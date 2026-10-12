use super::migrations;
use super::vault_lock::VaultLock;
use crate::application::errors::AppError;
use rusqlite::{Connection, OpenFlags};
use rusqlite::{Transaction, TransactionBehavior};
use std::path::Path;
use std::sync::mpsc::{self, SyncSender};
use std::thread::{self, JoinHandle};
/// Native Rust broker only; never exposed to the renderer.
pub type CoreConnection = Connection;

#[derive(Debug)]
pub enum StorageError {
    LockFailed(String),
    SqliteError(rusqlite::Error),
    MigrationError(String),
    IncompatibleSchema,
    VaultMissing,
    VaultExists,
    VaultIo,
    PlaintextVaultRejected,
    CipherUnavailable,
    // Wrong key and unreadable/corrupt ciphertext cannot be distinguished
    // safely without independent key-provider evidence; neither authorizes wipe.
    CipherKeyRejected,
}

type WriterJob = Box<dyn FnOnce(&mut Connection) + Send + 'static>;

/// Conexión y lock pertenecen al hilo nativo, no al renderer.
/// La cola es acotada. Estos callbacks son código Rust confiable; no se
/// exponen como SQL/closures en IPC. Tauri deberá invocar fuera del hilo UI.
pub struct WriterActor {
    sender: Option<SyncSender<WriterJob>>,
    thread: Option<JoinHandle<()>>,
}

impl WriterActor {
    #[cfg(feature = "fixture-storage")]
    pub fn open_fixture<P: AsRef<Path>>(vault_dir: P) -> Result<Self, StorageError> {
        let path = vault_dir.as_ref().to_path_buf();
        Self::start(move || VaultWriter::open(path))
    }

    #[cfg(feature = "encrypted-storage")]
    pub fn create_encrypted<P: AsRef<Path>>(
        vault_dir: P,
        key: super::cipher::CipherKey,
    ) -> Result<Self, StorageError> {
        let path = vault_dir.as_ref().to_path_buf();
        Self::start(move || VaultWriter::create_encrypted(path, &key))
    }

    #[cfg(feature = "encrypted-storage")]
    pub fn open_encrypted<P: AsRef<Path>>(
        vault_dir: P,
        key: super::cipher::CipherKey,
    ) -> Result<Self, StorageError> {
        let path = vault_dir.as_ref().to_path_buf();
        Self::start(move || VaultWriter::open_encrypted(path, &key))
    }

    fn start<F>(factory: F) -> Result<Self, StorageError>
    where
        F: FnOnce() -> Result<VaultWriter, StorageError> + Send + 'static,
    {
        let (sender, jobs) = mpsc::sync_channel::<WriterJob>(64);
        let (ready, startup) = mpsc::sync_channel(1);
        let thread = thread::Builder::new()
            .name("ventard-vault-writer".into())
            .spawn(move || {
                let mut writer = match factory() {
                    Ok(writer) => writer,
                    Err(error) => {
                        let _ = ready.send(Err(error));
                        return;
                    }
                };
                if ready.send(Ok(())).is_err() {
                    return;
                }
                while let Ok(job) = jobs.recv() {
                    job(writer.connection());
                }
            })
            .map_err(|_| StorageError::MigrationError("WRITER_START_FAILED".into()))?;
        match startup.recv() {
            Ok(Ok(())) => Ok(Self {
                sender: Some(sender),
                thread: Some(thread),
            }),
            Ok(Err(error)) => {
                let _ = thread.join();
                Err(error)
            }
            Err(_) => {
                let _ = thread.join();
                Err(StorageError::MigrationError("WRITER_START_FAILED".into()))
            }
        }
    }

    pub fn call<R, F>(&self, command: F) -> Result<R, AppError>
    where
        R: Send + 'static,
        F: FnOnce(&mut Connection) -> Result<R, AppError> + Send + 'static,
    {
        let (response, result) = mpsc::sync_channel(1);
        let job = Box::new(move |connection: &mut Connection| {
            // COMMIT ocurre antes de responder. Perder el receptor no deshace
            // una operación; su resultado se recupera del journal por ID/hash.
            let outcome = command(connection);
            let _ = response.send(outcome);
        });
        self.sender
            .as_ref()
            .ok_or_else(|| AppError::Storage("LOCAL_STORAGE_IO".into()))?
            .send(job)
            .map_err(|_| AppError::Storage("LOCAL_STORAGE_IO".into()))?;
        result
            .recv()
            .map_err(|_| AppError::Storage("LOCAL_STORAGE_IO".into()))?
    }

