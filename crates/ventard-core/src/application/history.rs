//! Bounded, scoped local history. SELECT only: never reconstruct old invoices,
//! repair business facts, dispatch outbox or claim remote acknowledgement.
use super::{
    errors::{AppError, BusinessError, ProtocolError},
    sales,
};
use crate::{
    domain::{identity::EntityId, money::MoneyCents},
    storage::catalogue_preview::CatalogueContext,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

const PAGE_SIZE: u32 = 10;
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoryFilter {
    pub search: String,
    pub method: Option<String>,
    pub from_ms: Option<String>,
    pub to_ms: Option<String>,
    pub page: u32,
}
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HistoryRow {
    pub operation_id: String,
    pub ticket: String,
    pub date_ms: Option<String>,
    pub method: Option<String>,
    pub total_cents: String,
    pub itbis_cents: String,
    pub discount_cents: String,
    pub ncf: Option<String>,
    pub customer_name: Option<String>,
    pub ticket_evidence: &'static str,
    pub remote_status: &'static str,
}
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPage {
    pub rows: Vec<HistoryRow>,
    pub total: String,
    pub page: u32,
    pub page_size: u32,
    pub scope: String,
    pub branch_id: Option<String>,
    pub coverage: &'static str,
}
fn invalid() -> AppError {
    AppError::Protocol(ProtocolError::MalformedPayload)
}
fn ms(raw: &str) -> Option<i64> {
    raw.parse::<i64>()
        .ok()
        .filter(|v| *v >= 0 && *v <= 9_007_199_254_740_991 && v.to_string() == raw)
}
fn cents_match(value: &Value, expected: i64) -> bool {
    value
        .as_str()
        .and_then(|s| MoneyCents::parse_dto(s).ok())
        .is_some_and(|m| m.cents() == expected)
}
pub fn ticket(c: &Connection, ctx: &CatalogueContext, op: &str) -> Result<Value, AppError> {
    EntityId::parse(op).map_err(|_| invalid())?;
    let found:Option<(String,i64,i64,i64)>=c.query_row("SELECT ticket,total_cents,tax_cents,discount_cents FROM sales WHERE operation_id=?1 AND tenant_id=?2 AND scope_key=?3",(op,&ctx.tenant_id,sales::scope_key(ctx)?),|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
    let (number, total, tax, discount) = found.ok_or(AppError::Business(
        BusinessError::HistorySnapshotUnavailable,
    ))?;
    let exists: bool = c.query_row(
        "SELECT EXISTS(SELECT 1 FROM sale_ticket_snapshots_v1 WHERE operation_id=?1)",
        [op],
        |r| r.get(0),
    )?;
    if !exists {
        return Err(AppError::Business(
            BusinessError::HistorySnapshotUnavailable,
        ));
    }
    let v = sales::ticket(c, ctx, op)
        .map_err(|_| AppError::Business(BusinessError::HistorySnapshotCorrupt))?;
    if v["version"] != "ventard.ticket.snapshot.1"
        || v["operationId"] != op
        || v["tenantId"] != ctx.tenant_id
        || v["scope"]["type"] != ctx.scope_type
        || v["scope"]["branchId"] != serde_json::json!(ctx.branch_id)
        || v["ticket"] != number
        || !cents_match(&v["sale"]["totals"]["totalCents"], total)
        || !cents_match(&v["sale"]["totals"]["itbisCents"], tax)
        || !cents_match(&v["sale"]["totals"]["discountCents"], discount)
    {
        return Err(AppError::Business(BusinessError::HistorySnapshotCorrupt));
    }
    Ok(v)
}
pub fn read(
    c: &Connection,
    ctx: &CatalogueContext,
    f: HistoryFilter,
) -> Result<HistoryPage, AppError> {
    if f.page == 0
        || f.page > 100000
        || f.search.chars().count() > 256
        || f.search.chars().any(char::is_control)
        || f.method.as_deref().is_some_and(|s| {
            !["EFECTIVO", "TARJETA", "TRANSFERENCIA", "MIXTO", "FIADO"].contains(&s)
        })
    {
        return Err(invalid());
    }
    let from = f
        .from_ms
        .as_deref()
        .map(|s| ms(s).ok_or_else(invalid))
        .transpose()?;
    let to = f
        .to_ms
        .as_deref()
        .map(|s| ms(s).ok_or_else(invalid))
        .transpose()?;
    if matches!((from,to),(Some(a),Some(b)) if a>=b) {
        return Err(invalid());
    }
    let key = sales::scope_key(ctx)?;
    let pattern = format!(
        "%{}%",
        f.search
            .trim()
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_")
    );
    // No concatenation of values into SQL. Only the fixed SELECT fragment is
    // shared by count/page; LIMIT bounds snapshot verification to ten rows.
    let base = r#" FROM sales s JOIN operation_journal j ON j.operation_id=s.operation_id
      LEFT JOIN sale_ticket_snapshots_v1 t ON t.operation_id=s.operation_id
      WHERE s.tenant_id=?1 AND s.scope_key=?2 AND j.local_state='COMMITTED'
      AND (?3 IS NULL OR json_extract(CASE WHEN json_valid(j.result) THEN j.result ELSE '{}' END,'$.paymentMethod')=?3)
      AND (?4 IS NULL OR (s.created_at<>'' AND s.created_at NOT GLOB '*[^0-9]*' AND CAST(s.created_at AS INTEGER)>=?4))
      AND (?5 IS NULL OR (s.created_at<>'' AND s.created_at NOT GLOB '*[^0-9]*' AND CAST(s.created_at AS INTEGER)<?5))
      AND (s.ticket LIKE ?6 ESCAPE '\' OR coalesce(s.ncf,'') LIKE ?6 ESCAPE '\'
        OR coalesce(json_extract(CASE WHEN json_valid(CAST(t.snapshot_bytes AS TEXT)) THEN CAST(t.snapshot_bytes AS TEXT) ELSE '{}' END,'$.customerName'),'') LIKE ?6 ESCAPE '\')"#;
    let values = params![ctx.tenant_id, key, f.method, from, to, pattern];
    let total: u64 = c.query_row(&format!("SELECT count(*){base}"), values, |r| r.get(0))?;
    let offset = u64::from(f.page - 1) * u64::from(PAGE_SIZE);
    let query=format!("SELECT s.operation_id,s.ticket,s.created_at,json_extract(CASE WHEN json_valid(j.result) THEN j.result ELSE '{{}}' END,'$.paymentMethod'),s.total_cents,s.tax_cents,s.discount_cents,s.ncf{base} ORDER BY CAST(s.created_at AS INTEGER) DESC,j.local_seq DESC,s.operation_id DESC LIMIT {PAGE_SIZE} OFFSET {offset}");
    let mut q = c.prepare(&query)?;
    let mut rows = q
        .query_map(values, |r| {
            Ok(HistoryRow {
                operation_id: r.get(0)?,
                ticket: r.get(1)?,
                date_ms: r.get::<_, String>(2).ok().filter(|s| ms(s).is_some()),
                method: r.get(3)?,
                total_cents: r.get::<_, i64>(4)?.to_string(),
                itbis_cents: r.get::<_, i64>(5)?.to_string(),
                discount_cents: r.get::<_, i64>(6)?.to_string(),
                ncf: r.get(7)?,
                customer_name: None,
                ticket_evidence: "UNAVAILABLE_LEGACY",
                remote_status: "UNVERIFIED",
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    for row in &mut rows {
        match ticket(c, ctx, &row.operation_id) {
            Ok(v) => {
                row.ticket_evidence = "VERIFIED_SNAPSHOT";
                row.customer_name = v["customerName"].as_str().map(str::to_owned);
                let receipt:Option<String>=c.query_row("SELECT receipt FROM native_sales_receipts_v1 WHERE operation_id=?1 AND tenant_id=?2 AND scope_key=?3",(&row.operation_id,&ctx.tenant_id,sales::scope_key(ctx)?),|r|r.get(0)).optional()?;
                if let Some(raw) = receipt {
                    let intent: Vec<u8> = c.query_row(
                        "SELECT canonical_bytes FROM operation_journal WHERE operation_id=?1",
                        [&row.operation_id],
                        |r| r.get(0),
                    )?;
                    if let (Ok(intent), Ok(receipt), Ok(snapshot)) = (
                        serde_json::from_slice::<Value>(&intent),
                        serde_json::from_str::<Value>(&raw),
                        crate::domain::canonical::canonicalize(
                            &serde_json::to_vec(&v).map_err(|_| invalid())?,
                        ),
                    ) {
                        if super::sales_sync::validate_event(
                            ctx,
                            &intent,
                            Some(&snapshot.0),
                            &receipt,
                        )
                        .is_ok()
                        {
                            row.remote_status = "APPLIED";
                        }
                    }
                }
            }
            Err(AppError::Business(BusinessError::HistorySnapshotUnavailable)) => {}
            Err(AppError::Business(BusinessError::HistorySnapshotCorrupt)) => {
                row.ticket_evidence = "CORRUPT_SNAPSHOT";
            }
            Err(e) => return Err(e),
        }
    }
    Ok(HistoryPage {
        rows,
        total: total.to_string(),
        page: f.page,
        page_size: PAGE_SIZE,
        scope: ctx.scope_type.clone(),
        branch_id: ctx.branch_id.clone(),
        coverage: "LOCAL_NATIVE_ONLY",
    })
}
