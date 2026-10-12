//! Slice T017: exclusivamente dataset sintético aislado. NO SALE_CONFIRM
//! comercial T060, grant/licencia, seriales, fiado, NCF, feed ni print físico.
use crate::{
    application::{
        errors::{AppError, BusinessError, ProtocolError},
        operations::{execute_prepared_operation, get_operation_result, prepare_operation},
    },
    domain::{
        canonical::canonicalize,
        identity::EntityId,
        money::MoneyCents,
        quantity::Ratio,
        sale_quote::{calculate_totals, Discount, QuoteLine},
    },
    storage::{
        cipher::CipherKey,
        writer::{StorageError, WriterActor},
    },
};
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::Path;
mod cart;
mod catalogue;
mod native_sales;
pub use cart::{QaCartAction, QaCartResult, QaCartSave, QaCartWorkspace};
pub use catalogue::{QaCatalogueResult, QaProductWrite, QaStockChange};
const SCHEMA: &str = include_str!("../qa-migrations/0001_checkout.sql");
pub const QA_TENANT: &str = "96000000-0000-4000-8000-000000000050";
const ACTOR: &str = "96000000-0000-4000-8000-000000000051";
const DEVICE: &str = "96000000-0000-4000-8000-000000000052";
fn invalid() -> AppError {
    AppError::Protocol(ProtocolError::MalformedPayload)
}
fn stale() -> AppError {
    AppError::Protocol(ProtocolError::InvalidStateTransition)
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QaLine {
    pub product_id: String,
    pub quantity: String,
    pub revision: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub free: Option<crate::application::sales::FreeLine>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QaSaleRequest {
    pub operation_id: String,
    pub lines: Vec<QaLine>,
    pub tender_cents: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cart_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_cart_revision: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<crate::application::sales::SaleOptions>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accepted_quote_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fiscal_type: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct QaResult {
    pub operation_id: String,
    pub hash: String,
    pub ticket: String,
    pub total_cents: String,
    pub itbis_cents: String,
    pub change_cents: String,
    pub remote_status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payment_method: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ncf: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub discount_cents: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub print_status: Option<String>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QaQuoteLine {
    pub product_id: String,
    pub subtotal_cents: String,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QaQuote {
    pub subtotal_cents: String,
    pub itbis_cents: String,
    pub total_cents: String,
    pub change_cents: Option<String>,
    pub payable: bool,
    pub line_totals: Vec<QaQuoteLine>,
    pub quote_hash: Option<String>,
    pub discount_cents: String,
    pub limits: Vec<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QaQuoteRequest {
    pub lines: Vec<QaLine>,
    pub tender_cents: Option<String>,
    #[serde(default)]
    pub options: Option<crate::application::sales::SaleOptions>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct QaProduct {
    pub id: String,
    pub name: String,
    pub code: String,
    pub price_cents: String,
    pub stock: String,
    pub revision: String,
    #[serde(default)]
    pub available_serials: Vec<String>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QaCatalogue {
    pub products: Vec<QaProduct>,
    pub confirmed_sales: String,
    pub cash_cents: String,
    pub pending_operations: String,
    pub last_result: Option<QaResult>,
    pub pending_attempt: Option<QaSaleRequest>,
    pub carts: QaCartWorkspace,
    pub customers: Vec<crate::application::sales::CustomerView>,
}
pub struct QaCheckout {
    writer: WriterActor,
}
impl QaCheckout {
    pub fn history_read(
        &self,
        filter: crate::application::history::HistoryFilter,
    ) -> Result<crate::application::history::HistoryPage, AppError> {
        self.writer
            .call(move |c| crate::application::history::read(c, &native_sales::context(), filter))
    }
    pub fn abandon_sale(&self, op: String) -> Result<(), AppError> {
        self.writer.call(move |c| native_sales::abandon(c, &op))
    }
    pub fn ticket_snapshot(&self, op: String) -> Result<Value, AppError> {
        self.writer
            .call(move |c| crate::application::history::ticket(c, &native_sales::context(), &op))
    }
    pub fn quote(
        &self,
        lines: Vec<QaLine>,
        tender_cents: Option<String>,
    ) -> Result<QaQuote, AppError> {
        let tender = tender_cents
            .map(|s| {
                MoneyCents::parse_dto(&s)
                    .and_then(MoneyCents::require_non_negative)
                    .map_err(|_| invalid())
            })
            .transpose()?;
        self.writer
            .call(move |c| native_sales::quote(c, &lines, tender, None))
    }
    pub fn quote_options(&self, req: QaQuoteRequest) -> Result<QaQuote, AppError> {
        let tender = req
            .tender_cents
            .map(|v| MoneyCents::parse_dto(&v).map_err(|_| invalid()))
            .transpose()?;
        self.writer
            .call(move |c| native_sales::quote(c, &req.lines, tender, req.options))
    }
    pub fn create(dir: impl AsRef<Path>, key: CipherKey) -> Result<Self, StorageError> {
        let writer = WriterActor::create_encrypted(dir, key)?;
        writer
            .transaction(|tx| {
                tx.execute_batch(SCHEMA)?;
                tx.execute(
                    "INSERT INTO qa_meta VALUES(1,?1)",
                    [format!("{:x}", Sha256::digest(SCHEMA))],
                )?;
                tx.execute("INSERT INTO qa_turn VALUES(1,'OPEN')", [])?;
                for i in 1..=10 {
                    tx.execute(
                        "INSERT INTO qa_products VALUES(?1,?2,?3,?4,100,'1')",
                        (
                            format!("qa-product-{i:02}"),
                            format!("Producto QA {i:02}"),
                            format!("{i:06}"),
                            10000i64 * i,
                        ),
                    )?;
                }
                Ok(())
            })
            .map_err(|_| StorageError::VaultIo)?;
        writer
            .call(catalogue::ensure_schema)
            .map_err(|_| StorageError::IncompatibleSchema)?;
        writer
            .call(cart::ensure_schema)
            .map_err(|_| StorageError::IncompatibleSchema)?;
        writer
            .call(native_sales::initialize)
            .map_err(|_| StorageError::IncompatibleSchema)?;
        Ok(Self { writer })
    }
    pub fn open(dir: impl AsRef<Path>, key: CipherKey) -> Result<Self, StorageError> {
        let writer = WriterActor::open_encrypted(dir, key)?;
        writer
            .call(|c| {
                let checksum: String =
                    c.query_row("SELECT checksum FROM qa_meta WHERE version=1", [], |r| {
                        r.get(0)
                    })?;
                if checksum != format!("{:x}", Sha256::digest(SCHEMA)) {
                    return Err(invalid());
                }
                Ok(())
            })
            .map_err(|_| StorageError::IncompatibleSchema)?;
        writer
            .call(catalogue::ensure_schema)
            .map_err(|_| StorageError::IncompatibleSchema)?;
        writer
            .call(cart::ensure_schema)
            .map_err(|_| StorageError::IncompatibleSchema)?;
        writer
            .call(native_sales::initialize)
            .map_err(|_| StorageError::IncompatibleSchema)?;
        Ok(Self { writer })
    }
    pub fn catalogue(&self) -> Result<QaCatalogue, AppError> {
        self.writer.call(|c|{
   native_sales::refresh_products(c)?;
   let mut q=c.prepare("SELECT id,name,code,price_cents,stock,revision FROM qa_products ORDER BY code,id LIMIT 1000")?;
   let mut products=q.query_map([],|r|Ok(QaProduct{id:r.get(0)?,name:r.get(1)?,code:r.get(2)?,price_cents:r.get::<_,i64>(3)?.to_string(),stock:r.get::<_,i32>(4)?.to_string(),revision:r.get(5)?,available_serials:vec![]}))?.collect::<Result<Vec<_>,_>>()?;
   for product in &mut products {product.available_serials=native_sales::serials(c,&product.id)?;}
   let count:i64=c.query_row("SELECT count(*) FROM qa_sales",[],|r|r.get(0))?;
   let cash:i64=c.query_row("SELECT COALESCE(sum(amount_cents),0) FROM qa_cash_entries",[],|r|r.get(0))?;
   let pending:i64=c.query_row("SELECT count(*) FROM qa_outbox",[],|r|r.get(0))?;
   let last:Option<String>=c.query_row("SELECT result FROM operation_journal WHERE kind='SALE_CONFIRM' AND local_state='COMMITTED' ORDER BY local_seq DESC LIMIT 1",[],|r|r.get(0)).optional()?;
   let attempt:Option<Vec<u8>>=c.query_row("SELECT canonical_bytes FROM operation_journal WHERE kind='SALE_CONFIRM' AND local_state='PREPARED' ORDER BY local_seq DESC LIMIT 1",[],|r|r.get(0)).optional()?;
   let legacy_attempt=attempt.filter(|b|serde_json::from_slice::<Value>(b).is_ok_and(|v|v["qaOnly"]==true));
   let pending_attempt=native_sales::pending(c)?.or(legacy_attempt.map(|b|native_sales::pending_request(&b)).transpose()?);
   let last_result=last.map(|s|{let mut r:QaResult=serde_json::from_str(&s).map_err(|_|invalid())?;r.remote_status="NOT_ENABLED".into();Ok::<_,AppError>(r)}).transpose()?;
   Ok(QaCatalogue{products,confirmed_sales:count.to_string(),cash_cents:cash.to_string(),pending_operations:pending.to_string(),last_result,pending_attempt,carts:cart::read_workspace(c)?,customers:crate::application::sales::customers(c,&native_sales::context())?})
 })
    }
    pub fn operation_result(&self, id: &str) -> Result<Option<QaResult>, AppError> {
        EntityId::parse(id).map_err(|_| invalid())?;
        let id = id.to_owned();
        self.writer.call(move |c| {
            let hash: Option<String> = c
                .query_row(
                    "SELECT hash FROM operation_journal WHERE operation_id=?1 AND kind='SALE_CONFIRM'",
                    [&id],
                    |r| r.get(0),
                )
                .optional()?;
            hash.map(|h| get_operation_result(c, &id, &h))
                .transpose()?
                .flatten()
                .map(|v| {let mut r:QaResult=serde_json::from_value(v).map_err(|_|invalid())?;r.remote_status="NOT_ENABLED".into();Ok(r)})
                .transpose()
        })
    }
    pub fn confirm(&self, request: QaSaleRequest) -> Result<QaResult, AppError> {
        EntityId::parse(&request.operation_id).map_err(|_| invalid())?;
        if request.lines.is_empty() || request.lines.len() > 10 {
            return Err(invalid());
        }
        let tender = MoneyCents::parse_dto(&request.tender_cents)
            .and_then(MoneyCents::require_non_negative)
            .map_err(|_| invalid())?;
        let mut seen = std::collections::HashSet::new();
        for line in &request.lines {
            if !seen.insert(line.product_id.clone())
                || line.product_id.len() > 64
                || line.revision.len() > 20
            {
                return Err(invalid());
            }
            quantity(&line.quantity)?;
        }
        self.writer.call(move |c| {
            let old: Option<Vec<u8>> = c
                .query_row(
                    "SELECT canonical_bytes FROM operation_journal WHERE operation_id=?1",
                    [&request.operation_id],
                    |r| r.get(0),
                )
                .optional()?;
            if (request.cart_id.is_none()
                && request.options.is_none()
                && request.accepted_quote_hash.is_none()
                && request.fiscal_type.is_none())
                || old.as_ref().is_some_and(|b| {
                    serde_json::from_slice::<Value>(b).is_ok_and(|v| v["qaOnly"] == true)
                })
            {
                confirm(c, request, tender)
            } else {
                native_sales::confirm(c, request)
            }
        })
    }
}
fn quantity(s: &str) -> Result<i32, AppError> {
    if s.is_empty() || s.len() > 10 || s.starts_with('0') || !s.bytes().all(|b| b.is_ascii_digit())
    {
        return Err(invalid());
    }
    s.parse::<i32>().ok().filter(|n| *n > 0).ok_or_else(invalid)
}
type SelectedLine = (String, i32, i64);
fn quote_lines(
    c: &Connection,
    lines: &[QaLine],
    tender: Option<MoneyCents>,
) -> Result<(QaQuote, Vec<SelectedLine>), AppError> {
    if lines.len() > 10 {
        return Err(invalid());
    }
    let mut seen = std::collections::HashSet::new();
    let mut selected = Vec::new();
    let mut quotes = Vec::new();
    let mut line_totals = Vec::new();
    for line in lines {
        if line.product_id.len() > 64 || line.revision.len() > 20 || !seen.insert(&line.product_id)
        {
            return Err(invalid());
        }
        let qty = quantity(&line.quantity)?;
        let (price, stock, revision): (i64, i32, String) = c
            .query_row(
                "SELECT price_cents,stock,revision FROM qa_products WHERE id=?1",
                [&line.product_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?
            .ok_or_else(invalid)?;
        if revision != line.revision {
            return Err(stale());
        }
        if stock < qty {
            return Err(AppError::Business(BusinessError::InsufficientStock {
                product: line.product_id.clone(),
                available: stock.to_string(),
                requested: qty.to_string(),
            }));
        }
        let unit_price = MoneyCents::from_cents(price)
            .and_then(MoneyCents::require_non_negative)
            .map_err(|_| invalid())?;
        let subtotal = MoneyCents::from_i128(i128::from(unit_price.cents()) * i128::from(qty))
            .map_err(|_| invalid())?;
        quotes.push(QuoteLine {
            unit_price,
            quantity: Ratio::from_integer(qty as u64),
            tax_rate: Ratio::from_parts(9u32.into(), 50u32.into()).map_err(|_| invalid())?,
        });
        line_totals.push(QaQuoteLine {
            product_id: line.product_id.clone(),
            subtotal_cents: subtotal.to_dto(),
        });
        selected.push((line.product_id.clone(), qty, price));
    }
    let totals =
        calculate_totals(&quotes, &Discount::Amount(MoneyCents::ZERO)).map_err(|_| invalid())?;
    let payable = !lines.is_empty() && tender.is_some_and(|p| p >= totals.total);
    let change_cents = if payable {
        Some(
            tender
                .ok_or_else(invalid)?
                .checked_sub(totals.total)
                .map_err(|_| invalid())?
                .to_dto(),
        )
    } else {
        None
    };
    Ok((
        QaQuote {
            subtotal_cents: totals.subtotal.to_dto(),
            itbis_cents: totals.itbis.to_dto(),
            total_cents: totals.total.to_dto(),
            change_cents,
            payable,
            line_totals,
            quote_hash: None,
            discount_cents: "0".into(),
            limits: vec![],
        },
        selected,
    ))
}
fn confirm(
    c: &mut Connection,
    request: QaSaleRequest,
    tender: MoneyCents,
) -> Result<QaResult, AppError> {
    // Request hash es sólo de este protocolo QA fijo: no sustituye el envelope
    // comercial con quote/versions/snapshots que debe completar T056/T060.
    let value = json!({"qaOnly":true,"request":request});
    let (bytes, hash) = canonicalize(
        serde_json::to_vec(&value)
            .map_err(|_| invalid())?
            .as_slice(),
    )
    .map_err(|_| invalid())?;
    prepare_operation(
        c,
        &request.operation_id,
        "ventard.native.v1",
        "SALE_CONFIRM",
        1,
        bytes.as_bytes(),
        &hash,
        ACTOR,
        "GLOBAL",
        DEVICE,
        1,
        "1791504000000",
    )?;
    let id = request.operation_id.clone();
    let h = hash.clone();
    let result = execute_prepared_operation(c, &id, &hash, move |tx| {
        let turn: String =
            tx.query_row("SELECT status FROM qa_turn WHERE id=1", [], |r| r.get(0))?;
        if turn != "OPEN" {
            return Err(stale());
        }
        let (quote, selected) = quote_lines(tx, &request.lines, Some(tender))?;
        let total_cents = MoneyCents::parse_dto(&quote.total_cents).map_err(|_| invalid())?;
        if !quote.payable {
            return Err(invalid());
        }
        let change = MoneyCents::parse_dto(quote.change_cents.as_deref().ok_or_else(invalid)?)
            .map_err(|_| invalid())?;
        let seq: i64 = tx.query_row(
            "SELECT local_seq FROM operation_journal WHERE operation_id=?1",
            [&request.operation_id],
            |r| r.get(0),
        )?;
        let ticket = format!("QA-{seq:06}");
        tx.execute(
            "INSERT INTO qa_sales VALUES(?1,?2,?3)",
            (&request.operation_id, total_cents.cents(), &ticket),
        )?;
        for (product, qty, price) in selected {
            tx.execute(
                "UPDATE qa_products SET stock=stock-?2 WHERE id=?1",
                (&product, qty),
            )?;
            tx.execute(
                "INSERT INTO qa_sale_lines VALUES(?1,?2,?3,?4)",
                (&request.operation_id, &product, qty, price),
            )?;
            tx.execute(
                "INSERT INTO qa_stock_movements VALUES(?1,?2,?3)",
                (&request.operation_id, &product, -qty),
            )?;
        }
        tx.execute(
            "INSERT INTO qa_payments VALUES(?1,?2,?3,?4)",
            (
                &request.operation_id,
                total_cents.cents(),
                tender.cents(),
                change.cents(),
            ),
        )?;
        tx.execute(
            "INSERT INTO qa_cash_entries VALUES(?1,1,?2)",
            (&request.operation_id, total_cents.cents()),
        )?;
        tx.execute(
            "INSERT INTO qa_outbox VALUES(?1,'NOT_ENABLED')",
            [&request.operation_id],
        )?;
        let result = QaResult {
            operation_id: request.operation_id.clone(),
            hash: h,
            ticket,
            total_cents: quote.total_cents,
            itbis_cents: quote.itbis_cents,
            change_cents: change.to_dto(),
            remote_status: "NOT_ENABLED".into(),
            payment_method: None,
            ncf: None,
            discount_cents: None,
            print_status: None,
        };
        let json = serde_json::to_string(&result).map_err(|_| invalid())?;
        tx.execute(
            "INSERT INTO qa_print_jobs VALUES(?1,'NOT_CONFIGURED',?2)",
            (&request.operation_id, &json),
        )?;
        cart::consume_in_sale(tx, &request)?;
        serde_json::from_str::<Value>(&json).map_err(|_| invalid())
    })?;
    serde_json::from_value(result).map_err(|_| invalid())
}
