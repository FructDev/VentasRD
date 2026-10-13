//! Read sold serial facts from immutable native origin or verified capture.
//! Adjust/certificate documents never mutate sale amounts, stock or dates.
use super::{
    errors::{AppError, BusinessError, ProtocolError},
    management::Command,
    sales, sales_sync,
};
use crate::{
    domain::{canonical::canonicalize, identity::EntityId, money::MoneyCents},
    storage::catalogue_preview::{self, CatalogueContext},
};
use rusqlite::{Connection, OptionalExtension, Transaction};
use serde_json::{json, Value};
fn invalid() -> AppError {
    AppError::Protocol(ProtocolError::MalformedPayload)
}
fn guard(code: &str) -> AppError {
    AppError::Business(BusinessError::SaleGuard { code: code.into() })
}
fn s(v: &Value) -> Result<&str, AppError> {
    v.as_str().ok_or_else(invalid)
}
fn number(v: &str, max: i64) -> Result<i64, AppError> {
    let n = MoneyCents::parse_dto(v).map_err(|_| invalid())?.cents();
    if n < 0 || n > max {
        return Err(invalid());
    }
    Ok(n)
}
fn hash(v: &Value) -> Result<String, AppError> {
    canonicalize(&serde_json::to_vec(v).map_err(|_| invalid())?)
        .map(|v| v.1)
        .map_err(|_| invalid())
}
fn serial_text(v: &str) -> Result<(), AppError> {
    if v.trim() != v || v.is_empty() || v.chars().count() > 256 || v.chars().any(char::is_control) {
        return Err(invalid());
    }
    Ok(())
}
pub fn supports(k: &str) -> bool {
    k == "WARRANTY_PATCH"
}
fn capture(
    c: &Connection,
    ctx: &CatalogueContext,
    pid: &str,
    serial: &str,
) -> Result<Option<Value>, AppError> {
    let key = catalogue_preview::key(ctx).map_err(|_| invalid())?;
    let row:Option<String>=c.query_row("SELECT json_extract(x.value,'$.warranty') FROM native_sales_pages_v1 p,json_each(p.payload) x JOIN native_sales_bootstrap_v1 b ON b.context_key=p.context_key WHERE p.context_key=?1 AND b.state='ACTIVE' AND json_extract(x.value,'$.kind')='SERIAL' AND json_extract(x.value,'$.productId')=?2 AND json_extract(x.value,'$.text')=?3",(&key,pid,serial),|r|r.get(0)).optional()?.flatten();
    row.map(|v| serde_json::from_str(&v).map_err(|_| invalid()))
        .transpose()
}
fn base(
    c: &Connection,
    ctx: &CatalogueContext,
    pid: &str,
    serial: &str,
) -> Result<Value, AppError> {
    EntityId::parse(pid).map_err(|_| invalid())?;
    serial_text(serial)?;
    let sk = sales::scope_key(ctx)?;
    let (state,owner,name):(String,Option<String>,String)=c.query_row("SELECT s.state,s.sale_operation_id,p.name FROM sale_serial_inventory_v1 s JOIN products p ON p.producto_id=s.producto_id AND p.tenant_id=s.tenant_id WHERE s.tenant_id=?1 AND s.scope_key=?2 AND s.producto_id=?3 AND s.serial=?4",(&ctx.tenant_id,&sk,pid,serial),|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?.ok_or_else(||guard("SERIAL_UNAVAILABLE"))?;
    let mut a = json!({"productId":pid,"serial":serial,"name":name,"state":state,"sourceOperationId":null,"soldAtMs":null,"customerName":null,"priceCents":null,"days":null,"untilMs":null});
    if state == "SOLD" {
        let native: Option<Vec<u8>> = if let Some(op) = &owner {
            c.query_row("SELECT canonical_bytes FROM operation_journal WHERE operation_id=?1 AND local_state='COMMITTED'",[op],|r|r.get(0)).optional()?
        } else {
            None
        };
        if let Some(raw) = native {
            let v: Value = serde_json::from_slice(&raw).map_err(|_| invalid())?;
            a["sourceOperationId"] = v["operationId"].clone();
            a["soldAtMs"] = v["originAtUtcMs"].clone();
            if v["kind"] == "LAYAWAY_COMPLETE" {
                let ap = &v["payload"]["document"]["layaway"];
                let item = ap["definition"]["items"]
                    .as_array()
                    .ok_or_else(invalid)?
                    .iter()
                    .find(|i| i["productId"] == pid && i["serial"] == serial)
                    .ok_or_else(invalid)?;
                a["name"] = item["name"].clone();
                a["priceCents"] = item["priceCents"].clone();
                a["customerName"] = ap["definition"]["customerName"].clone();
                a["days"] = ap["warrantyDays"].clone();
                a["untilMs"] = ap["warrantyUntilMs"].clone();
            } else if v["kind"] == "SALE_CONFIRM" {
                let sale = &v["payload"]["sale"];
                let line = sale["lines"]
                    .as_array()
                    .ok_or_else(invalid)?
                    .iter()
                    .find(|i| i["productId"] == pid && i["serial"] == serial)
                    .ok_or_else(invalid)?;
                a["name"] = line["name"].clone();
                a["priceCents"] = line["unitPriceCents"].clone();
                a["customerName"] = sale["customer"]["name"].clone();
                let sr = sale["serials"]
                    .as_array()
                    .ok_or_else(invalid)?
                    .iter()
                    .find(|i| i["productId"] == pid && i["text"] == serial)
                    .ok_or_else(invalid)?;
                a["days"] = sr["warrantyDays"].clone();
                if let Some(days) = sr["warrantyDays"].as_str() {
                    let n = number(days, 3650)?;
                    if n > 0 {
                        a["untilMs"] = json!((number(s(&a["soldAtMs"])?, 9_007_199_254_740_991)?
                            + n * 86400000)
                            .to_string());
                    }
                }
            } else {
                return Err(invalid());
            }
        } else if let Some(captured) = capture(c, ctx, pid, serial)? {
            for key in [
                "sourceOperationId",
                "name",
                "soldAtMs",
                "customerName",
                "priceCents",
                "days",
                "untilMs",
            ] {
                a[key] = captured[key].clone();
            }
        }
    }
    validate(&a)?;
    let source = json!({"productId":pid,"serial":serial,"sourceOperationId":a["sourceOperationId"],"soldAtMs":a["soldAtMs"],"priceCents":a["priceCents"],"customerName":a["customerName"]});
    a["sourceHash"] = json!(hash(&source)?);
    Ok(a)
}
fn validate(a: &Value) -> Result<(), AppError> {
    for field in ["soldAtMs", "priceCents", "untilMs"] {
        if let Some(v) = a[field].as_str() {
            number(v, 9_007_199_254_740_991)?;
        } else if !a[field].is_null() {
            return Err(invalid());
        }
    }
    if let Some(days) = a["days"].as_str() {
        let days = number(days, 3650)?;
        if a["soldAtMs"].is_null()
            || a["untilMs"]
                != if days == 0 {
                    Value::Null
                } else {
                    json!(
                        (number(s(&a["soldAtMs"])?, 9_007_199_254_740_991)? + days * 86400000)
                            .to_string()
                    )
                }
        {
            return Err(invalid());
        }
    } else if !a["days"].is_null() || !a["untilMs"].is_null() {
        return Err(invalid());
    }
    if let Some(op) = a["sourceOperationId"].as_str() {
        EntityId::parse(op).map_err(|_| invalid())?;
    }
    if let Some(name) = a["customerName"].as_str() {
        if name.chars().count() > 256 || name.chars().any(char::is_control) {
            return Err(invalid());
        }
    }
    Ok(())
}
fn current(
    c: &Connection,
    ctx: &CatalogueContext,
    pid: &str,
    serial: &str,
) -> Result<Value, AppError> {
    let mut a = base(c, ctx, pid, serial)?;
    let row:Option<(String,String,String)>=c.query_row("SELECT r.document,r.operation_id,coalesce(o.state,'APPLIED') FROM native_management_records_v1 r LEFT JOIN outbox o ON o.operation_id=r.operation_id WHERE r.tenant_id=?1 AND r.scope_key=?2 AND r.kind='WARRANTY_PATCH' AND json_extract(r.document,'$.warranty.productId')=?3 AND json_extract(r.document,'$.warranty.serial')=?4 AND json_extract(r.document,'$.warranty.sourceHash')=?5 ORDER BY cast(json_extract(r.document,'$.warranty.version') AS INTEGER) DESC LIMIT 1",(&ctx.tenant_id,sales::scope_key(ctx)?,pid,serial,s(&a["sourceHash"])?),|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
    a["version"] = json!("0");
    if let Some((raw, op, status)) = row {
        let d: Value = serde_json::from_str(&raw).map_err(|_| invalid())?;
        if a["state"] == "SOLD" {
            a = d["warranty"].clone();
        }
        a["operationId"] = json!(op);
        a["remoteStatus"] = json!(status);
    }
    let mut stable = a.clone();
    stable
        .as_object_mut()
        .ok_or_else(invalid)?
        .remove("operationId");
    stable
        .as_object_mut()
        .ok_or_else(invalid)?
        .remove("remoteStatus");
    a["revision"] = json!(hash(&stable)?);
    Ok(a)
}
pub fn defaults(c: &Connection, ctx: &CatalogueContext) -> Result<Value, AppError> {
    let raw:Option<String>=c.query_row("SELECT document FROM native_management_records_v1 WHERE tenant_id=?1 AND scope_key=?2 AND kind='CONFIG_PATCH' AND json_type(document,'$.warrantyDefault')='object' ORDER BY cast(json_extract(document,'$.warrantyDefault.revision') AS INTEGER) DESC LIMIT 1",(&ctx.tenant_id,sales::scope_key(ctx)?),|r|r.get(0)).optional()?;
    Ok(raw
        .map(|s| {
            serde_json::from_str::<Value>(&s)
                .map(|v| v["warrantyDefault"].clone())
                .map_err(|_| invalid())
        })
        .transpose()?
        .unwrap_or(json!({"days":"30","revision":"0"})))
}
pub fn read(c: &Connection, ctx: &CatalogueContext) -> Result<Value, AppError> {
    if !sales_sync::operational(c, ctx)? {
        return Err(guard("LEGACY_NOT_VERIFIABLE"));
    }
    let mut q=c.prepare("SELECT producto_id,serial FROM sale_serial_inventory_v1 WHERE tenant_id=?1 AND scope_key=?2 LIMIT 10001")?;
    let ids = q
        .query_map((&ctx.tenant_id, sales::scope_key(ctx)?), |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    if ids.len() > 10000 {
        return Err(guard("EXPORT_TOO_LARGE"));
    }
    let mut rows = vec![];
    for (pid, serial) in ids {
        rows.push(current(c, ctx, &pid, &serial)?)
    }
    Ok(json!({"rows":rows,"coverage":"LOCAL_NATIVE_ONLY","default":defaults(c,ctx)?}))
}
pub fn document(
    c: &Connection,
    ctx: &CatalogueContext,
    req: &Command,
    at: &str,
    source: Option<&Value>,
) -> Result<(String, Value), AppError> {
    match req {
        Command::WarrantyDefault {
            operation_id,
            expected_revision,
            days,
        } => {
            let old = defaults(c, ctx)?;
            if old["revision"] != *expected_revision {
                return Err(guard("VERSION_CONFLICT"));
            }
            let days = number(days, 3650)?;
            let rev = number(expected_revision, 2147483646)? + 1;
            Ok((
                "CONFIG_PATCH".into(),
                json!({"operationId":operation_id,"warrantyDefault":{"days":days.to_string(),"revision":rev.to_string()},"amountCents":"0","method":null,"concept":"Garantía por defecto"}),
            ))
        }
        Command::WarrantySave {
            operation_id,
            product_id,
            serial,
            expected_revision,
            action,
            days,
        } => {
            let mut a = current(c, ctx, product_id, serial)?;
            if a["revision"] != *expected_revision {
                return Err(guard("VERSION_CONFLICT"));
            }
            if a["state"] != "SOLD" || a["soldAtMs"].is_null() {
                return Err(guard("WARRANTY_ORIGIN_UNKNOWN"));
            }
            if matches!(
                a["remoteStatus"].as_str(),
                Some("INTERVENTION" | "CONFLICT" | "DENIED")
            ) {
                return Err(guard("SERVICE_SYNC_CONFLICT"));
            }
            let sold = number(s(&a["soldAtMs"])?, 9_007_199_254_740_991)?;
            if number(at, 9_007_199_254_740_991)? < sold {
                return Err(invalid());
            }
            if action == "ADJUST" {
                let days = number(days, 3650)?;
                a["days"] = json!(days.to_string());
                a["untilMs"] = if days == 0 {
                    Value::Null
                } else {
                    json!((sold + days * 86400000).to_string())
                };
            } else if action != "CERTIFY" || !days.is_empty() || a["days"].is_null() {
                return Err(guard("WARRANTY_ORIGIN_UNKNOWN"));
            }
            let version = number(s(&a["version"])?, 2147483646)? + 1;
            for key in ["revision", "operationId", "remoteStatus"] {
                a.as_object_mut().ok_or_else(invalid)?.remove(key);
            }
            a["version"] = json!(version.to_string());
            validate(&a)?;
            let business = if let Some(source) = source {
                source["business"].clone()
            } else {
                super::settings::public_profile(c, ctx)?
            };
            Ok((
                "WARRANTY_PATCH".into(),
                json!({"operationId":operation_id,"warranty":a,"business":business,"amountCents":"0","method":null,"concept":format!("Garantía {serial}")}),
            ))
        }
        _ => Err(invalid()),
    }
}
pub fn apply(
    tx: &Transaction<'_>,
    ctx: &CatalogueContext,
    v: &Value,
    remote: bool,
) -> Result<(), AppError> {
    let req: Command =
        serde_json::from_value(v["payload"]["request"].clone()).map_err(|_| invalid())?;
    let (kind, d) = document(
        tx,
        ctx,
        &req,
        s(&v["originAtUtcMs"])?,
        remote.then_some(&v["payload"]["document"]),
    )?;
    if v["kind"] != kind || v["payload"]["document"] != d {
        return Err(guard("VERSION_CONFLICT"));
    }
    Ok(())
}
/// Current metadata capture imports its exact source/receipt, never financial effects.
pub fn import_capture(
    tx: &Transaction<'_>,
    ctx: &CatalogueContext,
    event: &Value,
    watermark: i64,
) -> Result<(), AppError> {
    let raw = s(&event["intent"])?;
    let (canonical, h) = canonicalize(raw.as_bytes()).map_err(|_| invalid())?;
    if canonical != raw {
        return Err(invalid());
    }
    let v: Value = serde_json::from_str(raw).map_err(|_| invalid())?;
    if !matches!(v["kind"].as_str(), Some("WARRANTY_PATCH" | "CONFIG_PATCH"))
        || !event["snapshot"].is_null()
    {
        return Err(invalid());
    }
    sales_sync::validate_event(ctx, &v, None, &event["receipt"])?;
    let seq = number(
        s(&event["receipt"]["remoteSequence"])?,
        9_007_199_254_740_991,
    )?;
    if seq == 0 || seq > watermark || !v["originalTurnId"].is_null() {
        return Err(invalid());
    }
    let d = &v["payload"]["document"];
    let req: Command =
        serde_json::from_value(v["payload"]["request"].clone()).map_err(|_| invalid())?;
    let op = s(&v["operationId"])?;
    if d["operationId"] != op || d["amountCents"] != "0" || !d["method"].is_null() {
        return Err(invalid());
    }
    match req {
        Command::WarrantySave {
            operation_id,
            product_id,
            serial,
            action,
            days,
            ..
        } => {
            let a = &d["warranty"];
            validate(a)?;
            serial_text(&serial)?;
            EntityId::parse(&product_id).map_err(|_| invalid())?;
            if operation_id != op
                || v["kind"] != "WARRANTY_PATCH"
                || a["productId"] != product_id
                || a["serial"] != serial
                || a["state"] != "SOLD"
                || a["days"].is_null()
                || number(s(&a["version"])?, 2147483647)? == 0
                || number(s(&a["soldAtMs"])?, 9_007_199_254_740_991)?
                    > number(s(&v["originAtUtcMs"])?, 9_007_199_254_740_991)?
                || d["concept"] != format!("Garantía {serial}")
            {
                return Err(invalid());
            }
            if (action == "ADJUST" && a["days"] != days)
                || (action == "CERTIFY" && !days.is_empty())
                || !matches!(action.as_str(), "ADJUST" | "CERTIFY")
            {
                return Err(invalid());
            }
            let source = json!({"productId":a["productId"],"serial":a["serial"],"sourceOperationId":a["sourceOperationId"],"soldAtMs":a["soldAtMs"],"priceCents":a["priceCents"],"customerName":a["customerName"]});
            if a["sourceHash"] != hash(&source)? {
                return Err(invalid());
            }
        }
        Command::WarrantyDefault {
            operation_id,
            expected_revision,
            days,
        } => {
            if operation_id != op
                || v["kind"] != "CONFIG_PATCH"
                || d["warrantyDefault"]["days"] != days
                || number(&days, 3650).is_err()
                || number(s(&d["warrantyDefault"]["revision"])?, 2147483647)?
                    != number(&expected_revision, 2147483646)? + 1
                || d["concept"] != "Garantía por defecto"
            {
                return Err(invalid());
            }
        }
        _ => return Err(invalid()),
    }
    let sk = sales::scope_key(ctx)?;
    let origin = sk.split_once('/').ok_or_else(invalid)?.1;
    tx.execute("INSERT INTO operation_journal VALUES(?1,'ventard.native.v1',?2,1,?3,?4,?5,?6,?7,?8,?9,COALESCE((SELECT MAX(local_seq) FROM operation_journal),0)+1,'COMMITTED',?10)",(op,s(&v["kind"])?,raw.as_bytes(),h,s(&v["actorId"])?,origin,s(&v["originDeviceId"])?,number(s(&v["writerEpoch"])?,9_007_199_254_740_991)?,s(&v["originAtUtcMs"])?,json!({"remoteStatus":"APPLIED","source":"CURRENT_CAPTURE"}).to_string()))?;
    tx.execute(
        "INSERT INTO native_management_records_v1 VALUES(?1,?2,?3,?4,NULL,NULL,NULL,0,?5,?6,?7)",
        (
            op,
            &ctx.tenant_id,
            &sk,
            s(&v["kind"])?,
            s(&d["concept"])?,
            s(&v["originAtUtcMs"])?,
            d.to_string(),
        ),
    )?;
    tx.execute(
        "INSERT INTO native_sales_receipts_v1 VALUES(?1,?2,?3,?4,?5)",
        (op, &ctx.tenant_id, &sk, seq, event["receipt"].to_string()),
    )?;
    Ok(())
}
