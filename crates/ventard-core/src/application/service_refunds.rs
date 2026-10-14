//! Deposit refunds are independent append-only facts. Original service payments,
//! stock reservations and issued receipts never change when money is returned.
use super::{
    errors::{AppError, BusinessError, ProtocolError},
    management::{self, Command},
    sales, sales_sync,
};
use crate::{
    domain::{canonical::canonicalize, identity::EntityId, money::MoneyCents},
    storage::catalogue_preview::CatalogueContext,
};
use rusqlite::{Connection, Transaction};
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
fn n(v: &str) -> Result<i64, AppError> {
    let n = MoneyCents::parse_dto(v).map_err(|_| invalid())?.cents();
    if n < 0 {
        return Err(invalid());
    }
    Ok(n)
}
fn basis(family: &str, service: &Value) -> Result<i64, AppError> {
    let paid = n(s(&service["paidCents"])?)?;
    if matches!(family, "repair" | "layaway")
        && matches!(
            service["state"].as_str(),
            Some("cancelado" | "no_reparado" | "abandonado")
        )
    {
        if let Some(pending) = service.get("settlementPendingCents") {
            let pending = n(s(pending)?)?;
            if pending > paid {
                return Err(invalid());
            }
            return Ok(pending);
        }
    }
    match (family, service["state"].as_str()) {
        ("repair" | "layaway", Some("cancelado")) => Ok(paid),
        ("repair", Some("no_reparado" | "abandonado")) => Ok(paid
            .checked_sub(n(s(&service["totalCents"])?)?)
            .filter(|n| *n >= 0)
            .unwrap_or(0)),
        ("repair" | "layaway", _) => Ok(0),
        _ => Err(invalid()),
    }
}
pub fn summary(
    c: &Connection,
    ctx: &CatalogueContext,
    family: &str,
    service: &Value,
) -> Result<Value, AppError> {
    let eligible = basis(family, service)?;
    let id = s(&service["id"])?;
    let sk = sales::scope_key(ctx)?;
    let exists:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='native_service_refunds_v1')",[],|r|r.get(0))?;
    if !exists {
        return Ok(
            json!({"revision":"0","eligibleCents":eligible.to_string(),"refundedCents":"0","pendingCents":eligible.to_string(),"rows":[]}),
        );
    }
    let mut q=c.prepare("SELECT document FROM native_service_refunds_v1 WHERE tenant_id=?1 AND scope_key=?2 AND family=?3 AND service_id=?4 ORDER BY revision LIMIT 1001")?;
    let raw = q
        .query_map((&ctx.tenant_id, &sk, family, id), |r| r.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    if raw.len() > 1000 {
        return Err(guard("EXPORT_TOO_LARGE"));
    }
    let mut refunded = MoneyCents::ZERO;
    let mut rows = vec![];
    for raw in raw {
        let doc: Value = serde_json::from_str(&raw).map_err(|_| invalid())?;
        refunded = refunded
            .checked_add(MoneyCents::parse_dto(s(&doc["amountCents"])?).map_err(|_| invalid())?)
            .map_err(|_| invalid())?;
        rows.push(doc["refund"].clone());
    }
    let pending = eligible
        .checked_sub(refunded.cents())
        .filter(|n| *n >= 0)
        .ok_or_else(|| guard("SERVICE_REFUND_DIVERGED"))?;
    Ok(
        json!({"revision":rows.len().to_string(),"eligibleCents":eligible.to_string(),"refundedCents":refunded.to_dto(),"pendingCents":pending.to_string(),"rows":rows}),
    )
}
pub fn document(
    c: &Connection,
    ctx: &CatalogueContext,
    req: &Command,
    at: &str,
    remote: bool,
) -> Result<Value, AppError> {
    let Command::ServiceRefund {
        operation_id,
        family,
        service_id,
        expected_service_revision,
        expected_refund_revision,
        amount_cents,
        method,
        turn_id,
        reason,
    } = req
    else {
        return Err(invalid());
    };
    EntityId::parse(service_id).map_err(|_| invalid())?;
    EntityId::parse(operation_id).map_err(|_| invalid())?;
    n(at)?;
    if !matches!(method.as_str(), "EFECTIVO" | "TARJETA" | "TRANSFERENCIA")
        || reason.trim() != reason
        || reason.is_empty()
        || reason.chars().count() > 256
        || reason.chars().any(char::is_control)
    {
        return Err(invalid());
    }
    let old = match family.as_str() {
        "repair" => super::repairs::current(c, ctx, service_id)?,
        "layaway" => super::layaways::current(c, ctx, service_id)?,
        _ => return Err(invalid()),
    }
    .ok_or_else(|| guard("SERVICE_REFUND_UNVERIFIED"))?;
    if matches!(
        old["remoteStatus"].as_str(),
        Some("CONFLICT" | "INTERVENTION" | "DENIED")
    ) {
        return Err(guard("SERVICE_SYNC_CONFLICT"));
    }
    let conflict:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM native_service_refunds_v1 r JOIN outbox o ON o.operation_id=r.operation_id WHERE r.tenant_id=?1 AND r.scope_key=?2 AND r.family=?3 AND r.service_id=?4 AND o.state IN('CONFLICT','INTERVENTION','DENIED'))",(&ctx.tenant_id,sales::scope_key(ctx)?,family,service_id),|r|r.get(0))?;
    if conflict {
        return Err(guard("SERVICE_SYNC_CONFLICT"));
    }
    let service = &old[family.as_str()];
    let summary = summary(c, ctx, family, service)?;
    if n(s(&summary["revision"])?)? >= 1000 {
        return Err(guard("EXPORT_TOO_LARGE"));
    }
    if service["revision"] != *expected_service_revision
        || summary["revision"] != *expected_refund_revision
    {
        return Err(guard("VERSION_CONFLICT"));
    }
    let amount = n(amount_cents)?;
    let pending = n(s(&summary["pendingCents"])?)?;
    let refunded = n(s(&summary["refundedCents"])?)?;
    if amount == 0 || amount > pending {
        return Err(guard("SERVICE_REFUND_EXCESS"));
    }
    if let Some(turn) = turn_id {
        EntityId::parse(turn).map_err(|_| invalid())?;
        if !remote {
            let drawer = management::active_turn(c, ctx, turn)?;
            if n(s(&drawer["openedAtMs"])?)? > n(at)? {
                return Err(guard("TURN_CHANGED"));
            }
        }
    } else if method == "EFECTIVO" {
        return Err(guard("TURN_REQUIRED"));
    }
    let after = refunded.checked_add(amount).ok_or_else(invalid)?;
    let revision = n(expected_refund_revision)?
        .checked_add(1)
        .ok_or_else(invalid)?;
    let mut doc = json!({"service":{"family":family,"id":service_id,"revision":expected_service_revision,"folio":service["folio"],"basisCents":summary["eligibleCents"]},"refund":{"operationId":operation_id,"revision":revision.to_string(),"amountCents":amount_cents,"method":method,"turnId":turn_id,"dateMs":at,"reason":reason},"refundedBeforeCents":summary["refundedCents"],"refundedAfterCents":after.to_string(),"pendingBeforeCents":summary["pendingCents"],"pendingAfterCents":(pending-amount).to_string(),"amountCents":amount_cents,"method":method,"concept":format!("Devolución de depósito {}",s(&service["folio"])?),"business":old["business"]});
    if turn_id.is_some() {
        doc["cashDeltaCents"] = json!(if method == "EFECTIVO" { -amount } else { 0 }.to_string());
    }
    Ok(doc)
}
pub fn validate(v: &Value) -> Result<(), AppError> {
    let req: Command =
        serde_json::from_value(v["payload"]["request"].clone()).map_err(|_| invalid())?;
    let Command::ServiceRefund {
        operation_id,
        family,
        service_id,
        expected_service_revision,
        expected_refund_revision,
        amount_cents,
        method,
        turn_id,
        reason,
    } = req
    else {
        return Err(invalid());
    };
    let d = &v["payload"]["document"];
    let fields = d.as_object().ok_or_else(invalid)?;
    if fields.len() != 10 + usize::from(fields.contains_key("cashDeltaCents"))
        || ![
            "service",
            "refund",
            "refundedBeforeCents",
            "refundedAfterCents",
            "pendingBeforeCents",
            "pendingAfterCents",
            "amountCents",
            "method",
            "concept",
            "business",
        ]
        .iter()
        .all(|key| fields.contains_key(*key))
        || d["service"].as_object().is_none_or(|fields| {
            fields.len() != 5
                || !["family", "id", "revision", "folio", "basisCents"]
                    .iter()
                    .all(|key| fields.contains_key(*key))
        })
        || (!d["business"].is_null() && !d["business"].is_object())
    {
        return Err(invalid());
    }
    let amount = n(&amount_cents)?;
    let before = n(s(&d["refundedBeforeCents"])?)?;
    let pending = n(s(&d["pendingBeforeCents"])?)?;
    let basis = n(s(&d["service"]["basisCents"])?)?;
    if !matches!(family.as_str(), "repair" | "layaway")
        || !matches!(method.as_str(), "EFECTIVO" | "TARJETA" | "TRANSFERENCIA")
        || reason.trim() != reason
        || reason.is_empty()
        || reason.chars().count() > 256
        || reason.chars().any(char::is_control)
        || amount == 0
        || amount > pending
        || before.checked_add(pending) != Some(basis)
        || v["operationId"] != operation_id
        || d["service"]["family"] != family
        || d["service"]["id"] != service_id
        || d["service"]["revision"] != expected_service_revision
        || d["amountCents"] != amount_cents
        || d["method"] != method
        || v["originalTurnId"] != json!(turn_id)
        || d["pendingAfterCents"].as_str() != Some((pending - amount).to_string().as_str())
        || d["refundedAfterCents"].as_str()
            != Some(
                before
                    .checked_add(amount)
                    .ok_or_else(invalid)?
                    .to_string()
                    .as_str(),
            )
    {
        return Err(invalid());
    }
    EntityId::parse(&service_id).map_err(|_| invalid())?;
    if n(&expected_service_revision)? == 0 || n(&expected_refund_revision)? >= 1000 {
        return Err(invalid());
    }
    let expected = json!({"operationId":operation_id,"revision":n(&expected_refund_revision)?.checked_add(1).ok_or_else(invalid)?.to_string(),"amountCents":amount_cents,"method":method,"turnId":turn_id,"dateMs":v["originAtUtcMs"],"reason":reason});
    if d["refund"] != expected
        || d["concept"] != format!("Devolución de depósito {}", s(&d["service"]["folio"])?)
        || (turn_id.is_none() && (method == "EFECTIVO" || d.get("cashDeltaCents").is_some()))
        || (turn_id.is_some()
            && d["cashDeltaCents"].as_str()
                != Some(
                    if method == "EFECTIVO" { -amount } else { 0 }
                        .to_string()
                        .as_str(),
                ))
    {
        return Err(invalid());
    }
    Ok(())
}
pub fn apply(
    tx: &Transaction<'_>,
    ctx: &CatalogueContext,
    v: &Value,
    remote: bool,
) -> Result<(), AppError> {
    validate(v)?;
    let req: Command =
        serde_json::from_value(v["payload"]["request"].clone()).map_err(|_| invalid())?;
    let expected = document(tx, ctx, &req, s(&v["originAtUtcMs"])?, remote)?;
    if expected != v["payload"]["document"] {
        return Err(guard("VERSION_CONFLICT"));
    }
    insert(tx, ctx, v)
}
fn insert(tx: &Transaction<'_>, ctx: &CatalogueContext, v: &Value) -> Result<(), AppError> {
    let d = &v["payload"]["document"];
    tx.execute(
        "INSERT INTO native_service_refunds_v1 VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
        (
            s(&v["operationId"])?,
            &ctx.tenant_id,
            sales::scope_key(ctx)?,
            s(&d["service"]["family"])?,
            s(&d["service"]["id"])?,
            n(s(&d["refund"]["revision"])?)?,
            n(s(&d["amountCents"])?)?,
            d.to_string(),
        ),
    )?;
    Ok(())
}
pub fn import_capture(
    tx: &Transaction<'_>,
    ctx: &CatalogueContext,
    events: &Value,
    watermark: i64,
) -> Result<(), AppError> {
    if events.is_null() {
        return Ok(());
    }
    let events = events.as_array().ok_or_else(invalid)?;
    if events.len() > 10000 {
        return Err(invalid());
    }
    for e in events {
        let raw = s(&e["intent"])?;
        let v: Value = serde_json::from_str(raw).map_err(|_| invalid())?;
        let (canonical, hash) = canonicalize(raw.as_bytes()).map_err(|_| invalid())?;
        let r = &e["receipt"];
        if canonical != raw
            || r["intentHash"] != hash
            || v["kind"] != "SERVICE_REFUND"
            || n(s(&r["remoteSequence"])?)? > watermark
        {
            return Err(invalid());
        }
        sales_sync::validate_event(ctx, &v, None, r)?;
        validate(&v)?;
        let op = s(&v["operationId"])?;
        let found: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM native_service_refunds_v1 WHERE operation_id=?1)",
            [op],
            |r| r.get(0),
        )?;
        if found {
            let old: String = tx.query_row(
                "SELECT document FROM native_service_refunds_v1 WHERE operation_id=?1",
                [op],
                |r| r.get(0),
            )?;
            if serde_json::from_str::<Value>(&old).map_err(|_| invalid())?
                != v["payload"]["document"]
            {
                return Err(invalid());
            }
            continue;
        }
        let doc = &v["payload"]["document"];
        let sk = sales::scope_key(ctx)?;
        let (count,refunded):(i64,i64)=tx.query_row("SELECT count(*),coalesce(sum(amount_cents),0) FROM native_service_refunds_v1 WHERE tenant_id=?1 AND scope_key=?2 AND family=?3 AND service_id=?4",(&ctx.tenant_id,&sk,s(&doc["service"]["family"])?,s(&doc["service"]["id"])?),|r|Ok((r.get(0)?,r.get(1)?)))?;
        if n(s(&doc["refund"]["revision"])?)? != count + 1
            || doc["refundedBeforeCents"].as_str() != Some(refunded.to_string().as_str())
        {
            return Err(invalid());
        }
        let origin = sk.split_once('/').ok_or_else(invalid)?.1.to_owned();
        tx.execute("INSERT INTO operation_journal VALUES(?1,'ventard.native.v1','SERVICE_REFUND',1,?2,?3,?4,?5,?6,?7,?8,COALESCE((SELECT MAX(local_seq) FROM operation_journal),0)+1,'COMMITTED',?9)",(op,raw.as_bytes(),hash,s(&v["actorId"])?,origin,s(&v["originDeviceId"])?,n(s(&v["writerEpoch"])?)?,s(&v["originAtUtcMs"])?,json!({"remoteStatus":"APPLIED","source":"CURRENT_CAPTURE"}).to_string()))?;
        insert(tx, ctx, &v)?;
        tx.execute("INSERT INTO native_management_records_v1 VALUES(?1,?2,?3,'SERVICE_REFUND',?4,NULL,?5,?6,?7,?8,?9)",(op,&ctx.tenant_id,&sk,v["originalTurnId"].as_str(),s(&doc["method"])?,n(s(&doc["amountCents"])?)?,s(&doc["concept"])?,s(&v["originAtUtcMs"])?,doc.to_string()))?;
        let (receipt_raw, _) =
            canonicalize(&serde_json::to_vec(r).map_err(|_| invalid())?).map_err(|_| invalid())?;
        tx.execute(
            "INSERT INTO native_sales_receipts_v1 VALUES(?1,?2,?3,?4,?5)",
            (
                op,
                &ctx.tenant_id,
                &sk,
                n(s(&r["remoteSequence"])?)?,
                receipt_raw,
            ),
        )?;
    }
    Ok(())
}
