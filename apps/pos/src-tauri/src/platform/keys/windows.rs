//! Backend QA explícito, usuario Windows actual y persistencia Local.
//! No enumeración, default global, PIN ni fichero plaintext de secretos.
use fs2::FileExt;
use keyring_core::{api::CredentialStoreApi, Entry, Error};
use std::{
    collections::HashMap,
    fs::{File, OpenOptions},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
};
use subtle::ConstantTimeEq;
use ventard_core::security::key_provider::{KeyError, NativeKeyStore};
use windows_native_keyring_store::Store;
use zeroize::{Zeroize, Zeroizing};

// Credential Manager puede fallar en read-back inmediato mientras otro hilo
// cambia persistencia, incluso al aprovisionar slots distintos. Secuenciar
// todas las llamadas del adaptador, no sólo escritores del mismo vault.
static KEYSTORE_GATE: Mutex<()> = Mutex::new(());

pub struct WindowsKeyStore {
    root: PathBuf,
    store: Arc<Store>,
}
impl WindowsKeyStore {
    /// Caller nativo entrega directorio privado estable del app (no JS).
    /// Homologación ACL/clone/otros OS permanece en G1/G7.
    pub fn new(root: impl AsRef<Path>) -> Result<Self, KeyError> {
        std::fs::create_dir_all(root.as_ref()).map_err(|_| KeyError::ProviderFailure)?;
        let root = root
            .as_ref()
            .canonicalize()
            .map_err(|_| KeyError::ProviderFailure)?;
        Ok(Self {
            root,
            store: Store::new().map_err(map_error)?,
        })
    }
    fn entry(&self, slot: &str) -> Result<Entry, KeyError> {
        self.store
            .build(
                "VentaRD Native QA",
                "vault-key",
                Some(&HashMap::from([("target", slot), ("persistence", "Local")])),
            )
            .map_err(map_error)
    }
    fn lock(&self, slot: &str) -> Result<(File, MutexGuard<'static, ()>), KeyError> {
        let hash = slot
            .strip_prefix("com.ventard.pos.qa.vault-key.")
            .ok_or(KeyError::BindingInvalid)?;
        if hash.len() != 64
            || !hash
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(KeyError::BindingInvalid);
        }
        let gate = KEYSTORE_GATE
            .lock()
            .map_err(|_| KeyError::ProviderFailure)?;
        // Caller usa la misma raíz privada estable para todos los vaults.
        // Entre procesos ocupados se devuelve estado temporal, sin retry.
        let path = self.root.join("credential-store.lock");
        match std::fs::symlink_metadata(&path) {
            Ok(m) if !m.file_type().is_file() => return Err(KeyError::ProviderFailure),
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(KeyError::ProviderFailure),
        }
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(path)
            .map_err(|_| KeyError::ProviderFailure)?;
        file.try_lock_exclusive().map_err(|e| {
            if e.kind() == std::io::ErrorKind::WouldBlock {
                KeyError::TemporarilyUnavailable
            } else {
                KeyError::ProviderFailure
            }
        })?;
        // Tuple drop libera el fichero antes del gate intra-proceso.
        Ok((file, gate))
    }
    fn read_entry(entry: &Entry) -> Result<Zeroizing<Vec<u8>>, KeyError> {
        let attributes = entry.get_attributes().map_err(map_error)?;
        if attributes.get("persistence").map(String::as_str) != Some("Local") {
            return Err(KeyError::Invalidated);
        }
        entry.get_secret().map(Zeroizing::new).map_err(map_error)
    }
}
impl NativeKeyStore for WindowsKeyStore {
    fn read(&self, slot: &str) -> Result<Zeroizing<Vec<u8>>, KeyError> {
        let _guard = self.lock(slot)?;
        Self::read_entry(&self.entry(slot)?)
    }
    fn create_new(&self, slot: &str, record: &[u8]) -> Result<(), KeyError> {
        if record.len() != 92 {
            return Err(KeyError::BindingInvalid);
        }
        let _guard = self.lock(slot)?;
        let entry = self.entry(slot)?;
        match entry.get_attributes() {
            Ok(_) => return Err(KeyError::AlreadyExists),
            Err(Error::NoEntry) => {}
            Err(e) => return Err(map_error(e)),
        }
        // No retry/deshacer implícito si OS da respuesta incierta tras escritura.
        entry
            .set_secret(record)
            .map_err(|_| KeyError::WriteUncertain)?;
        let saved = Self::read_entry(&entry).map_err(|_| KeyError::WriteUncertain)?;
        if !bool::from(saved.as_slice().ct_eq(record)) {
            return Err(KeyError::WriteUncertain);
        }
        Ok(())
    }
}
fn map_error(e: Error) -> KeyError {
    match e {
        Error::NoEntry => KeyError::Missing,
        Error::NoStorageAccess(_) => KeyError::TemporarilyUnavailable,
        Error::BadEncoding(mut bytes) | Error::BadDataFormat(mut bytes, _) => {
            bytes.zeroize();
            KeyError::Invalidated
        }
        Error::Ambiguous(_) | Error::BadStoreFormat(_) => KeyError::Invalidated,
        _ => KeyError::ProviderFailure,
    }
}
/// Test-only custody. Can remove solely exact records successfully created
/// by this guard; never enumerates or deletes unrelated user credentials.
#[cfg(test)]
pub(crate) struct FixtureKeys {
    store: WindowsKeyStore,
    owned: Mutex<HashMap<String, Zeroizing<Vec<u8>>>>,
}
#[cfg(test)]
impl FixtureKeys {
    pub(crate) fn new(root: &Path) -> Self {
        Self {
            store: WindowsKeyStore::new(root).unwrap(),
            owned: Mutex::new(HashMap::new()),
        }
    }
    pub(crate) fn lose_owned(&self, slot: &str) {
        let owned = self.owned.lock().unwrap();
        let expected = owned.get(slot).expect("only this fixture's keys");
        let actual = self.store.read(slot).unwrap();
        assert!(bool::from(actual.as_slice().ct_eq(expected.as_slice())));
        self.store.entry(slot).unwrap().delete_credential().unwrap();
    }
}
#[cfg(test)]
impl NativeKeyStore for FixtureKeys {
    fn read(&self, slot: &str) -> Result<Zeroizing<Vec<u8>>, KeyError> {
        self.store.read(slot)
    }
    fn create_new(&self, slot: &str, record: &[u8]) -> Result<(), KeyError> {
        self.store.create_new(slot, record)?;
        self.owned
            .lock()
            .map_err(|_| KeyError::ProviderFailure)?
            .insert(slot.into(), Zeroizing::new(record.to_vec()));
        Ok(())
    }
}
#[cfg(test)]
impl Drop for FixtureKeys {
    fn drop(&mut self) {
        if let Ok(owned) = self.owned.lock() {
            for (slot, expected) in owned.iter() {
                if let Ok(actual) = self.store.read(slot) {
                    if bool::from(actual.as_slice().ct_eq(expected.as_slice())) {
                        let _ = self
                            .store
                            .entry(slot)
                            .and_then(|e| e.delete_credential().map_err(map_error));
                    }
                }
            }
        }
    }
}
