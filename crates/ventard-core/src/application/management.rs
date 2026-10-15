//! Customer metadata, debt payments, drawer movements and immutable cuts.
//! The shell supplies verified authority. No renderer SQL, clocks or tenant claims.
use super::{
    errors::{AppError, AuthError, BusinessError, ProtocolError},
    operations, sales, sales_sync,
};
use crate::{
    domain::{canonical::canonicalize, identity::EntityId, money::MoneyCents},
    security::offline_grant::VerifiedGrant,
    storage::catalogue_preview::CatalogueContext,
};
use rusqlite::{Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "SCREAMING_SNAKE_CASE",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Command {
    ServiceRefund {
        operation_id: String,
        family: String,
        service_id: String,
        expected_service_revision: String,
        expected_refund_revision: String,
        amount_cents: String,
        method: String,
        turn_id: Option<String>,
        reason: String,
    },
    BusinessSave {
        operation_id: String,
        expected_revision: String,
        definition: Box<super::settings::Definition>,
    },
    WarrantySave {
        operation_id: String,
        product_id: String,
        serial: String,
        expected_revision: String,
        action: String,
        days: String,
    },
    WarrantyDefault {
        operation_id: String,
        expected_revision: String,
        days: String,
    },
    LayawayCreate {
        operation_id: String,
        layaway_id: String,
        definition: Box<super::layaways::Definition>,
        initial_payment_cents: String,
        method: String,
        turn_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        create_customer: Option<bool>,
    },
    LayawayAction {
        operation_id: String,
        layaway_id: String,
        expected_revision: String,
        action: String,
        amount_cents: String,
        method: String,
        turn_id: Option<String>,
        warranty_days: String,
    },
    RepairDisassemble {
        operation_id: String,
        repair_id: String,
        expected_revision: String,
        entries: Vec<super::repairs::RecoveryPart>,
    },
    RepairSave {
        operation_id: String,
        repair_id: String,
        expected_revision: String,
        definition: Box<super::repairs::Definition>,
        quote: bool,
        initial_payment_cents: String,
        method: String,
        turn_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        create_customer: Option<bool>,
    },
    RepairAction {
        operation_id: String,
        repair_id: String,
        expected_revision: String,
        action: String,
        amount_cents: String,
        method: String,
        turn_id: Option<String>,
        warranty_days: String,
    },
    SaleReturn {
        operation_id: String,
        sale_id: String,
        expected_return_revision: String,
        items: Vec<crate::domain::return_plan::Item>,
        serials: Vec<String>,
        reason: String,
        turn_id: String,
    },
    ProductSave {
        operation_id: String,
        product_id: String,
        expected_revision: String,
        definition: super::inventory::ProductDefinition,
    },
    ProductDelete {
        operation_id: String,
        product_id: String,
        expected_revision: String,
    },
    InventoryChange {
        operation_id: String,
        product_id: String,
        expected_stock_revision: String,
        mode: String,
        quantity: String,
        reason: String,
        serials: Vec<String>,
    },
    CustomerSave {
        operation_id: String,
        customer_id: String,
        expected_revision: String,
        name: String,
        phone: Option<String>,
        limit_cents: String,
        price_tier: u8,
        wholesale: bool,
    },
    CustomerDelete {
        operation_id: String,
        customer_id: String,
        expected_revision: String,
    },
    CreditPayment {
        operation_id: String,
        customer_id: String,
        expected_revision: String,
        amount_cents: String,
        method: String,
        concept: String,
        turn_id: String,
    },
    ExpenseRecord {
        operation_id: String,
        amount_cents: String,
        method: String,
        concept: String,
        turn_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        category: Option<String>,
    },
    CashEntry {
        operation_id: String,
        amount_cents: String,
        direction: String,
        concept: String,
        turn_id: String,
    },
    CutX {
        operation_id: String,
        turn_id: String,
        counted_cents: String,
        denominations: Vec<Denomination>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        notes: Option<String>,
    },
    TurnClose {
        operation_id: String,
        turn_id: String,
        counted_cents: String,
        denominations: Vec<Denomination>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        notes: Option<String>,
    },
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Denomination {
    pub value_cents: String,
    pub count: String,
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
fn amount(v: &str) -> Result<i64, AppError> {
    MoneyCents::parse_dto(v)
        .map(|m| m.cents())
        .map_err(|_| invalid())
}
fn nonnegative(v: &str) -> Result<i64, AppError> {
    let n = amount(v)?;
    if n < 0 {
        return Err(invalid());
    }
    Ok(n)
}
fn positive(v: &str) -> Result<i64, AppError> {
    let n = amount(v)?;
    if n <= 0 {
        return Err(invalid());
    }
    Ok(n)
}
fn text(v: &str, max: usize) -> Result<(), AppError> {
    if v.trim().is_empty() || v.chars().count() > max || v.chars().any(char::is_control) {
        return Err(invalid());
    }
    Ok(())
}
fn canon(v: &Value) -> Result<(String, String), AppError> {
    canonicalize(&serde_json::to_vec(v).map_err(|_| invalid())?).map_err(|_| invalid())
}
pub fn supports(kind: &str) -> bool {
    matches!(
        kind,
        "PRODUCT_CREATE"
            | "SERVICE_REFUND"
            | "WARRANTY_PATCH"
            | "CONFIG_PATCH"
            | "LAYAWAY_CREATE"
            | "LAYAWAY_PAYMENT"
            | "LAYAWAY_COMPLETE"
            | "LAYAWAY_CANCEL"
            | "REPAIR_CREATE"
            | "REPAIR_EDIT"
            | "REPAIR_DISASSEMBLE"
            | "SALE_RETURN"
            | "PRODUCT_PATCH"
            | "PRODUCT_DELETE"
            | "INVENTORY_DELTA"
            | "INVENTORY_COUNT"
            | "CUSTOMER_CREATE"
            | "CUSTOMER_PATCH"
            | "CUSTOMER_DELETE"
            | "CREDIT_PAYMENT"
            | "EXPENSE_RECORD"
            | "CASH_ENTRY"
            | "CUT_X"
            | "TURN_CLOSE"
    )
}
fn sum_rows(c: &Connection, sql: &str, tenant: &str, key: &str) -> Result<i64, AppError> {
    let mut q = c.prepare(sql)?;
    let mut total = MoneyCents::ZERO;
    for row in q.query_map((tenant, key), |r| r.get::<_, i64>(0))? {
        total = total
            .checked_add(MoneyCents::from_cents(row?).map_err(|_| invalid())?)
            .map_err(|_| invalid())?;
    }
    Ok(total.cents())
}
pub fn drawer(c: &Connection, ctx: &CatalogueContext, turn: &str) -> Result<Value, AppError> {
    let sk = sales::scope_key(ctx)?;
    let row:Option<(i64,String,String)>=c.query_row("SELECT opening_cents,status,opened_at_ms FROM cash_turns WHERE tenant_id=?1 AND scope_key=?2 AND turn_id=?3",(&ctx.tenant_id,&sk,turn),|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
    let (opening, status, at) = row.ok_or_else(|| guard("TURN_REQUIRED"))?;
    let base:Option<(i64,String)>=c.query_row("SELECT net_cents,authority FROM native_cash_baseline_v1 WHERE tenant_id=?1 AND turn_id=?2",(&ctx.tenant_id,turn),|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
    let captured_without_base: bool = if base.is_none() {
        c.query_row("SELECT EXISTS(SELECT 1 FROM native_sales_bootstrap_v1 WHERE state='ACTIVE' AND json_extract(manifest,'$.context.tenantId')=?1 AND json_extract(manifest,'$.turn.receipt.operationId')=?2)",(&ctx.tenant_id,turn),|r|r.get(0))?
    } else {
        false
    };
    let coverage = if captured_without_base {
        "UNKNOWN"
    } else {
        base.as_ref().map_or("VERIFIED", |b| b.1.as_str())
    };
    let overlay = sum_rows(
        c,
        "SELECT e.amount_cents FROM sale_cash_entries_v1 e LEFT JOIN native_sales_receipts_v1 r ON r.operation_id=e.operation_id LEFT JOIN native_cash_baseline_v1 b ON b.tenant_id=e.tenant_id AND b.turn_id=e.turn_id WHERE e.tenant_id=?1 AND e.turn_id=?2 AND (r.remote_sequence IS NULL OR r.remote_sequence>coalesce(b.remote_sequence,0))",
        &ctx.tenant_id,
        turn,
    )?;
    let cash = MoneyCents::from_cents(base.as_ref().map_or(0, |b| b.0))
        .and_then(|n| n.checked_add(MoneyCents::from_cents(overlay)?))
        .map_err(|_| invalid())?
        .cents();
    let expected = MoneyCents::from_cents(opening)
        .and_then(|a| a.checked_add(MoneyCents::from_cents(cash)?))
        .map_err(|_| invalid())?;
    let mut summary = std::collections::BTreeMap::<&str, MoneyCents>::new();
    let mut sales_count = 0;
    let mut products =
        std::collections::BTreeMap::<String, (crate::domain::quantity::Ratio, MoneyCents)>::new();
    let mut product_coverage = "LOCAL_NATIVE_ONLY";
    let mut q=c.prepare("SELECT s.total_cents,snap.snapshot_bytes,snap.snapshot_hash FROM sales s LEFT JOIN sale_ticket_snapshots_v1 snap ON snap.operation_id=s.operation_id WHERE s.tenant_id=?1 AND s.scope_key=?2 AND s.turn_id=?3")?;
    for row in q.query_map((&ctx.tenant_id, &sk, turn), |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, Option<Vec<u8>>>(1)?,
            r.get::<_, Option<String>>(2)?,
        ))
    })? {
        let (n, bytes, snapshot_hash) = row?;
        sales_count += 1;
        let total = summary
            .get("totalCents")
            .copied()
            .unwrap_or_default()
            .checked_add(MoneyCents::from_cents(n).map_err(|_| invalid())?)
            .map_err(|_| invalid())?;
        summary.insert("totalCents", total);
        if let Some(b) = bytes {
            let (canonical, h) =
                crate::domain::canonical::canonicalize(&b).map_err(|_| invalid())?;
            if canonical.as_bytes() != b || Some(h) != snapshot_hash {
                return Err(invalid());
            }
            let v: Value = serde_json::from_slice(&b).map_err(|_| invalid())?;
            if amount(s(&v["sale"]["totals"]["totalCents"])?)? != n {
                return Err(invalid());
            }
            for line in v["sale"]["lines"].as_array().ok_or_else(invalid)? {
                let name = s(&line["name"])?;
                if products.len() >= 500 && !products.contains_key(name) {
                    product_coverage = "FIRST_500_LOCAL_NATIVE_PRODUCTS";
                    continue;
                }
                let ratio = crate::domain::quantity::Ratio::from_parts(
                    s(&line["quantity"]["numerator"])?
                        .parse()
                        .map_err(|_| invalid())?,
                    s(&line["quantity"]["denominator"])?
                        .parse()
                        .map_err(|_| invalid())?,
                )
                .map_err(|_| invalid())?;
                let cents = ratio
                    .checked_mul(&crate::domain::quantity::Ratio::from_integer(
                        nonnegative(s(&line["unitPriceCents"])?)? as u64,
                    ))
                    .map_err(|_| invalid())?
                    .to_exact_integer()
                    .map_err(|_| invalid())?;
                let cents = MoneyCents::parse_dto(&cents.to_string()).map_err(|_| invalid())?;
                let current = products
                    .entry(name.into())
                    .or_insert((crate::domain::quantity::Ratio::zero(), MoneyCents::ZERO));
                current.0 = current.0.checked_add(&ratio).map_err(|_| invalid())?;
                current.1 = current.1.checked_add(cents).map_err(|_| invalid())?;
            }
            let p = &v["sale"]["payment"];
            for (key, field) in [
                ("cashSalesCents", "cashNetCents"),
                ("cardCents", "cardCents"),
                ("transferCents", "transferCents"),
                ("creditCents", "creditChargeCents"),
            ] {
                let n = nonnegative(s(&p[field])?)?;
                let total = summary
                    .get(key)
                    .copied()
                    .unwrap_or_default()
                    .checked_add(MoneyCents::from_cents(n).map_err(|_| invalid())?)
                    .map_err(|_| invalid())?;
                summary.insert(key, total);
            }
            if p["method"] == "MIXTO" {
                let total = summary
                    .get("mixedCents")
                    .copied()
                    .unwrap_or_default()
                    .checked_add(MoneyCents::from_cents(n).map_err(|_| invalid())?)
                    .map_err(|_| invalid())?;
                summary.insert("mixedCents", total);
            }
        } else {
            product_coverage = "MISSING_SNAPSHOT";
        }
    }
    let mut q=c.prepare("SELECT kind,method,amount_cents FROM native_management_records_v1 WHERE tenant_id=?1 AND turn_id=?2")?;
    for row in q.query_map((&ctx.tenant_id, turn), |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, Option<String>>(1)?,
            r.get::<_, i64>(2)?,
        ))
    })? {
        let (k, m, n) = row?;
        let key = match (k.as_str(), m.as_deref()) {
            ("EXPENSE_RECORD", Some("EFECTIVO")) => Some("cashExpensesCents"),
            ("CREDIT_PAYMENT", Some("EFECTIVO")) => Some("cashCreditPaymentsCents"),
            ("CREDIT_PAYMENT", Some("TARJETA")) => Some("cardCreditPaymentsCents"),
            ("CREDIT_PAYMENT", Some("TRANSFERENCIA")) => Some("transferCreditPaymentsCents"),
            _ => None,
        };
        if let Some(key) = key {
            let total = summary
                .get(key)
                .copied()
                .unwrap_or_default()
                .checked_add(MoneyCents::from_cents(n).map_err(|_| invalid())?)
                .map_err(|_| invalid())?;
            summary.insert(key, total);
        }
    }
    let mut q=c.prepare("SELECT document FROM native_management_records_v1 WHERE tenant_id=?1 AND scope_key=?2 AND turn_id=?3 AND kind='SALE_RETURN'")?;
    for raw in q.query_map((&ctx.tenant_id, &sk, turn), |r| r.get::<_, String>(0))? {
        let d: Value = serde_json::from_str(&raw?).map_err(|_| invalid())?;
        let refund = &d["refund"];
        let total = nonnegative(s(&refund["amountCents"])?)?;
        let cash = nonnegative(s(&refund["cashRefundCents"])?)?;
        let bank = nonnegative(s(&refund["bankRefundCents"])?)?;
        let mut changes = vec![("totalCents", total), ("cashSalesCents", cash)];
        match s(&refund["method"])? {
            "TARJETA" => changes.push(("cardCents", bank)),
            "TRANSFERENCIA" => changes.push(("transferCents", bank)),
            "MIXTO" => {
                changes.push(("transferCents", bank));
                changes.push(("mixedCents", total));
            }
            "FIADO" => changes.push(("creditCents", total)),
            "EFECTIVO" => {}
            _ => return Err(invalid()),
        }
        for (key, n) in changes {
            let old = summary.get(key).copied().unwrap_or_default();
            summary.insert(
                key,
                old.checked_sub(MoneyCents::from_cents(n).map_err(|_| invalid())?)
                    .map_err(|_| invalid())?,
            );
        }
        let old = summary.get("refundCents").copied().unwrap_or_default();
        summary.insert(
            "refundCents",
            old.checked_add(MoneyCents::from_cents(total).map_err(|_| invalid())?)
                .map_err(|_| invalid())?,
        );
        product_coverage = "LOCAL_NATIVE_SALES_BEFORE_RETURNS";
    }
    // Current captures contain the complete append-only payment list. Count each
    // original payment once, including deposits present before this installation.
    let mut q=c.prepare("SELECT DISTINCT p.value FROM native_management_records_v1 r,json_each(r.document,'$.repair.payments') p WHERE r.tenant_id=?1 AND r.scope_key=?2 AND r.kind IN('REPAIR_CREATE','REPAIR_EDIT','REPAIR_DISASSEMBLE') AND json_extract(p.value,'$.turnId')=?3")?;
    let mut seen = std::collections::BTreeMap::<String, Value>::new();
    for row in q.query_map((&ctx.tenant_id, &sk, turn), |r| r.get::<_, String>(0))? {
        let p: Value = serde_json::from_str(&row?).map_err(|_| invalid())?;
        let id = s(&p["operationId"])?;
        if let Some(old) = seen.get(id) {
            if old != &p {
                return Err(invalid());
            }
            continue;
        }
        let n = positive(s(&p["amountCents"])?)?;
        for key in [
            Some("repairIncomeCents"),
            (p["method"] == "EFECTIVO").then_some("repairCashCents"),
        ]
        .into_iter()
        .flatten()
        {
            let previous = summary.get(key).copied().unwrap_or_default();
            summary.insert(
                key,
                previous
                    .checked_add(MoneyCents::from_cents(n).map_err(|_| invalid())?)
                    .map_err(|_| invalid())?,
            );
        }
        seen.insert(id.into(), p);
    }
    let mut q=c.prepare("SELECT DISTINCT p.value FROM native_management_records_v1 r,json_each(r.document,'$.layaway.payments') p WHERE r.tenant_id=?1 AND r.scope_key=?2 AND r.kind IN('LAYAWAY_CREATE','LAYAWAY_PAYMENT','LAYAWAY_COMPLETE','LAYAWAY_CANCEL') AND json_extract(p.value,'$.turnId')=?3")?;
    let mut seen = std::collections::BTreeMap::<String, Value>::new();
    for row in q.query_map((&ctx.tenant_id, &sk, turn), |r| r.get::<_, String>(0))? {
        let p: Value = serde_json::from_str(&row?).map_err(|_| invalid())?;
        let id = s(&p["operationId"])?;
        if let Some(old) = seen.get(id) {
            if old != &p {
                return Err(invalid());
            }
            continue;
        }
        let n = positive(s(&p["amountCents"])?)?;
        for key in [
            Some("layawayIncomeCents"),
            (p["method"] == "EFECTIVO").then_some("layawayCashCents"),
        ]
        .into_iter()
        .flatten()
        {
            let previous = summary.get(key).copied().unwrap_or_default();
            summary.insert(
                key,
                previous
                    .checked_add(MoneyCents::from_cents(n).map_err(|_| invalid())?)
                    .map_err(|_| invalid())?,
            );
        }
        seen.insert(id.into(), p);
    }
    let mut out = json!({"salesCount":sales_count.to_string()});
    for key in [
        "totalCents",
        "cashSalesCents",
        "cardCents",
        "transferCents",
        "creditCents",
        "mixedCents",
        "cashExpensesCents",
        "cashCreditPaymentsCents",
        "cardCreditPaymentsCents",
        "transferCreditPaymentsCents",
        "refundCents",
        "repairIncomeCents",
        "repairCashCents",
        "layawayIncomeCents",
        "layawayCashCents",
    ] {
        out[key] = json!(summary.get(key).copied().unwrap_or_default().to_dto());
    }
    let mut q=c.prepare("SELECT e.operation_id,e.amount_cents,j.kind,j.prepared_at,coalesce(s.ticket,m.concept,j.kind) FROM sale_cash_entries_v1 e JOIN operation_journal j ON j.operation_id=e.operation_id LEFT JOIN sales s ON s.operation_id=e.operation_id LEFT JOIN native_management_records_v1 m ON m.operation_id=e.operation_id WHERE e.tenant_id=?1 AND e.turn_id=?2 ORDER BY cast(j.prepared_at AS INTEGER),j.local_seq LIMIT 200")?;
    let details=q.query_map((&ctx.tenant_id,turn),|r|Ok(json!({"key":r.get::<_,String>(0)?,"amountCents":r.get::<_,i64>(1)?.to_string(),"kind":r.get::<_,String>(2)?,"dateMs":r.get::<_,String>(3)?,"title":r.get::<_,String>(4)?})))?.collect::<Result<Vec<_>,_>>()?;
    let product_rows:Vec<Value>=products.into_iter().map(|(name,(q,total))|json!({"name":name,"quantity":{"numerator":q.numerator().to_string(),"denominator":q.denominator().to_string()},"subtotalCents":total.to_dto()})).collect();
    Ok(
        json!({"turnId":turn,"status":status,"openedAtMs":at,"openingCents":opening.to_string(),"netCashCents":if coverage=="VERIFIED"{Some(cash.to_string())}else{None},"expectedCents":if coverage=="VERIFIED"{Some(expected.to_dto())}else{None},"coverage":coverage,"summary":out,"details":details,"products":product_rows,"productsCoverage":product_coverage}),
    )
}
pub(crate) fn active_turn(
    c: &Connection,
    ctx: &CatalogueContext,
    turn: &str,
) -> Result<Value, AppError> {
    EntityId::parse(turn).map_err(|_| invalid())?;
    let d = drawer(c, ctx, turn)?;
    if d["status"] != "OPEN" {
        return Err(guard("TURN_CHANGED"));
    }
    if d["coverage"] != "VERIFIED" {
        return Err(guard("CASH_UNVERIFIED"));
    }
    Ok(d)
}
pub(crate) fn customer(
    c: &Connection,
    ctx: &CatalogueContext,
    cid: &str,
) -> Result<Value, AppError> {
    EntityId::parse(cid).map_err(|_| invalid())?;
    let row:Option<Value>=c.query_row("SELECT a.name,a.balance_cents,a.limit_cents,a.active,a.authority_state,a.revision,coalesce(m.revision,1),m.phone,coalesce(p.tier,1),coalesce(m.wholesale,0) FROM sale_customer_accounts_v1 a LEFT JOIN native_customer_metadata_v1 m ON m.customer_id=a.customer_id AND m.tenant_id=a.tenant_id LEFT JOIN native_sales_customer_pricing_v1 p ON p.customer_id=a.customer_id AND p.tenant_id=a.tenant_id WHERE a.customer_id=?1 AND a.tenant_id=?2 AND a.scope_key IN(?3,?4)",(cid,&ctx.tenant_id,sales::scope_key(ctx)?,format!("{}/GLOBAL",ctx.tenant_id)),|r|Ok(json!({"id":cid,"name":r.get::<_,String>(0)?,"balanceCents":r.get::<_,i64>(1)?.to_string(),"limitCents":r.get::<_,Option<i64>>(2)?.map(|n|n.to_string()),"active":r.get::<_,bool>(3)?,"authority":r.get::<_,String>(4)?,"balanceRevision":r.get::<_,i64>(5)?.to_string(),"revision":r.get::<_,i64>(6)?.to_string(),"phone":r.get::<_,Option<String>>(7)?,"priceTier":r.get::<_,u8>(8)?,"wholesale":r.get::<_,bool>(9)?}))).optional()?;
    row.ok_or_else(|| guard("VERSION_CONFLICT"))
}
/// Scoped customer activity uses saved native facts, including downloaded history.
/// Current account authority remains independent of the historical sum.
pub fn customer_activity(
    c: &Connection,
    ctx: &CatalogueContext,
    cid: &str,
    include_services: bool,
) -> Result<Value, AppError> {
    if !sales_sync::operational(c, ctx)? {
        return Err(guard("LEGACY_NOT_VERIFIABLE"));
    }
    let current = customer(c, ctx, cid)?;
    let sk = sales::scope_key(ctx)?;
    let mut q=c.prepare("SELECT s.operation_id,s.ticket,s.created_at,s.total_cents,coalesce(o.state,'APPLIED'),CASE WHEN json_extract(CAST(t.snapshot_bytes AS TEXT),'$.sale.payment.method')='FIADO' THEN cast(json_extract(CAST(t.snapshot_bytes AS TEXT),'$.sale.payment.creditChargeCents') AS INTEGER) ELSE 0 END FROM sales s JOIN sale_ticket_snapshots_v1 t USING(operation_id) LEFT JOIN outbox o ON o.operation_id=s.operation_id WHERE s.tenant_id=?1 AND s.scope_key=?2 AND (json_extract(CAST(t.snapshot_bytes AS TEXT),'$.sale.customer.id')=?3 OR json_extract(CAST(t.snapshot_bytes AS TEXT),'$.sale.payment.customerId')=?3) ORDER BY cast(s.created_at AS INTEGER) DESC,s.operation_id DESC LIMIT 60001")?;
    let sales = q
        .query_map((&ctx.tenant_id, &sk, cid), |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, i64>(5)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    if sales.len() > 60000 {
        return Err(guard("EXPORT_TOO_LARGE"));
    }
    let sales_count = sales.len();
    let mut credit = MoneyCents::ZERO;
    let mut rows = Vec::new();
    for (op, ticket, at, total, status, fiado) in sales {
        credit = credit
            .checked_add(MoneyCents::from_cents(fiado).map_err(|_| invalid())?)
            .map_err(|_| invalid())?;
        rows.push(json!({"operationId":op,"kind":"SALE_CONFIRM","concept":format!("Venta #{ticket}"),"dateMs":at,"amountCents":total.to_string(),"direction":if fiado>0{"CHARGE"}else{"NEUTRAL"},"remoteStatus":status}));
    }
    let mut q=c.prepare("SELECT operation_id,kind,concept,created_at_ms,amount_cents,coalesce(o.state,'APPLIED') FROM native_management_records_v1 r LEFT JOIN outbox o USING(operation_id) WHERE r.tenant_id=?1 AND r.scope_key=?2 AND (r.customer_id=?3 OR json_extract(r.document,'$.credit.customerId')=?3 OR (r.kind='SALE_RETURN' AND EXISTS(SELECT 1 FROM sales s JOIN sale_ticket_snapshots_v1 t ON t.operation_id=s.operation_id WHERE s.operation_id=json_extract(r.document,'$.saleId') AND s.tenant_id=r.tenant_id AND s.scope_key=r.scope_key AND (json_extract(CAST(t.snapshot_bytes AS TEXT),'$.sale.customer.id')=?3 OR json_extract(CAST(t.snapshot_bytes AS TEXT),'$.sale.payment.customerId')=?3)))) AND r.kind IN('CREDIT_PAYMENT','SALE_RETURN') ORDER BY cast(created_at_ms AS INTEGER) DESC,operation_id DESC LIMIT 60001")?;
    let events=q.query_map((&ctx.tenant_id,&sk,cid),|r|Ok(json!({"operationId":r.get::<_,String>(0)?,"kind":r.get::<_,String>(1)?,"concept":r.get::<_,String>(2)?,"dateMs":r.get::<_,String>(3)?,"amountCents":r.get::<_,i64>(4)?.to_string(),"direction":"PAYMENT","remoteStatus":r.get::<_,String>(5)?})))?.collect::<Result<Vec<_>,_>>()?;
    if events.len() > 60000 {
        return Err(guard("EXPORT_TOO_LARGE"));
    }
    rows.extend(events);
    for row in &rows {
        crate::domain::identity::UtcMillis::parse_dto(s(&row["dateMs"])?).map_err(|_| invalid())?;
    }
    rows.sort_by(|a, b| {
        b["dateMs"]
            .as_str()
            .and_then(|s| s.parse::<u64>().ok())
            .cmp(&a["dateMs"].as_str().and_then(|s| s.parse::<u64>().ok()))
            .then_with(|| b["operationId"].as_str().cmp(&a["operationId"].as_str()))
    });
    let total = rows.len();
    rows.truncate(100);
    let count_services = |view: Value| -> Result<Value, AppError> {
        Ok(json!(view["rows"]
            .as_array()
            .ok_or_else(invalid)?
            .iter()
            .filter(|r| r["definition"]["customerId"] == cid)
            .count()
            .to_string()))
    };
    let repairs = if include_services {
        count_services(super::repairs::read(c, ctx)?)?
    } else {
        Value::Null
    };
    let layaways = if include_services {
        count_services(super::layaways::read(c, ctx)?)?
    } else {
        Value::Null
    };
    Ok(
        json!({"customer":current,"recordedCreditCents":credit.to_dto(),"salesCount":sales_count.to_string(),"repairs":repairs,"layaways":layaways,"rows":rows,"totalRows":total.to_string(),"rowLimit":100,"coverage":"SAVED_NATIVE_HISTORY_CURRENT_SCOPE","servicesCoverage":if include_services{"CURRENT_NATIVE_AND_ADOPTED_BASELINES"}else{"NOT_REQUESTED"}}),
    )
}
pub fn read(c: &Connection, ctx: &CatalogueContext) -> Result<Value, AppError> {
    if !sales_sync::operational(c, ctx)? {
        return Err(guard("LEGACY_NOT_VERIFIABLE"));
    }
    let sk = sales::scope_key(ctx)?;
    let mut q=c.prepare("SELECT customer_id FROM sale_customer_accounts_v1 WHERE tenant_id=?1 AND scope_key IN(?2,?3) ORDER BY name,customer_id")?;
    let mut customers = vec![];
    for id in q.query_map(
        (&ctx.tenant_id, &sk, format!("{}/GLOBAL", ctx.tenant_id)),
        |r| r.get::<_, String>(0),
    )? {
        if customers.len() >= 10000 {
            return Err(invalid());
        }
        customers.push(customer(c, ctx, &id?)?);
    }
    let mut q=c.prepare("SELECT r.operation_id,r.kind,r.turn_id,r.customer_id,r.method,r.amount_cents,r.concept,r.created_at_ms,coalesce(o.state,'APPLIED'),r.document FROM native_management_records_v1 r LEFT JOIN outbox o ON o.operation_id=r.operation_id WHERE r.tenant_id=?1 AND r.scope_key=?2 ORDER BY cast(r.created_at_ms AS INTEGER) DESC,r.operation_id DESC LIMIT 200")?;
    let movements=q.query_map((&ctx.tenant_id,&sk),|r|Ok(json!({"operationId":r.get::<_,String>(0)?,"kind":r.get::<_,String>(1)?,"turnId":r.get::<_,Option<String>>(2)?,"customerId":r.get::<_,Option<String>>(3)?,"method":r.get::<_,Option<String>>(4)?,"amountCents":r.get::<_,i64>(5)?.to_string(),"concept":r.get::<_,String>(6)?,"createdAtMs":r.get::<_,String>(7)?,"remoteStatus":r.get::<_,String>(8)?,"document":serde_json::from_str::<Value>(&r.get::<_,String>(9)?).map_err(|_|rusqlite::Error::InvalidQuery)?})))?.collect::<Result<Vec<_>,_>>()?;
    let turn:Option<String>=c.query_row("SELECT turn_id FROM cash_turns WHERE tenant_id=?1 AND scope_key=?2 AND status IN('OPEN','CLOSING')",(&ctx.tenant_id,&sk),|r|r.get(0)).optional()?;
    let mut q=c.prepare("SELECT canonical_bytes FROM operation_journal WHERE local_state='PREPARED' AND origin_actor=?1 AND origin_device=?2 AND json_extract(CAST(canonical_bytes AS TEXT),'$.negocioId')=?3 AND kind NOT IN('SALE_CONFIRM','TURN_OPEN') ORDER BY local_seq LIMIT 100")?;
    let pending = q
        .query_map((&ctx.actor_id, &ctx.device_id, &ctx.tenant_id), |r| {
            r.get::<_, Vec<u8>>(0)
        })?
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .map(|b| {
            serde_json::from_slice::<Value>(&b)
                .map(|v| v["payload"]["request"].clone())
                .map_err(|_| invalid())
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(
        json!({"customers":customers,"movements":movements,"movementLimit":200,"coverage":"LOCAL_NATIVE_ONLY","turn":turn.map(|t|drawer(c,ctx,&t)).transpose()?,"pending":pending}),
    )
}
pub(crate) fn counted(counted: &str, denoms: &[Denomination]) -> Result<i64, AppError> {
    let n = nonnegative(counted)?;
    if denoms.len() > 20 {
        return Err(invalid());
    }
    if !denoms.is_empty() {
        let mut total = 0i128;
        let mut seen = std::collections::HashSet::new();
        for d in denoms {
            let unit = positive(&d.value_cents)?;
            if ![
                1, 5, 10, 25, 50, 100, 500, 1000, 2500, 5000, 10000, 20000, 50000, 100000, 200000,
            ]
            .contains(&unit)
                || !seen.insert(unit)
            {
                return Err(invalid());
            }
            total += unit as i128 * nonnegative(&d.count)? as i128;
        }
        if total != n as i128 {
            return Err(invalid());
        }
    }
    Ok(n)
}
pub fn execute(
    c: &mut Connection,
    g: &VerifiedGrant,
    now: u64,
    high: u64,
    opens: u64,
    req: Command,
) -> Result<Value, AppError> {
    execute_private(c, g, now, high, opens, req, None)
}
#[allow(clippy::too_many_arguments)]
pub fn execute_private(
    c: &mut Connection,
    g: &VerifiedGrant,
    now: u64,
    high: u64,
    opens: u64,
    req: Command,
    private: Option<super::repair_private::Change>,
) -> Result<Value, AppError> {
    let decision = g.evaluate(now, high, opens).map_err(|_| invalid())?;
    let required = if matches!(req, Command::CreditPayment { .. }) {
        "SELL"
    } else {
        "MANAGE"
    };
    if !decision.allows(required) {
        return Err(AppError::Auth(AuthError::PermissionDenied {
            required: required.into(),
        }));
    }
    if matches!(
        req,
        Command::RepairSave { .. }
            | Command::ServiceRefund { .. }
            | Command::WarrantySave { .. }
            | Command::WarrantyDefault { .. }
            | Command::LayawayCreate { .. }
            | Command::LayawayAction { .. }
            | Command::RepairAction { .. }
            | Command::RepairDisassemble { .. }
    ) && decision.plan_tier.as_deref() != Some("pro")
    {
        return Err(guard("PRO_REQUIRED"));
    }
    let p = g.payload();
    let ctx = CatalogueContext {
        tenant_id: p.tenant_id.clone(),
        actor_id: p.actor_id.clone(),
        device_id: p.device_id.clone(),
        installation_id: p.installation_id.clone(),
        writer_epoch: p.writer_epoch.clone(),
        scope_type: p.scope.r#type.clone(),
        branch_id: p.scope.branch_id.clone(),
    };
    if !sales_sync::operational(c, &ctx)? {
        return Err(guard("LEGACY_NOT_VERIFIABLE"));
    }
    let request = serde_json::to_value(&req).map_err(|_| invalid())?;
    let op = s(&request["operationId"])?;
    EntityId::parse(op).map_err(|_| invalid())?;
    super::repair_private::stage(c, &ctx, &req, private.as_ref())?;
    let sk = sales::scope_key(&ctx)?;
    let origin = sk.split_once('/').ok_or_else(invalid)?.1;
    let old: Option<Vec<u8>> = c
        .query_row(
            "SELECT canonical_bytes FROM operation_journal WHERE operation_id=?1",
            [op],
            |r| r.get(0),
        )
        .optional()?;
    let intent = if let Some(b) = old {
        let v: Value = serde_json::from_slice(&b).map_err(|_| invalid())?;
        if v["payload"]["request"] != request
            || v["negocioId"] != p.tenant_id
            || v["actorId"] != p.actor_id
            || v["originDeviceId"] != p.device_id
            || v["installationId"] != p.installation_id
            || v["writerEpoch"] != p.writer_epoch
            || v["scope"] != json!({"type":p.scope.r#type,"sucursalId":p.scope.branch_id})
        {
            return Err(AppError::Protocol(ProtocolError::OperationIdConflict));
        }
        v
    } else {
        let mut doc = json!({});
        let mut kind = request["kind"].as_str().ok_or_else(invalid)?.to_owned();
        let mut turn: Option<String> = None;
        match &req {
            Command::ServiceRefund { turn_id, .. } => {
                doc = super::service_refunds::document(
                    c,
                    &ctx,
                    &req,
                    &decision.effective_time_ms,
                    false,
                )?;
                turn = turn_id.clone();
            }
            Command::BusinessSave { .. } => {
                kind = "CONFIG_PATCH".into();
                doc = super::settings::document(c, &ctx, &req)?;
            }
            Command::WarrantySave { .. } | Command::WarrantyDefault { .. } => {
                (kind, doc) =
                    super::warranties::document(c, &ctx, &req, &decision.effective_time_ms, None)?;
            }
            Command::LayawayCreate { .. } | Command::LayawayAction { .. } => {
                (kind, doc) =
                    super::layaways::document(c, &ctx, &req, &decision.effective_time_ms)?;
                turn = doc["payment"]["turnId"].as_str().map(str::to_owned);
            }
            Command::RepairSave { .. }
            | Command::RepairAction { .. }
            | Command::RepairDisassemble { .. } => {
                (kind, doc) = super::repairs::document(c, &ctx, &req, &decision.effective_time_ms)?;
                turn = doc["payment"]["turnId"].as_str().map(str::to_owned);
            }
            Command::SaleReturn { turn_id, .. } => {
                doc = super::returns::document(c, &ctx, &req)?;
                turn = Some(turn_id.clone());
            }
            Command::ProductSave { .. }
            | Command::ProductDelete { .. }
            | Command::InventoryChange { .. } => {
                (kind, doc) = super::inventory::document(c, &ctx, &req)?;
            }
            Command::CustomerSave {
                customer_id,
                expected_revision,
                name,
                phone,
                limit_cents,
                price_tier,
                wholesale,
                ..
            } => {
                EntityId::parse(customer_id).map_err(|_| invalid())?;
                text(name, 256)?;
                if let Some(p) = phone {
                    if p.chars().count() > 64 || p.chars().any(char::is_control) {
                        return Err(invalid());
                    }
                }
                nonnegative(limit_cents)?;
                if !(1..=3).contains(price_tier) {
                    return Err(invalid());
                }
                let rev = nonnegative(expected_revision)?;
                if rev == 0 {
                    let exists:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM sale_customer_accounts_v1 WHERE customer_id=?1)",[customer_id],|r|r.get(0))?;
                    if exists {
                        return Err(guard("VERSION_CONFLICT"));
                    }
                    kind = "CUSTOMER_CREATE".into();
                } else {
                    let old = customer(c, &ctx, customer_id)?;
                    if old["revision"] != *expected_revision || old["active"] != true {
                        return Err(guard("VERSION_CONFLICT"));
                    }
                    kind = "CUSTOMER_PATCH".into();
                }
                doc = json!({"customer":{"id":customer_id,"name":name,"phone":phone,"limitCents":limit_cents,"priceTier":price_tier,"wholesale":wholesale,"active":true,"revision":rev.checked_add(1).ok_or_else(invalid)?.to_string()}});
            }
            Command::CustomerDelete {
                customer_id,
                expected_revision,
                ..
            } => {
                let old = customer(c, &ctx, customer_id)?;
                if old["revision"] != *expected_revision || old["active"] != true {
                    return Err(guard("VERSION_CONFLICT"));
                }
                if amount(s(&old["balanceCents"])?)? > 0 {
                    return Err(guard("CREDIT_BALANCE_PENDING"));
                }
                let rev = positive(expected_revision)?;
                let cust = json!({"id":old["id"],"name":old["name"],"phone":old["phone"],"limitCents":old["limitCents"],"priceTier":old["priceTier"],"wholesale":old["wholesale"],"active":false,"revision":rev.checked_add(1).ok_or_else(invalid)?.to_string()});
                doc = json!({"customer":cust});
            }
            Command::CreditPayment {
                customer_id,
                expected_revision,
                amount_cents,
                method,
                concept,
                turn_id,
                ..
            } => {
                text(concept, 256)?;
                let n = positive(amount_cents)?;
                if !["EFECTIVO", "TARJETA", "TRANSFERENCIA"].contains(&method.as_str()) {
                    return Err(invalid());
                }
                let old = customer(c, &ctx, customer_id)?;
                if old["active"] != true
                    || old["authority"] != "VERIFIED"
                    || old["balanceRevision"] != *expected_revision
                {
                    return Err(guard("VERSION_CONFLICT"));
                }
                let before = nonnegative(s(&old["balanceCents"])?)?;
                if n > before {
                    return Err(guard("CREDIT_OVERPAY"));
                }
                active_turn(c, &ctx, turn_id)?;
                turn = Some(turn_id.clone());
                doc = json!({"customerId":customer_id,"balanceBeforeCents":before.to_string(),"balanceAfterCents":(before-n).to_string(),"balanceRevision":positive(expected_revision)?.checked_add(1).ok_or_else(invalid)?.to_string(),"amountCents":amount_cents,"method":method,"concept":concept,"cashDeltaCents":if method=="EFECTIVO"{amount_cents.as_str()}else{"0"}});
            }
            Command::ExpenseRecord {
                amount_cents,
                method,
                concept,
                turn_id,
                category,
                ..
            } => {
                positive(amount_cents)?;
                text(concept, 256)?;
                if !["EFECTIVO", "TARJETA", "TRANSFERENCIA"].contains(&method.as_str())
                    || category.as_deref().is_some_and(|c| {
                        ![
                            "mercancia",
                            "servicios",
                            "alquiler",
                            "sueldos",
                            "transporte",
                            "otro",
                        ]
                        .contains(&c)
                    })
                {
                    return Err(invalid());
                }
                active_turn(c, &ctx, turn_id)?;
                turn = Some(turn_id.clone());
                doc = json!({"amountCents":amount_cents,"method":method,"concept":concept,"category":category,"cashDeltaCents":if method=="EFECTIVO"{(-positive(amount_cents)?).to_string()}else{"0".into()}});
            }
            Command::CashEntry {
                amount_cents,
                direction,
                concept,
                turn_id,
                ..
            } => {
                let n = positive(amount_cents)?;
                text(concept, 256)?;
                if !["IN", "OUT"].contains(&direction.as_str()) {
                    return Err(invalid());
                }
                active_turn(c, &ctx, turn_id)?;
                turn = Some(turn_id.clone());
                doc = json!({"amountCents":amount_cents,"method":"EFECTIVO","concept":concept,"direction":direction,"cashDeltaCents":if direction=="IN"{n}else{-n}.to_string()});
            }
            Command::CutX {
                turn_id,
                counted_cents,
                denominations,
                ..
            }
            | Command::TurnClose {
                turn_id,
                counted_cents,
                denominations,
                ..
            } => {
                let n = counted(counted_cents, denominations)?;
                let d = active_turn(c, &ctx, turn_id)?;
                if matches!(req, Command::TurnClose { .. }) {
                    let pending:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM outbox o JOIN operation_journal j ON j.operation_id=o.operation_id WHERE o.state<>'APPLIED' AND j.origin_scope=?1 AND json_extract(CAST(j.canonical_bytes AS TEXT),'$.negocioId')=?2)",(origin,&ctx.tenant_id),|r|r.get(0))?;
                    if pending {
                        return Err(guard("CASH_PENDING"));
                    }
                }
                if let Some(note) = request["notes"].as_str() {
                    if note.chars().count() > 1000
                        || note.chars().any(|c| c.is_control() && c != '\n')
                    {
                        return Err(invalid());
                    }
                }
                turn = Some(turn_id.clone());
                let expected = amount(s(&d["expectedCents"])?)?;
                doc = json!({"drawer":d,"countedCents":counted_cents,"differenceCents":MoneyCents::from_i128(n as i128-expected as i128).map_err(|_|invalid())?.to_dto(),"denominations":denominations,"notes":request["notes"]});
                let business = super::settings::public_profile(c, &ctx)?;
                if !business.is_null() {
                    doc["business"] = business;
                }
            }
        }
        if let Some(t) = &turn {
            let d = drawer(c, &ctx, t)?;
            if doc["cashDeltaCents"].is_string() {
                MoneyCents::parse_dto(s(&d["expectedCents"])?)
                    .map_err(|_| invalid())?
                    .checked_add(
                        MoneyCents::parse_dto(s(&doc["cashDeltaCents"])?).map_err(|_| invalid())?,
                    )
                    .map_err(|_| invalid())?;
            }
        }
        json!({"protocol":"ventard.native.v1","kind":kind,"contractVersion":1,"canonicalizationVersion":"C-N1","operationId":op,"negocioId":p.tenant_id,"scope":{"type":p.scope.r#type,"sucursalId":p.scope.branch_id},"originDeviceId":p.device_id,"installationId":p.installation_id,"writerEpoch":p.writer_epoch,"actorId":p.actor_id,"permissionGrantId":p.grant_id,"originalTurnId":turn,"originAtUtcMs":decision.effective_time_ms,"expectedVersions":{},"dependencies":[],"payload":{"request":request,"document":doc}})
    };
    let (bytes, hash) = canon(&intent)?;
    let kind = s(&intent["kind"])?;
    operations::prepare_operation(
        c,
        op,
        "ventard.native.v1",
        kind,
        1,
        bytes.as_bytes(),
        &hash,
        &p.actor_id,
        origin,
        &p.device_id,
        p.writer_epoch.parse().map_err(|_| invalid())?,
        s(&intent["originAtUtcMs"])?,
    )?;
    operations::execute_prepared_operation(c, op, &hash, |tx| {
        apply(tx, &ctx, &intent, false)?;
        super::repair_private::apply(tx, &ctx, &intent)?;
        tx.execute(
            "INSERT INTO outbox(operation_id,envelope,state) VALUES(?1,?2,'PENDING')",
            (op, bytes.as_bytes()),
        )?;
        Ok(
            json!({"operationId":op,"kind":kind,"remoteStatus":"PENDING","document":intent["payload"]["document"]}),
        )
    })
}

pub fn effects(v: &Value) -> Result<Value, AppError> {
    if super::layaways::supports(v["kind"].as_str().unwrap_or_default()) {
        return super::layaways::effects(v);
    }
    if super::repairs::supports(v["kind"].as_str().unwrap_or_default()) {
        return super::repairs::effects(v);
    }
    if v["kind"] == "SALE_RETURN" {
        return super::returns::effects(v);
    }
    if super::inventory::supports(v["kind"].as_str().unwrap_or_default()) {
        return super::inventory::effects(v);
    }
    let op = s(&v["operationId"])?;
    let kind = s(&v["kind"])?;
    if !supports(kind) {
        return Err(invalid());
    }
    Ok(
        json!([{"id":sales::effect_id(op,"management"),"kind":kind,"payload":v["payload"]["document"]}]),
    )
}
pub fn validate_receipt(v: &Value, r: &Value, snapshot: Option<&str>) -> Result<(), AppError> {
    if v["kind"] == "SERVICE_REFUND" {
        super::service_refunds::validate(v)?;
    }
    if super::layaways::supports(v["kind"].as_str().unwrap_or_default()) {
        return super::layaways::validate_receipt(v, r, snapshot);
    }
    if super::repairs::supports(v["kind"].as_str().unwrap_or_default()) {
        return super::repairs::validate_receipt(v, r, snapshot);
    }
    if v["kind"] == "SALE_RETURN" {
        return super::returns::validate_receipt(v, r, snapshot);
    }
    if super::inventory::supports(v["kind"].as_str().unwrap_or_default()) {
        return super::inventory::validate_receipt(v, r, snapshot);
    }
    if snapshot.is_some()
        || !r["snapshotHash"].is_null()
        || !r["ticket"].is_null()
        || !r["ncf"].is_null()
        || !r["totalCents"].is_null()
        || r["stock"] != json!([])
        || r["effects"] != effects(v)?
    {
        return Err(invalid());
    }
    if matches!(v["kind"].as_str(), Some("CUT_X" | "TURN_CLOSE")) {
        let req: Command =
            serde_json::from_value(v["payload"]["request"].clone()).map_err(|_| invalid())?;
        let (turn, n, notes) = match &req {
            Command::CutX {
                turn_id,
                counted_cents,
                denominations,
                notes,
                ..
            } if v["kind"] == "CUT_X" => (turn_id, counted(counted_cents, denominations)?, notes),
            Command::TurnClose {
                turn_id,
                counted_cents,
                denominations,
                notes,
                ..
            } if v["kind"] == "TURN_CLOSE" => {
                (turn_id, counted(counted_cents, denominations)?, notes)
            }
            _ => return Err(invalid()),
        };
        let d = &v["payload"]["document"];
        let expected = amount(s(&d["drawer"]["expectedCents"])?)?;
        let difference = MoneyCents::from_i128(n as i128 - expected as i128)
            .map_err(|_| invalid())?
            .to_dto();
        if v["originalTurnId"] != *turn
            || d["drawer"]["turnId"] != *turn
            || d["drawer"]["status"] != "OPEN"
            || d["countedCents"] != json!(n.to_string())
            || d["differenceCents"] != difference
            || d["denominations"] != v["payload"]["request"]["denominations"]
            || d["notes"] != json!(notes)
        {
            return Err(invalid());
        }
    }
    Ok(())
}
pub fn apply(
    tx: &Transaction<'_>,
    ctx: &CatalogueContext,
    v: &Value,
    remote: bool,
) -> Result<(), AppError> {
    let op = s(&v["operationId"])?;
    let kind = s(&v["kind"])?;
    let d = &v["payload"]["document"];
    let req = &v["payload"]["request"];
    let sk = sales::scope_key(ctx)?;
    if kind == "SERVICE_REFUND" {
        super::service_refunds::apply(tx, ctx, v, remote)?;
    }
    if kind == "SALE_RETURN" {
        super::returns::apply(tx, ctx, v, remote)?;
    }
    if kind == "CONFIG_PATCH" && req["kind"] == "BUSINESS_SAVE" {
        super::settings::apply(tx, ctx, v, remote)?;
    } else if matches!(kind, "WARRANTY_PATCH" | "CONFIG_PATCH") {
        super::warranties::apply(tx, ctx, v, remote)?;
    }
    if super::repairs::supports(kind) {
        super::repairs::apply(tx, ctx, v, remote)?;
    }
    if super::layaways::supports(kind) {
        super::layaways::apply(tx, ctx, v, remote)?;
    }
    if super::inventory::supports(kind) {
        super::inventory::apply(tx, ctx, v, remote)?;
    }
    if kind.starts_with("CUSTOMER_") {
        let cu = &d["customer"];
        let cid = s(&cu["id"])?;
        let exists:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM sale_customer_accounts_v1 WHERE customer_id=?1 AND tenant_id=?2)",(cid,&ctx.tenant_id),|r|r.get(0))?;
        let current = if exists {
            Some(customer(tx, ctx, cid)?)
        } else {
            None
        };
        if kind == "CUSTOMER_DELETE"
            && current.as_ref().is_some_and(|c| {
                c["balanceCents"]
                    .as_str()
                    .and_then(|s| amount(s).ok())
                    .is_some_and(|n| n > 0)
            })
        {
            return Err(guard("CREDIT_BALANCE_PENDING"));
        }
        let rev = positive(s(&cu["revision"])?)?;
        let expected = nonnegative(s(&req["expectedRevision"])?)?;
        if rev != expected + 1
            || current.as_ref().is_some_and(|c| {
                c["revision"].as_str().and_then(|s| s.parse::<i64>().ok()) != Some(expected)
            })
            || (current.is_none() && kind != "CUSTOMER_CREATE")
        {
            return Err(guard("VERSION_CONFLICT"));
        }
        if kind == "CUSTOMER_CREATE" {
            if current.is_some() {
                return Err(guard("VERSION_CONFLICT"));
            }
            tx.execute(
                "INSERT INTO sale_customer_accounts_v1 VALUES(?1,?2,?3,?4,0,?5,1,'VERIFIED',1)",
                (
                    cid,
                    &ctx.tenant_id,
                    &sk,
                    s(&cu["name"])?,
                    nonnegative(s(&cu["limitCents"])?)?,
                ),
            )?;
        } else {
            let n=tx.execute("UPDATE sale_customer_accounts_v1 SET name=?3,limit_cents=?4,active=?5 WHERE customer_id=?1 AND tenant_id=?2",(cid,&ctx.tenant_id,s(&cu["name"])?,nonnegative(s(&cu["limitCents"])?)?,cu["active"].as_bool().ok_or_else(invalid)?))?;
            if n != 1 {
                return Err(guard("VERSION_CONFLICT"));
            }
        }
        tx.execute("INSERT INTO native_customer_metadata_v1 VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(customer_id) DO UPDATE SET phone=excluded.phone,price_tier=excluded.price_tier,wholesale=excluded.wholesale,revision=excluded.revision",(cid,&ctx.tenant_id,cu["phone"].as_str(),cu["priceTier"].as_u64().ok_or_else(invalid)?,cu["wholesale"].as_bool().ok_or_else(invalid)?,rev))?;
        tx.execute("INSERT INTO native_sales_customer_pricing_v1 VALUES(?1,?2,?3) ON CONFLICT(customer_id) DO UPDATE SET tier=excluded.tier",(cid,&ctx.tenant_id,cu["priceTier"].as_u64().ok_or_else(invalid)?))?;
    } else if kind == "CREDIT_PAYMENT" {
        let cid = s(&d["customerId"])?;
        let old = customer(tx, ctx, cid)?;
        if old["balanceCents"] != d["balanceBeforeCents"]
            || old["balanceRevision"] != req["expectedRevision"]
        {
            return Err(guard("VERSION_CONFLICT"));
        }
        let n = positive(s(&d["amountCents"])?)?;
        let before = nonnegative(s(&d["balanceBeforeCents"])?)?;
        if n > before || amount(s(&d["balanceAfterCents"])?)? != before - n {
            return Err(guard("CREDIT_OVERPAY"));
        }
        tx.execute(
            "INSERT INTO sale_credit_entries_v1 VALUES(?1,?2,?3,?4,?5,?6,?7)",
            (op, cid, &ctx.tenant_id, &sk, -n, before, before - n),
        )?;
        tx.execute("UPDATE sale_customer_accounts_v1 SET balance_cents=?3,revision=revision+1 WHERE customer_id=?1 AND tenant_id=?2",(cid,&ctx.tenant_id,before-n))?;
        tx.execute(
            "INSERT INTO payments VALUES(?1,?2,NULL,NULL,?3,?4,0,0,?5)",
            (
                sales::effect_id(op, "payment"),
                op,
                s(&d["method"])?,
                n,
                v["originalTurnId"].as_str(),
            ),
        )?;
    }
    if let Some(delta) = d["cashDeltaCents"].as_str() {
        let n = amount(delta)?;
        let turn = s(&v["originalTurnId"])?;
        active_turn(tx, ctx, turn)?;
        if n != 0 {
            tx.execute(
                "INSERT INTO sale_cash_entries_v1 VALUES(?1,?2,?3,?4,?5)",
                (op, turn, &ctx.tenant_id, &sk, n),
            )?;
        }
    }
    if matches!(kind, "TURN_CLOSE" | "CUT_X") {
        let turn = s(&v["originalTurnId"])?;
        let current = if remote {
            let (opening,at,status):(i64,String,String)=tx.query_row("SELECT opening_cents,opened_at_ms,status FROM cash_turns WHERE turn_id=?1 AND tenant_id=?2 AND scope_key=?3",(turn,&ctx.tenant_id,&sk),|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
            if d["drawer"]["openingCents"] != json!(opening.to_string())
                || d["drawer"]["openedAtMs"] != at
                || !matches!(status.as_str(), "OPEN" | "CLOSING")
            {
                return Err(guard("TURN_CHANGED"));
            }
            None
        } else {
            Some(active_turn(tx, ctx, turn)?)
        };
        if [
            "turnId",
            "status",
            "openedAtMs",
            "openingCents",
            "netCashCents",
            "expectedCents",
            "summary",
        ]
        .iter()
        .any(|key| {
            current
                .as_ref()
                .is_some_and(|current| current[*key] != d["drawer"][*key])
        }) {
            return Err(guard("VERSION_CONFLICT"));
        }
        if kind == "TURN_CLOSE" {
            if remote {
                tx.execute("INSERT INTO native_sales_failures_v1 SELECT o.operation_id,'TURN_CHANGED' FROM outbox o JOIN operation_journal j ON j.operation_id=o.operation_id WHERE o.state<>'APPLIED' AND o.operation_id<>?1 AND json_extract(CAST(j.canonical_bytes AS TEXT),'$.originalTurnId')=?2 AND json_extract(CAST(j.canonical_bytes AS TEXT),'$.negocioId')=?3 ON CONFLICT(operation_id) DO UPDATE SET code='TURN_CHANGED'",(op,turn,&ctx.tenant_id))?;
                tx.execute("UPDATE outbox SET state='INTERVENTION',claim_id=NULL,lease_expires=NULL WHERE state<>'APPLIED' AND operation_id<>?1 AND operation_id IN(SELECT operation_id FROM operation_journal WHERE json_extract(CAST(canonical_bytes AS TEXT),'$.originalTurnId')=?2 AND json_extract(CAST(canonical_bytes AS TEXT),'$.negocioId')=?3)",(op,turn,&ctx.tenant_id))?;
            }
            tx.execute(
                "UPDATE cash_turns SET status=?2,revision=revision+1 WHERE turn_id=?1",
                (turn, if remote { "CLOSED" } else { "CLOSING" }),
            )?;
        }
    }
    tx.execute(
        "INSERT INTO native_management_records_v1 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
        (
            op,
            &ctx.tenant_id,
            &sk,
            kind,
            v["originalTurnId"].as_str(),
            d["customerId"].as_str(),
            d["method"].as_str(),
            d["amountCents"]
                .as_str()
                .map(amount)
                .transpose()?
                .unwrap_or(0),
            d["concept"].as_str().unwrap_or(kind),
            s(&v["originAtUtcMs"])?,
            d.to_string(),
        ),
    )?;
    Ok(())
}
pub fn acknowledge(tx: &Transaction<'_>, v: &Value) -> Result<(), AppError> {
    if v["kind"] == "TURN_CLOSE" {
        tx.execute(
            "UPDATE cash_turns SET status='CLOSED' WHERE turn_id=?1 AND status='CLOSING'",
            [s(&v["originalTurnId"])?],
        )?;
    }
    Ok(())
}
pub fn abandon(
    c: &mut Connection,
    g: &VerifiedGrant,
    now: u64,
    high: u64,
    opens: u64,
    op: &str,
) -> Result<Value, AppError> {
    let raw: Vec<u8> = c.query_row(
        "SELECT canonical_bytes FROM operation_journal WHERE operation_id=?1",
        [op],
        |r| r.get(0),
    )?;
    let v: Value = serde_json::from_slice(&raw).map_err(|_| invalid())?;
    let p = g.payload();
    let decision = g.evaluate(now, high, opens).map_err(|_| invalid())?;
    let required = if v["kind"] == "CREDIT_PAYMENT" {
        "SELL"
    } else {
        "MANAGE"
    };
    if !decision.allows(required)
        || !v["kind"].as_str().is_some_and(supports)
        || v["negocioId"] != p.tenant_id
        || v["actorId"] != p.actor_id
        || v["originDeviceId"] != p.device_id
        || v["installationId"] != p.installation_id
        || v["writerEpoch"] != p.writer_epoch
        || v["scope"] != json!({"type":p.scope.r#type,"sucursalId":p.scope.branch_id})
    {
        return Err(AppError::Auth(AuthError::PermissionDenied {
            required: required.into(),
        }));
    }
    let effects:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM outbox WHERE operation_id=?1) OR EXISTS(SELECT 1 FROM native_management_records_v1 WHERE operation_id=?1)",[op],|r|r.get(0))?;
    if effects {
        return Err(guard("OPERATION_ALREADY_APPLIED"));
    }
    operations::abandon_operation(c, op)?;
    Ok(json!({"operationId":op,"state":"ABANDONED"}))
}

pub fn report(
    c: &Connection,
    ctx: &CatalogueContext,
    from: &str,
    to: &str,
) -> Result<Value, AppError> {
    if !sales_sync::operational(c, ctx)? {
        return Err(guard("LEGACY_NOT_VERIFIABLE"));
    }
    let start = nonnegative(from)?;
    let end = nonnegative(to)?;
    if end <= start || end - start > 366 * 86_400_000 {
        return Err(invalid());
    }
    let sk = sales::scope_key(ctx)?;
    let mut q=c.prepare("SELECT s.operation_id,s.total_cents,s.tax_cents,s.discount_cents,snap.snapshot_bytes FROM sales s LEFT JOIN sale_ticket_snapshots_v1 snap ON snap.operation_id=s.operation_id WHERE s.tenant_id=?1 AND s.scope_key=?2 AND cast(s.created_at AS INTEGER)>=?3 AND cast(s.created_at AS INTEGER)<?4 ORDER BY s.created_at")?;
    let mut totals = [MoneyCents::ZERO; 3];
    let mut count = 0;
    let mut missing = 0;
    let mut costs = MoneyCents::ZERO;
    for row in q.query_map((&ctx.tenant_id, &sk, start, end), |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, i64>(1)?,
            r.get::<_, i64>(2)?,
            r.get::<_, i64>(3)?,
            r.get::<_, Option<Vec<u8>>>(4)?,
        ))
    })? {
        let (_, total, tax, discount, snapshot) = row?;
        count += 1;
        for (i, n) in [total, tax, discount].iter().enumerate() {
            totals[i] = totals[i]
                .checked_add(MoneyCents::from_cents(*n).map_err(|_| invalid())?)
                .map_err(|_| invalid())?;
        }
        let frozen_cost = snapshot
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
            .and_then(|v| snapshot_cost(&v).ok());
        if let Some(n) = frozen_cost {
            costs = costs.checked_add(n).map_err(|_| invalid())?;
        } else {
            missing += 1;
        }
    }
    let mut methods = std::collections::BTreeMap::<String, MoneyCents>::new();
    let mut q=c.prepare("SELECT p.method,p.amount_cents FROM payments p JOIN sales s ON s.sale_id=p.sale_id WHERE s.tenant_id=?1 AND s.scope_key=?2 AND cast(s.created_at AS INTEGER)>=?3 AND cast(s.created_at AS INTEGER)<?4")?;
    for row in q.query_map((&ctx.tenant_id, &sk, start, end), |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
    })? {
        let (m, n) = row?;
        let prev = methods.get(&m).copied().unwrap_or_default();
        methods.insert(
            m,
            prev.checked_add(MoneyCents::from_cents(n).map_err(|_| invalid())?)
                .map_err(|_| invalid())?,
        );
    }
    let mut credit = MoneyCents::ZERO;
    let mut expense = MoneyCents::ZERO;
    let mut abono = MoneyCents::ZERO;
    let mut refunds = MoneyCents::ZERO;
    let mut service_refunds = MoneyCents::ZERO;
    let mut q=c.prepare("SELECT e.amount_cents FROM sale_credit_entries_v1 e JOIN sales s ON s.operation_id=e.operation_id WHERE e.tenant_id=?1 AND e.scope_key=?2 AND cast(s.created_at AS INTEGER)>=?3 AND cast(s.created_at AS INTEGER)<?4")?;
    for row in q.query_map((&ctx.tenant_id, &sk, start, end), |r| r.get::<_, i64>(0))? {
        credit = credit
            .checked_add(MoneyCents::from_cents(row?).map_err(|_| invalid())?)
            .map_err(|_| invalid())?;
    }
    let mut q=c.prepare("SELECT kind,amount_cents FROM native_management_records_v1 WHERE tenant_id=?1 AND scope_key=?2 AND cast(created_at_ms AS INTEGER)>=?3 AND cast(created_at_ms AS INTEGER)<?4")?;
    for row in q.query_map((&ctx.tenant_id, &sk, start, end), |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
    })? {
        let (k, n) = row?;
        let m = MoneyCents::from_cents(n).map_err(|_| invalid())?;
        if k == "EXPENSE_RECORD" {
            expense = expense.checked_add(m).map_err(|_| invalid())?
        }
        if k == "CREDIT_PAYMENT" {
            abono = abono.checked_add(m).map_err(|_| invalid())?
        }
        if k == "SALE_RETURN" {
            refunds = refunds.checked_add(m).map_err(|_| invalid())?;
        }
        if k == "SERVICE_REFUND" {
            service_refunds = service_refunds.checked_add(m).map_err(|_| invalid())?;
        }
    }
    let profit = if missing == 0 && refunds == MoneyCents::ZERO {
        Some(
            totals[0]
                .checked_sub(totals[1])
                .and_then(|n| n.checked_sub(costs))
                .and_then(|n| n.checked_sub(expense))
                .map_err(|_| invalid())?
                .to_dto(),
        )
    } else {
        None
    };
    Ok(
        json!({"fromMs":from,"toMs":to,"coverage":"LOCAL_NATIVE_ONLY","salesCount":count.to_string(),"totalCents":totals[0].to_dto(),"itbisCents":totals[1].to_dto(),"discountCents":totals[2].to_dto(),"creditCents":credit.to_dto(),"expenseCents":expense.to_dto(),"creditPaymentsCents":abono.to_dto(),"refundCents":refunds.to_dto(),"serviceDepositRefundCents":service_refunds.to_dto(),"netSalesCents":totals[0].checked_sub(refunds).map_err(|_|invalid())?.to_dto(),"paymentMethods":methods.into_iter().map(|(k,v)|(k,v.to_dto())).collect::<std::collections::BTreeMap<_,_>>(),"salesWithUnknownCost":missing.to_string(),"profitCents":profit,"profitEvidence":if refunds!=MoneyCents::ZERO{"RETURNS_COST_ALLOCATION_PENDING"}else if missing==0{"FROZEN_SALE_COSTS_LESS_TAX_AND_EXPENSES"}else{"COST_UNAVAILABLE"},"fiscalEvidence":"NOT_CERTIFIED"}),
    )
}
fn snapshot_cost(v: &Value) -> Result<MoneyCents, AppError> {
    use crate::domain::quantity::Ratio;
    use num_traits::ToPrimitive;
    let mut cost = Ratio::zero();
    let lines = v["sale"]["lines"]
        .as_array()
        .filter(|ls| !ls.is_empty())
        .ok_or_else(invalid)?;
    for line in lines {
        let cents = nonnegative(s(&line["costCents"])?)?;
        let quantity = Ratio::parse_canonical(
            s(&line["quantity"]["numerator"])?,
            s(&line["quantity"]["denominator"])?,
        )
        .map_err(|_| invalid())?;
        let value = Ratio::from_integer(cents as u64)
            .checked_mul(&quantity)
            .map_err(|_| invalid())?;
        cost = cost.checked_add(&value).map_err(|_| invalid())?;
    }
    MoneyCents::from_cents(
        cost.to_exact_integer()
            .map_err(|_| invalid())?
            .to_i64()
            .ok_or_else(invalid)?,
    )
    .map_err(|_| invalid())
}
