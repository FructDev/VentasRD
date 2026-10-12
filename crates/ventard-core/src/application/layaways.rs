//! Apartados: immutable items, stock/serial reservations and append-only money.
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
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Item {
    pub product_id: String,
    pub name: String,
    pub quantity: String,
    pub price_cents: String,
    pub serial: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Definition {
    pub customer_id: Option<String>,
    pub customer_name: String,
    pub phone: String,
    pub notes: String,
    pub items: Vec<Item>,
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
fn n(v: &str) -> Result<i64, AppError> {
    let n = MoneyCents::parse_dto(v).map_err(|_| invalid())?.cents();
    if n < 0 {
        return Err(invalid());
    }
    Ok(n)
}
fn uint(v: &str) -> Result<i32, AppError> {
    let n = v.parse::<i32>().map_err(|_| invalid())?;
    if n < 0 || n.to_string() != v {
        return Err(invalid());
    }
    Ok(n)
}
fn text(v: &str, max: usize, required: bool) -> Result<(), AppError> {
    if v.trim() != v
        || v.chars().count() > max
        || v.chars().any(|c| c.is_control() && c != '\n')
        || required && v.is_empty()
    {
        return Err(invalid());
    }
    Ok(())
}
pub fn supports(k: &str) -> bool {
    matches!(
        k,
        "LAYAWAY_CREATE" | "LAYAWAY_PAYMENT" | "LAYAWAY_COMPLETE" | "LAYAWAY_CANCEL"
    )
}
fn current(c: &Connection, ctx: &CatalogueContext, id: &str) -> Result<Option<Value>, AppError> {
    EntityId::parse(id).map_err(|_| invalid())?;
    let row:Option<(String,String)>=c.query_row("SELECT r.document,coalesce(o.state,'APPLIED') FROM native_management_records_v1 r LEFT JOIN outbox o ON o.operation_id=r.operation_id WHERE r.tenant_id=?1 AND r.scope_key=?2 AND r.kind LIKE 'LAYAWAY_%' AND json_extract(r.document,'$.layaway.id')=?3 ORDER BY cast(json_extract(r.document,'$.layaway.revision') AS INTEGER) DESC LIMIT 1",(&ctx.tenant_id,sales::scope_key(ctx)?,id),|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
    row.map(|(raw, state)| {
        let mut d: Value = serde_json::from_str(&raw).map_err(|_| invalid())?;
        d["remoteStatus"] = json!(state);
        Ok(d)
    })
    .transpose()
}
pub fn read(c: &Connection, ctx: &CatalogueContext) -> Result<Value, AppError> {
    if !sales_sync::operational(c, ctx)? {
        return Err(guard("LEGACY_NOT_VERIFIABLE"));
    }
    let mut q=c.prepare("SELECT DISTINCT json_extract(document,'$.layaway.id') FROM native_management_records_v1 WHERE tenant_id=?1 AND scope_key=?2 AND kind LIKE 'LAYAWAY_%' LIMIT 10001")?;
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
        let mut a = d["layaway"].clone();
        a["operationId"] = d["operationId"].clone();
        a["remoteStatus"] = d["remoteStatus"].clone();
        rows.push(a)
    }
    rows.sort_by_key(|r| {
        std::cmp::Reverse(
            r["createdAtMs"]
                .as_str()
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(0),
        )
    });
    Ok(json!({"rows":rows,"coverage":"LOCAL_NATIVE_ONLY"}))
}
fn folio(c: &Connection, ctx: &CatalogueContext, op: &str) -> Result<(String, String), AppError> {
    let old:Option<(String,String)>=c.query_row("SELECT json_extract(CAST(canonical_bytes AS TEXT),'$.payload.document.layaway.folio'),json_extract(CAST(canonical_bytes AS TEXT),'$.payload.document.layaway.folioNumber') FROM operation_journal WHERE operation_id=?1 AND kind='LAYAWAY_CREATE'",[op],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
    if let Some(old) = old {
        return Ok(old);
    }
    let prefix:String=c.query_row("SELECT prefix FROM ticket_sequences WHERE tenant_id=?1 AND installation_id=?2 AND device_id=?3 AND writer_epoch=?4",(&ctx.tenant_id,&ctx.installation_id,&ctx.device_id,&ctx.writer_epoch),|r|r.get(0)).optional()?.ok_or_else(||guard("TICKET_SOURCE_UNKNOWN"))?;
    let last:i64=c.query_row("SELECT coalesce(max(cast(json_extract(CAST(canonical_bytes AS TEXT),'$.payload.document.layaway.folioNumber') AS INTEGER)),0) FROM operation_journal WHERE kind LIKE 'LAYAWAY_%' AND json_extract(CAST(canonical_bytes AS TEXT),'$.negocioId')=?1 AND substr(json_extract(CAST(canonical_bytes AS TEXT),'$.payload.document.layaway.folio'),1,length(?2)+1)=?2||'-'",(&ctx.tenant_id,format!("AP-{prefix}")),|r|r.get(0))?;
    let next = last
        .checked_add(1)
        .filter(|n| *n <= 9_007_199_254_740_991)
        .ok_or_else(invalid)?;
    Ok((format!("AP-{prefix}-{next:03}"), next.to_string()))
}
fn validate_definition(
    c: &Connection,
    ctx: &CatalogueContext,
    d: &Definition,
    new_customer: bool,
    metadata: bool,
) -> Result<i64, AppError> {
    text(&d.customer_name, 256, true)?;
    text(&d.phone, 64, false)?;
    text(&d.notes, 4000, false)?;
    if d.items.is_empty() || d.items.len() > 100 {
        return Err(invalid());
    }
    if let Some(id) = &d.customer_id {
        EntityId::parse(id).map_err(|_| invalid())?;
        if !new_customer && metadata {
            let cu = management::customer(c, ctx, id)?;
            if cu["active"] != true {
                return Err(guard("CUSTOMER_INVALID"));
            }
        }
    } else if new_customer {
        return Err(invalid());
    }
    let mut keys = HashSet::new();
    let mut total = 0i128;
    for it in &d.items {
        EntityId::parse(&it.product_id).map_err(|_| invalid())?;
        text(&it.name, 256, true)?;
        let qty = uint(&it.quantity)?;
        if qty == 0 || !keys.insert((&it.product_id, &it.serial)) {
            return Err(invalid());
        }
        total += qty as i128 * n(&it.price_cents)? as i128;
        if let Some(serial) = &it.serial {
            text(serial, 256, true)?;
            if qty != 1 {
                return Err(guard("SERIAL_REQUIRED"));
            }
        }
        if metadata {
            let p = inventory::product(c, ctx, &it.product_id)?;
            if p["deleted"] == true
                || p["metadata"]["productType"] == "combo"
                || p["metadata"]["serialRequired"].as_bool() != Some(it.serial.is_some())
            {
                return Err(guard("SERVICE_PART_UNSUPPORTED"));
            }
        }
    }
    MoneyCents::from_i128(total)
        .map(|v| v.cents())
        .map_err(|_| invalid())
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
        Command::LayawayCreate {
            operation_id,
            layaway_id,
            ..
        } => (operation_id, layaway_id, "0"),
        Command::LayawayAction {
            operation_id,
            layaway_id,
            expected_revision,
            ..
        } => (operation_id, layaway_id, expected_revision.as_str()),
        _ => return Err(invalid()),
    };
    EntityId::parse(op).map_err(|_| invalid())?;
    let rev = uint(rev)?;
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
    if old
        .as_ref()
        .and_then(|d| d["layaway"]["revision"].as_str())
        .and_then(|v| uint(v).ok())
        != if rev == 0 { None } else { Some(rev) }
    {
        return Err(guard("VERSION_CONFLICT"));
    }
    let mut customer = Value::Null;
    let mut a = if let Some(d) = &old {
        let a = d["layaway"].clone();
        if a["state"] != "activo"
            || a["updatedAtMs"]
                .as_str()
                .and_then(|v| v.parse::<u64>().ok())
                .is_none_or(|t| t > now)
        {
            return Err(guard("SERVICE_STATE_INVALID"));
        }
        a
    } else {
        if rev != 0 {
            return Err(guard("VERSION_CONFLICT"));
        }
        json!({"id":id,"revision":"0","state":"activo","definition":null,"totalCents":"0","paidCents":"0","payments":[],"createdAtMs":at,"updatedAtMs":at,"completedAtMs":null,"cancelledAtMs":null,"warrantyDays":"0","warrantyUntilMs":null})
    };
    let (amount, method, turn, kind) = match req {
        Command::LayawayCreate {
            definition,
            initial_payment_cents,
            method,
            turn_id,
            create_customer,
            ..
        } => {
            if old.is_some() {
                return Err(guard("VERSION_CONFLICT"));
            }
            let create = create_customer == &Some(true);
            let total = validate_definition(c, ctx, definition, create, source.is_none())?;
            if create {
                let cid = definition.customer_id.as_ref().ok_or_else(invalid)?;
                let exists: bool = c.query_row(
                    "SELECT EXISTS(SELECT 1 FROM sale_customer_accounts_v1 WHERE customer_id=?1)",
                    [cid],
                    |r| r.get(0),
                )?;
                if exists {
                    return Err(guard("VERSION_CONFLICT"));
                }
                customer = json!({"id":cid,"name":definition.customer_name,"phone":if definition.phone.is_empty(){Value::Null}else{json!(definition.phone)},"limitCents":"0","balanceCents":"0","priceTier":1,"wholesale":false,"revision":"1","balanceRevision":"1","active":true,"authority":"VERIFIED"});
            }
            let (f, number) = if let Some(source) = source {
                (
                    s(&source["layaway"]["folio"])?.to_owned(),
                    s(&source["layaway"]["folioNumber"])?.to_owned(),
                )
            } else {
                folio(c, ctx, op)?
            };
            a["folio"] = json!(f);
            a["folioNumber"] = json!(number);
            a["definition"] = serde_json::to_value(definition).map_err(|_| invalid())?;
            a["totalCents"] = json!(total.to_string());
            (n(initial_payment_cents)?, method, turn_id, "LAYAWAY_CREATE")
        }
        Command::LayawayAction {
            action,
            amount_cents,
            method,
            turn_id,
            warranty_days,
            ..
        } => {
            let days = uint(warranty_days)?;
            if days > 3650 {
                return Err(invalid());
            }
            match action.as_str() {
                "PAYMENT" => {
                    if days != 0 || n(amount_cents)? == 0 {
                        return Err(invalid());
                    }
                    (n(amount_cents)?, method, turn_id, "LAYAWAY_PAYMENT")
                }
                "COMPLETE" => {
                    if n(amount_cents)? != 0 {
                        return Err(invalid());
                    }
                    a["state"] = json!("completado");
                    a["completedAtMs"] = json!(at);
                    a["warrantyDays"] = json!(days.to_string());
                    a["warrantyUntilMs"] = if days > 0 {
                        json!(now
                            .checked_add(days as u64 * 86_400_000)
                            .ok_or_else(invalid)?
                            .to_string())
                    } else {
                        Value::Null
                    };
                    (
                        n(s(&a["totalCents"])?)? - n(s(&a["paidCents"])?)?,
                        method,
                        turn_id,
                        "LAYAWAY_COMPLETE",
                    )
                }
                "CANCEL" => {
                    if n(amount_cents)? != 0 || days != 0 {
                        return Err(invalid());
                    }
                    a["state"] = json!("cancelado");
                    a["cancelledAtMs"] = json!(at);
                    a["settlementPendingCents"] = a["paidCents"].clone();
                    (0, method, turn_id, "LAYAWAY_CANCEL")
                }
                _ => return Err(invalid()),
            }
        }
        _ => return Err(invalid()),
    };
    if !matches!(method.as_str(), "EFECTIVO" | "TARJETA" | "TRANSFERENCIA") {
        return Err(invalid());
    }
    let paid = MoneyCents::from_i128(n(s(&a["paidCents"])?)? as i128 + amount as i128)
        .map_err(|_| invalid())?
        .cents();
    if amount < 0 || paid > n(s(&a["totalCents"])?)? {
        return Err(guard("SERVICE_OVERPAY"));
    }
    let mut payment = Value::Null;
    if amount > 0 {
        if let Some(turn) = turn {
            EntityId::parse(turn).map_err(|_| invalid())?;
            if source.is_none() {
                let d = management::active_turn(c, ctx, turn)?;
                if d["openedAtMs"]
                    .as_str()
                    .and_then(|v| v.parse::<u64>().ok())
                    .is_none_or(|t| t > now)
                {
                    return Err(guard("TURN_CHANGED"));
                }
            }
        } else if method == "EFECTIVO" {
            return Err(guard("TURN_REQUIRED"));
        }
        payment = json!({"operationId":op,"amountCents":amount.to_string(),"method":method,"turnId":turn,"dateMs":at});
        a["payments"]
            .as_array_mut()
            .ok_or_else(invalid)?
            .push(payment.clone());
        a["paidCents"] = json!(paid.to_string())
    }
    a["revision"] = json!(rev.checked_add(1).ok_or_else(invalid)?.to_string());
    a["updatedAtMs"] = json!(at);
    let def: Definition = serde_json::from_value(a["definition"].clone()).map_err(|_| invalid())?;
    let sk = sales::scope_key(ctx)?;
    let mut delta = BTreeMap::<String, i32>::new();
    for it in &def.items {
        let qty = uint(&it.quantity)?;
        let d = if rev == 0 {
            -qty
        } else if kind == "LAYAWAY_CANCEL" {
            qty
        } else {
            0
        };
        let entry = delta.entry(it.product_id.clone()).or_default();
        *entry = entry.checked_add(d).ok_or_else(invalid)?;
    }
    let mut stock = vec![];
    for (pid, delta) in delta {
        if delta == 0 {
            continue;
        }
        if let Some(source) = source {
            let e = source["stock"]
                .as_array()
                .ok_or_else(invalid)?
                .get(stock.len())
                .ok_or_else(invalid)?;
            let delta_text = delta.to_string();
            if e["productId"] != pid || e["delta"] != delta_text {
                return Err(invalid());
            }
            stock.push(e.clone());
            continue;
        }
        let (qty, revision, pending) = sales::stock(c, &pid, &sk)?;
        let after = qty
            .checked_add(delta)
            .filter(|n| *n >= 0)
            .ok_or_else(|| guard("STOCK_INSUFFICIENT"))?;
        let(base,seq):(String,i64)=c.query_row("SELECT remote_base_qty,remote_seq FROM stock_projections WHERE producto_id=?1 AND scope_key=?2",(&pid,&sk),|r|Ok((r.get(0)?,r.get(1)?)))?;
        stock.push(json!({"productId":pid,"delta":delta.to_string(),"before":qty.to_string(),"after":after.to_string(),"expectedRevision":revision,"stockEvidence":{"productId":pid,"remoteBaseQty":base,"remoteSequence":seq.to_string(),"pending":serde_json::from_str::<Value>(&pending).map_err(|_|invalid())?,"effectiveQty":qty.to_string()}}))
    }
    let mut serials = vec![];
    for it in &def.items {
        let Some(serial) = &it.serial else { continue };
        let(before,revision,owner):(String,String,Option<String>)=c.query_row("SELECT state,revision,sale_operation_id FROM sale_serial_inventory_v1 WHERE tenant_id=?1 AND scope_key=?2 AND producto_id=?3 AND serial=?4",(&ctx.tenant_id,&sk,&it.product_id,serial),|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?.ok_or_else(||guard("SERIAL_UNAVAILABLE"))?;
        let wanted = if rev == 0 { "AVAILABLE" } else { "RESERVED" };
        if before != wanted {
            return Err(guard("SERIAL_UNAVAILABLE"));
        }
        if rev > 0 {
            let owner = owner.ok_or_else(|| guard("SERIAL_UNAVAILABLE"))?;
            let bound:Option<String>=c.query_row("SELECT json_extract(CAST(canonical_bytes AS TEXT),'$.payload.document.layaway.id') FROM operation_journal WHERE operation_id=?1",[owner],|r|r.get(0)).optional()?.flatten();
            if bound.as_deref() != Some(id) {
                return Err(guard("SERIAL_UNAVAILABLE"));
            }
        }
        let after = if kind == "LAYAWAY_COMPLETE" {
            "SOLD"
        } else if kind == "LAYAWAY_CANCEL" {
            "AVAILABLE"
        } else {
            "RESERVED"
        };
        if let Some(source) = source {
            let e = source["serials"]
                .as_array()
                .ok_or_else(invalid)?
                .get(serials.len())
                .ok_or_else(invalid)?;
            if e["productId"] != it.product_id
                || e["text"] != *serial
                || e["before"] != wanted
                || e["after"] != after
            {
                return Err(invalid());
            }
            serials.push(e.clone())
        } else {
            serials.push(json!({"productId":it.product_id,"text":serial,"expectedRevision":revision,"before":before,"after":after}))
        }
    }
    let business = if let Some(d) = &old {
        d["business"].clone()
    } else if let Some(source) = source {
        source["business"].clone()
    } else {
        let b: Option<String> = c
            .query_row(
                "SELECT profile FROM native_business_profile_v1 WHERE tenant_id=?1",
                [&ctx.tenant_id],
                |r| r.get(0),
            )
            .optional()?;
        b.map(|v| serde_json::from_str(&v).map_err(|_| invalid()))
            .transpose()?
            .unwrap_or(Value::Null)
    };
    let mut d = json!({"operationId":op,"layaway":a,"stock":stock,"serials":serials,"payment":payment,"amountCents":amount.to_string(),"method":if amount==0{Value::Null}else{json!(method)},"concept":format!("Apartado {}",s(&a["folio"])?),"business":business});
    if !customer.is_null() {
        d["customer"] = customer
    }
    if amount > 0 && turn.is_some() {
        d["cashDeltaCents"] = json!(if method == "EFECTIVO" {
            amount.to_string()
        } else {
            "0".into()
        })
    }
    Ok((kind.into(), d))
}
pub fn effects(v: &Value) -> Result<Value, AppError> {
    let mut e = super::repairs::effects(v)?
        .as_array()
        .ok_or_else(invalid)?
        .clone();
    for serial in v["payload"]["document"]["serials"]
        .as_array()
        .ok_or_else(invalid)?
    {
        e.push(json!({"id":sales::effect_id(s(&v["operationId"])?,&format!("serial/{}",s(&serial["text"])?)),"kind":"SERIAL","payload":serial}))
    }
    Ok(json!(e))
}
pub fn validate_receipt(v: &Value, r: &Value, snapshot: Option<&str>) -> Result<(), AppError> {
    if r["effects"] != effects(v)? {
        return Err(invalid());
    }
    let mut r = r.clone();
    r["effects"] = super::repairs::effects(v)?;
    super::repairs::validate_receipt(v, &r, snapshot)
}
pub fn apply(
    tx: &Transaction<'_>,
    ctx: &CatalogueContext,
    v: &Value,
    remote: bool,
) -> Result<(), AppError> {
    let d = &v["payload"]["document"];
    let req: Command =
        serde_json::from_value(v["payload"]["request"].clone()).map_err(|_| invalid())?;
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
        let pid = s(&e["productId"])?;
        let eid = sales::effect_id(op, &format!("stock/{pid}"));
        tx.execute(
            "INSERT INTO inventory_movements VALUES(?1,?2,?3,?4,'LAYAWAY',?5,NULL,NULL,NULL)",
            (&eid, op, pid, &sk, s(&e["delta"])?),
        )?;
        if !remote {
            let (_, _, pending) = sales::stock(tx, pid, &sk)?;
            let mut pending: Vec<Value> = serde_json::from_str(&pending).map_err(|_| invalid())?;
            pending.push(json!({"operationId":op,"effectId":eid,"delta":e["delta"]}));
            tx.execute("UPDATE stock_projections SET effective_stock=?3,pending_coverage=?4 WHERE producto_id=?1 AND scope_key=?2",(pid,&sk,s(&e["after"])?,json!(pending).to_string()))?;
        }
    }
    for e in d["serials"].as_array().ok_or_else(invalid)? {
        let changed=tx.execute("UPDATE sale_serial_inventory_v1 SET state=?5,sale_operation_id=?6 WHERE tenant_id=?1 AND scope_key=?2 AND producto_id=?3 AND serial=?4 AND state=?7",(&ctx.tenant_id,&sk,s(&e["productId"])?,s(&e["text"])?,s(&e["after"])?,if e["after"]=="AVAILABLE"{None}else{Some(op)},s(&e["before"])?))?;
        if changed != 1 {
            return Err(guard("SERIAL_UNAVAILABLE"));
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
/// Current captures already contain past cash and stock in their baselines.
/// Import only the current immutable document and original receipt, without replay.
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
    if seq == 0 || seq > watermark {
        return Err(invalid());
    }
    let d = &v["payload"]["document"];
    let a = &d["layaway"];
    let id = s(&a["id"])?;
    if current(tx, ctx, id)?.is_some() {
        return Err(invalid());
    }
    let def: Definition = serde_json::from_value(a["definition"].clone()).map_err(|_| invalid())?;
    let total = validate_definition(tx, ctx, &def, false, false)?;
    if n(s(&a["totalCents"])?)? != total
        || !matches!(
            a["state"].as_str(),
            Some("activo" | "completado" | "cancelado")
        )
    {
        return Err(invalid());
    }
    let req: Command =
        serde_json::from_value(v["payload"]["request"].clone()).map_err(|_| invalid())?;
    let (op, rid, revision, kind) = match &req {
        Command::LayawayCreate {
            operation_id,
            layaway_id,
            definition,
            ..
        } => {
            if serde_json::to_value(definition).map_err(|_| invalid())? != a["definition"] {
                return Err(invalid());
            }
            (operation_id, layaway_id, 0, "LAYAWAY_CREATE")
        }
        Command::LayawayAction {
            operation_id,
            layaway_id,
            expected_revision,
            action,
            ..
        } => (
            operation_id,
            layaway_id,
            uint(expected_revision)?,
            match action.as_str() {
                "PAYMENT" => "LAYAWAY_PAYMENT",
                "COMPLETE" => "LAYAWAY_COMPLETE",
                "CANCEL" => "LAYAWAY_CANCEL",
                _ => return Err(invalid()),
            },
        ),
        _ => return Err(invalid()),
    };
    if id != rid
        || v["operationId"] != *op
        || d["operationId"] != *op
        || v["kind"] != kind
        || uint(s(&a["revision"])?)? != revision.checked_add(1).ok_or_else(invalid)?
    {
        return Err(invalid());
    }
    let created = n(s(&a["createdAtMs"])?)?;
    let updated = n(s(&a["updatedAtMs"])?)?;
    if created > updated || a["updatedAtMs"] != v["originAtUtcMs"] {
        return Err(invalid());
    }
    let mut paid = 0i128;
    let mut seen = HashSet::new();
    let payments = a["payments"].as_array().ok_or_else(invalid)?;
    if payments.len() > 10000 {
        return Err(invalid());
    }
    for p in payments {
        EntityId::parse(s(&p["operationId"])?).map_err(|_| invalid())?;
        let amount = n(s(&p["amountCents"])?)?;
        let date = n(s(&p["dateMs"])?)?;
        if amount == 0
            || date < created
            || date > updated
            || !seen.insert(s(&p["operationId"])?)
            || !matches!(
                p["method"].as_str(),
                Some("EFECTIVO" | "TARJETA" | "TRANSFERENCIA")
            )
        {
            return Err(invalid());
        }
        if let Some(id) = p["turnId"].as_str() {
            EntityId::parse(id).map_err(|_| invalid())?;
        } else if p["method"] == "EFECTIVO" {
            return Err(invalid());
        }
        paid += amount as i128;
    }
    if paid != n(s(&a["paidCents"])?)? as i128 || paid > total as i128 {
        return Err(invalid());
    }
    let amount = n(s(&d["amountCents"])?)?;
    if amount > 0 {
        if payments.last() != Some(&d["payment"])
            || d["payment"]["operationId"] != *op
            || d["payment"]["amountCents"] != d["amountCents"]
            || d["payment"]["method"] != d["method"]
            || d["payment"]["dateMs"] != v["originAtUtcMs"]
            || d["payment"]["turnId"] != v["originalTurnId"]
        {
            return Err(invalid());
        }
    } else if !d["payment"].is_null() || !d["method"].is_null() || !v["originalTurnId"].is_null() {
        return Err(invalid());
    }
    let days = uint(s(&a["warrantyDays"])?)?;
    if days > 3650 {
        return Err(invalid());
    }
    if a["state"] == "completado" {
        if paid != total as i128
            || n(s(&a["completedAtMs"])?)? != updated
            || a["warrantyUntilMs"]
                != if days == 0 {
                    Value::Null
                } else {
                    json!((updated as u64 + days as u64 * 86400000).to_string())
                }
        {
            return Err(invalid());
        }
    } else if !a["completedAtMs"].is_null() || days != 0 || !a["warrantyUntilMs"].is_null() {
        return Err(invalid());
    }
    if a["state"] == "cancelado"
        && (a["settlementPendingCents"] != a["paidCents"] || a["cancelledAtMs"] != a["updatedAtMs"])
    {
        return Err(invalid());
    }
    let number = n(s(&a["folioNumber"])?)?;
    let folio = s(&a["folio"])?;
    let prefix = folio
        .strip_prefix("AP-N")
        .and_then(|v| v.split_once('-'))
        .ok_or_else(invalid)?
        .0;
    if number == 0
        || prefix.len() != 32
        || !prefix.bytes().all(|b| b.is_ascii_hexdigit())
        || !folio.ends_with(&format!("-{number:03}"))
    {
        return Err(invalid());
    }
    let scope = sales::scope_key(ctx)?;
    let origin = scope.split_once('/').ok_or_else(invalid)?.1;
    tx.execute("INSERT INTO operation_journal VALUES(?1,'ventard.native.v1',?2,1,?3,?4,?5,?6,?7,?8,?9,COALESCE((SELECT MAX(local_seq) FROM operation_journal),0)+1,'COMMITTED',?10)",(op,s(&v["kind"])?,raw.as_bytes(),hash,s(&v["actorId"])?,origin,s(&v["originDeviceId"])?,n(s(&v["writerEpoch"])?)?,s(&v["originAtUtcMs"])?,json!({"remoteStatus":"APPLIED","source":"CURRENT_CAPTURE"}).to_string()))?;
    tx.execute(
        "INSERT INTO native_management_records_v1 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
        (
            op,
            &ctx.tenant_id,
            &scope,
            s(&v["kind"])?,
            v["originalTurnId"].as_str(),
            def.customer_id.as_deref(),
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
/// Called after every product/serial/current document in the same capture exists.
pub fn bind_captured_serials(tx: &Transaction<'_>, ctx: &CatalogueContext) -> Result<(), AppError> {
    let sk = sales::scope_key(ctx)?;
    let mut q=tx.prepare("SELECT document FROM native_management_records_v1 WHERE tenant_id=?1 AND scope_key=?2 AND kind LIKE 'LAYAWAY_%'")?;
    let docs = q
        .query_map((&ctx.tenant_id, &sk), |r| r.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    let mut latest = BTreeMap::<String, Value>::new();
    for raw in docs {
        let d: Value = serde_json::from_str(&raw).map_err(|_| invalid())?;
        let id = s(&d["layaway"]["id"])?;
        if latest.get(id).is_none_or(|v| {
            uint(v["layaway"]["revision"].as_str().unwrap_or("")).unwrap_or(0)
                < uint(d["layaway"]["revision"].as_str().unwrap_or("")).unwrap_or(0)
        }) {
            latest.insert(id.into(), d);
        }
    }
    for d in latest.values() {
        let a = &d["layaway"];
        if a["state"] != "activo" {
            continue;
        }
        for item in a["definition"]["items"].as_array().ok_or_else(invalid)? {
            let Some(serial) = item["serial"].as_str() else {
                continue;
            };
            let changed=tx.execute("UPDATE sale_serial_inventory_v1 SET sale_operation_id=?5 WHERE tenant_id=?1 AND scope_key=?2 AND producto_id=?3 AND serial=?4 AND state='RESERVED' AND sale_operation_id IS NULL",(&ctx.tenant_id,&sk,s(&item["productId"])?,serial,s(&d["operationId"])?))?;
            if changed != 1 {
                return Err(guard("SERIAL_UNAVAILABLE"));
            }
        }
    }
    Ok(())
}
