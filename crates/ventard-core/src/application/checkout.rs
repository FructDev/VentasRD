//! Durable preparation, not SALE_CONFIRM. Internal native API, no write IPC.
//! A commercial caller still needs operational bootstrap/drawer fencing/fiscal.
use super::errors::{AppError, AuthError, BusinessError, ProtocolError};
use crate::{
    domain::{
        canonical::canonicalize,
        identity::{EntityId, Scope},
        sale_plan::ValidatedSale,
    },
    fiscal::reservations::{self as fiscal, NcfKind},
    security::offline_grant::VerifiedGrant,
    storage::catalogue_preview::{self, CatalogueContext},
};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior};
use serde::Serialize;
use serde_json::{json, Value};

#[derive(Debug, Clone)]
pub struct CheckoutPrepare {
    pub operation_id: String,
    pub cart_id: String,
    pub expected_revision: String,
    pub accepted_quote_hash: String,
    pub fiscal_type: Option<NcfKind>,
}
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckoutView {
    pub operation_id: String,
    pub hash: String,
    pub local_seq: String,
    pub state: String,
    pub intent: Value,
    pub result: Option<Value>,
}
fn invalid() -> AppError {
    AppError::Protocol(ProtocolError::MalformedPayload)
}
fn conflict() -> AppError {
    AppError::Protocol(ProtocolError::OperationIdConflict)
}
fn stale() -> AppError {
    AppError::Business(BusinessError::Conflict {
        message: "CHECKOUT_CHANGED".into(),
    })
}
fn denied() -> AppError {
    AppError::Auth(AuthError::PermissionDenied {
        required: "CHECKOUT_CONTEXT".into(),
    })
}
pub(crate) fn context(g: &VerifiedGrant) -> CatalogueContext {
    let p = g.payload();
    CatalogueContext {
        tenant_id: p.tenant_id.clone(),
        actor_id: p.actor_id.clone(),
        device_id: p.device_id.clone(),
        installation_id: p.installation_id.clone(),
        writer_epoch: p.writer_epoch.clone(),
        scope_type: p.scope.r#type.clone(),
        branch_id: p.scope.branch_id.clone(),
    }
}
pub(crate) fn permitted(
    g: &VerifiedGrant,
    now: u64,
    high: u64,
    openings: u64,
    cap: &str,
) -> Result<String, AppError> {
    let decision = g.evaluate(now, high, openings).map_err(|_| denied())?;
    if !decision.allows(cap) {
        return Err(denied());
    }
    Ok(decision.effective_time_ms)
}
pub(crate) fn load(
    c: &Connection,
    ctx: &CatalogueContext,
    operation: &str,
    hash: &str,
) -> Result<CheckoutView, AppError> {
    EntityId::parse(operation).map_err(|_| invalid())?;
    let key = catalogue_preview::key(ctx).map_err(|_| invalid())?;
    type JournalRow = (String, Vec<u8>, i64, String, Option<String>);
    let row:Option<JournalRow>=c.query_row("SELECT j.hash,j.canonical_bytes,j.local_seq,j.local_state,j.result FROM checkout_drafts d JOIN operation_journal j ON j.operation_id=d.operation_id WHERE d.operation_id=?1 AND d.context_key=?2",(operation,key),|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional()?;
    let (stored, bytes, seq, state, result) = row.ok_or_else(denied)?;
    if stored != hash {
        return Err(conflict());
    }
    let (canonical, actual) = canonicalize(&bytes).map_err(|_| invalid())?;
    if canonical.as_bytes() != bytes || actual != stored {
        return Err(invalid());
    }
    let intent: Value = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    if intent["protocol"] != "ventard.native.v1"
        || intent["kind"] != "SALE_CONFIRM"
        || intent["operationId"] != operation
        || intent["negocioId"] != ctx.tenant_id
        || intent["actorId"] != ctx.actor_id
        || intent["originDeviceId"] != ctx.device_id
        || intent["installationId"] != ctx.installation_id
        || intent["writerEpoch"] != ctx.writer_epoch
        || intent["scope"] != json!({"type":ctx.scope_type,"sucursalId":ctx.branch_id})
    {
        return Err(denied());
    }
    if !matches!(state.as_str(), "PREPARED" | "COMMITTED" | "ABANDONED")
        || (state == "COMMITTED") != result.is_some()
    {
        return Err(invalid());
    }
    fiscal::verify_binding(
        c,
        ctx,
        operation,
        hash,
        &intent["payload"]["sale"]["fiscal"],
        &state,
    )?;
    Ok(CheckoutView {
        operation_id: operation.into(),
        hash: stored,
        local_seq: seq.to_string(),
        state,
        intent,
        result: result
            .map(|s| serde_json::from_str(&s).map_err(|_| invalid()))
            .transpose()?,
    })
}
pub fn read_checkout(
    c: &Connection,
    g: &VerifiedGrant,
    now: u64,
    high: u64,
    openings: u64,
    operation: &str,
    hash: &str,
) -> Result<CheckoutView, AppError> {
    permitted(g, now, high, openings, "READ")?;
    load(c, &context(g), operation, hash)
}
#[allow(clippy::too_many_arguments)]
pub fn prepare_checkout(
    c: &mut Connection,
    g: &VerifiedGrant,
    now: u64,
    high: u64,
    openings: u64,
    req: CheckoutPrepare,
    sale: &ValidatedSale,
) -> Result<CheckoutView, AppError> {
    prepare_with_request(c, g, now, high, openings, req, sale, None)
}
#[allow(clippy::too_many_arguments)]
pub(crate) fn prepare_with_request(
    c: &mut Connection,
    g: &VerifiedGrant,
    now: u64,
    high: u64,
    openings: u64,
    req: CheckoutPrepare,
    sale: &ValidatedSale,
    request: Option<Value>,
) -> Result<CheckoutView, AppError> {
    let time = permitted(g, now, high, openings, "SELL")?;
    let ctx = context(g);
    let key = catalogue_preview::key(&ctx).map_err(|_| invalid())?;
    EntityId::parse(&req.operation_id).map_err(|_| invalid())?;
    EntityId::parse(&req.cart_id).map_err(|_| invalid())?;
    let revision = req
        .expected_revision
        .parse::<i64>()
        .map_err(|_| invalid())?;
    if revision <= 0
        || revision.to_string() != req.expected_revision
        || req.accepted_quote_hash != sale.quote_hash()
    {
        return Err(invalid());
    }
    let tenant = EntityId::parse(&ctx.tenant_id).map_err(|_| invalid())?;
    let scope = Scope::parse_command(Some(&ctx.scope_type), ctx.branch_id.as_deref())
        .map_err(|_| invalid())?;
    if sale.context() != (tenant, scope) {
        return Err(denied());
    }
    let mut payload = json!({"cartId":req.cart_id,"cartRevision":req.expected_revision,"quoteHash":req.accepted_quote_hash,"sale":sale.payload()});
    if let Some(request) = request {
        payload["request"] = request;
    }
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    // Fail closed. A preview/catalogue grant or local PIN cannot activate a vault.
    let active: i64 = tx.query_row(
        "SELECT count(*) FROM vault_meta WHERE negocio_id=?1 AND activation_state='ACTIVE'",
        [&ctx.tenant_id],
        |r| r.get(0),
    )?;
    let installation:i64=tx.query_row("SELECT count(*) FROM installations WHERE installation_id=?1 AND device_id=?2 AND writer_epoch=?3 AND status='ACTIVE'",(&ctx.installation_id,&ctx.device_id,&ctx.writer_epoch),|r|r.get(0))?;
    if active != 1 || installation != 1 {
        return Err(denied());
    }
    let existing: Option<String> = tx
        .query_row(
            "SELECT hash FROM operation_journal WHERE operation_id=?1",
            [&req.operation_id],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(hash) = existing {
        let first = load(&tx, &ctx, &req.operation_id, &hash)?;
        let original_fiscal = &first.intent["payload"]["sale"]["fiscal"];
        match req.fiscal_type {
            Some(kind) if original_fiscal["type"] == kind.text() => {
                payload["sale"]["fiscal"] = original_fiscal.clone();
            }
            None if original_fiscal.is_null() => {}
            _ => return Err(conflict()),
        }
        if first.intent["payload"] != payload {
            return Err(conflict());
        }
        if first.state == "ABANDONED" {
            return Err(AppError::Business(BusinessError::OperationAbandoned));
        }
        return Ok(first);
    }
    let original:Option<(i64,String)>=tx.query_row("SELECT revision,lines FROM account_drafts WHERE context_key=?1 AND id=?2 AND status='ACTIVE'",(&key,&req.cart_id),|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
    let (cart_revision, raw) = original.ok_or_else(stale)?;
    if cart_revision != revision {
        return Err(stale());
    }
    let lines: Vec<super::drafts::DraftLine> = serde_json::from_str(&raw).map_err(|_| invalid())?;
    let accepted = sale.payload();
    let quote_lines = accepted["lines"].as_array().ok_or_else(invalid)?;
    // Current account draft supports product lines only; free-line draft port is
    // separate. Never consume another cart or promote preview revision to authority.
    if lines.len() != quote_lines.len()
        || lines
            .iter()
            .zip(quote_lines)
            .enumerate()
            .any(|(index, (a, b))| {
                let free = payload["request"]["lines"][index]["free"].is_object()
                    && payload["request"]["lines"][index]["productId"] == a.product_id;
                (b["productId"] != a.product_id && !(b["productId"].is_null() && free))
                    || b["quantity"] != json!({"numerator":a.quantity,"denominator":"1"})
            })
    {
        return Err(stale());
    }
    ensure_editable(&tx, &key, &req.cart_id)?;
    let fiscal_candidate = req
        .fiscal_type
        .map(|kind| fiscal::peek_in(&tx, &ctx, kind))
        .transpose()?;
    if let Some(candidate) = &fiscal_candidate {
        payload["sale"]["fiscal"] = candidate.value(&req.operation_id);
    }
    let p = g.payload();
    let intent = json!({"protocol":"ventard.native.v1","kind":"SALE_CONFIRM","contractVersion":1,"canonicalizationVersion":"C-N1","operationId":req.operation_id,"negocioId":ctx.tenant_id,"scope":{"type":ctx.scope_type,"sucursalId":ctx.branch_id},"originDeviceId":ctx.device_id,"installationId":ctx.installation_id,"writerEpoch":ctx.writer_epoch,"actorId":ctx.actor_id,"permissionGrantId":p.grant_id,"originalTurnId":accepted["payment"]["turnId"],"originAtUtcMs":time,"expectedVersions":{"cart":req.expected_revision},"dependencies":[],"payload":payload});
    let (canonical, hash) = canonicalize(&serde_json::to_vec(&intent).map_err(|_| invalid())?)
        .map_err(|_| invalid())?;
    let origin_scope = match scope {
        Scope::Global => "GLOBAL".into(),
        Scope::Branch(id) => format!("BRANCH:{id}"),
        _ => return Err(invalid()),
    };
    tx.execute("INSERT INTO operation_journal(operation_id,protocol,kind,version,canonical_bytes,hash,origin_actor,origin_scope,origin_device,origin_epoch,prepared_at,local_seq,local_state)VALUES(?1,'ventard.native.v1','SALE_CONFIRM',1,?2,?3,?4,?5,?6,?7,?8,COALESCE((SELECT MAX(local_seq) FROM operation_journal),0)+1,'PREPARED')",(&req.operation_id,canonical.as_bytes(),&hash,&ctx.actor_id,origin_scope,&ctx.device_id,&ctx.writer_epoch,&time))?;
    tx.execute(
        "INSERT INTO checkout_drafts VALUES(?1,?2,?3,?4,?5)",
        (
            &req.operation_id,
            &key,
            &req.cart_id,
            revision,
            &req.accepted_quote_hash,
        ),
    )?;
    if let Some(candidate) = &fiscal_candidate {
        fiscal::reserve_in(&tx, &ctx, &req.operation_id, &hash, candidate)?;
    }
    let view = load(&tx, &ctx, &req.operation_id, &hash)?;
    tx.commit()?;
    Ok(view)
}
pub(crate) fn ensure_editable(c: &Connection, key: &str, cart: &str) -> Result<(), AppError> {
    let locked:i64=c.query_row("SELECT count(*) FROM checkout_drafts d JOIN operation_journal j ON j.operation_id=d.operation_id WHERE d.context_key=?1 AND d.cart_id=?2 AND j.local_state='PREPARED'",(key,cart),|r|r.get(0))?;
    if locked != 0 {
        return Err(stale());
    }
    Ok(())
}
pub fn abandon_checkout(
    c: &mut Connection,
    g: &VerifiedGrant,
    now: u64,
    high: u64,
    openings: u64,
    operation: &str,
    hash: &str,
) -> Result<(), AppError> {
    permitted(g, now, high, openings, "READ")?;
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let view = load(&tx, &context(g), operation, hash)?;
    match view.state.as_str() {
        "ABANDONED" => return Ok(()),
        "PREPARED" => {}
        _ => return Err(stale()),
    }
    // Abandon reservation and intention together. The allocated number is burned;
    // an unknown binding cannot silently free a fiscal number.
    if !view.intent["payload"]["sale"]["fiscal"].is_null() {
        fiscal::abandon_in(&tx, &context(g), operation, hash)?;
    }
    tx.execute("UPDATE operation_journal SET local_state='ABANDONED' WHERE operation_id=?1 AND local_state='PREPARED'",[operation])?;
    tx.commit()?;
    Ok(())
}
