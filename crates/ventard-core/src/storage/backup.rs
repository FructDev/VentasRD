//! Portable SQLCipher snapshot and separate recovery key file. Native Rust only.
//! Restored archives are query-only; recovering an OS key never replaces a DB.
use super::{
    cipher::{self, CipherKey},
    migrations,
    writer::VaultWriter,
};
use crate::{
    domain::{canonical::canonicalize, identity::EntityId},
    security::{
        key_provider::KeyBinding,
        recovery_enrollment::{recover_key, seal_recovery_key, RecoverySecret},
    },
};
use base64::{engine::general_purpose::STANDARD, Engine};
use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    XChaCha20Poly1305, XNonce,
};
use rusqlite::{backup::Backup, Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{Read, Seek, Write},
    path::{Path, PathBuf},
    time::Duration,
};
use zeroize::Zeroizing;
const MAGIC: &[u8; 8] = b"VRBKP001";
const KEY_MAGIC: &[u8; 8] = b"VRKEYR01";
const MAX_DB: u64 = 2 * 1024 * 1024 * 1024;
const MAX_HEADER: usize = 65536;
#[derive(Debug, Clone, Copy)]
pub struct BackupError(&'static str);
impl BackupError {
    pub fn code(self) -> &'static str {
        self.0
    }
}
impl From<std::io::Error> for BackupError {
    fn from(_: std::io::Error) -> Self {
        err("BACKUP_IO")
    }
}
impl From<rusqlite::Error> for BackupError {
    fn from(_: rusqlite::Error) -> Self {
        err("BACKUP_DATABASE_INVALID")
    }
}
fn err(code: &'static str) -> BackupError {
    BackupError(code)
}
fn invalid() -> BackupError {
    err("BACKUP_INVALID")
}
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Source {
    #[serde(default)]
    pub local_anchor_hash: Option<String>,
    pub tenant_id: String,
    pub vault_id: String,
    pub installation_id: String,
    pub device_id: String,
    pub actor_id: String,
    pub writer_epoch: String,
    pub scope_type: String,
    pub branch_id: Option<String>,
    pub key_version: u32,
    pub captured_at_ms: String,
}
impl Source {
    pub fn binding(&self) -> Result<KeyBinding, BackupError> {
        self.validate()?;
        KeyBinding::new(
            EntityId::parse(&self.tenant_id).map_err(|_| invalid())?,
            EntityId::parse(&self.vault_id).map_err(|_| invalid())?,
            EntityId::parse(&self.installation_id).map_err(|_| invalid())?,
            self.key_version,
        )
        .map_err(|_| invalid())
    }
    pub fn same_identity(&self, other: &Self) -> bool {
        let mut a = self.clone();
        a.captured_at_ms = other.captured_at_ms.clone();
        a == *other
    }
    pub fn validate(&self) -> Result<(), BackupError> {
        if self.local_anchor_hash.as_ref().is_some_and(|h| {
            h.len() != 64
                || !h
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        }) {
            return Err(invalid());
        }
        for id in [
            &self.tenant_id,
            &self.vault_id,
            &self.installation_id,
            &self.device_id,
            &self.actor_id,
        ] {
            EntityId::parse(id).map_err(|_| invalid())?;
        }
        if self.writer_epoch != "1"
            || self.key_version != 1
            || self
                .captured_at_ms
                .parse::<u64>()
                .ok()
                .filter(|v| *v <= 9_007_199_254_740_991)
                .is_none()
        {
            return Err(invalid());
        }
        match (self.scope_type.as_str(), &self.branch_id) {
            ("GLOBAL", None) => (),
            ("BRANCH", Some(b)) => {
                EntityId::parse(b).map_err(|_| invalid())?;
            }
            _ => return Err(invalid()),
        }
        Ok(())
    }
}
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub protocol: String,
    pub backup_id: String,
    pub source: Source,
    pub schema_version: u32,
    pub database_bytes: u64,
    pub database_hash: String,
    pub recovery_envelope: String,
    pub counts: BTreeMap<String, String>,
    pub external_assets: Vec<String>,
    #[serde(default)]
    pub transition_runs: BTreeMap<String, String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Frozen {
    directory: String,
    header: String,
    manifest: Manifest,
}
pub struct Job {
    pub operation_id: String,
    pub source: Source,
    pub backup_path: PathBuf,
    pub key_path: PathBuf,
    pub state: String,
    frozen: Option<Frozen>,
}
impl Job {
    pub fn has_frozen_snapshot(&self) -> bool {
        self.frozen.is_some()
    }
}
fn regular(path: &Path, max: u64) -> Result<File, BackupError> {
    let m = fs::symlink_metadata(path)?;
    if !m.file_type().is_file() || m.len() > max {
        return Err(invalid());
    }
    Ok(File::open(path)?)
}
fn digest(mut file: File) -> Result<(u64, String), BackupError> {
    let mut hash = Sha256::new();
    let mut buf = [0u8; 32768];
    let mut len = 0u64;
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        len = len
            .checked_add(n as u64)
            .filter(|v| *v <= MAX_DB)
            .ok_or_else(invalid)?;
        hash.update(&buf[..n]);
    }
    Ok((len, format!("{:x}", hash.finalize())))
}
fn counts(c: &Connection) -> Result<BTreeMap<String, String>, BackupError> {
    let mut names=c.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")?;
    let mut result = BTreeMap::new();
    for name in names.query_map([], |r| r.get::<_, String>(0))? {
        let name = name?;
        let count: i64 = c.query_row(
            &format!("SELECT count(*) FROM \"{}\"", name.replace('"', "\"\"")),
            [],
            |r| r.get(0),
        )?;
        result.insert(name, count.to_string());
    }
    Ok(result)
}
fn validate_database(c: &Connection, source: &Source) -> Result<(), BackupError> {
    source.validate()?;
    migrations::validate_history(c).map_err(|_| err("BACKUP_SCHEMA_UNSUPPORTED"))?;
    if c.query_row::<String, _, _>("PRAGMA integrity_check", [], |r| r.get(0))? != "ok" {
        return Err(invalid());
    }
    if c.prepare("PRAGMA cipher_integrity_check")?
        .query([])?
        .next()?
        .is_some()
        || c.prepare("PRAGMA foreign_key_check")?
            .query([])?
            .next()?
            .is_some()
    {
        return Err(invalid());
    }
    if c.query_row::<bool, _, _>(
        "SELECT EXISTS(SELECT 1 FROM scopes WHERE negocio_id<>?1)",
        [&source.tenant_id],
        |r| r.get(0),
    )? {
        return Err(err("BACKUP_CONTEXT_MISMATCH"));
    }
    let mut q = c.prepare("SELECT canonical_bytes,hash,operation_id FROM operation_journal")?;
    for row in q.query_map([], |r| {
        Ok((
            r.get::<_, Vec<u8>>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
        ))
    })? {
        let (raw, hash, id) = row?;
        let (canonical, h) = canonicalize(&raw).map_err(|_| invalid())?;
        if canonical.as_bytes() != raw || h != hash {
            return Err(invalid());
        }
        let v: Value = serde_json::from_slice(&raw).map_err(|_| invalid())?;
        if v["operationId"] != id
            || v["negocioId"] != source.tenant_id
            || v["scope"] != json!({"type":source.scope_type,"sucursalId":source.branch_id})
        {
            return Err(err("BACKUP_CONTEXT_MISMATCH"));
        }
    }
    Ok(())
}
pub fn job(c: &Connection, source: &Source, id: &str) -> Result<Option<Job>, BackupError> {
    EntityId::parse(id).map_err(|_| invalid())?;
    let row:Option<(String,String,String,String,Option<String>)>=c.query_row("SELECT source,backup_path,key_path,state,result FROM native_backup_jobs_v1 WHERE operation_id=?1",[id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional()?;
    row.map(|(s, b, k, state, result)| {
        let s: Source = serde_json::from_str(&s).map_err(|_| invalid())?;
        if !s.same_identity(source) {
            return Err(err("BACKUP_CONTEXT_MISMATCH"));
        }
        Ok(Job {
            operation_id: id.into(),
            source: s,
            backup_path: b.into(),
            key_path: k.into(),
            state,
            frozen: result
                .map(|v| serde_json::from_str(&v).map_err(|_| invalid()))
                .transpose()?,
        })
    })
    .transpose()
}
/// Paths come exclusively from the native chooser. Renderer receives no paths.
pub fn prepare(
    c: &Connection,
    source: Source,
    id: &str,
    backup_path: &Path,
    key_path: &Path,
) -> Result<Job, BackupError> {
    source.validate()?;
    if let Some(old) = job(c, &source, id)? {
        return Ok(old);
    }
    if id == source.vault_id {
        return Err(invalid());
    }
    let b = backup_path.parent().ok_or_else(invalid)?.canonicalize()?;
    let k = key_path.parent().ok_or_else(invalid)?.canonicalize()?;
    if b == k || backup_path == key_path {
        return Err(err("BACKUP_SEPARATE_KEY_REQUIRED"));
    }
    for path in [backup_path, key_path] {
        match fs::symlink_metadata(path) {
            Ok(_) => return Err(err("BACKUP_FILE_EXISTS")),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(e.into()),
        }
    }
    let tx = c.unchecked_transaction()?;
    tx.execute(
        "INSERT INTO native_backup_jobs_v1 VALUES(?1,?2,?3,?4,?5,?6,?7,'PREPARED',NULL)",
        (
            &id,
            &source.tenant_id,
            &source.installation_id,
            &source.actor_id,
            serde_json::to_string(&source).map_err(|_| invalid())?,
            backup_path.to_str().ok_or_else(invalid)?,
            key_path.to_str().ok_or_else(invalid)?,
        ),
    )?;
    tx.commit()?;
    job(c, &source, id)?.ok_or_else(invalid)
}
fn encrypt_manifest(m: &Manifest, secret: &RecoverySecret) -> Result<Vec<u8>, BackupError> {
    let bytes = serde_json::to_vec(m).map_err(|_| invalid())?;
    if bytes.len() > MAX_HEADER - 40 {
        return Err(invalid());
    }
    let mut nonce = [0u8; 24];
    getrandom::fill(&mut nonce).map_err(|_| err("BACKUP_IO"))?;
    let cipher = XChaCha20Poly1305::new_from_slice(secret.native_bytes()).map_err(|_| invalid())?;
    let encrypted = cipher
        .encrypt(
            &XNonce::from(nonce),
            Payload {
                msg: &bytes,
                aad: MAGIC,
            },
        )
        .map_err(|_| invalid())?;
    let mut result = nonce.to_vec();
    result.extend(encrypted);
    Ok(result)
}
fn decrypt_manifest(bytes: &[u8], secret: &RecoverySecret) -> Result<Manifest, BackupError> {
    if bytes.len() < 40 || bytes.len() > MAX_HEADER {
        return Err(invalid());
    }
    let cipher = XChaCha20Poly1305::new_from_slice(secret.native_bytes()).map_err(|_| invalid())?;
    let nonce: XNonce = bytes[..24].try_into().map_err(|_| invalid())?;
    let raw = Zeroizing::new(
        cipher
            .decrypt(
                &nonce,
                Payload {
                    msg: &bytes[24..],
                    aad: MAGIC,
                },
            )
            .map_err(|_| err("BACKUP_KEY_INVALID"))?,
    );
    serde_json::from_slice(&raw).map_err(|_| invalid())
}
fn key_bytes(id: &str, secret: &RecoverySecret) -> Result<Zeroizing<Vec<u8>>, BackupError> {
    let mut b = Zeroizing::new(KEY_MAGIC.to_vec());
    b.extend_from_slice(
        EntityId::parse(id)
            .map_err(|_| invalid())?
            .as_uuid()
            .as_bytes(),
    );
    b.extend_from_slice(secret.native_bytes());
    Ok(b)
}
pub fn read_recovery_file(path: &Path) -> Result<(String, RecoverySecret), BackupError> {
    let mut file = regular(path, 56)?;
    let mut bytes = Zeroizing::new([0u8; 56]);
    file.read_exact(&mut *bytes)?;
    if &bytes[..8] != KEY_MAGIC || file.read(&mut [0u8; 1])? != 0 {
        return Err(invalid());
    }
    let id = uuid::Uuid::from_slice(&bytes[8..24])
        .map_err(|_| invalid())?
        .to_string();
    let mut secret = Zeroizing::new([0u8; 32]);
    secret.copy_from_slice(&bytes[24..]);
    Ok((id, RecoverySecret::from_native(*secret)))
}
/// Existing partial files can only be extended after proving their entire
/// prefix equals this frozen export. Never overwrite or truncate a user file.
fn publish(path: &Path, head: &[u8], database: Option<&Path>) -> Result<(), BackupError> {
    let expected = || -> Result<Box<dyn Read>, BackupError> {
        let prefix = std::io::Cursor::new(head.to_vec());
        Ok(if let Some(db) = database {
            Box::new(prefix.chain(regular(db, MAX_DB)?))
        } else {
            Box::new(prefix)
        })
    };
    let mut out = match OpenOptions::new().write(true).create_new(true).open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            let mut old = regular(path, MAX_DB + MAX_HEADER as u64 + 20)?;
            if old.metadata()?.len() < head.len() as u64 {
                return Err(err("BACKUP_FILE_EXISTS"));
            }
            let mut source = expected()?;
            let mut a = [0u8; 32768];
            let mut b = [0u8; 32768];
            loop {
                let n = old.read(&mut a)?;
                if n == 0 {
                    break;
                }
                source
                    .read_exact(&mut b[..n])
                    .map_err(|_| err("BACKUP_FILE_EXISTS"))?;
                if a[..n] != b[..n] {
                    return Err(err("BACKUP_FILE_EXISTS"));
                }
            }
            OpenOptions::new().append(true).open(path)?
        }
        Err(e) => return Err(e.into()),
    };
    let offset = out.metadata()?.len();
    let mut source = expected()?;
    let mut remaining = offset;
    let mut buf = [0u8; 32768];
    while remaining > 0 {
        let cap = remaining.min(buf.len() as u64) as usize;
        source.read_exact(&mut buf[..cap])?;
        remaining -= cap as u64;
    }
    std::io::copy(&mut source, &mut out)?;
    out.sync_all()?;
    Ok(())
}
pub fn create(
    c: &Connection,
    mut job: Job,
    key: &CipherKey,
    secret: &RecoverySecret,
    private_root: &Path,
) -> Result<Value, BackupError> {
    if job.state == "FAILED" {
        return Err(err("BACKUP_JOB_ABANDONED"));
    }
    let source = job.source.clone();
    validate_database(c, &source)?;
    if job.frozen.is_none() {
        let directory = private_root.join(format!("snapshot-{}", EntityId::new_random()));
        fs::create_dir(&directory)?;
        let mut snapshot = VaultWriter::create_encrypted(&directory, key)
            .map_err(|_| err("BACKUP_DATABASE_INVALID"))?;
        let backup = Backup::new(c, snapshot.connection())?;
        backup.run_to_completion(128, Duration::from_millis(1), None)?;
        drop(backup);
        validate_database(snapshot.connection(), &source)?;
        let count = counts(snapshot.connection())?;
        let transition_runs =
            super::legacy_cutover::fingerprints(snapshot.connection()).map_err(|_| invalid())?;
        snapshot
            .connection()
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);PRAGMA journal_mode=DELETE;")?;
        drop(snapshot);
        let (len, hash) = digest(regular(&directory.join("pos_core.db"), MAX_DB)?)?;
        let m = Manifest {
            protocol: "ventard.backup.1".into(),
            backup_id: job.operation_id.clone(),
            schema_version: migrations::validate_history(c).map_err(|_| invalid())?,
            database_bytes: len,
            database_hash: hash,
            source: source.clone(),
            recovery_envelope: STANDARD.encode(
                seal_recovery_key(&source.binding()?, key, secret)
                    .map_err(|_| invalid())?
                    .as_bytes(),
            ),
            counts: count,
            external_assets: vec![],
            transition_runs,
        };
        let protected = encrypt_manifest(&m, secret)?;
        let mut header = MAGIC.to_vec();
        header.extend_from_slice(&(protected.len() as u32).to_be_bytes());
        header.extend_from_slice(&protected);
        header.extend_from_slice(&len.to_be_bytes());
        let f = Frozen {
            directory: directory.to_str().ok_or_else(invalid)?.into(),
            header: STANDARD.encode(header),
            manifest: m,
        };
        c.execute(
            "UPDATE native_backup_jobs_v1 SET result=?2 WHERE operation_id=?1 AND result IS NULL",
            (
                &job.operation_id,
                serde_json::to_string(&f).map_err(|_| invalid())?,
            ),
        )?;
        job.frozen = Some(f);
    }
    let f = job.frozen.as_ref().ok_or_else(invalid)?;
    let header = STANDARD.decode(&f.header).map_err(|_| invalid())?;
    if header.len() < 60 || &header[..8] != MAGIC {
        return Err(invalid());
    }
    let protected = header.get(12..header.len() - 8).ok_or_else(invalid)?;
    if decrypt_manifest(protected, secret)? != f.manifest {
        return Err(err("BACKUP_KEY_INVALID"));
    }
    if f.manifest.source != source || f.manifest.backup_id != job.operation_id {
        return Err(invalid());
    }
    let db = Path::new(&f.directory).join("pos_core.db");
    let (len, hash) = digest(regular(&db, MAX_DB)?)?;
    if len != f.manifest.database_bytes || hash != f.manifest.database_hash {
        return Err(err("BACKUP_SOURCE_CHANGED"));
    }
    publish(&job.key_path, &key_bytes(&job.operation_id, secret)?, None)?;
    publish(
        &job.backup_path,
        &STANDARD.decode(&f.header).map_err(|_| invalid())?,
        Some(&db),
    )?;
    let probe = private_root.join(format!("verify-{}", EntityId::new_random()));
    let verified = restore(&job.backup_path, &job.key_path, &probe)?;
    if verified.manifest.database_hash != f.manifest.database_hash {
        return Err(invalid());
    }
    c.execute(
        "UPDATE native_backup_jobs_v1 SET state='VERIFIED' WHERE operation_id=?1",
        [&job.operation_id],
    )?;
    Ok(summary(&f.manifest, "VERIFIED"))
}
pub fn summary(m: &Manifest, status: &str) -> Value {
    json!({"backupId":m.backup_id,"state":status,"capturedAtMs":m.source.captured_at_ms,"tenantId":m.source.tenant_id,"schemaVersion":m.schema_version,"databaseBytes":m.database_bytes.to_string(),"databaseHash":m.database_hash,"counts":m.counts,"coverage":"COMPLETE_NATIVE_DATABASE_INLINE_ASSETS","restoration":"VERIFIED_QUERY_ONLY"})
}
pub fn list(c: &Connection, source: &Source) -> Result<Value, BackupError> {
    let mut q=c.prepare("SELECT operation_id,state,result FROM native_backup_jobs_v1 WHERE tenant_id=?1 AND installation_id=?2 AND actor_id=?3 ORDER BY rowid DESC LIMIT 20")?;
    let mut rows = vec![];
    for row in q.query_map(
        (&source.tenant_id, &source.installation_id, &source.actor_id),
        |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
            ))
        },
    )? {
        let (id, state, f) = row?;
        let value = if let Some(f) = f {
            summary(
                &serde_json::from_str::<Frozen>(&f)
                    .map_err(|_| invalid())?
                    .manifest,
                &state,
            )
        } else {
            json!({"backupId":id,"state":state})
        };
        rows.push(value)
    }
    Ok(json!({"rows":rows}))
}
pub fn abandon(c: &Connection, source: &Source, id: &str) -> Result<(), BackupError> {
    let j = job(c, source, id)?.ok_or_else(invalid)?;
    if j.state == "VERIFIED" {
        return Err(err("BACKUP_ALREADY_VERIFIED"));
    }
    c.execute("UPDATE native_backup_jobs_v1 SET state='FAILED' WHERE operation_id=?1 AND state='PREPARED'",[id])?;
    Ok(())
}
pub struct Archive {
    connection: Connection,
    pub manifest: Manifest,
    key: CipherKey,
}
/// Native-only custody metadata. The original database remains encrypted and
/// query-only; its key is wrapped under the destination vault's secret.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreservedArchive {
    pub manifest: Manifest,
    pub envelope: String,
}
impl Archive {
    pub fn encrypted_bytes(&self) -> Result<Vec<u8>, BackupError> {
        if self.manifest.database_bytes>128*1024*1024{return Err(err("RECOVERY_TOO_LARGE"));}
        let path = self.connection.path().ok_or_else(invalid)?;
        let mut file = regular(Path::new(path), 128 * 1024 * 1024)?;
        let mut bytes = vec![];
        file.read_to_end(&mut bytes)?;
        if bytes.len() as u64 != self.manifest.database_bytes
            || format!("{:x}", Sha256::digest(&bytes)) != self.manifest.database_hash
        {
            return Err(err("BACKUP_SOURCE_CHANGED"));
        }
        Ok(bytes)
    }
    pub fn nested(&self, directory: &Path, recovery_id: &str) -> Result<Archive, BackupError> {
        EntityId::parse(recovery_id).map_err(|_| invalid())?;
        let (custody,bytes):(String,Vec<u8>)=self.connection.query_row("SELECT p.custody_json,a.ciphertext FROM native_recovery_plans_v1 p JOIN native_recovery_assets_v1 a USING(custody_directory) WHERE p.recovery_id=?1 AND p.tenant_id=?2",(recovery_id,&self.manifest.source.tenant_id),|r|Ok((r.get(0)?,r.get(1)?)))?;
        let custody: PreservedArchive = serde_json::from_str(&custody).map_err(|_| invalid())?;
        if custody.manifest.source.tenant_id != self.manifest.source.tenant_id
            || custody.manifest.source.scope_type != self.manifest.source.scope_type
            || custody.manifest.source.branch_id != self.manifest.source.branch_id
        {
            return Err(err("BACKUP_CONTEXT_MISMATCH"));
        }
        materialize_preserved(directory, &custody, &bytes)?;
        open_preserved(
            directory,
            &custody,
            &RecoverySecret::from_cipher_key(&self.key),
        )
    }
    pub fn preserve(
        &self,
        directory: &Path,
        secret: &RecoverySecret,
    ) -> Result<PreservedArchive, BackupError> {
        match fs::create_dir(directory) {
            Ok(()) => (),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => (),
            Err(e) => return Err(e.into()),
        }
        if !fs::symlink_metadata(directory)?.file_type().is_dir() {
            return Err(invalid());
        }
        let path = directory.join("archive.cipher");
        if path.exists() {
            let (len, hash) = digest(regular(&path, MAX_DB)?)?;
            if len != self.manifest.database_bytes || hash != self.manifest.database_hash {
                return Err(err("BACKUP_SOURCE_CHANGED"));
            }
        } else {
            let source = self.connection.path().ok_or_else(invalid)?;
            let mut input = regular(Path::new(source), MAX_DB)?;
            let mut output = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)?;
            let copied = std::io::copy(&mut input, &mut output).and_then(|len| {
                output.sync_all()?;
                Ok(len)
            });
            drop(output);
            let len = match copied {
                Ok(len) => len,
                Err(e) => {
                    let _ = fs::remove_file(&path);
                    return Err(e.into());
                }
            };
            let (actual, hash) = digest(regular(&path, MAX_DB)?)?;
            if len != self.manifest.database_bytes
                || actual != len
                || hash != self.manifest.database_hash
            {
                return Err(err("BACKUP_SOURCE_CHANGED"));
            }
        }
        let envelope = seal_recovery_key(&self.manifest.source.binding()?, &self.key, secret)
            .map_err(|_| invalid())?;
        Ok(PreservedArchive {
            manifest: self.manifest.clone(),
            envelope: STANDARD.encode(envelope.as_bytes()),
        })
    }
    pub fn read<R>(&self, f: impl FnOnce(&Connection, &Source) -> R) -> R {
        f(&self.connection, &self.manifest.source)
    }
    /// The existing source is opened in place using its original key. No backup
    /// bytes are copied over it; later sales and counters remain intact.
    pub fn existing(&self, root: &Path, source: &Source) -> Result<VaultWriter, BackupError> {
        if !self.manifest.source.same_identity(source) {
            return Err(err("BACKUP_CONTEXT_MISMATCH"));
        }
        let mut w = VaultWriter::open_encrypted(root, &self.key)
            .map_err(|_| err("BACKUP_CURRENT_DATABASE_REQUIRED"))?;
        validate_database(w.connection(), source)?;
        Ok(w)
    }
    pub fn recover_missing_key(
        &self,
        store: &impl crate::security::key_provider::NativeKeyStore,
        source: &Source,
    ) -> Result<(), BackupError> {
        if !self.manifest.source.same_identity(source) {
            return Err(err("BACKUP_CONTEXT_MISMATCH"));
        }
        crate::security::key_provider::persist_recovered_key(store, &source.binding()?, &self.key)
            .map_err(|_| err("BACKUP_KEY_STORE_FAILED"))
    }
}
pub fn open_preserved(
    directory: &Path,
    stored: &PreservedArchive,
    secret: &RecoverySecret,
) -> Result<Archive, BackupError> {
    if !fs::symlink_metadata(directory)?.file_type().is_dir() {
        return Err(invalid());
    }
    let m = &stored.manifest;
    let path = directory.join("archive.cipher");
    let (len, hash) = digest(regular(&path, MAX_DB)?)?;
    if len != m.database_bytes || hash != m.database_hash {
        return Err(err("BACKUP_SOURCE_CHANGED"));
    }
    let envelope = STANDARD.decode(&stored.envelope).map_err(|_| invalid())?;
    let key = recover_key(&m.source.binding()?, secret, &envelope)
        .map_err(|_| err("BACKUP_KEY_INVALID"))?;
    let connection = Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    cipher::key_connection(&connection, &key).map_err(|_| err("BACKUP_DATABASE_INVALID"))?;
    cipher::validate_key(&connection).map_err(|_| invalid())?;
    connection.execute_batch("PRAGMA query_only=ON;PRAGMA foreign_keys=ON;")?;
    validate_database(&connection, &m.source)?;
    if migrations::validate_history(&connection).map_err(|_| invalid())? != m.schema_version
        || counts(&connection)? != m.counts
    {
        return Err(invalid());
    }
    Ok(Archive {
        connection,
        manifest: m.clone(),
        key,
    })
}
pub fn materialize_preserved(
    directory: &Path,
    stored: &PreservedArchive,
    bytes: &[u8],
) -> Result<(), BackupError> {
    if bytes.len() > 128 * 1024 * 1024
        || bytes.len() as u64 != stored.manifest.database_bytes
        || format!("{:x}", Sha256::digest(bytes)) != stored.manifest.database_hash
    {
        return Err(err("BACKUP_SOURCE_CHANGED"));
    }
    match fs::create_dir(directory) {
        Ok(()) => (),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => (),
        Err(e) => return Err(e.into()),
    }
    if !fs::symlink_metadata(directory)?.file_type().is_dir() {
        return Err(invalid());
    }
    let path = directory.join("archive.cipher");
    if path.exists() {
        let (len, hash) = digest(regular(&path, MAX_DB)?)?;
        if len != bytes.len() as u64 || hash != stored.manifest.database_hash {
            return Err(err("BACKUP_SOURCE_CHANGED"));
        }
        return Ok(());
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)?;
    if let Err(e) = file.write_all(bytes).and_then(|_| file.sync_all()) {
        drop(file);
        let _ = fs::remove_file(&path);
        return Err(e.into());
    }
    Ok(())
}
/// Candidate only, CREATE_NEW. It cannot dispatch, migrate, allocate or print.
pub fn restore(
    backup_path: &Path,
    key_path: &Path,
    candidate: &Path,
) -> Result<Archive, BackupError> {
    let (id, secret) = read_recovery_file(key_path)?;
    let mut file = regular(backup_path, MAX_DB + MAX_HEADER as u64 + 20)?;
    let mut magic = [0u8; 8];
    file.read_exact(&mut magic)?;
    if &magic != MAGIC {
        return Err(invalid());
    }
    let mut size = [0u8; 4];
    file.read_exact(&mut size)?;
    let size = u32::from_be_bytes(size) as usize;
    if !(40..=MAX_HEADER).contains(&size) {
        return Err(invalid());
    }
    let mut protected = vec![0u8; size];
    file.read_exact(&mut protected)?;
    let m = decrypt_manifest(&protected, &secret)?;
    m.source.validate()?;
    let mut len = [0u8; 8];
    file.read_exact(&mut len)?;
    let len = u64::from_be_bytes(len);
    if m.protocol != "ventard.backup.1"
        || m.backup_id != id
        || len != m.database_bytes
        || !(4096..=MAX_DB).contains(&len)
        || !m.external_assets.is_empty()
    {
        return Err(invalid());
    }
    let offset = file.stream_position()?;
    if file.metadata()?.len() != offset + len {
        return Err(invalid());
    }
    let envelope = STANDARD
        .decode(&m.recovery_envelope)
        .map_err(|_| invalid())?;
    let key = recover_key(&m.source.binding()?, &secret, &envelope)
        .map_err(|_| err("BACKUP_KEY_INVALID"))?;
    fs::create_dir(candidate)?;
    let path = candidate.join("pos_core.db");
    let mut out = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)?;
    let mut hash = Sha256::new();
    let mut buf = [0u8; 32768];
    let mut left = len;
    while left > 0 {
        let n = left.min(buf.len() as u64) as usize;
        file.read_exact(&mut buf[..n])?;
        out.write_all(&buf[..n])?;
        hash.update(&buf[..n]);
        left -= n as u64;
    }
    out.sync_all()?;
    drop(out);
    if format!("{:x}", hash.finalize()) != m.database_hash {
        return Err(invalid());
    }
    let connection = Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    cipher::key_connection(&connection, &key).map_err(|_| err("BACKUP_DATABASE_INVALID"))?;
    cipher::validate_key(&connection).map_err(|_| invalid())?;
    connection.execute_batch("PRAGMA query_only=ON;PRAGMA foreign_keys=ON;")?;
    validate_database(&connection, &m.source)?;
    if migrations::validate_history(&connection).map_err(|_| invalid())? != m.schema_version
        || counts(&connection)? != m.counts
    {
        return Err(invalid());
    }
    Ok(Archive {
        connection,
        manifest: m,
        key,
    })
}
