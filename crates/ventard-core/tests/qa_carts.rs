#![cfg(feature = "qa-spike")]
use std::path::PathBuf;
use ventard_core::{
    qa::{QaCartAction, QaCartSave, QaCheckout, QaSaleRequest},
    storage::{cipher::CipherKey, writer::VaultWriter},
};
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!("ventard-cart-qa-{}", uuid::Uuid::new_v4()));
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
            .starts_with("ventard-cart-qa-"));
        let _ = std::fs::remove_dir_all(p);
    }
}
fn key() -> CipherKey {
    CipherKey::new([0x75; 32])
}
fn save(id: Option<&str>, rev: Option<&str>, qty: &str) -> QaCartSave {
    serde_json::from_value(serde_json::json!({"requestId":uuid::Uuid::new_v4().to_string(),"cartId":id,"expectedRevision":rev,"lines":[{"productId":"qa-product-01","quantity":qty,"revision":"1"}]})).unwrap()
}
fn action(
    kind: &str,
    id: &str,
    rev: &str,
    active: Option<&str>,
    active_rev: Option<&str>,
) -> QaCartAction {
    serde_json::from_value(serde_json::json!({"requestId":uuid::Uuid::new_v4().to_string(),"action":kind,"cartId":id,"expectedRevision":rev,"activeCartId":active,"activeRevision":active_rev})).unwrap()
}
#[test]
fn cart_is_durable_but_never_moves_stock_cash_or_outbox() {
    let f = Fixture::new();
    let s = QaCheckout::create(&f.0, key()).unwrap();
    let req = save(None, None, "2");
    let ack = s.save_cart(req.clone()).unwrap();
    assert_eq!(
        ack.workspace.active.as_ref().unwrap().lines[0].quantity,
        "2"
    );
    for _ in 0..100 {
        let replay = s.save_cart(req.clone()).unwrap();
        assert_eq!(replay.cart_id, ack.cart_id);
        assert_eq!(replay.revision, "1");
    }
    let mut incompatible = req;
    incompatible.lines[0].quantity = "3".into();
    assert_eq!(
        s.save_cart(incompatible).unwrap_err().code(),
        "OPERATION_ID_CONFLICT"
    );
    drop(s);
    let s = QaCheckout::open(&f.0, key()).unwrap();
    let c = s.catalogue().unwrap();
    assert_eq!(c.carts.active.unwrap().lines[0].quantity, "2");
    assert_eq!(c.products[0].stock, "100");
    assert_eq!(c.cash_cents, "0");
    assert_eq!(c.pending_operations, "0");
    assert_eq!(c.confirmed_sales, "0");
}
#[test]
fn pause_resume_with_occupied_cart_swaps_atomically_without_losing_either() {
    let f = Fixture::new();
    let s = QaCheckout::create(&f.0, key()).unwrap();
    let a = s.save_cart(save(None, None, "1")).unwrap();
    s.cart_action(action("PAUSE", &a.cart_id, "1", None, None))
        .unwrap();
    let b = s.save_cart(save(None, None, "2")).unwrap();
    let req = action("RESUME", &a.cart_id, "2", Some(&b.cart_id), Some("1"));
    let resumed = s.cart_action(req.clone()).unwrap();
    assert_eq!(resumed.workspace.active.as_ref().unwrap().id, a.cart_id);
    assert_eq!(resumed.workspace.paused[0].id, b.cart_id);
    assert_eq!(s.cart_action(req).unwrap().workspace, resumed.workspace);
    drop(s);
    let s = QaCheckout::open(&f.0, key()).unwrap();
    let c = s.catalogue().unwrap();
    assert_eq!(c.carts.active.unwrap().lines[0].quantity, "1");
    assert_eq!(c.carts.paused[0].lines[0].quantity, "2");
}
#[test]
fn stale_version_bad_quantity_and_failed_swap_leave_original_cart_untouched() {
    let f = Fixture::new();
    let s = QaCheckout::create(&f.0, key()).unwrap();
    let a = s.save_cart(save(None, None, "1")).unwrap();
    assert_eq!(
        s.save_cart(save(Some(&a.cart_id), Some("2"), "2"))
            .unwrap_err()
            .code(),
        "VERSION_CONFLICT"
    );
    assert!(s
        .save_cart(save(Some(&a.cart_id), Some("1"), "1.5"))
        .is_err());
    s.cart_action(action("PAUSE", &a.cart_id, "1", None, None))
        .unwrap();
    let b = s.save_cart(save(None, None, "2")).unwrap();
    let before = s.catalogue().unwrap().carts;
    assert!(s
        .cart_action(action(
            "RESUME",
            &a.cart_id,
            "2",
            Some(&b.cart_id),
            Some("2")
        ))
        .is_err());
    assert_eq!(s.catalogue().unwrap().carts, before);
}
#[test]
fn sale_consumes_only_its_cart_in_same_commit_and_replay_does_not_consume_new_cart() {
    let f = Fixture::new();
    let s = QaCheckout::create(&f.0, key()).unwrap();
    let a = s.save_cart(save(None, None, "1")).unwrap();
    let request:QaSaleRequest=serde_json::from_value(serde_json::json!({"operationId":uuid::Uuid::new_v4().to_string(),"cartId":a.cart_id,"expectedCartRevision":"1","lines":[{"productId":"qa-product-01","quantity":"1","revision":"1"}],"tenderCents":"20000"})).unwrap();
    let result = s.confirm(request.clone()).unwrap();
    assert!(s.catalogue().unwrap().carts.active.is_none());
    let b = s.save_cart(save(None, None, "2")).unwrap();
    assert_eq!(s.confirm(request).unwrap(), result);
    assert_eq!(s.catalogue().unwrap().carts.active.unwrap().id, b.cart_id);
    assert_eq!(s.catalogue().unwrap().products[0].stock, "99");
}
#[test]
fn failed_sale_keeps_prepared_cart_immutable_and_failure_after_sale_rolls_back_cart_consumption() {
    let f = Fixture::new();
    let s = QaCheckout::create(&f.0, key()).unwrap();
    let a = s.save_cart(save(None, None, "1")).unwrap();
    drop(s);
    let mut w = VaultWriter::open_encrypted(&f.0, &key()).unwrap();
    w.connection().execute_batch("CREATE TRIGGER qa_cart_fault BEFORE UPDATE OF status ON qa_carts WHEN NEW.status='COMMITTED' BEGIN SELECT RAISE(ABORT,'synthetic fault'); END;").unwrap();
    drop(w);
    let s = QaCheckout::open(&f.0, key()).unwrap();
    let req:QaSaleRequest=serde_json::from_value(serde_json::json!({"operationId":uuid::Uuid::new_v4().to_string(),"cartId":a.cart_id,"expectedCartRevision":"1","lines":[{"productId":"qa-product-01","quantity":"1","revision":"1"}],"tenderCents":"20000"})).unwrap();
    assert!(s.confirm(req).is_err());
    let c = s.catalogue().unwrap();
    assert_eq!(c.products[0].stock, "100");
    assert_eq!(c.confirmed_sales, "0");
    assert_eq!(c.cash_cents, "0");
    assert_eq!(c.carts.active.unwrap().id, a.cart_id);
    assert!(s.save_cart(save(Some(&a.cart_id), Some("1"), "2")).is_err());
    assert!(s
        .cart_action(action("PAUSE", &a.cart_id, "1", None, None))
        .is_err());
}

