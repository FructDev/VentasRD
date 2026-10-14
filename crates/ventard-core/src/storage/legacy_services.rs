//! Present service balances/reservations adopted by an explicit owner cutover.
//! Old payments stay evidence, never payment effects or native receipts.
use super::{catalogue_preview::CatalogueContext, legacy_transition};
use crate::{
    application::{
        errors::{AppError, ProtocolError},
        sales,
    },
    domain::canonical::canonicalize,
};
use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Value};

fn invalid() -> AppError {
    AppError::Protocol(ProtocolError::MalformedPayload)
}
fn text(v: &Value, key: &str) -> String {
    v[key].as_str().unwrap_or("").to_owned()
}
fn integer(v: &Value) -> Result<String, AppError> {
    let v = super::legacy_reconciliation::number(v).ok_or_else(invalid)?;
    let n = v.parse::<u64>().map_err(|_| invalid())?;
    if n > 9_007_199_254_740_991 {
        return Err(invalid());
    }
    Ok(n.to_string())
}
fn cents(v: &Value) -> Result<String, AppError> {
    legacy_transition::cents(v)
        .filter(|n| *n >= 0)
        .map(|n| n.to_string())
        .ok_or_else(invalid)
}
pub fn active(table: &str, row: &Value) -> bool {
    match table {
        "apartados" => row["estado"] == "activo",
        "reparaciones" => !matches!(
            row["estado"].as_str(),
            Some("entregado" | "cancelado" | "no_reparado")
        ),
        _ => false,
    }
}
/// Exact, deterministic projection; raw source remains encrypted alongside it.
pub fn project(table: &str, raw: &Value) -> Result<Value, AppError> {
    let r = legacy_transition::normalize(raw, 0).map_err(|_| invalid())?;
    uuid::Uuid::parse_str(r["id"].as_str().ok_or_else(invalid)?).map_err(|_| invalid())?;
    let created = integer(&r["fecha_creacion"])?;
    let updated = integer(&r["fecha_actualizacion"])?;
    if created.parse::<u64>().map_err(|_| invalid())?
        > updated.parse::<u64>().map_err(|_| invalid())?
    {
        return Err(invalid());
    }
    let total = cents(&r["total"])?;
    let paid = cents(
        &r[if table == "apartados" {
            "abonado"
        } else {
            "abono"
        }],
    )?;
    let (_, raw_hash) = canonicalize(r.to_string().as_bytes()).map_err(|_| invalid())?;
    let mut doc = json!({"id":r["id"],"revision":"1","folio":r["folio"],"folioNumber":"1","state":r["estado"],"totalCents":total,"paidCents":paid,"payments":[],"createdAtMs":created,"updatedAtMs":updated,"warrantyDays":"0","warrantyUntilMs":null,"legacyBaseline":{"protocol":"ventard.service.baseline.1","sourceHash":raw_hash,"paidCents":paid}});
    let field = if table == "apartados" {
        "abonos"
    } else {
        "pagos"
    };
    let evidence = r[field].as_array();
    let mut payments = vec![];
    let mut occurrences = std::collections::BTreeMap::<String, u32>::new();
    for p in evidence.into_iter().flatten() {
        let fingerprint = canonicalize(p.to_string().as_bytes())
            .map_err(|_| invalid())?
            .1;
        let occurrence = occurrences.entry(fingerprint.clone()).or_default();
        let identity = canonicalize(
            json!([
                r["negocio_id"],
                table,
                r["id"],
                field,
                fingerprint,
                *occurrence
            ])
            .to_string()
            .as_bytes(),
        )
        .map_err(|_| invalid())?
        .1;
        *occurrence += 1;
        payments.push(json!({"id":identity,"amountCents":cents(&p["monto"]).ok(),"method":p["metodo"].as_str(),"dateMs":integer(&p["fecha"]).ok()}));
    }
    doc["legacyBaseline"]["payments"] = json!(payments);
    doc["legacyBaseline"]["paymentsRecorded"] = json!(evidence.is_some());
    let mut log = vec![];
    for l in r["bitacora"].as_array().into_iter().flatten() {
        log.push(json!({"state":l["estado"].as_str(),"dateMs":integer(&l["fecha"]).ok(),"actor":l["usuario"].as_str()}));
    }
    doc["legacyBaseline"]["log"] = json!(log);
    if r["folio"]
        .as_str()
        .is_none_or(|s| s.is_empty() || s.len() > 256)
    {
        return Err(invalid());
    }
    let mut definition = json!({"customerId":r.get("cliente_id").unwrap_or(&Value::Null),"customerName":text(&r,"cliente_nombre"),"phone":text(&r,"cliente_telefono"),"notes":text(&r,"notas")});
    if table == "apartados" {
        if r["estado"] != "activo" {
            return Err(invalid());
        }
        let mut items = vec![];
        for item in r["items"].as_array().ok_or_else(invalid)? {
            items.push(json!({"productId":item["producto_id"],"name":item["nombre"],"quantity":integer(&item["cantidad"])?,"priceCents":cents(&item["precio_unitario"])?,"serial":item.get("serial_numero").unwrap_or(&Value::Null)}));
        }
        definition["items"] = json!(items);
        let mut computed = 0i128;
        for item in definition["items"].as_array().ok_or_else(invalid)? {
            let q = item["quantity"]
                .as_str()
                .ok_or_else(invalid)?
                .parse::<i128>()
                .map_err(|_| invalid())?;
            if q <= 0 || q > i32::MAX as i128 {
                return Err(invalid());
            }
            computed += q * item["priceCents"]
                .as_str()
                .ok_or_else(invalid)?
                .parse::<i128>()
                .map_err(|_| invalid())?;
        }
        if computed.to_string() != total || paid.parse::<i128>().map_err(|_| invalid())? > computed
        {
            return Err(invalid());
        }
        doc["completedAtMs"] = Value::Null;
        doc["cancelledAtMs"] = Value::Null;
    } else if table == "reparaciones" {
        for (to, from) in [
            ("brand", "equipo_marca"),
            ("model", "equipo_modelo"),
            ("imei", "equipo_imei"),
            ("color", "equipo_color"),
            ("conditionNotes", "condicion_entrada"),
            ("accessories", "accesorios"),
            ("problem", "problema_reportado"),
            ("diagnosis", "diagnostico"),
            ("technician", "tecnico_nombre"),
        ] {
            definition[to] = json!(text(&r, from));
        }
        definition["conditionChecks"] = r.get("condicion_checklist").cloned().unwrap_or(json!([]));
        definition["labourCents"] = json!(cents(&r["mano_obra"])?);
        let mut parts = vec![];
        let mut computed = definition["labourCents"]
            .as_str()
            .ok_or_else(invalid)?
            .parse::<i128>()
            .map_err(|_| invalid())?;
        for part in r["repuestos"].as_array().ok_or_else(invalid)? {
            let quantity = integer(&part["cantidad"])?;
            let price = cents(&part["precio"])?;
            computed += quantity.parse::<i128>().map_err(|_| invalid())?
                * price.parse::<i128>().map_err(|_| invalid())?;
            parts.push(json!({"productId":if part["desde_inventario"]==true{part.get("producto_id").unwrap_or(&Value::Null).clone()}else{Value::Null},"name":part["nombre"],"quantity":quantity,"costCents":cents(&part["costo"])?,"priceCents":price}));
        }
        let separate = computed.to_string() == total;
        if !separate && definition["labourCents"] != total && r["estado"] != "abandonado" {
            return Err(invalid());
        }
        if !separate {
            for p in &mut parts {
                p["priceCents"] = json!("0")
            }
        }
        definition["partsChargeSeparate"] = json!(separate);
        definition["parts"] = json!(parts);
        if r["es_garantia"] == true {
            definition["warrantyOriginId"] = r["reparacion_origen_id"].clone()
        }
        doc["log"] = json!([]);
        doc["deliveredAtMs"] = Value::Null;
    } else {
        return Err(invalid());
    }
    doc["definition"] = definition;
    if table == "apartados" {
        serde_json::from_value::<crate::application::layaways::Definition>(
            doc["definition"].clone(),
        )
        .map_err(|_| invalid())?;
    } else {
        serde_json::from_value::<crate::application::repairs::Definition>(
            doc["definition"].clone(),
        )
        .map_err(|_| invalid())?;
        if !matches!(
            r["estado"].as_str(),
            Some(
                "recibido"
                    | "diagnostico"
                    | "cotizado"
                    | "en_reparacion"
                    | "esperando_repuesto"
                    | "listo"
                    | "abandonado"
            )
        ) {
            return Err(invalid());
        }
    }
    Ok(doc)
}
pub fn current(
    c: &Connection,
    ctx: &CatalogueContext,
    kind: &str,
    id: &str,
) -> Result<Option<Value>, AppError> {
    if !available(c)? {
        return Ok(None);
    }
    let raw:Option<String>=c.query_row("SELECT envelope FROM legacy_service_baselines_v1 WHERE tenant_id=?1 AND scope_key=?2 AND kind=?3 AND service_id=?4",(&ctx.tenant_id,sales::scope_key(ctx)?,kind,id),|r|r.get(0)).optional()?;
    raw.map(|raw|{let envelope:Value=serde_json::from_str(&raw).map_err(|_|invalid())?;validate(ctx,&envelope)?;let mut d=json!({"operationId":envelope["document"]["id"],"business":null,"remoteStatus":"BASELINE_ADOPTED"});d[kind]=envelope["document"].clone();Ok(d)}).transpose()
}
pub fn import(c: &Connection, ctx: &CatalogueContext, envelopes: &Value) -> Result<(), AppError> {
    if envelopes.is_null() {
        return Ok(());
    }
    let rows = envelopes.as_array().ok_or_else(invalid)?;
    if rows.len() > 10000 {
        return Err(invalid());
    }
    for envelope in rows {
        let (kind, doc) = validate(ctx, envelope)?;
        let id = doc["id"].as_str().ok_or_else(invalid)?;
        let previous:Option<String>=c.query_row("SELECT envelope FROM legacy_service_baselines_v1 WHERE tenant_id=?1 AND scope_key=?2 AND kind=?3 AND service_id=?4",(&ctx.tenant_id,sales::scope_key(ctx)?,kind,id),|r|r.get(0)).optional()?;
        if let Some(previous) = previous {
            if serde_json::from_str::<Value>(&previous).map_err(|_| invalid())? != *envelope {
                return Err(invalid());
            }
        } else {
            c.execute(
                "INSERT INTO legacy_service_baselines_v1 VALUES(?1,?2,?3,?4,?5)",
                (
                    &ctx.tenant_id,
                    sales::scope_key(ctx)?,
                    kind,
                    id,
                    envelope.to_string(),
                ),
            )?;
        }
    }
    Ok(())
}

