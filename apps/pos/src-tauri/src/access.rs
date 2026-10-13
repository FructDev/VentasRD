//! DEBUG staging access on definitive pages. No commercial activation until
//! consistent snapshot/recovery/fiscal are ready. Credentials never leave Rust.
pub mod backup;
mod printers;
pub mod sales;
use crate::platform::keys::windows::WindowsKeyStore;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use reqwest::blocking::{Client, Response};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs::OpenOptions,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{State, WebviewWindow};
use ventard_core::{
    application::cash::{self, TurnResult},
    application::{
        drafts::{
            self, DraftAction, DraftLine, DraftQuote, DraftResult, DraftSave, DraftWorkspace,
        },
        errors::AppError,
    },
    domain::identity::EntityId,
    fiscal::{
        requests::{self as fiscal, AllocationRequest, FiscalView},
        reservations::NcfKind,
    },
    security::{
        access_cache::{load_grant, save_grant},
        key_provider::{create_vault_key, load_vault_key, KeyBinding},
        license_policy::{record_operational_open, OperationalLaunch},
        local_auth::{enroll_pin, unlock_pin},
        offline_grant::{GrantContext, TrustedGrantKey},
    },
    storage::{
        catalogue_preview::{self as catalogue, CatalogueContext, CataloguePreview, Manifest},
        writer::WriterActor,
    },
};
use zeroize::Zeroizing;
const HOST: &str = "https://blzzinivvzadqjbnpsre.supabase.co";
const ISSUER: &str = "http://127.0.0.1:3107/api/native/provision";
const TENANTS: [&str; 2] = [
    "96000000-0000-4000-8000-000000000001",
    "96000000-0000-4000-8000-000000000002",
];
#[derive(Serialize, Debug)]
pub struct AccessError {
    code: &'static str,
}
fn error(code: &'static str) -> AccessError {
    AccessError { code }
}
fn time() -> Result<u64, AccessError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|d| u64::try_from(d.as_millis()).ok())
        .ok_or(error("ACCESS_CLOCK_UNAVAILABLE"))
}
fn id(v: &str) -> Result<(), AccessError> {
    EntityId::parse(v)
        .map(|_| ())
        .map_err(|_| error("ACCESS_CONTEXT_INVALID"))
}
fn public_key(k: &str) -> bool {
    if k.starts_with("sb_publishable_") {
        return k.len() < 512
            && k.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    }
    k.split('.')
        .nth(1)
        .and_then(|p| URL_SAFE_NO_PAD.decode(p).ok())
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .is_some_and(|c| c["role"] == "anon" && c["ref"] == "blzzinivvzadqjbnpsre")
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Config {
    publishable_key: String,
    key_id: String,
    public_hex: String,
    issuer_url: String,
}
impl Config {
    fn validate(&self) -> Result<(), AccessError> {
        if !public_key(&self.publishable_key) || self.issuer_url != ISSUER {
            return Err(error("ACCESS_CONFIG_INVALID"));
        }
        self.trust().map(|_| ())
    }
    fn trust(&self) -> Result<Vec<TrustedGrantKey>, AccessError> {
        if self.public_hex.len() != 64
            || !self
                .public_hex
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(error("ACCESS_CONFIG_INVALID"));
        }
        let mut key = [0u8; 32];
        for (i, b) in key.iter_mut().enumerate() {
            *b = u8::from_str_radix(&self.public_hex[i * 2..i * 2 + 2], 16)
                .map_err(|_| error("ACCESS_CONFIG_INVALID"))?;
        }
        Ok(vec![
            TrustedGrantKey::new(&self.key_id, key).map_err(|_| error("ACCESS_CONFIG_INVALID"))?
        ])
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Identity {
    tenant_id: String,
    device_id: String,
    installation_id: String,
    vault_id: String,
    scope_type: String,
    branch_id: Option<String>,
}
impl Identity {
    fn validate(&self) -> Result<(), AccessError> {
        for s in [
            &self.tenant_id,
            &self.device_id,
            &self.installation_id,
            &self.vault_id,
        ] {
            id(s)?;
        }
        if !TENANTS.contains(&self.tenant_id.as_str()) {
            return Err(error("ACCESS_TENANT_DENIED"));
        }
        match (self.scope_type.as_str(), &self.branch_id) {
            ("GLOBAL", None) => Ok(()),
            ("BRANCH", Some(b)) => id(b),
            _ => Err(error("ACCESS_CONTEXT_INVALID")),
        }
    }
    fn binding(&self) -> Result<KeyBinding, AccessError> {
        self.validate()?;
        KeyBinding::new(
            EntityId::parse(&self.tenant_id).unwrap(),
            EntityId::parse(&self.vault_id).unwrap(),
            EntityId::parse(&self.installation_id).unwrap(),
            1,
        )
        .map_err(|_| error("ACCESS_CONTEXT_INVALID"))
    }
    fn context(&self, actor: &str) -> Result<GrantContext, AccessError> {
        self.validate()?;
        id(actor)?;
        Ok(GrantContext {
            tenant_id: self.tenant_id.clone(),
            actor_id: actor.into(),
            device_id: self.device_id.clone(),
            installation_id: self.installation_id.clone(),
            writer_epoch: "1".into(),
            scope_type: self.scope_type.clone(),
            branch_id: self.branch_id.clone(),
            min_grant_sequence: "1".into(),
            audience: "ventard.native.staging.v1".into(),
        })
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Selection {
    identity: Identity,
    actor_id: String,
}
impl Selection {
    fn catalogue_context(&self) -> CatalogueContext {
        CatalogueContext {
            tenant_id: self.identity.tenant_id.clone(),
            actor_id: self.actor_id.clone(),
            device_id: self.identity.device_id.clone(),
            installation_id: self.identity.installation_id.clone(),
            writer_epoch: "1".into(),
            scope_type: self.identity.scope_type.clone(),
            branch_id: self.identity.branch_id.clone(),
        }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogueDownload {
    complete: bool,
    received: usize,
    total: usize,
    view: AccessView,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CashView {
    scope: String,
    branch_id: Option<String>,
    turn: Option<TurnResult>,
    can_open: bool,
    limitation: &'static str,
    pending_opening: Option<Value>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CataloguePage {
    snapshot_id: String,
    index: usize,
    payload: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Branch {
    id: String,
    name: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tenant {
    id: String,
    name: String,
    branches: Vec<Branch>,
}
struct Session {
    actor: String,
    token: Zeroizing<String>,
    tenants: Vec<Tenant>,
    expires_at: u64,
}
struct Inner {
    config: Option<Config>,
    session: Option<Session>,
    selected: Option<Selection>,
    writer: Option<Arc<WriterActor>>,
    unlocked: bool,
}
pub struct AccessState {
    fiscal_settings_gate: Mutex<()>,
    archive_selection: Mutex<Option<AccessView>>,
    recovery: Mutex<backup::RecoveryState>,
    root: PathBuf,
    inner: Mutex<Inner>,
    launch: Arc<OperationalLaunch>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessView {
    status: &'static str,
    configured: bool,
    actor_id: Option<String>,
    tenant_id: Option<String>,
    role: Option<String>,
    pin_enrolled: bool,
    tenants: Vec<Tenant>,
    catalogue_ready: bool,
    operational_ready: bool,
}
fn read_json<T: for<'de> Deserialize<'de>>(p: &Path) -> Result<T, AccessError> {
    let meta = std::fs::symlink_metadata(p).map_err(|_| error("ACCESS_IDENTITY_UNAVAILABLE"))?;
    if !meta.is_file() || meta.len() > 8192 {
        return Err(error("ACCESS_IDENTITY_INVALID"));
    }
    serde_json::from_slice(&std::fs::read(p).map_err(|_| error("ACCESS_IDENTITY_UNAVAILABLE"))?)
        .map_err(|_| error("ACCESS_IDENTITY_INVALID"))
}
fn create_json<T: Serialize>(p: &Path, v: &T) -> Result<(), AccessError> {
    let mut f = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(p)
        .map_err(|_| error("ACCESS_IDENTITY_UNAVAILABLE"))?;
    f.write_all(&serde_json::to_vec(v).map_err(|_| error("ACCESS_IDENTITY_INVALID"))?)
        .and_then(|_| f.sync_all())
        .map_err(|_| error("ACCESS_IDENTITY_UNAVAILABLE"))
}
fn response(mut r: Response) -> Result<Value, AccessError> {
    let mut bytes = Zeroizing::new(Vec::new());
    r.by_ref()
        .take(65537)
        .read_to_end(&mut bytes)
        .map_err(|_| error("ACCESS_NETWORK_UNAVAILABLE"))?;
    if bytes.len() > 65536 {
        return Err(error("ACCESS_RESPONSE_INVALID"));
    }
    serde_json::from_slice(&bytes).map_err(|_| error("ACCESS_RESPONSE_INVALID"))
}
fn fiscal_http_error(status: u16) -> AccessError {
    error(match status {
        401 => "ACCESS_LOGIN_REQUIRED",
        403 => "FISCAL_REMOTE_DENIED",
        404 => "FISCAL_MIGRATION_REQUIRED",
        429 => "ACCESS_RATE_LIMITED",
        400 | 409 | 422 => "FISCAL_REMOTE_CONFLICT",
        _ => "FISCAL_REMOTE_UNAVAILABLE",
    })
}
fn fiscal_recover(
    r: &AllocationRequest,
    mut rpc: impl FnMut(&str, Value) -> Result<Value, AccessError>,
) -> Result<Value, AccessError> {
    let found = rpc("native_fiscal_lookup_v2", r.rpc_body())?;
    if found["status"] == "NOT_FOUND" {
        // Only an authorized, exact negative lookup may trigger sending again.
        if found != json!({"status":"NOT_FOUND","requestId":r.request_id(),"payloadHash":r.hash}) {
            return Err(error("FISCAL_EVIDENCE_INVALID"));
        }
        rpc("native_fiscal_allocate_v2", r.rpc_body())
    } else {
        Ok(found)
    }
}
impl AccessState {
    pub fn new(root: PathBuf) -> Self {
        Self {
            fiscal_settings_gate: Mutex::new(()),
            recovery: Mutex::new(backup::RecoveryState::default()),
            archive_selection: Mutex::new(None),
            root,
            inner: Mutex::new(Inner {
                config: None,
                session: None,
                selected: None,
                writer: None,
                unlocked: false,
            }),
            launch: Arc::new(OperationalLaunch::new()),
        }
    }
    fn config(&self, inner: &mut Inner) -> Result<Config, AccessError> {
        if let Some(c) = &inner.config {
            return Ok(c.clone());
        }
        std::fs::create_dir_all(&self.root).map_err(|_| error("ACCESS_STORAGE_UNAVAILABLE"))?;
        let p = self.root.join("public-staging-config.json");
        let c = if p.exists() {
            read_json::<Config>(&p)?
        } else {
            let c = Config {
                publishable_key: std::env::var("VENTARD_NATIVE_STAGING_PUBLISHABLE_KEY")
                    .map_err(|_| error("ACCESS_NOT_CONFIGURED"))?,
                key_id: std::env::var("VENTARD_NATIVE_GRANT_KEY_ID")
                    .map_err(|_| error("ACCESS_NOT_CONFIGURED"))?,
                public_hex: std::env::var("VENTARD_NATIVE_GRANT_PUBLIC_HEX")
                    .map_err(|_| error("ACCESS_NOT_CONFIGURED"))?,
                issuer_url: ISSUER.into(),
            };
            c.validate()?;
            create_json(&p, &c)?;
            c
        };
        c.validate()?;
        inner.config = Some(c.clone());
        Ok(c)
    }
    fn client() -> Result<Client, AccessError> {
        Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(15))
            .build()
            .map_err(|_| error("ACCESS_NETWORK_UNAVAILABLE"))
    }
    fn writer(&self, inner: &mut Inner, s: &Selection) -> Result<(), AccessError> {
        if inner.writer.is_some() {
            return Ok(());
        }
        let root = self.root.join(&s.identity.tenant_id);
        let keys = WindowsKeyStore::new(self.root.join("key-locks"))
            .map_err(|_| error("ACCESS_KEY_UNAVAILABLE"))?;
        let key = load_vault_key(&keys, &s.identity.binding()?)
            .map_err(|_| error("ACCESS_KEY_UNAVAILABLE"))?;
        inner.writer = Some(Arc::new(
            WriterActor::open_encrypted(root, key)
                .map_err(|_| error("ACCESS_VAULT_UNAVAILABLE"))?,
        ));
        Ok(())
    }
    fn view(&self, inner: &mut Inner) -> Result<AccessView, AccessError> {
        if let Some(view) = self.archive_view()? {
            return Ok(view);
        }
        let config = match self.config(inner) {
            Ok(c) => c,
            Err(e) if e.code == "ACCESS_NOT_CONFIGURED" => {
                return Ok(AccessView {
                    status: "NOT_CONFIGURED",
                    configured: false,
                    actor_id: None,
                    tenant_id: None,
                    role: None,
                    pin_enrolled: false,
                    tenants: vec![],
                    catalogue_ready: false,
                    operational_ready: false,
                })
            }
            Err(e) => return Err(e),
        };
        if inner.selected.is_none() && inner.session.is_none() {
            let p = self.root.join("selected.json");
            if p.exists() {
                let s: Selection = read_json(&p)?;
                s.identity.context(&s.actor_id)?;
                inner.selected = Some(s);
            }
        }
        let mut view = AccessView {
            status: if inner.session.is_some() {
                "AUTHENTICATED"
            } else {
                "LOGIN_REQUIRED"
            },
            configured: true,
            actor_id: inner.session.as_ref().map(|s| s.actor.clone()),
            tenant_id: None,
            role: None,
            pin_enrolled: false,
            tenants: inner
                .session
                .as_ref()
                .map(|s| s.tenants.clone())
                .unwrap_or_default(),
            catalogue_ready: false,
            operational_ready: false,
        };
        if let Some(selected) = inner.selected.clone() {
            self.writer(inner, &selected)?;
            let ctx = selected.identity.context(&selected.actor_id)?;
            let keys = config.trust()?;
            let actor = selected.actor_id.clone();
            let preview_context = selected.catalogue_context();
            let result=inner.writer.as_ref().unwrap().call(move|conn|{Ok((||{let grant=load_grant(conn,&keys,&ctx).map_err(|e|error(e.code()))?;let enrolled:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM local_pin_credentials_v1 WHERE tenant_id=?1 AND actor_id=?2)",(&ctx.tenant_id,&actor),|r|r.get(0)).map_err(|_|error("ACCESS_STORAGE_UNAVAILABLE"))?;let ready=catalogue::read(conn,&preview_context).map_err(|e|error(e.code()))?.is_some();Ok::<_,AccessError>((grant.payload().role.clone(),enrolled,ready))})())}).map_err(|_|error("ACCESS_STORAGE_UNAVAILABLE"))??;
            view.actor_id = Some(selected.actor_id.clone());
            view.tenant_id = Some(selected.identity.tenant_id.clone());
            view.role = Some(result.0);
            view.pin_enrolled = result.1;
            view.catalogue_ready = inner.unlocked && result.2;
            let context = selected.catalogue_context();
            view.operational_ready = inner.unlocked
                && inner
                    .writer
                    .as_ref()
                    .unwrap()
                    .call(move |c| ventard_core::application::sales_sync::operational(c, &context))
                    .map_err(|_| error("ACCESS_STORAGE_UNAVAILABLE"))?;
            view.status = if inner.unlocked {
                "PREPARATION_REQUIRED"
            } else if result.1 {
                "LOCKED"
            } else {
                "PIN_ENROLLMENT_REQUIRED"
            };
        }
        Ok(view)
    }
    fn catalogue_authorize(&self, inner: &mut Inner) -> Result<Selection, AccessError> {
        self.deny_archive()?;
        if !inner.unlocked {
            return Err(error("ACCESS_PIN_REQUIRED"));
        }
        let selected = inner
            .selected
            .clone()
            .ok_or(error("ACCESS_LOGIN_REQUIRED"))?;
        self.writer(inner, &selected)?;
        let config = self.config(inner)?;
        let trust = config.trust()?;
        let ctx = selected.identity.context(&selected.actor_id)?;
        let now = time()?;
        inner.writer.as_ref().unwrap().call(move|conn|Ok((||{
            let grant=load_grant(conn,&trust,&ctx).map_err(|e|error(e.code()))?;
            let(highwater,openings):(u64,u64)=conn.query_row("SELECT highwater_ms,openings FROM local_access_runtime_v1 WHERE tenant_id=?1 AND installation_id=?2 AND device_id=?3 AND writer_epoch=?4",(&ctx.tenant_id,&ctx.installation_id,&ctx.device_id,&ctx.writer_epoch),|r|Ok((r.get(0)?,r.get(1)?))).map_err(|_|error("ACCESS_STORAGE_UNAVAILABLE"))?;
            if !grant.evaluate(now,highwater,openings).map_err(|e|error(e.code()))?.allows("READ"){return Err(error("ACCESS_READ_DENIED"))}Ok(())
        })())).map_err(|_|error("ACCESS_STORAGE_UNAVAILABLE"))??;
        Ok(selected)
    }
    fn catalogue_rpc(
        client: &Client,
        config: &Config,
        token: &str,
        function: &str,
        body: Value,
    ) -> Result<Value, AccessError> {
        // Only native-owned fixed endpoints/arguments. No URL, SQL or RPC name from IPC.
        let r = client
            .post(format!("{HOST}/rest/v1/rpc/{function}"))
            .header("apikey", &config.publishable_key)
            .bearer_auth(token)
            .json(&body)
            .send()
            .map_err(|_| error("ACCESS_NETWORK_UNAVAILABLE"))?;
        let status = r.status().as_u16();
        if !(200..300).contains(&status) {
            return Err(error(match status {
                401 => "ACCESS_LOGIN_REQUIRED",
                403 => "CATALOGUE_REMOTE_DENIED",
                404 => "CATALOGUE_MIGRATION_REQUIRED",
                429 => "ACCESS_RATE_LIMITED",
                _ => "CATALOGUE_REMOTE_UNAVAILABLE",
            }));
        }
        let mut bytes = Vec::new();
        r.take(2_097_153)
            .read_to_end(&mut bytes)
            .map_err(|_| error("ACCESS_NETWORK_UNAVAILABLE"))?;
        if bytes.len() > 2_097_152 {
            return Err(error("ACCESS_RESPONSE_INVALID"));
        }
        serde_json::from_slice(&bytes).map_err(|_| error("ACCESS_RESPONSE_INVALID"))
    }
    fn catalogue_step(&self) -> Result<CatalogueDownload, AccessError> {
        let mut inner = self.inner.lock().map_err(|_| error("ACCESS_BUSY"))?;
        let selected = self.catalogue_authorize(&mut inner)?;
        let config = self.config(&mut inner)?;
        let session = inner
            .session
            .as_ref()
            .filter(|s| s.actor == selected.actor_id && s.expires_at > time().unwrap_or(u64::MAX))
            .ok_or(error("ACCESS_LOGIN_REQUIRED"))?;
        let token = Zeroizing::new(session.token.to_string());
        let ctx = selected.catalogue_context();
        let pending_ctx = ctx.clone();
        let now = time()?;
        let writer = inner.writer.as_ref().unwrap();
        let m = writer
            .call(move |conn| Ok(catalogue::pending(conn, &pending_ctx, now)))
            .map_err(|_| error("ACCESS_STORAGE_UNAVAILABLE"))?
            .map_err(|e| error(e.code()))?;
        let client = Self::client()?;
        let m = match m {
            Some(m) => m,
            None => {
                let value = Self::catalogue_rpc(
                    &client,
                    &config,
                    &token,
                    "native_catalogue_begin_v1",
                    json!({"p_snapshot_id":EntityId::new_random().to_string(),"p_negocio_id":ctx.tenant_id,"p_installation_id":ctx.installation_id,"p_device_id":ctx.device_id,"p_writer_epoch":ctx.writer_epoch,"p_scope_kind":ctx.scope_type,"p_sucursal_id":ctx.branch_id}),
                )?;
                let manifest: Manifest =
                    serde_json::from_value(value).map_err(|_| error("ACCESS_RESPONSE_INVALID"))?;
                // The server creates this capture during the request. Reusing
                // the pre-request timestamp incorrectly makes it look future-dated.
                let received_at = time()?;
                let stored = manifest.clone();
                let stored_ctx = ctx.clone();
                writer
                    .call(move |conn| Ok(catalogue::begin(conn, &stored_ctx, &stored, received_at)))
                    .map_err(|_| error("ACCESS_STORAGE_UNAVAILABLE"))?
                    .map_err(|e| error(e.code()))?;
                manifest
            }
        };
        let c = ctx.clone();
        let sid = m.snapshot_id.clone();
        let mut missing = writer
            .call(move |conn| Ok(catalogue::missing_pages(conn, &c, &sid)))
            .map_err(|_| error("ACCESS_STORAGE_UNAVAILABLE"))?
            .map_err(|e| error(e.code()))?;
        if let Some(&index) = missing.first() {
            let response = Self::catalogue_rpc(
                &client,
                &config,
                &token,
                "native_catalogue_page_v1",
                json!({"p_snapshot_id":m.snapshot_id,"p_page_index":index}),
            )?;
            let page: CataloguePage =
                serde_json::from_value(response).map_err(|_| error("ACCESS_RESPONSE_INVALID"))?;
            if page.snapshot_id != m.snapshot_id || page.index != index {
                return Err(error("CATALOGUE_EVIDENCE_INVALID"));
            }
            let c = ctx.clone();
            let sid = m.snapshot_id.clone();
            let now = time()?;
            writer
                .call(move |conn| {
                    Ok(catalogue::stage_page(
                        conn,
                        &c,
                        &sid,
                        index,
                        &page.payload,
                        now,
                    ))
                })
                .map_err(|_| error("ACCESS_STORAGE_UNAVAILABLE"))?
                .map_err(|e| error(e.code()))?;
            missing.remove(0);
        }
        let complete = missing.is_empty();
        if complete {
            let c = ctx;
            let sid = m.snapshot_id.clone();
            writer
                .call(move |conn| Ok(catalogue::activate(conn, &c, &sid)))
                .map_err(|_| error("ACCESS_STORAGE_UNAVAILABLE"))?
                .map_err(|e| error(e.code()))?;
        }
        let total = m.pages.len();
        let received = total - missing.len();
        Ok(CatalogueDownload {
            complete,
            received,
            total,
            view: self.view(&mut inner)?,
        })
    }
    fn catalogue_read(&self) -> Result<Option<CataloguePreview>, AccessError> {
        let mut inner = self.inner.lock().map_err(|_| error("ACCESS_BUSY"))?;
        let ctx = self.catalogue_authorize(&mut inner)?.catalogue_context();
        inner
            .writer
            .as_ref()
            .unwrap()
            .call(move |conn| Ok(catalogue::read(conn, &ctx)))
            .map_err(|_| error("ACCESS_STORAGE_UNAVAILABLE"))?
            .map_err(|e| error(e.code()))
    }
    fn draft_call<R: Send + 'static>(
        &self,
        f: impl FnOnce(&WriterActor, CatalogueContext) -> Result<R, AppError>,
    ) -> Result<R, AccessError> {
        let mut inner = self.inner.lock().map_err(|_| error("ACCESS_BUSY"))?;
        let ctx = self.catalogue_authorize(&mut inner)?.catalogue_context();
        f(inner.writer.as_ref().unwrap(), ctx).map_err(|e| error(e.code()))
    }
    fn cash_read(&self) -> Result<CashView, AccessError> {
        self.draft_call(|writer, ctx| {
            writer.call(move |conn| {
                let mut turn = cash::read_turn(conn, &ctx)?;
                let native=ventard_core::application::sales_sync::operational(conn,&ctx)?;
                let pending_opening=ventard_core::application::sales_sync::pending_shared_turn(conn,&ctx)?;
                if let Some(t)=&mut turn{let applied:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM native_sales_receipts_v1 WHERE operation_id=?1)",[&t.operation_id],|r|r.get(0))?;if applied{t.remote_status="APPLIED".into();}}
                Ok(CashView {
                    scope: ctx.scope_type,
                    branch_id: ctx.branch_id,
                    can_open: native&&turn.is_none(),
                    limitation: if native{"STAGING_NATIVE_SHARED_TURN"}else{"COMMERCIAL_BOOTSTRAP_REQUIRED"},
                    turn,
                    pending_opening,
                })
            })
        })
    }
    fn fiscal_read(&self) -> Result<FiscalView, AccessError> {
        self.draft_call(|w, ctx| w.call(move |c| fiscal::read(c, &ctx)))
    }
    fn fiscal_step(&self, kind: NcfKind) -> Result<FiscalView, AccessError> {
        let mut inner = self.inner.lock().map_err(|_| error("ACCESS_BUSY"))?;
        let selected = self.catalogue_authorize(&mut inner)?;
        let config = self.config(&mut inner)?;
        let session = inner
            .session
            .as_ref()
            .filter(|s| s.actor == selected.actor_id && s.expires_at > time().unwrap_or(u64::MAX))
            .ok_or(error("ACCESS_LOGIN_REQUIRED"))?;
        let token = Zeroizing::new(session.token.to_string());
        let grant_ctx = selected.identity.context(&selected.actor_id)?;
        let trust = config.trust()?;
        let now = time()?;
        let w = Arc::clone(inner.writer.as_ref().unwrap());
        let context = grant_ctx.clone();
        let keys = config.trust()?;
        // Persist UNKNOWN before the first POST, including on retries/restart.
        let request=w.call(move|c|Ok((||{
            let g=load_grant(c,&keys,&context).map_err(|e|error(e.code()))?;
            let (high,opens):(u64,u64)=c.query_row("SELECT highwater_ms,openings FROM local_access_runtime_v1 WHERE tenant_id=?1 AND installation_id=?2 AND device_id=?3 AND writer_epoch=?4",(&context.tenant_id,&context.installation_id,&context.device_id,&context.writer_epoch),|r|Ok((r.get(0)?,r.get(1)?))).map_err(|_|error("ACCESS_STORAGE_UNAVAILABLE"))?;
            fiscal::prepare(c,&g,now,high,opens,kind).map_err(|e|error(e.code()))
        })())).map_err(|_|error("ACCESS_STORAGE_UNAVAILABLE"))??;
        let native_context = selected.catalogue_context();
        let lookup_context = native_context.clone();
        let native = w
            .call(move |c| ventard_core::application::sales_sync::operational(c, &lookup_context))
            .map_err(|e| error(e.code()))?;
        drop(inner);
        let client = Self::client()?;
        let receipt = fiscal_recover(&request, |name, body| {
            // Internal fixed functions only: no generic URL/RPC capability in IPC.
            let name = if native && name == "native_fiscal_allocate_v2" {
                "native_sales_fiscal_allocate_v1"
            } else {
                name
            };
            let response = client
                .post(format!("{HOST}/rest/v1/rpc/{name}"))
                .header("apikey", &config.publishable_key)
                .bearer_auth(&*token)
                .json(&body)
                .send()
                .map_err(|_| error("ACCESS_NETWORK_UNAVAILABLE"))?;
            if !response.status().is_success() {
                return Err(fiscal_http_error(response.status().as_u16()));
            }
            let mut bytes = Vec::new();
            response
                .take(8193)
                .read_to_end(&mut bytes)
                .map_err(|_| error("FISCAL_REMOTE_UNAVAILABLE"))?;
            if bytes.len() > 8192 {
                return Err(error("FISCAL_EVIDENCE_INVALID"));
            }
            serde_json::from_slice(&bytes).map_err(|_| error("FISCAL_EVIDENCE_INVALID"))
        })?;
        let current = self.inner.lock().map_err(|_| error("ACCESS_BUSY"))?;
        if !current.unlocked
            || current
                .selected
                .as_ref()
                .is_none_or(|s| s.catalogue_context() != native_context)
            || current
                .writer
                .as_ref()
                .is_none_or(|writer| !Arc::ptr_eq(writer, &w))
        {
            return Err(error("ACCESS_CONTEXT_CHANGED"));
        }
        let now = time()?;
        let ctx = selected.catalogue_context();
        w.call(move|c|Ok((||{
            let g=load_grant(c,&trust,&grant_ctx).map_err(|e|error(e.code()))?;
            let (high,opens):(u64,u64)=c.query_row("SELECT highwater_ms,openings FROM local_access_runtime_v1 WHERE tenant_id=?1 AND installation_id=?2 AND device_id=?3 AND writer_epoch=?4",(&ctx.tenant_id,&ctx.installation_id,&ctx.device_id,&ctx.writer_epoch),|r|Ok((r.get(0)?,r.get(1)?))).map_err(|_|error("ACCESS_STORAGE_UNAVAILABLE"))?;
            fiscal::accept(c,&g,now,high,opens,&request,&receipt).map_err(|_|error("FISCAL_EVIDENCE_INVALID"))?;
            fiscal::read(c,&ctx).map_err(|e|error(e.code()))
        })())).map_err(|_|error("ACCESS_STORAGE_UNAVAILABLE"))?
    }
    fn login(&self, email: String, password: Zeroizing<String>) -> Result<AccessView, AccessError> {
        if email.len() > 254 || !email.contains('@') || password.is_empty() || password.len() > 1024
        {
            return Err(error("ACCESS_INPUT_INVALID"));
        }
        let mut inner = self.inner.lock().map_err(|_| error("ACCESS_BUSY"))?;
        self.deny_archive()?;
        inner.session = None;
        inner.unlocked = false;
        let config = self.config(&mut inner)?;
        let client = Self::client()?;
        let r = client
            .post(format!("{HOST}/auth/v1/token?grant_type=password"))
            .header("apikey", &config.publishable_key)
            .json(&json!({"email":email.trim(),"password":&*password}))
            .send()
            .map_err(|_| error("ACCESS_NETWORK_UNAVAILABLE"))?;
        drop(password);
        let status = r.status();
        let data = response(r)?;
        if !status.is_success() {
            return Err(error(match data["code"].as_str() {
                Some("invalid_credentials") => "ACCESS_CREDENTIALS_INVALID",
                Some("email_not_confirmed") => "ACCESS_EMAIL_UNCONFIRMED",
                _ if status.as_u16() == 429 => "ACCESS_RATE_LIMITED",
                _ => "ACCESS_LOGIN_UNAVAILABLE",
            }));
        }
        let actor = data["user"]["id"]
            .as_str()
            .ok_or(error("ACCESS_RESPONSE_INVALID"))?
            .to_string();
        id(&actor)?;
        if data["user"]["is_anonymous"] == true {
            return Err(error("ACCESS_ACTOR_DENIED"));
        }
        let token = Zeroizing::new(
            data["access_token"]
                .as_str()
                .filter(|s| !s.is_empty() && s.len() <= 8192)
                .ok_or(error("ACCESS_RESPONSE_INVALID"))?
                .to_string(),
        );
        let expires_at = data["expires_at"]
            .as_u64()
            .and_then(|s| s.checked_mul(1000))
            .ok_or(error("ACCESS_RESPONSE_INVALID"))?;
        if expires_at <= time()? {
            return Err(error("ACCESS_LOGIN_REQUIRED"));
        }
        let r = client
            .get(format!(
                "{HOST}/rest/v1/native_staging_licenses_v1?select=negocio_id&limit=3"
            ))
            .header("apikey", &config.publishable_key)
            .bearer_auth(&*token)
            .send()
            .map_err(|_| error("ACCESS_NETWORK_UNAVAILABLE"))?;
        if !r.status().is_success() {
            return Err(error("ACCESS_REGISTRY_UNAVAILABLE"));
        }
        let data = response(r)?;
        let rows = data.as_array().ok_or(error("ACCESS_RESPONSE_INVALID"))?;
        if rows.len() > 2 {
            return Err(error("ACCESS_RESPONSE_INVALID"));
        }
        let mut tenants = Vec::new();
        for row in rows {
            let tenant = row["negocio_id"]
                .as_str()
                .ok_or(error("ACCESS_RESPONSE_INVALID"))?;
            if !TENANTS.contains(&tenant) {
                return Err(error("ACCESS_TENANT_DENIED"));
            }
            let r=client.get(format!("{HOST}/rest/v1/sucursales?select=id,nombre&negocio_id=eq.{tenant}&order=id&limit=101")).header("apikey",&config.publishable_key).bearer_auth(&*token).send().map_err(|_|error("ACCESS_NETWORK_UNAVAILABLE"))?;
            if !r.status().is_success() {
                return Err(error("ACCESS_BRANCH_UNAVAILABLE"));
            }
            let rows = response(r)?;
            let rows = rows.as_array().ok_or(error("ACCESS_RESPONSE_INVALID"))?;
            if rows.len() > 100 {
                return Err(error("ACCESS_RESPONSE_INVALID"));
            }
            let mut branches = vec![];
            for b in rows {
                let bid = b["id"].as_str().ok_or(error("ACCESS_RESPONSE_INVALID"))?;
                id(bid)?;
                let name = b["nombre"]
                    .as_str()
                    .filter(|s| s.len() <= 256)
                    .ok_or(error("ACCESS_RESPONSE_INVALID"))?;
                branches.push(Branch {
                    id: bid.into(),
                    name: name.into(),
                });
            }
            tenants.push(Tenant {
                id: tenant.into(),
                name: if tenant == TENANTS[0] {
                    "Negocio QA A"
                } else {
                    "Negocio QA B"
                }
                .into(),
                branches,
            });
        }
        if tenants.is_empty() {
            return Err(error("ACCESS_TENANT_DENIED"));
        }
        // Do not retain a previous actor/vault as the new online session context.
        inner.writer = None;
        inner.selected = None;
        inner.session = Some(Session {
            actor,
            token,
            tenants,
            expires_at,
        });
        // Return session choices without restoring the previous selected file here.
        Ok(AccessView {
            status: "AUTHENTICATED",
            configured: true,
            actor_id: inner.session.as_ref().map(|s| s.actor.clone()),
            tenant_id: None,
            role: None,
            pin_enrolled: false,
            tenants: inner.session.as_ref().unwrap().tenants.clone(),
            catalogue_ready: false,
            operational_ready: false,
        })
    }
    fn provision(&self, tenant: String, branch: Option<String>) -> Result<AccessView, AccessError> {
        let mut inner = self.inner.lock().map_err(|_| error("ACCESS_BUSY"))?;
        self.deny_archive()?;
        let config = self.config(&mut inner)?;
        let session = inner
            .session
            .as_ref()
            .ok_or(error("ACCESS_LOGIN_REQUIRED"))?;
        let allowed = session
            .tenants
            .iter()
            .find(|t| t.id == tenant)
            .ok_or(error("ACCESS_TENANT_DENIED"))?;
        if branch
            .as_ref()
            .is_some_and(|b| !allowed.branches.iter().any(|s| s.id == *b))
        {
            return Err(error("ACCESS_BRANCH_DENIED"));
        }
        if session.expires_at <= time()? {
            return Err(error("ACCESS_LOGIN_REQUIRED"));
        }
        let actor = session.actor.clone();
        let root = self.root.join(&tenant);
        std::fs::create_dir_all(&root).map_err(|_| error("ACCESS_STORAGE_UNAVAILABLE"))?;
        let ip = root.join("identity.json");
        let identity = if ip.exists() {
            let i: Identity = read_json(&ip)?;
            i.validate()?;
            if i.tenant_id != tenant || i.branch_id != branch {
                return Err(error("ACCESS_INSTALLATION_SCOPE_LOCKED"));
            }
            i
        } else {
            let i = Identity {
                tenant_id: tenant.clone(),
                device_id: EntityId::new_random().to_string(),
                installation_id: EntityId::new_random().to_string(),
                vault_id: EntityId::new_random().to_string(),
                scope_type: if branch.is_some() { "BRANCH" } else { "GLOBAL" }.into(),
                branch_id: branch,
            };
            create_json(&ip, &i)?;
            i
        };
        let rp = root.join(format!("registration-{actor}.json"));
        let mut request = ventard_core::security::registration_requests::load_or_create(&rp)
            .map_err(|_| error("ACCESS_STORAGE_UNAVAILABLE"))?;
        let client = Self::client()?;
        let mut accepted = None;
        for attempt in 0..2 {
            let r = client.post(&config.issuer_url).bearer_auth(&*session.token)
                .json(&json!({"registrationId":request,"tenantId":identity.tenant_id,"deviceId":identity.device_id,"installationId":identity.installation_id,"scopeType":identity.scope_type,"branchId":identity.branch_id}))
                .send().map_err(|_| error("ACCESS_ISSUER_UNAVAILABLE"))?;
            if r.status().is_success() {
                accepted = Some(r);
                break;
            }
            let status = r.status().as_u16();
            if status == 401 {
                return Err(error("ACCESS_LOGIN_REQUIRED"));
            }
            // Only a policy rejection from the fixed authenticated issuer renews.
            // Persist the new ID BEFORE retry; uncertainty reuses that same ID.
            if status == 409 && attempt == 0 {
                let body = response(r)?;
                if body["code"] == "NATIVE_POLICY_CHANGED" {
                    request = ventard_core::security::registration_requests::renew(&rp, &request)
                        .map_err(|_| error("ACCESS_STORAGE_UNAVAILABLE"))?;
                    continue;
                }
            } else if status == 403 {
                if let Ok(body) = response(r) {
                    if body["code"] == "NATIVE_OWNER_SETUP_REQUIRED" {
                        return Err(error("ACCESS_OWNER_SETUP_REQUIRED"));
                    }
                }
            }
            return Err(error("ACCESS_PROVISION_UNAVAILABLE"));
        }
        let r = accepted.ok_or(error("ACCESS_PROVISION_UNAVAILABLE"))?;
        let wire =
            serde_json::to_vec(&response(r)?).map_err(|_| error("ACCESS_RESPONSE_INVALID"))?;
        let ctx = identity.context(&actor)?;
        let trusted = config.trust()?;
        let verified = ventard_core::security::offline_grant::verify_grant(&wire, &trusted, &ctx)
            .map_err(|_| error("ACCESS_GRANT_UNVERIFIABLE"))?;
        if verified.payload().grant_id != request {
            return Err(error("ACCESS_GRANT_UNVERIFIABLE"));
        }
        if inner
            .selected
            .as_ref()
            .is_some_and(|s| s.identity.tenant_id != tenant)
        {
            inner.writer = None;
            inner.selected = None;
            inner.unlocked = false;
        }
        if inner.writer.is_none() {
            let store = WindowsKeyStore::new(self.root.join("key-locks"))
                .map_err(|_| error("ACCESS_KEY_UNAVAILABLE"))?;
            let binding = identity.binding()?;
            inner.writer = Some(Arc::new(
                if root.join("pos_core.db").exists() {
                    let key = load_vault_key(&store, &binding)
                        .map_err(|_| error("ACCESS_KEY_UNAVAILABLE"))?;
                    WriterActor::open_encrypted(&root, key)
                } else {
                    let key = create_vault_key(&store, &binding)
                        .map_err(|_| error("ACCESS_KEY_UNAVAILABLE"))?;
                    WriterActor::create_encrypted(&root, key)
                }
                .map_err(|_| error("ACCESS_VAULT_UNAVAILABLE"))?,
            ));
        }
        inner
            .writer
            .as_ref()
            .unwrap()
            .call(move |conn| {
                Ok(save_grant(conn, &wire, &trusted, &ctx)
                    .map(|_| ())
                    .map_err(|e| error(e.code())))
            })
            .map_err(|_| error("ACCESS_STORAGE_UNAVAILABLE"))??;
        let selection = Selection {
            identity,
            actor_id: actor,
        };
        let p = self.root.join("selected.json");
        // Selection is a non-authoritative pointer: grant/PIN revalidated in vault.
        let pending = self
            .root
            .join(format!("selected-{}.pending", EntityId::new_random()));
        create_json(&pending, &selection)?;
        // Keep previous pointer intact until the new one is completely written.
        std::fs::rename(&pending, &p).map_err(|_| error("ACCESS_IDENTITY_UNAVAILABLE"))?;
        inner.selected = Some(selection);
        inner.unlocked = false;
        self.view(&mut inner)
    }
    fn pin(&self, pin: Zeroizing<String>, enroll: bool) -> Result<AccessView, AccessError> {
        let mut inner = self.inner.lock().map_err(|_| error("ACCESS_BUSY"))?;
        self.deny_archive()?;
        let config = self.config(&mut inner)?;
        if inner.selected.is_none() {
            self.view(&mut inner)?;
        }
        let selected = inner
            .selected
            .clone()
            .ok_or(error("ACCESS_LOGIN_REQUIRED"))?;
        if enroll
            && inner.session.as_ref().is_none_or(|s| {
                s.actor != selected.actor_id || s.expires_at <= time().unwrap_or(u64::MAX)
            })
        {
            return Err(error("ACCESS_LOGIN_REQUIRED"));
        }
        self.writer(&mut inner, &selected)?;
        let trusted = config.trust()?;
        let ctx = selected.identity.context(&selected.actor_id)?;
        let now = time()?;
        let launch = Arc::clone(&self.launch);
        // Counter launch callback and auth each run on the writer, never renderer.
        inner
            .writer
            .as_ref()
            .unwrap()
            .call(move |conn| {
                Ok((|| {
                    let g = load_grant(conn, &trusted, &ctx).map_err(|e| error(e.code()))?;
                    if enroll {
                        enroll_pin(conn, &g, &pin, now).map_err(|e| error(e.code()))?;
                    }
                    unlock_pin(conn, &g, &pin, now).map_err(|e| error(e.code()))?;
                    record_operational_open(conn, &g, &launch, now).map_err(|e| error(e.code()))?;
                    Ok::<_, AccessError>(())
                })())
            })
            .map_err(|_| error("ACCESS_STORAGE_UNAVAILABLE"))??;
        inner.unlocked = true;
        self.view(&mut inner)
    }
}
fn admission(window: &WebviewWindow, version: &str, request: &str) -> Result<(), AccessError> {
    if !cfg!(debug_assertions)
        || window.label() != "main"
        || version != "ventard.native.access.1"
        || !crate::allowed_navigation(
            &window.url().map_err(|_| error("ACCESS_DENIED"))?,
            !cfg!(feature = "custom-protocol"),
        )
    {
        return Err(error("ACCESS_DENIED"));
    }
    id(request)
}
#[tauri::command]
pub async fn native_access_status(
    window: WebviewWindow,
    state: State<'_, Arc<AccessState>>,
    ipc_version: String,
    request_id: String,
) -> Result<AccessView, AccessError> {
    admission(&window, &ipc_version, &request_id)?;
    let s = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let mut i = s.inner.lock().map_err(|_| error("ACCESS_BUSY"))?;
        s.view(&mut i)
    })
    .await
    .map_err(|_| error("ACCESS_UNAVAILABLE"))?
}
#[tauri::command]
pub async fn native_access_login(
    window: WebviewWindow,
    state: State<'_, Arc<AccessState>>,
    ipc_version: String,
    request_id: String,
    email: String,
    password: String,
) -> Result<AccessView, AccessError> {
    let password = Zeroizing::new(password);
    admission(&window, &ipc_version, &request_id)?;
    let s = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || s.login(email, password))
        .await
        .map_err(|_| error("ACCESS_UNAVAILABLE"))?
}
#[tauri::command]
pub async fn native_access_provision(
    window: WebviewWindow,
    state: State<'_, Arc<AccessState>>,
    ipc_version: String,
    request_id: String,
    tenant_id: String,
    branch_id: Option<String>,
) -> Result<AccessView, AccessError> {
    admission(&window, &ipc_version, &request_id)?;
    let s = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || s.provision(tenant_id, branch_id))
        .await
        .map_err(|_| error("ACCESS_UNAVAILABLE"))?
}
#[tauri::command]
pub async fn native_access_pin(
    window: WebviewWindow,
    state: State<'_, Arc<AccessState>>,
    ipc_version: String,
    request_id: String,
    pin: String,
    enroll: bool,
) -> Result<AccessView, AccessError> {
    let pin = Zeroizing::new(pin);
    admission(&window, &ipc_version, &request_id)?;
    let s = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || s.pin(pin, enroll))
        .await
        .map_err(|_| error("ACCESS_UNAVAILABLE"))?
}
#[tauri::command]
pub async fn native_access_lock(
    window: WebviewWindow,
    state: State<'_, Arc<AccessState>>,
    ipc_version: String,
    request_id: String,
) -> Result<AccessView, AccessError> {
    admission(&window, &ipc_version, &request_id)?;
    let s = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        s.clear_archive()?;
        let mut i = s.inner.lock().map_err(|_| error("ACCESS_BUSY"))?;
        i.session = None;
        i.unlocked = false;
        s.view(&mut i)
    })
    .await
    .map_err(|_| error("ACCESS_UNAVAILABLE"))?
}

#[tauri::command]
pub async fn native_catalogue_download(
    window: WebviewWindow,
    state: State<'_, Arc<AccessState>>,
    ipc_version: String,
    request_id: String,
) -> Result<CatalogueDownload, AccessError> {
    admission(&window, &ipc_version, &request_id)?;
    let s = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || s.catalogue_step())
        .await
        .map_err(|_| error("ACCESS_UNAVAILABLE"))?
}
#[tauri::command]
pub async fn native_catalogue_read(
    window: WebviewWindow,
    state: State<'_, Arc<AccessState>>,
    ipc_version: String,
    request_id: String,
) -> Result<Option<CataloguePreview>, AccessError> {
    admission(&window, &ipc_version, &request_id)?;
    let s = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || s.catalogue_read())
        .await
        .map_err(|_| error("ACCESS_UNAVAILABLE"))?
}

#[tauri::command]
pub async fn native_cart_read(
    window: WebviewWindow,
    state: State<'_, Arc<AccessState>>,
    ipc_version: String,
    request_id: String,
) -> Result<DraftWorkspace, AccessError> {
    admission(&window, &ipc_version, &request_id)?;
    let s = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        s.draft_call(|w, ctx| w.call(move |c| drafts::read(c, &ctx)))
    })
    .await
    .map_err(|_| error("ACCESS_UNAVAILABLE"))?
}
#[tauri::command]
pub async fn native_cart_save(
    window: WebviewWindow,
    state: State<'_, Arc<AccessState>>,
    ipc_version: String,
    request_id: String,
    cart: DraftSave,
) -> Result<DraftResult, AccessError> {
    admission(&window, &ipc_version, &request_id)?;
    let s = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        s.draft_call(move |w, ctx| w.call(move |c| drafts::save(c, &ctx, cart)))
    })
    .await
    .map_err(|_| error("ACCESS_UNAVAILABLE"))?
}
#[tauri::command]
pub async fn native_cart_action(
    window: WebviewWindow,
    state: State<'_, Arc<AccessState>>,
    ipc_version: String,
    request_id: String,
    cart: DraftAction,
) -> Result<DraftResult, AccessError> {
    admission(&window, &ipc_version, &request_id)?;
    let s = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        s.draft_call(move |w, ctx| w.call(move |c| drafts::action(c, &ctx, cart)))
    })
    .await
    .map_err(|_| error("ACCESS_UNAVAILABLE"))?
}
#[tauri::command]
pub async fn native_catalogue_quote(
    window: WebviewWindow,
    state: State<'_, Arc<AccessState>>,
    ipc_version: String,
    request_id: String,
    lines: Vec<DraftLine>,
) -> Result<DraftQuote, AccessError> {
    admission(&window, &ipc_version, &request_id)?;
    let s = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        s.draft_call(move |w, ctx| w.call(move |c| drafts::quote(c, &ctx, &lines)))
    })
    .await
    .map_err(|_| error("ACCESS_UNAVAILABLE"))?
}

