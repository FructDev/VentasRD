//! Operator-reviewed present balances and document versions, separate from
//! immutable historical evidence. No inferred remote application or replay.
use super::*;
use std::collections::BTreeSet;
type Data = BTreeMap<String, Vec<Value>>;
pub fn resolution_upload_parts(intent: &str) -> Result<Vec<String>, Error> {
    if intent.is_empty() || intent.len() > transition::MAX_CAPTURE {
        return Err(Error("RESOLUTION_TOO_LARGE"));
    }
    let mut parts = vec![];
    let mut start = 0;
    while start < intent.len() {
        let mut end = (start + 524_288).min(intent.len());
        while !intent.is_char_boundary(end) {
            end -= 1;
        }
        if end <= start {
            return Err(invalid());
        }
        parts.push(intent[start..end].to_owned());
        start = end;
    }
    Ok(parts)
}
pub fn resolution_part_hash(part: &str) -> String {
    hash(part)
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RowDisposition {
    pub table: String,
    pub row_id: String,
    pub variant_id: Option<String>,
    pub archive_only: bool,
    #[serde(default)]
    pub scope_confirmed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub patch: Option<Value>,
    pub reason: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StockCount {
    pub product_id: String,
    pub quantity: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DebtBalance {
    pub customer_id: String,
    pub balance_cents: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SelectedReview {
    pub run_id: String,
    pub revision: u32,
    pub decisions: Vec<RowDisposition>,
    pub stock_counts: Vec<StockCount>,
    pub debt_balances: Vec<DebtBalance>,
    pub reason: String,
    pub confirmation: String,
}
fn reason_valid(s: &str) -> bool {
    let s = s.trim();
    (10..=500).contains(&s.chars().count()) && !s.chars().any(char::is_control)
}
fn whole(s: &str, max: u64) -> bool {
    !s.is_empty()
        && s.bytes().all(|b| b.is_ascii_digit())
        && s.parse::<u64>()
            .is_ok_and(|n| n <= max && n.to_string() == s)
}
fn cloud_rows(c: &Connection, ctx: &CatalogueContext, run: &str) -> Result<Data, Error> {
    let report = transition::report(c, ctx, run)?;
    let source = report["sources"]
        .as_array()
        .ok_or_else(invalid)?
        .iter()
        .find(|s| s["kind"] == "CLOUD")
        .ok_or(Error("CUTOVER_CLOUD_REQUIRED"))?;
    // comparison authenticates the context, source hash and capture identity.
    comparison(c, ctx, run)?;
    let raw: String = c.query_row(
        "SELECT body FROM legacy_cloud_captures_v1 WHERE capture_id=?1",
        [source["id"].as_str().ok_or_else(invalid)?],
        |r| r.get(0),
    )?;
    let capture: Value = serde_json::from_str(&raw).map_err(|_| invalid())?;
    capture["tables"]
        .as_array()
        .ok_or_else(invalid)?
        .iter()
        .map(|t| {
            Ok((
                t["name"].as_str().ok_or_else(invalid)?.to_owned(),
                t["rows"]
                    .as_array()
                    .ok_or_else(invalid)?
                    .iter()
                    .map(|r| transition::normalize(r, 0).map_err(Error::from))
                    .collect::<Result<Vec<_>, _>>()?,
            ))
        })
        .collect()
}
fn replace(data: &mut Data, table: &str, id: &str, row: Option<Value>) {
    let rows = data.entry(table.into()).or_default();
    rows.retain(|r| r["id"] != id);
    if let Some(row) = row {
        rows.push(row)
    }
    rows.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
}
fn sale_owner(table: &str, row: &Value, id: &str) -> bool {
    match table {
        "venta_detalles" => row["venta_id"] == id,
        "transacciones_fiado" => row["venta_id"] == id && row["tipo"] == "cargo",
        "movimientos_stock" => row["referencia_id"] == id && row["tipo"] == "venta",
        "operaciones_locales" => {
            row["operation_id"] == id && matches!(row["tipo"].as_str(), Some("SALE" | "CHECKOUT"))
        }
        _ => false,
    }
}
fn target(
    c: &Connection,
    ctx: &CatalogueContext,
    run: &str,
    decisions: &[RowDisposition],
) -> Result<Data, Error> {
    if decisions.len() > 200_000 {
        return Err(invalid());
    }
    let mut data = transition::selected(c, run)?;
    cloud_rows(c, ctx, run)?;
    let mut seen = BTreeSet::new();
    for d in decisions
        .iter()
        .filter(|d| d.table == "ventas")
        .chain(decisions.iter().filter(|d| d.table != "ventas"))
    {
        if !transition::CLOUD_TABLES.contains(&d.table.as_str())
            || !seen.insert((&d.table, &d.row_id))
            || !reason_valid(&d.reason)
        {
            return Err(invalid());
        }
        let raw:Option<String>=c.query_row("SELECT variants FROM legacy_transition_rows_v1 WHERE run_id=?1 AND table_name=?2 AND row_id=?3",(run,&d.table,&d.row_id),|r|r.get(0)).optional()?;
        let variants: Value =
            serde_json::from_str(&raw.ok_or_else(invalid)?).map_err(|_| invalid())?;
        if d.variant_id.is_some() && !d.archive_only && d.table != "ventas" {
            for v in variants.as_array().ok_or_else(invalid)? {
                let row = &v["row"];
                let parent = match d.table.as_str() {
                    "venta_detalles" => row["venta_id"].as_str(),
                    "transacciones_fiado" if row["tipo"] == "cargo" => row["venta_id"].as_str(),
                    "movimientos_stock" if row["tipo"] == "venta" => row["referencia_id"].as_str(),
                    _ => None,
                };
                if let Some(parent) = parent {
                    let state:Option<String>=c.query_row("SELECT state FROM legacy_transition_docs_v1 WHERE run_id=?1 AND sale_id=?2",(run,parent),|r|r.get(0)).optional()?;
                    if state.as_deref().is_some_and(|s| s != "CONSENSUS") {
                        return Err(Error("TRANSITION_DOCUMENT_REQUIRED"));
                    }
                }
            }
        }
        let mut chosen = if d.archive_only {
            None
        } else if d.table == "ventas" && d.variant_id.is_some() {
            let raw: String = c.query_row(
                "SELECT variants FROM legacy_transition_docs_v1 WHERE run_id=?1 AND sale_id=?2",
                (run, &d.row_id),
                |r| r.get(0),
            )?;
            let docs: Value = serde_json::from_str(&raw).map_err(|_| invalid())?;
            let doc = docs
                .as_array()
                .ok_or_else(invalid)?
                .iter()
                .find(|v| Some(v["sourceId"].as_str().unwrap_or("")) == d.variant_id.as_deref())
                .ok_or_else(invalid)?;
            for (table, field) in [
                ("venta_detalles", "details"),
                ("transacciones_fiado", "charges"),
                ("movimientos_stock", "inventory"),
                ("operaciones_locales", "journals"),
            ] {
                data.entry(table.into())
                    .or_default()
                    .retain(|r| !sale_owner(table, r, &d.row_id));
                for r in doc[field].as_array().ok_or_else(invalid)? {
                    data.entry(table.into())
                        .or_default()
                        .push(transition::normalize(r, 0)?);
                }
            }
            Some(transition::normalize(&doc["sale"], 0)?)
        } else if let Some(variant) = &d.variant_id {
            Some(transition::normalize(
                &variants
                    .as_array()
                    .ok_or_else(invalid)?
                    .iter()
                    .find(|v| v["variantId"] == *variant)
                    .ok_or_else(invalid)?["row"],
                0,
            )?)
        } else {
            data.get(&d.table)
                .into_iter()
                .flatten()
                .find(|r| r["id"] == d.row_id)
                .cloned()
        };
        if d.archive_only && d.table == "ventas" {
            for table in [
                "venta_detalles",
                "transacciones_fiado",
                "movimientos_stock",
                "operaciones_locales",
            ] {
                data.entry(table.into())
                    .or_default()
                    .retain(|r| !sale_owner(table, r, &d.row_id));
            }
        }
        if let Some(patch) = &d.patch {
            if d.archive_only || super::super::legacy_web::secrets(patch) {
                return Err(Error("RESOLUTION_PATCH_INVALID"));
            }
            let allowed: &[&str] = match d.table.as_str() {
                "productos" => &[
                    "nombre",
                    "codigo_barras",
                    "precio_venta",
                    "precio_2",
                    "precio_3",
                    "costo",
                    "tasa_itbis",
                    "tipo",
                    "serializable",
                    "eliminado",
                    "stock_minimo",
                    "ubicacion",
                    "fecha_creacion",
                    "fecha_actualizacion",
                ],
                "clientes" => &[
                    "nombre",
                    "telefono",
                    "limite_credito",
                    "tipo_precio",
                    "al_por_mayor",
                    "eliminado",
                    "fecha_actualizacion",
                ],
                "reparaciones" => &[
                    "folio",
                    "cliente_id",
                    "cliente_nombre",
                    "cliente_telefono",
                    "equipo_marca",
                    "equipo_modelo",
                    "equipo_imei",
                    "equipo_color",
                    "condicion_checklist",
                    "condicion_entrada",
                    "accesorios",
                    "problema_reportado",
                    "diagnostico",
                    "tecnico_nombre",
                    "notas",
                    "repuestos",
                    "mano_obra",
                    "total",
                    "abono",
                    "pagos",
                    "bitacora",
                    "estado",
                    "es_garantia",
                    "reparacion_origen_id",
                    "fecha_creacion",
                    "fecha_actualizacion",
                ],
                "apartados" => &[
                    "folio",
                    "cliente_id",
                    "cliente_nombre",
                    "cliente_telefono",
                    "notas",
                    "items",
                    "total",
                    "abonado",
                    "abonos",
                    "estado",
                    "fecha_creacion",
                    "fecha_actualizacion",
                    "fecha_completado",
                    "fecha_cancelado",
                ],
                _ => return Err(Error("RESOLUTION_PATCH_INVALID")),
            };
            let patch = patch.as_object().ok_or_else(invalid)?;
            let row = chosen
                .as_mut()
                .and_then(Value::as_object_mut)
                .ok_or_else(invalid)?;
            for (field, value) in patch {
                if !allowed.contains(&field.as_str()) {
                    return Err(Error("RESOLUTION_PATCH_INVALID"));
                }
                row.insert(field.clone(), transition::normalize(value, 0)?);
            }
        }
        if let Some(ref row) = chosen {
            if row["id"] != d.row_id {
                return Err(invalid());
            }
        }
        replace(&mut data, &d.table, &d.row_id, chosen);
    }
    // Foreign, explicitly identified businesses stay in their source archive.
    for rows in data.values_mut() {
        rows.retain(|r| {
            !r["negocio_id"]
                .as_str()
                .is_some_and(|n| n != ctx.tenant_id && uuid::Uuid::parse_str(n).is_ok())
        });
        let ids = rows
            .iter()
            .map(|r| r["id"].as_str().ok_or_else(invalid))
            .collect::<Result<BTreeSet<_>, _>>()?;
        if ids.len() != rows.len() {
            return Err(Error("TRANSITION_DOCUMENT_OWNERSHIP"));
        }
    }
    let analysis = transition::analyze(c, ctx, run, Some(data.clone()))?;
    for (table, rows) in &mut data {
        if !matches!(
            table.as_str(),
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
        ) {
            continue;
        }
        for row in rows {
            if row.get("sucursal_id").is_some() {
                continue;
            }
            let proved = analysis["issues"]
                .as_array()
                .ok_or_else(invalid)?
                .iter()
                .any(|i| {
                    i["table"] == *table
                        && i["id"] == row["id"]
                        && matches!(
                            i["code"].as_str(),
                            Some("SCOPE_FROM_LINKED_SALE" | "SCOPE_FROM_SAVED_CHECKOUT")
                        )
                });
            let attested = decisions.iter().any(|d| {
                d.table == *table && row["id"] == d.row_id && d.scope_confirmed && !d.archive_only
            });
            if proved || attested {
                row["sucursal_id"] = json!(ctx.branch_id);
            }
        }
    }
    Ok(data)
}
fn scoped_quantity(v: &Value, ctx: &CatalogueContext) -> Option<String> {
    let value = if ctx.scope_type == "GLOBAL" {
        &v["stock_actual"]
    } else {
        &v["inventory_stock_by_scope"][format!(
            "{}:{}",
            ctx.tenant_id,
            ctx.branch_id.as_deref().unwrap_or("GLOBAL")
        )]
    };
    let raw = super::super::legacy_reconciliation::number(value)?;
    whole(&raw, i32::MAX as u64).then_some(raw)
}
pub fn store_resolution_basis(
    c: &mut Connection,
    ctx: &CatalogueContext,
    run: &str,
    revision: u32,
    basis: &Value,
) -> Result<Value, Error> {
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let mut report = transition::report(&tx, ctx, run)?;
    let diff = comparison(&tx, ctx, run)?;
    if basis["protocol"] != "ventard.web.resolution.basis.1"
        || basis["context"] != json!(ctx)
        || basis["captureId"] != diff.capture_id
        || basis["tables"] != diff.tables
        || basis["stockHash"] != canonical(&basis["stockBase"])?.1
        || !basis["stockBase"].is_array()
    {
        return Err(Error("RESOLUTION_SOURCE_CHANGED"));
    }
    if basis["started"] != false {
        return Err(Error("RESOLUTION_NATIVE_ALREADY_STARTED"));
    }
    if report["resolutionBasis"] == *basis {
        return Ok(report);
    }
    if report["revision"] != revision || report["conflicts"] != 0 {
        return Err(Error("TRANSITION_REVISION"));
    }
    let pending:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM legacy_cutovers_v1 WHERE context=?1 AND state IN('UNKNOWN','ADOPTED','ACTIVE'))",[ctx_json(ctx)?],|r|r.get(0))?;
    if pending {
        return Err(Error("CUTOVER_REVIEW_REQUIRED"));
    }
    let next = revision.checked_add(1).ok_or_else(invalid)?;
    report["resolutionBasis"] = basis.clone();
    report["selectedBaselineReview"] = Value::Null;
    report["revision"] = json!(next);
    tx.execute("INSERT INTO legacy_transition_decisions_v1 VALUES(?1,?2,'RESOLUTION_BASIS',?3,?4,?5,'Captura vigente de existencias para conciliación')",(run,next,&diff.capture_id,canonical(basis)?.1,&ctx.actor_id))?;
    tx.execute(
        "UPDATE legacy_transition_runs_v1 SET revision=?2,report=?3 WHERE run_id=?1",
        (run, next, report.to_string()),
    )?;
    tx.commit()?;
    Ok(report)
}
fn selected_report(
    c: &Connection,
    ctx: &CatalogueContext,
    run: &str,
    data: Data,
) -> Result<Value, Error> {
    let mut a = transition::analyze(c, ctx, run, Some(data.clone()))?;
    let mut blockers = vec![];
    let mut warnings = vec![];
    let mut services = vec![];
    for p in data.get("productos").into_iter().flatten() {
        for field in ["precio_venta", "precio_2", "precio_3", "costo"] {
            if p.get(field)
                .is_some_and(|v| !v.is_null() && transition::cents(v).is_none_or(|n| n < 0))
            {
                blockers.push(
                    json!({"code":"INVALID_MONEY","table":"productos","id":p["id"],"field":field}),
                );
            }
        }
    }
    for t in ["reparaciones", "apartados"] {
        for r in data.get(t).into_iter().flatten() {
            if super::super::legacy_services::active(t, r) {
                if super::super::legacy_services::project(t, r).is_err() {
                    blockers.push(json!({"code":"CUTOVER_SERVICE_REQUIRES_RECONCILIATION","table":t,"id":r["id"]}));
                } else {
                    services.push(json!({"table":t,"id":r["id"],"folio":r["folio"]}));
                }
            }
        }
    }
    for r in data.get("cajas").into_iter().flatten() {
        if r["estado"] != "cerrada" {
            blockers.push(json!({"code":"CUTOVER_CLOSE_WEB_CASH","table":"cajas","id":r["id"]}));
        }
    }
    for issue in a["issues"].as_array().ok_or_else(invalid)? {
        match issue["code"].as_str().unwrap_or("") {
            "SCOPE_FROM_LINKED_SALE" | "SCOPE_FROM_SAVED_CHECKOUT" => {}
            "CASH_LINK_UNKNOWN"
            | "CASH_REFERENCE_MISSING"
            | "CASH_EXPECTED_MISMATCH"
            | "PAYMENT_HISTORY_MISSING"
            | "PAYMENT_SUM_MISMATCH"
            | "CREDIT_RETURN_UNPROVEN"
            | "RETURN_PAYMENT_UNPROVEN"
            | "CREDIT_CHARGE_MISMATCH"
            | "SALE_DETAILS_MISSING" => warnings.push(issue.clone()),
            "PAYMENT_UNKNOWN" if issue["table"] != "ventas" => warnings.push(issue.clone()),
            _ => blockers.push(issue.clone()),
        }
    }
    a["blockers"] = json!(blockers);
    a["warnings"] = json!(warnings);
    a["services"] = json!(services);
    Ok(a)
}
pub fn resolution_view(
    c: &Connection,
    ctx: &CatalogueContext,
    run: &str,
    page: u32,
) -> Result<Value, Error> {
    resolution_preview_inner(c, ctx, run, page, None)
}
pub fn resolution_preview(
    c: &Connection,
    ctx: &CatalogueContext,
    run: &str,
    page: u32,
    decisions: &[RowDisposition],
) -> Result<Value, Error> {
    resolution_preview_inner(c, ctx, run, page, Some(decisions))
}
fn resolution_preview_inner(
    c: &Connection,
    ctx: &CatalogueContext,
    run: &str,
    page: u32,
    draft: Option<&[RowDisposition]>,
) -> Result<Value, Error> {
    let report = transition::report(c, ctx, run)?;
    let mut diff = differences(c, ctx, run, page)?;
    let decisions: Vec<RowDisposition> = if let Some(d) = draft {
        d.to_vec()
    } else {
        report["selectedBaselineReview"]["input"]["decisions"]
            .as_array()
            .map(|v| serde_json::from_value(json!(v)).map_err(|_| invalid()))
            .transpose()?
            .unwrap_or_default()
    };
    let data = target(c, ctx, run, &decisions)?;
    let analysis = selected_report(c, ctx, run, data.clone())?;
    let basis = &report["resolutionBasis"];
    let original = transition::selected(c, run)?;
    let cloud = cloud_rows(c, ctx, run)?;
    let mut review_rows = comparison(c, ctx, run)?
        .rows
        .into_iter()
        .map(|r| {
            (
                (
                    r["table"].as_str().unwrap_or("").to_owned(),
                    r["id"].as_str().unwrap_or("").to_owned(),
                ),
                r,
            )
        })
        .collect::<BTreeMap<_, _>>();
    for issue in report["issues"]
        .as_array()
        .ok_or_else(invalid)?
        .iter()
        .chain(analysis["issues"].as_array().ok_or_else(invalid)?)
    {
        let t = issue["table"].as_str().ok_or_else(invalid)?;
        let id = issue["id"].as_str().ok_or_else(invalid)?;
        if transition::CLOUD_TABLES.contains(&t) {
            review_rows.entry((t.into(),id.into())).or_insert_with(||json!({"table":t,"id":id,"preserved":original.get(t).into_iter().flatten().find(|r|r["id"]==id),"cloud":cloud.get(t).into_iter().flatten().find(|r|r["id"]==id)}));
        }
    }
    diff["total"] = json!(review_rows.len());
    diff["rows"] = json!(review_rows
        .into_values()
        .skip(page as usize * 10)
        .take(10)
        .collect::<Vec<_>>());
    for row in diff["rows"].as_array_mut().ok_or_else(invalid)? {
        let raw: Option<String> = if row["table"] == "ventas" {
            c.query_row(
                "SELECT variants FROM legacy_transition_docs_v1 WHERE run_id=?1 AND sale_id=?2",
                (run, row["id"].as_str().ok_or_else(invalid)?),
                |r| r.get(0),
            )
            .optional()?
        } else {
            c.query_row("SELECT variants FROM legacy_transition_rows_v1 WHERE run_id=?1 AND table_name=?2 AND row_id=?3",(run,row["table"].as_str().ok_or_else(invalid)?,row["id"].as_str().ok_or_else(invalid)?),|r|r.get(0)).optional()?
        };
        row["options"] = raw
            .map(|s| serde_json::from_str::<Value>(&s).map_err(|_| invalid()))
            .transpose()?
            .unwrap_or(json!([]));
    }
    let mut products = vec![];
    for p in data
        .get("productos")
        .into_iter()
        .flatten()
        .filter(|p| p["tipo"] != "combo")
    {
        let id = p["id"].as_str().ok_or_else(invalid)?;
        let base = basis["stockBase"]
            .as_array()
            .and_then(|s| s.iter().find(|r| r["productId"] == id));
        let current = base.and_then(|r| {
            if ctx.scope_type == "GLOBAL" {
                r["quantity"].as_str()
            } else {
                r["branches"]
                    .as_array()
                    .and_then(|a| a.iter().find(|r| r["branchId"] == json!(ctx.branch_id)))
                    .and_then(|r| r["quantity"].as_str())
            }
        });
        let raw:Option<String>=c.query_row("SELECT variants FROM legacy_transition_rows_v1 WHERE run_id=?1 AND table_name='productos' AND row_id=?2",(run,id),|r|r.get(0)).optional()?;
        let variants: Value = raw
            .map(|s| serde_json::from_str(&s).map_err(|_| invalid()))
            .transpose()?
            .unwrap_or(json!([]));
        let proposals = variants
            .as_array()
            .ok_or_else(invalid)?
            .iter()
            .filter_map(|v| scoped_quantity(&v["row"], ctx))
            .collect::<BTreeSet<_>>();
        products.push(json!({"productId":id,"name":p["nombre"],"currentQuantity":current,"browserQuantity":if proposals.len()==1{proposals.first().cloned()}else{None},"serialRequired":p["serializable"]}));
    }
    let customers=data.get("clientes").into_iter().flatten().map(|r|{let debt=analysis["debts"].as_array().and_then(|a|a.iter().find(|d|d["customerId"]==r["id"]));json!({"customerId":r["id"],"name":r["nombre"],"ledgerBalanceCents":debt.map(|d|d["balanceCents"].clone()).unwrap_or(json!("0"))})}).collect::<Vec<_>>();
    diff["basisReady"] = json!(!basis.is_null());
    diff["selectedReviewed"] = json!(!report["selectedBaselineReview"].is_null());
    diff["products"] = json!(products);
    diff["customers"] = json!(customers);
    diff["analysis"] = analysis;
    diff["review"] = report["selectedBaselineReview"].clone();
    Ok(diff)
}
pub fn review_selected(
    c: &mut Connection,
    ctx: &CatalogueContext,
    input: &SelectedReview,
) -> Result<Value, Error> {
    if input.confirmation != "RECONCILE_SELECTED_DOCUMENTS_AND_PRESENT_BALANCES"
        || !reason_valid(&input.reason)
    {
        return Err(invalid());
    }
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let mut report = transition::report(&tx, ctx, &input.run_id)?;
    let input_value = json!(input);
    let input_hash = canonical(&input_value)?.1;
    if report["revision"] == input.revision.checked_add(1).ok_or_else(invalid)?
        && report["selectedBaselineReview"]["inputHash"] == input_hash
    {
        return Ok(report);
    }
    if report["revision"] != input.revision || report["conflicts"] != 0 {
        return Err(Error("CUTOVER_REVIEW_REQUIRED"));
    }
    if crate::application::sales_sync::operational(&tx, ctx).map_err(|_| invalid())? {
        return Err(Error("RESOLUTION_NATIVE_ALREADY_STARTED"));
    }
    let basis = report["resolutionBasis"].clone();
    if basis["protocol"] != "ventard.web.resolution.basis.1"
        || basis["context"] != json!(ctx)
        || basis["started"] != false
    {
        return Err(Error("RESOLUTION_BASIS_REQUIRED"));
    }
    let pending:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM legacy_cutovers_v1 WHERE context=?1 AND state IN('UNKNOWN','ADOPTED','ACTIVE'))",[ctx_json(ctx)?],|r|r.get(0))?;
    if pending {
        return Err(Error("CUTOVER_REVIEW_REQUIRED"));
    }
    let data = target(&tx, ctx, &input.run_id, &input.decisions)?;
    let analysis = selected_report(&tx, ctx, &input.run_id, data.clone())?;
    if !analysis["blockers"]
        .as_array()
        .ok_or_else(invalid)?
        .is_empty()
    {
        return Err(Error("RESOLUTION_DOCUMENTS_REQUIRED"));
    }
    let expected = data
        .get("productos")
        .into_iter()
        .flatten()
        .filter(|p| p["tipo"] != "combo")
        .map(|p| p["id"].as_str().ok_or_else(invalid))
        .collect::<Result<BTreeSet<_>, _>>()?;
    let counts = input
        .stock_counts
        .iter()
        .map(|s| s.product_id.as_str())
        .collect::<BTreeSet<_>>();
    if counts != expected
        || counts.len() != input.stock_counts.len()
        || input
            .stock_counts
            .iter()
            .any(|s| !whole(&s.quantity, i32::MAX as u64))
    {
        return Err(Error("RESOLUTION_STOCK_COVERAGE"));
    }
    let expected = data
        .get("clientes")
        .into_iter()
        .flatten()
        .map(|p| p["id"].as_str().ok_or_else(invalid))
        .collect::<Result<BTreeSet<_>, _>>()?;
    let balances = input
        .debt_balances
        .iter()
        .map(|s| s.customer_id.as_str())
        .collect::<BTreeSet<_>>();
    if balances != expected
        || balances.len() != input.debt_balances.len()
        || input
            .debt_balances
            .iter()
            .any(|s| !whole(&s.balance_cents, 9_007_199_254_740_991))
    {
        return Err(Error("RESOLUTION_DEBT_COVERAGE"));
    }
    let rows = transition::CLOUD_TABLES
        .iter()
        .map(|t| json!({"name":t,"rows":data.get(*t).cloned().unwrap_or_default()}))
        .collect::<Vec<_>>();
    let next = input.revision.checked_add(1).ok_or_else(invalid)?;
    report["selectedBaselineReview"] = json!({"input":input,"inputHash":input_hash,"rows":rows,"analysis":analysis,"history":history_for_plan(&tx,ctx,&input.run_id)?});
    report["revision"] = json!(next);
    tx.execute(
        "INSERT INTO legacy_transition_decisions_v1 VALUES(?1,?2,'SELECTED_BASELINE',?3,?4,?5,?6)",
        (
            &input.run_id,
            next,
            basis["captureId"].as_str().ok_or_else(invalid)?,
            &input_hash,
            &ctx.actor_id,
            input.reason.trim(),
        ),
    )?;
    tx.execute(
        "UPDATE legacy_transition_runs_v1 SET revision=?2,report=?3 WHERE run_id=?1",
        (&input.run_id, next, report.to_string()),
    )?;
    tx.commit()?;
    Ok(report)
}
pub fn resolution_plan(c: &Connection, ctx: &CatalogueContext, run: &str) -> Result<Value, Error> {
    let report = transition::report(c, ctx, run)?;
    let review = &report["selectedBaselineReview"];
    let input: SelectedReview = serde_json::from_value(review["input"].clone())
        .map_err(|_| Error("RESOLUTION_REVIEW_REQUIRED"))?;
    let h = canonical(&json!(input))?.1;
    let audited:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM legacy_transition_decisions_v1 WHERE run_id=?1 AND revision=?2 AND table_name='SELECTED_BASELINE' AND variant_id=?3 AND actor_id=?4)",(run,report["revision"].as_u64().ok_or_else(invalid)?,&h,&ctx.actor_id),|r|r.get(0))?;
    let data = target(c, ctx, run, &input.decisions)?;
    let rows = transition::CLOUD_TABLES
        .iter()
        .map(|t| json!({"name":t,"rows":data.get(*t).cloned().unwrap_or_default()}))
        .collect::<Vec<_>>();
    if !audited
        || review["inputHash"] != h
        || review["rows"] != json!(rows)
        || review["history"] != history_for_plan(c, ctx, run)?
    {
        return Err(Error("RESOLUTION_REVIEW_REQUIRED"));
    }
    Ok(
        json!({"protocol":"ventard.web.resolution.1","reason":input.reason,"basis":report["resolutionBasis"],"rows":rows,"stockCounts":input.stock_counts,"debtBalances":input.debt_balances,"decisions":input.decisions,"history":review["history"]}),
    )
}
pub fn selected_readiness(
    c: &Connection,
    ctx: &CatalogueContext,
    run: &str,
) -> Result<Value, Error> {
    let report = transition::report(c, ctx, run)?;
    let mut blockers = vec![];
    if report["conflicts"] != 0 {
        blockers.push(json!({"code":"CUTOVER_REVIEW_REQUIRED"}));
    }
    let plan = resolution_plan(c, ctx, run);
    let mut a = if let Ok(plan) = plan {
        let data = plan["rows"]
            .as_array()
            .ok_or_else(invalid)?
            .iter()
            .map(|t| {
                Ok((
                    t["name"].as_str().ok_or_else(invalid)?.to_owned(),
                    t["rows"].as_array().ok_or_else(invalid)?.clone(),
                ))
            })
            .collect::<Result<Data, Error>>()?;
        selected_report(c, ctx, run, data)?
    } else {
        blockers.push(json!({"code":"RESOLUTION_REVIEW_REQUIRED"}));
        json!({"blockers":[],"services":[],"warnings":[]})
    };
    blockers.extend(a["blockers"].as_array().ok_or_else(invalid)?.clone());
    a["runId"] = json!(run);
    a["revision"] = report["revision"].clone();
    a["canPrepare"] = json!(blockers.is_empty());
    a["blockers"] = json!(blockers);
    a["legacyCashHistoryWarnings"] = a["warnings"].clone();
    a["serviceHistoryWarnings"] = a["warnings"].clone();
    Ok(a)
}
fn history_for_plan(c: &Connection, ctx: &CatalogueContext, run: &str) -> Result<Value, Error> {
    let current = transition::selected(c, run)?;
    let mut data = transition::history_data(c, ctx)?.unwrap_or_default();
    let report = transition::report(c, ctx, run)?;
    for (table, rows) in current {
        let old = data.entry(table).or_default();
        for row in rows {
            if !old.iter().any(|r| r["id"] == row["id"]) {
                old.push(row)
            }
        }
        old.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
    }
    for rows in data.values_mut() {
        rows.retain(|r| r["negocio_id"] == ctx.tenant_id);
    }
    let mut tickets = vec![];
    for sale in data.get("ventas").into_iter().flatten() {
        if let Some(id) = sale["id"].as_str() {
            if let Ok(mut ticket) =
                transition::ticket(c, ctx, id).or_else(|_| transition::run_ticket(c, ctx, run, id))
            {
                if ticket["coverage"] == "HASH_MATCHED_LOCAL_CHECKOUT" {
                    ticket["coverage"] = json!("PRESERVED_ORIGIN_CHECKOUT");
                }
                tickets.push(ticket);
            }
        }
    }
    // Carry only an independently verified scope attribution; unknown scope
    // remains unknown in history and cannot become financial authority.
    for (table, rows) in &mut data {
        for row in rows {
            if row.get("sucursal_id").is_none()
                && report["issues"].as_array().is_some_and(|a| {
                    a.iter().any(|i| {
                        i["table"] == *table
                            && i["id"] == row["id"]
                            && matches!(
                                i["code"].as_str(),
                                Some("SCOPE_FROM_LINKED_SALE" | "SCOPE_FROM_SAVED_CHECKOUT")
                            )
                    })
                })
            {
                row["sucursal_id"] = json!(ctx.branch_id);
            }
        }
    }
    Ok(
        json!({"protocol":"ventard.web.resolution.history.1","tables":transition::CLOUD_TABLES.iter().map(|t|json!({"name":t,"rows":data.get(*t).cloned().unwrap_or_default()})).collect::<Vec<_>>(),"tickets":tickets}),
    )
}
fn scope(ctx: &CatalogueContext) -> String {
    ctx.branch_id
        .as_ref()
        .map_or_else(|| "GLOBAL".into(), |b| format!("BRANCH:{b}"))
}
fn history_validate(
    ctx: &CatalogueContext,
    body: &Value,
    receipt: &Value,
    h: &str,
) -> Result<(), Error> {
    if canonical(body)?.1 != h
        || body["protocol"] != "ventard.web.resolution.history.1"
        || receipt["protocol"] != "ventard.web.cutover.receipt.1"
        || receipt["status"] != "BASELINE_ADOPTED"
        || receipt["coverage"] != "RECONCILED_SELECTED_BASELINE"
        || receipt["legacyReplay"] != false
        || receipt["context"]["tenantId"] != ctx.tenant_id
        || receipt["context"]["scopeType"] != ctx.scope_type
        || receipt["context"]["branchId"] != json!(ctx.branch_id)
    {
        return Err(Error("RESOLUTION_HISTORY_INVALID"));
    }
    uuid::Uuid::parse_str(receipt["cutoverId"].as_str().ok_or_else(invalid)?)
        .map_err(|_| invalid())?;
    let tables = body["tables"].as_array().ok_or_else(invalid)?;
    let mut seen = BTreeSet::new();
    let mut size = 0usize;
    let mut sales = BTreeSet::new();
    if tables.len() != transition::CLOUD_TABLES.len()
        || body.to_string().len() > transition::MAX_CAPTURE
    {
        return Err(Error("RESOLUTION_HISTORY_INVALID"));
    }
    for t in tables {
        let name = t["name"].as_str().ok_or_else(invalid)?;
        if !transition::CLOUD_TABLES.contains(&name) || !seen.insert(name) {
            return Err(invalid());
        }
        let rows = t["rows"].as_array().ok_or_else(invalid)?;
        size += rows.len();
        if size > 600_000 {
            return Err(invalid());
        }
        let mut ids = BTreeSet::new();
        for r in rows {
            let id = r["id"].as_str().ok_or_else(invalid)?;
            if !ids.insert(id)
                || r["negocio_id"] != ctx.tenant_id
                || super::super::legacy_web::secrets(r)
            {
                return Err(Error("RESOLUTION_HISTORY_INVALID"));
            }
            if name == "ventas" {
                sales.insert(id);
            }
        }
    }
    let mut ids = BTreeSet::new();
    for t in body["tickets"].as_array().ok_or_else(invalid)? {
        let id = t["id"].as_str().ok_or_else(invalid)?;
        if !sales.contains(id)
            || !ids.insert(id)
            || t["effectStatus"] != "UNKNOWN_LEGACY"
            || super::super::legacy_web::secrets(t)
        {
            return Err(Error("RESOLUTION_HISTORY_INVALID"));
        }
    }
    Ok(())
}
/// Transport staging only. Required history becomes visible atomically with
/// the operational snapshot; it never creates a sale, balance or grant.
pub fn stage_resolution_history(
    c: &Connection,
    ctx: &CatalogueContext,
    envelope: &Value,
) -> Result<(), Error> {
    if envelope["protocol"] != "ventard.web.resolution.history.envelope.1"
        || envelope["context"] != json!(ctx)
    {
        return Err(Error("RESOLUTION_HISTORY_INVALID"));
    }
    let h = envelope["historyHash"].as_str().ok_or_else(invalid)?;
    let body = &envelope["history"];
    let receipt = &envelope["receipt"];
    history_validate(ctx, body, receipt, h)?;
    let old:Option<(String,String)>=c.query_row("SELECT body,receipt FROM legacy_resolution_history_v1 WHERE tenant_id=?1 AND scope_key=?2 AND history_hash=?3",(&ctx.tenant_id,scope(ctx),h),|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
    let raw = body.to_string();
    let proof = receipt.to_string();
    if old.as_ref().is_some_and(|(b, r)| *b != raw || *r != proof) {
        return Err(Error("RESOLUTION_HISTORY_INVALID"));
    }
    c.execute(
        "INSERT OR IGNORE INTO legacy_resolution_history_v1 VALUES(?1,?2,?3,?4,?5,?6,0)",
        (
            &ctx.tenant_id,
            scope(ctx),
            h,
            raw,
            receipt["cutoverId"].as_str().ok_or_else(invalid)?,
            proof,
        ),
    )?;
    Ok(())
}
pub fn activate_resolution_history(
    c: &Connection,
    ctx: &CatalogueContext,
    manifest: &Value,
) -> Result<(), Error> {
    let meta = &manifest["legacyResolutionHistory"];
    if meta.is_null() {
        return Ok(());
    }
    let h = meta["sha256"].as_str().ok_or_else(invalid)?;
    let raw:Option<(String,String,String)>=c.query_row("SELECT body,receipt,cutover_id FROM legacy_resolution_history_v1 WHERE tenant_id=?1 AND scope_key=?2 AND history_hash=?3",(&ctx.tenant_id,scope(ctx),h),|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
    let (body, receipt, id) = raw.ok_or(Error("RESOLUTION_HISTORY_REQUIRED"))?;
    if meta["cutoverId"] != id {
        return Err(Error("RESOLUTION_HISTORY_INVALID"));
    }
    history_validate(
        ctx,
        &serde_json::from_str(&body).map_err(|_| invalid())?,
        &serde_json::from_str(&receipt).map_err(|_| invalid())?,
        h,
    )?;
    c.execute("UPDATE legacy_resolution_history_v1 SET active=CASE WHEN history_hash=?3 THEN 1 ELSE 0 END WHERE tenant_id=?1 AND scope_key=?2",(&ctx.tenant_id,scope(ctx),h))?;
    Ok(())
}
fn active_history(c: &Connection, ctx: &CatalogueContext) -> Result<Option<Value>, Error> {
    let present: bool = c.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='legacy_resolution_history_v1')",
        [],
        |r| r.get(0),
    )?;
    if !present {
        return Ok(None);
    }
    let row:Option<(String,String,String)>=c.query_row("SELECT body,receipt,history_hash FROM legacy_resolution_history_v1 WHERE tenant_id=?1 AND scope_key=?2 AND active=1",(&ctx.tenant_id,scope(ctx)),|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
    row.map(|(b, r, h)| {
        let body: Value = serde_json::from_str(&b).map_err(|_| invalid())?;
        let receipt = serde_json::from_str(&r).map_err(|_| invalid())?;
        history_validate(ctx, &body, &receipt, &h)?;
        Ok(body)
    })
    .transpose()
}
pub fn resolution_history_data(
    c: &Connection,
    ctx: &CatalogueContext,
) -> Result<Option<Data>, Error> {
    active_history(c, ctx)?
        .map(|h| {
            h["tables"]
                .as_array()
                .ok_or_else(invalid)?
                .iter()
                .map(|t| {
                    Ok((
                        t["name"].as_str().ok_or_else(invalid)?.into(),
                        t["rows"].as_array().ok_or_else(invalid)?.clone(),
                    ))
                })
                .collect()
        })
        .transpose()
}
pub fn resolution_history_ticket(
    c: &Connection,
    ctx: &CatalogueContext,
    id: &str,
) -> Result<Option<Value>, Error> {
    Ok(active_history(c, ctx)?.and_then(|h| {
        h["tickets"]
            .as_array()
            .and_then(|a| a.iter().find(|t| t["id"] == id))
            .cloned()
    }))
}
