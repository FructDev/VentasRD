//! Signed updater boundary. No renderer-supplied URL, key or installer path.
use super::*;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::AppHandle;
#[cfg(feature = "signed-updates")]
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Default)]
pub struct UpdateState {
    busy: AtomicBool,
    #[cfg(feature = "signed-updates")]
    pending: Mutex<Option<Update>>,
}
#[derive(Deserialize)]
#[serde(
    tag = "action",
    rename_all = "SCREAMING_SNAKE_CASE",
    deny_unknown_fields
)]
pub enum UpdateAction {
    Status {},
    Check {},
    Install {
        version: String,
        confirmation: String,
    },
}
struct Busy<'a>(&'a AtomicBool);
impl Drop for Busy<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release)
    }
}
fn settings(
    url: Option<&str>,
    key: Option<&str>,
) -> Result<Option<(tauri::Url, String)>, AccessError> {
    match (url, key) {
        (None, None) => Ok(None),
        (Some(url), Some(key)) => {
            let url = tauri::Url::parse(url).map_err(|_| error("UPDATE_CONFIG_INVALID"))?;
            let decoded = base64::engine::general_purpose::STANDARD
                .decode(key)
                .map_err(|_| error("UPDATE_CONFIG_INVALID"))?;
            if url.scheme() != "https"
                || url.host_str().is_none()
                || !url.username().is_empty()
                || url.password().is_some()
                || url.query().is_some()
                || url.fragment().is_some()
                || url.path() != "/api/native/releases/windows-x86_64"
                || key.len() > 2048
                || !decoded.starts_with(b"untrusted comment:")
            {
                return Err(error("UPDATE_CONFIG_INVALID"));
            }
            Ok(Some((url, key.to_owned())))
        }
        _ => Err(error("UPDATE_CONFIG_INVALID")),
    }
}
#[cfg(feature = "signed-updates")]
fn allowed_download(url: &tauri::Url) -> bool {
    let Some(origin) = option_env!("VENTARD_UPDATE_DOWNLOAD_ORIGIN") else {
        return false;
    };
    valid_download(url, origin)
}
#[cfg(any(feature = "signed-updates", test))]
fn valid_download(url: &tauri::Url, origin: &str) -> bool {
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && url.origin().ascii_serialization() == origin
}
fn can_install(snapshot: &Value) -> Result<(), AccessError> {
    if snapshot["status"] != "ready" || snapshot["mode"] != "staging-operational" {
        return Err(error("UPDATE_LOCAL_NOT_READY"));
    }
    if snapshot["pendingOperations"] != "0"
        || !snapshot["pendingAttempt"].is_null()
        || !snapshot["carts"]["active"].is_null()
    {
        return Err(error("UPDATE_OPERATIONS_PENDING"));
    }
    Ok(())
}
impl AccessState {
    fn update_authorize(&self, install: bool) -> Result<(), AccessError> {
        self.deny_archive()?;
        let (selected, writer) = self.backup_owner()?;
        let context = selected.catalogue_context();
        if install {
            writer
                .call(move |c| ventard_core::application::sales_sync::read(c, &context))
                .map_err(|e| error(e.code()))
                .and_then(|s| can_install(&s))?;
        }
        Ok(())
    }
}
#[tauri::command]
pub async fn native_update(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, UpdateState>,
    access: State<'_, Arc<AccessState>>,
    ipc_version: String,
    request_id: String,
    command: UpdateAction,
) -> Result<Value, AccessError> {
    admission(&window, &ipc_version, &request_id)?;
    let version = app.package_info().version.to_string();
    let configured = settings(
        option_env!("VENTARD_UPDATE_URL"),
        option_env!("VENTARD_UPDATE_PUBLIC_KEY"),
    )?;
    if matches!(command, UpdateAction::Status {}) {
        return Ok(
            json!({"currentVersion":version,"status":if cfg!(feature="signed-updates")&&configured.is_some(){"READY"}else{"NOT_CONFIGURED"}}),
        );
    }
    let authorize = Arc::clone(access.inner());
    tauri::async_runtime::spawn_blocking(move || authorize.update_authorize(false))
        .await
        .map_err(|_| error("UPDATE_UNAVAILABLE"))??;
    if state.busy.swap(true, Ordering::AcqRel) {
        return Err(error("UPDATE_BUSY"));
    }
    let _busy = Busy(&state.busy);
    #[cfg(not(feature = "signed-updates"))]
    {
        let _ = configured;
        Err(error("UPDATE_NOT_CONFIGURED"))
    }
    #[cfg(feature = "signed-updates")]
    {
        let (url, key) = configured.ok_or(error("UPDATE_NOT_CONFIGURED"))?;
        match command {
            UpdateAction::Check {} => {
                let update = app
                    .updater_builder()
                    .endpoints(vec![url])
                    .map_err(|_| error("UPDATE_CONFIG_INVALID"))?
                    .pubkey(key)
                    .timeout(Duration::from_secs(20))
                    .build()
                    .map_err(|_| error("UPDATE_CONFIG_INVALID"))?
                    .check()
                    .await
                    .map_err(|_| error("UPDATE_NETWORK_UNAVAILABLE"))?;
                let result = match &update {
                    Some(u) => {
                        if !allowed_download(&u.download_url) {
                            return Err(error("UPDATE_CONFIG_INVALID"));
                        }
                        json!({"currentVersion":version,"status":"AVAILABLE","version":u.version,"notes":u.body})
                    }
                    None => json!({"currentVersion":version,"status":"UP_TO_DATE"}),
                };
                *state.pending.lock().map_err(|_| error("UPDATE_BUSY"))? = update;
                Ok(result)
            }
            UpdateAction::Install {
                version,
                confirmation,
            } => {
                if confirmation != "INSTALAR_ACTUALIZACION" {
                    return Err(error("UPDATE_CONFIRMATION_REQUIRED"));
                }
                let update = state
                    .pending
                    .lock()
                    .map_err(|_| error("UPDATE_BUSY"))?
                    .clone()
                    .filter(|u| u.version == version)
                    .ok_or(error("UPDATE_CHECK_REQUIRED"))?;
                if !allowed_download(&update.download_url) {
                    return Err(error("UPDATE_CONFIG_INVALID"));
                }
                // Signature verification is enforced by the official plugin.
                let bytes = update
                    .download(|_, _| {}, || {})
                    .await
                    .map_err(|_| error("UPDATE_DOWNLOAD_OR_SIGNATURE_INVALID"))?;
                // Recheck local operations AFTER download, before Windows exits.
                let authorize = Arc::clone(access.inner());
                tauri::async_runtime::spawn_blocking(move || authorize.update_authorize(true))
                    .await
                    .map_err(|_| error("UPDATE_UNAVAILABLE"))??;
                update
                    .install(bytes)
                    .map_err(|_| error("UPDATE_INSTALL_FAILED"))?;
                Ok(json!({"status":"INSTALLING"}))
            }
            UpdateAction::Status {} => unreachable!(),
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn downloads_stay_on_pinned_https_origin_without_credentials() {
        let origin = "https://ventard.vercel.app";
        assert!(valid_download(
            &tauri::Url::parse("https://ventard.vercel.app/downloads/app.exe").unwrap(),
            origin
        ));
        for url in [
            "http://ventard.vercel.app/app.exe",
            "https://other.test/app.exe",
            "https://user:pass@ventard.vercel.app/app.exe",
            "https://ventard.vercel.app/app.exe?token=x",
        ] {
            assert!(!valid_download(&tauri::Url::parse(url).unwrap(), origin));
        }
    }
    #[test]
    fn missing_update_configuration_stays_disabled_and_foreign_transport_is_rejected() {
        assert!(settings(None, None).unwrap().is_none());
        let key =
            base64::engine::general_purpose::STANDARD.encode("untrusted comment: fixture\nfixture");
        assert!(settings(
            Some("https://release.example.test/api/native/releases/windows-x86_64"),
            Some(&key)
        )
        .unwrap()
        .is_some());
        for url in [
            "http://release.example.test/api/native/releases/windows-x86_64",
            "https://user:password@release.example.test/api/native/releases/windows-x86_64",
            "https://release.example.test/arbitrary",
            "https://release.example.test/api/native/releases/windows-x86_64?token=secret",
        ] {
            assert!(settings(Some(url), Some(&key)).is_err())
        }
    }
    #[test]
    fn update_install_preserves_pending_operations_and_requires_local_preparation() {
        let ready = json!({"status":"ready","mode":"staging-operational","pendingOperations":"0","pendingAttempt":null,"carts":{"active":null}});
        assert!(can_install(&ready).is_ok());
        for (key, value) in [
            ("pendingOperations", json!("1")),
            ("pendingAttempt", json!({"id":"fixture"})),
            ("carts", json!({"active":{"id":"fixture"}})),
            ("mode", json!("recovery-readonly")),
        ] {
            let mut value2 = ready.clone();
            value2[key] = value;
            assert!(can_install(&value2).is_err())
        }
        let state = AccessState::new(PathBuf::from("unused-update-fixture"));
        assert_eq!(
            state.update_authorize(true).err().unwrap().code,
            "ACCESS_PIN_REQUIRED"
        );
        assert!(serde_json::from_value::<UpdateAction>(
            json!({"action":"CHECK","url":"https://forged.test"})
        )
        .is_err());
    }
}
