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
fn bootstrap(c: &mut Connection, context: &CatalogueContext) { bootstrap_coverage(c,context,"QA_SYNTHETIC_ADOPTED"); }
#[test]
fn production_cloud_coverage_bootstraps_without_replaying_stock(){
 let mut c=db();bootstrap_coverage(&mut c,&ctx(),"CLOUD_ADOPTED_V1");
 assert_eq!(read(&c,&ctx()).unwrap()["confirmedSales"],"0");
}
fn bootstrap_coverage(c: &mut Connection, context: &CatalogueContext,coverage:&str) {
    let row = json!({"kind":"PRODUCT","id":id(20),"name":"Sintético","code":"QA","revision":"1","deleted":false,"priceTiers":{"retailCents":"10000"},"metadata":{"taxRate":{"numerator":"9","denominator":"50"},"costCents":null,"serialRequired":false,"recipe":[]},"stock":{"quantity":"100","version":"0","authority":"VERIFIED"}});
    let (payload, h) = canon(&json!([row]));
    let m = json!({"version":"ventard.native.operational.1","namespace":"NATIVE1","coverage":coverage,"snapshotId":id(300),"context":context,"capturedAtMs":"1000","expiresAtMs":"5000","watermark":"0","totalCount":1,"ticketPrefix":format!("N{}",context.installation_id.replace('-',"")),"lastTicket":"0","freeTax":{"numerator":"9","denominator":"50"},"turn":null,"pages":[{"index":0,"count":1,"byteLength":payload.len(),"sha256":h}]});
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

fn history_bootstrap(
    c: &mut Connection,
    events: Vec<Value>,
    watermark: &str,
) -> Result<(), ventard_core::application::errors::AppError> {
    let mut rows = vec![
        json!({"kind":"PRODUCT","id":id(20),"name":"Sintético actual","code":"QA","revision":"7","deleted":false,"priceTiers":{"retailCents":"25000"},"metadata":{"taxRate":{"numerator":"9","denominator":"50"},"costCents":null,"serialRequired":false,"recipe":[]},"stock":{"quantity":"93","version":watermark,"authority":"VERIFIED"}}),
    ];
    let turn = events
        .iter()
        .find(|e| {
            serde_json::from_str::<Value>(e["intent"].as_str().unwrap()).unwrap()["kind"]
                == "TURN_OPEN"
        })
        .cloned();
    if events.iter().any(|e| {
        serde_json::from_str::<Value>(e["intent"].as_str().unwrap()).unwrap()["payload"]["sale"]
            ["payment"]["method"]
            == "FIADO"
    }) {
        rows.push(json!({"kind":"CUSTOMER","id":id(30),"name":"Cliente actual","balanceCents":"20000","limitCents":"100000","active":true,"revision":"7","priceTier":"1"}));
    }
    let history_count = events.len();
    for e in &events {
        let v: Value = serde_json::from_str(e["intent"].as_str().unwrap()).unwrap();
        if let Some(serials) = v["payload"]["sale"]["serials"].as_array() {
            for s in serials {
                rows[0]["metadata"]["serialRequired"] = json!(true);
                rows[0]["stock"]["quantity"] = json!("0");
                rows.push(json!({"kind":"SERIAL","productId":s["productId"],"text":s["text"],"revision":"1","state":"SOLD","saleOperationId":e["receipt"]["operationId"]}));
            }
        }
    }
    rows.extend(
        events
            .into_iter()
            .map(|e| json!({"kind":"HISTORY_EVENT","id":e["receipt"]["operationId"],"event":e})),
    );
    let (payload, h) = canon(&json!(rows));
    let m = json!({"version":"ventard.native.operational.1","namespace":"NATIVE1","coverage":"QA_SYNTHETIC_ADOPTED","snapshotId":id(305),"context":ctx(),"capturedAtMs":"1000","expiresAtMs":"5000","watermark":watermark,"historyCoverage":"NATIVE_LEDGER_THROUGH_WATERMARK","historyCount":history_count,"totalCount":rows.len(),"ticketPrefix":format!("N{}",ctx().installation_id.replace('-',"")),"lastTicket":"0","freeTax":{"numerator":"9","denominator":"50"},"turn":turn,"cashBase":turn.as_ref().map(|t|json!({"turnId":t["receipt"]["operationId"],"tenantId":ctx().tenant_id,"scope":{"type":ctx().scope_type,"branchId":ctx().branch_id},"sequence":watermark,"netCents":"11800"})),"pages":[{"index":0,"count":rows.len(),"byteLength":payload.len(),"sha256":h}]});
    begin_bootstrap(c, &ctx(), &m, 1000)?;
    stage_bootstrap_page(c, &ctx(), 0, &payload, 1000)?;
    activate_bootstrap(c, &ctx(), 1000, &id(1000))
}

#[test]
fn captured_sold_serial_retains_original_sale_ownership_without_replaying_sale() {
    let mut e = event();
    let mut v: Value = serde_json::from_str(e["intent"].as_str().unwrap()).unwrap();
    v["payload"]["sale"]["lines"][0]["serial"] = json!("SERIAL-QA-HISTORY");
    let serial = json!({"productId":id(20),"text":"SERIAL-QA-HISTORY","expectedRevision":"1"});
    v["payload"]["sale"]["serials"] = json!([serial]);
    e["receipt"]["effects"][0]["payload"] = v["payload"]["sale"]["lines"][0].clone();
    e["receipt"]["effects"].as_array_mut().unwrap().push(
        json!({"id":eid(&id(100),"serial/SERIAL-QA-HISTORY"),"kind":"SERIAL","payload":serial}),
    );
    let mut s: Value = serde_json::from_str(e["snapshot"].as_str().unwrap()).unwrap();
    s["sale"] = v["payload"]["sale"].clone();
    let (raw, h) = canon(&s);
    e["snapshot"] = json!(raw);
    e["receipt"]["snapshotHash"] = json!(h);
    let (raw, h) = canon(&v);
    e["intent"] = json!(raw);
    e["receipt"]["intentHash"] = json!(h);
    let mut c = db();
    history_bootstrap(&mut c, vec![e.clone()], "7").unwrap();
    let row: (String, String) = c
        .query_row(
            "SELECT state,sale_operation_id FROM sale_serial_inventory_v1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(row, ("SOLD".into(), id(100)));
    receive_event(&mut c, &ctx(), &e).unwrap();
    assert_eq!(
        c.query_row::<String, _, _>("SELECT effective_stock FROM stock_projections", [], |r| r
            .get(0))
            .unwrap(),
        "0"
    );
    assert_eq!(
        ventard_core::application::returns::read(&c, &ctx(), &id(100)).unwrap()["serials"][0]
            ["text"],
        "SERIAL-QA-HISTORY"
    );
}

fn historic_payment(method: &str) -> Value {
    let mut e = event();
    let mut v: Value = serde_json::from_str(e["intent"].as_str().unwrap()).unwrap();
    let p = &mut v["payload"]["sale"]["payment"];
    *p = json!({"method":method,"customerId":if method=="FIADO"{Some(id(30))}else{None},"paidCents":if method=="FIADO"{"0"}else{"11800"},"creditChargeCents":if method=="FIADO"{"11800"}else{"0"},"cashNetCents":if method=="EFECTIVO"{"11800"}else{"0"},"cardCents":"0","transferCents":"0","tenderCents":if method=="EFECTIVO"{"11800"}else{"0"},"changeCents":"0","turnId":if method=="EFECTIVO"{Some(id(90))}else{None},"bankSettlementVerified":false});
    e["receipt"]["effects"][2]["payload"] = p.clone();
    e["receipt"]["effects"].as_array_mut().unwrap().push(if method=="FIADO"{json!({"id":eid(&id(100),"credit"),"kind":"CREDIT","payload":{"customerId":id(30),"amountCents":"11800"}})}else{json!({"id":eid(&id(100),"cash"),"kind":"CASH","payload":{"turnId":id(90),"amountCents":"11800"}})});
    let mut s: Value = serde_json::from_str(e["snapshot"].as_str().unwrap()).unwrap();
    s["sale"] = v["payload"]["sale"].clone();
    let (raw, h) = canon(&v);
    e["intent"] = json!(raw);
    e["receipt"]["intentHash"] = json!(h);
    let (raw, h) = canon(&s);
    e["snapshot"] = json!(raw);
    e["receipt"]["snapshotHash"] = json!(h);
    e["receipt"]["remoteSequence"] = json!("2");
    e["receipt"]["stock"][0]["version"] = json!("2");
    e
}
fn captured_turn() -> Value {
    let mut v: Value = serde_json::from_str(event()["intent"].as_str().unwrap()).unwrap();
    v["operationId"] = json!(id(90));
    v["kind"] = json!("TURN_OPEN");
    v["payload"] = json!({"openingCents":"2000"});
    let (raw, h) = canon(&v);
    json!({"intent":raw,"snapshot":null,"receipt":{"protocol":"ventard.native.receipt.1","status":"APPLIED","namespace":"NATIVE1","operationId":id(90),"tenantId":ctx().tenant_id,"scope":{"type":"BRANCH","branchId":ctx().branch_id},"actorId":v["actorId"],"installationId":v["installationId"],"deviceId":v["originDeviceId"],"writerEpoch":"1","intentHash":h,"snapshotHash":null,"remoteSequence":"1","appliedAtMs":"1000","ticket":null,"ncf":null,"totalCents":null,"effects":[{"id":id(90),"kind":"TURN_OPEN","amountCents":"2000"}],"stock":[]}})
}
#[test]
fn historical_cash_and_credit_keep_current_balances_and_current_drawer_once() {
    for method in ["EFECTIVO", "FIADO"] {
        let mut c = db();
        let e = historic_payment(method);
        history_bootstrap(&mut c, vec![captured_turn(), e.clone()], "7").unwrap();
        let drawer = ventard_core::application::management::drawer(&c, &ctx(), &id(90)).unwrap();
        assert_eq!(drawer["expectedCents"], "13800");
        assert_eq!(
            c.query_row::<i64, _, _>("SELECT count(*) FROM sale_cash_entries_v1", [], |r| r
                .get(0))
                .unwrap(),
            0
        );
        assert_eq!(
            c.query_row::<i64, _, _>("SELECT count(*) FROM sale_credit_entries_v1", [], |r| r
                .get(0))
                .unwrap(),
            0
        );
        if method == "FIADO" {
            let view = ventard_core::application::returns::read(&c, &ctx(), &id(100)).unwrap();
            let req = ventard_core::application::management::Command::SaleReturn {
                operation_id: id(110),
                sale_id: id(100),
                expected_return_revision: view["revision"].as_str().unwrap().into(),
                items: vec![ventard_core::domain::return_plan::Item {
                    key: id(20),
                    quantity: "1".into(),
                }],
                serials: vec![],
                reason: "Devolución QA".into(),
                turn_id: id(90),
            };
            let document = ventard_core::application::returns::document(&c, &ctx(), &req).unwrap();
            assert_eq!(document["credit"]["beforeCents"], "20000");
            assert_eq!(document["credit"]["afterCents"], "8200");
            assert_eq!(
                c.query_row::<i64, _, _>(
                    "SELECT balance_cents FROM sale_customer_accounts_v1",
                    [],
                    |r| r.get(0)
                )
                .unwrap(),
                20000
            );
        }
        receive_event(&mut c, &ctx(), &e).unwrap();
        assert_eq!(
            ventard_core::application::management::drawer(&c, &ctx(), &id(90)).unwrap()
                ["expectedCents"],
            "13800"
        );
    }
}

#[test]
fn fresh_installation_preserves_exact_native_history_without_replaying_authority() {
    let mut c = db();
    let e = event();
    history_bootstrap(&mut c, vec![e.clone()], "7").unwrap();
    assert_eq!(
        ventard_core::application::history::ticket(&c, &ctx(), &id(100)).unwrap(),
        serde_json::from_str::<Value>(e["snapshot"].as_str().unwrap()).unwrap()
    );
    assert_eq!(
        c.query_row::<String, _, _>("SELECT effective_stock FROM stock_projections", [], |r| r
            .get(0))
            .unwrap(),
        "93"
    );
    for table in [
        "inventory_movements",
        "sale_cash_entries_v1",
        "sale_credit_entries_v1",
        "outbox",
        "cash_turns",
    ] {
        assert_eq!(
            c.query_row::<i64, _, _>(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
                .unwrap(),
            0,
            "{table}"
        );
    }
    assert_eq!(
        c.query_row::<i64, _, _>("SELECT sum(amount_cents) FROM payments", [], |r| r.get(0))
            .unwrap(),
        11800
    );
    assert_eq!(
        c.query_row::<String, _, _>("SELECT origin_device FROM operation_journal", [], |r| r
            .get(0))
            .unwrap(),
        id(10)
    );
    let prefix = c
        .query_row::<String, _, _>("SELECT prefix FROM ticket_sequences", [], |r| r.get(0))
        .unwrap();
    assert_eq!(
        prefix,
        format!("N{}", ctx().installation_id.replace('-', ""))
    );
    receive_event(&mut c, &ctx(), &e).unwrap();
    assert_eq!(
        c.query_row::<String, _, _>("SELECT effective_stock FROM stock_projections", [], |r| r
            .get(0))
            .unwrap(),
        "93"
    );
    assert_eq!(
        c.query_row::<i64, _, _>("SELECT count(*) FROM sales", [], |r| r.get(0))
            .unwrap(),
        1
    );
}

#[test]
fn corrupted_or_future_captured_history_rolls_back_entire_activation() {
    for mode in ["future", "corrupt", "duplicate", "foreign"] {
        let mut c = db();
        let mut e = event();
        let mut events = vec![];
        match mode {
            "future" => e["receipt"]["remoteSequence"] = json!("8"),
            "corrupt" => e["receipt"]["effects"]
                .as_array_mut()
                .unwrap()
                .pop()
                .map(|_| ())
                .unwrap(),
            "duplicate" => events.push(e.clone()),
            "foreign" => e["receipt"]["tenantId"] = json!(id(99)),
            _ => unreachable!(),
        }
        events.push(e);
        assert!(history_bootstrap(&mut c, events, "7").is_err(), "{mode}");
        for table in [
            "sales",
            "products",
            "native_sales_cursor_v1",
            "ticket_sequences",
            "operation_journal",
        ] {
            assert_eq!(
                c.query_row::<i64, _, _>(&format!("SELECT count(*) FROM {table}"), [], |r| r
                    .get(0))
                    .unwrap(),
                0,
                "{mode}/{table}"
            );
        }
    }
}

#[test]
#[ignore = "requires explicitly generated isolated PostgreSQL fixture"]
fn postgres_history_capture_activates_new_encrypted_installation_without_replay() {
    use ventard_core::storage::{cipher::CipherKey, writer::VaultWriter};
    let path = std::env::var("VENTARD_HISTORY_CAPTURE_FIXTURE")
        .expect("generate PostgreSQL fixture first");
    let captured: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let context: CatalogueContext =
        serde_json::from_value(captured["manifest"]["context"].clone()).unwrap();
    let now = captured["manifest"]["capturedAtMs"]
        .as_str()
        .unwrap()
        .parse::<u64>()
        .unwrap();
    let root = std::env::temp_dir().join(format!(
        "ventard-history-recovery-fixture-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir(&root).unwrap();
    let key = CipherKey::new([0x46; 32]);
    let captured_rows = captured["pages"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|p| serde_json::from_str::<Vec<Value>>(p.as_str().unwrap()).unwrap())
        .collect::<Vec<_>>();
    let original_snapshots = captured_rows
        .iter()
        .filter(|r| r["kind"] == "HISTORY_EVENT" && r["event"]["snapshot"].is_string())
        .map(|r| {
            (
                r["id"].as_str().unwrap().to_owned(),
                r["event"]["snapshot"].as_str().unwrap().to_owned(),
            )
        })
        .collect::<Vec<_>>();
    let mut writer = VaultWriter::create_encrypted(&root, &key).unwrap();
    let c = writer.connection();
    begin_bootstrap(c, &context, &captured["manifest"], now).unwrap();
    for (i, p) in captured["pages"].as_array().unwrap().iter().enumerate() {
        stage_bootstrap_page(c, &context, i, p.as_str().unwrap(), now).unwrap();
    }
    activate_bootstrap(c, &context, now, &id(1000)).unwrap();
    let pages = captured["pages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p.as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    let before = c.total_changes();
    for _ in 0..2 {
        import_history(c, &context, &captured["manifest"], &pages, now).unwrap();
    }
    assert_eq!(
        c.total_changes(),
        before,
        "history replay must be read-only for already captured facts"
    );
    c.execute("UPDATE native_sales_cursor_v1 SET sequence=0", [])
        .unwrap();
    assert_eq!(
        import_history(c, &context, &captured["manifest"], &pages, now)
            .unwrap_err()
            .code(),
        "HISTORY_SYNC_REQUIRED"
    );
    c.execute(
        "UPDATE native_sales_cursor_v1 SET sequence=?1",
        [captured["manifest"]["watermark"].as_str().unwrap()],
    )
    .unwrap();
    assert_eq!(
        c.query_row::<i64, _, _>("SELECT count(*) FROM sales", [], |r| r.get(0))
            .unwrap(),
        original_snapshots.len() as i64
    );
    for p in captured_rows.iter().filter(|r| r["kind"] == "PRODUCT") {
        assert_eq!(
            c.query_row::<String, _, _>(
                "SELECT effective_stock FROM stock_projections WHERE producto_id=?1",
                [p["id"].as_str().unwrap()],
                |r| r.get(0)
            )
            .unwrap(),
            p["stock"]["quantity"].as_str().unwrap()
        );
    }
    for table in [
        "outbox",
        "inventory_movements",
        "sale_cash_entries_v1",
        "sale_credit_entries_v1",
    ] {
        assert_eq!(
            c.query_row::<i64, _, _>(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
                .unwrap(),
            0
        );
    }
    drop(writer);
    let mut writer = VaultWriter::open_encrypted(&root, &key).unwrap();
    let c = writer.connection();
    for (op, raw) in original_snapshots {
        let saved: Vec<u8> = c
            .query_row(
                "SELECT snapshot_bytes FROM sale_ticket_snapshots_v1 WHERE operation_id=?1",
                [&op],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(saved, raw.as_bytes());
        assert_eq!(
            ventard_core::application::history::ticket(c, &context, &op).unwrap(),
            serde_json::from_str::<Value>(&raw).unwrap()
        );
    }
    assert_eq!(
        c.query_row::<String, _, _>("SELECT installation_id FROM ticket_sequences", [], |r| r
            .get(0))
            .unwrap(),
        context.installation_id
    );
    if captured["manifest"]["serviceRefunds"]
        .as_array()
        .is_some_and(|r| !r.is_empty())
    {
        let repairs = ventard_core::application::repairs::read(c, &context).unwrap();
        assert_eq!(repairs["rows"][0]["revision"], "2");
        assert_eq!(repairs["rows"][0]["state"], "cancelado");
        assert_eq!(repairs["rows"][0]["settlement"]["refundedCents"], "40");
        let turn = captured["manifest"]["turn"]["receipt"]["operationId"]
            .as_str()
            .unwrap();
        assert_eq!(
            ventard_core::application::management::drawer(c, &context, turn).unwrap()
                ["expectedCents"],
            "50060"
        );
    }
    assert!(c
        .prepare("PRAGMA foreign_key_check")
        .unwrap()
        .query([])
        .unwrap()
        .next()
        .unwrap()
        .is_none());
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
