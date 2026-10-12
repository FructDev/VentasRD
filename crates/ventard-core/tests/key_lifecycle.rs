#![cfg(feature = "encrypted-storage")]
use sha2::{Digest, Sha256};
use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    path::PathBuf,
};
use ventard_core::security::key_provider::{
    create_vault_key, load_vault_key, open_existing_vault, KeyBinding, KeyError, NativeKeyStore,
};
use ventard_core::security::recovery_enrollment::{recover_key, seal_recovery_key, RecoverySecret};
use ventard_core::{domain::identity::EntityId, storage::writer::VaultWriter};
use zeroize::Zeroizing;

#[derive(Default)]
struct FakeStore {
    rows: RefCell<HashMap<String, Vec<u8>>>,
    writes: Cell<usize>,
    failure: Cell<Option<KeyError>>,
}
impl NativeKeyStore for FakeStore {
    fn read(&self, slot: &str) -> Result<Zeroizing<Vec<u8>>, KeyError> {
        if let Some(e) = self.failure.get() {
            return Err(e);
        }
        self.rows
            .borrow()
            .get(slot)
            .cloned()
            .map(Zeroizing::new)
            .ok_or(KeyError::Missing)
    }
    fn create_new(&self, slot: &str, record: &[u8]) -> Result<(), KeyError> {
        let mut rows = self.rows.borrow_mut();
        if rows.contains_key(slot) {
            return Err(KeyError::AlreadyExists);
        }
        rows.insert(slot.into(), record.to_vec());
        self.writes.set(self.writes.get() + 1);
        Ok(())
    }
}
fn binding(version: u32) -> KeyBinding {
    KeyBinding::new(
        EntityId::new_random(),
        EntityId::new_random(),
        EntityId::new_random(),
        version,
    )
    .unwrap()
}
struct FixtureDir(PathBuf);
impl FixtureDir {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!("ventard-key-fixture-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&p).unwrap();
        Self(p)
    }
    fn digest(&self) -> Vec<u8> {
        Sha256::digest(std::fs::read(self.0.join("pos_core.db")).unwrap()).to_vec()
    }
}
impl Drop for FixtureDir {
    fn drop(&mut self) {
        if let (Ok(target), Ok(root)) = (self.0.canonicalize(), std::env::temp_dir().canonicalize())
        {
            assert!(
                target.starts_with(root)
                    && target
                        .file_name()
                        .unwrap()
                        .to_string_lossy()
                        .starts_with("ventard-key-fixture-")
            );
            let _ = std::fs::remove_dir_all(target);
        }
    }
}

