//! Read-only, fixed-host observations. Native paths/tokens/HTTP never reach UI.
use super::*;
use ventard_core::storage::legacy_reconciliation as core;
fn map(e: core::Error) -> AccessError {
    error(e.code())
}
fn http_failure(status: u16, bytes: &[u8]) -> &'static str {
    if status == 401 {
        return "LOGIN_REQUIRED";
    }
    if status == 403 {
        return "REMOTE_DENIED";
    }
    let value: Value = serde_json::from_slice(bytes).unwrap_or(Value::Null);
    if status == 404 || value["code"] == "PGRST202" || value["code"] == "42883" {
        return "MIGRATION_REQUIRED";
    }
    match value["message"].as_str() {
        Some("WEB_OBSERVATION_UNAVAILABLE") => "TABLE_UNAVAILABLE",
        Some("WEB_OBSERVATION_TOO_LARGE") => "RESPONSE_TOO_LARGE",
        _ => "NETWORK_UNAVAILABLE",
    }
}
impl AccessState {
    fn web_owned<R: Send + 'static>(
        &self,
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
        let inner = self.inner.lock().map_err(|_| error("ACCESS_BUSY"))?;
        if !inner.unlocked
            || inner
                .selected
                .as_ref()
                .is_none_or(|current| current.catalogue_context() != ctx)
            || inner
                .writer
                .as_ref()
                .is_none_or(|current| !Arc::ptr_eq(current, &w))
        {
            return Err(error("WEB_RECONCILE_CONTEXT"));
        }
        self.deny_archive()?;
        w.call(move |c| Ok(f(c, ctx)))
            .map_err(|_| error("WEB_RECONCILE_STORAGE"))?
            .map_err(map)
    }
    fn web_observe(
        &self,
        batch: &core::Batch,
        expected: &CatalogueContext,
    ) -> Result<String, &'static str> {
        let (config, token) = {
            let mut inner = self.inner.lock().map_err(|_| "REMOTE_DENIED")?;
            if !inner.unlocked
                || inner
                    .selected
                    .as_ref()
                    .is_none_or(|s| s.catalogue_context() != *expected)
            {
                return Err("REMOTE_DENIED");
            }
            let config = self.config(&mut inner).map_err(|_| "REMOTE_DENIED")?;
            let session = inner
                .session
                .as_ref()
                .filter(|s| {
                    s.actor == expected.actor_id && s.expires_at > time().unwrap_or(u64::MAX)
                })
                .ok_or("LOGIN_REQUIRED")?;
            (config, Zeroizing::new(session.token.to_string()))
        };
        config.validate().map_err(|_| "REMOTE_DENIED")?;
        let body = json!({"p_negocio_id":expected.tenant_id,"p_installation_id":expected.installation_id,"p_device_id":expected.device_id,"p_writer_epoch":expected.writer_epoch,"p_scope_kind":expected.scope_type,"p_sucursal_id":expected.branch_id,"p_observation_id":batch.observation_id,"p_table":batch.table,"p_ids":batch.ids});
        let client = Self::client().map_err(|_| "NETWORK_UNAVAILABLE")?;
        let response = client
            .post(format!("{HOST}/rest/v1/rpc/native_web_observe_v1"))
            .header("apikey", &config.publishable_key)
            .bearer_auth(&*token)
            .json(&body)
            .send()
            .map_err(|_| "NETWORK_UNAVAILABLE")?;
        let status = response.status().as_u16();
        let mut bytes = Vec::new();
        response
            .take(2_097_153)
            .read_to_end(&mut bytes)
            .map_err(|_| "NETWORK_UNAVAILABLE")?;
        if !(200..300).contains(&status) {
            return Err(http_failure(status, &bytes));
        }
        if bytes.len() > 2_097_152 {
            return Err("RESPONSE_TOO_LARGE");
        }
        String::from_utf8(bytes).map_err(|_| "RESPONSE_INVALID")
    }
    pub(super) fn web_reconcile_action(
        &self,
        action: backup::Action,
    ) -> Result<Value, AccessError> {
        let _gate = self
            .web_reconcile_gate
            .lock()
            .map_err(|_| error("ACCESS_BUSY"))?;
        match action {
            backup::Action::WebReconcileView { export_id } => {
                id(&export_id)?;
                self.web_owned(move |c, ctx| core::view(c, &ctx, &export_id))
            }
            backup::Action::WebReconcilePrepare {
                export_id,
                report_id,
            } => {
                id(&export_id)?;
                id(&report_id)?;
                let at = time()?.to_string();
                self.web_owned(move |c, ctx| core::prepare(c, &ctx, &export_id, &report_id, &at))
            }
            backup::Action::WebReconcileRows {
                report_id,
                table,
                page,
            } => {
                id(&report_id)?;
                self.web_owned(move |c, ctx| core::rows(c, &ctx, &report_id, &table, page))
            }
            backup::Action::WebReconcileStep { report_id } => {
                id(&report_id)?;
                let report = report_id.clone();
                let (context, batch) =
                    self.web_owned(move |c, ctx| Ok((ctx.clone(), core::next(c, &ctx, &report)?)))?;
                let Some(batch) = batch else {
                    return self.web_owned(move |c, ctx| core::status(c, &ctx, &report_id));
                };
                let observation = self.web_observe(&batch, &context);
                self.web_owned(move |c, ctx| {
                    if ctx != context {
                        return Err(core::context_changed());
                    }
                    match observation {
                        Ok(raw) => match core::accept(c, &ctx, &report_id, &batch, &raw) {
                            Ok(v) => Ok(v),
                            Err(e)
                                if matches!(
                                    e.code(),
                                    "WEB_RECONCILE_INVALID" | "WEB_RECONCILE_TOO_LARGE"
                                ) =>
                            {
                                core::failure(c, &ctx, &report_id, "RESPONSE_INVALID")
                            }
                            Err(e) => Err(e),
                        },
                        Err(code) => core::failure(c, &ctx, &report_id, code),
                    }
                })
            }
            _ => Err(error("WEB_RECONCILE_INVALID")),
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn observation_actions_require_owner_pin_before_storage_or_http() {
        let state = AccessState::new(std::env::temp_dir().join("unused-web-observation-fixture"));
        for action in [
            backup::Action::WebReconcileView {
                export_id: TENANTS[0].into(),
            },
            backup::Action::WebReconcilePrepare {
                export_id: TENANTS[0].into(),
                report_id: TENANTS[0].into(),
            },
            backup::Action::WebReconcileStep {
                report_id: TENANTS[0].into(),
            },
            backup::Action::WebReconcileRows {
                report_id: TENANTS[0].into(),
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
    #[test]
    fn errors_do_not_forward_server_details() {
        assert_eq!(http_failure(404, b"secret body"), "MIGRATION_REQUIRED");
        assert_eq!(http_failure(401, b"private token"), "LOGIN_REQUIRED");
        assert_eq!(http_failure(403, b"sensitive actor"), "REMOTE_DENIED");
        assert_eq!(
            http_failure(400, br#"{"message":"WEB_OBSERVATION_UNAVAILABLE"}"#),
            "TABLE_UNAVAILABLE"
        );
        assert_eq!(http_failure(500, b"SQL secret"), "NETWORK_UNAVAILABLE");
    }
}