fn validate(ctx: &CatalogueContext, envelope: &Value) -> Result<(&'static str, Value), AppError> {
    let table = envelope["table"].as_str().ok_or_else(invalid)?;
    let kind = match table {
        "apartados" => "layaway",
        "reparaciones" => "repair",
        _ => return Err(invalid()),
    };
    let raw = &envelope["source"];
    let receipt = &envelope["receipt"];
    let doc = project(table, raw)?;
    let (_, doc_hash) = canonicalize(doc.to_string().as_bytes()).map_err(|_| invalid())?;
    if raw["negocio_id"] != ctx.tenant_id
        || raw.get("sucursal_id").unwrap_or(&Value::Null) != &json!(ctx.branch_id)
        || envelope["document"] != doc
        || receipt["protocol"] != "ventard.service.baseline.receipt.1"
        || receipt["status"] != "BASELINE_ADOPTED"
        || receipt["tenantId"] != ctx.tenant_id
        || receipt["scope"] != json!({"type":ctx.scope_type,"branchId":ctx.branch_id})
        || receipt["sourceHash"] != doc["legacyBaseline"]["sourceHash"]
        || receipt["documentHash"] != doc_hash
        || receipt["legacyReplay"] != false
        || uuid::Uuid::parse_str(receipt["cutoverId"].as_str().ok_or_else(invalid)?).is_err()
    {
        return Err(invalid());
    }
    Ok((kind, doc))
}

pub fn available(c: &Connection) -> Result<bool, AppError> {
    Ok(c.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='legacy_service_baselines_v1')",
        [],
        |r| r.get(0),
    )?)
}
pub fn source(
    c: &Connection,
    ctx: &CatalogueContext,
    kind: &str,
    id: &str,
) -> Result<Option<Value>, AppError> {
    if !available(c)? {
        return Ok(None);
    }
    let raw:Option<String>=c.query_row("SELECT envelope FROM legacy_service_baselines_v1 WHERE tenant_id=?1 AND scope_key=?2 AND kind=?3 AND service_id=?4",(&ctx.tenant_id,sales::scope_key(ctx)?,kind,id),|r|r.get(0)).optional()?;
    raw.map(|raw| {
        let e: Value = serde_json::from_str(&raw).map_err(|_| invalid())?;
        validate(ctx, &e)?;
        Ok(e["source"].clone())
    })
    .transpose()
}
