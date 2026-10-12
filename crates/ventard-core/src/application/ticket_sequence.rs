//! Local durable ticket counter. Registration evidence comes from a trusted
//! native bootstrap adapter, never sales MAX/history length or renderer input.
//! This is NOT clone detection or server prefix ownership (G6/G7 remain gates).
use crate::domain::{
    canonical::canonicalize,
    identity::EntityId,
    ticket_sequence::{format_ticket, next_ticket_number},
};
use crate::{
    application::errors::AppError,
    fiscal::reservations::{conflict, grant_context, installation, invalid, unknown},
    security::offline_grant::VerifiedGrant,
    storage::catalogue_preview::{self, CatalogueContext},
};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde_json::{json, Value};
#[derive(Debug)]
pub struct TicketSeedEvidence {
    pub prefix: String,
    pub last_issued: u64,
    pub source_ref: String,
}
pub fn register_ticket_seed(
    c: &mut Connection,
    g: &VerifiedGrant,
    now: u64,
    high: u64,
    openings: u64,
    seed: &TicketSeedEvidence,
) -> Result<(), AppError> {
    let ctx = grant_context(g, now, high, openings)?;
    EntityId::parse(&seed.source_ref).map_err(|_| invalid())?;
    if format_ticket(&seed.prefix, 1).is_err() || seed.last_issued > 9_007_199_254_740_991 {
        return Err(invalid());
    }
    let(bytes,hash)=canonicalize(&serde_json::to_vec(&json!({"tenantId":ctx.tenant_id,"deviceId":ctx.device_id,"installationId":ctx.installation_id,"writerEpoch":ctx.writer_epoch,"prefix":seed.prefix,"lastIssued":seed.last_issued.to_string(),"sourceRef":seed.source_ref})).map_err(|_|invalid())?).map_err(|_|invalid())?;
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if installation(&tx, &ctx)? != seed.prefix {
        return Err(conflict());
    }
    let old: Option<String> = tx
        .query_row(
            "SELECT evidence_hash FROM ticket_sequences WHERE tenant_id=?1 AND installation_id=?2",
            (&ctx.tenant_id, &ctx.installation_id),
            |r| r.get(0),
        )
        .optional()?;
    if let Some(h) = old {
        return if h == hash { Ok(()) } else { Err(conflict()) };
    }
    let occupied: i64 = tx.query_row(
        "SELECT count(*) FROM ticket_sequences WHERE tenant_id=?1 AND prefix=?2",
        (&ctx.tenant_id, &seed.prefix),
        |r| r.get(0),
    )?;
    if occupied != 0 {
        return Err(conflict());
    }
    tx.execute(
        "INSERT INTO ticket_sequences VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
        (
            &ctx.tenant_id,
            &ctx.installation_id,
            &ctx.device_id,
            &ctx.writer_epoch,
            &seed.prefix,
            seed.last_issued,
            hash,
            bytes.as_bytes(),
        ),
    )?;
    tx.commit()?;
    Ok(())
}
/// Must be called within the SAME parent transaction as all sale effects.
pub fn issue_ticket_in(
    tx: &Transaction<'_>,
    ctx: &CatalogueContext,
    op: &str,
    hash: &str,
) -> Result<String, AppError> {
    catalogue_preview::key(ctx).map_err(|_| invalid())?;
    EntityId::parse(op).map_err(|_| invalid())?;
    let row:Option<(Vec<u8>,String,String)>=tx.query_row("SELECT canonical_bytes,hash,local_state FROM operation_journal WHERE operation_id=?1 AND kind='SALE_CONFIRM'",[op],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
    let (bytes, h, state) = row.ok_or_else(unknown)?;
    let (canonical, actual) = canonicalize(&bytes).map_err(|_| invalid())?;
    if h != hash || actual != hash || canonical.as_bytes() != bytes {
        return Err(conflict());
    }
    let intent: Value = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    if intent["negocioId"] != ctx.tenant_id
        || intent["installationId"] != ctx.installation_id
        || intent["originDeviceId"] != ctx.device_id
        || intent["writerEpoch"] != ctx.writer_epoch
        || intent["actorId"] != ctx.actor_id
        || intent["scope"] != json!({"type":ctx.scope_type,"sucursalId":ctx.branch_id})
    {
        return Err(conflict());
    }
    let old:Option<String>=tx.query_row("SELECT ticket FROM ticket_allocations WHERE operation_id=?1 AND tenant_id=?2 AND installation_id=?3 AND intention_hash=?4",(op,&ctx.tenant_id,&ctx.installation_id,hash),|r|r.get(0)).optional()?;
    if let Some(ticket) = old {
        return if matches!(state.as_str(), "PREPARED" | "COMMITTED") {
            Ok(ticket)
        } else {
            Err(conflict())
        };
    }
    if state != "PREPARED" {
        return Err(conflict());
    }
    let prefix = installation(tx, ctx)?;
    let last:Option<u64>=tx.query_row("SELECT last_issued FROM ticket_sequences WHERE tenant_id=?1 AND installation_id=?2 AND device_id=?3 AND writer_epoch=?4 AND prefix=?5",(&ctx.tenant_id,&ctx.installation_id,&ctx.device_id,&ctx.writer_epoch,&prefix),|r|r.get(0)).optional()?;
    let next = next_ticket_number(last.ok_or_else(unknown)?).map_err(|_| invalid())?;
    let ticket = format_ticket(&prefix, next).map_err(|_| invalid())?;
    tx.execute(
        "UPDATE ticket_sequences SET last_issued=?3 WHERE tenant_id=?1 AND installation_id=?2",
        (&ctx.tenant_id, &ctx.installation_id, next),
    )?;
    tx.execute(
        "INSERT INTO ticket_allocations VALUES(?1,?2,?3,?4,?5,?6)",
        (
            op,
            &ctx.tenant_id,
            &ctx.installation_id,
            hash,
            next,
            &ticket,
        ),
    )?;
    Ok(ticket)
}
