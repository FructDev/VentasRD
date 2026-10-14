//! Equipment credentials are encrypted with the vault and synced through a
//! separate owner/admin contract. Never embed them in public money documents.
use super::{
    errors::{AppError, BusinessError, ProtocolError},
    management::Command,
    sales,
};
use crate::{
    domain::{canonical::canonicalize, identity::EntityId},
    storage::catalogue_preview::CatalogueContext,
};
use rusqlite::{Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Change {
    pub value: String,
    pub base_operation_id: Option<String>,
}
fn invalid() -> AppError {
    AppError::Protocol(ProtocolError::MalformedPayload)
}
fn conflict() -> AppError {
    AppError::Protocol(ProtocolError::OperationIdConflict)
}
fn guard() -> AppError {
    AppError::Business(BusinessError::SaleGuard {
        code: "PRIVATE_VERSION_CONFLICT".into(),
    })
}
fn s(v: &Value) -> Result<&str, AppError> {
    v.as_str().ok_or_else(invalid)
}
fn canon(v: &Value) -> Result<(String, String), AppError> {
    canonicalize(&serde_json::to_vec(v).map_err(|_| invalid())?).map_err(|_| invalid())
}
fn credential(value: &str) -> Result<(), AppError> {
    if value.chars().count() > 256 || value.chars().any(char::is_control) {
        return Err(invalid());
    }
    Ok(())
}
pub fn read(c: &Connection, ctx: &CatalogueContext, id: &str) -> Result<Value, AppError> {
    EntityId::parse(id).map_err(|_| invalid())?;
    let current=c.query_row("SELECT credential,operation_id,remote_state FROM native_repair_private_values_v1 WHERE repair_id=?1 AND tenant_id=?2 AND scope_key=?3",(id,&ctx.tenant_id,sales::scope_key(ctx)?),|r|Ok(json!({"value":r.get::<_,String>(0)?,"baseOperationId":r.get::<_,String>(1)?,"remoteState":r.get::<_,String>(2)?}))).optional()?;
    if let Some(current) = current {
        return Ok(current);
    }
    if let Some(source) = crate::storage::legacy_services::source(c, ctx, "repair", id)? {
        if let Some(value) = source["patron_clave"].as_str() {
            credential(value)?;
            return Ok(
                json!({"value":value,"baseOperationId":null,"remoteState":"BASELINE_ADOPTED"}),
            );
        }
    }
    Ok(json!({"value":null,"baseOperationId":null,"remoteState":"NOT_CAPTURED"}))
}
pub(crate) fn stage(
    c: &Connection,
    ctx: &CatalogueContext,
    req: &Command,
    change: Option<&Change>,
) -> Result<(), AppError> {
    let request = serde_json::to_value(req).map_err(|_| invalid())?;
    let op = s(&request["operationId"])?;
    let (_, request_hash) = canon(&request)?;
    type Staged = (
        String,
        String,
        String,
        String,
        String,
        String,
        String,
        String,
    );
    let old:Option<Staged>=c.query_row("SELECT request_hash,private_bytes,tenant_id,scope_key,actor_id,installation_id,device_id,writer_epoch FROM native_repair_private_intents_v1 WHERE operation_id=?1",[op],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?))).optional()?;
    if let Some((hash, private, tenant, scope, actor, installation, device, epoch)) = old {
        if hash != request_hash
            || tenant != ctx.tenant_id
            || scope != sales::scope_key(ctx)?
            || actor != ctx.actor_id
            || installation != ctx.installation_id
            || device != ctx.device_id
            || epoch != ctx.writer_epoch
        {
            return Err(conflict());
        }
        if let Some(change) = change {
            if canon(&serde_json::to_value(change).map_err(|_| invalid())?)?.0 != private {
                return Err(conflict());
            }
        }
        return Ok(());
    }
    let Some(change) = change else {
        return Ok(());
    };
    let Command::RepairSave { repair_id, .. } = req else {
        return Err(invalid());
    };
    credential(&change.value)?;
    if let Some(id) = &change.base_operation_id {
        EntityId::parse(id).map_err(|_| invalid())?;
    }
    let exists: bool = c.query_row(
        "SELECT EXISTS(SELECT 1 FROM operation_journal WHERE operation_id=?1)",
        [op],
        |r| r.get(0),
    )?;
    if exists {
        return Err(conflict());
    }
    let current = read(c, ctx, repair_id)?;
    if current["baseOperationId"] != json!(change.base_operation_id) {
        return Err(guard());
    }
    let (bytes, hash) = canon(&serde_json::to_value(change).map_err(|_| invalid())?)?;
    c.execute(
        "INSERT INTO native_repair_private_intents_v1 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
        (
            op,
            &ctx.tenant_id,
            sales::scope_key(ctx)?,
            &ctx.actor_id,
            &ctx.installation_id,
            &ctx.device_id,
            &ctx.writer_epoch,
            repair_id,
            request_hash,
            bytes,
            hash,
        ),
    )?;
    Ok(())
}
pub(crate) fn apply(
    tx: &Transaction<'_>,
    ctx: &CatalogueContext,
    v: &Value,
) -> Result<(), AppError> {
    let op = s(&v["operationId"])?;
    let row:Option<(String,String)>=tx.query_row("SELECT private_bytes,private_hash FROM native_repair_private_intents_v1 WHERE operation_id=?1 AND tenant_id=?2 AND scope_key=?3",(op,&ctx.tenant_id,sales::scope_key(ctx)?),|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
    let Some((raw, hash)) = row else {
        return Ok(());
    };
    let (canonical, actual) = canonicalize(raw.as_bytes()).map_err(|_| invalid())?;
    if canonical != raw || actual != hash {
        return Err(invalid());
    }
    let change: Change = serde_json::from_str(&raw).map_err(|_| invalid())?;
    let r = &v["payload"]["document"]["repair"];
    let id = s(&r["id"])?;
    let current = read(tx, ctx, id)?;
    if current["baseOperationId"] != json!(change.base_operation_id) {
        return Err(guard());
    }
    let revision = s(&r["revision"])?.parse::<i64>().map_err(|_| invalid())?;
    let intent = json!({"protocol":"ventard.repair.private.1","operationId":op,"tenantId":ctx.tenant_id,"scope":{"type":ctx.scope_type,"branchId":ctx.branch_id},"actorId":ctx.actor_id,"installationId":ctx.installation_id,"deviceId":ctx.device_id,"writerEpoch":ctx.writer_epoch,"repairId":id,"repairRevision":r["revision"],"baseOperationId":change.base_operation_id,"value":change.value});
    let (bytes, hash) = canon(&intent)?;
    tx.execute("INSERT INTO native_repair_private_values_v1 VALUES(?1,?2,?3,?4,?5,?6,'PENDING') ON CONFLICT(repair_id) DO UPDATE SET operation_id=excluded.operation_id,repair_revision=excluded.repair_revision,credential=excluded.credential,remote_state='PENDING' WHERE tenant_id=excluded.tenant_id AND scope_key=excluded.scope_key",(id,&ctx.tenant_id,sales::scope_key(ctx)?,op,revision,&change.value))?;
    tx.execute(
        "INSERT INTO native_repair_private_outbox_v1 VALUES(?1,?2,?3,'PENDING')",
        (op, bytes, hash),
    )?;
    Ok(())
}
#[derive(Clone, Debug)]
pub struct Dispatch {
    pub operation_id: String,
    pub intent: String,
    pub hash: String,
}
pub fn pending(c: &Connection, ctx: &CatalogueContext) -> Result<Vec<Dispatch>, AppError> {
    let mut q=c.prepare("SELECT p.operation_id,p.intent,p.hash FROM native_repair_private_outbox_v1 p JOIN native_sales_receipts_v1 r ON r.operation_id=p.operation_id JOIN operation_journal j ON j.operation_id=p.operation_id WHERE p.state='PENDING' AND r.tenant_id=?1 AND r.scope_key=?2 AND json_extract(p.intent,'$.actorId')=?3 AND json_extract(p.intent,'$.installationId')=?4 AND json_extract(p.intent,'$.deviceId')=?5 AND json_extract(p.intent,'$.writerEpoch')=?6 ORDER BY j.local_seq LIMIT 50")?;
    let rows = q
        .query_map(
            (
                &ctx.tenant_id,
                sales::scope_key(ctx)?,
                &ctx.actor_id,
                &ctx.installation_id,
                &ctx.device_id,
                &ctx.writer_epoch,
            ),
            |r| {
                Ok(Dispatch {
                    operation_id: r.get(0)?,
                    intent: r.get(1)?,
                    hash: r.get(2)?,
                })
            },
        )?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}
pub fn acknowledge(
    c: &Connection,
    ctx: &CatalogueContext,
    d: &Dispatch,
    receipt: &Value,
) -> Result<(), AppError> {
    let v: Value = serde_json::from_str(&d.intent).map_err(|_| invalid())?;
    if receipt["protocol"] != "ventard.repair.private.receipt.1"
        || receipt["operationId"] != d.operation_id
        || receipt["intentHash"] != d.hash
        || receipt["repairId"] != v["repairId"]
        || receipt["tenantId"] != ctx.tenant_id
        || receipt["scope"] != json!({"type":ctx.scope_type,"branchId":ctx.branch_id})
        || !matches!(receipt["status"].as_str(), Some("APPLIED" | "SUPERSEDED"))
    {
        return Err(invalid());
    }
    let tx = c.unchecked_transaction()?;
    tx.execute("UPDATE native_repair_private_outbox_v1 SET state='APPLIED' WHERE operation_id=?1 AND hash=?2",(&d.operation_id,&d.hash))?;
    tx.execute("UPDATE native_repair_private_values_v1 SET remote_state='APPLIED' WHERE operation_id=?1 AND tenant_id=?2",(&d.operation_id,&ctx.tenant_id))?;
    tx.commit()?;
    Ok(())
}
pub fn failure(
    c: &Connection,
    ctx: &CatalogueContext,
    d: &Dispatch,
    status: u16,
) -> Result<(), AppError> {
    if matches!(status, 400 | 409 | 422) {
        let tx = c.unchecked_transaction()?;
        tx.execute("UPDATE native_repair_private_outbox_v1 SET state='INTERVENTION' WHERE operation_id=?1 AND hash=?2",(&d.operation_id,&d.hash))?;
        tx.execute("UPDATE native_repair_private_values_v1 SET remote_state='INTERVENTION' WHERE operation_id=?1 AND tenant_id=?2",(&d.operation_id,&ctx.tenant_id))?;
        tx.commit()?;
    }
    Ok(())
}
pub fn import(c: &Connection, ctx: &CatalogueContext, bundle: &Value) -> Result<(), AppError> {
    if bundle["protocol"] != "ventard.repair.private.view.1"
        || bundle["tenantId"] != ctx.tenant_id
        || bundle["scope"] != json!({"type":ctx.scope_type,"branchId":ctx.branch_id})
    {
        return Err(invalid());
    }
    let rows = bundle["rows"].as_array().ok_or_else(invalid)?;
    if rows.len() > 10000 {
        return Err(invalid());
    }
    let tx = c.unchecked_transaction()?;
    let mut seen = std::collections::HashSet::new();
    for r in rows {
        let id = s(&r["repairId"])?;
        let op = s(&r["operationId"])?;
        EntityId::parse(id).map_err(|_| invalid())?;
        EntityId::parse(op).map_err(|_| invalid())?;
        let value = s(&r["value"])?;
        credential(value)?;
        let revision = s(&r["repairRevision"])?
            .parse::<i64>()
            .map_err(|_| invalid())?;
        if revision <= 0 || !seen.insert(id) {
            return Err(invalid());
        }
        let known:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM native_management_records_v1 WHERE tenant_id=?1 AND scope_key=?2 AND json_extract(document,'$.repair.id')=?3 AND cast(json_extract(document,'$.repair.revision') AS INTEGER)>=?4)",(&ctx.tenant_id,sales::scope_key(ctx)?,id,revision),|r|r.get(0))?;
        if !known {
            continue;
        }
        tx.execute("INSERT INTO native_repair_private_values_v1 VALUES(?1,?2,?3,?4,?5,?6,'APPLIED') ON CONFLICT(repair_id) DO UPDATE SET operation_id=excluded.operation_id,repair_revision=excluded.repair_revision,credential=excluded.credential,remote_state='APPLIED' WHERE tenant_id=excluded.tenant_id AND scope_key=excluded.scope_key AND excluded.repair_revision>=repair_revision AND (remote_state='APPLIED' OR excluded.repair_revision>repair_revision OR excluded.operation_id=operation_id)",(id,&ctx.tenant_id,sales::scope_key(ctx)?,op,revision,value))?;
    }
    tx.commit()?;
    Ok(())
}
