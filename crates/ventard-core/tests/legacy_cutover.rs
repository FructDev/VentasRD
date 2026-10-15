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
        service_reservations_confirmed: None,
        legacy_cash_history_confirmed: None,
    }
}
fn browser_copy(w: &mut VaultWriter, data: Value) -> String {
    use sha2::{Digest, Sha256};
    use ventard_core::storage::legacy_web;
    let original = legacy_web::decrypt(
        include_bytes!("fixtures/legacy-web-v1.vrweb"),
        include_bytes!("fixtures/legacy-web-v1.vrwebkey"),
    )
    .unwrap();
    let mut p: Value = serde_json::from_str(original.raw_body()).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    p["exportId"] = json!(id);
    for table in p["tables"].as_array_mut().unwrap() {
        let rows = data
            .get(table["name"].as_str().unwrap())
            .cloned()
            .unwrap_or(json!([]));
        let raw = rows.to_string();
        table["rowsJson"] = json!(raw);
        table["count"] = json!(rows.as_array().unwrap().len());
        table["sha256"] = json!(format!("{:x}", Sha256::digest(raw.as_bytes())));
    }
    let package = legacy_web::parse(p.to_string()).unwrap();
    legacy_web::store(w.connection(), &context().tenant_id, &package).unwrap();
    id
}
#[test]
fn divergent_history_can_use_reviewed_cloud_baseline_without_replaying_or_erasing_it() {
    let (dir, mut w) = create();
    let ctx = context();
    sources(&mut w, json!({}));
    let browser = browser_copy(
        &mut w,
        json!({"ventas":[{"id":"browser-sale","negocio_id":ctx.tenant_id,"sucursal_id":null,"total":10,"metodo_pago":"tarjeta","fecha":1000}],"venta_detalles":[{"id":"browser-detail","negocio_id":ctx.tenant_id,"sucursal_id":null,"venta_id":"browser-sale","producto_id":null,"producto_nombre":"Libre QA","cantidad":1,"precio_unitario":10,"subtotal":10}]}),
    );
    let run = uuid::Uuid::new_v4().to_string();
    transition::prepare(
        w.connection(),
        &ctx,
        &run,
        &[browser.clone()],
        Some("96000016-0000-4000-8000-000000000001"),
        "2000",
    )
    .unwrap();
    transition::publish_history(w.connection(), &ctx, &run, 0).unwrap();
    let comparison = cut::differences(w.connection(), &ctx, &run, 0).unwrap();
    assert_eq!(comparison["total"], 2);
    assert_eq!(comparison["rows"][1]["id"], "browser-sale");
    assert_eq!(comparison["rows"][1]["cloud"], Value::Null);
    assert_eq!(
        cut::readiness(w.connection(), &ctx, &run).unwrap()["canPrepare"],
        false
    );
    let d = cut::BaselineDecision {
        run_id: run.clone(),
        revision: 0,
        difference_hash: comparison["differenceHash"].as_str().unwrap().into(),
        reason: "Revisé saldo y stock actual, conservar copia histórica sin aplicar sus efectos"
            .into(),
        confirmation: "USE_CLOUD_BASELINE_PRESERVE_HISTORY".into(),
    };
    let mut i = input();
    i.run_id = run.clone();
    verified_backup(&mut w, &dir, &ctx, &i);
    let before = cut::fingerprints(w.connection()).unwrap()[&run].clone();
    let mut wrong = ctx.clone();
    wrong.actor_id = uuid::Uuid::new_v4().to_string();
    assert!(cut::review_baseline(w.connection(), &wrong, &d).is_err());
    let mut stale = d.clone();
    stale.difference_hash = "0".repeat(64);
    assert!(cut::review_baseline(w.connection(), &ctx, &stale).is_err());
    w.connection().execute_batch("CREATE TRIGGER review_fault BEFORE UPDATE ON legacy_transition_runs_v1 BEGIN SELECT RAISE(ABORT,'fixture');END;").unwrap();
    assert!(cut::review_baseline(w.connection(), &ctx, &d).is_err());
    assert_eq!(
        transition::report(w.connection(), &ctx, &run).unwrap()["revision"],
        0
    );
    assert_eq!(
        w.connection()
            .query_row::<i64, _, _>(
                "SELECT count(*) FROM legacy_transition_decisions_v1",
                [],
                |r| r.get(0)
            )
            .unwrap(),
        0
    );
    w.connection()
        .execute_batch("DROP TRIGGER review_fault")
        .unwrap();
    let reviewed = cut::review_baseline(w.connection(), &ctx, &d).unwrap();
    assert_eq!(reviewed["canPrepare"], true);
    assert_eq!(reviewed["revision"], 1);
    assert_eq!(
        cut::review_baseline(w.connection(), &ctx, &d).unwrap(),
        reviewed
    );
    assert_ne!(cut::fingerprints(w.connection()).unwrap()[&run], before);
    let mut changed = d.clone();
    changed.reason.push_str(" distinto");
    assert!(cut::review_baseline(w.connection(), &ctx, &changed).is_err());
    i.revision = 1;
    assert_eq!(
        cut::prepare(w.connection(), &ctx, &i, "3000")
            .unwrap_err()
            .code(),
        "CUTOVER_BACKUP_REQUIRED"
    );
    i.backup_id = uuid::Uuid::new_v4().to_string();
    let after_review = dir.join("after-review");
    std::fs::create_dir(&after_review).unwrap();
    verified_backup(&mut w, &after_review, &ctx, &i);
    let p = cut::prepare(w.connection(), &ctx, &i, "3000").unwrap();
    let wire: Value = serde_json::from_str(&p.intent).unwrap();
    assert!(wire["tables"]
        .as_array()
        .unwrap()
        .iter()
        .all(|t| t["count"] == 0));
    assert_eq!(
        transition::history(w.connection(), &ctx, "", None, None, None, 1).unwrap()["total"],
        "1"
    );
    assert_eq!(
        transition::report(w.connection(), &ctx, &run).unwrap()["effectStatus"],
        "UNKNOWN_LEGACY"
    );
    for t in [
        "outbox",
        "operation_journal",
        "inventory_movements",
        "sale_cash_entries_v1",
    ] {
        assert_eq!(
            w.connection()
                .query_row::<i64, _, _>(&format!("SELECT count(*) FROM {t}"), [], |r| r.get(0))
                .unwrap(),
            0
        );
    }
    drop(w);
    let mut w = VaultWriter::open_encrypted(&dir, &CipherKey::new([119; 32])).unwrap();
    assert_eq!(
        cut::load(w.connection(), &ctx, &i.cutover_id).unwrap().hash,
        p.hash
    );
    assert!(cut::review_baseline(w.connection(), &ctx, &d).is_ok());
    assert_eq!(
        ventard_core::storage::legacy_web::rows(
            w.connection(),
            &ctx.tenant_id,
            &browser,
            "ventas",
            0
        )
        .unwrap()["rows"][0]["id"],
        "browser-sale"
    );
}
#[test]
fn reviewed_difference_never_overrides_invalid_money_or_active_service_version() {
    for (table, row, code) in [
        (
            "ventas",
            json!({"id":"invalid-sale","negocio_id":context().tenant_id,"sucursal_id":null,"total":-1,"metodo_pago":"tarjeta"}),
            "INVALID_MONEY",
        ),
        (
            "reparaciones",
            json!({"id":"96000016-0000-4000-8000-000000000099","negocio_id":context().tenant_id,"sucursal_id":null,"estado":"pendiente"}),
            "CUTOVER_SERVICE_BASELINE_CONFLICT",
        ),
        (
            "cajas",
            json!({"id":"browser-open-turn","negocio_id":context().tenant_id,"sucursal_id":null,"estado":"abierta","monto_apertura":10}),
            "CUTOVER_CLOSE_WEB_CASH",
        ),
    ] {
        let (_, mut w) = create();
        let ctx = context();
        sources(&mut w, json!({}));
        let copy = browser_copy(&mut w, json!({table:[row]}));
        let run = uuid::Uuid::new_v4().to_string();
        transition::prepare(
            w.connection(),
            &ctx,
            &run,
            &[copy],
            Some("96000016-0000-4000-8000-000000000001"),
            "2000",
        )
        .unwrap();
        transition::publish_history(w.connection(), &ctx, &run, 0).unwrap();
        let diff = cut::differences(w.connection(), &ctx, &run, 0).unwrap();
        let d = cut::BaselineDecision {
            run_id: run.clone(),
            revision: 0,
            difference_hash: diff["differenceHash"].as_str().unwrap().into(),
            reason: "Revisión de la base actual sintética".into(),
            confirmation: "USE_CLOUD_BASELINE_PRESERVE_HISTORY".into(),
        };
        let ready = cut::review_baseline(w.connection(), &ctx, &d).unwrap();
        assert_eq!(ready["canPrepare"], false);
        assert!(
            ready["blockers"]
                .as_array()
                .unwrap()
                .iter()
                .any(|v| v["code"] == code),
            "{ready}"
        );
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
fn unlinked_historical_cash_requires_frozen_explicit_archive_confirmation_without_money_replay() {
    let (dir, mut w) = create();
    let ctx = context();
    sources(
        &mut w,
        json!({"ventas":[{"id":"old-unlinked-sale","negocio_id":ctx.tenant_id,"sucursal_id":null,"total":{"$number":"10"},"metodo_pago":"efectivo","fecha":{"$number":"1000"},"caja_id":null}],"venta_detalles":[{"id":"old-free-line","negocio_id":ctx.tenant_id,"sucursal_id":null,"venta_id":"old-unlinked-sale","producto_id":null,"producto_nombre":"Libre QA","cantidad":{"$number":"1"},"precio_unitario":{"$number":"10"},"subtotal":{"$number":"10"}}]}),
    );
    let ready = cut::readiness(w.connection(), &ctx, &input().run_id).unwrap();
    assert_eq!(
        ready["legacyCashHistoryWarnings"].as_array().unwrap().len(),
        1
    );
    assert_eq!(ready["canPrepare"], true);
    let mut i = input();
    verified_backup(&mut w, &dir, &ctx, &i);
    assert_eq!(
        cut::prepare(w.connection(), &ctx, &i, "3000")
            .unwrap_err()
            .code(),
        "CUTOVER_CASH_HISTORY_CONFIRMATION_REQUIRED"
    );
    i.legacy_cash_history_confirmed = Some(true);
    let prepared = cut::prepare(w.connection(), &ctx, &i, "3000").unwrap();
    let frozen: Value = serde_json::from_str(&prepared.intent).unwrap();
    assert_eq!(frozen["legacyCashHistoryConfirmed"], true);
    assert_eq!(
        transition::report(w.connection(), &ctx, &i.run_id).unwrap()["effectStatus"],
        "UNKNOWN_LEGACY"
    );
    for table in ["outbox", "sale_cash_entries_v1", "inventory_movements"] {
        assert_eq!(
            w.connection()
                .query_row::<i64, _, _>(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
                .unwrap(),
            0
        );
    }
    i.legacy_cash_history_confirmed = Some(false);
    assert_eq!(
        cut::prepare(w.connection(), &ctx, &i, "3000")
            .unwrap_err()
            .code(),
        "CUTOVER_ID_CONFLICT"
    );
}
#[test]
fn active_service_with_missing_old_payment_details_requires_explicit_baseline_confirmation() {
    let (dir, mut w) = create();
    let ctx = context();
    sources(
        &mut w,
        json!({"apartados":[{"id":"96000016-0000-4000-8000-000000000040","negocio_id":ctx.tenant_id,"sucursal_id":null,"folio":"AP-042","estado":"activo","cliente_nombre":"Ana","items":[{"producto_id":"96000016-0000-4000-8000-000000000041","nombre":"Equipo","cantidad":{"$number":"1"},"precio_unitario":{"$number":"25"}}],"total":{"$number":"25"},"abonado":{"$number":"5"},"fecha_creacion":{"$number":"1000"},"fecha_actualizacion":{"$number":"2000"}}]}),
    );
    let r = cut::readiness(w.connection(), &ctx, &input().run_id).unwrap();
    assert_eq!(r["canPrepare"], true);
    assert_eq!(r["services"].as_array().unwrap().len(), 1);
    let mut i = input();
    verified_backup(&mut w, &dir, &ctx, &i);
    assert_eq!(
        cut::prepare(w.connection(), &ctx, &i, "3000")
            .unwrap_err()
            .code(),
        "CUTOVER_SERVICE_RESERVATIONS_REQUIRED"
    );
    i.service_reservations_confirmed = Some(true);
    let pending = cut::prepare(w.connection(), &ctx, &i, "3000").unwrap();
    let plan: Value = serde_json::from_str(&pending.intent).unwrap();
    assert_eq!(plan["serviceReservationsConfirmed"], true);
    assert_eq!(
        w.connection()
            .query_row("SELECT count(*) FROM payments", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
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
    let mut i = input();
    let cid = v["capture"]["captureId"].as_str().unwrap();
    transition::store_capture(w.connection(), &ctx, cid, &v["capture"].to_string()).unwrap();
    let copies = if std::env::var("VENTARD_CUTOVER_DIVERGENT").as_deref() == Ok("1") {
        vec![browser_copy(
            &mut w,
            json!({"ventas":[{"id":"browser-only-sale","negocio_id":ctx.tenant_id,"sucursal_id":ctx.branch_id,"total":10,"metodo_pago":"tarjeta","fecha":1000}],"venta_detalles":[{"id":"browser-only-line","negocio_id":ctx.tenant_id,"sucursal_id":ctx.branch_id,"venta_id":"browser-only-sale","producto_id":null,"producto_nombre":"Libre QA","cantidad":1,"precio_unitario":10,"subtotal":10}]}),
        )]
    } else {
        vec![]
    };
    transition::prepare(
        w.connection(),
        &ctx,
        &i.run_id,
        &copies,
        Some(cid),
        "1791909600000",
    )
    .unwrap();
    transition::publish_history(w.connection(), &ctx, &i.run_id, 0).unwrap();
    if !copies.is_empty() {
        let diff = cut::differences(w.connection(), &ctx, &i.run_id, 0).unwrap();
        cut::review_baseline(
            w.connection(),
            &ctx,
            &cut::BaselineDecision {
                run_id: i.run_id.clone(),
                revision: 0,
                difference_hash: diff["differenceHash"].as_str().unwrap().into(),
                reason: "PG aislado: base nube revisada, copia exclusiva conservada".into(),
                confirmation: "USE_CLOUD_BASELINE_PRESERVE_HISTORY".into(),
            },
        )
        .unwrap();
        i.revision = 1;
    }
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
    let plan: Value = serde_json::from_str(packet["intent"].as_str().unwrap()).unwrap();
    if plan["sources"]
        .as_array()
        .unwrap()
        .iter()
        .any(|s| s["kind"] == "BROWSER")
    {
        let preserved = transition::history(w.connection(), &ctx, "", None, None, None, 1).unwrap();
        assert_eq!(preserved["total"], "1");
        assert_eq!(preserved["rows"][0]["id"], "browser-only-sale");
        assert_eq!(preserved["rows"][0]["effectStatus"], "UNKNOWN_LEGACY");
        assert_eq!(
            w.connection()
                .query_row::<i64, _, _>("SELECT count(*) FROM outbox", [], |r| r.get(0))
                .unwrap(),
            0
        );
    }
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
