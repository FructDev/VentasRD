//! Adaptador DEBUG+feature explícita, Windows, namespace QA y datos sintéticos.
//! No aceptar SQL, root/vault/tenant/key/actor del renderer. No permiso comercial.
use crate::platform::keys::windows::WindowsKeyStore;
use serde::{Deserialize, Serialize};
use std::{
    fs::OpenOptions,
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tauri::{State, WebviewWindow};
use ventard_core::qa::{QaCartAction, QaCartResult, QaCartSave};
use ventard_core::{
    domain::identity::EntityId,
    qa::{
        QaCatalogue, QaCatalogueResult, QaCheckout, QaProductWrite, QaQuote, QaQuoteRequest,
        QaResult, QaSaleRequest, QaStockChange, QA_TENANT,
    },
    security::key_provider::{create_vault_key, load_vault_key, KeyBinding},
};

#[derive(Serialize)]
pub struct QaError {
    code: &'static str,
}
fn err(code: &'static str) -> QaError {
    QaError { code }
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Identity {
    vault_id: String,
    installation_id: String,
}
impl Identity {
    fn binding(&self) -> Result<KeyBinding, QaError> {
        KeyBinding::new(
            EntityId::parse(QA_TENANT).map_err(|_| err("QA_IDENTITY_INVALID"))?,
            EntityId::parse(&self.vault_id).map_err(|_| err("QA_IDENTITY_INVALID"))?,
            EntityId::parse(&self.installation_id).map_err(|_| err("QA_IDENTITY_INVALID"))?,
            1,
        )
        .map_err(|e| err(e.code()))
    }
}
pub struct QaState {
    root: PathBuf,
    store: Mutex<Option<QaCheckout>>,
    lose_response_once: AtomicBool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QaRead {
    status: &'static str,
    catalogue: Option<QaCatalogue>,
}
impl QaState {
    pub fn new(root: PathBuf) -> Self {
        // Fault injection is native-side and ONLY for an explicitly owned,
        // validated temporary harness fixture. Never accept this from IPC or
        // weaken the non-writable Tauri internals to simulate a lost response.
        let owned_fixture = root.parent().is_some_and(|parent| {
            parent
                .to_str()
                .is_some_and(|value| fixture_root(value).is_ok())
        });
        let lose_response_once = cfg!(debug_assertions)
            && owned_fixture
            && std::env::var("VENTARD_QA_LOSE_SALE_RESPONSE_ONCE").as_deref() == Ok("1")
            && std::env::var("VENTARD_QA_SHELL_SMOKE").as_deref() == Ok("1");
        Self {
            root,
            store: Mutex::new(None),
            lose_response_once: AtomicBool::new(lose_response_once),
        }
    }
    fn identity(&self) -> Result<Identity, QaError> {
        let p = self.root.join("qa-identity.json");
        if std::fs::metadata(&p)
            .map_err(|_| err("QA_IDENTITY_MISSING"))?
            .len()
            > 1024
        {
            return Err(err("QA_IDENTITY_INVALID"));
        }
        serde_json::from_slice(&std::fs::read(p).map_err(|_| err("QA_IDENTITY_MISSING"))?)
            .map_err(|_| err("QA_IDENTITY_INVALID"))
    }
    fn keys(&self) -> Result<WindowsKeyStore, QaError> {
        WindowsKeyStore::new(
            self.root
                .parent()
                .ok_or_else(|| err("QA_PATH_INVALID"))?
                .join("qa-key-locks"),
        )
        .map_err(|e| err(e.code()))
    }
    fn use_store<R>(
        &self,
        f: impl FnOnce(&QaCheckout) -> Result<R, QaError>,
    ) -> Result<R, QaError> {
        let mut guard = self
            .store
            .lock()
            .map_err(|_| err("QA_STORAGE_UNAVAILABLE"))?;
        if guard.is_none() {
            let identity = self.identity()?;
            let key =
                load_vault_key(&self.keys()?, &identity.binding()?).map_err(|e| err(e.code()))?;
            *guard =
                Some(QaCheckout::open(&self.root, key).map_err(|_| err("QA_VAULT_UNREADABLE"))?);
        }
        f(guard
            .as_ref()
            .ok_or_else(|| err("QA_STORAGE_UNAVAILABLE"))?)
    }
    fn read(&self) -> Result<QaRead, QaError> {
        if !self.root.join("qa-identity.json").exists() {
            if self.root.join("pos_core.db").exists() {
                return Err(err("QA_IDENTITY_MISSING"));
            }
            return Ok(QaRead {
                status: "NOT_PROVISIONED",
                catalogue: None,
            });
        }
        self.use_store(|s| {
            Ok(QaRead {
                status: "READY",
                catalogue: Some(s.catalogue().map_err(|e| err(e.code()))?),
            })
        })
    }
    fn create(&self) -> Result<QaRead, QaError> {
        let mut guard = self
            .store
            .lock()
            .map_err(|_| err("QA_STORAGE_UNAVAILABLE"))?;
        if guard.is_some()
            || self.root.join("qa-identity.json").exists()
            || self.root.join("pos_core.db").exists()
        {
            return Err(err("QA_VAULT_EXISTS"));
        }
        std::fs::create_dir_all(&self.root).map_err(|_| err("QA_STORAGE_UNAVAILABLE"))?;
        let identity = Identity {
            vault_id: EntityId::new_random().to_string(),
            installation_id: EntityId::new_random().to_string(),
        };
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(self.root.join("qa-identity.json"))
            .map_err(|_| err("QA_VAULT_EXISTS"))?;
        file.write_all(&serde_json::to_vec(&identity).map_err(|_| err("QA_IDENTITY_INVALID"))?)
            .and_then(|_| file.sync_all())
            .map_err(|_| err("QA_STORAGE_UNAVAILABLE"))?;
        // Fallo deja intención/meta visible; JAMÁS regenerar silenciosamente en read.
        let key =
            create_vault_key(&self.keys()?, &identity.binding()?).map_err(|e| err(e.code()))?;
        let store =
            QaCheckout::create(&self.root, key).map_err(|_| err("QA_STORAGE_UNAVAILABLE"))?;
        let catalogue = store.catalogue().map_err(|e| err(e.code()))?;
        *guard = Some(store);
        Ok(QaRead {
            status: "READY",
            catalogue: Some(catalogue),
        })
    }
}
pub fn fixture_root(value: &str) -> Result<PathBuf, QaError> {
    let path = Path::new(value)
        .canonicalize()
        .map_err(|_| err("QA_PATH_INVALID"))?;
    let temp = std::env::temp_dir()
        .canonicalize()
        .map_err(|_| err("QA_PATH_INVALID"))?;
    if !path.starts_with(temp)
        || !path
            .file_name()
            .ok_or_else(|| err("QA_PATH_INVALID"))?
            .to_string_lossy()
            .starts_with("ventard-native-spike-")
    {
        return Err(err("QA_PATH_INVALID"));
    }
    Ok(path.join("vault"))
}
fn admission(window: &WebviewWindow, ipc_version: &str, request_id: &str) -> Result<(), QaError> {
    if !cfg!(debug_assertions) || window.label() != "main" {
        return Err(err("QA_DISABLED"));
    }
    if ipc_version != "ventard.qa.ipc.1" || EntityId::parse(request_id).is_err() {
        return Err(err("QA_CONTRACT_INVALID"));
    }
    Ok(())
}
#[tauri::command]
pub async fn qa_read(
    window: WebviewWindow,
    state: State<'_, Arc<QaState>>,
    ipc_version: String,
    request_id: String,
) -> Result<QaRead, QaError> {
    admission(&window, &ipc_version, &request_id)?;
    let s = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || s.read())
        .await
        .map_err(|_| err("QA_STORAGE_UNAVAILABLE"))?
}
#[tauri::command]
pub async fn qa_create(
    window: WebviewWindow,
    state: State<'_, Arc<QaState>>,
    ipc_version: String,
    request_id: String,
) -> Result<QaRead, QaError> {
    admission(&window, &ipc_version, &request_id)?;
    let s = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || s.create())
        .await
        .map_err(|_| err("QA_STORAGE_UNAVAILABLE"))?
}
#[tauri::command]
pub async fn qa_sell(
    window: WebviewWindow,
    state: State<'_, Arc<QaState>>,
    ipc_version: String,
    request_id: String,
    sale: QaSaleRequest,
) -> Result<QaResult, QaError> {
    admission(&window, &ipc_version, &request_id)?;
    let s = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let result = s.use_store(|store| store.confirm(sale).map_err(|e| err(e.code())))?;
        if s.lose_response_once.swap(false, Ordering::AcqRel) {
            return Err(err("QA_RESPONSE_LOST"));
        }
        Ok(result)
    })
    .await
    .map_err(|_| err("QA_STORAGE_UNAVAILABLE"))?
}
#[tauri::command]
pub async fn qa_result(
    window: WebviewWindow,
    state: State<'_, Arc<QaState>>,
    ipc_version: String,
    request_id: String,
    operation_id: String,
) -> Result<Option<QaResult>, QaError> {
    admission(&window, &ipc_version, &request_id)?;
    let s = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        s.use_store(|store| {
            store
                .operation_result(&operation_id)
                .map_err(|e| err(e.code()))
        })
    })
    .await
    .map_err(|_| err("QA_STORAGE_UNAVAILABLE"))?
}
#[tauri::command]
pub async fn qa_quote(
    window: WebviewWindow,
    state: State<'_, Arc<QaState>>,
    ipc_version: String,
    request_id: String,
    quote: QaQuoteRequest,
) -> Result<QaQuote, QaError> {
    admission(&window, &ipc_version, &request_id)?;
    let s = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        s.use_store(|store| store.quote_options(quote).map_err(|e| err(e.code())))
    })
    .await
    .map_err(|_| err("QA_STORAGE_UNAVAILABLE"))?
}
#[tauri::command]
pub async fn qa_sale_abandon(
    window: WebviewWindow,
    state: State<'_, Arc<QaState>>,
    ipc_version: String,
    request_id: String,
    operation_id: String,
) -> Result<(), QaError> {
    admission(&window, &ipc_version, &request_id)?;
    let s = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        s.use_store(|store| store.abandon_sale(operation_id).map_err(|e| err(e.code())))
    })
    .await
    .map_err(|_| err("QA_STORAGE_UNAVAILABLE"))?
}
#[tauri::command]
pub async fn qa_sale_ticket(
    window: WebviewWindow,
    state: State<'_, Arc<QaState>>,
    ipc_version: String,
    request_id: String,
    operation_id: String,
) -> Result<serde_json::Value, QaError> {
    admission(&window, &ipc_version, &request_id)?;
    let s = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        s.use_store(|store| {
            store
                .ticket_snapshot(operation_id)
                .map_err(|e| err(e.code()))
        })
    })
    .await
    .map_err(|_| err("QA_STORAGE_UNAVAILABLE"))?
}
#[tauri::command]
pub async fn qa_history_read(
    window: WebviewWindow,
    state: State<'_, Arc<QaState>>,
    ipc_version: String,
    request_id: String,
    filter: ventard_core::application::history::HistoryFilter,
) -> Result<ventard_core::application::history::HistoryPage, QaError> {
    admission(&window, &ipc_version, &request_id)?;
    let s = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        s.use_store(|store| store.history_read(filter).map_err(|e| err(e.code())))
    })
    .await
    .map_err(|_| err("QA_STORAGE_UNAVAILABLE"))?
}

