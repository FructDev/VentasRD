//! Durable partial returns on the final history page. Immutable original basis.
use super::{
    errors::{AppError, BusinessError, ProtocolError},
    history,
    management::{self, Command},
    sales,
};
use crate::{
    domain::{
        canonical::canonicalize,
        money::MoneyCents,
        return_plan::{self, Item},
    },
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
fn n(v: &Value) -> Result<i64, AppError> {
    Ok(MoneyCents::parse_dto(s(v)?).map_err(|_| invalid())?.cents())
}
fn basis(c: &Connection, ctx: &CatalogueContext, sale_id: &str) -> Result<Value, AppError> {
    let mut ticket = history::ticket(c, ctx, sale_id)?;
    let hash: String = c.query_row(
        "SELECT snapshot_hash FROM sale_ticket_snapshots_v1 WHERE operation_id=?1",
        [sale_id],
        |r| r.get(0),
    )?;
    ticket["printSnapshotHash"] = json!(hash);
    Ok(ticket)
}
fn prior(
    c: &Connection,
    ctx: &CatalogueContext,
    sale_id: &str,
) -> Result<Vec<(String, Value)>, AppError> {
    let mut q=c.prepare("SELECT operation_id,document FROM native_management_records_v1 WHERE tenant_id=?1 AND scope_key=?2 AND kind='SALE_RETURN' AND json_extract(document,'$.saleId')=?3 ORDER BY operation_id")?;
    let rows = q
        .query_map((&ctx.tenant_id, sales::scope_key(ctx)?, sale_id), |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    rows.into_iter()
        .map(|(id, raw)| Ok((id, serde_json::from_str(&raw).map_err(|_| invalid())?)))
        .collect()
}
fn revision(hash: &Value, rows: &[(String, Value)]) -> Result<String, AppError> {
    Ok(canonicalize(&serde_json::to_vec(&json!({"snapshotHash":hash,"returns":rows.iter().map(|(id,d)|json!({"operationId":id,"refund":d["refund"]})).collect::<Vec<_>>()})).map_err(|_|invalid())?).map_err(|_|invalid())?.1)
}
pub fn read(c: &Connection, ctx: &CatalogueContext, sale_id: &str) -> Result<Value, AppError> {
    let ticket = basis(c, ctx, sale_id)?;
    let rows = prior(c, ctx, sale_id)?;
    let refunds = rows
        .iter()
        .map(|(_, d)| d["refund"].clone())
        .collect::<Vec<_>>();
    let mut data = return_plan::available(&ticket["sale"], &refunds).map_err(guard)?;
    data["saleId"] = json!(sale_id);
    data["ticket"] = ticket["ticket"].clone();
    data["method"] = ticket["sale"]["payment"]["method"].clone();
    data["revision"] = json!(revision(&ticket["printSnapshotHash"], &rows)?);
    data["blockedCode"] = if ticket["ncf"].is_null() {
        Value::Null
    } else {
        json!("RETURN_FISCAL_PENDING")
    };
    data["previous"] = json!(rows
        .iter()
        .map(
            |(id, d)| json!({"operationId":id,"reason":d["concept"],"amountCents":d["amountCents"]})
        )
        .collect::<Vec<_>>());
    Ok(data)
}
pub fn preview(
    c: &Connection,
    ctx: &CatalogueContext,
    sale_id: &str,
    items: &[Item],
    serials: &[String],
) -> Result<Value, AppError> {
    let ticket = basis(c, ctx, sale_id)?;
    if !ticket["ncf"].is_null() {
        return Err(guard("RETURN_FISCAL_PENDING"));
    }
    let rows = prior(c, ctx, sale_id)?;
    let refunds = rows
        .iter()
        .map(|(_, d)| d["refund"].clone())
        .collect::<Vec<_>>();
    return_plan::plan(&ticket["sale"], &refunds, items, serials).map_err(guard)
}
pub fn document(c: &Connection, ctx: &CatalogueContext, req: &Command) -> Result<Value, AppError> {
    let Command::SaleReturn {
        sale_id,
        expected_return_revision,
        items,
        serials,
        reason,
        turn_id,
        ..
    } = req
    else {
        return Err(invalid());
    };
    if reason.trim().is_empty()
        || reason.trim() != reason
        || reason.chars().count() > 256
        || reason.chars().any(char::is_control)
    {
        return Err(invalid());
    }
    management::active_turn(c, ctx, turn_id)?;
    let ticket = basis(c, ctx, sale_id)?;
    if !ticket["ncf"].is_null() {
        return Err(guard("RETURN_FISCAL_PENDING"));
    }
    let rows = prior(c, ctx, sale_id)?;
    let rev = revision(&ticket["printSnapshotHash"], &rows)?;
    if rev != *expected_return_revision {
        return Err(guard("RETURN_CHANGED"));
    }
    let refunds = rows
        .iter()
        .map(|(_, d)| d["refund"].clone())
        .collect::<Vec<_>>();
    let refund = return_plan::plan(&ticket["sale"], &refunds, items, serials).map_err(guard)?;
    let sk = sales::scope_key(ctx)?;
    let mut stock = vec![];
    for delta in refund["inventory"].as_array().ok_or_else(invalid)? {
        let pid = s(&delta["productId"])?;
        let (before, rev, pending) = sales::stock(c, pid, &sk)?;
        let after = before
            .checked_add(i32::try_from(n(&delta["delta"])?).map_err(|_| invalid())?)
            .ok_or_else(|| guard("STOCK_OUT_OF_RANGE"))?;
        let(base,seq):(String,i64)=c.query_row("SELECT remote_base_qty,remote_seq FROM stock_projections WHERE producto_id=?1 AND scope_key=?2",(pid,&sk),|r|Ok((r.get(0)?,r.get(1)?)))?;
        stock.push(json!({"productId":pid,"delta":delta["delta"],"before":before.to_string(),"after":after.to_string(),"expectedRevision":rev,"stockEvidence":{"productId":pid,"remoteBaseQty":base,"remoteSequence":seq.to_string(),"pending":serde_json::from_str::<Value>(&pending).map_err(|_|invalid())?,"effectiveQty":before.to_string()}}));
    }
    let mut serial_proof = vec![];
    for serial in refund["serials"].as_array().ok_or_else(invalid)? {
        let row:(String,String,Option<String>)=c.query_row("SELECT revision,state,sale_operation_id FROM sale_serial_inventory_v1 WHERE tenant_id=?1 AND scope_key=?2 AND producto_id=?3 AND serial=?4",(&ctx.tenant_id,&sk,s(&serial["productId"])?,s(&serial["text"])?),|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(|_|guard("RETURN_SERIAL_INVALID"))?;
        if row.1 != "SOLD" || row.2.as_deref() != Some(sale_id) {
            return Err(guard("RETURN_SERIAL_INVALID"));
        }
        serial_proof.push(
            json!({"productId":serial["productId"],"text":serial["text"],"expectedRevision":row.0}),
        );
    }
    let mut credit = Value::Null;
    if refund["method"] == "FIADO" {
        let cid = s(&ticket["sale"]["payment"]["customerId"])?;
        let old = management::customer(c, ctx, cid)?;
        let charge:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM sale_credit_entries_v1 WHERE operation_id=?1 AND tenant_id=?2 AND customer_id=?3 AND amount_cents>0)",(sale_id,&ctx.tenant_id,cid),|r|r.get(0))?;
        let amount = n(&refund["amountCents"])?;
        let before = n(&old["balanceCents"])?;
        if !charge || old["authority"] != "VERIFIED" {
            return Err(guard("RETURN_CREDIT_UNVERIFIED"));
        }
        if before < amount {
            return Err(guard("RETURN_PAID_CREDIT_PENDING"));
        }
        credit = json!({"customerId":cid,"beforeCents":before.to_string(),"afterCents":(before-amount).to_string(),"expectedRevision":old["balanceRevision"]});
    }
    Ok(
        json!({"saleId":sale_id,"originalSnapshotHash":ticket["printSnapshotHash"],"priorReturnIds":rows.iter().map(|(id,_)|id).collect::<Vec<_>>(),"returnRevision":rev,"refund":refund,"stock":stock,"serialProof":serial_proof,"credit":credit,"method":refund["method"],"amountCents":refund["amountCents"],"concept":reason,"cashDeltaCents":(-n(&refund["cashRefundCents"])?).to_string()}),
    )
}
pub fn apply(
    tx: &Transaction<'_>,
    ctx: &CatalogueContext,
    v: &Value,
    remote: bool,
) -> Result<(), AppError> {
    let op = s(&v["operationId"])?;
    let d = &v["payload"]["document"];
    let req: Command =
        serde_json::from_value(v["payload"]["request"].clone()).map_err(|_| invalid())?;
    if !remote {
        if document(tx, ctx, &req)? != *d {
            return Err(guard("RETURN_CHANGED"));
        }
    } else {
        let Command::SaleReturn {
            sale_id,
            expected_return_revision,
            items,
            serials,
            reason,
            turn_id,
            ..
        } = &req
        else {
            return Err(invalid());
        };
        let ticket = basis(tx, ctx, sale_id)?;
        let rows = prior(tx, ctx, sale_id)?;
        let ids = rows.iter().map(|(id, _)| json!(id)).collect::<Vec<_>>();
        if d["priorReturnIds"] != json!(ids)
            || d["originalSnapshotHash"] != ticket["printSnapshotHash"]
            || !ticket["ncf"].is_null()
            || revision(&ticket["printSnapshotHash"], &rows)? != *expected_return_revision
            || d["saleId"] != *sale_id
            || d["concept"] != *reason
            || v["originalTurnId"] != *turn_id
        {
            return Err(guard("RETURN_CHANGED"));
        }
        let refunds = rows
            .iter()
            .map(|(_, d)| d["refund"].clone())
            .collect::<Vec<_>>();
        if return_plan::plan(&ticket["sale"], &refunds, items, serials).map_err(guard)?
            != d["refund"]
        {
            return Err(invalid());
        }
    }
    let sk = sales::scope_key(ctx)?;
    for delta in d["stock"].as_array().ok_or_else(invalid)? {
        let pid = s(&delta["productId"])?;
        let eid = sales::effect_id(op, &format!("stock/{pid}"));
        tx.execute(
            "INSERT INTO inventory_movements VALUES(?1,?2,?3,?4,'RETURN',?5,NULL,NULL,NULL)",
            (&eid, op, pid, &sk, s(&delta["delta"])?),
        )?;
        if !remote {
            let (_, _, pending) = sales::stock(tx, pid, &sk)?;
            let mut pending: Vec<Value> = serde_json::from_str(&pending).map_err(|_| invalid())?;
            pending.push(json!({"operationId":op,"effectId":eid,"delta":delta["delta"]}));
            tx.execute("UPDATE stock_projections SET effective_stock=?3,pending_coverage=?4 WHERE producto_id=?1 AND scope_key=?2",(pid,&sk,s(&delta["after"])?,json!(pending).to_string()))?;
        }
    }
    for serial in d["serialProof"].as_array().ok_or_else(invalid)? {
        let changed=tx.execute("UPDATE sale_serial_inventory_v1 SET state='AVAILABLE',sale_operation_id=NULL,revision=?7 WHERE tenant_id=?1 AND scope_key=?2 AND producto_id=?3 AND serial=?4 AND sale_operation_id=?5 AND state='SOLD' AND revision=?6",(&ctx.tenant_id,&sk,s(&serial["productId"])?,s(&serial["text"])?,s(&d["saleId"])?,s(&serial["expectedRevision"])?,s(&serial["expectedRevision"])?))?;
        if changed != 1 {
            return Err(guard("RETURN_SERIAL_INVALID"));
        }
    }
    if !d["credit"].is_null() {
        let credit = &d["credit"];
        let old = management::customer(tx, ctx, s(&credit["customerId"])?)?;
        let before = n(&credit["beforeCents"])?;
        let after = n(&credit["afterCents"])?;
        if old["balanceRevision"] != credit["expectedRevision"]
            || old["balanceCents"] != credit["beforeCents"]
            || after < 0
            || before - after != n(&d["amountCents"])?
        {
            return Err(guard("VERSION_CONFLICT"));
        }
        tx.execute(
            "INSERT INTO sale_credit_entries_v1 VALUES(?1,?2,?3,?4,?5,?6,?7)",
            (
                op,
                s(&credit["customerId"])?,
                &ctx.tenant_id,
                &sk,
                after - before,
                before,
                after,
            ),
        )?;
        tx.execute("UPDATE sale_customer_accounts_v1 SET balance_cents=?3,revision=revision+1 WHERE tenant_id=?1 AND customer_id=?2",(&ctx.tenant_id,s(&credit["customerId"])?,after))?;
    }
    Ok(())
}
pub fn effects(v: &Value) -> Result<Value, AppError> {
    let op = s(&v["operationId"])?;
    let d = &v["payload"]["document"];
    let mut list =
        vec![json!({"id":sales::effect_id(op,"management"),"kind":"SALE_RETURN","payload":d})];
    for e in d["refund"]["inventory"].as_array().ok_or_else(invalid)? {
        let pid = s(&e["productId"])?;
        list.push(
            json!({"id":sales::effect_id(op,&format!("stock/{pid}")),"kind":"STOCK","payload":e}),
        );
    }
    Ok(json!(list))
}
pub fn validate_receipt(v: &Value, r: &Value, snapshot: Option<&str>) -> Result<(), AppError> {
    let d = &v["payload"]["document"];
    let Command::SaleReturn {
        sale_id,
        expected_return_revision,
        reason,
        turn_id,
        ..
    } = serde_json::from_value(v["payload"]["request"].clone()).map_err(|_| invalid())?
    else {
        return Err(invalid());
    };
    if snapshot.is_some()
        || !r["snapshotHash"].is_null()
        || !r["ticket"].is_null()
        || !r["ncf"].is_null()
        || !r["totalCents"].is_null()
        || r["effects"] != effects(v)?
        || d["saleId"] != sale_id
        || d["returnRevision"] != expected_return_revision
        || d["concept"] != reason
        || v["originalTurnId"] != turn_id
        || d["amountCents"] != d["refund"]["amountCents"]
        || d["method"] != d["refund"]["method"]
        || d["cashDeltaCents"] != json!((-n(&d["refund"]["cashRefundCents"])?).to_string())
    {
        return Err(invalid());
    }
    let stock = r["stock"].as_array().ok_or_else(invalid)?;
    let deltas = d["stock"].as_array().ok_or_else(invalid)?;
    if stock.len() != deltas.len()
        || deltas.len()
            != d["refund"]["inventory"]
                .as_array()
                .ok_or_else(invalid)?
                .len()
    {
        return Err(invalid());
    }
    for (i, e) in deltas.iter().enumerate() {
        let proof = &e["stockEvidence"];
        let pending = proof["pending"].as_array().ok_or_else(invalid)?;
        let mut seen = std::collections::HashSet::new();
        let mut effective = n(&proof["remoteBaseQty"])?;
        if !(0..=i32::MAX as i64).contains(&effective)
            || n(&proof["remoteSequence"])? < 0
            || pending.len() > 1000
        {
            return Err(invalid());
        }
        let pid = s(&e["productId"])?;
        for p in pending {
            let op = s(&p["operationId"])?;
            crate::domain::identity::EntityId::parse(op).map_err(|_| invalid())?;
            if !seen.insert(op) || p["effectId"] != sales::effect_id(op, &format!("stock/{pid}")) {
                return Err(invalid());
            }
            let delta = n(&p["delta"])?;
            i32::try_from(delta).map_err(|_| invalid())?;
            effective = effective.checked_add(delta).ok_or_else(invalid)?;
        }
        let hash=canonicalize(&serde_json::to_vec(&json!({"quantity":proof["effectiveQty"],"remoteSequence":proof["remoteSequence"],"pending":proof["pending"]})).map_err(|_|invalid())?).map_err(|_|invalid())?.1;
        if proof["productId"] != e["productId"]
            || proof["effectiveQty"] != e["before"]
            || effective != n(&e["before"])?
            || e["expectedRevision"] != hash
            || n(&e["delta"])? <= 0
            || !(0..=i32::MAX as i64).contains(&n(&e["after"])?)
        {
            return Err(invalid());
        }
        if stock[i]["productId"] != e["productId"]
            || stock[i]["after"] != e["after"]
            || stock[i]["version"] != r["remoteSequence"]
            || e["delta"] != d["refund"]["inventory"][i]["delta"]
            || e["productId"] != d["refund"]["inventory"][i]["productId"]
            || n(&e["before"])? + n(&e["delta"])? != n(&e["after"])?
        {
            return Err(invalid());
        }
    }
    Ok(())
}
