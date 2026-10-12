#![cfg(feature = "qa-spike")]
use std::path::PathBuf;
use ventard_core::{
    qa::{QaCheckout, QaSaleRequest},
    storage::{cipher::CipherKey, writer::VaultWriter},
};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!("ventard-checkout-qa-{}", uuid::Uuid::new_v4()));
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
            .starts_with("ventard-checkout-qa-"));
        let _ = std::fs::remove_dir_all(p);
    }
}
fn key() -> CipherKey {
    CipherKey::new([0x73; 32])
} // únicamente fixture sintético
fn sale(qty: &str, tender: &str) -> QaSaleRequest {
    serde_json::from_value(serde_json::json!({
        "operationId": uuid::Uuid::new_v4().to_string(),
        "lines": [{"productId":"qa-product-01", "quantity":qty, "revision":"1"}],
        "tenderCents":tender
    }))
    .unwrap()
}

#[test]
fn native_quote_is_read_only_and_returns_exact_cart_and_payment_amounts() {
    let f = Fixture::new();
    let store = QaCheckout::create(&f.0, key()).unwrap();
    let request = sale("2", "30000");
    let before = store.catalogue().unwrap();
    let quote = store
        .quote(request.lines.clone(), Some("30000".into()))
        .unwrap();
    assert_eq!(quote.subtotal_cents, "20000");
    assert_eq!(quote.itbis_cents, "3600");
    assert_eq!(quote.total_cents, "23600");
    assert_eq!(quote.change_cents, Some("6400".into()));
    assert!(quote.payable);
    assert_eq!(quote.line_totals[0].subtotal_cents, "20000");
    let under = store.quote(request.lines, Some("100".into())).unwrap();
    assert!(!under.payable);
    assert!(under.change_cents.is_none());
    let after = store.catalogue().unwrap();
    assert_eq!(before.confirmed_sales, after.confirmed_sales);
    assert_eq!(before.cash_cents, after.cash_cents);
    assert_eq!(before.products[0].stock, after.products[0].stock);
    assert_eq!(before.pending_operations, after.pending_operations);
    assert!(after.pending_attempt.is_none());
}
#[test]
fn encrypted_catalogue_seed_is_durable_and_reopen_never_resets_stock() {
    let f = Fixture::new();
    let store = QaCheckout::create(&f.0, key()).unwrap();
    assert_eq!(store.catalogue().unwrap().products.len(), 10);
    let r = store.confirm(sale("2", "30000")).unwrap();
    assert_eq!(r.total_cents, "23600");
    assert_eq!(r.change_cents, "6400");
    assert_eq!(r.remote_status, "NOT_ENABLED");
    drop(store);
    let store = QaCheckout::open(&f.0, key()).unwrap();
    let c = store.catalogue().unwrap();
    assert_eq!(c.products[0].stock, "98");
    assert_eq!(c.confirmed_sales, "1");
    assert_eq!(c.cash_cents, "23600");
    assert_eq!(c.last_result.unwrap(), r);
}
#[test]
fn hundred_replays_and_response_loss_have_only_one_set_of_effects() {
    let f = Fixture::new();
    let store = QaCheckout::create(&f.0, key()).unwrap();
    let request = sale("1", "20000");
    let result = store.confirm(request.clone()).unwrap();
    drop(store); // respuesta UI podría haberse perdido; intención conserva identidad
    let store = QaCheckout::open(&f.0, key()).unwrap();
    for _ in 0..100 {
        assert_eq!(store.confirm(request.clone()).unwrap(), result);
    }
    let c = store.catalogue().unwrap();
    assert_eq!(c.confirmed_sales, "1");
    assert_eq!(c.products[0].stock, "99");
    assert_eq!(c.cash_cents, "11800");
    assert_eq!(c.pending_operations, "1");
    assert_eq!(
        store
            .operation_result(&request.operation_id)
            .unwrap()
            .unwrap(),
        result
    );
}
#[test]
fn identity_conflict_is_rejected_without_new_effects() {
    let f = Fixture::new();
    let store = QaCheckout::create(&f.0, key()).unwrap();
    let request = sale("1", "20000");
    store.confirm(request.clone()).unwrap();
    let mut incompatible = request;
    incompatible.lines[0].quantity = "2".into();
    assert_eq!(
        store.confirm(incompatible).unwrap_err().code(),
        "OPERATION_ID_CONFLICT"
    );
    assert_eq!(store.catalogue().unwrap().products[0].stock, "99");
}
#[test]
fn invalid_quantity_stale_revision_and_payment_do_not_change_stock_or_cash() {
    let f = Fixture::new();
    let store = QaCheckout::create(&f.0, key()).unwrap();
    for (qty, tender) in [
        ("1.5", "20000"),
        ("0", "20000"),
        ("01", "20000"),
        ("101", "2000000"),
        ("1", "100"),
    ] {
        assert!(store.confirm(sale(qty, tender)).is_err());
    }
    let mut stale = sale("1", "20000");
    stale.lines[0].revision = "2".into();
    assert_eq!(store.confirm(stale).unwrap_err().code(), "VERSION_CONFLICT");
    let c = store.catalogue().unwrap();
    assert_eq!(c.confirmed_sales, "0");
    assert_eq!(c.products[0].stock, "100");
    assert_eq!(c.cash_cents, "0");
    assert!(serde_json::from_value::<QaSaleRequest>(
        serde_json::json!({"operationId":"x", "lines":[],"tenderCents":"1","tenantId":"other"})
    )
    .is_err());
}
#[test]
fn failure_after_stock_and_sale_rolls_back_every_effect_and_independent_sale_progresses() {
    let f = Fixture::new();
    let store = QaCheckout::create(&f.0, key()).unwrap();
    drop(store);
    let mut writer = VaultWriter::open_encrypted(&f.0, &key()).unwrap();
    writer.connection().execute_batch("CREATE TRIGGER qa_fault BEFORE INSERT ON qa_cash_entries WHEN NEW.amount_cents=11800 BEGIN SELECT RAISE(ABORT,'synthetic fault'); END;").unwrap();
    drop(writer);
    let store = QaCheckout::open(&f.0, key()).unwrap();
    let failed = sale("1", "20000");
    assert!(store.confirm(failed.clone()).is_err());
    assert!(store
        .operation_result(&failed.operation_id)
        .unwrap()
        .is_none());
    let c = store.catalogue().unwrap();
    assert_eq!(c.products[0].stock, "100");
    assert_eq!(c.confirmed_sales, "0");
    assert_eq!(c.pending_operations, "0");
    assert_eq!(c.pending_attempt.unwrap().operation_id, failed.operation_id);
    store.confirm(sale("2", "30000")).unwrap();
    assert_eq!(store.catalogue().unwrap().products[0].stock, "98");
}
