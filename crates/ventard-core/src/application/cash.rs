//! Local TURN_OPEN command. Auth is revalidated from a VerifiedGrant, not UI
//! claims. A commercial IPC caller must ALSO enforce activation/drawer-writer
//! fencing. This module's local uniqueness is not global offline exclusivity.
use super::{
    errors::{AppError, AuthError, BusinessError, ProtocolError},
    operations::{execute_prepared_operation, prepare_operation},
};
use crate::{
    domain::{
        canonical::canonicalize,
        identity::{EntityId, Scope},
        money::MoneyCents,
    },
    security::offline_grant::VerifiedGrant,
    storage::catalogue_preview::{self, CatalogueContext},
};
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TurnOpen {
    pub operation_id: String,
    pub opening_cents: String,
    pub expected_drawer_revision: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnResult {
    pub operation_id: String,
    pub turn_id: String,
    pub tenant_id: String,
    pub scope_key: String,
    pub actor_id: String,
    pub opening_cents: String,
    pub opened_at_ms: String,
    pub drawer_revision: String,
    pub remote_status: String,
}
fn invalid() -> AppError {
    AppError::Protocol(ProtocolError::MalformedPayload)
}
fn conflict() -> AppError {
    AppError::Protocol(ProtocolError::OperationIdConflict)
}
fn changed() -> AppError {
    AppError::Business(BusinessError::Conflict {
        message: "TURN_CHANGED".into(),
    })
}
fn revision(raw: &str) -> Result<i64, AppError> {
    let n = raw.parse::<i64>().map_err(|_| invalid())?;
    if n < 0 || n.to_string() != raw {
        return Err(invalid());
    }
    Ok(n)
}
fn scope_key(tenant: &str, kind: &str, branch: Option<&str>) -> Result<(String, String), AppError> {
    EntityId::parse(tenant).map_err(|_| invalid())?;
    let scope = Scope::parse_command(Some(kind), branch).map_err(|_| invalid())?;
    let origin = match scope {
        Scope::Global => "GLOBAL".to_string(),
        Scope::Branch(id) => format!("BRANCH:{id}"),
        _ => return Err(invalid()),
    };
    Ok((format!("{tenant}/{origin}"), origin))
}
pub fn read_turn(c: &Connection, ctx: &CatalogueContext) -> Result<Option<TurnResult>, AppError> {
    catalogue_preview::key(ctx).map_err(|_| invalid())?;
    let (key, _) = scope_key(&ctx.tenant_id, &ctx.scope_type, ctx.branch_id.as_deref())?;
    let row:Option<String>=c.query_row("SELECT j.result FROM cash_turns t JOIN operation_journal j ON j.operation_id=t.operation_id WHERE t.tenant_id=?1 AND t.scope_key=?2 AND t.status IN ('OPEN','CLOSING') AND j.local_state='COMMITTED'",(&ctx.tenant_id,key),|r|r.get(0)).optional()?;
    row.map(|raw| serde_json::from_str(&raw).map_err(|_| invalid()))
        .transpose()
}
pub fn open_turn(
    c: &mut Connection,
    grant: &VerifiedGrant,
    now_ms: u64,
    highwater_ms: u64,
    openings: u64,
    req: TurnOpen,
) -> Result<TurnResult, AppError> {
    let decision = grant
        .evaluate(now_ms, highwater_ms, openings)
        .map_err(|_| invalid())?;
    if !decision.allows("SELL") {
        return Err(AppError::Auth(AuthError::PermissionDenied {
            required: "SELL".into(),
        }));
    }
    EntityId::parse(&req.operation_id).map_err(|_| invalid())?;
    let amount = MoneyCents::parse_dto(&req.opening_cents)
        .and_then(|m| m.require_non_negative())
        .map_err(|_| invalid())?;
    let expected = revision(&req.expected_drawer_revision)?;
    let p = grant.payload();
    let epoch = p
        .writer_epoch
        .parse::<u32>()
        .ok()
        .filter(|n| *n > 0)
        .ok_or_else(invalid)?;
    let (key, origin_scope) =
        scope_key(&p.tenant_id, &p.scope.r#type, p.scope.branch_id.as_deref())?;
    let payload = json!({"openingCents":req.opening_cents});
    let expected_versions = json!({"drawer":req.expected_drawer_revision});
    let original: Option<(Vec<u8>, String)> = c
        .query_row(
            "SELECT canonical_bytes,hash FROM operation_journal WHERE operation_id=?1",
            [&req.operation_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let (canonical, hash, intent) = if let Some((bytes, stored_hash)) = original {
        let v: Value = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
        if v["protocol"] != "ventard.native.v1"
            || v["kind"] != "TURN_OPEN"
            || v["operationId"] != req.operation_id
            || v["negocioId"] != p.tenant_id
            || v["actorId"] != p.actor_id
            || v["originDeviceId"] != p.device_id
            || v["installationId"] != p.installation_id
            || v["writerEpoch"] != p.writer_epoch
            || v["scope"] != json!({"type":p.scope.r#type,"sucursalId":p.scope.branch_id})
            || v["payload"] != payload
            || v["expectedVersions"] != expected_versions
        {
            return Err(conflict());
        }
        let (canonical, hash) = canonicalize(&bytes).map_err(|_| invalid())?;
        if canonical.as_bytes() != bytes || hash != stored_hash {
            return Err(invalid());
        }
        (canonical, hash, v)
    } else {
        let v = json!({"protocol":"ventard.native.v1","kind":"TURN_OPEN","contractVersion":1,"canonicalizationVersion":"C-N1","operationId":req.operation_id,"negocioId":p.tenant_id,"scope":{"type":p.scope.r#type,"sucursalId":p.scope.branch_id},"originDeviceId":p.device_id,"installationId":p.installation_id,"writerEpoch":p.writer_epoch,"actorId":p.actor_id,"permissionGrantId":p.grant_id,"originalTurnId":null,"originAtUtcMs":decision.effective_time_ms,"expectedVersions":expected_versions,"dependencies":[],"payload":payload});
        let (canonical, hash) =
            canonicalize(&serde_json::to_vec(&v).map_err(|_| invalid())?).map_err(|_| invalid())?;
        (canonical, hash, v)
    };
    let at = intent["originAtUtcMs"].as_str().ok_or_else(invalid)?;
    prepare_operation(
        c,
        &req.operation_id,
        "ventard.native.v1",
        "TURN_OPEN",
        1,
        canonical.as_bytes(),
        &hash,
        &p.actor_id,
        &origin_scope,
        &p.device_id,
        epoch,
        at,
    )?;
    let result = execute_prepared_operation(c, &req.operation_id, &hash, |tx| {
        let existing_scope: Option<(String, Option<String>, String)> = tx
            .query_row(
                "SELECT type,sucursal_id,negocio_id FROM scopes WHERE scope_key=?1",
                [&key],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        if let Some(existing) = existing_scope {
            if existing
                != (
                    p.scope.r#type.clone(),
                    p.scope.branch_id.clone(),
                    p.tenant_id.clone(),
                )
            {
                return Err(invalid());
            }
        } else {
            tx.execute(
                "INSERT INTO scopes(scope_key,type,sucursal_id,negocio_id)VALUES(?1,?2,?3,?4)",
                (&key, &p.scope.r#type, &p.scope.branch_id, &p.tenant_id),
            )?;
        }
        tx.execute(
            "INSERT OR IGNORE INTO cash_drawers VALUES(?1,?2,0)",
            (&p.tenant_id, &key),
        )?;
        let current: i64 = tx.query_row(
            "SELECT revision FROM cash_drawers WHERE tenant_id=?1 AND scope_key=?2",
            (&p.tenant_id, &key),
            |r| r.get(0),
        )?;
        let occupied:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM cash_turns WHERE tenant_id=?1 AND scope_key=?2 AND status IN ('OPEN','CLOSING'))",(&p.tenant_id,&key),|r|r.get(0))?;
        if current != expected || occupied {
            return Err(changed());
        }
        let next = current.checked_add(1).ok_or_else(invalid)?;
        tx.execute(
            "INSERT INTO cash_turns VALUES(?1,?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,1,'OPEN')",
            (
                &req.operation_id,
                &p.tenant_id,
                &key,
                &p.actor_id,
                &p.device_id,
                &p.installation_id,
                epoch,
                intent["permissionGrantId"].as_str().ok_or_else(invalid)?,
                amount.cents(),
                at,
            ),
        )?;
        tx.execute(
            "UPDATE cash_drawers SET revision=?3 WHERE tenant_id=?1 AND scope_key=?2",
            (&p.tenant_id, &key, next),
        )?;
        tx.execute(
            "INSERT INTO outbox(operation_id,envelope,state)VALUES(?1,?2,'PENDING')",
            (&req.operation_id, canonical.as_bytes()),
        )?;
        let result = TurnResult {
            operation_id: req.operation_id.clone(),
            turn_id: req.operation_id.clone(),
            tenant_id: p.tenant_id.clone(),
            scope_key: key.clone(),
            actor_id: p.actor_id.clone(),
            opening_cents: amount.to_dto(),
            opened_at_ms: at.into(),
            drawer_revision: next.to_string(),
            remote_status: "PENDING".into(),
        };
        serde_json::to_value(result).map_err(|_| invalid())
    })?;
    serde_json::from_value(result).map_err(|_| invalid())
}