#[tauri::command]
pub async fn native_cash_read(
    window: WebviewWindow,
    state: State<'_, Arc<AccessState>>,
    ipc_version: String,
    request_id: String,
) -> Result<CashView, AccessError> {
    admission(&window, &ipc_version, &request_id)?;
    let s = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || s.cash_read())
        .await
        .map_err(|_| error("ACCESS_UNAVAILABLE"))?
}
#[tauri::command]
pub async fn native_history_read(
    window: WebviewWindow,
    state: State<'_, Arc<AccessState>>,
    ipc_version: String,
    request_id: String,
    filter: ventard_core::application::history::HistoryFilter,
) -> Result<ventard_core::application::history::HistoryPage, AccessError> {
    admission(&window, &ipc_version, &request_id)?;
    let s = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        s.draft_call(move |w, ctx| {
            w.call(move |c| ventard_core::application::history::read(c, &ctx, filter))
        })
    })
    .await
    .map_err(|_| error("ACCESS_UNAVAILABLE"))?
}
#[tauri::command]
pub async fn native_history_ticket(
    window: WebviewWindow,
    state: State<'_, Arc<AccessState>>,
    ipc_version: String,
    request_id: String,
    operation_id: String,
) -> Result<Value, AccessError> {
    admission(&window, &ipc_version, &request_id)?;
    let s = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        s.draft_call(move |w, ctx| {
            w.call(move |c| ventard_core::application::printing::ticket(c, &ctx, &operation_id))
        })
    })
    .await
    .map_err(|_| error("ACCESS_UNAVAILABLE"))?
}
#[tauri::command]
pub async fn native_fiscal_read(
    window: WebviewWindow,
    state: State<'_, Arc<AccessState>>,
    ipc_version: String,
    request_id: String,
) -> Result<FiscalView, AccessError> {
    admission(&window, &ipc_version, &request_id)?;
    let s = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || s.fiscal_read())
        .await
        .map_err(|_| error("ACCESS_UNAVAILABLE"))?
}
#[tauri::command]
pub async fn native_fiscal_prepare(
    window: WebviewWindow,
    state: State<'_, Arc<AccessState>>,
    ipc_version: String,
    request_id: String,
    kind: String,
) -> Result<FiscalView, AccessError> {
    admission(&window, &ipc_version, &request_id)?;
    let kind = match kind.as_str() {
        "B01" => NcfKind::B01,
        "B02" => NcfKind::B02,
        _ => return Err(error("FISCAL_EVIDENCE_INVALID")),
    };
    let s = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || s.fiscal_step(kind))
        .await
        .map_err(|_| error("ACCESS_UNAVAILABLE"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fiscal_recovery_does_not_allocate_on_uncertain_or_denied_lookup() {
        let r = AllocationRequest {
            payload: json!({"requestId":"synthetic"}),
            hash: "a".repeat(64),
        };
        for code in [
            "ACCESS_NETWORK_UNAVAILABLE",
            "ACCESS_LOGIN_REQUIRED",
            "FISCAL_REMOTE_DENIED",
            "ACCESS_RATE_LIMITED",
            "FISCAL_REMOTE_UNAVAILABLE",
        ] {
            let mut calls = 0;
            assert_eq!(
                fiscal_recover(&r, |name, _| {
                    calls += 1;
                    assert_eq!(name, "native_fiscal_lookup_v2");
                    Err(error(code))
                })
                .unwrap_err()
                .code,
                code
            );
            assert_eq!(calls, 1);
        }
        assert!(fiscal_recover(&r, |_, _| Ok(json!({"status":"NOT_FOUND"}))).is_err());
    }
    #[test]
    fn fiscal_recovery_sends_exact_same_payload_only_after_exact_negative_lookup() {
        let r = AllocationRequest {
            payload: json!({"requestId":"synthetic"}),
            hash: "a".repeat(64),
        };
        let mut names = vec![];
        let receipt = json!({"status":"ALLOCATED","first":"1"});
        assert_eq!(
            fiscal_recover(&r, |name, body| {
                assert_eq!(body, r.rpc_body());
                names.push(name.to_owned());
                Ok(if names.len() == 1 {
                    json!({"status":"NOT_FOUND","requestId":"synthetic","payloadHash":r.hash})
                } else {
                    receipt.clone()
                })
            })
            .unwrap(),
            receipt
        );
        assert_eq!(
            names,
            ["native_fiscal_lookup_v2", "native_fiscal_allocate_v2"]
        );
        names.clear();
        assert_eq!(
            fiscal_recover(&r, |name, _| {
                names.push(name.to_owned());
                Ok(receipt.clone())
            })
            .unwrap(),
            receipt
        );
        assert_eq!(names, ["native_fiscal_lookup_v2"]);
    }
    #[test]
    fn fiscal_transport_statuses_are_safe_and_commands_require_pin() {
        for (status, code) in [
            (401, "ACCESS_LOGIN_REQUIRED"),
            (403, "FISCAL_REMOTE_DENIED"),
            (429, "ACCESS_RATE_LIMITED"),
            (503, "FISCAL_REMOTE_UNAVAILABLE"),
        ] {
            assert_eq!(fiscal_http_error(status).code, code)
        }
        let state = AccessState::new(PathBuf::from("unused-fixture-path"));
        assert_eq!(
            state.fiscal_step(NcfKind::B02).unwrap_err().code,
            "ACCESS_PIN_REQUIRED"
        );
        assert_eq!(state.fiscal_read().unwrap_err().code, "ACCESS_PIN_REQUIRED");
    }
    #[test]
    fn catalogue_commands_require_unlocked_actor_before_any_network_or_storage() {
        let state = AccessState::new(PathBuf::from("unused-fixture-path"));
        assert_eq!(state.cash_read().err().unwrap().code, "ACCESS_PIN_REQUIRED");
        assert_eq!(
            state.catalogue_read().err().unwrap().code,
            "ACCESS_PIN_REQUIRED"
        );
        assert_eq!(
            state.catalogue_step().err().unwrap().code,
            "ACCESS_PIN_REQUIRED"
        );
        assert_eq!(
            state
                .draft_call(|w, ctx| w.call(move |c| drafts::read(c, &ctx)))
                .unwrap_err()
                .code,
            "ACCESS_PIN_REQUIRED"
        );
        assert_eq!(
            state
                .draft_call(|w, ctx| w.call(move |c| drafts::quote(c, &ctx, &[])))
                .unwrap_err()
                .code,
            "ACCESS_PIN_REQUIRED"
        );
    }
    fn config() -> Config {
        Config {
            publishable_key: "sb_publishable_fixture".into(),
            key_id: "fixture-only".into(),
            public_hex: "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a".into(),
            issuer_url: ISSUER.into(),
        }
    }
    #[test]
    fn config_rejects_foreign_targets_privileged_keys_and_non_ascii_public_hex() {
        assert!(config().validate().is_ok());
        let mut c = config();
        c.issuer_url = "https://another-host.test/api/native/provision".into();
        assert!(c.validate().is_err());
        let mut c = config();
        c.publishable_key = "not-a-public-key".into();
        assert!(c.validate().is_err());
        let mut c = config();
        c.public_hex = "é".repeat(32);
        assert!(c.validate().is_err());
        let mut c = config();
        c.public_hex = "00".repeat(32);
        assert!(c.validate().is_err());
        let claims = URL_SAFE_NO_PAD.encode(br#"{"role":"owner","ref":"blzzinivvzadqjbnpsre"}"#);
        assert!(!public_key(&format!("x.{claims}.x")));
    }
    #[test]
    fn identity_scope_and_tenant_are_not_inferred_from_missing_fields() {
        let mut i = Identity {
            tenant_id: TENANTS[0].into(),
            device_id: "96000000-0000-4000-8000-000000000011".into(),
            installation_id: "96000000-0000-4000-8000-000000000012".into(),
            vault_id: "96000000-0000-4000-8000-000000000013".into(),
            scope_type: "GLOBAL".into(),
            branch_id: None,
        };
        assert!(i.validate().is_ok());
        i.scope_type = "BRANCH".into();
        assert!(i.validate().is_err());
        i.branch_id = Some("96000000-0000-4000-8000-000000000014".into());
        assert!(i.validate().is_ok());
        i.tenant_id = "96000000-0000-4000-8000-000000000099".into();
        assert!(i.validate().is_err());
    }
    #[test]
    fn new_session_does_not_restore_previous_actor_and_transport_token_is_not_serialized() {
        let root = std::env::temp_dir().join(format!(
            "ventard-access-broker-fixture-{}",
            EntityId::new_random()
        ));
        std::fs::create_dir(&root).unwrap();
        std::fs::write(
            root.join("selected.json"),
            b"corrupt-previous-selection-fixture",
        )
        .unwrap();
        let state = AccessState::new(root.clone());
        let mut inner = state.inner.lock().unwrap();
        inner.config = Some(config());
        inner.session = Some(Session {
            actor: "96000000-0000-4000-8000-000000000051".into(),
            token: Zeroizing::new("never-render-this-fixture-token".into()),
            tenants: vec![],
            expires_at: u64::MAX,
        });
        let view = state.view(&mut inner).unwrap();
        assert_eq!(view.status, "AUTHENTICATED");
        assert!(view.tenant_id.is_none());
        assert!(!serde_json::to_string(&view)
            .unwrap()
            .contains("never-render"));
        drop(inner);
        drop(state);
        let p = root.canonicalize().unwrap();
        assert!(
            p.starts_with(std::env::temp_dir().canonicalize().unwrap())
                && p.file_name()
                    .unwrap()
                    .to_str()
                    .unwrap()
                    .starts_with("ventard-access-broker-fixture-")
        );
        std::fs::remove_dir_all(p).unwrap();
    }
}
