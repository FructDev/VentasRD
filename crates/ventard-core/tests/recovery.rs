#![cfg(feature = "encrypted-storage")]
use serde_json::{json, Value};
use ventard_core::{
    security::recovery_enrollment::RecoverySecret,
    storage::{backup, cipher::CipherKey, writer::VaultWriter},
};
fn id(n: u32) -> String {
    format!("96400000-0000-4000-8000-{n:012}")
}
#[test]
#[ignore = "requires explicitly generated isolated PostgreSQL history fixture"]
fn postgres_history_recovery_verifies_original_facts_without_replaying_effects() {
    use ventard_core::{
        application::sales_sync,
        storage::{catalogue_preview::CatalogueContext, recovery},
    };
    let captured: Value = serde_json::from_slice(
        &std::fs::read(
            std::env::var("VENTARD_HISTORY_CAPTURE_FIXTURE")
                .expect("generate isolated PostgreSQL fixture first"),
        )
        .unwrap(),
    )
    .unwrap();
    let ctx: CatalogueContext =
        serde_json::from_value(captured["manifest"]["context"].clone()).unwrap();
    let now = captured["manifest"]["capturedAtMs"]
        .as_str()
        .unwrap()
        .parse::<u64>()
        .unwrap();
    let root = std::env::temp_dir().join(format!(
        "ventard-recovery-facts-fixture-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir(&root).unwrap();
    let key = CipherKey::new([0x63; 32]);
    let mut writer = VaultWriter::create_encrypted(&root, &key).unwrap();
    let c = writer.connection();
    sales_sync::begin_bootstrap(c, &ctx, &captured["manifest"], now).unwrap();
    for (i, page) in captured["pages"].as_array().unwrap().iter().enumerate() {
        sales_sync::stage_bootstrap_page(c, &ctx, i, page.as_str().unwrap(), now).unwrap();
    }
    sales_sync::activate_bootstrap(c, &ctx, now, &id(100)).unwrap();
    let original: Value = serde_json::from_slice(
        &c.query_row::<Vec<u8>, _, _>(
            "SELECT canonical_bytes FROM operation_journal ORDER BY local_seq LIMIT 1",
            [],
            |r| r.get(0),
        )
        .unwrap(),
    )
    .unwrap();
    let source = backup::Source {
        local_anchor_hash: None,
        tenant_id: ctx.tenant_id.clone(),
        vault_id: id(101),
        installation_id: original["installationId"].as_str().unwrap().into(),
        device_id: original["originDeviceId"].as_str().unwrap().into(),
        actor_id: original["actorId"].as_str().unwrap().into(),
        writer_epoch: original["writerEpoch"].as_str().unwrap().into(),
        scope_type: ctx.scope_type.clone(),
        branch_id: ctx.branch_id.clone(),
        key_version: 1,
        captured_at_ms: now.to_string(),
    };
    // A lost response leaves the original operation pending in the old copy,
    // even though the server already accepted its exact original bytes.
    let op = original["operationId"].as_str().unwrap();
    let raw = c
        .query_row::<Vec<u8>, _, _>(
            "SELECT canonical_bytes FROM operation_journal WHERE operation_id=?1",
            [op],
            |r| r.get(0),
        )
        .unwrap();
    c.execute(
        "INSERT INTO outbox(operation_id,envelope,state) VALUES(?1,?2,'PENDING')",
        (op, raw),
    )
    .unwrap();
    let facts = recovery::facts(c, &source).unwrap();
    assert!(facts.len() >= 2);
    assert!(facts.iter().any(|f| f.pending));
    c.execute("DELETE FROM outbox", []).unwrap();
    let before = c.total_changes();
    let good = recovery::inspect(c, &ctx, &source, &facts).unwrap();
    assert_eq!(good["canTransfer"], true);
    assert_eq!(good["verified"], facts.len().to_string());
    assert_eq!(c.total_changes(), before);
    let mut missing = facts.clone();
    missing[0].operation_id = id(102);
    assert_eq!(
        recovery::inspect(c, &ctx, &source, &missing).unwrap()["issues"][0]["code"],
        "CLOUD_OPERATION_MISSING"
    );
    let mut changed = facts.clone();
    changed[0].hash = "0".repeat(64);
    assert_eq!(
        recovery::inspect(c, &ctx, &source, &changed).unwrap()["issues"][0]["code"],
        "CONTENT_CONFLICT"
    );
    let mut changed_snapshot = facts.clone();
    let snapshot = changed_snapshot
        .iter_mut()
        .find(|f| f.snapshot.is_some())
        .unwrap();
    snapshot.snapshot = Some("{}".into());
    assert_eq!(
        recovery::inspect(c, &ctx, &source, &changed_snapshot).unwrap()["canTransfer"],
        false
    );
    c.execute("UPDATE native_sales_cursor_v1 SET sequence=0", [])
        .unwrap();
    assert_eq!(
        recovery::inspect(c, &ctx, &source, &facts).unwrap()["issues"][0]["code"],
        "RECEIPT_UNVERIFIED"
    );
    assert_eq!(
        c.query_row::<i64, _, _>("SELECT count(*) FROM outbox", [], |r| r.get(0))
            .unwrap(),
        0
    );
    for table in [
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
    let mut reopened = VaultWriter::open_encrypted(&root, &key).unwrap();
    assert_eq!(
        recovery::facts(reopened.connection(), &source)
            .unwrap()
            .len(),
        facts.len()
    );
}
#[test]
fn recovered_archive_custody_uses_destination_secret_and_never_becomes_a_writer() {
    let root = std::env::temp_dir().join(format!(
        "ventard-recovery-custody-fixture-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir(&root).unwrap();
    for name in ["original", "exports", "keys", "snapshot", "candidate"] {
        std::fs::create_dir(root.join(name)).unwrap();
    }
    let original_key = CipherKey::new([0x61; 32]);
    let destination_key = CipherKey::new([0x62; 32]);
    let recovery = RecoverySecret::generate().unwrap();
    let mut original = VaultWriter::create_encrypted(root.join("original"), &original_key).unwrap();
    let c = original.connection();
    let source = backup::Source {
        local_anchor_hash: None,
        tenant_id: id(1),
        vault_id: id(2),
        installation_id: id(3),
        device_id: id(4),
        actor_id: id(5),
        writer_epoch: "1".into(),
        scope_type: "GLOBAL".into(),
        branch_id: None,
        key_version: 1,
        captured_at_ms: "2000".into(),
    };
    c.execute(
        "INSERT INTO scopes VALUES('GLOBAL','GLOBAL',NULL,?1)",
        [id(1)],
    )
    .unwrap();
    let file = root.join("exports/test.vrdbackup");
    let card = root.join("keys/test.vrdkey");
    let job = backup::prepare(c, source, &id(6), &file, &card).unwrap();
    backup::create(c, job, &original_key, &recovery, &root.join("snapshot")).unwrap();
    let archive = backup::restore(&file, &card, &root.join("candidate/restored")).unwrap();
    let destination = RecoverySecret::from_cipher_key(&destination_key);
    let folder = root.join("custody");
    let stored = archive.preserve(&folder, &destination).unwrap();
    drop(archive);
    let reopened = backup::open_preserved(&folder, &stored, &destination).unwrap();
    reopened.read(|c, source| {
        assert_eq!(source.tenant_id, id(1));
        assert_eq!(
            c.query_row::<i64, _, _>("SELECT count(*) FROM scopes", [], |r| r.get(0))
                .unwrap(),
            1
        );
        assert!(c.execute("DELETE FROM scopes", []).is_err());
    });
    assert!(backup::open_preserved(
        &folder,
        &stored,
        &RecoverySecret::from_cipher_key(&original_key)
    )
    .is_err());
    let mut altered = stored.clone();
    altered.manifest.database_hash = "0".repeat(64);
    assert!(backup::open_preserved(&folder, &altered, &destination).is_err());
    let target = ventard_core::storage::catalogue_preview::CatalogueContext {
        tenant_id: id(1),
        actor_id: id(5),
        device_id: id(14),
        installation_id: id(13),
        writer_epoch: "1".into(),
        scope_type: "GLOBAL".into(),
        branch_id: None,
    };
    std::fs::create_dir(root.join("destination")).unwrap();
    let mut current =
        VaultWriter::create_encrypted(root.join("destination"), &destination_key).unwrap();
    let c = current.connection();
    let m = json!({"version":"ventard.native.operational.1","namespace":"NATIVE1","coverage":"QA_SYNTHETIC_ADOPTED","snapshotId":id(15),"context":target,"capturedAtMs":"2000","expiresAtMs":"5000","watermark":"0","historyCoverage":"NATIVE_LEDGER_THROUGH_WATERMARK","historyCount":0,"totalCount":0,"ticketPrefix":format!("N{}",target.installation_id.replace('-',"")),"lastTicket":"0","freeTax":{"numerator":"0","denominator":"1"},"turn":null,"pages":[]});
    ventard_core::application::sales_sync::begin_bootstrap(c, &target, &m, 2000).unwrap();
    ventard_core::application::sales_sync::activate_bootstrap(c, &target, 2000, &id(16)).unwrap();
    let facts = reopened
        .read(ventard_core::storage::recovery::facts)
        .unwrap();
    let ciphertext = reopened.encrypted_bytes().unwrap();
    let view = ventard_core::storage::recovery::prepare(
        c,
        &target,
        &id(17),
        &id(18),
        &stored,
        facts.clone(),
        ciphertext.clone(),
    )
    .unwrap();
    assert_eq!(view["state"], "REVIEW");
    assert_eq!(
        ventard_core::storage::recovery::prepare(
            c,
            &target,
            &id(17),
            &id(18),
            &stored,
            facts,
            ciphertext.clone()
        )
        .unwrap(),
        view
    );
    let mut wrong = stored.clone();
    wrong.manifest.backup_id = id(19);
    assert_eq!(
        ventard_core::storage::recovery::prepare(
            c,
            &target,
            &id(17),
            &id(18),
            &wrong,
            vec![],
            ciphertext
        )
        .unwrap_err()
        .code(),
        "RECOVERY_ID_CONFLICT"
    );
    assert_eq!(
        ventard_core::storage::recovery::ensure_writable(
            c,
            serde_json::to_string(&json!({"negocioId":id(1)}))
                .unwrap()
                .as_bytes()
        )
        .unwrap_err()
        .code(),
        "RECOVERY_REVIEW_REQUIRED"
    );
    assert_eq!(
        ventard_core::storage::recovery::freeze(c, &target, &id(17), &id(15), false)
            .unwrap_err()
            .code(),
        "RECOVERY_CONFIRMATION_REQUIRED"
    );
    let v = json!({"operationId":id(50),"negocioId":id(1),"actorId":id(5),"originDeviceId":id(14),"installationId":id(13),"writerEpoch":"1","scope":{"type":"GLOBAL","sucursalId":null},"payload":{"openingCents":"2000"}});
    let (raw, h) =
        ventard_core::domain::canonical::canonicalize(&serde_json::to_vec(&v).unwrap()).unwrap();
    let blocked = ventard_core::application::operations::prepare_operation(
        c,
        &id(50),
        "ventard.native.v1",
        "TURN_OPEN",
        1,
        raw.as_bytes(),
        &h,
        &id(5),
        "GLOBAL",
        &id(14),
        1,
        "2000",
    )
    .unwrap_err();
    assert_eq!(blocked.code(), "RECOVERY_REVIEW_REQUIRED");
    assert_eq!(
        c.query_row::<i64, _, _>("SELECT count(*) FROM operation_journal", [], |r| r.get(0))
            .unwrap(),
        0
    );
    let (request, hash) =
        ventard_core::storage::recovery::freeze(c, &target, &id(17), &id(15), true).unwrap();
    let request: Value = serde_json::from_str(&request).unwrap();
    let receipt = json!({"protocol":"ventard.native.recovery.receipt.1","requestId":id(17),"requestHash":hash,"backupId":request["backupId"],"backupHash":request["backupHash"],"source":request["source"],"target":request["target"],"status":"APPLIED","retiredSource":true,"replay":false});
    let mut bad = receipt.clone();
    bad["retiredSource"] = json!(false);
    assert!(ventard_core::storage::recovery::record(c, &target, &id(17), &bad).is_err());
    assert_eq!(
        ventard_core::storage::recovery::record(c, &target, &id(17), &receipt).unwrap()["state"],
        "ACTIVE"
    );
    ventard_core::storage::recovery::record(c, &target, &id(17), &receipt).unwrap();
    ventard_core::storage::recovery::ensure_writable(
        c,
        serde_json::to_string(&json!({"negocioId":id(1)}))
            .unwrap()
            .as_bytes(),
    )
    .unwrap();
    assert_eq!(
        c.query_row::<i64, _, _>("SELECT count(*) FROM outbox", [], |r| r.get(0))
            .unwrap(),
        0
    );
    let parent_source = backup::Source {
        local_anchor_hash: None,
        tenant_id: id(1),
        vault_id: id(16),
        installation_id: id(13),
        device_id: id(14),
        actor_id: id(5),
        writer_epoch: "1".into(),
        scope_type: "GLOBAL".into(),
        branch_id: None,
        key_version: 1,
        captured_at_ms: "3000".into(),
    };
    let parent_file = root.join("exports/parent.vrdbackup");
    let parent_card = root.join("keys/parent.vrdkey");
    let parent_secret = RecoverySecret::generate().unwrap();
    let job = backup::prepare(c, parent_source, &id(40), &parent_file, &parent_card).unwrap();
    backup::create(
        c,
        job,
        &destination_key,
        &parent_secret,
        &root.join("snapshot"),
    )
    .unwrap();
    let parent =
        backup::restore(&parent_file, &parent_card, &root.join("candidate/parent")).unwrap();
    assert_eq!(
        parent
            .read(ventard_core::storage::recovery::archived_list)
            .unwrap()["rows"][0]["recoveryId"],
        id(17)
    );
    let child = parent
        .nested(&root.join("candidate/child"), &id(17))
        .unwrap();
    assert!(child.manifest == stored.manifest);
    child.read(|c, _| assert!(c.execute("DELETE FROM scopes", []).is_err()));
}
