#![cfg(feature = "encrypted-storage")]

use rusqlite::{backup::Backup, Connection, OpenFlags};
use sha2::{Digest, Sha256};
use std::{path::PathBuf, time::Duration};
use ventard_core::application::operations::{
    execute_prepared_operation, get_operation_result, prepare_operation,
};
use ventard_core::domain::canonical::canonicalize;
use ventard_core::storage::{
    cipher::CipherKey,
    writer::{StorageError, VaultWriter, WriterActor},
};

// Sólo datos/llaves sintéticas; ninguna llave real, cuenta o dato de clientes.
struct FixtureDir(PathBuf);
impl FixtureDir {
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("ventard-cipher-fixture-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn bytes(&self) -> Vec<u8> {
        std::fs::read(self.0.join("pos_core.db")).unwrap()
    }
    fn digest(&self) -> Vec<u8> {
        Sha256::digest(self.bytes()).to_vec()
    }
}
impl Drop for FixtureDir {
    fn drop(&mut self) {
        // Únicamente este directorio UUID creado por el test.
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn key() -> CipherKey {
    CipherKey::new([0x5a; 32])
}
fn probe(writer: &mut VaultWriter) {
    writer
        .connection()
        .execute_batch("CREATE TABLE cipher_probe(value TEXT) STRICT;")
        .unwrap();
    writer
        .connection()
        .execute(
            "INSERT INTO cipher_probe VALUES(?1)",
            ["synthetic-secret-marker-ventard-2026"],
        )
        .unwrap();
}
fn read_probe(writer: &mut VaultWriter) -> String {
    writer
        .connection()
        .query_row("SELECT value FROM cipher_probe", [], |r| r.get(0))
        .unwrap()
}

#[test]
fn cipher_binding_exposes_real_runtime_values() {
    let c = Connection::open_in_memory().unwrap();
    c.execute_batch("PRAGMA cipher_log_level=NONE; PRAGMA key='synthetic-test-only'; PRAGMA cipher_memory_security=ON;").unwrap();
    for query in [
        "PRAGMA cipher_version",
        "SELECT sqlite_version()",
        "SELECT sqlite_source_id()",
        "PRAGMA cipher_provider",
        "PRAGMA cipher_provider_version",
        "PRAGMA cipher_memory_security",
    ] {
        let value: rusqlite::types::Value = c.query_row(query, [], |r| r.get(0)).unwrap();
        println!("{query} = {value:?}");
    }
    println!("VERSION_NUMBER = {}", rusqlite::version_number());
}

#[test]
fn linked_cipher_engine_and_durability_are_observed_not_inferred_from_crate_version() {
    let dir = FixtureDir::new();
    let mut writer = VaultWriter::create_encrypted(&dir.0, &key()).unwrap();
    let c = writer.connection();
    let cipher: String = c
        .query_row("PRAGMA cipher_version", [], |r| r.get(0))
        .unwrap();
    let engine: String = c
        .query_row("SELECT sqlite_version()", [], |r| r.get(0))
        .unwrap();
    let source: String = c
        .query_row("SELECT sqlite_source_id()", [], |r| r.get(0))
        .unwrap();
    let provider: String = c
        .query_row("PRAGMA cipher_provider", [], |r| r.get(0))
        .unwrap();
    let provider_version: String = c
        .query_row("PRAGMA cipher_provider_version", [], |r| r.get(0))
        .unwrap();
    println!("SQLCIPHER={cipher}; SQLITE={engine}; SOURCE_ID={source}; PROVIDER={provider}; PROVIDER_VERSION={provider_version}");
    assert!(!cipher.is_empty());
    assert_eq!(
        engine, "3.51.3",
        "cambio de motor requiere revisión del gate WAL y manifest"
    );
    assert_eq!(provider, "openssl");
    let wal: String = c
        .query_row("PRAGMA journal_mode", [], |r| r.get(0))
        .unwrap();
    let sync: i64 = c.query_row("PRAGMA synchronous", [], |r| r.get(0)).unwrap();
    let fk: i64 = c
        .query_row("PRAGMA foreign_keys", [], |r| r.get(0))
        .unwrap();
    let memory: String = c
        .query_row("PRAGMA cipher_memory_security", [], |r| r.get(0))
        .unwrap();
    let log_level: String = c
        .query_row("PRAGMA cipher_log_level", [], |r| r.get(0))
        .unwrap();
    let cipher_status: String = c
        .query_row("PRAGMA cipher_status", [], |r| r.get(0))
        .unwrap();
    assert_eq!(
        (wal.as_str(), sync, fk, memory.as_str()),
        ("wal", 2, 1, "1")
    );
    assert_eq!(log_level, "NONE", "sin logs SQL internos no sanitizados");
    assert_eq!(cipher_status, "1", "handle realmente cifrado");
}

#[test]
fn database_and_live_wal_are_encrypted_and_same_key_reopens_durable_rows() {
    let dir = FixtureDir::new();
    let mut writer = VaultWriter::create_encrypted(&dir.0, &key()).unwrap();
    probe(&mut writer);
    for path in [dir.0.join("pos_core.db"), dir.0.join("pos_core.db-wal")] {
        let bytes = std::fs::read(path).unwrap();
        assert!(!bytes.starts_with(b"SQLite format 3\0"));
        assert!(!bytes
            .windows(36)
            .any(|b| b == b"synthetic-secret-marker-ventard-2026"));
    }
    drop(writer);
    let unkeyed =
        Connection::open_with_flags(dir.0.join("pos_core.db"), OpenFlags::SQLITE_OPEN_READ_ONLY)
            .unwrap();
    assert!(unkeyed
        .query_row("SELECT count(*) FROM sqlite_master", [], |r| r
            .get::<_, i64>(0))
        .is_err());
    drop(unkeyed);
    let mut reopened = VaultWriter::open_encrypted(&dir.0, &key()).unwrap();
    assert_eq!(
        read_probe(&mut reopened),
        "synthetic-secret-marker-ventard-2026"
    );
}

#[test]
fn wrong_key_does_not_mutate_or_replace_existing_vault() {
    let dir = FixtureDir::new();
    let mut writer = VaultWriter::create_encrypted(&dir.0, &key()).unwrap();
    probe(&mut writer);
    drop(writer);
    let before = dir.digest();
    assert!(matches!(
        VaultWriter::open_encrypted(&dir.0, &CipherKey::new([0x6b; 32])),
        Err(StorageError::CipherKeyRejected)
    ));
    assert_eq!(dir.digest(), before);
    let mut reopened = VaultWriter::open_encrypted(&dir.0, &key()).unwrap();
    assert_eq!(
        read_probe(&mut reopened),
        "synthetic-secret-marker-ventard-2026"
    );
}

#[test]
fn open_existing_never_creates_missing_or_adopts_empty_or_plaintext_database() {
    let missing = FixtureDir::new();
    assert!(matches!(
        VaultWriter::open_encrypted(&missing.0, &key()),
        Err(StorageError::VaultMissing)
    ));
    assert!(!missing.0.join("pos_core.db").exists());
    let empty = FixtureDir::new();
    std::fs::File::create(empty.0.join("pos_core.db")).unwrap();
    assert!(VaultWriter::open_encrypted(&empty.0, &key()).is_err());
    assert_eq!(empty.bytes().len(), 0);
    let plaintext = FixtureDir::new();
    let c = Connection::open(plaintext.0.join("pos_core.db")).unwrap();
    c.execute_batch(
        "CREATE TABLE plaintext_probe(value TEXT); INSERT INTO plaintext_probe VALUES('preserve');",
    )
    .unwrap();
    drop(c);
    let before = plaintext.digest();
    assert!(matches!(
        VaultWriter::open_encrypted(&plaintext.0, &key()),
        Err(StorageError::PlaintextVaultRejected)
    ));
    assert_eq!(plaintext.digest(), before);
}

#[test]
fn create_new_never_overwrites_existing_ciphertext() {
    let dir = FixtureDir::new();
    drop(VaultWriter::create_encrypted(&dir.0, &key()).unwrap());
    let before = dir.digest();
    assert!(matches!(
        VaultWriter::create_encrypted(&dir.0, &key()),
        Err(StorageError::VaultExists)
    ));
    assert_eq!(dir.digest(), before);
}

#[test]
fn orphan_wal_prevents_creation_of_a_falsely_empty_vault() {
    let dir = FixtureDir::new();
    let wal = dir.0.join("pos_core.db-wal");
    std::fs::write(&wal, b"synthetic-orphan-not-a-real-wal").unwrap();
    assert!(matches!(
        VaultWriter::create_encrypted(&dir.0, &key()),
        Err(StorageError::VaultExists)
    ));
    assert!(!dir.0.join("pos_core.db").exists());
    assert_eq!(
        std::fs::read(wal).unwrap(),
        b"synthetic-orphan-not-a-real-wal"
    );
}

#[test]
fn cipher_writer_actor_keeps_exclusive_ownership_and_reopens_after_shutdown() {
    let dir = FixtureDir::new();
    let actor = WriterActor::create_encrypted(&dir.0, key()).unwrap();
    assert!(WriterActor::open_encrypted(&dir.0, key()).is_err());
    actor.transaction(|tx| { tx.execute_batch("CREATE TABLE cipher_actor(value INTEGER) STRICT; INSERT INTO cipher_actor VALUES(42);")?; Ok(()) }).unwrap();
    drop(actor);
    let actor = WriterActor::open_encrypted(&dir.0, key()).unwrap();
    let value: i64 = actor
        .call(|c| Ok(c.query_row("SELECT value FROM cipher_actor", [], |r| r.get(0))?))
        .unwrap();
    assert_eq!(value, 42);
}

#[test]
fn cipher_schema_checksum_failure_preserves_the_existing_database() {
    let dir = FixtureDir::new();
    let mut writer = VaultWriter::create_encrypted(&dir.0, &key()).unwrap();
    writer
        .connection()
        .execute("UPDATE migration_history SET checksum=?1", ["0".repeat(64)])
        .unwrap();
    drop(writer);
    let before = dir.digest();
    assert!(VaultWriter::open_encrypted(&dir.0, &key()).is_err());
    assert_eq!(dir.digest(), before);
}

#[test]
fn encrypted_online_snapshot_can_be_reopened_in_another_directory_with_another_key() {
    // Spike del binding, NO backup comercial VERIFIED ni activación/clonado de writer.
    let source = FixtureDir::new();
    let candidate = FixtureDir::new();
    let mut writer = VaultWriter::create_encrypted(&source.0, &key()).unwrap();
    probe(&mut writer); // dato permanece en WAL al iniciar snapshot; no copiar el .db vivo.
    let (_, hash) = prepare_fixture(&mut writer);
    let candidate_key = CipherKey::new([0x7c; 32]);
    let mut snapshot = VaultWriter::create_encrypted(&candidate.0, &candidate_key).unwrap();
    let backup = Backup::new(writer.connection(), snapshot.connection()).unwrap();
    backup
        .run_to_completion(64, Duration::from_millis(1), None)
        .unwrap();
    drop(backup);
    assert_eq!(read_probe(&mut snapshot), read_probe(&mut writer));
    let integrity: String = snapshot
        .connection()
        .query_row("PRAGMA integrity_check", [], |r| r.get(0))
        .unwrap();
    assert_eq!(integrity, "ok");
    let mut check = snapshot
        .connection()
        .prepare("PRAGMA cipher_integrity_check")
        .unwrap();
    assert_eq!(
        check
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .count(),
        0
    );
    drop(check);
    drop(snapshot);
    assert!(VaultWriter::open_encrypted(&candidate.0, &key()).is_err());
    let mut reopened = VaultWriter::open_encrypted(&candidate.0, &candidate_key).unwrap();
    assert_eq!(
        read_probe(&mut reopened),
        "synthetic-secret-marker-ventard-2026"
    );
    assert_eq!(
        get_operation_result(reopened.connection(), PROCESS_OP, &hash).unwrap(),
        None
    );
    let restored: (String, Vec<u8>) = reopened
        .connection()
        .query_row(
            "SELECT hash,canonical_bytes FROM operation_journal WHERE operation_id=?1",
            [PROCESS_OP],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    let (canonical, _) = fixture_intent();
    assert_eq!(
        restored,
        (hash, canonical.into_bytes()),
        "pending conserva identidad/bytes, no se inventa recibo"
    );
}

const PROCESS_OP: &str = "96000000-0000-4000-8000-000000000901";
fn fixture_intent() -> (String, String) {
    canonicalize(format!(r#"{{"operationId":"{PROCESS_OP}","totalCents":"11800"}}"#).as_bytes())
        .unwrap()
}
fn prepare_fixture(writer: &mut VaultWriter) -> (String, String) {
    let (canonical, hash) = fixture_intent();
    prepare_operation(
        writer.connection(),
        PROCESS_OP,
        "ventard.native.v1",
        "SALE_CONFIRM",
        1,
        canonical.as_bytes(),
        &hash,
        "96000000-0000-4000-8000-000000000902",
        "GLOBAL",
        "96000000-0000-4000-8000-000000000903",
        1,
        "1700000000000",
    )
    .unwrap();
    (canonical, hash)
}

struct OwnedChild(std::process::Child);
impl Drop for OwnedChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
fn fixture_child(dir: &FixtureDir, mode: &str) -> OwnedChild {
    use std::io::{BufRead, BufReader};
    use std::process::{Command, Stdio};
    let mut child = OwnedChild(
        Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "cipher_process_owner", "--nocapture"])
            .env("VENTARD_CIPHER_FIXTURE_CHILD", &dir.0)
            .env("VENTARD_CIPHER_FIXTURE_MODE", mode)
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    let stdout = child.0.stdout.take().unwrap();
    let (ready, wait) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if line.contains("CIPHER_FIXTURE_READY") {
                let _ = ready.send(());
                break;
            }
        }
    });
    wait.recv_timeout(Duration::from_secs(20))
        .expect("child no llegó a frontera de commit");
    child
}

#[test]
fn cipher_process_owner() {
    use std::io::Write;
    let Some(path) = std::env::var_os("VENTARD_CIPHER_FIXTURE_CHILD") else {
        return;
    };
    let path = PathBuf::from(path).canonicalize().unwrap();
    assert!(path.starts_with(std::env::temp_dir().canonicalize().unwrap()));
    assert!(path
        .file_name()
        .unwrap()
        .to_string_lossy()
        .starts_with("ventard-cipher-fixture-"));
    let mut writer = VaultWriter::create_encrypted(&path, &key()).unwrap();
    writer
        .connection()
        .execute_batch("CREATE TABLE cipher_effect(value INTEGER) STRICT;")
        .unwrap();
    let (_, hash) = prepare_fixture(&mut writer);
    let partial = std::env::var("VENTARD_CIPHER_FIXTURE_MODE").unwrap() == "partial";
    execute_prepared_operation(writer.connection(), PROCESS_OP, &hash, |tx| {
        tx.execute("INSERT INTO cipher_effect VALUES(1)", [])?;
        if partial {
            println!("CIPHER_FIXTURE_READY");
            std::io::stdout().flush().unwrap();
            loop {
                std::thread::sleep(Duration::from_millis(50));
            }
        }
        Ok(serde_json::json!({"ticket":"QA-cipher", "totalCents":"11800"}))
    })
    .unwrap();
    println!("CIPHER_FIXTURE_READY");
    std::io::stdout().flush().unwrap();
    loop {
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn killed_cipher_owner_releases_lock_and_replay_recovers_committed_result_once() {
    let dir = FixtureDir::new();
    let child = fixture_child(&dir, "committed");
    assert!(VaultWriter::open_encrypted(&dir.0, &key()).is_err());
    drop(child); // Termina sólo el proceso hijo sintético; NO apagón real.
    let mut writer = VaultWriter::open_encrypted(&dir.0, &key()).unwrap();
    let (_, hash) = fixture_intent();
    for _ in 0..100 {
        let result = execute_prepared_operation(writer.connection(), PROCESS_OP, &hash, |_| {
            panic!("no duplicar efecto")
        })
        .unwrap();
        assert_eq!(result["ticket"], "QA-cipher");
    }
    let count: i64 = writer
        .connection()
        .query_row("SELECT count(*) FROM cipher_effect", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 1);
}

#[test]
fn killed_cipher_process_mid_transaction_leaves_prepared_intent_without_partial_effect() {
    let dir = FixtureDir::new();
    let child = fixture_child(&dir, "partial");
    drop(child);
    let mut writer = VaultWriter::open_encrypted(&dir.0, &key()).unwrap();
    let (_, hash) = fixture_intent();
    assert_eq!(
        get_operation_result(writer.connection(), PROCESS_OP, &hash).unwrap(),
        None
    );
    let count: i64 = writer
        .connection()
        .query_row("SELECT count(*) FROM cipher_effect", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 0);
}
