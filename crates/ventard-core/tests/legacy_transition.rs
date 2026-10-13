#![cfg(feature = "encrypted-storage")]
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use ventard_core::storage::{
    catalogue_preview::CatalogueContext, cipher::CipherKey, legacy_transition as t, legacy_web,
    writer::VaultWriter,
};
const TENANT: &str = "96000000-0000-4000-8000-000000000001";
fn ctx() -> CatalogueContext {
    CatalogueContext {
        tenant_id: TENANT.into(),
        actor_id: TENANT.into(),
        installation_id: TENANT.into(),
        device_id: TENANT.into(),
        writer_epoch: "1".into(),
        scope_type: "GLOBAL".into(),
        branch_id: None,
    }
}
fn hash(s: &str) -> String {
    format!("{:x}", Sha256::digest(s.as_bytes()))
}
#[test]
fn whole_sale_choice_deduplicates_distinct_detail_and_charge_ids_atomically() {
    let dir = std::env::temp_dir().join(format!(
        "ventard-transition-fixture-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir(&dir).unwrap();
    let mut w = VaultWriter::create_encrypted(&dir, &CipherKey::new([109; 32])).unwrap();
    let a = "96000015-0000-4000-8000-000000000001";
    let b = "96000015-0000-4000-8000-000000000002";
    let run = "96000015-0000-4000-8000-000000000003";
    let mut header = sale("credit-sale", json!(12.34), "fiado");
    header["cliente_id"] = json!("client");
    for (source, suffix) in [(a, "a"), (b, "b")] {
        let p = package(
            source,
            json!({"ventas":[header],"clientes":[{"id":"client","negocio_id":TENANT,"nombre":"Cliente"}],"venta_detalles":[{"id":format!("detail-{suffix}"),"negocio_id":TENANT,"sucursal_id":null,"venta_id":"credit-sale","nombre":"Cable","cantidad":1,"precio_unitario":12.34,"subtotal":12.34}],"transacciones_fiado":[{"id":format!("charge-{suffix}"),"negocio_id":TENANT,"sucursal_id":null,"venta_id":"credit-sale","cliente_id":"client","tipo":"cargo","monto":12.34}]}),
        );
        legacy_web::store(w.connection(), TENANT, &p).unwrap();
    }
    let r = t::prepare(
        w.connection(),
        &ctx(),
        run,
        &[a.into(), b.into()],
        None,
        "1791909600000",
    )
    .unwrap();
    assert_eq!(r["documentConflicts"], 1);
    assert_eq!(r["debts"][0]["balanceCents"], Value::Null);
    assert!(t::publish_history(w.connection(), &ctx(), run, 0).is_err());
    w.connection().execute_batch("CREATE TRIGGER transition_fault BEFORE INSERT ON legacy_transition_decisions_v1 BEGIN SELECT RAISE(ABORT,'fixture');END;").unwrap();
    assert!(t::resolve_document(
        w.connection(),
        &ctx(),
        run,
        t::DocumentDecision {
            sale_id: "credit-sale",
            source_id: b,
            revision: 0,
            reason: "Versión B revisada por el dueño"
        }
    )
    .is_err());
    assert_eq!(
        t::report(w.connection(), &ctx(), run).unwrap()["revision"],
        0
    );
    w.connection()
        .execute_batch("DROP TRIGGER transition_fault")
        .unwrap();
    let r = t::resolve_document(
        w.connection(),
        &ctx(),
        run,
        t::DocumentDecision {
            sale_id: "credit-sale",
            source_id: b,
            revision: 0,
            reason: "Versión B revisada por el dueño",
        },
    )
    .unwrap();
    assert_eq!(r["documentConflicts"], 0);
    assert_eq!(r["counts"]["venta_detalles"], 1);
    assert_eq!(r["counts"]["transacciones_fiado"], 1);
    assert_eq!(r["debts"][0]["balanceCents"], "1234");
    t::publish_history(w.connection(), &ctx(), run, 1).unwrap();
    let ticket = t::ticket(w.connection(), &ctx(), "credit-sale").unwrap();
    assert_eq!(ticket["lines"].as_array().unwrap().len(), 1);
    assert_eq!(ticket["lines"][0]["id"], "detail-b");
    let rows = t::rows(w.connection(), &ctx(), run, "venta_detalles", 0).unwrap();
    assert_eq!(rows["total"], 2);
    assert!(rows["rows"]
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r["id"] == "detail-a" && r["excluded"] == true));
}
fn package(id: &str, data: Value) -> legacy_web::Package {
    let p = legacy_web::decrypt(
        include_bytes!("fixtures/legacy-web-v1.vrweb"),
        include_bytes!("fixtures/legacy-web-v1.vrwebkey"),
    )
    .unwrap();
    let mut v: Value = serde_json::from_str(p.raw_body()).unwrap();
    v["exportId"] = json!(id);
    for table in v["tables"].as_array_mut().unwrap() {
        let rows = data
            .get(table["name"].as_str().unwrap())
            .cloned()
            .unwrap_or(json!([]));
        let raw = rows.to_string();
        table["rowsJson"] = json!(raw);
        table["sha256"] = json!(hash(&raw));
        table["count"] = json!(rows.as_array().unwrap().len());
    }
    legacy_web::parse(v.to_string()).unwrap()
}
fn cloud(id: &str, data: Value) -> String {
    let tables=t::CLOUD_TABLES.iter().map(|name|{let rows=data.get(*name).cloned().unwrap_or(json!([]));json!({"name":name,"count":rows.as_array().unwrap().len(),"rows":rows,"scopeEvidence":[]})}).collect::<Vec<_>>();
    json!({"protocol":"ventard.web.capture.1","captureId":id,"context":ctx(),"capturedAtMs":"1791909600000","coverage":"SCOPE_COMPLETE_SINGLE_SNAPSHOT","decimalEncoding":"TAGGED_NUMBERS_V1","tables":tables}).to_string()
}
fn sale(id: &str, amount: Value, method: &str) -> Value {
    json!({"id":id,"negocio_id":TENANT,"sucursal_id":null,"caja_id":"cash-old","total":amount,"metodo_pago":method,"numero_ticket":7,"ncf":"B0200000007","fecha_creacion":1791909600000i64})
}
#[test]
fn two_copies_and_cloud_merge_exact_money_restart_replay_and_history_without_business_effects() {
    let dir = std::env::temp_dir().join(format!(
        "ventard-transition-fixture-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir(&dir).unwrap();
    let key = CipherKey::new([102; 32]);
    let mut w = VaultWriter::create_encrypted(&dir, &key).unwrap();
    let a = "96000005-0000-4000-8000-000000000001";
    let b = "96000005-0000-4000-8000-000000000002";
    let capture = "96000005-0000-4000-8000-000000000003";
    let run = "96000005-0000-4000-8000-000000000004";
    let common = sale("sale-shared", json!(12.34), "efectivo");
    let pending = sale("sale-pending", json!(25.01), "fiado");
    let details = json!([{"id":"line-shared","negocio_id":TENANT,"venta_id":"sale-shared","nombre":"Cable original","cantidad":1,"precio_unitario":12.34,"subtotal":12.34}]);
    let data = json!({"ventas":[common],"venta_detalles":details,"cajas":[{"id":"cash-old","negocio_id":TENANT,"sucursal_id":null,"estado":"abierta","monto_apertura":100.00}],"clientes":[{"id":"customer-old","negocio_id":TENANT,"nombre":"Cliente antiguo"}]});
    let pa = package(a, data.clone());
    legacy_web::store(w.connection(), TENANT, &pa).unwrap();
    let pb = package(
        b,
        json!({"ventas":[common,pending],"venta_detalles":details,"transacciones_fiado":[{"id":"charge-old","negocio_id":TENANT,"sucursal_id":null,"cliente_id":"customer-old","venta_id":"sale-pending","tipo":"cargo","monto":25.01}]}),
    );
    legacy_web::store(w.connection(), TENANT, &pb).unwrap();
    let remote = cloud(
        capture,
        json!({"ventas":[{"id":"sale-cloud","negocio_id":TENANT,"sucursal_id":null,"caja_id":"cash-old","total":{"$number":"5.0000"},"metodo_pago":"tarjeta","fecha_creacion":{"$number":"1791909600000"}}]}),
    );
    t::store_capture(w.connection(), &ctx(), capture, &remote).unwrap();
    let report = t::prepare(
        w.connection(),
        &ctx(),
        run,
        &[b.into(), a.into()],
        Some(capture),
        "1791909600000",
    )
    .unwrap();
    assert_eq!(report["counts"]["ventas"], 3);
    assert_eq!(report["sales"]["totalCents"], "4235");
    assert_eq!(report["debts"][0]["balanceCents"], "2501");
    assert_eq!(report["cash"][0]["expectedCents"], "11234");
    assert_eq!(report["canActivate"], false);
    assert_eq!(
        t::prepare(
            w.connection(),
            &ctx(),
            run,
            &[a.into(), b.into()],
            Some(capture),
            "1791909600000"
        )
        .unwrap(),
        report
    );
    t::publish_history(w.connection(), &ctx(), run, 0).unwrap();
    let rows = t::history(w.connection(), &ctx(), "", None, None, None, 1).unwrap();
    assert_eq!(rows["total"], "3");
    assert_eq!(
        t::ticket(w.connection(), &ctx(), "sale-shared").unwrap()["lines"][0]["name"],
        "Cable original"
    );
    drop(w);
    let mut w = VaultWriter::open_encrypted(&dir, &key).unwrap();
    assert_eq!(
        t::view(w.connection(), &ctx()).unwrap()["report"]["runId"],
        run
    );
    t::publish_history(w.connection(), &ctx(), run, 0).unwrap();
    assert_eq!(
        t::history(w.connection(), &ctx(), "", None, None, None, 1).unwrap()["total"],
        "3"
    );
    for table in [
        "sales",
        "operation_journal",
        "outbox",
        "inventory_movements",
        "sale_customer_accounts_v1",
    ] {
        let n: i64 = w
            .connection()
            .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0, "{table}");
    }
    assert!(!std::fs::read(dir.join("pos_core.db"))
        .unwrap()
        .windows(11)
        .any(|v| v == b"sale-shared"));
}
#[test]
fn conflicting_documents_require_audited_choice_and_never_concatenate_embedded_payments() {
    let dir = std::env::temp_dir().join(format!(
        "ventard-transition-fixture-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir(&dir).unwrap();
    let mut w = VaultWriter::create_encrypted(&dir, &CipherKey::new([103; 32])).unwrap();
    let a = "96000006-0000-4000-8000-000000000001";
    let b = "96000006-0000-4000-8000-000000000002";
    let run = "96000006-0000-4000-8000-000000000003";
    for (id, payments) in [
        (
            a,
            json!([{"monto":1.23,"metodo":"efectivo","caja_id":"cash","fecha":1791909600000i64}]),
        ),
        (
            b,
            json!([{"monto":1.23,"metodo":"efectivo","caja_id":"cash","fecha":1791909600000i64},{"monto":2.34,"metodo":"efectivo","caja_id":"cash","fecha":1791909600000i64}]),
        ),
    ] {
        let p = package(
            id,
            json!({"reparaciones":[{"id":"repair-old","negocio_id":TENANT,"sucursal_id":null,"pagos":payments,"abono":if id==a{1.23}else{3.57}}]}),
        );
        legacy_web::store(w.connection(), TENANT, &p).unwrap();
    }
    let r = t::prepare(
        w.connection(),
        &ctx(),
        run,
        &[a.into(), b.into()],
        None,
        "1791909600000",
    )
    .unwrap();
    assert_eq!(r["conflicts"], 1);
    assert!(t::publish_history(w.connection(), &ctx(), run, 0).is_err());
    let variants = t::rows(w.connection(), &ctx(), run, "reparaciones", 0).unwrap();
    let variant = variants["rows"][0]["variants"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["sourceIds"].as_array().unwrap().contains(&json!(b)))
        .unwrap()["variantId"]
        .as_str()
        .unwrap()
        .to_owned();
    let chosen = t::resolve(
        w.connection(),
        &ctx(),
        run,
        t::Decision {
            table: "reparaciones",
            row_id: "repair-old",
            variant_id: &variant,
            revision: 0,
            reason: "Copia B contiene ambos pagos verificados por el dueño",
        },
    )
    .unwrap();
    assert_eq!(chosen["conflicts"], 0);
    assert_eq!(chosen["payments"].as_array().unwrap().len(), 2);
    assert!(t::resolve(
        w.connection(),
        &ctx(),
        run,
        t::Decision {
            table: "reparaciones",
            row_id: "repair-old",
            variant_id: &variant,
            revision: 0,
            reason: "otra elección"
        }
    )
    .is_err());
    let mut other = ctx();
    other.writer_epoch = "2".into();
    assert!(t::rows(w.connection(), &other, run, "reparaciones", 0).is_err());
}
#[test]
fn capture_is_complete_context_bound_immutable_and_fractional_cents_are_not_rounded() {
    let dir = std::env::temp_dir().join(format!(
        "ventard-transition-fixture-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir(&dir).unwrap();
    let mut w = VaultWriter::create_encrypted(&dir, &CipherKey::new([104; 32])).unwrap();
    let id = "96000007-0000-4000-8000-000000000001";
    let raw = cloud(
        id,
        json!({"ventas":[{"id":"bad-money","negocio_id":TENANT,"sucursal_id":null,"metodo_pago":"efectivo","total":{"$number":"1.001"}}]}),
    );
    t::store_capture(w.connection(), &ctx(), id, &raw).unwrap();
    t::store_capture(w.connection(), &ctx(), id, &raw).unwrap();
    assert!(t::store_capture(w.connection(), &ctx(), id, &cloud(id, json!({}))).is_err());
    let r = t::prepare(
        w.connection(),
        &ctx(),
        "96000007-0000-4000-8000-000000000002",
        &[],
        Some(id),
        "1791909600000",
    )
    .unwrap();
    assert_eq!(r["sales"]["totalCents"], Value::Null);
    assert!(r["issues"]
        .as_array()
        .unwrap()
        .iter()
        .any(|i| i["code"] == "INVALID_MONEY"));
    let mut broken: Value = serde_json::from_str(&raw).unwrap();
    broken["captureId"] = json!("96000007-0000-4000-8000-000000000003");
    broken["tables"].as_array_mut().unwrap().pop();
    assert!(t::store_capture(
        w.connection(),
        &ctx(),
        broken["captureId"].as_str().unwrap(),
        &broken.to_string()
    )
    .is_err());
}

#[test]
fn incomplete_credit_and_cash_never_become_zero_or_a_complete_balance() {
    let dir = std::env::temp_dir().join(format!(
        "ventard-transition-fixture-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir(&dir).unwrap();
    let mut w = VaultWriter::create_encrypted(&dir, &CipherKey::new([105; 32])).unwrap();
    let id = "96000008-0000-4000-8000-000000000001";
    let raw = cloud(
        id,
        json!({"cajas":[{"id":"cash","negocio_id":TENANT,"sucursal_id":null,"monto_apertura":{"$number":"100.00"}}],"ventas":[{"id":"cash-sale","negocio_id":TENANT,"sucursal_id":null,"metodo_pago":"efectivo","total":{"$number":"12.34"}}],"clientes":[{"id":"client","negocio_id":TENANT,"nombre":"Cliente"}],"transacciones_fiado":[{"id":"bad-credit","negocio_id":TENANT,"sucursal_id":null,"cliente_id":"client","tipo":"cargo","monto":{"$number":"1.001"}}]}),
    );
    t::store_capture(w.connection(), &ctx(), id, &raw).unwrap();
    let r = t::prepare(
        w.connection(),
        &ctx(),
        "96000008-0000-4000-8000-000000000002",
        &[],
        Some(id),
        "1791909600000",
    )
    .unwrap();
    assert_eq!(r["cash"][0]["expectedCents"], Value::Null);
    assert_eq!(r["cash"][0]["observedExpectedCents"], "10000");
    assert_eq!(r["debts"][0]["balanceCents"], Value::Null);
    assert_eq!(r["debts"][0]["observedBalanceCents"], "0");
}

#[test]
fn preparation_and_publication_are_atomic_on_storage_failure_and_new_history_cannot_erase_old_sources(
) {
    let dir = std::env::temp_dir().join(format!(
        "ventard-transition-fixture-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir(&dir).unwrap();
    let mut w = VaultWriter::create_encrypted(&dir, &CipherKey::new([106; 32])).unwrap();
    let source = "96000009-0000-4000-8000-000000000001";
    let run = "96000009-0000-4000-8000-000000000002";
    let p = package(
        source,
        json!({"ventas":[sale("original-sale",json!(12.34),"efectivo")]}),
    );
    legacy_web::store(w.connection(), TENANT, &p).unwrap();
    w.connection().execute_batch("CREATE TRIGGER transition_fault BEFORE UPDATE ON legacy_transition_runs_v1 BEGIN SELECT RAISE(ABORT,'fixture');END;").unwrap();
    assert!(t::prepare(
        w.connection(),
        &ctx(),
        run,
        &[source.into()],
        None,
        "1791909600000"
    )
    .is_err());
    assert_eq!(
        w.connection()
            .query_row("SELECT count(*) FROM legacy_transition_runs_v1", [], |r| {
                r.get::<_, i64>(0)
            })
            .unwrap(),
        0
    );
    assert_eq!(
        w.connection()
            .query_row("SELECT count(*) FROM legacy_transition_rows_v1", [], |r| {
                r.get::<_, i64>(0)
            })
            .unwrap(),
        0
    );
    w.connection()
        .execute_batch("DROP TRIGGER transition_fault")
        .unwrap();
    t::prepare(
        w.connection(),
        &ctx(),
        run,
        &[source.into()],
        None,
        "1791909600000",
    )
    .unwrap();
    w.connection().execute_batch("CREATE TRIGGER transition_fault BEFORE UPDATE ON legacy_transition_runs_v1 BEGIN SELECT RAISE(ABORT,'fixture');END;").unwrap();
    assert!(t::publish_history(w.connection(), &ctx(), run, 0).is_err());
    assert_eq!(
        t::history(w.connection(), &ctx(), "", None, None, None, 1).unwrap()["total"],
        "0"
    );
    w.connection()
        .execute_batch("DROP TRIGGER transition_fault")
        .unwrap();
    t::publish_history(w.connection(), &ctx(), run, 0).unwrap();
    let later = "96000009-0000-4000-8000-000000000003";
    t::prepare(
        w.connection(),
        &ctx(),
        later,
        &[source.into()],
        None,
        "1791909600001",
    )
    .unwrap();
    t::publish_history(w.connection(), &ctx(), later, 0).unwrap();
    assert_eq!(
        t::history(w.connection(), &ctx(), "", None, None, None, 1).unwrap()["total"],
        "1"
    );
    let source_b = "96000009-0000-4000-8000-000000000004";
    let p = package(
        source_b,
        json!({"ventas":[sale("exclusive-sale",json!(25.01),"tarjeta")]}),
    );
    legacy_web::store(w.connection(), TENANT, &p).unwrap();
    let extended = "96000009-0000-4000-8000-000000000005";
    t::prepare(
        w.connection(),
        &ctx(),
        extended,
        &[source.into(), source_b.into()],
        None,
        "1791909600002",
    )
    .unwrap();
    t::publish_history(w.connection(), &ctx(), extended, 0).unwrap();
    assert_eq!(
        t::history(w.connection(), &ctx(), "", None, None, None, 1).unwrap()["total"],
        "2"
    );
    let older = "96000009-0000-4000-8000-000000000006";
    t::prepare(
        w.connection(),
        &ctx(),
        older,
        &[source.into()],
        None,
        "1791909600003",
    )
    .unwrap();
    assert!(t::publish_history(w.connection(), &ctx(), older, 0).is_err());
}

#[test]
#[ignore = "requires explicit isolated PostgreSQL capture fixture"]
fn postgres_complete_capture_roundtrips_exact_rows_and_context() {
    let raw = std::fs::read_to_string(std::env::var("VENTARD_TRANSITION_CAPTURE_FIXTURE").unwrap())
        .unwrap();
    let v: Value = serde_json::from_str(&raw).unwrap();
    let context: CatalogueContext = serde_json::from_value(v["context"].clone()).unwrap();
    let dir = std::env::temp_dir().join(format!(
        "ventard-transition-fixture-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir(&dir).unwrap();
    let mut w = VaultWriter::create_encrypted(&dir, &CipherKey::new([107; 32])).unwrap();
    let id = v["captureId"].as_str().unwrap();
    let captured = t::store_capture(w.connection(), &context, id, &raw).unwrap();
    assert_eq!(captured["counts"]["ventas"], 136);
    let r = t::prepare(
        w.connection(),
        &context,
        "96000010-0000-4000-8000-000000000001",
        &[],
        Some(id),
        "1791909600000",
    )
    .unwrap();
    assert_eq!(r["sales"]["totalCents"], "1369");
    assert_eq!(r["canActivate"], false);
}

#[test]
fn original_web_checkout_hash_recovers_its_scope_and_full_saved_invoice_but_never_remote_effects() {
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/legacy-checkout-original.json")).unwrap();
    for tamper in [false, true] {
        let dir = std::env::temp_dir().join(format!(
            "ventard-transition-fixture-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir(&dir).unwrap();
        let mut w = VaultWriter::create_encrypted(&dir, &CipherKey::new([108; 32])).unwrap();
        let mut journal = fixture["journal"].clone();
        if tamper {
            journal["resultado"]["comprobante"]["negocio"]["nombre"] = json!("Nombre alterado");
        }
        let source = "96000014-0000-4000-8000-000000000001";
        let p = package(
            source,
            json!({"ventas":[fixture["sale"]],"venta_detalles":fixture["details"],"operaciones_locales":[journal]}),
        );
        legacy_web::store(w.connection(), TENANT, &p).unwrap();
        let run = "96000014-0000-4000-8000-000000000002";
        let r = t::prepare(
            w.connection(),
            &ctx(),
            run,
            &[source.into()],
            None,
            "1791909600000",
        )
        .unwrap();
        assert_eq!(
            r["localCheckoutProofs"].as_array().unwrap().len(),
            if tamper { 0 } else { 1 }
        );
        t::publish_history(w.connection(), &ctx(), run, 0).unwrap();
        let history = t::history(w.connection(), &ctx(), "", None, None, None, 1).unwrap();
        assert_eq!(history["total"], if tamper { "0" } else { "1" });
        if !tamper {
            let ticket = t::ticket(
                w.connection(),
                &ctx(),
                fixture["sale"]["id"].as_str().unwrap(),
            )
            .unwrap();
            assert_eq!(ticket["business"]["name"], "Negocio histórico QA");
            assert_eq!(ticket["itbisCents"], "0");
            assert_eq!(ticket["subtotalCents"], "1234");
            assert_eq!(ticket["receivedCents"], "1234");
            assert_eq!(ticket["coverage"], "HASH_MATCHED_LOCAL_CHECKOUT");
            assert_eq!(ticket["effectStatus"], "UNKNOWN_LEGACY");
        }
    }
}
