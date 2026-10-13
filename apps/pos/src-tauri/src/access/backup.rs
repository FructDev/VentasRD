//! Native chooser + encrypted backup broker. No paths or keys from the renderer.
use super::*;
use std::collections::BTreeMap;
use ventard_core::{
    security::{key_provider::KeyError, recovery_enrollment::RecoverySecret},
    storage::backup as core,
};
#[derive(Default)]
pub(super) struct RecoveryState {
    candidates: BTreeMap<String, core::Archive>,
    active: Option<String>,
}
#[derive(Deserialize)]
#[serde(
    tag = "action",
    rename_all = "SCREAMING_SNAKE_CASE",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Action {
    Status {},
    WebStatus {},
    WebImport {},
    WebRows {
        export_id: String,
        table: String,
        page: u32,
    },
    Create {
        operation_id: String,
    },
    Abandon {
        operation_id: String,
    },
    Inspect {},
    Open {
        handle: String,
    },
    Close {},
    RecoverKey {
        handle: String,
        pin: String,
    },
    Read {},
    HistoryRead {
        filter: ventard_core::application::history::HistoryFilter,
    },
    Ticket {
        operation_id: String,
    },
    ManagementRead {},
    SettingsRead {},
    PrintLayoutRead {},
    RepairsRead {},
    LayawaysRead {},
    WarrantiesRead {},
    InventoryHistory {
        product_id: String,
        page: u32,
    },
    Report {
        from_ms: String,
        to_ms: String,
    },
    Document {
        family: String,
        operation_id: String,
    },
    ReportExport {
        kind: ventard_core::application::report_exports::Kind,
        from_ms: String,
        to_ms: String,
    },
}
fn map(e: core::BackupError) -> AccessError {
    error(e.code())
}
fn source(s: &Selection) -> Result<core::Source, AccessError> {
    Ok(core::Source {
        local_anchor_hash: None,
        tenant_id: s.identity.tenant_id.clone(),
        vault_id: s.identity.vault_id.clone(),
        installation_id: s.identity.installation_id.clone(),
        device_id: s.identity.device_id.clone(),
        actor_id: s.actor_id.clone(),
        writer_epoch: "1".into(),
        scope_type: s.identity.scope_type.clone(),
        branch_id: s.identity.branch_id.clone(),
        key_version: 1,
        captured_at_ms: time()?.to_string(),
    })
}
fn context(s: &core::Source) -> CatalogueContext {
    CatalogueContext {
        tenant_id: s.tenant_id.clone(),
        installation_id: s.installation_id.clone(),
        device_id: s.device_id.clone(),
        actor_id: s.actor_id.clone(),
        writer_epoch: s.writer_epoch.clone(),
        scope_type: s.scope_type.clone(),
        branch_id: s.branch_id.clone(),
    }
}
impl AccessState {
    fn anchored_source(&self, s: &Selection, enroll: bool) -> Result<core::Source, AccessError> {
        let mut x = source(s)?;
        let store = WindowsKeyStore::new(self.root.join("key-locks"))
            .map_err(|_| error("BACKUP_KEY_STORE_FAILED"))?;
        let anchor = s.identity.binding()?;
        if enroll {
            load_vault_key(&store, &s.identity.binding()?)
                .map_err(|_| error("ACCESS_KEY_UNAVAILABLE"))?;
        }
        x.local_anchor_hash = Some(
            ventard_core::security::key_provider::installation_anchor(&store, &anchor, enroll)
                .map_err(|_| error("BACKUP_ORIGINAL_DEVICE_REQUIRED"))?,
        );
        Ok(x)
    }
    pub(super) fn deny_archive(&self) -> Result<(), AccessError> {
        if self.archive_view()?.is_some() {
            return Err(error("BACKUP_ARCHIVE_READ_ONLY"));
        }
        Ok(())
    }
    pub(super) fn clear_archive(&self) -> Result<(), AccessError> {
        let mut r = self.recovery.lock().map_err(|_| error("ACCESS_BUSY"))?;
        r.active = None;
        r.candidates.clear();
        *self
            .archive_selection
            .lock()
            .map_err(|_| error("ACCESS_BUSY"))? = None;
        Ok(())
    }
    pub(super) fn archive_view(&self) -> Result<Option<AccessView>, AccessError> {
        Ok(self
            .archive_selection
            .lock()
            .map_err(|_| error("ACCESS_BUSY"))?
            .clone())
    }
    fn backup_owner(&self) -> Result<(Selection, Arc<WriterActor>), AccessError> {
        let mut i = self.inner.lock().map_err(|_| error("ACCESS_BUSY"))?;
        if !i.unlocked {
            return Err(error("ACCESS_PIN_REQUIRED"));
        }
        let s = i.selected.clone().ok_or(error("ACCESS_LOGIN_REQUIRED"))?;
        self.writer(&mut i, &s)?;
        let trust = self.config(&mut i)?.trust()?;
        let ctx = s.identity.context(&s.actor_id)?;
        let w = Arc::clone(i.writer.as_ref().unwrap());
        w.call(move |c| {
            let g = load_grant(c, &trust, &ctx).map_err(|_| {
                AppError::Auth(ventard_core::application::errors::AuthError::InvalidSignature)
            })?;
            if !g.payload().capabilities.iter().any(|v| v == "MANAGE") {
                return Err(AppError::Auth(
                    ventard_core::application::errors::AuthError::PermissionDenied {
                        required: "MANAGE".into(),
                    },
                ));
            }
            Ok(())
        })
        .map_err(|e| error(e.code()))?;
        Ok((s, w))
    }
    fn backup_private(&self) -> Result<PathBuf, AccessError> {
        let root = self.root.canonicalize().map_err(|_| error("BACKUP_IO"))?;
        let dir = root.join("recovery-candidates");
        std::fs::create_dir_all(&dir).map_err(|_| error("BACKUP_IO"))?;
        let dir = dir.canonicalize().map_err(|_| error("BACKUP_IO"))?;
        if !dir.starts_with(root) {
            return Err(error("BACKUP_IO"));
        }
        Ok(dir)
    }
    fn archive_read(&self, action: Action) -> Result<Value, AccessError> {
        let state = self.recovery.lock().map_err(|_| error("ACCESS_BUSY"))?;
        let a = state
            .active
            .as_ref()
            .and_then(|h| state.candidates.get(h))
            .ok_or(error("BACKUP_NOT_OPEN"))?;
        a.read(|c, source| {
            let ctx = context(source);
            let result = (|| -> Result<Value, AppError> {
                match action {
                    Action::Read {} => {
                        let mut v=ventard_core::application::sales_sync::read(c,&ctx)?;
if v.is_null(){
 let preview=catalogue::read(c,&ctx).map_err(|_|AppError::Storage("LOCAL_STORAGE_IO".into()))?;
 let products=preview.map(|p|p.products.into_iter().map(|p|json!({"id":p.id,"name":p.name,"code":p.code.unwrap_or_default(),"priceCents":p.price_cents.clone().unwrap_or("0".into()),"stock":p.stock.unwrap_or_default(),"revision":"ARCHIVE_PREVIEW","preview":{"priceVerifiable":p.price_cents.is_some(),"stockVerifiable":false,"stockEvidence":p.stock_evidence}})).collect::<Vec<_>>()).unwrap_or_default();
 let scope=ventard_core::application::sales::scope_key(&ctx)?;
 let sales:i64=c.query_row("SELECT count(*) FROM sales WHERE tenant_id=?1 AND scope_key=?2",(&ctx.tenant_id,&scope),|r|r.get(0))?;
 let pending:i64=c.query_row("SELECT count(*) FROM outbox WHERE state<>'APPLIED'",[],|r|r.get(0))?;
 let cash:i64=c.query_row("SELECT coalesce(sum(amount_cents),0) FROM sale_cash_entries_v1 WHERE tenant_id=?1 AND scope_key=?2",(&ctx.tenant_id,&scope),|r|r.get(0))?;
 v=json!({"status":"ready","products":products,"customers":[],"confirmedSales":sales.to_string(),"cashCents":cash.to_string(),"pendingOperations":pending.to_string(),"carts":{"active":null,"paused":[]},"lastResult":null,"pendingAttempt":null,"scopeRevision":"archive-catalogue-only","coverage":"CATALOGUE_PREVIEW_ONLY"});
}
v["mode"] = json!("recovery-readonly");
                        v["inventoryReadOnly"] = json!(true);
                        v["supportsDrafts"] = json!(false);
                        v["carts"] = json!({"active":null,"paused":[]});
                        v["lastResult"] = Value::Null;
                        v["pendingAttempt"] = Value::Null;
                        v["backupCapturedAtMs"] = json!(source.captured_at_ms);
                        Ok(v)
                    }
                    Action::HistoryRead { filter } => serde_json::to_value(
                        ventard_core::application::history::read(c, &ctx, filter)?,
                    )
                    .map_err(|_| AppError::Storage("LOCAL_STORAGE_IO".into())),
                    Action::Ticket { operation_id } => {
                        let mut v =
                            ventard_core::application::printing::ticket(c, &ctx, &operation_id)?;
                        v["autoPrintJob"] = Value::Null;
                        v["printAttempt"] = Value::Null;
                        Ok(v)
                    }
                    Action::ManagementRead {} => {
                        let mut v = ventard_core::application::management::read(c, &ctx)?;
                        v["canManage"] = json!(false);
                        v["coverage"] = json!("RECOVERED_ARCHIVE");
                        v["pending"] = json!([]);
                        Ok(v)
                    }
                    Action::SettingsRead {}=>{let mut v=ventard_core::application::settings::read(c,&ctx)?;v["canWrite"]=json!(false);v["canLoadRemote"]=json!(false);Ok(v)},
                    Action::PrintLayoutRead {}=>Ok(json!({"layout":ventard_core::application::printing::layout(c,&ctx)?,"canWrite":false,"coverage":"RECOVERED_ARCHIVE"})),
                    Action::RepairsRead {}=>{let mut v=ventard_core::application::repairs::read(c,&ctx)?;v["canWrite"]=json!(false);v["coverage"]=json!("RECOVERED_ARCHIVE");Ok(v)},
                    Action::LayawaysRead {}=>{let mut v=ventard_core::application::layaways::read(c,&ctx)?;v["canWrite"]=json!(false);v["coverage"]=json!("RECOVERED_ARCHIVE");Ok(v)},
                    Action::WarrantiesRead {}=>{let mut v=ventard_core::application::warranties::read(c,&ctx)?;v["canWrite"]=json!(false);v["effectiveTimeMs"]=json!(source.captured_at_ms);v["coverage"]=json!("RECOVERED_ARCHIVE");Ok(v)},
                    Action::InventoryHistory{product_id,page}=>ventard_core::application::inventory::history(c,&ctx,&product_id,page),
                    Action::Report{from_ms,to_ms}=>ventard_core::application::management::report(c,&ctx,&from_ms,&to_ms),
                    Action::Document{family,operation_id}=>match family.as_str(){"REPAIR"=>ventard_core::application::printing::repair_ticket(c,&ctx,&operation_id),"LAYAWAY"=>ventard_core::application::printing::layaway_ticket(c,&ctx,&operation_id),"WARRANTY"=>ventard_core::application::printing::warranty_ticket(c,&ctx,&operation_id),"CUT"=>ventard_core::application::printing::cut_ticket(c,&ctx,&operation_id),_=>Err(AppError::Protocol(ventard_core::application::errors::ProtocolError::MalformedPayload))},
                    Action::ReportExport {
                        kind,
                        from_ms,
                        to_ms,
                    } => ventard_core::application::report_exports::read(
                        c, &ctx, kind, &from_ms, &to_ms,
                    ),
                    _ => Err(AppError::Auth(
                        ventard_core::application::errors::AuthError::PermissionDenied {
                            required: "RECOVERY_READ_ONLY".into(),
                        },
                    )),
                }
            })();
            result.map_err(|e| error(e.code()))
        })
    }
    pub(super) fn backup_action(&self, action: Action) -> Result<Value, AccessError> {
        if matches!(
            &action,
            Action::Read {}
                | Action::HistoryRead { .. }
                | Action::Ticket { .. }
                | Action::ManagementRead {}
                | Action::SettingsRead {}
                | Action::PrintLayoutRead {}
                | Action::RepairsRead {}
                | Action::LayawaysRead {}
                | Action::WarrantiesRead {}
                | Action::InventoryHistory { .. }
                | Action::Report { .. }
                | Action::Document { .. }
                | Action::ReportExport { .. }
        ) {
            return self.archive_read(action);
        }
        let mut r = self.recovery.lock().map_err(|_| error("ACCESS_BUSY"))?;
        match action {
            Action::WebStatus {} | Action::WebRows { .. } | Action::WebImport {} => {
                if r.active.is_some() {
                    return Err(error("BACKUP_ARCHIVE_READ_ONLY"));
                }
                drop(r);
                let (selected, writer) = self.backup_owner()?;
                let tenant = selected.identity.tenant_id.clone();
                let convert = |e: ventard_core::storage::legacy_web::ImportError| error(e.code());
                let _read_guard = if !matches!(&action, Action::WebImport {}) {
                    let inner = self.inner.lock().map_err(|_| error("ACCESS_BUSY"))?;
                    let latest = inner
                        .selected
                        .as_ref()
                        .ok_or(error("ACCESS_LOGIN_REQUIRED"))?;
                    if !inner.unlocked || !source(latest)?.same_identity(&source(&selected)?) {
                        return Err(error("WEB_IMPORT_CONTEXT_CHANGED"));
                    }
                    self.deny_archive()?;
                    Some(inner)
                } else {
                    None
                };
                match action {
                    Action::WebStatus {} => writer
                        .call(move |c| Ok(ventard_core::storage::legacy_web::list(c, &tenant)))
                        .map_err(|_| error("WEB_IMPORT_STORAGE"))?
                        .map_err(convert),
                    Action::WebRows {
                        export_id,
                        table,
                        page,
                    } => writer
                        .call(move |c| {
                            Ok(ventard_core::storage::legacy_web::rows(
                                c, &tenant, &export_id, &table, page,
                            ))
                        })
                        .map_err(|_| error("WEB_IMPORT_STORAGE"))?
                        .map_err(convert),
                    Action::WebImport {} => {
                        let Some(file) = rfd::FileDialog::new()
                            .set_title("Elegir traslado cifrado del navegador VentaRD")
                            .add_filter("Traslado VentaRD", &["vrweb"])
                            .pick_file()
                        else {
                            return Ok(json!({"state":"CANCELLED"}));
                        };
                        let Some(key) = rfd::FileDialog::new()
                            .set_title("Elegir la llave del traslado del navegador")
                            .add_filter("Llave VentaRD", &["vrwebkey"])
                            .pick_file()
                        else {
                            return Ok(json!({"state":"CANCELLED"}));
                        };
                        let package = ventard_core::storage::legacy_web::read_files(&file, &key)
                            .map_err(convert)?;
                        // Choosers/decryption may outlive the selected account. Reauthorize
                        // and hold selection stable across the atomic isolated insert.
                        let (current, writer) = self.backup_owner()?;
                        if !source(&selected)?.same_identity(&source(&current)?) {
                            return Err(error("WEB_IMPORT_CONTEXT_CHANGED"));
                        }
                        let inner = self.inner.lock().map_err(|_| error("ACCESS_BUSY"))?;
                        let latest = inner
                            .selected
                            .as_ref()
                            .ok_or(error("ACCESS_LOGIN_REQUIRED"))?;
                        if !inner.unlocked || !source(latest)?.same_identity(&source(&current)?) {
                            return Err(error("WEB_IMPORT_CONTEXT_CHANGED"));
                        }
                        self.deny_archive()?;
                        writer
                            .call(move |c| {
                                Ok(ventard_core::storage::legacy_web::store(
                                    c, &tenant, &package,
                                ))
                            })
                            .map_err(|_| error("WEB_IMPORT_STORAGE"))?
                            .map_err(convert)
                    }
                    _ => Err(error("WEB_IMPORT_INVALID")),
                }
            }
            Action::Abandon { operation_id } => {
                if r.active.is_some() {
                    return Err(error("BACKUP_ARCHIVE_READ_ONLY"));
                }
                let (s, w) = self.backup_owner()?;
                let x = self.anchored_source(&s, false)?;
                w.call(move |c| Ok(core::abandon(c, &x, &operation_id)))
                    .map_err(|_| error("BACKUP_IO"))?
                    .map_err(map)?;
                Ok(json!({"state":"ABANDONED","filesDeleted":false}))
            }
            Action::Status {} => {
                if let Some(a) = r.active.as_ref().and_then(|h| r.candidates.get(h)) {
                    return Ok(
                        json!({"archive":core::summary(&a.manifest,"VERIFIED"),"canCreate":false,"rows":[]}),
                    );
                }
                drop(r);
                let (s, w) = self.backup_owner()?;
                let x = source(&s)?;
                let mut v = w
                    .call(move |c| Ok(core::list(c, &x)))
                    .map_err(|_| error("BACKUP_IO"))?
                    .map_err(map)?;
                v["canCreate"] = json!(true);
                Ok(v)
            }
            Action::Create { operation_id } => {
                id(&operation_id)?;
                if r.active.is_some() {
                    return Err(error("BACKUP_ARCHIVE_READ_ONLY"));
                }
                let (s, w) = self.backup_owner()?;
                let x = self.anchored_source(&s, true)?;
                let op = operation_id.clone();
                let xc = x.clone();
                let old = w
                    .call(move |c| Ok(core::job(c, &xc, &op)))
                    .map_err(|_| error("BACKUP_IO"))?
                    .map_err(map)?;
                let job = if let Some(j) = old {
                    j
                } else {
                    let Some(folder) = rfd::FileDialog::new()
                        .set_title("Guardar respaldo cifrado de VentaRD")
                        .pick_folder()
                    else {
                        return Ok(json!({"state":"CANCELLED"}));
                    };
                    let Some(keys_folder) = rfd::FileDialog::new()
                        .set_title("Guardar llave de recuperación en otra carpeta o unidad")
                        .pick_folder()
                    else {
                        return Ok(json!({"state":"CANCELLED"}));
                    };
                    let folder = folder.canonicalize().map_err(|_| error("BACKUP_IO"))?;
                    let keys_folder = keys_folder.canonicalize().map_err(|_| error("BACKUP_IO"))?;
                    let own = self.root.canonicalize().map_err(|_| error("BACKUP_IO"))?;
                    if folder.starts_with(&own) || keys_folder.starts_with(&own) {
                        return Err(error("BACKUP_DESTINATION_INVALID"));
                    }
                    let b = folder.join(format!("VentaRD-{operation_id}.vrdbackup"));
                    let k = keys_folder.join(format!("VentaRD-{operation_id}.vrdkey"));
                    let op = operation_id.clone();
                    let xc = x.clone();
                    w.call(move |c| Ok(core::prepare(c, xc, &op, &b, &k)))
                        .map_err(|_| error("BACKUP_IO"))?
                        .map_err(map)?
                };
                let store = WindowsKeyStore::new(self.root.join("key-locks"))
                    .map_err(|_| error("BACKUP_KEY_STORE_FAILED"))?;
                let key = load_vault_key(&store, &s.identity.binding()?)
                    .map_err(|_| error("ACCESS_KEY_UNAVAILABLE"))?;
                let binding = KeyBinding::new(
                    EntityId::parse(&x.tenant_id).unwrap(),
                    EntityId::parse(&operation_id).unwrap(),
                    EntityId::parse(&x.installation_id).unwrap(),
                    0xBACC0001,
                )
                .map_err(|_| error("BACKUP_INVALID"))?;
                let recovery_key = match load_vault_key(&store, &binding) {
                    Ok(k) => k,
                    Err(KeyError::Missing) if !job.has_frozen_snapshot() => {
                        create_vault_key(&store, &binding)
                            .map_err(|_| error("BACKUP_KEY_STORE_FAILED"))?
                    }
                    Err(_) => return Err(error("BACKUP_KEY_STORE_FAILED")),
                };
                let secret = RecoverySecret::from_cipher_key(&recovery_key);
                let private = self.backup_private()?;
                w.call(move |c| Ok(core::create(c, job, &key, &secret, &private)))
                    .map_err(|_| error("BACKUP_IO"))?
                    .map_err(map)
            }
            Action::Inspect {} => {
                if r.candidates.len() >= 8 {
                    return Err(error("BACKUP_TOO_MANY_CANDIDATES"));
                }
                let Some(file) = rfd::FileDialog::new()
                    .set_title("Abrir respaldo cifrado de VentaRD")
                    .add_filter("Respaldo VentaRD", &["vrdbackup"])
                    .pick_file()
                else {
                    return Ok(json!({"state":"CANCELLED"}));
                };
                let Some(card) = rfd::FileDialog::new()
                    .set_title("Elegir su llave de recuperación")
                    .add_filter("Llave VentaRD", &["vrdkey"])
                    .pick_file()
                else {
                    return Ok(json!({"state":"CANCELLED"}));
                };
                let handle = EntityId::new_random().to_string();
                let dir = self.backup_private()?.join(format!("restore-{handle}"));
                let a = core::restore(&file, &card, &dir).map_err(map)?;
                let mut result = core::summary(&a.manifest, "VERIFIED");
                result["handle"] = json!(handle);
                r.candidates.insert(handle, a);
                Ok(result)
            }
            Action::Open { handle } => {
                id(&handle)?;
                let a = r.candidates.get(&handle).ok_or(error("BACKUP_NOT_OPEN"))?;
                // Complete prior admitted writer work and stop live senders
                // before acknowledging entry into the archive.
                let mut live = self.inner.lock().map_err(|_| error("ACCESS_BUSY"))?;
                live.unlocked = false;
                *self
                    .archive_selection
                    .lock()
                    .map_err(|_| error("ACCESS_BUSY"))? = Some(AccessView {
                    status: "RECOVERY_ARCHIVE",
                    configured: true,
                    actor_id: Some(a.manifest.source.actor_id.clone()),
                    tenant_id: Some(a.manifest.source.tenant_id.clone()),
                    role: None,
                    pin_enrolled: false,
                    tenants: vec![],
                    catalogue_ready: true,
                    operational_ready: false,
                });
                r.active = Some(handle);
                Ok(json!({"state":"RECOVERY_ARCHIVE"}))
            }
            Action::Close {} => {
                r.active = None;
                *self
                    .archive_selection
                    .lock()
                    .map_err(|_| error("ACCESS_BUSY"))? = None;
                Ok(json!({"state":"CLOSED"}))
            }
            Action::RecoverKey { handle, pin } => {
                let pin = Zeroizing::new(pin);
                let a = r.candidates.get(&handle).ok_or(error("BACKUP_NOT_OPEN"))?;
                let mut inner = self.inner.lock().map_err(|_| error("ACCESS_BUSY"))?;
                if inner.writer.is_some() {
                    return Err(error("BACKUP_CLOSE_ACTIVE_REQUIRED"));
                }
                let selected = if let Some(s) = inner.selected.clone() {
                    s
                } else {
                    let s: Selection = read_json(&self.root.join("selected.json"))?;
                    s.identity.validate()?;
                    s
                };
                let source = self.anchored_source(&selected, false)?;
                if !a.manifest.source.same_identity(&source) {
                    return Err(error("BACKUP_CONTEXT_MISMATCH"));
                }
                let trust = self.config(&mut inner)?.trust()?;
                let ctx = selected.identity.context(&selected.actor_id)?;
                let mut existing = a
                    .existing(&self.root.join(&source.tenant_id), &source)
                    .map_err(map)?;
                let grant = load_grant(existing.connection(), &trust, &ctx)
                    .map_err(|_| error("PERMISSION_DENIED"))?;
                if !grant.payload().capabilities.iter().any(|c| c == "MANAGE") {
                    return Err(error("PERMISSION_DENIED"));
                }
                ventard_core::security::local_auth::verify_recovery_pin(
                    existing.connection(),
                    &grant,
                    &pin,
                    time()?,
                )
                .map_err(|e| error(e.code()))?;
                let store = WindowsKeyStore::new(self.root.join("key-locks"))
                    .map_err(|_| error("BACKUP_KEY_STORE_FAILED"))?;
                a.recover_missing_key(&store, &source).map_err(map)?;
                drop(existing);
                inner.selected = Some(selected);
                inner.unlocked = false;
                r.active = None;
                *self
                    .archive_selection
                    .lock()
                    .map_err(|_| error("ACCESS_BUSY"))? = None;
                Ok(json!({"state":"KEY_RECOVERED","databaseReplaced":false}))
            }
            _ => Err(error("BACKUP_ARCHIVE_READ_ONLY")),
        }
    }
}
#[tauri::command]
pub async fn native_backup(
    window: WebviewWindow,
    state: State<'_, Arc<AccessState>>,
    ipc_version: String,
    request_id: String,
    command: Action,
) -> Result<Value, AccessError> {
    admission(&window, &ipc_version, &request_id)?;
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || state.backup_action(command))
        .await
        .map_err(|_| error("ACCESS_UNAVAILABLE"))?
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn real_windows_recovery_of_owned_fixture_key_preserves_newer_original_database() {
        use crate::platform::keys::windows::FixtureKeys;
        use ed25519_dalek::{Signer, SigningKey};
        use ventard_core::{
            domain::canonical::canonicalize,
            security::key_provider::{installation_anchor, load_vault_key},
            storage::writer::VaultWriter,
        };
        let root = std::env::temp_dir().join(format!(
            "ventard-backup-broker-fixture-{}",
            EntityId::new_random()
        ));
        std::fs::create_dir(&root).unwrap();
        for name in [TENANTS[0], "private", "exports", "cards"] {
            std::fs::create_dir(root.join(name)).unwrap();
        }
        let identity = Identity {
            tenant_id: TENANTS[0].into(),
            vault_id: EntityId::new_random().to_string(),
            device_id: EntityId::new_random().to_string(),
            installation_id: EntityId::new_random().to_string(),
            scope_type: "GLOBAL".into(),
            branch_id: None,
        };
        let selection = Selection {
            identity,
            actor_id: EntityId::new_random().to_string(),
        };
        let ctx = selection.identity.context(&selection.actor_id).unwrap();
        let binding = selection.identity.binding().unwrap();
        let store = FixtureKeys::new(&root.join("key-locks"));
        let key = create_vault_key(&store, &binding).unwrap();
        let mut source = source(&selection).unwrap();
        source.local_anchor_hash = Some(installation_anchor(&store, &binding, true).unwrap());
        let mut live = VaultWriter::create_encrypted(root.join(TENANTS[0]), &key).unwrap();
        let c = live.connection();
        c.execute(
            "INSERT INTO scopes VALUES(?1,'GLOBAL',NULL,?2)",
            (format!("{}/GLOBAL", TENANTS[0]), TENANTS[0]),
        )
        .unwrap();
        let signer = SigningKey::from_bytes(&[0x38; 32]);
        let public_hex = signer
            .verifying_key()
            .to_bytes()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        let config = Config {
            publishable_key: "sb_publishable_synthetic_fixture_only".into(),
            key_id: "backup-fixture-key".into(),
            public_hex,
            issuer_url: ISSUER.into(),
        };
        let trust = config.trust().unwrap();
        let payload = json!({"protocol":"ventard.offline-grant.v1","keyId":config.key_id,"issuer":"ventard.staging","audience":"ventard.native.staging.v1","grantId":EntityId::new_random().to_string(),"grantSequence":"1","policyVersion":"1","tenantId":ctx.tenant_id,"actorId":ctx.actor_id,"deviceId":ctx.device_id,"installationId":ctx.installation_id,"writerEpoch":"1","scope":{"type":"GLOBAL","branchId":null},"role":"owner","capabilities":["READ","SELL","MANAGE"],"issuedAtMs":"1000","actorExpiresAtMs":null,"license":{"planActive":true,"accessUntilMs":null,"trialUntilMs":null,"graceDays":"5","warnAfterOpenings":"200","blockAfterOpenings":"300"}});
        let canonical = canonicalize(&serde_json::to_vec(&payload).unwrap())
            .unwrap()
            .0;
        let signature = signer
            .sign(canonical.as_bytes())
            .to_bytes()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        let wire = serde_json::to_vec(&json!({"payload":payload,"signature":signature})).unwrap();
        let grant = save_grant(c, &wire, &trust, &ctx).unwrap();
        enroll_pin(c, &grant, &Zeroizing::new("9876".into()), 2000).unwrap();
        c.execute(
            "INSERT INTO native_business_profile_v1 VALUES(?1,?2)",
            (
                TENANTS[0],
                json!({"name":"OLD BACKUP · SYNTHETIC FIXTURE"}).to_string(),
            ),
        )
        .unwrap();
        let op = EntityId::new_random().to_string();
        let b = root.join("exports/fixture.vrdbackup");
        let card = root.join("cards/fixture.vrdkey");
        let recovery = RecoverySecret::generate().unwrap();
        let job = core::prepare(c, source.clone(), &op, &b, &card).unwrap();
        core::create(c, job, &key, &recovery, &root.join("private")).unwrap();
        c.execute(
            "UPDATE native_business_profile_v1 SET profile=?2 WHERE tenant_id=?1",
            (
                TENANTS[0],
                json!({"name":"NEWER LIVE DATA · SYNTHETIC FIXTURE"}).to_string(),
            ),
        )
        .unwrap();
        drop(live);
        store.lose_owned(&binding.slot());
        assert!(load_vault_key(&store, &binding).is_err());
        let archive = core::restore(&b, &card, &root.join("candidate")).unwrap();
        let state = AccessState::new(root.clone());
        {
            let mut i = state.inner.lock().unwrap();
            i.config = Some(config);
            i.selected = Some(selection.clone());
        }
        let handle = EntityId::new_random().to_string();
        state
            .recovery
            .lock()
            .unwrap()
            .candidates
            .insert(handle.clone(), archive);
        assert_eq!(
            state
                .backup_action(Action::RecoverKey {
                    handle: handle.clone(),
                    pin: "0000".into()
                })
                .unwrap_err()
                .code,
            "PIN_INVALID"
        );
        assert!(load_vault_key(&store, &binding).is_err());
        let result = state
            .backup_action(Action::RecoverKey {
                handle,
                pin: "9876".into(),
            })
            .unwrap();
        assert_eq!(result["state"], "KEY_RECOVERED");
        assert_eq!(result["databaseReplaced"], false);
        let recovered = load_vault_key(&store, &binding).unwrap();
        let mut w = VaultWriter::open_encrypted(root.join(TENANTS[0]), &recovered).unwrap();
        let profile: String = w
            .connection()
            .query_row("SELECT profile FROM native_business_profile_v1", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert!(profile.contains("NEWER LIVE DATA"));
        drop(w);
        drop(state);
        drop(store);
        let real = root.canonicalize().unwrap();
        assert!(
            real.starts_with(std::env::temp_dir().canonicalize().unwrap())
                && real
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("ventard-backup-broker-fixture-")
        );
        std::fs::remove_dir_all(real).unwrap();
    }
    #[test]
    fn archive_blocks_native_live_access_before_pin_or_grant_loading() {
        let state = AccessState::new(std::env::temp_dir().join("unused-backup-admission-fixture"));
        *state.archive_selection.lock().unwrap() = Some(AccessView {
            status: "RECOVERY_ARCHIVE",
            configured: true,
            actor_id: None,
            tenant_id: None,
            role: None,
            pin_enrolled: false,
            tenants: vec![],
            catalogue_ready: true,
            operational_ready: false,
        });
        let mut inner = state.inner.lock().unwrap();
        assert_eq!(
            state.catalogue_authorize(&mut inner).err().unwrap().code,
            "BACKUP_ARCHIVE_READ_ONLY"
        );
    }
    #[test]
    fn backup_ipc_accepts_no_renderer_paths_sql_or_write_actions() {
        for v in [
            json!({"action":"CREATE","operationId":"96000000-0000-4000-8000-000000000001","path":"C:/private"}),
            json!({"action":"INSPECT","sql":"SELECT secret"}),
            json!({"action":"DELETE"}),
            json!({"action":"RECOVER_KEY","handle":"fixture","pin":"0000","tenantId":"forged"}),
            json!({"action":"WEB_IMPORT","path":"C:/private","key":"forged"}),
            json!({"action":"WEB_ROWS","exportId":"fixture","table":"ventas","page":0,"tenantId":"forged"}),
        ] {
            assert!(serde_json::from_value::<Action>(v).is_err())
        }
    }
    #[test]
    fn browser_migration_requires_owner_pin_before_any_chooser_or_data_read() {
        let state =
            AccessState::new(std::env::temp_dir().join("unused-web-migration-admission-fixture"));
        for action in [
            Action::WebImport {},
            Action::WebStatus {},
            Action::WebRows {
                export_id: "fixture".into(),
                table: "ventas".into(),
                page: 0,
            },
        ] {
            assert_eq!(
                state.backup_action(action).unwrap_err().code,
                "ACCESS_PIN_REQUIRED"
            );
        }
    }
}
