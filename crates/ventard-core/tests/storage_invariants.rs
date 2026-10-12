#![cfg(feature = "fixture-storage")]

use rusqlite::Connection;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;
use ventard_core::application::operations::{
    execute_prepared_operation, get_operation_result, prepare_operation,
};
use ventard_core::domain::canonical::canonicalize;
use ventard_core::storage::writer::VaultWriter;

struct FixtureDir(PathBuf);
impl FixtureDir {
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("ventard-native-fixture-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for FixtureDir {
    fn drop(&mut self) {
        // Exclusivamente un directorio sintético creado por este test.
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn required_pragmas_are_effective_and_reopen_preserves_schema() {
    let dir = FixtureDir::new();
    let mut writer = VaultWriter::open(&dir.0).unwrap();
    let conn = writer.connection();
    let journal: String = conn
        .query_row("PRAGMA journal_mode", [], |r| r.get(0))
        .unwrap();
    let synchronous: i64 = conn
        .query_row("PRAGMA synchronous", [], |r| r.get(0))
        .unwrap();
    let fk: i64 = conn
        .query_row("PRAGMA foreign_keys", [], |r| r.get(0))
        .unwrap();
    assert_eq!(journal, "wal");
    assert_eq!((synchronous, fk), (2, 1));
    drop(writer);
    assert!(VaultWriter::open(&dir.0).is_ok());
}

#[test]
fn second_writer_is_rejected_and_lock_is_released_on_drop() {
    let dir = FixtureDir::new();
    let writer = VaultWriter::open(&dir.0).unwrap();
    assert!(VaultWriter::open(&dir.0).is_err());
    drop(writer);
    assert!(VaultWriter::open(&dir.0).is_ok());
}

#[test]
fn schema_newer_than_the_binary_is_rejected_without_losing_rows() {
    let dir = FixtureDir::new();
    let conn = Connection::open(dir.0.join("pos_core.db")).unwrap();
    conn.execute_batch("CREATE TABLE probe(value TEXT); INSERT INTO probe VALUES('preserve'); PRAGMA user_version=999;").unwrap();
    drop(conn);
    assert!(
        VaultWriter::open(&dir.0).is_err(),
        "no escribir con un binario incompatible"
    );
    let conn = Connection::open(dir.0.join("pos_core.db")).unwrap();
    let value: String = conn
        .query_row("SELECT value FROM probe", [], |r| r.get(0))
        .unwrap();
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap();
    assert_eq!(value, "preserve");
    assert_eq!(version, 999);
}

#[test]
fn applied_migrations_have_a_persisted_checksum_and_tampering_blocks_open() {
    let dir = FixtureDir::new();
    let mut writer = VaultWriter::open(&dir.0).unwrap();
    let history: i64 = writer
        .connection()
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='migration_history'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(history, 1, "falta historial persistente de checksums");
    writer
        .connection()
        .execute(
            "UPDATE migration_history SET checksum=?1 WHERE version=1",
            ["0".repeat(64)],
        )
        .unwrap();
    drop(writer);
    assert!(
        VaultWriter::open(&dir.0).is_err(),
        "no aceptar migración histórica alterada"
    );
}

#[test]
fn an_untracked_old_schema_is_not_accepted_or_repaired_silently() {
    let dir = FixtureDir::new();
    let conn = Connection::open(dir.0.join("pos_core.db")).unwrap();
    conn.execute_batch(include_str!("../migrations/0001_core.sql"))
        .unwrap();
    conn.execute_batch("PRAGMA user_version=1;").unwrap();
    drop(conn);
    assert!(
        VaultWriter::open(&dir.0).is_err(),
        "el borrador anterior no tiene prueba de migración aplicada"
    );
}

#[test]
fn schema_ddl_can_be_replayed_without_mutation_or_duplicate_indexes() {
    let conn = Connection::open_in_memory().unwrap();
    let sql = include_str!("../migrations/0001_core.sql");
    conn.execute_batch(sql).unwrap();
    assert!(
        conn.execute_batch(sql).is_ok(),
        "índices también deben ser idempotentes"
    );
}

struct OwnedChild(Child);
impl Drop for OwnedChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn fixture_child(dir: &FixtureDir, mode: &str) -> OwnedChild {
    let mut child = OwnedChild(
        Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "fixture_process_owner", "--nocapture"])
            .env("VENTARD_NATIVE_FIXTURE_CHILD", &dir.0)
            .env("VENTARD_NATIVE_FIXTURE_MODE", mode)
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    let stdout = child.0.stdout.take().unwrap();
    let (ready, wait) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if line.contains("FIXTURE_READY") {
                let _ = ready.send(());
                break;
            }
        }
    });
    wait.recv_timeout(Duration::from_secs(20))
        .expect("child no alcanzó la frontera esperada");
    child
}