#[test]
fn ten_paused_limit_keeps_active_and_full_swap_remains_possible() {
    let f = Fixture::new();
    let s = QaCheckout::create(&f.0, key()).unwrap();
    let mut first = None;
    for _ in 0..10 {
        let a = s.save_cart(save(None, None, "1")).unwrap();
        if first.is_none() {
            first = Some(a.cart_id.clone());
        }
        s.cart_action(action("PAUSE", &a.cart_id, "1", None, None))
            .unwrap();
    }
    let current = s.save_cart(save(None, None, "2")).unwrap();
    assert!(s
        .cart_action(action("PAUSE", &current.cart_id, "1", None, None))
        .is_err());
    assert_eq!(s.catalogue().unwrap().carts.paused.len(), 10);
    let first = first.unwrap();
    let result = s
        .cart_action(action(
            "RESUME",
            &first,
            "2",
            Some(&current.cart_id),
            Some("1"),
        ))
        .unwrap();
    assert_eq!(result.workspace.paused.len(), 10);
    assert_eq!(result.workspace.active.unwrap().id, first);
    let discard = s
        .cart_action(action("DISCARD", &current.cart_id, "2", None, None))
        .unwrap();
    assert_eq!(discard.workspace.paused.len(), 9);
    assert_eq!(s.catalogue().unwrap().confirmed_sales, "0");
    assert_eq!(s.catalogue().unwrap().products[0].stock, "100");
}

#[test]
fn migration_from_pre_cart_vault_preserves_legacy_sale_hash_and_has_no_phantom_cart() {
    let f = Fixture::new();
    let s = QaCheckout::create(&f.0, key()).unwrap();
    let old:QaSaleRequest=serde_json::from_value(serde_json::json!({"operationId":uuid::Uuid::new_v4().to_string(),"lines":[{"productId":"qa-product-01","quantity":"1","revision":"1"}],"tenderCents":"20000"})).unwrap();
    let result = s.confirm(old.clone()).unwrap();
    drop(s);
    let mut w = VaultWriter::open_encrypted(&f.0, &key()).unwrap();
    w.connection()
        .execute_batch(
            "DROP TABLE qa_cart_requests; DROP TABLE qa_carts; DROP TABLE qa_cart_schema;",
        )
        .unwrap();
    drop(w);
    let s = QaCheckout::open(&f.0, key()).unwrap();
    let c = s.catalogue().unwrap();
    assert!(c.carts.active.is_none());
    assert!(c.carts.paused.is_empty());
    assert_eq!(c.products[0].stock, "99");
    assert_eq!(c.cash_cents, "11800");
    assert_eq!(s.confirm(old).unwrap(), result);
    drop(s);
    let mut w = VaultWriter::open_encrypted(&f.0, &key()).unwrap();
    w.connection()
        .execute(
            "UPDATE qa_cart_schema SET checksum='tampered' WHERE id=1",
            [],
        )
        .unwrap();
    drop(w);
    assert!(QaCheckout::open(&f.0, key()).is_err());
}
