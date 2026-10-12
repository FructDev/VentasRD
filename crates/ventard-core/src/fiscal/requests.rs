//! Native-owned v2 requests: persist before sending, lookup on every recovery,
//! exact contextual receipt and allocated block committed in one transaction.
//! The transport must authenticate the server; this is not a signature verifier.
use super::reservations::{self as blocks, AllocatedBlockEvidence, NcfKind};
use crate::{
    application::errors::AppError,
    domain::{canonical::canonicalize, identity::EntityId},
    security::offline_grant::VerifiedGrant,
    storage::catalogue_preview::{self, CatalogueContext},
};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior};
use serde::Serialize;
use serde_json::{json, Value};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AllocationRequest {
    pub payload: Value,
    pub hash: String,
}
impl AllocationRequest {
    pub fn request_id(&self) -> &str {
        self.payload["requestId"].as_str().unwrap_or("")
    }
    pub fn rpc_body(&self) -> Value {
        json!({"p_request":self.payload,"p_hash":self.hash})
    }
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FiscalView {
    pub pending: Vec<String>,
    pub available_b01: String,
    pub available_b02: String,
    pub last_status: Option<String>,
    pub last_reason: Option<String>,
}
fn encode(v: &Value) -> Result<(String, String), AppError> {
    canonicalize(&serde_json::to_vec(v).map_err(|_| blocks::invalid())?)
        .map_err(|_| blocks::invalid())
}
fn row(
    c: &Connection,
    ctx: &CatalogueContext,
    kind: NcfKind,
) -> Result<Option<AllocationRequest>, AppError> {
    let key = catalogue_preview::key(ctx).map_err(|_| blocks::invalid())?;
    let old:Option<(Vec<u8>,String)>=c.query_row("SELECT payload_bytes,payload_hash FROM fiscal_requests_v2 WHERE context_key=?1 AND kind=?2 AND state='UNKNOWN'",(key,kind.text()),|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
    old.map(|(bytes, hash)| {
        let payload: Value = serde_json::from_slice(&bytes).map_err(|_| blocks::invalid())?;
        let (canonical, h) = encode(&payload)?;
        if canonical.as_bytes() != bytes || h != hash {
            return Err(blocks::invalid());
        }
        Ok(AllocationRequest { payload, hash })
    })
    .transpose()
}
pub fn prepare(
    c: &mut Connection,
    g: &VerifiedGrant,
    now: u64,
    high: u64,
    openings: u64,
    kind: NcfKind,
) -> Result<AllocationRequest, AppError> {
    let ctx = blocks::grant_context(g, now, high, openings)?;
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    // Range provisioning is permitted before commercial bootstrap. It does not
    // mark this installation, stock or vault as commercially ready.
    if let Some(r) = row(&tx, &ctx, kind)? {
        return Ok(r);
    }
    let payload = json!({"version":"2","requestId":EntityId::new_random().to_string(),"tenantId":ctx.tenant_id,"actorId":ctx.actor_id,"installationId":ctx.installation_id,"deviceId":ctx.device_id,"writerEpoch":ctx.writer_epoch,"scopeType":ctx.scope_type,"branchId":ctx.branch_id,"kind":kind.text(),"quantity":"20"});
    let (bytes, hash) = encode(&payload)?;
    let r = AllocationRequest { payload, hash };
    let key = catalogue_preview::key(&ctx).map_err(|_| blocks::invalid())?;
    tx.execute(
        "INSERT INTO fiscal_requests_v2 VALUES(?1,?2,?3,?4,?5,'UNKNOWN',NULL)",
        (key, r.request_id(), kind.text(), bytes.as_bytes(), &r.hash),
    )?;
    tx.commit()?;
    Ok(r)
}
fn number(v: &Value) -> Result<u32, AppError> {
    let s = v.as_str().ok_or_else(blocks::invalid)?;
    let n = s.parse::<u32>().map_err(|_| blocks::invalid())?;
    if n == 0 || n > 99_999_999 || n.to_string() != s {
        return Err(blocks::invalid());
    }
    Ok(n)
}
pub fn accept(
    c: &mut Connection,
    g: &VerifiedGrant,
    now: u64,
    high: u64,
    openings: u64,
    r: &AllocationRequest,
    receipt: &Value,
) -> Result<(), AppError> {
    let ctx = blocks::grant_context(g, now, high, openings)?;
    let key = catalogue_preview::key(&ctx).map_err(|_| blocks::invalid())?;
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let stored:Option<(Vec<u8>,String,Option<Vec<u8>>)>=tx.query_row("SELECT payload_bytes,payload_hash,receipt_bytes FROM fiscal_requests_v2 WHERE context_key=?1 AND request_id=?2",(&key,r.request_id()),|s|Ok((s.get(0)?,s.get(1)?,s.get(2)?))).optional()?;
    let (bytes, hash, old) = stored.ok_or_else(blocks::invalid)?;
    let (canonical, h) = encode(&r.payload)?;
    if bytes != canonical.as_bytes() || hash != h || hash != r.hash {
        return Err(blocks::conflict());
    }
    let expected_context = json!({"actorId":ctx.actor_id,"tenantId":ctx.tenant_id,"installationId":ctx.installation_id,"deviceId":ctx.device_id,"writerEpoch":ctx.writer_epoch,"scopeType":ctx.scope_type,"branchId":ctx.branch_id});
    for (k, v) in expected_context.as_object().unwrap() {
        if r.payload.get(k) != Some(v) {
            return Err(blocks::invalid());
        }
    }
    let o = receipt.as_object().ok_or_else(blocks::invalid)?;
    let fields = [
        "payloadHash",
        "status",
        "first",
        "last",
        "sourceRef",
        "reason",
    ];
    if fields.iter().any(|field| !o.contains_key(*field))
        || o.len() != r.payload.as_object().ok_or_else(blocks::invalid)?.len() + 6
        || receipt["payloadHash"] != hash
    {
        return Err(blocks::invalid());
    }
    for (k, v) in r.payload.as_object().unwrap() {
        if o.get(k) != Some(v) {
            return Err(blocks::invalid());
        }
    }
    EntityId::parse(receipt["sourceRef"].as_str().ok_or_else(blocks::invalid)?)
        .map_err(|_| blocks::invalid())?;
    let (receipt_bytes, _) = encode(receipt)?;
    if let Some(old) = old {
        return if old == receipt_bytes.as_bytes() {
            Ok(())
        } else {
            Err(blocks::conflict())
        };
    }
    let status = receipt["status"].as_str().ok_or_else(blocks::invalid)?;
    match status {
        "ALLOCATED" => {
            if !receipt["reason"].is_null() {
                return Err(blocks::invalid());
            }
            let first = number(&receipt["first"])?;
            let last = number(&receipt["last"])?;
            let kind = match r.payload["kind"].as_str() {
                Some("B01") => NcfKind::B01,
                Some("B02") => NcfKind::B02,
                _ => return Err(blocks::invalid()),
            };
            // Installations may be provisioned locally later. The fiscal block
            // is bound to the authenticated grant, never activates stock/sales.
            let b = AllocatedBlockEvidence {
                request_id: r.request_id().into(),
                tenant_id: ctx.tenant_id.clone(),
                device_id: ctx.device_id.clone(),
                installation_id: ctx.installation_id.clone(),
                writer_epoch: ctx.writer_epoch.clone(),
                kind,
                first,
                last,
                source_ref: receipt["sourceRef"].as_str().unwrap().into(),
            };
            blocks::store_allocated_block_in(&tx, &ctx, &b)?;
        }
        "NO_BLOCK" => {
            if !receipt["first"].is_null()
                || !receipt["last"].is_null()
                || !matches!(
                    receipt["reason"].as_str(),
                    Some("NOT_CONFIGURED" | "KIND_NOT_CONFIGURED" | "DISABLED" | "EXHAUSTED")
                )
            {
                return Err(blocks::invalid());
            }
        }
        _ => return Err(blocks::invalid()),
    }
    tx.execute("UPDATE fiscal_requests_v2 SET state=?3,receipt_bytes=?4 WHERE context_key=?1 AND request_id=?2",(&key,r.request_id(),status,receipt_bytes.as_bytes()))?;
    tx.commit()?;
    Ok(())
}
pub fn read(c: &Connection, ctx: &CatalogueContext) -> Result<FiscalView, AppError> {
    let key = catalogue_preview::key(ctx).map_err(|_| blocks::invalid())?;
    let mut stmt=c.prepare("SELECT kind FROM fiscal_requests_v2 WHERE context_key=?1 AND state='UNKNOWN' ORDER BY kind")?;
    let pending = stmt
        .query_map([&key], |r| r.get(0))?
        .collect::<Result<Vec<String>, _>>()?;
    let available = |kind: &str| -> Result<String, AppError> {
        let n:i64=c.query_row("SELECT coalesce(sum(last_number-next_number+1),0) FROM fiscal_blocks WHERE tenant_id=?1 AND installation_id=?2 AND device_id=?3 AND writer_epoch=?4 AND kind=?5 AND next_number<=last_number",(&ctx.tenant_id,&ctx.installation_id,&ctx.device_id,&ctx.writer_epoch,kind),|r|r.get(0))?;
        Ok(n.to_string())
    };
    let last:Option<(String,Vec<u8>)>=c.query_row("SELECT state,receipt_bytes FROM fiscal_requests_v2 WHERE context_key=?1 AND state<>'UNKNOWN' ORDER BY rowid DESC LIMIT 1",[key],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
    let (last_status, last_reason) = match last {
        Some((status, bytes)) => {
            let v: Value = serde_json::from_slice(&bytes).map_err(|_| blocks::invalid())?;
            (Some(status), v["reason"].as_str().map(str::to_owned))
        }
        None => (None, None),
    };
    Ok(FiscalView {
        pending,
        available_b01: available("B01")?,
        available_b02: available("B02")?,
        last_status,
        last_reason,
    })
}
