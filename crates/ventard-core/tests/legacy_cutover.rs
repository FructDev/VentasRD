#![cfg(feature = "encrypted-storage")]
use serde_json::{json, Value};
use ventard_core::storage::{
    backup, catalogue_preview::CatalogueContext, cipher::CipherKey, legacy_cutover as cut,
    legacy_transition as transition, writer::VaultWriter,
};
fn verified_backup(
    w: &mut VaultWriter,
    dir: &std::path::Path,
    ctx: &CatalogueContext,
    input: &cut::Input,
) {
    let source = backup::Source {
        local_anchor_hash: None,
        tenant_id: ctx.tenant_id.clone(),
        vault_id: "96000016-0000-4000-8000-000000000005".into(),
        installation_id: ctx.installation_id.clone(),
        device_id: ctx.device_id.clone(),
        actor_id: ctx.actor_id.clone(),
        writer_epoch: ctx.writer_epoch.clone(),
        scope_type: ctx.scope_type.clone(),
        branch_id: ctx.branch_id.clone(),
        key_version: 1,
        captured_at_ms: "1791909600100".into(),
    };
    for name in ["backup-files", "backup-keys", "private-backup"] {
        std::fs::create_dir(dir.join(name)).unwrap()
    }
    let job = backup::prepare(
        w.connection(),
        source,
        &input.backup_id,
        &dir.join("backup-files/cutover.vrbackup"),
        &dir.join("backup-keys/cutover.vrkey"),
    )
    .unwrap();
    let proof = backup::create(
        w.connection(),
        job,
        &CipherKey::new([119; 32]),
        &ventard_core::security::recovery_enrollment::RecoverySecret::generate().unwrap(),
        &dir.join("private-backup"),
    )
    .unwrap();
    assert_eq!(proof["state"], "VERIFIED");
}
fn context() -> CatalogueContext {
    let id = "96000000-0000-4000-8000-000000000001".to_string();
    CatalogueContext {
        tenant_id: id.clone(),
        actor_id: id.clone(),
        installation_id: id.clone(),
        device_id: id,
        writer_epoch: "1".into(),
        scope_type: "GLOBAL".into(),
        branch_id: None,
    }
}
fn create() -> (std::path::PathBuf, VaultWriter) {
    let dir =
        std::env::temp_dir().join(format!("ventard-cutover-fixture-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&dir).unwrap();
    let writer = VaultWriter::create_encrypted(&dir, &CipherKey::new([119; 32])).unwrap();
    (dir, writer)
}
fn input() -> cut::Input {
    cut::Input {
        cutover_id: "96000016-0000-4000-8000-000000000003".into(),
        run_id: "96000016-0000-4000-8000-000000000002".into(),
        revision: 0,
        backup_id: "96000016-0000-4000-8000-000000000004".into(),
        confirmation: "WEB_WRITERS_CLOSED_BALANCES_REVIEWED".into(),
        free_tax: "0.18".into(),
    }
}
fn sources(w: &mut VaultWriter, data: Value) {
    let ctx = context();
    let capture = "96000016-0000-4000-8000-000000000001";
    let tables = transition::CLOUD_TABLES
        .iter()
        .map(|t| {
            let rows = data.get(*t).cloned().unwrap_or(json!([]));
            json!({"name":t,"count":rows.as_array().unwrap().len(),"rows":rows,"scopeEvidence":[]})
        })
        .collect::<Vec<_>>();
    let body = json!({"protocol":"ventard.web.capture.1","captureId":capture,"context":ctx,"capturedAtMs":"1791909600000","coverage":"SCOPE_COMPLETE_SINGLE_SNAPSHOT","decimalEncoding":"TAGGED_NUMBERS_V1","tables":tables});
    transition::store_capture(w.connection(), &ctx, capture, &body.to_string()).unwrap();
    transition::prepare(
        w.connection(),
        &ctx,
        &input().run_id,
        &[],
        Some(capture),
        "1791909600000",
    )
    .unwrap();
    transition::publish_history(w.connection(), &ctx, &input().run_id, 0).unwrap();
}
#[test]
fn cutover_requires_real_verified_backup_and_freezes_exact_intent_before_network() {
    let (dir, mut w) = create();
    sources(&mut w, json!({}));
    let ctx = context();
    let i = input();
    assert_eq!(
        cut::prepare(w.connection(), &ctx, &i, "1791909600100")
            .unwrap_err()
            .code(),
        "CUTOVER_BACKUP_REQUIRED"
    );
    verified_backup(&mut w, &dir, &ctx, &i);
    let backup_original: String = w
        .connection()
        .query_row(
            "SELECT result FROM native_backup_jobs_v1 WHERE operation_id=?1",
            [&i.backup_id],
            |r| r.get(0),
        )
        .unwrap();
    let mut old_backup: Value = serde_json::from_str(&backup_original).unwrap();
    old_backup["manifest"]["transitionRuns"][&i.run_id] = json!("0".repeat(64));
    w.connection()
        .execute(
            "UPDATE native_backup_jobs_v1 SET result=?2 WHERE operation_id=?1",
            (&i.backup_id, old_backup.to_string()),
        )
        .unwrap();
    assert_eq!(
        cut::prepare(w.connection(), &ctx, &i, "1791909600100")
            .unwrap_err()
            .code(),
        "CUTOVER_BACKUP_REQUIRED"
    );
    w.connection()
        .execute(
            "UPDATE native_backup_jobs_v1 SET result=?2 WHERE operation_id=?1",
            (&i.backup_id, backup_original),
        )
        .unwrap();
    let saved = cut::prepare(w.connection(), &ctx, &i, "1791909600100").unwrap();
    assert_eq!(saved.state, "UNKNOWN");
    assert_eq!(
        cut::prepare(w.connection(), &ctx, &i, "1791909600200")
            .unwrap()
            .hash,
        saved.hash
    );
    let mut changed = i.clone();
    changed.free_tax = "0".into();
    assert_eq!(
        cut::prepare(w.connection(), &ctx, &changed, "1791909600200")
            .unwrap_err()
            .code(),
        "CUTOVER_ID_CONFLICT"
    );
    let receipt = json!({"protocol":"ventard.web.cutover.receipt.1","status":"BASELINE_ADOPTED","cutoverId":i.cutover_id,"planHash":saved.hash,"context":ctx,"runId":i.run_id,"revision":0,"backupId":i.backup_id,"coverage":"CLOUD_CONVERGED_BASELINE","legacyReplay":false});
    let mut fake = receipt.clone();
    fake["planHash"] = json!("b".repeat(64));
    assert!(cut::accept(w.connection(), &ctx, &i.cutover_id, &fake).is_err());
    w.connection().execute_batch("CREATE TRIGGER cutover_fault BEFORE UPDATE ON legacy_cutovers_v1 BEGIN SELECT RAISE(ABORT,'fixture');END;").unwrap();
    assert!(cut::accept(w.connection(), &ctx, &i.cutover_id, &receipt).is_err());
    assert_eq!(
        cut::load(w.connection(), &ctx, &i.cutover_id)
            .unwrap()
            .state,
        "UNKNOWN"
    );
    w.connection()
        .execute_batch("DROP TRIGGER cutover_fault")
        .unwrap();
    cut::accept(w.connection(), &ctx, &i.cutover_id, &receipt).unwrap();
    w.connection()
        .execute(
            "UPDATE legacy_cutovers_v1 SET receipt=?2 WHERE cutover_id=?1",
            (&i.cutover_id, fake.to_string()),
        )
        .unwrap();
    assert_eq!(
        cut::load(w.connection(), &ctx, &i.cutover_id)
            .unwrap_err()
            .code(),
        "CUTOVER_RECEIPT_INVALID"
    );
    w.connection()
        .execute(
            "UPDATE legacy_cutovers_v1 SET receipt=?2 WHERE cutover_id=?1",
            (&i.cutover_id, receipt.to_string()),
        )
        .unwrap();
    drop(w);
    let mut w = VaultWriter::open_encrypted(&dir, &CipherKey::new([119; 32])).unwrap();
    assert_eq!(
        cut::load(w.connection(), &ctx, &i.cutover_id)
            .unwrap()
            .state,
        "ADOPTED"
    );
    assert_eq!(
        w.connection()
            .query_row("SELECT count(*) FROM operation_journal", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        w.connection()
            .query_row("SELECT count(*) FROM outbox", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
    let mut wrong = ctx.clone();
    wrong.writer_epoch = "2".into();
    assert!(cut::load(w.connection(), &wrong, &i.cutover_id).is_err());
}
#[test]
fn readiness_rejects_open_cash_and_keeps_services_without_inventing_authority() {
    let (_, mut w) = create();
    sources(
        &mut w,
        json!({"cajas":[{"id":"old-turn","negocio_id":context().tenant_id,"sucursal_id":null,"estado":"abierta","monto_apertura":{"$number":"100"}}]}),
    );
    let r = cut::readiness(w.connection(), &context(), &input().run_id).unwrap();
    assert!(r["blockers"]
        .as_array()
        .unwrap()
        .iter()
        .any(|b| b["code"] == "CUTOVER_CLOSE_WEB_CASH"));
    assert_eq!(r["canPrepare"], false);
}
#[test]
fn abandoned_attempt_remains_a_tombstone_and_cannot_become_active() {
    let (dir, mut w) = create();
    sources(&mut w, json!({}));
    let ctx = context();
    let i = input();
    verified_backup(&mut w, &dir, &ctx, &i);
    let p = cut::prepare(w.connection(), &ctx, &i, "1791909600100").unwrap();
    let receipt = json!({"protocol":"ventard.web.cutover.receipt.1","status":"ABANDONED","cutoverId":i.cutover_id,"planHash":p.hash,"context":ctx,"runId":i.run_id,"revision":0,"backupId":i.backup_id,"coverage":"NO_BASELINE_CHANGE","legacyReplay":false});
    cut::accept(w.connection(), &ctx, &i.cutover_id, &receipt).unwrap();
    assert_eq!(
        cut::load(w.connection(), &ctx, &i.cutover_id)
            .unwrap()
            .state,
        "ABANDONED"
    );
    assert!(cut::mark_active(w.connection(), &ctx, &i.cutover_id).is_err());
    let mut late = receipt;
    late["status"] = json!("BASELINE_ADOPTED");
    late["coverage"] = json!("CLOUD_CONVERGED_BASELINE");
    assert!(cut::accept(w.connection(), &ctx, &i.cutover_id, &late).is_err());
    assert_eq!(
        w.connection()
            .query_row("SELECT count(*) FROM outbox", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
}
#[test]
fn another_explicit_business_is_preserved_but_never_adopted_in_the_target_baseline() {
    use sha2::{Digest, Sha256};
    use ventard_core::storage::legacy_web;
    let (_, mut w) = create();
    sources(&mut w, json!({}));
    let ctx = context();
    let original = legacy_web::decrypt(
        include_bytes!("fixtures/legacy-web-v1.vrweb"),
        include_bytes!("fixtures/legacy-web-v1.vrwebkey"),
    )
    .unwrap();
    let mut p: Value = serde_json::from_str(original.raw_body()).unwrap();
    p["exportId"] = json!("96000016-0000-4000-8000-000000000006");
    for table in p["tables"].as_array_mut().unwrap() {
        let rows = if table["name"] == "ventas" {
            json!([{"id":"foreign-sale","negocio_id":"96000000-0000-4000-8000-000000000002","sucursal_id":null,"total":1.23,"metodo_pago":"tarjeta"}])
        } else if table["name"] == "cajas" || table["name"] == "reparaciones" {
            json!([{"id":"foreign-active-document","negocio_id":"96000000-0000-4000-8000-000000000002","sucursal_id":null,"estado":"abierta"}])
        } else {
            json!([])
        };
        let raw = rows.to_string();
        table["rowsJson"] = json!(raw);
        table["count"] = json!(rows.as_array().unwrap().len());
        table["sha256"] = json!(format!("{:x}", Sha256::digest(raw.as_bytes())));
    }
    let package = legacy_web::parse(p.to_string()).unwrap();
    legacy_web::store(w.connection(), &ctx.tenant_id, &package).unwrap();
    let run = "96000016-0000-4000-8000-000000000007";
    transition::prepare(
        w.connection(),
        &ctx,
        run,
        &[package.export_id().into()],
        Some("96000016-0000-4000-8000-000000000001"),
        "1791909600001",
    )
    .unwrap();
    transition::publish_history(w.connection(), &ctx, run, 0).unwrap();
    assert_eq!(
        cut::readiness(w.connection(), &ctx, run).unwrap()["canPrepare"],
        true
    );
    assert_eq!(
        legacy_web::rows(
            w.connection(),
            &ctx.tenant_id,
            package.export_id(),
            "ventas",
            0
        )
        .unwrap()["rows"][0]["id"],
        "foreign-sale"
    );
    assert_eq!(
        transition::history(w.connection(), &ctx, "", None, None, None, 1).unwrap()["total"],
        "0"
    );
}
#[test]
#[ignore = "requires explicit isolated PostgreSQL capture and bootstrap fixture"]
fn postgres_capture_prepares_native_wire_with_real_verified_backup() {
    let v: Value = serde_json::from_str(
        &std::fs::read_to_string(std::env::var("VENTARD_CUTOVER_PG_FIXTURE").unwrap()).unwrap(),
    )
    .unwrap();
    let ctx: CatalogueContext = serde_json::from_value(v["capture"]["context"].clone()).unwrap();
    let (dir, mut w) = create();
    let i = input();
    let cid = v["capture"]["captureId"].as_str().unwrap();
    transition::store_capture(w.connection(), &ctx, cid, &v["capture"].to_string()).unwrap();
    transition::prepare(
        w.connection(),
        &ctx,
        &i.run_id,
        &[],
        Some(cid),
        "1791909600000",
    )
    .unwrap();
    transition::publish_history(w.connection(), &ctx, &i.run_id, 0).unwrap();
    let ready = cut::readiness(w.connection(), &ctx, &i.run_id).unwrap();
    assert_eq!(ready["blockers"], json!([]));
    verified_backup(&mut w, &dir, &ctx, &i);
    let p = cut::prepare(w.connection(), &ctx, &i, "1791909600100").unwrap();
    let plan: Value = serde_json::from_str(&p.intent).unwrap();
    assert_eq!(plan["tables"], v["plan"]["tables"]);
    let output = std::env::var("VENTARD_CUTOVER_NATIVE_WIRE_FIXTURE").unwrap();
    std::fs::write(output,json!({"intent":p.intent,"hash":p.hash,"directory":dir,"bootstrap":v["manifest"],"pages":v["pages"]}).to_string()).unwrap();
}
#[test]
#[ignore = "requires native wire accepted by isolated PostgreSQL in previous phase"]
fn postgres_receipt_activates_same_cutover_and_bootstrap_without_replaying_legacy_money() {
    let packet: Value = serde_json::from_str(
        &std::fs::read_to_string(std::env::var("VENTARD_CUTOVER_NATIVE_WIRE_FIXTURE").unwrap())
            .unwrap(),
    )
    .unwrap();
    let receipt: Value = serde_json::from_str(
        &std::fs::read_to_string(std::env::var("VENTARD_CUTOVER_RECEIPT_FIXTURE").unwrap())
            .unwrap(),
    )
    .unwrap();
    let path = std::path::PathBuf::from(packet["directory"].as_str().unwrap());
    assert_eq!(path.parent().unwrap(), std::env::temp_dir());
    assert!(path
        .file_name()
        .unwrap()
        .to_str()
        .unwrap()
        .starts_with("ventard-cutover-fixture-"));
    let mut w = VaultWriter::open_encrypted(&path, &CipherKey::new([119; 32])).unwrap();
    let ctx: CatalogueContext = serde_json::from_value(receipt["context"].clone()).unwrap();
    let id = receipt["cutoverId"].as_str().unwrap();
    cut::accept(w.connection(), &ctx, id, &receipt).unwrap();
    let m = &packet["bootstrap"];
    let now = m["capturedAtMs"].as_str().unwrap().parse::<u64>().unwrap();
    use ventard_core::application::sales_sync;
    sales_sync::begin_bootstrap(w.connection(), &ctx, m, now).unwrap();
    for (index, page) in packet["pages"].as_array().unwrap().iter().enumerate() {
        sales_sync::stage_bootstrap_page(
            w.connection(),
            &ctx,
            index,
            page["payload"].as_str().unwrap(),
            now,
        )
        .unwrap();
    }
    sales_sync::activate_bootstrap(
        w.connection(),
        &ctx,
        now,
        "96000016-0000-4000-8000-000000000005",
    )
    .unwrap();
    assert_eq!(
        cut::mark_active(w.connection(), &ctx, id).unwrap()["state"],
        "ACTIVE"
    );
    let snapshot = sales_sync::read(w.connection(), &ctx).unwrap();
    assert_eq!(snapshot["customers"][0]["balanceCents"], "1234");
    assert_eq!(snapshot["products"][0]["stock"], "100");
    assert_eq!(snapshot["confirmedSales"], "0");
    assert_eq!(snapshot["pendingOperations"], "0");
    assert_eq!(
        cut::load(w.connection(), &ctx, id).unwrap().hash,
        receipt["planHash"]
    );
    assert!(sales_sync::activate_bootstrap(
        w.connection(),
        &ctx,
        now,
        "96000016-0000-4000-8000-000000000005"
    )
    .is_err());
}
