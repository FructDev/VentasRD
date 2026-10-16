//! Fixed Staging read endpoint and owner/PIN-bound SQLCipher reconciliation.
use super::*;
use ventard_core::storage::legacy_cutover as cut;
use ventard_core::storage::legacy_transition as core;
fn resolution_schema_failure(rpc: &str, code: Option<&str>) -> bool {
    matches!(rpc, "native_web_cutover_v1" | "native_web_resolution_commit_v1")
        && matches!(code, Some("23502" | "23503" | "23514" | "22P02" | "22003"))
}
impl AccessState {
    fn cutover_owned<R: Send + 'static>(
        &self,
        f: impl FnOnce(
                &mut ventard_core::storage::writer::CoreConnection,
                CatalogueContext,
            ) -> Result<R, cut::Error>
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
                .is_none_or(|s| s.catalogue_context() != ctx)
            || inner
                .writer
                .as_ref()
                .is_none_or(|other| !Arc::ptr_eq(other, &w))
        {
            return Err(error("CUTOVER_CONTEXT"));
        }
        self.deny_archive()?;
        w.call(move |c| Ok(f(c, ctx)))
            .map_err(|_| error("CUTOVER_STORAGE"))?
            .map_err(|e| error(e.code()))
    }
    fn transition_owned<R: Send + 'static>(
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
                .is_none_or(|s| s.catalogue_context() != ctx)
            || inner
                .writer
                .as_ref()
                .is_none_or(|other| !Arc::ptr_eq(other, &w))
        {
            return Err(error("TRANSITION_CONTEXT"));
        }
        self.deny_archive()?;
        w.call(move |c| Ok(f(c, ctx)))
            .map_err(|_| error("TRANSITION_STORAGE"))?
            .map_err(|e| error(e.code()))
    }
    pub(super) fn transition_rpc(
        &self,
        ctx: &CatalogueContext,
        rpc: &'static str,
        args: Value,
    ) -> Result<String, AccessError> {
        let (config, token) = {
            let mut inner = self.inner.lock().map_err(|_| error("ACCESS_BUSY"))?;
            if !inner.unlocked
                || inner
                    .selected
                    .as_ref()
                    .is_none_or(|s| s.catalogue_context() != *ctx)
            {
                return Err(error("TRANSITION_CONTEXT"));
            }
            let config = self.config(&mut inner)?;
            let session = inner
                .session
                .as_ref()
                .filter(|s| s.actor == ctx.actor_id && s.expires_at > time().unwrap_or(u64::MAX))
                .ok_or_else(|| error("LOGIN_REQUIRED"))?;
            (config, Zeroizing::new(session.token.to_string()))
        };
        config.validate()?;
        let response = Self::client()?
            .post(format!("{HOST}/rest/v1/rpc/{rpc}"))
            .header("apikey", &config.publishable_key)
            .bearer_auth(&*token)
            .json(&args)
            .send()
            .map_err(|_| error("NETWORK_UNAVAILABLE"))?;
        let status = response.status().as_u16();
        let mut bytes = Vec::new();
        response
            .take((core::MAX_CAPTURE + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|_| error("NETWORK_UNAVAILABLE"))?;
        if !(200..300).contains(&status) {
            let v: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
            return Err(error(match status {
                401 => "LOGIN_REQUIRED",
                403 => "REMOTE_DENIED",
                404 if rpc.starts_with("native_recovery_") => "RECOVERY_MIGRATION_REQUIRED",
                404 if rpc.starts_with("native_web_resolution_") => "RESOLUTION_MIGRATION_REQUIRED",
                404 => "MIGRATION_REQUIRED",
                _ => match v["message"].as_str() {
                    Some("RESOLUTION_SOURCE_CHANGED")=>"RESOLUTION_SOURCE_CHANGED",
                    Some("RESOLUTION_NATIVE_ALREADY_STARTED")=>"RESOLUTION_NATIVE_ALREADY_STARTED",
                    Some("RESOLUTION_OTHER_WRITERS_ACTIVE")=>"RESOLUTION_OTHER_WRITERS_ACTIVE",
                    Some("RESOLUTION_OTHER_BRANCH_STOCK_UNKNOWN")=>"RESOLUTION_OTHER_BRANCH_STOCK_UNKNOWN",
                    Some("RESOLUTION_SOURCE_PARENT_MISSING")=>"RESOLUTION_SOURCE_PARENT_MISSING",
                    Some("RESOLUTION_SCHEMA_INCOMPATIBLE")=>"RESOLUTION_SCHEMA_INCOMPATIBLE",
                    Some("RESOLUTION_STOCK_COVERAGE")=>"RESOLUTION_STOCK_COVERAGE",
                    Some("RESOLUTION_DEBT_COVERAGE")=>"RESOLUTION_DEBT_COVERAGE",
                    Some("RESOLUTION_MONEY_INVALID")=>"RESOLUTION_MONEY_INVALID",
                    Some("RESOLUTION_SCOPE")=>"RESOLUTION_SCOPE",
                    Some("RESOLUTION_HISTORY_REQUIRED")=>"RESOLUTION_HISTORY_REQUIRED",
                    Some("RESOLUTION_HISTORY_INVALID")=>"RESOLUTION_HISTORY_INVALID",
                    Some("RESOLUTION_TOO_LARGE")=>"RESOLUTION_TOO_LARGE",
                    Some("RESOLUTION_PART_INVALID")=>"RESOLUTION_PART_INVALID",
                    Some("RESOLUTION_TRANSPORT_FULL")=>"RESOLUTION_TRANSPORT_FULL",
                    _ if resolution_schema_failure(rpc,v["code"].as_str())=>"RESOLUTION_SCHEMA_INCOMPATIBLE",
                    Some("WEB_OBSERVATION_UNAVAILABLE") => "TABLE_UNAVAILABLE",
                    Some("WEB_OBSERVATION_TOO_LARGE") => "TRANSITION_TOO_LARGE",
                    Some("CUTOVER_SOURCE_CHANGED") => "CUTOVER_SOURCE_CHANGED",
                    Some("CUTOVER_CLOSE_WEB_CASH") => "CUTOVER_CLOSE_WEB_CASH",
                    Some("CUTOVER_CASH_HISTORY_CONFIRMATION_REQUIRED") => {
                        "CUTOVER_CASH_HISTORY_CONFIRMATION_REQUIRED"
                    }
                    Some("CUTOVER_SERVICE_REQUIRES_RECONCILIATION") => {
                        "CUTOVER_SERVICE_REQUIRES_RECONCILIATION"
                    }
                    Some("CUTOVER_SERVICE_RESERVATIONS_REQUIRED") => {
                        "CUTOVER_SERVICE_RESERVATIONS_REQUIRED"
                    }
                    Some("CUTOVER_SERVICE_CAPTURE_TOO_LARGE") => {
                        "CUTOVER_SERVICE_CAPTURE_TOO_LARGE"
                    }
                    Some("CUTOVER_SERVICE_BASELINE_CONFLICT") => {
                        "CUTOVER_SERVICE_BASELINE_CONFLICT"
                    }
                    Some(
                        "NATIVE_SERVICE_PART_UNSUPPORTED"
                        | "NATIVE_SERIAL_SOURCE_UNVERIFIABLE"
                        | "NATIVE_SERIAL_CONFLICT",
                    ) => "CUTOVER_SERVICE_REQUIRES_RECONCILIATION",
                    Some("CUTOVER_CREDIT_UNVERIFIABLE") => "CUTOVER_CREDIT_UNVERIFIABLE",
                    Some("CUTOVER_ACTIVE_BALANCE_CONFLICT") => "CUTOVER_ACTIVE_BALANCE_CONFLICT",
                    Some("CUTOVER_ID_CONFLICT") => "CUTOVER_ID_CONFLICT",
                    Some("RECOVERY_PENDING_UNVERIFIED") => "RECOVERY_PENDING_UNVERIFIED",
                    Some("RECOVERY_SOURCE_NOT_ACTIVE") => "RECOVERY_SOURCE_NOT_ACTIVE",
                    Some("RECOVERY_SNAPSHOT_REQUIRED" | "RECOVERY_SNAPSHOT_EXPIRED") => {
                        "RECOVERY_SNAPSHOT_EXPIRED"
                    }
                    Some("RECOVERY_ID_CONFLICT") => "RECOVERY_ID_CONFLICT",
                    Some("RECOVERY_OWNER_REQUIRED") => "RECOVERY_OWNER_REQUIRED",
                    Some("RECOVERY_NEW_IDENTITY_REQUIRED") => "RECOVERY_NEW_IDENTITY_REQUIRED",
                    Some("NATIVE_ACTIVE_SCOPE_CONFLICT") => "CUTOVER_ACTIVE_SCOPE_CONFLICT",
                    Some("NATIVE_CREDIT_SOURCE_UNVERIFIABLE") => "CUTOVER_CREDIT_UNVERIFIABLE",
                    _ => "NETWORK_UNAVAILABLE",
                },
            }));
        }
        if bytes.len() > core::MAX_CAPTURE {
            return Err(error("TRANSITION_TOO_LARGE"));
        }
        String::from_utf8(bytes).map_err(|_| error("TRANSITION_INVALID"))
    }
    pub(super) fn transition_action(&self, action: backup::Action) -> Result<Value, AccessError> {
        match action {
            backup::Action::TransitionResolutionBasis {run_id,revision} => {
                id(&run_id)?;let rid=run_id.clone();
                let (ctx,capture)=self.cutover_owned(move|c,ctx|{let report=core::report(c,&ctx,&rid)?;if report["revision"]!=revision{return Err(cut::context_changed());}let capture=report["sources"].as_array().and_then(|a|a.iter().find(|s|s["kind"]=="CLOUD")).and_then(|s|s["id"].as_str()).ok_or(cut::context_changed())?.to_owned();Ok((ctx,capture))})?;
                let raw=self.transition_rpc(&ctx,"native_web_resolution_basis_v1",json!({"p_context":ctx,"p_capture_id":capture}))?;
                let basis:Value=serde_json::from_str(&raw).map_err(|_|error("RESOLUTION_SOURCE_CHANGED"))?;
                self.cutover_owned(move|c,current|{if current!=ctx{return Err(cut::context_changed());}cut::store_resolution_basis(c,&current,&run_id,revision,&basis)})
            }
            backup::Action::TransitionResolutionView {run_id,page} => {id(&run_id)?;self.cutover_owned(move|c,ctx|cut::resolution_view(c,&ctx,&run_id,page))}
            backup::Action::TransitionResolutionPreview {run_id,page,decisions} => {id(&run_id)?;self.cutover_owned(move|c,ctx|cut::resolution_preview(c,&ctx,&run_id,page,&decisions))}
            backup::Action::TransitionSelectedReview {input} => {id(&input.run_id)?;self.cutover_owned(move|c,ctx|cut::review_selected(c,&ctx,&input))}
            backup::Action::TransitionDifferences { run_id, page } => {
                id(&run_id)?;
                self.cutover_owned(move |c,ctx| cut::differences(c,&ctx,&run_id,page))
            }
            backup::Action::TransitionBaselineReview { input } => {
                id(&input.run_id)?;
                self.cutover_owned(move |c,ctx| {
                    cut::review_baseline(c,&ctx,&input)?;
                    Ok(core::report(c,&ctx,&input.run_id)?)
                })
            }
            backup::Action::TransitionCutoverView { run_id } => {
                id(&run_id)?;
                self.cutover_owned(move|c,ctx|{let mut value=cut::readiness(c,&ctx,&run_id)?;value["pending"]=cut::view(c,&ctx)?;value["selectedBaseline"]=cut::selected_readiness(c,&ctx,&run_id)?;
                    let mut q=c.prepare("SELECT operation_id FROM native_backup_jobs_v1 WHERE tenant_id=?1 AND installation_id=?2 AND actor_id=?3 AND state='VERIFIED' ORDER BY rowid DESC LIMIT 20")?;
                    value["backups"]=json!(q.query_map((&ctx.tenant_id,&ctx.installation_id,&ctx.actor_id),|r|r.get::<_,String>(0))?.collect::<Result<Vec<_>,_>>()?);Ok(value)})
            }
            backup::Action::TransitionCutover { input } => {
                let id = input.cutover_id.clone();
                let at = time()?.to_string();
                let (ctx, p) = self.cutover_owned(move |c, ctx| {
                    Ok((ctx.clone(), cut::prepare(c, &ctx, &input, &at)?))
                })?;
                self.complete_cutover(ctx, id, p)
            }
            backup::Action::TransitionCutoverRecover { cutover_id } => {
                id(&cutover_id)?;
                let cid = cutover_id.clone();
                let (ctx, p) =
                    self.cutover_owned(move |c, ctx| Ok((ctx.clone(), cut::load(c, &ctx, &cid)?)))?;
                self.complete_cutover(ctx, cutover_id, p)
            }
            backup::Action::TransitionCutoverAbandon { cutover_id } => {
                id(&cutover_id)?;
                let cid = cutover_id.clone();
                let (ctx, p) =
                    self.cutover_owned(move |c, ctx| Ok((ctx.clone(), cut::load(c, &ctx, &cid)?)))?;
                let raw = if p.intent.contains("\"reconciliation\":") {
                    self.resolution_transport(&ctx,&cutover_id,&p,true)?
                }else{self.transition_rpc(
                    &ctx,
                    "native_web_cutover_abandon_v1",
                    json!({"p_intent":p.intent,"p_hash":p.hash}),
                )?};
                let receipt: Value =
                    serde_json::from_str(&raw).map_err(|_| error("CUTOVER_RECEIPT_INVALID"))?;
                self.cutover_owned(move |c, current| {
                    if current != ctx {
                        return Err(cut::context_changed());
                    }
                    cut::accept(c, &current, &cutover_id, &receipt)?;
                    cut::view(c, &current)
                })
            }
            backup::Action::TransitionView {} => {
                self.transition_owned(|c, ctx| core::view(c, &ctx))
            }
            backup::Action::TransitionCapture { capture_id } => {
                id(&capture_id)?;
                let cid = capture_id.clone();
                let (ctx, old) = self.transition_owned(move |c, ctx| {
                    Ok((ctx.clone(), core::capture_status(c, &ctx, &cid)?))
                })?;
                if let Some(old) = old {
                    return Ok(old);
                }
                let raw = self.transition_rpc(&ctx,"native_web_capture_v1",json!({"p_negocio_id":ctx.tenant_id,"p_installation_id":ctx.installation_id,"p_device_id":ctx.device_id,"p_writer_epoch":ctx.writer_epoch,"p_scope_kind":ctx.scope_type,"p_sucursal_id":ctx.branch_id,"p_capture_id":capture_id}))?;
                self.transition_owned(move |c, current| {
                    if current != ctx {
                        return Err(core::context_changed());
                    }
                    core::store_capture(c, &current, &capture_id, &raw)
                })
            }
            backup::Action::TransitionPrepare {
                run_id,
                export_ids,
                capture_id,
            } => {
                id(&run_id)?;
                for source in &export_ids {
                    id(source)?;
                }
                if let Some(ref source) = capture_id {
                    id(source)?;
                }
                let at = time()?.to_string();
                self.transition_owned(move |c, ctx| {
                    core::prepare(c, &ctx, &run_id, &export_ids, capture_id.as_deref(), &at)
                })
            }
            backup::Action::TransitionRows {
                run_id,
                table,
                page,
            } => {
                id(&run_id)?;
                self.transition_owned(move |c, ctx| core::rows(c, &ctx, &run_id, &table, page))
            }
            backup::Action::TransitionResolve {
                run_id,
                table,
                row_id,
                variant_id,
                revision,
                reason,
            } => {
                id(&run_id)?;
                self.transition_owned(move |c, ctx| {
                    core::resolve(
                        c,
                        &ctx,
                        &run_id,
                        core::Decision {
                            table: &table,
                            row_id: &row_id,
                            variant_id: &variant_id,
                            revision,
                            reason: &reason,
                        },
                    )
                })
            }
            backup::Action::TransitionResolveDocument {
                run_id,
                sale_id,
                source_id,
                revision,
                reason,
            } => {
                id(&run_id)?;
                id(&source_id)?;
                self.transition_owned(move |c, ctx| {
                    core::resolve_document(
                        c,
                        &ctx,
                        &run_id,
                        core::DocumentDecision {
                            sale_id: &sale_id,
                            source_id: &source_id,
                            revision,
                            reason: &reason,
                        },
                    )
                })
            }
            backup::Action::TransitionPublish { run_id, revision } => {
                id(&run_id)?;
                self.transition_owned(move |c, ctx| {
                    core::publish_history(c, &ctx, &run_id, revision)
                })
            }
            backup::Action::LegacyHistory { filter } => self.transition_owned(move |c, ctx| {
                core::history(
                    c,
                    &ctx,
                    &filter.search,
                    filter.method.as_deref(),
                    filter.from_ms.as_deref(),
                    filter.to_ms.as_deref(),
                    filter.page,
                )
            }),
            backup::Action::LegacyTicket { sale_id } => {
                self.transition_owned(move |c, ctx| core::ticket(c, &ctx, &sale_id))
            }
            _ => Err(error("TRANSITION_INVALID")),
        }
    }
    fn complete_cutover(
        &self,
        ctx: CatalogueContext,
        id: String,
        p: cut::Pending,
    ) -> Result<Value, AccessError> {
        if p.state == "ABANDONED" {
            return self.cutover_owned(move |c, current| {
                if current != ctx {
                    return Err(cut::context_changed());
                }
                cut::view(c, &current)
            });
        }
        if p.state == "UNKNOWN" {
            let raw = if p.intent.contains("\"reconciliation\":") {
                self.resolution_transport(&ctx,&id,&p,false)?
            }else{self.transition_rpc(
                &ctx,
                "native_web_cutover_v1",
                json!({"p_intent":p.intent,"p_hash":p.hash}),
            )?};
            let receipt: Value =
                serde_json::from_str(&raw).map_err(|_| error("CUTOVER_RECEIPT_INVALID"))?;
            let x = ctx.clone();
            let cid = id.clone();
            let status = self.cutover_owned(move |c, current| {
                if current != x {
                    return Err(cut::context_changed());
                }
                cut::accept(c, &current, &cid, &receipt)?;
                cut::view(c, &current)
            })?;
            if status["state"] == "ABANDONED" {
                return Ok(status);
            }
        }
        self.sales_bootstrap()?;
        self.sales_receive_only()?;
        self.cutover_owned(move |c, current| {
            if current != ctx {
                return Err(cut::context_changed());
            }
            cut::mark_active(c, &current, &id)
        })
    }
    fn resolution_transport(&self,ctx:&CatalogueContext,id:&str,p:&cut::Pending,cancel:bool)->Result<String,AccessError>{
        let parts=cut::resolution_upload_parts(&p.intent).map_err(|e|error(e.code()))?;
        let args=json!({"p_context":ctx,"p_cutover_id":id,"p_hash":p.hash,"p_part_count":parts.len()});
        let rpc=if cancel{"native_web_resolution_abandon_v1"}else{"native_web_resolution_commit_v1"};
        let raw=self.transition_rpc(ctx,rpc,args.clone())?;
        let status:Value=serde_json::from_str(&raw).map_err(|_|error("CUTOVER_RECEIPT_INVALID"))?;
        if status["status"]!="UPLOAD_REQUIRED"{return Ok(raw);}
        if status["cutoverId"]!=id||status["planHash"]!=p.hash{return Err(error("CUTOVER_RECEIPT_INVALID"));}
        for (index,part) in parts.iter().enumerate(){
            let part_hash=cut::resolution_part_hash(part);
            let staged=self.transition_rpc(ctx,"native_web_resolution_stage_v1",json!({"p_context":ctx,"p_cutover_id":id,"p_hash":p.hash,"p_part_count":parts.len(),"p_index":index,"p_part":part,"p_part_hash":part_hash}))?;
            let staged:Value=serde_json::from_str(&staged).map_err(|_|error("CUTOVER_RECEIPT_INVALID"))?;
            if staged["status"]!="STAGED"||staged["cutoverId"]!=id||staged["planHash"]!=p.hash||staged["index"]!=index||staged["partHash"]!=part_hash{return Err(error("CUTOVER_RECEIPT_INVALID"));}
        }
        self.transition_rpc(ctx,rpc,args)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn chunked_commit_constraint_rejection_is_not_a_network_failure() {
        for rpc in ["native_web_cutover_v1", "native_web_resolution_commit_v1"] {
            for code in ["23502", "23503", "23514", "22P02", "22003"] {
                assert!(resolution_schema_failure(rpc, Some(code)));
            }
            assert!(!resolution_schema_failure(rpc, None));
            assert!(!resolution_schema_failure(rpc, Some("42501")));
            assert!(!resolution_schema_failure(rpc, Some("57014")));
        }
        assert!(!resolution_schema_failure("native_web_capture_v1", Some("23514")));
    }
    #[test]
    fn all_transition_actions_require_owner_pin_before_any_read_or_remote_call() {
        let state = AccessState::new(std::env::temp_dir().join("unused-transition-fixture"));
        for action in [
            backup::Action::TransitionView {},
            backup::Action::TransitionResolutionBasis {run_id:TENANTS[0].into(),revision:0},
            backup::Action::TransitionResolutionView {run_id:TENANTS[0].into(),page:0},
            backup::Action::TransitionResolutionPreview {run_id:TENANTS[0].into(),page:0,decisions:vec![]},
            backup::Action::TransitionSelectedReview {input:cut::SelectedReview {run_id:TENANTS[0].into(),revision:0,decisions:vec![],stock_counts:vec![],debt_balances:vec![],reason:"Conciliación sintética".into(),confirmation:"RECONCILE_SELECTED_DOCUMENTS_AND_PRESENT_BALANCES".into()}},
            backup::Action::TransitionDifferences {run_id:TENANTS[0].into(),page:0},
            backup::Action::TransitionBaselineReview { input:cut::BaselineDecision {run_id:TENANTS[0].into(),revision:0,difference_hash:"a".repeat(64),reason:"Revisión sintética de las copias".into(),confirmation:"USE_CLOUD_BASELINE_PRESERVE_HISTORY".into()} },
            backup::Action::TransitionCutoverView {
                run_id: TENANTS[0].into(),
            },
            backup::Action::TransitionCutoverRecover {
                cutover_id: TENANTS[0].into(),
            },
            backup::Action::TransitionCutoverAbandon {
                cutover_id: TENANTS[0].into(),
            },
            backup::Action::TransitionCutover {
                input: cut::Input {
                    cutover_id: TENANTS[0].into(),
                    run_id: TENANTS[0].into(),
                    revision: 0,
                    backup_id: TENANTS[0].into(),
                    confirmation: "WEB_WRITERS_CLOSED_BALANCES_REVIEWED".into(),
                    free_tax: "0.18".into(),
                    service_reservations_confirmed: None,
                    legacy_cash_history_confirmed: None,
                    reconcile_selected: None,
                },
            },
            backup::Action::TransitionCapture {
                capture_id: TENANTS[0].into(),
            },
            backup::Action::TransitionPrepare {
                run_id: TENANTS[0].into(),
                export_ids: vec![],
                capture_id: Some(TENANTS[0].into()),
            },
            backup::Action::TransitionPublish {
                run_id: TENANTS[0].into(),
                revision: 0,
            },
            backup::Action::LegacyTicket {
                sale_id: "legacy-id".into(),
            },
        ] {
            assert_eq!(
                state.backup_action(action).unwrap_err().code,
                "ACCESS_PIN_REQUIRED"
            );
        }
    }
}
