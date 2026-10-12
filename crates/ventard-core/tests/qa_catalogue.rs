#![cfg(feature = "qa-spike")]
use std::path::PathBuf;
use ventard_core::{
    qa::{QaCheckout, QaProductWrite, QaSaleRequest, QaStockChange},
    storage::{cipher::CipherKey, writer::VaultWriter},
};
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!("ventard-catalogue-qa-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&p).unwrap();
        Self(p)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let p = self.0.canonicalize().unwrap();
        assert!(p.starts_with(std::env::temp_dir().canonicalize().unwrap()));
        assert!(p
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("ventard-catalogue-qa-"));
        let _ = std::fs::remove_dir_all(p);
    }
}
fn key() -> CipherKey {
    CipherKey::new([0x74; 32])
}
fn product() -> QaProductWrite {
    serde_json::from_value(serde_json::json!({"operationId":uuid::Uuid::new_v4().to_string(),"productId":null,"expectedRevision":null,"name":"Cable USB C","code":"000011","priceCents":"12500"})).unwrap()
}
fn adjust(id: &str, revision: &str, delta: &str) -> QaStockChange {
    serde_json::from_value(serde_json::json!({"operationId":uuid::Uuid::new_v4().to_string(),"productId":id,"expectedRevision":revision,"delta":delta,"reason":"Entrada de prueba"})).unwrap()
}
#[test]
fn create_replays_exactly_and_is_visible_beyond_seed_ten() {
    let f = Fixture::new();
    let s = QaCheckout::create(&f.0, key()).unwrap();
    let req = product();
    let result = s.save_product(req.clone()).unwrap();
    assert_eq!(result.product.id, req.operation_id);
    assert_eq!(result.product.code, "000011");
    assert_eq!(result.product.price_cents, "12500");
    assert_eq!(result.product.stock, "0");
    for _ in 0..100 {
        assert_eq!(s.save_product(req.clone()).unwrap(), result);
    }
    let mut changed = req;
    changed.price_cents = "12501".into();
    assert_eq!(
        s.save_product(changed).unwrap_err().code(),
        "OPERATION_ID_CONFLICT"
    );
    let c = s.catalogue().unwrap();
    assert_eq!(c.products.len(), 11);
    assert_eq!(c.confirmed_sales, "0");
    assert!(c.last_result.is_none());
    assert!(c.pending_attempt.is_none());
    drop(s);
    let s = QaCheckout::open(&f.0, key()).unwrap();
    assert!(s
        .catalogue()
        .unwrap()
        .products
        .iter()
        .any(|p| p.id == result.product.id));
}
#[test]
fn stock_is_a_separate_audited_atomic_delta_and_edit_never_changes_it() {
    let f = Fixture::new();
    let s = QaCheckout::create(&f.0, key()).unwrap();
    let p = s.save_product(product()).unwrap().product;
    let delta = adjust(&p.id, "1", "5");
    let applied = s.adjust_stock(delta.clone()).unwrap();
    assert_eq!(applied.product.stock, "5");
    assert_eq!(applied.product.revision, "2");
    assert_eq!(s.adjust_stock(delta).unwrap(), applied);
    let mut edit = product();
    edit.operation_id = uuid::Uuid::new_v4().to_string();
    edit.product_id = Some(p.id.clone());
    edit.expected_revision = Some("2".into());
    edit.price_cents = "12501".into();
    let updated = s.save_product(edit.clone()).unwrap();
    assert_eq!(updated.product.stock, "5");
    assert_eq!(updated.product.revision, "3");
    edit.operation_id = uuid::Uuid::new_v4().to_string();
    assert_eq!(s.save_product(edit).unwrap_err().code(), "VERSION_CONFLICT");
    let before = s.catalogue().unwrap();
    assert!(s.adjust_stock(adjust(&p.id, "3", "-6")).is_err());
    assert!(s.adjust_stock(adjust(&p.id, "3", "2147483647")).is_err());
    let after = s.catalogue().unwrap();
    assert_eq!(before.products, after.products);
    assert_eq!(after.confirmed_sales, "0");
    assert_eq!(after.cash_cents, "0");
    assert!(after.pending_attempt.is_none());
    drop(s);
    let mut w = VaultWriter::open_encrypted(&f.0, &key()).unwrap();
    let c = w.connection();
    let rows: i64 = c
        .query_row("SELECT count(*) FROM qa_inventory_adjustments", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(rows, 1);
    let (d, b, a): (i32, i32, i32) = c
        .query_row(
            "SELECT delta,stock_before,stock_after FROM qa_inventory_adjustments",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!((d, b, a), (5, 0, 5));
}
#[test]
fn product_validation_duplicate_code_and_unknown_stock_fail_closed() {
    let f = Fixture::new();
    let s = QaCheckout::create(&f.0, key()).unwrap();
    for (name, code, price) in [
        ("", "new", "1"),
        ("OK", "000001", "1"),
        ("OK", "new", "1.5"),
        ("OK", "new", "-1"),
        ("OK", "new", "9007199254740992"),
    ] {
        let mut req = product();
        req.name = name.into();
        req.code = code.into();
        req.price_cents = price.into();
        assert!(s.save_product(req).is_err());
    }
    let c = s.catalogue().unwrap();
    assert_eq!(c.products.len(), 10);
    assert!(c.pending_attempt.is_none());
    assert!(serde_json::from_value::<QaProductWrite>(serde_json::json!({"operationId":uuid::Uuid::new_v4().to_string(),"productId":null,"expectedRevision":null,"name":"OK","code":"new","priceCents":"1","stock":"100"})).is_err());
    for d in ["0", "-0", "01", "+1", "1.5", "-2147483649"] {
        assert!(s.adjust_stock(adjust("qa-product-01", "1", d)).is_err());
    }
}
#[test]
fn newly_created_uuid_product_can_sell_and_stale_quote_is_rejected() {
    let f = Fixture::new();
    let s = QaCheckout::create(&f.0, key()).unwrap();
    let p = s.save_product(product()).unwrap().product;
    s.adjust_stock(adjust(&p.id, "1", "2")).unwrap();
    let req:QaSaleRequest=serde_json::from_value(serde_json::json!({"operationId":uuid::Uuid::new_v4().to_string(),"lines":[{"productId":p.id,"quantity":"1","revision":"2"}],"tenderCents":"20000"})).unwrap();
    assert_eq!(
        s.quote(req.lines.clone(), None).unwrap().total_cents,
        "14750"
    );
    let result = s.confirm(req).unwrap();
    assert_eq!(result.change_cents, "5250");
    let mut edit = product();
    edit.operation_id = uuid::Uuid::new_v4().to_string();
    edit.product_id = Some(p.id.clone());
    edit.expected_revision = Some("2".into());
    edit.price_cents = "15000".into();
    s.save_product(edit).unwrap();
    let line =
        serde_json::from_value(serde_json::json!({"productId":p.id,"quantity":"1","revision":"2"}))
            .unwrap();
    assert_eq!(
        s.quote(vec![line], None).unwrap_err().code(),
        "VERSION_CONFLICT"
    );
    assert_eq!(s.catalogue().unwrap().last_result.unwrap(), result);
}
#[test]
fn old_qa_vault_is_upgraded_without_reseeding_or_replacing_sales() {
    let f = Fixture::new();
    let s = QaCheckout::create(&f.0, key()).unwrap();
    let req:QaSaleRequest=serde_json::from_value(serde_json::json!({"operationId":uuid::Uuid::new_v4().to_string(),"lines":[{"productId":"qa-product-01","quantity":"1","revision":"1"}],"tenderCents":"20000"})).unwrap();
    let result = s.confirm(req).unwrap();
    drop(s);
    let mut w = VaultWriter::open_encrypted(&f.0, &key()).unwrap();
    w.connection()
        .execute_batch("DROP TABLE qa_inventory_adjustments; DROP TABLE qa_schema_migrations;")
        .unwrap();
    drop(w);
    let s = QaCheckout::open(&f.0, key()).unwrap();
    let c = s.catalogue().unwrap();
    assert_eq!(c.products[0].stock, "99");
    assert_eq!(c.last_result.unwrap(), result);
    drop(s);
    let mut w = VaultWriter::open_encrypted(&f.0, &key()).unwrap();
    w.connection()
        .execute(
            "UPDATE qa_schema_migrations SET checksum='tampered' WHERE version=2",
            [],
        )
        .unwrap();
    drop(w);
    assert!(QaCheckout::open(&f.0, key()).is_err());
}

#[test]
fn failure_between_audit_and_projection_rolls_back_then_same_identity_recovers() {
    let f = Fixture::new();
    let s = QaCheckout::create(&f.0, key()).unwrap();
    let p = s.save_product(product()).unwrap().product;
    drop(s);
    let mut w = VaultWriter::open_encrypted(&f.0, &key()).unwrap();
    w.connection().execute_batch("CREATE TRIGGER qa_stock_fault BEFORE UPDATE OF stock ON qa_products WHEN NEW.stock=5 BEGIN SELECT RAISE(ABORT,'synthetic fault'); END;").unwrap();
    drop(w);
    let s = QaCheckout::open(&f.0, key()).unwrap();
    let req = adjust(&p.id, "1", "5");
    assert!(s.adjust_stock(req.clone()).is_err());
    assert_eq!(
        s.catalogue()
            .unwrap()
            .products
            .iter()
            .find(|x| x.id == p.id)
            .unwrap()
            .stock,
        "0"
    );
    drop(s);
    let mut w = VaultWriter::open_encrypted(&f.0, &key()).unwrap();
    let c = w.connection();
    assert_eq!(
        c.query_row("SELECT count(*) FROM qa_inventory_adjustments", [], |r| r
            .get::<_, i64>(
            0
        ))
        .unwrap(),
        0
    );
    assert_eq!(
        c.query_row(
            "SELECT local_state FROM operation_journal WHERE operation_id=?1",
            [&req.operation_id],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "PREPARED"
    );
    c.execute_batch("DROP TRIGGER qa_stock_fault;").unwrap();
    drop(w);
    let s = QaCheckout::open(&f.0, key()).unwrap();
    let result = s.adjust_stock(req.clone()).unwrap();
    assert_eq!(result.product.stock, "5");
    assert_eq!(s.adjust_stock(req).unwrap(), result);
}

#[test]
fn concurrent_expected_revision_allows_only_one_edit() {
    let f = Fixture::new();
    let s = QaCheckout::create(&f.0, key()).unwrap();
    let p = s.save_product(product()).unwrap().product;
    std::thread::scope(|scope| {
        let jobs = (0..2)
            .map(|i| {
                let s = &s;
                let mut req = product();
                req.operation_id = uuid::Uuid::new_v4().to_string();
                req.product_id = Some(p.id.clone());
                req.expected_revision = Some("1".into());
                req.name = format!("Edición {i}");
                scope.spawn(move || s.save_product(req))
            })
            .collect::<Vec<_>>();
        let results = jobs
            .into_iter()
            .map(|j| j.join().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter(|r| r
                    .as_ref()
                    .err()
                    .is_some_and(|e| e.code() == "VERSION_CONFLICT"))
                .count(),
            1
        );
    });
    assert_eq!(
        s.catalogue()
            .unwrap()
            .products
            .iter()
            .find(|x| x.id == p.id)
            .unwrap()
            .revision,
        "2"
    );
}
