//! A single pure quote/inventory/payment plan from trusted native read-models.
//! No Deserialize: the renderer cannot supply authority, tax or credit facts.
use super::{
    canonical::canonicalize,
    identity::{EntityId, Scope},
    money::MoneyCents,
    quantity::Ratio,
    sale_inventory::{self, InventoryLine, InventoryProduct, SerialAvailability},
    sale_payment::{self, CreditContext, Payment, PaymentTurn},
    sale_quote::{self, Discount, HistoricalIngredient, HistoricalQuoteLine},
};
use serde_json::{json, Value};
use std::collections::HashMap;

#[derive(Debug, Clone)]
pub struct SaleProductFacts {
    pub inventory: InventoryProduct,
    pub name: String,
    pub unit_price: MoneyCents,
    pub tax_rate: Ratio,
    pub cost: Option<MoneyCents>,
}
#[derive(Debug, Clone)]
pub enum SaleSelection {
    Product(InventoryLine),
    /// Explicit free line, not an invented product/stock movement.
    Free(HistoricalQuoteLine),
}
#[derive(Debug)]
pub enum SalePlanError {
    Invalid,
    Inventory(sale_inventory::InventoryError),
    Payment(sale_payment::PaymentError),
}
impl SalePlanError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Invalid => "CONTRACT_INVALID",
            Self::Inventory(e) => e.code(),
            Self::Payment(e) => e.code(),
        }
    }
}
/// Constructible only by plan_sale. Accepted bytes do not depend on mutable
/// catalogue data, incidental input-table order, wall clock or random IDs.
#[derive(Debug)]
pub struct ValidatedSale {
    tenant: EntityId,
    scope: Scope,
    payload: Value,
    hash: String,
}
/// Resolved from native customer facts (or an explicit recipient name). Not an
/// authority, balance or price-tier declaration supplied by the renderer.
pub struct HistoricalCustomer {
    pub id: Option<EntityId>,
    pub name: String,
    pub revision: Option<String>,
}
impl ValidatedSale {
    pub(crate) fn with_warranty_days(mut self, days: &str) -> Result<Self, SalePlanError> {
        let n = days.parse::<u32>().map_err(|_| SalePlanError::Invalid)?;
        if n > 3650 || n.to_string() != days {
            return Err(SalePlanError::Invalid);
        }
        for serial in self.payload["serials"]
            .as_array_mut()
            .ok_or(SalePlanError::Invalid)?
        {
            serial["warrantyDays"] = json!(days);
        }
        self.hash =
            canonicalize(&serde_json::to_vec(&self.payload).map_err(|_| SalePlanError::Invalid)?)
                .map_err(|_| SalePlanError::Invalid)?
                .1;
        Ok(self)
    }
    pub(crate) fn with_price_policy(mut self, policy: Value) -> Result<Self, SalePlanError> {
        for line in self.payload["lines"]
            .as_array_mut()
            .ok_or(SalePlanError::Invalid)?
        {
            if !line["productId"].is_null() {
                line["pricePolicy"] = policy.clone();
            }
        }
        self.hash =
            canonicalize(&serde_json::to_vec(&self.payload).map_err(|_| SalePlanError::Invalid)?)
                .map_err(|_| SalePlanError::Invalid)?
                .1;
        Ok(self)
    }
    pub(crate) fn with_stock_evidence(
        mut self,
        evidence: Vec<Value>,
    ) -> Result<Self, SalePlanError> {
        self.payload["stockEvidence"] = json!(evidence);
        self.hash =
            canonicalize(&serde_json::to_vec(&self.payload).map_err(|_| SalePlanError::Invalid)?)
                .map_err(|_| SalePlanError::Invalid)?
                .1;
        Ok(self)
    }
    pub(crate) fn with_customer(
        mut self,
        customer: HistoricalCustomer,
    ) -> Result<Self, SalePlanError> {
        if !name_valid(&customer.name) {
            return Err(SalePlanError::Invalid);
        }
        self.payload["customer"] = json!({"id":customer.id.map(|id|id.to_string()),"name":customer.name,"revision":customer.revision});
        self.hash =
            canonicalize(&serde_json::to_vec(&self.payload).map_err(|_| SalePlanError::Invalid)?)
                .map_err(|_| SalePlanError::Invalid)?
                .1;
        Ok(self)
    }
    pub fn payload(&self) -> Value {
        self.payload.clone()
    }
    pub fn quote_hash(&self) -> &str {
        &self.hash
    }
    pub(crate) fn context(&self) -> (EntityId, Scope) {
        (self.tenant, self.scope)
    }
}
fn ratio(v: &Ratio) -> Value {
    json!({"numerator":v.numerator().to_string(),"denominator":v.denominator().to_string()})
}
fn name_valid(s: &str) -> bool {
    !s.trim().is_empty() && s.len() <= 1024 && !s.chars().any(char::is_control)
}
#[allow(clippy::too_many_arguments)]
pub fn plan_sale(
    tenant: EntityId,
    scope: Scope,
    selection: &[SaleSelection],
    products: &[SaleProductFacts],
    serials: &[SerialAvailability],
    discount: &Discount,
    payment: &Payment,
    turn: Option<&PaymentTurn>,
    credit: Option<&CreditContext>,
) -> Result<ValidatedSale, SalePlanError> {
    if scope == Scope::UnknownLegacy
        || selection.is_empty()
        || selection.len() > 100
        || products.len() > 10_000
    {
        return Err(SalePlanError::Invalid);
    }
    let mut catalogue = HashMap::new();
    for p in products {
        if catalogue.insert(p.inventory.reference.id, p).is_some() {
            return Err(SalePlanError::Invalid);
        }
    }
    let mut stock_lines = Vec::new();
    let mut history = Vec::new();
    for chosen in selection {
        let line = match chosen {
            SaleSelection::Product(input) => {
                let p = catalogue
                    .get(&input.product_id)
                    .ok_or(SalePlanError::Inventory(
                        sale_inventory::InventoryError::Unknown,
                    ))?;
                stock_lines.push(input.clone());
                HistoricalQuoteLine {
                    product_id: Some(input.product_id),
                    product_revision: Some(p.inventory.revision.clone()),
                    name: p.name.clone(),
                    unit_price: p.unit_price,
                    quantity: input.quantity.clone(),
                    tax_rate: p.tax_rate.clone(),
                    cost: p.cost,
                    recipe: p
                        .inventory
                        .recipe
                        .iter()
                        .map(|r| HistoricalIngredient {
                            product_id: r.product_id,
                            quantity_per_unit: r.per_unit.clone(),
                            revision: catalogue
                                .get(&r.product_id)
                                .map(|f| f.inventory.revision.clone()),
                        })
                        .collect(),
                    serial: input.serial.clone(),
                }
            }
            SaleSelection::Free(f) => {
                if f.product_id.is_some()
                    || f.product_revision.is_some()
                    || !f.recipe.is_empty()
                    || f.serial.is_some()
                {
                    return Err(SalePlanError::Invalid);
                }
                f.clone()
            }
        };
        if !name_valid(&line.name) || line.cost.is_some_and(|m| m.require_non_negative().is_err()) {
            return Err(SalePlanError::Invalid);
        }
        history.push(line);
    }
    let inventory = if stock_lines.is_empty() {
        sale_inventory::InventoryPlan {
            effects: vec![],
            serials: vec![],
        }
    } else {
        sale_inventory::validate_inventory(
            tenant,
            scope,
            &stock_lines,
            &products
                .iter()
                .map(|p| p.inventory.clone())
                .collect::<Vec<_>>(),
            serials,
        )
        .map_err(SalePlanError::Inventory)?
    };
    let quote =
        sale_quote::quote_snapshot(&history, discount).map_err(|_| SalePlanError::Invalid)?;
    let pay =
        sale_payment::validate_payment(tenant, scope, quote.totals.total, payment, turn, credit)
            .map_err(SalePlanError::Payment)?;
    let (method, customer) = match payment {
        Payment::Cash { .. } => ("EFECTIVO", None),
        Payment::Card => ("TARJETA", None),
        Payment::Transfer => ("TRANSFERENCIA", None),
        Payment::Mixed { .. } => ("MIXTO", None),
        Payment::Credit { customer_id } => ("FIADO", Some(customer_id.to_string())),
    };
    let discount_input = match discount {
        Discount::Amount(v) => json!({"type":"AMOUNT","amountCents":v.to_string()}),
        Discount::Percent(v) => json!({"type":"PERCENT","ratio":ratio(v)}),
    };
    let payload = json!({"calculationVersion":quote.calculation_version,"currency":"DOP","lines":history.iter().map(|l|json!({"productId":l.product_id.map(|id|id.to_string()),"productRevision":l.product_revision,"name":l.name,"unitPriceCents":l.unit_price.to_string(),"quantity":ratio(&l.quantity),"taxRate":ratio(&l.tax_rate),"costCents":l.cost.map(|v|v.to_string()),"serial":l.serial,"recipe":l.recipe.iter().map(|r|json!({"productId":r.product_id.to_string(),"perUnit":ratio(&r.quantity_per_unit),"revision":r.revision})).collect::<Vec<_>>()})).collect::<Vec<_>>(),"discount":discount_input,"totals":{"subtotalCents":quote.totals.subtotal.to_string(),"itbisCents":quote.totals.itbis.to_string(),"discountCents":quote.totals.discount.to_string(),"totalCents":quote.totals.total.to_string()},"payment":{"method":method,"customerId":customer,"paidCents":pay.paid.to_string(),"creditChargeCents":pay.credit_charge.to_string(),"cashNetCents":pay.cash_net.to_string(),"cardCents":pay.card.to_string(),"transferCents":pay.transfer.to_string(),"tenderCents":pay.tender.to_string(),"changeCents":pay.change.to_string(),"turnId":pay.turn_id.map(|id|id.to_string()),"bankSettlementVerified":false},"inventory":inventory.effects.iter().map(|e|json!({"productId":e.product_id.to_string(),"delta":e.delta.to_string(),"expectedRevision":e.expected_revision})).collect::<Vec<_>>(),"serials":inventory.serials.iter().map(|s|json!({"text":s.text,"productId":s.product_id.to_string(),"expectedRevision":s.expected_revision})).collect::<Vec<_>>(),"fiscal":null});
    let (_, hash) =
        canonicalize(&serde_json::to_vec(&payload).map_err(|_| SalePlanError::Invalid)?)
            .map_err(|_| SalePlanError::Invalid)?;
    Ok(ValidatedSale {
        tenant,
        scope,
        payload,
        hash,
    })
}
