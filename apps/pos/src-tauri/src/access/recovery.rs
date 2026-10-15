//! Owner/PIN-bound recovery of a portable backup into a fresh identity.
use super::backup::Action;
use super::*;
use ventard_core::security::recovery_enrollment::RecoverySecret;
use ventard_core::storage::{backup as archive, recovery as core};
impl AccessState {
    fn recovery_owned<R: Send + 'static>(
        &self,
        expected: &CatalogueContext,
        f: impl FnOnce(
                &mut ventard_core::storage::writer::CoreConnection,
                CatalogueContext,
            ) -> Result<R, core::Error>
            + Send
            + 'static,
    ) -> Result<R, AccessError> {
        self.deny_archive()?;
        let (s, w) = self.backup_owner()?;
        let ctx = s.catalogue_context();
        if ctx != *expected {
            return Err(error("RECOVERY_CONTEXT"));
        }
        let inner = self.inner.lock().map_err(|_| error("ACCESS_BUSY"))?;
        if !inner.unlocked
            || inner
                .selected
                .as_ref()
                .is_none_or(|s| s.catalogue_context() != ctx)
            || inner
                .writer
                .as_ref()
                .is_none_or(|current| !Arc::ptr_eq(current, &w))
        {
            return Err(error("RECOVERY_CONTEXT"));
        }
        w.call(move |c| Ok(f(c, ctx)))
            .map_err(|_| error("RECOVERY_STORAGE"))?
            .map_err(|e| error(e.code()))
    }
    fn recovery_secret(&self, s: &Selection) -> Result<RecoverySecret, AccessError> {
        let store = WindowsKeyStore::new(self.root.join("key-locks"))
            .map_err(|_| error("BACKUP_KEY_STORE_FAILED"))?;
        let key = load_vault_key(&store, &s.identity.binding()?)
            .map_err(|_| error("ACCESS_KEY_UNAVAILABLE"))?;
        Ok(RecoverySecret::from_cipher_key(&key))
    }
    fn recovery_send(
        &self,
        ctx: &CatalogueContext,
        recovery_id: String,
        abandon: bool,
    ) -> Result<Value, AccessError> {
        let id = recovery_id.clone();
        let (intent, hash) = self.recovery_owned(ctx, move |c, ctx| core::request(c, &ctx, &id))?;
        let args = json!({"p_intent":intent,"p_hash":hash});
        let raw = self.transition_rpc(ctx, "native_recovery_lookup_v1", args.clone())?;
        let mut receipt: Value =
            serde_json::from_str(&raw).map_err(|_| error("RECOVERY_INVALID"))?;
        if receipt["status"] == "NOT_FOUND" {
            let raw = self.transition_rpc(
                ctx,
                "native_recovery_submit_v1",
                json!({"p_intent":intent,"p_hash":hash,"p_abandon":abandon}),
            )?;
            receipt = serde_json::from_str(&raw).map_err(|_| error("RECOVERY_INVALID"))?;
        }
        self.recovery_owned(ctx, move |c, ctx| {
            core::record(c, &ctx, &recovery_id, &receipt)
        })
    }
    pub(super) fn recovery_action(&self, action: Action) -> Result<Value, AccessError> {
        self.deny_archive()?;
        let (selected, _) = self.backup_owner()?;
        let ctx = selected.catalogue_context();
        match action {
            Action::RecoveryList {} => self.recovery_owned(&ctx, |c, ctx| core::list(c, &ctx)),
            Action::RecoveryPrepare {
                handle,
                recovery_id,
            } => {
                id(&handle)?;
                id(&recovery_id)?;
                let old = recovery_id.clone();
                if let Some(view) =
                    self.recovery_owned(&ctx, move |c, ctx| core::view(c, &ctx, &old))?
                {
                    let old = recovery_id.clone();
                    let (_, saved) =
                        self.recovery_owned(&ctx, move |c, ctx| core::custody(c, &ctx, &old))?;
                    let state = self.recovery.lock().map_err(|_| error("ACCESS_BUSY"))?;
                    let candidate = state
                        .candidates
                        .get(&handle)
                        .ok_or(error("BACKUP_NOT_OPEN"))?;
                    if candidate.manifest != saved.manifest {
                        return Err(error("RECOVERY_ID_CONFLICT"));
                    }
                    return Ok(view);
                }
                self.sales_history_remote()?;
                let secret = self.recovery_secret(&selected)?;
                let directory_id = EntityId::new_random().to_string();
                let directory = self
                    .backup_private()?
                    .join(format!("custody-{directory_id}"));
                let state = self.recovery.lock().map_err(|_| error("ACCESS_BUSY"))?;
                let candidate = state
                    .candidates
                    .get(&handle)
                    .ok_or(error("BACKUP_NOT_OPEN"))?;
                let source = candidate.manifest.source.clone();
                let facts = candidate.read(core::facts).map_err(|e| error(e.code()))?;
                drop(state);
                let preliminary = facts.clone();
                self.recovery_owned(&ctx, move |c, ctx| {
                    core::inspect(c, &ctx, &source, &preliminary)
                })?;
                let state = self.recovery.lock().map_err(|_| error("ACCESS_BUSY"))?;
                let candidate = state
                    .candidates
                    .get(&handle)
                    .ok_or(error("BACKUP_NOT_OPEN"))?;
                let custody = candidate
                    .preserve(&directory, &secret)
                    .map_err(|e| error(e.code()))?;
                let ciphertext = candidate.encrypted_bytes().map_err(|e| error(e.code()))?;
                drop(state);
                self.recovery_owned(&ctx, move |c, ctx| {
                    core::prepare(
                        c,
                        &ctx,
                        &recovery_id,
                        &directory_id,
                        &custody,
                        facts,
                        ciphertext,
                    )
                })
            }
            Action::RecoveryReview { recovery_id } => {
                self.sales_history_remote()?;
                self.recovery_owned(&ctx, move |c, ctx| core::review(c, &ctx, &recovery_id))
            }
            Action::RecoverySendPending {
                recovery_id,
                original_stopped,
            } => {
                if !original_stopped {
                    return Err(error("RECOVERY_CONFIRMATION_REQUIRED"));
                }
                let request_id = recovery_id.clone();
                let facts =
                    self.recovery_owned(&ctx, move |c, ctx| core::pending(c, &ctx, &request_id))?;
                self.recovery_original_pending(facts)?;
                self.sales_history_remote()?;
                self.recovery_owned(&ctx, move |c, ctx| core::review(c, &ctx, &recovery_id))
            }
            Action::RecoveryConfirm {
                recovery_id,
                original_stopped,
            } => {
                if !original_stopped {
                    return Err(error("RECOVERY_CONFIRMATION_REQUIRED"));
                }
                let capture = self.sales_history_remote()?;
                let snapshot = capture["snapshotId"]
                    .as_str()
                    .ok_or(error("RECOVERY_INVALID"))?
                    .to_owned();
                let request_id = recovery_id.clone();
                self.recovery_owned(&ctx, move |c, ctx| {
                    core::freeze(c, &ctx, &request_id, &snapshot, true)
                })?;
                self.recovery_send(&ctx, recovery_id, false)
            }
            Action::RecoveryRecover { recovery_id } => self.recovery_send(&ctx, recovery_id, false),
            Action::RecoveryAbandon { recovery_id } => {
                let request_id = recovery_id.clone();
                let prepared = self
                    .recovery_owned(&ctx, move |c, ctx| core::view(c, &ctx, &request_id))?
                    .ok_or(error("RECOVERY_NOT_FOUND"))?["state"]
                    == "PREPARED";
                if prepared {
                    self.recovery_send(&ctx, recovery_id, true)
                } else {
                    self.recovery_owned(&ctx, move |c, ctx| {
                        core::abandon_unprepared(c, &ctx, &recovery_id)
                    })
                }
            }
            Action::RecoveryOpen { recovery_id } => {
                let secret = self.recovery_secret(&selected)?;
                let (directory, custody, ciphertext) =
                    self.recovery_owned(&ctx, move |c, ctx| {
                        let (directory, custody) = core::custody(c, &ctx, &recovery_id)?;
                        Ok((directory, custody, core::ciphertext(c, &ctx, &recovery_id)?))
                    })?;
                let directory = self.backup_private()?.join(format!("custody-{directory}"));
                archive::materialize_preserved(&directory, &custody, &ciphertext)
                    .map_err(|e| error(e.code()))?;
                let preserved = archive::open_preserved(&directory, &custody, &secret)
                    .map_err(|e| error(e.code()))?;
                let handle = EntityId::new_random().to_string();
                let mut state = self.recovery.lock().map_err(|_| error("ACCESS_BUSY"))?;
                if state.candidates.len() >= 8 {
                    return Err(error("BACKUP_TOO_MANY_CANDIDATES"));
                }
                state.candidates.insert(handle.clone(), preserved);
                drop(state);
                self.backup_action(Action::Open { handle })
            }
            _ => Err(error("RECOVERY_INVALID")),
        }
    }
}
