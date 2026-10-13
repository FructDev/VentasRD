#![cfg(feature = "encrypted-storage")]
use ed25519_dalek::{Signer, SigningKey};
use rusqlite::Connection;
use serde_json::json;
use sha2::{Digest, Sha256};
use ventard_core::application::history::{self, HistoryFilter};
use ventard_core::application::sales::{self, SaleLine, SaleOptions, SalePayment, SaleRequest};
use ventard_core::{
    application::{
        checkout::*,
        drafts::{self, DraftAction, DraftActionKind},
    },
    domain::{
        canonical::canonicalize,
        identity::{EntityId, Scope, TenantRef},
        money::MoneyCents,
        quantity::Ratio,
        sale_inventory::*,
        sale_payment::*,
        sale_plan::*,
        sale_quote::Discount,
    },
    security::offline_grant::*,
    storage::{catalogue_preview::CatalogueContext, migrations},
};
#[test]
fn automatic_print_job_is_visible_durable_and_recovery_never_repeats_sale_or_os_attempt() {
    use ventard_core::application::printing;
    let mut c = sales_db();
    c.execute(
        "INSERT INTO sale_print_settings_v1 VALUES(?1,?2,1,'WINDOWS_DIALOG')",
        (id(1), id(4)),
    )
    .unwrap();
    let request = native_request(&c, options(SalePayment::Card));
    let result = sales::confirm(&mut c, &grant(2, true), 1000, 0, 0, request.clone()).unwrap();
    assert_eq!(result.print_status, "QUEUED");
    let ticket = printing::ticket(&c, &ctx(2), &result.operation_id).unwrap();
    assert_eq!(ticket["autoPrintJob"]["state"], "QUEUED");
    let attempt = ticket["autoPrintJob"]["attemptId"].as_str().unwrap();
    assert!(printing::request(
        &mut c,
        &ctx(2),
        &result.operation_id,
        ticket["printSnapshotHash"].as_str().unwrap(),
        attempt
    )
    .unwrap());
    assert!(!printing::request(
        &mut c,
        &ctx(2),
        &result.operation_id,
        ticket["printSnapshotHash"].as_str().unwrap(),
        attempt
    )
    .unwrap());
    assert_eq!(
        printing::ticket(&c, &ctx(2), &result.operation_id).unwrap()["autoPrintJob"]["state"],
        "UNKNOWN"
    );
    assert_eq!(
        sales::confirm(&mut c, &grant(2, true), 1000, 0, 0, request).unwrap(),
        result
    );
    assert_eq!(
        c.query_row("SELECT count(*) FROM payments", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        c.query_row(
            "SELECT count(*) FROM native_document_print_attempts_v1",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
}

#[test]
fn shared_opening_creates_only_a_durable_request_until_exact_server_receipt() {
    let mut c = db();
    let context = ctx(2);
    let sk = sales::scope_key(&context).unwrap();
    c.execute(
        "INSERT INTO scopes VALUES(?1,'BRANCH',?2,?3)",
        (&sk, id(5), id(1)),
    )
    .unwrap();
    c.execute(
        "INSERT INTO native_sales_cursor_v1 VALUES(?1,?2,'NATIVE1',0)",
        (id(1), &sk),
    )
    .unwrap();
    let req = ventard_core::application::sales_sync::request_shared_turn(
        &mut c,
        &grant(2, true),
        1000,
        0,
        0,
        &id(90),
        "50000",
    )
    .unwrap();
    assert_eq!(req["state"], "PREPARED");
    assert_eq!(
        c.query_row::<i64, _, _>("SELECT count(*) FROM cash_turns", [], |r| r.get(0))
            .unwrap(),
        0
    );
    assert_eq!(
        ventard_core::application::sales_sync::request_shared_turn(
            &mut c,
            &grant(2, true),
            2000,
            0,
            0,
            &id(90),
            "50000"
        )
        .unwrap(),
        req
    );
    let raw: Vec<u8> = c
        .query_row(
            "SELECT canonical_bytes FROM operation_journal WHERE operation_id=?1",
            [id(90)],
            |r| r.get(0),
        )
        .unwrap();
    let intent: serde_json::Value = serde_json::from_slice(&raw).unwrap();
    let (_, h) = canonicalize(&raw).unwrap();
    let receipt = json!({"protocol":"ventard.native.receipt.1","status":"APPLIED","namespace":"NATIVE1","operationId":id(90),"tenantId":id(1),"scope":{"type":"BRANCH","branchId":id(5)},"actorId":id(2),"installationId":id(4),"deviceId":id(3),"writerEpoch":"1","intentHash":h,"snapshotHash":null,"remoteSequence":"1","appliedAtMs":"2000","ticket":null,"ncf":null,"totalCents":null,"effects":[{"id":id(90),"kind":"TURN_OPEN","amountCents":"50000"}],"stock":[]});
    let e = json!({"receipt":receipt,"intent":String::from_utf8(raw).unwrap(),"snapshot":null});
    ventard_core::application::sales_sync::receive_event(&mut c, &context, &e).unwrap();
    assert_eq!(
        c.query_row::<i64, _, _>("SELECT opening_cents FROM cash_turns", [], |r| r.get(0))
            .unwrap(),
        50000
    );
    assert_eq!(intent["payload"]["openingCents"], "50000");
    ventard_core::application::sales_sync::receive_event(&mut c, &context, &e).unwrap();
    assert_eq!(
        c.query_row::<i64, _, _>("SELECT count(*) FROM cash_turns", [], |r| r.get(0))
            .unwrap(),
        1
    );
}
fn sales_db() -> Connection {
    let mut c = db();
    let g = grant(2, true);
    let key = format!("{}/BRANCH:{}", id(1), id(5));
    c.execute(
        "INSERT INTO scopes VALUES(?1,'BRANCH',?2,?3)",
        (&key, id(5), id(1)),
    )
    .unwrap();
    c.execute("INSERT INTO products VALUES(?1,?2,1,NULL,NULL,'Artículo sintético',?3,?4,0)",(id(11),id(1),json!({"retailCents":"10000"}).to_string(),json!({"taxRate":{"numerator":"9","denominator":"50"},"costCents":null,"serialRequired":false,"recipe":[]}).to_string())).unwrap();
    c.execute(
        "INSERT INTO stock_projections VALUES(?1,?2,'5',1,'[]','5','VERIFIED')",
        (id(11), &key),
    )
    .unwrap();
    ventard_core::application::cash::open_turn(
        &mut c,
        &g,
        1000,
        0,
        0,
        ventard_core::application::cash::TurnOpen {
            operation_id: id(90),
            opening_cents: "0".into(),
            expected_drawer_revision: "0".into(),
        },
    )
    .unwrap();
    ventard_core::application::ticket_sequence::register_ticket_seed(
        &mut c,
        &g,
        1000,
        0,
        0,
        &ventard_core::application::ticket_sequence::TicketSeedEvidence {
            prefix: "SYNTHETIC".into(),
            last_issued: 0,
            source_ref: id(91),
        },
    )
    .unwrap();
    c
}
#[test]
fn native_sales_wire_corpus_is_generated_by_real_checkout() {
    let mut c = sales_db();
    let context = ctx(2);
    let key = sales::scope_key(&context).unwrap();
    c.execute(
        "INSERT INTO native_sales_cursor_v1 VALUES(?1,?2,'NATIVE1',0)",
        (&context.tenant_id, &key),
    )
    .unwrap();
    c.execute("UPDATE stock_projections SET remote_seq=0", [])
        .unwrap();
    // The core does not trust JS. This wire corpus comes from its actual commit.
    c.execute(
        "UPDATE installations SET ticket_prefix=?1",
        [format!("N{}", context.installation_id.replace('-', ""))],
    )
    .unwrap();
    c.execute(
        "UPDATE ticket_sequences SET prefix=?1",
        [format!("N{}", context.installation_id.replace('-', ""))],
    )
    .unwrap();
    let req = native_request(&c, options(SalePayment::Card));
    sales::confirm(&mut c, &grant(2, true), 1000, 0, 0, req).unwrap();
    let intent: Vec<u8> = c
        .query_row(
            "SELECT canonical_bytes FROM operation_journal WHERE operation_id=?1",
            [id(92)],
            |r| r.get(0),
        )
        .unwrap();
    let snapshot: Vec<u8> = c
        .query_row(
            "SELECT snapshot_bytes FROM sale_ticket_snapshots_v1 WHERE operation_id=?1",
            [id(92)],
            |r| r.get(0),
        )
        .unwrap();
    let v: serde_json::Value = serde_json::from_slice(&intent).unwrap();
    assert_eq!(
        v["payload"]["sale"]["stockEvidence"][0]["remoteBaseQty"],
        "5"
    );
    let wire = json!({"context":context,"intent":String::from_utf8(intent).unwrap(),"snapshot":String::from_utf8(snapshot).unwrap()});
    let folder = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../scratch");
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::write(
        folder.join("native-sale-wire.json"),
        serde_json::to_vec(&wire).unwrap(),
    )
    .unwrap();
}
#[test]
#[ignore = "Run after sales-server.test.mjs has emitted its actual PostgreSQL receipt"]
fn postgres_receipt_roundtrip_clears_own_pending_without_second_local_sale() {
    let folder = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../scratch/native-sale-roundtrip.json");
    let event: serde_json::Value = serde_json::from_slice(&std::fs::read(folder).unwrap()).unwrap();
    let mut c = sales_db();
    let context = ctx(2);
    let key = sales::scope_key(&context).unwrap();
    c.execute(
        "INSERT INTO native_sales_cursor_v1 VALUES(?1,?2,'NATIVE1',0)",
        (&context.tenant_id, &key),
    )
    .unwrap();
    c.execute("UPDATE stock_projections SET remote_seq=0", [])
        .unwrap();
    c.execute(
        "UPDATE installations SET ticket_prefix=?1",
        [format!("N{}", context.installation_id.replace('-', ""))],
    )
    .unwrap();
    c.execute(
        "UPDATE ticket_sequences SET prefix=?1",
        [format!("N{}", context.installation_id.replace('-', ""))],
    )
    .unwrap();
    let req = native_request(&c, options(SalePayment::Card));
    let first = sales::confirm(&mut c, &grant(2, true), 1000, 0, 0, req).unwrap();
    assert_eq!(first.snapshot_hash, event["receipt"]["snapshotHash"]);
    ventard_core::application::sales_sync::receive_event(&mut c, &context, &event).unwrap();
    ventard_core::application::sales_sync::receive_event(&mut c, &context, &event).unwrap();
    assert_eq!(
        c.query_row::<i64, _, _>("SELECT count(*) FROM sales", [], |r| r.get(0))
            .unwrap(),
        1
    );
    assert_eq!(
        c.query_row::<String, _, _>("SELECT pending_coverage FROM stock_projections", [], |r| r
            .get(0))
            .unwrap(),
        "[]"
    );
    assert_eq!(
        c.query_row::<String, _, _>("SELECT effective_stock FROM stock_projections", [], |r| r
            .get(0))
            .unwrap(),
        "4"
    );
    assert_eq!(
        c.query_row::<String, _, _>(
            "SELECT state FROM outbox WHERE operation_id=?1",
            [id(92)],
            |r| r.get(0)
        )
        .unwrap(),
        "APPLIED"
    );
}
fn options(payment: SalePayment) -> SaleOptions {
    SaleOptions {
        payment,
        discount_cents: "0".into(),
        serials: Default::default(),
        customer: None,
        discount_percent_basis_points: None,
        warranty_days: None,
    }
}
#[test]
fn percent_discount_and_customer_price_tiers_match_legacy_without_floats() {
    let mut c = sales_db();
    let opts:SaleOptions=serde_json::from_value(json!({"payment":{"method":"CARD"},"discountCents":"0","discountPercentBasisPoints":"1000","serials":{}})).unwrap();
    let q = sales::quote(&c, &ctx(2), &native_lines(), &opts).unwrap();
    assert_eq!(q.total_cents, "10620");
    assert_eq!(q.discount_cents, "1180");
    c.execute("INSERT INTO sale_customer_accounts_v1 VALUES(?1,?2,?3,'Cliente P2',0,50000,1,'VERIFIED',1)",(id(96),id(1),sales::scope_key(&ctx(2)).unwrap())).unwrap();
    c.execute(
        "INSERT INTO native_sales_customer_pricing_v1 VALUES(?1,?2,2)",
        (id(96), id(1)),
    )
    .unwrap();
    c.execute(
        "UPDATE products SET price_tiers=?1",
        [json!({"retailCents":"10000","tier2Cents":"9000","tier3Cents":"8000"}).to_string()],
    )
    .unwrap();
    let mut opts = options(SalePayment::Card);
    opts.customer = Some(sales::SaleCustomer::Registered { id: id(96) });
    let q = sales::quote(&c, &ctx(2), &native_lines(), &opts).unwrap();
    assert_eq!(q.total_cents, "10620");
    let request = native_request(&c, opts);
    let result = sales::confirm(&mut c, &grant(2, true), 1000, 0, 0, request).unwrap();
    assert_eq!(result.total_cents, "10620");
    assert_eq!(
        sales::ticket(&c, &ctx(2), &id(92)).unwrap()["sale"]["lines"][0]["pricePolicy"]["tier"],
        "2"
    );
}
#[test]
fn identified_cash_customer_is_frozen_and_does_not_create_credit() {
    let mut c = sales_db();
    c.execute("INSERT INTO sale_customer_accounts_v1 VALUES(?1,?2,?3,'Nombre original',0,50000,1,'VERIFIED',1)",(id(96),id(1),format!("{}/BRANCH:{}",id(1),id(5)))).unwrap();
    let mut opts = options(SalePayment::Cash {
        tender_cents: "20000".into(),
    });
    opts.customer = Some(sales::SaleCustomer::Registered { id: id(96) });
    let req = native_request(&c, opts);
    let original = sales::confirm(&mut c, &grant(2, true), 1000, 0, 0, req.clone()).unwrap();
    c.execute(
        "UPDATE sale_customer_accounts_v1 SET name='Nombre actual',revision=2",
        [],
    )
    .unwrap();
    assert_eq!(
        sales::confirm(&mut c, &grant(2, true), 1000, 0, 0, req).unwrap(),
        original
    );
    assert_eq!(
        sales::ticket(&c, &ctx(2), &id(92)).unwrap()["customerName"],
        "Nombre original"
    );
    assert_eq!(
        c.query_row::<u32, _, _>("SELECT count(*) FROM sale_credit_entries_v1", [], |r| r
            .get(0))
            .unwrap(),
        0
    );
    assert_eq!(
        c.query_row::<i64, _, _>(
            "SELECT balance_cents FROM sale_customer_accounts_v1",
            [],
            |r| r.get(0)
        )
        .unwrap(),
        0
    );
}
#[test]
fn named_customer_changes_quote_and_invalid_credit_or_tenant_is_rejected() {
    let mut c = sales_db();
    let mut opts = options(SalePayment::Card);
    opts.customer = Some(sales::SaleCustomer::Named {
        name: "Destinatario explícito".into(),
    });
    let accepted = native_request(&c, opts.clone());
    opts.customer = Some(sales::SaleCustomer::Named {
        name: "Otro destinatario".into(),
    });
    assert_ne!(
        sales::quote(&c, &ctx(2), &native_lines(), &opts)
            .unwrap()
            .quote_hash
            .as_ref(),
        Some(&accepted.accepted_quote_hash)
    );
    sales::confirm(&mut c, &grant(2, true), 1000, 0, 0, accepted).unwrap();
    assert_eq!(
        sales::ticket(&c, &ctx(2), &id(92)).unwrap()["customerName"],
        "Destinatario explícito"
    );
    let c = sales_db();
    c.execute(
        "INSERT INTO sale_customer_accounts_v1 VALUES(?1,?2,?3,'Ajeno',0,50000,1,'VERIFIED',1)",
        (id(96), id(99), format!("{}/BRANCH:{}", id(1), id(5))),
    )
    .unwrap();
    let mut opts = options(SalePayment::Card);
    opts.customer = Some(sales::SaleCustomer::Registered { id: id(96) });
    assert!(
        !sales::quote(&c, &ctx(2), &native_lines(), &opts)
            .unwrap()
            .payable
    );
    opts.payment = SalePayment::Credit {
        customer_id: id(96),
    };
    opts.customer = Some(sales::SaleCustomer::Named {
        name: "No es referencia de fiado".into(),
    });
    assert!(
        !sales::quote(&c, &ctx(2), &native_lines(), &opts)
            .unwrap()
            .payable
    );
    assert_eq!(
        c.query_row::<u32, _, _>("SELECT count(*) FROM sales", [], |r| r.get(0))
            .unwrap(),
        0
    );
}
fn history_filter() -> HistoryFilter {
    HistoryFilter {
        search: String::new(),
        method: None,
        from_ms: None,
        to_ms: None,
        page: 1,
    }
}
#[test]
fn native_history_is_scoped_read_only_and_uses_frozen_not_current_ticket_facts() {
    let mut c = sales_db();
    let mut opts = options(SalePayment::Card);
    opts.customer = Some(sales::SaleCustomer::Named {
        name: "Cliente de contado".into(),
    });
    let req = native_request(&c, opts);
    sales::confirm(&mut c, &grant(2, true), 1000, 0, 0, req).unwrap();
    c.execute(
        "UPDATE products SET name='Nombre distinto',price_tiers='{\"retailCents\":\"99999\"}'",
        [],
    )
    .unwrap();
    let changes: u64 = c
        .query_row("SELECT total_changes()", [], |r| r.get(0))
        .unwrap();
    let result = history::read(&c, &ctx(2), history_filter()).unwrap();
    assert_eq!(result.total, "1");
    assert_eq!(result.rows.len(), 1);
    assert_eq!(
        result.rows[0].customer_name.as_deref(),
        Some("Cliente de contado")
    );
    assert_eq!(result.rows[0].total_cents, "11800");
    assert_eq!(result.rows[0].method.as_deref(), Some("TARJETA"));
    assert_eq!(result.rows[0].ticket_evidence, "VERIFIED_SNAPSHOT");
    assert_eq!(result.rows[0].remote_status, "UNVERIFIED");
    let frozen = history::ticket(&c, &ctx(2), &id(92)).unwrap();
    assert_eq!(frozen["sale"]["lines"][0]["name"], "Artículo sintético");
    let mut other = ctx(2);
    other.tenant_id = id(99);
    assert_eq!(
        history::read(&c, &other, history_filter()).unwrap().total,
        "0"
    );
    assert!(history::ticket(&c, &other, &id(92)).is_err());
    other = ctx(3);
    other.branch_id = Some(id(6));
    assert_eq!(
        history::read(&c, &other, history_filter()).unwrap().total,
        "0"
    );
    assert!(history::ticket(&c, &other, &id(92)).is_err());
    assert_eq!(
        history::read(&c, &ctx(3), history_filter()).unwrap().total,
        "1"
    );
    assert_eq!(
        changes,
        c.query_row::<u64, _, _>("SELECT total_changes()", [], |r| r.get(0))
            .unwrap()
    );
}
#[test]
fn history_distinguishes_missing_and_corrupt_snapshots_without_reconstructing_them() {
    let mut c = sales_db();
    let req = native_request(&c, options(SalePayment::Transfer));
    sales::confirm(&mut c, &grant(2, true), 1000, 0, 0, req).unwrap();
    c.execute(
        "UPDATE sale_ticket_snapshots_v1 SET snapshot_bytes=x'7b7d'",
        [],
    )
    .unwrap();
    let row = history::read(&c, &ctx(2), history_filter())
        .unwrap()
        .rows
        .remove(0);
    assert_eq!(row.ticket_evidence, "CORRUPT_SNAPSHOT");
    assert!(row.customer_name.is_none());
    assert!(history::ticket(&c, &ctx(2), &id(92)).is_err());
    c.execute("DELETE FROM sale_ticket_snapshots_v1", [])
        .unwrap();
    assert_eq!(
        history::read(&c, &ctx(2), history_filter()).unwrap().rows[0].ticket_evidence,
        "UNAVAILABLE_LEGACY"
    );
    assert!(history::ticket(&c, &ctx(2), &id(92)).is_err());
}
#[test]
fn history_filters_dates_methods_literal_search_and_bounded_pages() {
    let mut c = sales_db();
    let req = native_request(&c, options(SalePayment::Transfer));
    sales::confirm(&mut c, &grant(2, true), 1000, 0, 0, req).unwrap();
    for n in 110..=121 {
        c.execute("INSERT INTO operation_journal SELECT ?1,protocol,kind,version,canonical_bytes,hash,origin_actor,origin_scope,origin_device,origin_epoch,prepared_at,?2,'COMMITTED',result FROM operation_journal WHERE operation_id=?3",(id(n),n,id(92))).unwrap();
        c.execute("INSERT INTO sales SELECT ?1,?1,tenant_id,scope_key,turn_id,?2,ncf,actor_id,total_cents,tax_cents,discount_cents,calculation_version,created_at FROM sales WHERE operation_id=?3",(id(n),format!("LEGACY-{n}"),id(92))).unwrap();
    }
    let page = history::read(&c, &ctx(2), history_filter()).unwrap();
    assert_eq!(page.total, "13");
    assert_eq!(page.rows.len(), 10);
    let mut filter = history_filter();
    filter.page = 2;
    assert_eq!(history::read(&c, &ctx(2), filter).unwrap().rows.len(), 3);
    for (search, method, from, to, count) in [
        ("SYNTHETIC", None, None, None, "1"),
        ("%", None, None, None, "0"),
        ("", Some("EFECTIVO"), None, None, "0"),
        ("", None, Some("1001"), None, "0"),
        ("", None, Some("1000"), Some("1001"), "13"),
    ] {
        let mut filter = history_filter();
        filter.search = search.into();
        filter.method = method.map(str::to_owned);
        filter.from_ms = from.map(str::to_owned);
        filter.to_ms = to.map(str::to_owned);
        assert_eq!(history::read(&c, &ctx(2), filter).unwrap().total, count);
    }
    let mut filter = history_filter();
    filter.page = 0;
    assert!(history::read(&c, &ctx(2), filter).is_err());
}
fn native_lines() -> Vec<SaleLine> {
    vec![SaleLine {
        product_id: id(11),
        quantity: "1".into(),
        revision: "1".into(),
        free: None,
    }]
}
#[test]
fn report_preserves_original_cost_and_print_request_never_repeats_the_sale() {
    use ventard_core::application::{management, printing};
    let mut c = sales_db();
    let context = ctx(2);
    let sk = sales::scope_key(&context).unwrap();

    c.execute(
        "UPDATE products SET metadata=json_set(metadata,'$.costCents','6000')",
        [],
    )
    .unwrap();
    let req = native_request(
        &c,
        options(SalePayment::Cash {
            tender_cents: "20000".into(),
        }),
    );
    let result = sales::confirm(&mut c, &grant(2, true), 1000, 0, 0, req).unwrap();
    c.execute(
        "INSERT INTO native_sales_cursor_v1 VALUES(?1,?2,'NATIVE1',0)",
        (id(1), &sk),
    )
    .unwrap();
    let before = c.total_changes();
    let report = management::report(&c, &context, "1000", "1001").unwrap();
    assert_eq!(report["totalCents"], "11800");
    assert_eq!(report["itbisCents"], "1800");
    assert_eq!(report["profitCents"], "4000");
    assert_eq!(c.total_changes(), before);
    c.execute(
        "UPDATE products SET metadata=json_set(metadata,'$.costCents','999999')",
        [],
    )
    .unwrap();
    assert_eq!(
        management::report(&c, &context, "1000", "1001").unwrap()["profitCents"],
        "4000"
    );
    let ticket = printing::ticket(&c, &context, &result.operation_id).unwrap();
    let hash = ticket["printSnapshotHash"].as_str().unwrap();
    assert!(printing::request(&mut c, &context, &result.operation_id, hash, &id(600)).unwrap());
    assert!(!printing::request(&mut c, &context, &result.operation_id, hash, &id(600)).unwrap());
    assert!(printing::request(
        &mut c,
        &context,
        &result.operation_id,
        &"0".repeat(64),
        &id(601)
    )
    .is_err());
    let mut alien = context.clone();
    alien.tenant_id = id(99);
    assert!(printing::request(&mut c, &alien, &result.operation_id, hash, &id(602)).is_err());
    assert_eq!(
        c.query_row::<String, _, _>(
            "SELECT state FROM native_document_print_attempts_v1",
            [],
            |r| r.get(0)
        )
        .unwrap(),
        "UNKNOWN"
    );
    assert_eq!(
        c.query_row::<i64, _, _>("SELECT count(*) FROM sales", [], |r| r.get(0))
            .unwrap(),
        1
    );
    c.execute(
        "INSERT INTO native_print_attempts_v1 VALUES(?1,?2,?3,'UNKNOWN')",
        (id(603), &result.operation_id, hash),
    )
    .unwrap();
    c.execute_batch("DROP TABLE native_repair_private_outbox_v1;DROP TABLE native_repair_private_values_v1;DROP TABLE native_repair_private_intents_v1;DROP TABLE native_document_print_attempts_v1;DELETE FROM migration_history WHERE version>=14;PRAGMA user_version=13;").unwrap();
    migrations::apply(&mut c).unwrap();
    assert!(!printing::request(&mut c, &context, &result.operation_id, hash, &id(603)).unwrap());
    assert_eq!(
        printing::ticket(&c, &context, &result.operation_id).unwrap()["printAttempt"]["attemptId"],
        id(603)
    );
}
fn native_request(c: &Connection, options: SaleOptions) -> SaleRequest {
    let quote = sales::quote(c, &ctx(2), &native_lines(), &options).unwrap();
    SaleRequest {
        operation_id: id(92),
        cart_id: id(21),
        expected_cart_revision: "1".into(),
        accepted_quote_hash: quote.quote_hash.unwrap(),
        lines: native_lines(),
        options,
        fiscal_type: None,
    }
}
#[test]
fn full_native_cash_sale_commits_all_effects_and_replay_once() {
    let mut c = sales_db();
    let req = native_request(
        &c,
        options(SalePayment::Cash {
            tender_cents: "20000".into(),
        }),
    );
    let result = sales::confirm(&mut c, &grant(2, true), 1000, 0, 0, req.clone()).unwrap();
    assert_eq!(result.total_cents, "11800");
    assert_eq!(result.change_cents, "8200");
    for _ in 0..100 {
        assert_eq!(
            sales::confirm(&mut c, &grant(2, true), 1000, 0, 0, req.clone()).unwrap(),
            result
        );
    }
    for table in [
        "sales",
        "sale_lines",
        "payments",
        "inventory_movements",
        "sale_ticket_snapshots_v1",
        "sale_cart_consumptions_v1",
        "sale_cash_entries_v1",
    ] {
        assert_eq!(
            c.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r
                .get::<_, u32>(0))
                .unwrap(),
            1,
            "{table}"
        );
    }
    assert_eq!(
        c.query_row("SELECT effective_stock FROM stock_projections", [], |r| {
            r.get::<_, String>(0)
        })
        .unwrap(),
        "4"
    );
    assert_eq!(
        c.query_row(
            "SELECT count(*) FROM outbox WHERE operation_id=?1",
            [id(92)],
            |r| r.get::<_, u32>(0)
        )
        .unwrap(),
        1
    );
    assert_eq!(
        c.query_row("SELECT costo_cents FROM sale_lines", [], |r| r
            .get::<_, Option<i64>>(0))
            .unwrap(),
        None
    );
    assert_eq!(result.remote_status, "PENDING");
}
#[test]
fn native_card_and_transfer_without_turn_do_not_manufacture_cash() {
    for payment in [SalePayment::Card, SalePayment::Transfer] {
        let mut c = sales_db();
        c.execute("UPDATE cash_turns SET status='CLOSED'", [])
            .unwrap();
        let req = native_request(&c, options(payment));
        sales::confirm(&mut c, &grant(2, true), 1000, 0, 0, req).unwrap();
        assert_eq!(
            c.query_row("SELECT turn_id FROM sales", [], |r| r
                .get::<_, Option<String>>(0))
                .unwrap(),
            None
        );
        assert_eq!(
            c.query_row("SELECT count(*) FROM sale_cash_entries_v1", [], |r| r
                .get::<_, u32>(0))
                .unwrap(),
            0
        );
    }
}
#[test]
fn native_mixed_and_credit_persist_exact_breakdown_and_debt() {
    let mut c = sales_db();
    let req = native_request(
        &c,
        options(SalePayment::Mixed {
            cash_cents: "1800".into(),
            transfer_cents: "10000".into(),
            tender_cents: "2000".into(),
        }),
    );
    let r = sales::confirm(&mut c, &grant(2, true), 1000, 0, 0, req).unwrap();
    assert_eq!(r.change_cents, "200");
    assert_eq!(
        c.query_row("SELECT sum(amount_cents) FROM payments", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        11800
    );
    assert_eq!(
        c.query_row("SELECT amount_cents FROM sale_cash_entries_v1", [], |r| r
            .get::<_, i64>(
            0
        ))
        .unwrap(),
        1800
    );
    let mut c = sales_db();
    c.execute("INSERT INTO sale_customer_accounts_v1 VALUES(?1,?2,?3,'Cliente sintético',0,50000,1,'VERIFIED',1)",(id(96),id(1),format!("{}/BRANCH:{}",id(1),id(5)))).unwrap();
    let req = native_request(
        &c,
        options(SalePayment::Credit {
            customer_id: id(96),
        }),
    );
    sales::confirm(&mut c, &grant(2, true), 1000, 0, 0, req).unwrap();
    assert_eq!(
        c.query_row(
            "SELECT balance_cents FROM sale_customer_accounts_v1",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        11800
    );
    assert_eq!(
        c.query_row("SELECT count(*) FROM payments", [], |r| r.get::<_, u32>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        c.query_row("SELECT count(*) FROM sale_credit_entries_v1", [], |r| r
            .get::<_, u32>(0))
            .unwrap(),
        1
    );
}
#[test]
fn native_sale_fault_rolls_back_ticket_stock_payment_cart_print_and_preserves_attempt() {
    let mut c = sales_db();
    let req = native_request(
        &c,
        options(SalePayment::Cash {
            tender_cents: "20000".into(),
        }),
    );
    c.execute_batch("CREATE TRIGGER sale_fault BEFORE INSERT ON sale_cash_entries_v1 BEGIN SELECT RAISE(ABORT,'synthetic fault');END;").unwrap();
    assert!(sales::confirm(&mut c, &grant(2, true), 1000, 0, 0, req.clone()).is_err());
    for table in [
        "sales",
        "payments",
        "inventory_movements",
        "ticket_allocations",
        "sale_cart_consumptions_v1",
        "sale_ticket_snapshots_v1",
        "sale_print_jobs_v1",
    ] {
        assert_eq!(
            c.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r
                .get::<_, u32>(0))
                .unwrap(),
            0,
            "{table}"
        );
    }
    assert_eq!(
        c.query_row("SELECT effective_stock FROM stock_projections", [], |r| {
            r.get::<_, String>(0)
        })
        .unwrap(),
        "5"
    );
    assert_eq!(
        c.query_row(
            "SELECT local_state FROM operation_journal WHERE operation_id=?1",
            [id(92)],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "PREPARED"
    );
    c.execute_batch("DROP TRIGGER sale_fault").unwrap();
    assert_eq!(
        sales::confirm(&mut c, &grant(2, true), 1000, 0, 0, req)
            .unwrap()
            .ticket,
        "SYNTHETIC-000001"
    );
}
#[test]
fn native_sale_denies_stale_quote_unknown_stock_changed_identity_and_missing_sell() {
    let mut c = sales_db();
    let req = native_request(&c, options(SalePayment::Card));
    assert!(sales::confirm(&mut c, &grant(2, false), 1000, 0, 0, req.clone()).is_err());
    c.execute("UPDATE products SET revision=2", []).unwrap();
    assert!(sales::confirm(&mut c, &grant(2, true), 1000, 0, 0, req.clone()).is_err());
    c.execute("UPDATE products SET revision=1", []).unwrap();
    c.execute("UPDATE stock_projections SET authority_state='UNKNOWN'", [])
        .unwrap();
    assert!(sales::confirm(&mut c, &grant(2, true), 1000, 0, 0, req.clone()).is_err());
    c.execute(
        "UPDATE stock_projections SET authority_state='VERIFIED'",
        [],
    )
    .unwrap();
    sales::confirm(&mut c, &grant(2, true), 1000, 0, 0, req.clone()).unwrap();
    let mut changed = req;
    changed.options.discount_cents = "1".into();
    assert_eq!(
        sales::confirm(&mut c, &grant(2, true), 1000, 0, 0, changed)
            .unwrap_err()
            .code(),
        "OPERATION_ID_CONFLICT"
    );
}
#[test]
fn native_free_sale_is_explicit_and_has_no_invented_product_or_stock_effect() {
    let mut c = sales_db();
    c.execute(
        "INSERT INTO sale_free_settings_v1 VALUES(?1,?2,?3)",
        (
            id(1),
            format!("{}/BRANCH:{}", id(1), id(5)),
            json!({"numerator":"9","denominator":"50"}).to_string(),
        ),
    )
    .unwrap();
    let lines:Vec<SaleLine>=serde_json::from_value(json!([{"productId":id(98),"quantity":"2","revision":"1","free":{"name":"Servicio libre sintético","unitPriceCents":"10000"}}])).unwrap();
    let opts = options(SalePayment::Card);
    let q = sales::quote(&c, &ctx(2), &lines, &opts).unwrap();
    let key = format!("{:x}", Sha256::digest(serde_json::to_vec(&ctx(2)).unwrap()));
    c.execute(
        "UPDATE account_drafts SET lines=?2 WHERE context_key=?1",
        (
            &key,
            json!([{"productId":id(98),"quantity":"2","revision":"1"}]).to_string(),
        ),
    )
    .unwrap();
    let req = SaleRequest {
        operation_id: id(92),
        cart_id: id(21),
        expected_cart_revision: "1".into(),
        accepted_quote_hash: q.quote_hash.unwrap(),
        lines,
        options: opts,
        fiscal_type: None,
    };
    let result = sales::confirm(&mut c, &grant(2, true), 1000, 0, 0, req).unwrap();
    assert_eq!(result.total_cents, "23600");
    assert_eq!(
        c.query_row("SELECT producto_id FROM sale_lines", [], |r| r
            .get::<_, Option<String>>(0))
            .unwrap(),
        None
    );
    assert_eq!(
        c.query_row("SELECT count(*) FROM inventory_movements", [], |r| r
            .get::<_, u32>(0))
            .unwrap(),
        0
    );
}
#[test]
fn native_serial_fiscal_and_print_snapshot_are_atomic_exact_and_recoverable() {
    use ventard_core::fiscal::reservations::{
        store_allocated_block, AllocatedBlockEvidence, NcfKind,
    };
    let mut c = sales_db();
    let key = format!("{}/BRANCH:{}", id(1), id(5));
    let g = grant(2, true);
    c.execute(
        "UPDATE products SET metadata=json_set(metadata,'$.serialRequired',json('true'))",
        [],
    )
    .unwrap();
    c.execute("INSERT INTO sale_serial_inventory_v1 VALUES(?1,?2,?3,'000012345678901','1','AVAILABLE',NULL)",(id(1),&key,id(11))).unwrap();
    c.execute(
        "INSERT INTO sale_print_settings_v1 VALUES(?1,?2,1,NULL)",
        (id(1), id(4)),
    )
    .unwrap();
    store_allocated_block(
        &mut c,
        &g,
        1000,
        0,
        0,
        &AllocatedBlockEvidence {
            request_id: id(100),
            tenant_id: id(1),
            device_id: id(3),
            installation_id: id(4),
            writer_epoch: "1".into(),
            kind: NcfKind::B02,
            first: 1,
            last: 20,
            source_ref: id(101),
        },
    )
    .unwrap();
    let mut opts = options(SalePayment::Card);
    opts.serials.insert(id(11), "000012345678901".into());
    opts.warranty_days = Some("45".into());
    let mut req = native_request(&c, opts);
    req.fiscal_type = Some("B02".into());
    c.execute_batch("CREATE TRIGGER print_fault BEFORE INSERT ON sale_print_jobs_v1 BEGIN SELECT RAISE(ABORT,'synthetic print failure');END;").unwrap();
    assert!(sales::confirm(&mut c, &g, 1000, 0, 0, req.clone()).is_err());
    assert_eq!(
        c.query_row("SELECT state FROM sale_serial_inventory_v1", [], |r| r
            .get::<_, String>(
            0
        ))
        .unwrap(),
        "AVAILABLE"
    );
    assert_eq!(
        c.query_row("SELECT state FROM fiscal_reservations", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        "PREPARED"
    );
    assert_eq!(
        c.query_row("SELECT count(*) FROM sale_ticket_snapshots_v1", [], |r| r
            .get::<_, u32>(
            0
        ))
        .unwrap(),
        0
    );
    c.execute_batch("DROP TRIGGER print_fault").unwrap();
    let result = sales::confirm(&mut c, &g, 1000, 0, 0, req.clone()).unwrap();
    assert_eq!(result.ncf, Some("B0200000001".into()));
    let original: Vec<u8> = c
        .query_row(
            "SELECT canonical_bytes FROM operation_journal WHERE operation_id=?1",
            [&result.operation_id],
            |r| r.get(0),
        )
        .unwrap();
    let original: serde_json::Value = serde_json::from_slice(&original).unwrap();
    assert_eq!(
        original["payload"]["sale"]["serials"][0]["warrantyDays"],
        "45"
    );
    assert_eq!(original["originAtUtcMs"], "1000");
    assert_eq!(result.print_status, "WAITING_CONFIGURATION");
    assert_eq!(
        c.query_row("SELECT serial FROM sale_lines", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        "000012345678901"
    );
    assert_eq!(
        c.query_row("SELECT state FROM fiscal_reservations", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        "COMMITTED"
    );
    assert_eq!(sales::confirm(&mut c, &g, 1000, 0, 0, req).unwrap(), result);
    assert_eq!(
        c.query_row("SELECT count(*) FROM sale_print_jobs_v1", [], |r| r
            .get::<_, u32>(0))
            .unwrap(),
        1
    );
    let ticket = sales::ticket(&c, &ctx(2), &id(92)).unwrap();
    assert_eq!(ticket["sale"]["lines"][0]["serial"], "000012345678901");
    assert_eq!(ticket["sale"]["payment"]["bankSettlementVerified"], false);
}
#[test]
fn complete_sales_upgrade_preserves_v10_sales_payments_and_foreign_keys() {
    let mut c = Connection::open_in_memory().unwrap();
    c.execute_batch("PRAGMA foreign_keys=ON; CREATE TABLE migration_history(version INTEGER PRIMARY KEY,name TEXT NOT NULL,checksum TEXT NOT NULL);").unwrap();
    for m in migrations::get_embedded_migrations()
        .into_iter()
        .filter(|m| m.version <= 10)
    {
        c.execute_batch(m.sql).unwrap();
        c.execute(
            "INSERT INTO migration_history VALUES(?1,?2,?3)",
            (m.version, m.name, m.checksum),
        )
        .unwrap();
    }
    c.pragma_update(None, "user_version", 10).unwrap();
    c.execute(
        "INSERT INTO scopes VALUES(?1,'BRANCH',?2,?3)",
        ("preserved-scope", id(5), id(1)),
    )
    .unwrap();
    c.execute("INSERT INTO operation_journal VALUES(?1,'legacy-fixture','SALE',1,x'7b7d',?2,?3,'preserved-scope',?4,1,'1000',1,'COMMITTED','{}')", (id(92),"0".repeat(64),id(2),id(3))).unwrap();
    c.execute("INSERT INTO sales VALUES(?1,?1,?2,'preserved-scope','historical-turn','OLD-000007',NULL,?3,11800,1800,0,'legacy','1000')", (id(92),id(1),id(2))).unwrap();
    c.execute("INSERT INTO sale_lines VALUES(?1,?2,NULL,'Nombre histórico',10000,'18',NULL,7000,'1','000012345678901')",(id(93),id(92))).unwrap();
    c.execute(
        "INSERT INTO payments VALUES(?1,?2,?2,NULL,'EFECTIVO',11800,20000,8200,'historical-turn')",
        (id(94), id(92)),
    )
    .unwrap();
    let before: String = c.query_row("SELECT json_array(s.ticket,s.turn_id,s.total_cents,l.nombre,l.costo_cents,l.serial,p.amount_cents,p.change_cents,p.turn_id) FROM sales s JOIN sale_lines l ON l.sale_id=s.sale_id JOIN payments p ON p.sale_id=s.sale_id",[],|r|r.get(0)).unwrap();
    migrations::apply(&mut c).unwrap();
    let after: String = c.query_row("SELECT json_array(s.ticket,s.turn_id,s.total_cents,l.nombre,l.costo_cents,l.serial,p.amount_cents,p.change_cents,p.turn_id) FROM sales s JOIN sale_lines l ON l.sale_id=s.sale_id JOIN payments p ON p.sale_id=s.sale_id",[],|r|r.get(0)).unwrap();
    assert_eq!(before, after);
    assert_eq!(migrations::validate_history(&c).unwrap(), 20);
    assert_eq!(
        c.query_row::<u32, _, _>("SELECT count(*) FROM pragma_foreign_key_check", [], |r| r
            .get(0))
            .unwrap(),
        0
    );
    assert!(c
        .execute(
            "INSERT INTO sale_lines VALUES(?1,'missing',NULL,'Orphan',1,'0',NULL,NULL,'1',NULL)",
            [id(95)]
        )
        .is_err());
    // A historical operation did not acquire a fabricated ticket snapshot/receipt.
    assert_eq!(
        c.query_row::<u32, _, _>("SELECT count(*) FROM sale_ticket_snapshots_v1", [], |r| r
            .get(0))
            .unwrap(),
        0
    );
    migrations::apply(&mut c).unwrap();
    assert_eq!(
        c.query_row::<u32, _, _>("SELECT count(*) FROM sales", [], |r| r.get(0))
            .unwrap(),
        1
    );
}
fn id(n: u32) -> String {
    format!("96000000-0000-4000-8000-{n:012}")
}
fn entity(n: u32) -> EntityId {
    EntityId::parse(&id(n)).unwrap()
}
fn money(n: i64) -> MoneyCents {
    MoneyCents::from_cents(n).unwrap()
}
fn scope() -> Scope {
    Scope::Branch(entity(5))
}
fn grant(actor: u32, sell: bool) -> VerifiedGrant {
    let key = SigningKey::from_bytes(&[0x31; 32]);
    let p = json!({"protocol":"ventard.offline-grant.v1","keyId":"checkout-fixture-1","issuer":"ventard.staging","audience":"ventard.native.staging.v1","grantId":id(10),"grantSequence":"1","policyVersion":"1","tenantId":id(1),"actorId":id(actor),"deviceId":id(3),"installationId":id(4),"writerEpoch":"1","scope":{"type":"BRANCH","branchId":id(5)},"role":"seller","capabilities":if sell {vec!["READ","SELL"]}else{vec!["READ"]},"issuedAtMs":"1000","actorExpiresAtMs":null,"license":{"planActive":true,"accessUntilMs":null,"trialUntilMs":null,"graceDays":"5","warnAfterOpenings":"200","blockAfterOpenings":"300"}});
    let (raw, _) = canonicalize(&serde_json::to_vec(&p).unwrap()).unwrap();
    let signature = key
        .sign(raw.as_bytes())
        .to_bytes()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    verify_grant(
        &serde_json::to_vec(&json!({"payload":p,"signature":signature})).unwrap(),
        &[TrustedGrantKey::new("checkout-fixture-1", key.verifying_key().to_bytes()).unwrap()],
        &GrantContext {
            tenant_id: id(1),
            actor_id: id(actor),
            device_id: id(3),
            installation_id: id(4),
            writer_epoch: "1".into(),
            scope_type: "BRANCH".into(),
            branch_id: Some(id(5)),
            min_grant_sequence: "1".into(),
            audience: "ventard.native.staging.v1".into(),
        },
    )
    .unwrap()
}
fn ctx(actor: u32) -> CatalogueContext {
    CatalogueContext {
        tenant_id: id(1),
        actor_id: id(actor),
        device_id: id(3),
        installation_id: id(4),
        writer_epoch: "1".into(),
        scope_type: "BRANCH".into(),
        branch_id: Some(id(5)),
    }
}
fn product() -> SaleProductFacts {
    SaleProductFacts {
        inventory: InventoryProduct {
            reference: TenantRef {
                negocio_id: entity(1),
                id: entity(11),
            },
            scope: scope(),
            revision: "metadata-1".into(),
            deleted: false,
            serial_required: false,
            recipe: vec![],
            authority: Some(StockAuthority {
                available: 5,
                revision: "stock-1".into(),
                verified: true,
            }),
        },
        name: "Artículo sintético".into(),
        unit_price: money(10000),
        tax_rate: Ratio::parse_legacy_decimal("0.18").unwrap(),
        cost: None,
    }
}
fn selected() -> SaleSelection {
    SaleSelection::Product(InventoryLine {
        product_id: entity(11),
        quantity: Ratio::one(),
        expected_revision: "metadata-1".into(),
        serial: None,
    })
}
fn turn() -> PaymentTurn {
    PaymentTurn {
        id: entity(40),
        tenant_id: entity(1),
        scope: scope(),
        open: true,
    }
}
fn plan(payment: Payment) -> ValidatedSale {
    plan_sale(
        entity(1),
        scope(),
        &[selected()],
        &[product()],
        &[],
        &Discount::Amount(MoneyCents::ZERO),
        &payment,
        Some(&turn()),
        None,
    )
    .unwrap()
}
fn request(op: u32, p: &ValidatedSale) -> CheckoutPrepare {
    CheckoutPrepare {
        operation_id: id(op),
        cart_id: id(21),
        expected_revision: "1".into(),
        accepted_quote_hash: p.quote_hash().into(),
        fiscal_type: None,
    }
}
fn db() -> Connection {
    let mut c = Connection::open_in_memory().unwrap();
    c.pragma_update(None, "foreign_keys", true).unwrap();
    migrations::apply(&mut c).unwrap();
    populate(&c);
    c
}
fn populate(c: &Connection) {
    c.execute(
        "INSERT INTO vault_meta VALUES(?1,?2,8,'synthetic','SQLCipher','ACTIVE',0)",
        (id(6), id(1)),
    )
    .unwrap();
    c.execute(
        "INSERT INTO installations VALUES(?1,?2,1,'SYNTHETIC','1000','ACTIVE')",
        (id(4), id(3)),
    )
    .unwrap();
    let k = format!("{:x}", Sha256::digest(serde_json::to_vec(&ctx(2)).unwrap()));
    c.execute(
        "INSERT INTO account_drafts VALUES(?1,?2,1,1,'ACTIVE',?3)",
        (
            k,
            id(21),
            json!([{"productId":id(11),"quantity":"1","revision":id(22)}]).to_string(),
        ),
    )
    .unwrap();
}
fn no_effects(c: &Connection) {
    for table in [
        "sales",
        "payments",
        "inventory_movements",
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
}
#[test]
fn quote_payment_inventory_are_one_pure_plan_and_unknown_cost_stays_null() {
    let p = plan(Payment::Cash {
        tender: money(20000),
    });
    let v = p.payload();
    assert_eq!(v["totals"]["totalCents"], "11800");
    assert_eq!(v["payment"]["changeCents"], "8200");
    assert_eq!(v["payment"]["cashNetCents"], "11800");
    assert_eq!(v["inventory"][0]["delta"], "-1");
    assert!(v["lines"][0]["costCents"].is_null());
    assert_eq!(
        p.quote_hash(),
        plan(Payment::Cash {
            tender: money(20000)
        })
        .quote_hash()
    );
    assert_ne!(
        p.quote_hash(),
        plan(Payment::Cash {
            tender: money(20001)
        })
        .quote_hash()
    );
}
#[test]
fn unknown_stock_and_wrong_scope_never_become_payable() {
    let mut f = product();
    f.inventory.authority.as_mut().unwrap().verified = false;
    assert_eq!(
        plan_sale(
            entity(1),
            scope(),
            &[selected()],
            &[f],
            &[],
            &Discount::Amount(MoneyCents::ZERO),
            &Payment::Card,
            None,
            None
        )
        .unwrap_err()
        .code(),
        "STOCK_UNVERIFIED"
    );
    let mut f = product();
    f.inventory.scope = Scope::Global;
    assert_eq!(
        plan_sale(
            entity(1),
            scope(),
            &[selected()],
            &[f],
            &[],
            &Discount::Amount(MoneyCents::ZERO),
            &Payment::Card,
            None,
            None
        )
        .unwrap_err()
        .code(),
        "SCOPE_INVALID"
    );
}
#[test]
fn prepared_checkout_replays_original_bytes_timestamp_and_sequence_without_effects() {
    let mut c = db();
    let p = plan(Payment::Cash {
        tender: money(20000),
    });
    let g = grant(2, true);
    let first = prepare_checkout(&mut c, &g, 2000, 2000, 1, request(30, &p), &p).unwrap();
    for _ in 0..100 {
        assert_eq!(
            prepare_checkout(&mut c, &g, 3000, 3000, 2, request(30, &p), &p).unwrap(),
            first
        );
    }
    assert_eq!(first.state, "PREPARED");
    assert_eq!(first.intent["originAtUtcMs"], "2000");
    assert_eq!(first.intent["installationId"], id(4));
    assert!(first.result.is_none());
    assert_eq!(
        read_checkout(&c, &g, 3000, 3000, 2, &id(30), &first.hash).unwrap(),
        first
    );
    assert_eq!(
        c.query_row::<i64, _, _>("SELECT count(*) FROM operation_journal", [], |r| r.get(0))
            .unwrap(),
        1
    );
    no_effects(&c);
}
#[test]
fn identity_payload_conflict_stale_cart_and_second_intent_are_rejected() {
    let mut c = db();
    let g = grant(2, true);
    let p = plan(Payment::Card);
    let first = prepare_checkout(&mut c, &g, 2000, 2000, 1, request(30, &p), &p).unwrap();
    let altered = plan(Payment::Transfer);
    assert_eq!(
        prepare_checkout(&mut c, &g, 2000, 2000, 1, request(30, &altered), &altered)
            .unwrap_err()
            .code(),
        "OPERATION_ID_CONFLICT"
    );
    assert_eq!(
        prepare_checkout(&mut c, &g, 2000, 2000, 1, request(31, &p), &p)
            .unwrap_err()
            .code(),
        "VERSION_CONFLICT"
    );
    let mut stale = request(32, &p);
    stale.expected_revision = "2".into();
    assert!(prepare_checkout(&mut c, &g, 2000, 2000, 1, stale, &p).is_err());
    assert_eq!(
        read_checkout(&c, &g, 2000, 2000, 1, &id(30), &first.hash).unwrap(),
        first
    );
    no_effects(&c);
}
#[test]
fn preparation_locks_real_account_draft_until_explicit_abandon() {
    let mut c = db();
    let g = grant(2, true);
    let p = plan(Payment::Transfer);
    let first = prepare_checkout(&mut c, &g, 2000, 2000, 1, request(30, &p), &p).unwrap();
    let pause = |op| DraftAction {
        request_id: id(op),
        action: DraftActionKind::Pause,
        cart_id: id(21),
        expected_revision: "1".into(),
        active_cart_id: None,
        active_revision: None,
    };
    assert_eq!(
        drafts::action(&mut c, &ctx(2), pause(50))
            .unwrap_err()
            .code(),
        "VERSION_CONFLICT"
    );
    abandon_checkout(&mut c, &g, 2000, 2000, 1, &id(30), &first.hash).unwrap();
    abandon_checkout(&mut c, &g, 2000, 2000, 1, &id(30), &first.hash).unwrap();
    assert_eq!(
        read_checkout(&c, &g, 2000, 2000, 1, &id(30), &first.hash)
            .unwrap()
            .state,
        "ABANDONED"
    );
    assert!(prepare_checkout(&mut c, &g, 2000, 2000, 1, request(30, &p), &p).is_err());
    assert!(drafts::action(&mut c, &ctx(2), pause(51)).is_ok());
    no_effects(&c);
}
#[test]
fn no_permission_read_only_installation_or_other_actor_never_writes_or_leaks() {
    let mut c = db();
    let p = plan(Payment::Card);
    assert_eq!(
        prepare_checkout(&mut c, &grant(2, false), 2000, 2000, 1, request(30, &p), &p)
            .unwrap_err()
            .code(),
        "PERMISSION_DENIED"
    );
    c.execute("UPDATE vault_meta SET activation_state='READ_ONLY'", [])
        .unwrap();
    assert_eq!(
        prepare_checkout(&mut c, &grant(2, true), 2000, 2000, 1, request(30, &p), &p)
            .unwrap_err()
            .code(),
        "PERMISSION_DENIED"
    );
    assert_eq!(
        c.query_row::<i64, _, _>("SELECT count(*) FROM operation_journal", [], |r| r.get(0))
            .unwrap(),
        0
    );
    c.execute("UPDATE vault_meta SET activation_state='ACTIVE'", [])
        .unwrap();
    let first =
        prepare_checkout(&mut c, &grant(2, true), 2000, 2000, 1, request(30, &p), &p).unwrap();
    assert_eq!(
        read_checkout(&c, &grant(9, true), 2000, 2000, 1, &id(30), &first.hash)
            .unwrap_err()
            .code(),
        "PERMISSION_DENIED"
    );
    no_effects(&c);
}
#[test]
fn checkout_and_journal_rollback_together_when_persistence_fails() {
    let mut c = db();
    let p = plan(Payment::Card);
    let g = grant(2, true);
    c.execute_batch("CREATE TRIGGER fail_checkout BEFORE INSERT ON checkout_drafts BEGIN SELECT RAISE(ABORT,'synthetic failure');END;").unwrap();
    assert!(prepare_checkout(&mut c, &g, 2000, 2000, 1, request(30, &p), &p).is_err());
    assert_eq!(
        c.query_row::<i64, _, _>("SELECT count(*) FROM operation_journal", [], |r| r.get(0))
            .unwrap(),
        0
    );
    no_effects(&c);
    c.execute_batch("DROP TRIGGER fail_checkout;").unwrap();
    assert!(prepare_checkout(&mut c, &g, 2000, 2000, 1, request(30, &p), &p).is_ok());
}
#[test]
fn mixed_credit_and_free_lines_keep_exact_totals_and_no_fake_stock() {
    let mixed = plan(Payment::Mixed {
        cash: money(5000),
        transfer: money(6800),
        tender: money(10000),
    })
    .payload();
    assert_eq!(mixed["payment"]["changeCents"], "5000");
    assert_eq!(mixed["payment"]["transferCents"], "6800");
    assert!(!mixed["payment"]["bankSettlementVerified"]
        .as_bool()
        .unwrap());
    let credit = CreditContext {
        customer_id: entity(60),
        tenant_id: entity(1),
        scope: Scope::Global,
        balance: money(100),
        limit: Some(MoneyCents::ZERO),
        active: true,
        verified: true,
    };
    let p = plan_sale(
        entity(1),
        scope(),
        &[selected()],
        &[product()],
        &[],
        &Discount::Amount(MoneyCents::ZERO),
        &Payment::Credit {
            customer_id: entity(60),
        },
        None,
        Some(&credit),
    )
    .unwrap()
    .payload();
    assert_eq!(p["payment"]["creditChargeCents"], "11800");
    assert_eq!(p["payment"]["paidCents"], "0");
    assert!(p["payment"]["turnId"].is_null());
    use ventard_core::domain::sale_quote::HistoricalQuoteLine;
    let free = SaleSelection::Free(HistoricalQuoteLine {
        product_id: None,
        product_revision: None,
        name: "Servicio sintético".into(),
        unit_price: money(3),
        quantity: Ratio::one(),
        tax_rate: Ratio::parse_legacy_decimal("0.18").unwrap(),
        cost: None,
        recipe: vec![],
        serial: None,
    });
    let p = plan_sale(
        entity(1),
        scope(),
        &[free.clone(), free],
        &[],
        &[],
        &Discount::Amount(MoneyCents::ZERO),
        &Payment::Card,
        None,
        None,
    )
    .unwrap()
    .payload();
    assert_eq!(p["totals"]["itbisCents"], "1");
    assert_eq!(p["totals"]["totalCents"], "7");
    assert_eq!(p["inventory"], json!([]));
}
#[test]
fn recipe_and_serial_snapshots_are_frozen_and_table_order_does_not_change_hash() {
    let mut combo = product();
    combo.inventory.recipe = vec![RecipePart {
        product_id: entity(12),
        per_unit: Ratio::from_integer(2),
    }];
    combo.inventory.authority = None;
    let mut ingredient = product();
    ingredient.inventory.reference.id = entity(12);
    let a = plan_sale(
        entity(1),
        scope(),
        &[selected()],
        &[combo.clone(), ingredient.clone()],
        &[],
        &Discount::Amount(MoneyCents::ZERO),
        &Payment::Card,
        None,
        None,
    )
    .unwrap();
    let b = plan_sale(
        entity(1),
        scope(),
        &[selected()],
        &[ingredient, combo],
        &[],
        &Discount::Amount(MoneyCents::ZERO),
        &Payment::Card,
        None,
        None,
    )
    .unwrap();
    assert_eq!(a.quote_hash(), b.quote_hash());
    assert_eq!(a.payload()["inventory"][0]["delta"], "-2");
    assert_eq!(
        a.payload()["lines"][0]["recipe"][0]["revision"],
        "metadata-1"
    );
    let mut p = product();
    p.inventory.serial_required = true;
    let mut l = match selected() {
        SaleSelection::Product(l) => l,
        _ => unreachable!(),
    };
    l.serial = Some("000012345678901".into());
    let s = SerialAvailability {
        text: l.serial.clone().unwrap(),
        product_id: entity(11),
        tenant_id: entity(1),
        scope: scope(),
        available: true,
        revision: "serial-1".into(),
    };
    let p = plan_sale(
        entity(1),
        scope(),
        &[SaleSelection::Product(l)],
        &[p],
        &[s],
        &Discount::Amount(MoneyCents::ZERO),
        &Payment::Card,
        None,
        None,
    )
    .unwrap()
    .payload();
    assert_eq!(p["serials"][0]["text"], "000012345678901");
}
#[test]
fn quote_ack_and_cart_content_are_checked_without_preparing_wrong_sale() {
    let mut c = db();
    let p = plan(Payment::Card);
    let g = grant(2, true);
    let mut req = request(30, &p);
    req.accepted_quote_hash = "0".repeat(64);
    assert_eq!(
        prepare_checkout(&mut c, &g, 2000, 2000, 1, req, &p)
            .unwrap_err()
            .code(),
        "CONTRACT_INVALID"
    );
    c.execute(
        "UPDATE account_drafts SET lines=?1",
        [json!([{"productId":id(11),"quantity":"2","revision":id(22)}]).to_string()],
    )
    .unwrap();
    assert_eq!(
        prepare_checkout(&mut c, &g, 2000, 2000, 1, request(30, &p), &p)
            .unwrap_err()
            .code(),
        "VERSION_CONFLICT"
    );
    assert_eq!(
        c.query_row::<i64, _, _>("SELECT count(*) FROM operation_journal", [], |r| r.get(0))
            .unwrap(),
        0
    );
    no_effects(&c);
}
#[test]
fn local_encrypted_reopen_recovers_preparation_and_v7_upgrade_preserves_pin_and_cart() {
    use ventard_core::{
        security::local_auth::{enroll_pin, unlock_pin},
        storage::{cipher::CipherKey, writer::VaultWriter},
    };
    use zeroize::Zeroizing;
    let path =
        std::env::temp_dir().join(format!("ventard-checkout-fixture-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&path).unwrap();
    let key = CipherKey::new([0x61; 32]);
    let g = grant(2, true);
    let pin = Zeroizing::new("5193".to_owned());
    let p = plan(Payment::Card);
    {
        let mut w = VaultWriter::create_encrypted(&path, &key).unwrap();
        let c = w.connection();
        populate(c);
        enroll_pin(c, &g, &pin, 2000).unwrap();
        c.execute_batch("DROP TABLE fiscal_requests_v2;DROP TABLE fiscal_reservations;DROP TABLE fiscal_blocks;DROP TABLE fiscal_watermarks;DROP TABLE ticket_allocations;DROP TABLE ticket_sequences;DROP TABLE checkout_drafts;DELETE FROM migration_history WHERE version>=8;PRAGMA user_version=7;").unwrap();
        assert_eq!(migrations::validate_history(c).unwrap(), 7);
    }
    let original;
    {
        let mut w = VaultWriter::open_encrypted(&path, &key).unwrap();
        let c = w.connection();
        assert_eq!(migrations::validate_history(c).unwrap(), 20);
        assert!(unlock_pin(c, &g, &pin, 2100).unwrap().allows("READ"));
        assert_eq!(drafts::read(c, &ctx(2)).unwrap().active.unwrap().id, id(21));
        original = prepare_checkout(c, &g, 2100, 2100, 1, request(30, &p), &p).unwrap();
        no_effects(c);
    }
    {
        let mut w = VaultWriter::open_encrypted(&path, &key).unwrap();
        let c = w.connection();
        assert_eq!(
            read_checkout(c, &g, 2200, 2200, 1, &id(30), &original.hash).unwrap(),
            original
        );
        assert!(prepare_checkout(c, &g, 2200, 2200, 1, request(31, &p), &p).is_err());
        no_effects(c);
    }
    let absolute = path.canonicalize().unwrap();
    assert!(
        absolute.starts_with(std::env::temp_dir().canonicalize().unwrap())
            && absolute
                .file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .starts_with("ventard-checkout-fixture-")
    );
    std::fs::remove_dir_all(absolute).unwrap();
}
