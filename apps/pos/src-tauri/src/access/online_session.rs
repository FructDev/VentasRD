//! OS custody of the rotating Staging refresh token. Never exported/backed up.
use super::*;
use fs2::FileExt;
use keyring_core::{api::CredentialStoreApi, Entry, Error as StoreError};
use std::{collections::HashMap, fs::File, sync::MutexGuard};
use subtle::ConstantTimeEq;
use windows_native_keyring_store::Store;

static SESSION_GATE: Mutex<()> = Mutex::new(());

// Serializes rotation and persistence across threads AND app processes. The
// file contains no token. Different installations/actors have different slots.
struct RefreshStore {
    entry: Entry,
    _file: File,
    _gate: MutexGuard<'static, ()>,
}
impl RefreshStore {
    fn open(root: &Path, selected: &Selection) -> Result<Self, AccessError> {
        selected.identity.context(&selected.actor_id)?;
        let slot = format!(
            "{}.{}.{}",
            if cfg!(feature="production-pilot") {"com.ventard.pos.production-auth"} else {"com.ventard.pos.qa.staging-auth"},
            selected.identity.binding()?.slot(),
            selected.actor_id
        );
        std::fs::create_dir_all(root).map_err(|_| error("ACCESS_SESSION_STORAGE"))?;
        let gate = SESSION_GATE
            .lock()
            .map_err(|_| error("ACCESS_SESSION_STORAGE"))?;
        let path = root.join("online-session.lock");
        match std::fs::symlink_metadata(&path) {
            Ok(m) if !m.is_file() => return Err(error("ACCESS_SESSION_STORAGE")),
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                return Err(error("ACCESS_SESSION_STORAGE"))
            }
            _ => {}
        }
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(path)
            .map_err(|_| error("ACCESS_SESSION_STORAGE"))?;
        file.try_lock_exclusive()
            .map_err(|_| error("ACCESS_BUSY"))?;
        let store = Store::new().map_err(|_| error("ACCESS_SESSION_STORAGE"))?;
        let entry = store
            .build(
                if cfg!(feature="production-pilot") {"VentaRD Native"} else {"VentaRD Native QA"},
                if cfg!(feature="production-pilot") {"production-auth"} else {"staging-auth"},
                Some(&HashMap::from([
                    ("target", slot.as_str()),
                    ("persistence", "Local"),
                ])),
            )
            .map_err(|_| error("ACCESS_SESSION_STORAGE"))?;
        Ok(Self {
            entry,
            _file: file,
            _gate: gate,
        })
    }
    fn read(&self) -> Result<Option<Zeroizing<String>>, AccessError> {
        match self.entry.get_attributes() {
            Err(StoreError::NoEntry) => return Ok(None),
            Ok(attributes)
                if attributes.get("persistence").map(String::as_str) == Some("Local") => {}
            _ => return Err(error("ACCESS_SESSION_STORAGE")),
        }
        let bytes = Zeroizing::new(
            self.entry
                .get_secret()
                .map_err(|_| error("ACCESS_SESSION_STORAGE"))?,
        );
        let token = std::str::from_utf8(&bytes).map_err(|_| error("ACCESS_SESSION_STORAGE"))?;
        if !valid_refresh(token) {
            return Err(error("ACCESS_SESSION_STORAGE"));
        }
        Ok(Some(Zeroizing::new(token.to_owned())))
    }
    fn save(&self, token: &str) -> Result<(), AccessError> {
        if !valid_refresh(token) {
            return Err(error("ACCESS_RESPONSE_INVALID"));
        }
        self.entry
            .set_secret(token.as_bytes())
            .map_err(|_| error("ACCESS_SESSION_STORAGE"))?;
        let saved = self.read()?.ok_or(error("ACCESS_SESSION_STORAGE"))?;
        if !bool::from(saved.as_bytes().ct_eq(token.as_bytes())) {
            return Err(error("ACCESS_SESSION_STORAGE"));
        }
        Ok(())
    }
    fn clear(&self) -> Result<(), AccessError> {
        match self.entry.delete_credential() {
            Ok(()) | Err(StoreError::NoEntry) => Ok(()),
            Err(_) => Err(error("ACCESS_SESSION_STORAGE")),
        }
    }
}
fn valid_refresh(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 1024
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
pub(super) fn tokens(
    data: &mut Value,
    expected: Option<&str>,
    now: u64,
) -> Result<Session, AccessError> {
    let actor = data["user"]["id"]
        .as_str()
        .ok_or(error("ACCESS_RESPONSE_INVALID"))?
        .to_owned();
    id(&actor).map_err(|_| error("ACCESS_RESPONSE_INVALID"))?;
    if expected.is_some_and(|id| id != actor) || data["user"]["is_anonymous"] == true {
        return Err(error("ACCESS_RESPONSE_INVALID"));
    }
    let expires_at = data["expires_at"]
        .as_u64()
        .and_then(|s| s.checked_mul(1000))
        .filter(|s| *s > now)
        .ok_or(error("ACCESS_RESPONSE_INVALID"))?;
    let token = match data["access_token"].take() {
        Value::String(s) if !s.is_empty() && s.len() <= 8192 => Zeroizing::new(s),
        _ => return Err(error("ACCESS_RESPONSE_INVALID")),
    };
    let refresh = match data["refresh_token"].take() {
        Value::String(s) if valid_refresh(&s) => Zeroizing::new(s),
        _ => return Err(error("ACCESS_RESPONSE_INVALID")),
    };
    Ok(Session {
        actor,
        token,
        refresh,
        tenants: vec![],
        expires_at,
    })
}

impl AccessState {
    pub(super) fn remember_session(
        &self,
        selected: &Selection,
        session: &Session,
    ) -> Result<(), AccessError> {
        if selected.actor_id != session.actor {
            return Err(error("ACCESS_ACTOR_DENIED"));
        }
        RefreshStore::open(&self.root, selected)?.save(&session.refresh)
    }
    pub(super) fn forget_session(&self, selected: &Selection) -> Result<(), AccessError> {
        RefreshStore::open(&self.root, selected)?.clear()
    }
    // Called only by network operations AFTER local grant/PIN authorization.
    // Opening the vault, checking status and unlocking the PIN remain offline.
    pub(super) fn online_token(
        &self,
        inner: &mut Inner,
        selected: &Selection,
    ) -> Result<Zeroizing<String>, AccessError> {
        self.online_token_with(inner, selected, |config, refresh| {
            let r = Self::client()?
                .post(format!("{HOST}/auth/v1/token?grant_type=refresh_token"))
                .header("apikey", &config.publishable_key)
                .json(&json!({"refresh_token":refresh}))
                .send()
                .map_err(|_| error("ACCESS_NETWORK_UNAVAILABLE"))?;
            let status = r.status();
            let data = response(r)?;
            if !status.is_success() {
                return Err(error(match (status.as_u16(), data["code"].as_str()) {
                    (
                        400 | 401 | 403,
                        Some(
                            "refresh_token_not_found"
                            | "refresh_token_already_used"
                            | "session_not_found"
                            | "session_expired"
                            | "user_banned"
                            | "user_not_found",
                        ),
                    ) => "ACCESS_SESSION_REVOKED",
                    (401 | 403, _) => "ACCESS_SESSION_REVOKED",
                    (429, _) => "ACCESS_RATE_LIMITED",
                    _ => "ACCESS_NETWORK_UNAVAILABLE",
                }));
            }
            Ok(data)
        })
    }
    fn online_token_with(
        &self,
        inner: &mut Inner,
        selected: &Selection,
        refresh: impl FnOnce(&Config, &str) -> Result<Value, AccessError>,
    ) -> Result<Zeroizing<String>, AccessError> {
        if !inner.unlocked
            || inner
                .selected
                .as_ref()
                .is_none_or(|s| s.catalogue_context() != selected.catalogue_context())
        {
            return Err(error("ACCESS_PIN_REQUIRED"));
        }
        let now = time()?;
        if let Some(s) = inner
            .session
            .as_ref()
            .filter(|s| s.actor == selected.actor_id && s.expires_at > now.saturating_add(30_000))
        {
            return Ok(Zeroizing::new(s.token.to_string()));
        }
        let config = self.config(inner)?;
        let store = RefreshStore::open(&self.root, selected)?;
        let saved = store.read()?.ok_or(error("ACCESS_LOGIN_REQUIRED"))?;
        let mut data = match refresh(&config, &saved) {
            Err(e) if e.code == "ACCESS_SESSION_REVOKED" => {
                inner.session = None;
                store.clear()?;
                return Err(error("ACCESS_LOGIN_REQUIRED"));
            }
            result => result?,
        };
        let session = tokens(&mut data, Some(&selected.actor_id), time()?)?;
        // Persist the rotated token before any commercial request is allowed.
        store.save(&session.refresh)?;
        let token = Zeroizing::new(session.token.to_string());
        inner.session = Some(session);
        Ok(token)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn selection() -> Selection {
        Selection {
            actor_id: EntityId::new_random().to_string(),
            identity: Identity {
                tenant_id: TENANTS[2].into(),
                device_id: EntityId::new_random().to_string(),
                installation_id: EntityId::new_random().to_string(),
                vault_id: EntityId::new_random().to_string(),
                scope_type: "BRANCH".into(),
                branch_id: Some(EntityId::new_random().to_string()),
            },
        }
    }
    fn reply(actor: &str, refresh: &str) -> Value {
        json!({"user":{"id":actor,"is_anonymous":false},"access_token":"fixture-access-only","refresh_token":refresh,"expires_at":200})
    }
    #[test]
    fn refresh_rejects_other_actor_expired_anonymous_and_malformed_without_echoing_secrets() {
        let actor = EntityId::new_random().to_string();
        let mut good = reply(&actor, "fixture-refresh-1");
        let session = tokens(&mut good, Some(&actor), 100_000).unwrap();
        assert_eq!(session.actor, actor);
        assert_eq!(session.expires_at, 200_000);
        assert!(good["refresh_token"].is_null());
        for mut bad in [
            reply(&EntityId::new_random().to_string(), "fixture-refresh-1"),
            reply(&actor, ""),
            reply(&actor, "secret\ninvalid"),
        ] {
            let e = tokens(&mut bad, Some(&actor), 100_000).err().unwrap();
            assert_eq!(
                serde_json::to_string(&e).unwrap(),
                r#"{"code":"ACCESS_RESPONSE_INVALID"}"#
            );
        }
        let mut expired = reply(&actor, "fixture-refresh-1");
        assert!(tokens(&mut expired, Some(&actor), 200_000).is_err());
        let mut anonymous = reply(&actor, "fixture-refresh-1");
        anonymous["user"]["is_anonymous"] = json!(true);
        assert!(tokens(&mut anonymous, Some(&actor), 100_000).is_err());
    }
    #[test]
    fn windows_refresh_survives_reopen_rotates_and_logout_deletes_only_its_exact_slot() {
        let root = std::env::temp_dir().join(format!(
            "ventard-online-session-fixture-{}",
            EntityId::new_random()
        ));
        let selected = selection();
        let other = selection();
        {
            let store = RefreshStore::open(&root, &selected).unwrap();
            assert!(store.read().unwrap().is_none());
            store.save("fixture-refresh-1").unwrap();
        }
        {
            let store = RefreshStore::open(&root, &selected).unwrap();
            assert_eq!(
                &**store.read().unwrap().as_ref().unwrap(),
                "fixture-refresh-1"
            );
            store.save("fixture-refresh-2").unwrap();
        }
        {
            let store = RefreshStore::open(&root, &other).unwrap();
            assert!(store.read().unwrap().is_none());
            store.save("fixture-other-refresh").unwrap();
        }
        {
            let store = RefreshStore::open(&root, &selected).unwrap();
            assert_eq!(
                &**store.read().unwrap().as_ref().unwrap(),
                "fixture-refresh-2"
            );
            store.clear().unwrap();
            store.clear().unwrap();
            assert!(store.read().unwrap().is_none());
        }
        {
            let store = RefreshStore::open(&root, &other).unwrap();
            assert_eq!(
                &**store.read().unwrap().as_ref().unwrap(),
                "fixture-other-refresh"
            );
            store.clear().unwrap();
        }
        // No token/secret in the profile files, including its lock.
        for entry in std::fs::read_dir(&root).unwrap() {
            assert!(
                !String::from_utf8_lossy(&std::fs::read(entry.unwrap().path()).unwrap())
                    .contains("fixture-")
            );
        }
        let path = root.canonicalize().unwrap();
        assert!(path.starts_with(std::env::temp_dir().canonicalize().unwrap()));
        assert!(path
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("ventard-online-session-fixture-"));
        std::fs::remove_dir_all(path).unwrap();
    }
    #[test]
    fn restart_refresh_is_pin_gated_recovers_timeout_and_revocation_preserves_local_selection() {
        let root = std::env::temp_dir().join(format!(
            "ventard-online-session-fixture-{}",
            EntityId::new_random()
        ));
        let selected = selection();
        RefreshStore::open(&root, &selected)
            .unwrap()
            .save("fixture-initial")
            .unwrap();
        let state = AccessState::new(root.clone());
        let mut inner = state.inner.lock().unwrap();
        inner.config = Some(Config {
            web_origin: None,
            publishable_key: "sb_publishable_fixture".into(),
            key_id: "fixture-only".into(),
            public_hex: "12".repeat(32),
            issuer_url: HOSTED_ISSUER.into(),
        });
        inner.selected = Some(selected.clone());
        assert_eq!(
            state
                .online_token_with(&mut inner, &selected, |_, _| panic!(
                    "locked must not send auth"
                ))
                .err()
                .unwrap()
                .code,
            "ACCESS_PIN_REQUIRED"
        );
        inner.unlocked = true;
        assert_eq!(
            state
                .online_token_with(&mut inner, &selected, |_, _| Err(error(
                    "ACCESS_NETWORK_UNAVAILABLE"
                )))
                .err()
                .unwrap()
                .code,
            "ACCESS_NETWORK_UNAVAILABLE"
        );
        assert_eq!(
            &**RefreshStore::open(&root, &selected)
                .unwrap()
                .read()
                .unwrap()
                .as_ref()
                .unwrap(),
            "fixture-initial"
        );
        let foreign = EntityId::new_random().to_string();
        assert!(state
            .online_token_with(&mut inner, &selected, |_, _| {
                let mut value = reply(&foreign, "fixture-forged");
                value["expires_at"] = json!(time().unwrap() / 1000 + 3600);
                Ok(value)
            })
            .is_err());
        let token = state
            .online_token_with(&mut inner, &selected, |_, previous| {
                assert_eq!(previous, "fixture-initial");
                let mut value = reply(&selected.actor_id, "fixture-rotated");
                value["expires_at"] = json!(time().unwrap() / 1000 + 3600);
                Ok(value)
            })
            .unwrap();
        assert_eq!(&*token, "fixture-access-only");
        assert!(state
            .online_token_with(&mut inner, &selected, |_, _| panic!(
                "fresh in-memory token must not rotate twice"
            ))
            .is_ok());
        drop(inner);
        drop(state);
        let reopened = AccessState::new(root.clone());
        let mut inner = reopened.inner.lock().unwrap();
        inner.config = Some(Config {
            web_origin: None,
            publishable_key: "sb_publishable_fixture".into(),
            key_id: "fixture-only".into(),
            public_hex: "12".repeat(32),
            issuer_url: HOSTED_ISSUER.into(),
        });
        inner.selected = Some(selected.clone());
        inner.unlocked = true;
        assert_eq!(
            reopened
                .online_token_with(&mut inner, &selected, |_, previous| {
                    assert_eq!(previous, "fixture-rotated");
                    Err(error("ACCESS_SESSION_REVOKED"))
                })
                .err()
                .unwrap()
                .code,
            "ACCESS_LOGIN_REQUIRED"
        );
        assert!(inner.unlocked);
        assert_eq!(
            inner.selected.as_ref().unwrap().identity.installation_id,
            selected.identity.installation_id
        );
        assert!(RefreshStore::open(&root, &selected)
            .unwrap()
            .read()
            .unwrap()
            .is_none());
        drop(inner);
        drop(reopened);
        let path = root.canonicalize().unwrap();
        assert!(path.starts_with(std::env::temp_dir().canonicalize().unwrap()));
        assert!(path
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("ventard-online-session-fixture-"));
        std::fs::remove_dir_all(path).unwrap();
    }
}
