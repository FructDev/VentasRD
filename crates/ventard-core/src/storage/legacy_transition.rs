//! Merge preserved sources without replaying legacy effects. Every choice is
//! audited. Historical incorporation is independent of commercial cutover.
use super::{
    catalogue_preview::CatalogueContext,
    legacy_reconciliation::{decimal, number},
    legacy_web,
};
use crate::domain::money::MoneyCents;
use num_bigint::BigInt;
use num_traits::ToPrimitive;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
pub const CLOUD_TABLES: &[&str] = &[
    "apartados",
    "cajas",
    "clientes",
    "composiciones",
    "cortes_caja",
    "devoluciones",
    "gastos",
    "movimientos_stock",
    "productos",
    "reparaciones",
    "seriales",
    "sucursales",
    "transacciones_fiado",
    "venta_detalles",
    "ventas",
];
pub const MAX_CAPTURE: usize = 33_554_432;
#[derive(Debug, Clone, Copy)]
pub struct Error(&'static str);
impl Error {
    pub fn code(self) -> &'static str {
        self.0
    }
}
pub fn context_changed() -> Error {
    Error("TRANSITION_CONTEXT")
}
impl From<rusqlite::Error> for Error {
    fn from(_: rusqlite::Error) -> Self {
        Self("TRANSITION_STORAGE")
    }
}
fn invalid() -> Error {
    Error("TRANSITION_INVALID")
}
fn digest(s: &str) -> String {
    format!("{:x}", Sha256::digest(s.as_bytes()))
}
fn parse(s: &str) -> Result<Value, Error> {
    serde_json::from_str(s).map_err(|_| invalid())
}
fn encode(ctx: &CatalogueContext) -> Result<String, Error> {
    for id in [
        &ctx.tenant_id,
        &ctx.actor_id,
        &ctx.installation_id,
        &ctx.device_id,
    ] {
        uuid::Uuid::parse_str(id).map_err(|_| invalid())?;
    }
    match (ctx.scope_type.as_str(), &ctx.branch_id) {
        ("GLOBAL", None) => {}
        ("BRANCH", Some(b)) => {
            uuid::Uuid::parse_str(b).map_err(|_| invalid())?;
        }
        _ => return Err(invalid()),
    }
    if ctx
        .writer_epoch
        .parse::<u64>()
        .ok()
        .filter(|n| *n > 0 && *n <= 9_007_199_254_740_991)
        .is_none()
    {
        return Err(invalid());
    }
    serde_json::to_string(ctx).map_err(|_| invalid())
}
fn authorize(c: &Connection, ctx: &CatalogueContext, id: &str) -> Result<(), Error> {
    let stored: Option<String> = c
        .query_row(
            "SELECT context FROM legacy_transition_runs_v1 WHERE run_id=?1 AND tenant_id=?2",
            (id, &ctx.tenant_id),
            |r| r.get(0),
        )
        .optional()?;
    if stored.as_deref() != Some(encode(ctx)?.as_str()) {
        return Err(Error("TRANSITION_CONTEXT"));
    }
    Ok(())
}
fn scope_key(ctx: &CatalogueContext) -> String {
    ctx.branch_id
        .as_ref()
        .map_or_else(|| "GLOBAL".into(), |b| format!("BRANCH:{b}"))
}
fn scoped_table(t: &str) -> bool {
    matches!(
        t,
        "ventas"
            | "venta_detalles"
            | "transacciones_fiado"
            | "cajas"
            | "cortes_caja"
            | "devoluciones"
            | "gastos"
            | "movimientos_stock"
            | "reparaciones"
            | "apartados"
    )
}
fn in_scope(ctx: &CatalogueContext, t: &str, v: &Value) -> bool {
    !scoped_table(t)
        || match (ctx.scope_type.as_str(), v.get("sucursal_id")) {
            ("GLOBAL", Some(Value::Null)) => true,
            ("BRANCH", Some(Value::String(b))) => Some(b) == ctx.branch_id.as_ref(),
            _ => false,
        }
}
fn linked_sale_scope(
    ctx: &CatalogueContext,
    t: &str,
    v: &Value,
    data: &BTreeMap<String, Vec<Value>>,
    checkouts: &BTreeMap<String, super::legacy_checkout::Snapshot>,
) -> bool {
    matches!(t, "venta_detalles" | "devoluciones")
        && v.get("sucursal_id").is_none()
        && all(data, "ventas").iter().any(|sale| {
            sale["id"] == v["venta_id"]
                && sale["negocio_id"] == ctx.tenant_id
                && (in_scope(ctx, "ventas", sale)
                    || checkouts
                        .get(sale["id"].as_str().unwrap_or(""))
                        .is_some_and(|s| s.in_scope(ctx)))
        })
}
fn exact_int(v: &Value) -> Option<i64> {
    let (n, scale) = decimal(&number(v)?)?;
    if scale != 0 {
        return None;
    }
    n.to_i64()
}
pub(crate) fn cents(v: &Value) -> Option<i64> {
    let (n, scale) = decimal(&number(v)?)?;
    if scale > 2 {
        return None;
    }
    MoneyCents::from_i128((n * BigInt::from(10u8).pow(2 - scale)).to_i128()?)
        .ok()
        .map(|m| m.cents())
}
fn sum(a: i64, b: i64) -> Result<i64, Error> {
    MoneyCents::from_i128(a as i128 + b as i128)
        .map(|m| m.cents())
        .map_err(|_| Error("TRANSITION_MONEY_OVERFLOW"))
}
fn canonical_number(raw: &str) -> Result<String, Error> {
    let (n, scale) = decimal(raw).ok_or_else(invalid)?;
    let s = n.to_string();
    if scale == 0 {
        return Ok(s);
    }
    let (negative, digits) = s
        .strip_prefix('-')
        .map_or((false, s.as_str()), |d| (true, d));
    let padded = format!("{:0>width$}", digits, width = scale as usize + 1);
    let split = padded.len() - scale as usize;
    Ok(format!(
        "{}{}.{}",
        if negative { "-" } else { "" },
        &padded[..split],
        &padded[split..]
    ))
}
fn metadata(k: &str) -> bool {
    k == "estado_sincronizacion"
        || k.starts_with("inventory_")
        || k.starts_with("sync_")
        || matches!(
            k,
            "remote_receipt"
                | "payload_hash"
                | "attempt_count"
                | "last_attempt_at"
                | "next_attempt_at"
                | "last_outcome_code"
                | "error_class"
                | "claim_id"
                | "lease_until"
                | "conflict"
                | "origin_device_id"
                | "expected_remote_sequence"
        )
}
pub(crate) fn normalize(v: &Value, depth: u32) -> Result<Value, Error> {
    if depth > 64 {
        return Err(invalid());
    }
    if let Some(raw) = number(v) {
        return Ok(json!({"$number":canonical_number(&raw)?}));
    }
    match v {
        Value::Array(a) => Ok(Value::Array(
            a.iter()
                .map(|v| normalize(v, depth + 1))
                .collect::<Result<_, _>>()?,
        )),
        Value::Object(o) => {
            let mut out = serde_json::Map::new();
            for (k, v) in o {
                if !metadata(k) {
                    out.insert(k.clone(), normalize(v, depth + 1)?);
                }
            }
            Ok(Value::Object(out))
        }
        _ => Ok(v.clone()),
    }
}
// Comparison only: leave captured bytes and the PostgreSQL CAS normalization
// unchanged. Timestamp encodings may differ across browser and database exports.
fn timestamp(v: &Value) -> Option<String> {
    if let Some(s) = v.as_str() {
        let instant =
            time::OffsetDateTime::parse(s, &time::format_description::well_known::Rfc3339).ok()?;
        canonical_number(&format!("{}e-6", instant.unix_timestamp_nanos())).ok()
    } else {
        canonical_number(&number(v)?).ok()
    }
}
fn equivalent_field(field: &str, a: &Value, b: &Value) -> bool {
    if matches!(
        field,
        "actualizado_en"
            | "created_at"
            | "updated_at"
            | "fecha_creacion"
            | "fecha_actualizacion"
            | "fecha"
    ) {
        if let (Some(a), Some(b)) = (timestamp(a), timestamp(b)) {
            return a == b;
        }
    }
    equivalent(a, b)
}
pub(crate) fn equivalent(a: &Value, b: &Value) -> bool {
    if a == b {
        return true;
    }
    match (a, b) {
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(k, a)| b.get(k).is_some_and(|b| equivalent_field(k, a, b)))
        }
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| equivalent(a, b))
        }
        _ => false,
    }
}
// Only absent fields may be complemented. Arrays remain indivisible documents;
// null is an explicit value, never an absent field or an inferred GLOBAL scope.
fn complement(a: &mut Value, b: &Value) -> bool {
    let (Some(a), Some(b)) = (a.as_object_mut(), b.as_object()) else {
        return false;
    };
    if b.iter()
        .any(|(k, v)| a.get(k).is_some_and(|old| !equivalent_field(k, old, v)))
    {
        return false;
    }
    for (k, v) in b {
        a.entry(k.clone()).or_insert_with(|| v.clone());
    }
    true
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Capture {
    protocol: String,
    capture_id: String,
    context: CatalogueContext,
    captured_at_ms: String,
    coverage: String,
    decimal_encoding: String,
    tables: Vec<CaptureTable>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CaptureTable {
    name: String,
    count: usize,
    rows: Vec<Value>,
    scope_evidence: Vec<Value>,
}
pub fn store_capture(
    c: &mut Connection,
    ctx: &CatalogueContext,
    id: &str,
    raw: &str,
) -> Result<Value, Error> {
    encode(ctx)?;
    uuid::Uuid::parse_str(id).map_err(|_| invalid())?;
    if raw.len() > MAX_CAPTURE {
        return Err(Error("TRANSITION_TOO_LARGE"));
    }
    let v: Capture = serde_json::from_str(raw).map_err(|_| invalid())?;
    if v.protocol != "ventard.web.capture.1"
        || v.capture_id != id
        || v.context != *ctx
        || v.coverage != "SCOPE_COMPLETE_SINGLE_SNAPSHOT"
        || v.decimal_encoding != "TAGGED_NUMBERS_V1"
        || v.tables.len() != CLOUD_TABLES.len()
        || v.captured_at_ms
            .parse::<u64>()
            .ok()
            .filter(|n| *n <= 9_007_199_254_740_991)
            .is_none()
    {
        return Err(invalid());
    }
    let mut seen = BTreeSet::new();
    let mut total = 0usize;
    let mut counts = BTreeMap::new();
    for table in &v.tables {
        if !CLOUD_TABLES.contains(&table.name.as_str())
            || !seen.insert(&table.name)
            || table.count != table.rows.len()
            || table.count > 200_000
        {
            return Err(invalid());
        }
        total += table.count;
        if total > 200_000 {
            return Err(Error("TRANSITION_TOO_LARGE"));
        }
        let mut ids = BTreeSet::new();
        for row in &table.rows {
            let rid = row["id"]
                .as_str()
                .filter(|s| !s.is_empty() && s.len() <= 512)
                .ok_or_else(invalid)?;
            if row["negocio_id"] != ctx.tenant_id
                || !ids.insert(rid)
                || legacy_web::secrets(row)
                || !cloud_value(row, 0)
            {
                return Err(invalid());
            }
            if ctx.scope_type == "BRANCH"
                && scoped_table(&table.name)
                && !in_scope(ctx, &table.name, row)
            {
                let evidence = table
                    .scope_evidence
                    .iter()
                    .filter(|e| {
                        e["rowId"] == rid
                            && e["sourceTable"] == "ventas"
                            && e["sourceId"] == row["venta_id"]
                            && e["tenantId"] == ctx.tenant_id
                            && e["branchId"] == json!(ctx.branch_id)
                    })
                    .count();
                if table.name != "devoluciones" || row.get("sucursal_id").is_some() || evidence != 1
                {
                    return Err(invalid());
                }
            }
        }
        let mut evidence_ids = BTreeSet::new();
        for e in &table.scope_evidence {
            let rid = e["rowId"].as_str().ok_or_else(invalid)?;
            if ctx.scope_type != "BRANCH"
                || table.name != "devoluciones"
                || !ids.contains(rid)
                || !evidence_ids.insert(rid)
                || !table.rows.iter().any(|r| {
                    r["id"] == rid
                        && r.get("sucursal_id").is_none()
                        && r["venta_id"] == e["sourceId"]
                })
                || e["sourceTable"] != "ventas"
                || e["tenantId"] != ctx.tenant_id
                || e["branchId"] != json!(ctx.branch_id)
            {
                return Err(invalid());
            }
        }
        counts.insert(table.name.clone(), table.count);
    }
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let h = digest(raw);
    let old: Option<(String, String)> = tx
        .query_row(
            "SELECT context,body_hash FROM legacy_cloud_captures_v1 WHERE capture_id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    if let Some((context, oldhash)) = old {
        if context != encode(ctx)? || oldhash != h {
            return Err(Error("TRANSITION_SOURCE_CONFLICT"));
        }
    } else {
        tx.execute(
            "INSERT INTO legacy_cloud_captures_v1 VALUES(?1,?2,?3,?4,?5,?6)",
            (id, &ctx.tenant_id, encode(ctx)?, h, raw, &v.captured_at_ms),
        )?;
    }
    tx.commit()?;
    Ok(
        json!({"captureId":id,"capturedAtMs":v.captured_at_ms,"counts":counts,"coverage":v.coverage}),
    )
}
pub fn capture_status(
    c: &Connection,
    ctx: &CatalogueContext,
    id: &str,
) -> Result<Option<Value>, Error> {
    let old: Option<(String, String, String)> = c
        .query_row(
            "SELECT context,body_hash,body FROM legacy_cloud_captures_v1 WHERE capture_id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    old.map(|(saved,h,raw)|{if saved!=encode(ctx)?||digest(&raw)!=h{return Err(Error("TRANSITION_SOURCE_CONFLICT"));}let v:Capture=serde_json::from_str(&raw).map_err(|_|invalid())?;Ok(json!({"captureId":id,"capturedAtMs":v.captured_at_ms,"counts":v.tables.iter().map(|t|(t.name.clone(),t.count)).collect::<BTreeMap<_,_>>(),"coverage":v.coverage}))}).transpose()
}
fn cloud_value(v: &Value, depth: u32) -> bool {
    if depth > 64 {
        return false;
    }
    match v {
        Value::Number(_) => false,
        Value::Object(o) if o.contains_key("$number") || o.contains_key("$milliseconds") => {
            o.len() == 1 && number(v).and_then(|s| decimal(&s)).is_some()
        }
        Value::Object(o) => o.values().all(|v| cloud_value(v, depth + 1)),
        Value::Array(a) => a.iter().all(|v| cloud_value(v, depth + 1)),
        _ => true,
    }
}
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Variant {
    variant_id: String,
    source_ids: Vec<String>,
    row: Value,
}
type Groups = BTreeMap<(String, String), Vec<Variant>>;
type SourceTables = BTreeMap<String, Vec<Value>>;
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Document {
    source_id: String,
    sale: Value,
    details: Vec<Value>,
    charges: Vec<Value>,
    inventory: Vec<Value>,
    journals: Vec<Value>,
}
fn doc_equal(a: &Document, b: &Document) -> Result<bool, Error> {
    let mut root = normalize(&a.sale, 0)?;
    if !complement(&mut root, &normalize(&b.sale, 0)?) {
        return Ok(false);
    }
    for (left, right) in [
        (&a.details, &b.details),
        (&a.charges, &b.charges),
        (&a.inventory, &b.inventory),
    ] {
        if left.len() != right.len() {
            return Ok(false);
        }
        let by_id = right
            .iter()
            .map(|r| (r["id"].as_str().unwrap_or(""), r))
            .collect::<BTreeMap<_, _>>();
        for row in left {
            let Some(other) = by_id.get(row["id"].as_str().unwrap_or("")) else {
                return Ok(false);
            };
            let mut value = normalize(row, 0)?;
            if !complement(&mut value, &normalize(other, 0)?) {
                return Ok(false);
            }
        }
    }
    Ok(true)
}
fn build_documents(
    c: &Connection,
    ctx: &CatalogueContext,
    run: &str,
    sources: &BTreeMap<String, SourceTables>,
) -> Result<(), Error> {
    let mut docs = BTreeMap::<String, Vec<Document>>::new();
    for (source, tables) in sources {
        for sale in all(tables, "ventas") {
            if sale["negocio_id"] != ctx.tenant_id {
                continue;
            }
            let id = sale["id"].as_str().ok_or_else(invalid)?;
            let doc = Document {
                source_id: source.clone(),
                sale: sale.clone(),
                details: all(tables, "venta_detalles")
                    .iter()
                    .filter(|r| r["venta_id"] == id)
                    .cloned()
                    .collect(),
                charges: all(tables, "transacciones_fiado")
                    .iter()
                    .filter(|r| r["venta_id"] == id && r["tipo"] == "cargo")
                    .cloned()
                    .collect(),
                inventory: all(tables, "movimientos_stock")
                    .iter()
                    .filter(|r| r["referencia_id"] == id && r["tipo"] == "venta")
                    .cloned()
                    .collect(),
                journals: all(tables, "operaciones_locales")
                    .iter()
                    .filter(|r| {
                        r["operation_id"] == id
                            && matches!(r["tipo"].as_str(), Some("SALE" | "CHECKOUT"))
                    })
                    .cloned()
                    .collect(),
            };
            docs.entry(id.into()).or_default().push(doc);
        }
    }
    let mut unresolved = BTreeSet::new();
    let mut q=c.prepare("SELECT table_name,variants FROM legacy_transition_rows_v1 WHERE run_id=?1 AND selected IS NULL")?;
    for r in q.query_map([run], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })? {
        let (table, raw) = r?;
        let variants: Vec<Variant> = serde_json::from_str(&raw).map_err(|_| invalid())?;
        for variant in variants {
            if let Some(owner) = child_owner(&table, &variant.row) {
                unresolved.insert(owner.to_owned());
            }
        }
    }
    for (id, variants) in docs {
        let mut consensus = true;
        for i in 0..variants.len() {
            for j in i + 1..variants.len() {
                consensus &= doc_equal(&variants[i], &variants[j])?;
            }
        }
        consensus &= !unresolved.contains(&id);
        c.execute("INSERT INTO legacy_transition_docs_v1(run_id,sale_id,variants,state) VALUES(?1,?2,?3,?4)",(run,id,serde_json::to_string(&variants).map_err(|_|invalid())?,if consensus{"CONSENSUS"}else{"CONFLICT"}))?;
    }
    Ok(())
}
fn add(groups: &mut Groups, source: &str, table: &str, row: &Value) -> Result<(), Error> {
    let id = row["id"].as_str().ok_or_else(invalid)?;
    let canonical = normalize(row, 0)?;
    let h = digest(&canonical.to_string());
    let group = groups.entry((table.into(), id.into())).or_default();
    if let Some(old) = group.iter_mut().find(|v| v.variant_id == h) {
        old.source_ids.push(source.into());
    } else {
        group.push(Variant {
            variant_id: h,
            source_ids: vec![source.into()],
            row: row.clone(),
        });
    }
    Ok(())
}
pub fn prepare(
    c: &mut Connection,
    ctx: &CatalogueContext,
    run: &str,
    exports: &[String],
    capture: Option<&str>,
    at: &str,
) -> Result<Value, Error> {
    uuid::Uuid::parse_str(run).map_err(|_| invalid())?;
    if exports.len() > 50
        || exports.is_empty() && capture.is_none()
        || at
            .parse::<u64>()
            .ok()
            .filter(|n| *n <= 9_007_199_254_740_991)
            .is_none()
    {
        return Err(invalid());
    }
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let context = encode(ctx)?;
    let mut ids = exports.to_vec();
    ids.sort();
    ids.dedup();
    if ids.len() != exports.len() {
        return Err(invalid());
    }
    let mut source_manifest = Vec::new();
    let mut groups = Groups::new();
    let mut documents = BTreeMap::<String, SourceTables>::new();
    let mut source_rows = 0usize;
    for id in &ids {
        let (h, raw): (String, String) = tx.query_row(
            "SELECT body_hash,body FROM legacy_web_packages_v1 WHERE export_id=?1 AND tenant_id=?2",
            (id, &ctx.tenant_id),
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        if digest(&raw) != h {
            return Err(Error("TRANSITION_SOURCE_CONFLICT"));
        }
        let p = legacy_web::parse(raw).map_err(|_| invalid())?;
        let v = parse(p.raw_body())?;
        source_manifest.push(json!({"id":id,"kind":"BROWSER","sha256":h}));
        for table in v["tables"].as_array().ok_or_else(invalid)? {
            let name = table["name"].as_str().ok_or_else(invalid)?;
            let rows = parse(table["rowsJson"].as_str().ok_or_else(invalid)?)?;
            documents
                .entry(id.clone())
                .or_default()
                .insert(name.into(), rows.as_array().ok_or_else(invalid)?.clone());
            for row in rows.as_array().ok_or_else(invalid)? {
                source_rows += 1;
                if source_rows > 600_000 {
                    return Err(Error("TRANSITION_TOO_LARGE"));
                }
                add(&mut groups, id, name, row)?;
            }
        }
    }
    if let Some(id) = capture {
        let(saved,h,raw):(String,String,String)=tx.query_row("SELECT context,body_hash,body FROM legacy_cloud_captures_v1 WHERE capture_id=?1 AND tenant_id=?2",(id,&ctx.tenant_id),|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
        if saved != context || digest(&raw) != h {
            return Err(Error("TRANSITION_SOURCE_CONFLICT"));
        }
        source_manifest.push(json!({"id":id,"kind":"CLOUD","sha256":h}));
        let v: Capture = serde_json::from_str(&raw).map_err(|_| invalid())?;
        for table in v.tables {
            documents
                .entry(id.into())
                .or_default()
                .insert(table.name.clone(), table.rows.clone());
            for row in table.rows {
                source_rows += 1;
                if source_rows > 600_000 {
                    return Err(Error("TRANSITION_TOO_LARGE"));
                }
                add(&mut groups, id, &table.name, &row)?;
            }
        }
    }
    let sources = json!(source_manifest).to_string();
    let old: Option<(String, String)> = tx
        .query_row(
            "SELECT context,sources FROM legacy_transition_runs_v1 WHERE run_id=?1",
            [run],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    if let Some((saved, s)) = old {
        if saved != context || s != sources {
            return Err(Error("TRANSITION_SOURCE_CONFLICT"));
        }
        return report(&tx, ctx, run);
    }
    tx.execute("INSERT INTO legacy_transition_runs_v1(run_id,tenant_id,context,sources,created_at_ms,report) VALUES(?1,?2,?3,?4,?5,'{}')",(run,&ctx.tenant_id,context,sources,at))?;
    for ((table, id), variants) in groups {
        let mut merged = normalize(&variants[0].row, 0)?;
        let compatible = variants
            .iter()
            .skip(1)
            .all(|v| normalize(&v.row, 0).is_ok_and(|row| complement(&mut merged, &row)));
        let selected = compatible.then(|| merged.to_string());
        tx.execute("INSERT INTO legacy_transition_rows_v1(run_id,table_name,row_id,variants,selected) VALUES(?1,?2,?3,?4,?5)",(run,table,id,serde_json::to_string(&variants).map_err(|_|invalid())?,selected))?;
    }
    build_documents(&tx, ctx, run, &documents)?;
    recompute(&tx, ctx, run)?;
    tx.commit()?;
    report(c, ctx, run)
}
pub(crate) fn selected(c: &Connection, id: &str) -> Result<BTreeMap<String, Vec<Value>>, Error> {
    let mut out = BTreeMap::<String, Vec<Value>>::new();
    let mut q=c.prepare("SELECT table_name,selected FROM legacy_transition_rows_v1 WHERE run_id=?1 AND selected IS NOT NULL AND excluded=0 ORDER BY table_name,row_id")?;
    for r in q.query_map([id], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })? {
        let (table, raw) = r?;
        out.entry(table).or_default().push(parse(&raw)?);
    }
    Ok(out)
}
fn issue(issues: &mut Vec<Value>, code: &str, table: &str, id: &str, field: &str) {
    issues.push(json!({"code":code,"table":table,"id":id,"field":field}));
}
fn amount(v: &Value, field: &str, t: &str, issues: &mut Vec<Value>) -> Option<i64> {
    let id = v["id"].as_str().unwrap_or("");
    let n = v.get(field).and_then(cents).filter(|n| *n >= 0);
    if n.is_none() {
        issue(issues, "INVALID_MONEY", t, id, field);
    }
    n
}
fn all<'a>(data: &'a BTreeMap<String, Vec<Value>>, t: &str) -> &'a [Value] {
    data.get(t).map_or(&[], |v| v.as_slice())
}
fn checkouts(
    c: &Connection,
    ctx: &CatalogueContext,
    run: &str,
    data: &BTreeMap<String, Vec<Value>>,
) -> Result<BTreeMap<String, super::legacy_checkout::Snapshot>, Error> {
    let sales = all(data, "ventas")
        .iter()
        .map(|v| (v["id"].as_str().unwrap_or(""), v))
        .collect::<BTreeMap<_, _>>();
    let mut out = BTreeMap::<String, super::legacy_checkout::Snapshot>::new();
    let mut conflicts = BTreeSet::new();
    let mut q=c.prepare("SELECT variants,selected,selected_variant FROM legacy_transition_rows_v1 WHERE run_id=?1 AND table_name='operaciones_locales' AND selected IS NOT NULL AND excluded=0")?;
    for row in q.query_map([run], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, Option<String>>(2)?,
        ))
    })? {
        let (raw, selected, chosen) = row?;
        let selected = parse(&selected)?;
        let variants: Vec<Variant> = serde_json::from_str(&raw).map_err(|_| invalid())?;
        for v in variants {
            if chosen.as_deref().is_some_and(|h| h != v.variant_id) {
                continue;
            }
            let Some(sale) = v.row["operation_id"].as_str().and_then(|id| sales.get(id)) else {
                continue;
            };
            let mut normalized = normalize(&v.row, 0)?;
            if !complement(&mut normalized, &selected) || normalized != selected {
                continue;
            }
            if let Some(s) = super::legacy_checkout::read(&ctx.tenant_id, &v.row, sale) {
                if let Some(prior) = out.get(&s.sale_id) {
                    if prior.hash != s.hash
                        || prior.branch != s.branch
                        || prior.invoice != s.invoice
                    {
                        conflicts.insert(s.sale_id.clone());
                    }
                } else {
                    out.insert(s.sale_id.clone(), s);
                }
            }
        }
    }
    for id in conflicts {
        out.remove(&id);
    }
    Ok(out)
}
pub(crate) fn analyze(
    c: &Connection,
    ctx: &CatalogueContext,
    run: &str,
    override_data: Option<BTreeMap<String, Vec<Value>>>,
) -> Result<Value, Error> {
    authorize(c, ctx, run)?;
    let data = match override_data {
        Some(data) => data,
        None => selected(c, run)?,
    };
    let checkouts = checkouts(c, ctx, run, &data)?;
    let (revision, published, sources): (i64, i64, String) = c.query_row(
        "SELECT revision,history_published,sources FROM legacy_transition_runs_v1 WHERE run_id=?1",
        [run],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    let manifest = parse(&sources)?;
    let cloud = manifest
        .as_array()
        .ok_or_else(invalid)?
        .iter()
        .any(|s| s["kind"] == "CLOUD");
    let conflicts: i64 = c.query_row(
        "SELECT count(*) FROM legacy_transition_rows_v1 WHERE run_id=?1 AND selected IS NULL AND excluded=0",
        [run],
        |r| r.get(0),
    )?;
    let document_conflicts: i64 = c.query_row(
        "SELECT count(*) FROM legacy_transition_docs_v1 WHERE run_id=?1 AND state='CONFLICT'",
        [run],
        |r| r.get(0),
    )?;
    let conflicts = conflicts + document_conflicts;
    let mut issues = Vec::new();
    let mut counts = BTreeMap::new();
    let mut scope_data = BTreeMap::<String, Vec<Value>>::new();
    for (table, rows) in &data {
        counts.insert(table.clone(), rows.len());
        for row in rows {
            let rid = row["id"].as_str().ok_or_else(invalid)?;
            if row["negocio_id"] != ctx.tenant_id {
                issue(&mut issues, "TENANT_UNPROVEN", table, rid, "negocio_id");
                continue;
            }
            let checkout_scope =
                table == "ventas" && checkouts.get(rid).is_some_and(|s| s.in_scope(ctx));
            if !in_scope(ctx, table, row)
                && !checkout_scope
                && !linked_sale_scope(ctx, table, row, &data, &checkouts)
            {
                issue(
                    &mut issues,
                    if row.get("sucursal_id").is_some() {
                        "OUTSIDE_SELECTED_SCOPE"
                    } else {
                        "SCOPE_UNPROVEN"
                    },
                    table,
                    rid,
                    "sucursal_id",
                );
                continue;
            }
            if !in_scope(ctx, table, row) && !checkout_scope {
                issue(
                    &mut issues,
                    "SCOPE_FROM_LINKED_SALE",
                    table,
                    rid,
                    "venta_id",
                );
            }
            if checkout_scope && !in_scope(ctx, table, row) {
                issue(
                    &mut issues,
                    "SCOPE_FROM_SAVED_CHECKOUT",
                    table,
                    rid,
                    "operaciones_locales",
                );
            }
            scope_data
                .entry(table.clone())
                .or_default()
                .push(row.clone());
        }
    }
    let data = &scope_data;
    let mut sold = 0;
    let mut valid_sales = conflicts == 0;
    let mut by_method = BTreeMap::<String, i64>::new();
    let mut cash_flow = BTreeMap::<String, i64>::new();
    let mut cash_unknown = false;
    let mut debts = BTreeMap::<String, i64>::new();
    let mut debt_unknown = BTreeSet::<String>::new();
    let mut payments = Vec::new();
    let mut ncfs = BTreeMap::<String, Vec<String>>::new();
    let sales_by_id = all(data, "ventas")
        .iter()
        .map(|s| (s["id"].as_str().unwrap_or(""), s))
        .collect::<BTreeMap<_, _>>();
    let mut cash_effect =
        |row: &Value, t: &str, value: i64, issues: &mut Vec<Value>| -> Result<(), Error> {
            if value == 0 {
                return Ok(());
            }
            if let Some(id) = row["caja_id"].as_str() {
                let old = *cash_flow.get(id).unwrap_or(&0);
                cash_flow.insert(id.into(), sum(old, value)?);
            } else {
                cash_unknown = true;
                issue(
                    issues,
                    "CASH_LINK_UNKNOWN",
                    t,
                    row["id"].as_str().unwrap_or(""),
                    "caja_id",
                );
            }
            Ok(())
        };
    for sale in all(data, "ventas") {
        let id = sale["id"].as_str().ok_or_else(invalid)?;
        if let Some(ncf) = sale["ncf"].as_str().filter(|s| !s.is_empty()) {
            ncfs.entry(ncf.into()).or_default().push(id.into());
        }
        let Some(total) = amount(sale, "total", "ventas", &mut issues) else {
            valid_sales = false;
            continue;
        };
        sold = sum(sold, total)?;
        let method = sale["metodo_pago"].as_str().unwrap_or("");
        if !["efectivo", "tarjeta", "transferencia", "mixto", "fiado"].contains(&method) {
            issue(&mut issues, "PAYMENT_UNKNOWN", "ventas", id, "metodo_pago");
        } else {
            let entry = by_method.entry(method.into()).or_default();
            *entry = sum(*entry, total)?;
        }
        let cash = if method == "efectivo" {
            Some(total)
        } else if method == "mixto" {
            let a = amount(sale, "monto_efectivo", "ventas", &mut issues);
            let b = amount(sale, "monto_transferencia", "ventas", &mut issues);
            match (a, b) {
                (Some(a), Some(b)) if a > 0 && b > 0 && sum(a, b)? == total => Some(a),
                _ => {
                    issue(
                        &mut issues,
                        "MIXED_PAYMENT_MISMATCH",
                        "ventas",
                        id,
                        "monto_efectivo",
                    );
                    None
                }
            }
        } else if ["tarjeta", "transferencia", "fiado"].contains(&method) {
            Some(0)
        } else {
            None
        };
        if let Some(cash) = cash {
            cash_effect(sale, "ventas", cash, &mut issues)?;
        }
        if !all(data, "venta_detalles")
            .iter()
            .any(|l| l["venta_id"] == id)
        {
            issue(
                &mut issues,
                "SALE_DETAILS_MISSING",
                "ventas",
                id,
                "venta_detalles",
            );
        }
        if method == "fiado" {
            let charges = all(data, "transacciones_fiado")
                .iter()
                .filter(|r| r["venta_id"] == id && r["tipo"] == "cargo")
                .collect::<Vec<_>>();
            let mut charged = 0;
            let mut complete = !charges.is_empty();
            for charge in charges {
                if sale["cliente_id"].is_null() || charge["cliente_id"] != sale["cliente_id"] {
                    complete = false;
                }
                if let Some(n) = charge.get("monto").and_then(cents) {
                    charged = sum(charged, n)?;
                } else {
                    complete = false;
                }
            }
            if !complete || charged != total {
                issue(
                    &mut issues,
                    "CREDIT_CHARGE_MISMATCH",
                    "ventas",
                    id,
                    "transacciones_fiado",
                );
            }
        }
    }
    for detail in all(data, "venta_detalles") {
        let id = detail["id"].as_str().unwrap_or("");
        if !sales_by_id.contains_key(detail["venta_id"].as_str().unwrap_or("")) {
            issue(
                &mut issues,
                "SALE_REFERENCE_MISSING",
                "venta_detalles",
                id,
                "venta_id",
            );
        }
        let unit = amount(detail, "precio_unitario", "venta_detalles", &mut issues);
        let subtotal = amount(detail, "subtotal", "venta_detalles", &mut issues);
        let qty = detail
            .get("cantidad")
            .and_then(number)
            .and_then(|s| decimal(&s));
        match (unit, subtotal, qty) {
            (Some(unit), Some(subtotal), Some((n, scale))) if n > BigInt::from(0u8) => {
                let denominator = BigInt::from(10u8).pow(scale);
                let multiplied = n * unit;
                if &multiplied % &denominator != BigInt::from(0u8)
                    || (&multiplied / &denominator).to_i64() != Some(subtotal)
                {
                    issue(
                        &mut issues,
                        "DETAIL_AMOUNT_MISMATCH",
                        "venta_detalles",
                        id,
                        "subtotal",
                    );
                }
            }
            _ => issue(
                &mut issues,
                "DETAIL_AMOUNT_MISMATCH",
                "venta_detalles",
                id,
                "cantidad",
            ),
        }
    }
    for r in all(data, "transacciones_fiado") {
        let id = r["id"].as_str().unwrap_or("");
        let Some(customer) = r["cliente_id"].as_str() else {
            issue(
                &mut issues,
                "CUSTOMER_REFERENCE_MISSING",
                "transacciones_fiado",
                id,
                "cliente_id",
            );
            continue;
        };
        debts.entry(customer.into()).or_default();
        if !all(data, "clientes").iter().any(|c| c["id"] == customer) {
            debt_unknown.insert(customer.into());
            issue(
                &mut issues,
                "CUSTOMER_REFERENCE_MISSING",
                "transacciones_fiado",
                id,
                "cliente_id",
            );
        }
        let Some(n) = amount(r, "monto", "transacciones_fiado", &mut issues) else {
            debt_unknown.insert(customer.into());
            continue;
        };
        let change = match r["tipo"].as_str() {
            Some("cargo") => n,
            Some("abono") => -n,
            _ => {
                debt_unknown.insert(customer.into());
                issue(
                    &mut issues,
                    "CREDIT_TYPE_UNKNOWN",
                    "transacciones_fiado",
                    id,
                    "tipo",
                );
                continue;
            }
        };
        let old = debts.entry(customer.into()).or_default();
        *old = sum(*old, change)?;
        if r["tipo"] == "abono" {
            match r["metodo_pago"].as_str() {
                Some("efectivo") => cash_effect(r, "transacciones_fiado", n, &mut issues)?,
                Some("tarjeta" | "transferencia") => {}
                _ => issue(
                    &mut issues,
                    "PAYMENT_UNKNOWN",
                    "transacciones_fiado",
                    id,
                    "metodo_pago",
                ),
            }
        }
    }
    for (t, field, totalfield) in [
        ("reparaciones", "pagos", "abono"),
        ("apartados", "abonos", "abonado"),
    ] {
        for doc in all(data, t) {
            let id = doc["id"].as_str().unwrap_or("");
            let Some(list) = doc[field].as_array() else {
                issue(&mut issues, "PAYMENT_HISTORY_MISSING", t, id, field);
                continue;
            };
            let mut total = 0;
            let mut occurrences = BTreeMap::<String, usize>::new();
            for p in list {
                let normalized = normalize(p, 0)?;
                let fingerprint = digest(&normalized.to_string());
                let occurrence = occurrences.entry(fingerprint.clone()).or_default();
                let identity = digest(
                    &json!([ctx.tenant_id, t, id, field, fingerprint, *occurrence]).to_string(),
                );
                *occurrence += 1;
                let mut row = p.clone();
                row["id"] = json!(id);
                let Some(n) = amount(&row, "monto", t, &mut issues) else {
                    continue;
                };
                total = sum(total, n)?;
                payments.push(json!({"id":identity,"table":t,"documentId":id,"montoCents":n.to_string(),"method":p["metodo"],"cajaId":p["caja_id"]}));
                match p["metodo"].as_str() {
                    Some("efectivo") => cash_effect(&row, t, n, &mut issues)?,
                    Some("tarjeta" | "transferencia") => {}
                    _ => issue(&mut issues, "PAYMENT_UNKNOWN", t, id, "metodo"),
                }
            }
            if amount(doc, totalfield, t, &mut issues) != Some(total) {
                issue(&mut issues, "PAYMENT_SUM_MISMATCH", t, id, totalfield);
            }
        }
    }
    for r in all(data, "devoluciones") {
        let id = r["id"].as_str().unwrap_or("");
        let Some(sale) = sales_by_id.get(r["venta_id"].as_str().unwrap_or("")) else {
            issue(
                &mut issues,
                "SALE_REFERENCE_MISSING",
                "devoluciones",
                id,
                "venta_id",
            );
            continue;
        };
        if let Some(n) = amount(r, "monto_devuelto", "devoluciones", &mut issues) {
            match sale["metodo_pago"].as_str() {
                Some("efectivo") => cash_effect(r, "devoluciones", -n, &mut issues)?,
                Some("tarjeta" | "transferencia") => {}
                Some("fiado") => issue(
                    &mut issues,
                    "CREDIT_RETURN_UNPROVEN",
                    "devoluciones",
                    id,
                    "transacciones_fiado",
                ),
                _ => issue(
                    &mut issues,
                    "RETURN_PAYMENT_UNPROVEN",
                    "devoluciones",
                    id,
                    "metodo_pago",
                ),
            }
        }
    }
    for r in all(data, "gastos") {
        if r["eliminado"] == true {
            continue;
        }
        let id = r["id"].as_str().unwrap_or("");
        if let Some(n) = amount(r, "monto", "gastos", &mut issues) {
            match r["metodo"].as_str() {
                Some("efectivo") => cash_effect(r, "gastos", -n, &mut issues)?,
                Some("tarjeta" | "transferencia") => {}
                _ => issue(&mut issues, "PAYMENT_UNKNOWN", "gastos", id, "metodo"),
            }
        }
    }
    // A partial sum is retained for review, never exposed as a complete balance.
    cash_unknown |= conflicts > 0
        || issues.iter().any(|i| {
            matches!(
                i["code"].as_str(),
                Some(
                    "INVALID_MONEY"
                        | "PAYMENT_UNKNOWN"
                        | "MIXED_PAYMENT_MISMATCH"
                        | "PAYMENT_HISTORY_MISSING"
                        | "PAYMENT_SUM_MISMATCH"
                        | "RETURN_PAYMENT_UNPROVEN"
                        | "SCOPE_UNPROVEN"
                        | "TENANT_UNPROVEN"
                )
            ) && scoped_table(i["table"].as_str().unwrap_or(""))
        });
    let mut cash = Vec::new();
    for row in all(data, "cajas") {
        let id = row["id"].as_str().unwrap_or("");
        let opening = amount(row, "monto_apertura", "cajas", &mut issues);
        let movement = cash_flow.remove(id).unwrap_or(0);
        let expected = opening.map(|n| sum(n, movement)).transpose()?;
        if let (Some(saved), Some(computed)) = (row.get("monto_esperado").and_then(cents), expected)
        {
            if saved != computed {
                issue(
                    &mut issues,
                    "CASH_EXPECTED_MISMATCH",
                    "cajas",
                    id,
                    "monto_esperado",
                );
            }
        }
        cash.push(json!({"id":id,"state":row["estado"],"openingCents":opening.map(|v|v.to_string()),"movementsCents":movement.to_string(),"observedExpectedCents":expected.map(|v|v.to_string()),"expectedCents":if cash_unknown{None}else{expected.map(|v|v.to_string())},"coverage":if cash_unknown{"LINKED_FACTS_ONLY"}else{"EXPLICIT_LINKS_ONLY"}}));
    }
    for id in cash_flow.keys() {
        issue(
            &mut issues,
            "CASH_REFERENCE_MISSING",
            "cajas",
            id,
            "caja_id",
        );
    }
    for (ncf, ids) in ncfs {
        if ids.len() > 1 {
            for id in ids {
                issue(&mut issues, "NCF_DUPLICATE", "ventas", &id, &ncf);
            }
        }
    }
    let ledger_incomplete = conflicts > 0
        || issues.iter().any(|i| {
            i["table"] == "transacciones_fiado"
                && matches!(
                    i["code"].as_str(),
                    Some("SCOPE_UNPROVEN" | "TENANT_UNPROVEN" | "CUSTOMER_REFERENCE_MISSING")
                )
        });
    let debt_rows=debts.into_iter().map(|(id,balance)|{let incomplete=ledger_incomplete||debt_unknown.contains(&id);json!({"customerId":id,"name":all(data,"clientes").iter().find(|c|c["id"]==id).and_then(|c|c["nombre"].as_str()),"balanceCents":if incomplete{None}else{Some(balance.to_string())},"observedBalanceCents":balance.to_string(),"coverage":if incomplete{"INCOMPLETE_SELECTED_LEDGER"}else{"SELECTED_SCOPED_LEDGER"}})}).collect::<Vec<_>>();
    let report = json!({"runId":run,"revision":revision,"historyPublished":published==1,"createdAtMs":c.query_row("SELECT created_at_ms FROM legacy_transition_runs_v1 WHERE run_id=?1",[run],|r|r.get::<_,String>(0))?,"sources":manifest,"counts":counts,"conflicts":conflicts,"issues":issues,"sales":{"totalCents":if valid_sales{Some(sold.to_string())}else{None},"byMethodCents":by_method.into_iter().map(|(k,v)|(k,v.to_string())).collect::<BTreeMap<_,_>>()},"debts":debt_rows,"cash":cash,"payments":payments,"cloudCoverage":if cloud{"SCOPE_COMPLETE_SINGLE_SNAPSHOT"}else{"BROWSER_COPIES_ONLY"},"effectStatus":"UNKNOWN_LEGACY","canActivate":false});
    let mut report = report;
    report["localCheckoutProofs"] =
        json!(checkouts.values().map(|s| s.proof()).collect::<Vec<_>>());
    report["documentConflicts"] = json!(document_conflicts);
    Ok(report)
}
fn recompute(c: &Connection, ctx: &CatalogueContext, run: &str) -> Result<(), Error> {
    let value = analyze(c, ctx, run, None)?;
    c.execute(
        "UPDATE legacy_transition_runs_v1 SET report=?2 WHERE run_id=?1",
        (run, value.to_string()),
    )?;
    Ok(())
}
pub fn report(c: &Connection, ctx: &CatalogueContext, id: &str) -> Result<Value, Error> {
    authorize(c, ctx, id)?;
    let raw: String = c.query_row(
        "SELECT report FROM legacy_transition_runs_v1 WHERE run_id=?1",
        [id],
        |r| r.get(0),
    )?;
    parse(&raw)
}
pub fn view(c: &Connection, ctx: &CatalogueContext) -> Result<Value, Error> {
    let context = encode(ctx)?;
    let run:Option<String>=c.query_row("SELECT run_id FROM legacy_transition_runs_v1 WHERE tenant_id=?1 AND context=?2 ORDER BY rowid DESC LIMIT 1",(&ctx.tenant_id,context),|r|r.get(0)).optional()?;
    let capture:Option<(String,String)>=c.query_row("SELECT capture_id,captured_at_ms FROM legacy_cloud_captures_v1 WHERE tenant_id=?1 AND context=?2 ORDER BY rowid DESC LIMIT 1",(&ctx.tenant_id,encode(ctx)?),|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
    Ok(
        json!({"report":run.map(|id|report(c,ctx,&id)).transpose()?,"capture":capture.map(|(id,at)|json!({"captureId":id,"capturedAtMs":at}))}),
    )
}
pub fn rows(
    c: &Connection,
    ctx: &CatalogueContext,
    id: &str,
    table: &str,
    page: u32,
) -> Result<Value, Error> {
    authorize(c, ctx, id)?;
    if !legacy_web::TABLES.contains(&table) || page > 60_000 {
        return Err(invalid());
    }
    let total: i64 = c.query_row(
        "SELECT count(*) FROM legacy_transition_rows_v1 WHERE run_id=?1 AND table_name=?2",
        (id, table),
        |r| r.get(0),
    )?;
    let mut q=c.prepare("SELECT row_id,variants,selected,selected_variant,excluded FROM legacy_transition_rows_v1 WHERE run_id=?1 AND table_name=?2 ORDER BY (selected IS NULL) DESC,row_id LIMIT 10 OFFSET ?3")?;
    let mut rows = Vec::new();
    for r in q.query_map((id, table, page as i64 * 10), |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, Option<String>>(2)?,
            r.get::<_, Option<String>>(3)?,
            r.get::<_, bool>(4)?,
        ))
    })? {
        let (row_id, variants, selected, variant, excluded) = r?;
        let mut row = json!({"id":row_id,"variants":parse(&variants)?,"selected":selected.map(|s|parse(&s)).transpose()?,"selectedVariant":variant,"excluded":excluded});
        if table == "ventas" {
            let doc:Option<(String,String,Option<String>)>=c.query_row("SELECT state,variants,chosen_source FROM legacy_transition_docs_v1 WHERE run_id=?1 AND sale_id=?2",(id,&row_id),|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
            if let Some((state, variants, chosen)) = doc {
                row["document"] =
                    json!({"state":state,"variants":parse(&variants)?,"chosenSource":chosen});
            }
        }
        rows.push(row);
    }
    Ok(json!({"rows":rows,"total":total,"page":page}))
}
pub struct Decision<'a> {
    pub table: &'a str,
    pub row_id: &'a str,
    pub variant_id: &'a str,
    pub revision: u32,
    pub reason: &'a str,
}
pub struct DocumentDecision<'a> {
    pub sale_id: &'a str,
    pub source_id: &'a str,
    pub revision: u32,
    pub reason: &'a str,
}
fn child_owner<'a>(table: &str, row: &'a Value) -> Option<&'a str> {
    match table {
        "ventas" => row["id"].as_str(),
        "venta_detalles" => row["venta_id"].as_str(),
        "transacciones_fiado" if row["tipo"] == "cargo" => row["venta_id"].as_str(),
        "movimientos_stock" if row["tipo"] == "venta" => row["referencia_id"].as_str(),
        "operaciones_locales" if matches!(row["tipo"].as_str(), Some("SALE" | "CHECKOUT")) => {
            row["operation_id"].as_str()
        }
        _ => None,
    }
}
pub fn resolve_document(
    c: &mut Connection,
    ctx: &CatalogueContext,
    run: &str,
    d: DocumentDecision<'_>,
) -> Result<Value, Error> {
    let reason = d.reason.trim();
    if reason.chars().count() < 10
        || reason.chars().count() > 500
        || reason.chars().any(char::is_control)
    {
        return Err(invalid());
    }
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    authorize(&tx, ctx, run)?;
    let (revision, published): (u32, bool) = tx.query_row(
        "SELECT revision,history_published FROM legacy_transition_runs_v1 WHERE run_id=?1",
        [run],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    if revision != d.revision || published {
        return Err(Error("TRANSITION_REVISION"));
    }
    let raw: String = tx.query_row(
        "SELECT variants FROM legacy_transition_docs_v1 WHERE run_id=?1 AND sale_id=?2",
        (run, d.sale_id),
        |r| r.get(0),
    )?;
    let documents: Vec<Document> = serde_json::from_str(&raw).map_err(|_| invalid())?;
    let chosen = documents
        .iter()
        .find(|v| v.source_id == d.source_id)
        .ok_or_else(invalid)?;
    let mut selected_rows = BTreeMap::<(String, String), Value>::new();
    for (table, rows) in [
        ("ventas", std::slice::from_ref(&chosen.sale)),
        ("venta_detalles", chosen.details.as_slice()),
        ("transacciones_fiado", chosen.charges.as_slice()),
        ("movimientos_stock", chosen.inventory.as_slice()),
        ("operaciones_locales", chosen.journals.as_slice()),
    ] {
        for row in rows {
            if row["negocio_id"] != ctx.tenant_id || child_owner(table, row) != Some(d.sale_id) {
                return Err(Error("TRANSITION_DOCUMENT_OWNERSHIP"));
            }
            let id = row["id"].as_str().ok_or_else(invalid)?;
            selected_rows.insert((table.into(), id.into()), normalize(row, 0)?);
        }
    }
    let mut q=tx.prepare("SELECT table_name,row_id,variants FROM legacy_transition_rows_v1 WHERE run_id=?1 AND table_name IN('ventas','venta_detalles','transacciones_fiado','movimientos_stock','operaciones_locales')")?;
    let mut related = Vec::new();
    for record in q.query_map([run], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
        ))
    })? {
        let (table, id, raw) = record?;
        let variants: Vec<Variant> = serde_json::from_str(&raw).map_err(|_| invalid())?;
        if variants
            .iter()
            .any(|v| child_owner(&table, &v.row) == Some(d.sale_id))
        {
            if variants
                .iter()
                .filter_map(|v| child_owner(&table, &v.row))
                .any(|owner| owner != d.sale_id)
            {
                return Err(Error("TRANSITION_DOCUMENT_OWNERSHIP"));
            }
            related.push((table, id));
        }
    }
    drop(q);
    for (table, id) in related {
        if let Some(row) = selected_rows.get(&(table.clone(), id.clone())) {
            tx.execute("UPDATE legacy_transition_rows_v1 SET selected=?4,selected_variant=?5,excluded=0 WHERE run_id=?1 AND table_name=?2 AND row_id=?3",(run,&table,&id,row.to_string(),digest(&row.to_string())))?;
        } else {
            tx.execute("UPDATE legacy_transition_rows_v1 SET excluded=1 WHERE run_id=?1 AND table_name=?2 AND row_id=?3",(run,table,id))?;
        }
    }
    let next = revision.checked_add(1).ok_or_else(invalid)?;
    tx.execute("UPDATE legacy_transition_docs_v1 SET state='CHOSEN',chosen_source=?3 WHERE run_id=?1 AND sale_id=?2",(run,d.sale_id,d.source_id))?;
    tx.execute(
        "INSERT INTO legacy_transition_decisions_v1 VALUES(?1,?2,'SALE_DOCUMENT',?3,?4,?5,?6)",
        (run, next, d.sale_id, d.source_id, &ctx.actor_id, reason),
    )?;
    tx.execute(
        "UPDATE legacy_transition_runs_v1 SET revision=?2 WHERE run_id=?1",
        (run, next),
    )?;
    recompute(&tx, ctx, run)?;
    tx.commit()?;
    report(c, ctx, run)
}
pub fn resolve(
    c: &mut Connection,
    ctx: &CatalogueContext,
    run: &str,
    decision: Decision<'_>,
) -> Result<Value, Error> {
    let Decision {
        table,
        row_id: id,
        variant_id: variant,
        revision,
        reason,
    } = decision;
    let reason = reason.trim();
    if reason.chars().count() < 10
        || reason.chars().count() > 500
        || reason.chars().any(char::is_control)
    {
        return Err(invalid());
    }
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    authorize(&tx, ctx, run)?;
    let (saved, published): (u32, bool) = tx.query_row(
        "SELECT revision,history_published FROM legacy_transition_runs_v1 WHERE run_id=?1",
        [run],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    if saved != revision || published {
        return Err(Error("TRANSITION_REVISION"));
    }
    let raw:String=tx.query_row("SELECT variants FROM legacy_transition_rows_v1 WHERE run_id=?1 AND table_name=?2 AND row_id=?3",(run,table,id),|r|r.get(0))?;
    let variants: Vec<Variant> = serde_json::from_str(&raw).map_err(|_| invalid())?;
    for variant in &variants {
        if let Some(owner) = child_owner(table, &variant.row) {
            let state: Option<String> = tx
                .query_row(
                    "SELECT state FROM legacy_transition_docs_v1 WHERE run_id=?1 AND sale_id=?2",
                    (run, owner),
                    |r| r.get(0),
                )
                .optional()?;
            if state.as_deref().is_some_and(|s| s != "CONSENSUS") {
                return Err(Error("TRANSITION_DOCUMENT_REQUIRED"));
            }
        }
    }
    let chosen = variants
        .iter()
        .find(|v| v.variant_id == variant)
        .ok_or_else(invalid)?;
    let n = saved.checked_add(1).ok_or_else(invalid)?;
    tx.execute("UPDATE legacy_transition_rows_v1 SET selected=?4,selected_variant=?5 WHERE run_id=?1 AND table_name=?2 AND row_id=?3",(run,table,id,normalize(&chosen.row,0)?.to_string(),variant))?;
    tx.execute(
        "INSERT INTO legacy_transition_decisions_v1 VALUES(?1,?2,?3,?4,?5,?6,?7)",
        (run, n, table, id, variant, &ctx.actor_id, reason),
    )?;
    tx.execute(
        "UPDATE legacy_transition_runs_v1 SET revision=?2 WHERE run_id=?1",
        (run, n),
    )?;
    recompute(&tx, ctx, run)?;
    tx.commit()?;
    report(c, ctx, run)
}
pub fn publish_history(
    c: &mut Connection,
    ctx: &CatalogueContext,
    run: &str,
    revision: u32,
) -> Result<Value, Error> {
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let v = report(&tx, ctx, run)?;
    if v["revision"] != revision || v["conflicts"] != 0 {
        return Err(Error("TRANSITION_REVIEW_REQUIRED"));
    }
    let old: Option<String> = tx
        .query_row(
            "SELECT run_id FROM legacy_history_active_v1 WHERE tenant_id=?1 AND scope_key=?2",
            (&ctx.tenant_id, scope_key(ctx)),
            |r| r.get(0),
        )
        .optional()?;
    if let Some(ref old) = old {
        if old != run {
            let prior_sources: String = tx.query_row(
                "SELECT sources FROM legacy_transition_runs_v1 WHERE run_id=?1",
                [old],
                |r| r.get(0),
            )?;
            let prior = parse(&prior_sources)?;
            if !prior.as_array().ok_or_else(invalid)?.iter().all(|s| {
                v["sources"]
                    .as_array()
                    .is_some_and(|sources| sources.contains(s))
            }) {
                return Err(Error("TRANSITION_HISTORY_EXISTS"));
            }
            let previous = selected(&tx, old)?;
            let next = selected(&tx, run)?;
            for (table, rows) in previous {
                for mut old in rows {
                    let new = all(&next, &table)
                        .iter()
                        .find(|r| r["id"] == old["id"])
                        .ok_or(Error("TRANSITION_HISTORY_EXISTS"))?;
                    if !complement(&mut old, new) || old != *new {
                        return Err(Error("TRANSITION_HISTORY_EXISTS"));
                    }
                }
            }
        }
    }
    tx.execute(
        "INSERT INTO legacy_history_active_v1 VALUES(?1,?2,?3) ON CONFLICT(tenant_id,scope_key) DO UPDATE SET run_id=excluded.run_id",
        (&ctx.tenant_id, scope_key(ctx), run),
    )?;
    tx.execute(
        "UPDATE legacy_transition_runs_v1 SET history_published=1 WHERE run_id=?1",
        [run],
    )?;
    recompute(&tx, ctx, run)?;
    tx.commit()?;
    report(c, ctx, run)
}
pub(crate) fn history_data(
    c: &Connection,
    ctx: &CatalogueContext,
) -> Result<Option<BTreeMap<String, Vec<Value>>>, Error> {
    encode(ctx)?;
    let present:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='legacy_history_active_v1')",[],|r|r.get(0))?;
    if !present {
        return Ok(None);
    }
    let run: Option<String> = c
        .query_row(
            "SELECT run_id FROM legacy_history_active_v1 WHERE tenant_id=?1 AND scope_key=?2",
            (&ctx.tenant_id, scope_key(ctx)),
            |r| r.get(0),
        )
        .optional()?;
    let mut data = run.map(|id| selected(c, &id)).transpose()?;
    if let Some(remote) =
        super::legacy_cutover::resolution_history_data(c, ctx).map_err(|_| invalid())?
    {
        let merged = data.get_or_insert_with(BTreeMap::new);
        for (table, rows) in remote {
            let current = merged.entry(table).or_default();
            for row in rows {
                if !current.iter().any(|r| r["id"] == row["id"]) {
                    current.push(row);
                }
            }
        }
    }
    Ok(data)
}
fn active_run(c: &Connection, ctx: &CatalogueContext) -> Result<Option<String>, Error> {
    encode(ctx)?;
    let present:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='legacy_history_active_v1')",[],|r|r.get(0))?;
    if !present {
        return Ok(None);
    }
    Ok(c.query_row(
        "SELECT run_id FROM legacy_history_active_v1 WHERE tenant_id=?1 AND scope_key=?2",
        (&ctx.tenant_id, scope_key(ctx)),
        |r| r.get(0),
    )
    .optional()?)
}
fn ticket_number(row: &Value) -> String {
    let n = row
        .get("numero_ticket")
        .and_then(exact_int)
        .filter(|n| *n >= 0)
        .map(|n| format!("{n:06}"));
    match (n, row["caja_codigo"].as_str()) {
        (Some(n), Some(code)) if !code.is_empty() => format!("{code}-{n}"),
        (Some(n), _) => n,
        _ => row["id"].as_str().unwrap_or("Sin número guardado").into(),
    }
}
pub fn history(
    c: &Connection,
    ctx: &CatalogueContext,
    search: &str,
    method: Option<&str>,
    from: Option<&str>,
    to: Option<&str>,
    page: u32,
) -> Result<Value, Error> {
    if page == 0
        || page > 100_000
        || search.chars().count() > 256
        || search.chars().any(char::is_control)
    {
        return Err(invalid());
    }
    let from = from
        .map(|s| s.parse::<i64>().map_err(|_| invalid()))
        .transpose()?;
    let to = to
        .map(|s| s.parse::<i64>().map_err(|_| invalid()))
        .transpose()?;
    if matches!((from,to),(Some(a),Some(b))if a>=b) {
        return Err(invalid());
    }
    let data = history_data(c, ctx)?.unwrap_or_default();
    let checkouts = active_run(c, ctx)?
        .map(|run| checkouts(c, ctx, &run, &data))
        .transpose()?
        .unwrap_or_default();
    let mut native_ids = BTreeSet::new();
    let mut query = c.prepare("SELECT operation_id FROM sales WHERE tenant_id=?1")?;
    for row in query.query_map([&ctx.tenant_id], |r| r.get::<_, String>(0))? {
        native_ids.insert(row?);
    }
    let mut rows = Vec::new();
    for r in all(&data, "ventas") {
        if r["negocio_id"] != ctx.tenant_id
            || (!in_scope(ctx, "ventas", r)
                && !checkouts
                    .get(r["id"].as_str().unwrap_or(""))
                    .is_some_and(|s| s.in_scope(ctx)))
        {
            continue;
        }
        if native_ids.contains(r["id"].as_str().unwrap_or("")) {
            continue;
        }
        let ticket = ticket_number(r);
        let date = r
            .get("fecha_creacion")
            .and_then(exact_int)
            .filter(|n| *n >= 0 && *n <= 9_007_199_254_740_991);
        let name = r["cliente_nombre"].as_str().map(str::to_owned);
        let search = search.trim().to_lowercase();
        if method.is_some_and(|m| r["metodo_pago"].as_str() != Some(m.to_lowercase().as_str()))
            || from.is_some_and(|a| date.is_none_or(|d| d < a))
            || to.is_some_and(|b| date.is_none_or(|d| d >= b))
            || ![Some(ticket.as_str()), r["ncf"].as_str(), name.as_deref()]
                .into_iter()
                .flatten()
                .any(|s| s.to_lowercase().contains(&search))
        {
            continue;
        }
        rows.push(json!({"id":r["id"],"ticket":ticket,"dateMs":date.map(|v|v.to_string()),"method":r["metodo_pago"],"totalCents":r.get("total").and_then(cents).map(|v|v.to_string()),"ncf":r["ncf"],"customerName":name,"effectStatus":"UNKNOWN_LEGACY"}));
    }
    rows.sort_by(|a, b| {
        b["dateMs"]
            .as_str()
            .and_then(|s| s.parse::<i64>().ok())
            .cmp(&a["dateMs"].as_str().and_then(|s| s.parse::<i64>().ok()))
            .then_with(|| a["id"].as_str().cmp(&b["id"].as_str()))
    });
    let total = rows.len();
    let rows = rows
        .into_iter()
        .skip((page as usize - 1) * 10)
        .take(10)
        .collect::<Vec<_>>();
    Ok(
        json!({"rows":rows,"total":total.to_string(),"page":page,"pageSize":10,"coverage":"PUBLISHED_LEGACY_HISTORY"}),
    )
}
pub fn ticket(c: &Connection, ctx: &CatalogueContext, id: &str) -> Result<Value, Error> {
    let data = history_data(c, ctx)?.ok_or_else(invalid)?;
    let checkouts = active_run(c, ctx)?
        .map(|run| checkouts(c, ctx, &run, &data))
        .transpose()?
        .unwrap_or_default();
    let saved = super::legacy_cutover::resolution_history_tickets(c, ctx).map_err(|_| ());
    project_ticket(ctx, &data, &checkouts, &saved, id)
}
/// Project a frozen set of historical tickets with the same published-first,
/// run-fallback rules as individual ticket reads. Read each
/// source and verify its checkout proofs once for the whole writer transaction.
pub(crate) fn history_tickets(
    c: &Connection,
    ctx: &CatalogueContext,
    run: &str,
    ids: &[String],
) -> Result<Vec<Value>, Error> {
    authorize(c, ctx, run)?;
    let published = (|| {
        let data = history_data(c, ctx)?.ok_or_else(invalid)?;
        let proofs = active_run(c, ctx)?
            .map(|active| checkouts(c, ctx, &active, &data))
            .transpose()?
            .unwrap_or_default();
        Ok::<_, Error>((ticket_data_by_sale(&data), proofs))
    })()
    .ok();
    let fallback = (|| {
        let data = selected(c, run)?;
        let proofs = checkouts(c, ctx, run, &data)?;
        Ok::<_, Error>((ticket_data_by_sale(&data), proofs))
    })()
    .ok();
    let saved = super::legacy_cutover::resolution_history_tickets(c, ctx).map_err(|_| ());
    Ok(ids
        .iter()
        .filter_map(|id| {
            published
                .as_ref()
                .and_then(|(data, proofs)| {
                    data.get(id)
                        .and_then(|rows| project_ticket(ctx, rows, proofs, &saved, id).ok())
                })
                .or_else(|| {
                    fallback.as_ref().and_then(|(data, proofs)| {
                        data.get(id)
                            .and_then(|rows| project_ticket(ctx, rows, proofs, &saved, id).ok())
                    })
                })
        })
        .collect())
}
fn ticket_data_by_sale(
    data: &BTreeMap<String, Vec<Value>>,
) -> BTreeMap<String, BTreeMap<String, Vec<Value>>> {
    let mut indexed = BTreeMap::<String, BTreeMap<String, Vec<Value>>>::new();
    for (table, field) in [("ventas", "id"), ("venta_detalles", "venta_id")] {
        for row in all(data, table) {
            if let Some(id) = row[field].as_str() {
                indexed
                    .entry(id.to_owned())
                    .or_default()
                    .entry(table.to_owned())
                    .or_default()
                    .push(row.clone());
            }
        }
    }
    indexed
}
fn project_ticket(
    ctx: &CatalogueContext,
    data: &BTreeMap<String, Vec<Value>>,
    checkouts: &BTreeMap<String, super::legacy_checkout::Snapshot>,
    saved_tickets: &Result<BTreeMap<String, Value>, ()>,
    id: &str,
) -> Result<Value, Error> {
    let r = all(data, "ventas")
        .iter()
        .find(|r| {
            r["id"] == id
                && r["negocio_id"] == ctx.tenant_id
                && (in_scope(ctx, "ventas", r)
                    || checkouts.get(id).is_some_and(|s| s.in_scope(ctx)))
        })
        .ok_or_else(invalid)?;
    if !checkouts.contains_key(id) {
        if let Some(saved) = saved_tickets.as_ref().map_err(|_| invalid())?.get(id) {
            if saved["totalCents"] == json!(r.get("total").and_then(cents).map(|n| n.to_string())) {
                return Ok(saved.clone());
            }
        }
    }
    let lines=all(data,"venta_detalles").iter().filter(|l|l["venta_id"]==id&&l["negocio_id"]==ctx.tenant_id).map(|l|json!({"id":l["id"],"name":l["nombre"],"quantity":l.get("cantidad").and_then(number),"unitPriceCents":l.get("precio_unitario").and_then(cents).map(|n|n.to_string()),"subtotalCents":l.get("subtotal").and_then(cents).map(|n|n.to_string())})).collect::<Vec<_>>();
    let mut ticket = json!({"id":id,"ticket":ticket_number(r),"ncf":r["ncf"],"dateMs":r.get("fecha_creacion").and_then(exact_int).map(|n|n.to_string()),"customerName":r["cliente_nombre"],"actorName":r["vendedor_nombre"],"method":r["metodo_pago"],"totalCents":r.get("total").and_then(cents).map(|n|n.to_string()),"subtotalCents":r.get("subtotal").and_then(cents).map(|n|n.to_string()),"itbisCents":r.get("itbis").and_then(cents).map(|n|n.to_string()),"discountCents":r.get("descuento").and_then(cents).map(|n|n.to_string()),"receivedCents":null,"changeCents":null,"business":null,"lines":lines,"coverage":"PRESERVED_LEGACY_FIELDS","effectStatus":"UNKNOWN_LEGACY"});
    if let Some(s) = checkouts.get(id) {
        let invoice = &s.invoice;
        // Use the saved invoice's descriptions/serials, never today's catalogue.
        ticket["lines"]=json!(invoice["items"].as_array().ok_or_else(invalid)?.iter().map(|l|{
            let subtotal=l.get("precio_venta").and_then(cents).and_then(|price|{
                let(n,scale)=decimal(&number(&l["cantidad"])?)?;let d=BigInt::from(10u8).pow(scale);let value=n*price;
                if &value%&d!=BigInt::from(0u8){return None;}MoneyCents::from_i128((value/d).to_i128()?).ok().map(|n|n.to_dto())
            });json!({"id":l["id"],"name":l["nombre"],"quantity":l.get("cantidad").and_then(number),"unitPriceCents":l.get("precio_venta").and_then(cents).map(|n|n.to_string()),"subtotalCents":subtotal,"serial":l["serial_numero"],"location":l["ubicacion"]})
        }).collect::<Vec<_>>());
        for (target, field) in [
            ("subtotalCents", "subtotal"),
            ("itbisCents", "itbis"),
            ("discountCents", "descuento"),
            ("receivedCents", "montoRecibido"),
        ] {
            ticket[target] = json!(invoice.get(field).and_then(cents).map(|n| n.to_string()));
        }
        let business = &invoice["negocio"];
        ticket["business"] = json!({"name":business["nombre"],"rnc":business["rnc"],"address":business["direccion"],"phone":business["telefono"],"footer":business["mensajePie"],"logo":invoice["logoUrl"]});
        ticket["coverage"] = json!("HASH_MATCHED_LOCAL_CHECKOUT");
        ticket["checkoutEvidence"] = s.proof();
        if r["metodo_pago"] == "efectivo" {
            let paid = cents(&invoice["montoRecibido"]).ok_or_else(invalid)?;
            let total = cents(&invoice["total"]).ok_or_else(invalid)?;
            if paid >= total {
                ticket["changeCents"] = json!((paid - total).to_string());
            }
        }
    }
    Ok(ticket)
}

#[cfg(test)]
mod timestamp_comparison_tests {
    use super::*;

    #[test]
    fn equality_preserves_wire_hashes_explicit_nulls_and_array_order() {
        let iso = json!({"created_at":"2026-10-02T15:24:39.336454Z"});
        let database = json!({"created_at":{"$milliseconds":"1790954679336.454000"}});
        let normalized = normalize(&database, 0).unwrap();
        assert_eq!(
            normalized,
            json!({"created_at":{"$number":"1790954679336.454"}})
        );
        assert_eq!(normalize(&iso, 0).unwrap(), iso);
        assert!(equivalent(&iso, &normalized));
        assert!(!equivalent(&json!({"created_at":null}), &iso));
        assert!(!equivalent(&json!({}), &iso));
        assert!(!equivalent(
            &json!({"created_at":"not a date"}),
            &normalized
        ));
        assert!(!equivalent(
            &json!([iso.clone(), null]),
            &json!([null, normalized.clone()])
        ));
        assert!(equivalent(&json!([iso]), &json!([normalized])));
    }
}
