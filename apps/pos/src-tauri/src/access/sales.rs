//! Account Sales: typed IPC, fixed Staging host, network outside the vault/UI
//! mutex. Never mint authority from previews or accept SQL/RPC/URLs from React.
use super::*;
#[path = "product_media.rs"]
mod product_media;
#[path = "team.rs"]
mod team;
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
    TeamRead {},
    TeamExecute { input: ventard_core::storage::team::Input },
    TeamRecover { cancel: bool },
    TeamShare { #[serde(rename="operationId")] operation_id:String },
    CatalogueRead {},
    CatalogueOpen { share: bool },
    HistoryLoadRemote {},
    ProductPhotos {
        #[serde(rename = "productIds")]
        product_ids: Vec<String>,
    },
    PrinterRead {},
    PrinterTest {
        #[serde(rename = "attemptId")]
        attempt_id: String,
    },
    PrinterSave {
        profile: ventard_core::application::printing::transport::Profile,
    },
    FiscalSettingsRead {},
    FiscalSettingsSave {
        request: ventard_core::fiscal::settings::Input,
    },
    FiscalSettingsRecover {
        #[serde(rename = "operationId")]
        operation_id: String,
    },
    FiscalSettingsAbandon {
        #[serde(rename = "operationId")]
        operation_id: String,
    },
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
    CustomerActivity {
        #[serde(rename = "customerId")]
        customer_id: String,
    },
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
        #[serde(default)]
        raster: Option<ventard_core::application::printing::transport::Raster>,
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
        #[serde(default)]
        raster: Option<ventard_core::application::printing::transport::Raster>,
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
        #[serde(default)]
        raster: Option<ventard_core::application::printing::transport::Raster>,
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
fn cashier_allowed(action:&SalesAction)->bool{
 matches!(action,SalesAction::Read|SalesAction::ManagementRead|SalesAction::ProductPhotos{..}|SalesAction::PrinterRead{}|SalesAction::PrintLayoutRead|SalesAction::Print{..}|SalesAction::Quote{..}|SalesAction::Confirm{..}|SalesAction::Result{..}|SalesAction::Abandon{..}|SalesAction::OpenTurn{..}|SalesAction::Bootstrap|SalesAction::Synchronize|SalesAction::Retry{..})
}
type SalesHttpFailure = (u16, u64, Option<&'static str>);
fn recovery_submission(
    current: &CatalogueContext,
    fact: &ventard_core::storage::recovery::Fact,
) -> Result<Option<(CatalogueContext, Value)>, AccessError> {
    let (canonical, hash) = ventard_core::domain::canonical::canonicalize(fact.intent.as_bytes())
        .map_err(|_| error("RECOVERY_INVALID"))?;
    if canonical != fact.intent || hash != fact.hash {
        return Err(error("RECOVERY_INVALID"));
    }
    let v: Value = serde_json::from_str(&fact.intent).map_err(|_| error("RECOVERY_INVALID"))?;
    if v["actorId"] != current.actor_id {
        return Ok(None);
    }
    if v["operationId"] != fact.operation_id
        || v["protocol"] != "ventard.native.v1"
        || v["negocioId"] != current.tenant_id
        || v["scope"] != json!({"type":current.scope_type,"sucursalId":current.branch_id})
    {
        return Err(error("RECOVERY_INVALID"));
    }
    let original = CatalogueContext {
        tenant_id: current.tenant_id.clone(),
        actor_id: current.actor_id.clone(),
        device_id: v["originDeviceId"]
            .as_str()
            .ok_or(error("RECOVERY_INVALID"))?
            .into(),
        installation_id: v["installationId"]
            .as_str()
            .ok_or(error("RECOVERY_INVALID"))?
            .into(),
        writer_epoch: v["writerEpoch"]
            .as_str()
            .ok_or(error("RECOVERY_INVALID"))?
            .into(),
        scope_type: current.scope_type.clone(),
        branch_id: current.branch_id.clone(),
    };
    for value in [
        &original.device_id,
        &original.installation_id,
        &fact.operation_id,
    ] {
        EntityId::parse(value).map_err(|_| error("RECOVERY_INVALID"))?;
    }
    if original.writer_epoch.parse::<u64>().ok().is_none_or(|v| {
        v == 0 || v > 9_007_199_254_740_991 || v.to_string() != original.writer_epoch
    }) {
        return Err(error("RECOVERY_INVALID"));
    }
    let snapshot_hash = fact
        .snapshot
        .as_ref()
        .map(|s| {
            let (canonical, h) = ventard_core::domain::canonical::canonicalize(s.as_bytes())
                .map_err(|_| error("RECOVERY_INVALID"))?;
            if canonical != *s {
                return Err(error("RECOVERY_INVALID"));
            }
            Ok(h)
        })
        .transpose()?;
    Ok(Some((
        original,
        json!({"p_intent":fact.intent,"p_hash":fact.hash,"p_snapshot":fact.snapshot,"p_snapshot_hash":snapshot_hash}),
    )))
}
// A metadata snapshot may expire or be removed while the offline document is
// still valid. Refresh only its server proof; never rewrite the frozen header,
// import a stock/cash baseline, advance a cursor, or create another operation.
fn submit_with_header_proof(
    ctx: &CatalogueContext,
    submission: Value,
    mut rpc: impl FnMut(&'static str, Value) -> Result<Value, SalesHttpFailure>,
) -> Result<Value, SalesHttpFailure> {
    let original = rpc("native_sales_submit_v1", submission.clone());
    if !matches!(
        &original,
        Err((400 | 409 | 422, _, Some("SALES_HEADER_PROOF_REQUIRED")))
    ) {
        return original;
    }
    let document = submission["p_snapshot"]
        .as_str()
        .or_else(|| submission["p_intent"].as_str())
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok());
    let header = document.as_ref().map(|v| {
        if submission["p_snapshot"].is_string() {
            &v["business"]
        } else {
            &v["payload"]["document"]["business"]
        }
    });
    let Some(header) = header.filter(|h| h.is_object()) else {
        return original;
    };
    let mut request = body(ctx);
    let snapshot_id = EntityId::new_random().to_string();
    request["p_snapshot_id"] = json!(snapshot_id);
    let manifest = rpc("native_sales_bootstrap_v1", request)?;
    if manifest["version"] != "ventard.native.operational.1"
        || manifest["namespace"] != "NATIVE1"
        || manifest["snapshotId"] != snapshot_id
        || manifest["context"] != serde_json::to_value(ctx).map_err(|_| (503, 3000, None))?
        || manifest["business"] != *header
    {
        return original;
    }
    rpc("native_sales_submit_v1", submission)
}
// Never forward raw PostgreSQL messages/details (may contain values or secrets).
fn safe_sales_rejection(bytes: &[u8]) -> Option<&'static str> {
    let value: Value = serde_json::from_slice(bytes).ok()?;
    match value["message"].as_str() {
        Some("NATIVE_TEAM_ID_CONFLICT")=>Some("TEAM_ID_CONFLICT"),
        Some("NATIVE_TEAM_VERSION")=>Some("TEAM_VERSION"),
        Some("NATIVE_TEAM_EMAIL_EXISTS")=>Some("TEAM_EMAIL_EXISTS"),
        Some("NATIVE_TEAM_PROTECTED")=>Some("TEAM_PROTECTED"),
        Some("NATIVE_SERVICE_HEADER_INVALID") => Some("SALES_HEADER_PROOF_REQUIRED"),
        Some("FISCAL_SETTINGS_VERSION_CONFLICT") => Some("FISCAL_SETTINGS_VERSION_CONFLICT"),
        Some("FISCAL_SETTINGS_KIND_TRANSITION_REQUIRED") => {
            Some("FISCAL_SETTINGS_KIND_TRANSITION_REQUIRED")
        }
        Some("FISCAL_SETTINGS_ALLOCATED_RANGE_CONFLICT") => {
            Some("FISCAL_SETTINGS_ALLOCATED_RANGE_CONFLICT")
        }
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
    fn public_catalogue_read(&self)->Result<Value,AccessError>{
        self.deny_archive()?;
        let mut cached=self.sales_local(|c,ctx,g,high,opens|{
            if !g.evaluate(time().map_err(|_|AppError::Protocol(ventard_core::application::errors::ProtocolError::MalformedPayload))?,high,opens).map_err(|_|AppError::Protocol(ventard_core::application::errors::ProtocolError::MalformedPayload))?.allows("MANAGE"){return Err(AppError::Auth(ventard_core::application::errors::AuthError::PermissionDenied{required:"MANAGE".into()}))}
            ventard_core::application::public_catalogue::view(c,&ctx)
        })?;
        let n=match self.sales_network(){Ok(n)=>n,Err(e) if e.code=="ACCESS_LOGIN_REQUIRED"=>{cached["remoteError"]=json!(e.code);return Ok(cached)},Err(e)=>return Err(e)};
        cached["webOrigin"]=json!(n.config.web_origin);
        let remote=Self::sales_rpc(&n,"native_catalogue_settings_v1",body(&n.selected.catalogue_context()));
        self.sales_current(&n)?;
        match remote{
            Ok(v)=>cached["remote"]=super::public_catalogue::validate_remote(v,&n.selected.identity.tenant_id)?,
            Err((status,_,_))=>cached["remoteError"]=json!(match status{401=>"ACCESS_LOGIN_REQUIRED",403=>"PERMISSION_DENIED",404=>"PUBLIC_CATALOGUE_MIGRATION_REQUIRED",_=>"NETWORK_UNAVAILABLE"})
        }
        Ok(cached)
    }
    fn sales_network(&self) -> Result<NetworkContext, AccessError> {
        let mut i = self.inner.lock().map_err(|_| error("ACCESS_BUSY"))?;
        let selected = self.catalogue_authorize(&mut i)?;
        let config = self.config(&mut i)?;
        let token = self.online_token(&mut i, &selected)?;
        Ok(NetworkContext {
            writer: Arc::clone(i.writer.as_ref().unwrap()),
            selected,
            config,
            token,
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
                | "native_fiscal_settings_read_v1"
                | "native_fiscal_settings_lookup_v1"
                | "native_fiscal_settings_submit_v1"
                | "native_fiscal_settings_abandon_v1"
                | "native_catalogue_settings_v1"
                | "native_team_read_v1"
                | "native_team_lookup_v1"
                | "native_team_submit_v1"
                | "native_team_cancel_v1"
        ) {
            return Err((403, 0, None));
        }
        let c = Self::client().map_err(|_| (503, 3000, None))?;
        let r = c
            .post(format!("{HOST}/rest/v1/rpc/{function}"))
            .header("apikey", &n.config.publishable_key)
            .header("x-ventard-journal", "stock-merge-1")
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
    pub(super) fn sales_bootstrap(&self) -> Result<Value, AccessError> {
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
        if let Some(meta)=m.get("legacyResolutionHistory").filter(|v|!v.is_null()) {
            let raw=self.transition_rpc(&ctx,"native_web_resolution_history_v1",json!({"p_context":ctx,"p_cutover_id":meta["cutoverId"]}))?;
            let envelope:Value=serde_json::from_str(&raw).map_err(|_|error("RESOLUTION_HISTORY_INVALID"))?;
            if envelope["historyHash"]!=meta["sha256"] {return Err(error("RESOLUTION_HISTORY_INVALID"));}
            self.sales_current(&n)?;let x=ctx.clone();
            n.writer.call(move|c|Ok(ventard_core::storage::legacy_cutover::stage_resolution_history(c,&x,&envelope))).map_err(|e|error(e.code()))?.map_err(|e|error(e.code()))?;
        }
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
    pub(super) fn sales_history_remote(&self) -> Result<Value, AccessError> {
        self.sales_sync()?;
        let n = self.sales_network()?;
        let ctx = n.selected.catalogue_context();
        let mut request = body(&ctx);
        let snapshot_id = EntityId::new_random().to_string();
        request["p_snapshot_id"] = json!(snapshot_id);
        let manifest =
            Self::sales_rpc(&n, "native_sales_bootstrap_v1", request).map_err(sales_http)?;
        if manifest["snapshotId"] != snapshot_id
            || manifest["historyCoverage"] != "NATIVE_LEDGER_THROUGH_WATERMARK"
        {
            return Err(error("HISTORY_MIGRATION_REQUIRED"));
        }
        let descriptors = manifest["pages"]
            .as_array()
            .filter(|p| p.len() <= 300)
            .ok_or(error("SALES_EVIDENCE_INVALID"))?;
        let mut pages = Vec::new();
        let mut total = 0usize;
        for (index, _) in descriptors.iter().enumerate() {
            self.sales_current(&n)?;
            let mut request = body(&ctx);
            request["p_snapshot_id"] = json!(snapshot_id);
            request["p_page_index"] = json!(index);
            let page = Self::sales_rpc(&n, "native_sales_bootstrap_page_v1", request)
                .map_err(sales_http)?;
            if page["snapshotId"] != snapshot_id || page["index"] != index {
                return Err(error("SALES_EVIDENCE_INVALID"));
            }
            let raw = page["payload"]
                .as_str()
                .filter(|s| s.len() <= 1_048_576)
                .ok_or(error("SALES_EVIDENCE_INVALID"))?;
            total = total
                .checked_add(raw.len())
                .filter(|n| *n <= 64 * 1024 * 1024)
                .ok_or(error("SALES_EVIDENCE_INVALID"))?;
            pages.push(raw.to_owned());
        }
        // Catch up effects that already existed at the snapshot before adding
        // missing older facts. Do not rewind live stock, debt or drawer state.
        self.sales_sync()?;
        self.sales_current(&n)?;
        self.sales_local(move |c, current, _, _, _| {
            sync::import_history(
                c,
                &current,
                &manifest,
                &pages,
                time().map_err(|_| AppError::Storage("CLOCK".into()))?,
            )
        })
    }
    pub(super) fn recovery_original_pending(
        &self,
        facts: Vec<ventard_core::storage::recovery::Fact>,
    ) -> Result<(), AccessError> {
        let n = self.sales_network()?;
        let current = n.selected.catalogue_context();
        let mut sent = 0;
        for fact in facts {
            let Some((original, submission)) = recovery_submission(&current, &fact)? else {
                continue;
            };
            self.sales_current(&n)?;
            let mut lookup = body(&original);
            lookup["p_operation_id"] = json!(fact.operation_id);
            lookup["p_hash"] = json!(fact.hash);
            let receipt =
                Self::sales_rpc(&n, "native_sales_lookup_v1", lookup).map_err(sales_http)?;
            if receipt["status"] == "NOT_FOUND" {
                submit_with_header_proof(&original, submission, |rpc, args| {
                    Self::sales_rpc(&n, rpc, args)
                })
                .map_err(sales_http)?;
            }
            sent += 1;
        }
        if sent == 0 {
            return Err(error("RECOVERY_ORIGINAL_USER_REQUIRED"));
        }
        Ok(())
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
    if r!=json!({"status":"NOT_FOUND","operationId":d.operation_id,"intentHash":d.hash}){return Err((503,3000,None))}submit_with_header_proof(&ctx,json!({"p_intent":d.intent,"p_hash":d.hash,"p_snapshot":d.snapshot,"p_snapshot_hash":d.snapshot_hash}),|rpc,args|{self.sales_current(&n).map_err(|_|(403,0,Some("SALES_REMOTE_DENIED")))?;Self::sales_rpc(&n,rpc,args)})
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
        self.receive_sales_pages(&n, &ctx)?;
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
    fn receive_sales_pages(
        &self,
        n: &NetworkContext,
        ctx: &CatalogueContext,
    ) -> Result<(), AccessError> {
        for _ in 0..25 {
            self.sales_current(n)?;
            let x = ctx.clone();
            let after=n.writer.call(move|c|Ok(c.query_row::<i64,_,_>("SELECT sequence FROM native_sales_cursor_v1 WHERE tenant_id=?1 AND scope_key=?2",(&x.tenant_id,sales::scope_key(&x)?),|r|r.get(0))?)).map_err(|e|error(e.code()))?;
            let mut b = body(ctx);
            b["p_after"] = json!(after.to_string());
            let page = Self::sales_rpc(n, "native_sales_feed_v1", b).map_err(sales_http)?;
            let complete = page["scannedThrough"] == page["watermark"];
            let advanced = page["scannedThrough"].as_str() != Some(&after.to_string());
            self.sales_current(n)?;
            let x = ctx.clone();
            n.writer
                .call(move |c| sync::receive_feed(c, &x, &page))
                .map_err(|e| error(e.code()))?;
            if complete {
                return Ok(());
            }
            if !advanced {
                return Err(error("SALES_SYNC_INCOMPLETE"));
            }
        }
        Err(error("SALES_SYNC_INCOMPLETE"))
    }
    pub(super) fn sales_receive_only(&self) -> Result<Value, AccessError> {
        let n = self.sales_network()?;
        let ctx = n.selected.catalogue_context();
        self.receive_sales_pages(&n, &ctx)?;
        self.sales_local(|c, ctx, _, _, _| sync::read(c, &ctx))
    }
    fn sales_action(&self, action: SalesAction) -> Result<Value, AccessError> {
        // The cashier is the original POS-only role. Enforce at IPC as well as
        // navigation; a renderer cannot request reports or administration.
        let allowed=cashier_allowed(&action);
        self.sales_local(move|_,_,g,_,_|{
            if g.payload().role=="cashier"&&!allowed{return Err(AppError::Auth(ventard_core::application::errors::AuthError::PermissionDenied{required:"MANAGE".into()}))}Ok(())
        })?;
        match action {
            SalesAction::ProductPhotos { product_ids } => self.product_photos(product_ids),
            SalesAction::PrinterTest { attempt_id } => {
                let now = time()?;
                let a = attempt_id.clone();
                let (job, ctx) = self.sales_local(move |c, ctx, g, high, opens| {
                    Ok((
                        ventard_core::application::printing::transport::probe(
                            c, &ctx, &g, now, high, opens, &a,
                        )?,
                        ctx,
                    ))
                })?;
                if job.fresh {
                    let inner = self.inner.lock().map_err(|_| error("ACCESS_BUSY"))?;
                    if !inner.unlocked
                        || inner
                            .selected
                            .as_ref()
                            .is_none_or(|s| s.catalogue_context() != ctx)
                    {
                        return Err(error("ACCESS_CONTEXT_CHANGED"));
                    }
                    let receipt = super::printers::send(&job.profile, &job.bytes)?;
                    let writer = Arc::clone(
                        inner
                            .writer
                            .as_ref()
                            .ok_or(error("ACCESS_PREPARATION_REQUIRED"))?,
                    );
                    drop(inner);
                    let hash = job.wire_hash;
                    writer
                        .call(move |c| {
                            ventard_core::application::printing::transport::acknowledge(
                                c,
                                &ctx,
                                &attempt_id,
                                &hash,
                                &receipt,
                            )
                        })
                        .map_err(|e| error(e.code()))?;
                }
                Ok(json!({"status":"UNKNOWN","submitted":job.fresh}))
            }
            SalesAction::TeamRead {} => self.team_read(),
            SalesAction::TeamExecute { input } => self.team_send(Some(input),false),
            SalesAction::TeamRecover { cancel } => self.team_send(None,cancel),
            SalesAction::TeamShare { operation_id } => self.team_share(operation_id),
            SalesAction::CatalogueRead {} => self.public_catalogue_read(),
            SalesAction::CatalogueOpen { share } => {
                let v=self.public_catalogue_read()?;
                let origin=v["webOrigin"].as_str().ok_or(error("CATALOGUE_WEB_REQUIRED"))?;
                if v["remote"]["enabled"]!=true || v["pending"].as_array().is_none_or(|p|!p.is_empty()){return Err(error("CATALOGUE_NOT_CONFIRMED"))}
                let path=v["remote"]["publicPath"].as_str().ok_or(error("CATALOGUE_RESPONSE_INVALID"))?;
                let link=format!("{origin}{path}");
                let mut url=reqwest::Url::parse(if share{"https://wa.me/"}else{&link}).map_err(|_|error("CATALOGUE_RESPONSE_INVALID"))?;
                if share{url.query_pairs_mut().append_pair("text",&format!("Mira nuestro catálogo: {link}"));}
                use std::os::windows::process::CommandExt;
                std::process::Command::new("rundll32.exe").arg("url.dll,FileProtocolHandler").arg(url.as_str()).creation_flags(0x08000000).spawn().map_err(|_|error("CONTACT_OPEN_FAILED"))?;
                Ok(json!({"status":"OPEN_REQUESTED"}))
            },
            SalesAction::FiscalSettingsRead {} => self.fiscal_settings_read(),
            SalesAction::FiscalSettingsSave { request } => {
                self.fiscal_settings_send(Some(request), None, false)
            }
            SalesAction::FiscalSettingsRecover { operation_id } => {
                self.fiscal_settings_send(None, Some(operation_id), false)
            }
            SalesAction::FiscalSettingsAbandon { operation_id } => {
                self.fiscal_settings_send(None, Some(operation_id), true)
            }
            SalesAction::Bootstrap => self.sales_bootstrap(),
            SalesAction::HistoryLoadRemote {} => self.sales_history_remote(),
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
                    SalesAction::PrinterRead {}=>Ok(json!({"profile":ventard_core::application::printing::transport::profile(c,&ctx)?,"canWrite":g.evaluate(now,high,opens).map_err(|_|AppError::Auth(ventard_core::application::errors::AuthError::InvalidSignature))?.allows("MANAGE"),"queues":super::printers::queues(),"probeAttempt":ventard_core::application::printing::transport::last_probe(c,&ctx)?})),
                    SalesAction::PrinterSave {profile}=>{super::printers::validate_queue(&profile).map_err(|_|AppError::Business(ventard_core::application::errors::BusinessError::SaleGuard{code:"PRINT_QUEUE_MISSING".into()}))?;Ok(json!(ventard_core::application::printing::transport::save(c,&g,now,high,opens,profile)?))},
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
                    SalesAction::ProductPhotos{..}|SalesAction::PrinterTest {..}|SalesAction::Print { .. }|SalesAction::PrintCut{..}|SalesAction::PrintRepair{..} => Err(AppError::Protocol(
                        ventard_core::application::errors::ProtocolError::MalformedPayload,
                    )),
                    SalesAction::CustomerActivity{customer_id}=>{
                        let decision=g.evaluate(now,high,opens).map_err(|_|AppError::Auth(ventard_core::application::errors::AuthError::InvalidSignature))?;
                        ventard_core::application::management::customer_activity(c,&ctx,&customer_id,decision.allows("MANAGE"))
                    }
                    SalesAction::ManagementRead => {
                        let mut view = ventard_core::application::management::read(c, &ctx)?;
                        if g.payload().role=="cashier"{view["movements"]=json!([]);view["customers"]=json!([]);view["pending"]=json!([]);}
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
impl AccessState {
    fn fiscal_settings_read(&self) -> Result<Value, AccessError> {
        let _gate = self
            .fiscal_settings_gate
            .lock()
            .map_err(|_| error("ACCESS_BUSY"))?;
        let now = time()?;
        let mut cached = self.sales_local(move |c, _, g, high, opens| {
            let ctx = ventard_core::fiscal::settings::authorize(c, &g, now, high, opens)?;
            let mut v = ventard_core::fiscal::settings::view(c, &ctx)?;
            v["canWrite"] = json!(true);
            Ok(v)
        })?;
        let n = match self.sales_network() {
            Ok(n) => n,
            Err(e) if e.code == "ACCESS_LOGIN_REQUIRED" => {
                cached["remoteError"] = json!(e.code);
                return Ok(cached);
            }
            Err(e) => return Err(e),
        };
        let capture = match Self::sales_rpc(
            &n,
            "native_fiscal_settings_read_v1",
            body(&n.selected.catalogue_context()),
        ) {
            Ok(v) => v,
            Err(e) => {
                cached["remoteError"] = json!(fiscal_settings_http(e).code);
                return Ok(cached);
            }
        };
        self.sales_current(&n)?;
        let ctx = n.selected.catalogue_context();
        n.writer
            .call(move |c| {
                ventard_core::fiscal::settings::cache(c, &ctx, &capture)?;
                let mut v = ventard_core::fiscal::settings::view(c, &ctx)?;
                v["canWrite"] = json!(true);
                Ok(v)
            })
            .map_err(|e| error(e.code()))
    }
    fn fiscal_settings_send(
        &self,
        input: Option<ventard_core::fiscal::settings::Input>,
        operation_id: Option<String>,
        abandon: bool,
    ) -> Result<Value, AccessError> {
        let _gate = self
            .fiscal_settings_gate
            .lock()
            .map_err(|_| error("ACCESS_BUSY"))?;
        let now = time()?;
        let request = self.sales_local(move |c, _, g, high, opens| {
            if let Some(input) = input {
                ventard_core::fiscal::settings::prepare(c, &g, now, high, opens, input)
            } else {
                let ctx = ventard_core::fiscal::settings::authorize(c, &g, now, high, opens)?;
                ventard_core::fiscal::settings::get(
                    c,
                    &ctx,
                    operation_id.as_deref().ok_or(AppError::Protocol(
                        ventard_core::application::errors::ProtocolError::MalformedPayload,
                    ))?,
                )
            }
        })?;
        let n = self.sales_network()?;
        let found = Self::sales_rpc(&n, "native_fiscal_settings_lookup_v1", request.rpc_body())
            .map_err(fiscal_settings_http)?;
        let receipt = if found["status"] == "NOT_FOUND" {
            if found
                != json!({"status":"NOT_FOUND","requestId":request.id(),"payloadHash":request.hash})
            {
                return Err(error("FISCAL_SETTINGS_EVIDENCE_INVALID"));
            }
            self.sales_current(&n)?;
            Self::sales_rpc(
                &n,
                if abandon {
                    "native_fiscal_settings_abandon_v1"
                } else {
                    "native_fiscal_settings_submit_v1"
                },
                request.rpc_body(),
            )
            .map_err(fiscal_settings_http)?
        } else {
            found
        };
        self.sales_current(&n)?;
        let ctx = n.selected.catalogue_context();
        n.writer
            .call(move |c| {
                ventard_core::fiscal::settings::accept(c, &ctx, &request, &receipt)?;
                let mut v = ventard_core::fiscal::settings::view(c, &ctx)?;
                v["canWrite"] = json!(true);
                Ok(v)
            })
            .map_err(|e| error(e.code()))
    }
}
fn fiscal_settings_http(e: SalesHttpFailure) -> AccessError {
    error(match e {
        (_, _, Some("FISCAL_SETTINGS_KIND_TRANSITION_REQUIRED")) => {
            "FISCAL_SETTINGS_KIND_TRANSITION_REQUIRED"
        }
        (_, _, Some("FISCAL_SETTINGS_ALLOCATED_RANGE_CONFLICT")) => {
            "FISCAL_SETTINGS_ALLOCATED_RANGE_CONFLICT"
        }
        (_, _, Some("FISCAL_SETTINGS_VERSION_CONFLICT")) => "FISCAL_SETTINGS_VERSION_CONFLICT",
        (404, _, _) => "FISCAL_SETTINGS_MIGRATION_REQUIRED",
        (401, _, _) => "ACCESS_LOGIN_REQUIRED",
        (403, _, _) => "FISCAL_REMOTE_DENIED",
        (429, _, _) => "ACCESS_RATE_LIMITED",
        (400 | 409 | 422, _, _) => "FISCAL_REMOTE_CONFLICT",
        _ => "FISCAL_REMOTE_UNAVAILABLE",
    })
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
        let allowed=cashier_allowed(&command);
        s.sales_local(move|_,_,g,_,_|{if g.payload().role=="cashier"&&!allowed{return Err(AppError::Auth(ventard_core::application::errors::AuthError::PermissionDenied{required:"MANAGE".into()}))}Ok(())})?;
        let cut = matches!(
            &command,
            SalesAction::PrintCut { .. } | SalesAction::PrintRepair { .. }
        );
        if let SalesAction::Print {
            operation_id,
            snapshot_hash,
            attempt_id,
            raster,
        }
        | SalesAction::PrintCut {
            operation_id,
            snapshot_hash,
            attempt_id,
            raster,
        }
        | SalesAction::PrintRepair {
            operation_id,
            snapshot_hash,
            attempt_id,
            raster,
        } = command
        {
            let op = operation_id.clone();
            let id = attempt_id.clone();
            let now = time()?;
            let (job, prepared_ctx) = s.sales_local(move |c, ctx, g, high, opens| {
                let capability = if cut { "MANAGE" } else { "SELL" };
                if !g
                    .evaluate(now, high, opens)
                    .map_err(|_| {
                        AppError::Auth(
                            ventard_core::application::errors::AuthError::InvalidSignature,
                        )
                    })?
                    .allows(capability)
                {
                    return Err(AppError::Auth(
                        ventard_core::application::errors::AuthError::PermissionDenied {
                            required: capability.into(),
                        },
                    ));
                }
                let job = ventard_core::application::printing::transport::prepare(
                    c,
                    &ctx,
                    &op,
                    &snapshot_hash,
                    &id,
                    cut,
                    raster,
                )?;
                Ok((job, ctx))
            })?;
            if job.fresh {
                // Hold selection across the OS boundary: a lock/archive/actor switch
                // cannot turn this into a send authorized by another context.
                let inner = s.inner.lock().map_err(|_| error("ACCESS_BUSY"))?;
                if !inner.unlocked
                    || inner
                        .selected
                        .as_ref()
                        .is_none_or(|selected| selected.catalogue_context() != prepared_ctx)
                {
                    return Err(error("ACCESS_CONTEXT_CHANGED"));
                }
                let result = if job.profile.mode == "DIALOG" {
                    window
                        .print()
                        .map(|_| json!({"transport":"WINDOWS_DIALOG","paper":"UNKNOWN"}))
                        .map_err(|_| error("PRINT_FAILED"))
                } else {
                    super::printers::send(&job.profile, &job.bytes)
                };
                let writer = Arc::clone(
                    inner
                        .writer
                        .as_ref()
                        .ok_or(error("ACCESS_PREPARATION_REQUIRED"))?,
                );
                drop(inner);
                match result {
                    Ok(receipt) => {
                        let ctx = prepared_ctx.clone();
                        let attempt = attempt_id.clone();
                        let hash = job.wire_hash;
                        writer
                            .call(move |c| {
                                ventard_core::application::printing::transport::acknowledge(
                                    c, &ctx, &attempt, &hash, &receipt,
                                )
                            })
                            .map_err(|e| error(e.code()))?;
                    }
                    Err(e) => {
                        // A direct partial send can have produced paper. UNKNOWN
                        // survives every transport error; never fall back/retry it.
                        if job.profile.mode == "DIALOG" {
                            let ctx = prepared_ctx.clone();
                            let op = operation_id.clone();
                            let attempt = attempt_id.clone();
                            writer
                                .call(move |c| {
                                    if cut {
                                        ventard_core::application::printing::failed_cut(
                                            c, &ctx, &op, &attempt,
                                        )
                                    } else {
                                        ventard_core::application::printing::failed(
                                            c, &ctx, &op, &attempt,
                                        )
                                    }
                                })
                                .map_err(|e| error(e.code()))?;
                        }
                        return Err(e);
                    }
                }
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
            Ok(json!({"status":status,"submitted":job.fresh}))
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
    fn cashier_ipc_is_pos_only_even_when_renderer_requests_other_pages(){
        for action in [SalesAction::Read,SalesAction::PrintLayoutRead,SalesAction::Synchronize]{assert!(cashier_allowed(&action))}
        for action in [SalesAction::TeamRead{},SalesAction::CatalogueRead{},SalesAction::HistoryLoadRemote{},SalesAction::SettingsRead,SalesAction::RepairsRead,SalesAction::WarrantiesRead,SalesAction::Report{from_ms:"0".into(),to_ms:"1".into()}]{assert!(!cashier_allowed(&action))}
    }
    #[test]
    fn recovered_native_pending_keeps_origin_bytes_and_refuses_another_actor() {
        let id = |n: u32| format!("96400000-0000-4000-8000-{n:012}");
        let current = CatalogueContext {
            tenant_id: id(1),
            actor_id: id(2),
            device_id: id(40),
            installation_id: id(30),
            writer_epoch: "1".into(),
            scope_type: "GLOBAL".into(),
            branch_id: None,
        };
        let v = json!({"protocol":"ventard.native.v1","kind":"TURN_OPEN","operationId":id(5),"negocioId":id(1),"actorId":id(2),"originDeviceId":id(4),"installationId":id(3),"writerEpoch":"1","scope":{"type":"GLOBAL","sucursalId":null},"payload":{"openingCents":"2000"}});
        let (intent, hash) =
            ventard_core::domain::canonical::canonicalize(&serde_json::to_vec(&v).unwrap())
                .unwrap();
        let fact = ventard_core::storage::recovery::Fact {
            operation_id: id(5),
            intent: intent.clone(),
            hash: hash.clone(),
            snapshot: None,
            pending: true,
        };
        let (origin, submission) = recovery_submission(&current, &fact).unwrap().unwrap();
        assert_eq!(origin.installation_id, id(3));
        assert_eq!(origin.device_id, id(4));
        assert_eq!(origin.actor_id, current.actor_id);
        assert_eq!(submission["p_intent"], intent);
        assert_eq!(submission["p_hash"], hash);
        assert_eq!(submission["p_snapshot"], Value::Null);
        let mut other = current.clone();
        other.actor_id = id(9);
        assert!(recovery_submission(&other, &fact).unwrap().is_none());
        let mut altered = fact.clone();
        altered.hash = "0".repeat(64);
        assert!(recovery_submission(&current, &altered).is_err());
        altered = fact.clone();
        altered.operation_id = id(8);
        assert!(recovery_submission(&current, &altered).is_err());
    }

    fn header_context() -> CatalogueContext {
        CatalogueContext {
            tenant_id: "96000000-0000-4000-8000-000000000001".into(),
            actor_id: "96000000-0000-4000-8000-000000000011".into(),
            installation_id: "96000000-0000-4000-8000-000000000012".into(),
            device_id: "96000000-0000-4000-8000-000000000013".into(),
            writer_epoch: "1".into(),
            scope_type: "GLOBAL".into(),
            branch_id: None,
        }
    }
    #[test]
    fn header_proof_refresh_retries_the_identical_frozen_submission_only_once() {
        assert_eq!(
            safe_sales_rejection(
                br#"{"message":"NATIVE_SERVICE_HEADER_INVALID","details":"private"}"#
            ),
            Some("SALES_HEADER_PROOF_REQUIRED")
        );
        let ctx = header_context();
        let header = json!({"name":"QA","phone":null});
        let submission = json!({"p_intent":json!({"payload":{"document":{"business":header}}}).to_string(),"p_hash":"original-hash","p_snapshot":null,"p_snapshot_hash":null});
        let mut calls = Vec::new();
        let result=submit_with_header_proof(&ctx,submission.clone(),|rpc,args|{calls.push(rpc);if rpc=="native_sales_submit_v1" {assert_eq!(args,submission);if calls.len()==1 {Err((400,0,Some("SALES_HEADER_PROOF_REQUIRED")))}else{Ok(json!({"status":"APPLIED"}))}}else{assert_eq!(args["p_installation_id"],ctx.installation_id);Ok(json!({"version":"ventard.native.operational.1","namespace":"NATIVE1","context":ctx,"snapshotId":args["p_snapshot_id"],"business":header}))}}).unwrap();
        assert_eq!(result["status"], "APPLIED");
        assert_eq!(
            calls,
            vec![
                "native_sales_submit_v1",
                "native_sales_bootstrap_v1",
                "native_sales_submit_v1"
            ]
        );
    }
    #[test]
    fn header_proof_refresh_cannot_replace_a_header_or_accept_a_foreign_snapshot() {
        for foreign in [false, true] {
            let ctx = header_context();
            let header = json!({"name":"QA"});
            let submission = json!({"p_intent":json!({"payload":{"document":{"business":header}}}).to_string(),"p_snapshot":null});
            let mut submits = 0;
            let result = submit_with_header_proof(&ctx, submission, |rpc, args| {
                if rpc == "native_sales_submit_v1" {
                    submits += 1;
                    Err((400, 0, Some("SALES_HEADER_PROOF_REQUIRED")))
                } else {
                    let mut m = json!({"version":"ventard.native.operational.1","namespace":"NATIVE1","context":ctx,"snapshotId":args["p_snapshot_id"],"business":header});
                    if foreign {
                        m["context"]["actorId"] = json!("another-actor")
                    } else {
                        m["business"]["name"] = json!("changed-header")
                    }
                    Ok(m)
                }
            });
            assert_eq!(result.unwrap_err().2, Some("SALES_HEADER_PROOF_REQUIRED"));
            assert_eq!(submits, 1);
        }
    }
    #[test]
    fn header_proof_refresh_is_bounded_and_does_not_retry_other_rejections() {
        for reason in [None, Some("SALES_HEADER_PROOF_REQUIRED")] {
            let ctx = header_context();
            let submission = json!({"p_intent":json!({"payload":{"document":{"business":{"name":"QA"}}}}).to_string(),"p_snapshot":null});
            let mut calls = 0;
            let result = submit_with_header_proof(&ctx, submission, |rpc, args| {
                calls += 1;
                if rpc == "native_sales_bootstrap_v1" {
                    Ok(
                        json!({"version":"ventard.native.operational.1","namespace":"NATIVE1","context":ctx,"snapshotId":args["p_snapshot_id"],"business":{"name":"QA"}}),
                    )
                } else {
                    Err((400, 0, reason))
                }
            });
            assert!(result.is_err());
            assert_eq!(calls, if reason.is_some() { 3 } else { 1 });
        }
    }

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
