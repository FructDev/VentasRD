#![cfg(feature = "encrypted-storage")]
use serde_json::{json, Value};
use ventard_core::{
    domain::canonical::canonicalize,
    storage::{
        catalogue_preview::CatalogueContext, cipher::CipherKey, legacy_services as services,
        writer::VaultWriter,
    },
};
fn id(n: u32) -> String {
    format!("96200000-0000-4000-8000-{n:012}")
}
fn ctx() -> CatalogueContext {
    CatalogueContext {
        tenant_id: id(1),
        actor_id: id(2),
        installation_id: id(3),
        device_id: id(4),
        writer_epoch: "1".into(),
        scope_type: "GLOBAL".into(),
        branch_id: None,
    }
}
fn source() -> Value {
    json!({"id":id(5),"negocio_id":id(1),"sucursal_id":null,"folio":"AP-0042","estado":"activo","cliente_nombre":"Ana","items":[{"producto_id":id(6),"nombre":"Equipo","cantidad":{"$number":"2"},"precio_unitario":{"$number":"25.55"}}],"total":{"$number":"51.10"},"abonado":{"$number":"10.25"},"abonos":[{"monto":{"$number":"10.25"},"metodo":"efectivo","fecha":{"$number":"1000"}}],"fecha_creacion":{"$number":"1000"},"fecha_actualizacion":{"$number":"2000"}})
}
fn envelope(raw: Value) -> Value {
    let document = services::project("apartados", &raw).unwrap();
    let hash = canonicalize(document.to_string().as_bytes()).unwrap().1;
    json!({"table":"apartados","source":raw,"receipt":{"protocol":"ventard.service.baseline.receipt.1","status":"BASELINE_ADOPTED","cutoverId":id(7),"tenantId":id(1),"scope":{"type":"GLOBAL","branchId":null},"sourceHash":document["legacyBaseline"]["sourceHash"],"documentHash":hash,"legacyReplay":false},"document":document})
}
#[test]
fn old_service_is_readable_without_replaying_payments_stock_or_outbox() {
    let dir =
        std::env::temp_dir().join(format!("ventard-legacy-services-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&dir).unwrap();
    let mut w = VaultWriter::create_encrypted(&dir, &CipherKey::new([76; 32])).unwrap();
    let c = w.connection();
    let e = envelope(source());
    services::import(c, &ctx(), &json!([e.clone()])).unwrap();
    services::import(c, &ctx(), &json!([e])).unwrap();
    let d = services::current(c, &ctx(), "layaway", &id(5))
        .unwrap()
        .unwrap();
    assert_eq!(d["layaway"]["folio"], "AP-0042");
    assert_eq!(d["layaway"]["paidCents"], "1025");
    assert_eq!(d["layaway"]["totalCents"], "5110");
    assert_eq!(d["layaway"]["payments"], json!([]));
    assert_eq!(d["remoteStatus"], "BASELINE_ADOPTED");
    for table in [
        "operation_journal",
        "outbox",
        "payments",
        "inventory_movements",
    ] {
        assert_eq!(
            c.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        )
    }
    let mut foreign = ctx();
    foreign.tenant_id = id(8);
    assert!(services::current(c, &foreign, "layaway", &id(5))
        .unwrap()
        .is_none());
    use ventard_core::application::printing;
    let ticket = printing::layaway_ticket(c, &ctx(), &id(5)).unwrap();
    assert_eq!(ticket["document"]["layaway"]["folio"], "AP-0042");
    assert_eq!(ticket["document"]["business"], Value::Null);
    let hash = ticket["printSnapshotHash"].as_str().unwrap();
    c.execute_batch("CREATE TRIGGER fixture_print_fail BEFORE INSERT ON legacy_service_printer_dispatch_v1 BEGIN SELECT RAISE(ABORT,'owned print rollback');END;").unwrap();
    assert!(printing::transport::prepare(c, &ctx(), &id(5), hash, &id(10), true, None).is_err());
    assert_eq!(
        c.query_row(
            "SELECT count(*) FROM legacy_service_print_attempts_v1",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    c.execute_batch("DROP TRIGGER fixture_print_fail").unwrap();
    assert!(
        printing::transport::prepare(c, &ctx(), &id(5), hash, &id(10), true, None)
            .unwrap()
            .fresh
    );
    assert!(
        !printing::transport::prepare(c, &ctx(), &id(5), hash, &id(10), true, None)
            .unwrap()
            .fresh
    );
    assert!(printing::transport::prepare(c, &foreign, &id(5), hash, &id(10), true, None).is_err());
    assert_eq!(
        c.query_row("SELECT count(*) FROM operation_journal", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    c.execute("UPDATE legacy_service_baselines_v1 SET envelope=json_set(envelope,'$.document.paidCents','99999')",[]).unwrap();
    assert!(services::current(c, &ctx(), "layaway", &id(5)).is_err());
}
#[test]
fn baseline_rejects_tamper_inconsistent_totals_and_precision() {
    let mut r = source();
    r["total"] = json!({"$number":"51.101"});
    assert!(services::project("apartados", &r).is_err());
    r = source();
    r["total"] = json!({"$number":"51.11"});
    assert!(services::project("apartados", &r).is_err());
    r = source();
    r["abonado"] = json!({"$number":"52"});
    assert!(services::project("apartados", &r).is_err());
}

#[test]
#[ignore = "requires isolated PostgreSQL synthetic fixture"]
fn postgres_baseline_and_following_payment_are_consumed_without_old_effects() {
    use ventard_core::application::{layaways, repairs, sales_sync};
    let fixture: Value = serde_json::from_str(
        &std::fs::read_to_string(std::env::var("VENTARD_SERVICE_BASELINE_FIXTURE").unwrap())
            .unwrap(),
    )
    .unwrap();
    let context: CatalogueContext =
        serde_json::from_value(fixture["manifest"]["context"].clone()).unwrap();
    let dir = std::env::temp_dir().join(format!(
        "ventard-services-roundtrip-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir(&dir).unwrap();
    let mut w = VaultWriter::create_encrypted(&dir, &CipherKey::new([76; 32])).unwrap();
    let c = w.connection();
    let now = fixture["manifest"]["capturedAtMs"]
        .as_str()
        .unwrap()
        .parse::<u64>()
        .unwrap();
    sales_sync::begin_bootstrap(c, &context, &fixture["manifest"], now).unwrap();
    for (i, page) in fixture["pages"].as_array().unwrap().iter().enumerate() {
        sales_sync::stage_bootstrap_page(c, &context, i, page.as_str().unwrap(), now).unwrap()
    }
    sales_sync::activate_bootstrap(c, &context, now, "96200000-0000-4000-8000-000000001550")
        .unwrap();
    assert_eq!(
        layaways::read(c, &context).unwrap()["rows"][0]["paidCents"],
        "1025"
    );
    assert_eq!(
        repairs::read(c, &context).unwrap()["rows"][0]["folio"],
        "REP-089"
    );
    assert_eq!(
        c.query_row("SELECT count(*) FROM operation_journal", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    sales_sync::receive_event(c, &context, &fixture["event"]).unwrap();
    sales_sync::receive_event(c, &context, &fixture["event"]).unwrap();
    let a = layaways::read(c, &context).unwrap();
    assert_eq!(a["rows"].as_array().unwrap().len(), 1);
    assert_eq!(a["rows"][0]["paidCents"], "1125");
    assert_eq!(
        c.query_row("SELECT count(*) FROM payments", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        c.query_row("SELECT count(*) FROM inventory_movements", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    for event in fixture["events"].as_array().unwrap().iter().skip(1) {
        sales_sync::receive_event(c, &context, event).unwrap();
        sales_sync::receive_event(c, &context, event).unwrap();
    }
    assert_eq!(
        layaways::read(c, &context).unwrap()["rows"][0]["state"],
        "cancelado"
    );
    assert_eq!(
        repairs::read(c, &context).unwrap()["rows"][0]["paidCents"],
        "500"
    );
    assert_eq!(
        c.query_row("SELECT count(*) FROM payments", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        2
    );
    assert_eq!(
        c.query_row("SELECT count(*) FROM inventory_movements", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    let second_dir = std::env::temp_dir().join(format!(
        "ventard-services-roundtrip-second-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir(&second_dir).unwrap();
    let mut second = VaultWriter::create_encrypted(&second_dir, &CipherKey::new([75; 32])).unwrap();
    let c = second.connection();
    sales_sync::begin_bootstrap(c, &context, &fixture["finalManifest"], now).unwrap();
    for (i, page) in fixture["finalPages"].as_array().unwrap().iter().enumerate() {
        sales_sync::stage_bootstrap_page(c, &context, i, page.as_str().unwrap(), now).unwrap()
    }
    sales_sync::activate_bootstrap(c, &context, now, "96200000-0000-4000-8000-000000001551")
        .unwrap();
    assert_eq!(
        layaways::read(c, &context).unwrap()["rows"][0]["state"],
        "cancelado"
    );
    assert_eq!(
        repairs::read(c, &context).unwrap()["rows"][0]["paidCents"],
        "500"
    );
    assert_eq!(
        c.query_row("SELECT count(*) FROM payments", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        c.query_row("SELECT count(*) FROM inventory_movements", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
}
