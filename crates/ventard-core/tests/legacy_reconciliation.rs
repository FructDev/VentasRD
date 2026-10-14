#![cfg(feature = "encrypted-storage")]
use serde_json::{json, Value};
use ventard_core::storage::{
    catalogue_preview::CatalogueContext, cipher::CipherKey, legacy_reconciliation as r, legacy_web,
    writer::VaultWriter,
};
const TENANT: &str = "96000000-0000-4000-8000-000000000001";
fn ctx() -> CatalogueContext {
    CatalogueContext {
        tenant_id: TENANT.into(),
        installation_id: "96000001-0000-4000-8000-000000000001".into(),
        device_id: "96000002-0000-4000-8000-000000000001".into(),
        actor_id: "96000003-0000-4000-8000-000000000001".into(),
        writer_epoch: "1".into(),
        scope_type: "GLOBAL".into(),
        branch_id: None,
    }
}
struct Dir(std::path::PathBuf);
impl Dir {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!(
            "ventard-reconcile-fixture-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir(&p).unwrap();
        Self(p)
    }
}
impl Drop for Dir {
    fn drop(&mut self) {
        if let (Ok(owned), Ok(root)) = (self.0.canonicalize(), std::env::temp_dir().canonicalize())
        {
            if owned.parent() == Some(root.as_path())
                && owned.file_name().is_some_and(|n| {
                    n.to_string_lossy()
                        .starts_with("ventard-reconcile-fixture-")
                })
            {
                let _ = std::fs::remove_dir_all(owned);
            }
        }
    }
}
fn fixture(w: &mut VaultWriter) -> String {
    let p = legacy_web::decrypt(
        include_bytes!("fixtures/legacy-web-v1.vrweb"),
        include_bytes!("fixtures/legacy-web-v1.vrwebkey"),
    )
    .unwrap();
    let id = p.export_id().to_owned();
    legacy_web::store(w.connection(), TENANT, &p).unwrap();
    id
}
fn snapshot(batch: &r::Batch, rows: Value) -> String {
    json!({"protocol":"ventard.web.observation.1","observationId":batch.observation_id,"tenantId":TENANT,"actorId":ctx().actor_id,"installationId":ctx().installation_id,"deviceId":ctx().device_id,"writerEpoch":"1","scope":{"type":"GLOBAL","branchId":null},"table":batch.table,"requestedIds":batch.ids,"capturedAtMs":"1791909600000","coverage":"REQUESTED_IDS_ONLY","decimalEncoding":"TAGGED_NUMBERS_V1","rows":rows}).to_string()
}
fn number(s: &str) -> Value {
    json!({"$number":s})
}
#[test]
fn schema_23_upgrade_preserves_frozen_plan_and_existing_row_checkpoints() {
    let dir = Dir::new();
    let key = CipherKey::new([95; 32]);
    let mut w = VaultWriter::create_encrypted(&dir.0, &key).unwrap();
    let export = fixture(&mut w);
    let report = "98000001-0000-4000-8000-000000000005";
    let original = r::prepare(w.connection(), &ctx(), &export, report, "1791909500000").unwrap();
    let first = r::next(w.connection(), &ctx(), report).unwrap().unwrap();
    r::accept(
        w.connection(),
        &ctx(),
        report,
        &first,
        &snapshot(&first, json!([])),
    )
    .unwrap();
    let next = r::next(w.connection(), &ctx(), report).unwrap().unwrap();
    // Owned synthetic fixture reconstructed as the actual prior schema; never
    // downgrade a user's database or modify historical migration checksums.
    w.connection().execute_batch("ALTER TABLE legacy_web_observation_plans_v1 DROP COLUMN source_kind; DROP TABLE legacy_cutovers_v1; DROP TABLE legacy_history_active_v1; DROP TABLE legacy_transition_decisions_v1; DROP TABLE legacy_transition_docs_v1; DROP TABLE legacy_transition_rows_v1; DROP TABLE legacy_transition_runs_v1; DROP TABLE legacy_cloud_captures_v1; DELETE FROM migration_history WHERE version>=24; PRAGMA user_version=23;").unwrap();
    drop(w);
    let mut w = VaultWriter::open_encrypted(&dir.0, &key).unwrap();
    assert_eq!(
        r::next(w.connection(), &ctx(), report).unwrap().unwrap(),
        next
    );
    let status = r::status(w.connection(), &ctx(), report).unwrap();
    assert_eq!(status["totalBatches"], original["totalBatches"]);
    assert_eq!(status["completedBatches"], 1);
    assert_eq!(next.source_kind, "LEGACY_ROWS");
    assert_eq!(
        w.connection()
            .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        27
    );
}
#[test]
fn durable_inventory_evidence_resumes_after_row_observation_and_never_applies_stock_or_sales() {
    use sha2::{Digest, Sha256};
    let f: Value =
        serde_json::from_str(include_str!("fixtures/legacy-inventory-proof.json")).unwrap();
    let dir = Dir::new();
    let key = CipherKey::new([94; 32]);
    let mut w = VaultWriter::create_encrypted(&dir.0, &key).unwrap();
    let p = legacy_web::decrypt(
        include_bytes!("fixtures/legacy-web-v1.vrweb"),
        include_bytes!("fixtures/legacy-web-v1.vrwebkey"),
    )
    .unwrap();
    let mut body: Value = serde_json::from_str(p.raw_body()).unwrap();
    let rows = f["fixtures"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v["local"].clone())
        .collect::<Vec<_>>();
    let raw_rows = serde_json::to_string(&rows).unwrap();
    let table = body["tables"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|t| t["name"] == "movimientos_stock")
        .unwrap();
    table["count"] = json!(rows.len());
    table["rowsJson"] = json!(raw_rows);
    table["sha256"] = json!(format!("{:x}", Sha256::digest(raw_rows.as_bytes())));
    let original = body.to_string();
    let p = legacy_web::parse(original.clone()).unwrap();
    let export = p.export_id().to_owned();
    legacy_web::store(w.connection(), TENANT, &p).unwrap();
    let mut scoped = ctx();
    scoped.scope_type = "BRANCH".into();
    scoped.branch_id = Some(f["branch"].as_str().unwrap().into());
    let report = "98000001-0000-4000-8000-000000000004";
    r::prepare(w.connection(), &scoped, &export, report, "1791909500000").unwrap();
    let batch = loop {
        let b = r::next(w.connection(), &scoped, report).unwrap().unwrap();
        if b.source_kind == "INVENTORY_LEDGER_V2" {
            break b;
        }
        let mut empty: Value = serde_json::from_str(&snapshot(&b, json!([]))).unwrap();
        empty["scope"] = json!({"type":"BRANCH","branchId":scoped.branch_id});
        r::accept(w.connection(), &scoped, report, &b, &empty.to_string()).unwrap();
    };
    let previous_rows_hash:String=w.connection().query_row("SELECT response_hash FROM legacy_web_observations_v1 JOIN legacy_web_observation_plans_v1 USING(report_id,batch_index) WHERE report_id=?1 AND table_name='movimientos_stock' AND source_kind='LEGACY_ROWS'",[report],|r|r.get(0)).unwrap();
    r::failure(w.connection(), &scoped, report, "NETWORK_UNAVAILABLE").unwrap();
    drop(w);
    let mut w = VaultWriter::open_encrypted(&dir.0, &key).unwrap();
    assert_eq!(
        r::next(w.connection(), &scoped, report).unwrap().unwrap(),
        batch
    );
    let mut value: Value = serde_json::from_str(&snapshot(&batch, json!([]))).unwrap();
    value["scope"] = json!({"type":"BRANCH","branchId":scoped.branch_id});
    value["protocol"] = json!("ventard.web.inventory-ledger.1");
    value["decimalEncoding"] = json!("RAW_INT4_BIGINT_V1");
    value["ledgerRowsJson"] = f["rawLedgerRows"].clone();
    let mut probe: Value = serde_json::from_str(&snapshot(&batch, json!([]))).unwrap();
    probe["scope"] = json!({"type":"BRANCH","branchId":scoped.branch_id});
    value["contextProofJson"] = json!(probe.to_string());
    let raw = value.to_string();
    let mut injected_probe = probe.clone();
    injected_probe["rows"] = json!([{"id":batch.ids[0],"negocio_id":"96000000-0000-4000-8000-000000000002","sucursal_id":scoped.branch_id}]);
    let mut injected = value.clone();
    injected["contextProofJson"] = json!(injected_probe.to_string());
    assert!(r::accept(
        w.connection(),
        &scoped,
        report,
        &batch,
        &injected.to_string()
    )
    .is_err());
    let mut stale = value.clone();
    probe["writerEpoch"] = json!("2");
    stale["contextProofJson"] = json!(probe.to_string());
    assert!(r::accept(w.connection(), &scoped, report, &batch, &stale.to_string()).is_err());
    stale = value.clone();
    stale.as_object_mut().unwrap().remove("contextProofJson");
    assert!(r::accept(w.connection(), &scoped, report, &batch, &stale.to_string()).is_err());
    for (source_field, ledger_field, new_id) in [
        (
            "negocio_id",
            "negocio_id",
            "96000000-0000-4000-8000-000000000002",
        ),
        (
            "sucursal_id",
            "sucursal_id",
            "96400000-0000-4000-8000-000000000090",
        ),
        ("id", "operacion_id", "96400000-0000-4000-8000-000000000091"),
    ] {
        let mut source = f["fixtures"][0]["local"].clone();
        source[source_field] = json!(new_id);
        let canonical =
            ventard_core::storage::legacy_inventory_proof::reconstruct(&source).unwrap();
        let mut ledger: Value = serde_json::from_str(f["rawLedgerRows"].as_str().unwrap()).unwrap();
        ledger[0][ledger_field] = json!(new_id);
        ledger[0]["payload_hash"] = json!(format!("{:x}", Sha256::digest(canonical.as_bytes())));
        assert!(
            ventard_core::storage::legacy_inventory_proof::parse_rows(&ledger.to_string()).is_ok()
        );
        let mut injected = value.clone();
        injected["ledgerRowsJson"] = json!(ledger.to_string());
        assert!(
            r::accept(
                w.connection(),
                &scoped,
                report,
                &batch,
                &injected.to_string()
            )
            .is_err(),
            "{ledger_field}"
        );
    }
    let mut different = value.clone();
    different["tenantId"] = json!("96000000-0000-4000-8000-000000000002");
    assert!(r::accept(
        w.connection(),
        &scoped,
        report,
        &batch,
        &different.to_string()
    )
    .is_err());
    w.connection().execute_batch("CREATE TEMP TRIGGER ledger_fail BEFORE UPDATE ON legacy_web_comparisons_v1 BEGIN SELECT RAISE(ABORT,'fixture interrupted'); END;").unwrap();
    assert!(r::accept(w.connection(), &scoped, report, &batch, &raw).is_err());
    assert_eq!(
        r::next(w.connection(), &scoped, report).unwrap().unwrap(),
        batch
    );
    w.connection()
        .execute_batch("DROP TRIGGER ledger_fail")
        .unwrap();
    r::accept(w.connection(), &scoped, report, &batch, &raw).unwrap();
    r::accept(w.connection(), &scoped, report, &batch, &raw).unwrap();
    different = value;
    different["capturedAtMs"] = json!("1791909600001");
    assert!(r::accept(
        w.connection(),
        &scoped,
        report,
        &batch,
        &different.to_string()
    )
    .is_err());
    let result = r::rows(w.connection(), &scoped, report, "movimientos_stock", 0).unwrap();
    for row in result["rows"].as_array().unwrap() {
        assert_eq!(row["inventoryEvidence"]["status"], "APPLIED_VERIFIED");
        assert_eq!(row["effectStatus"], "UNKNOWN_LEGACY");
    }
    let status = r::status(w.connection(), &scoped, report).unwrap();
    assert_eq!(status["inventoryEffectCounts"]["APPLIED_VERIFIED"], 2);
    assert_eq!(status["canActivate"], false);
    let after:String=w.connection().query_row("SELECT response_hash FROM legacy_web_observations_v1 JOIN legacy_web_observation_plans_v1 USING(report_id,batch_index) WHERE report_id=?1 AND table_name='movimientos_stock' AND source_kind='LEGACY_ROWS'",[report],|r|r.get(0)).unwrap();
    assert_eq!(after, previous_rows_hash);
    let preserved: String = w
        .connection()
        .query_row(
            "SELECT body FROM legacy_web_packages_v1 WHERE export_id=?1",
            [export],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(preserved, original);
    assert_eq!(
        w.connection()
            .query_row("SELECT count(*) FROM operation_journal", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}
#[test]
fn return_scope_requires_exact_separate_sale_evidence_without_fabricating_row_fields() {
    use sha2::{Digest, Sha256};
    let dir = Dir::new();
    let mut w = VaultWriter::create_encrypted(&dir.0, &CipherKey::new([93; 32])).unwrap();
    let p = legacy_web::decrypt(
        include_bytes!("fixtures/legacy-web-v1.vrweb"),
        include_bytes!("fixtures/legacy-web-v1.vrwebkey"),
    )
    .unwrap();
    let mut body: Value = serde_json::from_str(p.raw_body()).unwrap();
    let source = json!({"id":"old-return","negocio_id":TENANT,"venta_id":"old-sale","monto":1.23});
    let table = body["tables"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|t| t["name"] == "devoluciones")
        .unwrap();
    let raw_rows = json!([source]).to_string();
    table["count"] = json!(1);
    table["rowsJson"] = json!(raw_rows);
    table["sha256"] = json!(format!("{:x}", Sha256::digest(raw_rows.as_bytes())));
    let p = legacy_web::parse(body.to_string()).unwrap();
    let export = p.export_id().to_owned();
    legacy_web::store(w.connection(), TENANT, &p).unwrap();
    let mut scoped = ctx();
    scoped.scope_type = "BRANCH".into();
    scoped.branch_id = Some("96000004-0000-4000-8000-000000000001".into());
    let report = "98000001-0000-4000-8000-000000000003";
    r::prepare(w.connection(), &scoped, &export, report, "1791909500000").unwrap();
    let batch = loop {
        let b = r::next(w.connection(), &scoped, report).unwrap().unwrap();
        if b.table == "devoluciones" {
            break b;
        }
        let mut empty: Value = serde_json::from_str(&snapshot(&b, json!([]))).unwrap();
        empty["scope"] = json!({"type":"BRANCH","branchId":scoped.branch_id});
        r::accept(w.connection(), &scoped, report, &b, &empty.to_string()).unwrap();
    };
    let mut raw:Value=serde_json::from_str(&snapshot(&batch,json!([{"id":"old-return","negocio_id":TENANT,"venta_id":"old-sale","monto":number("1.2300")}]))).unwrap();
    raw["scope"] = json!({"type":"BRANCH","branchId":scoped.branch_id});
    assert!(r::accept(w.connection(), &scoped, report, &batch, &raw.to_string()).is_err());
    raw["scopeEvidence"] = json!([{"rowId":"old-return","sourceTable":"ventas","sourceId":"old-sale","tenantId":TENANT,"branchId":scoped.branch_id}]);
    for key in ["rowId", "sourceTable", "sourceId", "tenantId", "branchId"] {
        let mut changed = raw.clone();
        changed["scopeEvidence"][0][key] = json!("different");
        assert!(
            r::accept(
                w.connection(),
                &scoped,
                report,
                &batch,
                &changed.to_string()
            )
            .is_err(),
            "{key}"
        );
    }
    let mut duplicate = raw.clone();
    duplicate["scopeEvidence"]
        .as_array_mut()
        .unwrap()
        .push(raw["scopeEvidence"][0].clone());
    assert!(r::accept(
        w.connection(),
        &scoped,
        report,
        &batch,
        &duplicate.to_string()
    )
    .is_err());
    let mut fabricated = raw.clone();
    fabricated["rows"][0]["sucursal_id"] = json!(scoped.branch_id);
    assert!(r::accept(
        w.connection(),
        &scoped,
        report,
        &batch,
        &fabricated.to_string()
    )
    .is_err());
    r::accept(w.connection(), &scoped, report, &batch, &raw.to_string()).unwrap();
    let rows = r::rows(w.connection(), &scoped, report, "devoluciones", 0).unwrap();
    let row = &rows["rows"][0];
    assert_eq!(row["effectStatus"], "UNKNOWN_LEGACY");
    assert!(row["limitations"]
        .as_array()
        .unwrap()
        .contains(&json!("REMOTE_SCOPE_FROM_SALE")));
    assert!(row["limitations"]
        .as_array()
        .unwrap()
        .contains(&json!("LOCAL_SCOPE_UNKNOWN")));
    assert_eq!(row["status"], "PARTIAL_OBSERVED_FIELDS");
    assert_eq!(
        w.connection()
            .query_row("SELECT count(*) FROM operation_journal", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}
#[test]
fn exact_observed_fields_are_not_receipts_and_money_is_never_rounded() {
    let local = json!({"id":"a","negocio_id":TENANT,"total":12.34,"metodo_pago":"fiado","sucursal_id":null,"estado_sincronizacion":1});
    let remote = json!({"id":"a","negocio_id":TENANT,"total":number("12.3400"),"metodo_pago":"fiado","sucursal_id":null});
    let row = r::compare("ventas", &local, Some(&remote)).unwrap();
    assert_eq!(row["status"], "MATCH_OBSERVED_FIELDS");
    assert_eq!(row["effectStatus"], "UNKNOWN_LEGACY");
    let mut bad = local.clone();
    bad["total"] = json!(12.345);
    assert!(
        r::compare("ventas", &bad, Some(&remote)).unwrap()["unverifiableFields"]
            .as_array()
            .unwrap()
            .contains(&json!("total"))
    );
    let mut changed = remote.clone();
    changed["total"] = json!({"$milliseconds":"12.34"});
    assert!(
        r::compare("ventas", &local, Some(&changed)).unwrap()["unverifiableFields"]
            .as_array()
            .unwrap()
            .contains(&json!("total"))
    );
    changed["total"] = number("12.35");
    assert_eq!(
        r::compare("ventas", &local, Some(&changed)).unwrap()["status"],
        "DIFFERENT_OBSERVED"
    );
    let mut unknown = local;
    unknown.as_object_mut().unwrap().remove("sucursal_id");
    assert!(
        r::compare("ventas", &unknown, Some(&remote)).unwrap()["limitations"]
            .as_array()
            .unwrap()
            .contains(&json!("LOCAL_SCOPE_UNKNOWN"))
    );
    let missing = r::compare("ventas", &unknown, None).unwrap();
    assert_eq!(missing["status"], "NOT_FOUND_AT_OBSERVATION");
    assert_eq!(missing["effectStatus"], "UNKNOWN_LEGACY");
}
#[test]
fn embedded_payments_subcents_and_unbounded_exponents_remain_unverifiable() {
    let local =
        json!({"id":"repair","negocio_id":TENANT,"pagos":[{"monto":12.345,"serial":"00001"}]});
    let remote = json!({"id":"repair","negocio_id":TENANT,"pagos":[{"monto":number("12.345"),"serial":"00001"}]});
    assert!(
        r::compare("reparaciones", &local, Some(&remote)).unwrap()["unverifiableFields"]
            .as_array()
            .unwrap()
            .contains(&json!("pagos"))
    );
    let local = json!({"id":"sale","negocio_id":TENANT,"total":1});
    let remote = json!({"id":"sale","negocio_id":TENANT,"total":number("1e-2147483648")});
    assert!(
        r::compare("ventas", &local, Some(&remote)).unwrap()["unverifiableFields"]
            .as_array()
            .unwrap()
            .contains(&json!("total"))
    );
}
#[test]
#[ignore = "Run after web-reconciliation-server.test.mjs emits actual PostgreSQL observations"]
fn actual_postgres_decimals_times_and_embedded_payments_compare_without_rounding() {
    let path =
        std::env::var("VENTARD_WEB_OBSERVATION_FIXTURE").expect("real PostgreSQL fixture required");
    let data: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let remote = &data["sale"]["rows"][0];
    let local = json!({"id":remote["id"],"negocio_id":TENANT,"sucursal_id":remote["sucursal_id"],"total":12.34,"metodo_pago":"fiado","numero_ticket":7,"ncf":"B0200000007","fecha_creacion":1791909500000u64,"estado_sincronizacion":0});
    assert_eq!(
        r::compare("ventas", &local, Some(remote)).unwrap()["status"],
        "MATCH_OBSERVED_FIELDS"
    );
    let debt = &data["debt"]["rows"][0];
    let local = json!({"id":debt["id"],"negocio_id":TENANT,"monto":12.34,"fecha_creacion":1791907200123u64});
    let result = r::compare("transacciones_fiado", &local, Some(debt)).unwrap();
    assert!(result["matchedFields"]
        .as_array()
        .unwrap()
        .contains(&json!("fecha_creacion")));
    assert_eq!(result["differentFields"], json!([]));
    let repair = &data["repair"]["rows"][0];
    let local =
        json!({"id":repair["id"],"negocio_id":TENANT,"pagos":[{"monto":12.34,"serial":"00001"}]});
    let result = r::compare("reparaciones", &local, Some(repair)).unwrap();
    assert!(result["matchedFields"]
        .as_array()
        .unwrap()
        .contains(&json!("pagos")));
    assert_eq!(result["effectStatus"], "UNKNOWN_LEGACY");
}
#[test]
fn durable_resume_never_replays_or_changes_the_original_browser_package() {
    let dir = Dir::new();
    let key = CipherKey::new([91; 32]);
    let mut w = VaultWriter::create_encrypted(&dir.0, &key).unwrap();
    let export = fixture(&mut w);
    let report = "98000001-0000-4000-8000-000000000001";
    let prepared = r::prepare(w.connection(), &ctx(), &export, report, "1791909500000").unwrap();
    assert_eq!(prepared["state"], "PENDING");
    assert_eq!(
        r::prepare(
            w.connection(),
            &ctx(),
            &export,
            "98000001-0000-4000-8000-000000000099",
            "1791909500000"
        )
        .unwrap_err()
        .code(),
        "WEB_RECONCILE_PENDING"
    );
    let before: String = w
        .connection()
        .query_row("SELECT body FROM legacy_web_packages_v1", [], |row| {
            row.get(0)
        })
        .unwrap();
    let batch = r::next(w.connection(), &ctx(), report).unwrap().unwrap();
    let raw = snapshot(&batch, json!([]));
    let first = r::accept(w.connection(), &ctx(), report, &batch, &raw).unwrap();
    assert_eq!(
        r::accept(w.connection(), &ctx(), report, &batch, &raw).unwrap(),
        first
    );
    let mut changed: Value = serde_json::from_str(&raw).unwrap();
    changed["capturedAtMs"] = json!("1791909600001");
    assert!(r::accept(w.connection(), &ctx(), report, &batch, &changed.to_string()).is_err());
    r::failure(w.connection(), &ctx(), report, "MIGRATION_REQUIRED").unwrap();
    drop(w);
    let mut w = VaultWriter::open_encrypted(&dir.0, &key).unwrap();
    assert!(r::next(w.connection(), &ctx(), report).unwrap().is_some());
    while let Some(batch) = r::next(w.connection(), &ctx(), report).unwrap() {
        let raw = snapshot(&batch, json!([]));
        r::accept(w.connection(), &ctx(), report, &batch, &raw).unwrap();
    }
    let view = r::view(w.connection(), &ctx(), &export).unwrap();
    assert_eq!(view["report"]["state"], "REVIEW_REQUIRED");
    assert_eq!(view["report"]["canActivate"], false);
    assert_eq!(view["report"]["coverage"], "REQUESTED_IDS_ONLY_WINDOWED");
    let after: String = w
        .connection()
        .query_row("SELECT body FROM legacy_web_packages_v1", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(after, before);
    let live: i64 = w
        .connection()
        .query_row("SELECT count(*) FROM operation_journal", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(live, 0);
}
#[test]
fn mismatched_context_rows_response_and_interrupted_write_do_not_finish_the_batch() {
    let dir = Dir::new();
    let mut w = VaultWriter::create_encrypted(&dir.0, &CipherKey::new([92; 32])).unwrap();
    let export = fixture(&mut w);
    let report = "98000001-0000-4000-8000-000000000002";
    r::prepare(w.connection(), &ctx(), &export, report, "1791909500000").unwrap();
    let batch = r::next(w.connection(), &ctx(), report).unwrap().unwrap();
    let raw = snapshot(&batch, json!([]));
    let mut other = ctx();
    other.actor_id = "96000003-0000-4000-8000-000000000002".into();
    assert!(r::next(w.connection(), &other, report).is_err());
    let mut value: Value = serde_json::from_str(&raw).unwrap();
    value["scope"].as_object_mut().unwrap().remove("branchId");
    assert!(r::accept(w.connection(), &ctx(), report, &batch, &value.to_string()).is_err());
    value = serde_json::from_str(&raw).unwrap();
    value["rows"] = json!([{"id":batch.ids[0],"negocio_id":TENANT,"precio_venta":12.34}]);
    assert!(r::accept(w.connection(), &ctx(), report, &batch, &value.to_string()).is_err());
    value = serde_json::from_str(&raw).unwrap();
    value["rows"] = json!([{"id":"not-requested","negocio_id":TENANT}]);
    assert!(r::accept(w.connection(), &ctx(), report, &batch, &value.to_string()).is_err());
    value = serde_json::from_str(&raw).unwrap();
    value["tenantId"] = json!("96000000-0000-4000-8000-000000000002");
    assert!(r::accept(w.connection(), &ctx(), report, &batch, &value.to_string()).is_err());
    w.connection().execute_batch("CREATE TEMP TRIGGER reconcile_fail BEFORE UPDATE ON legacy_web_reconciliations_v1 BEGIN SELECT RAISE(ABORT,'fixture interrupted'); END;").unwrap();
    assert!(r::accept(w.connection(), &ctx(), report, &batch, &raw).is_err());
    let n: i64 = w
        .connection()
        .query_row(
            "SELECT count(*) FROM legacy_web_observations_v1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(n, 0);
    assert_eq!(
        r::next(w.connection(), &ctx(), report).unwrap().unwrap(),
        batch
    );
    w.connection()
        .execute_batch("DROP TRIGGER reconcile_fail")
        .unwrap();
    r::accept(w.connection(), &ctx(), report, &batch, &raw).unwrap();
}
