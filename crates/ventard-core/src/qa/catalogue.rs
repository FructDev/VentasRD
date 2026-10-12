//! Catálogo local del adaptador sintético. No grant/RPC/scope comercial.
use super::*;
use rusqlite::{Transaction, TransactionBehavior};
const CATALOGUE_SCHEMA: &str = include_str!("../../qa-migrations/0002_catalogue.sql");
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QaProductWrite {
    pub operation_id: String,
    pub product_id: Option<String>,
    pub expected_revision: Option<String>,
    pub name: String,
    pub code: String,
    pub price_cents: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QaStockChange {
    pub operation_id: String,
    pub product_id: String,
    pub expected_revision: String,
    pub delta: String,
    pub reason: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct QaCatalogueResult {
    pub operation_id: String,
    pub product: QaProduct,
    pub remote_status: String,
}
pub(super) fn ensure_schema(c: &mut Connection) -> Result<(), AppError> {
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    tx.execute_batch("CREATE TABLE IF NOT EXISTS qa_schema_migrations(version INTEGER PRIMARY KEY CHECK(version=2),checksum TEXT NOT NULL) STRICT;")?;
    let expected = format!("{:x}", Sha256::digest(CATALOGUE_SCHEMA));
    let stored: Option<String> = tx
        .query_row(
            "SELECT checksum FROM qa_schema_migrations WHERE version=2",
            [],
            |r| r.get(0),
        )
        .optional()?;
    match stored {
        Some(s) if s != expected => return Err(invalid()),
        None => {
            tx.execute_batch(CATALOGUE_SCHEMA)?;
            tx.execute("INSERT INTO qa_schema_migrations VALUES(2,?1)", [expected])?;
        }
        _ => {}
    }
    // Missing objects are corruption, not a reason to reconstruct their history.
    tx.prepare("SELECT operation_id,product_id,delta,stock_before,stock_after,reason FROM qa_inventory_adjustments LIMIT 0")?;
    tx.commit()?;
    Ok(())
}
fn text_valid(s: &str, max: usize) -> bool {
    !s.is_empty() && s.chars().count() <= max && s.trim() == s && !s.chars().any(char::is_control)
}
fn revision(s: &str) -> Result<i64, AppError> {
    if s.is_empty() || s.len() > 19 || s.starts_with('0') || !s.bytes().all(|b| b.is_ascii_digit())
    {
        return Err(invalid());
    }
    s.parse::<i64>().ok().filter(|n| *n > 0).ok_or_else(invalid)
}
fn read_product(c: &Connection, id: &str) -> Result<QaProduct, AppError> {
    c.query_row(
        "SELECT id,name,code,price_cents,stock,revision FROM qa_products WHERE id=?1",
        [id],
        |r| {
            Ok(QaProduct {
                id: r.get(0)?,
                name: r.get(1)?,
                code: r.get(2)?,
                price_cents: r.get::<_, i64>(3)?.to_string(),
                stock: r.get::<_, i32>(4)?.to_string(),
                revision: r.get(5)?,
                available_serials: vec![],
            })
        },
    )
    .optional()?
    .ok_or_else(invalid)
}
fn next_revision(p: &QaProduct, expected: &str) -> Result<String, AppError> {
    if p.revision != expected {
        return Err(stale());
    }
    Ok(revision(expected)?
        .checked_add(1)
        .ok_or_else(invalid)?
        .to_string())
}
fn operation<F, G>(
    c: &mut Connection,
    id: &str,
    kind: &str,
    request: Value,
    preflight: F,
    effects: G,
) -> Result<QaCatalogueResult, AppError>
where
    F: FnOnce(&Connection) -> Result<(), AppError>,
    G: FnOnce(&Transaction<'_>) -> Result<QaProduct, AppError>,
{
    let (bytes, hash) = canonicalize(
        &serde_json::to_vec(&json!({"qaOnly":true,"kind":kind,"request":request}))
            .map_err(|_| invalid())?,
    )
    .map_err(|_| invalid())?;
    // Preflight only for new intentions. Replays return the original durable
    // result even if the catalogue/stock has subsequently changed.
    let exists: bool = c.query_row(
        "SELECT EXISTS(SELECT 1 FROM operation_journal WHERE operation_id=?1)",
        [id],
        |r| r.get(0),
    )?;
    if !exists {
        preflight(c)?;
    }
    prepare_operation(
        c,
        id,
        "ventard.native.v1",
        kind,
        1,
        bytes.as_bytes(),
        &hash,
        ACTOR,
        "GLOBAL",
        DEVICE,
        1,
        "1791504000000",
    )?;
    let result = execute_prepared_operation(c, id, &hash, |tx| {
        let product = effects(tx)?;
        serde_json::to_value(QaCatalogueResult {
            operation_id: id.to_owned(),
            product,
            remote_status: "NOT_ENABLED".into(),
        })
        .map_err(|_| invalid())
    })?;
    serde_json::from_value(result).map_err(|_| invalid())
}
impl QaCheckout {
    pub fn save_product(&self, request: QaProductWrite) -> Result<QaCatalogueResult, AppError> {
        EntityId::parse(&request.operation_id).map_err(|_| invalid())?;
        if !text_valid(&request.name, 120) || !text_valid(&request.code, 64) {
            return Err(invalid());
        }
        let price = MoneyCents::parse_dto(&request.price_cents)
            .and_then(MoneyCents::require_non_negative)
            .map_err(|_| invalid())?;
        let create = match (&request.product_id, &request.expected_revision) {
            (None, None) => true,
            (Some(id), Some(r)) if text_valid(id, 64) => {
                revision(r)?;
                false
            }
            _ => return Err(invalid()),
        };
        self.writer.call(move|c|{
   let id=request.product_id.as_deref().unwrap_or(&request.operation_id).to_owned();
   let validate=|c:&Connection|->Result<(),AppError>{
    let duplicate:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM qa_products WHERE code=?1 AND id<>?2)",(&request.code,&id),|r|r.get(0))?;
    if duplicate{return Err(AppError::Business(BusinessError::ProductCodeExists));}
    if create{let count:i64=c.query_row("SELECT count(*) FROM qa_products",[],|r|r.get(0))?;if count>=1000{return Err(invalid());}}else{next_revision(&read_product(c,&id)?,request.expected_revision.as_deref().ok_or_else(invalid)?)?;}
    Ok(())
   };
   operation(c,&request.operation_id,if create{"PRODUCT_CREATE"}else{"PRODUCT_PATCH"},serde_json::to_value(&request).map_err(|_|invalid())?,validate,|tx|{
    if create {tx.execute("INSERT INTO qa_products(id,name,code,price_cents,stock,revision) VALUES(?1,?2,?3,?4,0,'1')",(&id,&request.name,&request.code,price.cents()))?;}
    else{let next=next_revision(&read_product(tx,&id)?,request.expected_revision.as_deref().ok_or_else(invalid)?)?;tx.execute("UPDATE qa_products SET name=?2,code=?3,price_cents=?4,revision=?5 WHERE id=?1",(&id,&request.name,&request.code,price.cents(),next))?;}
    read_product(tx,&id)
   })
  })
    }
    pub fn adjust_stock(&self, request: QaStockChange) -> Result<QaCatalogueResult, AppError> {
        EntityId::parse(&request.operation_id).map_err(|_| invalid())?;
        if !text_valid(&request.product_id, 64) || !text_valid(&request.reason, 120) {
            return Err(invalid());
        }
        revision(&request.expected_revision)?;
        let delta = request.delta.parse::<i32>().map_err(|_| invalid())?;
        if delta == 0 || delta.to_string() != request.delta {
            return Err(invalid());
        }
        self.writer.call(move|c|{
   let validate=|c:&Connection|->Result<(QaProduct,i32,String),AppError>{let p=read_product(c,&request.product_id)?;let next=next_revision(&p,&request.expected_revision)?;let before=p.stock.parse::<i32>().map_err(|_|invalid())?;let after=before.checked_add(delta).filter(|n|*n>=0).ok_or_else(invalid)?;Ok((p,after,next))};
   operation(c,&request.operation_id,"INVENTORY_DELTA",serde_json::to_value(&request).map_err(|_|invalid())?,|c|validate(c).map(|_|()),|tx|{
    let (p,after,next)=validate(tx)?;let before=p.stock.parse::<i32>().map_err(|_|invalid())?;
    tx.execute("INSERT INTO qa_inventory_adjustments(operation_id,product_id,delta,stock_before,stock_after,reason) VALUES(?1,?2,?3,?4,?5,?6)",(&request.operation_id,&request.product_id,delta,before,after,&request.reason))?;
    tx.execute("UPDATE qa_products SET stock=?2,revision=?3 WHERE id=?1",(&request.product_id,after,next))?;read_product(tx,&request.product_id)
   })
  })
    }
}
