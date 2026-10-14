//! Trusted operational bootstrap and whole-sale receipt/inbox. No HTTP, clocks,
//! credentials or renderer-supplied stock. The shell obtains server evidence.
use super::{
    errors::{AppError, ProtocolError},
    sales::{effect_id, scope_key},
};
use crate::{
    domain::{canonical::canonicalize, identity::EntityId, money::MoneyCents},
    storage::catalogue_preview::{self, CatalogueContext},
};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};
fn invalid() -> AppError {
    AppError::Protocol(ProtocolError::MalformedPayload)
}
fn conflict() -> AppError {
    AppError::Protocol(ProtocolError::OperationIdConflict)
}
fn text(v: &Value) -> Result<&str, AppError> {
    v.as_str().ok_or_else(invalid)
}
fn integer(v: &Value) -> Result<i64, AppError> {
    let s = text(v)?;
    let n = s.parse::<i64>().map_err(|_| invalid())?;
    if !(0..=9_007_199_254_740_991).contains(&n) || n.to_string() != s {
        return Err(invalid());
    }
    Ok(n)
}
fn bytes(v: &Value) -> Result<(String, String), AppError> {
    canonicalize(&serde_json::to_vec(v).map_err(|_| invalid())?).map_err(|_| invalid())
}
fn array(v: &Value) -> Result<&Vec<Value>, AppError> {
    v.as_array().ok_or_else(invalid)
}
pub fn sale_result(
    c: &Connection,
    ctx: &CatalogueContext,
    op: &str,
) -> Result<Option<Value>, AppError> {
    EntityId::parse(op).map_err(|_| invalid())?;
    let raw:Option<String>=c.query_row("SELECT result FROM operation_journal WHERE operation_id=?1 AND origin_actor=?2 AND origin_device=?3 AND origin_epoch=?4 AND json_extract(CAST(canonical_bytes AS TEXT),'$.negocioId')=?5 AND json_extract(CAST(canonical_bytes AS TEXT),'$.installationId')=?6 AND local_state='COMMITTED'",(op,&ctx.actor_id,&ctx.device_id,&ctx.writer_epoch,&ctx.tenant_id,&ctx.installation_id),|r|r.get(0)).optional()?;
    raw.map(|s| {
        let mut v: Value = serde_json::from_str(&s).map_err(|_| invalid())?;
        let status: Option<String> = c
            .query_row(
                "SELECT state FROM outbox WHERE operation_id=?1",
                [op],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(s) = status {
            v["remoteStatus"] = json!(s)
        }
        Ok(v)
    })
    .transpose()
}
pub fn read(c: &Connection, ctx: &CatalogueContext) -> Result<Value, AppError> {
    if !operational(c, ctx)? {
        return Ok(Value::Null);
    }
    let sk = scope_key(ctx)?;
    let mut q=c.prepare("SELECT p.producto_id,p.name,p.barcode,p.price_tiers,p.metadata,p.revision,s.effective_stock,s.authority_state FROM products p JOIN stock_projections s ON s.producto_id=p.producto_id AND s.scope_key=?2 WHERE p.tenant_id=?1 AND p.tombstone=0 ORDER BY p.name,p.producto_id LIMIT 10000")?;
    let rows = q
        .query_map((&ctx.tenant_id, &sk), |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, i64>(5)?,
                r.get::<_, String>(6)?,
                r.get::<_, String>(7)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut products = vec![];
    for (id, name, code, prices, metadata, revision, stock, state) in rows {
        let price: Value = serde_json::from_str(&prices).map_err(|_| invalid())?;
        let meta: Value = serde_json::from_str(&metadata).map_err(|_| invalid())?;
        let mut product = json!({"id":id,"name":name,"code":code.unwrap_or_default(),"priceCents":price["retailCents"],"stock":if state=="VERIFIED"{stock}else{String::new()},"revision":revision.to_string(),"kind":if array(&meta["recipe"] )?.is_empty(){"simple"}else{"combo"},"preview":{"priceVerifiable":price["retailCents"].is_string(),"stockVerifiable":state=="VERIFIED","stockEvidence":if state=="VERIFIED"{"VERIFIED_NATIVE_BASE_PLUS_PENDING"}else{"MISSING_OR_DIVERGENT_AUTHORITY"}}});
        let cost = super::inventory::cost(c, ctx, &id)?;
        product["costCents"] = json!(cost.map(|n| n.to_dto()));
        let margin = cost.and_then(|n| {
            price["retailCents"]
                .as_str()
                .and_then(|p| MoneyCents::parse_dto(p).ok())
                .and_then(|p| p.checked_sub(n).ok())
        });
        product["marginCents"] = json!(margin.map(|n| n.to_dto()));
        product["possibleStock"] = json!(super::inventory::possible_stock(c, ctx, &id)?);
        product["tier2Cents"] = price["tier2Cents"].clone();
        product["tier3Cents"] = price["tier3Cents"].clone();
        product["taxRate"] = meta["taxRate"].clone();
        product["serialRequired"] = meta["serialRequired"].clone();
        product["recipe"] = meta["recipe"].clone();
        product["minimum"] = meta["minimum"].clone();
        product["location"] = meta["location"].clone();
        product["locationKnown"] = json!(meta.get("location").is_some());
        if let Some(data) = meta["photo"]["data"].as_str() {
            super::settings::validate_png(data)?;
            product["photo"] = json!(data);
        }
        if meta["productType"].is_string() {
            product["kind"] = meta["productType"].clone();
        } else if array(&meta["recipe"])?.is_empty() {
            // Older manifests did not distinguish retail products from supplies.
            product.as_object_mut().ok_or_else(invalid)?.remove("kind");
        }
        product["stockRevision"] = if state == "VERIFIED" {
            json!(super::sales::stock(c, &id, &sk)?.1)
        } else {
            Value::Null
        };
        if meta["serialRequired"] == true {
            let mut serials=c.prepare("SELECT serial FROM sale_serial_inventory_v1 WHERE tenant_id=?1 AND scope_key=?2 AND producto_id=?3 AND state='AVAILABLE' ORDER BY serial LIMIT 1000")?;
            product["availableSerials"] = json!(serials
                .query_map((&ctx.tenant_id, &sk, &id), |r| r.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?);
        }
        products.push(product);
    }
    let sales: i64 = c.query_row(
        "SELECT count(*) FROM sales WHERE tenant_id=?1 AND scope_key=?2",
        (&ctx.tenant_id, &sk),
        |r| r.get(0),
    )?;
    let mut capital = 0i128;
    let mut unknown_capital = 0u32;
    let mut low = 0u32;
    let mut known_minimum = 0u32;
    let mut best: Option<(&Value, i64)> = None;
    for p in &products {
        let units = if p["kind"] == "combo" {
            p["possibleStock"].as_str()
        } else {
            p["stock"].as_str().filter(|s| !s.is_empty())
        };
        if let (Some(q), Some(m)) = (units, p["minimum"].as_str()) {
            let q = q.parse::<i32>().map_err(|_| invalid())?;
            let m = m.parse::<i32>().map_err(|_| invalid())?;
            known_minimum += 1;
            if q > 0 && q <= m {
                low += 1;
            }
        }
        if p["kind"] != "combo" {
            match (units, p["costCents"].as_str()) {
                (Some(q), Some(cost)) => {
                    capital += q.parse::<i32>().map_err(|_| invalid())? as i128
                        * MoneyCents::parse_dto(cost).map_err(|_| invalid())?.cents() as i128
                }
                (Some("0"), None) => {}
                _ => unknown_capital += 1,
            }
        }
        if p["kind"] == "simple" {
            if let Some(m) = p["marginCents"].as_str() {
                let n = MoneyCents::parse_dto(m).map_err(|_| invalid())?.cents();
                if best.as_ref().is_none_or(|(_, v)| n > *v) {
                    best = Some((p, n));
                }
            }
        }
    }
    let inventory_summary = json!({"lowCount":low.to_string(),"minimumCoverage":known_minimum.to_string(),"capitalCents":if unknown_capital==0{MoneyCents::from_i128(capital).ok().map(|n|n.to_dto())}else{None},"unknownCapitalProducts":unknown_capital.to_string(),"bestMargin":best.map(|(p,n)|json!({"name":p["name"],"amountCents":n.to_string()}))});
    let cash:i64=c.query_row("SELECT COALESCE(sum(e.amount_cents),0) FROM sale_cash_entries_v1 e JOIN cash_turns t ON t.turn_id=e.turn_id WHERE t.tenant_id=?1 AND t.scope_key=?2 AND t.status='OPEN'",(&ctx.tenant_id,&sk),|r|r.get(0))?;
    let pending:i64=c.query_row("SELECT count(*) FROM outbox o JOIN operation_journal j ON j.operation_id=o.operation_id WHERE o.state<>'APPLIED' AND json_extract(CAST(j.canonical_bytes AS TEXT),'$.negocioId')=?1 AND j.origin_scope=?2",(&ctx.tenant_id,sk.strip_prefix(&format!("{}/",ctx.tenant_id)).ok_or_else(invalid)?),|r|r.get(0))?;
    let last:Option<String>=c.query_row("SELECT operation_id FROM sales WHERE tenant_id=?1 AND scope_key=?2 AND actor_id=?3 ORDER BY rowid DESC LIMIT 1",(&ctx.tenant_id,&sk,&ctx.actor_id),|r|r.get(0)).optional()?;
    let prepared:Option<Vec<u8>>=c.query_row("SELECT canonical_bytes FROM operation_journal WHERE kind='SALE_CONFIRM' AND local_state='PREPARED' AND origin_actor=?1 AND origin_device=?2 AND json_extract(CAST(canonical_bytes AS TEXT),'$.negocioId')=?3 ORDER BY local_seq DESC LIMIT 1",(&ctx.actor_id,&ctx.device_id,&ctx.tenant_id),|r|r.get(0)).optional()?;
    let attempt = prepared
        .map(|b| {
            serde_json::from_slice::<Value>(&b)
                .map(|v| v["payload"]["request"].clone())
                .map_err(|_| invalid())
        })
        .transpose()?;
    let mut failure=c.prepare("SELECT o.operation_id,o.state,coalesce(f.code,'PENDING') FROM outbox o JOIN operation_journal j ON j.operation_id=o.operation_id LEFT JOIN native_sales_failures_v1 f ON f.operation_id=o.operation_id WHERE o.state<>'APPLIED' AND json_extract(CAST(j.canonical_bytes AS TEXT),'$.negocioId')=?1 ORDER BY j.local_seq LIMIT 100")?;
    let issues=failure.query_map([&ctx.tenant_id],|r|Ok(json!({"operationId":r.get::<_,String>(0)?,"state":r.get::<_,String>(1)?,"code":r.get::<_,String>(2)?})))?.collect::<Result<Vec<_>,_>>()?;
    let stock_state:String=c.query_row("SELECT json_group_array(json_array(producto_id,remote_base_qty,remote_seq,pending_coverage,effective_stock,authority_state)) FROM (SELECT * FROM stock_projections WHERE scope_key=?1 ORDER BY producto_id)",[&sk],|r|r.get(0))?;
    let customer_state:String=c.query_row("SELECT json_group_array(json_array(customer_id,name,balance_cents,limit_cents,revision,active,metadata_revision,price_tier)) FROM (SELECT a.*,coalesce(m.revision,1) metadata_revision,coalesce(p.tier,1) price_tier FROM sale_customer_accounts_v1 a LEFT JOIN native_customer_metadata_v1 m ON m.customer_id=a.customer_id AND m.tenant_id=a.tenant_id LEFT JOIN native_sales_customer_pricing_v1 p ON p.customer_id=a.customer_id AND p.tenant_id=a.tenant_id WHERE a.tenant_id=?1 ORDER BY a.customer_id)",[&ctx.tenant_id],|r|r.get(0))?;
    let turn_state:String=c.query_row("SELECT json_group_array(json_array(t.turn_id,t.status,t.revision,coalesce(r.remote_sequence,0))) FROM cash_turns t LEFT JOIN native_sales_receipts_v1 r ON r.operation_id=t.operation_id WHERE t.tenant_id=?1 AND t.scope_key=?2",(&ctx.tenant_id,&sk),|r|r.get(0))?;
    let business: Option<String> = c
        .query_row(
            "SELECT profile FROM native_business_profile_v1 WHERE tenant_id=?1",
            [&ctx.tenant_id],
            |r| r.get(0),
        )
        .optional()?;
    let business: Value = business
        .map(|raw| serde_json::from_str(&raw).map_err(|_| invalid()))
        .transpose()?
        .unwrap_or(Value::Null);
    let scope_revision = {
        let management_state:String=c.query_row("SELECT json_array((SELECT count(*) FROM native_management_records_v1 WHERE tenant_id=?1 AND scope_key=?2),(SELECT max(rowid) FROM native_management_records_v1 WHERE tenant_id=?1 AND scope_key=?2),(SELECT max(remote_sequence) FROM native_sales_receipts_v1 WHERE tenant_id=?1 AND scope_key=?2),(SELECT sequence FROM native_sales_cursor_v1 WHERE tenant_id=?1 AND scope_key=?2))",(&ctx.tenant_id,&sk),|r|r.get(0))?;
        bytes(&json!({"products":products,"stock":stock_state,"customers":customer_state,"turn":turn_state,"management":management_state,"business":business,"settingsSupported":super::settings::supported(c,ctx)?}))?.1
    };
    Ok(
        json!({"status":"ready","mode":"staging-operational","supportsDrafts":true,"inventoryReadOnly":true,"inventorySummary":inventory_summary,"scopeRevision":scope_revision,"business":business,"defaultWarrantyDays":super::warranties::defaults(c,ctx)?["days"],"products":products,"confirmedSales":sales.to_string(),"cashCents":cash.to_string(),"pendingOperations":pending.to_string(),"lastResult":last.map(|id|sale_result(c,ctx,&id)).transpose()?.flatten(),"pendingAttempt":attempt,"carts":super::drafts::read(c,ctx)?,"customers":super::sales::customers(c,ctx)?,"syncIssues":issues}),
    )
}
pub fn operational(c: &Connection, ctx: &CatalogueContext) -> Result<bool, AppError> {
    catalogue_preview::key(ctx).map_err(|_| invalid())?;
    Ok(c.query_row(
        "SELECT EXISTS(SELECT 1 FROM native_sales_cursor_v1 WHERE tenant_id=?1 AND scope_key=?2)",
        (&ctx.tenant_id, scope_key(ctx)?),
        |r| r.get(0),
    )?)
}
fn manifest_valid(ctx: &CatalogueContext, m: &Value, now: u64) -> Result<(), AppError> {
    catalogue_preview::key(ctx).map_err(|_| invalid())?;
    EntityId::parse(text(&m["snapshotId"])?).map_err(|_| invalid())?;
    if m["version"] != "ventard.native.operational.1"
        || m["namespace"] != "NATIVE1"
        || m["coverage"] != "QA_SYNTHETIC_ADOPTED"
        || m["context"] != serde_json::to_value(ctx).map_err(|_| invalid())?
    {
        return Err(invalid());
    }
    let captured = integer(&m["capturedAtMs"])? as u64;
    let expiry = integer(&m["expiresAtMs"])? as u64;
    if now >= expiry
        || captured.saturating_sub(now) > 5000
        || expiry <= captured
        || expiry - captured > 86_400_000
    {
        return Err(invalid());
    }
    integer(&m["watermark"])?;
    integer(&m["lastTicket"])?;
    if m["ticketPrefix"] != format!("N{}", ctx.installation_id.replace('-', "")) {
        return Err(invalid());
    }
    let pages = array(&m["pages"])?;
    if pages.len() > 300 {
        return Err(invalid());
    }
    let mut count = 0;
    for (i, p) in pages.iter().enumerate() {
        if p["index"] != i
            || p["count"].as_u64().is_none_or(|n| n == 0 || n > 200)
            || p["byteLength"]
                .as_u64()
                .is_none_or(|n| n == 0 || n > 1_048_576)
            || text(&p["sha256"])?.len() != 64
        {
            return Err(invalid());
        }
        count += p["count"].as_u64().ok_or_else(invalid)?;
    }
    if m["totalCount"] != count {
        return Err(invalid());
    }
    Ok(())
}
pub fn begin_bootstrap(
    c: &mut Connection,
    ctx: &CatalogueContext,
    m: &Value,
    now: u64,
) -> Result<(), AppError> {
    manifest_valid(ctx, m, now)?;
    if operational(c, ctx)? {
        return Err(conflict());
    }
    let key = catalogue_preview::key(ctx).map_err(|_| invalid())?;
    let raw = bytes(m)?.0;
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let old: Option<String> = tx
        .query_row(
            "SELECT manifest FROM native_sales_bootstrap_v1 WHERE context_key=?1",
            [&key],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(old) = old.filter(|s| s != &raw) {
        let old: Value = serde_json::from_str(&old).map_err(|_| invalid())?;
        if integer(&old["expiresAtMs"])? as u64 > now {
            return Err(conflict());
        }
        // Expired unactivated transport pages only; never commercial facts/PIN.
        tx.execute(
            "DELETE FROM native_sales_pages_v1 WHERE context_key=?1",
            [&key],
        )?;
        tx.execute(
            "DELETE FROM native_sales_bootstrap_v1 WHERE context_key=?1 AND state='DOWNLOADING'",
            [&key],
        )?;
    }
    tx.execute(
        "INSERT OR IGNORE INTO native_sales_bootstrap_v1 VALUES(?1,?2,'DOWNLOADING')",
        (&key, raw),
    )?;
    tx.commit()?;
    Ok(())
}
pub fn bootstrap_manifest(
    c: &Connection,
    ctx: &CatalogueContext,
) -> Result<Option<Value>, AppError> {
    let raw:Option<String>=c.query_row("SELECT manifest FROM native_sales_bootstrap_v1 WHERE context_key=?1 AND state='DOWNLOADING'",[catalogue_preview::key(ctx).map_err(|_|invalid())?],|r|r.get(0)).optional()?;
    raw.map(|s| serde_json::from_str(&s).map_err(|_| invalid()))
        .transpose()
}
pub fn stage_bootstrap_page(
    c: &mut Connection,
    ctx: &CatalogueContext,
    index: usize,
    payload: &str,
    now: u64,
) -> Result<(), AppError> {
    let m = bootstrap_manifest(c, ctx)?.ok_or_else(invalid)?;
    manifest_valid(ctx, &m, now)?;
    let p = m["pages"].get(index).ok_or_else(invalid)?;
    let (v, h) = canonicalize(payload.as_bytes()).map_err(|_| invalid())?;
    let rows: Value = serde_json::from_str(payload).map_err(|_| invalid())?;
    if v != payload
        || p["sha256"] != h
        || p["byteLength"] != payload.len()
        || p["count"] != array(&rows)?.len()
    {
        return Err(invalid());
    }
    let key = catalogue_preview::key(ctx).map_err(|_| invalid())?;
    let old: Option<String> = c
        .query_row(
            "SELECT payload FROM native_sales_pages_v1 WHERE context_key=?1 AND page_index=?2",
            (&key, index as i64),
            |r| r.get(0),
        )
        .optional()?;
    if old.as_ref().is_some_and(|v| v != payload) {
        return Err(conflict());
    }
    c.execute(
        "INSERT OR IGNORE INTO native_sales_pages_v1 VALUES(?1,?2,?3)",
        (&key, index as i64, payload),
    )?;
    Ok(())
}
pub fn missing_bootstrap_pages(
    c: &Connection,
    ctx: &CatalogueContext,
) -> Result<Vec<usize>, AppError> {
    let m = bootstrap_manifest(c, ctx)?.ok_or_else(invalid)?;
    let key = catalogue_preview::key(ctx).map_err(|_| invalid())?;
    let mut missing = vec![];
    for i in 0..array(&m["pages"])?.len() {
        let found:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM native_sales_pages_v1 WHERE context_key=?1 AND page_index=?2)",(&key,i as i64),|r|r.get(0))?;
        if !found {
            missing.push(i)
        }
    }
    Ok(missing)
}
pub fn activate_bootstrap(
    c: &mut Connection,
    ctx: &CatalogueContext,
    now: u64,
    vault_id: &str,
) -> Result<(), AppError> {
    let m = bootstrap_manifest(c, ctx)?.ok_or_else(invalid)?;
    manifest_valid(ctx, &m, now)?;
    if !missing_bootstrap_pages(c, ctx)?.is_empty() {
        return Err(invalid());
    }
    let k = catalogue_preview::key(ctx).map_err(|_| invalid())?;
    let sk = scope_key(ctx)?;
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    // Never reset journal, pending work, local numbers, or legacy product authority.
    let occupied:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM operation_journal) OR EXISTS(SELECT 1 FROM products) OR EXISTS(SELECT 1 FROM ticket_sequences)",[],|r|r.get(0))?;
    if occupied {
        return Err(conflict());
    }
    tx.execute(
        "INSERT OR IGNORE INTO scopes VALUES(?1,?2,?3,?4)",
        (&sk, &ctx.scope_type, &ctx.branch_id, &ctx.tenant_id),
    )?;
    tx.execute(
        "INSERT INTO installations VALUES(?1,?2,?3,?4,?5,'ACTIVE')",
        (
            &ctx.installation_id,
            &ctx.device_id,
            integer(&json!(ctx.writer_epoch))?,
            text(&m["ticketPrefix"])?,
            text(&m["capturedAtMs"])?,
        ),
    )?;
    crate::storage::legacy_services::import(&tx, ctx, &m["legacyServices"])?;
    let mut seen = HashSet::new();
    let mut rows = vec![];
    for i in 0..array(&m["pages"])?.len() {
        let raw: String = tx.query_row(
            "SELECT payload FROM native_sales_pages_v1 WHERE context_key=?1 AND page_index=?2",
            (&k, i as i64),
            |r| r.get(0),
        )?;
        let v: Value = serde_json::from_str(&raw).map_err(|_| invalid())?;
        rows.extend(array(&v)?.clone());
    }
    for row in rows.iter().filter(|r| r["kind"] == "PRODUCT") {
        let id = text(&row["id"])?;
        EntityId::parse(id).map_err(|_| invalid())?;
        if !seen.insert(id.to_owned()) {
            return Err(invalid());
        }
        let rev = integer(&row["revision"])?;
        if rev == 0 {
            return Err(invalid());
        }
        integer(&row["priceTiers"]["retailCents"])?;
        tx.execute(
            "INSERT INTO products VALUES(?1,?2,?3,NULL,?4,?5,?6,?7,?8)",
            (
                id,
                &ctx.tenant_id,
                rev,
                row["code"].as_str(),
                text(&row["name"])?,
                row["priceTiers"].to_string(),
                row["metadata"].to_string(),
                row["deleted"].as_bool().ok_or_else(invalid)?,
            ),
        )?;
        let qty = row["stock"]["quantity"].as_str();
        let state = if row["stock"]["authority"] == "VERIFIED" {
            let n = integer(&row["stock"]["quantity"])?;
            if n > i32::MAX.into() {
                return Err(invalid());
            }
            "VERIFIED"
        } else {
            "UNKNOWN"
        };
        tx.execute(
            "INSERT INTO stock_projections VALUES(?1,?2,?3,?4,'[]',?3,?5)",
            (
                id,
                &sk,
                qty.unwrap_or("0"),
                integer(&row["stock"]["version"])?,
                state,
            ),
        )?;
    }
    for row in &rows {
        match text(&row["kind"])? {
            "PRODUCT" => {}
            "CUSTOMER" => {
                let id = text(&row["id"])?;
                EntityId::parse(id).map_err(|_| invalid())?;
                tx.execute("INSERT INTO sale_customer_accounts_v1 VALUES(?1,?2,?3,?4,?5,?6,?7,'VERIFIED',?8)",(id,&ctx.tenant_id,&sk,text(&row["name"] )?,integer(&row["balanceCents"] )?,if row["limitCents"].is_null(){None}else{Some(integer(&row["limitCents"] )?)},row["active"].as_bool().ok_or_else(invalid)?,integer(&row["revision"] )?))?;
                let tier = integer(&row["priceTier"])?;
                if !(1..=3).contains(&tier) {
                    return Err(invalid());
                }
                tx.execute(
                    "INSERT INTO native_sales_customer_pricing_v1 VALUES(?1,?2,?3)",
                    (id, &ctx.tenant_id, tier),
                )?;
                if row["metadataRevision"].is_string() {
                    tx.execute(
                        "INSERT INTO native_customer_metadata_v1 VALUES(?1,?2,?3,?4,?5,?6)",
                        (
                            id,
                            &ctx.tenant_id,
                            row["phone"].as_str(),
                            tier,
                            row["wholesale"].as_bool().ok_or_else(invalid)?,
                            integer(&row["metadataRevision"])?,
                        ),
                    )?;
                }
            }
            "SERIAL" => {
                if !matches!(text(&row["state"])?, "AVAILABLE" | "RESERVED" | "SOLD" | "LOST") {
                    return Err(invalid());
                }
                tx.execute(
                    "INSERT INTO sale_serial_inventory_v1 VALUES(?1,?2,?3,?4,?5,?6,NULL)",
                    (
                        &ctx.tenant_id,
                        &sk,
                        text(&row["productId"])?,
                        text(&row["text"])?,
                        text(&row["revision"])?,
                        text(&row["state"])?,
                    ),
                )?;
            }
            "REPAIR" => {
                if row["event"]["receipt"]["effects"][0]["payload"]["repair"]["id"] != row["id"] {
                    return Err(invalid());
                }
                super::repairs::import_capture(&tx, ctx, &row["event"], integer(&m["watermark"])?)?;
            }
            "LAYAWAY" => {
                if row["event"]["receipt"]["effects"][0]["payload"]["layaway"]["id"] != row["id"] {
                    return Err(invalid());
                }
                super::layaways::import_capture(
                    &tx,
                    ctx,
                    &row["event"],
                    integer(&m["watermark"])?,
                )?;
            }
            "WARRANTY_RECORD" => {
                if row["event"]["receipt"]["operationId"] != row["id"] {
                    return Err(invalid());
                }
                super::warranties::import_capture(
                    &tx,
                    ctx,
                    &row["event"],
                    integer(&m["watermark"])?,
                )?;
            }
            _ => return Err(invalid()),
        }
    }
    super::layaways::bind_captured_serials(&tx, ctx)?;
    tx.execute(
        "INSERT INTO sale_free_settings_v1 VALUES(?1,?2,?3)",
        (&ctx.tenant_id, &sk, m["freeTax"].to_string()),
    )?;
    let evidence = bytes(
        &json!({"source":"OPERATIONAL_BOOTSTRAP","snapshotId":m["snapshotId"],"context":ctx,"prefix":m["ticketPrefix"],"lastIssued":m["lastTicket"]}),
    )?;
    tx.execute(
        "INSERT INTO ticket_sequences VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
        (
            &ctx.tenant_id,
            &ctx.installation_id,
            &ctx.device_id,
            &ctx.writer_epoch,
            text(&m["ticketPrefix"])?,
            integer(&m["lastTicket"])?,
            evidence.1,
            evidence.0.as_bytes(),
        ),
    )?;
    EntityId::parse(vault_id).map_err(|_| invalid())?;
    tx.execute("INSERT INTO vault_meta VALUES(?1,?2,12,'STAGING_NATIVE_OPERATIONAL','SQLCipher','ACTIVE',0) ON CONFLICT(vault_id) DO UPDATE SET activation_state='ACTIVE' WHERE negocio_id=excluded.negocio_id",(vault_id,&ctx.tenant_id))?;
    tx.execute(
        "INSERT INTO native_sales_cursor_v1 VALUES(?1,?2,'NATIVE1',?3)",
        (&ctx.tenant_id, &sk, integer(&m["watermark"])?),
    )?;
    if !m["turn"].is_null() {
        receive_in(&tx, ctx, &m["turn"])?;
        if !m["cashBase"].is_object() {
            tx.execute(
                "INSERT INTO native_cash_baseline_v1 VALUES(?1,?2,0,?3,'UNKNOWN')",
                (
                    &ctx.tenant_id,
                    text(&m["turn"]["receipt"]["operationId"])?,
                    integer(&m["watermark"])?,
                ),
            )?;
        }
    }
    if m["cashBase"].is_object() {
        store_cash_base(&tx, ctx, &m["cashBase"], integer(&m["watermark"])?)?;
    }
    if m["business"].is_object() {
        tx.execute("INSERT INTO native_business_profile_v1 VALUES(?1,?2) ON CONFLICT(tenant_id) DO UPDATE SET profile=excluded.profile",(&ctx.tenant_id,m["business"].to_string()))?;
    }
    super::settings::import_protocol(&tx, ctx, &m)?;
    if m["businessSettings"].is_object() {
        super::settings::import_current(
            &tx,
            ctx,
            &m["businessSettings"],
            integer(&m["watermark"])?,
        )?;
    }
    tx.execute(
        "UPDATE native_sales_bootstrap_v1 SET state='ACTIVE' WHERE context_key=?1",
        [k],
    )?;
    tx.commit()?;
    Ok(())
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Dispatch {
    pub operation_id: String,
    pub hash: String,
    pub intent: String,
    pub snapshot: Option<String>,
    pub snapshot_hash: Option<String>,
    pub claim_id: String,
}
type ClaimRow = (String, String, Vec<u8>, Option<Vec<u8>>, Option<String>);
/// Durable coordinated request, without a cobrable drawer until its receipt.
pub fn pending_shared_turn(
    c: &Connection,
    ctx: &CatalogueContext,
) -> Result<Option<Value>, AppError> {
    let raw:Option<Vec<u8>>=c.query_row("SELECT j.canonical_bytes FROM operation_journal j LEFT JOIN outbox o ON o.operation_id=j.operation_id WHERE j.kind='TURN_OPEN' AND j.local_state='PREPARED' AND j.origin_actor=?1 AND j.origin_device=?2 AND json_extract(CAST(j.canonical_bytes AS TEXT),'$.negocioId')=?3 AND json_extract(CAST(j.canonical_bytes AS TEXT),'$.installationId')=?4 AND (o.state IS NULL OR o.state IN('PENDING','IN_FLIGHT','RETRYABLE_ERROR')) ORDER BY j.local_seq LIMIT 1",(&ctx.actor_id,&ctx.device_id,&ctx.tenant_id,&ctx.installation_id),|r|r.get(0)).optional()?;
    raw.map(|b| {
        let v: Value = serde_json::from_slice(&b).map_err(|_| invalid())?;
        let mut result =
            json!({"operationId":v["operationId"],"openingCents":v["payload"]["openingCents"]});
        if v["payload"]["denominations"].is_array() {
            result["denominations"] = v["payload"]["denominations"].clone();
        }
        Ok(result)
    })
    .transpose()
}
#[allow(clippy::too_many_arguments)]
pub fn request_shared_turn(
    c: &mut Connection,
    g: &crate::security::offline_grant::VerifiedGrant,
    now: u64,
    high: u64,
    opens: u64,
    op: &str,
    opening: &str,
) -> Result<Value, AppError> {
    request_shared_turn_with_count(c, g, now, high, opens, op, opening, None)
}
#[allow(clippy::too_many_arguments)]
pub fn request_shared_turn_with_count(
    c: &mut Connection,
    g: &crate::security::offline_grant::VerifiedGrant,
    now: u64,
    high: u64,
    opens: u64,
    op: &str,
    opening: &str,
    denominations: Option<&[super::management::Denomination]>,
) -> Result<Value, AppError> {
    let decision = g.evaluate(now, high, opens).map_err(|_| invalid())?;
    if !decision.allows("SELL") {
        return Err(AppError::Auth(super::errors::AuthError::PermissionDenied {
            required: "SELL".into(),
        }));
    }
    EntityId::parse(op).map_err(|_| invalid())?;
    integer(&json!(opening))?;
    let mut payload = json!({"openingCents":opening});
    if let Some(ds) = denominations {
        super::management::counted(opening, ds)?;
        payload["denominations"] = json!(ds);
    }
    let ctx = super::checkout::context(g);
    if !operational(c, &ctx)? {
        return Err(invalid());
    }
    let p = g.payload();
    let origin = if ctx.scope_type == "GLOBAL" {
        "GLOBAL".to_owned()
    } else {
        format!("BRANCH:{}", ctx.branch_id.as_deref().ok_or_else(invalid)?)
    };
    let old: Option<Vec<u8>> = c
        .query_row(
            "SELECT canonical_bytes FROM operation_journal WHERE operation_id=?1",
            [op],
            |r| r.get(0),
        )
        .optional()?;
    let v = if let Some(raw) = old {
        let v: Value = serde_json::from_slice(&raw).map_err(|_| invalid())?;
        if v["kind"] != "TURN_OPEN"
            || v["negocioId"] != p.tenant_id
            || v["actorId"] != p.actor_id
            || v["originDeviceId"] != p.device_id
            || v["installationId"] != p.installation_id
            || v["writerEpoch"] != p.writer_epoch
            || v["scope"] != json!({"type":p.scope.r#type,"sucursalId":p.scope.branch_id})
            || v["payload"] != payload
        {
            return Err(conflict());
        }
        v
    } else {
        if pending_shared_turn(c, &ctx)?.is_some() {
            return Err(conflict());
        }
        if super::cash::read_turn(c, &ctx)?.is_some() {
            return Err(AppError::Business(
                super::errors::BusinessError::SaleGuard {
                    code: "TURN_CHANGED".into(),
                },
            ));
        }
        let rev:i64=c.query_row("SELECT coalesce((SELECT revision FROM cash_drawers WHERE tenant_id=?1 AND scope_key=?2),0)",(&ctx.tenant_id,scope_key(&ctx)?),|r|r.get(0))?;
        json!({"protocol":"ventard.native.v1","kind":"TURN_OPEN","contractVersion":1,"canonicalizationVersion":"C-N1","operationId":op,"negocioId":p.tenant_id,"scope":{"type":p.scope.r#type,"sucursalId":p.scope.branch_id},"originDeviceId":p.device_id,"installationId":p.installation_id,"writerEpoch":p.writer_epoch,"actorId":p.actor_id,"permissionGrantId":p.grant_id,"originalTurnId":null,"originAtUtcMs":decision.effective_time_ms,"expectedVersions":{"drawer":rev.to_string()},"dependencies":[],"payload":payload})
    };
    let (b, h) = bytes(&v)?;
    super::operations::prepare_operation(
        c,
        op,
        "ventard.native.v1",
        "TURN_OPEN",
        1,
        b.as_bytes(),
        &h,
        &p.actor_id,
        &origin,
        &p.device_id,
        p.writer_epoch.parse().map_err(|_| invalid())?,
        text(&v["originAtUtcMs"])?,
    )?;
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let existing: Option<Vec<u8>> = tx
        .query_row(
            "SELECT envelope FROM outbox WHERE operation_id=?1",
            [op],
            |r| r.get(0),
        )
        .optional()?;
    if existing
        .as_ref()
        .is_some_and(|o| o.as_slice() != b.as_bytes())
    {
        return Err(conflict());
    }
    tx.execute(
        "INSERT OR IGNORE INTO outbox(operation_id,envelope,state) VALUES(?1,?2,'PENDING')",
        (op, b.as_bytes()),
    )?;
    let state: String = tx.query_row(
        "SELECT local_state FROM operation_journal WHERE operation_id=?1",
        [op],
        |r| r.get(0),
    )?;
    tx.commit()?;
    Ok(json!({"operationId":op,"openingCents":opening,"state":state}))
}
pub fn claim(
    c: &mut Connection,
    ctx: &CatalogueContext,
    now: u64,
) -> Result<Option<Dispatch>, AppError> {
    if !operational(c, ctx)? {
        return Err(invalid());
    }
    let key = if ctx.scope_type == "GLOBAL" {
        "GLOBAL".into()
    } else {
        format!("BRANCH:{}", ctx.branch_id.as_deref().ok_or_else(invalid)?)
    };
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let row:Option<ClaimRow>=tx.query_row("SELECT o.operation_id,j.hash,j.canonical_bytes,s.snapshot_bytes,s.snapshot_hash FROM outbox o JOIN operation_journal j ON j.operation_id=o.operation_id LEFT JOIN sale_ticket_snapshots_v1 s ON s.operation_id=o.operation_id WHERE (j.local_state='COMMITTED' OR (j.local_state='PREPARED' AND j.kind='TURN_OPEN')) AND j.origin_actor=?1 AND j.origin_device=?2 AND j.origin_epoch=?3 AND j.origin_scope=?4 AND (o.state IN('PENDING','RETRYABLE_ERROR') AND o.next_attempt<=?5 OR o.state='IN_FLIGHT' AND o.lease_expires<=?5) ORDER BY j.local_seq LIMIT 1",(&ctx.actor_id,&ctx.device_id,&ctx.writer_epoch,&key,now),|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional()?;
    let Some((op, h, b, s, sh)) = row else {
        return Ok(None);
    };
    let intent = String::from_utf8(b).map_err(|_| invalid())?;
    let v: Value = serde_json::from_str(&intent).map_err(|_| invalid())?;
    if v["negocioId"] != ctx.tenant_id || v["installationId"] != ctx.installation_id {
        return Err(invalid());
    }
    // Historical intents without native stock proof stay visible, never rehashed.
    if v["kind"] == "SALE_CONFIRM" && !v["payload"]["sale"]["stockEvidence"].is_array() {
        tx.execute(
            "UPDATE outbox SET state='INTERVENTION' WHERE operation_id=?1",
            [&op],
        )?;
        tx.execute(
            "INSERT OR REPLACE INTO native_sales_failures_v1 VALUES(?1,'LEGACY_NOT_VERIFIABLE')",
            [&op],
        )?;
        tx.commit()?;
        return Ok(None);
    }
    let claim = EntityId::new_random().to_string();
    tx.execute("UPDATE outbox SET state='IN_FLIGHT',attempts=attempts+1,claim_id=?2,lease_expires=?3 WHERE operation_id=?1",(&op,&claim,now.saturating_add(30_000)))?;
    tx.commit()?;
    Ok(Some(Dispatch {
        operation_id: op,
        hash: h,
        intent,
        snapshot: s
            .map(String::from_utf8)
            .transpose()
            .map_err(|_| invalid())?,
        snapshot_hash: sh,
        claim_id: claim,
    }))
}
pub fn failure_state(status: u16) -> &'static str {
    match status {
        401 => "PENDING",
        403 | 404 | 422 => "INTERVENTION",
        400 | 409 => "CONFLICT",
        _ => "RETRYABLE_ERROR",
    }
}
pub fn record_failure(
    c: &mut Connection,
    d: &Dispatch,
    status: u16,
    now: u64,
    retry_after: u64,
) -> Result<(), AppError> {
    record_failure_detail(c, d, status, now, retry_after, None)
}
pub fn record_failure_detail(
    c: &mut Connection,
    d: &Dispatch,
    status: u16,
    now: u64,
    retry_after: u64,
    reason: Option<&'static str>,
) -> Result<(), AppError> {
    let state = failure_state(status);
    let code = match status {
        401 => "AUTH_REQUIRED",
        403 => "REMOTE_DENIED",
        404 => "MIGRATION_REQUIRED",
        429 => "RATE_LIMITED",
        400 | 409 | 422 => "REMOTE_CONFLICT",
        _ => "REMOTE_UNAVAILABLE",
    };
    let code = reason
        .filter(|r| {
            matches!(
                *r,
                "SALES_SETUP_REQUIRED"
                    | "SALES_SCOPE_CONFLICT"
                    | "SALES_REMOTE_DENIED"
                    | "SALES_SOURCE_UNVERIFIABLE"
                    | "AUTHORITY_PROJECTION_DIVERGED"
                    | "SALES_SCHEMA_INCOMPATIBLE"
                    | "SALES_PAYMENT_CONTEXT_INVALID"
            )
        })
        .unwrap_or(code);
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let changed=tx.execute("UPDATE outbox SET state=?3,next_attempt=?4,lease_expires=NULL,claim_id=NULL WHERE operation_id=?1 AND claim_id=?2 AND state='IN_FLIGHT'",(&d.operation_id,&d.claim_id,state,now.saturating_add(if status==401{0}else{retry_after.clamp(1000,86_400_000)})))?;
    if changed == 1 {
        if matches!(state, "CONFLICT" | "INTERVENTION" | "DENIED") {
            tx.execute("UPDATE stock_projections SET authority_state='UNKNOWN' WHERE (producto_id,scope_key) IN(SELECT producto_id,scope_key FROM inventory_movements WHERE owner_operation_id=?1 AND cast(delta_qty AS INTEGER)>0)",[&d.operation_id])?;
        }
        tx.execute(
            "INSERT OR REPLACE INTO native_sales_failures_v1 VALUES(?1,?2)",
            (&d.operation_id, code),
        )?;
    }
    tx.commit()?;
    Ok(())
}

/// Explicit operator recovery of the same durable intent. Never replay local effects.
pub fn retry_failed(
    c: &mut Connection,
    ctx: &CatalogueContext,
    op: &str,
    now: u64,
) -> Result<(), AppError> {
    EntityId::parse(op).map_err(|_| invalid())?;
    if !operational(c, ctx)? {
        return Err(invalid());
    }
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let row: Option<(Vec<u8>,Vec<u8>,String,String)> = tx.query_row("SELECT j.canonical_bytes,o.envelope,j.hash,o.state FROM operation_journal j JOIN outbox o ON o.operation_id=j.operation_id WHERE j.operation_id=?1 AND j.protocol='ventard.native.v1' AND (j.local_state='COMMITTED' OR (j.local_state='PREPARED' AND j.kind='TURN_OPEN')) AND j.origin_actor=?2 AND j.origin_device=?3 AND j.origin_scope=?4 AND j.origin_epoch=?5",(op,&ctx.actor_id,&ctx.device_id,scope_key(ctx)?.split_once('/').ok_or_else(invalid)?.1,&ctx.writer_epoch),|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
    let (canonical, envelope, hash, state) = row.ok_or_else(conflict)?;
    if !matches!(state.as_str(), "CONFLICT" | "INTERVENTION") || canonical != envelope {
        return Err(conflict());
    }
    let v: Value = serde_json::from_slice(&canonical).map_err(|_| invalid())?;
    if v["kind"] == "SALE_CONFIRM" && !v["payload"]["sale"]["stockEvidence"].is_array() {
        return Err(conflict());
    }
    if v["negocioId"] != ctx.tenant_id
        || v["actorId"] != ctx.actor_id
        || v["originDeviceId"] != ctx.device_id
        || v["installationId"] != ctx.installation_id
        || v["writerEpoch"] != ctx.writer_epoch
        || v["scope"] != json!({"type":ctx.scope_type,"sucursalId":ctx.branch_id})
        || v["operationId"] != op
        || !(matches!(v["kind"].as_str(), Some("SALE_CONFIRM" | "TURN_OPEN"))
            || v["kind"].as_str().is_some_and(super::management::supports))
        || bytes(&v)?.1 != hash
    {
        return Err(conflict());
    }
    tx.execute("UPDATE outbox SET state='PENDING',next_attempt=?2,lease_expires=NULL,claim_id=NULL WHERE operation_id=?1",(op,now))?;
    tx.commit()?;
    Ok(())
}

pub fn validate_event(
    ctx: &CatalogueContext,
    v: &Value,
    snapshot: Option<&str>,
    r: &Value,
) -> Result<(), AppError> {
    catalogue_preview::key(ctx).map_err(|_| invalid())?;
    let op = text(&v["operationId"])?;
    EntityId::parse(op).map_err(|_| invalid())?;
    if v["protocol"] != "ventard.native.v1"
        || v["negocioId"] != ctx.tenant_id
        || v["scope"] != json!({"type":ctx.scope_type,"sucursalId":ctx.branch_id})
        || r["protocol"] != "ventard.native.receipt.1"
        || r["status"] != "APPLIED"
        || r["namespace"] != "NATIVE1"
        || r["operationId"] != op
        || r["tenantId"] != ctx.tenant_id
        || r["scope"] != json!({"type":ctx.scope_type,"branchId":ctx.branch_id})
        || r["intentHash"] != bytes(v)?.1
    {
        return Err(invalid());
    }
    for (dst, src) in [
        ("actorId", "actorId"),
        ("installationId", "installationId"),
        ("deviceId", "originDeviceId"),
        ("writerEpoch", "writerEpoch"),
    ] {
        if r[dst] != v[src] {
            return Err(invalid());
        }
    }
    if integer(&r["remoteSequence"])? == 0 {
        return Err(invalid());
    }
    integer(&r["appliedAtMs"])?;
    let mut expected = BTreeMap::new();
    let mut add = |id: String, kind: &str, payload: Value| {
        expected.insert(id, json!({"kind":kind,"payload":payload}));
    };
    if v["kind"] == "TURN_OPEN" {
        if snapshot.is_some() || !r["snapshotHash"].is_null() || !r["ticket"].is_null() {
            return Err(invalid());
        }
        add(
            op.into(),
            "TURN_OPEN",
            json!({"id":op,"kind":"TURN_OPEN","amountCents":v["payload"]["openingCents"]}),
        );
    } else if v["kind"] == "SALE_CONFIRM" {
        let raw = snapshot.ok_or_else(invalid)?;
        let (canon, h) = canonicalize(raw.as_bytes()).map_err(|_| invalid())?;
        if canon != raw || r["snapshotHash"] != h {
            return Err(invalid());
        }
        let s: Value = serde_json::from_str(raw).map_err(|_| invalid())?;
        let sale = &v["payload"]["sale"];
        if s["version"] != "ventard.ticket.snapshot.1"
            || s["operationId"] != op
            || s["tenantId"] != ctx.tenant_id
            || s["scope"] != r["scope"]
            || s["actorId"] != v["actorId"]
            || s["originAtUtcMs"] != v["originAtUtcMs"]
            || s["sale"] != *sale
            || r["ticket"] != s["ticket"]
            || r["ncf"] != s["ncf"]
            || r["totalCents"] != sale["totals"]["totalCents"]
        {
            return Err(invalid());
        }
        for (i, l) in array(&sale["lines"])?.iter().enumerate() {
            add(effect_id(op, &format!("line/{i}")), "LINE", l.clone());
        }
        for e in array(&sale["inventory"])? {
            let pid = text(&e["productId"])?;
            add(
                effect_id(op, &format!("stock/{pid}")),
                "STOCK",
                json!({"productId":pid,"delta":e["delta"]}),
            );
        }
        let pay = &sale["payment"];
        add(effect_id(op, "payment"), "PAYMENT", pay.clone());
        if pay["method"] == "FIADO" {
            add(
                effect_id(op, "credit"),
                "CREDIT",
                json!({"customerId":pay["customerId"],"amountCents":pay["creditChargeCents"]}),
            );
        }
        if matches!(pay["method"].as_str(), Some("EFECTIVO" | "MIXTO")) {
            add(
                effect_id(op, "cash"),
                "CASH",
                json!({"turnId":pay["turnId"],"amountCents":pay["cashNetCents"]}),
            );
        }
        for serial in array(&sale["serials"])? {
            add(
                effect_id(op, &format!("serial/{}", text(&serial["text"])?)),
                "SERIAL",
                serial.clone(),
            );
        }
        if !sale["fiscal"].is_null() {
            add(effect_id(op, "fiscal"), "FISCAL", sale["fiscal"].clone());
        }
        let stock = array(&r["stock"])?;
        if stock.len() != array(&sale["inventory"])?.len() {
            return Err(invalid());
        }
        let mut seen = HashSet::new();
        for x in stock {
            let pid = text(&x["productId"])?;
            if !seen.insert(pid) {
                return Err(invalid());
            }
            let e = array(&sale["inventory"])?
                .iter()
                .find(|e| e["productId"] == pid)
                .ok_or_else(invalid)?;
            let proof = array(&sale["stockEvidence"])?
                .iter()
                .find(|e| e["productId"] == pid)
                .ok_or_else(invalid)?;
            let delta = text(&e["delta"])?.parse::<i64>().map_err(|_| invalid())?;
            if integer(&x["after"])?
                != integer(&proof["effectiveQty"])?
                    .checked_add(delta)
                    .ok_or_else(invalid)?
                || x["version"] != r["remoteSequence"]
            {
                return Err(invalid());
            }
        }
    } else if v["kind"].as_str().is_some_and(super::management::supports) {
        return super::management::validate_receipt(v, r, snapshot);
    } else {
        return Err(invalid());
    }
    let mut actual = BTreeMap::new();
    for e in array(&r["effects"])? {
        let id = text(&e["id"])?.to_owned();
        let payload = if e["kind"] == "TURN_OPEN" {
            e.clone()
        } else {
            e["payload"].clone()
        };
        if actual
            .insert(id, json!({"kind":e["kind"],"payload":payload}))
            .is_some()
        {
            return Err(invalid());
        }
    }
    if actual != expected {
        return Err(invalid());
    }
    Ok(())
}
pub fn receive_event(
    c: &mut Connection,
    ctx: &CatalogueContext,
    e: &Value,
) -> Result<(), AppError> {
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    receive_in(&tx, ctx, e)?;
    tx.commit()?;
    Ok(())
}
fn receive_in(tx: &Transaction<'_>, ctx: &CatalogueContext, event: &Value) -> Result<(), AppError> {
    let intent = text(&event["intent"])?;
    let (canon, h) = canonicalize(intent.as_bytes()).map_err(|_| invalid())?;
    if canon != intent {
        return Err(invalid());
    }
    let v: Value = serde_json::from_str(intent).map_err(|_| invalid())?;
    let r = &event["receipt"];
    validate_event(ctx, &v, event["snapshot"].as_str(), r)?;
    let op = text(&v["operationId"])?;
    let sk = scope_key(ctx)?;
    let seq = integer(&r["remoteSequence"])?;
    let raw = bytes(r)?.0;
    let old: Option<String> = tx
        .query_row(
            "SELECT receipt FROM native_sales_receipts_v1 WHERE operation_id=?1",
            [op],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(old) = old {
        return if old == raw { Ok(()) } else { Err(conflict()) };
    }
    let local: Option<(Vec<u8>, String, String)> = tx
        .query_row(
            "SELECT canonical_bytes,hash,local_state FROM operation_journal WHERE operation_id=?1",
            [op],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    let prepared_turn = local
        .as_ref()
        .is_some_and(|(_, _, state)| state == "PREPARED" && v["kind"] == "TURN_OPEN");
    if let Some((b, hash, state)) = &local {
        if b.as_slice() != intent.as_bytes()
            || *hash != h
            || (state != "COMMITTED" && !prepared_turn)
        {
            return Err(conflict());
        }
        if let Some(snapshot) = event["snapshot"].as_str() {
            let original: Vec<u8> = tx.query_row(
                "SELECT snapshot_bytes FROM sale_ticket_snapshots_v1 WHERE operation_id=?1",
                [op],
                |r| r.get(0),
            )?;
            if original.as_slice() != snapshot.as_bytes() {
                return Err(conflict());
            }
        }
    }
    if local.is_none() || prepared_turn {
        let origin = if ctx.scope_type == "GLOBAL" {
            "GLOBAL".into()
        } else {
            format!("BRANCH:{}", ctx.branch_id.as_deref().ok_or_else(invalid)?)
        };
        if prepared_turn {
            tx.execute("UPDATE operation_journal SET local_state='COMMITTED',result=?2 WHERE operation_id=?1",(op,json!({"remoteStatus":"APPLIED"}).to_string()))?;
        } else {
            tx.execute("INSERT INTO operation_journal VALUES(?1,'ventard.native.v1',?2,1,?3,?4,?5,?6,?7,?8,?9,COALESCE((SELECT MAX(local_seq) FROM operation_journal),0)+1,'COMMITTED',?10)",(op,text(&v["kind"] )?,intent.as_bytes(),&h,text(&v["actorId"] )?,origin,text(&v["originDeviceId"] )?,integer(&v["writerEpoch"] )?,text(&v["originAtUtcMs"] )?,json!({"remoteStatus":"APPLIED"}).to_string()))?;
        }
        if v["kind"] == "TURN_OPEN" {
            tx.execute(
                "INSERT OR IGNORE INTO cash_drawers VALUES(?1,?2,0)",
                (&ctx.tenant_id, &sk),
            )?;
            tx.execute(
                "INSERT INTO cash_turns VALUES(?1,?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,1,'OPEN')",
                (
                    op,
                    &ctx.tenant_id,
                    &sk,
                    text(&v["actorId"])?,
                    text(&v["originDeviceId"])?,
                    text(&v["installationId"])?,
                    integer(&v["writerEpoch"])?,
                    text(&v["permissionGrantId"])?,
                    integer(&v["payload"]["openingCents"])?,
                    text(&v["originAtUtcMs"])?,
                ),
            )?;
            let result = json!({"operationId":op,"turnId":op,"tenantId":ctx.tenant_id,"scopeKey":sk,"actorId":v["actorId"],"openingCents":v["payload"]["openingCents"],"openedAtMs":v["originAtUtcMs"],"drawerRevision":"1","remoteStatus":"APPLIED"});
            tx.execute(
                "UPDATE operation_journal SET result=?2 WHERE operation_id=?1",
                (op, result.to_string()),
            )?;
            tx.execute(
                "UPDATE cash_drawers SET revision=1 WHERE tenant_id=?1 AND scope_key=?2",
                (&ctx.tenant_id, &sk),
            )?;
        } else if v["kind"].as_str().is_some_and(super::management::supports) {
            super::management::apply(tx, ctx, &v, true)?;
        } else {
            import_sale(tx, ctx, &v, event)?;
        }
    }
    if v["kind"].as_str().is_some_and(super::management::supports) {
        super::management::acknowledge(tx, &v)?;
    }
    tx.execute(
        "INSERT INTO native_sales_receipts_v1 VALUES(?1,?2,?3,?4,?5)",
        (op, &ctx.tenant_id, &sk, seq, raw),
    )?;
    for stock in array(&r["stock"])? {
        let pid = text(&stock["productId"])?;
        let row:(i64,String)=tx.query_row("SELECT remote_seq,pending_coverage FROM stock_projections WHERE producto_id=?1 AND scope_key=?2",(pid,&sk),|r|Ok((r.get(0)?,r.get(1)?)))?;
        let covered: Value = serde_json::from_str(&row.1).map_err(|_| invalid())?;
        let mut remaining = vec![];
        for p in array(&covered)? {
            let applied:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM native_sales_receipts_v1 WHERE operation_id=?1 AND tenant_id=?2 AND scope_key=?3 AND remote_sequence<=?4)",(text(&p["operationId"] )?,&ctx.tenant_id,&sk,seq.max(row.0)),|r|r.get(0))?;
            if !applied {
                remaining.push(p.clone());
            }
        }
        let base = if seq >= row.0 {
            integer(&stock["after"])?
        } else {
            tx.query_row::<String,_,_>("SELECT remote_base_qty FROM stock_projections WHERE producto_id=?1 AND scope_key=?2",(pid,&sk),|r|r.get(0))?.parse().map_err(|_|invalid())?
        };
        let mut effective = base;
        let mut rejected_positive = false;
        for p in &remaining {
            if text(&p["delta"])?.parse::<i64>().map_err(|_| invalid())? > 0 {
                let rejected:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM outbox WHERE operation_id=?1 AND state IN('CONFLICT','INTERVENTION','DENIED'))",[text(&p["operationId"])?],|r|r.get(0))?;
                rejected_positive |= rejected;
            }
            effective = effective
                .checked_add(text(&p["delta"])?.parse::<i64>().map_err(|_| invalid())?)
                .ok_or_else(invalid)?;
        }
        tx.execute("UPDATE stock_projections SET remote_base_qty=?3,remote_seq=?4,pending_coverage=?5,effective_stock=?6,authority_state=?7 WHERE producto_id=?1 AND scope_key=?2",(pid,&sk,base.to_string(),seq.max(row.0),serde_json::to_string(&remaining).map_err(|_|invalid())?,effective.to_string(),if effective<0||rejected_positive{"UNKNOWN"}else{"VERIFIED"}))?;
    }
    tx.execute(
        "UPDATE outbox SET state='APPLIED',claim_id=NULL,lease_expires=NULL WHERE operation_id=?1",
        [op],
    )?;
    tx.execute(
        "DELETE FROM native_sales_failures_v1 WHERE operation_id=?1",
        [op],
    )?;
    Ok(())
}
fn import_sale(
    tx: &Transaction<'_>,
    ctx: &CatalogueContext,
    v: &Value,
    event: &Value,
) -> Result<(), AppError> {
    let op = text(&v["operationId"])?;
    let sk = scope_key(ctx)?;
    let sale = &v["payload"]["sale"];
    let p = &sale["payment"];
    let totals = &sale["totals"];
    let r = &event["receipt"];
    tx.execute(
        "INSERT INTO sales VALUES(?1,?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
        (
            op,
            &ctx.tenant_id,
            &sk,
            p["turnId"].as_str(),
            text(&r["ticket"])?,
            r["ncf"].as_str(),
            text(&v["actorId"])?,
            integer(&totals["totalCents"])?,
            integer(&totals["itbisCents"])?,
            integer(&totals["discountCents"])?,
            text(&sale["calculationVersion"])?,
            text(&v["originAtUtcMs"])?,
        ),
    )?;
    for (i, l) in array(&sale["lines"])?.iter().enumerate() {
        tx.execute(
            "INSERT INTO sale_lines VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            (
                effect_id(op, &format!("line/{i}")),
                op,
                l["productId"].as_str(),
                text(&l["name"])?,
                integer(&l["unitPriceCents"])?,
                l["taxRate"].to_string(),
                l["recipe"].to_string(),
                if l["costCents"].is_null() {
                    None
                } else {
                    Some(integer(&l["costCents"])?)
                },
                l["quantity"].to_string(),
                l["serial"].as_str(),
            ),
        )?;
    }
    for e in array(&sale["inventory"])? {
        let pid = text(&e["productId"])?;
        tx.execute(
            "INSERT INTO inventory_movements VALUES(?1,?2,?3,?4,'SALE',?5,NULL,NULL,?6)",
            (
                effect_id(op, &format!("stock/{pid}")),
                op,
                pid,
                &sk,
                text(&e["delta"])?,
                r["remoteSequence"].to_string(),
            ),
        )?;
    }
    for serial in array(&sale["serials"])? {
        let changed=tx.execute("UPDATE sale_serial_inventory_v1 SET state='SOLD',sale_operation_id=?5 WHERE tenant_id=?1 AND scope_key=?2 AND producto_id=?3 AND serial=?4 AND state='AVAILABLE'",(&ctx.tenant_id,&sk,text(&serial["productId"] )?,text(&serial["text"] )?,op))?;
        if changed != 1 {
            return Err(conflict());
        }
    }
    if p["method"] == "FIADO" {
        let cid = text(&p["customerId"])?;
        let before:i64=tx.query_row("SELECT balance_cents FROM sale_customer_accounts_v1 WHERE customer_id=?1 AND tenant_id=?2",(cid,&ctx.tenant_id),|r|r.get(0))?;
        let charge = integer(&p["creditChargeCents"])?;
        let after = before.checked_add(charge).ok_or_else(invalid)?;
        tx.execute(
            "INSERT INTO sale_credit_entries_v1 VALUES(?1,?2,?3,?4,?5,?6,?7)",
            (op, cid, &ctx.tenant_id, &sk, charge, before, after),
        )?;
        tx.execute("UPDATE sale_customer_accounts_v1 SET balance_cents=?2,revision=revision+1 WHERE customer_id=?1",(cid,after))?;
    } else {
        let legs = match text(&p["method"])? {
            "EFECTIVO" => vec![("EFECTIVO", "cashNetCents")],
            "TARJETA" => vec![("TARJETA", "cardCents")],
            "TRANSFERENCIA" => vec![("TRANSFERENCIA", "transferCents")],
            "MIXTO" => vec![
                ("EFECTIVO", "cashNetCents"),
                ("TRANSFERENCIA", "transferCents"),
            ],
            _ => return Err(invalid()),
        };
        for (method, amount) in legs {
            tx.execute(
                "INSERT INTO payments VALUES(?1,?2,?2,NULL,?3,?4,?5,?6,?7)",
                (
                    effect_id(op, &format!("payment/{method}")),
                    op,
                    method,
                    integer(&p[amount])?,
                    if method == "EFECTIVO" {
                        integer(&p["tenderCents"])?
                    } else {
                        0
                    },
                    if method == "EFECTIVO" {
                        integer(&p["changeCents"])?
                    } else {
                        0
                    },
                    p["turnId"].as_str(),
                ),
            )?;
        }
    }
    if matches!(p["method"].as_str(), Some("EFECTIVO" | "MIXTO")) {
        tx.execute(
            "INSERT INTO sale_cash_entries_v1 VALUES(?1,?2,?3,?4,?5)",
            (
                op,
                text(&p["turnId"])?,
                &ctx.tenant_id,
                &sk,
                integer(&p["cashNetCents"])?,
            ),
        )?;
    }
    let snapshot = text(&event["snapshot"])?;
    tx.execute(
        "INSERT INTO sale_ticket_snapshots_v1 VALUES(?1,?2,?3)",
        (op, snapshot.as_bytes(), text(&r["snapshotHash"])?),
    )?;
    let result = json!({"operationId":op,"hash":r["intentHash"],"ticket":r["ticket"],"totalCents":totals["totalCents"],"itbisCents":totals["itbisCents"],"discountCents":totals["discountCents"],"changeCents":p["changeCents"],"paymentMethod":p["method"],"ncf":r["ncf"],"remoteStatus":"APPLIED","printStatus":"NOT_REQUESTED","snapshotHash":r["snapshotHash"]});
    tx.execute(
        "UPDATE operation_journal SET result=?2 WHERE operation_id=?1",
        (op, result.to_string()),
    )?;
    Ok(())
}
pub fn receive_feed(
    c: &mut Connection,
    ctx: &CatalogueContext,
    page: &Value,
) -> Result<(), AppError> {
    if page["namespace"] != "NATIVE1"
        || page["tenantId"] != ctx.tenant_id
        || page["scope"] != json!({"type":ctx.scope_type,"branchId":ctx.branch_id})
        || page["coverage"] != "COMPLETE"
    {
        return Err(invalid());
    }
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let sk = scope_key(ctx)?;
    let mut last: i64 = tx.query_row(
        "SELECT sequence FROM native_sales_cursor_v1 WHERE tenant_id=?1 AND scope_key=?2",
        (&ctx.tenant_id, &sk),
        |r| r.get(0),
    )?;
    let end = integer(&page["scannedThrough"])?;
    let watermark = integer(&page["watermark"])?;
    if end < last || end > watermark || array(&page["events"])?.len() > 200 {
        return Err(invalid());
    }
    crate::storage::legacy_services::import(&tx, ctx, &page["legacyServices"])?;
    for event in array(&page["events"])? {
        let seq = integer(&event["receipt"]["remoteSequence"])?;
        if seq <= last || seq > end {
            return Err(invalid());
        }
        receive_in(&tx, ctx, event)?;
        last = seq;
    }
    if page["cashBase"].is_object() {
        store_cash_base(&tx, ctx, &page["cashBase"], end)?;
    }
    if page["business"].is_object()
        && !tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM native_business_settings_v1 WHERE tenant_id=?1)",
            [&ctx.tenant_id],
            |r| r.get::<_, bool>(0),
        )?
    {
        tx.execute("INSERT INTO native_business_profile_v1 VALUES(?1,?2) ON CONFLICT(tenant_id) DO UPDATE SET profile=excluded.profile",(&ctx.tenant_id,page["business"].to_string()))?;
    }
    super::settings::import_protocol(&tx, ctx, page)?;
    if page["businessSettings"].is_object() {
        super::settings::import_current(&tx, ctx, &page["businessSettings"], end)?;
    }
    tx.execute(
        "UPDATE native_sales_cursor_v1 SET sequence=?3 WHERE tenant_id=?1 AND scope_key=?2",
        (&ctx.tenant_id, &sk, end),
    )?;
    tx.commit()?;
    Ok(())
}
fn store_cash_base(
    tx: &Transaction<'_>,
    ctx: &CatalogueContext,
    v: &Value,
    through: i64,
) -> Result<(), AppError> {
    let turn = text(&v["turnId"])?;
    EntityId::parse(turn).map_err(|_| invalid())?;
    if v["tenantId"] != ctx.tenant_id
        || v["scope"] != json!({"type":ctx.scope_type,"branchId":ctx.branch_id})
        || integer(&v["sequence"])? != through
    {
        return Err(invalid());
    }
    let net = crate::domain::money::MoneyCents::parse_dto(text(&v["netCents"])?)
        .map_err(|_| invalid())?
        .cents();
    let own:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM cash_turns WHERE tenant_id=?1 AND scope_key=?2 AND turn_id=?3)",(&ctx.tenant_id,scope_key(ctx)?,turn),|r|r.get(0))?;
    if !own {
        return Err(invalid());
    }
    tx.execute("INSERT INTO native_cash_baseline_v1 VALUES(?1,?2,?3,?4,'VERIFIED') ON CONFLICT(tenant_id,turn_id) DO UPDATE SET net_cents=excluded.net_cents,remote_sequence=excluded.remote_sequence,authority='VERIFIED' WHERE excluded.remote_sequence>=native_cash_baseline_v1.remote_sequence",(&ctx.tenant_id,turn,net,through))?;
    Ok(())
}
