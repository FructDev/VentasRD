#![cfg(feature = "encrypted-storage")]
use serde_json::json;
use ventard_core::storage::{cipher::CipherKey, legacy_web as web, writer::VaultWriter};
const TENANT: &str = "96000000-0000-4000-8000-000000000001";
#[test]
fn browser_schema_24_preserves_shared_journal_bytes_without_replaying_them() {
    use sha2::{Digest, Sha256};
    let mut body: serde_json::Value = serde_json::from_str(fixture().raw_body()).unwrap();
    body["schemaVersion"] = json!(24);
    for name in web::SHARED_TABLES {
        let rows = if name == "shared_outbox" { json!([{"id":"shared-fixture/op","state":"UNCERTAIN","wire":{"intent":"original exact bytes"}}]) } else { json!([]) };
        let text = rows.to_string();
        body["tables"].as_array_mut().unwrap().push(json!({"name":name,"count":rows.as_array().unwrap().len(),"rowsJson":text,"sha256":format!("{:x}",Sha256::digest(text.as_bytes()))}));
    }
    let package = web::parse(body.to_string()).unwrap();
    let dir = Dir::new();
    let mut writer = VaultWriter::create_encrypted(&dir.0, &CipherKey::new([0x76;32])).unwrap();
    let summary = web::store(writer.connection(), TENANT, &package).unwrap();
    assert_eq!(summary["canActivate"], false);
    assert_eq!(web::rows(writer.connection(), TENANT, package.export_id(), "shared_outbox", 0).unwrap()["rows"][0]["wire"]["intent"], "original exact bytes");
    let live: i64 = writer.connection().query_row("SELECT count(*) FROM operation_journal", [], |r| r.get(0)).unwrap();
    assert_eq!(live, 0);
    body["tables"].as_array_mut().unwrap().pop();
    assert!(web::parse(body.to_string()).is_err());
}
fn fixture() -> web::Package {
    web::decrypt(
        include_bytes!("fixtures/legacy-web-v1.vrweb"),
        include_bytes!("fixtures/legacy-web-v1.vrwebkey"),
    )
    .unwrap()
}
struct Dir(std::path::PathBuf);
impl Dir {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!(
            "ventard-web-import-fixture-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir(&p).unwrap();
        Self(p)
    }
}
impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
#[test]
fn webcrypto_file_authenticated_and_raw_bytes_preserved_without_replay() {
    let dir = Dir::new();
    let key = CipherKey::new([0x73; 32]);
    let mut w = VaultWriter::create_encrypted(&dir.0, &key).unwrap();
    let p = fixture();
    let result = web::store(w.connection(), TENANT, &p).unwrap();
    assert_eq!(result["state"], "PRESERVED_REVIEW_REQUIRED");
    assert_eq!(result["writersStopped"], false);
    assert_eq!(result["counts"]["ventas"], 1);
    assert_eq!(result["pendingRows"], 2);
    let row = web::rows(w.connection(), TENANT, p.export_id(), "ventas", 0).unwrap();
    assert_eq!(row["rows"][0]["total"], json!(12.34));
    assert_eq!(row["rows"][0]["id"], "sale-qa");
    assert_eq!(row["rows"][0]["ncf"], "B0200000007");
    assert_eq!(row["rows"][0]["estado_sincronizacion"], 0);
    let live: i64 = w
        .connection()
        .query_row("SELECT count(*) FROM operation_journal", [], |r| r.get(0))
        .unwrap();
    assert_eq!(live, 0);
    assert_eq!(web::store(w.connection(), TENANT, &p).unwrap(), result);
    drop(w);
    let mut w = VaultWriter::open_encrypted(&dir.0, &key).unwrap();
    assert_eq!(
        web::list(w.connection(), TENANT).unwrap()["rows"][0],
        result
    );
    let body: String = w
        .connection()
        .query_row("SELECT body FROM legacy_web_packages_v1", [], |r| r.get(0))
        .unwrap();
    assert_eq!(body, p.raw_body());
    let disk = std::fs::read(dir.0.join("pos_core.db")).unwrap();
    assert!(!disk.windows(7).any(|w| w == b"sale-qa"));
}
#[test]
fn rejects_tamper_wrong_key_counts_hashes_identity_and_source_conflict() {
    let mut bytes = include_bytes!("fixtures/legacy-web-v1.vrweb").to_vec();
    bytes[30] ^= 1;
    assert_eq!(
        web::decrypt(&bytes, include_bytes!("fixtures/legacy-web-v1.vrwebkey"))
            .err()
            .unwrap()
            .code(),
        "WEB_IMPORT_KEY_INVALID"
    );
    let mut key = include_bytes!("fixtures/legacy-web-v1.vrwebkey").to_vec();
    key[10] ^= 1;
    assert!(web::decrypt(include_bytes!("fixtures/legacy-web-v1.vrweb"), &key).is_err());
    let dir = Dir::new();
    let mut w = VaultWriter::create_encrypted(&dir.0, &CipherKey::new([0x74; 32])).unwrap();
    let p = fixture();
    assert_eq!(
        web::store(w.connection(), "other", &p).unwrap_err().code(),
        "WEB_IMPORT_TENANT_MISMATCH"
    );
    let mut v: serde_json::Value = serde_json::from_str(p.raw_body()).unwrap();
    v["tables"][17]["count"] = json!(2);
    assert!(web::parse(v.to_string()).is_err());
    v = serde_json::from_str(p.raw_body()).unwrap();
    v["tables"][17]["sha256"] = json!("0".repeat(64));
    assert!(web::parse(v.to_string()).is_err());
    web::store(w.connection(), TENANT, &p).unwrap();
    v = serde_json::from_str(p.raw_body()).unwrap();
    v["profileAlias"] = json!("Changed profile");
    let other = web::parse(v.to_string()).unwrap();
    assert_eq!(
        web::store(w.connection(), TENANT, &other)
            .unwrap_err()
            .code(),
        "WEB_IMPORT_ID_CONFLICT"
    );
    assert_eq!(
        web::list(w.connection(), TENANT).unwrap()["rows"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert!(web::rows(w.connection(), "other", p.export_id(), "ventas", 0).is_err());
    assert!(web::rows(w.connection(), TENANT, p.export_id(), "sqlite_master", 0).is_err());
    w.connection()
        .execute(
            "UPDATE legacy_web_tables_v1 SET rows_json='[]' WHERE table_name='ventas'",
            [],
        )
        .unwrap();
    assert_eq!(
        web::rows(w.connection(), TENANT, p.export_id(), "ventas", 0)
            .unwrap_err()
            .code(),
        "WEB_IMPORT_INVALID"
    );
}
#[test]
fn interrupted_insert_rolls_back_and_resume_is_exact() {
    let dir = Dir::new();
    let mut w = VaultWriter::create_encrypted(&dir.0, &CipherKey::new([0x75; 32])).unwrap();
    let p = fixture();
    w.connection().execute_batch("CREATE TEMP TRIGGER fail_migration BEFORE INSERT ON legacy_web_tables_v1 WHEN NEW.table_name='ventas' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;").unwrap();
    assert!(web::store(w.connection(), TENANT, &p).is_err());
    let n: i64 = w
        .connection()
        .query_row("SELECT count(*) FROM legacy_web_packages_v1", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(n, 0);
    w.connection()
        .execute_batch("DROP TRIGGER fail_migration")
        .unwrap();
    web::store(w.connection(), TENANT, &p).unwrap();
    let n: i64 = w
        .connection()
        .query_row("SELECT count(*) FROM legacy_web_tables_v1", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(n, 18);
}
#[test]
fn older_browser_versions_preserve_existing_tables_without_inventing_metadata() {
    for version in [21, 22] {
        let p = fixture();
        let mut value: serde_json::Value = serde_json::from_str(p.raw_body()).unwrap();
        value["schemaVersion"] = json!(version);
        value["tables"].as_array_mut().unwrap().retain(|t| {
            t["name"] != "operaciones_locales"
                && (version == 22 || t["name"] != "inventario_sync_cursors")
        });
        assert!(web::parse(value.to_string()).is_ok());
    }
}
