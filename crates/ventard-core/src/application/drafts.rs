//! Editable account drafts. Not a prepared sale, stock reservation or remote command.
use super::errors::{AppError, BusinessError, ProtocolError};
use crate::{
    domain::{canonical::canonicalize, identity::EntityId, money::MoneyCents},
    storage::catalogue_preview::{self as catalogue, CatalogueContext},
};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DraftLine {
    pub product_id: String,
    pub quantity: String,
    pub revision: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub free: Option<super::sales::FreeLine>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DraftCart {
    pub id: String,
    pub revision: String,
    pub label: String,
    pub lines: Vec<DraftLine>,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DraftWorkspace {
    pub active: Option<DraftCart>,
    pub paused: Vec<DraftCart>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DraftSave {
    pub request_id: String,
    pub cart_id: Option<String>,
    pub expected_revision: Option<String>,
    pub lines: Vec<DraftLine>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DraftActionKind {
    Pause,
    Resume,
    Discard,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DraftAction {
    pub request_id: String,
    pub action: DraftActionKind,
    pub cart_id: String,
    pub expected_revision: String,
    pub active_cart_id: Option<String>,
    pub active_revision: Option<String>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftResult {
    pub request_id: String,
    pub cart_id: String,
    pub revision: String,
    pub workspace: DraftWorkspace,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftLineTotal {
    pub product_id: String,
    pub subtotal_cents: Option<String>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftQuote {
    pub subtotal_cents: Option<String>,
    pub itbis_cents: Option<String>,
    pub total_cents: Option<String>,
    pub change_cents: Option<String>,
    pub payable: bool,
    pub line_totals: Vec<DraftLineTotal>,
    pub limits: Vec<String>,
}
fn invalid() -> AppError {
    AppError::Protocol(ProtocolError::MalformedPayload)
}
fn stale() -> AppError {
    AppError::Business(BusinessError::Conflict {
        message: "DRAFT_VERSION_CONFLICT".into(),
    })
}
fn uuid(s: &str) -> Result<(), AppError> {
    EntityId::parse(s).map(|_| ()).map_err(|_| invalid())
}
fn key(ctx: &CatalogueContext) -> Result<String, AppError> {
    catalogue::key(ctx).map_err(|_| invalid())
}
fn quantity(s: &str) -> Result<i32, AppError> {
    let n = s.parse::<i32>().map_err(|_| invalid())?;
    if n <= 0 || n.to_string() != s {
        return Err(invalid());
    }
    Ok(n)
}
fn lines_valid(lines: &[DraftLine]) -> Result<(), AppError> {
    if lines.len() > 100 {
        return Err(invalid());
    }
    let mut ids = HashSet::new();
    for l in lines {
        uuid(&l.product_id)?;
        if l.revision
            .parse::<u64>()
            .ok()
            .is_none_or(|n| n == 0 || n.to_string() != l.revision)
        {
            uuid(&l.revision)?;
        }
        quantity(&l.quantity)?;
        if let Some(free) = &l.free {
            if free.name.trim().is_empty()
                || free.name.chars().count() > 256
                || free.name.chars().any(char::is_control)
                || MoneyCents::parse_dto(&free.unit_price_cents)
                    .and_then(MoneyCents::require_non_negative)
                    .is_err()
            {
                return Err(invalid());
            }
        }
        if !ids.insert(&l.product_id) {
            return Err(invalid());
        }
    }
    Ok(())
}
fn row(r: &rusqlite::Row<'_>) -> rusqlite::Result<DraftCart> {
    let raw: String = r.get(3)?;
    let lines = serde_json::from_str(&raw).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(3, rusqlite::types::Type::Text, Box::new(e))
    })?;
    Ok(DraftCart {
        id: r.get(1)?,
        revision: r.get::<_, i64>(2)?.to_string(),
        label: format!("Venta en espera {}", r.get::<_, i64>(0)?),
        lines,
    })
}
fn workspace(c: &Connection, k: &str) -> Result<DraftWorkspace, AppError> {
    let active=c.query_row("SELECT seq,id,revision,lines FROM account_drafts WHERE context_key=?1 AND status='ACTIVE'",[k],row).optional()?;
    let mut q=c.prepare("SELECT seq,id,revision,lines FROM account_drafts WHERE context_key=?1 AND status='PAUSED' ORDER BY seq DESC LIMIT 10")?;
    let paused = q.query_map([k], row)?.collect::<Result<Vec<_>, _>>()?;
    Ok(DraftWorkspace { active, paused })
}
pub fn read(c: &Connection, ctx: &CatalogueContext) -> Result<DraftWorkspace, AppError> {
    workspace(c, &key(ctx)?)
}
fn get(
    c: &Connection,
    k: &str,
    id: &str,
    status: &str,
    expected: &str,
) -> Result<DraftCart, AppError> {
    uuid(id)?;
    super::checkout::ensure_editable(c, k, id)?;
    let cart=c.query_row("SELECT seq,id,revision,lines FROM account_drafts WHERE context_key=?1 AND id=?2 AND status=?3",(k,id,status),row).optional()?.ok_or_else(stale)?;
    if cart.revision != expected {
        return Err(stale());
    }
    Ok(cart)
}
fn next(cart: &DraftCart) -> Result<i64, AppError> {
    cart.revision
        .parse::<i64>()
        .ok()
        .and_then(|n| n.checked_add(1))
        .ok_or_else(invalid)
}
fn pause(tx: &Transaction<'_>, k: &str, cart: &DraftCart) -> Result<(), AppError> {
    super::checkout::ensure_editable(tx, k, &cart.id)?;
    let n: i64 = tx.query_row(
        "SELECT count(*) FROM account_drafts WHERE context_key=?1 AND status='PAUSED'",
        [k],
        |r| r.get(0),
    )?;
    if cart.lines.is_empty() || n >= 10 {
        return Err(invalid());
    }
    tx.execute(
        "UPDATE account_drafts SET status='PAUSED',revision=?3 WHERE context_key=?1 AND id=?2",
        (k, &cart.id, next(cart)?),
    )?;
    Ok(())
}
fn request<F>(
    c: &mut Connection,
    ctx: &CatalogueContext,
    id: &str,
    payload: serde_json::Value,
    effect: F,
) -> Result<DraftResult, AppError>
where
    F: FnOnce(&Transaction<'_>, &str) -> Result<(String, String), AppError>,
{
    uuid(id)?;
    let k = key(ctx)?;
    let (_,hash)=canonicalize(&serde_json::to_vec(&serde_json::json!({"version":"ventard.native.draft.1","contextKey":k,"request":payload})).map_err(|_|invalid())?).map_err(|_|invalid())?;
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let stored: Option<(String, String)> = tx
        .query_row(
            "SELECT hash,result FROM account_draft_requests WHERE context_key=?1 AND request_id=?2",
            (&k, id),
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let (cart_id, revision) = match stored {
        Some((h, raw)) => {
            if h != hash {
                return Err(AppError::Protocol(ProtocolError::OperationIdConflict));
            }
            serde_json::from_str::<(String, String)>(&raw).map_err(|_| invalid())?
        }
        None => {
            let ack = effect(&tx, &k)?;
            tx.execute(
                "INSERT INTO account_draft_requests VALUES(?1,?2,?3,?4)",
                (
                    &k,
                    id,
                    hash,
                    serde_json::to_string(&ack).map_err(|_| invalid())?,
                ),
            )?;
            ack
        }
    };
    // Immutable acknowledgement + CURRENT workspace: retries never roll back later edits.
    let workspace = workspace(&tx, &k)?;
    tx.commit()?;
    Ok(DraftResult {
        request_id: id.into(),
        cart_id,
        revision,
        workspace,
    })
}
pub fn save(
    c: &mut Connection,
    ctx: &CatalogueContext,
    req: DraftSave,
) -> Result<DraftResult, AppError> {
    lines_valid(&req.lines)?;
    match (&req.cart_id, &req.expected_revision) {
        (None, None) if !req.lines.is_empty() => {}
        (Some(id), Some(_)) => uuid(id)?,
        _ => return Err(invalid()),
    }
    let payload = serde_json::to_value(&req).map_err(|_| invalid())?;
    request(c, ctx, &req.request_id, payload, |tx, k| {
        let old = if let Some(id) = &req.cart_id {
            Some(get(
                tx,
                k,
                id,
                "ACTIVE",
                req.expected_revision.as_deref().ok_or_else(invalid)?,
            )?)
        } else {
            None
        };
        let native = super::sales_sync::operational(tx, ctx)?;
        let catalogue = if native {
            None
        } else {
            Some(
                catalogue::read(tx, ctx)
                    .map_err(|_| invalid())?
                    .ok_or_else(invalid)?,
            )
        };
        let ids: HashSet<_> = catalogue
            .as_ref()
            .map(|c| c.products.iter().map(|p| p.id.as_str()).collect())
            .unwrap_or_default();
        for l in &req.lines {
            // Preserve old references conservatively when a capture changes. New references
            // must come from the currently authorized capture; never silently reprice.
            let preserved = old.as_ref().is_some_and(|cart| {
                cart.lines
                    .iter()
                    .any(|o| o.product_id == l.product_id && o.revision == l.revision)
            });
            let allowed = if native && l.free.is_some() {
                true
            } else if native {
                tx.query_row("SELECT EXISTS(SELECT 1 FROM products WHERE producto_id=?1 AND tenant_id=?2 AND revision=?3 AND tombstone=0)",(&l.product_id,&ctx.tenant_id,&l.revision),|r|r.get::<_,bool>(0))?
            } else {
                l.free.is_none()
                    && ids.contains(l.product_id.as_str())
                    && l.revision == catalogue.as_ref().ok_or_else(invalid)?.manifest.snapshot_id
            };
            if !preserved && !allowed {
                return Err(invalid());
            }
        }
        let raw = serde_json::to_string(&req.lines).map_err(|_| invalid())?;
        if let Some(cart) = old {
            let rev = next(&cart)?;
            tx.execute(
                "UPDATE account_drafts SET lines=?3,revision=?4 WHERE context_key=?1 AND id=?2",
                (k, &cart.id, raw, rev),
            )?;
            Ok((cart.id, rev.to_string()))
        } else {
            if workspace(tx, k)?.active.is_some() {
                return Err(stale());
            }
            let seq: i64 = tx.query_row(
                "SELECT COALESCE(MAX(seq),0)+1 FROM account_drafts WHERE context_key=?1",
                [k],
                |r| r.get(0),
            )?;
            tx.execute(
                "INSERT INTO account_drafts VALUES(?1,?2,?3,1,'ACTIVE',?4)",
                (k, &req.request_id, seq, raw),
            )?;
            Ok((req.request_id.clone(), "1".into()))
        }
    })
}
pub fn action(
    c: &mut Connection,
    ctx: &CatalogueContext,
    req: DraftAction,
) -> Result<DraftResult, AppError> {
    let payload = serde_json::to_value(&req).map_err(|_| invalid())?;
    request(c, ctx, &req.request_id, payload, |tx, k| match req.action {
        DraftActionKind::Pause => {
            if req.active_cart_id.is_some() || req.active_revision.is_some() {
                return Err(invalid());
            }
            let cart = get(tx, k, &req.cart_id, "ACTIVE", &req.expected_revision)?;
            pause(tx, k, &cart)?;
            Ok((cart.id.clone(), next(&cart)?.to_string()))
        }
        DraftActionKind::Discard => {
            if req.active_cart_id.is_some() || req.active_revision.is_some() {
                return Err(invalid());
            }
            let cart = get(tx, k, &req.cart_id, "PAUSED", &req.expected_revision)?;
            let rev = next(&cart)?;
            tx.execute("UPDATE account_drafts SET status='DISCARDED',revision=?3 WHERE context_key=?1 AND id=?2",(k,&cart.id,rev))?;
            Ok((cart.id, rev.to_string()))
        }
        DraftActionKind::Resume => {
            let cart = get(tx, k, &req.cart_id, "PAUSED", &req.expected_revision)?;
            match (
                workspace(tx, k)?.active,
                &req.active_cart_id,
                &req.active_revision,
            ) {
                (None, None, None) => {}
                (Some(a), Some(id), Some(rev)) if a.id == *id && a.revision == *rev => {
                    tx.execute("UPDATE account_drafts SET status='DISCARDED' WHERE context_key=?1 AND id=?2",(k,&cart.id))?;
                    if a.lines.is_empty() {
                        tx.execute("UPDATE account_drafts SET status='DISCARDED',revision=?3 WHERE context_key=?1 AND id=?2",(k,&a.id,next(&a)?))?;
                    } else {
                        pause(tx, k, &a)?;
                    }
                }
                _ => return Err(stale()),
            }
            let rev = next(&cart)?;
            tx.execute("UPDATE account_drafts SET status='ACTIVE',revision=?3 WHERE context_key=?1 AND id=?2",(k,&cart.id,rev))?;
            Ok((cart.id, rev.to_string()))
        }
    })
}
pub fn quote(
    c: &Connection,
    ctx: &CatalogueContext,
    lines: &[DraftLine],
) -> Result<DraftQuote, AppError> {
    lines_valid(lines)?;
    key(ctx)?;
    let preview = catalogue::read(c, ctx)
        .map_err(|_| invalid())?
        .ok_or_else(invalid)?;
    let products: HashMap<_, _> = preview
        .products
        .iter()
        .map(|p| (p.id.as_str(), p))
        .collect();
    let mut sum = MoneyCents::ZERO;
    let mut complete = true;
    let mut line_totals = Vec::new();
    let mut limits = vec![
        "TAX_CONTEXT_UNAVAILABLE".into(),
        "COMMERCIAL_CHECKOUT_DISABLED".into(),
        "POINT_IN_TIME_NOT_AVAILABILITY".into(),
    ];
    for l in lines {
        let qty = quantity(&l.quantity)?;
        let amount = if l.revision != preview.manifest.snapshot_id {
            if !limits.iter().any(|s| s == "CATALOGUE_CHANGED") {
                limits.push("CATALOGUE_CHANGED".into());
            }
            None
        } else {
            products
                .get(l.product_id.as_str())
                .and_then(|p| p.price_cents.as_deref())
                .map(|price| {
                    MoneyCents::parse_dto(price)
                        .and_then(|m| m.require_non_negative())
                        .and_then(|m| MoneyCents::from_i128(m.cents() as i128 * qty as i128))
                })
                .transpose()
                .map_err(|_| invalid())?
        };
        if let Some(a) = amount {
            sum = sum.checked_add(a).map_err(|_| invalid())?;
        } else {
            complete = false;
        }
        line_totals.push(DraftLineTotal {
            product_id: l.product_id.clone(),
            subtotal_cents: amount.map(|m| m.to_dto()),
        });
    }
    if !complete && !limits.iter().any(|s| s == "CATALOGUE_CHANGED") {
        limits.push("PRICE_UNVERIFIABLE".into());
    }
    Ok(DraftQuote {
        subtotal_cents: complete.then(|| sum.to_dto()),
        itbis_cents: None,
        total_cents: None,
        change_cents: None,
        payable: false,
        line_totals,
        limits,
    })
}
