//! Durable read-only observations. Row equality/absence is never proof of
//! complete remote effects, permission to replay, or commercial activation.
use super::{catalogue_preview::CatalogueContext, legacy_inventory_proof as inventory, legacy_web};
use crate::domain::money::MoneyCents;
use num_bigint::BigInt;
use num_traits::ToPrimitive;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
const MAX_RESPONSE: usize = 2_097_152;
#[derive(Debug, Clone, Copy)]
pub struct Error(&'static str);
impl Error {
    pub fn code(self) -> &'static str {
        self.0
    }
}
impl From<rusqlite::Error> for Error {
    fn from(_: rusqlite::Error) -> Self {
        Self("WEB_RECONCILE_STORAGE")
    }
}
fn invalid() -> Error {
    Error("WEB_RECONCILE_INVALID")
}
pub fn context_changed() -> Error {
    Error("WEB_RECONCILE_CONTEXT")
}
fn hash(s: &str) -> String {
    format!("{:x}", Sha256::digest(s.as_bytes()))
}
fn parsed(s: &str) -> Result<Value, Error> {
    serde_json::from_str(s).map_err(|_| invalid())
}
fn context(ctx: &CatalogueContext) -> Result<String, Error> {
    for id in [
        &ctx.tenant_id,
        &ctx.installation_id,
        &ctx.device_id,
        &ctx.actor_id,
    ] {
        uuid::Uuid::parse_str(id).map_err(|_| invalid())?;
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
    match (ctx.scope_type.as_str(), &ctx.branch_id) {
        ("GLOBAL", None) => {}
        ("BRANCH", Some(b)) => {
            uuid::Uuid::parse_str(b).map_err(|_| invalid())?;
        }
        _ => return Err(invalid()),
    }
    serde_json::to_string(ctx).map_err(|_| invalid())
}
fn authorize(c: &Connection, ctx: &CatalogueContext, report: &str) -> Result<(), Error> {
    let stored: Option<String> = c
        .query_row(
            "SELECT context FROM legacy_web_reconciliations_v1 WHERE report_id=?1 AND tenant_id=?2",
            (report, &ctx.tenant_id),
            |r| r.get(0),
        )
        .optional()?;
    if stored.as_deref() != Some(context(ctx)?.as_str()) {
        return Err(Error("WEB_RECONCILE_CONTEXT"));
    }
    Ok(())
}
// Exact bounded decimal normalization: no f64 arithmetic and no rounding.
pub(crate) fn decimal(raw: &str) -> Option<(BigInt, u32)> {
    if raw.len() > 180 || raw.trim() != raw {
        return None;
    }
    let lower = raw.to_ascii_lowercase();
    let mut ex = lower.split('e');
    let mantissa = ex.next()?;
    let exponent = ex
        .next()
        .map(|s| s.parse::<i32>().ok())
        .unwrap_or(Some(0))?;
    if ex.next().is_some() || !(-100..=100).contains(&exponent) {
        return None;
    }
    let (negative, m) = if let Some(s) = mantissa.strip_prefix('-') {
        (true, s)
    } else {
        (false, mantissa)
    };
    let mut parts = m.split('.');
    let whole = parts.next()?;
    let fraction = parts.next().unwrap_or("");
    if parts.next().is_some()
        || whole.is_empty()
        || !whole
            .bytes()
            .chain(fraction.bytes())
            .all(|b| b.is_ascii_digit())
    {
        return None;
    }
    let mut integer = BigInt::parse_bytes(format!("{whole}{fraction}").as_bytes(), 10)?;
    if negative {
        integer = -integer;
    }
    let mut scale = fraction.len() as i32 - exponent;
    if scale < 0 {
        integer *= BigInt::from(10u8).pow((-scale) as u32);
        scale = 0;
    }
    while scale > 0 && &integer % BigInt::from(10u8) == BigInt::from(0u8) {
        integer /= 10;
        scale -= 1;
    }
    Some((integer, scale as u32))
}
pub(crate) fn number(v: &Value) -> Option<String> {
    match v {
        Value::Number(n) => Some(n.to_string()),
        Value::Object(o) if o.len() == 1 => o
            .get("$number")
            .or_else(|| o.get("$milliseconds"))?
            .as_str()
            .map(str::to_owned),
        _ => None,
    }
}
fn money_field(name: &str) -> bool {
    matches!(
        name,
        "total"
            | "subtotal"
            | "monto"
            | "costo"
            | "costo_estimado"
            | "precio_final"
            | "abono"
            | "abonado"
            | "limite_credito"
            | "diferencia"
            | "efectivo"
            | "tarjeta"
            | "transferencia"
            | "fiado"
            | "mixto"
            | "total_ventas"
    ) || name.starts_with("precio_")
        || name.starts_with("monto_")
        || name.starts_with("ingreso_")
}
fn valid_money(v: &Value) -> bool {
    if v.is_object() && v.get("$number").is_none() {
        return false;
    }
    let Some(raw) = number(v) else {
        return false;
    };
    let Some((n, scale)) = decimal(&raw) else {
        return false;
    };
    if scale > 2 {
        return false;
    }
    let cents = n * BigInt::from(10u8).pow(2 - scale);
    cents
        .to_i128()
        .and_then(|v| MoneyCents::from_i128(v).ok())
        .is_some()
}
fn money_compatible(name: &str, v: &Value, depth: u32) -> bool {
    if depth > 64 {
        return false;
    }
    if money_field(name) {
        return valid_money(v);
    }
    match v {
        Value::Object(o) => o
            .iter()
            .all(|(key, value)| money_compatible(key, value, depth + 1)),
        Value::Array(a) => a
            .iter()
            .all(|value| money_compatible(name, value, depth + 1)),
        _ => true,
    }
}
fn equal(local: &Value, remote: &Value, depth: u32) -> Option<bool> {
    if depth > 64 {
        return None;
    }
    if local.is_number() {
        let l = decimal(&number(local)?)?;
        let r = decimal(&number(remote)?)?;
        return Some(l == r);
    }
    match (local, remote) {
        (Value::Null, Value::Null) => Some(true),
        (Value::Bool(a), Value::Bool(b)) => Some(a == b),
        (Value::String(a), Value::String(b)) => Some(a == b),
        (Value::Array(a), Value::Array(b)) => {
            if a.len() != b.len() {
                return Some(false);
            }
            for (l, r) in a.iter().zip(b) {
                if !equal(l, r, depth + 1)? {
                    return Some(false);
                }
            }
            Some(true)
        }
        (Value::Object(a), Value::Object(b)) => {
            if a.len() != b.len() {
                return Some(false);
            }
            for (k, l) in a {
                if !equal(l, b.get(k)?, depth + 1)? {
                    return Some(false);
                }
            }
            Some(true)
        }
        _ => None,
    }
}
fn metadata(key: &str) -> bool {
    key == "estado_sincronizacion"
        || key.starts_with("inventory_")
        || key.starts_with("sync_")
        || matches!(
            key,
            "payload_hash"
                | "origin_device_id"
                | "attempt_count"
                | "last_attempt_at"
                | "next_attempt_at"
                | "last_outcome_code"
                | "error_class"
                | "claim_id"
                | "lease_until"
                | "remote_receipt"
                | "conflict"
                | "expected_remote_sequence"
                | "sin_stock"
        )
}
fn display(v: Option<&Value>) -> String {
    let text = match v {
        None => "Campo ausente".into(),
        Some(Value::Null) => "Sin dato (null)".into(),
        Some(v) => number(v).unwrap_or_else(|| {
            v.as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| v.to_string())
        }),
    };
    if text.chars().count() > 512 {
        format!("{}…", text.chars().take(512).collect::<String>())
    } else {
        text
    }
}
pub fn compare(table: &str, local: &Value, remote: Option<&Value>) -> Result<Value, Error> {
    let o = local.as_object().ok_or_else(invalid)?;
    let id = local["id"].as_str().ok_or_else(invalid)?;
    let mut matched = Vec::new();
    let mut different = Vec::new();
    let mut unknown = Vec::new();
    let mut limitations = vec!["REMOTE_EFFECTS_UNVERIFIED"];
    if matches!(
        table,
        "ventas"
            | "cajas"
            | "gastos"
            | "transacciones_fiado"
            | "movimientos_stock"
            | "devoluciones"
    ) && !o.contains_key("sucursal_id")
    {
        limitations.push("LOCAL_SCOPE_UNKNOWN");
    }
    if !o.contains_key("negocio_id") {
        limitations.push("LOCAL_TENANT_UNKNOWN");
    }
    let status = if let Some(r) = remote {
        if r["id"] != local["id"] {
            return Err(invalid());
        }
        for (k, v) in o {
            if metadata(k) {
                continue;
            }
            if table == "productos" && k == "stock_actual" {
                unknown.push(k.clone());
                limitations.push("STOCK_SCOPE_UNVERIFIED");
                continue;
            }
            if !money_compatible(k, v, 0) || r.get(k).is_some_and(|x| !money_compatible(k, x, 0)) {
                unknown.push(k.clone());
                continue;
            }
            match r.get(k).and_then(|rv| equal(v, rv, 0)) {
                Some(true) => matched.push(k.clone()),
                Some(false) => different.push(k.clone()),
                None => unknown.push(k.clone()),
            }
        }
        if !different.is_empty() {
            "DIFFERENT_OBSERVED"
        } else if !unknown.is_empty() || limitations.len() > 1 {
            "PARTIAL_OBSERVED_FIELDS"
        } else {
            "MATCH_OBSERVED_FIELDS"
        }
    } else {
        "NOT_FOUND_AT_OBSERVATION"
    };
    let review_fields:Vec<_>=different.iter().chain(&unknown).map(|field|json!({"field":field,"local":display(o.get(field)),"remote":display(remote.and_then(|r|r.get(field)))})).collect();
    let mut result = json!({"id":id,"table":table,"status":status,"effectStatus":"UNKNOWN_LEGACY","matchedFields":matched,"differentFields":different,"unverifiableFields":unknown,"limitations":limitations,"reviewFields":review_fields});
    if table == "movimientos_stock" {
        result["inventoryEvidence"] = inventory::pending(local);
    }
    Ok(result)
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Batch {
    pub report_id: String,
    pub index: u32,
    pub table: String,
    pub observation_id: String,
    pub ids: Vec<String>,
    pub source_kind: String,
}
fn report(c: &Connection, ctx: &CatalogueContext, id: &str) -> Result<Value, Error> {
    authorize(c, ctx, id)?;
    let(export,state,error,total,created):(String,String,Option<String>,usize,String)=c.query_row("SELECT export_id,state,last_error,total_batches,created_at_ms FROM legacy_web_reconciliations_v1 WHERE report_id=?1",[id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?)))?;
    let completed: usize = c.query_row(
        "SELECT count(*) FROM legacy_web_observations_v1 WHERE report_id=?1",
        [id],
        |r| r.get(0),
    )?;
    let mut counts = BTreeMap::new();
    let mut s = c.prepare(
        "SELECT status,count(*) FROM legacy_web_comparisons_v1 WHERE report_id=?1 GROUP BY status",
    )?;
    for row in s.query_map([id], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, usize>(1)?))
    })? {
        let (k, n) = row?;
        counts.insert(k, n);
    }
    let mut inventory_counts = BTreeMap::new();
    let mut s=c.prepare("SELECT coalesce(json_extract(result,'$.inventoryEvidence.status'),'UNKNOWN_LEGACY'),count(*) FROM legacy_web_comparisons_v1 WHERE report_id=?1 AND table_name='movimientos_stock' GROUP BY 1")?;
    for row in s.query_map([id], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, usize>(1)?))
    })? {
        let (k, n) = row?;
        inventory_counts.insert(k, n);
    }
    Ok(
        json!({"reportId":id,"exportId":export,"state":state,"lastError":error,"totalBatches":total,"completedBatches":completed,"createdAtMs":created,"counts":counts,"inventoryEffectCounts":inventory_counts,"canActivate":false,"coverage":"REQUESTED_IDS_ONLY_WINDOWED","effectStatus":"UNKNOWN_LEGACY"}),
    )
}
pub fn prepare(
    c: &mut Connection,
    ctx: &CatalogueContext,
    export: &str,
    id: &str,
    at: &str,
) -> Result<Value, Error> {
    uuid::Uuid::parse_str(id).map_err(|_| invalid())?;
    if at
        .parse::<u64>()
        .ok()
        .filter(|v| *v <= 9_007_199_254_740_991)
        .is_none()
    {
        return Err(invalid());
    }
    let encoded = context(ctx)?;
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let (body, digest): (String, String) = tx.query_row(
        "SELECT body,body_hash FROM legacy_web_packages_v1 WHERE export_id=?1 AND tenant_id=?2",
        (export, &ctx.tenant_id),
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    if hash(&body) != digest || legacy_web::parse(body.clone()).is_err() {
        return Err(invalid());
    }
    if let Some((old_export, old_hash)) = tx
        .query_row(
            "SELECT export_id,source_hash FROM legacy_web_reconciliations_v1 WHERE report_id=?1",
            [id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
        )
        .optional()?
    {
        if old_export != export || old_hash != digest {
            return Err(Error("WEB_RECONCILE_ID_CONFLICT"));
        }
        return report(&tx, ctx, id);
    }
    let pending:usize=tx.query_row("SELECT count(*) FROM legacy_web_reconciliations_v1 WHERE tenant_id=?1 AND export_id=?2 AND context=?3 AND state IN('PENDING','PENDING_ERROR')",rusqlite::params![ctx.tenant_id,export,encoded],|r|r.get(0))?;
    if pending > 0 {
        return Err(Error("WEB_RECONCILE_PENDING"));
    }
    tx.execute("INSERT INTO legacy_web_reconciliations_v1(report_id,export_id,tenant_id,context,source_hash,created_at_ms,state,total_batches) VALUES(?1,?2,?3,?4,?5,?6,'PENDING',0)",rusqlite::params![id,export,ctx.tenant_id,encoded,digest,at])?;
    let source = parsed(&body)?;
    if source["tenantId"] != ctx.tenant_id {
        return Err(Error("WEB_RECONCILE_CONTEXT"));
    }
    let mut index = 0u32;
    let mut inventory_candidates = Vec::new();
    for table in source["tables"].as_array().ok_or_else(invalid)? {
        let name = table["name"].as_str().ok_or_else(invalid)?;
        let rows: Vec<Value> =
            serde_json::from_str(table["rowsJson"].as_str().ok_or_else(invalid)?)
                .map_err(|_| invalid())?;
        let mut eligible = Vec::new();
        for row in rows {
            let foreign = row["negocio_id"]
                .as_str()
                .is_some_and(|n| n != ctx.tenant_id);
            let local = matches!(
                name,
                "secuencias" | "operaciones_locales" | "inventario_sync_cursors"
            );
            if foreign || local {
                let result = json!({"id":row["id"],"table":name,"status":if foreign{"FOREIGN_TENANT"}else{"LOCAL_METADATA"},"effectStatus":"UNKNOWN_LEGACY","limitations":["REMOTE_EFFECTS_UNVERIFIED"]});
                insert_result(&tx, id, name, &result)?;
            } else {
                eligible.push(row);
            }
        }
        eligible.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
        if name == "movimientos_stock" {
            inventory_candidates.extend(
                eligible
                    .iter()
                    .filter(|row| inventory::candidate(row))
                    .cloned(),
            );
        }
        for rows in eligible.chunks(100) {
            let ids: Vec<_> = rows
                .iter()
                .map(|r| r["id"].as_str().unwrap().to_owned())
                .collect();
            let observation = uuid::Uuid::new_v4().to_string();
            tx.execute(
                "INSERT INTO legacy_web_observation_plans_v1(report_id,batch_index,table_name,observation_id,ids,local_rows) VALUES(?1,?2,?3,?4,?5,?6)",
                rusqlite::params![
                    id,
                    index,
                    name,
                    observation,
                    serde_json::to_string(&ids).map_err(|_| invalid())?,
                    serde_json::to_string(rows).map_err(|_| invalid())?
                ],
            )?;
            index += 1;
        }
    }
    for rows in inventory_candidates.chunks(100) {
        let ids: Vec<_> = rows
            .iter()
            .map(|r| r["id"].as_str().unwrap().to_owned())
            .collect();
        tx.execute("INSERT INTO legacy_web_observation_plans_v1(report_id,batch_index,table_name,observation_id,ids,local_rows,source_kind) VALUES(?1,?2,'movimientos_stock',?3,?4,?5,'INVENTORY_LEDGER_V2')",rusqlite::params![id,index,uuid::Uuid::new_v4().to_string(),serde_json::to_string(&ids).map_err(|_|invalid())?,serde_json::to_string(rows).map_err(|_|invalid())?])?;
        index += 1;
    }
    tx.execute(
        "UPDATE legacy_web_reconciliations_v1 SET total_batches=?2,state=?3 WHERE report_id=?1",
        rusqlite::params![
            id,
            index,
            if index == 0 {
                "REVIEW_REQUIRED"
            } else {
                "PENDING"
            }
        ],
    )?;
    tx.commit()?;
    report(c, ctx, id)
}
pub fn next(c: &Connection, ctx: &CatalogueContext, id: &str) -> Result<Option<Batch>, Error> {
    authorize(c, ctx, id)?;
    let row:Option<(u32,String,String,String,String)>=c.query_row("SELECT p.batch_index,p.table_name,p.observation_id,p.ids,p.source_kind FROM legacy_web_observation_plans_v1 p WHERE p.report_id=?1 AND NOT EXISTS(SELECT 1 FROM legacy_web_observations_v1 o WHERE o.report_id=p.report_id AND o.batch_index=p.batch_index) ORDER BY p.batch_index LIMIT 1",[id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional()?;
    row.map(|(index, table, observation_id, ids, source_kind)| {
        Ok(Batch {
            report_id: id.into(),
            index,
            table,
            observation_id,
            ids: serde_json::from_str(&ids).map_err(|_| invalid())?,
            source_kind,
        })
    })
    .transpose()
}
fn insert_result(c: &Connection, id: &str, table: &str, v: &Value) -> Result<(), Error> {
    c.execute(
        "INSERT INTO legacy_web_comparisons_v1 VALUES(?1,?2,?3,?4,?5)",
        rusqlite::params![
            id,
            table,
            v["id"].as_str().ok_or_else(invalid)?,
            v["status"].as_str().ok_or_else(invalid)?,
            v.to_string()
        ],
    )?;
    Ok(())
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Observation {
    protocol: String,
    observation_id: String,
    tenant_id: String,
    actor_id: String,
    installation_id: String,
    device_id: String,
    writer_epoch: String,
    scope: Scope,
    table: String,
    requested_ids: Vec<String>,
    captured_at_ms: String,
    coverage: String,
    decimal_encoding: String,
    rows: Vec<Value>,
    #[serde(default)]
    scope_evidence: Vec<ScopeEvidence>,
    #[serde(default)]
    ledger_rows_json: Option<String>,
    #[serde(default)]
    context_proof_json: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ScopeEvidence {
    row_id: String,
    source_table: String,
    source_id: String,
    tenant_id: String,
    branch_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Scope {
    #[serde(rename = "type")]
    kind: String,
    #[serde(deserialize_with = "required_branch")]
    branch_id: Option<String>,
}
fn required_branch<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    Option::<String>::deserialize(d)
}
fn observed_value(v: &Value, depth: u32) -> bool {
    if depth > 64 {
        return false;
    }
    match v {
        Value::Number(_) => false,
        Value::Array(a) => a.iter().all(|v| observed_value(v, depth + 1)),
        Value::Object(o) => {
            if o.contains_key("$number") || o.contains_key("$milliseconds") {
                return o.len() == 1 && number(v).and_then(|s| decimal(&s)).is_some();
            }
            o.values().all(|v| observed_value(v, depth + 1))
        }
        _ => true,
    }
}
/// Existing public read RPC revalidates the private server fence/owner context.
/// It is windowed evidence, never an atomic business cutover authorization.
pub fn validate_context_probe(
    ctx: &CatalogueContext,
    batch: &Batch,
    raw: &str,
) -> Result<(), Error> {
    if raw.len() > MAX_RESPONSE {
        return Err(invalid());
    }
    let o: Observation = serde_json::from_str(raw).map_err(|_| invalid())?;
    if o.protocol != "ventard.web.observation.1"
        || o.observation_id != batch.observation_id
        || o.tenant_id != ctx.tenant_id
        || o.actor_id != ctx.actor_id
        || o.installation_id != ctx.installation_id
        || o.device_id != ctx.device_id
        || o.writer_epoch != ctx.writer_epoch
        || o.scope.kind != ctx.scope_type
        || o.scope.branch_id != ctx.branch_id
        || o.table != batch.table
        || o.requested_ids != batch.ids
        || o.coverage != "REQUESTED_IDS_ONLY"
        || o.decimal_encoding != "TAGGED_NUMBERS_V1"
        || o.ledger_rows_json.is_some()
        || o.context_proof_json.is_some()
        || !o.scope_evidence.is_empty()
        || o.rows.len() > batch.ids.len()
        || o.captured_at_ms
            .parse::<u64>()
            .ok()
            .filter(|n| *n <= 9_007_199_254_740_991)
            .is_none()
    {
        return Err(invalid());
    }
    let mut seen = std::collections::BTreeSet::new();
    for row in &o.rows {
        let id = row["id"].as_str().ok_or_else(invalid)?;
        if !batch.ids.iter().any(|requested| requested == id)
            || !seen.insert(id)
            || row["negocio_id"] != ctx.tenant_id
            || legacy_web::secrets(row)
            || !observed_value(row, 0)
            || (ctx.scope_type == "BRANCH"
                && row.get("sucursal_id").and_then(Value::as_str) != ctx.branch_id.as_deref())
        {
            return Err(invalid());
        }
    }
    Ok(())
}
pub fn accept(
    c: &mut Connection,
    ctx: &CatalogueContext,
    id: &str,
    batch: &Batch,
    raw: &str,
) -> Result<Value, Error> {
    if raw.len() > MAX_RESPONSE {
        return Err(Error("WEB_RECONCILE_TOO_LARGE"));
    }
    let ledger = match batch.source_kind.as_str() {
        "LEGACY_ROWS" => false,
        "INVENTORY_LEDGER_V2" => true,
        _ => return Err(invalid()),
    };
    let obs: Observation = serde_json::from_str(raw).map_err(|_| invalid())?;
    let digest = hash(raw);
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    authorize(&tx, ctx, id)?;
    if batch.report_id != id
        || obs.protocol
            != if ledger {
                "ventard.web.inventory-ledger.1"
            } else {
                "ventard.web.observation.1"
            }
        || obs.observation_id != batch.observation_id
        || obs.tenant_id != ctx.tenant_id
        || obs.actor_id != ctx.actor_id
        || obs.installation_id != ctx.installation_id
        || obs.device_id != ctx.device_id
        || obs.writer_epoch != ctx.writer_epoch
        || obs.scope.kind != ctx.scope_type
        || obs.scope.branch_id != ctx.branch_id
        || obs.table != batch.table
        || obs.requested_ids != batch.ids
        || obs.coverage != "REQUESTED_IDS_ONLY"
        || obs.decimal_encoding
            != if ledger {
                "RAW_INT4_BIGINT_V1"
            } else {
                "TAGGED_NUMBERS_V1"
            }
        || (ledger
            && (batch.table != "movimientos_stock"
                || !obs.rows.is_empty()
                || !obs.scope_evidence.is_empty()
                || obs.ledger_rows_json.is_none()))
        || (!ledger && (obs.ledger_rows_json.is_some() || obs.context_proof_json.is_some()))
        || obs
            .captured_at_ms
            .parse::<u64>()
            .ok()
            .filter(|v| *v <= 9_007_199_254_740_991)
            .is_none()
        || obs.rows.len() > batch.ids.len()
    {
        return Err(invalid());
    }
    let old:Option<String>=tx.query_row("SELECT response_hash FROM legacy_web_observations_v1 WHERE report_id=?1 AND batch_index=?2",(id,batch.index),|r|r.get(0)).optional()?;
    if let Some(old) = old {
        if old != digest {
            return Err(Error("WEB_RECONCILE_OBSERVATION_CONFLICT"));
        }
        return report(&tx, ctx, id);
    }
    if next(&tx, ctx, id)?.as_ref() != Some(batch) {
        return Err(Error("WEB_RECONCILE_BATCH_CHANGED"));
    }
    if ledger {
        validate_context_probe(
            ctx,
            batch,
            obs.context_proof_json.as_deref().ok_or_else(invalid)?,
        )?;
        accept_inventory(&tx, ctx, id, batch, &obs)?;
    } else {
        let mut inherited = BTreeMap::new();
        for evidence in &obs.scope_evidence {
            if ctx.scope_type != "BRANCH"
                || batch.table != "devoluciones"
                || evidence.source_table != "ventas"
                || evidence.tenant_id != ctx.tenant_id
                || Some(evidence.branch_id.as_str()) != ctx.branch_id.as_deref()
                || evidence.source_id.is_empty()
                || evidence.source_id.len() > 512
                || !obs.rows.iter().any(|row| {
                    row["id"] == evidence.row_id
                        && row["venta_id"] == evidence.source_id
                        && row.get("sucursal_id").is_none()
                })
                || inherited
                    .insert(evidence.row_id.as_str(), evidence)
                    .is_some()
            {
                return Err(invalid());
            }
        }
        let mut remote = BTreeMap::new();
        for row in &obs.rows {
            let row_id = row["id"].as_str().ok_or_else(invalid)?;
            if !batch.ids.iter().any(|id| id == row_id)
                || row["negocio_id"] != ctx.tenant_id
                || legacy_web::secrets(row)
                || !observed_value(row, 0)
                || (ctx.scope_type == "BRANCH"
                    && matches!(
                        batch.table.as_str(),
                        "apartados"
                            | "cajas"
                            | "cortes_caja"
                            | "devoluciones"
                            | "gastos"
                            | "movimientos_stock"
                            | "reparaciones"
                            | "transacciones_fiado"
                            | "venta_detalles"
                            | "ventas"
                    )
                    && row.get("sucursal_id").and_then(Value::as_str) != ctx.branch_id.as_deref()
                    && !inherited.contains_key(row_id))
                || remote.insert(row_id, row).is_some()
            {
                return Err(invalid());
            }
        }
        let local:String=tx.query_row("SELECT local_rows FROM legacy_web_observation_plans_v1 WHERE report_id=?1 AND batch_index=?2",(id,batch.index),|r|r.get(0))?;
        let local: Vec<Value> = serde_json::from_str(&local).map_err(|_| invalid())?;
        for row in local {
            let row_id = row["id"].as_str().ok_or_else(invalid)?;
            let mut result = compare(&batch.table, &row, remote.get(row_id).copied())?;
            if batch.table == "movimientos_stock"
                && result["inventoryEvidence"]["status"] == "PENDING_LOOKUP"
            {
                let planned:i64=tx.query_row("SELECT count(*) FROM legacy_web_observation_plans_v1 p,json_each(p.ids) i WHERE p.report_id=?1 AND p.source_kind='INVENTORY_LEDGER_V2' AND i.value=?2",(id,row_id),|r|r.get(0))?;
                if planned == 0 {
                    result["inventoryEvidence"] =
                        json!({"status":"UNKNOWN_LEGACY","code":"FROZEN_REPORT_WITHOUT_LEDGER"});
                }
            }
            if inherited.contains_key(row_id) {
                result["limitations"]
                    .as_array_mut()
                    .ok_or_else(invalid)?
                    .push(json!("REMOTE_SCOPE_FROM_SALE"));
            }
            result["observedAtMs"] = json!(obs.captured_at_ms);
            insert_result(&tx, id, &batch.table, &result)?;
        }
    }
    tx.execute(
        "INSERT INTO legacy_web_observations_v1 VALUES(?1,?2,?3,?4,?5)",
        rusqlite::params![id, batch.index, digest, raw, obs.captured_at_ms],
    )?;
    let remaining:usize=tx.query_row("SELECT count(*) FROM legacy_web_observation_plans_v1 p WHERE p.report_id=?1 AND NOT EXISTS(SELECT 1 FROM legacy_web_observations_v1 o WHERE o.report_id=p.report_id AND o.batch_index=p.batch_index)",[id],|r|r.get(0))?;
    tx.execute(
        "UPDATE legacy_web_reconciliations_v1 SET state=?2,last_error=NULL WHERE report_id=?1",
        (
            id,
            if remaining == 0 {
                "REVIEW_REQUIRED"
            } else {
                "PENDING"
            },
        ),
    )?;
    tx.commit()?;
    report(c, ctx, id)
}
fn accept_inventory(
    c: &Connection,
    ctx: &CatalogueContext,
    report: &str,
    batch: &Batch,
    obs: &Observation,
) -> Result<(), Error> {
    let rows = inventory::parse_rows(obs.ledger_rows_json.as_deref().ok_or_else(invalid)?)
        .map_err(|_| invalid())?;
    let requested = batch
        .ids
        .iter()
        .map(|id| {
            uuid::Uuid::parse_str(id)
                .map(|id| id.to_string())
                .map_err(|_| invalid())
        })
        .collect::<Result<std::collections::BTreeSet<_>, _>>()?;
    if requested.len() != batch.ids.len() {
        return Err(invalid());
    }
    let mut remote = BTreeMap::new();
    for row in &rows {
        let key = uuid::Uuid::parse_str(row.operation_id())
            .map_err(|_| invalid())?
            .to_string();
        if !requested.contains(&key)
            || row.tenant_id() != ctx.tenant_id
            || row.branch_id() != ctx.branch_id.as_deref()
            || row.authority() != ctx.scope_type
            || remote.insert(key, row).is_some()
        {
            return Err(invalid());
        }
    }
    let raw:String=c.query_row("SELECT local_rows FROM legacy_web_observation_plans_v1 WHERE report_id=?1 AND batch_index=?2",(report,batch.index),|r|r.get(0))?;
    let locals: Vec<Value> = serde_json::from_str(&raw).map_err(|_| invalid())?;
    for local in locals {
        let row_id = local["id"].as_str().ok_or_else(invalid)?;
        let key = uuid::Uuid::parse_str(row_id)
            .map_err(|_| invalid())?
            .to_string();
        if !requested.contains(&key) || !inventory::candidate(&local) {
            return Err(invalid());
        }
        let saved:String=c.query_row("SELECT result FROM legacy_web_comparisons_v1 WHERE report_id=?1 AND table_name='movimientos_stock' AND row_id=?2",(report,row_id),|r|r.get(0))?;
        let mut result: Value = serde_json::from_str(&saved).map_err(|_| invalid())?;
        result["inventoryEvidence"] = inventory::classify(&local, remote.get(&key).copied());
        result["inventoryReceivedAtMs"] = json!(obs.captured_at_ms);
        c.execute("UPDATE legacy_web_comparisons_v1 SET result=?3 WHERE report_id=?1 AND table_name='movimientos_stock' AND row_id=?2",(report,row_id,result.to_string()))?;
    }
    Ok(())
}
pub fn failure(
    c: &mut Connection,
    ctx: &CatalogueContext,
    id: &str,
    code: &str,
) -> Result<Value, Error> {
    if !matches!(
        code,
        "MIGRATION_REQUIRED"
            | "LOGIN_REQUIRED"
            | "REMOTE_DENIED"
            | "NETWORK_UNAVAILABLE"
            | "RESPONSE_INVALID"
            | "TABLE_UNAVAILABLE"
            | "RESPONSE_TOO_LARGE"
    ) {
        return Err(invalid());
    }
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    authorize(&tx, ctx, id)?;
    tx.execute("UPDATE legacy_web_reconciliations_v1 SET state='PENDING_ERROR',last_error=?2 WHERE report_id=?1 AND state<>'REVIEW_REQUIRED'",(id,code))?;
    tx.commit()?;
    report(c, ctx, id)
}
pub fn view(c: &Connection, ctx: &CatalogueContext, export: &str) -> Result<Value, Error> {
    let encoded = context(ctx)?;
    let id:Option<String>=c.query_row("SELECT report_id FROM legacy_web_reconciliations_v1 WHERE tenant_id=?1 AND export_id=?2 AND context=?3 ORDER BY rowid DESC LIMIT 1",rusqlite::params![ctx.tenant_id,export,encoded],|r|r.get(0)).optional()?;
    Ok(json!({"report":id.map(|id|report(c,ctx,&id)).transpose()?}))
}
pub fn status(c: &Connection, ctx: &CatalogueContext, id: &str) -> Result<Value, Error> {
    report(c, ctx, id)
}
pub fn rows(
    c: &Connection,
    ctx: &CatalogueContext,
    id: &str,
    table: &str,
    page: u32,
) -> Result<Value, Error> {
    authorize(c, ctx, id)?;
    if !legacy_web::TABLES.contains(&table) || page > 200_000 {
        return Err(invalid());
    }
    let total: usize = c.query_row(
        "SELECT count(*) FROM legacy_web_comparisons_v1 WHERE report_id=?1 AND table_name=?2",
        (id, table),
        |r| r.get(0),
    )?;
    let mut s=c.prepare("SELECT result FROM legacy_web_comparisons_v1 WHERE report_id=?1 AND table_name=?2 ORDER BY row_id LIMIT 10 OFFSET ?3")?;
    let mut rows = Vec::new();
    for row in s.query_map(rusqlite::params![id, table, page as usize * 10], |r| {
        r.get::<_, String>(0)
    })? {
        rows.push(parsed(&row?)?);
    }
    Ok(json!({"rows":rows,"total":total,"page":page}))
}
