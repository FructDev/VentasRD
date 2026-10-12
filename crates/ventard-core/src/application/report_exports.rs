//! Coherent read-only exports of native facts. Formatting/files stay in React.
use super::{
    errors::{AppError, BusinessError, ProtocolError},
    history, management, sales, sales_sync,
};
use crate::{
    domain::{money::MoneyCents, quantity::Ratio},
    storage::catalogue_preview::CatalogueContext,
};
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Kind {
    Sales,
    Inventory,
    Credit,
    Ncf,
    Repairs,
    Layaways,
}
fn invalid() -> AppError {
    AppError::Protocol(ProtocolError::MalformedPayload)
}
fn guard(code: &str) -> AppError {
    AppError::Business(BusinessError::SaleGuard { code: code.into() })
}
fn s(v: &Value) -> Result<&str, AppError> {
    v.as_str().ok_or_else(invalid)
}
fn money(v: &Value) -> Result<MoneyCents, AppError> {
    MoneyCents::parse_dto(s(v)?).map_err(|_| invalid())
}
pub fn read(
    c: &Connection,
    ctx: &CatalogueContext,
    kind: Kind,
    from: &str,
    to: &str,
) -> Result<Value, AppError> {
    if !sales_sync::operational(c, ctx)? {
        return Err(guard("LEGACY_NOT_VERIFIABLE"));
    }
    let start = MoneyCents::parse_dto(from).map_err(|_| invalid())?.cents();
    let end = MoneyCents::parse_dto(to).map_err(|_| invalid())?.cents();
    if start < 0 || end <= start || end - start > 366 * 86_400_000 {
        return Err(invalid());
    }
    let tx = c.unchecked_transaction()?;
    let sk = sales::scope_key(ctx)?;
    let profile: Option<String> = tx
        .query_row(
            "SELECT profile FROM native_business_profile_v1 WHERE tenant_id=?1",
            [&ctx.tenant_id],
            |r| r.get(0),
        )
        .optional()?;
    let mut result = json!({"version":"ventard.report.export.1","kind":kind,"coverage":"LOCAL_NATIVE_ONLY","fromMs":from,"toMs":to,"business":profile.map(|p|serde_json::from_str::<Value>(&p)).transpose().map_err(|_|invalid())?});
    match kind {
        Kind::Layaways => {
            let data = super::layaways::read(&tx, ctx)?;
            let all = data["rows"].as_array().ok_or_else(invalid)?;
            let in_range = |v: &Value| {
                v.as_str()
                    .and_then(|s| s.parse::<i64>().ok())
                    .is_some_and(|n| n >= start && n < end)
            };
            let received = all
                .iter()
                .filter(|a| in_range(&a["createdAtMs"]))
                .cloned()
                .collect::<Vec<_>>();
            let completed = all
                .iter()
                .filter(|a| a["state"] == "completado" && in_range(&a["completedAtMs"]))
                .collect::<Vec<_>>();
            let mut income = MoneyCents::ZERO;
            let mut payments = MoneyCents::ZERO;
            let mut receivable = MoneyCents::ZERO;
            let mut active = 0;
            for a in &completed {
                income = income
                    .checked_add(money(&a["totalCents"])?)
                    .map_err(|_| invalid())?;
            }
            for a in all {
                for p in a["payments"].as_array().ok_or_else(invalid)? {
                    if in_range(&p["dateMs"]) {
                        payments = payments
                            .checked_add(money(&p["amountCents"])?)
                            .map_err(|_| invalid())?;
                    }
                }
                if a["state"] == "activo" {
                    active += 1;
                    receivable = receivable
                        .checked_add(
                            money(&a["totalCents"])?
                                .checked_sub(money(&a["paidCents"])?)
                                .map_err(|_| invalid())?,
                        )
                        .map_err(|_| invalid())?;
                }
            }
            result["summary"] = json!({"new":received.len().to_string(),"paymentsCents":payments.to_dto(),"completed":completed.len().to_string(),"completedIncomeCents":income.to_dto(),"active":active.to_string(),"receivableCents":receivable.to_dto()});
            result["rows"] = json!(received);
        }
        Kind::Repairs => {
            let data = super::repairs::read(&tx, ctx)?;
            let all = data["rows"].as_array().ok_or_else(invalid)?;
            let in_range = |v: &Value| {
                v.as_str()
                    .and_then(|s| s.parse::<i64>().ok())
                    .is_some_and(|n| n >= start && n < end)
            };
            let received = all
                .iter()
                .filter(|r| in_range(&r["createdAtMs"]))
                .cloned()
                .collect::<Vec<_>>();
            let delivered = all
                .iter()
                .filter(|r| r["state"] == "entregado" && in_range(&r["deliveredAtMs"]))
                .cloned()
                .collect::<Vec<_>>();
            let mut income = MoneyCents::ZERO;
            let mut cost = MoneyCents::ZERO;
            for r in &delivered {
                income = income
                    .checked_add(money(&r["totalCents"])?)
                    .map_err(|_| invalid())?;
                for p in r["definition"]["parts"].as_array().ok_or_else(invalid)? {
                    let qty = s(&p["quantity"])?.parse::<i32>().map_err(|_| invalid())?;
                    cost = cost
                        .checked_add(
                            MoneyCents::from_i128(
                                money(&p["costCents"])?.cents() as i128 * qty as i128,
                            )
                            .map_err(|_| invalid())?,
                        )
                        .map_err(|_| invalid())?;
                }
            }
            result["summary"] = json!({"received":received.len().to_string(),"delivered":delivered.len().to_string(),"incomeCents":income.to_dto(),"partsCostCents":cost.to_dto(),"profitCents":income.checked_sub(cost).map_err(|_|invalid())?.to_dto(),"inProcess":all.iter().filter(|r|r["state"]!="entregado"&&r["state"]!="cancelado").count().to_string()});
            result["received"] = json!(received);
            result["delivered"] = json!(delivered);
        }
        Kind::Inventory => {
            let count:i64=tx.query_row("SELECT count(*) FROM products p JOIN stock_projections s ON s.producto_id=p.producto_id AND s.scope_key=?2 WHERE p.tenant_id=?1 AND p.tombstone=0",(&ctx.tenant_id,&sk),|r|r.get(0))?;
            if count > 10000 {
                return Err(guard("EXPORT_TOO_LARGE"));
            }
            let data = sales_sync::read(&tx, ctx)?;
            let mut products = data["products"].clone();
            for p in products.as_array_mut().ok_or_else(invalid)? {
                let value = if p["kind"] == "combo" {
                    None
                } else {
                    p["stock"]
                        .as_str()
                        .and_then(|q| q.parse::<i32>().ok())
                        .filter(|q| *q >= 0)
                        .zip(
                            p["costCents"]
                                .as_str()
                                .and_then(|v| MoneyCents::parse_dto(v).ok()),
                        )
                        .and_then(|(q, cost)| {
                            MoneyCents::from_i128(q as i128 * cost.cents() as i128).ok()
                        })
                        .map(|v| v.to_dto())
                };
                p["valuationCents"] = json!(value);
            }
            result["products"] = products;
            result["summary"] = data["inventorySummary"].clone();
        }
        Kind::Credit => {
            let data = management::read(&tx, ctx)?;
            result["customers"] = data["customers"].clone();
            result["creditHistoryCoverage"] =
                json!("CHARGES_PAYMENTS_BEFORE_BOOTSTRAP_UNAVAILABLE");
        }
        Kind::Sales | Kind::Ncf => {
            let ncf = matches!(kind, Kind::Ncf);
            let count:i64=tx.query_row("SELECT count(*) FROM sales WHERE tenant_id=?1 AND scope_key=?2 AND cast(created_at AS INTEGER)>=?3 AND cast(created_at AS INTEGER)<?4 AND (?5=0 OR ncf IS NOT NULL)",(&ctx.tenant_id,&sk,start,end,ncf),|r|r.get(0))?;
            if count > 10000 {
                return Err(guard("EXPORT_TOO_LARGE"));
            }
            result["summary"] = management::report(&tx, ctx, from, to)?;
            let mut q=tx.prepare("SELECT s.operation_id,s.ticket,s.ncf,s.created_at,s.total_cents,s.tax_cents,s.discount_cents,coalesce(o.state,'UNVERIFIED'),r.remote_sequence FROM sales s LEFT JOIN outbox o ON o.operation_id=s.operation_id LEFT JOIN native_sales_receipts_v1 r ON r.operation_id=s.operation_id WHERE s.tenant_id=?1 AND s.scope_key=?2 AND cast(s.created_at AS INTEGER)>=?3 AND cast(s.created_at AS INTEGER)<?4 AND (?5=0 OR s.ncf IS NOT NULL) ORDER BY cast(s.created_at AS INTEGER) DESC,s.operation_id")?;
            let mut rows = vec![];
            let mut top = BTreeMap::<String, (String, Ratio, MoneyCents)>::new();
            let mut missing = 0;
            for row in q.query_map((&ctx.tenant_id, &sk, start, end, ncf), |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, i64>(4)?,
                    r.get::<_, i64>(5)?,
                    r.get::<_, i64>(6)?,
                    r.get::<_, String>(7)?,
                    r.get::<_, Option<i64>>(8)?,
                ))
            })? {
                let (op, ticket, ncf, date, total, tax, discount, status, receipt) = row?;
                let mut data = json!({"operationId":op,"ticket":ticket,"ncf":ncf,"dateMs":date,"totalCents":total.to_string(),"itbisCents":tax.to_string(),"discountCents":discount.to_string(),"remoteStatus":if receipt.is_some(){"APPLIED"}else{status.as_str()},"method":null,"customerName":null,"ticketEvidence":"UNAVAILABLE"});
                match history::ticket(&tx, ctx, &op) {
                    Ok(snapshot) => {
                        data["method"] = snapshot["sale"]["payment"]["method"].clone();
                        data["customerName"] = snapshot["customerName"].clone();
                        data["ticketEvidence"] = json!("VERIFIED_SNAPSHOT");
                        if !matches!(kind, Kind::Ncf) {
                            for (i, line) in snapshot["sale"]["lines"]
                                .as_array()
                                .ok_or_else(invalid)?
                                .iter()
                                .enumerate()
                            {
                                let key = line["productId"]
                                    .as_str()
                                    .map(str::to_owned)
                                    .unwrap_or_else(|| format!("free/{op}/{i}"));
                                if top.len() >= 10000 && !top.contains_key(&key) {
                                    return Err(guard("EXPORT_TOO_LARGE"));
                                }
                                let qty = Ratio::parse_canonical(
                                    s(&line["quantity"]["numerator"])?,
                                    s(&line["quantity"]["denominator"])?,
                                )
                                .map_err(|_| invalid())?;
                                let price = money(&line["unitPriceCents"])?;
                                if price.cents() < 0 {
                                    return Err(invalid());
                                }
                                let subtotal = qty
                                    .checked_mul(&Ratio::from_integer(price.cents() as u64))
                                    .map_err(|_| invalid())?
                                    .to_exact_integer()
                                    .map_err(|_| invalid())?;
                                let subtotal = MoneyCents::parse_dto(&subtotal.to_string())
                                    .map_err(|_| invalid())?;
                                let old = top.entry(key).or_insert((
                                    s(&line["name"])?.into(),
                                    Ratio::zero(),
                                    MoneyCents::ZERO,
                                ));
                                old.1 = old.1.checked_add(&qty).map_err(|_| invalid())?;
                                old.2 = old.2.checked_add(subtotal).map_err(|_| invalid())?;
                            }
                        }
                    }
                    Err(AppError::Business(BusinessError::HistorySnapshotUnavailable)) => {
                        missing += 1;
                    }
                    Err(e) => return Err(e),
                }
                rows.push(data);
            }
            let mut top = top.into_values().collect::<Vec<_>>();
            top.sort_by(|a, b| b.2.cents().cmp(&a.2.cents()).then_with(|| a.0.cmp(&b.0)));
            top.truncate(50);
            result["sales"] = json!(rows);
            result["topProducts"]=json!(top.into_iter().map(|(name,q,total)|json!({"name":name,"quantity":{"numerator":q.numerator().to_string(),"denominator":q.denominator().to_string()},"subtotalCents":total.to_dto()})).collect::<Vec<_>>());
            result["salesWithoutSnapshot"] = json!(missing.to_string());
            let mut q=tx.prepare("SELECT r.operation_id,r.created_at_ms,r.document,coalesce(o.state,'APPLIED'),s.ticket FROM native_management_records_v1 r LEFT JOIN outbox o USING(operation_id) LEFT JOIN sales s ON s.operation_id=json_extract(r.document,'$.saleId') AND s.tenant_id=r.tenant_id AND s.scope_key=r.scope_key WHERE r.tenant_id=?1 AND r.scope_key=?2 AND r.kind='SALE_RETURN' AND cast(r.created_at_ms AS INTEGER)>=?3 AND cast(r.created_at_ms AS INTEGER)<?4 ORDER BY cast(r.created_at_ms AS INTEGER),r.operation_id LIMIT 10001")?;
            let refunds=q.query_map((&ctx.tenant_id,&sk,start,end),|r|Ok(json!({"operationId":r.get::<_,String>(0)?,"dateMs":r.get::<_,String>(1)?,"document":serde_json::from_str::<Value>(&r.get::<_,String>(2)?).map_err(|_|rusqlite::Error::InvalidQuery)?,"remoteStatus":r.get::<_,String>(3)?,"originalTicket":r.get::<_,Option<String>>(4)?})))?.collect::<Result<Vec<_>,_>>()?;
            if refunds.len() > 10000 {
                return Err(guard("EXPORT_TOO_LARGE"));
            }
            result["refunds"] = json!(refunds);
            result["fiscalEvidence"] = json!("NOT_CERTIFIED_607_UNAVAILABLE");
        }
    }
    tx.commit()?;
    Ok(result)
}
