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
fn inventory_ledger_url(
    ctx: &CatalogueContext,
    batch: &core::Batch,
) -> Result<reqwest::Url, &'static str> {
    if batch.source_kind != "INVENTORY_LEDGER_V2"
        || batch.table != "movimientos_stock"
        || batch.ids.is_empty()
        || batch.ids.len() > 100
    {
        return Err("RESPONSE_INVALID");
    }
    let tenant = uuid::Uuid::parse_str(&ctx.tenant_id).map_err(|_| "RESPONSE_INVALID")?;
    let scope = match (ctx.scope_type.as_str(), ctx.branch_id.as_deref()) {
        ("GLOBAL", None) => "is.null".into(),
        ("BRANCH", Some(branch)) => format!(
            "eq.{}",
            uuid::Uuid::parse_str(branch).map_err(|_| "RESPONSE_INVALID")?
        ),
        _ => return Err("RESPONSE_INVALID"),
    };
    let ids = batch
        .ids
        .iter()
        .map(|id| {
            uuid::Uuid::parse_str(id)
                .map(|id| id.to_string())
                .map_err(|_| "RESPONSE_INVALID")
        })
        .collect::<Result<Vec<_>, _>>()?;
    if ids.iter().collect::<std::collections::BTreeSet<_>>().len() != ids.len() {
        return Err("RESPONSE_INVALID");
    }
    let mut url = reqwest::Url::parse(&format!("{HOST}/rest/v1/inventario_operaciones_v2"))
        .map_err(|_| "RESPONSE_INVALID")?;
    url.query_pairs_mut().append_pair("select","negocio_id,operacion_id,payload_version,payload_hash,authority_kind,producto_id,sucursal_id,effect_kind,effect_value,tipo,referencia_id,fecha_origen,expected_remote_sequence,remote_sequence,stock_before,stock_after,applied_at,applied_by,warning_codes")
      .append_pair("negocio_id",&format!("eq.{tenant}")).append_pair("sucursal_id",&scope).append_pair("authority_kind",&format!("eq.{}",ctx.scope_type)).append_pair("operacion_id",&format!("in.({})",ids.join(","))).append_pair("order","operacion_id.asc").append_pair("limit","101");
    Ok(url)
}
fn probe_context(
    client: &reqwest::blocking::Client,
    key: &str,
    token: &str,
    body: &Value,
    ctx: &CatalogueContext,
    batch: &core::Batch,
) -> Result<String, &'static str> {
    let response = client
        .post(format!("{HOST}/rest/v1/rpc/native_web_observe_v1"))
        .header("apikey", key)
        .bearer_auth(token)
        .json(body)
        .send()
        .map_err(|_| "NETWORK_UNAVAILABLE")?;
    let status = response.status().as_u16();
    let mut bytes = Vec::new();
    response
        .take(500_001)
        .read_to_end(&mut bytes)
        .map_err(|_| "NETWORK_UNAVAILABLE")?;
    if !(200..300).contains(&status) {
        return Err(http_failure(status, &bytes));
    }
    if bytes.len() > 500_000 {
        return Err("RESPONSE_TOO_LARGE");
    }
    let raw = String::from_utf8(bytes).map_err(|_| "RESPONSE_INVALID")?;
    core::validate_context_probe(ctx, batch, &raw).map_err(|_| "RESPONSE_INVALID")?;
    Ok(raw)
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
            let selected = inner.selected.clone().ok_or("LOGIN_REQUIRED")?;
            let token = self.online_token(&mut inner, &selected).map_err(|e| match e.code { "ACCESS_LOGIN_REQUIRED" => "LOGIN_REQUIRED", "ACCESS_NETWORK_UNAVAILABLE" => "NETWORK_UNAVAILABLE", _ => "REMOTE_DENIED" })?;
            (config, token)
        };
        config.validate().map_err(|_| "REMOTE_DENIED")?;
        let body = json!({"p_negocio_id":expected.tenant_id,"p_installation_id":expected.installation_id,"p_device_id":expected.device_id,"p_writer_epoch":expected.writer_epoch,"p_scope_kind":expected.scope_type,"p_sucursal_id":expected.branch_id,"p_observation_id":batch.observation_id,"p_table":batch.table,"p_ids":batch.ids});
        let client = Self::client().map_err(|_| "NETWORK_UNAVAILABLE")?;
        if batch.source_kind == "INVENTORY_LEDGER_V2" {
            probe_context(
                &client,
                &config.publishable_key,
                &token,
                &body,
                expected,
                batch,
            )?;
            let response = client
                .get(inventory_ledger_url(expected, batch)?)
                .header("apikey", &config.publishable_key)
                .bearer_auth(&*token)
                .send()
                .map_err(|_| "NETWORK_UNAVAILABLE")?;
            let status = response.status().as_u16();
            let mut bytes = Vec::new();
            response
                .take(1_000_001)
                .read_to_end(&mut bytes)
                .map_err(|_| "NETWORK_UNAVAILABLE")?;
            if !(200..300).contains(&status) {
                return Err(http_failure(status, &bytes));
            }
            if bytes.len() > 1_000_000 {
                return Err("RESPONSE_TOO_LARGE");
            }
            let raw = String::from_utf8(bytes).map_err(|_| "RESPONSE_INVALID")?;
            let received = time().map_err(|_| "RESPONSE_INVALID")?.to_string();
            let context_proof = probe_context(
                &client,
                &config.publishable_key,
                &token,
                &body,
                expected,
                batch,
            )?;
            // Native reception time, not a claimed server snapshot. Original
            // ledger bytes and applied_at are preserved verbatim in SQLCipher.
            let envelope=serde_json::to_string(&json!({"protocol":"ventard.web.inventory-ledger.1","observationId":batch.observation_id,"tenantId":expected.tenant_id,"actorId":expected.actor_id,"installationId":expected.installation_id,"deviceId":expected.device_id,"writerEpoch":expected.writer_epoch,"scope":{"type":expected.scope_type,"branchId":expected.branch_id},"table":batch.table,"requestedIds":batch.ids,"capturedAtMs":received,"coverage":"REQUESTED_IDS_ONLY","decimalEncoding":"RAW_INT4_BIGINT_V1","rows":[],"ledgerRowsJson":raw,"contextProofJson":context_proof})).map_err(|_|"RESPONSE_INVALID")?;
            if envelope.len() > 2_097_152 {
                return Err("RESPONSE_TOO_LARGE");
            }
            return Ok(envelope);
        }
        if batch.source_kind != "LEGACY_ROWS" {
            return Err("RESPONSE_INVALID");
        }
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
    fn inventory_evidence_queries_only_fixed_read_endpoint_and_explicit_context_scope() {
        let mut ctx = CatalogueContext {
            tenant_id: TENANTS[0].into(),
            installation_id: TENANTS[0].into(),
            device_id: TENANTS[0].into(),
            actor_id: TENANTS[0].into(),
            writer_epoch: "1".into(),
            scope_type: "BRANCH".into(),
            branch_id: Some(TENANTS[1].into()),
        };
        let mut batch = core::Batch {
            report_id: TENANTS[0].into(),
            index: 0,
            table: "movimientos_stock".into(),
            observation_id: TENANTS[0].into(),
            ids: vec![TENANTS[0].into()],
            source_kind: "INVENTORY_LEDGER_V2".into(),
        };
        let url = inventory_ledger_url(&ctx, &batch).unwrap();
        assert_eq!(url.host_str(), Some("blzzinivvzadqjbnpsre.supabase.co"));
        assert_eq!(url.path(), "/rest/v1/inventario_operaciones_v2");
        let query = url
            .query_pairs()
            .collect::<std::collections::BTreeMap<_, _>>();
        assert_eq!(query["sucursal_id"], format!("eq.{}", TENANTS[1]));
        assert_eq!(query["negocio_id"], format!("eq.{}", TENANTS[0]));
        assert_eq!(query["authority_kind"], "eq.BRANCH");
        ctx.scope_type = "GLOBAL".into();
        ctx.branch_id = None;
        assert!(inventory_ledger_url(&ctx, &batch)
            .unwrap()
            .query_pairs()
            .any(|(k, v)| k == "sucursal_id" && v == "is.null"));
        batch.ids = vec!["http://untrusted.invalid?q=or(negocio_id.neq.x)".into()];
        assert!(inventory_ledger_url(&ctx, &batch).is_err());
        batch.ids = vec![TENANTS[0].into()];
        batch.table = "ventas".into();
        assert!(inventory_ledger_url(&ctx, &batch).is_err());
    }
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
