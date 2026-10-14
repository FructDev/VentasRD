//! Account inventory operations share the durable journal and receipt feed.
use super::{
    errors::{AppError, BusinessError, ProtocolError},
    management::Command,
    sales,
};
use crate::{
    domain::{identity::EntityId, money::MoneyCents, quantity::Ratio},
    storage::catalogue_preview::CatalogueContext,
};
use rusqlite::{Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecipeDefinition {
    pub product_id: String,
    pub numerator: String,
    pub denominator: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProductDefinition {
    pub name: String,
    pub code: String,
    pub price_cents: String,
    pub tier2_cents: Option<String>,
    pub tier3_cents: Option<String>,
    pub cost_cents: Option<String>,
    pub tax_percent: String,
    pub product_type: String,
    pub location: String,
    pub minimum: String,
    pub serial_required: bool,
    pub recipe: Vec<RecipeDefinition>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub photo: Option<ProductPhoto>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProductPhoto {
    pub data: Option<String>,
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
fn uint(v: &str) -> Result<i64, AppError> {
    let n = MoneyCents::parse_dto(v).map_err(|_| invalid())?.cents();
    if n < 0 {
        return Err(invalid());
    }
    Ok(n)
}
fn qty(v: &str) -> Result<i32, AppError> {
    let n = uint(v)?;
    i32::try_from(n).map_err(|_| invalid())
}
fn text(v: &str, max: usize, empty: bool) -> Result<(), AppError> {
    if (!empty && v.is_empty())
        || v.trim() != v
        || v.chars().count() > max
        || v.chars().any(char::is_control)
    {
        return Err(invalid());
    }
    Ok(())
}
fn serial_adjustments(
    c: &Connection,
    ctx: &CatalogueContext,
    pid: &str,
    mode: &str,
    serials: &[String],
    before: i32,
) -> Result<Value, AppError> {
    let sk = sales::scope_key(ctx)?;
    let mut q=c.prepare("SELECT serial,revision FROM sale_serial_inventory_v1 WHERE tenant_id=?1 AND scope_key=?2 AND producto_id=?3 AND state='AVAILABLE' ORDER BY serial LIMIT 1001")?;
    let available = q
        .query_map((&ctx.tenant_id, &sk, pid), |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?
        .collect::<Result<BTreeMap<_, _>, _>>()?;
    if available.len() > 1000 || available.len() != before as usize {
        return Err(guard("SERIAL_INVENTORY_DIVERGED"));
    }
    let mut changes = BTreeMap::new();
    let mut selected = HashSet::new();
    for serial in serials {
        text(serial, 128, false)?;
        if !selected.insert(serial.as_str()) {
            return Err(guard("SERIAL_UNAVAILABLE"));
        }
        let mut rows=c.prepare("SELECT scope_key,producto_id,state,revision FROM sale_serial_inventory_v1 WHERE tenant_id=?1 AND serial=?2 LIMIT 2")?;
        let existing = rows
            .query_map((&ctx.tenant_id, serial), |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        if existing.len() > 1 {
            return Err(guard("SERIAL_UNAVAILABLE"));
        }
        let (state, revision) = if let Some((scope, product, state, revision)) = existing.first() {
            if scope != &sk || product != pid || !matches!(state.as_str(), "AVAILABLE" | "LOST") {
                return Err(guard("SERIAL_UNAVAILABLE"));
            }
            (Some(state.as_str()), Some(revision.as_str()))
        } else {
            (None, None)
        };
        if mode == "LOSS" && state != Some("AVAILABLE") {
            return Err(guard("SERIAL_UNAVAILABLE"));
        }
        let after = if mode == "LOSS" { "LOST" } else { "AVAILABLE" };
        if state != Some(after) {
            changes.insert(serial.clone(),json!({"productId":pid,"text":serial,"expectedRevision":revision,"before":state,"after":after}));
        }
    }
    if mode == "COUNT" {
        for (serial, revision) in available {
            if !selected.contains(serial.as_str()) {
                changes.insert(serial.clone(),json!({"productId":pid,"text":serial,"expectedRevision":revision,"before":"AVAILABLE","after":"LOST"}));
            }
        }
    }
    Ok(json!(changes.into_values().collect::<Vec<_>>()))
}
pub fn supports(kind: &str) -> bool {
    matches!(
        kind,
        "PRODUCT_CREATE"
            | "PRODUCT_PATCH"
            | "PRODUCT_DELETE"
            | "INVENTORY_DELTA"
            | "INVENTORY_COUNT"
    )
}
pub(crate) fn product(
    c: &Connection,
    ctx: &CatalogueContext,
    pid: &str,
) -> Result<Value, AppError> {
    let row:Option<(i64,String,String,String,String,bool)>=c.query_row("SELECT revision,name,coalesce(barcode,''),price_tiers,metadata,tombstone FROM products WHERE producto_id=?1 AND tenant_id=?2",(pid,&ctx.tenant_id),|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).optional()?;
    let (rev, name, code, prices, meta, deleted) = row.ok_or_else(|| guard("VERSION_CONFLICT"))?;
    Ok(
        json!({"id":pid,"revision":rev.to_string(),"name":name,"code":code,"priceTiers":serde_json::from_str::<Value>(&prices).map_err(|_|invalid())?,"metadata":serde_json::from_str::<Value>(&meta).map_err(|_|invalid())?,"deleted":deleted}),
    )
}
pub fn document(
    c: &Connection,
    ctx: &CatalogueContext,
    req: &Command,
) -> Result<(String, Value), AppError> {
    let sk = sales::scope_key(ctx)?;
    match req {
        Command::ProductSave {
            product_id,
            expected_revision,
            definition: d,
            ..
        } => {
            EntityId::parse(product_id).map_err(|_| invalid())?;
            let rev = uint(expected_revision)?;
            text(&d.name, 256, false)?;
            text(&d.code, 64, true)?;
            text(&d.location, 256, true)?;
            if let Some(photo) = &d.photo {
                if let Some(data) = &photo.data {
                    super::settings::validate_png(data)?;
                }
            }
            if uint(&d.price_cents)? > 999999999999
                || d.cost_cents.is_none()
                || uint(d.cost_cents.as_deref().ok_or_else(invalid)?)? > 999999999999
            {
                return Err(invalid());
            }
            for v in [&d.tier2_cents, &d.tier3_cents].into_iter().flatten() {
                uint(v)?;
            }
            let percent = uint(&d.tax_percent)?;
            if percent > 100 || !matches!(d.product_type.as_str(), "simple" | "insumo" | "combo") {
                return Err(invalid());
            }
            qty(&d.minimum)?;
            let exists: bool = c.query_row(
                "SELECT EXISTS(SELECT 1 FROM products WHERE producto_id=?1)",
                [product_id],
                |r| r.get(0),
            )?;
            if rev == 0 {
                if exists {
                    return Err(guard("VERSION_CONFLICT"));
                }
            } else {
                let old = product(c, ctx, product_id)?;
                if old["deleted"] != false || old["revision"] != *expected_revision {
                    return Err(guard("VERSION_CONFLICT"));
                }
                if old["metadata"]["serialRequired"] != d.serial_required
                    || old["metadata"]["recipe"]
                        .as_array()
                        .ok_or_else(invalid)?
                        .is_empty()
                        != (d.product_type != "combo")
                {
                    let (stock, _, _) = sales::stock(c, product_id, &sk)?;
                    let serials:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM sale_serial_inventory_v1 WHERE tenant_id=?1 AND producto_id=?2)",(&ctx.tenant_id,product_id),|r|r.get(0))?;
                    let referenced:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM products p,json_each(p.metadata,'$.recipe') r WHERE p.tenant_id=?1 AND p.tombstone=0 AND json_extract(r.value,'$.productId')=?2)",(&ctx.tenant_id,product_id),|r|r.get(0))?;
                    if stock != 0 || serials || referenced {
                        return Err(guard("PRODUCT_TYPE_IN_USE"));
                    }
                }
            }
            let duplicate:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM products WHERE tenant_id=?1 AND barcode=?2 AND barcode<>'' AND tombstone=0 AND producto_id<>?3)",(&ctx.tenant_id,&d.code,product_id),|r|r.get(0))?;
            if duplicate {
                return Err(guard("PRODUCT_CODE_EXISTS"));
            }
            if (d.product_type == "combo") == d.recipe.is_empty()
                || d.recipe.len() > 100
                || d.serial_required && d.product_type != "simple"
            {
                return Err(invalid());
            }
            let mut seen = HashSet::new();
            let mut recipe = vec![];
            let mut calculated_cost = Ratio::zero();
            for part in &d.recipe {
                if part.product_id == *product_id || !seen.insert(&part.product_id) {
                    return Err(invalid());
                }
                let ingredient = product(c, ctx, &part.product_id)?;
                let m = &ingredient["metadata"];
                if ingredient["deleted"] != false
                    || m["serialRequired"] == true
                    || !m["recipe"].as_array().ok_or_else(invalid)?.is_empty()
                {
                    return Err(guard("RECIPE_INVALID"));
                }
                let ratio = Ratio::parse_canonical(&part.numerator, &part.denominator)
                    .map_err(|_| invalid())?;
                let numerator = uint(&part.numerator)?;
                let denominator = uint(&part.denominator)?;
                if numerator == 0
                    || denominator == 0
                    || denominator > 10000
                    || 10000 % denominator != 0
                    || numerator as i128 * 10000 > 999999999999i128 * denominator as i128
                {
                    return Err(invalid());
                }
                let cost = uint(s(&m["costCents"])?)?;
                calculated_cost = calculated_cost
                    .checked_add(
                        &ratio
                            .checked_mul(&Ratio::from_integer(cost as u64))
                            .map_err(|_| invalid())?,
                    )
                    .map_err(|_| invalid())?;
                recipe.push(json!({"productId":part.product_id,"perUnit":{"numerator":ratio.numerator().to_string(),"denominator":ratio.denominator().to_string()},"revision":ingredient["revision"]}));
            }
            recipe.sort_by(|a, b| a["productId"].as_str().cmp(&b["productId"].as_str()));
            if d.product_type == "combo"
                && calculated_cost
                    .to_exact_integer()
                    .map_err(|_| guard("RECIPE_COST_INVALID"))?
                    .to_string()
                    != *d.cost_cents.as_ref().ok_or_else(invalid)?
            {
                return Err(guard("RECIPE_COST_INVALID"));
            }
            let ratio =
                Ratio::from_parts((percent as u64).into(), 100u64.into()).map_err(|_| invalid())?;
            let mut p = json!({"id":product_id,"name":d.name,"code":d.code,"revision":rev.checked_add(1).ok_or_else(invalid)?.to_string(),"deleted":false,"priceTiers":{"retailCents":d.price_cents,"tier2Cents":d.tier2_cents,"tier3Cents":d.tier3_cents},"metadata":{"costCents":d.cost_cents,"taxRate":{"numerator":ratio.numerator().to_string(),"denominator":ratio.denominator().to_string()},"serialRequired":d.serial_required,"recipe":recipe,"productType":d.product_type,"recipeCostPolicy":if d.product_type=="combo"{"NATIVE_EXACT"}else{"DECLARED"},"location":d.location,"minimum":d.minimum}});
            if let Some(photo) = &d.photo {
                p["metadata"]["photo"] = json!(photo);
            } else if rev > 0 {
                let old = product(c, ctx, product_id)?;
                if let Some(photo) = old["metadata"].get("photo") {
                    p["metadata"]["photo"] = photo.clone();
                }
            }
            Ok((
                if rev == 0 {
                    "PRODUCT_CREATE"
                } else {
                    "PRODUCT_PATCH"
                }
                .into(),
                json!({"product":p}),
            ))
        }
        Command::ProductDelete {
            product_id,
            expected_revision,
            ..
        } => {
            let mut p = product(c, ctx, product_id)?;
            if p["deleted"] != false || p["revision"] != *expected_revision {
                return Err(guard("VERSION_CONFLICT"));
            }
            let used:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM products p,json_each(p.metadata,'$.recipe') r WHERE p.tenant_id=?1 AND p.tombstone=0 AND json_extract(r.value,'$.productId')=?2)",(&ctx.tenant_id,product_id),|r|r.get(0))?;
            if used {
                return Err(guard("PRODUCT_RECIPE_IN_USE"));
            }
            p["deleted"] = json!(true);
            p["revision"] = json!(uint(expected_revision)?
                .checked_add(1)
                .ok_or_else(invalid)?
                .to_string());
            Ok(("PRODUCT_DELETE".into(), json!({"product":p})))
        }
        Command::InventoryChange {
            product_id,
            expected_stock_revision,
            mode,
            quantity,
            reason,
            serials,
            ..
        } => {
            text(reason, 256, false)?;
            let p = product(c, ctx, product_id)?;
            if p["deleted"] != false
                || !p["metadata"]["recipe"]
                    .as_array()
                    .ok_or_else(invalid)?
                    .is_empty()
            {
                return Err(guard("PRODUCT_TYPE_IN_USE"));
            }
            let (before, revision, _) = sales::stock(c, product_id, &sk)?;
            if revision != *expected_stock_revision {
                return Err(guard("VERSION_CONFLICT"));
            }
            let n = qty(quantity)?;
            let delta = match mode.as_str() {
                "IN" if n > 0 => n,
                "LOSS" if n > 0 => -n,
                "COUNT" => n - before,
                _ => return Err(invalid()),
            };
            let after = before
                .checked_add(delta)
                .filter(|n| *n >= 0)
                .ok_or_else(|| guard("STOCK_UNAVAILABLE"))?;
            let serialized = p["metadata"]["serialRequired"] == true;
            if serialized && serials.len() != n as usize
                || !serialized && !serials.is_empty()
                || serials.len() > 1000
            {
                return Err(guard("SERIAL_REQUIRED"));
            }
            let mut seen = HashSet::new();
            for serial in serials {
                text(serial, 128, false)?;
                if !seen.insert(serial) {
                    return Err(guard("SERIAL_UNAVAILABLE"));
                }
                let used:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM sale_serial_inventory_v1 WHERE tenant_id=?1 AND serial=?2)",(&ctx.tenant_id,serial),|r|r.get(0))?;
                if mode == "IN" && used {
                    return Err(guard("SERIAL_UNAVAILABLE"));
                }
            }
            let (base,seq,pending):(String,i64,String)=c.query_row("SELECT remote_base_qty,remote_seq,pending_coverage FROM stock_projections WHERE producto_id=?1 AND scope_key=?2",(product_id,&sk),|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
            let mut doc = json!({"productId":product_id,"productRevision":p["revision"],"delta":delta.to_string(),"before":before.to_string(),"after":after.to_string(),"mode":mode,"reason":reason,"serials":serials,"stockEvidence":{"productId":product_id,"remoteBaseQty":base,"remoteSequence":seq.to_string(),"pending":serde_json::from_str::<Value>(&pending).map_err(|_|invalid())?,"effectiveQty":before.to_string()}});
            if serialized && mode != "IN" {
                doc["serialChanges"] =
                    serial_adjustments(c, ctx, product_id, mode, serials, before)?;
            }
            Ok((
                if mode == "COUNT" {
                    "INVENTORY_COUNT"
                } else {
                    "INVENTORY_DELTA"
                }
                .into(),
                doc,
            ))
        }
        _ => Err(invalid()),
    }
}
/// Frozen sale cost follows live ingredient costs only for the new native recipes.
/// Legacy recipe snapshots retain their established valuation policy.
pub(crate) fn cost(
    c: &Connection,
    ctx: &CatalogueContext,
    pid: &str,
) -> Result<Option<MoneyCents>, AppError> {
    let p = product(c, ctx, pid)?;
    let m = &p["metadata"];
    if m["recipeCostPolicy"] != "NATIVE_EXACT" {
        return m["costCents"]
            .as_str()
            .map(|v| MoneyCents::parse_dto(v).map_err(|_| invalid()))
            .transpose();
    }
    let mut total = Ratio::zero();
    for part in m["recipe"].as_array().ok_or_else(invalid)? {
        let ingredient = product(c, ctx, s(&part["productId"])?)?;
        let Some(cost) = ingredient["metadata"]["costCents"].as_str() else {
            return Ok(None);
        };
        let ratio = Ratio::from_parts(
            s(&part["perUnit"]["numerator"])?
                .parse()
                .map_err(|_| invalid())?,
            s(&part["perUnit"]["denominator"])?
                .parse()
                .map_err(|_| invalid())?,
        )
        .map_err(|_| invalid())?;
        total = total
            .checked_add(
                &ratio
                    .checked_mul(&Ratio::from_integer(uint(cost)? as u64))
                    .map_err(|_| invalid())?,
            )
            .map_err(|_| invalid())?;
    }
    Ok(total
        .to_exact_integer()
        .ok()
        .and_then(|n| MoneyCents::parse_dto(&n.to_string()).ok()))
}
pub(crate) fn possible_stock(
    c: &Connection,
    ctx: &CatalogueContext,
    pid: &str,
) -> Result<Option<String>, AppError> {
    let p = product(c, ctx, pid)?;
    let recipe = p["metadata"]["recipe"].as_array().ok_or_else(invalid)?;
    if recipe.is_empty() {
        return Ok(None);
    }
    let sk = sales::scope_key(ctx)?;
    let mut capacity = i32::MAX;
    for part in recipe {
        let Ok((stock, _, _)) = sales::stock(c, s(&part["productId"])?, &sk) else {
            return Ok(None);
        };
        let n: num_bigint::BigUint = s(&part["perUnit"]["numerator"])?
            .parse()
            .map_err(|_| invalid())?;
        let d: num_bigint::BigUint = s(&part["perUnit"]["denominator"])?
            .parse()
            .map_err(|_| invalid())?;
        if n == 0u32.into() || d == 0u32.into() {
            return Err(invalid());
        }
        let possible = (num_bigint::BigUint::from(stock as u32) * d / n).to_string();
        capacity = capacity.min(possible.parse::<i32>().unwrap_or(i32::MAX));
    }
    Ok(Some(capacity.to_string()))
}
pub fn apply(
    tx: &Transaction<'_>,
    ctx: &CatalogueContext,
    v: &Value,
    remote: bool,
) -> Result<(), AppError> {
    let kind = s(&v["kind"])?;
    let op = s(&v["operationId"])?;
    let req: Command =
        serde_json::from_value(v["payload"]["request"].clone()).map_err(|_| invalid())?;
    let d = &v["payload"]["document"];
    let sk = sales::scope_key(ctx)?;
    if !remote || kind.starts_with("PRODUCT_") {
        let (k, expected) = document(tx, ctx, &req)?;
        if k != kind || expected != *d {
            return Err(guard("VERSION_CONFLICT"));
        }
    }
    if kind.starts_with("PRODUCT_") {
        let p = &d["product"];
        let pid = s(&p["id"])?;
        let rev = uint(s(&p["revision"])?)?;
        if kind == "PRODUCT_CREATE" {
            tx.execute(
                "INSERT INTO products VALUES(?1,?2,?3,NULL,?4,?5,?6,?7,0)",
                (
                    pid,
                    &ctx.tenant_id,
                    rev,
                    s(&p["code"])?,
                    s(&p["name"])?,
                    p["priceTiers"].to_string(),
                    p["metadata"].to_string(),
                ),
            )?;
            let coverage = if remote {
                json!([])
            } else {
                json!([{"operationId":op,"effectId":sales::effect_id(op,&format!("stock/{pid}")),"delta":"0"}])
            };
            tx.execute(
                "INSERT INTO stock_projections VALUES(?1,?2,'0',0,?3,'0','VERIFIED')",
                (pid, &sk, coverage.to_string()),
            )?;
        } else {
            tx.execute("UPDATE products SET revision=?3,barcode=?4,name=?5,price_tiers=?6,metadata=?7,tombstone=?8 WHERE producto_id=?1 AND tenant_id=?2",(pid,&ctx.tenant_id,rev,s(&p["code"])?,s(&p["name"])?,p["priceTiers"].to_string(),p["metadata"].to_string(),p["deleted"].as_bool().ok_or_else(invalid)?))?;
        }
    } else {
        let pid = s(&d["productId"])?;
        let p = product(tx, ctx, pid)?;
        let serialized = p["metadata"]["serialRequired"] == true;
        let serials = d["serials"].as_array().ok_or_else(invalid)?;
        if serialized
            && d["mode"] == "IN"
            && s(&d["delta"])?.parse::<usize>().ok() != Some(serials.len())
            || !serialized && !serials.is_empty()
            || !p["metadata"]["recipe"]
                .as_array()
                .ok_or_else(invalid)?
                .is_empty()
        {
            return Err(guard("SERIAL_REQUIRED"));
        }
        let delta = s(&d["delta"])?;
        let eid = sales::effect_id(op, &format!("stock/{pid}"));
        tx.execute(
            "INSERT INTO inventory_movements VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            (
                &eid,
                op,
                pid,
                &sk,
                s(&d["mode"])?,
                delta,
                if kind == "INVENTORY_COUNT" {
                    d["after"].as_str()
                } else {
                    None
                },
                uint(s(&d["stockEvidence"]["remoteSequence"])?)?,
                if remote { Some(op) } else { None },
            ),
        )?;
        if !remote {
            let (_, _, pending) = sales::stock(tx, pid, &sk)?;
            let mut list: Vec<Value> = serde_json::from_str(&pending).map_err(|_| invalid())?;
            list.push(json!({"operationId":op,"effectId":eid,"delta":delta}));
            tx.execute("UPDATE stock_projections SET effective_stock=?3,pending_coverage=?4 WHERE producto_id=?1 AND scope_key=?2",(pid,&sk,s(&d["after"])?,serde_json::to_string(&list).map_err(|_|invalid())?))?;
        }
        if let Some(changes) = d.get("serialChanges") {
            if !serialized || d["mode"] == "IN" {
                return Err(invalid());
            }
            for change in changes.as_array().ok_or_else(invalid)? {
                let serial = s(&change["text"])?;
                if change["before"].is_null() {
                    let used: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM sale_serial_inventory_v1 WHERE tenant_id=?1 AND serial=?2)", (&ctx.tenant_id, serial), |r| r.get(0))?;
                    if used {
                        return Err(guard("SERIAL_UNAVAILABLE"));
                    }
                    tx.execute("INSERT INTO sale_serial_inventory_v1 VALUES(?1,?2,?3,?4,'1','AVAILABLE',NULL)",(&ctx.tenant_id,&sk,pid,serial))?;
                } else {
                    let changed=tx.execute("UPDATE sale_serial_inventory_v1 SET state=?5,sale_operation_id=?6 WHERE tenant_id=?1 AND scope_key=?2 AND producto_id=?3 AND serial=?4 AND state=?7 AND revision=?8",(&ctx.tenant_id,&sk,pid,serial,s(&change["after"])?,if change["after"]=="LOST"{Some(op)}else{None},s(&change["before"])?,s(&change["expectedRevision"])?))?;
                    if changed != 1 {
                        return Err(guard("SERIAL_UNAVAILABLE"));
                    }
                }
            }
        } else {
            if serialized && d["mode"] != "IN" {
                return Err(invalid());
            }
            for serial in d["serials"].as_array().ok_or_else(invalid)? {
                let used:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM sale_serial_inventory_v1 WHERE tenant_id=?1 AND serial=?2)",(&ctx.tenant_id,s(serial)?),|r|r.get(0))?;
                if used {
                    return Err(guard("SERIAL_UNAVAILABLE"));
                }
                tx.execute(
                    "INSERT INTO sale_serial_inventory_v1 VALUES(?1,?2,?3,?4,'1','AVAILABLE',NULL)",
                    (&ctx.tenant_id, &sk, pid, s(serial)?),
                )?;
            }
        }
    }
    Ok(())
}
pub fn effects(v: &Value) -> Result<Value, AppError> {
    let op = s(&v["operationId"])?;
    let kind = s(&v["kind"])?;
    let d = &v["payload"]["document"];
    let mut list = vec![json!({"id":sales::effect_id(op,"management"),"kind":kind,"payload":d})];
    if kind == "PRODUCT_CREATE" || kind.starts_with("INVENTORY_") {
        let pid = if kind == "PRODUCT_CREATE" {
            s(&d["product"]["id"])?
        } else {
            s(&d["productId"])?
        };
        list.push(json!({"id":sales::effect_id(op,&format!("stock/{pid}")),"kind":"STOCK","payload":{"productId":pid,"delta":if kind=="PRODUCT_CREATE"{"0"}else{s(&d["delta"])?}}}));
    }
    if let Some(changes) = d.get("serialChanges") {
        for change in changes.as_array().ok_or_else(invalid)? {
            list.push(json!({"id":sales::effect_id(op,&format!("serial/{}",s(&change["text"])?)),"kind":"SERIAL","payload":change}));
        }
    }
    Ok(json!(list))
}
pub fn validate_receipt(v: &Value, r: &Value, snapshot: Option<&str>) -> Result<(), AppError> {
    let req: Command =
        serde_json::from_value(v["payload"]["request"].clone()).map_err(|_| invalid())?;
    if let Command::InventoryChange {
        product_id,
        expected_stock_revision,
        mode,
        quantity,
        reason,
        serials,
        ..
    } = &req
    {
        let d = &v["payload"]["document"];
        let proof = &d["stockEvidence"];
        let before = qty(s(&d["before"])?)?;
        let n = qty(quantity)?;
        let delta = match mode.as_str() {
            "IN" if n > 0 => n,
            "LOSS" if n > 0 => -n,
            "COUNT" => n - before,
            _ => return Err(invalid()),
        };
        let after = before
            .checked_add(delta)
            .filter(|n| *n >= 0)
            .ok_or_else(invalid)?;
        text(reason, 256, false)?;
        let expected=crate::domain::canonical::canonicalize(&serde_json::to_vec(&json!({"quantity":proof["effectiveQty"],"remoteSequence":proof["remoteSequence"],"pending":proof["pending"]})).map_err(|_|invalid())?).map_err(|_|invalid())?.1;
        if d["productId"] != *product_id
            || proof["productId"] != *product_id
            || proof["effectiveQty"] != d["before"]
            || d["delta"] != json!(delta.to_string())
            || d["after"] != json!(after.to_string())
            || d["mode"] != *mode
            || d["reason"] != *reason
            || d["serials"] != json!(serials)
            || expected != *expected_stock_revision
            || (v["kind"] == "INVENTORY_COUNT") != (mode == "COUNT")
        {
            return Err(invalid());
        }
        let mut effective = qty(s(&proof["remoteBaseQty"])?)? as i64;
        uint(s(&proof["remoteSequence"])?)?;
        let mut seen = HashSet::new();
        for p in proof["pending"].as_array().ok_or_else(invalid)? {
            let op = s(&p["operationId"])?;
            EntityId::parse(op).map_err(|_| invalid())?;
            if !seen.insert(op)
                || p["effectId"] != sales::effect_id(op, &format!("stock/{product_id}"))
            {
                return Err(invalid());
            }
            let delta = s(&p["delta"])?.parse::<i32>().map_err(|_| invalid())?;
            if p["delta"] != json!(delta.to_string()) {
                return Err(invalid());
            }
            effective = effective.checked_add(delta as i64).ok_or_else(invalid)?;
        }
        if effective != before as i64 {
            return Err(invalid());
        }
        let mut selected = HashSet::new();
        for serial in serials {
            text(serial, 128, false)?;
            if !selected.insert(serial.as_str()) {
                return Err(invalid());
            }
        }
        if let Some(changes) = d.get("serialChanges") {
            let changes = changes.as_array().ok_or_else(invalid)?;
            if !matches!(mode.as_str(), "LOSS" | "COUNT")
                || serials.len() != n as usize
                || changes.len() > 2000
            {
                return Err(invalid());
            }
            let mut last = None;
            let mut availability_delta = 0i64;
            let mut removed = HashSet::new();
            for change in changes {
                let fields = change.as_object().ok_or_else(invalid)?;
                let sn = s(&change["text"])?;
                text(sn, 128, false)?;
                if fields.len() != 5
                    || !["productId","text","expectedRevision","before","after"].iter().all(|key| fields.contains_key(*key))
                    || change["productId"] != *product_id
                    || last.is_some_and(|previous: &str| previous >= sn)
                {
                    return Err(invalid());
                }
                last = Some(sn);
                let before = if change["before"].is_null() {
                    if !change["expectedRevision"].is_null() {
                        return Err(invalid());
                    }
                    None
                } else {
                    if uint(s(&change["expectedRevision"])?)? == 0 {
                        return Err(invalid());
                    }
                    Some(s(&change["before"])?)
                };
                match (mode.as_str(), before, s(&change["after"])?) {
                    ("LOSS", Some("AVAILABLE"), "LOST") if selected.contains(sn) => {
                        removed.insert(sn);
                        availability_delta -= 1;
                    }
                    ("COUNT", Some("AVAILABLE"), "LOST") if !selected.contains(sn) => {
                        availability_delta -= 1
                    }
                    ("COUNT", None | Some("LOST"), "AVAILABLE") if selected.contains(sn) => {
                        availability_delta += 1
                    }
                    _ => return Err(invalid()),
                }
            }
            if availability_delta != delta as i64 || (mode == "LOSS" && removed != selected) {
                return Err(invalid());
            }
        } else if !serials.is_empty() && (mode != "IN" || serials.len() != n as usize) {
            return Err(invalid());
        }
    }
    if snapshot.is_some()
        || !r["snapshotHash"].is_null()
        || !r["ticket"].is_null()
        || !r["ncf"].is_null()
        || !r["totalCents"].is_null()
        || r["effects"] != effects(v)?
    {
        return Err(invalid());
    }
    let kind = s(&v["kind"])?;
    let d = &v["payload"]["document"];
    let stock = r["stock"].as_array().ok_or_else(invalid)?;
    if kind == "PRODUCT_CREATE" || kind.starts_with("INVENTORY_") {
        let (pid, after) = if kind == "PRODUCT_CREATE" {
            (&d["product"]["id"], json!("0"))
        } else {
            (&d["productId"], d["after"].clone())
        };
        if stock.len() != 1
            || stock[0]["productId"] != *pid
            || stock[0]["after"] != after
            || stock[0]["version"] != r["remoteSequence"]
        {
            return Err(invalid());
        }
        qty(s(&after)?)?;
    } else if !stock.is_empty() {
        return Err(invalid());
    }
    Ok(())
}
pub fn history(
    c: &Connection,
    ctx: &CatalogueContext,
    pid: &str,
    page: u32,
) -> Result<Value, AppError> {
    product(c, ctx, pid)?;
    if page == 0 || page > 100000 {
        return Err(invalid());
    }
    let sk = sales::scope_key(ctx)?;
    let total: i64 = c.query_row(
        "SELECT count(*) FROM inventory_movements WHERE producto_id=?1 AND scope_key=?2",
        (pid, &sk),
        |r| r.get(0),
    )?;
    let mut q=c.prepare("SELECT m.effect_id,m.owner_operation_id,m.kind,m.delta_qty,m.absolute_qty,json_extract(CAST(j.canonical_bytes AS TEXT),'$.originAtUtcMs'),coalesce(json_extract(CAST(j.canonical_bytes AS TEXT),'$.payload.document.reason'),m.kind),coalesce(o.state,'APPLIED') FROM inventory_movements m JOIN operation_journal j ON j.operation_id=m.owner_operation_id LEFT JOIN outbox o ON o.operation_id=j.operation_id WHERE m.producto_id=?1 AND m.scope_key=?2 ORDER BY j.local_seq DESC,m.effect_id LIMIT 50 OFFSET ?3")?;
    let rows=q.query_map((pid,&sk,(page as i64-1)*50),|r|Ok(json!({"id":r.get::<_,String>(0)?,"operationId":r.get::<_,String>(1)?,"kind":r.get::<_,String>(2)?,"delta":r.get::<_,String>(3)?,"absolute":r.get::<_,Option<String>>(4)?,"dateMs":r.get::<_,String>(5)?,"reason":r.get::<_,String>(6)?,"remoteStatus":r.get::<_,String>(7)?})))?.collect::<Result<Vec<_>,_>>()?;
    Ok(
        json!({"rows":rows,"page":page,"pageSize":50,"total":total.to_string(),"coverage":"LOCAL_NATIVE_ONLY"}),
    )
}
