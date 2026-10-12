//! Editable carts are not prepared commercial intentions and never go outbox.
use super::*;
use rusqlite::{Transaction, TransactionBehavior};
const CART_SCHEMA: &str = include_str!("../../qa-migrations/0003_carts.sql");
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct QaCart {
    pub id: String,
    pub revision: String,
    pub label: String,
    pub lines: Vec<QaLine>,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct QaCartWorkspace {
    pub active: Option<QaCart>,
    pub paused: Vec<QaCart>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QaCartSave {
    pub request_id: String,
    pub cart_id: Option<String>,
    pub expected_revision: Option<String>,
    pub lines: Vec<QaLine>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum QaCartActionKind {
    Pause,
    Resume,
    Discard,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QaCartAction {
    pub request_id: String,
    pub action: QaCartActionKind,
    pub cart_id: String,
    pub expected_revision: String,
    pub active_cart_id: Option<String>,
    pub active_revision: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QaCartResult {
    pub request_id: String,
    pub cart_id: String,
    pub revision: String,
    pub workspace: QaCartWorkspace,
}
pub(super) fn ensure_schema(c: &mut Connection) -> Result<(), AppError> {
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    tx.execute_batch("CREATE TABLE IF NOT EXISTS qa_cart_schema(id INTEGER PRIMARY KEY CHECK(id=1),checksum TEXT NOT NULL) STRICT;")?;
    let checksum = format!("{:x}", Sha256::digest(CART_SCHEMA));
    let stored: Option<String> = tx
        .query_row("SELECT checksum FROM qa_cart_schema WHERE id=1", [], |r| {
            r.get(0)
        })
        .optional()?;
    match stored {
        Some(s) if s != checksum => return Err(invalid()),
        None => {
            tx.execute_batch(CART_SCHEMA)?;
            tx.execute("INSERT INTO qa_cart_schema VALUES(1,?1)", [checksum])?;
        }
        _ => {}
    }
    tx.prepare("SELECT seq,id,revision,status,lines,sale_operation_id FROM qa_carts LIMIT 0")?;
    tx.prepare("SELECT request_id,hash,result FROM qa_cart_requests LIMIT 0")?;
    tx.commit()?;
    Ok(())
}
fn row(r: &rusqlite::Row<'_>) -> rusqlite::Result<QaCart> {
    let seq: i64 = r.get(0)?;
    let bytes: String = r.get(3)?;
    let lines = serde_json::from_str(&bytes).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(3, rusqlite::types::Type::Text, Box::new(e))
    })?;
    Ok(QaCart {
        id: r.get(1)?,
        revision: r.get::<_, i64>(2)?.to_string(),
        label: format!("Venta en espera {seq}"),
        lines,
    })
}
pub(super) fn read_workspace(c: &Connection) -> Result<QaCartWorkspace, AppError> {
    let active = c
        .query_row(
            "SELECT seq,id,revision,lines FROM qa_carts WHERE status='ACTIVE'",
            [],
            row,
        )
        .optional()?;
    let mut q=c.prepare("SELECT seq,id,revision,lines FROM qa_carts WHERE status='PAUSED' ORDER BY seq DESC LIMIT 10")?;
    let paused = q.query_map([], row)?.collect::<Result<Vec<_>, _>>()?;
    Ok(QaCartWorkspace { active, paused })
}
fn get(c: &Connection, id: &str, status: &str, expected: &str) -> Result<QaCart, AppError> {
    EntityId::parse(id).map_err(|_| invalid())?;
    let cart = c
        .query_row(
            "SELECT seq,id,revision,lines FROM qa_carts WHERE id=?1 AND status=?2",
            (id, status),
            row,
        )
        .optional()?
        .ok_or_else(stale)?;
    if cart.revision != expected {
        return Err(stale());
    }
    Ok(cart)
}
fn next_revision(cart: &QaCart) -> Result<i64, AppError> {
    cart.revision
        .parse::<i64>()
        .ok()
        .and_then(|n| n.checked_add(1))
        .ok_or_else(invalid)
}
fn editable(c: &Connection, id: &str) -> Result<(), AppError> {
    let prepared:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM operation_journal WHERE kind='SALE_CONFIRM' AND local_state='PREPARED' AND (json_extract(CAST(canonical_bytes AS TEXT),'$.request.cartId')=?1 OR json_extract(CAST(canonical_bytes AS TEXT),'$.payload.cartId')=?1))",[id],|r|r.get(0))?;
    if prepared {
        Err(stale())
    } else {
        Ok(())
    }
}
fn pause(c: &Transaction<'_>, cart: &QaCart) -> Result<(), AppError> {
    editable(c, &cart.id)?;
    let count: i64 = c.query_row(
        "SELECT count(*) FROM qa_carts WHERE status='PAUSED'",
        [],
        |r| r.get(0),
    )?;
    if cart.lines.is_empty() || count >= 10 {
        return Err(invalid());
    }
    c.execute(
        "UPDATE qa_carts SET status='PAUSED',revision=?2 WHERE id=?1",
        (&cart.id, next_revision(cart)?),
    )?;
    Ok(())
}
fn request<F>(
    c: &mut Connection,
    id: &str,
    payload: Value,
    effects: F,
) -> Result<QaCartResult, AppError>
where
    F: FnOnce(&Transaction<'_>) -> Result<(String, String), AppError>,
{
    EntityId::parse(id).map_err(|_| invalid())?;
    let (_, hash) = canonicalize(
        &serde_json::to_vec(&json!({"qaCartOnly":true,"request":payload}))
            .map_err(|_| invalid())?,
    )
    .map_err(|_| invalid())?;
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let stored: Option<(String, String)> = tx
        .query_row(
            "SELECT hash,result FROM qa_cart_requests WHERE request_id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let (cart_id, revision) = match stored {
        Some((h, result)) => {
            if h != hash {
                return Err(AppError::Protocol(ProtocolError::OperationIdConflict));
            }
            serde_json::from_str::<(String, String)>(&result).map_err(|_| invalid())?
        }
        None => {
            let ack = effects(&tx)?;
            tx.execute(
                "INSERT INTO qa_cart_requests VALUES(?1,?2,?3)",
                (
                    id,
                    &hash,
                    serde_json::to_string(&ack).map_err(|_| invalid())?,
                ),
            )?;
            ack
        }
    };
    let workspace = read_workspace(&tx)?;
    tx.commit()?;
    Ok(QaCartResult {
        request_id: id.to_owned(),
        cart_id,
        revision,
        workspace,
    })
}
impl QaCheckout {
    pub fn save_cart(&self, req: QaCartSave) -> Result<QaCartResult, AppError> {
        if req.lines.len() > 10 {
            return Err(invalid());
        }
        let mut seen = std::collections::HashSet::new();
        for l in &req.lines {
            if l.product_id.len() > 64 || !seen.insert(&l.product_id) {
                return Err(invalid());
            }
            quantity(&l.quantity)?;
            if l.revision.is_empty()
                || l.revision.len() > 19
                || l.revision.starts_with('0')
                || !l.revision.bytes().all(|b| b.is_ascii_digit())
                || l.revision.parse::<i64>().ok().is_none_or(|n| n <= 0)
            {
                return Err(invalid());
            }
        }
        match (&req.cart_id, &req.expected_revision) {
            (None, None) if !req.lines.is_empty() => {}
            (Some(id), Some(r)) if EntityId::parse(id).is_ok() && !r.is_empty() => {}
            _ => return Err(invalid()),
        }
        self.writer.call(move|c|request(c,&req.request_id,serde_json::to_value(&req).map_err(|_|invalid())?,|tx|{
   for l in &req.lines{if let Some(free)=&l.free{EntityId::parse(&l.product_id).map_err(|_|invalid())?;MoneyCents::parse_dto(&free.unit_price_cents).and_then(MoneyCents::require_non_negative).map_err(|_|invalid())?;if free.name.trim().is_empty()||free.name.len()>512||free.name.chars().any(char::is_control){return Err(invalid());}}else{let exists:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM qa_products WHERE id=?1)",[&l.product_id],|r|r.get(0))?;if !exists{return Err(invalid());}}}
   let json=serde_json::to_string(&req.lines).map_err(|_|invalid())?;
   let (id,rev)=if let Some(id)=&req.cart_id{let cart=get(tx,id,"ACTIVE",req.expected_revision.as_deref().ok_or_else(invalid)?)?;editable(tx,id)?;let rev=next_revision(&cart)?;tx.execute("UPDATE qa_carts SET lines=?2,revision=?3 WHERE id=?1",(id,json,rev))?;(id.clone(),rev)}else{if read_workspace(tx)?.active.is_some(){return Err(stale());}tx.execute("INSERT INTO qa_carts(id,revision,status,lines) VALUES(?1,1,'ACTIVE',?2)",(&req.request_id,json))?;(req.request_id.clone(),1)};
   Ok((id,rev.to_string()))
  }))
    }
    pub fn cart_action(&self, req: QaCartAction) -> Result<QaCartResult, AppError> {
        self.writer.call(move|c|request(c,&req.request_id,serde_json::to_value(&req).map_err(|_|invalid())?,|tx|{
   match req.action {
    QaCartActionKind::Pause=>{if req.active_cart_id.is_some()||req.active_revision.is_some(){return Err(invalid());}let cart=get(tx,&req.cart_id,"ACTIVE",&req.expected_revision)?;pause(tx,&cart)?;Ok((cart.id.clone(),next_revision(&cart)?.to_string()))},
    QaCartActionKind::Discard=>{if req.active_cart_id.is_some()||req.active_revision.is_some(){return Err(invalid());}let cart=get(tx,&req.cart_id,"PAUSED",&req.expected_revision)?;editable(tx,&cart.id)?;let rev=next_revision(&cart)?;tx.execute("UPDATE qa_carts SET status='DISCARDED',revision=?2 WHERE id=?1",(&cart.id,rev))?;Ok((cart.id,rev.to_string()))},
    QaCartActionKind::Resume=>{
     let cart=get(tx,&req.cart_id,"PAUSED",&req.expected_revision)?;editable(tx,&cart.id)?;let active=read_workspace(tx)?.active;
     match (active,&req.active_cart_id,&req.active_revision){(None,None,None)=>{},(Some(a),Some(id),Some(rev))if a.id==*id&&a.revision==*rev=>{editable(tx,&a.id)?;if a.lines.is_empty(){tx.execute("UPDATE qa_carts SET status='DISCARDED',revision=?2 WHERE id=?1",(&a.id,next_revision(&a)?))?;}else{
       // Remove target from PAUSED before swapping so the limit remains10.
       tx.execute("UPDATE qa_carts SET status='DISCARDED' WHERE id=?1",[&cart.id])?;pause(tx,&a)?;
     }},_=>return Err(stale())}
     let rev=next_revision(&cart)?;tx.execute("UPDATE qa_carts SET status='ACTIVE',revision=?2 WHERE id=?1",(&cart.id,rev))?;Ok((cart.id,rev.to_string()))
    }
   }
  }))
    }
}
pub(super) fn consume_in_sale(tx: &Transaction<'_>, sale: &QaSaleRequest) -> Result<(), AppError> {
    match (&sale.cart_id, &sale.expected_cart_revision) {
        (None, None) => Ok(()),
        (Some(id), Some(rev)) => {
            let cart = get(tx, id, "ACTIVE", rev)?;
            if cart.lines != sale.lines {
                return Err(stale());
            }
            tx.execute("UPDATE qa_carts SET status='COMMITTED',revision=?2,sale_operation_id=?3 WHERE id=?1",(id,next_revision(&cart)?,&sale.operation_id))?;
            Ok(())
        }
        _ => Err(invalid()),
    }
}
