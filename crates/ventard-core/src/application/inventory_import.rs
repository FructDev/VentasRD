//! Conservative native import. Frozen plan first, atomic local product + count
//! per row. Uses existing product/count wire protocols; no legacy DB adoption.
use super::{
    errors::{AppError, AuthError, BusinessError, ProtocolError},
    inventory::{self, ProductDefinition},
    management::Command,
    operations, sales, sales_sync,
};
use crate::{
    domain::{canonical::canonicalize, identity::EntityId},
    security::offline_grant::VerifiedGrant,
    storage::catalogue_preview::CatalogueContext,
};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Row {
    pub row: u32,
    pub name: String,
    pub code: Option<String>,
    pub price: Option<String>,
    pub cost: Option<String>,
    pub stock: Option<String>,
    pub minimum: Option<String>,
    pub location: Option<String>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Batch {
    pub operation_id: String,
    pub file_name: String,
    pub duplicate_policy: String,
    pub new_tax_percent: String,
    pub rows: Vec<Row>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Item {
    row: u32,
    name: String,
    state: String,
    error: Option<String>,
    created: bool,
    product: Option<Command>,
    stock: Option<Command>,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Plan {
    operation_id: String,
    file_name: String,
    context: CatalogueContext,
    permission_grant_id: String,
    captured_at_ms: String,
    state: String,
    items: Vec<Item>,
}
fn invalid() -> AppError {
    AppError::Protocol(ProtocolError::MalformedPayload)
}
fn guard(code: &str) -> AppError {
    AppError::Business(BusinessError::SaleGuard { code: code.into() })
}
fn ctx(g: &VerifiedGrant) -> CatalogueContext {
    let p = g.payload();
    CatalogueContext {
        tenant_id: p.tenant_id.clone(),
        actor_id: p.actor_id.clone(),
        installation_id: p.installation_id.clone(),
        device_id: p.device_id.clone(),
        writer_epoch: p.writer_epoch.clone(),
        scope_type: p.scope.r#type.clone(),
        branch_id: p.scope.branch_id.clone(),
    }
}
fn key(ctx: &CatalogueContext) -> Result<String, AppError> {
    serde_json::to_string(ctx).map_err(|_| invalid())
}
fn authorize(
    c: &Connection,
    g: &VerifiedGrant,
    now: u64,
    high: u64,
    opens: u64,
) -> Result<(CatalogueContext, String), AppError> {
    let d = g.evaluate(now, high, opens).map_err(|_| invalid())?;
    if !d.allows("MANAGE") {
        return Err(AppError::Auth(AuthError::PermissionDenied {
            required: "MANAGE".into(),
        }));
    }
    let x = ctx(g);
    if !sales_sync::operational(c, &x)? {
        return Err(guard("LEGACY_NOT_VERIFIABLE"));
    }
    Ok((x, d.effective_time_ms))
}
/// No floating point, rounding, malformed grouping or silent invalid-to-zero.
fn number(v: &str, money: bool) -> Result<String, AppError> {
    let raw = v.trim();
    let raw = if money {
        raw.strip_prefix("RD$")
            .or_else(|| raw.strip_prefix('$'))
            .unwrap_or(raw)
            .trim()
    } else {
        raw
    };
    let parts: Vec<_> = raw.split('.').collect();
    if parts.is_empty() || parts.len() > 2 || !money && parts.len() > 1 {
        return Err(guard("IMPORT_INVALID_NUMBER"));
    }
    let groups: Vec<_> = parts[0].split(',').collect();
    if groups.len() > 1
        && (!money
            || groups[0].is_empty()
            || groups[0].len() > 3
            || groups[1..].iter().any(|s| s.len() != 3))
    {
        return Err(guard("IMPORT_INVALID_NUMBER"));
    }
    let whole = groups.concat();
    if whole.is_empty() || !whole.bytes().all(|b| b.is_ascii_digit()) {
        return Err(guard("IMPORT_INVALID_NUMBER"));
    }
    let n = whole
        .parse::<u64>()
        .map_err(|_| guard("IMPORT_INVALID_NUMBER"))?;
    let fraction = parts.get(1).copied().unwrap_or("");
    if parts.len() == 2 && (fraction.is_empty() || fraction.len() > 2)
        || !fraction.bytes().all(|b| b.is_ascii_digit())
    {
        return Err(guard("IMPORT_INVALID_NUMBER"));
    }
    let value = if money {
        n.checked_mul(100).and_then(|n| {
            n.checked_add(if fraction.is_empty() {
                0
            } else {
                fraction.parse::<u64>().unwrap() * if fraction.len() == 1 { 10 } else { 1 }
            })
        })
    } else {
        Some(n)
    }
    .ok_or_else(|| guard("IMPORT_INVALID_NUMBER"))?;
    if value > if money { 999999999999 } else { i32::MAX as u64 } {
        return Err(guard("IMPORT_INVALID_NUMBER"));
    }
    Ok(value.to_string())
}
fn optional(v: &Option<String>, money: bool) -> Result<Option<String>, AppError> {
    v.as_deref()
        .filter(|v| !v.trim().is_empty())
        .map(|v| number(v, money))
        .transpose()
}
fn text(v: &str, max: usize, empty: bool) -> Result<(), AppError> {
    if v.trim() != v
        || (!empty && v.is_empty())
        || v.chars().count() > max
        || v.chars().any(char::is_control)
    {
        Err(invalid())
    } else {
        Ok(())
    }
}
fn opt_text(v: &Value) -> Option<String> {
    v.as_str().map(str::to_owned)
}
fn load(c: &Connection, context: &CatalogueContext, id: &str) -> Result<Plan, AppError> {
    EntityId::parse(id).map_err(|_| invalid())?;
    let row: Option<(String, String)> = c
        .query_row(
            "SELECT context_key,plan FROM native_inventory_import_v1 WHERE operation_id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let (k, v) = row.ok_or_else(|| guard("IMPORT_NOT_FOUND"))?;
    if k != key(context)? {
        return Err(guard("IMPORT_CONTEXT_MISMATCH"));
    }
    serde_json::from_str(&v).map_err(|_| invalid())
}
fn summary(p: &Plan) -> Result<Value, AppError> {
    let count = |state: &str| {
        p.items
            .iter()
            .filter(|i| i.state == state)
            .count()
            .to_string()
    };
    Ok(
        json!({"operationId":p.operation_id,"fileName":p.file_name,"capturedAtMs":p.captured_at_ms,"state":p.state,"ready":count("READY"),"remaining":p.items.iter().filter(|i|matches!(i.state.as_str(),"READY"|"ERROR")).count().to_string(),"created":p.items.iter().filter(|i|i.state=="DONE"&&i.created).count().to_string(),"updated":p.items.iter().filter(|i|i.state=="DONE"&&!i.created).count().to_string(),"invalid":count("INVALID"),"skipped":count("SKIPPED"),"rows":p.items.iter().map(|i|json!({"row":i.row,"name":i.name,"state":i.state,"error":i.error,"created":i.created,"definition":i.product.as_ref().and_then(|q|if let Command::ProductSave{definition,..}=q{Some(definition)}else{None}),"stock":i.stock.as_ref().and_then(|q|if let Command::InventoryChange{quantity,..}=q{Some(quantity)}else{None})})).collect::<Vec<_>>(),"coverage":"LOCAL_NATIVE_PER_ROW_ATOMIC_REMOTE_OPERATIONS_PENDING"}),
    )
}
pub fn list(
    c: &Connection,
    g: &VerifiedGrant,
    now: u64,
    high: u64,
    opens: u64,
) -> Result<Value, AppError> {
    let (x, _) = authorize(c, g, now, high, opens)?;
    let mut q=c.prepare("SELECT plan FROM native_inventory_import_v1 WHERE context_key=?1 ORDER BY rowid DESC LIMIT 20")?;
    let mut rows = vec![];
    for v in q.query_map([key(&x)?], |r| r.get::<_, String>(0))? {
        rows.push(summary(&serde_json::from_str(&v?).map_err(|_| invalid())?)?)
    }
    Ok(json!({"rows":rows}))
}
pub fn prepare(
    c: &mut Connection,
    g: &VerifiedGrant,
    now: u64,
    high: u64,
    opens: u64,
    b: Batch,
) -> Result<Value, AppError> {
    let (x, date) = authorize(c, g, now, high, opens)?;
    EntityId::parse(&b.operation_id).map_err(|_| invalid())?;
    text(&b.file_name, 256, false)?;
    if b.rows.is_empty()
        || b.rows.len() > 500
        || !matches!(b.duplicate_policy.as_str(), "SKIP" | "UPDATE")
        || !matches!(b.new_tax_percent.as_str(), "0" | "18")
    {
        return Err(invalid());
    }
    if b.rows.iter().any(|r| {
        r.name.len() > 1024
            || [
                &r.code,
                &r.price,
                &r.cost,
                &r.stock,
                &r.minimum,
                &r.location,
            ]
            .into_iter()
            .flatten()
            .any(|v| v.len() > 1024)
            || r.name.len()
                + [
                    &r.code,
                    &r.price,
                    &r.cost,
                    &r.stock,
                    &r.minimum,
                    &r.location,
                ]
                .into_iter()
                .flatten()
                .map(|v| v.len())
                .sum::<usize>()
                > 2048
    }) {
        return Err(invalid());
    }
    let (_, hash) =
        canonicalize(&serde_json::to_vec(&b).map_err(|_| invalid())?).map_err(|_| invalid())?;
    let old: Option<String> = c
        .query_row(
            "SELECT input_hash FROM native_inventory_import_v1 WHERE operation_id=?1",
            [&b.operation_id],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(old) = old {
        if old != hash {
            return Err(AppError::Protocol(ProtocolError::OperationIdConflict));
        }
        return summary(&load(c, &x, &b.operation_id)?);
    }
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let sk = sales::scope_key(&x)?;
    let mut q=tx.prepare("SELECT producto_id,name,coalesce(barcode,'') FROM products WHERE tenant_id=?1 AND tombstone=0")?;
    let existing = q
        .query_map([&x.tenant_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    drop(q);
    let mut names = HashSet::new();
    let mut codes = HashSet::new();
    let mut targets = HashSet::new();
    let mut row_numbers = HashSet::new();
    let mut items = vec![];
    for r in &b.rows {
        if r.row < 2 || !row_numbers.insert(r.row) {
            return Err(invalid());
        }
        let mut item = Item {
            row: r.row,
            name: r.name.trim().into(),
            state: "READY".into(),
            error: None,
            created: false,
            product: None,
            stock: None,
        };
        let planned = (|| -> Result<(), AppError> {
            text(&item.name, 256, false)?;
            let code = r.code.as_deref().map(str::trim).filter(|v| !v.is_empty());
            if let Some(code) = code {
                text(code, 64, true)?
            }
            let lowered = item.name.to_lowercase();
            if !names.insert(lowered.clone()) || code.is_some_and(|v| !codes.insert(v.to_owned())) {
                item.state = "SKIPPED".into();
                item.error = Some("IMPORT_DUPLICATE_IN_FILE".into());
                return Ok(());
            }
            let by_code: Vec<_> = existing
                .iter()
                .filter(|p| code.is_some_and(|code| p.2 == code))
                .collect();
            let by_name: Vec<_> = existing
                .iter()
                .filter(|p| p.1.trim().to_lowercase() == lowered)
                .collect();
            if by_code.len() > 1
                || by_code.is_empty() && by_name.len() > 1
                || !by_code.is_empty() && by_name.iter().any(|p| p.0 != by_code[0].0)
            {
                return Err(guard("IMPORT_AMBIGUOUS_PRODUCT"));
            }
            let found = by_code.first().or_else(|| by_name.first()).copied();
            if let Some(p) = found {
                if !targets.insert(p.0.clone()) {
                    item.state = "SKIPPED".into();
                    item.error = Some("IMPORT_DUPLICATE_IN_FILE".into());
                    return Ok(());
                }
                if b.duplicate_policy == "SKIP" {
                    item.state = "SKIPPED".into();
                    return Ok(());
                }
            }
            let pid = found
                .map(|p| p.0.clone())
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
            let op = uuid::Uuid::new_v4().to_string();
            let old = found
                .map(|_| inventory::product(&tx, &x, &pid))
                .transpose()?;
            item.created = old.is_none();
            let meta = old.as_ref().map(|o| &o["metadata"]);
            let prices = old.as_ref().map(|o| &o["priceTiers"]);
            let stock = optional(&r.stock, false)?;
            let minimum = optional(&r.minimum, false)?;
            let price = optional(&r.price, true)?;
            let cost = optional(&r.cost, true)?;
            if old.is_some()
                && ((prices.is_some_and(|v| v["retailCents"].is_null()) && price.is_none())
                    || (meta.is_some_and(|m| m["minimum"].is_null()) && minimum.is_none())
                    || (meta.is_some_and(|m| m["location"].is_null()) && r.location.is_none())
                    || meta.is_some_and(|m| !m["serialRequired"].is_boolean()))
            {
                return Err(guard("IMPORT_MISSING_METADATA"));
            }
            let kind = meta
                .and_then(|m| m["productType"].as_str())
                .unwrap_or("simple");
            let serialized = meta
                .and_then(|m| m["serialRequired"].as_bool())
                .unwrap_or(false);
            if old.is_some()
                && meta.is_some_and(|m| !m["recipe"].as_array().is_some_and(Vec::is_empty))
                || stock.is_some() && (serialized || kind == "combo")
            {
                return Err(guard("IMPORT_ADVANCED_PRODUCT"));
            }
            let tax = if let Some(m) = meta {
                let n = m["taxRate"]["numerator"]
                    .as_str()
                    .ok_or_else(invalid)?
                    .parse::<u64>()
                    .map_err(|_| invalid())?;
                let d = m["taxRate"]["denominator"]
                    .as_str()
                    .ok_or_else(invalid)?
                    .parse::<u64>()
                    .map_err(|_| invalid())?;
                if d == 0 || n.checked_mul(100).ok_or_else(invalid)? % d != 0 {
                    return Err(invalid());
                }
                (n * 100 / d).to_string()
            } else {
                b.new_tax_percent.clone()
            };
            let definition = ProductDefinition {
                name: item.name.clone(),
                code: code
                    .map(str::to_owned)
                    .or_else(|| old.as_ref().and_then(|p| opt_text(&p["code"])))
                    .unwrap_or_default(),
                price_cents: price
                    .or_else(|| prices.and_then(|p| opt_text(&p["retailCents"])))
                    .unwrap_or("0".into()),
                cost_cents: Some(
                    cost.or_else(|| meta.and_then(|m| opt_text(&m["costCents"])))
                        .unwrap_or("0".into()),
                ),
                tier2_cents: prices.and_then(|p| opt_text(&p["tier2Cents"])),
                tier3_cents: prices.and_then(|p| opt_text(&p["tier3Cents"])),
                tax_percent: tax,
                product_type: kind.into(),
                location: r
                    .location
                    .as_ref()
                    .map(|s| s.trim().to_owned())
                    .or_else(|| meta.and_then(|m| opt_text(&m["location"])))
                    .unwrap_or_default(),
                minimum: minimum
                    .or_else(|| meta.and_then(|m| opt_text(&m["minimum"])))
                    .unwrap_or("0".into()),
                serial_required: serialized,
                recipe: vec![],
            };
            if old.is_some()
                && (meta.is_some_and(|m| m["costCents"].is_null())
                    && r.cost.as_deref().is_none_or(|s| s.trim().is_empty())
                    || meta.is_some_and(|m| m["productType"].is_null()))
            {
                return Err(guard("IMPORT_MISSING_METADATA"));
            }
            let req = Command::ProductSave {
                operation_id: op.clone(),
                product_id: pid.clone(),
                expected_revision: old
                    .as_ref()
                    .and_then(|p| opt_text(&p["revision"]))
                    .unwrap_or("0".into()),
                definition,
            };
            inventory::document(&tx, &x, &req)?;
            if let Some(n) = stock {
                let expected = if old.is_some() {
                    sales::stock(&tx, &pid, &sk)?.1
                } else {
                    canonicalize(&serde_json::to_vec(&json!({"quantity":"0","remoteSequence":"0","pending":[{"operationId":op,"effectId":sales::effect_id(&op,&format!("stock/{pid}")),"delta":"0"}]})).map_err(|_|invalid())?).map_err(|_|invalid())?.1
                };
                item.stock = Some(Command::InventoryChange {
                    operation_id: uuid::Uuid::new_v4().to_string(),
                    product_id: pid,
                    expected_stock_revision: expected,
                    mode: "COUNT".into(),
                    quantity: n,
                    reason: format!("Importación fila {}", r.row),
                    serials: vec![],
                })
            }
            item.product = Some(req);
            Ok(())
        })();
        if let Err(e) = planned {
            item.state = "INVALID".into();
            item.error = Some(e.code().into());
            item.product = None;
            item.stock = None
        }
        items.push(item);
    }
    let p = Plan {
        operation_id: b.operation_id.clone(),
        file_name: b.file_name,
        context: x,
        permission_grant_id: g.payload().grant_id.clone(),
        captured_at_ms: date,
        state: "PREPARED".into(),
        items,
    };
    tx.execute(
        "INSERT INTO native_inventory_import_v1 VALUES(?1,?2,?3,?4)",
        (
            &b.operation_id,
            key(&p.context)?,
            hash,
            serde_json::to_string(&p).map_err(|_| invalid())?,
        ),
    )?;
    tx.commit()?;
    summary(&p)
}
fn apply_row(tx: &rusqlite::Transaction<'_>, p: &Plan, item: &Item) -> Result<(), AppError> {
    for req in [&item.product, &item.stock].into_iter().flatten() {
        let request = serde_json::to_value(req).map_err(|_| invalid())?;
        let op = request["operationId"].as_str().ok_or_else(invalid)?;
        let (kind, doc) = inventory::document(tx, &p.context, req)?;
        let x = &p.context;
        let sk = sales::scope_key(x)?;
        let origin = sk.split_once('/').ok_or_else(invalid)?.1;
        let intent = json!({"protocol":"ventard.native.v1","kind":kind,"contractVersion":1,"canonicalizationVersion":"C-N1","operationId":op,"negocioId":x.tenant_id,"scope":{"type":x.scope_type,"sucursalId":x.branch_id},"originDeviceId":x.device_id,"installationId":x.installation_id,"writerEpoch":x.writer_epoch,"actorId":x.actor_id,"permissionGrantId":p.permission_grant_id,"originalTurnId":null,"originAtUtcMs":p.captured_at_ms,"expectedVersions":{},"dependencies":[],"payload":{"request":request,"document":doc}});
        let (bytes, hash) = canonicalize(&serde_json::to_vec(&intent).map_err(|_| invalid())?)
            .map_err(|_| invalid())?;
        operations::prepare_in_transaction(
            tx,
            op,
            "ventard.native.v1",
            &kind,
            1,
            bytes.as_bytes(),
            &hash,
            &x.actor_id,
            origin,
            &x.device_id,
            x.writer_epoch.parse().map_err(|_| invalid())?,
            &p.captured_at_ms,
        )?;
        inventory::apply(tx, x, &intent, false)?;
        tx.execute(
            "INSERT INTO outbox(operation_id,envelope,state) VALUES(?1,?2,'PENDING')",
            (op, bytes.as_bytes()),
        )?;
        operations::commit_in_transaction(
            tx,
            op,
            &json!({"operationId":op,"kind":kind,"remoteStatus":"PENDING","document":doc}),
        )?;
    }
    Ok(())
}
pub fn run(
    c: &mut Connection,
    g: &VerifiedGrant,
    now: u64,
    high: u64,
    opens: u64,
    id: &str,
) -> Result<Value, AppError> {
    let (x, _) = authorize(c, g, now, high, opens)?;
    let mut p = load(c, &x, id)?;
    if p.state == "FINISHED" {
        return summary(&p);
    }
    let indices = p
        .items
        .iter()
        .enumerate()
        .filter(|(_, i)| matches!(i.state.as_str(), "READY" | "ERROR"))
        .map(|(n, _)| n)
        .collect::<Vec<_>>();
    let mut indices = indices;
    indices.sort_by_key(|n| p.items[*n].state == "ERROR");
    indices.truncate(20);
    for n in indices {
        let result = (|| -> Result<(), AppError> {
            let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
            apply_row(&tx, &p, &p.items[n])?;
            let mut updated = p.items.clone();
            updated[n].state = "DONE".into();
            updated[n].error = None;
            let mut wire = serde_json::to_value(&p).map_err(|_| invalid())?;
            wire["items"] = serde_json::to_value(&updated).map_err(|_| invalid())?;
            tx.execute(
                "UPDATE native_inventory_import_v1 SET plan=?2 WHERE operation_id=?1",
                (id, wire.to_string()),
            )?;
            tx.commit()?;
            Ok(())
        })();
        match result {
            Ok(()) => {
                p.items[n].state = "DONE".into();
                p.items[n].error = None
            }
            Err(e) => {
                p.items[n].state = "ERROR".into();
                p.items[n].error = Some(e.code().into());
                c.execute(
                    "UPDATE native_inventory_import_v1 SET plan=?2 WHERE operation_id=?1",
                    (id, serde_json::to_string(&p).map_err(|_| invalid())?),
                )?;
            }
        }
    }
    if !p
        .items
        .iter()
        .any(|i| matches!(i.state.as_str(), "READY" | "ERROR"))
    {
        p.state = "FINISHED".into();
        c.execute(
            "UPDATE native_inventory_import_v1 SET plan=?2 WHERE operation_id=?1",
            (id, serde_json::to_string(&p).map_err(|_| invalid())?),
        )?;
    }
    summary(&p)
}
pub fn stop(
    c: &mut Connection,
    g: &VerifiedGrant,
    now: u64,
    high: u64,
    opens: u64,
    id: &str,
) -> Result<Value, AppError> {
    let (x, _) = authorize(c, g, now, high, opens)?;
    let mut p = load(c, &x, id)?;
    for row in &mut p.items {
        if matches!(row.state.as_str(), "READY" | "ERROR") {
            row.state = "SKIPPED".into();
            row.error = Some("IMPORT_STOPPED_UNAPPLIED".into())
        }
    }
    p.state = "FINISHED".into();
    c.execute(
        "UPDATE native_inventory_import_v1 SET plan=?2 WHERE operation_id=?1",
        (id, serde_json::to_string(&p).map_err(|_| invalid())?),
    )?;
    summary(&p)
}
