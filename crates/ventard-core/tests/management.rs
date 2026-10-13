#![cfg(feature = "encrypted-storage")]
use rusqlite::Connection;
use serde_json::json;
fn business_save(op: u32, revision: &str, name: &str) -> management::Command {
    serde_json::from_value(json!({"kind":"BUSINESS_SAVE","operationId":id(op),"expectedRevision":revision,"definition":{"name":name,"whatsapp":"8095550100","phone":"8095550101","rnc":"131000001","address":"Calle QA","footer":"Gracias por su compra","logo":null,"color":"dorado","font":"syne","bank":{"name":"Banco QA","account":"001-123","holder":"Tienda QA"}}})).unwrap()
}
#[test]
fn inventory_import_is_owner_scoped_exact_atomic_per_row_and_recovers_same_frozen_plan() {
    use ventard_core::application::inventory_import as imp;
    let mut c = db();
    let owner = grant(2, 5, true);
    let batch:imp::Batch=serde_json::from_value(json!({"operationId":id(890),"fileName":"inventario-qa.csv","duplicatePolicy":"SKIP","newTaxPercent":"18","rows":[
      {"row":2,"name":"Importado QA","code":"000000000000001","price":"RD$1,500.01","cost":"1000.00","stock":"7","minimum":"2","location":"Pasillo QA"},
      {"row":3,"name":"Inválido","price":"1.234","stock":"-2"},
      {"row":4,"name":"Importado QA","code":"000000000000001","price":"9"}
    ]})).unwrap();
    let prepared = imp::prepare(&mut c, &owner, 2000, 2000, 1, batch.clone()).unwrap();
    assert_eq!(prepared["ready"], "1");
    assert_eq!(prepared["invalid"], "1");
    assert_eq!(prepared["skipped"], "1");
    assert_eq!(
        c.query_row(
            "SELECT count(*) FROM products WHERE name='Importado QA'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    c.execute_batch("CREATE TRIGGER import_fault BEFORE INSERT ON inventory_movements BEGIN SELECT RAISE(ABORT,'owned-import-fixture'); END").unwrap();
    let interrupted = imp::run(&mut c, &owner, 2000, 2000, 1, &id(890)).unwrap();
    assert_eq!(interrupted["remaining"], "1");
    assert_eq!(
        c.query_row(
            "SELECT count(*) FROM products WHERE name='Importado QA'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    assert_eq!(
        c.query_row(
            "SELECT count(*) FROM operation_journal WHERE origin_actor=?1",
            [id(2)],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    c.execute_batch("DROP TRIGGER import_fault").unwrap();
    let result = imp::run(&mut c, &owner, 3000, 3000, 1, &id(890)).unwrap();
    assert_eq!(result["remaining"], "0");
    assert_eq!(result["created"], "1");
    let snapshot = ventard_core::application::sales_sync::read(&c, &ctx()).unwrap();
    let p = snapshot["products"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["name"] == "Importado QA")
        .unwrap();
    assert_eq!(p["priceCents"], "150001");
    assert_eq!(p["stock"], "7");
    assert_eq!(p["code"], "000000000000001");
    assert_eq!(
        imp::run(&mut c, &owner, 4000, 4000, 1, &id(890)).unwrap(),
        result
    );
    assert_eq!(
        imp::prepare(&mut c, &owner, 4000, 4000, 1, batch.clone()).unwrap(),
        result
    );
    let mut changed = batch;
    changed.rows[0].price = Some("2".into());
    assert!(imp::prepare(&mut c, &owner, 4000, 4000, 1, changed).is_err());
    assert!(imp::run(&mut c, &grant(9, 5, false), 2000, 2000, 1, &id(890)).is_err());
    assert!(imp::run(&mut c, &grant(2, 6, true), 2000, 2000, 1, &id(890)).is_err());
    if let Ok(path) = std::env::var("VENTARD_IMPORT_WIRE_FIXTURE") {
        let mut q = c
            .prepare("SELECT canonical_bytes,hash FROM operation_journal ORDER BY local_seq")
            .unwrap();
        let packets=q.query_map([],|r|Ok(json!({"bytes":String::from_utf8(r.get::<_,Vec<u8>>(0)?).unwrap(),"hash":r.get::<_,String>(1)?}))).unwrap().collect::<Result<Vec<_>,_>>().unwrap();
        std::fs::write(path, serde_json::to_vec(&packets).unwrap()).unwrap();
    }
    assert_eq!(
        c.query_row("SELECT count(*) FROM outbox", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        2
    );
}
#[test]
fn inventory_import_update_preserves_unmapped_fields_and_conflict_never_retargets_stock() {
    use ventard_core::application::inventory_import as imp;
    let mut c = db();
    let owner = grant(2, 5, true);
    let batch = |op: u32, policy: &str, price: &str, stock: Option<&str>| {
        serde_json::from_value::<imp::Batch>(json!({"operationId":id(op),"fileName":"update-qa.csv","duplicatePolicy":policy,"newTaxPercent":"0","rows":[{"row":2,"name":"Producto QA","code":"000001","price":price,"cost":"10.01","stock":stock,"minimum":"2","location":"Pasillo 1"}]})).unwrap()
    };
    imp::prepare(
        &mut c,
        &owner,
        2000,
        2000,
        1,
        batch(900, "SKIP", "20.02", Some("7")),
    )
    .unwrap();
    imp::run(&mut c, &owner, 2000, 2000, 1, &id(900)).unwrap();
    let mut update = batch(901, "UPDATE", "30.03", None);
    update.rows[0].cost = None;
    update.rows[0].minimum = None;
    update.rows[0].location = None;
    let prepared = imp::prepare(&mut c, &owner, 2000, 2000, 1, update).unwrap();
    assert_eq!(prepared["rows"][0]["definition"]["costCents"], "1001");
    assert_eq!(prepared["rows"][0]["definition"]["location"], "Pasillo 1");
    assert_eq!(prepared["rows"][0]["stock"], serde_json::Value::Null);
    let applied = imp::run(&mut c, &owner, 2000, 2000, 1, &id(901)).unwrap();
    assert_eq!(applied["updated"], "1");
    let snapshot = ventard_core::application::sales_sync::read(&c, &ctx()).unwrap();
    let p = &snapshot["products"][0];
    assert_eq!(p["priceCents"], "3003");
    assert_eq!(p["stock"], "7");
    assert_eq!(p["taxRate"], json!({"numerator":"0","denominator":"1"}));
    imp::prepare(
        &mut c,
        &owner,
        2000,
        2000,
        1,
        batch(902, "UPDATE", "40.04", Some("2")),
    )
    .unwrap();
    let before: i64 = c
        .query_row("SELECT count(*) FROM outbox", [], |r| r.get(0))
        .unwrap();
    c.execute(
        "UPDATE products SET revision=revision+1 WHERE barcode='000001'",
        [],
    )
    .unwrap();
    let failed = imp::run(&mut c, &owner, 2000, 2000, 1, &id(902)).unwrap();
    assert_eq!(failed["remaining"], "1");
    assert_eq!(failed["rows"][0]["error"], "VERSION_CONFLICT");
    assert_eq!(
        c.query_row::<i64, _, _>("SELECT count(*) FROM outbox", [], |r| r.get(0))
            .unwrap(),
        before
    );
    let stopped = imp::stop(&mut c, &owner, 2000, 2000, 1, &id(902)).unwrap();
    assert_eq!(stopped["state"], "FINISHED");
    assert_eq!(stopped["skipped"], "1");
    assert_eq!(
        ventard_core::application::sales_sync::read(&c, &ctx()).unwrap()["products"][0]["stock"],
        "7"
    );
}
#[test]
fn inventory_import_plan_and_committed_rows_survive_real_cipher_reopening() {
    use ventard_core::{
        application::inventory_import as imp,
        storage::{cipher::CipherKey, writer::VaultWriter},
    };
    let root =
        std::env::temp_dir().join(format!("ventard-import-fixture-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&root).unwrap();
    let key = CipherKey::new([0x67; 32]);
    let owner = grant(2, 5, true);
    let batch:imp::Batch=serde_json::from_value(json!({"operationId":id(910),"fileName":"cifrado-qa.csv","duplicatePolicy":"SKIP","newTaxPercent":"18","rows":[{"row":2,"name":"Producto cifrado QA","code":"000000000000001","price":"0.01","cost":"0","stock":"3"}]})).unwrap();
    let expected;
    {
        let mut w = VaultWriter::create_encrypted(&root, &key).unwrap();
        let c = w.connection();
        c.execute(
            "INSERT INTO scopes VALUES(?1,'BRANCH',?2,?3)",
            (sales_key(), id(5), id(1)),
        )
        .unwrap();
        c.execute(
            "INSERT INTO native_sales_cursor_v1 VALUES(?1,?2,'NATIVE1',0)",
            (id(1), sales_key()),
        )
        .unwrap();
        imp::prepare(c, &owner, 2000, 2000, 1, batch.clone()).unwrap();
    }
    {
        let mut w = VaultWriter::open_encrypted(&root, &key).unwrap();
        let c = w.connection();
        assert_eq!(
            imp::list(c, &owner, 2000, 2000, 1).unwrap()["rows"][0]["ready"],
            "1"
        );
        expected = imp::run(c, &owner, 2000, 2000, 1, &id(910)).unwrap();
        assert_eq!(expected["created"], "1");
    }
    {
        let mut w = VaultWriter::open_encrypted(&root, &key).unwrap();
        let c = w.connection();
        assert_eq!(
            imp::prepare(c, &owner, 4000, 4000, 1, batch).unwrap(),
            expected
        );
        assert_eq!(
            imp::run(c, &owner, 4000, 4000, 1, &id(910)).unwrap(),
            expected
        );
        assert_eq!(
            c.query_row::<i64, _, _>("SELECT count(*) FROM outbox", [], |r| r.get(0))
                .unwrap(),
            2
        );
        let v = ventard_core::application::sales_sync::read(c, &ctx()).unwrap();
        assert_eq!(v["products"][0]["priceCents"], "1");
        assert_eq!(v["products"][0]["stock"], "3");
    }
    let real = root.canonicalize().unwrap();
    assert!(
        real.starts_with(std::env::temp_dir().canonicalize().unwrap())
            && real
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("ventard-import-fixture-")
    );
    std::fs::remove_dir_all(real).unwrap();
}
#[test]
fn portable_backup_preserves_wal_pending_money_and_original_tickets_without_os_key() {
    use ventard_core::{
        security::recovery_enrollment::RecoverySecret,
        storage::{backup, cipher::CipherKey, writer::VaultWriter},
    };
    let root =
        std::env::temp_dir().join(format!("ventard-backup-fixture-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&root).unwrap();
    for name in ["live", "exports", "keys", "private"] {
        std::fs::create_dir(root.join(name)).unwrap();
    }
    let key = CipherKey::new([0x45; 32]);
    let recovery = RecoverySecret::generate().unwrap();
    let source = backup::Source {
        local_anchor_hash: None,
        tenant_id: id(1),
        vault_id: id(880),
        installation_id: id(4),
        device_id: id(3),
        actor_id: id(2),
        writer_epoch: "1".into(),
        scope_type: "BRANCH".into(),
        branch_id: Some(id(5)),
        key_version: 1,
        captured_at_ms: "2000".into(),
    };
    let mut live = VaultWriter::create_encrypted(root.join("live"), &key).unwrap();
    let c = live.connection();
    c.execute(
        "INSERT INTO scopes VALUES(?1,'BRANCH',?2,?3)",
        (sales_key(), id(5), id(1)),
    )
    .unwrap();
    c.execute(
        "INSERT INTO native_sales_cursor_v1 VALUES(?1,?2,'NATIVE1',0)",
        (id(1), sales_key()),
    )
    .unwrap();
    repair_fixture(c);
    run_pro(c, repair_save(701, "0")).unwrap();
    let ticket = ventard_core::application::printing::repair_ticket(c, &ctx(), &id(701)).unwrap();
    let path = root.join("exports/test.vrdbackup");
    let card = root.join("keys/test.vrdkey");
    let job = backup::prepare(c, source.clone(), &id(881), &path, &card).unwrap();
    let first = backup::create(c, job, &key, &recovery, &root.join("private")).unwrap();
    assert_eq!(first["state"], "VERIFIED");
    let bytes = std::fs::read(&path).unwrap();
    let keybytes = std::fs::read(&card).unwrap();
    let old = backup::job(c, &source, &id(881)).unwrap().unwrap();
    assert_eq!(
        backup::create(c, old, &key, &recovery, &root.join("private")).unwrap(),
        first
    );
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    assert_eq!(std::fs::read(&card).unwrap(), keybytes);
    let archive = backup::restore(&path, &card, &root.join("independent-recovery")).unwrap();
    archive.read(|db, _| {
        assert_eq!(
            ventard_core::application::printing::repair_ticket(db, &ctx(), &id(701)).unwrap(),
            ticket
        );
        assert!(db.execute("DELETE FROM outbox", []).is_err());
        assert!(
            db.query_row::<i64, _, _>(
                "SELECT count(*) FROM outbox WHERE state<>'APPLIED'",
                [],
                |r| r.get(0)
            )
            .unwrap()
                > 0
        );
    });
    run(c, save(882, "0")).unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    // Corrupted and incomplete exports never replace the active database.
    for (name, damaged) in [
        ("truncated", bytes[..bytes.len() - 1].to_vec()),
        ("manifest-tampered", {
            let mut b = bytes.clone();
            b[40] ^= 1;
            b
        }),
        ("database-tampered", {
            let mut b = bytes.clone();
            let last = b.len() - 1;
            b[last] ^= 1;
            b
        }),
    ] {
        let file = root.join("exports").join(format!("{name}.vrdbackup"));
        std::fs::write(&file, damaged).unwrap();
        assert!(backup::restore(&file, &card, &root.join(name)).is_err());
        assert_eq!(
            ventard_core::application::printing::repair_ticket(c, &ctx(), &id(701)).unwrap(),
            ticket
        );
    }
    let wrong_card = root.join("keys/wrong.vrdkey");
    let mut wrong_bytes = keybytes.clone();
    wrong_bytes[55] ^= 1;
    std::fs::write(&wrong_card, wrong_bytes).unwrap();
    assert!(backup::restore(&path, &wrong_card, &root.join("wrong-key")).is_err());
    // A response lost after freeze resumes the same bytes, even after new writes.
    let header_size = 12 + u32::from_be_bytes(bytes[8..12].try_into().unwrap()) as usize + 8;
    std::fs::write(&path, &bytes[..header_size + 128]).unwrap();
    c.execute(
        "UPDATE native_backup_jobs_v1 SET state='PREPARED' WHERE operation_id=?1",
        [id(881)],
    )
    .unwrap();
    let pending = backup::job(c, &source, &id(881)).unwrap().unwrap();
    assert_eq!(
        backup::create(c, pending, &key, &recovery, &root.join("private")).unwrap(),
        first
    );
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    let mut foreign = source.clone();
    foreign.branch_id = Some(id(999));
    let foreign_path = root.join("exports/foreign.vrdbackup");
    let foreign_key = root.join("keys/foreign.vrdkey");
    let foreign_job =
        backup::prepare(c, foreign.clone(), &id(883), &foreign_path, &foreign_key).unwrap();
    assert!(backup::create(c, foreign_job, &key, &recovery, &root.join("private")).is_err());
    assert!(!foreign_path.exists() && !foreign_key.exists());
    backup::abandon(c, &foreign, &id(883)).unwrap();
    assert_eq!(
        backup::job(c, &foreign, &id(883)).unwrap().unwrap().state,
        "FAILED"
    );
    std::fs::remove_file(&card).unwrap();
    let wrong = RecoverySecret::generate().unwrap();
    let job = backup::job(c, &source, &id(881)).unwrap().unwrap();
    assert!(backup::create(c, job, &key, &wrong, &root.join("private")).is_err());
    assert!(
        !card.exists(),
        "a wrong recovery secret must not publish a replacement key file"
    );
    drop(archive);
    drop(live);
    let real = root.canonicalize().unwrap();
    assert!(
        real.starts_with(std::env::temp_dir().canonicalize().unwrap())
            && real
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("ventard-backup-fixture-")
    );
    std::fs::remove_dir_all(real).unwrap();
}
#[test]
fn encrypted_settings_reopen_preserves_bank_header_revision_and_exact_attempt() {
    use ventard_core::{
        application::settings,
        storage::{cipher::CipherKey, writer::VaultWriter},
    };
    let root = std::env::temp_dir();
    let path = root.join(format!("ventard-settings-fixture-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&path).unwrap();
    let key = CipherKey::new([0x62; 32]);
    let request = business_save(840, "0", "Negocio cifrado QA");
    let expected;
    {
        let mut vault = VaultWriter::create_encrypted(&path, &key).unwrap();
        let c = vault.connection();
        c.execute(
            "INSERT INTO scopes VALUES(?1,'BRANCH',?2,?3)",
            (sales_key(), id(5), id(1)),
        )
        .unwrap();
        c.execute(
            "INSERT INTO native_sales_cursor_v1 VALUES(?1,?2,'NATIVE1',0)",
            (id(1), sales_key()),
        )
        .unwrap();
        c.execute("INSERT INTO native_business_settings_protocol_v1 VALUES(?1,'ventard.business.settings.1')",[id(1)]).unwrap();
        expected = run(c, request.clone()).unwrap();
    }
    {
        let mut vault = VaultWriter::open_encrypted(&path, &key).unwrap();
        let c = vault.connection();
        assert_eq!(run(c, request).unwrap(), expected);
        let settings = settings::read(c, &ctx()).unwrap();
        assert_eq!(settings["revision"], "1");
        assert_eq!(settings["definition"]["bank"]["account"], "001-123");
        assert_eq!(
            settings::public_profile(c, &ctx()).unwrap()["name"],
            "Negocio cifrado QA"
        );
        assert_eq!(
            c.query_row(
                "SELECT count(*) FROM outbox WHERE operation_id=?1",
                [id(840)],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
    }
    let real = std::fs::canonicalize(&path).unwrap();
    assert!(
        real.starts_with(std::fs::canonicalize(root).unwrap())
            && real
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("ventard-settings-fixture-")
    );
    std::fs::remove_dir_all(real).unwrap();
}
#[test]
#[ignore = "requires explicit isolated PostgreSQL settings event fixture"]
fn postgres_settings_proof_imports_current_metadata_without_replaying_money_or_stock() {
    use ventard_core::application::settings;
    let path =
        std::env::var("VENTARD_SETTINGS_EVENT_FIXTURE").expect("explicit isolated fixture path");
    let packet: serde_json::Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let watermark = packet["watermark"]
        .as_str()
        .unwrap()
        .parse::<i64>()
        .unwrap();
    let mut c = db();
    for _ in 0..2 {
        let tx = c.transaction().unwrap();
        settings::import_protocol(
            &tx,
            &ctx(),
            &json!({"businessSettingsProtocol":"ventard.business.settings.1"}),
        )
        .unwrap();
        settings::import_current(&tx, &ctx(), &packet["event"], watermark).unwrap();
        tx.commit().unwrap();
    }
    let expected = settings::read(&c, &ctx()).unwrap();
    assert_eq!(expected["definition"]["bank"]["account"], "001-123");
    assert_eq!(expected["remoteStatus"], "APPLIED");
    let mut bad = packet["event"].clone();
    bad["receipt"]["effects"] = json!([]);
    let tx = c.transaction().unwrap();
    assert!(settings::import_current(&tx, &ctx(), &bad, watermark).is_err());
    assert!(settings::import_current(&tx, &ctx(), &packet["event"], watermark - 1).is_err());
    drop(tx);
    assert_eq!(settings::read(&c, &ctx()).unwrap(), expected);
    for table in [
        "payments",
        "inventory_movements",
        "operation_journal",
        "outbox",
    ] {
        assert_eq!(
            c.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
}
#[test]
fn business_conflicts_keep_latest_verified_remote_choice_and_block_new_headers() {
    use ventard_core::application::settings;
    let mut a = db();
    let mut b = db();
    for c in [&mut a, &mut b] {
        c.execute("INSERT INTO native_business_settings_protocol_v1 VALUES(?1,'ventard.business.settings.1')",[id(1)]).unwrap();
    }
    run(&mut a, business_save(830, "0", "Servidor uno")).unwrap();
    let first = event(&a, 830, 1);
    run(&mut a, business_save(831, "1", "Servidor dos")).unwrap();
    let second = event(&a, 831, 2);
    run(&mut b, business_save(832, "0", "Edición concurrente")).unwrap();
    for e in [&second, &first] {
        let tx = b.transaction().unwrap();
        settings::import_current(&tx, &ctx(), e, 2).unwrap();
        tx.commit().unwrap();
    }
    assert!(settings::read(&b, &ctx()).unwrap()["canLoadRemote"]
        .as_bool()
        .unwrap());
    assert_eq!(
        settings::public_profile(&b, &ctx()).unwrap_err().code(),
        "SERVICE_SYNC_CONFLICT"
    );
    let before: Vec<u8> = b
        .query_row(
            "SELECT canonical_bytes FROM operation_journal WHERE operation_id=?1",
            [id(832)],
            |r| r.get(0),
        )
        .unwrap();
    settings::load_remote(&mut b, &ctx()).unwrap();
    assert_eq!(
        settings::read(&b, &ctx()).unwrap()["definition"]["name"],
        "Servidor dos"
    );
    assert!(settings::load_remote(&mut b, &ctx()).is_err());
    assert_eq!(
        settings::public_profile(&b, &ctx()).unwrap()["name"],
        "Servidor dos"
    );
    let after: Vec<u8> = b
        .query_row(
            "SELECT canonical_bytes FROM operation_journal WHERE operation_id=?1",
            [id(832)],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(before, after);
    assert_eq!(
        b.query_row("SELECT count(*) FROM payments", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
}
#[test]
fn business_settings_are_basic_owner_authorized_atomic_and_recover_exactly_without_money_or_stock()
{
    use ventard_core::application::settings;
    let mut c = db();
    let request = business_save(810, "0", "Tienda QA");
    assert!(run(&mut c, request.clone()).is_err());
    c.execute(
        "INSERT INTO native_business_settings_protocol_v1 VALUES(?1,'ventard.business.settings.1')",
        [id(1)],
    )
    .unwrap();
    assert!(
        management::execute(&mut c, &grant(2, 5, false), 2000, 2000, 1, request.clone()).is_err()
    );
    c.execute_batch("CREATE TRIGGER fail_business BEFORE INSERT ON native_management_records_v1 WHEN NEW.kind='CONFIG_PATCH' BEGIN SELECT RAISE(ABORT,'fixture rollback');END;").unwrap();
    assert!(run(&mut c, request.clone()).is_err());
    assert_eq!(settings::read(&c, &ctx()).unwrap()["revision"], "0");
    c.execute_batch("DROP TRIGGER fail_business;").unwrap();
    let first = run(&mut c, request.clone()).unwrap();
    assert_eq!(run(&mut c, request).unwrap(), first);
    let view = settings::read(&c, &ctx()).unwrap();
    assert_eq!(view["revision"], "1");
    assert_eq!(view["definition"]["bank"]["account"], "001-123");
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
    assert!(run(&mut c, business_save(811, "0", "Conflict")).is_err());
    let mut bad = serde_json::to_value(business_save(812, "1", "Nueva tienda")).unwrap();
    bad["definition"]["logo"] = json!("data:image/svg+xml,<svg></svg>");
    assert!(run(&mut c, serde_json::from_value(bad).unwrap()).is_err());
    assert_eq!(settings::read(&c, &ctx()).unwrap()["revision"], "1");
}
#[test]
fn business_change_updates_future_documents_and_preserves_issued_repair_header_and_hash() {
    use ventard_core::application::{printing, settings};
    let mut c = db();
    repair_fixture(&mut c);
    c.execute(
        "INSERT INTO native_business_settings_protocol_v1 VALUES(?1,'ventard.business.settings.1')",
        [id(1)],
    )
    .unwrap();
    run(&mut c, business_save(820, "0", "Nombre original")).unwrap();
    run_pro(&mut c, repair_save(701, "0")).unwrap();
    let old = printing::repair_ticket(&c, &ctx(), &id(701)).unwrap();
    assert_eq!(old["document"]["business"]["name"], "Nombre original");
    run(&mut c, business_save(821, "1", "Nombre nuevo")).unwrap();
    assert_eq!(printing::repair_ticket(&c, &ctx(), &id(701)).unwrap(), old);
    let mut next = repair_save(702, "0");
    if let management::Command::RepairSave { repair_id, .. } = &mut next {
        *repair_id = id(703)
    };
    run_pro(&mut c, next).unwrap();
    assert_eq!(
        printing::repair_ticket(&c, &ctx(), &id(702)).unwrap()["document"]["business"]["name"],
        "Nombre nuevo"
    );
    let mut branch = ctx();
    branch.branch_id = Some(id(60));
    assert_eq!(settings::read(&c, &branch).unwrap()["revision"], "2");
}
#[test]
fn repair_can_save_a_new_customer_with_zero_credit_limit_in_the_same_commit() {
    let mut c = db();
    repair_fixture(&mut c);
    let mut req = serde_json::to_value(repair_save(701, "0")).unwrap();
    req["createCustomer"] = json!(true);
    req["definition"]["customerId"] = json!(id(730));
    c.execute_batch("CREATE TRIGGER fail_new_customer BEFORE INSERT ON native_management_records_v1 WHEN NEW.kind='REPAIR_CREATE' BEGIN SELECT RAISE(ABORT,'fixture customer rollback');END;").unwrap();
    let cmd: management::Command = serde_json::from_value(req).unwrap();
    assert!(run_pro(&mut c, cmd.clone()).is_err());
    assert!(management::read(&c, &ctx()).unwrap()["customers"]
        .as_array()
        .unwrap()
        .is_empty());
    c.execute_batch("DROP TRIGGER fail_new_customer;").unwrap();
    run_pro(&mut c, cmd.clone()).unwrap();
    run_pro(&mut c, cmd).unwrap();
    let customers = management::read(&c, &ctx()).unwrap()["customers"].clone();
    assert_eq!(customers.as_array().unwrap().len(), 1);
    assert_eq!(customers[0]["name"], "Ana QA");
    assert_eq!(customers[0]["limitCents"], "0");
    assert_eq!(customers[0]["balanceCents"], "0");
    assert_eq!(customers[0]["phone"], "8095550100");
}
#[test]
fn repair_report_uses_delivery_dates_costs_and_never_exports_credentials() {
    use ventard_core::application::{
        repair_private::Change,
        report_exports::{self, Kind},
    };
    let mut c = db();
    repair_fixture(&mut c);
    management::execute_private(
        &mut c,
        &grant_tier(2, 5, true, Some("pro")),
        2000,
        2000,
        1,
        repair_save(701, "0"),
        Some(Change {
            value: "REPORT PRIVATE FIXTURE".into(),
            base_operation_id: None,
        }),
    )
    .unwrap();
    let data = report_exports::read(&c, &ctx(), Kind::Repairs, "0", "3000").unwrap();
    assert_eq!(data["summary"]["received"], "1");
    assert_eq!(data["summary"]["incomeCents"], "0");
    assert!(!data.to_string().contains("REPORT PRIVATE FIXTURE"));
    let mut quote = repair_save(702, "1");
    if let management::Command::RepairSave {
        quote,
        initial_payment_cents,
        ..
    } = &mut quote
    {
        *quote = true;
        *initial_payment_cents = "0".into();
    }
    run_pro(&mut c, quote).unwrap();
    for (op, rev, act) in [
        (703, "2", "APPROVE"),
        (704, "3", "READY"),
        (705, "4", "DELIVER"),
    ] {
        run_pro(&mut c, repair_action(op, rev, act, "EFECTIVO", "0")).unwrap();
    }
    let before = c.total_changes();
    let data = report_exports::read(&c, &ctx(), Kind::Repairs, "0", "3000").unwrap();
    assert_eq!(data["summary"]["incomeCents"], "400");
    assert_eq!(data["summary"]["partsCostCents"], "120");
    assert_eq!(data["summary"]["profitCents"], "280");
    assert_eq!(c.total_changes(), before);
}
#[test]
fn private_receipts_and_downloads_do_not_replay_money_or_regress_credentials() {
    use ventard_core::application::{repair_private as private, sales_sync};
    let mut c = db();
    repair_fixture(&mut c);
    for (op, seq) in [(301, 1), (302, 2)] {
        let e = inventory_event(&c, op, seq);
        sales_sync::receive_event(&mut c, &ctx(), &e).unwrap();
    }
    let req = repair_save(701, "0");
    management::execute_private(
        &mut c,
        &grant_tier(2, 5, true, Some("pro")),
        2000,
        2000,
        1,
        req,
        Some(private::Change {
            value: "First fixture code".into(),
            base_operation_id: None,
        }),
    )
    .unwrap();
    let receipt = repair_event(&c, 701, 3);
    sales_sync::receive_event(&mut c, &ctx(), &receipt).unwrap();
    let d = private::pending(&c, &ctx()).unwrap().pop().unwrap();
    let ack = json!({"protocol":"ventard.repair.private.receipt.1","operationId":id(701),"tenantId":id(1),"scope":{"type":"BRANCH","branchId":id(5)},"repairId":id(700),"intentHash":d.hash,"status":"APPLIED"});
    private::acknowledge(&c, &ctx(), &d, &ack).unwrap();
    assert_eq!(
        private::read(&c, &ctx(), &id(700)).unwrap()["remoteState"],
        "APPLIED"
    );
    let mut edit = repair_save(702, "1");
    if let management::Command::RepairSave {
        initial_payment_cents,
        ..
    } = &mut edit
    {
        *initial_payment_cents = "0".into();
    }
    management::execute_private(
        &mut c,
        &grant_tier(2, 5, true, Some("pro")),
        2000,
        2000,
        1,
        edit,
        Some(private::Change {
            value: "Second fixture code".into(),
            base_operation_id: Some(id(701)),
        }),
    )
    .unwrap();
    let old = json!({"protocol":"ventard.repair.private.view.1","tenantId":id(1),"scope":{"type":"BRANCH","branchId":id(5)},"rows":[{"repairId":id(700),"operationId":id(701),"repairRevision":"1","value":"First fixture code"}]});
    private::import(&c, &ctx(), &old).unwrap();
    assert_eq!(
        private::read(&c, &ctx(), &id(700)).unwrap()["value"],
        "Second fixture code"
    );
    let e = repair_event(&c, 702, 4);
    sales_sync::receive_event(&mut c, &ctx(), &e).unwrap();
    let d = private::pending(&c, &ctx()).unwrap().pop().unwrap();
    let mut ack = ack;
    ack["operationId"] = json!(id(702));
    ack["intentHash"] = json!(d.hash);
    private::acknowledge(&c, &ctx(), &d, &ack).unwrap();
    private::import(&c, &ctx(), &old).unwrap();
    assert_eq!(
        private::read(&c, &ctx(), &id(700)).unwrap()["value"],
        "Second fixture code"
    );
    let changes = c.total_changes();
    let mut wrong = ctx();
    wrong.branch_id = Some(id(555));
    assert!(private::import(&c, &wrong, &old).is_err());
    assert_eq!(c.total_changes(), changes);
    assert_eq!(
        management::drawer(&c, &ctx(), &id(90)).unwrap()["expectedCents"],
        "50100"
    );
    assert_eq!(inventory_product(&c)["stock"], "2");
}
#[test]
fn equipment_credentials_commit_with_repair_but_never_enter_public_journal_or_outbox() {
    use ventard_core::application::repair_private::{self, Change};
    let mut c = db();
    repair_fixture(&mut c);
    let req = repair_save(701, "0");
    let private = Change {
        value: "1-2-3 · fixture equipment".into(),
        base_operation_id: None,
    };
    c.execute_batch("CREATE TRIGGER fail_private BEFORE INSERT ON native_management_records_v1 WHEN NEW.kind='REPAIR_CREATE' BEGIN SELECT RAISE(ABORT,'private fixture rollback');END;").unwrap();
    assert!(management::execute_private(
        &mut c,
        &grant_tier(2, 5, true, Some("pro")),
        2000,
        2000,
        1,
        req.clone(),
        Some(private.clone())
    )
    .is_err());
    assert_eq!(
        repair_private::read(&c, &ctx(), &id(700)).unwrap()["value"],
        serde_json::Value::Null
    );
    assert_eq!(inventory_product(&c)["stock"], "4");
    c.execute_batch("DROP TRIGGER fail_private;").unwrap();
    run_pro(&mut c, req.clone()).unwrap();
    assert_eq!(
        repair_private::read(&c, &ctx(), &id(700)).unwrap()["value"],
        private.value
    );
    for _ in 0..5 {
        run_pro(&mut c, req.clone()).unwrap();
    }
    let journal: Vec<u8> = c
        .query_row(
            "SELECT canonical_bytes FROM operation_journal WHERE operation_id=?1",
            [id(701)],
            |r| r.get(0),
        )
        .unwrap();
    let outbox: Vec<u8> = c
        .query_row(
            "SELECT envelope FROM outbox WHERE operation_id=?1",
            [id(701)],
            |r| r.get(0),
        )
        .unwrap();
    for bytes in [journal, outbox] {
        assert!(!String::from_utf8(bytes)
            .unwrap()
            .contains("fixture equipment"));
    }
    let mut conflict = private;
    conflict.value = "another value".into();
    assert_eq!(
        management::execute_private(
            &mut c,
            &grant_tier(2, 5, true, Some("pro")),
            2000,
            2000,
            1,
            req,
            Some(conflict)
        )
        .unwrap_err()
        .code(),
        "OPERATION_ID_CONFLICT"
    );
    assert_eq!(inventory_product(&c)["stock"], "2");
    assert_eq!(
        c.query_row::<i64, _, _>(
            "SELECT count(*) FROM native_repair_private_outbox_v1",
            [],
            |r| r.get(0)
        )
        .unwrap(),
        1
    );
}
#[test]
#[ignore = "requires the isolated PostgreSQL disassembly capture, explicitly run by QA"]
fn postgres_disassembly_capture_preserves_recovered_stock_and_prior_deposits() {
    use ventard_core::application::{repairs, sales_sync};
    let fixture: serde_json::Value = serde_json::from_slice(
        &std::fs::read(std::env::var("VENTARD_REPAIR_DISASSEMBLY_FIXTURE").unwrap()).unwrap(),
    )
    .unwrap();
    let m = &fixture["manifest"];
    let context: CatalogueContext = serde_json::from_value(m["context"].clone()).unwrap();
    let now = m["capturedAtMs"].as_str().unwrap().parse::<u64>().unwrap();
    let mut c = Connection::open_in_memory().unwrap();
    c.pragma_update(None, "foreign_keys", true).unwrap();
    migrations::apply(&mut c).unwrap();
    sales_sync::begin_bootstrap(&mut c, &context, m, now).unwrap();
    for (i, p) in fixture["pages"].as_array().unwrap().iter().enumerate() {
        sales_sync::stage_bootstrap_page(&mut c, &context, i, p.as_str().unwrap(), now).unwrap();
    }
    sales_sync::activate_bootstrap(&mut c, &context, now, &id(800)).unwrap();
    let r = repairs::read(&c, &context).unwrap();
    assert_eq!(r["rows"][0]["state"], "cancelado");
    assert_eq!(r["rows"][0]["paidCents"], "150");
    assert_eq!(r["rows"][0]["totalCents"], "50");
    assert_eq!(r["rows"][0]["settlementPendingCents"], "100");
    assert_eq!(c.query_row::<String,_,_>("SELECT effective_stock FROM stock_projections WHERE producto_id='96200000-0000-4000-8000-000000000801'",[],|r|r.get(0)).unwrap(),"3");
    assert_eq!(c.query_row::<String,_,_>("SELECT effective_stock FROM stock_projections WHERE producto_id='96200000-0000-4000-8000-000000000020'",[],|r|r.get(0)).unwrap(),"102");
    let turn = m["turn"]["receipt"]["operationId"].as_str().unwrap();
    assert_eq!(
        management::drawer(&c, &context, turn).unwrap()["expectedCents"],
        "50100"
    );
}
#[test]
fn abandoned_equipment_disassembly_creates_parts_and_stock_atomically() {
    let mut c = db();
    repair_fixture(&mut c);
    run_pro(&mut c, repair_save(701, "0")).unwrap();
    let mut quote = repair_save(702, "1");
    if let management::Command::RepairSave {
        quote,
        initial_payment_cents,
        ..
    } = &mut quote
    {
        *quote = true;
        *initial_payment_cents = "0".into();
    }
    run_pro(&mut c, quote).unwrap();
    run_pro(&mut c, repair_action(703, "2", "ABANDON", "TARJETA", "50")).unwrap();
    assert_eq!(inventory_product(&c)["stock"], "4");
    let req:management::Command=serde_json::from_value(json!({"kind":"REPAIR_DISASSEMBLE","operationId":id(811),"repairId":id(700),"expectedRevision":"3","entries":[{"productId":id(300),"quantity":"2","newProduct":null},{"productId":id(801),"quantity":"3","newProduct":{"name":"Cámara recuperada","code":"","priceCents":"0","tier2Cents":null,"tier3Cents":null,"costCents":"700","taxPercent":"0","productType":"insumo","location":"","minimum":"0","serialRequired":false,"recipe":[]}}]})).unwrap();
    c.execute_batch("CREATE TRIGGER fail_disassembly BEFORE INSERT ON native_management_records_v1 WHEN NEW.kind='REPAIR_DISASSEMBLE' BEGIN SELECT RAISE(ABORT,'fixture disassembly');END;").unwrap();
    assert!(run_pro(&mut c, req.clone()).is_err());
    assert_eq!(inventory_product(&c)["stock"], "4");
    assert_eq!(
        c.query_row::<i64, _, _>(
            "SELECT count(*) FROM products WHERE producto_id=?1",
            [id(801)],
            |r| r.get(0)
        )
        .unwrap(),
        0
    );
    c.execute_batch("DROP TRIGGER fail_disassembly;").unwrap();
    let d = run_pro(&mut c, req.clone()).unwrap();
    assert_eq!(d["document"]["repair"]["state"], "cancelado");
    for _ in 0..5 {
        assert_eq!(run_pro(&mut c, req.clone()).unwrap(), d);
    }
    assert_eq!(inventory_product(&c)["stock"], "6");
    assert_eq!(
        c.query_row::<String, _, _>(
            "SELECT effective_stock FROM stock_projections WHERE producto_id=?1",
            [id(801)],
            |r| r.get(0)
        )
        .unwrap(),
        "3"
    );
    assert_eq!(
        management::drawer(&c, &ctx(), &id(90)).unwrap()["expectedCents"],
        "50100"
    );
    assert_eq!(d["document"]["repair"]["paidCents"], "150");
    assert_eq!(d["document"]["repair"]["totalCents"], "50");
    assert_eq!(d["document"]["repair"]["settlementPendingCents"], "100");
}
#[test]
fn warranty_reentry_is_linked_free_and_requires_a_current_original_warranty() {
    let mut c = db();
    repair_fixture(&mut c);
    run_pro(&mut c, repair_save(701, "0")).unwrap();
    let mut quote = repair_save(702, "1");
    if let management::Command::RepairSave {
        quote,
        initial_payment_cents,
        ..
    } = &mut quote
    {
        *quote = true;
        *initial_payment_cents = "0".into();
    }
    run_pro(&mut c, quote).unwrap();
    run_pro(&mut c, repair_action(703, "2", "APPROVE", "EFECTIVO", "0")).unwrap();
    run_pro(&mut c, repair_action(704, "3", "READY", "EFECTIVO", "0")).unwrap();
    run_pro(&mut c, repair_action(705, "4", "DELIVER", "EFECTIVO", "0")).unwrap();
    let mut value = serde_json::to_value(repair_save(721, "0")).unwrap();
    value["repairId"] = json!(id(720));
    value["initialPaymentCents"] = json!("0");
    value["definition"]["labourCents"] = json!("0");
    value["definition"]["parts"] = json!([]);
    value["definition"]["warrantyOriginId"] = json!(id(700));
    let req: management::Command = serde_json::from_value(value.clone()).unwrap();
    let r = run_pro(&mut c, req).unwrap();
    assert_eq!(
        r["document"]["repair"]["definition"]["warrantyOriginId"],
        id(700)
    );
    assert_eq!(r["document"]["repair"]["totalCents"], "0");
    assert_eq!(inventory_product(&c)["stock"], "2");
    value["operationId"] = json!(id(722));
    value["expectedRevision"] = json!("1");
    value["definition"]["labourCents"] = json!("1");
    assert_eq!(
        run_pro(&mut c, serde_json::from_value(value.clone()).unwrap())
            .unwrap_err()
            .code(),
        "SERVICE_GUARANTEE_FREE"
    );
    value["operationId"] = json!(id(723));
    value["repairId"] = json!(id(724));
    value["expectedRevision"] = json!("0");
    value["definition"]["labourCents"] = json!("0");
    let req = serde_json::from_value(value).unwrap();
    assert_eq!(
        management::execute(
            &mut c,
            &grant_tier(2, 5, true, Some("pro")),
            3_000_000_000,
            3_000_000_000,
            1,
            req
        )
        .unwrap_err()
        .code(),
        "SERVICE_GUARANTEE_EXPIRED"
    );
}
#[test]
#[ignore = "requires the isolated PostgreSQL capture fixture, explicitly run by QA"]
fn postgres_repair_capture_roundtrip_preserves_money_stock_and_ticket() {
    use ventard_core::application::{printing, repairs, sales_sync};
    let path = std::env::var("VENTARD_REPAIR_BOOTSTRAP_FIXTURE").expect("local fixture path");
    let fixture: serde_json::Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let m = &fixture["manifest"];
    let context: CatalogueContext = serde_json::from_value(m["context"].clone()).unwrap();
    let now = m["capturedAtMs"].as_str().unwrap().parse::<u64>().unwrap();
    let mut c = Connection::open_in_memory().unwrap();
    c.pragma_update(None, "foreign_keys", true).unwrap();
    migrations::apply(&mut c).unwrap();
    sales_sync::begin_bootstrap(&mut c, &context, m, now).unwrap();
    for (i, p) in fixture["pages"].as_array().unwrap().iter().enumerate() {
        sales_sync::stage_bootstrap_page(&mut c, &context, i, p.as_str().unwrap(), now).unwrap();
    }
    sales_sync::activate_bootstrap(&mut c, &context, now, &id(800)).unwrap();
    let r = repairs::read(&c, &context).unwrap();
    assert_eq!(r["rows"].as_array().unwrap().len(), 1);
    assert_eq!(r["rows"][0]["state"], "entregado");
    assert_eq!(r["rows"][0]["paidCents"], "400");
    let turn = m["turn"]["receipt"]["operationId"].as_str().unwrap();
    let d = management::drawer(&c, &context, turn).unwrap();
    assert_eq!(d["expectedCents"], "50300");
    assert_eq!(d["summary"]["repairIncomeCents"], "400");
    assert_eq!(d["summary"]["repairCashCents"], "300");
    assert_eq!(
        c.query_row::<String, _, _>("SELECT effective_stock FROM stock_projections", [], |r| r
            .get(0))
            .unwrap(),
        "98"
    );
    assert_eq!(
        c.query_row::<i64, _, _>("SELECT count(*) FROM sale_cash_entries_v1", [], |r| r
            .get(0))
            .unwrap(),
        0
    );
    let op = r["rows"][0]["operationId"].as_str().unwrap();
    let ticket = printing::repair_ticket(&c, &context, op).unwrap();
    assert_eq!(
        ticket["document"]["repair"]["payments"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
    assert_eq!(ticket["document"]["repair"]["totalCents"], "400");
}
#[test]
fn encrypted_repair_reopen_recovers_original_intent_and_uncertain_print() {
    use ventard_core::{
        application::{printing, repairs},
        storage::{cipher::CipherKey, writer::VaultWriter},
    };
    let root = std::env::temp_dir();
    let path = root.join(format!("ventard-repair-fixture-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&path).unwrap();
    let key = CipherKey::new([0x68; 32]);
    let req = repair_save(701, "0");
    let hash;
    {
        let mut vault = VaultWriter::create_encrypted(&path, &key).unwrap();
        let c = vault.connection();
        c.execute(
            "INSERT INTO scopes VALUES(?1,'BRANCH',?2,?3)",
            (sales_key(), id(5), id(1)),
        )
        .unwrap();
        c.execute(
            "INSERT INTO native_sales_cursor_v1 VALUES(?1,?2,'NATIVE1',0)",
            (id(1), sales_key()),
        )
        .unwrap();
        repair_fixture(c);
        c.execute_batch("CREATE TRIGGER fail_repair BEFORE INSERT ON sale_cash_entries_v1 WHEN NEW.operation_id='96000000-0000-4000-8000-000000000701' BEGIN SELECT RAISE(ABORT,'repair fixture');END;").unwrap();
        assert!(management::execute_private(
            c,
            &grant_tier(2, 5, true, Some("pro")),
            2000,
            2000,
            1,
            req.clone(),
            Some(ventard_core::application::repair_private::Change {
                value: "reopen equipment fixture".into(),
                base_operation_id: None
            })
        )
        .is_err());
    }
    {
        let mut vault = VaultWriter::open_encrypted(&path, &key).unwrap();
        let c = vault.connection();
        assert_eq!(inventory_product(c)["stock"], "4");
        assert!(repairs::read(c, &ctx()).unwrap()["rows"]
            .as_array()
            .unwrap()
            .is_empty());
        c.execute_batch("DROP TRIGGER fail_repair;").unwrap();
        management::execute(
            c,
            &grant_tier(2, 5, true, Some("pro")),
            9000,
            9000,
            1,
            req.clone(),
        )
        .unwrap();
        let ticket = printing::repair_ticket(c, &ctx(), &id(701)).unwrap();
        assert_eq!(ticket["originAtUtcMs"], "2000");
        hash = ticket["printSnapshotHash"].as_str().unwrap().to_owned();
        assert!(printing::request_cut(c, &ctx(), &id(701), &hash, &id(799)).unwrap());
    }
    {
        let mut vault = VaultWriter::open_encrypted(&path, &key).unwrap();
        let c = vault.connection();
        run_pro(c, req).unwrap();
        assert_eq!(
            ventard_core::application::repair_private::read(c, &ctx(), &id(700)).unwrap()["value"],
            "reopen equipment fixture"
        );
        assert_eq!(inventory_product(c)["stock"], "2");
        assert_eq!(
            management::drawer(c, &ctx(), &id(90)).unwrap()["expectedCents"],
            "50100"
        );
        assert!(!printing::request_cut(c, &ctx(), &id(701), &hash, &id(799)).unwrap());
        assert_eq!(
            printing::repair_ticket(c, &ctx(), &id(701)).unwrap()["printAttempt"]["state"],
            "UNKNOWN"
        );
    }
    let real = std::fs::canonicalize(&path).unwrap();
    assert!(
        real.starts_with(std::fs::canonicalize(&root).unwrap())
            && real
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("ventard-repair-fixture-")
    );
    std::fs::remove_dir_all(real).unwrap();
}
#[test]
fn a_current_repair_capture_preserves_prior_payments_without_reapplying_money() {
    use ventard_core::application::{printing, repairs, sales_sync};
    let mut a = db();
    repair_fixture(&mut a);
    for (op, seq) in [(301, 1), (302, 2)] {
        let e = inventory_event(&a, op, seq);
        sales_sync::receive_event(&mut a, &ctx(), &e).unwrap();
    }
    run_pro(&mut a, repair_save(701, "0")).unwrap();
    let created = repair_event(&a, 701, 3);
    sales_sync::receive_event(&mut a, &ctx(), &created).unwrap();
    run_pro(&mut a, repair_action(702, "1", "PAYMENT", "TARJETA", "100")).unwrap();
    let latest = repair_event(&a, 702, 4);
    let mut b = db();
    repair_fixture(&mut b);
    b.execute("UPDATE stock_projections SET effective_stock='2',remote_base_qty='2',pending_coverage='[]',remote_seq=4",[]).unwrap();
    b.execute(
        "INSERT INTO native_cash_baseline_v1 VALUES(?1,?2,100,4,'VERIFIED')",
        (id(1), id(90)),
    )
    .unwrap();
    let tx = b.transaction().unwrap();
    repairs::import_capture(&tx, &ctx(), &latest, 4).unwrap();
    tx.commit().unwrap();
    assert_eq!(inventory_product(&b)["stock"], "2");
    assert_eq!(
        repairs::read(&b, &ctx()).unwrap()["rows"][0]["paidCents"],
        "200"
    );
    let drawer = management::drawer(&b, &ctx(), &id(90)).unwrap();
    assert_eq!(drawer["expectedCents"], "50100");
    assert_eq!(drawer["summary"]["repairIncomeCents"], "200");
    assert_eq!(drawer["summary"]["repairCashCents"], "100");
    assert_eq!(
        b.query_row::<i64, _, _>("SELECT count(*) FROM sale_cash_entries_v1", [], |r| r
            .get(0))
            .unwrap(),
        0
    );
    assert_eq!(
        printing::repair_ticket(&a, &ctx(), &id(702)).unwrap()["printSnapshotHash"],
        printing::repair_ticket(&b, &ctx(), &id(702)).unwrap()["printSnapshotHash"]
    );
    let mut next = repair_save(721, "0");
    if let management::Command::RepairSave { repair_id, .. } = &mut next {
        *repair_id = id(720);
    }
    let next = run_pro(&mut b, next).unwrap();
    assert!(next["document"]["repair"]["folio"]
        .as_str()
        .unwrap()
        .ends_with("-002"));
}
fn inventory_save(op: u32, revision: &str) -> management::Command {
    serde_json::from_value(json!({"kind":"PRODUCT_SAVE","operationId":id(op),"productId":id(300),"expectedRevision":revision,"definition":{"name":"Café QA","code":"CAFE","priceCents":"12345","tier2Cents":"10000","tier3Cents":null,"costCents":"6000","taxPercent":"18","productType":"simple","location":"A-2","minimum":"3","serialRequired":false,"recipe":[]}})).unwrap()
}
fn repair_save(op: u32, rev: &str) -> management::Command {
    serde_json::from_value(json!({"kind":"REPAIR_SAVE","operationId":id(op),"repairId":id(700),"expectedRevision":rev,"quote":false,"definition":{"customerId":null,"customerName":"Ana QA","phone":"8095550100","brand":"Samsung","model":"A14","imei":"IMEI-QA","color":"Negro","conditionChecks":["Enciende"],"conditionNotes":"Rayón","accessories":"Funda","problem":"Pantalla","diagnosis":"Cambio pantalla","notes":"QA","technician":"Luis","labourCents":"200","partsChargeSeparate":true,"parts":[{"productId":id(300),"name":"Café QA","quantity":"2","costCents":"60","priceCents":"100"}]},"initialPaymentCents":"100","method":"EFECTIVO","turnId":id(90)})).unwrap()
}
fn repair_action(
    op: u32,
    rev: &str,
    action: &str,
    method: &str,
    amount: &str,
) -> management::Command {
    serde_json::from_value(json!({"kind":"REPAIR_ACTION","operationId":id(op),"repairId":id(700),"expectedRevision":rev,"action":action,"amountCents":amount,"method":method,"turnId":id(90),"warrantyDays":if action=="DELIVER"{"30"}else{"0"}})).unwrap()
}
fn run_pro(
    c: &mut Connection,
    req: management::Command,
) -> Result<serde_json::Value, ventard_core::application::errors::AppError> {
    management::execute(c, &grant_tier(2, 5, true, Some("pro")), 2000, 2000, 1, req)
}
fn repair_fixture(c: &mut Connection) {
    run(c, inventory_save(301, "0")).unwrap();
    let rev = inventory_product(c)["stockRevision"]
        .as_str()
        .unwrap()
        .to_owned();
    run(c, inventory_change(302, &rev, "IN", "4")).unwrap();
    turn(c);
    c.execute(
        "INSERT INTO installations VALUES(?1,?2,1,?3,'1000','ACTIVE')",
        (id(4), id(3), format!("N{}", id(4).replace('-', ""))),
    )
    .unwrap();
    c.execute(
        "INSERT INTO ticket_sequences VALUES(?1,?2,?3,'1',?5,0,?4,x'7b7d')",
        (
            id(1),
            id(4),
            id(3),
            "0".repeat(64),
            format!("N{}", id(4).replace('-', "")),
        ),
    )
    .unwrap();
}
#[test]
fn repair_money_stock_states_and_replay_are_one_transaction() {
    let mut c = db();
    repair_fixture(&mut c);
    let req = repair_save(701, "0");
    let first = run_pro(&mut c, req.clone()).unwrap();
    assert_eq!(first["document"]["repair"]["totalCents"], "400");
    assert_eq!(first["document"]["repair"]["paidCents"], "100");
    for _ in 0..10 {
        assert_eq!(run_pro(&mut c, req.clone()).unwrap(), first);
    }
    assert_eq!(inventory_product(&c)["stock"], "2");
    assert_eq!(
        management::read(&c, &ctx()).unwrap()["turn"]["expectedCents"],
        "50100"
    );
    run_pro(&mut c, repair_action(702, "1", "PAYMENT", "TARJETA", "100")).unwrap();
    assert_eq!(
        management::read(&c, &ctx()).unwrap()["turn"]["expectedCents"],
        "50100"
    );
    run_pro(&mut c, repair_action(703, "2", "DIAGNOSE", "EFECTIVO", "0")).unwrap();
    let mut quote = repair_save(704, "3");
    if let management::Command::RepairSave {
        quote: q,
        initial_payment_cents,
        ..
    } = &mut quote
    {
        *q = true;
        *initial_payment_cents = "0".into();
    }
    run_pro(&mut c, quote).unwrap();
    run_pro(&mut c, repair_action(705, "4", "APPROVE", "EFECTIVO", "0")).unwrap();
    run_pro(&mut c, repair_action(706, "5", "READY", "EFECTIVO", "0")).unwrap();
    let delivered = run_pro(&mut c, repair_action(707, "6", "DELIVER", "EFECTIVO", "0")).unwrap();
    assert_eq!(delivered["document"]["amountCents"], "200");
    assert_eq!(delivered["document"]["repair"]["paidCents"], "400");
    assert_eq!(
        delivered["document"]["repair"]["warrantyUntilMs"],
        "2592002000"
    );
    assert_eq!(
        management::read(&c, &ctx()).unwrap()["turn"]["expectedCents"],
        "50300"
    );
    assert_eq!(inventory_product(&c)["stock"], "2");
    assert_eq!(
        run_pro(&mut c, repair_action(708, "7", "PAYMENT", "EFECTIVO", "1"))
            .unwrap_err()
            .code(),
        "SERVICE_STATE_INVALID"
    );
}
#[test]
fn repairs_require_signed_pro_and_do_not_invent_cash_or_allow_overpayment() {
    let mut c = db();
    repair_fixture(&mut c);
    for tier in [None, Some("basico")] {
        assert_eq!(
            management::execute(
                &mut c,
                &grant_tier(2, 5, true, tier),
                2000,
                2000,
                1,
                repair_save(701, "0")
            )
            .unwrap_err()
            .code(),
            "PRO_REQUIRED"
        );
    }
    c.execute("UPDATE cash_turns SET status='CLOSED'", [])
        .unwrap();
    assert_eq!(
        run_pro(&mut c, repair_save(701, "0")).unwrap_err().code(),
        "TURN_CHANGED"
    );
    assert_eq!(inventory_product(&c)["stock"], "4");
    c.execute("UPDATE cash_turns SET status='OPEN'", [])
        .unwrap();
    run_pro(&mut c, repair_save(701, "0")).unwrap();
    assert_eq!(
        run_pro(
            &mut c,
            repair_action(702, "1", "PAYMENT", "EFECTIVO", "301")
        )
        .unwrap_err()
        .code(),
        "SERVICE_OVERPAY"
    );
    assert_eq!(
        run_pro(
            &mut c,
            repair_action(703, "0", "PAYMENT", "EFECTIVO", "100")
        )
        .unwrap_err()
        .code(),
        "VERSION_CONFLICT"
    );
    let cancelled = run_pro(&mut c, repair_action(704, "1", "CANCEL", "EFECTIVO", "0")).unwrap();
    assert_eq!(cancelled["document"]["repair"]["paidCents"], "100");
    assert_eq!(inventory_product(&c)["stock"], "4");
    assert_eq!(
        management::read(&c, &ctx()).unwrap()["turn"]["expectedCents"],
        "50100"
    );
}
#[test]
fn repair_failure_rolls_back_and_retry_uses_original_date_and_stock() {
    let mut c = db();
    repair_fixture(&mut c);
    c.execute_batch("CREATE TRIGGER repair_failure BEFORE INSERT ON native_management_records_v1 WHEN NEW.kind='REPAIR_CREATE' BEGIN SELECT RAISE(ABORT,'fixture injected failure');END;").unwrap();
    let req = repair_save(701, "0");
    assert!(run_pro(&mut c, req.clone()).is_err());
    assert_eq!(inventory_product(&c)["stock"], "4");
    assert_eq!(
        management::read(&c, &ctx()).unwrap()["turn"]["expectedCents"],
        "50000"
    );
    c.execute_batch("DROP TRIGGER repair_failure;").unwrap();
    let result = management::execute(
        &mut c,
        &grant_tier(2, 5, true, Some("pro")),
        9999,
        9999,
        1,
        req,
    )
    .unwrap();
    assert_eq!(result["document"]["repair"]["createdAtMs"], "2000");
    assert_eq!(inventory_product(&c)["stock"], "2");
}
#[test]
fn an_uncosted_reception_can_hold_a_deposit_but_a_quote_cannot_erase_it() {
    let mut c = db();
    repair_fixture(&mut c);
    let mut req = repair_save(701, "0");
    if let management::Command::RepairSave { definition, .. } = &mut req {
        definition.parts.clear();
        definition.labour_cents = "0".into();
    }
    let d = run_pro(&mut c, req.clone()).unwrap();
    assert_eq!(d["document"]["repair"]["totalCents"], "0");
    assert_eq!(d["document"]["repair"]["paidCents"], "100");
    if let management::Command::RepairSave {
        operation_id,
        expected_revision,
        quote,
        initial_payment_cents,
        ..
    } = &mut req
    {
        *operation_id = id(702);
        *expected_revision = "1".into();
        *quote = true;
        *initial_payment_cents = "0".into();
    }
    assert_eq!(
        run_pro(&mut c, req.clone()).unwrap_err().code(),
        "SERVICE_OVERPAY"
    );
    if let management::Command::RepairSave { definition, .. } = &mut req {
        definition.labour_cents = "200".into();
    }
    run_pro(&mut c, req).unwrap();
    assert_eq!(inventory_product(&c)["stock"], "4");
}
fn repair_event(c: &Connection, op: u32, seq: u32) -> serde_json::Value {
    let mut e = event(c, op, seq);
    let v: serde_json::Value = serde_json::from_str(e["intent"].as_str().unwrap()).unwrap();
    e["receipt"]["stock"] = json!(v["payload"]["document"]["stock"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| json!({"productId":d["productId"],"after":d["after"],"version":seq.to_string()}))
        .collect::<Vec<_>>());
    e
}
#[test]
fn repair_receipts_rederive_money_and_import_once_without_repeating_stock() {
    use ventard_core::application::{printing, repairs, sales_sync};
    let mut a = db();
    let mut b = db();
    for c in [&mut a, &mut b] {
        repair_fixture(c);
        for (op, seq) in [(301, 1), (302, 2)] {
            sales_sync::receive_event(c, &ctx(), &inventory_event(c, op, seq)).unwrap();
        }
    }
    run_pro(&mut a, repair_save(701, "0")).unwrap();
    let e = repair_event(&a, 701, 3);
    let mut bad = e.clone();
    bad["receipt"]["stock"][0]["after"] = json!("3");
    assert!(sales_sync::receive_event(&mut b, &ctx(), &bad).is_err());
    assert!(repairs::read(&b, &ctx()).unwrap()["rows"]
        .as_array()
        .unwrap()
        .is_empty());
    for c in [&mut a, &mut b] {
        sales_sync::receive_event(c, &ctx(), &e).unwrap();
        sales_sync::receive_event(c, &ctx(), &e).unwrap();
        assert_eq!(inventory_product(c)["stock"], "2");
        assert_eq!(
            management::read(c, &ctx()).unwrap()["turn"]["expectedCents"],
            "50100"
        );
    }
    run_pro(&mut a, repair_action(702, "1", "PAYMENT", "TARJETA", "100")).unwrap();
    let e = repair_event(&a, 702, 4);
    sales_sync::receive_event(&mut b, &ctx(), &e).unwrap();
    assert_eq!(
        repairs::read(&b, &ctx()).unwrap()["rows"][0]["paidCents"],
        "200"
    );
    let ta = printing::repair_ticket(&a, &ctx(), &id(701)).unwrap();
    let tb = printing::repair_ticket(&b, &ctx(), &id(701)).unwrap();
    assert_eq!(ta["printSnapshotHash"], tb["printSnapshotHash"]);
    assert_eq!(tb["document"]["repair"]["paidCents"], "100");
    let hash = ta["printSnapshotHash"].as_str().unwrap();
    assert!(printing::request_cut(&mut a, &ctx(), &id(701), hash, &id(799)).unwrap());
    assert!(!printing::request_cut(&mut a, &ctx(), &id(701), hash, &id(799)).unwrap());
    assert_eq!(inventory_product(&a)["stock"], "2");
}
fn return_fixture(c: &mut Connection) {
    run(c, inventory_save(301, "0")).unwrap();
    let rev = inventory_product(c)["stockRevision"]
        .as_str()
        .unwrap()
        .to_owned();
    run(c, inventory_change(302, &rev, "IN", "4")).unwrap();
    turn(c);
    let snap = json!({"version":"ventard.ticket.snapshot.1","operationId":id(990),"tenantId":id(1),"scope":{"type":"BRANCH","branchId":id(5)},"actorId":id(2),"originAtUtcMs":"2000","ticket":"QA-return-basis","ncf":null,"sale":{"lines":[{"productId":id(300),"name":"Precio original","quantity":{"numerator":"3","denominator":"1"},"unitPriceCents":"33","recipe":[]}],"totals":{"totalCents":"100","itbisCents":"1","discountCents":"0"},"payment":{"method":"EFECTIVO","cashNetCents":"100","cardCents":"0","transferCents":"0","creditChargeCents":"0","customerId":null},"serials":[]}});
    let (b, h) = canonicalize(&serde_json::to_vec(&snap).unwrap()).unwrap();
    c.execute("INSERT INTO operation_journal VALUES(?1,'ventard.native.v1','SALE_CONFIRM',1,?2,?3,?4,?5,?6,1,'2000',100,'COMMITTED','{}')",(id(990),b.as_bytes(),&h,id(2),format!("BRANCH:{}",id(5)),id(3))).unwrap();
    c.execute(
        "INSERT INTO sales VALUES(?1,?1,?2,?3,?4,'QA-return-basis',NULL,?5,100,1,0,'QA','2000')",
        (id(990), id(1), sales_key(), id(90), id(2)),
    )
    .unwrap();
    c.execute(
        "INSERT INTO sale_ticket_snapshots_v1 VALUES(?1,?2,?3)",
        (id(990), b.as_bytes(), &h),
    )
    .unwrap();
}
fn sales_key() -> String {
    format!("{}/BRANCH:{}", id(1), id(5))
}
#[test]
fn an_old_operational_capture_without_cash_base_never_means_zero_cash() {
    let mut c = db();
    turn(&mut c);
    let manifest = json!({"context":{"tenantId":id(1)},"turn":{"receipt":{"operationId":id(90)}},"cashBase":null});
    c.execute(
        "INSERT INTO native_sales_bootstrap_v1 VALUES('cash-coverage-fixture',?1,'ACTIVE')",
        [manifest.to_string()],
    )
    .unwrap();
    let d = management::drawer(&c, &ctx(), &id(90)).unwrap();
    assert_eq!(d["coverage"], "UNKNOWN");
    assert_eq!(d["expectedCents"], serde_json::Value::Null);
    assert_eq!(
        run(
            &mut c,
            management::Command::CashEntry {
                operation_id: id(80),
                amount_cents: "100".into(),
                direction: "OUT".into(),
                concept: "Caja desconocida QA".into(),
                turn_id: id(90)
            }
        )
        .unwrap_err()
        .code(),
        "CASH_UNVERIFIED"
    );
}
#[test]
fn report_exports_are_readonly_scoped_and_preserve_historical_prices() {
    use ventard_core::application::report_exports::{self, Kind};
    let mut c = db();
    return_fixture(&mut c);
    let req = refund(&c, 991, "1");
    run(&mut c, req).unwrap();
    let changes = c.total_changes();
    let data = report_exports::read(&c, &ctx(), Kind::Sales, "0", "3000").unwrap();
    assert_eq!(data["sales"].as_array().unwrap().len(), 1);
    assert_eq!(data["sales"][0]["totalCents"], "100");
    assert_eq!(data["topProducts"][0]["name"], "Precio original");
    assert_eq!(data["topProducts"][0]["subtotalCents"], "99");
    assert_eq!(data["summary"]["netSalesCents"], "67");
    assert_eq!(data["refunds"].as_array().unwrap().len(), 1);
    let stock = report_exports::read(&c, &ctx(), Kind::Inventory, "0", "3000").unwrap();
    assert_eq!(stock["products"][0]["stock"], "5");
    assert_eq!(stock["products"][0]["priceCents"], "12345");
    assert_eq!(c.total_changes(), changes);
    let ncf = report_exports::read(&c, &ctx(), Kind::Ncf, "0", "3000").unwrap();
    assert_eq!(ncf["sales"], json!([]));
    let mut other = ctx();
    other.tenant_id = id(99);
    assert!(report_exports::read(&c, &other, Kind::Inventory, "0", "3000").is_err());
    assert!(report_exports::read(&c, &ctx(), Kind::Sales, "3000", "0").is_err());
}
#[test]
fn rejected_positive_stock_is_not_promoted_by_an_unrelated_receipt() {
    use ventard_core::application::sales_sync;
    let mut c = db();
    run(&mut c, inventory_save(301, "0")).unwrap();
    let created = inventory_event(&c, 301, 1);
    sales_sync::receive_event(&mut c, &ctx(), &created).unwrap();
    let rev = inventory_product(&c)["stockRevision"]
        .as_str()
        .unwrap()
        .to_owned();
    run(&mut c, inventory_change(302, &rev, "IN", "7")).unwrap();
    let moved = inventory_event(&c, 302, 2);
    let dispatch = sales_sync::claim(&mut c, &ctx(), 3000).unwrap().unwrap();
    sales_sync::record_failure(&mut c, &dispatch, 409, 3000, 1000).unwrap();
    assert_eq!(
        c.query_row::<String, _, _>("SELECT authority_state FROM stock_projections", [], |r| r
            .get(0))
            .unwrap(),
        "UNKNOWN"
    );
    assert_eq!(
        c.query_row::<String, _, _>("SELECT effective_stock FROM stock_projections", [], |r| r
            .get(0))
            .unwrap(),
        "7"
    );
    run(&mut c, inventory_save(303, "1")).unwrap();
    let patched = inventory_event(&c, 303, 3);
    sales_sync::receive_event(&mut c, &ctx(), &patched).unwrap();
    assert_eq!(
        c.query_row::<String, _, _>("SELECT authority_state FROM stock_projections", [], |r| r
            .get(0))
            .unwrap(),
        "UNKNOWN"
    );
    sales_sync::receive_event(&mut c, &ctx(), &moved).unwrap();
    assert_eq!(inventory_product(&c)["stock"], "7");
    assert_eq!(
        c.query_row::<String, _, _>("SELECT authority_state FROM stock_projections", [], |r| r
            .get(0))
            .unwrap(),
        "VERIFIED"
    );
}
fn refund(c: &Connection, op: u32, q: &str) -> management::Command {
    let v = ventard_core::application::returns::read(c, &ctx(), &id(990)).unwrap();
    serde_json::from_value(json!({"kind":"SALE_RETURN","operationId":id(op),"saleId":id(990),"expectedReturnRevision":v["revision"],"items":[{"key":id(300),"quantity":q}],"serials":[],"reason":"Producto defectuoso","turnId":id(90)})).unwrap()
}
fn replace_return_basis(c: &Connection, edit: impl FnOnce(&mut serde_json::Value)) {
    let raw: Vec<u8> = c
        .query_row(
            "SELECT snapshot_bytes FROM sale_ticket_snapshots_v1 WHERE operation_id=?1",
            [id(990)],
            |r| r.get(0),
        )
        .unwrap();
    let mut snap: serde_json::Value = serde_json::from_slice(&raw).unwrap();
    edit(&mut snap);
    let (b, h) = canonicalize(&serde_json::to_vec(&snap).unwrap()).unwrap();
    c.execute("UPDATE sale_ticket_snapshots_v1 SET snapshot_bytes=?2,snapshot_hash=?3 WHERE operation_id=?1",(id(990),b.as_bytes(),h)).unwrap();
}
#[test]
fn return_scoped_permissions_credit_and_fiscal_guards_preserve_money() {
    let mut c = db();
    return_fixture(&mut c);
    let request = refund(&c, 991, "3");
    assert_eq!(
        management::execute(&mut c, &grant(2, 5, false), 2000, 2000, 1, request.clone())
            .unwrap_err()
            .code(),
        "PERMISSION_DENIED"
    );
    let mut other = ctx();
    other.tenant_id = id(99);
    assert!(ventard_core::application::returns::read(&c, &other, &id(990)).is_err());
    replace_return_basis(&c, |v| v["ncf"] = json!("B0200000001"));
    let request = refund(&c, 991, "3");
    assert_eq!(
        run(&mut c, request).unwrap_err().code(),
        "RETURN_FISCAL_PENDING"
    );
    run(&mut c, save(20, "0")).unwrap();
    c.execute("UPDATE sale_customer_accounts_v1 SET balance_cents=50", [])
        .unwrap();
    c.execute(
        "INSERT INTO sale_credit_entries_v1 VALUES(?1,?2,?3,?4,100,0,100)",
        (id(990), id(30), id(1), sales_key()),
    )
    .unwrap();
    replace_return_basis(&c, |v| {
        v["ncf"] = serde_json::Value::Null;
        v["sale"]["payment"] = json!({"method":"FIADO","customerId":id(30),"cashNetCents":"0","cardCents":"0","transferCents":"0","creditChargeCents":"100"});
    });
    let request = refund(&c, 992, "3");
    assert_eq!(
        run(&mut c, request).unwrap_err().code(),
        "RETURN_PAID_CREDIT_PENDING"
    );
    c.execute("UPDATE sale_customer_accounts_v1 SET balance_cents=100", [])
        .unwrap();
    let request = refund(&c, 992, "3");
    run(&mut c, request).unwrap();
    assert_eq!(
        management::read(&c, &ctx()).unwrap()["customers"][0]["balanceCents"],
        "0"
    );
    assert_eq!(
        c.query_row::<i64, _, _>(
            "SELECT count(*) FROM sale_cash_entries_v1 WHERE operation_id=?1",
            [id(992)],
            |r| r.get(0)
        )
        .unwrap(),
        0
    );
    let report = management::report(&c, &ctx(), "0", "3000").unwrap();
    assert_eq!(report["refundCents"], "100");
    assert_eq!(report["netSalesCents"], "0");
    assert_eq!(report["profitCents"], serde_json::Value::Null);
}
#[test]
fn return_receipt_replays_and_remote_import_rederive_original_refund() {
    use ventard_core::application::sales_sync;
    let mut a = db();
    let mut b = db();
    for c in [&mut a, &mut b] {
        return_fixture(c);
        for (op, seq) in [(301, 1), (302, 2)] {
            let e = inventory_event(c, op, seq);
            sales_sync::receive_event(c, &ctx(), &e).unwrap();
        }
    }
    let request = refund(&a, 991, "1");
    run(&mut a, request).unwrap();
    let mut e = event(&a, 991, 3);
    let v: serde_json::Value = serde_json::from_str(e["intent"].as_str().unwrap()).unwrap();
    e["receipt"]["stock"] = json!([{ "productId":id(300),"after":v["payload"]["document"]["stock"][0]["after"],"version":"3"}]);
    let mut bad = e.clone();
    bad["receipt"]["stock"][0]["after"] = json!("6");
    assert!(sales_sync::receive_event(&mut b, &ctx(), &bad).is_err());
    assert_eq!(inventory_product(&b)["stock"], "4");
    for c in [&mut a, &mut b] {
        sales_sync::receive_event(c, &ctx(), &e).unwrap();
        sales_sync::receive_event(c, &ctx(), &e).unwrap();
        assert_eq!(inventory_product(c)["stock"], "5");
        assert_eq!(
            c.query_row::<i64, _, _>(
                "SELECT count(*) FROM native_management_records_v1 WHERE kind='SALE_RETURN'",
                [],
                |r| r.get(0)
            )
            .unwrap(),
            1
        );
    }
}
#[test]
fn encrypted_return_reopen_recovers_same_attempt_after_rollback() {
    use ventard_core::storage::{cipher::CipherKey, writer::VaultWriter};
    let root = std::env::temp_dir();
    let path = root.join(format!("ventard-return-fixture-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&path).unwrap();
    let key = CipherKey::new([0x64; 32]);
    let request;
    {
        let mut vault = VaultWriter::create_encrypted(&path, &key).unwrap();
        let c = vault.connection();
        c.execute(
            "INSERT INTO scopes VALUES(?1,'BRANCH',?2,?3)",
            (sales_key(), id(5), id(1)),
        )
        .unwrap();
        c.execute(
            "INSERT INTO native_sales_cursor_v1 VALUES(?1,?2,'NATIVE1',0)",
            (id(1), sales_key()),
        )
        .unwrap();
        return_fixture(c);
        request = refund(c, 991, "3");
        c.execute_batch("CREATE TRIGGER fail_refund BEFORE INSERT ON sale_cash_entries_v1 BEGIN SELECT RAISE(ABORT,'QA return');END;").unwrap();
        assert!(run(c, request.clone()).is_err());
    }
    {
        let mut vault = VaultWriter::open_encrypted(&path, &key).unwrap();
        let c = vault.connection();
        assert_eq!(inventory_product(c)["stock"], "4");
        assert!(management::read(c, &ctx()).unwrap()["pending"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["operationId"] == id(991)));
        c.execute_batch("DROP TRIGGER fail_refund;").unwrap();
        run(c, request.clone()).unwrap();
    }
    {
        let mut vault = VaultWriter::open_encrypted(&path, &key).unwrap();
        let c = vault.connection();
        run(c, request).unwrap();
        assert_eq!(inventory_product(c)["stock"], "7");
        assert_eq!(
            ventard_core::application::returns::read(c, &ctx(), &id(990)).unwrap()
                ["remainingCents"],
            "0"
        );
        assert_eq!(
            c.query_row::<i64, _, _>(
                "SELECT count(*) FROM sale_cash_entries_v1 WHERE operation_id=?1",
                [id(991)],
                |r| r.get(0)
            )
            .unwrap(),
            1
        );
    }
    assert!(path.starts_with(root));
    std::fs::remove_dir_all(path).unwrap();
}
#[test]
fn return_transaction_replay_rollback_and_remaining_are_exact() {
    let mut c = db();
    return_fixture(&mut c);
    let req = refund(&c, 991, "1");
    ventard_core::application::returns::document(&c, &ctx(), &req).unwrap();
    c.execute_batch("CREATE TRIGGER fail_return BEFORE INSERT ON sale_cash_entries_v1 BEGIN SELECT RAISE(ABORT,'QA refund');END;").unwrap();
    assert!(run(&mut c, req.clone()).is_err());
    assert_eq!(inventory_product(&c)["stock"], "4");
    assert_eq!(
        ventard_core::application::returns::read(&c, &ctx(), &id(990)).unwrap()["remainingCents"],
        "100"
    );
    c.execute_batch("DROP TRIGGER fail_return;").unwrap();
    let r = run(&mut c, req.clone()).unwrap();
    assert_eq!(run(&mut c, req).unwrap(), r);
    assert_eq!(r["document"]["refund"]["amountCents"], "33");
    assert_eq!(inventory_product(&c)["stock"], "5");
    let q = refund(&c, 992, "2");
    let r = run(&mut c, q).unwrap();
    assert_eq!(r["document"]["refund"]["amountCents"], "67");
    assert_eq!(inventory_product(&c)["stock"], "7");
    let invalid = refund(&c, 993, "1");
    assert!(run(&mut c, invalid).is_err());
}
fn inventory_change(op: u32, rev: &str, mode: &str, quantity: &str) -> management::Command {
    serde_json::from_value(json!({"kind":"INVENTORY_CHANGE","operationId":id(op),"productId":id(300),"expectedStockRevision":rev,"mode":mode,"quantity":quantity,"reason":"Conteo QA","serials":[]})).unwrap()
}
fn inventory_product(c: &Connection) -> serde_json::Value {
    ventard_core::application::sales_sync::read(c, &ctx()).unwrap()["products"][0].clone()
}
#[test]
fn inventory_metadata_and_stock_have_separate_versions_and_exact_replay() {
    let mut c = db();
    let created = run(&mut c, inventory_save(301, "0")).unwrap();
    assert_eq!(run(&mut c, inventory_save(301, "0")).unwrap(), created);
    assert_eq!(inventory_product(&c)["stock"], "0");
    assert_eq!(inventory_product(&c)["costCents"], "6000");
    let stock_rev = inventory_product(&c)["stockRevision"]
        .as_str()
        .unwrap()
        .to_owned();
    run(&mut c, inventory_change(302, &stock_rev, "IN", "7")).unwrap();
    assert_eq!(inventory_product(&c)["stock"], "7");
    assert_eq!(inventory_product(&c)["revision"], "1");
    let stock_rev = inventory_product(&c)["stockRevision"]
        .as_str()
        .unwrap()
        .to_owned();
    run(&mut c, inventory_save(303, "1")).unwrap();
    assert_eq!(inventory_product(&c)["stockRevision"], stock_rev);
    assert!(run(&mut c, inventory_save(304, "1")).is_err());
    run(&mut c, inventory_change(305, &stock_rev, "COUNT", "4")).unwrap();
    assert_eq!(inventory_product(&c)["stock"], "4");
    assert!(run(&mut c, inventory_change(306, &stock_rev, "COUNT", "8")).is_err());
    let stock_rev = inventory_product(&c)["stockRevision"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(run(&mut c, inventory_change(307, &stock_rev, "LOSS", "5")).is_err());
    assert_eq!(inventory_product(&c)["stock"], "4");
}
#[test]
fn inventory_atomic_rollback_keeps_same_prepared_intent_recoverable() {
    let mut c = db();
    run(&mut c, inventory_save(301, "0")).unwrap();
    let rev = inventory_product(&c)["stockRevision"]
        .as_str()
        .unwrap()
        .to_owned();
    c.execute_batch("CREATE TRIGGER fail_inventory BEFORE INSERT ON inventory_movements BEGIN SELECT RAISE(ABORT,'QA fail');END;").unwrap();
    assert!(run(&mut c, inventory_change(302, &rev, "IN", "8")).is_err());
    assert_eq!(inventory_product(&c)["stock"], "0");
    c.execute_batch("DROP TRIGGER fail_inventory;").unwrap();
    run(&mut c, inventory_change(302, &rev, "IN", "8")).unwrap();
    assert_eq!(inventory_product(&c)["stock"], "8");
}
fn inventory_event(c: &Connection, op: u32, seq: u32) -> serde_json::Value {
    let mut e = event(c, op, seq);
    let v: serde_json::Value = serde_json::from_str(e["intent"].as_str().unwrap()).unwrap();
    let d = &v["payload"]["document"];
    if v["kind"] == "PRODUCT_CREATE" {
        e["receipt"]["stock"] =
            json!([{"productId":d["product"]["id"],"after":"0","version":seq.to_string()}]);
    } else if v["kind"].as_str().unwrap().starts_with("INVENTORY_") {
        e["receipt"]["stock"] =
            json!([{"productId":d["productId"],"after":d["after"],"version":seq.to_string()}]);
    }
    e
}
#[test]
fn inventory_receipts_import_once_and_keep_later_pending_units() {
    use ventard_core::application::sales_sync;
    let mut a = db();
    let mut b = db();
    run(&mut a, inventory_save(301, "0")).unwrap();
    let created = inventory_event(&a, 301, 1);
    let rev = inventory_product(&a)["stockRevision"]
        .as_str()
        .unwrap()
        .to_owned();
    run(&mut a, inventory_change(302, &rev, "IN", "7")).unwrap();
    let moved = inventory_event(&a, 302, 2);
    let mut bad = moved.clone();
    bad["receipt"]["stock"][0]["after"] = json!("8");
    assert!(sales_sync::receive_event(&mut a, &ctx(), &bad).is_err());
    sales_sync::receive_event(&mut a, &ctx(), &created).unwrap();
    assert_eq!(inventory_product(&a)["stock"], "7");
    for c in [&mut a, &mut b] {
        sales_sync::receive_event(c, &ctx(), &created).unwrap();
        sales_sync::receive_event(c, &ctx(), &moved).unwrap();
        sales_sync::receive_event(c, &ctx(), &moved).unwrap();
        assert_eq!(inventory_product(c)["stock"], "7");
    }
    assert_eq!(inventory_product(&a), inventory_product(&b));
    let mut other = db();
    sales_sync::receive_event(&mut other, &ctx(), &created).unwrap();
    let mut forged = moved.clone();
    let mut intent: serde_json::Value =
        serde_json::from_str(forged["intent"].as_str().unwrap()).unwrap();
    intent["payload"]["request"]["quantity"] = json!("2");
    let (canonical, hash) =
        ventard_core::domain::canonical::canonicalize(&serde_json::to_vec(&intent).unwrap())
            .unwrap();
    forged["intent"] = json!(canonical);
    forged["receipt"]["intentHash"] = json!(hash);
    assert!(sales_sync::receive_event(&mut other, &ctx(), &forged).is_err());
    assert_eq!(inventory_product(&other)["stock"], "0");
}
#[test]
fn inventory_recipe_cost_and_serial_entries_are_exact_and_rollback_on_invalid_input() {
    let mut c = db();
    run(&mut c, inventory_save(301, "0")).unwrap();
    let mut req = serde_json::to_value(inventory_save(310, "0")).unwrap();
    req["productId"] = json!(id(311));
    req["definition"]["code"] = json!("COMBO");
    req["definition"]["productType"] = json!("combo");
    req["definition"]["costCents"] = json!("840");
    req["definition"]["recipe"] = json!([{"productId":id(300),"numerator":"7","denominator":"50"}]);
    run(&mut c, serde_json::from_value(req.clone()).unwrap()).unwrap();
    req["operationId"] = json!(id(312));
    req["productId"] = json!(id(313));
    req["definition"]["code"] = json!("BAD");
    req["definition"]["costCents"] = json!("841");
    assert!(run(&mut c, serde_json::from_value(req).unwrap()).is_err());
    let mut serial = serde_json::to_value(inventory_save(320, "0")).unwrap();
    serial["productId"] = json!(id(321));
    serial["definition"]["code"] = json!("SERIAL");
    serial["definition"]["serialRequired"] = json!(true);
    run(&mut c, serde_json::from_value(serial).unwrap()).unwrap();
    let p = ventard_core::application::sales_sync::read(&c, &ctx()).unwrap()["products"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["id"] == id(321))
        .unwrap()
        .clone();
    let mut add = serde_json::to_value(inventory_change(
        322,
        p["stockRevision"].as_str().unwrap(),
        "IN",
        "2",
    ))
    .unwrap();
    add["productId"] = json!(id(321));
    add["serials"] = json!(["IMEI-1", "IMEI-1"]);
    assert!(run(&mut c, serde_json::from_value(add.clone()).unwrap()).is_err());
    add["serials"] = json!(["IMEI-1", "IMEI-2"]);
    run(&mut c, serde_json::from_value(add.clone()).unwrap()).unwrap();
    assert_eq!(
        run(&mut c, serde_json::from_value(add).unwrap()).unwrap()["document"]["after"],
        "2"
    );
}
#[test]
fn inventory_history_permissions_and_prepared_abandon_are_scoped() {
    use ventard_core::application::inventory;
    let mut c = db();
    assert!(management::execute(
        &mut c,
        &grant(2, 5, false),
        2000,
        2000,
        1,
        inventory_save(301, "0")
    )
    .is_err());
    assert_eq!(c_record_count(&c), 0);
    run(&mut c, inventory_save(301, "0")).unwrap();
    let rev = inventory_product(&c)["stockRevision"]
        .as_str()
        .unwrap()
        .to_owned();
    c.execute_batch("CREATE TRIGGER fail_inventory BEFORE INSERT ON inventory_movements BEGIN SELECT RAISE(ABORT,'QA fail');END;").unwrap();
    assert!(run(&mut c, inventory_change(302, &rev, "IN", "8")).is_err());
    assert!(management::abandon(&mut c, &grant(99, 5, true), 2000, 2000, 1, &id(302)).is_err());
    management::abandon(&mut c, &grant(2, 5, true), 2000, 2000, 1, &id(302)).unwrap();
    assert!(run(&mut c, inventory_change(302, &rev, "IN", "8")).is_err());
    assert!(management::abandon(&mut c, &grant(2, 5, true), 2000, 2000, 1, &id(301)).is_err());
    c.execute_batch("DROP TRIGGER fail_inventory;").unwrap();
    run(&mut c, inventory_change(303, &rev, "IN", "8")).unwrap();
    let history = inventory::history(&c, &ctx(), &id(300), 1).unwrap();
    assert_eq!(history["total"], "1");
    assert_eq!(history["rows"][0]["delta"], "8");
    let mut wrong = ctx();
    wrong.tenant_id = id(99);
    assert!(inventory::history(&c, &wrong, &id(300), 1).is_err());
}
#[test]
fn encrypted_inventory_reopen_recovers_prepared_movement_without_duplicates() {
    use ventard_core::storage::{cipher::CipherKey, writer::VaultWriter};
    let path = std::env::temp_dir().join(format!(
        "ventard-inventory-fixture-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir(&path).unwrap();
    let key = CipherKey::new([0x63; 32]);
    let rev;
    {
        let mut vault = VaultWriter::create_encrypted(&path, &key).unwrap();
        let c = vault.connection();
        let sk = format!("{}/BRANCH:{}", id(1), id(5));
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
        run(c, inventory_save(301, "0")).unwrap();
        rev = inventory_product(c)["stockRevision"]
            .as_str()
            .unwrap()
            .to_owned();
        c.execute_batch("CREATE TRIGGER fail_inventory BEFORE INSERT ON inventory_movements BEGIN SELECT RAISE(ABORT,'QA fail');END;").unwrap();
        assert!(run(c, inventory_change(302, &rev, "IN", "8")).is_err());
    }
    {
        let mut vault = VaultWriter::open_encrypted(&path, &key).unwrap();
        let c = vault.connection();
        assert_eq!(inventory_product(c)["stock"], "0");
        assert_eq!(
            management::read(c, &ctx()).unwrap()["pending"][0]["operationId"],
            id(302)
        );
        c.execute_batch("DROP TRIGGER fail_inventory;").unwrap();
        run(c, inventory_change(302, &rev, "IN", "8")).unwrap();
    }
    {
        let mut vault = VaultWriter::open_encrypted(&path, &key).unwrap();
        let c = vault.connection();
        run(c, inventory_change(302, &rev, "IN", "8")).unwrap();
        assert_eq!(inventory_product(c)["stock"], "8");
        assert_eq!(
            ventard_core::application::inventory::history(c, &ctx(), &id(300), 1).unwrap()["total"],
            "1"
        );
    }
    std::fs::remove_dir_all(&path).unwrap();
}
#[test]
fn cut_printing_uses_original_counts_and_never_repeats_drawer_effects() {
    use ventard_core::application::printing;
    let mut c = db();
    turn(&mut c);
    run(
        &mut c,
        management::Command::CutX {
            operation_id: id(900),
            turn_id: id(90),
            counted_cents: "50000".into(),
            denominations: vec![],
            notes: Some("Conteo original".into()),
        },
    )
    .unwrap();
    let changes = c.total_changes();
    let t = printing::cut_ticket(&c, &ctx(), &id(900)).unwrap();
    assert_eq!(c.total_changes(), changes);
    assert_eq!(t["document"]["countedCents"], "50000");
    let hash = t["printSnapshotHash"].as_str().unwrap();
    assert!(printing::request_cut(&mut c, &ctx(), &id(900), hash, &id(901)).unwrap());
    assert!(!printing::request_cut(&mut c, &ctx(), &id(900), hash, &id(901)).unwrap());
    assert!(printing::request_cut(&mut c, &ctx(), &id(900), &"0".repeat(64), &id(902)).is_err());
    assert_eq!(c_record_count(&c), 1);
    assert_eq!(
        management::read(&c, &ctx()).unwrap()["turn"]["expectedCents"],
        "50000"
    );
    let mut wrong = ctx();
    wrong.tenant_id = id(99);
    assert!(printing::cut_ticket(&c, &wrong, &id(900)).is_err());
    printing::failed_cut(&c, &ctx(), &id(900), &id(901)).unwrap();
    assert_eq!(
        printing::cut_status(&c, &ctx(), &id(900), &id(901)).unwrap(),
        "FAILED"
    );
}
#[test]
fn remote_cut_is_frozen_before_later_pending_cash_and_close_preserves_conflicts() {
    use ventard_core::application::{printing, sales_sync};
    for close in [false, true] {
        let mut a = db();
        let mut b = db();
        turn(&mut a);
        turn(&mut b);
        let req = if close {
            management::Command::TurnClose {
                operation_id: id(920),
                turn_id: id(90),
                counted_cents: "50000".into(),
                denominations: vec![],
                notes: None,
            }
        } else {
            management::Command::CutX {
                operation_id: id(920),
                turn_id: id(90),
                counted_cents: "50000".into(),
                denominations: vec![],
                notes: None,
            }
        };
        run(&mut a, req).unwrap();
        run(
            &mut b,
            management::Command::CashEntry {
                operation_id: id(921),
                amount_cents: "5000".into(),
                direction: "IN".into(),
                concept: "Entrada posterior offline".into(),
                turn_id: id(90),
            },
        )
        .unwrap();
        sales_sync::receive_event(&mut b, &ctx(), &event(&a, 920, 1)).unwrap();
        let source = printing::cut_ticket(&a, &ctx(), &id(920)).unwrap();
        let imported = printing::cut_ticket(&b, &ctx(), &id(920)).unwrap();
        assert_eq!(source["printSnapshotHash"], imported["printSnapshotHash"]);
        assert_eq!(imported["document"]["drawer"]["expectedCents"], "50000");
        let state: String = b
            .query_row(
                "SELECT state FROM outbox WHERE operation_id=?1",
                [id(921)],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(state, if close { "INTERVENTION" } else { "PENDING" });
        assert_eq!(
            b.query_row::<i64, _, _>(
                "SELECT amount_cents FROM sale_cash_entries_v1 WHERE operation_id=?1",
                [id(921)],
                |r| r.get(0)
            )
            .unwrap(),
            5000
        );
        if close {
            assert!(management::read(&b, &ctx()).unwrap()["turn"].is_null());
        } else {
            assert_eq!(
                management::read(&b, &ctx()).unwrap()["turn"]["expectedCents"],
                "55000"
            );
        }
    }
}
use ventard_core::{
    application::management,
    storage::{catalogue_preview::CatalogueContext, migrations},
};
fn id(n: u32) -> String {
    format!("96000000-0000-4000-8000-{n:012}")
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
    let sk = format!("{}/BRANCH:{}", id(1), id(5));
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
    c
}
#[test]
fn module_reads_are_scoped_and_do_not_change_database() {
    let c = db();
    let changes = c.total_changes();
    let v = management::read(&c, &ctx()).unwrap();
    assert_eq!(v["customers"], json!([]));
    assert_eq!(v["movements"], json!([]));
    assert_eq!(c.total_changes(), changes);
    let mut other = ctx();
    other.tenant_id = id(99);
    assert!(management::read(&c, &other).is_err());
}
#[test]
fn customer_with_debt_cannot_be_deleted() {
    let mut c = db();
    run(&mut c, save(20, "0")).unwrap();
    c.execute(
        "UPDATE sale_customer_accounts_v1 SET balance_cents=12345",
        [],
    )
    .unwrap();
    assert_eq!(
        run(
            &mut c,
            management::Command::CustomerDelete {
                operation_id: id(21),
                customer_id: id(30),
                expected_revision: "1".into()
            }
        )
        .unwrap_err()
        .code(),
        "CREDIT_BALANCE_PENDING"
    );
    assert_eq!(
        management::read(&c, &ctx()).unwrap()["customers"][0]["active"],
        true
    );
}
fn save(op: u32, rev: &str) -> management::Command {
    management::Command::CustomerSave {
        operation_id: id(op),
        customer_id: id(30),
        expected_revision: rev.into(),
        name: "María Pérez".into(),
        phone: Some("8095550100".into()),
        limit_cents: "50000".into(),
        price_tier: 2,
        wholesale: true,
    }
}
fn run(
    c: &mut Connection,
    req: management::Command,
) -> Result<serde_json::Value, ventard_core::application::errors::AppError> {
    management::execute(c, &grant(2, 5, true), 2000, 2000, 1, req)
}
fn turn(c: &mut Connection) {
    ventard_core::application::cash::open_turn(
        c,
        &grant(2, 5, true),
        2000,
        2000,
        1,
        ventard_core::application::cash::TurnOpen {
            operation_id: id(90),
            opening_cents: "50000".into(),
            expected_drawer_revision: "0".into(),
        },
    )
    .unwrap();
    c.execute("UPDATE outbox SET state='APPLIED'", []).unwrap();
}
#[test]
fn customer_crud_tombstones_replay_and_versions_preserve_debt() {
    let mut c = db();
    let first = run(&mut c, save(20, "0")).unwrap();
    for _ in 0..100 {
        assert_eq!(run(&mut c, save(20, "0")).unwrap(), first)
    }
    assert!(run(&mut c, save(21, "0")).is_err());
    c.execute(
        "UPDATE sale_customer_accounts_v1 SET balance_cents=12345,revision=4",
        [],
    )
    .unwrap();
    run(&mut c, save(22, "1")).unwrap();
    let v = management::read(&c, &ctx()).unwrap();
    assert_eq!(v["customers"][0]["revision"], "2");
    assert_eq!(v["customers"][0]["balanceRevision"], "4");
    assert_eq!(v["customers"][0]["balanceCents"], "12345");
    c.execute("UPDATE sale_customer_accounts_v1 SET balance_cents=0", [])
        .unwrap();
    run(
        &mut c,
        management::Command::CustomerDelete {
            operation_id: id(23),
            customer_id: id(30),
            expected_revision: "2".into(),
        },
    )
    .unwrap();
    let v = management::read(&c, &ctx()).unwrap();
    assert_eq!(v["customers"][0]["active"], false);
    assert_eq!(v["customers"][0]["balanceCents"], "0");
    assert_eq!(
        c.query_row::<i64, _, _>(
            "SELECT count(*) FROM native_management_records_v1",
            [],
            |r| r.get(0)
        )
        .unwrap(),
        3
    );
}
#[test]
fn failure_rolls_back_metadata_result_and_outbox_then_same_id_recovers() {
    let mut c = db();
    c.execute_batch("CREATE TEMP TRIGGER fault BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT,'fixture'); END").unwrap();
    assert!(run(&mut c, save(20, "0")).is_err());
    assert_eq!(
        management::read(&c, &ctx()).unwrap()["customers"],
        json!([])
    );
    assert_eq!(
        management::read(&c, &ctx()).unwrap()["pending"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    c.execute_batch("DROP TRIGGER fault").unwrap();
    run(&mut c, save(20, "0")).unwrap();
    assert_eq!(management::read(&c, &ctx()).unwrap()["pending"], json!([]));
}
#[test]
fn authority_invalid_amount_and_identity_never_write() {
    let mut c = db();
    assert!(
        management::execute(&mut c, &grant(2, 5, false), 2000, 2000, 1, save(20, "0")).is_err()
    );
    assert!(
        management::execute(&mut c, &grant(2, 5, true), 2000, 2000, 301, save(20, "0")).is_err()
    );
    for value in ["-1", "01", "1.5", "9007199254740992"] {
        let mut v = serde_json::to_value(save(20, "0")).unwrap();
        v["limitCents"] = json!(value);
        assert!(run(&mut c, serde_json::from_value(v).unwrap()).is_err())
    }
    run(&mut c, save(20, "0")).unwrap();
    let mut other = serde_json::to_value(save(20, "0")).unwrap();
    other["name"] = json!("Otro");
    assert_eq!(
        run(&mut c, serde_json::from_value(other).unwrap())
            .unwrap_err()
            .code(),
        "OPERATION_ID_CONFLICT"
    );
    assert_eq!(
        c.query_row::<i64, _, _>("SELECT count(*) FROM sale_customer_accounts_v1", [], |r| r
            .get(0))
            .unwrap(),
        1
    );
}
fn pay(op: u32, method: &str, n: &str) -> management::Command {
    management::Command::CreditPayment {
        operation_id: id(op),
        customer_id: id(30),
        expected_revision: "1".into(),
        amount_cents: n.into(),
        method: method.into(),
        concept: "Abono".into(),
        turn_id: id(90),
    }
}
#[test]
fn abonos_use_original_turn_exact_cents_no_overpay_and_bank_never_adds_cash() {
    for method in ["EFECTIVO", "TARJETA", "TRANSFERENCIA"] {
        let mut c = db();
        turn(&mut c);
        run(&mut c, save(20, "0")).unwrap();
        c.execute(
            "UPDATE sale_customer_accounts_v1 SET balance_cents=12345",
            [],
        )
        .unwrap();
        assert_eq!(
            run(&mut c, pay(21, method, "12346")).unwrap_err().code(),
            "CREDIT_OVERPAY"
        );
        let first = run(&mut c, pay(22, method, "2345")).unwrap();
        assert_eq!(run(&mut c, pay(22, method, "2345")).unwrap(), first);
        let v = management::read(&c, &ctx()).unwrap();
        assert_eq!(v["customers"][0]["balanceCents"], "10000");
        assert_eq!(v["customers"][0]["balanceRevision"], "2");
        assert_eq!(
            v["turn"]["expectedCents"],
            if method == "EFECTIVO" {
                "52345"
            } else {
                "50000"
            }
        );
        assert!(run(&mut c, pay(23, method, "1000")).is_err());
    }
}
#[test]
fn expenses_entries_cut_and_close_preserve_cash_and_block_pending() {
    let mut c = db();
    turn(&mut c);
    let r = run(
        &mut c,
        management::Command::ExpenseRecord {
            category: None,
            operation_id: id(31),
            amount_cents: "1234".into(),
            method: "EFECTIVO".into(),
            concept: "Transporte".into(),
            turn_id: id(90),
        },
    )
    .unwrap();
    assert_eq!(r["document"]["cashDeltaCents"], "-1234");
    run(
        &mut c,
        management::Command::ExpenseRecord {
            category: None,
            operation_id: id(32),
            amount_cents: "999".into(),
            method: "TARJETA".into(),
            concept: "Materiales".into(),
            turn_id: id(90),
        },
    )
    .unwrap();
    run(
        &mut c,
        management::Command::CashEntry {
            operation_id: id(33),
            amount_cents: "234".into(),
            direction: "IN".into(),
            concept: "Entrada".into(),
            turn_id: id(90),
        },
    )
    .unwrap();
    assert_eq!(
        management::read(&c, &ctx()).unwrap()["turn"]["expectedCents"],
        "49000"
    );
    let close = management::Command::TurnClose {
        operation_id: id(35),
        turn_id: id(90),
        counted_cents: "50000".into(),
        notes: Some("Cuadre".into()),
        denominations: vec![management::Denomination {
            value_cents: "10000".into(),
            count: "5".into(),
        }],
    };
    assert_eq!(
        run(&mut c, close.clone()).unwrap_err().code(),
        "CASH_PENDING"
    );
    c.execute("UPDATE outbox SET state='APPLIED'", []).unwrap();
    let result = run(&mut c, close.clone()).unwrap();
    assert_eq!(result["document"]["differenceCents"], "1000");
    assert_eq!(
        management::read(&c, &ctx()).unwrap()["turn"]["status"],
        "CLOSING"
    );
    assert_eq!(run(&mut c, close).unwrap(), result);
    assert!(run(
        &mut c,
        management::Command::ExpenseRecord {
            category: None,
            operation_id: id(36),
            amount_cents: "1".into(),
            method: "EFECTIVO".into(),
            concept: "Gasto".into(),
            turn_id: id(90)
        }
    )
    .is_err());
}
fn event(c: &Connection, op: u32, seq: u32) -> serde_json::Value {
    let b: Vec<u8> = c
        .query_row(
            "SELECT canonical_bytes FROM operation_journal WHERE operation_id=?1",
            [id(op)],
            |r| r.get(0),
        )
        .unwrap();
    let v: serde_json::Value = serde_json::from_slice(&b).unwrap();
    let (_, hash) = canonicalize(&b).unwrap();
    json!({"intent":String::from_utf8(b).unwrap(),"snapshot":null,"receipt":{"protocol":"ventard.native.receipt.1","status":"APPLIED","namespace":"NATIVE1","operationId":id(op),"tenantId":id(1),"scope":{"type":"BRANCH","branchId":id(5)},"actorId":id(2),"installationId":id(4),"deviceId":id(3),"writerEpoch":"1","intentHash":hash,"snapshotHash":null,"remoteSequence":seq.to_string(),"appliedAtMs":"2000","ticket":null,"ncf":null,"totalCents":null,"stock":[],"effects":management::effects(&v).unwrap()}})
}
#[test]
fn exact_receipt_roundtrip_imports_customer_once_without_repeating_own_effects() {
    use ventard_core::application::sales_sync;
    let mut a = db();
    run(&mut a, save(20, "0")).unwrap();
    let e = event(&a, 20, 1);
    let mut bad = e.clone();
    bad["receipt"]["effects"] = json!([]);
    assert!(sales_sync::receive_event(&mut a, &ctx(), &bad).is_err());
    let mut b = db();
    sales_sync::receive_event(&mut b, &ctx(), &e).unwrap();
    sales_sync::receive_event(&mut b, &ctx(), &e).unwrap();
    sales_sync::receive_event(&mut a, &ctx(), &e).unwrap();
    assert_eq!(
        management::read(&a, &ctx()).unwrap()["customers"],
        management::read(&b, &ctx()).unwrap()["customers"]
    );
    assert_eq!(
        management::read(&a, &ctx()).unwrap()["movements"][0]["remoteStatus"],
        "APPLIED"
    );
    assert_eq!(c_record_count(&b), 1);
}
fn c_record_count(c: &Connection) -> i64 {
    c.query_row(
        "SELECT count(*) FROM native_management_records_v1",
        [],
        |r| r.get(0),
    )
    .unwrap()
}
#[test]
fn cash_base_plus_pending_overlay_never_counts_acknowledged_money_twice() {
    use ventard_core::application::sales_sync;
    let mut c = db();
    turn(&mut c);
    let context = ctx();
    run(
        &mut c,
        management::Command::ExpenseRecord {
            operation_id: id(31),
            amount_cents: "1000".into(),
            method: "EFECTIVO".into(),
            concept: "Transporte".into(),
            turn_id: id(90),
            category: Some("transporte".into()),
        },
    )
    .unwrap();
    let page = |seq: &str, net: &str| json!({"namespace":"NATIVE1","tenantId":id(1),"scope":{"type":"BRANCH","branchId":id(5)},"coverage":"COMPLETE","scannedThrough":seq,"watermark":seq,"events":[],"cashBase":{"tenantId":id(1),"scope":{"type":"BRANCH","branchId":id(5)},"turnId":id(90),"sequence":seq,"netCents":net}});
    sales_sync::receive_feed(&mut c, &context, &page("1", "5000")).unwrap();
    assert_eq!(
        management::read(&c, &context).unwrap()["turn"]["expectedCents"],
        "54000"
    );
    let receipt_event = event(&c, 31, 2);
    sales_sync::receive_event(&mut c, &context, &receipt_event).unwrap();
    sales_sync::receive_feed(&mut c, &context, &page("2", "4000")).unwrap();
    assert_eq!(
        management::read(&c, &context).unwrap()["turn"]["expectedCents"],
        "54000"
    );
    let mut bad = page("3", "4000");
    bad["cashBase"]["scope"]["branchId"] = json!(id(99));
    assert!(sales_sync::receive_feed(&mut c, &context, &bad).is_err());
    assert_eq!(
        c.query_row::<i64, _, _>("SELECT sequence FROM native_sales_cursor_v1", [], |r| r
            .get(0))
            .unwrap(),
        2
    );
}
#[test]
fn opening_denominations_are_durable_exact_and_not_rewritten_on_recovery() {
    use ventard_core::application::sales_sync;
    let mut c = db();
    let g = grant(2, 5, true);
    let denominations = vec![management::Denomination {
        value_cents: "10000".into(),
        count: "5".into(),
    }];
    let first = sales_sync::request_shared_turn_with_count(
        &mut c,
        &g,
        2000,
        2000,
        1,
        &id(90),
        "50000",
        Some(&denominations),
    )
    .unwrap();
    assert_eq!(
        sales_sync::request_shared_turn_with_count(
            &mut c,
            &g,
            3000,
            3000,
            2,
            &id(90),
            "50000",
            Some(&denominations)
        )
        .unwrap(),
        first
    );
    assert_eq!(
        sales_sync::pending_shared_turn(&c, &ctx())
            .unwrap()
            .unwrap()["denominations"],
        json!([{"valueCents":"10000","count":"5"}])
    );
    assert!(sales_sync::request_shared_turn_with_count(
        &mut c,
        &g,
        2000,
        2000,
        1,
        &id(90),
        "50000",
        None
    )
    .is_err());
    assert_eq!(
        c.query_row::<i64, _, _>("SELECT count(*) FROM cash_turns", [], |r| r.get(0))
            .unwrap(),
        0
    );
}
#[test]
fn report_is_readonly_scoped_halfopen_and_splits_abonos_from_revenue() {
    let mut c = db();
    turn(&mut c);
    run(
        &mut c,
        management::Command::ExpenseRecord {
            category: None,
            operation_id: id(31),
            amount_cents: "1234".into(),
            method: "EFECTIVO".into(),
            concept: "Transporte".into(),
            turn_id: id(90),
        },
    )
    .unwrap();
    let before = c.total_changes();
    let r = management::report(&c, &ctx(), "2000", "2001").unwrap();
    assert_eq!(r["expenseCents"], "1234");
    assert_eq!(r["totalCents"], "0");
    assert_eq!(r["profitCents"], "-1234");
    assert_eq!(
        management::report(&c, &ctx(), "2001", "3000").unwrap()["expenseCents"],
        "0"
    );
    assert_eq!(c.total_changes(), before);
}
use ed25519_dalek::{Signer, SigningKey};
use ventard_core::{domain::canonical::canonicalize, security::offline_grant::*};
fn grant(actor: u32, branch: u32, sell: bool) -> VerifiedGrant {
    grant_tier(actor, branch, sell, None)
}
fn grant_tier(actor: u32, branch: u32, sell: bool, tier: Option<&str>) -> VerifiedGrant {
    let key = SigningKey::from_bytes(&[0x29; 32]); // Synthetic public fixture, never client trust.
    let mut p = json!({"protocol":"ventard.offline-grant.v1","keyId":"cash-fixture-1","issuer":"ventard.staging","audience":"ventard.native.staging.v1","grantId":id(10),"grantSequence":"1","policyVersion":"1","tenantId":id(1),"actorId":id(actor),"deviceId":id(3),"installationId":id(4),"writerEpoch":"1","scope":{"type":"BRANCH","branchId":id(branch)},"role":if sell {"owner"}else{"seller"},"capabilities":if sell {vec!["READ","SELL","INVENTORY_WRITE","MANAGE"]}else{vec!["READ"]},"issuedAtMs":"1000","actorExpiresAtMs":null,"license":{"planActive":true,"accessUntilMs":null,"trialUntilMs":null,"graceDays":"5","warnAfterOpenings":"200","blockAfterOpenings":"300"}});
    if let Some(tier) = tier {
        p["license"]["planTier"] = json!(tier);
    }
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
#[test]
fn layaway_reserves_items_and_serials_once_then_delivery_collects_only_the_balance() {
    use ventard_core::application::layaways;
    let mut c = db();
    repair_fixture(&mut c);
    let req:management::Command=serde_json::from_value(json!({"kind":"LAYAWAY_CREATE","operationId":id(851),"layawayId":id(850),"definition":{"customerId":null,"customerName":"Ana QA","phone":"8095550100","notes":"Conservar contrato","items":[{"productId":id(300),"name":"Artículo QA","quantity":"2","priceCents":"123","serial":null}]},"initialPaymentCents":"100","method":"EFECTIVO","turnId":id(90)})).unwrap();
    let created = run_pro(&mut c, req.clone()).unwrap();
    assert_eq!(inventory_product(&c)["stock"], "2");
    for _ in 0..5 {
        assert_eq!(run_pro(&mut c, req.clone()).unwrap(), created);
    }
    let command = |op, rev, action, amount, method| {
        serde_json::from_value(json!({"kind":"LAYAWAY_ACTION","operationId":id(op),"layawayId":id(850),"expectedRevision":rev,"action":action,"amountCents":amount,"method":method,"turnId":id(90),"warrantyDays":if action=="COMPLETE"{"30"}else{"0"}})).unwrap()
    };
    assert_eq!(
        run_pro(&mut c, command(852, "1", "PAYMENT", "147", "TARJETA"))
            .unwrap_err()
            .code(),
        "SERVICE_OVERPAY"
    );
    run_pro(&mut c, command(853, "1", "PAYMENT", "50", "TARJETA")).unwrap();
    assert_eq!(
        management::drawer(&c, &ctx(), &id(90)).unwrap()["expectedCents"],
        "50100"
    );
    let delivered = run_pro(&mut c, command(854, "2", "COMPLETE", "0", "EFECTIVO")).unwrap();
    assert_eq!(delivered["document"]["layaway"]["paidCents"], "246");
    assert_eq!(inventory_product(&c)["stock"], "2");
    assert_eq!(
        management::drawer(&c, &ctx(), &id(90)).unwrap()["expectedCents"],
        "50196"
    );
    let changes = c.total_changes();
    assert_eq!(
        layaways::read(&c, &ctx()).unwrap()["rows"][0]["state"],
        "completado"
    );
    assert_eq!(c.total_changes(), changes);
}
#[test]
fn layaway_failure_rolls_back_stock_money_and_new_customer_and_cancel_preserves_deposits() {
    use ventard_core::application::layaways;
    let mut c = db();
    repair_fixture(&mut c);
    let req:management::Command=serde_json::from_value(json!({"kind":"LAYAWAY_CREATE","operationId":id(861),"layawayId":id(860),"createCustomer":true,"definition":{"customerId":id(862),"customerName":"Cliente apartado","phone":"8095550100","notes":"","items":[{"productId":id(300),"name":"Artículo QA","quantity":"1","priceCents":"500","serial":null}]},"initialPaymentCents":"100","method":"EFECTIVO","turnId":id(90)})).unwrap();
    c.execute_batch("CREATE TRIGGER fail_layaway BEFORE INSERT ON native_management_records_v1 WHEN NEW.kind='LAYAWAY_CREATE' BEGIN SELECT RAISE(ABORT,'fixture layaway');END;").unwrap();
    assert!(run_pro(&mut c, req.clone()).is_err());
    assert_eq!(inventory_product(&c)["stock"], "4");
    assert!(management::read(&c, &ctx()).unwrap()["customers"]
        .as_array()
        .unwrap()
        .is_empty());
    c.execute_batch("DROP TRIGGER fail_layaway;").unwrap();
    run_pro(&mut c, req).unwrap();
    let cancel:management::Command=serde_json::from_value(json!({"kind":"LAYAWAY_ACTION","operationId":id(863),"layawayId":id(860),"expectedRevision":"1","action":"CANCEL","amountCents":"0","method":"EFECTIVO","turnId":null,"warrantyDays":"0"})).unwrap();
    run_pro(&mut c, cancel.clone()).unwrap();
    run_pro(&mut c, cancel).unwrap();
    let a = &layaways::read(&c, &ctx()).unwrap()["rows"][0];
    assert_eq!(a["state"], "cancelado");
    assert_eq!(a["paidCents"], "100");
    assert_eq!(a["settlementPendingCents"], "100");
    assert_eq!(inventory_product(&c)["stock"], "4");
    assert_eq!(
        management::drawer(&c, &ctx(), &id(90)).unwrap()["expectedCents"],
        "50100"
    );
}
#[test]
fn layaway_serial_cannot_be_sold_or_reserved_elsewhere_and_returns_on_cancel() {
    let mut c = db();
    repair_fixture(&mut c);
    let meta: String = c
        .query_row(
            "SELECT metadata FROM products WHERE producto_id=?1",
            [id(300)],
            |r| r.get(0),
        )
        .unwrap();
    let mut meta: serde_json::Value = serde_json::from_str(&meta).unwrap();
    meta["serialRequired"] = json!(true);
    c.execute(
        "UPDATE products SET metadata=?2 WHERE producto_id=?1",
        (id(300), meta.to_string()),
    )
    .unwrap();
    c.execute(
        "INSERT INTO sale_serial_inventory_v1 VALUES(?1,?2,?3,'000000001','1','AVAILABLE',NULL)",
        (
            id(1),
            ventard_core::application::sales::scope_key(&ctx()).unwrap(),
            id(300),
        ),
    )
    .unwrap();
    let req = |op, ap| {
        serde_json::from_value(json!({"kind":"LAYAWAY_CREATE","operationId":id(op),"layawayId":id(ap),"definition":{"customerId":null,"customerName":"Ana QA","phone":"","notes":"","items":[{"productId":id(300),"name":"Equipo serial QA","quantity":"1","priceCents":"500","serial":"000000001"}]},"initialPaymentCents":"0","method":"EFECTIVO","turnId":null})).unwrap()
    };
    run_pro(&mut c, req(871, 870)).unwrap();
    assert_eq!(
        c.query_row::<String, _, _>("SELECT state FROM sale_serial_inventory_v1", [], |r| r
            .get(0))
            .unwrap(),
        "RESERVED"
    );
    assert_eq!(
        run_pro(&mut c, req(873, 872)).unwrap_err().code(),
        "SERIAL_UNAVAILABLE"
    );
    let cancel=serde_json::from_value(json!({"kind":"LAYAWAY_ACTION","operationId":id(874),"layawayId":id(870),"expectedRevision":"1","action":"CANCEL","amountCents":"0","method":"EFECTIVO","turnId":null,"warrantyDays":"0"})).unwrap();
    run_pro(&mut c, cancel).unwrap();
    assert_eq!(
        c.query_row::<String, _, _>("SELECT state FROM sale_serial_inventory_v1", [], |r| r
            .get(0))
            .unwrap(),
        "AVAILABLE"
    );
    run_pro(&mut c, req(875, 876)).unwrap();
    let complete=serde_json::from_value(json!({"kind":"LAYAWAY_ACTION","operationId":id(877),"layawayId":id(876),"expectedRevision":"1","action":"COMPLETE","amountCents":"0","method":"TARJETA","turnId":null,"warrantyDays":"30"})).unwrap();
    run_pro(&mut c, complete).unwrap();
    assert_eq!(
        c.query_row::<String, _, _>("SELECT state FROM sale_serial_inventory_v1", [], |r| r
            .get(0))
            .unwrap(),
        "SOLD"
    );
    let data = ventard_core::application::layaways::read(&c, &ctx()).unwrap();
    assert!(data["rows"]
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r["id"] == id(876) && r["warrantyUntilMs"] == "2592002000"));
    assert_eq!(
        management::drawer(&c, &ctx(), &id(90)).unwrap()["expectedCents"],
        "50000"
    );
}
#[test]
#[ignore = "requires explicitly generated isolated PostgreSQL layaway captures"]
fn postgres_layaway_capture_recovers_original_payments_and_serial_reservation_without_replaying_stock(
) {
    use ventard_core::application::{layaways, sales_sync};
    for (key, serial) in [
        ("VENTARD_LAYAWAY_BOOTSTRAP_FIXTURE", false),
        ("VENTARD_LAYAWAY_SERIAL_FIXTURE", true),
    ] {
        let fixture: serde_json::Value =
            serde_json::from_slice(&std::fs::read(std::env::var(key).unwrap()).unwrap()).unwrap();
        let m = &fixture["manifest"];
        let context: CatalogueContext = serde_json::from_value(m["context"].clone()).unwrap();
        let now = m["capturedAtMs"].as_str().unwrap().parse::<u64>().unwrap();
        let mut c = Connection::open_in_memory().unwrap();
        c.pragma_update(None, "foreign_keys", true).unwrap();
        migrations::apply(&mut c).unwrap();
        sales_sync::begin_bootstrap(&mut c, &context, m, now).unwrap();
        for (i, p) in fixture["pages"].as_array().unwrap().iter().enumerate() {
            sales_sync::stage_bootstrap_page(&mut c, &context, i, p.as_str().unwrap(), now)
                .unwrap();
        }
        sales_sync::activate_bootstrap(&mut c, &context, now, &id(880)).unwrap();
        let a = &layaways::read(&c, &context).unwrap()["rows"][0];
        assert_eq!(a["paidCents"], if serial { "100" } else { "246" });
        let turn = m["turn"]["receipt"]["operationId"].as_str().unwrap();
        assert_eq!(
            management::drawer(&c, &context, turn).unwrap()["expectedCents"],
            if serial { "50100" } else { "50196" }
        );
        assert_eq!(c.query_row::<String,_,_>("SELECT effective_stock FROM stock_projections WHERE producto_id='96200000-0000-4000-8000-000000000020'",[],|r|r.get(0)).unwrap(),if serial{"99"}else{"98"});
        if serial {
            assert_eq!(
                c.query_row::<String, _, _>(
                    "SELECT state FROM sale_serial_inventory_v1",
                    [],
                    |r| r.get(0)
                )
                .unwrap(),
                "RESERVED"
            );
            sales_sync::receive_event(&mut c, &context, &fixture["cancelled"]).unwrap();
            sales_sync::receive_event(&mut c, &context, &fixture["cancelled"]).unwrap();
            assert_eq!(
                c.query_row::<String, _, _>(
                    "SELECT state FROM sale_serial_inventory_v1",
                    [],
                    |r| r.get(0)
                )
                .unwrap(),
                "AVAILABLE"
            );
            assert_eq!(c.query_row::<String,_,_>("SELECT effective_stock FROM stock_projections WHERE producto_id='96200000-0000-4000-8000-000000000020'",[],|r|r.get(0)).unwrap(),"100");
            assert_eq!(
                management::drawer(&c, &context, turn).unwrap()["expectedCents"],
                "50100"
            );
        } else {
            assert_eq!(a["state"], "completado");
            assert_eq!(a["payments"].as_array().unwrap().len(), 3);
            let op = a["operationId"].as_str().unwrap();
            assert_eq!(
                ventard_core::application::printing::layaway_ticket(&c, &context, op).unwrap()
                    ["document"]["layaway"]["folio"],
                a["folio"]
            );
        }
    }
}
#[test]
fn layaway_report_preserves_payment_dates_and_delivery_income_readonly() {
    use ventard_core::application::report_exports::{self, Kind};
    let mut c = db();
    repair_fixture(&mut c);
    let req:management::Command=serde_json::from_value(json!({"kind":"LAYAWAY_CREATE","operationId":id(881),"layawayId":id(880),"definition":{"customerId":null,"customerName":"Ana QA","phone":"","notes":"","items":[{"productId":id(300),"name":"Artículo QA","quantity":"1","priceCents":"500","serial":null}]},"initialPaymentCents":"100","method":"EFECTIVO","turnId":id(90)})).unwrap();
    run_pro(&mut c, req).unwrap();
    let r = report_exports::read(&c, &ctx(), Kind::Layaways, "0", "3000").unwrap();
    assert_eq!(r["summary"]["paymentsCents"], "100");
    assert_eq!(r["summary"]["receivableCents"], "400");
    assert_eq!(r["summary"]["completedIncomeCents"], "0");
    let complete=serde_json::from_value(json!({"kind":"LAYAWAY_ACTION","operationId":id(882),"layawayId":id(880),"expectedRevision":"1","action":"COMPLETE","amountCents":"0","method":"TARJETA","turnId":null,"warrantyDays":"0"})).unwrap();
    management::execute(
        &mut c,
        &grant_tier(2, 5, true, Some("pro")),
        4000,
        4000,
        1,
        complete,
    )
    .unwrap();
    let changes = c.total_changes();
    let r = report_exports::read(&c, &ctx(), Kind::Layaways, "3000", "5000").unwrap();
    assert_eq!(r["summary"]["new"], "0");
    assert_eq!(r["summary"]["paymentsCents"], "400");
    assert_eq!(r["summary"]["completedIncomeCents"], "500");
    assert_eq!(r["summary"]["receivableCents"], "0");
    assert_eq!(c.total_changes(), changes);
}
#[test]
fn encrypted_layaway_reopen_keeps_original_attempt_folio_stock_money_and_unknown_print() {
    use ventard_core::{
        application::{layaways, printing},
        storage::{cipher::CipherKey, writer::VaultWriter},
    };
    let root = std::env::temp_dir();
    let path = root.join(format!("ventard-layaway-fixture-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&path).unwrap();
    let key = CipherKey::new([0x69; 32]);
    let req:management::Command=serde_json::from_value(json!({"kind":"LAYAWAY_CREATE","operationId":id(891),"layawayId":id(890),"definition":{"customerId":null,"customerName":"Ana QA","phone":"","notes":"Contrato durable","items":[{"productId":id(300),"name":"Artículo QA","quantity":"1","priceCents":"500","serial":null}]},"initialPaymentCents":"100","method":"EFECTIVO","turnId":id(90)})).unwrap();
    let hash;
    {
        let mut vault = VaultWriter::create_encrypted(&path, &key).unwrap();
        let c = vault.connection();
        c.execute(
            "INSERT INTO scopes VALUES(?1,'BRANCH',?2,?3)",
            (sales_key(), id(5), id(1)),
        )
        .unwrap();
        c.execute(
            "INSERT INTO native_sales_cursor_v1 VALUES(?1,?2,'NATIVE1',0)",
            (id(1), sales_key()),
        )
        .unwrap();
        repair_fixture(c);
        c.execute_batch("CREATE TRIGGER fail_ap BEFORE INSERT ON sale_cash_entries_v1 WHEN NEW.operation_id='96000000-0000-4000-8000-000000000891' BEGIN SELECT RAISE(ABORT,'fixture reopen');END;").unwrap();
        assert!(run_pro(c, req.clone()).is_err());
    }
    {
        let mut vault = VaultWriter::open_encrypted(&path, &key).unwrap();
        let c = vault.connection();
        assert_eq!(inventory_product(c)["stock"], "4");
        c.execute_batch("DROP TRIGGER fail_ap;").unwrap();
        management::execute(
            c,
            &grant_tier(2, 5, true, Some("pro")),
            9000,
            9000,
            1,
            req.clone(),
        )
        .unwrap();
        let ticket = printing::layaway_ticket(c, &ctx(), &id(891)).unwrap();
        assert_eq!(ticket["originAtUtcMs"], "2000");
        hash = ticket["printSnapshotHash"].as_str().unwrap().to_owned();
        assert!(printing::request_cut(c, &ctx(), &id(891), &hash, &id(899)).unwrap());
    }
    {
        let mut vault = VaultWriter::open_encrypted(&path, &key).unwrap();
        let c = vault.connection();
        run_pro(c, req).unwrap();
        assert_eq!(inventory_product(c)["stock"], "3");
        assert_eq!(
            management::drawer(c, &ctx(), &id(90)).unwrap()["expectedCents"],
            "50100"
        );
        assert_eq!(
            layaways::read(c, &ctx()).unwrap()["rows"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert!(!printing::request_cut(c, &ctx(), &id(891), &hash, &id(899)).unwrap());
        assert_eq!(
            printing::layaway_ticket(c, &ctx(), &id(891)).unwrap()["printAttempt"]["state"],
            "UNKNOWN"
        );
    }
    let real = std::fs::canonicalize(&path).unwrap();
    assert!(real.starts_with(std::fs::canonicalize(root).unwrap()));
    assert!(real
        .file_name()
        .unwrap()
        .to_str()
        .unwrap()
        .starts_with("ventard-layaway-fixture-"));
    std::fs::remove_dir_all(real).unwrap();
}
#[test]
fn warranty_adjustment_preserves_sale_origin_stock_and_money_and_replays_exactly() {
    let mut c = db();
    repair_fixture(&mut c);
    let raw: String = c
        .query_row(
            "SELECT metadata FROM products WHERE producto_id=?1",
            [id(300)],
            |r| r.get(0),
        )
        .unwrap();
    let mut meta: serde_json::Value = serde_json::from_str(&raw).unwrap();
    meta["serialRequired"] = json!(true);
    c.execute(
        "UPDATE products SET metadata=?2 WHERE producto_id=?1",
        (id(300), meta.to_string()),
    )
    .unwrap();
    c.execute(
        "INSERT INTO sale_serial_inventory_v1 VALUES(?1,?2,?3,'000000003','1','AVAILABLE',NULL)",
        (id(1), sales_key(), id(300)),
    )
    .unwrap();
    let create:management::Command=serde_json::from_value(json!({"kind":"LAYAWAY_CREATE","operationId":id(911),"layawayId":id(910),"definition":{"customerId":null,"customerName":"Ana QA","phone":"","notes":"","items":[{"productId":id(300),"name":"Equipo vendido QA","quantity":"1","priceCents":"500","serial":"000000003"}]},"initialPaymentCents":"0","method":"EFECTIVO","turnId":null})).unwrap();
    run_pro(&mut c, create).unwrap();
    let complete=serde_json::from_value(json!({"kind":"LAYAWAY_ACTION","operationId":id(912),"layawayId":id(910),"expectedRevision":"1","action":"COMPLETE","amountCents":"0","method":"TARJETA","turnId":null,"warrantyDays":"30"})).unwrap();
    run_pro(&mut c, complete).unwrap();
    let before = ventard_core::application::warranties::read(&c, &ctx()).unwrap();
    assert_eq!(before["rows"][0]["days"], "30");
    let req:management::Command=serde_json::from_value(json!({"kind":"WARRANTY_SAVE","operationId":id(913),"productId":id(300),"serial":"000000003","expectedRevision":before["rows"][0]["revision"],"action":"ADJUST","days":"60"})).unwrap();
    let updated = run_pro(&mut c, req.clone()).unwrap();
    for _ in 0..3 {
        assert_eq!(run_pro(&mut c, req.clone()).unwrap(), updated)
    }
    let a = &updated["document"]["warranty"];
    assert_eq!(a["soldAtMs"], "2000");
    assert_eq!(a["untilMs"], "5184002000");
    assert_eq!(a["customerName"], "Ana QA");
    assert_eq!(a["priceCents"], "500");
    assert_eq!(inventory_product(&c)["stock"], "3");
    assert_eq!(
        management::drawer(&c, &ctx(), &id(90)).unwrap()["expectedCents"],
        "50000"
    );
    let changes = c.total_changes();
    ventard_core::application::warranties::read(&c, &ctx()).unwrap();
    assert_eq!(changes, c.total_changes());
}
#[test]
#[ignore = "requires the explicitly emitted PostgreSQL warranty capture"]
fn postgres_warranty_capture_preserves_origin_adjustment_and_frozen_certificate() {
    use ventard_core::application::{printing, sales_sync, warranties};
    let fixture: serde_json::Value = serde_json::from_slice(
        &std::fs::read(std::env::var("VENTARD_WARRANTY_BOOTSTRAP_FIXTURE").unwrap()).unwrap(),
    )
    .unwrap();
    let m = &fixture["manifest"];
    let context: CatalogueContext = serde_json::from_value(m["context"].clone()).unwrap();
    let now = m["capturedAtMs"].as_str().unwrap().parse::<u64>().unwrap();
    let mut c = Connection::open_in_memory().unwrap();
    c.pragma_update(None, "foreign_keys", true).unwrap();
    migrations::apply(&mut c).unwrap();
    sales_sync::begin_bootstrap(&mut c, &context, m, now).unwrap();
    for (i, p) in fixture["pages"].as_array().unwrap().iter().enumerate() {
        sales_sync::stage_bootstrap_page(&mut c, &context, i, p.as_str().unwrap(), now).unwrap();
    }
    sales_sync::activate_bootstrap(&mut c, &context, now, &id(900)).unwrap();
    let view = warranties::read(&c, &context).unwrap();
    let a = &view["rows"][0];
    assert_eq!(a["days"], "60");
    assert_eq!(a["soldAtMs"], "1791712800000");
    assert_eq!(a["customerName"], "Ana QA");
    assert_eq!(a["priceCents"], "1234");
    let op = a["operationId"].as_str().unwrap();
    assert_eq!(
        printing::warranty_ticket(&c, &context, op).unwrap()["document"]["warranty"]["days"],
        "60"
    );
    let turn = m["turn"]["receipt"]["operationId"].as_str().unwrap();
    assert_eq!(
        management::drawer(&c, &context, turn).unwrap()["expectedCents"],
        "50000"
    );
}
#[test]
fn warranty_missing_origin_or_signed_pro_never_becomes_a_new_sale_date() {
    let mut c = db();
    repair_fixture(&mut c);
    c.execute(
        "INSERT INTO sale_serial_inventory_v1 VALUES(?1,?2,?3,'UNKNOWN-IMEI','1','SOLD',NULL)",
        (id(1), sales_key(), id(300)),
    )
    .unwrap();
    let data = ventard_core::application::warranties::read(&c, &ctx()).unwrap();
    let a = &data["rows"][0];
    assert_eq!(a["soldAtMs"], serde_json::Value::Null);
    assert_eq!(a["days"], serde_json::Value::Null);
    let req:management::Command=serde_json::from_value(json!({"kind":"WARRANTY_SAVE","operationId":id(940),"productId":id(300),"serial":"UNKNOWN-IMEI","expectedRevision":a["revision"],"action":"ADJUST","days":"30"})).unwrap();
    assert_eq!(run(&mut c, req.clone()).unwrap_err().code(), "PRO_REQUIRED");
    assert_eq!(
        run_pro(&mut c, req).unwrap_err().code(),
        "WARRANTY_ORIGIN_UNKNOWN"
    );
    assert_eq!(
        c.query_row::<i64, _, _>(
            "SELECT count(*) FROM operation_journal WHERE kind='WARRANTY_PATCH'",
            [],
            |r| r.get(0)
        )
        .unwrap(),
        0
    );
    let config: management::Command = serde_json::from_value(
        json!({"kind":"WARRANTY_DEFAULT","operationId":id(941),"expectedRevision":"0","days":"45"}),
    )
    .unwrap();
    run_pro(&mut c, config.clone()).unwrap();
    run_pro(&mut c, config).unwrap();
    assert_eq!(
        ventard_core::application::warranties::defaults(&c, &ctx()).unwrap()["days"],
        "45"
    );
    assert_eq!(
        management::drawer(&c, &ctx(), &id(90)).unwrap()["expectedCents"],
        "50000"
    );
    assert_eq!(inventory_product(&c)["stock"], "4");
}
#[test]
fn print_layout_is_local_scoped_durable_and_never_changes_ticket_hash_or_money() {
    use ventard_core::application::printing::{self, Layout};
    let mut c = db();
    repair_fixture(&mut c);
    run_pro(&mut c, repair_save(701, "0")).unwrap();
    let original = printing::repair_ticket(&c, &ctx(), &id(701)).unwrap();
    let d = Layout {
        paper_width: "58mm".into(),
        font_size: "grande".into(),
        density: "compacta".into(),
        copies: 2,
        ..Default::default()
    };
    printing::save_layout(
        &c,
        &grant_tier(2, 5, true, Some("pro")),
        2000,
        2000,
        1,
        d.clone(),
    )
    .unwrap();
    assert_eq!(printing::layout(&c, &ctx()).unwrap().paper_width, "58mm");
    let printed = printing::repair_ticket(&c, &ctx(), &id(701)).unwrap();
    assert_eq!(original["printSnapshotHash"], printed["printSnapshotHash"]);
    assert_eq!(original["document"], printed["document"]);
    let changes = c.total_changes();
    printing::layout(&c, &ctx()).unwrap();
    assert_eq!(c.total_changes(), changes);
    let mut another = ctx();
    another.installation_id = id(999);
    assert_eq!(printing::layout(&c, &another).unwrap().paper_width, "80mm");
    assert_eq!(
        management::drawer(&c, &ctx(), &id(90)).unwrap()["expectedCents"],
        "50100"
    );
    let invalid = Layout { copies: 3, ..d };
    assert!(printing::save_layout(
        &c,
        &grant_tier(2, 5, true, Some("pro")),
        2000,
        2000,
        1,
        invalid
    )
    .is_err());
}
#[test]
fn original_notice_is_scoped_readonly_and_only_prepares_ready_equipment() {
    let mut c = db();
    repair_fixture(&mut c);
    run_pro(&mut c, repair_save(701, "0")).unwrap();
    assert_eq!(
        ventard_core::application::notices::notice(&c, &ctx(), "REPAIR", &id(700))
            .unwrap_err()
            .code(),
        "SERVICE_STATE_INVALID"
    );
    let mut quote = repair_save(702, "1");
    if let management::Command::RepairSave {
        quote,
        initial_payment_cents,
        ..
    } = &mut quote
    {
        *quote = true;
        *initial_payment_cents = "0".into();
    }
    run_pro(&mut c, quote).unwrap();
    run_pro(&mut c, repair_action(703, "2", "APPROVE", "EFECTIVO", "0")).unwrap();
    run_pro(&mut c, repair_action(704, "3", "READY", "EFECTIVO", "0")).unwrap();
    let changes = c.total_changes();
    let (phone, message) =
        ventard_core::application::notices::notice(&c, &ctx(), "REPAIR", &id(700)).unwrap();
    assert_eq!(phone, "18095550100");
    assert!(message.contains("ya está *listo* para retirar"));
    assert!(message.contains("Saldo pendiente: *RD$ 3.00*"));
    assert_eq!(c.total_changes(), changes);
    let mut wrong = ctx();
    wrong.branch_id = Some(id(555));
    assert!(ventard_core::application::notices::notice(&c, &wrong, "REPAIR", &id(700)).is_err());
}
