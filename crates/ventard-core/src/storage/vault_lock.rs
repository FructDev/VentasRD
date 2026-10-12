use fs2::FileExt;
use std::fs::{File, OpenOptions};
use std::io;
use std::path::Path;

/// An OS-level file lock that guarantees exclusive access to a vault database.
/// Only one writer process can hold this lock at a time.
pub struct VaultLock {
    _file: File,
}

impl VaultLock {
    /// Attempts to acquire an exclusive lock for the specified vault directory.
    /// If another process holds the lock, this returns an error immediately (secondary process).
    pub fn try_acquire<P: AsRef<Path>>(vault_dir: P) -> io::Result<Self> {
        let lock_path = vault_dir.as_ref().join(".writer_lock");

        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&lock_path)?;

        // Attempt an exclusive, non-blocking lock.
        // If it fails, another process (e.g., another POS window or shell) is already the writer.
        file.try_lock_exclusive()?;

        Ok(Self { _file: file })
    }
}

impl Drop for VaultLock {
    fn drop(&mut self) {
        // Unlock happens automatically when the file descriptor is closed,
        // but we can explicitly try to unlock here.
        let _ = FileExt::unlock(&self._file);
    }
}
