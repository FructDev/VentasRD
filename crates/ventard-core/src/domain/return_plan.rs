//! VentaRD refund arithmetic over immutable sale facts. No live prices/recipes.
use super::{money::MoneyCents, quantity::Ratio};
use num_bigint::BigUint;
use num_traits::ToPrimitive;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Item {
    pub key: String,
    pub quantity: String,
}
type Result<T> = std::result::Result<T, &'static str>;
fn s(v: &Value) -> Result<&str> {
    v.as_str().ok_or("RETURN_BASIS_UNAVAILABLE")
}
fn money(v: &Value) -> Result<u64> {
    MoneyCents::parse_dto(s(v)?)
        .map_err(|_| "RETURN_BASIS_UNAVAILABLE")?
        .cents()
        .try_into()
        .map_err(|_| "RETURN_BASIS_UNAVAILABLE")
}
fn qty(v: &Value) -> Result<u32> {
    let n = money(v)?;
    if n > i32::MAX as u64 {
        return Err("RETURN_QUANTITY_INVALID");
    }
    Ok(n as u32)
}
fn ratio(v: &Value) -> Result<Ratio> {
    Ratio::parse_canonical(s(&v["numerator"])?, s(&v["denominator"])?)
        .map_err(|_| "RETURN_BASIS_UNAVAILABLE")
}
#[derive(Default)]
struct Group {
    name: String,
    quantity: u32,
    gross: u64,
    recipes: Vec<(u32, Value)>,
}
fn groups(sale: &Value) -> Result<BTreeMap<String, Group>> {
    let mut groups = BTreeMap::<String, Group>::new();
    let lines = sale["lines"].as_array().ok_or("RETURN_BASIS_UNAVAILABLE")?;
    if lines.is_empty() || lines.len() > 100 {
        return Err("RETURN_BASIS_UNAVAILABLE");
    }
    for (i, l) in lines.iter().enumerate() {
        let q = ratio(&l["quantity"])?
            .to_exact_integer()
            .map_err(|_| "RETURN_QUANTITY_INVALID")?
            .to_u32()
            .filter(|n| *n > 0 && *n <= i32::MAX as u32)
            .ok_or("RETURN_QUANTITY_INVALID")?;
        let key = l["productId"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| format!("free/{i}"));
        let g = groups.entry(key).or_default();
        g.name = s(&l["name"])?.into();
        g.quantity = g
            .quantity
            .checked_add(q)
            .filter(|n| *n <= i32::MAX as u32)
            .ok_or("RETURN_QUANTITY_INVALID")?;
        g.gross = g
            .gross
            .checked_add(
                money(&l["unitPriceCents"])?
                    .checked_mul(q as u64)
                    .ok_or("RETURN_BASIS_UNAVAILABLE")?,
            )
            .ok_or("RETURN_BASIS_UNAVAILABLE")?;
        g.recipes.push((q, l["recipe"].clone()));
    }
    Ok(groups)
}
type PreviousReturns = (BTreeMap<String, u32>, u64, u64, BTreeSet<String>);
fn previous(prior: &[Value]) -> Result<PreviousReturns> {
    let mut quantities = BTreeMap::<String, u32>::new();
    let (mut amount, mut cash) = (0u64, 0u64);
    let mut serials = BTreeSet::new();
    for d in prior {
        amount = amount
            .checked_add(money(&d["amountCents"])?)
            .ok_or("RETURN_BASIS_UNAVAILABLE")?;
        cash = cash
            .checked_add(money(&d["cashRefundCents"])?)
            .ok_or("RETURN_BASIS_UNAVAILABLE")?;
        for i in d["items"].as_array().ok_or("RETURN_BASIS_UNAVAILABLE")? {
            let key = s(&i["key"])?;
            let q = qty(&i["quantity"])?;
            let old = quantities.entry(key.into()).or_default();
            *old = old.checked_add(q).ok_or("RETURN_BASIS_UNAVAILABLE")?;
        }
        for v in d["serials"].as_array().ok_or("RETURN_BASIS_UNAVAILABLE")? {
            if !serials.insert(s(&v["text"])?.to_owned()) {
                return Err("RETURN_BASIS_UNAVAILABLE");
            }
        }
    }
    Ok((quantities, amount, cash, serials))
}
pub fn available(sale: &Value, prior: &[Value]) -> Result<Value> {
    let groups = groups(sale)?;
    let (returned, amount, _, serials) = previous(prior)?;
    let mut items = vec![];
    for (key, g) in groups {
        let left = g
            .quantity
            .checked_sub(*returned.get(&key).unwrap_or(&0))
            .ok_or("RETURN_BASIS_UNAVAILABLE")?;
        items.push(json!({"key":key,"name":g.name,"soldQuantity":g.quantity.to_string(),"remainingQuantity":left.to_string(),"grossCents":g.gross.to_string()}));
    }
    let left = money(&sale["totals"]["totalCents"])?
        .checked_sub(amount)
        .ok_or("RETURN_BASIS_UNAVAILABLE")?;
    let ss = sale["serials"]
        .as_array()
        .ok_or("RETURN_BASIS_UNAVAILABLE")?
        .iter()
        .filter(|v| {
            v["text"]
                .as_str()
                .is_some_and(|text| !serials.contains(text))
        })
        .map(|v| json!({"productId":v["productId"],"text":v["text"]}))
        .collect::<Vec<_>>();
    Ok(json!({"items":items,"serials":ss,"remainingCents":left.to_string()}))
}
fn round(n: &BigUint, d: &BigUint) -> Result<u64> {
    ((n * 2u8 + d) / (d * 2u8))
        .to_u64()
        .ok_or("RETURN_BASIS_UNAVAILABLE")
}
pub fn plan(
    sale: &Value,
    prior: &[Value],
    items: &[Item],
    selected_serials: &[String],
) -> Result<Value> {
    let groups = groups(sale)?;
    let (returned, already, returned_cash, returned_serials) = previous(prior)?;
    let total = money(&sale["totals"]["totalCents"])?;
    let remaining = total
        .checked_sub(already)
        .ok_or("RETURN_BASIS_UNAVAILABLE")?;
    if items.is_empty() || items.len() > 100 {
        return Err("RETURN_NOTHING_REMAINING");
    }
    let mut selected = BTreeMap::new();
    for i in items {
        let q = qty(&json!(i.quantity))?;
        if q == 0 || selected.insert(i.key.as_str(), q).is_some() || !groups.contains_key(&i.key) {
            return Err("RETURN_QUANTITY_INVALID");
        }
    }
    let mut all = true;
    let mut weight = Ratio::zero();
    let mut gross = 0u64;
    let mut inventory = BTreeMap::<String, Ratio>::new();
    for (key, g) in &groups {
        let left = g
            .quantity
            .checked_sub(*returned.get(key).unwrap_or(&0))
            .ok_or("RETURN_BASIS_UNAVAILABLE")?;
        let q = *selected.get(key.as_str()).unwrap_or(&0);
        if q > left {
            return Err("RETURN_QUANTITY_INVALID");
        }
        all &= q == left;
        gross = gross
            .checked_add(g.gross)
            .ok_or("RETURN_BASIS_UNAVAILABLE")?;
        if q == 0 {
            continue;
        }
        weight = weight
            .checked_add(
                &Ratio::from_parts(BigUint::from(g.gross) * q, BigUint::from(g.quantity))
                    .map_err(|_| "RETURN_BASIS_UNAVAILABLE")?,
            )
            .map_err(|_| "RETURN_BASIS_UNAVAILABLE")?;
        let signature = &g.recipes[0].1;
        if q < g.quantity && g.recipes.iter().any(|(_, r)| r != signature) {
            return Err("RETURN_STOCK_AMBIGUOUS");
        }
        if key.starts_with("free/") {
            continue;
        }
        for (line_qty, recipe) in &g.recipes {
            let factor = Ratio::from_parts(BigUint::from(*line_qty) * q, BigUint::from(g.quantity))
                .map_err(|_| "RETURN_BASIS_UNAVAILABLE")?;
            let parts = recipe.as_array().ok_or("RETURN_BASIS_UNAVAILABLE")?;
            let consumption = if parts.is_empty() {
                vec![(key.clone(), Ratio::one())]
            } else {
                parts
                    .iter()
                    .map(|p| Ok((s(&p["productId"])?.to_owned(), ratio(&p["perUnit"])?)))
                    .collect::<Result<Vec<_>>>()?
            };
            for (pid, per_unit) in consumption {
                let delta = per_unit
                    .checked_mul(&factor)
                    .map_err(|_| "RETURN_BASIS_UNAVAILABLE")?;
                let old = inventory.entry(pid).or_insert_with(Ratio::zero);
                *old = old
                    .checked_add(&delta)
                    .map_err(|_| "RETURN_BASIS_UNAVAILABLE")?;
            }
        }
    }
    if gross == 0 {
        return Err("RETURN_BASIS_UNAVAILABLE");
    }
    let amount = if all {
        remaining
    } else {
        round(
            &(weight.numerator() * total),
            &(weight.denominator() * gross),
        )?
        .min(remaining)
    };
    let method = s(&sale["payment"]["method"])?;
    let original_cash = money(&sale["payment"]["cashNetCents"])?;
    if !matches!(
        method,
        "EFECTIVO" | "MIXTO" | "TARJETA" | "TRANSFERENCIA" | "FIADO"
    ) {
        return Err("RETURN_BASIS_UNAVAILABLE");
    }
    let cash_remaining = original_cash
        .checked_sub(returned_cash)
        .ok_or("RETURN_BASIS_UNAVAILABLE")?;
    let cash = if original_cash == 0 {
        0
    } else if all {
        cash_remaining
    } else if method == "EFECTIVO" {
        amount.min(cash_remaining)
    } else if total > 0 {
        round(
            &(BigUint::from(amount) * original_cash),
            &BigUint::from(total),
        )?
        .min(cash_remaining)
    } else {
        0
    };
    if cash > amount {
        return Err("RETURN_BASIS_UNAVAILABLE");
    }
    let wanted: BTreeSet<_> = selected_serials.iter().collect();
    if wanted.len() != selected_serials.len() {
        return Err("RETURN_SERIAL_INVALID");
    }
    let mut ss = vec![];
    let mut serial_qty = BTreeMap::<String, u32>::new();
    for v in sale["serials"]
        .as_array()
        .ok_or("RETURN_BASIS_UNAVAILABLE")?
    {
        let text = s(&v["text"])?;
        let pid = s(&v["productId"])?;
        if wanted.contains(&text.to_owned()) {
            if returned_serials.contains(text) {
                return Err("RETURN_SERIAL_INVALID");
            }
            ss.push(json!({"productId":pid,"text":text}));
            *serial_qty.entry(pid.into()).or_default() += 1;
        }
    }
    if ss.len() != wanted.len() {
        return Err("RETURN_SERIAL_INVALID");
    }
    for (key, q) in &selected {
        let is_serial = sale["serials"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v["productId"] == *key);
        if is_serial && serial_qty.get(*key).copied().unwrap_or(0) != *q {
            return Err("RETURN_SERIAL_INVALID");
        }
    }
    if serial_qty
        .keys()
        .any(|key| !selected.contains_key(key.as_str()))
    {
        return Err("RETURN_SERIAL_INVALID");
    }
    ss.sort_by(|a, b| a["text"].as_str().cmp(&b["text"].as_str()));
    let stock = inventory
        .into_iter()
        .map(|(pid, d)| {
            let n = d
                .to_exact_integer()
                .map_err(|_| "RETURN_STOCK_FRACTIONAL")?
                .to_u32()
                .filter(|v| *v <= i32::MAX as u32)
                .ok_or("RETURN_STOCK_FRACTIONAL")?;
            Ok(json!({"productId":pid,"delta":n.to_string()}))
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(
        json!({"items":selected.into_iter().map(|(key,q)|json!({"key":key,"quantity":q.to_string()})).collect::<Vec<_>>(),"amountCents":amount.to_string(),"cashRefundCents":cash.to_string(),"bankRefundCents":if method=="FIADO"{0}else{amount-cash}.to_string(),"creditAdjustmentCents":if method=="FIADO"{amount}else{0}.to_string(),"method":method,"bankSettlementVerified":false,"inventory":stock,"serials":ss}),
    )
}
