#![cfg(feature = "encrypted-storage")]
use rusqlite::Connection;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use ventard_core::domain::canonical::canonicalize;
use ventard_core::{
    application::sales_sync::*,
    storage::{catalogue_preview::CatalogueContext, migrations},
};
fn id(n: u32) -> String {
    format!("96200000-0000-4000-8000-{n:012}")
}
fn ctx() -> CatalogueContext {
    CatalogueContext {
        tenant_id: id(1),
        actor_id: id(2),
        device_id: id(3),
        installation_id: id(4),
        writer_epoch: "1".into(),
        scope_type: "BRANCH".into(),
        branch_id: Some(id(5)),
    }
}
fn db() -> Connection {
    let mut c = Connection::open_in_memory().unwrap();
    c.pragma_update(None, "foreign_keys", true).unwrap();
    migrations::apply(&mut c).unwrap();
    c
}
#[test]
fn unknown_or_partial_receipt_never_marks_applied() {
    let mut c = db();
    for r in [
        json!({"status":"APPLIED"}),
        json!({"status":"APPLIED","namespace":"NATIVE1","stock":[]}),
    ] {
        assert!(receive_event(
            &mut c,
            &ctx(),
            &json!({"receipt":r,"intent":"{}","snapshot":null})
        )
        .is_err());
    }
    assert_eq!(
        c.query_row::<i64, _, _>("select count(*) from native_sales_receipts_v1", [], |r| r
            .get(0))
            .unwrap(),
        0
    );
}
#[test]
fn bootstrap_cannot_promote_preview_or_invent_remote_evidence() {
    let mut c = db();
    assert!(begin_bootstrap(
        &mut c,
        &ctx(),
        &json!({"version":"ventard.native.catalogue.preview.1"}),
        1000
    )
    .is_err());
    assert!(!operational(&c, &ctx()).unwrap());
}
#[test]
fn operational_read_marks_unknown_stock_explicitly_without_changing_data() {
    let mut c = db();
    bootstrap(&mut c, &ctx());
    c.execute("UPDATE stock_projections SET authority_state='UNKNOWN'", [])
        .unwrap();
    let changes = c.total_changes();
    let snapshot = read(&c, &ctx()).unwrap();
    assert_eq!(snapshot["products"][0]["stock"], "");
    assert!(snapshot["products"][0].get("kind").is_none());
    assert_eq!(snapshot["products"][0]["locationKnown"], false);
    assert!(snapshot["products"][0]["minimum"].is_null());
    assert_eq!(snapshot["products"][0]["preview"]["stockVerifiable"], false);
    assert_eq!(
        snapshot["products"][0]["preview"]["stockEvidence"],
        "MISSING_OR_DIVERGENT_AUTHORITY"
    );
    assert_eq!(c.total_changes(), changes);
}
#[test]
fn original_receipt_identity_hash_and_effect_set_are_required() {
    let v = json!({});
    let r = json!({"status":"APPLIED"});
    assert!(validate_event(&ctx(), &v, None, &r).is_err());
}
#[test]
fn failure_classification_preserves_permanent_operations() {
    assert_eq!(failure_state(401), "PENDING");
    assert_eq!(failure_state(403), "INTERVENTION");
    assert_eq!(failure_state(429), "RETRYABLE_ERROR");
    assert_eq!(failure_state(503), "RETRYABLE_ERROR");
    assert_eq!(failure_state(409), "CONFLICT");
}
#[test]
fn explicit_retry_keeps_original_bytes_and_cannot_repeat_local_effects_or_cross_context() {
    let mut c = db();
    let context = ctx();
    bootstrap(&mut c, &context);
    let v = json!({"protocol":"ventard.native.v1","kind":"SALE_CONFIRM","operationId":id(130),"negocioId":context.tenant_id,"actorId":context.actor_id,"originDeviceId":context.device_id,"installationId":context.installation_id,"writerEpoch":"1","scope":{"type":"BRANCH","sucursalId":context.branch_id},"payload":{"sale":{"stockEvidence":[]}}});
    let (b, h) = canon(&v);
    let scope = format!("BRANCH:{}", id(5));
    c.execute("INSERT INTO operation_journal VALUES(?1,'ventard.native.v1','SALE_CONFIRM',1,?2,?3,?4,?5,?6,1,'1000',130,'COMMITTED','{}')",(id(130),b.as_bytes(),&h,id(2),&scope,id(3))).unwrap();
    c.execute(
        "INSERT INTO outbox(operation_id,envelope,state) VALUES(?1,?2,'CONFLICT')",
        (id(130), b.as_bytes()),
    )
    .unwrap();
    let before = c
        .query_row::<String, _, _>("SELECT effective_stock FROM stock_projections", [], |r| {
            r.get(0)
        })
        .unwrap();
    let mut alien = context.clone();
    alien.actor_id = id(99);
    assert!(retry_failed(&mut c, &alien, &id(130), 2000).is_err());
    alien = context.clone();
    alien.installation_id = id(98);
    assert!(retry_failed(&mut c, &alien, &id(130), 2000).is_err());
    alien = context.clone();
    alien.tenant_id = id(97);
    assert!(retry_failed(&mut c, &alien, &id(130), 2000).is_err());
    alien = context.clone();
    alien.branch_id = Some(id(96));
    assert!(retry_failed(&mut c, &alien, &id(130), 2000).is_err());
    alien = context.clone();
    alien.writer_epoch = "2".into();
    assert!(retry_failed(&mut c, &alien, &id(130), 2000).is_err());
    c.execute(
        "UPDATE outbox SET envelope=?1 WHERE operation_id=?2",
        (b"{}".as_slice(), id(130)),
    )
    .unwrap();
    assert!(retry_failed(&mut c, &context, &id(130), 2000).is_err());
    c.execute(
        "UPDATE outbox SET envelope=?1 WHERE operation_id=?2",
        (b.as_bytes(), id(130)),
    )
    .unwrap();
    retry_failed(&mut c, &context, &id(130), 2000).unwrap();
    assert!(retry_failed(&mut c, &context, &id(130), 2000).is_err());
    let d = claim(&mut c, &context, 2000).unwrap().unwrap();
    assert_eq!(d.operation_id, id(130));
    assert_eq!(d.intent, b);
    assert_eq!(d.hash, h);
    assert_eq!(
        c.query_row::<String, _, _>("SELECT effective_stock FROM stock_projections", [], |r| r
            .get(0))
            .unwrap(),
        before
    );
    assert_eq!(
        c.query_row::<i64, _, _>("SELECT count(*) FROM operation_journal", [], |r| r.get(0))
            .unwrap(),
        1
    );
    assert_eq!(
        c.query_row::<i64, _, _>("SELECT count(*) FROM sales", [], |r| r.get(0))
            .unwrap(),
        0
    );
}
#[test]
fn scope_is_always_derived_from_validated_context() {
    let mut c = db();
    let mut wrong = ctx();
    wrong.branch_id = None;
    assert!(begin_bootstrap(&mut c, &wrong, &Value::Null, 1000).is_err());
}
fn canon(v: &Value) -> (String, String) {
    canonicalize(&serde_json::to_vec(v).unwrap()).unwrap()
}
fn eid(op: &str, part: &str) -> String {
    let digest = Sha256::digest(format!("ventard.local-effect.v1/{op}/{part}"));
    let mut b = [0; 16];
    b.copy_from_slice(&digest[..16]);
    b[6] = (b[6] & 15) | 0x80;
    b[8] = (b[8] & 63) | 0x80;
    uuid::Uuid::from_bytes(b).to_string()
}
fn bootstrap(c: &mut Connection, context: &CatalogueContext) {
    let row = json!({"kind":"PRODUCT","id":id(20),"name":"Sintético","code":"QA","revision":"1","deleted":false,"priceTiers":{"retailCents":"10000"},"metadata":{"taxRate":{"numerator":"9","denominator":"50"},"costCents":null,"serialRequired":false,"recipe":[]},"stock":{"quantity":"100","version":"0","authority":"VERIFIED"}});
    let (payload, h) = canon(&json!([row]));
    let m = json!({"version":"ventard.native.operational.1","namespace":"NATIVE1","coverage":"QA_SYNTHETIC_ADOPTED","snapshotId":id(300),"context":context,"capturedAtMs":"1000","expiresAtMs":"5000","watermark":"0","totalCount":1,"ticketPrefix":format!("N{}",context.installation_id.replace('-',"")),"lastTicket":"0","freeTax":{"numerator":"9","denominator":"50"},"turn":null,"pages":[{"index":0,"count":1,"byteLength":payload.len(),"sha256":h}]});
    begin_bootstrap(c, context, &m, 1000).unwrap();
    assert!(activate_bootstrap(c, context, 1000, &id(1000)).is_err());
    stage_bootstrap_page(c, context, 0, &payload, 1000).unwrap();
    activate_bootstrap(c, context, 1000, &id(1000)).unwrap();
    assert!(operational(c, context).unwrap());
}
fn event() -> Value {
    let op = id(100);
    let p = json!({"method":"TARJETA","customerId":null,"paidCents":"11800","creditChargeCents":"0","cashNetCents":"0","cardCents":"11800","transferCents":"0","tenderCents":"0","changeCents":"0","turnId":null,"bankSettlementVerified":false});
    let l = json!({"productId":id(20),"productRevision":"1","name":"Sintético","unitPriceCents":"10000","quantity":{"numerator":"1","denominator":"1"},"taxRate":{"numerator":"9","denominator":"50"},"costCents":null,"serial":null,"recipe":[]});
    let sale = json!({"calculationVersion":"ventard.sale.calculation.1","currency":"DOP","lines":[l],"discount":{"type":"AMOUNT","amountCents":"0"},"totals":{"subtotalCents":"10000","itbisCents":"1800","discountCents":"0","totalCents":"11800"},"payment":p,"inventory":[{"productId":id(20),"delta":"-1","expectedRevision":canon(&json!({"quantity":"100","remoteSequence":"0","pending":[]})).1}],"stockEvidence":[{"productId":id(20),"remoteBaseQty":"100","remoteSequence":"0","pending":[],"effectiveQty":"100"}],"serials":[],"fiscal":null});
    let v = json!({"protocol":"ventard.native.v1","kind":"SALE_CONFIRM","operationId":op,"negocioId":id(1),"scope":{"type":"BRANCH","sucursalId":id(5)},"actorId":id(9),"originDeviceId":id(10),"installationId":id(11),"writerEpoch":"1","permissionGrantId":id(12),"originAtUtcMs":"1000","payload":{"sale":sale}});
    let s = json!({"version":"ventard.ticket.snapshot.1","operationId":op,"tenantId":id(1),"scope":{"type":"BRANCH","branchId":id(5)},"actorId":id(9),"originAtUtcMs":"1000","ticket":"NQA-000001","ncf":null,"customerName":null,"sale":sale});
    let (intent, h) = canon(&v);
    let (snapshot, sh) = canon(&s);
    json!({"intent":intent,"snapshot":snapshot,"receipt":{"protocol":"ventard.native.receipt.1","status":"APPLIED","namespace":"NATIVE1","operationId":op,"tenantId":id(1),"scope":{"type":"BRANCH","branchId":id(5)},"actorId":id(9),"installationId":id(11),"deviceId":id(10),"writerEpoch":"1","intentHash":h,"snapshotHash":sh,"remoteSequence":"1","appliedAtMs":"1001","ticket":s["ticket"],"ncf":null,"totalCents":"11800","effects":[{"id":eid(&op,"line/0"),"kind":"LINE","payload":l},{"id":eid(&op,&format!("stock/{}",id(20))),"kind":"STOCK","payload":{"productId":id(20),"delta":"-1"}},{"id":eid(&op,"payment"),"kind":"PAYMENT","payload":p}],"stock":[{"productId":id(20),"after":"99","version":"1"}]}})
}
fn feed(events: Vec<Value>) -> Value {
    json!({"namespace":"NATIVE1","tenantId":id(1),"scope":{"type":"BRANCH","branchId":id(5)},"coverage":"COMPLETE","scannedThrough":"1","watermark":"1","events":events})
}
#[test]
fn other_pc_receives_whole_sale_once_and_keeps_own_pending_stock() {
    let mut c = db();
    bootstrap(&mut c, &ctx());
    let sk = format!("{}/BRANCH:{}", id(1), id(5));
    c.execute(
        "UPDATE stock_projections SET pending_coverage=?1,effective_stock='98'",
        [json!([{"operationId":id(500),"effectId":id(501),"delta":"-2"}]).to_string()],
    )
    .unwrap();
    let e = event();
    receive_feed(&mut c, &ctx(), &feed(vec![e.clone()])).unwrap();
    receive_event(&mut c, &ctx(), &e).unwrap();
    let(base,effective,pending):(String,String,String)=c.query_row("SELECT remote_base_qty,effective_stock,pending_coverage FROM stock_projections WHERE scope_key=?1",[sk],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap();
    assert_eq!(base, "99");
    assert_eq!(effective, "97");
    assert!(pending.contains(&id(500)));
    assert_eq!(
        c.query_row::<i64, _, _>("SELECT count(*) FROM sales", [], |r| r.get(0))
            .unwrap(),
        1
    );
    assert_eq!(
        c.query_row::<i64, _, _>("SELECT sum(amount_cents) FROM payments", [], |r| r.get(0))
            .unwrap(),
        11800
    );
    assert_eq!(
        c.query_row::<i64, _, _>("SELECT count(*) FROM outbox", [], |r| r.get(0))
            .unwrap(),
        0
    );
}
#[test]
fn corrupted_receipt_or_incomplete_page_rolls_back_cursor_money_and_stock() {
    let mut c = db();
    bootstrap(&mut c, &ctx());
    let mut e = event();
    e["receipt"]["effects"].as_array_mut().unwrap().pop();
    assert!(receive_feed(&mut c, &ctx(), &feed(vec![e])).is_err());
    assert_eq!(
        c.query_row::<i64, _, _>("SELECT sequence FROM native_sales_cursor_v1", [], |r| r
            .get(0))
            .unwrap(),
        0
    );
    assert_eq!(
        c.query_row::<i64, _, _>("SELECT count(*) FROM sales", [], |r| r.get(0))
            .unwrap(),
        0
    );
    assert_eq!(
        c.query_row::<String, _, _>("SELECT effective_stock FROM stock_projections", [], |r| r
            .get(0))
            .unwrap(),
        "100"
    );
}
#[test]
fn bootstrap_replay_never_resets_local_numbers_or_replaces_operational_facts() {
    let mut c = db();
    bootstrap(&mut c, &ctx());
    let e = event();
    receive_feed(&mut c, &ctx(), &feed(vec![e])).unwrap();
    assert!(begin_bootstrap(&mut c, &ctx(), &json!({}), 1000).is_err());
    assert_eq!(
        c.query_row::<String, _, _>("SELECT effective_stock FROM stock_projections", [], |r| r
            .get(0))
            .unwrap(),
        "99"
    );
}
#[test]
fn a_permanent_operation_stays_visible_while_99_independent_operations_advance() {
    let mut c = db();
    bootstrap(&mut c, &ctx());
    let scope = format!("BRANCH:{}", id(5));
    for n in 100..200 {
        let v = json!({"protocol":"ventard.native.v1","kind":"TURN_OPEN","operationId":id(n),"negocioId":id(1),"installationId":id(4),"scope":{"type":"BRANCH","sucursalId":id(5)}});
        let (b, h) = canon(&v);
        c.execute("INSERT INTO operation_journal VALUES(?1,'ventard.native.v1','TURN_OPEN',1,?2,?3,?4,?5,?6,1,'1000',?7,'COMMITTED','{}')",(id(n),b.as_bytes(),h,id(2),&scope,id(3),n as i64)).unwrap();
        c.execute(
            "INSERT INTO outbox(operation_id,envelope,state) VALUES(?1,?2,'PENDING')",
            (id(n), b.as_bytes()),
        )
        .unwrap();
    }
    for n in 100..200 {
        let d = claim(&mut c, &ctx(), 1000).unwrap().unwrap();
        assert_eq!(d.operation_id, id(n));
        record_failure(&mut c, &d, if n == 100 { 403 } else { 503 }, 1000, 60_000).unwrap();
    }
    assert_eq!(
        c.query_row::<i64, _, _>(
            "SELECT count(*) FROM outbox WHERE state='INTERVENTION'",
            [],
            |r| r.get(0)
        )
        .unwrap(),
        1
    );
    assert_eq!(
        c.query_row::<i64, _, _>(
            "SELECT count(*) FROM outbox WHERE state='RETRYABLE_ERROR' AND attempts=1",
            [],
            |r| r.get(0)
        )
        .unwrap(),
        99
    );
    assert!(claim(&mut c, &ctx(), 2000).unwrap().is_none());
    assert!(claim(&mut c, &ctx(), 61_000).unwrap().is_some());
}
