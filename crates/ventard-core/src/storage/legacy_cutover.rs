//! Explicit adoption of a converged cloud baseline. Legacy intentions remain
//! preserved and never enter NATIVE1 outbox or acquire fabricated receipts.
use super::{catalogue_preview::CatalogueContext, legacy_transition as transition};
use crate::domain::canonical::canonicalize;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
#[derive(Debug)]
pub struct Error(&'static str);
impl Error {
    pub fn code(&self) -> &'static str {
        self.0
    }
}
impl From<rusqlite::Error> for Error {
    fn from(_: rusqlite::Error) -> Self {
        Self("CUTOVER_STORAGE")
    }
}
impl From<transition::Error> for Error {
    fn from(e: transition::Error) -> Self {
        Self(e.code())
    }
}
fn invalid() -> Error {
    Error("CUTOVER_INVALID")
}
pub fn context_changed() -> Error {
    Error("CUTOVER_CONTEXT")
}
fn hash(raw: &str) -> String {
    format!("{:x}", Sha256::digest(raw.as_bytes()))
}
fn canonical(v: &Value) -> Result<(String, String), Error> {
    canonicalize(v.to_string().as_bytes()).map_err(|_| invalid())
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Input {
    pub cutover_id: String,
    pub run_id: String,
    pub revision: u32,
    pub backup_id: String,
    pub confirmation: String,
    pub free_tax: String,
}
#[derive(Clone, Debug)]
pub struct Pending {
    pub intent: String,
    pub hash: String,
    pub state: String,
}
fn ctx_json(ctx: &CatalogueContext) -> Result<String, Error> {
    serde_json::to_string(ctx).map_err(|_| invalid())
}
pub fn fingerprints(c: &Connection) -> Result<BTreeMap<String, String>, Error> {
    let exists: bool = c.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='legacy_transition_runs_v1')",
        [],
        |r| r.get(0),
    )?;
    if !exists {
        return Ok(BTreeMap::new());
    }
    let mut q=c.prepare("SELECT run_id,context,sources,revision,report FROM legacy_transition_runs_v1 ORDER BY run_id")?;
    let mut out = BTreeMap::new();
    for row in q.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, i64>(3)?,
            r.get::<_, String>(4)?,
        ))
    })? {
        let (id, context, sources, revision, report) = row?;
        let selected = transition::selected(c, &id)?;
        out.insert(
            id,
            hash(&json!([context, sources, revision, report, selected]).to_string()),
        );
    }
    Ok(out)
}
fn tables(c: &Connection, ctx: &CatalogueContext, run: &str) -> Result<Value, Error> {
    let report = transition::report(c, ctx, run)?;
    let source = report["sources"]
        .as_array()
        .ok_or_else(invalid)?
        .iter()
        .find(|s| s["kind"] == "CLOUD")
        .ok_or(Error("CUTOVER_CLOUD_REQUIRED"))?;
    let (raw, saved, stored_hash): (String, String, String) = c.query_row(
        "SELECT body,context,body_hash FROM legacy_cloud_captures_v1 WHERE capture_id=?1",
        [source["id"].as_str().ok_or_else(invalid)?],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    if saved != ctx_json(ctx)? || hash(&raw) != stored_hash || source["sha256"] != stored_hash {
        return Err(Error("CUTOVER_SOURCE_CONFLICT"));
    }
    let cloud: Value = serde_json::from_str(&raw).map_err(|_| invalid())?;
    let data = transition::selected(c, run)?;
    let mut out = vec![];
    for name in transition::CLOUD_TABLES {
        let rows = data
            .get(*name)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|r| r["negocio_id"] == ctx.tenant_id)
            .collect::<Vec<_>>();
        let mut current = cloud["tables"]
            .as_array()
            .ok_or_else(invalid)?
            .iter()
            .find(|t| t["name"] == *name)
            .ok_or_else(invalid)?["rows"]
            .as_array()
            .ok_or_else(invalid)?
            .iter()
            .map(|v| transition::normalize(v, 0).map_err(Error::from))
            .collect::<Result<Vec<_>, _>>()?;
        current.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
        if current != rows {
            return Err(Error("CUTOVER_COPIES_NOT_CONVERGED"));
        }
        let blocks = current
            .chunks(100)
            .map(|rows| canonical(&json!(rows)).map(|(_, h)| h))
            .collect::<Result<Vec<_>, _>>()?;
        out.push(json!({"name":name,"count":rows.len(),"blocks":blocks}));
    }
    Ok(json!(out))
}
pub fn readiness(c: &Connection, ctx: &CatalogueContext, run: &str) -> Result<Value, Error> {
    let report = transition::report(c, ctx, run)?;
    let mut blockers = vec![];
    if report["historyPublished"] != true || report["conflicts"] != 0 {
        blockers.push(json!({"code":"CUTOVER_REVIEW_REQUIRED"}))
    }
    if let Err(e) = tables(c, ctx, run) {
        blockers.push(json!({"code":e.code()}))
    }
    // A source turn is closed deliberately before handing its writer over.
    // Its original cash/history remain preserved; no synthetic TURN_OPEN.
    let selected = transition::selected(c, run)?;
    for row in selected.get("cajas").into_iter().flatten() {
        if row["negocio_id"] != ctx.tenant_id {
            continue;
        }
        if row["estado"] != "cerrada" {
            blockers.push(json!({"code":"CUTOVER_CLOSE_WEB_CASH","id":row["id"]}))
        }
    }
    for (table, terminal) in [
        (
            "reparaciones",
            &["entregado", "cancelado", "no_reparado"][..],
        ),
        ("apartados", &["completado", "cancelado"][..]),
    ] {
        for row in selected.get(table).into_iter().flatten() {
            if row["negocio_id"] != ctx.tenant_id {
                continue;
            }
            if row["estado"]
                .as_str()
                .is_none_or(|s| !terminal.contains(&s))
            {
                blockers.push(json!({"code":"CUTOVER_SERVICE_REQUIRES_RECONCILIATION","table":table,"id":row["id"]}))
            }
        }
    }
    for issue in report["issues"].as_array().ok_or_else(invalid)? {
        // A shared browser may preserve another explicitly identified business.
        // Keep its raw copy, but never adopt it into the selected tenant.
        let known_foreign = issue["code"] == "TENANT_UNPROVEN"
            && selected
                .get(issue["table"].as_str().unwrap_or(""))
                .into_iter()
                .flatten()
                .any(|row| {
                    row["id"] == issue["id"]
                        && row["negocio_id"]
                            .as_str()
                            .is_some_and(|n| n != ctx.tenant_id && uuid::Uuid::parse_str(n).is_ok())
                });
        if known_foreign {
            continue;
        }
        if !matches!(
            issue["code"].as_str(),
            Some("SCOPE_FROM_LINKED_SALE" | "SCOPE_FROM_SAVED_CHECKOUT")
        ) {
            blockers.push(issue.clone())
        }
    }
    Ok(
        json!({"runId":run,"revision":report["revision"],"canPrepare":blockers.is_empty(),"blockers":blockers,"coverage":"CONVERGED_CLOSED_WEB_BASELINE","legacyReplay":false}),
    )
}
pub fn load(c: &Connection, ctx: &CatalogueContext, id: &str) -> Result<Pending, Error> {
    let (saved, intent, hash, state): (String, String, String, String) = c.query_row(
        "SELECT context,intent,intent_hash,state FROM legacy_cutovers_v1 WHERE cutover_id=?1",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    )?;
    if saved != ctx_json(ctx)? {
        return Err(Error("CUTOVER_CONTEXT"));
    }
    if canonicalize(intent.as_bytes()).map_err(|_| invalid())?.1 != hash {
        return Err(Error("CUTOVER_SOURCE_CONFLICT"));
    }
    let receipt: Option<String> = c.query_row(
        "SELECT receipt FROM legacy_cutovers_v1 WHERE cutover_id=?1",
        [id],
        |r| r.get(0),
    )?;
    if state == "UNKNOWN" {
        if receipt.is_some() {
            return Err(Error("CUTOVER_RECEIPT_INVALID"));
        }
    } else {
        let plan: Value = serde_json::from_str(&intent).map_err(|_| invalid())?;
        let receipt: Value =
            serde_json::from_str(&receipt.ok_or(Error("CUTOVER_RECEIPT_INVALID"))?)
                .map_err(|_| invalid())?;
        let mut expected = expected_receipt(ctx, id, &hash, &plan);
        if state == "ABANDONED" {
            expected["status"] = json!("ABANDONED");
            expected["coverage"] = json!("NO_BASELINE_CHANGE");
        }
        if receipt != expected {
            return Err(Error("CUTOVER_RECEIPT_INVALID"));
        }
    }
    Ok(Pending {
        intent,
        hash,
        state,
    })
}
fn expected_receipt(ctx: &CatalogueContext, id: &str, hash: &str, plan: &Value) -> Value {
    json!({"protocol":"ventard.web.cutover.receipt.1","status":"BASELINE_ADOPTED","cutoverId":id,"planHash":hash,"context":ctx,"runId":plan["runId"],"revision":plan["revision"],"backupId":plan["backupId"],"coverage":"CLOUD_CONVERGED_BASELINE","legacyReplay":false})
}
pub fn view(c: &Connection, ctx: &CatalogueContext) -> Result<Value, Error> {
    let id:Option<String>=c.query_row("SELECT cutover_id FROM legacy_cutovers_v1 WHERE context=?1 ORDER BY rowid DESC LIMIT 1",[ctx_json(ctx)?],|r|r.get(0)).optional()?;
    id.map(|id| {
        let p = load(c, ctx, &id)?;
        let input: Input = serde_json::from_str(&c.query_row(
            "SELECT input FROM legacy_cutovers_v1 WHERE cutover_id=?1",
            [&id],
            |r| r.get::<_, String>(0),
        )?)
        .map_err(|_| invalid())?;
        Ok(json!({"cutoverId":id,"state":p.state,"runId":input.run_id,"backupId":input.backup_id}))
    })
    .transpose()
    .map(|v| v.unwrap_or(Value::Null))
}
pub fn prepare(
    c: &mut Connection,
    ctx: &CatalogueContext,
    input: &Input,
    at: &str,
) -> Result<Pending, Error> {
    for id in [&input.cutover_id, &input.run_id, &input.backup_id] {
        uuid::Uuid::parse_str(id).map_err(|_| invalid())?;
    }
    if input.confirmation != "WEB_WRITERS_CLOSED_BALANCES_REVIEWED"
        || !matches!(input.free_tax.as_str(), "0" | "0.18")
    {
        return Err(invalid());
    }
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let raw_input = serde_json::to_string(input).map_err(|_| invalid())?;
    let old: Option<String> = tx
        .query_row(
            "SELECT input FROM legacy_cutovers_v1 WHERE cutover_id=?1",
            [&input.cutover_id],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(old) = old {
        if old != raw_input {
            return Err(Error("CUTOVER_ID_CONFLICT"));
        }
        return load(&tx, ctx, &input.cutover_id);
    }
    let ready = readiness(&tx, ctx, &input.run_id)?;
    if ready["canPrepare"] != true || ready["revision"] != input.revision {
        return Err(Error("CUTOVER_REVIEW_REQUIRED"));
    }
    let raw:Option<String>=tx.query_row("SELECT result FROM native_backup_jobs_v1 WHERE operation_id=?1 AND tenant_id=?2 AND installation_id=?3 AND actor_id=?4 AND state='VERIFIED'",(&input.backup_id,&ctx.tenant_id,&ctx.installation_id,&ctx.actor_id),|r|r.get(0)).optional()?.flatten();
    let backup: Value = serde_json::from_str(&raw.ok_or(Error("CUTOVER_BACKUP_REQUIRED"))?)
        .map_err(|_| invalid())?;
    let manifest = &backup["manifest"];
    let source = &manifest["source"];
    let fingerprint = fingerprints(&tx)?
        .remove(&input.run_id)
        .ok_or_else(invalid)?;
    if source["tenantId"] != ctx.tenant_id
        || source["actorId"] != ctx.actor_id
        || source["installationId"] != ctx.installation_id
        || source["deviceId"] != ctx.device_id
        || source["writerEpoch"] != ctx.writer_epoch
        || source["scopeType"] != ctx.scope_type
        || source["branchId"] != json!(ctx.branch_id)
        || manifest["backupId"] != input.backup_id
        || manifest["transitionRuns"][&input.run_id] != fingerprint
        || manifest["databaseHash"]
            .as_str()
            .is_none_or(|h| h.len() != 64 || !h.bytes().all(|b| b.is_ascii_hexdigit()))
    {
        return Err(Error("CUTOVER_BACKUP_REQUIRED"));
    }
    let report = transition::report(&tx, ctx, &input.run_id)?;
    let plan = json!({"protocol":"ventard.web.cutover.1","cutoverId":input.cutover_id,"runId":input.run_id,"revision":input.revision,"context":ctx,"backupId":input.backup_id,"backupHash":manifest["databaseHash"],"runHash":fingerprint,"confirmation":input.confirmation,"freeTax":input.free_tax,"sources":report["sources"],"tables":tables(&tx,ctx,&input.run_id)?});
    let (intent, hash) = canonical(&plan)?;
    tx.execute(
        "INSERT INTO legacy_cutovers_v1 VALUES(?1,?2,?3,?4,?5,?6,'UNKNOWN',NULL,?7)",
        (
            &input.cutover_id,
            ctx_json(ctx)?,
            &input.run_id,
            raw_input,
            &intent,
            &hash,
            at,
        ),
    )?;
    tx.commit()?;
    Ok(Pending {
        intent,
        hash,
        state: "UNKNOWN".into(),
    })
}
pub fn accept(
    c: &mut Connection,
    ctx: &CatalogueContext,
    id: &str,
    receipt: &Value,
) -> Result<(), Error> {
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let pending = load(&tx, ctx, id)?;
    let plan: Value = serde_json::from_str(&pending.intent).map_err(|_| invalid())?;
    let mut expected = expected_receipt(ctx, id, &pending.hash, &plan);
    let abandoned = receipt["status"] == "ABANDONED";
    if abandoned {
        expected["status"] = json!("ABANDONED");
        expected["coverage"] = json!("NO_BASELINE_CHANGE");
    }
    if *receipt != expected {
        return Err(Error("CUTOVER_RECEIPT_INVALID"));
    }
    if pending.state != "UNKNOWN" && ((pending.state == "ABANDONED") != abandoned) {
        return Err(Error("CUTOVER_RECEIPT_INVALID"));
    }
    tx.execute("UPDATE legacy_cutovers_v1 SET state=CASE WHEN state='ACTIVE' THEN state ELSE ?3 END,receipt=?2 WHERE cutover_id=?1",(id,receipt.to_string(),if abandoned{"ABANDONED"}else{"ADOPTED"}))?;
    tx.commit()?;
    Ok(())
}
pub fn mark_active(c: &mut Connection, ctx: &CatalogueContext, id: &str) -> Result<Value, Error> {
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let p = load(&tx, ctx, id)?;
    if !matches!(p.state.as_str(), "ADOPTED" | "ACTIVE")
        || !crate::application::sales_sync::operational(&tx, ctx).map_err(|_| invalid())?
    {
        return Err(Error("CUTOVER_BOOTSTRAP_REQUIRED"));
    }
    tx.execute(
        "UPDATE legacy_cutovers_v1 SET state='ACTIVE' WHERE cutover_id=?1",
        [id],
    )?;
    tx.commit()?;
    view(c, ctx)
}
