//! Local fiscal evidence/reservations only. No remote allocator, signing,
//! business RPC or inferred authorization from configuration/legacy flags.
use crate::{
    application::errors::{AppError, AuthError, BusinessError, ProtocolError},
    domain::{canonical::canonicalize, identity::EntityId},
    security::offline_grant::VerifiedGrant,
    storage::catalogue_preview::{self, CatalogueContext},
};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde_json::{json, Value};
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NcfKind {
    B01,
    B02,
}
impl NcfKind {
    pub fn text(self) -> &'static str {
        match self {
            Self::B01 => "B01",
            Self::B02 => "B02",
        }
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RequestState {
    InFlight,
    Unknown,
    Received,
    NoBlock,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RequestRecovery {
    NoAutomaticRetry,
    LookupSameId,
    Complete,
}
pub fn request_recovery(version: u32, state: RequestState) -> RequestRecovery {
    match (version, state) {
        (_, RequestState::Received | RequestState::NoBlock) => RequestRecovery::Complete,
        (2, RequestState::Unknown | RequestState::InFlight) => RequestRecovery::LookupSameId,
        _ => RequestRecovery::NoAutomaticRetry,
    }
}
/// Native trusted transport facts, NOT a renderer DTO or verified server
/// signature. T058 must validate authentication and exact response provenance.
#[derive(Debug)]
pub struct AllocatedBlockEvidence {
    pub request_id: String,
    pub tenant_id: String,
    pub device_id: String,
    pub installation_id: String,
    pub writer_epoch: String,
    pub kind: NcfKind,
    pub first: u32,
    pub last: u32,
    pub source_ref: String,
}
#[derive(Debug, Clone)]
pub(crate) struct Candidate {
    pub block_id: String,
    pub kind: NcfKind,
    pub number: u32,
    pub ncf: String,
}
impl Candidate {
    pub(crate) fn value(&self, op: &str) -> Value {
        json!({"reservationId":op,"blockId":self.block_id,"type":self.kind.text(),"ncf":self.ncf,"number":self.number.to_string()})
    }
}
pub(crate) fn invalid() -> AppError {
    AppError::Protocol(ProtocolError::MalformedPayload)
}
pub(crate) fn unknown() -> AppError {
    AppError::Business(BusinessError::FiscalUnknown)
}
pub(crate) fn conflict() -> AppError {
    AppError::Protocol(ProtocolError::OperationIdConflict)
}
pub(crate) fn grant_context(
    g: &VerifiedGrant,
    now: u64,
    high: u64,
    openings: u64,
) -> Result<CatalogueContext, AppError> {
    if !g
        .evaluate(now, high, openings)
        .map_err(|_| invalid())?
        .allows("SELL")
    {
        return Err(AppError::Auth(AuthError::PermissionDenied {
            required: "SELL".into(),
        }));
    }
    let p = g.payload();
    Ok(CatalogueContext {
        tenant_id: p.tenant_id.clone(),
        actor_id: p.actor_id.clone(),
        device_id: p.device_id.clone(),
        installation_id: p.installation_id.clone(),
        writer_epoch: p.writer_epoch.clone(),
        scope_type: p.scope.r#type.clone(),
        branch_id: p.scope.branch_id.clone(),
    })
}
pub(crate) fn installation(c: &Connection, ctx: &CatalogueContext) -> Result<String, AppError> {
    catalogue_preview::key(ctx).map_err(|_| invalid())?;
    c.query_row("SELECT ticket_prefix FROM installations WHERE installation_id=?1 AND device_id=?2 AND writer_epoch=?3 AND status='ACTIVE'",(&ctx.installation_id,&ctx.device_id,&ctx.writer_epoch),|r|r.get(0)).optional()?.ok_or_else(unknown)
}
pub fn store_allocated_block(
    c: &mut Connection,
    g: &VerifiedGrant,
    now: u64,
    high: u64,
    openings: u64,
    b: &AllocatedBlockEvidence,
) -> Result<(), AppError> {
    let ctx = grant_context(g, now, high, openings)?;
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    installation(&tx, &ctx)?;
    store_allocated_block_in(&tx, &ctx, b)?;
    tx.commit()?;
    Ok(())
}
pub(crate) fn store_allocated_block_in(
    tx: &Transaction<'_>,
    ctx: &CatalogueContext,
    b: &AllocatedBlockEvidence,
) -> Result<(), AppError> {
    for id in [&b.request_id, &b.source_ref] {
        EntityId::parse(id).map_err(|_| invalid())?;
    }
    if b.tenant_id != ctx.tenant_id
        || b.device_id != ctx.device_id
        || b.installation_id != ctx.installation_id
        || b.writer_epoch != ctx.writer_epoch
    {
        return Err(AppError::Auth(AuthError::PermissionDenied {
            required: "FISCAL_CONTEXT".into(),
        }));
    }
    if b.first == 0 || b.last < b.first || b.last > 99_999_999 || b.last - b.first >= 20 {
        return Err(invalid());
    }
    let (bytes,hash)=canonicalize(&serde_json::to_vec(&json!({"requestId":b.request_id,"tenantId":b.tenant_id,"deviceId":b.device_id,"installationId":b.installation_id,"writerEpoch":b.writer_epoch,"kind":b.kind.text(),"first":b.first.to_string(),"last":b.last.to_string(),"sourceRef":b.source_ref})).map_err(|_|invalid())?).map_err(|_|invalid())?;
    catalogue_preview::key(ctx).map_err(|_| invalid())?;
    let old: Option<String> = tx
        .query_row(
            "SELECT evidence_hash FROM fiscal_blocks WHERE tenant_id=?1 AND request_id=?2",
            (&ctx.tenant_id, &b.request_id),
            |r| r.get(0),
        )
        .optional()?;
    if let Some(h) = old {
        return if h == hash { Ok(()) } else { Err(conflict()) };
    }
    let water: Option<u32> = tx
        .query_row(
            "SELECT last_accepted FROM fiscal_watermarks WHERE tenant_id=?1 AND kind=?2",
            (&ctx.tenant_id, b.kind.text()),
            |r| r.get(0),
        )
        .optional()?;
    if water.is_some_and(|w| b.first <= w) {
        return Err(conflict());
    }
    tx.execute(
        "INSERT INTO fiscal_blocks VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?7,?9,?10)",
        (
            &ctx.tenant_id,
            &b.request_id,
            &ctx.device_id,
            &ctx.installation_id,
            &ctx.writer_epoch,
            b.kind.text(),
            b.first,
            b.last,
            hash,
            bytes.as_bytes(),
        ),
    )?;
    tx.execute("INSERT INTO fiscal_watermarks VALUES(?1,?2,?3) ON CONFLICT(tenant_id,kind)DO UPDATE SET last_accepted=excluded.last_accepted",(&ctx.tenant_id,b.kind.text(),b.last))?;
    Ok(())
}

pub(crate) fn verify_binding(
    c: &Connection,
    ctx: &CatalogueContext,
    op: &str,
    hash: &str,
    value: &Value,
    parent_state: &str,
) -> Result<(), AppError> {
    if value.is_null() {
        let n: i64 = c.query_row(
            "SELECT count(*) FROM fiscal_reservations WHERE operation_id=?1",
            [op],
            |r| r.get(0),
        )?;
        return if n == 0 { Ok(()) } else { Err(invalid()) };
    }
    type Binding = (String, String, u32, String, String, String);
    let key = catalogue_preview::key(ctx).map_err(|_| invalid())?;
    let row:Option<Binding>=c.query_row("SELECT r.block_id,r.kind,r.number,r.ncf,r.state,r.intention_hash FROM fiscal_reservations r JOIN fiscal_blocks b ON b.tenant_id=r.tenant_id AND b.request_id=r.block_id WHERE r.operation_id=?1 AND r.tenant_id=?2 AND r.context_key=?3 AND b.device_id=?4 AND b.installation_id=?5 AND b.writer_epoch=?6",(op,&ctx.tenant_id,key,&ctx.device_id,&ctx.installation_id,&ctx.writer_epoch),|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).optional()?;
    let (block, kind, number, ncf, state, intention) = row.ok_or_else(invalid)?;
    if intention != hash
        || state != parent_state
        || ncf != format!("{kind}{number:08}")
        || *value
            != json!({"reservationId":op,"blockId":block,"type":kind,"ncf":ncf,"number":number.to_string()})
    {
        return Err(invalid());
    }
    Ok(())
}
pub(crate) fn peek_in(
    c: &Connection,
    ctx: &CatalogueContext,
    kind: NcfKind,
) -> Result<Candidate, AppError> {
    installation(c, ctx)?;
    let row:Option<(String,u32)>=c.query_row("SELECT request_id,next_number FROM fiscal_blocks WHERE tenant_id=?1 AND device_id=?2 AND installation_id=?3 AND writer_epoch=?4 AND kind=?5 AND next_number<=last_number ORDER BY first_number LIMIT 1",(&ctx.tenant_id,&ctx.device_id,&ctx.installation_id,&ctx.writer_epoch,kind.text()),|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
    if let Some((block_id, number)) = row {
        return Ok(Candidate {
            block_id,
            kind,
            number,
            ncf: format!("{}{:08}", kind.text(), number),
        });
    }
    let known:i64=c.query_row("SELECT count(*) FROM fiscal_blocks WHERE tenant_id=?1 AND installation_id=?2 AND writer_epoch=?3 AND kind=?4",(&ctx.tenant_id,&ctx.installation_id,&ctx.writer_epoch,kind.text()),|r|r.get(0))?;
    Err(if known == 0 {
        unknown()
    } else {
        AppError::Business(BusinessError::FiscalExhausted)
    })
}
pub(crate) fn reserve_in(
    tx: &Transaction<'_>,
    ctx: &CatalogueContext,
    op: &str,
    hash: &str,
    candidate: &Candidate,
) -> Result<(), AppError> {
    let next = peek_in(tx, ctx, candidate.kind)?;
    if next.block_id != candidate.block_id
        || next.number != candidate.number
        || next.ncf != candidate.ncf
    {
        return Err(conflict());
    }
    let key = catalogue_preview::key(ctx).map_err(|_| invalid())?;
    tx.execute(
        "INSERT INTO fiscal_reservations VALUES(?1,?2,?3,?4,?5,?6,?7,?8,'PREPARED')",
        (
            op,
            &ctx.tenant_id,
            &candidate.block_id,
            key,
            hash,
            candidate.kind.text(),
            candidate.number,
            &candidate.ncf,
        ),
    )?;
    tx.execute("UPDATE fiscal_blocks SET next_number=next_number+1 WHERE tenant_id=?1 AND request_id=?2 AND next_number=?3",(&ctx.tenant_id,&candidate.block_id,candidate.number))?;
    Ok(())
}
pub(crate) fn abandon_in(
    tx: &Transaction<'_>,
    ctx: &CatalogueContext,
    op: &str,
    hash: &str,
) -> Result<(), AppError> {
    transition(tx, ctx, op, hash, "ABANDONED")
}
pub fn consume_in(
    tx: &Transaction<'_>,
    ctx: &CatalogueContext,
    op: &str,
    hash: &str,
) -> Result<(), AppError> {
    transition(tx, ctx, op, hash, "COMMITTED")
}
fn transition(
    tx: &Transaction<'_>,
    ctx: &CatalogueContext,
    op: &str,
    hash: &str,
    to: &str,
) -> Result<(), AppError> {
    let key = catalogue_preview::key(ctx).map_err(|_| invalid())?;
    let state:Option<String>=tx.query_row("SELECT r.state FROM fiscal_reservations r JOIN operation_journal j ON j.operation_id=r.operation_id WHERE r.operation_id=?1 AND r.tenant_id=?2 AND r.context_key=?3 AND r.intention_hash=?4 AND j.hash=?4 AND j.local_state='PREPARED'",(op,&ctx.tenant_id,key,hash),|r|r.get(0)).optional()?;
    match state.as_deref() {
        Some("PREPARED") => {
            tx.execute(
                "UPDATE fiscal_reservations SET state=?2 WHERE operation_id=?1",
                (op, to),
            )?;
            Ok(())
        }
        Some(s) if s == to => Ok(()),
        _ => Err(conflict()),
    }
}
