//! Complete native local sale. Reads authoritative native facts, never renderer
//! stock/tax/credit. A commercial caller must have provisioned operational data
//! and writer ownership; catalogue previews alone cannot satisfy these gates.
use super::{
    checkout,
    errors::{AppError, BusinessError, ProtocolError},
    operations::execute_prepared_operation,
    ticket_sequence::issue_ticket_in,
};
use crate::{
    domain::{
        canonical::canonicalize,
        identity::{EntityId, Scope, TenantRef},
        money::MoneyCents,
        quantity::Ratio,
        sale_inventory::{
            InventoryLine, InventoryProduct, RecipePart, SerialAvailability, StockAuthority,
        },
        sale_payment::{CreditContext, Payment, PaymentTurn},
        sale_plan::{
            plan_sale, HistoricalCustomer, SaleProductFacts, SaleSelection, ValidatedSale,
        },
        sale_quote::{quote_snapshot, Discount, HistoricalQuoteLine},
    },
    fiscal::reservations::{consume_in, NcfKind},
    security::offline_grant::VerifiedGrant,
    storage::catalogue_preview::{self, CatalogueContext},
};
use rusqlite::{Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaleLine {
    pub product_id: String,
    pub quantity: String,
    pub revision: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub free: Option<FreeLine>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FreeLine {
    pub name: String,
    pub unit_price_cents: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "method",
    rename_all = "SCREAMING_SNAKE_CASE",
    deny_unknown_fields
)]
pub enum SalePayment {
    Cash {
        #[serde(rename = "tenderCents")]
        tender_cents: String,
    },
    Card,
    Transfer,
    Mixed {
        #[serde(rename = "cashCents")]
        cash_cents: String,
        #[serde(rename = "transferCents")]
        transfer_cents: String,
        #[serde(rename = "tenderCents")]
        tender_cents: String,
    },
    Credit {
        #[serde(rename = "customerId")]
        customer_id: String,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaleOptions {
    pub payment: SalePayment,
    pub discount_cents: String,
    #[serde(default)]
    pub serials: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub customer: Option<SaleCustomer>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub discount_percent_basis_points: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub warranty_days: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "SCREAMING_SNAKE_CASE", deny_unknown_fields)]
pub enum SaleCustomer {
    Registered { id: String },
    Named { name: String },
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaleRequest {
    pub operation_id: String,
    pub cart_id: String,
    pub expected_cart_revision: String,
    pub accepted_quote_hash: String,
    pub lines: Vec<SaleLine>,
    pub options: SaleOptions,
    pub fiscal_type: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SaleResult {
    pub operation_id: String,
    pub hash: String,
    pub ticket: String,
    pub total_cents: String,
    pub itbis_cents: String,
    pub discount_cents: String,
    pub change_cents: String,
    pub payment_method: String,
    pub ncf: Option<String>,
    pub remote_status: String,
    pub print_status: String,
    pub snapshot_hash: String,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaleQuote {
    pub subtotal_cents: String,
    pub itbis_cents: String,
    pub total_cents: String,
    pub discount_cents: String,
    pub change_cents: Option<String>,
    pub payable: bool,
    pub quote_hash: Option<String>,
    pub limits: Vec<String>,
    pub line_totals: Vec<Value>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomerView {
    pub id: String,
    pub name: String,
    pub balance_cents: String,
    pub limit_cents: Option<String>,
}
fn invalid() -> AppError {
    AppError::Protocol(ProtocolError::MalformedPayload)
}
fn guard(code: &str) -> AppError {
    AppError::Business(BusinessError::SaleGuard { code: code.into() })
}
fn entity(s: &str) -> Result<EntityId, AppError> {
    EntityId::parse(s).map_err(|_| invalid())
}
fn money(s: &str) -> Result<MoneyCents, AppError> {
    MoneyCents::parse_dto(s)
        .and_then(MoneyCents::require_non_negative)
        .map_err(|_| invalid())
}
fn num(v: &Value) -> Result<MoneyCents, AppError> {
    money(v.as_str().ok_or_else(invalid)?)
}
fn discount(opts: &SaleOptions) -> Result<Discount, AppError> {
    match &opts.discount_percent_basis_points {
        None => Ok(Discount::Amount(money(&opts.discount_cents)?)),
        Some(p) => {
            let n = money(p)?.cents();
            if n > 10000 || opts.discount_cents != "0" {
                return Err(invalid());
            }
            Ok(Discount::Percent(
                Ratio::from_parts((n as u64).into(), 100u64.into()).map_err(|_| invalid())?,
            ))
        }
    }
}
fn customer_pricing(
    c: &Connection,
    ctx: &CatalogueContext,
    opts: &SaleOptions,
) -> Result<Option<Value>, AppError> {
    let id = match &opts.customer {
        Some(SaleCustomer::Registered { id }) => Some(id.as_str()),
        _ => match &opts.payment {
            SalePayment::Credit { customer_id } => Some(customer_id.as_str()),
            _ => None,
        },
    };
    let Some(id) = id else { return Ok(None) };
    let tier:Option<u32>=c.query_row("SELECT tier FROM native_sales_customer_pricing_v1 WHERE customer_id=?1 AND tenant_id=?2",(id,&ctx.tenant_id),|r|r.get(0)).optional()?;
    match tier {
        Some(t) => Ok(Some(
            json!({"source":"CUSTOMER","customerId":id,"tier":t.to_string()}),
        )),
        None if super::sales_sync::operational(c, ctx)? => Err(guard("LEGACY_NOT_VERIFIABLE")),
        None => Ok(None),
    }
}
fn ratio(v: &Value) -> Result<Ratio, AppError> {
    let n = v["numerator"].as_str().ok_or_else(invalid)?;
    let d = v["denominator"].as_str().ok_or_else(invalid)?;
    Ratio::from_parts(
        n.parse().map_err(|_| invalid())?,
        d.parse().map_err(|_| invalid())?,
    )
    .map_err(|_| invalid())
}
pub fn scope_key(ctx: &CatalogueContext) -> Result<String, AppError> {
    catalogue_preview::key(ctx).map_err(|_| invalid())?;
    Ok(format!(
        "{}/{}",
        ctx.tenant_id,
        if ctx.scope_type == "GLOBAL" {
            "GLOBAL".into()
        } else {
            format!("BRANCH:{}", ctx.branch_id.as_deref().ok_or_else(invalid)?)
        }
    ))
}
fn scope(ctx: &CatalogueContext) -> Result<Scope, AppError> {
    Scope::parse_command(Some(&ctx.scope_type), ctx.branch_id.as_deref()).map_err(|_| invalid())
}
pub(crate) fn effect_id(operation: &str, part: &str) -> String {
    let digest = Sha256::digest(format!("ventard.local-effect.v1/{operation}/{part}"));
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes[6] = (bytes[6] & 15) | 0x80;
    bytes[8] = (bytes[8] & 63) | 0x80;
    uuid::Uuid::from_bytes(bytes).to_string()
}
pub(crate) fn stock(
    c: &Connection,
    product: &str,
    key: &str,
) -> Result<(i32, String, String), AppError> {
    let row:Option<(String,i64,String,String)>=c.query_row("SELECT effective_stock,remote_seq,pending_coverage,authority_state FROM stock_projections WHERE producto_id=?1 AND scope_key=?2",(product,key),|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
    let (qty, seq, pending, state) = row.ok_or_else(|| guard("STOCK_UNVERIFIED"))?;
    if state != "VERIFIED" || seq < 0 {
        return Err(guard("STOCK_UNVERIFIED"));
    }
    let amount = qty.parse::<i32>().map_err(|_| invalid())?;
    if amount < 0 || amount.to_string() != qty {
        return Err(invalid());
    }
    let coverage: Value = serde_json::from_str(&pending).map_err(|_| invalid())?;
    if !coverage.is_array() {
        return Err(guard("STOCK_UNVERIFIED"));
    }
    let (_, revision) = canonicalize(
        &serde_json::to_vec(
            &json!({"quantity":qty,"remoteSequence":seq.to_string(),"pending":coverage}),
        )
        .map_err(|_| invalid())?,
    )
    .map_err(|_| invalid())?;
    Ok((amount, revision, pending))
}
type NativeSaleFacts = (
    Vec<SaleSelection>,
    Vec<SaleProductFacts>,
    Vec<SerialAvailability>,
);
fn facts(
    c: &Connection,
    ctx: &CatalogueContext,
    lines: &[SaleLine],
    opts: &SaleOptions,
) -> Result<NativeSaleFacts, AppError> {
    if lines.is_empty() || lines.len() > 100 || opts.serials.len() > 100 {
        return Err(invalid());
    }
    let key = scope_key(ctx)?;
    let scope = scope(ctx)?;
    let tenant = entity(&ctx.tenant_id)?;
    let pricing = customer_pricing(c, ctx, opts)?;
    let mut ids = Vec::new();
    let mut seen = HashSet::new();
    let mut selections = Vec::new();
    for l in lines {
        let id = entity(&l.product_id)?;
        let q = l.quantity.parse::<i32>().map_err(|_| invalid())?;
        if q <= 0 || q.to_string() != l.quantity || !seen.insert(l.product_id.clone()) {
            return Err(invalid());
        }
        if let Some(free) = &l.free {
            if opts.serials.contains_key(&l.product_id) {
                return Err(invalid());
            }
            let rate:Option<String>=c.query_row("SELECT tax_rate FROM sale_free_settings_v1 WHERE tenant_id=?1 AND scope_key=?2",(&ctx.tenant_id,&key),|r|r.get(0)).optional()?;
            let rate: Value =
                serde_json::from_str(&rate.ok_or_else(|| guard("LEGACY_NOT_VERIFIABLE"))?)
                    .map_err(|_| invalid())?;
            selections.push(SaleSelection::Free(HistoricalQuoteLine {
                product_id: None,
                product_revision: None,
                name: free.name.clone(),
                unit_price: money(&free.unit_price_cents)?,
                quantity: Ratio::from_integer(q as u64),
                tax_rate: ratio(&rate)?,
                cost: None,
                recipe: vec![],
                serial: None,
            }));
            continue;
        }
        ids.push(l.product_id.clone());
        selections.push(SaleSelection::Product(InventoryLine {
            product_id: id,
            quantity: Ratio::from_integer(q as u64),
            expected_revision: l.revision.clone(),
            serial: opts.serials.get(&l.product_id).cloned(),
        }));
    }
    if opts.serials.keys().any(|k| !seen.contains(k)) {
        return Err(invalid());
    }
    let mut facts = Vec::new();
    let mut loaded = HashSet::new();
    let mut index = 0;
    while index < ids.len() {
        let id = ids[index].clone();
        index += 1;
        if !loaded.insert(id.clone()) {
            continue;
        }
        if loaded.len() > 1000 {
            return Err(invalid());
        }
        let row:Option<(String,i64,String,String,String,bool)>=c.query_row("SELECT tenant_id,revision,name,price_tiers,metadata,tombstone FROM products WHERE producto_id=?1",[&id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).optional()?;
        let (owner, revision, name, prices, metadata, deleted) =
            row.ok_or_else(|| guard("STOCK_UNVERIFIED"))?;
        if owner != ctx.tenant_id {
            return Err(guard("PERMISSION_DENIED"));
        }
        let prices: Value = serde_json::from_str(&prices).map_err(|_| invalid())?;
        let meta: Value = serde_json::from_str(&metadata).map_err(|_| invalid())?;
        if lines
            .iter()
            .any(|line| line.free.is_none() && line.product_id == id)
            && meta["productType"] == "insumo"
        {
            return Err(guard("PRODUCT_NOT_SELLABLE"));
        }
        let recipe = meta["recipe"]
            .as_array()
            .ok_or_else(invalid)?
            .iter()
            .map(|r| {
                let pid = r["productId"].as_str().ok_or_else(invalid)?.to_owned();
                ids.push(pid.clone());
                Ok(RecipePart {
                    product_id: entity(&pid)?,
                    per_unit: ratio(&r["perUnit"])?,
                })
            })
            .collect::<Result<Vec<_>, AppError>>()?;
        let (available, stock_revision, _) = stock(c, &id, &key)?;
        facts.push(SaleProductFacts {
            inventory: InventoryProduct {
                reference: TenantRef {
                    negocio_id: tenant,
                    id: entity(&id)?,
                },
                scope,
                revision: revision.to_string(),
                deleted,
                serial_required: meta["serialRequired"].as_bool().ok_or_else(invalid)?,
                recipe,
                authority: Some(StockAuthority {
                    available,
                    revision: stock_revision,
                    verified: true,
                }),
            },
            name,
            unit_price: {
                let selected = match pricing.as_ref().and_then(|p| p["tier"].as_str()) {
                    Some("2") => &prices["tier2Cents"],
                    Some("3") => &prices["tier3Cents"],
                    _ => &prices["retailCents"],
                };
                if selected.is_null() || selected.as_str() == Some("0") {
                    num(&prices["retailCents"])?
                } else {
                    num(selected)?
                }
            },
            tax_rate: ratio(&meta["taxRate"])?,
            cost: super::inventory::cost(c, ctx, &id)?,
        });
    }
    let mut serials = Vec::new();
    for (pid, text) in &opts.serials {
        let row:Option<(String,String)>=c.query_row("SELECT state,revision FROM sale_serial_inventory_v1 WHERE tenant_id=?1 AND scope_key=?2 AND producto_id=?3 AND serial=?4",(&ctx.tenant_id,&key,pid,text),|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
        if let Some((state, revision)) = row {
            serials.push(SerialAvailability {
                text: text.clone(),
                product_id: entity(pid)?,
                tenant_id: tenant,
                scope,
                available: state == "AVAILABLE",
                revision,
            });
        }
    }
    Ok((selections, facts, serials))
}
fn payment(input: &SalePayment) -> Result<Payment, AppError> {
    Ok(match input {
        SalePayment::Cash { tender_cents } => Payment::Cash {
            tender: money(tender_cents)?,
        },
        SalePayment::Card => Payment::Card,
        SalePayment::Transfer => Payment::Transfer,
        SalePayment::Mixed {
            cash_cents,
            transfer_cents,
            tender_cents,
        } => Payment::Mixed {
            cash: money(cash_cents)?,
            transfer: money(transfer_cents)?,
            tender: money(tender_cents)?,
        },
        SalePayment::Credit { customer_id } => Payment::Credit {
            customer_id: entity(customer_id)?,
        },
    })
}
fn turn(c: &Connection, ctx: &CatalogueContext) -> Result<Option<PaymentTurn>, AppError> {
    let key = scope_key(ctx)?;
    let id: Option<String> = c
        .query_row(
            "SELECT turn_id FROM cash_turns WHERE tenant_id=?1 AND scope_key=?2 AND status='OPEN'",
            (&ctx.tenant_id, key),
            |r| r.get(0),
        )
        .optional()?;
    if super::sales_sync::operational(c, ctx)? {
        if let Some(turn_id) = &id {
            let accepted:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM native_sales_receipts_v1 WHERE operation_id=?1 AND tenant_id=?2 AND scope_key=?3)",(turn_id,&ctx.tenant_id,scope_key(ctx)?),|r|r.get(0))?;
            if !accepted {
                return Ok(None);
            }
        }
    }
    id.map(|id| {
        Ok(PaymentTurn {
            id: entity(&id)?,
            tenant_id: entity(&ctx.tenant_id)?,
            scope: scope(ctx)?,
            open: true,
        })
    })
    .transpose()
}
fn credit(
    c: &Connection,
    ctx: &CatalogueContext,
    p: &SalePayment,
) -> Result<Option<CreditContext>, AppError> {
    let SalePayment::Credit { customer_id } = p else {
        return Ok(None);
    };
    let row:Option<(String,String,i64,Option<i64>,bool,String)>=c.query_row("SELECT tenant_id,scope_key,balance_cents,limit_cents,active,authority_state FROM sale_customer_accounts_v1 WHERE customer_id=?1",[customer_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).optional()?;
    let Some((tenant, key, balance, limit, active, state)) = row else {
        return Err(guard("LEGACY_NOT_VERIFIABLE"));
    };
    let account_scope = if key == format!("{}/GLOBAL", ctx.tenant_id) {
        Scope::Global
    } else if key == scope_key(ctx)? {
        scope(ctx)?
    } else {
        return Err(guard("PERMISSION_DENIED"));
    };
    Ok(Some(CreditContext {
        customer_id: entity(customer_id)?,
        tenant_id: entity(&tenant)?,
        scope: account_scope,
        balance: MoneyCents::from_cents(balance).map_err(|_| invalid())?,
        limit: limit
            .map(MoneyCents::from_cents)
            .transpose()
            .map_err(|_| invalid())?,
        active,
        verified: state == "VERIFIED",
    }))
}
fn plan(
    c: &Connection,
    ctx: &CatalogueContext,
    lines: &[SaleLine],
    opts: &SaleOptions,
) -> Result<ValidatedSale, AppError> {
    let (lines, products, serials) = facts(c, ctx, lines, opts)?;
    let planned = plan_sale(
        entity(&ctx.tenant_id)?,
        scope(ctx)?,
        &lines,
        &products,
        &serials,
        &discount(opts)?,
        &payment(&opts.payment)?,
        turn(c, ctx)?.as_ref(),
        credit(c, ctx, &opts.payment)?.as_ref(),
    )
    .map_err(|e| guard(e.code()))?;
    let planned = if let Some(policy) = customer_pricing(c, ctx, opts)? {
        planned
            .with_price_policy(policy)
            .map_err(|e| guard(e.code()))?
    } else {
        planned
    };
    let planned = if super::sales_sync::operational(c, ctx)? {
        let key = scope_key(ctx)?;
        let mut evidence = vec![];
        for e in planned.payload()["inventory"]
            .as_array()
            .ok_or_else(invalid)?
        {
            let pid = e["productId"].as_str().ok_or_else(invalid)?;
            let(base,seq,pending,effective):(String,i64,String,String)=c.query_row("SELECT remote_base_qty,remote_seq,pending_coverage,effective_stock FROM stock_projections WHERE producto_id=?1 AND scope_key=?2",(pid,&key),|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)))?;
            let pending: Value = serde_json::from_str(&pending).map_err(|_| invalid())?;
            evidence.push(json!({"productId":pid,"remoteBaseQty":base,"remoteSequence":seq.to_string(),"pending":pending,"effectiveQty":effective}));
        }
        planned
            .with_stock_evidence(evidence)
            .map_err(|e| guard(e.code()))?
    } else {
        planned
    };
    let planned = if let Some(days) = &opts.warranty_days {
        planned
            .with_warranty_days(days)
            .map_err(|e| guard(e.code()))?
    } else {
        planned
    };
    match customer(c, ctx, opts)? {
        Some(customer) => planned.with_customer(customer).map_err(|e| guard(e.code())),
        None => Ok(planned),
    }
}
fn customer(
    c: &Connection,
    ctx: &CatalogueContext,
    opts: &SaleOptions,
) -> Result<Option<HistoricalCustomer>, AppError> {
    let Some(choice) = &opts.customer else {
        return Ok(None);
    };
    match choice {
        SaleCustomer::Named { name } => {
            if matches!(opts.payment, SalePayment::Credit { .. })
                || name.trim() != name
                || name.chars().count() > 256
                || name.trim().is_empty()
                || name.chars().any(char::is_control)
            {
                return Err(invalid());
            }
            Ok(Some(HistoricalCustomer {
                id: None,
                name: name.clone(),
                revision: None,
            }))
        }
        SaleCustomer::Registered { id } => {
            let entity_id = entity(id)?;
            if matches!(&opts.payment,SalePayment::Credit{customer_id} if customer_id!=id) {
                return Err(invalid());
            }
            // Metadata and debt evolve independently; payments never rename a recipient.
            let row:Option<(String,i64)>=c.query_row("SELECT name,coalesce((SELECT m.revision FROM native_customer_metadata_v1 m WHERE m.customer_id=a.customer_id AND m.tenant_id=a.tenant_id),CASE WHEN EXISTS(SELECT 1 FROM native_sales_customer_pricing_v1 p WHERE p.customer_id=a.customer_id AND p.tenant_id=a.tenant_id) THEN 1 ELSE revision END) FROM sale_customer_accounts_v1 a WHERE customer_id=?1 AND tenant_id=?2 AND active=1 AND scope_key IN(?3,?4)",(id,&ctx.tenant_id,scope_key(ctx)?,format!("{}/GLOBAL",ctx.tenant_id)),|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
            let (name, revision) = row.ok_or_else(|| guard("LEGACY_NOT_VERIFIABLE"))?;
            if revision <= 0 {
                return Err(invalid());
            }
            Ok(Some(HistoricalCustomer {
                id: Some(entity_id),
                name,
                revision: Some(revision.to_string()),
            }))
        }
    }
}
pub fn quote(
    c: &Connection,
    ctx: &CatalogueContext,
    lines: &[SaleLine],
    opts: &SaleOptions,
) -> Result<SaleQuote, AppError> {
    if lines.is_empty() {
        return Ok(SaleQuote {
            subtotal_cents: "0".into(),
            itbis_cents: "0".into(),
            total_cents: "0".into(),
            discount_cents: "0".into(),
            change_cents: None,
            payable: false,
            quote_hash: None,
            limits: vec![],
            line_totals: vec![],
        });
    }
    let (selection, products, _) = facts(c, ctx, lines, opts)?;
    let by_id: HashMap<_, _> = products
        .iter()
        .map(|p| (p.inventory.reference.id, p))
        .collect();
    let mut history = Vec::new();
    let mut line_totals = Vec::new();
    for (input, selection) in lines.iter().zip(selection) {
        let historical = match selection {
            SaleSelection::Free(f) => f,
            SaleSelection::Product(l) => {
                let p = by_id.get(&l.product_id).ok_or_else(invalid)?;
                HistoricalQuoteLine {
                    product_id: Some(l.product_id),
                    product_revision: Some(p.inventory.revision.clone()),
                    name: p.name.clone(),
                    unit_price: p.unit_price,
                    quantity: l.quantity.clone(),
                    tax_rate: p.tax_rate.clone(),
                    cost: p.cost,
                    recipe: vec![],
                    serial: l.serial,
                }
            }
        };
        let n = historical
            .quantity
            .numerator()
            .to_string()
            .parse::<i64>()
            .map_err(|_| invalid())?;
        line_totals.push(json!({"productId":input.product_id,"unitPriceCents":historical.unit_price.to_string(),"subtotalCents":MoneyCents::from_i128(i128::from(historical.unit_price.cents())*i128::from(n)).map_err(|_|invalid())?.to_string()}));
        history.push(historical);
    }
    let totals = quote_snapshot(&history, &discount(opts)?)
        .map_err(|_| invalid())?
        .totals;
    let (hash, change, limits) = match plan(c, ctx, lines, opts) {
        Ok(p) => (
            Some(p.quote_hash().into()),
            Some(
                p.payload()["payment"]["changeCents"]
                    .as_str()
                    .ok_or_else(invalid)?
                    .into(),
            ),
            vec![],
        ),
        Err(e) => (None, None, vec![e.code().into()]),
    };
    Ok(SaleQuote {
        subtotal_cents: totals.subtotal.to_string(),
        itbis_cents: totals.itbis.to_string(),
        total_cents: totals.total.to_string(),
        discount_cents: totals.discount.to_string(),
        change_cents: change,
        payable: hash.is_some(),
        quote_hash: hash,
        limits,
        line_totals,
    })
}
pub fn customers(c: &Connection, ctx: &CatalogueContext) -> Result<Vec<CustomerView>, AppError> {
    let mut q=c.prepare("SELECT customer_id,name,balance_cents,limit_cents FROM sale_customer_accounts_v1 WHERE tenant_id=?1 AND active=1 AND authority_state='VERIFIED' AND scope_key IN(?2,?3) ORDER BY name,customer_id LIMIT 200")?;
    let rows = q
        .query_map(
            (
                &ctx.tenant_id,
                scope_key(ctx)?,
                format!("{}/GLOBAL", ctx.tenant_id),
            ),
            |r| {
                Ok(CustomerView {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    balance_cents: r.get::<_, i64>(2)?.to_string(),
                    limit_cents: r.get::<_, Option<i64>>(3)?.map(|n| n.to_string()),
                })
            },
        )?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}
pub fn confirm(
    c: &mut Connection,
    g: &VerifiedGrant,
    now: u64,
    high: u64,
    opens: u64,
    req: SaleRequest,
) -> Result<SaleResult, AppError> {
    confirm_with(c, g, now, high, opens, req, |_, _| Ok(()))
}
#[allow(clippy::too_many_arguments)]
pub(crate) fn confirm_with(
    c: &mut Connection,
    g: &VerifiedGrant,
    now: u64,
    high: u64,
    opens: u64,
    req: SaleRequest,
    after: impl FnOnce(&Transaction<'_>, &SaleResult) -> Result<(), AppError>,
) -> Result<SaleResult, AppError> {
    checkout::permitted(g, now, high, opens, "SELL")?;
    let ctx = checkout::context(g);
    entity(&req.operation_id)?;
    let wire = serde_json::to_value(&req).map_err(|_| invalid())?;
    let old: Option<String> = c
        .query_row(
            "SELECT hash FROM operation_journal WHERE operation_id=?1",
            [&req.operation_id],
            |r| r.get(0),
        )
        .optional()?;
    let prepared = if let Some(h) = old {
        let v = checkout::load(c, &ctx, &req.operation_id, &h)?;
        if v.intent["payload"]["request"] != wire {
            return Err(AppError::Protocol(ProtocolError::OperationIdConflict));
        }
        v
    } else {
        let sale = plan(c, &ctx, &req.lines, &req.options)?;
        let kind = match req.fiscal_type.as_deref() {
            None => None,
            Some("B01") => Some(NcfKind::B01),
            Some("B02") => Some(NcfKind::B02),
            _ => return Err(invalid()),
        };
        checkout::prepare_with_request(
            c,
            g,
            now,
            high,
            opens,
            checkout::CheckoutPrepare {
                operation_id: req.operation_id.clone(),
                cart_id: req.cart_id.clone(),
                expected_revision: req.expected_cart_revision.clone(),
                accepted_quote_hash: req.accepted_quote_hash.clone(),
                fiscal_type: kind,
            },
            &sale,
            Some(wire),
        )?
    };
    if prepared.state == "COMMITTED" {
        return serde_json::from_value(prepared.result.ok_or_else(invalid)?).map_err(|_| invalid());
    }
    if prepared.state != "PREPARED" {
        return Err(AppError::Business(BusinessError::OperationAbandoned));
    }
    let hash = prepared.hash.clone();
    let op = req.operation_id.clone();
    let value = execute_prepared_operation(c, &op, &hash, |tx| {
        let view = checkout::load(tx, &ctx, &op, &hash)?;
        let active:i64=tx.query_row("SELECT count(*) FROM vault_meta v,installations i WHERE v.negocio_id=?1 AND v.activation_state='ACTIVE' AND i.installation_id=?2 AND i.device_id=?3 AND i.writer_epoch=?4 AND i.status='ACTIVE'",(&ctx.tenant_id,&ctx.installation_id,&ctx.device_id,&ctx.writer_epoch),|r|r.get(0))?;
        if active != 1 {
            return Err(guard("PERMISSION_DENIED"));
        }
        let current = plan(tx, &ctx, &req.lines, &req.options)?;
        let mut sale = current.payload();
        sale["fiscal"] = view.intent["payload"]["sale"]["fiscal"].clone();
        if sale != view.intent["payload"]["sale"] || current.quote_hash() != req.accepted_quote_hash
        {
            return Err(guard("VERSION_CONFLICT"));
        }
        let result = apply(tx, &ctx, &req, &view.intent, &hash)?;
        after(tx, &result)?;
        serde_json::to_value(result).map_err(|_| invalid())
    })?;
    serde_json::from_value(value).map_err(|_| invalid())
}
fn apply(
    tx: &Transaction<'_>,
    ctx: &CatalogueContext,
    req: &SaleRequest,
    intent: &Value,
    hash: &str,
) -> Result<SaleResult, AppError> {
    let op = &req.operation_id;
    let key = scope_key(ctx)?;
    let sale = &intent["payload"]["sale"];
    let totals = &sale["totals"];
    let pay = &sale["payment"];
    let ticket = issue_ticket_in(tx, ctx, op, hash)?;
    let turn = pay["turnId"].as_str();
    let ncf = sale["fiscal"]["ncf"].as_str();
    tx.execute(
        "INSERT INTO sales VALUES(?1,?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
        (
            op,
            &ctx.tenant_id,
            &key,
            turn,
            &ticket,
            ncf,
            &ctx.actor_id,
            num(&totals["totalCents"])?.cents(),
            num(&totals["itbisCents"])?.cents(),
            num(&totals["discountCents"])?.cents(),
            sale["calculationVersion"].as_str().ok_or_else(invalid)?,
            intent["originAtUtcMs"].as_str().ok_or_else(invalid)?,
        ),
    )?;
    for (i, line) in sale["lines"]
        .as_array()
        .ok_or_else(invalid)?
        .iter()
        .enumerate()
    {
        tx.execute(
            "INSERT INTO sale_lines VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            (
                effect_id(op, &format!("line/{i}")),
                op,
                line["productId"].as_str(),
                line["name"].as_str().ok_or_else(invalid)?,
                num(&line["unitPriceCents"])?.cents(),
                line["taxRate"].to_string(),
                line["recipe"].to_string(),
                if line["costCents"].is_null() {
                    None
                } else {
                    Some(num(&line["costCents"])?.cents())
                },
                line["quantity"].to_string(),
                line["serial"].as_str(),
            ),
        )?;
    }
    for effect in sale["inventory"].as_array().ok_or_else(invalid)? {
        let product = effect["productId"].as_str().ok_or_else(invalid)?;
        let delta = effect["delta"]
            .as_str()
            .ok_or_else(invalid)?
            .parse::<i32>()
            .map_err(|_| invalid())?;
        let (before, revision, pending) = stock(tx, product, &key)?;
        if effect["expectedRevision"] != revision {
            return Err(guard("VERSION_CONFLICT"));
        }
        let after = before
            .checked_add(delta)
            .filter(|n| *n >= 0)
            .ok_or_else(|| guard("STOCK_UNAVAILABLE"))?;
        let eid = effect_id(op, &format!("stock/{product}"));
        tx.execute(
            "INSERT INTO inventory_movements VALUES(?1,?2,?3,?4,'SALE',?5,NULL,NULL,NULL)",
            (&eid, op, product, &key, delta.to_string()),
        )?;
        let mut pending: Vec<Value> = serde_json::from_str(&pending).map_err(|_| invalid())?;
        pending.push(json!({"operationId":op,"effectId":eid,"delta":delta.to_string()}));
        tx.execute("UPDATE stock_projections SET effective_stock=?3,pending_coverage=?4 WHERE producto_id=?1 AND scope_key=?2",(product,&key,after.to_string(),serde_json::to_string(&pending).map_err(|_|invalid())?))?;
    }
    for serial in sale["serials"].as_array().ok_or_else(invalid)? {
        let changed=tx.execute("UPDATE sale_serial_inventory_v1 SET state='SOLD',sale_operation_id=?5 WHERE tenant_id=?1 AND scope_key=?2 AND producto_id=?3 AND serial=?4 AND revision=?6 AND state='AVAILABLE'",(&ctx.tenant_id,&key,serial["productId"].as_str(),serial["text"].as_str(),op,serial["expectedRevision"].as_str()))?;
        if changed != 1 {
            return Err(guard("SERIAL_CONFLICT"));
        }
    }
    let method = pay["method"].as_str().ok_or_else(invalid)?;
    if method == "FIADO" {
        let customer = pay["customerId"].as_str().ok_or_else(invalid)?;
        let before:i64=tx.query_row("SELECT balance_cents FROM sale_customer_accounts_v1 WHERE customer_id=?1 AND tenant_id=?2",(customer,&ctx.tenant_id),|r|r.get(0))?;
        let charge = num(&pay["creditChargeCents"])?;
        let after = MoneyCents::from_cents(before)
            .map_err(|_| invalid())?
            .checked_add(charge)
            .map_err(|_| invalid())?;
        tx.execute(
            "INSERT INTO sale_credit_entries_v1 VALUES(?1,?2,?3,?4,?5,?6,?7)",
            (
                op,
                customer,
                &ctx.tenant_id,
                &key,
                charge.cents(),
                before,
                after.cents(),
            ),
        )?;
        tx.execute("UPDATE sale_customer_accounts_v1 SET balance_cents=?2,revision=revision+1 WHERE customer_id=?1",(customer,after.cents()))?;
    } else {
        let legs = match method {
            "EFECTIVO" => vec![(
                "EFECTIVO",
                num(&pay["cashNetCents"])?,
                num(&pay["tenderCents"])?,
                num(&pay["changeCents"])?,
            )],
            "TARJETA" => vec![(
                "TARJETA",
                num(&pay["cardCents"])?,
                MoneyCents::ZERO,
                MoneyCents::ZERO,
            )],
            "TRANSFERENCIA" => vec![(
                "TRANSFERENCIA",
                num(&pay["transferCents"])?,
                MoneyCents::ZERO,
                MoneyCents::ZERO,
            )],
            "MIXTO" => vec![
                (
                    "EFECTIVO",
                    num(&pay["cashNetCents"])?,
                    num(&pay["tenderCents"])?,
                    num(&pay["changeCents"])?,
                ),
                (
                    "TRANSFERENCIA",
                    num(&pay["transferCents"])?,
                    MoneyCents::ZERO,
                    MoneyCents::ZERO,
                ),
            ],
            _ => return Err(invalid()),
        };
        for (leg, amount, tender, change) in legs {
            tx.execute(
                "INSERT INTO payments VALUES(?1,?2,?2,NULL,?3,?4,?5,?6,?7)",
                (
                    effect_id(op, &format!("payment/{leg}")),
                    op,
                    leg,
                    amount.cents(),
                    tender.cents(),
                    change.cents(),
                    turn,
                ),
            )?;
        }
    }
    if matches!(method, "EFECTIVO" | "MIXTO") {
        tx.execute(
            "INSERT INTO sale_cash_entries_v1 VALUES(?1,?2,?3,?4,?5)",
            (
                op,
                turn.ok_or_else(|| guard("TURN_REQUIRED"))?,
                &ctx.tenant_id,
                &key,
                num(&pay["cashNetCents"])?.cents(),
            ),
        )?;
    }
    if !sale["fiscal"].is_null() {
        consume_in(tx, ctx, op, hash)?;
    }
    let customer_name: Option<String> = if let Some(name) = sale["customer"]["name"].as_str() {
        Some(name.into())
    } else if let Some(id) = pay["customerId"].as_str() {
        tx.query_row(
            "SELECT name FROM sale_customer_accounts_v1 WHERE customer_id=?1 AND tenant_id=?2",
            (id, &ctx.tenant_id),
            |r| r.get(0),
        )
        .optional()?
    } else {
        None
    };
    let mut snapshot = json!({"version":"ventard.ticket.snapshot.1","operationId":op,"tenantId":ctx.tenant_id,"scope":{"type":ctx.scope_type,"branchId":ctx.branch_id},"ticket":ticket,"ncf":ncf,"actorId":ctx.actor_id,"originAtUtcMs":intent["originAtUtcMs"],"customerName":customer_name,"sale":sale});
    let profile: Option<String> = tx
        .query_row(
            "SELECT profile FROM native_business_profile_v1 WHERE tenant_id=?1",
            [&ctx.tenant_id],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(raw) = profile {
        snapshot["business"] = serde_json::from_str(&raw).map_err(|_| invalid())?;
    }
    let (bytes, snapshot_hash) =
        canonicalize(&serde_json::to_vec(&snapshot).map_err(|_| invalid())?)
            .map_err(|_| invalid())?;
    tx.execute(
        "INSERT INTO sale_ticket_snapshots_v1 VALUES(?1,?2,?3)",
        (op, bytes.as_bytes(), &snapshot_hash),
    )?;
    let printing:Option<(bool,Option<String>)>=tx.query_row("SELECT auto_print,printer_profile_id FROM sale_print_settings_v1 WHERE tenant_id=?1 AND installation_id=?2",(&ctx.tenant_id,&ctx.installation_id),|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
    let print_status = if let Some((true, profile)) = printing {
        let state = if profile.is_some() {
            "QUEUED"
        } else {
            "WAITING_CONFIGURATION"
        };
        tx.execute(
            "INSERT INTO sale_print_jobs_v1 VALUES(?1,?2,?3,?4,?5)",
            (
                effect_id(op, "print/initial"),
                op,
                &snapshot_hash,
                profile,
                state,
            ),
        )?;
        state
    } else {
        "NOT_REQUESTED"
    };
    let context_key = catalogue_preview::key(ctx).map_err(|_| invalid())?;
    tx.execute(
        "INSERT INTO sale_cart_consumptions_v1 VALUES(?1,?2,?3,?4)",
        (op, &context_key, &req.cart_id, &req.expected_cart_revision),
    )?;
    // Old draft state is an inactive tombstone; explicit consumption above records
    // that it was sold, NOT discarded by the user. Original lines remain intact.
    let updated=tx.execute("UPDATE account_drafts SET status='DISCARDED',revision=revision+1 WHERE context_key=?1 AND id=?2 AND revision=?3 AND status='ACTIVE'",(&context_key,&req.cart_id,&req.expected_cart_revision))?;
    if updated != 1 {
        return Err(guard("VERSION_CONFLICT"));
    }
    let (envelope, _) =
        canonicalize(&serde_json::to_vec(intent).map_err(|_| invalid())?).map_err(|_| invalid())?;
    tx.execute(
        "INSERT INTO outbox(operation_id,envelope,state) VALUES(?1,?2,'PENDING')",
        (op, envelope.as_bytes()),
    )?;
    Ok(SaleResult {
        operation_id: op.clone(),
        hash: hash.into(),
        ticket,
        total_cents: totals["totalCents"].as_str().ok_or_else(invalid)?.into(),
        itbis_cents: totals["itbisCents"].as_str().ok_or_else(invalid)?.into(),
        discount_cents: totals["discountCents"].as_str().ok_or_else(invalid)?.into(),
        change_cents: pay["changeCents"].as_str().ok_or_else(invalid)?.into(),
        payment_method: method.into(),
        ncf: ncf.map(str::to_owned),
        remote_status: "PENDING".into(),
        print_status: print_status.into(),
        snapshot_hash,
    })
}
pub fn ticket(c: &Connection, ctx: &CatalogueContext, op: &str) -> Result<Value, AppError> {
    let raw:Option<(Vec<u8>,String)>=c.query_row("SELECT s.snapshot_bytes,s.snapshot_hash FROM sale_ticket_snapshots_v1 s JOIN sales v ON v.operation_id=s.operation_id WHERE s.operation_id=?1 AND v.tenant_id=?2 AND v.scope_key=?3",(op,&ctx.tenant_id,scope_key(ctx)?),|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
    let (bytes, hash) = raw.ok_or_else(invalid)?;
    let (canonical, h) = canonicalize(&bytes).map_err(|_| invalid())?;
    if canonical.as_bytes() != bytes || h != hash {
        return Err(invalid());
    }
    serde_json::from_slice(&bytes).map_err(|_| invalid())
}
