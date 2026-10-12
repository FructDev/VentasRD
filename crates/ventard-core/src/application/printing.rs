//! A print request never repeats the sale. Crossing the OS boundary is durable
//! UNKNOWN before sending: neither the dialog nor its return proves paper output.
use super::{
    errors::{AppError, ProtocolError},
    history, sales,
};
use crate::{domain::identity::EntityId, storage::catalogue_preview::CatalogueContext};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Layout {
    pub paper_width: String,
    pub font_size: String,
    pub density: String,
    pub copies: u8,
}
impl Default for Layout {
    fn default() -> Self {
        Self {
            paper_width: "80mm".into(),
            font_size: "normal".into(),
            density: "normal".into(),
            copies: 1,
        }
    }
}
fn valid_layout(d: &Layout) -> Result<(), AppError> {
    if !matches!(d.paper_width.as_str(), "58mm" | "80mm")
        || !matches!(d.font_size.as_str(), "normal" | "grande")
        || !matches!(d.density.as_str(), "normal" | "compacta")
        || !matches!(d.copies, 1 | 2)
    {
        return Err(invalid());
    }
    Ok(())
}
pub fn layout(c: &Connection, ctx: &CatalogueContext) -> Result<Layout, AppError> {
    let raw: Option<String> = c
        .query_row(
            "SELECT payload FROM native_print_layout_v1 WHERE tenant_id=?1 AND installation_id=?2",
            (&ctx.tenant_id, &ctx.installation_id),
            |r| r.get(0),
        )
        .optional()?;
    let d = raw
        .map(|v| serde_json::from_str::<Layout>(&v).map_err(|_| invalid()))
        .transpose()?
        .unwrap_or_default();
    valid_layout(&d)?;
    Ok(d)
}
pub fn save_layout(
    c: &Connection,
    g: &crate::security::offline_grant::VerifiedGrant,
    now: u64,
    high: u64,
    opens: u64,
    d: Layout,
) -> Result<Value, AppError> {
    if !g
        .evaluate(now, high, opens)
        .map_err(|_| invalid())?
        .allows("MANAGE")
    {
        return Err(AppError::Auth(super::errors::AuthError::PermissionDenied {
            required: "MANAGE".into(),
        }));
    }
    valid_layout(&d)?;
    let p = g.payload();
    let raw = serde_json::to_string(&d).map_err(|_| invalid())?;
    c.execute("INSERT INTO native_print_layout_v1 VALUES(?1,?2,?3) ON CONFLICT(tenant_id,installation_id) DO UPDATE SET payload=excluded.payload",(&p.tenant_id,&p.installation_id,raw))?;
    Ok(json!(d))
}
fn invalid() -> AppError {
    AppError::Protocol(ProtocolError::MalformedPayload)
}
fn last_attempt(c: &Connection, op: &str) -> Result<Option<Value>, AppError> {
    Ok(c.query_row("SELECT attempt_id,state FROM native_document_print_attempts_v1 WHERE operation_id=?1 ORDER BY rowid DESC LIMIT 1",[op],|r|Ok(json!({"attemptId":r.get::<_,String>(0)?,"state":r.get::<_,String>(1)?}))).optional()?)
}
pub fn repair_ticket(c: &Connection, ctx: &CatalogueContext, op: &str) -> Result<Value, AppError> {
    let row:Option<(Vec<u8>,String,String)>=c.query_row("SELECT j.canonical_bytes,j.hash,r.document FROM native_management_records_v1 r JOIN operation_journal j ON j.operation_id=r.operation_id WHERE r.operation_id=?1 AND r.tenant_id=?2 AND r.scope_key=?3 AND r.kind IN('REPAIR_CREATE','REPAIR_EDIT','REPAIR_DISASSEMBLE') AND j.local_state='COMMITTED'",(op,&ctx.tenant_id,sales::scope_key(ctx)?),|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
    let (raw, hash, document) = row.ok_or_else(invalid)?;
    let (canonical, h) = crate::domain::canonical::canonicalize(&raw).map_err(|_| invalid())?;
    let v: Value = serde_json::from_slice(&raw).map_err(|_| invalid())?;
    let d: Value = serde_json::from_str(&document).map_err(|_| invalid())?;
    if canonical.as_bytes() != raw
        || h != hash
        || v["operationId"] != op
        || v["negocioId"] != ctx.tenant_id
        || v["scope"] != json!({"type":ctx.scope_type,"sucursalId":ctx.branch_id})
        || v["payload"]["document"] != d
    {
        return Err(invalid());
    }
    let mut ticket = json!({"version":"ventard.repair.snapshot.1","operationId":op,"tenantId":ctx.tenant_id,"scope":{"type":ctx.scope_type,"branchId":ctx.branch_id},"originAtUtcMs":v["originAtUtcMs"],"document":d});
    let (_, hash) = crate::domain::canonical::canonicalize(
        &serde_json::to_vec(&ticket).map_err(|_| invalid())?,
    )
    .map_err(|_| invalid())?;
    ticket["printSnapshotHash"] = json!(hash);
    ticket["printLayout"] = json!(layout(c, ctx)?);
    if let Some(attempt) = last_attempt(c, op)? {
        ticket["printAttempt"] = attempt;
    }
    Ok(ticket)
}
pub fn layaway_ticket(c: &Connection, ctx: &CatalogueContext, op: &str) -> Result<Value, AppError> {
    let row:Option<(Vec<u8>,String,String)>=c.query_row("SELECT j.canonical_bytes,j.hash,r.document FROM native_management_records_v1 r JOIN operation_journal j ON j.operation_id=r.operation_id WHERE r.operation_id=?1 AND r.tenant_id=?2 AND r.scope_key=?3 AND r.kind IN('LAYAWAY_CREATE','LAYAWAY_PAYMENT','LAYAWAY_COMPLETE','LAYAWAY_CANCEL') AND j.local_state='COMMITTED'",(op,&ctx.tenant_id,sales::scope_key(ctx)?),|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
    let (raw, hash, document) = row.ok_or_else(invalid)?;
    let (canonical, h) = crate::domain::canonical::canonicalize(&raw).map_err(|_| invalid())?;
    let v: Value = serde_json::from_slice(&raw).map_err(|_| invalid())?;
    let d: Value = serde_json::from_str(&document).map_err(|_| invalid())?;
    if canonical.as_bytes() != raw
        || h != hash
        || v["operationId"] != op
        || v["negocioId"] != ctx.tenant_id
        || v["scope"] != json!({"type":ctx.scope_type,"sucursalId":ctx.branch_id})
        || v["payload"]["document"] != d
    {
        return Err(invalid());
    }
    let mut ticket = json!({"version":"ventard.layaway.snapshot.1","operationId":op,"tenantId":ctx.tenant_id,"scope":{"type":ctx.scope_type,"branchId":ctx.branch_id},"originAtUtcMs":v["originAtUtcMs"],"document":d});
    let (_, hash) = crate::domain::canonical::canonicalize(
        &serde_json::to_vec(&ticket).map_err(|_| invalid())?,
    )
    .map_err(|_| invalid())?;
    ticket["printSnapshotHash"] = json!(hash);
    ticket["printLayout"] = json!(layout(c, ctx)?);
    if let Some(attempt) = last_attempt(c, op)? {
        ticket["printAttempt"] = attempt;
    }
    Ok(ticket)
}
pub fn warranty_ticket(
    c: &Connection,
    ctx: &CatalogueContext,
    op: &str,
) -> Result<Value, AppError> {
    let row:Option<(Vec<u8>,String,String)>=c.query_row("SELECT j.canonical_bytes,j.hash,r.document FROM native_management_records_v1 r JOIN operation_journal j ON j.operation_id=r.operation_id WHERE r.operation_id=?1 AND r.tenant_id=?2 AND r.scope_key=?3 AND r.kind='WARRANTY_PATCH' AND j.local_state='COMMITTED'",(op,&ctx.tenant_id,sales::scope_key(ctx)?),|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
    let (raw, hash, document) = row.ok_or_else(invalid)?;
    let (canonical, h) = crate::domain::canonical::canonicalize(&raw).map_err(|_| invalid())?;
    let v: Value = serde_json::from_slice(&raw).map_err(|_| invalid())?;
    let d: Value = serde_json::from_str(&document).map_err(|_| invalid())?;
    if canonical.as_bytes() != raw
        || h != hash
        || v["operationId"] != op
        || v["negocioId"] != ctx.tenant_id
        || v["scope"] != json!({"type":ctx.scope_type,"sucursalId":ctx.branch_id})
        || v["payload"]["document"] != d
    {
        return Err(invalid());
    }
    let mut ticket = json!({"version":"ventard.warranty.snapshot.1","operationId":op,"tenantId":ctx.tenant_id,"scope":{"type":ctx.scope_type,"branchId":ctx.branch_id},"originAtUtcMs":v["originAtUtcMs"],"document":d});
    let (_, hash) = crate::domain::canonical::canonicalize(
        &serde_json::to_vec(&ticket).map_err(|_| invalid())?,
    )
    .map_err(|_| invalid())?;
    ticket["printSnapshotHash"] = json!(hash);
    ticket["printLayout"] = json!(layout(c, ctx)?);
    if let Some(attempt) = last_attempt(c, op)? {
        ticket["printAttempt"] = attempt;
    }
    Ok(ticket)
}
fn management_ticket(c: &Connection, ctx: &CatalogueContext, op: &str) -> Result<Value, AppError> {
    let kind:String=c.query_row("SELECT kind FROM native_management_records_v1 WHERE operation_id=?1 AND tenant_id=?2 AND scope_key=?3",(op,&ctx.tenant_id,sales::scope_key(ctx)?),|r|r.get(0))?;
    if kind == "WARRANTY_PATCH" {
        warranty_ticket(c, ctx, op)
    } else if super::layaways::supports(&kind) {
        layaway_ticket(c, ctx, op)
    } else if super::repairs::supports(&kind) {
        repair_ticket(c, ctx, op)
    } else {
        cut_ticket(c, ctx, op)
    }
}
pub fn cut_ticket(c: &Connection, ctx: &CatalogueContext, op: &str) -> Result<Value, AppError> {
    let row:Option<(Vec<u8>,String,String)>=c.query_row("SELECT j.canonical_bytes,j.hash,r.document FROM native_management_records_v1 r JOIN operation_journal j ON j.operation_id=r.operation_id WHERE r.operation_id=?1 AND r.tenant_id=?2 AND r.scope_key=?3 AND r.kind IN('CUT_X','TURN_CLOSE') AND j.local_state='COMMITTED'",(op,&ctx.tenant_id,sales::scope_key(ctx)?),|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
    let (raw, hash, document) = row.ok_or_else(invalid)?;
    let (canonical, h) = crate::domain::canonical::canonicalize(&raw).map_err(|_| invalid())?;
    if canonical.as_bytes() != raw || hash != h {
        return Err(invalid());
    }
    let v: Value = serde_json::from_slice(&raw).map_err(|_| invalid())?;
    let d: Value = serde_json::from_str(&document).map_err(|_| invalid())?;
    if v["operationId"] != op
        || v["negocioId"] != ctx.tenant_id
        || v["scope"] != json!({"type":ctx.scope_type,"sucursalId":ctx.branch_id})
        || v["payload"]["document"] != d
        || !matches!(v["kind"].as_str(), Some("CUT_X" | "TURN_CLOSE"))
    {
        return Err(invalid());
    }
    let mut income = crate::domain::money::MoneyCents::ZERO;
    for field in [
        "totalCents",
        "cashCreditPaymentsCents",
        "cardCreditPaymentsCents",
        "transferCreditPaymentsCents",
        "repairIncomeCents",
        "layawayIncomeCents",
    ] {
        income = income
            .checked_add(
                crate::domain::money::MoneyCents::parse_dto(
                    d["drawer"]["summary"][field]
                        .as_str()
                        .or_else(|| {
                            (field == "repairIncomeCents" || field == "layawayIncomeCents")
                                .then_some("0")
                        })
                        .ok_or_else(invalid)?,
                )
                .map_err(|_| invalid())?,
            )
            .map_err(|_| invalid())?;
    }
    let mut ticket = json!({"version":"ventard.cut.snapshot.1","operationId":op,"tenantId":ctx.tenant_id,"scope":{"type":ctx.scope_type,"branchId":ctx.branch_id},"kind":v["kind"],"originAtUtcMs":v["originAtUtcMs"],"document":d,"totalIncomeCents":income.to_dto()});
    let (_, snapshot_hash) = crate::domain::canonical::canonicalize(
        &serde_json::to_vec(&ticket).map_err(|_| invalid())?,
    )
    .map_err(|_| invalid())?;
    ticket["printSnapshotHash"] = json!(snapshot_hash);
    ticket["printLayout"] = json!(layout(c, ctx)?);
    if let Some(attempt) = last_attempt(c, op)? {
        ticket["printAttempt"] = attempt;
    }
    Ok(ticket)
}
pub fn request_cut(
    c: &mut Connection,
    ctx: &CatalogueContext,
    op: &str,
    hash: &str,
    attempt: &str,
) -> Result<bool, AppError> {
    EntityId::parse(attempt).map_err(|_| invalid())?;
    let ticket = management_ticket(c, ctx, op)?;
    if ticket["printSnapshotHash"] != hash {
        return Err(invalid());
    }
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let old:Option<(String,String)>=tx.query_row("SELECT operation_id,snapshot_hash FROM native_document_print_attempts_v1 WHERE attempt_id=?1",[attempt],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
    if let Some((stored, h)) = old {
        if stored != op || h != hash {
            return Err(AppError::Protocol(ProtocolError::OperationIdConflict));
        }
        return Ok(false);
    }
    tx.execute(
        "INSERT INTO native_document_print_attempts_v1 VALUES(?1,?2,?3,'UNKNOWN')",
        (attempt, op, hash),
    )?;
    tx.commit()?;
    Ok(true)
}
pub fn failed_cut(
    c: &Connection,
    ctx: &CatalogueContext,
    op: &str,
    attempt: &str,
) -> Result<(), AppError> {
    management_ticket(c, ctx, op)?;
    c.execute("UPDATE native_document_print_attempts_v1 SET state='FAILED' WHERE attempt_id=?1 AND operation_id=?2",(attempt,op))?;
    Ok(())
}
pub fn cut_status(
    c: &Connection,
    ctx: &CatalogueContext,
    op: &str,
    attempt: &str,
) -> Result<String, AppError> {
    management_ticket(c, ctx, op)?;
    Ok(c.query_row("SELECT state FROM native_document_print_attempts_v1 WHERE attempt_id=?1 AND operation_id=?2",(attempt,op),|r|r.get(0))?)
}
pub fn request(
    c: &mut Connection,
    ctx: &CatalogueContext,
    op: &str,
    hash: &str,
    attempt: &str,
) -> Result<bool, AppError> {
    EntityId::parse(attempt).map_err(|_| invalid())?;
    history::ticket(c, ctx, op)?;
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let original: String = tx.query_row(
        "SELECT snapshot_hash FROM sale_ticket_snapshots_v1 WHERE operation_id=?1",
        [op],
        |r| r.get(0),
    )?;
    if original != hash {
        return Err(invalid());
    }
    let old: Option<(String, String)> = tx
        .query_row(
            "SELECT operation_id,snapshot_hash FROM native_document_print_attempts_v1 WHERE attempt_id=?1",
            [attempt],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    if let Some((stored, h)) = old {
        if stored != op || h != hash {
            return Err(AppError::Protocol(ProtocolError::OperationIdConflict));
        }
        return Ok(false);
    }
    tx.execute(
        "INSERT INTO native_document_print_attempts_v1 VALUES(?1,?2,?3,'UNKNOWN')",
        (attempt, op, hash),
    )?;
    tx.execute(
        "UPDATE sale_print_jobs_v1 SET state='UNKNOWN' WHERE operation_id=?1",
        [op],
    )?;
    tx.commit()?;
    Ok(true)
}
pub fn failed(
    c: &Connection,
    ctx: &CatalogueContext,
    op: &str,
    attempt: &str,
) -> Result<(), AppError> {
    sales::ticket(c, ctx, op)?;
    c.execute("UPDATE native_document_print_attempts_v1 SET state='FAILED' WHERE attempt_id=?1 AND operation_id=?2",(attempt,op))?;
    Ok(())
}
pub fn ticket(
    c: &Connection,
    ctx: &CatalogueContext,
    op: &str,
) -> Result<serde_json::Value, AppError> {
    let mut v = history::ticket(c, ctx, op)?;
    let hash: String = c.query_row(
        "SELECT snapshot_hash FROM sale_ticket_snapshots_v1 WHERE operation_id=?1",
        [op],
        |r| r.get(0),
    )?;
    v["printSnapshotHash"] = serde_json::json!(hash);
    v["printLayout"] = json!(layout(c, ctx)?);
    if let Some(attempt) = last_attempt(c, op)? {
        v["printAttempt"] = attempt;
    }
    Ok(v)
}
pub fn status(
    c: &Connection,
    ctx: &CatalogueContext,
    op: &str,
    attempt: &str,
) -> Result<String, AppError> {
    history::ticket(c, ctx, op)?;
    Ok(c.query_row(
        "SELECT state FROM native_document_print_attempts_v1 WHERE attempt_id=?1 AND operation_id=?2",
        (attempt, op),
        |r| r.get(0),
    )?)
}
