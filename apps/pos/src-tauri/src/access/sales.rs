//! Account Sales: typed IPC, fixed Staging host, network outside the vault/UI
//! mutex. Never mint authority from previews or accept SQL/RPC/URLs from React.
use super::*;
use ventard_core::application::{
    checkout,
    sales::{self, SaleLine, SaleOptions, SaleRequest},
    sales_sync as sync,
};
#[derive(Deserialize)]
#[serde(
    tag = "action",
    rename_all = "SCREAMING_SNAKE_CASE",
    deny_unknown_fields
)]
pub enum SalesAction {
    ImportList {},
    ImportPrepare {
        batch: ventard_core::application::inventory_import::Batch,
    },
    ImportRun {
        #[serde(rename = "operationId")]
        operation_id: String,
    },
    ImportStop {
        #[serde(rename = "operationId")]
        operation_id: String,
    },
    Read,
    ManagementRead,
    RepairsRead,
    LayawaysRead,
    WarrantiesRead,
    PrintLayoutRead,
    SettingsRead,
    SettingsLoadRemote,
    ContactNotice {
        family: String,
        id: String,
    },
    PrintLayoutSave {
        layout: ventard_core::application::printing::Layout,
    },
    WarrantyTicket {
        #[serde(rename = "operationId")]
        operation_id: String,
    },
    LayawayTicket {
        #[serde(rename = "operationId")]
        operation_id: String,
    },
    RepairPrivateRead {
        #[serde(rename = "repairId")]
        repair_id: String,
    },
    RepairTicket {
        #[serde(rename = "operationId")]
        operation_id: String,
    },
    PrintRepair {
        #[serde(rename = "operationId")]
        operation_id: String,
        #[serde(rename = "snapshotHash")]
        snapshot_hash: String,
        #[serde(rename = "attemptId")]
        attempt_id: String,
    },
    ReturnRead {
        #[serde(rename = "saleId")]
        sale_id: String,
    },
    ReturnPreview {
        #[serde(rename = "saleId")]
        sale_id: String,
        items: Vec<ventard_core::domain::return_plan::Item>,
        serials: Vec<String>,
    },
    CutTicket {
        #[serde(rename = "operationId")]
        operation_id: String,
    },
    PrintCut {
        #[serde(rename = "operationId")]
        operation_id: String,
        #[serde(rename = "snapshotHash")]
        snapshot_hash: String,
        #[serde(rename = "attemptId")]
        attempt_id: String,
    },
    ManagementAbandon {
        #[serde(rename = "operationId")]
        operation_id: String,
    },
    InventoryHistory {
        #[serde(rename = "productId")]
        product_id: String,
        page: u32,
    },
    ManagementExecute {
        request: ventard_core::application::management::Command,
        #[serde(default)]
        private: Option<ventard_core::application::repair_private::Change>,
    },
    Report {
        #[serde(rename = "fromMs")]
        from_ms: String,
        #[serde(rename = "toMs")]
        to_ms: String,
    },
    ReportExport {
        kind: ventard_core::application::report_exports::Kind,
        #[serde(rename = "fromMs")]
        from_ms: String,
        #[serde(rename = "toMs")]
        to_ms: String,
    },
    Print {
        #[serde(rename = "operationId")]
        operation_id: String,
        #[serde(rename = "snapshotHash")]
        snapshot_hash: String,
        #[serde(rename = "attemptId")]
        attempt_id: String,
    },
    Quote {
        lines: Vec<SaleLine>,
        options: SaleOptions,
    },
    Confirm {
        sale: SaleRequest,
    },
    Result {
        #[serde(rename = "operationId")]
        operation_id: String,
    },
    Abandon {
        #[serde(rename = "operationId")]
        operation_id: String,
    },
    OpenTurn {
        #[serde(rename = "operationId")]
        operation_id: String,
        #[serde(rename = "openingCents")]
        opening_cents: String,
        #[serde(default)]
        denominations: Option<Vec<ventard_core::application::management::Denomination>>,
    },
    Bootstrap,
    Synchronize,
    Retry {
        #[serde(rename = "operationId")]
        operation_id: String,
    },
    Activate {
        confirmation: String,
        #[serde(rename = "freeTax")]
        free_tax: String,
    },
}
struct NetworkContext {
    writer: Arc<WriterActor>,
    selected: Selection,
    config: Config,
    token: Zeroizing<String>,
}
type SalesHttpFailure = (u16, u64, Option<&'static str>);
// Never forward raw PostgreSQL messages/details (may contain values or secrets).
fn safe_sales_rejection(bytes: &[u8]) -> Option<&'static str> {
    let value: Value = serde_json::from_slice(bytes).ok()?;
    match value["message"].as_str() {
        Some("NATIVE_PAYMENT_INVALID" | "NATIVE_TURN_CONTEXT_INVALID" | "NATIVE_TURN_REQUIRED") => {
            Some("SALES_PAYMENT_CONTEXT_INVALID")
        }
        Some("NATIVE_ACTIVATION_REQUIRED" | "NATIVE_SETUP_REQUIRED") => {
            Some("SALES_SETUP_REQUIRED")
        }
        Some("NATIVE_ACTIVE_SCOPE_CONFLICT") => Some("SALES_SCOPE_CONFLICT"),
        Some(
            "NATIVE_CONTEXT_DENIED"
            | "NATIVE_BRANCH_DENIED"
            | "NATIVE_LICENSE_DENIED"
            | "NATIVE_SNAPSHOT_CONTEXT_DENIED",
        ) => Some("SALES_REMOTE_DENIED"),
        Some(
            "NATIVE_CREDIT_SOURCE_UNVERIFIABLE"
            | "NATIVE_PRODUCT_SOURCE_UNVERIFIABLE"
            | "NATIVE_RECIPE_SOURCE_UNVERIFIABLE"
            | "NATIVE_PRICE_TIER_UNVERIFIABLE"
            | "NATIVE_SERIAL_SOURCE_UNVERIFIABLE",
        ) => Some("SALES_SOURCE_UNVERIFIABLE"),
        Some("AUTHORITY_PROJECTION_DIVERGED") => Some("AUTHORITY_PROJECTION_DIVERGED"),
        _ => match value["code"].as_str() {
            Some("42702" | "42703" | "42883" | "42P01") => Some("SALES_SCHEMA_INCOMPATIBLE"),
            _ => None,
        },
    }
}
fn body(ctx: &CatalogueContext) -> Value {
    json!({"p_negocio_id":ctx.tenant_id,"p_installation_id":ctx.installation_id,"p_device_id":ctx.device_id,"p_writer_epoch":ctx.writer_epoch,"p_scope_kind":ctx.scope_type,"p_sucursal_id":ctx.branch_id})
}
impl AccessState {
    fn sales_local<R: Send + 'static>(
        &self,
        f: impl FnOnce(
                &mut ventard_core::storage::writer::CoreConnection,
                CatalogueContext,
                ventard_core::security::offline_grant::VerifiedGrant,
                u64,
                u64,
            ) -> Result<R, AppError>
            + Send
            + 'static,
    ) -> Result<R, AccessError> {
        let mut inner = self.inner.lock().map_err(|_| error("ACCESS_BUSY"))?;
        let selected = self.catalogue_authorize(&mut inner)?;
        let ctx = selected.catalogue_context();
        let grant_ctx = selected.identity.context(&selected.actor_id)?;
        let trust = self.config(&mut inner)?.trust()?;
        inner.writer.as_ref().unwrap().call(move|c|{
   let grant=load_grant(c,&trust,&grant_ctx).map_err(|_|AppError::Auth(ventard_core::application::errors::AuthError::InvalidSignature))?;
   let(high,opens):(u64,u64)=c.query_row("SELECT highwater_ms,openings FROM local_access_runtime_v1 WHERE tenant_id=?1 AND installation_id=?2 AND device_id=?3 AND writer_epoch=?4",(&ctx.tenant_id,&ctx.installation_id,&ctx.device_id,&ctx.writer_epoch),|r|Ok((r.get(0)?,r.get(1)?)))?;
   f(c,ctx,grant,high,opens)
  }).map_err(|e|error(e.code()))
    }
    fn sales_network(&self) -> Result<NetworkContext, AccessError> {
        let mut i = self.inner.lock().map_err(|_| error("ACCESS_BUSY"))?;
        let selected = self.catalogue_authorize(&mut i)?;
        let config = self.config(&mut i)?;
        let session = i
            .session
            .as_ref()
            .filter(|s| s.actor == selected.actor_id && s.expires_at > time().unwrap_or(u64::MAX))
            .ok_or(error("ACCESS_LOGIN_REQUIRED"))?;
        Ok(NetworkContext {
            writer: Arc::clone(i.writer.as_ref().unwrap()),
            selected,
            config,
            token: Zeroizing::new(session.token.to_string()),
        })
    }
    fn sales_current(&self, n: &NetworkContext) -> Result<(), AccessError> {
        let i = self.inner.lock().map_err(|_| error("ACCESS_BUSY"))?;
        if !i.unlocked
            || i.selected
                .as_ref()
                .is_none_or(|s| s.catalogue_context() != n.selected.catalogue_context())
            || i.writer.as_ref().is_none_or(|w| !Arc::ptr_eq(w, &n.writer))
        {
            return Err(error("ACCESS_CONTEXT_CHANGED"));
        }
        Ok(())
    }
    fn sales_rpc(
        n: &NetworkContext,
        function: &str,
        body: Value,
    ) -> Result<Value, SalesHttpFailure> {
        // whitelist internal endpoints as a second boundary; not a renderer argument.
        if !matches!(
            function,
            "native_sales_activate_v1"
                | "native_sales_bootstrap_v1"
                | "native_sales_bootstrap_page_v1"
                | "native_sales_submit_v1"
                | "native_sales_lookup_v1"
                | "native_sales_feed_v1"
                | "native_repairs_private_submit_v1"
                | "native_repairs_private_read_v1"
        ) {
            return Err((403, 0, None));
        }
        let c = Self::client().map_err(|_| (503, 3000, None))?;
        let r = c
            .post(format!("{HOST}/rest/v1/rpc/{function}"))
            .header("apikey", &n.config.publishable_key)
            .bearer_auth(&*n.token)
            .json(&body)
            .send()
            .map_err(|_| (503, 3000, None))?;
        let status = r.status().as_u16();
        let delay = r
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(3)
            .saturating_mul(1000)
            .min(86_400_000);
        if !(200..300).contains(&status) {
            let mut bytes = Vec::new();
            let reason = if matches!(status, 400 | 403 | 409 | 422)
                && r.take(16_385).read_to_end(&mut bytes).is_ok()
                && bytes.len() <= 16_384
            {
                safe_sales_rejection(&bytes)
            } else {
                None
            };
            return Err((status, delay, reason));
        }
        let mut b = Vec::new();
        r.take(2_097_153)
            .read_to_end(&mut b)
            .map_err(|_| (503, 3000, None))?;
        if b.len() > 2_097_152 {
            return Err((503, 3000, None));
        }
        serde_json::from_slice(&b).map_err(|_| (503, 3000, None))
    }
    fn sales_bootstrap(&self) -> Result<Value, AccessError> {
        let n = self.sales_network()?;
        let ctx = n.selected.catalogue_context();
        let x = ctx.clone();
        if n.writer
            .call(move |c| sync::operational(c, &x))
            .map_err(|e| error(e.code()))?
        {
            return self.sales_local(|c, ctx, _, _, _| sync::read(c, &ctx));
        }
        let x = ctx.clone();
        let pending = n
            .writer
            .call(move |c| sync::bootstrap_manifest(c, &x))
            .map_err(|e| error(e.code()))?;
        let m = if let Some(m) = pending.filter(|m| {
            m["expiresAtMs"]
                .as_str()
                .and_then(|s| s.parse::<u64>().ok())
                .is_some_and(|expiry| expiry > time().unwrap_or(u64::MAX))
        }) {
            m
        } else {
            let mut b = body(&ctx);
            b["p_snapshot_id"] = json!(EntityId::new_random().to_string());
            let m = Self::sales_rpc(&n, "native_sales_bootstrap_v1", b).map_err(sales_http)?;
            self.sales_current(&n)?;
            let x = ctx.clone();
            let y = m.clone();
            n.writer
                .call(move |c| {
                    sync::begin_bootstrap(
                        c,
                        &x,
                        &y,
                        time().map_err(|_| AppError::Storage("CLOCK".into()))?,
                    )
                })
                .map_err(|e| error(e.code()))?;
            m
        };
        let x = ctx.clone();
        let missing = n
            .writer
            .call(move |c| sync::missing_bootstrap_pages(c, &x))
            .map_err(|e| error(e.code()))?;
        for index in missing {
            let mut b = body(&ctx);
            b["p_snapshot_id"] = m["snapshotId"].clone();
            b["p_page_index"] = json!(index);
            let page =
                Self::sales_rpc(&n, "native_sales_bootstrap_page_v1", b).map_err(sales_http)?;
            if page["snapshotId"] != m["snapshotId"] || page["index"] != index {
                return Err(error("SALES_EVIDENCE_INVALID"));
            }
            let payload = page["payload"]
                .as_str()
                .ok_or(error("SALES_EVIDENCE_INVALID"))?
                .to_owned();
            self.sales_current(&n)?;
            let x = ctx.clone();
            n.writer
                .call(move |c| {
                    sync::stage_bootstrap_page(
                        c,
                        &x,
                        index,
                        &payload,
                        time().map_err(|_| AppError::Storage("CLOCK".into()))?,
                    )
                })
                .map_err(|e| error(e.code()))?;
        }
        self.sales_current(&n)?;
        let x = ctx.clone();
        let vault = n.selected.identity.vault_id.clone();
        n.writer
            .call(move |c| {
                sync::activate_bootstrap(
                    c,
                    &x,
                    time().map_err(|_| AppError::Storage("CLOCK".into()))?,
                    &vault,
                )
            })
            .map_err(|e| error(e.code()))?;
        self.sales_local(|c, ctx, _, _, _| sync::read(c, &ctx))
    }
    fn sales_sync(&self) -> Result<Value, AccessError> {
        let n = self.sales_network()?;
        let ctx = n.selected.catalogue_context();
        for _ in 0..100 {
            self.sales_current(&n)?;
            let x = ctx.clone();
            let dispatch = n
                .writer
                .call(move |c| {
                    sync::claim(
                        c,
                        &x,
                        time().map_err(|_| AppError::Storage("CLOCK".into()))?,
                    )
                })
                .map_err(|e| error(e.code()))?;
            let Some(d) = dispatch else { break };
            let mut lookup = body(&ctx);
            lookup["p_operation_id"] = json!(d.operation_id);
            lookup["p_hash"] = json!(d.hash);
            let response=Self::sales_rpc(&n,"native_sales_lookup_v1",lookup).and_then(|r|if r["status"]=="NOT_FOUND"{
    if r!=json!({"status":"NOT_FOUND","operationId":d.operation_id,"intentHash":d.hash}){return Err((503,3000,None))}Self::sales_rpc(&n,"native_sales_submit_v1",json!({"p_intent":d.intent,"p_hash":d.hash,"p_snapshot":d.snapshot,"p_snapshot_hash":d.snapshot_hash}))
   }else{Ok(r)});
            self.sales_current(&n)?;
            match response {
                Ok(receipt) => {
                    let x = ctx.clone();
                    let event = json!({"receipt":receipt,"intent":d.intent,"snapshot":d.snapshot});
                    let accepted = n.writer.call(move |c| sync::receive_event(c, &x, &event));
                    if accepted.is_err() {
                        n.writer
                            .call(move |c| {
                                sync::record_failure(c, &d, 422, time().unwrap_or(0), 3000)
                            })
                            .map_err(|e| error(e.code()))?;
                    }
                }
                Err((status, delay, reason)) => {
                    n.writer
                        .call(move |c| {
                            sync::record_failure_detail(
                                c,
                                &d,
                                status,
                                time().unwrap_or(0),
                                delay,
                                reason,
                            )
                        })
                        .map_err(|e| error(e.code()))?;
                    if matches!(status, 401 | 429 | 503) {
                        return Err(sales_http((status, delay, reason)));
                    }
                }
            }
        }
        // Receive complete tenant scans; gaps from other scopes are NOT errors.
        for _ in 0..25 {
            self.sales_current(&n)?;
            let x = ctx.clone();
            let after=n.writer.call(move|c|Ok(c.query_row::<i64,_,_>("SELECT sequence FROM native_sales_cursor_v1 WHERE tenant_id=?1 AND scope_key=?2",(&x.tenant_id,sales::scope_key(&x)?),|r|r.get(0))?)).map_err(|e|error(e.code()))?;
            let mut b = body(&ctx);
            b["p_after"] = json!(after.to_string());
            let page = Self::sales_rpc(&n, "native_sales_feed_v1", b).map_err(sales_http)?;
            let complete = page["scannedThrough"] == page["watermark"];
            let advanced = page["scannedThrough"].as_str() != Some(&after.to_string());
            self.sales_current(&n)?;
            let x = ctx.clone();
            n.writer
                .call(move |c| sync::receive_feed(c, &x, &page))
                .map_err(|e| error(e.code()))?;
            if complete || !advanced {
                break;
            }
        }
        let private_allowed = self.sales_local(|_, _, g, high, opens| {
            let now = time().map_err(|_| {
                AppError::Protocol(
                    ventard_core::application::errors::ProtocolError::MalformedPayload,
                )
            })?;
            let decision = g.evaluate(now, high, opens).map_err(|_| {
                AppError::Protocol(
                    ventard_core::application::errors::ProtocolError::MalformedPayload,
                )
            })?;
            Ok(decision.allows("MANAGE") && decision.plan_tier.as_deref() == Some("pro"))
        })?;
        let mut private_pending = false;
        if private_allowed {
            self.sales_current(&n)?;
            let x = ctx.clone();
            let rows = n
                .writer
                .call(move |c| ventard_core::application::repair_private::pending(c, &x))
                .map_err(|e| error(e.code()))?;
            for dispatch in rows {
                let response = Self::sales_rpc(
                    &n,
                    "native_repairs_private_submit_v1",
                    json!({"p_intent":dispatch.intent,"p_hash":dispatch.hash}),
                );
                self.sales_current(&n)?;
                let x = ctx.clone();
                match response {
                    Ok(receipt) => {
                        n.writer
                            .call(move |c| {
                                ventard_core::application::repair_private::acknowledge(
                                    c, &x, &dispatch, &receipt,
                                )
                            })
                            .map_err(|e| error(e.code()))?;
                    }
                    Err((status, _, _)) => {
                        private_pending = true;
                        n.writer
                            .call(move |c| {
                                ventard_core::application::repair_private::failure(
                                    c, &x, &dispatch, status,
                                )
                            })
                            .map_err(|e| error(e.code()))?;
                        break;
                    }
                }
            }
            match Self::sales_rpc(&n, "native_repairs_private_read_v1", body(&ctx)) {
                Ok(bundle) => {
                    self.sales_current(&n)?;
                    let x = ctx.clone();
                    n.writer
                        .call(move |c| {
                            ventard_core::application::repair_private::import(c, &x, &bundle)
                        })
                        .map_err(|e| error(e.code()))?;
                }
                Err(_) => private_pending = true,
            }
        }
        let mut view = self.sales_local(|c, ctx, _, _, _| sync::read(c, &ctx))?;
        view["privateSyncPending"] = json!(private_pending);
        Ok(view)
    }
    fn sales_action(&self, action: SalesAction) -> Result<Value, AccessError> {
        match action {
            SalesAction::Bootstrap => self.sales_bootstrap(),
            SalesAction::Synchronize => self.sales_sync(),
            SalesAction::Activate {
                confirmation,
                free_tax,
            } => {
                if confirmation != "QA_SYNTHETIC_QUIESCED" {
                    return Err(error("SALES_SETUP_REQUIRED"));
                }
                let n = self.sales_network()?;
                let mut b = body(&n.selected.catalogue_context());
                b["p_confirmation"] = json!(confirmation);
                b["p_free_tax"] = json!(free_tax);
                Self::sales_rpc(&n, "native_sales_activate_v1", b).map_err(sales_http)?;
                self.sales_bootstrap()
            }
            a => {
                let now = time()?;
                self.sales_local(move |c, ctx, g, high, opens| match a {
                    SalesAction::ImportList {}=>ventard_core::application::inventory_import::list(c,&g,now,high,opens),
                    SalesAction::ImportPrepare {batch}=>ventard_core::application::inventory_import::prepare(c,&g,now,high,opens,batch),
                    SalesAction::ImportRun {operation_id}=>ventard_core::application::inventory_import::run(c,&g,now,high,opens,&operation_id),
                    SalesAction::ImportStop {operation_id}=>ventard_core::application::inventory_import::stop(c,&g,now,high,opens,&operation_id),
                    SalesAction::Read => {
                        let mut view = sync::read(c, &ctx)?;
                        if !view.is_null() {
                            view["inventoryReadOnly"] = json!(!g
                                .evaluate(now, high, opens)
                                .map_err(|_| AppError::Auth(
                                    ventard_core::application::errors::AuthError::InvalidSignature
                                ))?
                                .allows("MANAGE"));
                        }
                        Ok(view)
                    }
                    SalesAction::Print { .. }|SalesAction::PrintCut{..}|SalesAction::PrintRepair{..} => Err(AppError::Protocol(
                        ventard_core::application::errors::ProtocolError::MalformedPayload,
                    )),
                    SalesAction::ManagementRead => {
                        let mut view = ventard_core::application::management::read(c, &ctx)?;
                        view["canManage"] = json!(g
                            .evaluate(now, high, opens)
                            .map_err(|_| AppError::Auth(
                                ventard_core::application::errors::AuthError::InvalidSignature
                            ))?
                            .allows("MANAGE"));
                        view["planTier"]=json!(g.payload().license.plan_tier);
                        Ok(view)
                    }
                    SalesAction::RepairsRead => {
                        let decision=g.evaluate(now,high,opens).map_err(|_|AppError::Protocol(ventard_core::application::errors::ProtocolError::MalformedPayload))?;
                        if !g.payload().capabilities.iter().any(|c|c=="MANAGE") {return Err(AppError::Auth(ventard_core::application::errors::AuthError::PermissionDenied{required:"MANAGE".into()}));}
                        let mut data=ventard_core::application::repairs::read(c,&ctx)?;
                        data["planTier"]=json!(decision.plan_tier);
                        data["effectiveTimeMs"]=json!(decision.effective_time_ms);
                        data["canWrite"]=json!(decision.allows("MANAGE")&&decision.plan_tier.as_deref()==Some("pro"));
                        Ok(data)
                    }
                    SalesAction::LayawaysRead => {
                        if !g.payload().capabilities.iter().any(|c|c=="MANAGE"){return Err(AppError::Auth(ventard_core::application::errors::AuthError::PermissionDenied{required:"MANAGE".into()}));}
                        let decision=g.evaluate(now,high,opens).map_err(|_|AppError::Protocol(ventard_core::application::errors::ProtocolError::MalformedPayload))?;
                        let mut data=ventard_core::application::layaways::read(c,&ctx)?;
                        data["planTier"]=json!(decision.plan_tier);data["canWrite"]=json!(decision.allows("MANAGE")&&decision.plan_tier.as_deref()==Some("pro"));Ok(data)
                    },
                    SalesAction::WarrantiesRead=>{
                        if !g.payload().capabilities.iter().any(|c|c=="MANAGE"){return Err(AppError::Auth(ventard_core::application::errors::AuthError::PermissionDenied{required:"MANAGE".into()}));}
                        let decision=g.evaluate(now,high,opens).map_err(|_|AppError::Protocol(ventard_core::application::errors::ProtocolError::MalformedPayload))?;
                        let mut data=ventard_core::application::warranties::read(c,&ctx)?;data["effectiveTimeMs"]=json!(decision.effective_time_ms);data["planTier"]=json!(decision.plan_tier);data["canWrite"]=json!(decision.allows("MANAGE")&&decision.plan_tier.as_deref()==Some("pro"));Ok(data)
                    },
                    SalesAction::ContactNotice{family,id}=>{
                        let decision=g.evaluate(now,high,opens).map_err(|_|AppError::Protocol(ventard_core::application::errors::ProtocolError::MalformedPayload))?;
                        if !decision.allows("MANAGE"){return Err(AppError::Auth(ventard_core::application::errors::AuthError::PermissionDenied{required:"MANAGE".into()}));}
                        if matches!(family.as_str(),"REPAIR"|"LAYAWAY")&&decision.plan_tier.as_deref()!=Some("pro"){return Err(AppError::Business(ventard_core::application::errors::BusinessError::SaleGuard{code:"PRO_REQUIRED".into()}));}
                        let(phone,message)=ventard_core::application::notices::notice(c,&ctx,&family,&id)?;
                        let mut url=reqwest::Url::parse(&format!("https://wa.me/{phone}")).map_err(|_|AppError::Protocol(ventard_core::application::errors::ProtocolError::MalformedPayload))?;url.query_pairs_mut().append_pair("text",&message);
                        use std::os::windows::process::CommandExt;
                        std::process::Command::new("rundll32.exe").arg("url.dll,FileProtocolHandler").arg(url.as_str()).creation_flags(0x08000000).spawn().map_err(|_|AppError::Business(ventard_core::application::errors::BusinessError::SaleGuard{code:"CONTACT_OPEN_FAILED".into()}))?;
                        Ok(json!({"status":"DRAFT_REQUESTED"}))
                    },
                    SalesAction::PrintLayoutRead=>{
                        let d=g.evaluate(now,high,opens).map_err(|_|AppError::Protocol(ventard_core::application::errors::ProtocolError::MalformedPayload))?;
                        Ok(json!({"layout":ventard_core::application::printing::layout(c,&ctx)?,"canWrite":d.allows("MANAGE"),"coverage":"LOCAL_INSTALLATION"}))
                    },
                    SalesAction::SettingsRead=>{
                        if !g.payload().capabilities.iter().any(|s|s=="MANAGE"){return Err(AppError::Auth(ventard_core::application::errors::AuthError::PermissionDenied{required:"MANAGE".into()}));}
                        let d=g.evaluate(now,high,opens).map_err(|_|AppError::Protocol(ventard_core::application::errors::ProtocolError::MalformedPayload))?;
                        let mut data=ventard_core::application::settings::read(c,&ctx)?;let supported=ventard_core::application::settings::supported(c,&ctx)?;data["supported"]=json!(supported);data["canWrite"]=json!(d.allows("MANAGE")&&supported);Ok(data)
                    },
                    SalesAction::SettingsLoadRemote=>{
                        let d=g.evaluate(now,high,opens).map_err(|_|AppError::Protocol(ventard_core::application::errors::ProtocolError::MalformedPayload))?;
                        if !d.allows("MANAGE"){return Err(AppError::Auth(ventard_core::application::errors::AuthError::PermissionDenied{required:"MANAGE".into()}));}
                        ventard_core::application::settings::load_remote(c,&ctx)
                    },
                    SalesAction::PrintLayoutSave{layout}=>ventard_core::application::printing::save_layout(c,&g,now,high,opens,layout),
                    SalesAction::WarrantyTicket{operation_id}=>{
                        if !g.payload().capabilities.iter().any(|c|c=="MANAGE"){return Err(AppError::Auth(ventard_core::application::errors::AuthError::PermissionDenied{required:"MANAGE".into()}));}
                        ventard_core::application::printing::warranty_ticket(c,&ctx,&operation_id)
                    },
                    SalesAction::LayawayTicket{operation_id}=>{
                        if !g.payload().capabilities.iter().any(|c|c=="MANAGE"){return Err(AppError::Auth(ventard_core::application::errors::AuthError::PermissionDenied{required:"MANAGE".into()}));}
                        ventard_core::application::printing::layaway_ticket(c,&ctx,&operation_id)
                    },
                    SalesAction::RepairTicket{operation_id}=>{
                        if !g.payload().capabilities.iter().any(|c|c=="MANAGE"){return Err(AppError::Auth(ventard_core::application::errors::AuthError::PermissionDenied{required:"MANAGE".into()}));}
                        ventard_core::application::printing::repair_ticket(c,&ctx,&operation_id)
                    },
                    SalesAction::CutTicket{operation_id}=>{
                        if !g.evaluate(now,high,opens).map_err(|_|AppError::Protocol(ventard_core::application::errors::ProtocolError::MalformedPayload))?.allows("MANAGE"){return Err(AppError::Auth(ventard_core::application::errors::AuthError::PermissionDenied{required:"MANAGE".into()}))}
                        if !g.evaluate(now,high,opens).map_err(|_|AppError::Protocol(ventard_core::application::errors::ProtocolError::MalformedPayload))?.allows("MANAGE"){return Err(AppError::Auth(ventard_core::application::errors::AuthError::PermissionDenied{required:"MANAGE".into()}))}
                        ventard_core::application::printing::cut_ticket(c,&ctx,&operation_id)
                    },
                    SalesAction::ManagementExecute { request,private } => {
                        ventard_core::application::management::execute_private(
                            c, &g, now, high, opens, request,private,
                        )
                    }
                    SalesAction::RepairPrivateRead{repair_id}=>{
                        if !g.payload().capabilities.iter().any(|c|c=="MANAGE"){return Err(AppError::Auth(ventard_core::application::errors::AuthError::PermissionDenied{required:"MANAGE".into()}));}
                        ventard_core::application::repair_private::read(c,&ctx,&repair_id)
                    },
                    SalesAction::ReturnRead{sale_id}=>ventard_core::application::returns::read(c,&ctx,&sale_id),
                    SalesAction::ReturnPreview{sale_id,items,serials}=>ventard_core::application::returns::preview(c,&ctx,&sale_id,&items,&serials),
                    SalesAction::ManagementAbandon { operation_id } => {
                        ventard_core::application::management::abandon(
                            c,
                            &g,
                            now,
                            high,
                            opens,
                            &operation_id,
                        )
                    }
                    SalesAction::InventoryHistory { product_id, page } => {
                        ventard_core::application::inventory::history(c, &ctx, &product_id, page)
                    }
                    SalesAction::Report { from_ms, to_ms } => {
                        if !g
                            .evaluate(now, high, opens)
                            .map_err(|_| {
                                AppError::Auth(
                                    ventard_core::application::errors::AuthError::InvalidSignature,
                                )
                            })?
                            .allows("MANAGE")
                        {
                            return Err(AppError::Auth(
                                ventard_core::application::errors::AuthError::PermissionDenied {
                                    required: "MANAGE".into(),
                                },
                            ));
                        }
                        ventard_core::application::management::report(c, &ctx, &from_ms, &to_ms)
                    }
                    SalesAction::ReportExport{kind,from_ms,to_ms}=>{
                        if !g.evaluate(now,high,opens).map_err(|_|AppError::Auth(ventard_core::application::errors::AuthError::InvalidSignature))?.allows("MANAGE"){return Err(AppError::Auth(ventard_core::application::errors::AuthError::PermissionDenied{required:"MANAGE".into()}))}
                        if matches!(&kind,ventard_core::application::report_exports::Kind::Repairs|ventard_core::application::report_exports::Kind::Layaways)&&g.payload().license.plan_tier.as_deref()!=Some("pro"){return Err(AppError::Business(ventard_core::application::errors::BusinessError::SaleGuard{code:"PRO_REQUIRED".into()}));}
                        ventard_core::application::report_exports::read(c,&ctx,kind,&from_ms,&to_ms)
                    }
                    SalesAction::Quote { lines, options } => serde_json::to_value(sales::quote(
                        c, &ctx, &lines, &options,
                    )?)
                    .map_err(|_| {
                        AppError::Protocol(
                            ventard_core::application::errors::ProtocolError::MalformedPayload,
                        )
                    }),
                    SalesAction::Confirm { sale } => {
                        if !sync::operational(c, &ctx)? {
                            return Err(AppError::Auth(
                                ventard_core::application::errors::AuthError::PermissionDenied {
                                    required: "SELL".into(),
                                },
                            ));
                        }
                        serde_json::to_value(sales::confirm(c, &g, now, high, opens, sale)?)
                            .map_err(|_| AppError::Storage("SERIALIZE".into()))
                    }
                    SalesAction::Result { operation_id } => {
                        Ok(sync::sale_result(c, &ctx, &operation_id)?.unwrap_or(Value::Null))
                    }
                    SalesAction::Abandon { operation_id } => {
                        let hash: String = c.query_row(
                            "SELECT hash FROM operation_journal WHERE operation_id=?1",
                            [&operation_id],
                            |r| r.get(0),
                        )?;
                        checkout::abandon_checkout(c, &g, now, high, opens, &operation_id, &hash)?;
                        Ok(Value::Null)
                    }
                    SalesAction::Retry { operation_id } => {
                        let decision = g.evaluate(now, high, opens).map_err(|_| {
                            AppError::Auth(
                                ventard_core::application::errors::AuthError::InvalidSignature,
                            )
                        })?;
                        if !decision.allows("SELL") {
                            return Err(AppError::Auth(
                                ventard_core::application::errors::AuthError::PermissionDenied {
                                    required: "SELL".into(),
                                },
                            ));
                        }
                        sync::retry_failed(c, &ctx, &operation_id, now)?;
                        sync::read(c, &ctx)
                    }
                    SalesAction::OpenTurn {
                        operation_id,
                        opening_cents,
                        denominations,
                    } => sync::request_shared_turn_with_count(
                        c,
                        &g,
                        now,
                        high,
                        opens,
                        &operation_id,
                        &opening_cents,
                        denominations.as_deref(),
                    ),
                    _ => Err(AppError::Protocol(
                        ventard_core::application::errors::ProtocolError::MalformedPayload,
                    )),
                })
            }
        }
    }
}
fn sales_http((status, _, reason): SalesHttpFailure) -> AccessError {
    if matches!(status, 400 | 403 | 409 | 422) {
        if let Some(reason) = reason {
            return error(reason);
        }
    }
    error(match status {
        401 => "ACCESS_LOGIN_REQUIRED",
        403 => "SALES_REMOTE_DENIED",
        404 => "SALES_MIGRATION_REQUIRED",
        400 | 409 | 422 => "SALES_REMOTE_CONFLICT",
        429 => "ACCESS_RATE_LIMITED",
        _ => "SALES_REMOTE_UNAVAILABLE",
    })
}
#[tauri::command]
pub async fn native_sales(
    window: WebviewWindow,
    state: State<'_, Arc<AccessState>>,
    ipc_version: String,
    request_id: String,
    command: SalesAction,
) -> Result<Value, AccessError> {
    admission(&window, &ipc_version, &request_id)?;
    let s = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let cut = matches!(
            &command,
            SalesAction::PrintCut { .. } | SalesAction::PrintRepair { .. }
        );
        if let SalesAction::Print {
            operation_id,
            snapshot_hash,
            attempt_id,
        }
        | SalesAction::PrintCut {
            operation_id,
            snapshot_hash,
            attempt_id,
        }
        | SalesAction::PrintRepair {
            operation_id,
            snapshot_hash,
            attempt_id,
        } = command
        {
            let op = operation_id.clone();
            let id = attempt_id.clone();
            let now = time()?;
            let fresh = s.sales_local(move |c, ctx, g, high, opens| {
                if cut {
                    if !g
                        .evaluate(now, high, opens)
                        .map_err(|_| {
                            AppError::Protocol(
                                ventard_core::application::errors::ProtocolError::MalformedPayload,
                            )
                        })?
                        .allows("MANAGE")
                    {
                        return Err(AppError::Auth(
                            ventard_core::application::errors::AuthError::PermissionDenied {
                                required: "MANAGE".into(),
                            },
                        ));
                    }
                    ventard_core::application::printing::request_cut(
                        c,
                        &ctx,
                        &op,
                        &snapshot_hash,
                        &id,
                    )
                } else {
                    ventard_core::application::printing::request(c, &ctx, &op, &snapshot_hash, &id)
                }
            })?;
            if fresh && window.print().is_err() {
                s.sales_local(move |c, ctx, _, _, _| {
                    if cut {
                        ventard_core::application::printing::failed_cut(
                            c,
                            &ctx,
                            &operation_id,
                            &attempt_id,
                        )
                    } else {
                        ventard_core::application::printing::failed(
                            c,
                            &ctx,
                            &operation_id,
                            &attempt_id,
                        )
                    }
                })?;
                return Err(error("PRINT_FAILED"));
            }
            let status = s.sales_local(move |c, ctx, _, _, _| {
                if cut {
                    ventard_core::application::printing::cut_status(
                        c,
                        &ctx,
                        &operation_id,
                        &attempt_id,
                    )
                } else {
                    ventard_core::application::printing::status(c, &ctx, &operation_id, &attempt_id)
                }
            })?;
            Ok(json!({"status":status,"submitted":fresh}))
        } else {
            s.sales_action(command)
        }
    })
    .await
    .map_err(|_| error("ACCESS_UNAVAILABLE"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_setup_rejections_are_explicit_without_leaking_details() {
        assert_eq!(
            safe_sales_rejection(br#"{"code":"P0001","message":"NATIVE_ACTIVATION_REQUIRED"}"#),
            Some("SALES_SETUP_REQUIRED")
        );
        assert_eq!(
            safe_sales_rejection(br#"{"code":"42501","message":"NATIVE_CONTEXT_DENIED"}"#),
            Some("SALES_REMOTE_DENIED")
        );
        assert_eq!(
            safe_sales_rejection(
                br#"{"code":"42703","message":"column secret does not exist","details":"token"}"#
            ),
            Some("SALES_SCHEMA_INCOMPATIBLE")
        );
        for body in [
            br#"{"message":"Bearer secret"}"#.as_slice(),
            br#"{"message":"NATIVE_ACTIVATION_REQUIRED token"}"#,
            b"not json",
        ] {
            assert_eq!(safe_sales_rejection(body), None);
        }
    }
}