const PROCESS_OP: &str = "96000000-0000-4000-8000-000000000801";
fn fixture_intent() -> (String, String) {
    canonicalize(format!(r#"{{"operationId":"{PROCESS_OP}","totalCents":"11800"}}"#).as_bytes())
        .unwrap()
}

#[test]
fn fixture_process_owner() {
    let Some(path) = std::env::var_os("VENTARD_NATIVE_FIXTURE_CHILD") else {
        return;
    };
    let path = PathBuf::from(path).canonicalize().unwrap();
    let temp = std::env::temp_dir().canonicalize().unwrap();
    assert!(path.starts_with(temp));
    assert!(path
        .file_name()
        .unwrap()
        .to_string_lossy()
        .starts_with("ventard-native-fixture-"));
    let mut writer = VaultWriter::open(&path).unwrap();
    let (canonical, hash) = fixture_intent();
    writer
        .connection()
        .execute_batch("CREATE TABLE fixture_process_effect(value INTEGER);")
        .unwrap();
    prepare_operation(
        writer.connection(),
        PROCESS_OP,
        "ventard.native.v1",
        "SALE_CONFIRM",
        1,
        canonical.as_bytes(),
        &hash,
        "96000000-0000-4000-8000-000000000802",
        "GLOBAL",
        "96000000-0000-4000-8000-000000000803",
        1,
        "1700000000000",
    )
    .unwrap();
    let partial = std::env::var("VENTARD_NATIVE_FIXTURE_MODE").unwrap() == "partial";
    execute_prepared_operation(writer.connection(), PROCESS_OP, &hash, |tx| {
        tx.execute("INSERT INTO fixture_process_effect VALUES(1)", [])?;
        if partial {
            println!("FIXTURE_READY");
            std::io::stdout().flush().unwrap();
            loop {
                std::thread::sleep(Duration::from_millis(50));
            }
        }
        Ok(serde_json::json!({"ticket":"QA-process", "totalCents":"11800"}))
    })
    .unwrap();
    println!("FIXTURE_READY");
    std::io::stdout().flush().unwrap();
    loop {
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn killed_owner_releases_os_lock_and_committed_result_survives() {
    let dir = FixtureDir::new();
    let child = fixture_child(&dir, "committed");
    assert!(
        VaultWriter::open(&dir.0).is_err(),
        "otro proceso sostiene el lock"
    );
    drop(child); // Terminar el proceso propio, no un apagón físico.
    let mut writer = VaultWriter::open(&dir.0).unwrap();
    let (_, hash) = fixture_intent();
    assert_eq!(
        get_operation_result(writer.connection(), PROCESS_OP, &hash).unwrap(),
        Some(serde_json::json!({"ticket":"QA-process", "totalCents":"11800"}))
    );
    let repeated = execute_prepared_operation(writer.connection(), PROCESS_OP, &hash, |_| {
        panic!("no repetir después de kill")
    })
    .unwrap();
    assert_eq!(repeated["ticket"], "QA-process");
    let count: i64 = writer
        .connection()
        .query_row("SELECT count(*) FROM fixture_process_effect", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(count, 1);
}

#[test]
fn killed_process_mid_transaction_leaves_no_partial_effect_or_false_commit() {
    let dir = FixtureDir::new();
    let child = fixture_child(&dir, "partial");
    drop(child);
    let mut writer = VaultWriter::open(&dir.0).unwrap();
    let (_, hash) = fixture_intent();
    assert_eq!(
        get_operation_result(writer.connection(), PROCESS_OP, &hash).unwrap(),
        None
    );
    let count: i64 = writer
        .connection()
        .query_row("SELECT count(*) FROM fixture_process_effect", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(count, 0);
}
