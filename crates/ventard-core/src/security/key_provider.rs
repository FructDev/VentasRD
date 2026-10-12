//! Primitivas nativas del spike. No autorizan actor/provisioning ni activan
//! instalaciones. La UI nunca recibe material de clave ni usa PIN como DEK.
use crate::{
    domain::identity::EntityId,
    storage::{
        cipher::CipherKey,
        writer::{StorageError, VaultWriter},
    },
};
use sha2::{Digest, Sha256};
use std::path::Path;
use subtle::ConstantTimeEq;
use zeroize::Zeroizing;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyError {
    Missing,
    TemporarilyUnavailable,
    Invalidated,
    AlreadyExists,
    ProviderFailure,
    WriteUncertain,
    BindingInvalid,
    RandomUnavailable,
    RecoveryInvalid,
}
impl KeyError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Missing => "KEY_MISSING",
            Self::TemporarilyUnavailable => "KEY_TEMPORARILY_UNAVAILABLE",
            Self::Invalidated => "KEY_INVALIDATED",
            Self::AlreadyExists => "KEY_ALREADY_EXISTS",
            Self::ProviderFailure => "KEY_PROVIDER_FAILURE",
            Self::WriteUncertain => "KEY_STORE_WRITE_UNCERTAIN",
            Self::BindingInvalid => "KEY_BINDING_INVALID",
            Self::RandomUnavailable => "RANDOM_SOURCE_UNAVAILABLE",
            Self::RecoveryInvalid => "RECOVERY_ENVELOPE_INVALID",
        }
    }
}
impl std::fmt::Display for KeyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.code())
    }
}
impl std::error::Error for KeyError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyBinding {
    tenant: EntityId,
    vault: EntityId,
    installation: EntityId,
    version: u32,
}
impl KeyBinding {
    pub fn new(
        tenant: EntityId,
        vault: EntityId,
        installation: EntityId,
        version: u32,
    ) -> Result<Self, KeyError> {
        if version == 0 {
            return Err(KeyError::BindingInvalid);
        }
        Ok(Self {
            tenant,
            vault,
            installation,
            version,
        })
    }
    pub(crate) fn aad(&self) -> Vec<u8> {
        let mut b = Vec::with_capacity(60);
        b.extend_from_slice(b"VRKEY001");
        for id in [&self.tenant, &self.vault, &self.installation] {
            b.extend_from_slice(id.as_uuid().as_bytes());
        }
        b.extend_from_slice(&self.version.to_be_bytes());
        b
    }
    pub fn slot(&self) -> String {
        format!(
            "com.ventard.pos.qa.vault-key.{:x}",
            Sha256::digest(self.aad())
        )
    }
}

/// Implementación OS explícita; no default global ni fallback mock/archivo.
/// create_new debe serializar por slot y rechazar existente sin sobrescribir.
/// El owner coordina mantenimiento; esta interfaz no es IPC/exporte.
pub trait NativeKeyStore {
    fn read(&self, slot: &str) -> Result<Zeroizing<Vec<u8>>, KeyError>;
    fn create_new(&self, slot: &str, record: &[u8]) -> Result<(), KeyError>;
}
fn decode(binding: &KeyBinding, record: &[u8]) -> Result<CipherKey, KeyError> {
    if record.len() != 92 || record[..60] != binding.aad() {
        return Err(KeyError::Invalidated);
    }
    let mut bytes = Zeroizing::new([0u8; 32]);
    bytes.copy_from_slice(&record[60..]);
    Ok(CipherKey::from_zeroizing(bytes))
}
pub fn load_vault_key(
    store: &impl NativeKeyStore,
    binding: &KeyBinding,
) -> Result<CipherKey, KeyError> {
    decode(binding, &store.read(&binding.slot())?)
}
/// Sólo para nueva versión bajo intención nativa autorizada. Jamás invocarla
/// como fallback de load/open: el estado ausente no permite reprovisionar.
pub fn create_vault_key(
    store: &impl NativeKeyStore,
    binding: &KeyBinding,
) -> Result<CipherKey, KeyError> {
    let slot = binding.slot();
    match store.read(&slot) {
        Ok(_) => return Err(KeyError::AlreadyExists),
        Err(KeyError::Missing) => {}
        Err(e) => return Err(e),
    }
    let mut bytes = Zeroizing::new([0u8; 32]);
    getrandom::fill(&mut *bytes).map_err(|_| KeyError::RandomUnavailable)?;
    let key = CipherKey::from_zeroizing(bytes);
    let mut record = Zeroizing::new(Vec::with_capacity(92));
    record.extend_from_slice(&binding.aad());
    record.extend_from_slice(key.raw_native());
    store.create_new(&slot, &record)?;
    let persisted = store.read(&slot).map_err(|_| KeyError::WriteUncertain)?;
    if !bool::from(persisted.as_slice().ct_eq(record.as_slice())) {
        return Err(KeyError::WriteUncertain);
    }
    Ok(key)
}

#[derive(Debug)]
pub struct VaultAccessError(&'static str);
impl VaultAccessError {
    pub fn code(&self) -> &'static str {
        self.0
    }
}
impl std::fmt::Display for VaultAccessError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}
impl std::error::Error for VaultAccessError {}
pub fn open_existing_vault(
    store: &impl NativeKeyStore,
    binding: &KeyBinding,
    dir: impl AsRef<Path>,
) -> Result<VaultWriter, VaultAccessError> {
    let key = load_vault_key(store, binding).map_err(|e| VaultAccessError(e.code()))?;
    VaultWriter::open_encrypted(dir, &key).map_err(|e| {
        VaultAccessError(match e {
            StorageError::VaultMissing => "VAULT_MISSING",
            StorageError::CipherKeyRejected => "VAULT_UNREADABLE",
            StorageError::IncompatibleSchema => "VAULT_SCHEMA_UNSUPPORTED",
            StorageError::PlaintextVaultRejected => "PLAINTEXT_VAULT_REJECTED",
            _ => "LOCAL_STORAGE_UNAVAILABLE",
        })
    })
}
