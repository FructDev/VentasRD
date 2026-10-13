//! Repair documents use the same atomic journal/effects/outbox as cash and stock.
//! Exact amounts, append-only payments and state audit are derived in Rust.
use super::{
    errors::{AppError, BusinessError, ProtocolError},
    inventory,
    management::{self, Command},
    sales, sales_sync,
};
use crate::{
    domain::{identity::EntityId, money::MoneyCents},
    storage::catalogue_preview::CatalogueContext,
};
use rusqlite::{Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Part {
    pub product_id: Option<String>,
    pub name: String,
    pub quantity: String,
    pub cost_cents: String,
    pub price_cents: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecoveryPart {
    pub product_id: String,
    pub quantity: String,
    pub new_product: Option<inventory::ProductDefinition>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Definition {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub warranty_origin_id: Option<String>,
    pub customer_id: Option<String>,
    pub customer_name: String,
    pub phone: String,
    pub brand: String,
    pub model: String,
    pub imei: String,
    pub color: String,
    pub condition_checks: Vec<String>,
    pub condition_notes: String,
    pub accessories: String,
    pub problem: String,
    pub diagnosis: String,
    pub notes: String,
    pub technician: String,
    pub labour_cents: String,
    pub parts_charge_separate: bool,
    pub parts: Vec<Part>,
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
fn n(s: &str) -> Result<i64, AppError> {
    let n = MoneyCents::parse_dto(s).map_err(|_| invalid())?.cents();
    if n < 0 {
        return Err(invalid());
    }
    Ok(n)
}
fn uint(s: &str) -> Result<i32, AppError> {
    let n = s.parse::<i32>().map_err(|_| invalid())?;
    if n < 0 || n.to_string() != s {
        return Err(invalid());
    }
    Ok(n)
}
fn text(s: &str, max: usize, required: bool) -> Result<(), AppError> {
    if s.trim() != s
        || s.chars().count() > max
        || s.chars().any(|c| c.is_control() && c != '\n')
        || (required && s.is_empty())
    {
        return Err(invalid());
    }
    Ok(())
}
fn add(a: i64, b: i64) -> Result<i64, AppError> {
    MoneyCents::from_i128(a as i128 + b as i128)
        .map(|n| n.cents())
        .map_err(|_| invalid())
}
pub fn supports(k: &str) -> bool {
    matches!(k, "REPAIR_CREATE" | "REPAIR_EDIT" | "REPAIR_DISASSEMBLE")
}
fn current(c: &Connection, ctx: &CatalogueContext, id: &str) -> Result<Option<Value>, AppError> {
    EntityId::parse(id).map_err(|_| invalid())?;
    let row:Option<(String,String)>=c.query_row("SELECT r.document,coalesce(o.state,'APPLIED') FROM native_management_records_v1 r LEFT JOIN outbox o ON o.operation_id=r.operation_id WHERE r.tenant_id=?1 AND r.scope_key=?2 AND r.kind IN('REPAIR_CREATE','REPAIR_EDIT','REPAIR_DISASSEMBLE') AND json_extract(r.document,'$.repair.id')=?3 ORDER BY cast(json_extract(r.document,'$.repair.revision') AS INTEGER) DESC LIMIT 1",(&ctx.tenant_id,sales::scope_key(ctx)?,id),|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
    row.map(|(raw, status)| {
        let mut d: Value = serde_json::from_str(&raw).map_err(|_| invalid())?;
        d["remoteStatus"] = json!(status);
        Ok(d)
    })
    .transpose()
}
pub fn read(c: &Connection, ctx: &CatalogueContext) -> Result<Value, AppError> {
    if !sales_sync::operational(c, ctx)? {
        return Err(guard("LEGACY_NOT_VERIFIABLE"));
    }
    let mut q=c.prepare("SELECT DISTINCT json_extract(document,'$.repair.id') FROM native_management_records_v1 WHERE tenant_id=?1 AND scope_key=?2 AND kind IN('REPAIR_CREATE','REPAIR_EDIT','REPAIR_DISASSEMBLE') LIMIT 10001")?;
    let ids = q
        .query_map((&ctx.tenant_id, sales::scope_key(ctx)?), |r| {
            r.get::<_, String>(0)
        })?
        .collect::<Result<Vec<_>, _>>()?;
    if ids.len() > 10000 {
        return Err(guard("EXPORT_TOO_LARGE"));
    }
    let mut rows = vec![];
    for id in ids {
        let d = current(c, ctx, &id)?.ok_or_else(invalid)?;
        let mut r = d["repair"].clone();
        r["operationId"] = d["operationId"].clone();
        r["remoteStatus"] = d["remoteStatus"].clone();
        rows.push(r);
    }
    rows.sort_by(|a, b| {
        b["createdAtMs"]
            .as_str()
            .and_then(|s| s.parse::<u64>().ok())
            .cmp(
                &a["createdAtMs"]
                    .as_str()
                    .and_then(|s| s.parse::<u64>().ok()),
            )
    });
    Ok(json!({"rows":rows,"coverage":"LOCAL_NATIVE_ONLY"}))
}
/// The snapshot already includes past cash/stock in its verified baselines.
/// Import the current document and its exact receipt, without replaying effects.
pub fn import_capture(
    tx: &Transaction<'_>,
    ctx: &CatalogueContext,
    event: &Value,
    watermark: i64,
) -> Result<(), AppError> {
    let raw = s(&event["intent"])?;
    let (canonical, hash) =
        crate::domain::canonical::canonicalize(raw.as_bytes()).map_err(|_| invalid())?;
    if canonical != raw {
        return Err(invalid());
    }
    let v: Value = serde_json::from_str(raw).map_err(|_| invalid())?;
    if !supports(s(&v["kind"])?) || !event["snapshot"].is_null() {
        return Err(invalid());
    }
    sales_sync::validate_event(ctx, &v, None, &event["receipt"])?;
    let seq = n(s(&event["receipt"]["remoteSequence"])?)?;
    if seq <= 0 || seq > watermark {
        return Err(invalid());
    }
    let d = &v["payload"]["document"];
    let r = &d["repair"];
    let id = s(&r["id"])?;
    EntityId::parse(id).map_err(|_| invalid())?;
    let req: Command =
        serde_json::from_value(v["payload"]["request"].clone()).map_err(|_| invalid())?;
    let (op, req_id, revision) = match &req {
        Command::RepairSave {
            operation_id,
            repair_id,
            expected_revision,
            ..
        }
        | Command::RepairAction {
            operation_id,
            repair_id,
            expected_revision,
            ..
        }
        | Command::RepairDisassemble {
            operation_id,
            repair_id,
            expected_revision,
            ..
        } => (operation_id, repair_id, expected_revision),
        _ => return Err(invalid()),
    };
    if d["operationId"] != *op
        || v["operationId"] != *op
        || id != req_id
        || uint(s(&r["revision"])?)? != uint(revision)?.checked_add(1).ok_or_else(invalid)?
        || current(tx, ctx, id)?.is_some()
    {
        return Err(invalid());
    }
    let definition: Definition =
        serde_json::from_value(r["definition"].clone()).map_err(|_| invalid())?;
    let mut definition_check = definition.clone();
    if v["kind"] == "REPAIR_DISASSEMBLE" {
        definition_check.notes = definition_check
            .notes
            .strip_suffix(" · Equipo abandonado y despiezado")
            .or_else(|| {
                definition_check
                    .notes
                    .strip_suffix("Equipo abandonado y despiezado")
            })
            .ok_or_else(invalid)?
            .to_owned();
    }
    let computed = validate_definition(tx, ctx, &definition_check, false, false)?;
    let state = s(&r["state"])?;
    if !matches!(
        state,
        "recibido"
            | "diagnostico"
            | "cotizado"
            | "en_reparacion"
            | "esperando_repuesto"
            | "listo"
            | "entregado"
            | "no_reparado"
            | "abandonado"
            | "cancelado"
    ) {
        return Err(invalid());
    }
    let total = n(s(&r["totalCents"])?)?;
    if !matches!(state, "no_reparado" | "abandonado")
        && v["kind"] != "REPAIR_DISASSEMBLE"
        && total != computed
    {
        return Err(invalid());
    }
    let created = n(s(&r["createdAtMs"])?)?;
    let updated = n(s(&r["updatedAtMs"])?)?;
    if created > updated || r["updatedAtMs"] != v["originAtUtcMs"] {
        return Err(invalid());
    }
    let number = s(&r["folioNumber"])?;
    let number = n(number)?;
    if number == 0 {
        return Err(invalid());
    }
    let ending = format!("-{number:03}");
    let prefix = s(&r["folio"])?
        .strip_prefix("REP-N")
        .and_then(|x| x.strip_suffix(&ending))
        .ok_or_else(invalid)?;
    if prefix.len() != 32
        || !prefix
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(invalid());
    }
    let mut paid = 0;
    let mut seen = HashSet::new();
    let payments = r["payments"].as_array().ok_or_else(invalid)?;
    for p in payments {
        let id = s(&p["operationId"])?;
        EntityId::parse(id).map_err(|_| invalid())?;
        let amount = n(s(&p["amountCents"])?)?;
        let at = n(s(&p["dateMs"])?)?;
        if amount <= 0
            || !seen.insert(id)
            || at < created
            || at > updated
            || !matches!(
                p["method"].as_str(),
                Some("EFECTIVO" | "TARJETA" | "TRANSFERENCIA")
            )
        {
            return Err(invalid());
        }
        if let Some(turn) = p["turnId"].as_str() {
            EntityId::parse(turn).map_err(|_| invalid())?;
        } else if !p["turnId"].is_null() || p["method"] == "EFECTIVO" {
            return Err(invalid());
        }
        paid = add(paid, amount)?;
    }
    if paid != n(s(&r["paidCents"])?)? {
        return Err(invalid());
    }
    if let Some(pending) = r["settlementPendingCents"].as_str() {
        if !matches!(state, "no_reparado" | "abandonado" | "cancelado")
            || n(pending)?
                != paid
                    .checked_sub(total)
                    .filter(|n| *n >= 0)
                    .ok_or_else(invalid)?
        {
            return Err(invalid());
        }
    }
    let amount = n(s(&d["amountCents"])?)?;
    if (amount > 0
        && (payments.last() != Some(&d["payment"])
            || d["payment"]["operationId"] != *op
            || d["payment"]["amountCents"] != d["amountCents"]
            || d["payment"]["method"] != d["method"]
            || d["payment"]["turnId"] != v["originalTurnId"]))
        || (amount == 0 && !d["payment"].is_null())
    {
        return Err(invalid());
    }
    let days = uint(s(&r["warrantyDays"])?)?;
    if days > 3650 {
        return Err(invalid());
    }
    if let Some(delivered) = r["deliveredAtMs"].as_str() {
        let at = n(delivered)?;
        if state != "entregado"
            || at < created
            || at > updated
            || r["warrantyUntilMs"]
                != if days == 0 {
                    Value::Null
                } else {
                    json!(add(at, days as i64 * 86_400_000)?.to_string())
                }
        {
            return Err(invalid());
        }
    } else if state == "entregado" || days != 0 || !r["warrantyUntilMs"].is_null() {
        return Err(invalid());
    }
    let scope = sales::scope_key(ctx)?;
    let origin = scope.split_once('/').ok_or_else(invalid)?.1;
    tx.execute("INSERT INTO operation_journal VALUES(?1,'ventard.native.v1',?2,1,?3,?4,?5,?6,?7,?8,?9,COALESCE((SELECT MAX(local_seq) FROM operation_journal),0)+1,'COMMITTED',?10)",(op,s(&v["kind"])?,raw.as_bytes(),hash,s(&v["actorId"])?,origin,s(&v["originDeviceId"])?,n(s(&v["writerEpoch"])?)?,s(&v["originAtUtcMs"])?,json!({"remoteStatus":"APPLIED","source":"CURRENT_CAPTURE"}).to_string()))?;
    tx.execute(
        "INSERT INTO native_management_records_v1 VALUES(?1,?2,?3,?4,?5,NULL,?6,?7,?8,?9,?10)",
        (
            op,
            &ctx.tenant_id,
            &scope,
            s(&v["kind"])?,
            v["originalTurnId"].as_str(),
            d["method"].as_str(),
            amount,
            s(&d["concept"])?,
            s(&v["originAtUtcMs"])?,
            d.to_string(),
        ),
    )?;
    tx.execute(
        "INSERT INTO native_sales_receipts_v1 VALUES(?1,?2,?3,?4,?5)",
        (
            op,
            &ctx.tenant_id,
            &scope,
            seq,
            event["receipt"].to_string(),
        ),
    )?;
    Ok(())
}
fn validate_definition(
    c: &Connection,
    ctx: &CatalogueContext,
    d: &Definition,
    check_catalog: bool,
    new_customer: bool,
) -> Result<i64, AppError> {
    for (v, max, req) in [
        (&d.customer_name, 256, true),
        (&d.phone, 64, false),
        (&d.brand, 128, false),
        (&d.model, 256, true),
        (&d.imei, 128, false),
        (&d.color, 64, false),
        (&d.condition_notes, 2000, false),
        (&d.accessories, 1000, false),
        (&d.problem, 2000, true),
        (&d.diagnosis, 4000, false),
        (&d.notes, 4000, false),
        (&d.technician, 256, false),
    ] {
        text(v, max, req)?;
    }
    const CHECKS: [&str; 9] = [
        "Enciende",
        "Pantalla con rayones",
        "Pantalla rota / estrellada",
        "No enciende",
        "Mojado / humedad",
        "Carcasa / tapa dañada",
        "Botones con falla",
        "Con funda / mica",
        "Sin bandeja SIM",
    ];
    let mut checks = HashSet::new();
    for check in &d.condition_checks {
        if !CHECKS.contains(&check.as_str()) || !checks.insert(check) {
            return Err(invalid());
        }
    }
    if let Some(id) = &d.customer_id {
        EntityId::parse(id).map_err(|_| invalid())?;
        if check_catalog && !new_customer && management::customer(c, ctx, id)?["active"] != true {
            return Err(guard("CUSTOMER_REQUIRED"));
        }
    }
    if d.parts.len() > 100 {
        return Err(invalid());
    }
    let mut ids = HashSet::new();
    let mut total = n(&d.labour_cents)?;
    for part in &d.parts {
        text(&part.name, 256, true)?;
        let qty = uint(&part.quantity)?;
        if qty <= 0 {
            return Err(invalid());
        }
        n(&part.cost_cents)?;
        let price = n(&part.price_cents)?;
        if let Some(id) = &part.product_id {
            EntityId::parse(id).map_err(|_| invalid())?;
            if !ids.insert(id) {
                return Err(invalid());
            }
            if check_catalog {
                let p = inventory::product(c, ctx, id)?;
                if p["deleted"] == true {
                    return Err(guard("VERSION_CONFLICT"));
                }
                if p["metadata"]["serialRequired"] == true
                    || p["metadata"]["productType"] == "combo"
                    || p["metadata"]["recipe"]
                        .as_array()
                        .is_some_and(|r| !r.is_empty())
                {
                    return Err(guard("SERVICE_PART_UNSUPPORTED"));
                }
            }
        }
        if d.parts_charge_separate {
            total = add(
                total,
                MoneyCents::from_i128(price as i128 * qty as i128)
                    .map_err(|_| invalid())?
                    .cents(),
            )?;
        }
    }
    if let Some(id) = &d.warranty_origin_id {
        EntityId::parse(id).map_err(|_| invalid())?;
        if total != 0 {
            return Err(guard("SERVICE_GUARANTEE_FREE"));
        }
    }
    Ok(total)
}
fn reserved(r: &Value) -> Result<BTreeMap<String, i32>, AppError> {
    let mut out = BTreeMap::new();
    if matches!(
        r["state"].as_str(),
        Some("cancelado" | "no_reparado" | "abandonado")
    ) {
        return Ok(out);
    }
    for p in r["definition"]["parts"].as_array().ok_or_else(invalid)? {
        if let Some(id) = p["productId"].as_str() {
            let q = uint(s(&p["quantity"])?)?;
            if out.insert(id.into(), q).is_some() {
                return Err(invalid());
            }
        }
    }
    Ok(out)
}
fn folio(c: &Connection, ctx: &CatalogueContext, op: &str) -> Result<(String, String), AppError> {
    let frozen:Option<(String,String)>=c.query_row("SELECT json_extract(CAST(canonical_bytes AS TEXT),'$.payload.document.repair.folio'),json_extract(CAST(canonical_bytes AS TEXT),'$.payload.document.repair.folioNumber') FROM operation_journal WHERE operation_id=?1 AND kind='REPAIR_CREATE'",[op],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
    if let Some(f) = frozen {
        return Ok(f);
    }
    let prefix:String=c.query_row("SELECT prefix FROM ticket_sequences WHERE tenant_id=?1 AND installation_id=?2 AND device_id=?3 AND writer_epoch=?4",(&ctx.tenant_id,&ctx.installation_id,&ctx.device_id,&ctx.writer_epoch),|r|r.get(0)).optional()?.ok_or_else(||guard("TICKET_SOURCE_UNKNOWN"))?;
    let last:i64=c.query_row("SELECT coalesce(max(cast(json_extract(CAST(canonical_bytes AS TEXT),'$.payload.document.repair.folioNumber') AS INTEGER)),0) FROM operation_journal WHERE kind IN('REPAIR_CREATE','REPAIR_EDIT','REPAIR_DISASSEMBLE') AND json_extract(CAST(canonical_bytes AS TEXT),'$.negocioId')=?1 AND substr(json_extract(CAST(canonical_bytes AS TEXT),'$.payload.document.repair.folio'),1,length(?2)+1)=?2||'-'",(&ctx.tenant_id,format!("REP-{prefix}")),|r|r.get(0))?;
    let next = last
        .checked_add(1)
        .filter(|n| *n <= 9_007_199_254_740_991)
        .ok_or_else(invalid)?;
    Ok((format!("REP-{prefix}-{next:03}"), next.to_string()))
}
pub fn document(
    c: &Connection,
    ctx: &CatalogueContext,
    req: &Command,
    at: &str,
) -> Result<(String, Value), AppError> {
    document_inner(c, ctx, req, at, None)
}
fn document_inner(
    c: &Connection,
    ctx: &CatalogueContext,
    req: &Command,
    at: &str,
    source: Option<&Value>,
) -> Result<(String, Value), AppError> {
    let (op, id, rev) = match req {
        Command::RepairSave {
            operation_id,
            repair_id,
            expected_revision,
            ..
        }
        | Command::RepairAction {
            operation_id,
            repair_id,
            expected_revision,
            ..
        }
        | Command::RepairDisassemble {
            operation_id,
            repair_id,
            expected_revision,
            ..
        } => (operation_id, repair_id, expected_revision),
        _ => return Err(invalid()),
    };
    EntityId::parse(op).map_err(|_| invalid())?;
    let revision = uint(rev)?;
    let now = at.parse::<u64>().map_err(|_| invalid())?;
    let old = current(c, ctx, id)?;
    if old.as_ref().is_some_and(|d| {
        matches!(
            d["remoteStatus"].as_str(),
            Some("CONFLICT" | "INTERVENTION")
        )
    }) {
        return Err(guard("SERVICE_SYNC_CONFLICT"));
    }
    if old.as_ref().and_then(|d| d["repair"]["revision"].as_str())
        != if revision == 0 {
            None
        } else {
            Some(rev.as_str())
        }
    {
        return Err(guard("VERSION_CONFLICT"));
    }
    let mut repair = if let Some(d) = &old {
        let r = d["repair"].clone();
        if matches!(
            r["state"].as_str(),
            Some("entregado" | "cancelado" | "no_reparado" | "abandonado")
        ) && !(matches!(req, Command::RepairDisassemble { .. }) && r["state"] == "abandonado")
        {
            return Err(guard("SERVICE_STATE_INVALID"));
        }
        if r["updatedAtMs"]
            .as_str()
            .and_then(|s| s.parse::<u64>().ok())
            .is_none_or(|t| t > now)
        {
            return Err(invalid());
        }
        r
    } else {
        if !matches!(req, Command::RepairSave { .. }) {
            return Err(guard("VERSION_CONFLICT"));
        }
        let exists:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM native_management_records_v1 WHERE json_extract(document,'$.repair.id')=?1)",[id],|r|r.get(0))?;
        if exists {
            return Err(guard("VERSION_CONFLICT"));
        }
        let (f, number) = if let Some(source) = source {
            let number = s(&source["repair"]["folioNumber"])?;
            let n = number.parse::<u64>().map_err(|_| invalid())?;
            if n == 0 || n > 9_007_199_254_740_991 || n.to_string() != number {
                return Err(invalid());
            }
            let f = format!("REP-N{}-{n:03}", ctx.installation_id.replace('-', ""));
            if source["repair"]["folio"] != f {
                return Err(invalid());
            }
            (f, number.to_owned())
        } else {
            folio(c, ctx, op)?
        };
        json!({"id":id,"revision":"0","folio":f,"folioNumber":number,"state":"recibido","definition":{},"totalCents":"0","paidCents":"0","payments":[],"log":[],"createdAtMs":at,"updatedAtMs":at,"deliveredAtMs":null,"warrantyDays":"0","warrantyUntilMs":null})
    };
    let original_state = repair["state"].clone();
    let mut amount;
    let method;
    let turn;
    let payment_type;
    let no_method = "EFECTIVO".to_owned();
    let no_turn = None;
    let mut recovered = std::collections::BTreeMap::<String, i32>::new();
    let mut products = vec![];
    let mut customer = Value::Null;
    match req {
        Command::RepairDisassemble { entries, .. } => {
            if repair["state"] != "abandonado" || entries.is_empty() || entries.len() > 100 {
                return Err(guard("SERVICE_STATE_INVALID"));
            }
            for entry in entries {
                EntityId::parse(&entry.product_id).map_err(|_| invalid())?;
                let qty = uint(&entry.quantity)?;
                if qty <= 0 || recovered.insert(entry.product_id.clone(), qty).is_some() {
                    return Err(invalid());
                }
                if let Some(def) = &entry.new_product {
                    if def.product_type != "insumo"
                        || def.price_cents != "0"
                        || !def.code.is_empty()
                        || def.tier2_cents.is_some()
                        || def.tier3_cents.is_some()
                        || def.serial_required
                        || !def.recipe.is_empty()
                        || def.tax_percent != "0"
                        || def.minimum != "0"
                        || !def.location.is_empty()
                    {
                        return Err(guard("SERVICE_PART_UNSUPPORTED"));
                    }
                    let req = Command::ProductSave {
                        operation_id: op.clone(),
                        product_id: entry.product_id.clone(),
                        expected_revision: "0".into(),
                        definition: def.clone(),
                    };
                    let (_, doc) = inventory::document(c, ctx, &req)?;
                    products.push(json!({"request":req,"document":doc}));
                } else {
                    let p = inventory::product(c, ctx, &entry.product_id)?;
                    if p["deleted"] == true
                        || p["metadata"]["serialRequired"] == true
                        || p["metadata"]["productType"] == "combo"
                        || p["metadata"]["recipe"]
                            .as_array()
                            .is_some_and(|r| !r.is_empty())
                    {
                        return Err(guard("SERVICE_PART_UNSUPPORTED"));
                    }
                }
            }
            repair["state"] = json!("cancelado");
            let notes = s(&repair["definition"]["notes"])?;
            repair["definition"]["notes"] = json!(if notes.is_empty() {
                "Equipo abandonado y despiezado".into()
            } else {
                format!("{notes} · Equipo abandonado y despiezado")
            });
            amount = 0;
            method = &no_method;
            turn = &no_turn;
            payment_type = "abono";
        }
        Command::RepairSave {
            definition,
            quote,
            initial_payment_cents,
            method: m,
            turn_id,
            create_customer,
            ..
        } => {
            let previous_origin = old
                .as_ref()
                .and_then(|d| d["repair"]["definition"]["warrantyOriginId"].as_str());
            if revision > 0 && previous_origin != definition.warranty_origin_id.as_deref() {
                return Err(guard("SERVICE_STATE_INVALID"));
            }
            if let Some(origin) = &definition.warranty_origin_id {
                if n(initial_payment_cents)? != 0 {
                    return Err(guard("SERVICE_GUARANTEE_FREE"));
                }
                if revision == 0 {
                    let original = current(c, ctx, origin)?
                        .ok_or_else(|| guard("SERVICE_GUARANTEE_EXPIRED"))?;
                    if origin == id
                        || original["repair"]["state"] != "entregado"
                        || original["repair"]["deliveredAtMs"]
                            .as_str()
                            .and_then(|s| s.parse::<u64>().ok())
                            .is_none_or(|t| t > now)
                        || original["repair"]["warrantyUntilMs"]
                            .as_str()
                            .and_then(|s| s.parse::<u64>().ok())
                            .is_none_or(|t| t < now)
                    {
                        return Err(guard("SERVICE_GUARANTEE_EXPIRED"));
                    }
                    if matches!(
                        original["remoteStatus"].as_str(),
                        Some("CONFLICT" | "INTERVENTION")
                    ) {
                        return Err(guard("SERVICE_SYNC_CONFLICT"));
                    }
                    let parent = &original["repair"]["definition"];
                    if parent["customerId"] != json!(definition.customer_id)
                        || parent["customerName"] != definition.customer_name
                        || parent["phone"] != definition.phone
                        || parent["brand"] != definition.brand
                        || parent["model"] != definition.model
                        || parent["imei"] != definition.imei
                        || parent["color"] != definition.color
                    {
                        return Err(guard("SERVICE_STATE_INVALID"));
                    }
                }
            }
            if *quote
                && !matches!(
                    repair["state"].as_str(),
                    Some("recibido" | "diagnostico" | "cotizado")
                )
            {
                return Err(guard("SERVICE_STATE_INVALID"));
            }
            let create = create_customer == &Some(true);
            if create {
                if definition.warranty_origin_id.is_some() {
                    return Err(invalid());
                }
                let cid = definition.customer_id.as_deref().ok_or_else(invalid)?;
                EntityId::parse(cid).map_err(|_| invalid())?;
                let exists: bool = c.query_row(
                    "SELECT EXISTS(SELECT 1 FROM sale_customer_accounts_v1 WHERE customer_id=?1)",
                    [cid],
                    |r| r.get(0),
                )?;
                if exists {
                    return Err(guard("VERSION_CONFLICT"));
                }
                customer = json!({"id":cid,"name":definition.customer_name,"phone":if definition.phone.is_empty(){Value::Null}else{json!(definition.phone)},"limitCents":"0","priceTier":1,"wholesale":false,"active":true,"revision":"1"});
            }
            let total = validate_definition(c, ctx, definition, source.is_none(), create)?;
            let paid = n(s(&repair["paidCents"])?)?;
            amount = n(initial_payment_cents)?;
            if revision != 0 && amount != 0 {
                return Err(invalid());
            }
            let uncosted = !quote
                && total == 0
                && definition.parts.is_empty()
                && matches!(repair["state"].as_str(), Some("recibido" | "diagnostico"));
            if add(paid, amount)? > total && !uncosted {
                return Err(guard("SERVICE_OVERPAY"));
            }
            repair["definition"] = serde_json::to_value(definition).map_err(|_| invalid())?;
            if !definition.parts_charge_separate {
                for p in repair["definition"]["parts"]
                    .as_array_mut()
                    .ok_or_else(invalid)?
                {
                    p["priceCents"] = json!("0");
                }
            }
            repair["totalCents"] = json!(total.to_string());
            if *quote {
                repair["state"] = json!("cotizado");
            }
            method = m;
            turn = turn_id;
            payment_type = "abono";
        }
        Command::RepairAction {
            action,
            amount_cents,
            method: m,
            turn_id,
            warranty_days,
            ..
        } => {
            if uint(warranty_days)? > 3650 {
                return Err(invalid());
            }
            amount = n(amount_cents)?;
            if repair["definition"]["warrantyOriginId"].is_string() && amount > 0 {
                return Err(guard("SERVICE_GUARANTEE_FREE"));
            }
            let state = s(&repair["state"])?;
            let next = match action.as_str() {
                "PAYMENT" => state,
                "DIAGNOSE" if state == "recibido" => "diagnostico",
                "APPROVE" if state == "cotizado" => "en_reparacion",
                "WORK" | "WAIT" | "READY"
                    if matches!(state, "en_reparacion" | "esperando_repuesto" | "listo") =>
                {
                    match action.as_str() {
                        "WORK" => "en_reparacion",
                        "WAIT" => "esperando_repuesto",
                        _ => "listo",
                    }
                }
                "DELIVER" if state == "listo" => "entregado",
                "REJECT" | "ABANDON" if state == "cotizado" => {
                    if action == "REJECT" {
                        "no_reparado"
                    } else {
                        "abandonado"
                    }
                }
                "CANCEL" => "cancelado",
                _ => return Err(guard("SERVICE_STATE_INVALID")),
            }
            .to_owned();
            let paid = n(s(&repair["paidCents"])?)?;
            let total = n(s(&repair["totalCents"])?)?;
            if action == "DELIVER" {
                if paid > total {
                    return Err(guard("SERVICE_OVERPAY"));
                }
                if amount != 0 {
                    return Err(invalid());
                }
                amount = total - paid;
                let days = uint(warranty_days)?;
                if days > 3650 {
                    return Err(invalid());
                }
                repair["deliveredAtMs"] = json!(at);
                repair["warrantyDays"] = json!(warranty_days);
                repair["warrantyUntilMs"] = if days == 0 {
                    Value::Null
                } else {
                    json!(now
                        .checked_add(days as u64 * 86_400_000)
                        .filter(|t| *t <= 9_007_199_254_740_991)
                        .ok_or_else(invalid)?
                        .to_string())
                };
            } else if action == "PAYMENT" {
                if amount <= 0 || amount > total - paid {
                    return Err(guard("SERVICE_OVERPAY"));
                }
            } else if matches!(action.as_str(), "REJECT" | "ABANDON") {
                repair["totalCents"] = json!(amount.to_string());
                repair["settlementPendingCents"] = json!(paid.to_string());
                repair["definition"]["labourCents"] = json!("0");
            } else if amount != 0 {
                return Err(invalid());
            }
            repair["state"] = json!(next);
            method = m;
            turn = turn_id;
            payment_type = if action == "DELIVER" {
                "final"
            } else if matches!(action.as_str(), "REJECT" | "ABANDON") {
                "revision"
            } else {
                "abono"
            };
        }
        _ => return Err(invalid()),
    }
    if !matches!(method.as_str(), "EFECTIVO" | "TARJETA" | "TRANSFERENCIA") {
        return Err(invalid());
    }
    let mut payment = Value::Null;
    if amount > 0 {
        if let Some(t) = turn.as_ref().filter(|_| source.is_none()) {
            let drawer = management::active_turn(c, ctx, t)?;
            if drawer["openedAtMs"]
                .as_str()
                .and_then(|s| s.parse::<u64>().ok())
                .is_none_or(|t| t > now)
            {
                return Err(guard("TURN_CHANGED"));
            }
        } else if turn.is_none() && method == "EFECTIVO" {
            return Err(guard("TURN_REQUIRED"));
        }
        payment = json!({"operationId":op,"amountCents":amount.to_string(),"method":method,"turnId":turn,"dateMs":at,"type":payment_type});
        repair["payments"]
            .as_array_mut()
            .ok_or_else(invalid)?
            .push(payment.clone());
        repair["paidCents"] = json!(add(n(s(&repair["paidCents"])?)?, amount)?.to_string());
    }
    if revision == 0 {
        repair["log"]
            .as_array_mut()
            .ok_or_else(invalid)?
            .push(json!({"state":"recibido","dateMs":at,"actorId":ctx.actor_id}));
    }
    if repair["state"] != original_state {
        let state = repair["state"].clone();
        repair["log"]
            .as_array_mut()
            .ok_or_else(invalid)?
            .push(json!({"state":state,"dateMs":at,"actorId":ctx.actor_id}));
    }
    repair["revision"] = json!(revision.checked_add(1).ok_or_else(invalid)?.to_string());
    repair["updatedAtMs"] = json!(at);
    let before = old
        .as_ref()
        .map(|d| reserved(&d["repair"]))
        .transpose()?
        .unwrap_or_default();
    let after = reserved(&repair)?;
    let mut delta = before;
    for (id, qty) in after {
        let old = delta.entry(id).or_default();
        *old = old.checked_sub(qty).ok_or_else(invalid)?;
    }
    for (id, qty) in recovered {
        let d = delta.entry(id).or_default();
        *d = d.checked_add(qty).ok_or_else(invalid)?;
    }
    let sk = sales::scope_key(ctx)?;
    let mut stock = vec![];
    for (id, delta) in delta {
        if delta == 0 {
            continue;
        }
        if let Some(source) = source {
            let row = source["stock"]
                .as_array()
                .ok_or_else(invalid)?
                .get(stock.len())
                .ok_or_else(invalid)?;
            let delta_text = delta.to_string();
            if row["productId"] != id || row["delta"] != delta_text {
                return Err(invalid());
            }
            stock.push(row.clone());
            continue;
        }
        if products
            .iter()
            .any(|p| p["document"]["product"]["id"] == id)
        {
            let proof = json!({"productId":id,"remoteBaseQty":"0","remoteSequence":"0","pending":[],"effectiveQty":"0"});
            let (_, rev) = crate::domain::canonical::canonicalize(
                &serde_json::to_vec(&json!({"quantity":"0","remoteSequence":"0","pending":[]}))
                    .map_err(|_| invalid())?,
            )
            .map_err(|_| invalid())?;
            stock.push(json!({"productId":id,"delta":delta.to_string(),"before":"0","after":delta.to_string(),"expectedRevision":rev,"stockEvidence":proof}));
            continue;
        }
        let (qty, rev, pending) = sales::stock(c, &id, &sk)?;
        let next = qty
            .checked_add(delta)
            .filter(|n| *n >= 0)
            .ok_or_else(|| guard("STOCK_INSUFFICIENT"))?;
        let(base,seq):(String,i64)=c.query_row("SELECT remote_base_qty,remote_seq FROM stock_projections WHERE producto_id=?1 AND scope_key=?2",(&id,&sk),|r|Ok((r.get(0)?,r.get(1)?)))?;
        stock.push(json!({"productId":id,"delta":delta.to_string(),"before":qty.to_string(),"after":next.to_string(),"expectedRevision":rev,"stockEvidence":{"productId":id,"remoteBaseQty":base,"remoteSequence":seq.to_string(),"pending":serde_json::from_str::<Value>(&pending).map_err(|_|invalid())?,"effectiveQty":qty.to_string()}}));
    }
    let cash = if method == "EFECTIVO" { amount } else { 0 };
    let mut d = json!({"operationId":op,"repair":repair,"stock":stock,"payment":payment,"amountCents":amount.to_string(),"method":if amount==0{Value::Null}else{json!(method)},"concept":format!("Reparación {}",repair["folio"].as_str().ok_or_else(invalid)?)});
    if amount > 0 && turn.is_some() {
        d["cashDeltaCents"] = json!(cash.to_string());
    }
    // Freeze the original receipt header; newer edits cannot rewrite it.
    let business = if let Some(old) = &old {
        old["business"].clone()
    } else if let Some(source) = source {
        source["business"].clone()
    } else {
        super::settings::public_profile(c, ctx)?
    };
    d["business"] = business;
    if !customer.is_null() {
        d["customer"] = customer;
    }
    if matches!(req, Command::RepairDisassemble { .. }) {
        d["products"] = json!(products);
    }
    Ok((
        if matches!(req, Command::RepairDisassemble { .. }) {
            "REPAIR_DISASSEMBLE"
        } else if revision == 0 {
            "REPAIR_CREATE"
        } else {
            "REPAIR_EDIT"
        }
        .into(),
        d,
    ))
}
pub fn effects(v: &Value) -> Result<Value, AppError> {
    let op = s(&v["operationId"])?;
    let d = &v["payload"]["document"];
    let mut effects =
        vec![json!({"id":sales::effect_id(op,"management"),"kind":v["kind"],"payload":d})];
    for e in d["stock"].as_array().ok_or_else(invalid)? {
        let pid = s(&e["productId"])?;
        effects.push(json!({"id":sales::effect_id(op,&format!("stock/{pid}")),"kind":"STOCK","payload":{"productId":pid,"delta":e["delta"]}}));
    }
    Ok(json!(effects))
}
pub fn validate_receipt(v: &Value, r: &Value, snapshot: Option<&str>) -> Result<(), AppError> {
    if snapshot.is_some()
        || !r["snapshotHash"].is_null()
        || !r["ticket"].is_null()
        || !r["ncf"].is_null()
        || !r["totalCents"].is_null()
        || r["effects"] != effects(v)?
    {
        return Err(invalid());
    }
    let d = &v["payload"]["document"];
    let stock = d["stock"].as_array().ok_or_else(invalid)?;
    let actual = r["stock"].as_array().ok_or_else(invalid)?;
    if actual.len() != stock.len() {
        return Err(invalid());
    }
    let mut ids = HashSet::new();
    for (e, a) in stock.iter().zip(actual) {
        let id = s(&e["productId"])?;
        EntityId::parse(id).map_err(|_| invalid())?;
        if !ids.insert(id) {
            return Err(invalid());
        }
        let proof = &e["stockEvidence"];
        let pending = proof["pending"].as_array().ok_or_else(invalid)?;
        if pending.len() > 1000 || proof["productId"] != id || proof["effectiveQty"] != e["before"]
        {
            return Err(invalid());
        }
        let mut effective = uint(s(&proof["remoteBaseQty"])?)? as i64;
        n(s(&proof["remoteSequence"])?)?;
        let mut seen = HashSet::new();
        for p in pending {
            let op = s(&p["operationId"])?;
            EntityId::parse(op).map_err(|_| invalid())?;
            let delta = s(&p["delta"])?.parse::<i32>().map_err(|_| invalid())?;
            if !seen.insert(op)
                || s(&p["delta"])? != delta.to_string().as_str()
                || p["effectId"] != sales::effect_id(op, &format!("stock/{id}"))
            {
                return Err(invalid());
            }
            effective = effective.checked_add(delta as i64).ok_or_else(invalid)?;
        }
        let (_,hash)=crate::domain::canonical::canonicalize(&serde_json::to_vec(&json!({"quantity":proof["effectiveQty"],"remoteSequence":proof["remoteSequence"],"pending":pending})).map_err(|_|invalid())?).map_err(|_|invalid())?;
        if effective != uint(s(&e["before"])?)? as i64 || e["expectedRevision"] != hash {
            return Err(invalid());
        }
        let delta = s(&e["delta"])?.parse::<i32>().map_err(|_| invalid())?;
        if s(&e["delta"])? != delta.to_string().as_str() {
            return Err(invalid());
        }
        if uint(s(&e["before"])?)?.checked_add(delta) != Some(uint(s(&e["after"])?)?)
            || a["productId"] != e["productId"]
            || a["after"] != e["after"]
            || a["version"] != r["remoteSequence"]
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
    let req: Command =
        serde_json::from_value(v["payload"]["request"].clone()).map_err(|_| invalid())?;
    let d = &v["payload"]["document"];
    let mut source = ctx.clone();
    source.actor_id = s(&v["actorId"])?.into();
    source.installation_id = s(&v["installationId"])?.into();
    source.device_id = s(&v["originDeviceId"])?.into();
    source.writer_epoch = s(&v["writerEpoch"])?.into();
    let (kind, expected) = document_inner(
        tx,
        &source,
        &req,
        s(&v["originAtUtcMs"])?,
        remote.then_some(d),
    )?;
    if v["kind"] != kind || expected != *d {
        return Err(guard("VERSION_CONFLICT"));
    }
    let op = s(&v["operationId"])?;
    let sk = sales::scope_key(ctx)?;
    if v["kind"] == "REPAIR_DISASSEMBLE" {
        for p in d["products"].as_array().ok_or_else(invalid)? {
            let mut create = v.clone();
            create["kind"] = json!("PRODUCT_CREATE");
            create["payload"] = p.clone();
            // The compound operation publishes one stock effect per recovered
            // product; its initial zero is part of this same declaration.
            inventory::apply(tx, ctx, &create, true)?;
        }
    }
    if d["customer"].is_object() {
        let cu = &d["customer"];
        let cid = s(&cu["id"])?;
        tx.execute(
            "INSERT INTO sale_customer_accounts_v1 VALUES(?1,?2,?3,?4,0,0,1,'VERIFIED',1)",
            (cid, &ctx.tenant_id, &sk, s(&cu["name"])?),
        )?;
        tx.execute(
            "INSERT INTO native_customer_metadata_v1 VALUES(?1,?2,?3,1,0,1)",
            (cid, &ctx.tenant_id, cu["phone"].as_str()),
        )?;
        tx.execute(
            "INSERT INTO native_sales_customer_pricing_v1 VALUES(?1,?2,1)",
            (cid, &ctx.tenant_id),
        )?;
    }
    for e in d["stock"].as_array().ok_or_else(invalid)? {
        let id = s(&e["productId"])?;
        let eid = sales::effect_id(op, &format!("stock/{id}"));
        tx.execute(
            "INSERT INTO inventory_movements VALUES(?1,?2,?3,?4,'REPAIR',?5,NULL,NULL,NULL)",
            (&eid, op, id, &sk, s(&e["delta"])?),
        )?;
        if !remote {
            let (_, _, pending) = sales::stock(tx, id, &sk)?;
            let mut pending: Vec<Value> = serde_json::from_str(&pending).map_err(|_| invalid())?;
            pending.push(json!({"operationId":op,"effectId":eid,"delta":e["delta"]}));
            tx.execute("UPDATE stock_projections SET effective_stock=?3,pending_coverage=?4 WHERE producto_id=?1 AND scope_key=?2",(id,&sk,s(&e["after"])?,json!(pending).to_string()))?;
        }
    }
    if n(s(&d["amountCents"])?)? > 0 {
        tx.execute(
            "INSERT INTO payments VALUES(?1,?2,NULL,NULL,?3,?4,0,0,?5)",
            (
                sales::effect_id(op, "payment"),
                op,
                s(&d["method"])?,
                n(s(&d["amountCents"])?)?,
                v["originalTurnId"].as_str(),
            ),
        )?;
    }
    Ok(())
}