#[tauri::command]
pub async fn qa_product_save(
    window: WebviewWindow,
    state: State<'_, Arc<QaState>>,
    ipc_version: String,
    request_id: String,
    product: QaProductWrite,
) -> Result<QaCatalogueResult, QaError> {
    admission(&window, &ipc_version, &request_id)?;
    let s = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        s.use_store(|store| store.save_product(product).map_err(|e| err(e.code())))
    })
    .await
    .map_err(|_| err("QA_STORAGE_UNAVAILABLE"))?
}
#[tauri::command]
pub async fn qa_stock_adjust(
    window: WebviewWindow,
    state: State<'_, Arc<QaState>>,
    ipc_version: String,
    request_id: String,
    movement: QaStockChange,
) -> Result<QaCatalogueResult, QaError> {
    admission(&window, &ipc_version, &request_id)?;
    let s = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        s.use_store(|store| store.adjust_stock(movement).map_err(|e| err(e.code())))
    })
    .await
    .map_err(|_| err("QA_STORAGE_UNAVAILABLE"))?
}

#[tauri::command]
pub async fn qa_cart_save(
    window: WebviewWindow,
    state: State<'_, Arc<QaState>>,
    ipc_version: String,
    request_id: String,
    cart: QaCartSave,
) -> Result<QaCartResult, QaError> {
    admission(&window, &ipc_version, &request_id)?;
    let s = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        s.use_store(|store| store.save_cart(cart).map_err(|e| err(e.code())))
    })
    .await
    .map_err(|_| err("QA_STORAGE_UNAVAILABLE"))?
}
#[tauri::command]
pub async fn qa_cart_action(
    window: WebviewWindow,
    state: State<'_, Arc<QaState>>,
    ipc_version: String,
    request_id: String,
    cart: QaCartAction,
) -> Result<QaCartResult, QaError> {
    admission(&window, &ipc_version, &request_id)?;
    let s = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        s.use_store(|store| store.cart_action(cart).map_err(|e| err(e.code())))
    })
    .await
    .map_err(|_| err("QA_STORAGE_UNAVAILABLE"))?
}
