#![cfg(feature = "encrypted-storage")]
use ed25519_dalek::{Signer, SigningKey};
use rusqlite::Connection;
use serde_json::json;
use sha2::{Digest, Sha256};
use ventard_core::fiscal::requests;
use ventard_core::{
    application::{checkout::*, operations::execute_prepared_operation, ticket_sequence::*},
    domain::{
        canonical::canonicalize,
        identity::{EntityId, Scope, TenantRef},
        money::MoneyCents,
        quantity::Ratio,
        sale_inventory::*,
        sale_payment::Payment,
        sale_plan::*,
        sale_quote::Discount,
    },
    fiscal::reservations::*,
    security::offline_grant::*,
    storage::{catalogue_preview::CatalogueContext, migrations},
};

#[test]
fn fiscal_request_is_durable_and_retries_keep_id_and_hash() {
    let mut c = db();
    let g = grant();
    let first = requests::prepare(&mut c, &g, 1000, 0, 0, NcfKind::B02).unwrap();
    let retry = requests::prepare(&mut c, &g, 1000, 0, 0, NcfKind::B02).unwrap();
    assert_eq!(first, retry);
    assert_eq!(first.payload["quantity"], "20");
    assert_eq!(first.payload["version"], "2");
    let (canonical, hash) = canonicalize(&serde_json::to_vec(&first.payload).unwrap()).unwrap();
    assert_eq!(first.hash, hash);
    assert!(!canonical.contains(' '));
    assert_eq!(requests::read(&c, &ctx()).unwrap().pending.len(), 1);
}
fn allocation_receipt(r: &requests::AllocationRequest, start: u32) -> serde_json::Value {
    let mut receipt = r.payload.clone();
    let o = receipt.as_object_mut().unwrap();
    o.insert("payloadHash".into(), json!(r.hash));
    o.insert("status".into(), json!("ALLOCATED"));
    o.insert("first".into(), json!(start.to_string()));
    o.insert("last".into(), json!((start + 19).to_string()));
    o.insert("sourceRef".into(), json!(id(98)));
    o.insert("reason".into(), serde_json::Value::Null);
    receipt
}
#[test]
fn exact_receipt_and_request_completion_are_atomic_and_replay_preserves_cursor() {
    let mut c = db();
    let g = grant();
    let r = requests::prepare(&mut c, &g, 1000, 0, 0, NcfKind::B02).unwrap();
    let receipt = allocation_receipt(&r, 100);
    requests::accept(&mut c, &g, 1000, 0, 0, &r, &receipt).unwrap();
    c.execute("UPDATE fiscal_blocks SET next_number=102", [])
        .unwrap();
    requests::accept(&mut c, &g, 1000, 0, 0, &r, &receipt).unwrap();
    assert_eq!(
        c.query_row("SELECT next_number FROM fiscal_blocks", [], |r| r
            .get::<_, u32>(0))
            .unwrap(),
        102
    );
    let view = requests::read(&c, &ctx()).unwrap();
    assert!(view.pending.is_empty());
    assert_eq!(view.available_b02, "18");
    assert_ne!(
        requests::prepare(&mut c, &g, 1000, 0, 0, NcfKind::B02)
            .unwrap()
            .request_id(),
        r.request_id()
    );
}
#[test]
fn wrong_receipt_does_not_finish_request_or_insert_block() {
    for field in [
        "tenantId",
        "actorId",
        "installationId",
        "writerEpoch",
        "kind",
        "payloadHash",
        "branchId",
        "last",
    ] {
        let mut c = db();
        let g = grant();
        let r = requests::prepare(&mut c, &g, 1000, 0, 0, NcfKind::B02).unwrap();
        let mut receipt = allocation_receipt(&r, 100);
        receipt[field] = json!("incompatible");
        assert!(
            requests::accept(&mut c, &g, 1000, 0, 0, &r, &receipt).is_err(),
            "{field}"
        );
        assert_eq!(requests::read(&c, &ctx()).unwrap().pending.len(), 1);
        assert_eq!(
            c.query_row("SELECT count(*) FROM fiscal_blocks", [], |r| r
                .get::<_, u32>(0))
                .unwrap(),
            0
        );
    }
    let mut c = db();
    let g = grant();
    let r = requests::prepare(&mut c, &g, 1000, 0, 0, NcfKind::B02).unwrap();
    let mut receipt = allocation_receipt(&r, 100);
    let object = receipt.as_object_mut().unwrap();
    object.remove("reason");
    object.insert(
        "unexpectedSensitiveField".into(),
        json!("synthetic-redacted"),
    );
    assert!(requests::accept(&mut c, &g, 1000, 0, 0, &r, &receipt).is_err());
    assert_eq!(requests::read(&c, &ctx()).unwrap().pending.len(), 1);
}
#[test]
fn no_block_is_terminal_without_fabricating_numbers() {
    let mut c = db();
    let g = grant();
    let r = requests::prepare(&mut c, &g, 1000, 0, 0, NcfKind::B01).unwrap();
    let mut receipt = allocation_receipt(&r, 100);
    receipt["status"] = json!("NO_BLOCK");
    receipt["reason"] = json!("KIND_NOT_CONFIGURED");
    receipt["first"] = serde_json::Value::Null;
    receipt["last"] = serde_json::Value::Null;
    requests::accept(&mut c, &g, 1000, 0, 0, &r, &receipt).unwrap();
    assert!(requests::read(&c, &ctx()).unwrap().pending.is_empty());
    assert_eq!(
        c.query_row("SELECT count(*) FROM fiscal_blocks", [], |r| r
            .get::<_, u32>(0))
            .unwrap(),
        0
    );
}
#[test]
fn accepting_receipt_rolls_back_block_watermark_and_request_on_storage_failure() {
    let mut c = db();
    let g = grant();
    let r = requests::prepare(&mut c, &g, 1000, 0, 0, NcfKind::B02).unwrap();
    c.execute_batch("CREATE TRIGGER fail_receipt_update BEFORE UPDATE ON fiscal_requests_v2 BEGIN SELECT RAISE(ABORT,'synthetic storage error'); END;").unwrap();
    assert!(requests::accept(&mut c, &g, 1000, 0, 0, &r, &allocation_receipt(&r, 1)).is_err());
    assert_eq!(requests::read(&c, &ctx()).unwrap().pending.len(), 1);
    for table in ["fiscal_blocks", "fiscal_watermarks"] {
        assert_eq!(
            c.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r
                .get::<_, u32>(0))
                .unwrap(),
            0
        );
    }
}
#[test]
fn preparation_does_not_require_or_create_commercial_installation_or_activate_stock() {
    let mut c = db();
    let g = grant();
    c.execute("DELETE FROM installations", []).unwrap();
    let r = requests::prepare(&mut c, &g, 1000, 0, 0, NcfKind::B02).unwrap();
    requests::accept(&mut c, &g, 1000, 0, 0, &r, &allocation_receipt(&r, 1)).unwrap();
    assert_eq!(requests::read(&c, &ctx()).unwrap().available_b02, "20");
    for table in ["installations", "stock_projections", "sales", "outbox"] {
        assert_eq!(
            c.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r
                .get::<_, u32>(0))
                .unwrap(),
            0
        );
    }
    let mut other = ctx();
    other.branch_id = Some(id(99));
    assert!(requests::read(&c, &other).unwrap().pending.is_empty());
    // Fiscal blocks are installation-bound, not inferred from scope/actor.
    other.installation_id = id(100);
    assert_eq!(requests::read(&c, &other).unwrap().available_b02, "0");
}
#[test]
fn v9_to_v10_is_additive_and_preserves_allocated_blocks_and_cursor() {
    let mut c = db();
    let g = grant();
    store_allocated_block(&mut c, &g, 1000, 0, 0, &block(NcfKind::B02, 1, 20, 77)).unwrap();
    c.execute("UPDATE fiscal_blocks SET next_number=7", [])
        .unwrap();
    let evidence: Vec<u8> = c
        .query_row("SELECT evidence_bytes FROM fiscal_blocks", [], |r| r.get(0))
        .unwrap();
    c.execute_batch("DROP TABLE fiscal_requests_v2;DELETE FROM migration_history WHERE version>=10;PRAGMA user_version=9;").unwrap();
    assert_eq!(migrations::validate_history(&c).unwrap(), 9);
    migrations::apply(&mut c).unwrap();
    assert_eq!(migrations::validate_history(&c).unwrap(), 21);
    assert_eq!(
        c.query_row("SELECT evidence_bytes FROM fiscal_blocks", [], |r| r
            .get::<_, Vec<u8>>(0))
            .unwrap(),
        evidence
    );
    assert_eq!(requests::read(&c, &ctx()).unwrap().available_b02, "14");
}
#[test]
fn pending_request_survives_reopening_encrypted_vault() {
    use ventard_core::storage::writer::WriterActor;
    let path = std::env::temp_dir().join(format!("ventard-fiscal-{}", EntityId::new_random()));
    std::fs::create_dir(&path).unwrap();
    let key = ventard_core::storage::cipher::CipherKey::new([0x38; 32]);
    let w = WriterActor::create_encrypted(&path, key).unwrap();
    let first = w
        .call(|c| {
            populate(c);
            Ok(requests::prepare(c, &grant(), 1000, 0, 0, NcfKind::B02).unwrap())
        })
        .unwrap();
    drop(w);
    let key = ventard_core::storage::cipher::CipherKey::new([0x38; 32]);
    let w = WriterActor::open_encrypted(&path, key).unwrap();
    let retry = w
        .call(|c| Ok(requests::prepare(c, &grant(), 1000, 0, 0, NcfKind::B02).unwrap()))
        .unwrap();
    assert_eq!(first, retry);
    drop(w);
    // This test owns only its explicit random synthetic temp directory.
    let absolute = path.canonicalize().unwrap();
    assert!(absolute.starts_with(std::env::temp_dir().canonicalize().unwrap()));
    assert!(absolute
        .file_name()
        .unwrap()
        .to_str()
        .unwrap()
        .starts_with("ventard-fiscal-"));
    std::fs::remove_dir_all(absolute).unwrap();
}
fn id(n: u32) -> String {
    format!("96000000-0000-4000-8000-{n:012}")
}
fn entity(n: u32) -> EntityId {
    EntityId::parse(&id(n)).unwrap()
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
fn grant() -> VerifiedGrant {
    let key = SigningKey::from_bytes(&[0x63; 32]);
    let p = json!({"protocol":"ventard.offline-grant.v1","keyId":"fiscal-fixture-1","issuer":"ventard.staging","audience":"ventard.native.staging.v1","grantId":id(10),"grantSequence":"1","policyVersion":"1","tenantId":id(1),"actorId":id(2),"deviceId":id(3),"installationId":id(4),"writerEpoch":"1","scope":{"type":"BRANCH","branchId":id(5)},"role":"owner","capabilities":["READ","SELL"],"issuedAtMs":"1000","actorExpiresAtMs":null,"license":{"planActive":true,"accessUntilMs":null,"trialUntilMs":null,"graceDays":"5","warnAfterOpenings":"200","blockAfterOpenings":"300"}});
    let (raw, _) = canonicalize(&serde_json::to_vec(&p).unwrap()).unwrap();
    let signature = key
        .sign(raw.as_bytes())
        .to_bytes()
        .iter()
        .map(|v| format!("{v:02x}"))
        .collect::<String>();
    verify_grant(
        &serde_json::to_vec(&json!({"payload":p,"signature":signature})).unwrap(),
        &[TrustedGrantKey::new("fiscal-fixture-1", key.verifying_key().to_bytes()).unwrap()],
        &GrantContext {
            tenant_id: id(1),
            actor_id: id(2),
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
fn populate(c: &Connection) {
    c.execute(
        "INSERT INTO scopes VALUES('fixture-scope','BRANCH',?1,?2)",
        (id(5), id(1)),
    )
    .unwrap();
    c.execute(
        "INSERT INTO vault_meta VALUES(?1,?2,9,'synthetic','SQLCipher','ACTIVE',0)",
        (id(6), id(1)),
    )
    .unwrap();
    c.execute(
        "INSERT INTO installations VALUES(?1,?2,1,'SYNTHETIC','1000','ACTIVE')",
        (id(4), id(3)),
    )
    .unwrap();
    let key = format!("{:x}", Sha256::digest(serde_json::to_vec(&ctx()).unwrap()));
    c.execute(
        "INSERT INTO account_drafts VALUES(?1,?2,1,1,'ACTIVE',?3)",
        (
            key,
            id(21),
            json!([{"productId":id(11),"quantity":"1","revision":id(22)}]).to_string(),
        ),
    )
    .unwrap();
}
fn db() -> Connection {
    let mut c = Connection::open_in_memory().unwrap();
    c.pragma_update(None, "foreign_keys", true).unwrap();
    migrations::apply(&mut c).unwrap();
    populate(&c);
    c
}
fn sale() -> ValidatedSale {
    let p = SaleProductFacts {
        inventory: InventoryProduct {
            reference: TenantRef {
                negocio_id: entity(1),
                id: entity(11),
            },
            scope: Scope::Branch(entity(5)),
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
        name: "Synthetic fiscal fixture".into(),
        unit_price: MoneyCents::from_cents(100).unwrap(),
        tax_rate: Ratio::zero(),
        cost: None,
    };
    plan_sale(
        entity(1),
        Scope::Branch(entity(5)),
        &[SaleSelection::Product(InventoryLine {
            product_id: entity(11),
            quantity: Ratio::one(),
            expected_revision: "metadata-1".into(),
            serial: None,
        })],
        &[p],
        &[],
        &Discount::Amount(MoneyCents::ZERO),
        &Payment::Card,
        None,
        None,
    )
    .unwrap()
}
fn req(op: u32, kind: Option<NcfKind>) -> CheckoutPrepare {
    CheckoutPrepare {
        operation_id: id(op),
        cart_id: id(21),
        expected_revision: "1".into(),
        accepted_quote_hash: sale().quote_hash().into(),
        fiscal_type: kind,
    }
}
fn block(kind: NcfKind, from: u32, to: u32, request: u32) -> AllocatedBlockEvidence {
    AllocatedBlockEvidence {
        request_id: id(request),
        tenant_id: id(1),
        device_id: id(3),
        installation_id: id(4),
        writer_epoch: "1".into(),
        kind,
        first: from,
        last: to,
        source_ref: id(90),
    }
}
fn prep(c: &mut Connection, op: u32, kind: Option<NcfKind>) -> CheckoutView {
    prepare_checkout(c, &grant(), 2000, 2000, 1, req(op, kind), &sale()).unwrap()
}
#[test]
fn block_evidence_is_idempotent_tenant_bound_and_cannot_lower_watermark() {
    let mut c = db();
    let b = block(NcfKind::B01, 41, 42, 80);
    store_allocated_block(&mut c, &grant(), 2000, 2000, 1, &b).unwrap();
    for _ in 0..100 {
        store_allocated_block(&mut c, &grant(), 2000, 2000, 1, &b).unwrap();
    }
    let mut wrong = block(NcfKind::B01, 43, 44, 81);
    wrong.tenant_id = id(99);
    assert!(store_allocated_block(&mut c, &grant(), 2000, 2000, 1, &wrong).is_err());
    let changed = block(NcfKind::B01, 41, 43, 80);
    assert_eq!(
        store_allocated_block(&mut c, &grant(), 2000, 2000, 1, &changed)
            .unwrap_err()
            .code(),
        "OPERATION_ID_CONFLICT"
    );
    assert!(store_allocated_block(
        &mut c,
        &grant(),
        2000,
        2000,
        1,
        &block(NcfKind::B01, 40, 41, 82)
    )
    .is_err());
    assert_eq!(
        c.query_row::<i64, _, _>("SELECT last_accepted FROM fiscal_watermarks", [], |r| r
            .get(0))
            .unwrap(),
        42
    );
}
#[test]
fn fiscal_prepare_replay_abandon_and_exhaustion_never_reuse_numbers() {
    let mut c = db();
    store_allocated_block(
        &mut c,
        &grant(),
        2000,
        2000,
        1,
        &block(NcfKind::B02, 41, 42, 80),
    )
    .unwrap();
    let first = prep(&mut c, 30, Some(NcfKind::B02));
    assert_eq!(
        first.intent["payload"]["sale"]["fiscal"]["ncf"],
        "B0200000041"
    );
    for _ in 0..100 {
        assert_eq!(prep(&mut c, 30, Some(NcfKind::B02)), first);
    }
    assert!(prepare_checkout(
        &mut c,
        &grant(),
        2000,
        2000,
        1,
        req(30, Some(NcfKind::B01)),
        &sale()
    )
    .is_err());
    abandon_checkout(&mut c, &grant(), 2000, 2000, 1, &id(30), &first.hash).unwrap();
    assert_eq!(
        c.query_row::<String, _, _>(
            "SELECT state FROM fiscal_reservations WHERE operation_id=?1",
            [id(30)],
            |r| r.get(0)
        )
        .unwrap(),
        "ABANDONED"
    );
    let second = prep(&mut c, 31, Some(NcfKind::B02));
    assert_eq!(
        second.intent["payload"]["sale"]["fiscal"]["ncf"],
        "B0200000042"
    );
    abandon_checkout(&mut c, &grant(), 2000, 2000, 1, &id(31), &second.hash).unwrap();
    assert_eq!(
        prepare_checkout(
            &mut c,
            &grant(),
            2000,
            2000,
            1,
            req(32, Some(NcfKind::B02)),
            &sale()
        )
        .unwrap_err()
        .code(),
        "FISCAL_EXHAUSTED"
    );
    assert_eq!(
        c.query_row::<i64, _, _>("SELECT count(*) FROM outbox", [], |r| r.get(0))
            .unwrap(),
        0
    );
}
#[test]
fn prepare_failure_rolls_back_number_cursor_journal_and_checkout() {
    let mut c = db();
    store_allocated_block(
        &mut c,
        &grant(),
        2000,
        2000,
        1,
        &block(NcfKind::B01, 99_999_999, 99_999_999, 80),
    )
    .unwrap();
    c.execute_batch("CREATE TRIGGER fail_reservation BEFORE INSERT ON fiscal_reservations BEGIN SELECT RAISE(ABORT,'fixture');END;").unwrap();
    assert!(prepare_checkout(
        &mut c,
        &grant(),
        2000,
        2000,
        1,
        req(30, Some(NcfKind::B01)),
        &sale()
    )
    .is_err());
    assert_eq!(
        c.query_row::<i64, _, _>("SELECT count(*) FROM operation_journal", [], |r| r.get(0))
            .unwrap(),
        0
    );
    assert_eq!(
        c.query_row::<i64, _, _>("SELECT next_number FROM fiscal_blocks", [], |r| r.get(0))
            .unwrap(),
        99_999_999
    );
    c.execute_batch("DROP TRIGGER fail_reservation;").unwrap();
    assert_eq!(
        prep(&mut c, 30, Some(NcfKind::B01)).intent["payload"]["sale"]["fiscal"]["ncf"],
        "B0199999999"
    );
}
#[test]
fn unknown_legacy_request_never_becomes_a_new_retry_or_an_authorized_pool() {
    assert_eq!(
        request_recovery(1, RequestState::Unknown),
        RequestRecovery::NoAutomaticRetry
    );
    assert_eq!(
        request_recovery(2, RequestState::Unknown),
        RequestRecovery::LookupSameId
    );
    assert_eq!(
        request_recovery(2, RequestState::InFlight),
        RequestRecovery::LookupSameId
    );
    let mut c = db();
    assert_eq!(
        prepare_checkout(
            &mut c,
            &grant(),
            2000,
            2000,
            1,
            req(30, Some(NcfKind::B01)),
            &sale()
        )
        .unwrap_err()
        .code(),
        "FISCAL_UNKNOWN"
    );
    assert_eq!(
        c.query_row::<i64, _, _>("SELECT count(*) FROM operation_journal", [], |r| r.get(0))
            .unwrap(),
        0
    );
}
#[test]
fn ticket_requires_seed_evidence_replays_and_survives_history_purge() {
    let mut c = db();
    let g = grant();
    let first = prep(&mut c, 30, None);
    assert!(
        execute_prepared_operation(&mut c, &id(30), &first.hash, |tx| {
            let ticket = issue_ticket_in(tx, &ctx(), &id(30), &first.hash)?;
            Ok(json!({"ticket":ticket}))
        })
        .is_err()
    );
    let seed = TicketSeedEvidence {
        prefix: "SYNTHETIC".into(),
        last_issued: 40,
        source_ref: id(91),
    };
    register_ticket_seed(&mut c, &g, 2000, 2000, 1, &seed).unwrap();
    let original = execute_prepared_operation(&mut c, &id(30), &first.hash, |tx| {
        let ticket = issue_ticket_in(tx, &ctx(), &id(30), &first.hash)?;
        Ok(json!({"ticket":ticket}))
    })
    .unwrap();
    assert_eq!(original["ticket"], "SYNTHETIC-000041");
    for _ in 0..100 {
        assert_eq!(
            execute_prepared_operation(&mut c, &id(30), &first.hash, |_| panic!(
                "no second effect"
            ))
            .unwrap(),
            original
        );
    }
    c.execute("INSERT INTO sales VALUES(?1,?2,?3,'fixture-scope','fixture-turn',?4,NULL,?5,100,0,0,'fixture','2000')",(id(92),id(30),id(1),"SYNTHETIC-000041",id(2))).unwrap();
    assert_eq!(c.execute("DELETE FROM sales", []).unwrap(), 1);
    register_ticket_seed(&mut c, &g, 2000, 2000, 1, &seed).unwrap();
    let second = prep(&mut c, 31, None);
    let result = execute_prepared_operation(&mut c, &id(31), &second.hash, |tx| {
        Ok(json!({"ticket":issue_ticket_in(tx,&ctx(),&id(31),&second.hash)?}))
    })
    .unwrap();
    assert_eq!(result["ticket"], "SYNTHETIC-000042");
}
#[test]
fn ticket_and_ncf_consumption_rollback_with_the_parent_commit() {
    let mut c = db();
    store_allocated_block(
        &mut c,
        &grant(),
        2000,
        2000,
        1,
        &block(NcfKind::B01, 1, 2, 80),
    )
    .unwrap();
    register_ticket_seed(
        &mut c,
        &grant(),
        2000,
        2000,
        1,
        &TicketSeedEvidence {
            prefix: "SYNTHETIC".into(),
            last_issued: 0,
            source_ref: id(91),
        },
    )
    .unwrap();
    let first = prep(&mut c, 30, Some(NcfKind::B01));
    assert!(
        execute_prepared_operation(&mut c, &id(30), &first.hash, |tx| {
            issue_ticket_in(tx, &ctx(), &id(30), &first.hash)?;
            consume_in(tx, &ctx(), &id(30), &first.hash)?;
            Err(ventard_core::application::errors::AppError::Storage(
                "LOCAL_STORAGE_IO".into(),
            ))
        })
        .is_err()
    );
    assert_eq!(
        c.query_row::<i64, _, _>("SELECT last_issued FROM ticket_sequences", [], |r| r.get(0))
            .unwrap(),
        0
    );
    assert_eq!(
        c.query_row::<String, _, _>("SELECT state FROM fiscal_reservations", [], |r| r.get(0))
            .unwrap(),
        "PREPARED"
    );
    execute_prepared_operation(&mut c, &id(30), &first.hash, |tx| {
        let ticket = issue_ticket_in(tx, &ctx(), &id(30), &first.hash)?;
        consume_in(tx, &ctx(), &id(30), &first.hash)?;
        Ok(json!({"ticket":ticket}))
    })
    .unwrap();
    assert_eq!(
        c.query_row::<String, _, _>("SELECT state FROM fiscal_reservations", [], |r| r.get(0))
            .unwrap(),
        "COMMITTED"
    );
    assert!(abandon_checkout(&mut c, &grant(), 2000, 2000, 1, &id(30), &first.hash).is_err());
}

#[test]
fn mismatched_fiscal_evidence_never_recovers_as_a_valid_checkout() {
    let mut c = db();
    store_allocated_block(
        &mut c,
        &grant(),
        2000,
        2000,
        1,
        &block(NcfKind::B01, 1, 2, 80),
    )
    .unwrap();
    let first = prep(&mut c, 30, Some(NcfKind::B01));
    c.execute(
        "UPDATE fiscal_reservations SET intention_hash=?1",
        ["0".repeat(64)],
    )
    .unwrap();
    assert!(read_checkout(&c, &grant(), 2000, 2000, 1, &id(30), &first.hash).is_err());
}

#[test]
fn v8_upgrade_and_encrypted_reopen_preserve_pin_cart_and_fiscal_counter() {
    use ventard_core::{
        security::local_auth::{enroll_pin, unlock_pin},
        storage::{cipher::CipherKey, writer::VaultWriter},
    };
    use zeroize::Zeroizing;
    let path =
        std::env::temp_dir().join(format!("ventard-fiscal-fixture-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&path).unwrap();
    let key = CipherKey::new([0x64; 32]);
    let g = grant();
    let pin = Zeroizing::new("6294".to_owned());
    let original;
    {
        let mut w = VaultWriter::create_encrypted(&path, &key).unwrap();
        let c = w.connection();
        populate(c);
        enroll_pin(c, &g, &pin, 2000).unwrap();
        original = prep(c, 30, None);
        c.execute_batch("DROP TABLE fiscal_requests_v2;DROP TABLE fiscal_reservations;DROP TABLE fiscal_blocks;DROP TABLE fiscal_watermarks;DROP TABLE ticket_allocations;DROP TABLE ticket_sequences;DELETE FROM migration_history WHERE version>=9;PRAGMA user_version=8;").unwrap();
        assert_eq!(migrations::validate_history(c).unwrap(), 8);
    }
    let next;
    {
        let mut w = VaultWriter::open_encrypted(&path, &key).unwrap();
        let c = w.connection();
        assert_eq!(migrations::validate_history(c).unwrap(), 21);
        assert!(unlock_pin(c, &g, &pin, 2100).unwrap().allows("READ"));
        assert_eq!(
            read_checkout(c, &g, 2100, 2100, 1, &id(30), &original.hash).unwrap(),
            original
        );
        abandon_checkout(c, &g, 2100, 2100, 1, &id(30), &original.hash).unwrap();
        store_allocated_block(c, &g, 2100, 2100, 1, &block(NcfKind::B01, 1, 2, 80)).unwrap();
        next = prep(c, 31, Some(NcfKind::B01));
    }
    {
        let mut w = VaultWriter::open_encrypted(&path, &key).unwrap();
        let c = w.connection();
        assert_eq!(
            read_checkout(c, &g, 2200, 2200, 1, &id(31), &next.hash).unwrap(),
            next
        );
        abandon_checkout(c, &g, 2200, 2200, 1, &id(31), &next.hash).unwrap();
        assert_eq!(
            prep(c, 32, Some(NcfKind::B01)).intent["payload"]["sale"]["fiscal"]["ncf"],
            "B0100000002"
        );
    }
    let absolute = path.canonicalize().unwrap();
    assert!(
        absolute.starts_with(std::env::temp_dir().canonicalize().unwrap())
            && absolute
                .file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .starts_with("ventard-fiscal-fixture-")
    );
    std::fs::remove_dir_all(absolute).unwrap();
}
