#![cfg(windows)]
use keyring_core::{api::CredentialStoreApi, Entry};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
};
use ventard_core::security::key_provider::{
    create_vault_key, load_vault_key, KeyBinding, KeyError, NativeKeyStore,
};
use ventard_core::{domain::identity::EntityId, storage::writer::VaultWriter};
use ventard_pos_lib::platform::keys::windows::WindowsKeyStore;

// Metadata/delete del fixture usan APIs crudas, fuera del adaptador. No ejecutar
// cleanup de un caso mientras otro prueba provisionamiento. La concurrencia
// del producto sigue probándose con 16 threads dentro del tercer caso.
static FIXTURE_LIFECYCLE: Mutex<()> = Mutex::new(());

struct Fixture {
    path: PathBuf,
    credential: Entry,
}
impl Fixture {
    fn new(binding: &KeyBinding) -> Self {
        let path =
            std::env::temp_dir().join(format!("ventard-os-key-fixture-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&path).unwrap();
        let slot = binding.slot();
        let credential = windows_native_keyring_store::Store::new()
            .unwrap()
            .build(
                "VentaRD Native QA",
                "vault-key",
                Some(&HashMap::from([
                    ("target", slot.as_str()),
                    ("persistence", "Local"),
                ])),
            )
            .unwrap();
        assert!(
            matches!(credential.get_secret(), Err(keyring_core::Error::NoEntry)),
            "no modificar ninguna credencial existente"
        );
        Self { path, credential }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        // Únicamente la credencial UUID creada por este fixture; no enumerar.
        let _ = self.credential.delete_credential();
        if let (Ok(target), Ok(root)) = (
            self.path.canonicalize(),
            std::env::temp_dir().canonicalize(),
        ) {
            assert!(
                target.starts_with(root)
                    && target
                        .file_name()
                        .unwrap()
                        .to_string_lossy()
                        .starts_with("ventard-os-key-fixture-")
            );
            let _ = std::fs::remove_dir_all(target);
        }
    }
}
fn binding() -> KeyBinding {
    KeyBinding::new(
        EntityId::new_random(),
        EntityId::new_random(),
        EntityId::new_random(),
        1,
    )
    .unwrap()
}

#[test]
fn actual_windows_store_is_machine_local_and_reopens_encrypted_vault() {
    let _fixtures = FIXTURE_LIFECYCLE.lock().unwrap();
    let b = binding();
    let fixture = Fixture::new(&b);
    let store = WindowsKeyStore::new(fixture.path.join("locks")).unwrap();
    assert_eq!(load_vault_key(&store, &b).err(), Some(KeyError::Missing));
    let key = create_vault_key(&store, &b).unwrap();
    assert_eq!(
        fixture.credential.get_attributes().unwrap()["persistence"],
        "Local"
    );
    let db = fixture.path.join("vault");
    std::fs::create_dir(&db).unwrap();
    let mut w = VaultWriter::create_encrypted(&db, &key).unwrap();
    w.connection()
        .execute_batch(
            "CREATE TABLE probe(v TEXT) STRICT; INSERT INTO probe VALUES('os-synthetic');",
        )
        .unwrap();
    drop(w);
    drop(key);
    drop(store);
    let reopened_store = WindowsKeyStore::new(fixture.path.join("locks")).unwrap();
    let key = load_vault_key(&reopened_store, &b).unwrap();
    let mut w = VaultWriter::open_encrypted(&db, &key).unwrap();
    assert_eq!(
        w.connection()
            .query_row("SELECT v FROM probe", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "os-synthetic"
    );
    assert_eq!(
        create_vault_key(&reopened_store, &b).err(),
        Some(KeyError::AlreadyExists)
    );
}

#[test]
fn backend_create_new_never_overwrites_even_if_factory_read_is_stale() {
    let _fixtures = FIXTURE_LIFECYCLE.lock().unwrap();
    let b = binding();
    let fixture = Fixture::new(&b);
    let store = WindowsKeyStore::new(fixture.path.join("locks")).unwrap();
    create_vault_key(&store, &b).unwrap();
    let before = store.read(&b.slot()).unwrap();
    assert_eq!(
        store.create_new(&b.slot(), &[0u8; 92]),
        Err(KeyError::AlreadyExists)
    );
    assert_eq!(*store.read(&b.slot()).unwrap(), *before);
}

#[test]
fn distinct_slots_can_be_provisioned_concurrently_without_uncertain_readback() {
    let _fixtures = FIXTURE_LIFECYCLE.lock().unwrap();
    // Targets sintéticos independientes; no esconder concurrencia con test-threads=1.
    let fixtures: Vec<_> = (0..16)
        .map(|_| {
            let b = binding();
            let fixture = Fixture::new(&b);
            (b, fixture)
        })
        .collect();
    let stores: Vec<_> = fixtures
        .iter()
        .map(|(_, f)| WindowsKeyStore::new(f.path.join("locks")).unwrap())
        .collect();
    let start = Arc::new(std::sync::Barrier::new(stores.len()));
    std::thread::scope(|scope| {
        let handles: Vec<_> = stores
            .iter()
            .zip(&fixtures)
            .map(|(store, (b, _))| {
                let start = Arc::clone(&start);
                scope.spawn(move || {
                    start.wait();
                    create_vault_key(store, b).unwrap();
                    assert!(load_vault_key(store, b).is_ok());
                    assert_eq!(
                        create_vault_key(store, b).err(),
                        Some(KeyError::AlreadyExists)
                    );
                })
            })
            .collect();
        for handle in handles {
            handle.join().unwrap();
        }
    });
}