#[test]
fn new_random_key_can_reopen_but_repeated_creation_never_overwrites() {
    let store = FakeStore::default();
    let b = binding(1);
    let dir = FixtureDir::new();
    let key = create_vault_key(&store, &b).unwrap();
    let mut w = VaultWriter::create_encrypted(&dir.0, &key).unwrap();
    w.connection()
        .execute_batch("CREATE TABLE probe(v INTEGER) STRICT; INSERT INTO probe VALUES(42);")
        .unwrap();
    drop(w);
    assert_eq!(
        create_vault_key(&store, &b).err(),
        Some(KeyError::AlreadyExists)
    );
    assert_eq!(store.writes.get(), 1);
    let mut w = open_existing_vault(&store, &b, &dir.0).unwrap();
    assert_eq!(
        w.connection()
            .query_row("SELECT v FROM probe", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        42
    );
}
#[test]
fn missing_temporary_and_invalidated_keys_never_generate_key_or_mutate_database() {
    let store = FakeStore::default();
    let b = binding(1);
    let dir = FixtureDir::new();
    let key = create_vault_key(&store, &b).unwrap();
    drop(VaultWriter::create_encrypted(&dir.0, &key).unwrap());
    let before = dir.digest();
    for error in [
        KeyError::Missing,
        KeyError::TemporarilyUnavailable,
        KeyError::Invalidated,
        KeyError::ProviderFailure,
    ] {
        store.failure.set(Some(error));
        assert_eq!(
            open_existing_vault(&store, &b, &dir.0)
                .err()
                .unwrap()
                .code(),
            error.code()
        );
        assert_eq!(dir.digest(), before);
        assert_eq!(store.writes.get(), 1);
    }
    store.failure.set(None);
    assert!(open_existing_vault(&store, &b, &dir.0).is_ok());
}
#[test]
fn malformed_or_wrong_binding_record_is_invalidated_not_adopted() {
    let store = FakeStore::default();
    let a = binding(1);
    let b = binding(1);
    create_vault_key(&store, &a).unwrap();
    let record = store.rows.borrow().get(&a.slot()).unwrap().clone();
    store.rows.borrow_mut().insert(b.slot(), record);
    assert_eq!(
        load_vault_key(&store, &b).err(),
        Some(KeyError::Invalidated)
    );
    store.rows.borrow_mut().insert(a.slot(), vec![0u8; 5000]);
    assert_eq!(
        load_vault_key(&store, &a).err(),
        Some(KeyError::Invalidated)
    );
    assert_eq!(store.writes.get(), 1);
}
#[test]
fn identity_and_key_version_are_bound_and_errors_are_safe_allowlist_codes() {
    let id = EntityId::new_random();
    assert_eq!(
        KeyBinding::new(id, id, id, 0).err(),
        Some(KeyError::BindingInvalid)
    );
    let a = KeyBinding::new(id, id, id, 1).unwrap();
    let b = KeyBinding::new(id, id, id, 2).unwrap();
    assert_ne!(a.slot(), b.slot());
    assert_eq!(KeyError::Missing.to_string(), "KEY_MISSING");
    assert_eq!(
        KeyError::TemporarilyUnavailable.to_string(),
        "KEY_TEMPORARILY_UNAVAILABLE"
    );
    assert_eq!(KeyError::Invalidated.to_string(), "KEY_INVALIDATED");
}
#[test]
fn independent_recovery_secret_opens_ciphertext_without_os_key_and_does_not_enroll_automatically() {
    let store = FakeStore::default();
    let b = binding(1);
    let dir = FixtureDir::new();
    let key = create_vault_key(&store, &b).unwrap();
    let secret = RecoverySecret::generate().unwrap();
    let envelope = seal_recovery_key(&b, &key, &secret).unwrap();
    let mut w = VaultWriter::create_encrypted(&dir.0, &key).unwrap();
    w.connection()
        .execute_batch(
            "CREATE TABLE probe(v TEXT) STRICT; INSERT INTO probe VALUES('synthetic-preserved');",
        )
        .unwrap();
    drop(w);
    drop(key);
    store.rows.borrow_mut().clear();
    assert_eq!(load_vault_key(&store, &b).err(), Some(KeyError::Missing));
    let recovered = recover_key(&b, &secret, envelope.as_bytes()).unwrap();
    let mut w = VaultWriter::open_encrypted(&dir.0, &recovered).unwrap();
    assert_eq!(
        w.connection()
            .query_row("SELECT v FROM probe", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "synthetic-preserved"
    );
    assert_eq!(
        store.writes.get(),
        1,
        "recovery no escribe OS ni activa otra instalación"
    );
}
#[test]
fn recovery_rejects_wrong_secret_tamper_binding_and_version_without_touching_os() {
    let store = FakeStore::default();
    let b = binding(1);
    let key = create_vault_key(&store, &b).unwrap();
    let secret = RecoverySecret::generate().unwrap();
    let other = RecoverySecret::generate().unwrap();
    let envelope = seal_recovery_key(&b, &key, &secret).unwrap();
    assert!(recover_key(&b, &other, envelope.as_bytes()).is_err());
    assert!(recover_key(&binding(2), &secret, envelope.as_bytes()).is_err());
    let mut bytes = envelope.as_bytes().to_vec();
    *bytes.last_mut().unwrap() ^= 1;
    assert!(recover_key(&b, &secret, &bytes).is_err());
    assert!(recover_key(&b, &secret, &bytes[..20]).is_err());
    assert_eq!(store.writes.get(), 1);
}
#[test]
fn sealing_same_key_twice_uses_distinct_random_nonces() {
    let store = FakeStore::default();
    let b = binding(1);
    let key = create_vault_key(&store, &b).unwrap();
    let secret = RecoverySecret::generate().unwrap();
    let a = seal_recovery_key(&b, &key, &secret).unwrap();
    let c = seal_recovery_key(&b, &key, &secret).unwrap();
    assert_ne!(a.as_bytes(), c.as_bytes());
    assert!(recover_key(&b, &secret, a.as_bytes()).is_ok());
    assert!(recover_key(&b, &secret, c.as_bytes()).is_ok());
}

#[test]
fn old_key_version_and_envelope_remain_readable_after_another_version_is_created() {
    // Keyring versionado; NO afirmar que se ejecutó rekey SQLCipher.
    let store = FakeStore::default();
    let id = EntityId::new_random();
    let a = KeyBinding::new(id, id, id, 1).unwrap();
    let b = KeyBinding::new(id, id, id, 2).unwrap();
    let old = create_vault_key(&store, &a).unwrap();
    let secret = RecoverySecret::generate().unwrap();
    let envelope = seal_recovery_key(&a, &old, &secret).unwrap();
    create_vault_key(&store, &b).unwrap();
    assert!(load_vault_key(&store, &a).is_ok());
    assert!(load_vault_key(&store, &b).is_ok());
    assert!(recover_key(&a, &secret, envelope.as_bytes()).is_ok());
    assert!(recover_key(&b, &secret, envelope.as_bytes()).is_err());
    assert_eq!(store.rows.borrow().len(), 2);
}

#[test]
fn valid_binding_with_unreadable_ciphertext_is_not_misreported_as_missing_or_repaired() {
    let store = FakeStore::default();
    let b = binding(1);
    let dir = FixtureDir::new();
    let key = create_vault_key(&store, &b).unwrap();
    drop(VaultWriter::create_encrypted(&dir.0, &key).unwrap());
    let before = dir.digest();
    *store
        .rows
        .borrow_mut()
        .get_mut(&b.slot())
        .unwrap()
        .last_mut()
        .unwrap() ^= 1;
    assert_eq!(
        open_existing_vault(&store, &b, &dir.0)
            .err()
            .unwrap()
            .code(),
        "VAULT_UNREADABLE"
    );
    assert_eq!(store.writes.get(), 1);
    assert_eq!(dir.digest(), before);
}
#[test]
fn creation_does_not_bypass_temporary_or_invalidated_store_errors() {
    for error in [
        KeyError::TemporarilyUnavailable,
        KeyError::Invalidated,
        KeyError::ProviderFailure,
    ] {
        let store = FakeStore::default();
        store.failure.set(Some(error));
        assert_eq!(create_vault_key(&store, &binding(1)).err(), Some(error));
        assert_eq!(store.writes.get(), 0);
        assert!(store.rows.borrow().is_empty());
    }
}