    pub fn transaction<R, F>(&self, command: F) -> Result<R, AppError>
    where
        R: Send + 'static,
        F: FnOnce(&Transaction<'_>) -> Result<R, AppError> + Send + 'static,
    {
        self.call(move |connection| {
            let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let result = command(&tx)?;
            tx.commit()?;
            Ok(result)
        })
    }
}

impl Drop for WriterActor {
    fn drop(&mut self) {
        // Finalizar trabajos admitidos antes de liberar la conexión/lock.
        self.sender.take();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl From<rusqlite::Error> for StorageError {
    fn from(err: rusqlite::Error) -> Self {
        StorageError::SqliteError(err)
    }
}

/// The exclusive writer connection for a vault.
/// Manages the OS lock, SQLite pragmas, and schema migrations.
pub struct VaultWriter {
    conn: Connection,
    _lock: VaultLock,
}

impl VaultWriter {
    /// Opens the vault database as an exclusive writer.
    /// Fails if the vault is already locked by another process.
    // Nunca ofrecer un constructor plaintext en un artefacto comercial.
    // Nunca compilar este constructor en encrypted-storage.
    #[cfg(feature = "fixture-storage")]
    pub fn open<P: AsRef<Path>>(vault_dir: P) -> Result<Self, StorageError> {
        let vault_dir = vault_dir.as_ref();

        // 1. Acquire OS lock first
        let lock = VaultLock::try_acquire(vault_dir)
            .map_err(|e| StorageError::LockFailed(e.to_string()))?;

        let db_path = vault_dir.join("pos_core.db");

        // 2. Open SQLite connection
        let conn = Connection::open_with_flags(
            &db_path,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_CREATE
                | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;

        Self::finish_open(conn, lock)
    }

    /// Crear sólo con autorización de provisioning (el caller futuro). Nunca
    /// reutilizar esta ruta al fallar lectura de una base existente.
    #[cfg(feature = "encrypted-storage")]
    pub fn create_encrypted<P: AsRef<Path>>(
        vault_dir: P,
        key: &super::cipher::CipherKey,
    ) -> Result<Self, StorageError> {
        use std::fs::OpenOptions;
        let dir = vault_dir
            .as_ref()
            .canonicalize()
            .map_err(|_| StorageError::VaultIo)?;
        let lock =
            VaultLock::try_acquire(&dir).map_err(|e| StorageError::LockFailed(e.to_string()))?;
        let path = dir.join("pos_core.db");
        // Un WAL/journal huérfano puede contener operaciones recuperables.
        // Nunca fabricar una DB vacía encima de restos de un vault anterior.
        for suffix in ["-wal", "-shm", "-journal"] {
            match std::fs::symlink_metadata(dir.join(format!("pos_core.db{suffix}"))) {
                Ok(_) => return Err(StorageError::VaultExists),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
                Err(_) => return Err(StorageError::VaultIo),
            }
        }
        let reserved = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::AlreadyExists {
                    StorageError::VaultExists
                } else {
                    StorageError::VaultIo
                }
            })?;
        drop(reserved);
        // No CREATE SQLite: sólo el archivo reservado por esta llamada.
        let conn = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        super::cipher::key_connection(&conn, key)?;
        super::cipher::validate_key(&conn)?;
        Self::finish_open(conn, lock)
    }

    /// Abrir existente, sin CREATE ni wipe. Validar llave/historia primero con
    /// handle read-only para no cambiar el archivo al rechazar acceso/schema.
    #[cfg(feature = "encrypted-storage")]
    pub fn open_encrypted<P: AsRef<Path>>(
        vault_dir: P,
        key: &super::cipher::CipherKey,
    ) -> Result<Self, StorageError> {
        use std::io::Read;
        let dir = vault_dir
            .as_ref()
            .canonicalize()
            .map_err(|_| StorageError::VaultIo)?;
        let lock =
            VaultLock::try_acquire(&dir).map_err(|e| StorageError::LockFailed(e.to_string()))?;
        let path = dir.join("pos_core.db");
        let metadata = std::fs::symlink_metadata(&path).map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                StorageError::VaultMissing
            } else {
                StorageError::VaultIo
            }
        })?;
        if !metadata.file_type().is_file() || metadata.len() < 16 {
            return Err(StorageError::CipherKeyRejected);
        }
        let mut header = [0u8; 16];
        std::fs::File::open(&path)
            .and_then(|mut f| f.read_exact(&mut header))
            .map_err(|_| StorageError::VaultIo)?;
        if &header == b"SQLite format 3\0" {
            return Err(StorageError::PlaintextVaultRejected);
        }
        let readonly = Connection::open_with_flags(
            &path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        super::cipher::key_connection(&readonly, key)?;
        super::cipher::validate_key(&readonly)?;
        migrations::validate_history(&readonly)?;
        drop(readonly);
        let conn = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        super::cipher::key_connection(&conn, key)?;
        super::cipher::validate_key(&conn)?;
        Self::finish_open(conn, lock)
    }

    fn finish_open(mut conn: Connection, lock: VaultLock) -> Result<Self, StorageError> {
        // No cambiar journal_mode ni crear historia sobre una DB incompatible.
        migrations::validate_history(&conn)?;
        // 3. Set required PRAGMAs for durability and strict consistency
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = FULL;
             PRAGMA foreign_keys = ON;
             PRAGMA busy_timeout = 5000;",
        )?;

        let mode: String = conn.query_row("PRAGMA journal_mode", [], |r| r.get(0))?;
        let full: i64 = conn.query_row("PRAGMA synchronous", [], |r| r.get(0))?;
        let fk: i64 = conn.query_row("PRAGMA foreign_keys", [], |r| r.get(0))?;
        if mode != "wal" || full != 2 || fk != 1 {
            return Err(StorageError::MigrationError(
                "DURABILITY_CONFIGURATION_INVALID".into(),
            ));
        }
        migrations::apply(&mut conn)?;
        let writer = Self { conn, _lock: lock };

        Ok(writer)
    }

    /// Borrows the underlying SQLite connection for transactions.
    /// Commands MUST use `BEGIN IMMEDIATE` to prevent deadlocks and ensure exclusive write.
    pub fn connection(&mut self) -> &mut Connection {
        &mut self.conn
    }
}
