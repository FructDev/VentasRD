#![cfg(feature = "encrypted-storage")]
use ed25519_dalek::{Signer, SigningKey};
use rusqlite::Connection;
use serde_json::json;
use ventard_core::{
    application::cash::*,
    domain::canonical::canonicalize,
    security::offline_grant::*,
    storage::{catalogue_preview::CatalogueContext, migrations},
};
fn id(n: u32) -> String {
    format!("96000000-0000-4000-8000-{n:012}")
}
fn grant(actor: u32, branch: u32, sell: bool) -> VerifiedGrant {
    let key = SigningKey::from_bytes(&[0x29; 32]); // Synthetic public fixture, never client trust.
    let p = json!({"protocol":"ventard.offline-grant.v1","keyId":"cash-fixture-1","issuer":"ventard.staging","audience":"ventard.native.staging.v1","grantId":id(10),"grantSequence":"1","policyVersion":"1","tenantId":id(1),"actorId":id(actor),"deviceId":id(3),"installationId":id(4),"writerEpoch":"1","scope":{"type":"BRANCH","branchId":id(branch)},"role":"seller","capabilities":if sell {vec!["READ","SELL"]}else{vec!["READ"]},"issuedAtMs":"1000","actorExpiresAtMs":null,"license":{"planActive":true,"accessUntilMs":null,"trialUntilMs":null,"graceDays":"5","warnAfterOpenings":"200","blockAfterOpenings":"300"}});
    let (raw, _) = canonicalize(&serde_json::to_vec(&p).unwrap()).unwrap();
    let signature = key
        .sign(raw.as_bytes())
        .to_bytes()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    let ctx = GrantContext {
        tenant_id: id(1),
        actor_id: id(actor),
        device_id: id(3),
        installation_id: id(4),
        writer_epoch: "1".into(),
        scope_type: "BRANCH".into(),
        branch_id: Some(id(branch)),
        min_grant_sequence: "1".into(),
        audience: "ventard.native.staging.v1".into(),
    };
    verify_grant(
        &serde_json::to_vec(&json!({"payload":p,"signature":signature})).unwrap(),
        &[TrustedGrantKey::new("cash-fixture-1", key.verifying_key().to_bytes()).unwrap()],
        &ctx,
    )
    .unwrap()
}
fn ctx(actor: u32, branch: u32) -> CatalogueContext {
    CatalogueContext {
        tenant_id: id(1),
        actor_id: id(actor),
        device_id: id(3),
        installation_id: id(4),
        writer_epoch: "1".into(),
        scope_type: "BRANCH".into(),
        branch_id: Some(id(branch)),
    }
}
fn db() -> Connection {
    let mut c = Connection::open_in_memory().unwrap();
    migrations::apply(&mut c).unwrap();
    c
}
fn req(op: u32) -> TurnOpen {
    TurnOpen {
        operation_id: id(op),
        opening_cents: "50000".into(),
        expected_drawer_revision: "0".into(),
    }
}
#[test]
fn open_is_durable_replays_exactly_and_keeps_actor_and_original_timestamp() {
    let mut c = db();
    let g = grant(2, 5, true);
    let first = open_turn(&mut c, &g, 2000, 2000, 1, req(20)).unwrap();
    for _ in 0..100 {
        assert_eq!(
            open_turn(&mut c, &g, 3000, 3000, 2, req(20)).unwrap(),
            first
        );
    }
    assert_eq!(first.opening_cents, "50000");
    assert_eq!(first.remote_status, "PENDING");
    assert_eq!(first.actor_id, id(2));
    assert_eq!(first.opened_at_ms, "2000");
    assert_eq!(
        c.query_row::<i64, _, _>("SELECT count(*) FROM cash_turns", [], |r| r.get(0))
            .unwrap(),
        1
    );
    assert_eq!(
        c.query_row::<i64, _, _>("SELECT count(*) FROM outbox", [], |r| r.get(0))
            .unwrap(),
        1
    );
    assert_eq!(read_turn(&c, &ctx(2, 5)).unwrap().unwrap(), first);
}
#[test]
fn one_open_drawer_per_scope_other_actor_sees_same_turn_and_other_branch_is_independent() {
    let mut c = db();
    let a = open_turn(&mut c, &grant(2, 5, true), 2000, 2000, 1, req(20)).unwrap();
    assert_eq!(read_turn(&c, &ctx(9, 5)).unwrap().unwrap(), a);
    assert!(open_turn(&mut c, &grant(9, 5, true), 2000, 2000, 1, req(21)).is_err());
    assert!(read_turn(&c, &ctx(2, 6)).unwrap().is_none());
    assert!(open_turn(&mut c, &grant(2, 6, true), 2000, 2000, 1, req(22)).is_ok());
}
#[test]
fn incompatible_identity_or_actor_is_rejected_without_another_effect() {
    let mut c = db();
    let g = grant(2, 5, true);
    open_turn(&mut c, &g, 2000, 2000, 1, req(20)).unwrap();
    let mut altered = req(20);
    altered.opening_cents = "50001".into();
    assert_eq!(
        open_turn(&mut c, &g, 2000, 2000, 1, altered)
            .unwrap_err()
            .code(),
        "OPERATION_ID_CONFLICT"
    );
    assert!(open_turn(&mut c, &grant(9, 5, true), 2000, 2000, 1, req(20)).is_err());
    assert_eq!(
        c.query_row::<i64, _, _>("SELECT count(*) FROM cash_turns", [], |r| r.get(0))
            .unwrap(),
        1
    );
}
#[test]
fn invalid_money_or_grant_does_not_prepare_or_apply_cash() {
    let mut c = db();
    let g = grant(2, 5, true);
    for amount in ["-1", "1.5", "01", "9007199254740992"] {
        let mut bad = req(20);
        bad.opening_cents = amount.into();
        assert!(open_turn(&mut c, &g, 2000, 2000, 1, bad).is_err());
    }
    assert!(open_turn(&mut c, &grant(2, 5, false), 2000, 2000, 1, req(20)).is_err());
    assert!(open_turn(&mut c, &g, 2000, 2000, 301, req(20)).is_err());
    assert_eq!(
        c.query_row::<i64, _, _>("SELECT count(*) FROM operation_journal", [], |r| r.get(0))
            .unwrap(),
        0
    );
}
#[test]
fn failed_outbox_rolls_back_turn_and_keeps_prepared_intention_for_same_id() {
    let mut c = db();
    let g = grant(2, 5, true);
    c.execute_batch("CREATE TEMP TRIGGER fixture_cash_fault BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT,'fixture fault'); END;").unwrap();
    assert!(open_turn(&mut c, &g, 2000, 2000, 1, req(20)).is_err());
    assert!(read_turn(&c, &ctx(2, 5)).unwrap().is_none());
    assert_eq!(
        c.query_row::<String, _, _>(
            "SELECT local_state FROM operation_journal WHERE operation_id=?1",
            [id(20)],
            |r| r.get(0)
        )
        .unwrap(),
        "PREPARED"
    );
    c.execute_batch("DROP TRIGGER fixture_cash_fault;").unwrap();
    assert_eq!(
        open_turn(&mut c, &g, 3000, 3000, 1, req(20))
            .unwrap()
            .opened_at_ms,
        "2000"
    );
}
#[test]
fn encrypted_reopen_preserves_turn_and_outbox_without_any_network() {
    use ventard_core::storage::{cipher::CipherKey, writer::VaultWriter};
    let path = std::env::temp_dir().join(format!("ventard-cash-fixture-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&path).unwrap();
    let key = CipherKey::new([0x49; 32]);
    let g = grant(2, 5, true);
    {
        let mut w = VaultWriter::create_encrypted(&path, &key).unwrap();
        open_turn(w.connection(), &g, 2000, 2000, 1, req(20)).unwrap();
    }
    {
        let mut w = VaultWriter::open_encrypted(&path, &key).unwrap();
        assert_eq!(
            read_turn(w.connection(), &ctx(2, 5))
                .unwrap()
                .unwrap()
                .operation_id,
            id(20)
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
                .starts_with("ventard-cash-fixture-")
    );
    std::fs::remove_dir_all(absolute).unwrap();
}
#[test]
fn v6_to_current_preserves_pin_catalogue_and_active_account_draft() {
    use sha2::{Digest, Sha256};
    use ventard_core::{
        application::drafts,
        security::local_auth::{enroll_pin, unlock_pin},
        storage::{catalogue_preview as cat, cipher::CipherKey, writer::VaultWriter},
    };
    use zeroize::Zeroizing;
    let path = std::env::temp_dir().join(format!("ventard-cash-upgrade-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&path).unwrap();
    let key = CipherKey::new([0x59; 32]);
    let g = grant(2, 5, true);
    let context = ctx(2, 5);
    let snapshot_id = id(70);
    let pin = Zeroizing::new("3971".to_owned());
    let original;
    {
        let mut w = VaultWriter::create_encrypted(&path, &key).unwrap();
        let c = w.connection();
        let payload=json!([{"id":id(11),"name":"Cash upgrade fixture only","code":null,"priceCents":"103","stock":null,"stockEvidence":"MISSING_BRANCH_AUTHORITY"}]).to_string();
        let manifest = cat::Manifest {
            version: "ventard.native.catalogue.preview.1".into(),
            snapshot_id: snapshot_id.clone(),
            context: context.clone(),
            captured_at_ms: "1000".into(),
            expires_at_ms: "86401000".into(),
            coverage: "CATALOGUE_PREVIEW_V1".into(),
            watermark: None,
            total_count: 1,
            pages: vec![cat::PageDescriptor {
                index: 0,
                count: 1,
                byte_length: payload.len(),
                sha256: format!("{:x}", Sha256::digest(payload.as_bytes())),
            }],
        };
        cat::begin(c, &context, &manifest, 2000).unwrap();
        cat::stage_page(c, &context, &snapshot_id, 0, &payload, 2000).unwrap();
        cat::activate(c, &context, &snapshot_id).unwrap();
        enroll_pin(c, &g, &pin, 2000).unwrap();
        original = drafts::save(
            c,
            &context,
            drafts::DraftSave {
                request_id: id(80),
                cart_id: None,
                expected_revision: None,
                lines: vec![drafts::DraftLine {
                    product_id: id(11),
                    quantity: "2".into(),
                    revision: snapshot_id.clone(),
                    free: None,
                }],
            },
        )
        .unwrap()
        .workspace;
        c.execute_batch("ALTER TABLE legacy_web_observation_plans_v1 DROP COLUMN source_kind;DROP TABLE fiscal_requests_v2;DROP TABLE fiscal_reservations;DROP TABLE fiscal_blocks;DROP TABLE fiscal_watermarks;DROP TABLE ticket_allocations;DROP TABLE ticket_sequences;DROP TABLE checkout_drafts;DROP TABLE cash_turns;DROP TABLE cash_drawers;DELETE FROM migration_history WHERE version>=7;PRAGMA user_version=6;").unwrap();
        assert_eq!(migrations::validate_history(c).unwrap(), 6);
    }
    {
        let mut w = VaultWriter::open_encrypted(&path, &key).unwrap();
        let c = w.connection();
        assert_eq!(migrations::validate_history(c).unwrap(), 30);
        assert!(unlock_pin(c, &g, &pin, 2100).unwrap().allows("READ"));
        assert_eq!(drafts::read(c, &context).unwrap(), original);
        assert_eq!(
            cat::read(c, &context)
                .unwrap()
                .unwrap()
                .manifest
                .snapshot_id,
            snapshot_id
        );
        assert!(read_turn(c, &context).unwrap().is_none());
        assert_eq!(
            c.query_row::<i64, _, _>("SELECT count(*) FROM outbox", [], |r| r.get(0))
                .unwrap(),
            0
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
                .starts_with("ventard-cash-upgrade-")
    );
    std::fs::remove_dir_all(absolute).unwrap();
}
