//! Explicit adoption of a reviewed cloud baseline. Legacy intentions remain
//! preserved and never enter NATIVE1 outbox or acquire fabricated receipts.
use super::{catalogue_preview::CatalogueContext, legacy_transition as transition};
use crate::domain::canonical::{canonicalize_bounded, CanonError};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
#[path = "legacy_resolution.rs"]
mod resolution;
pub use resolution::*;
#[derive(Debug)]
pub struct Error(&'static str);
impl Error {
    pub fn code(&self) -> &'static str {
        self.0
    }
}
impl From<rusqlite::Error> for Error {
    fn from(_: rusqlite::Error) -> Self {
        Self("CUTOVER_STORAGE")
    }
}
impl From<transition::Error> for Error {
    fn from(e: transition::Error) -> Self {
        Self(e.code())
    }
}
fn invalid() -> Error {
    Error("CUTOVER_INVALID")
}
pub fn context_changed() -> Error {
    Error("CUTOVER_CONTEXT")
}
fn hash(raw: &str) -> String {
    format!("{:x}", Sha256::digest(raw.as_bytes()))
}
fn canonical(v: &Value) -> Result<(String, String), Error> {
    canonical_document(v.to_string().as_bytes())
}
fn canonical_document(bytes: &[u8]) -> Result<(String, String), Error> {
    canonicalize_bounded(bytes, transition::MAX_CAPTURE).map_err(|e| match e {
        CanonError::TooLarge => Error("RESOLUTION_TOO_LARGE"),
        _ => invalid(),
    })
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Input {
    pub cutover_id: String,
    pub run_id: String,
    pub revision: u32,
    pub backup_id: String,
    pub confirmation: String,
    pub free_tax: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service_reservations_confirmed: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub legacy_cash_history_confirmed: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reconcile_selected: Option<bool>,
}
#[derive(Clone, Debug)]
pub struct Pending {
    pub intent: String,
    pub hash: String,
    pub state: String,
}
fn ctx_json(ctx: &CatalogueContext) -> Result<String, Error> {
    serde_json::to_string(ctx).map_err(|_| invalid())
}
pub fn fingerprints(c: &Connection) -> Result<BTreeMap<String, String>, Error> {
    let exists: bool = c.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='legacy_transition_runs_v1')",
        [],
        |r| r.get(0),
    )?;
    if !exists {
        return Ok(BTreeMap::new());
    }
    let mut q=c.prepare("SELECT run_id,context,sources,revision,report FROM legacy_transition_runs_v1 ORDER BY run_id")?;
    let mut out = BTreeMap::new();
    for row in q.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, i64>(3)?,
            r.get::<_, String>(4)?,
        ))
    })? {
        let (id, context, sources, revision, report) = row?;
        let selected = transition::selected(c, &id)?;
        out.insert(
            id,
            hash(&json!([context, sources, revision, report, selected]).to_string()),
        );
    }
    Ok(out)
}
struct Comparison {
    tables: Value,
    rows: Vec<Value>,
    capture_id: String,
    difference_hash: String,
}
fn comparison(c: &Connection, ctx: &CatalogueContext, run: &str) -> Result<Comparison, Error> {
    let report = transition::report(c, ctx, run)?;
    let source = report["sources"]
        .as_array()
        .ok_or_else(invalid)?
        .iter()
        .find(|s| s["kind"] == "CLOUD")
        .ok_or(Error("CUTOVER_CLOUD_REQUIRED"))?;
    let (raw, saved, stored_hash): (String, String, String) = c.query_row(
        "SELECT body,context,body_hash FROM legacy_cloud_captures_v1 WHERE capture_id=?1",
        [source["id"].as_str().ok_or_else(invalid)?],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    if saved != ctx_json(ctx)? || hash(&raw) != stored_hash || source["sha256"] != stored_hash {
        return Err(Error("CUTOVER_SOURCE_CONFLICT"));
    }
    let cloud: Value = serde_json::from_str(&raw).map_err(|_| invalid())?;
    let data = transition::selected(c, run)?;
    let mut out = vec![];
    let mut differences = vec![];
    for name in transition::CLOUD_TABLES {
        let rows = data
            .get(*name)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|r| r["negocio_id"] == ctx.tenant_id)
            .collect::<Vec<_>>();
        let mut current = cloud["tables"]
            .as_array()
            .ok_or_else(invalid)?
            .iter()
            .find(|t| t["name"] == *name)
            .ok_or_else(invalid)?["rows"]
            .as_array()
            .ok_or_else(invalid)?
            .iter()
            .map(|v| transition::normalize(v, 0).map_err(Error::from))
            .collect::<Result<Vec<_>, _>>()?;
        current.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
        let chosen = rows
            .iter()
            .map(|r| (r["id"].as_str().unwrap_or(""), r))
            .collect::<BTreeMap<_, _>>();
        let remote = current
            .iter()
            .map(|r| (r["id"].as_str().unwrap_or(""), r))
            .collect::<BTreeMap<_, _>>();
        for id in chosen
            .keys()
            .chain(remote.keys())
            .copied()
            .collect::<std::collections::BTreeSet<_>>()
        {
            if !match (chosen.get(id), remote.get(id)) {
                (Some(a), Some(b)) => transition::equivalent(a, b),
                (None, None) => true,
                _ => false,
            } {
                differences.push(
                    json!({"table":name,"id":id,"preserved":chosen.get(id),"cloud":remote.get(id)}),
                );
            }
        }
        let blocks = current
            .chunks(100)
            .map(|rows| canonical(&json!(rows)).map(|(_, h)| h))
            .collect::<Result<Vec<_>, _>>()?;
        out.push(json!({"name":name,"count":current.len(),"blocks":blocks}));
    }
    let capture_id = source["id"].as_str().ok_or_else(invalid)?.to_owned();
    let (_, difference_hash) = canonical(&json!([capture_id, stored_hash, differences]))?;
    Ok(Comparison {
        tables: json!(out),
        rows: differences,
        capture_id,
        difference_hash,
    })
}
fn reviewed(
    c: &Connection,
    ctx: &CatalogueContext,
    run: &str,
    diff: &Comparison,
) -> Result<bool, Error> {
    let report = transition::report(c, ctx, run)?;
    let saved = &report["cloudBaselineReview"];
    if saved["differenceHash"] != diff.difference_hash || saved["captureId"] != diff.capture_id {
        return Ok(false);
    }
    Ok(c.query_row("SELECT EXISTS(SELECT 1 FROM legacy_transition_decisions_v1 WHERE run_id=?1 AND revision=?2 AND table_name='CLOUD_BASELINE' AND row_id=?3 AND variant_id=?4 AND actor_id=?5 AND reason=?6)",
        (run,report["revision"].as_u64().ok_or_else(invalid)?,&diff.capture_id,&diff.difference_hash,&ctx.actor_id,saved["reason"].as_str().ok_or_else(invalid)?),|r|r.get(0))?)
}
fn tables(c: &Connection, ctx: &CatalogueContext, run: &str) -> Result<Value, Error> {
    let diff = comparison(c, ctx, run)?;
    if !diff.rows.is_empty() && !reviewed(c, ctx, run, &diff)? {
        return Err(Error("CUTOVER_COPIES_NOT_CONVERGED"));
    }
    Ok(diff.tables)
}
/// Both versions are evidence only. Pagination never alters the source material.
pub fn differences(
    c: &Connection,
    ctx: &CatalogueContext,
    run: &str,
    page: u32,
) -> Result<Value, Error> {
    if page > 60_000 {
        return Err(invalid());
    }
    let report = transition::report(c, ctx, run)?;
    let diff = comparison(c, ctx, run)?;
    let is_reviewed = reviewed(c, ctx, run, &diff)?;
    let mut counts = BTreeMap::<String, usize>::new();
    for row in &diff.rows {
        *counts
            .entry(row["table"].as_str().ok_or_else(invalid)?.into())
            .or_default() += 1;
    }
    Ok(
        json!({"runId":run,"revision":report["revision"],"captureId":diff.capture_id,"differenceHash":diff.difference_hash,"reviewed":is_reviewed,"decision":if is_reviewed {report["cloudBaselineReview"].clone()}else{Value::Null},"total":diff.rows.len(),"counts":counts,"page":page,"rows":diff.rows.iter().skip(page as usize*10).take(10).collect::<Vec<_>>()}),
    )
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BaselineDecision {
    pub run_id: String,
    pub revision: u32,
    pub difference_hash: String,
    pub reason: String,
    pub confirmation: String,
}
/// Local audited decision, not an APPLIED receipt. The server still verifies
/// the entire current cloud snapshot atomically before adopting its balances.
pub fn review_baseline(
    c: &mut Connection,
    ctx: &CatalogueContext,
    d: &BaselineDecision,
) -> Result<Value, Error> {
    let reason = d.reason.trim();
    if d.confirmation != "USE_CLOUD_BASELINE_PRESERVE_HISTORY"
        || reason.chars().count() < 10
        || reason.chars().count() > 500
        || reason.chars().any(char::is_control)
    {
        return Err(invalid());
    }
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let mut report = transition::report(&tx, ctx, &d.run_id)?;
    let diff = comparison(&tx, ctx, &d.run_id)?;
    if diff.difference_hash != d.difference_hash
        || diff.rows.is_empty()
        || report["historyPublished"] != true
        || report["conflicts"] != 0
    {
        return Err(Error("CUTOVER_REVIEW_REQUIRED"));
    }
    let next = d.revision.checked_add(1).ok_or_else(invalid)?;
    if report["revision"] == next
        && reviewed(&tx, ctx, &d.run_id, &diff)?
        && report["cloudBaselineReview"]["reason"] == reason
    {
        return readiness(&tx, ctx, &d.run_id);
    }
    let pending:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM legacy_cutovers_v1 WHERE context=?1 AND state IN('UNKNOWN','ADOPTED','ACTIVE'))",[ctx_json(ctx)?],|r|r.get(0))?;
    if report["revision"] != d.revision || pending {
        return Err(Error("CUTOVER_REVIEW_REQUIRED"));
    }
    report["revision"] = json!(next);
    report["cloudBaselineReview"] = json!({"captureId":diff.capture_id,"differenceHash":diff.difference_hash,"reason":reason,"actorId":ctx.actor_id,"coverage":"CLOUD_BASELINE_PRESERVED_HISTORY","legacyReplay":false});
    tx.execute(
        "INSERT INTO legacy_transition_decisions_v1 VALUES(?1,?2,'CLOUD_BASELINE',?3,?4,?5,?6)",
        (
            &d.run_id,
            next,
            &diff.capture_id,
            &diff.difference_hash,
            &ctx.actor_id,
            reason,
        ),
    )?;
    tx.execute(
        "UPDATE legacy_transition_runs_v1 SET revision=?2,report=?3 WHERE run_id=?1",
        (&d.run_id, next, report.to_string()),
    )?;
    let view = readiness(&tx, ctx, &d.run_id)?;
    tx.commit()?;
    Ok(view)
}
pub fn readiness(c: &Connection, ctx: &CatalogueContext, run: &str) -> Result<Value, Error> {
    let report = transition::report(c, ctx, run)?;
    let mut blockers = vec![];
    if report["historyPublished"] != true || report["conflicts"] != 0 {
        blockers.push(json!({"code":"CUTOVER_REVIEW_REQUIRED"}))
    }
    if let Err(e) = tables(c, ctx, run) {
        blockers.push(json!({"code":e.code()}))
    }
    let diff = comparison(c, ctx, run).ok();
    // An active service must continue the exact adopted document. A baseline
    // acknowledgement cannot silently replace its deposit or reservation.
    if let Some(diff) = &diff {
        for row in &diff.rows {
            if row["table"] == "cajas"
                && !row["cloud"].is_null()
                && row["cloud"]["estado"] != "cerrada"
            {
                blockers.push(json!({"code":"CUTOVER_CLOSE_WEB_CASH","id":row["id"]}));
            }
            if matches!(row["table"].as_str(), Some("reparaciones" | "apartados"))
                && ["preserved", "cloud"].iter().any(|key| {
                    !row[key].is_null()
                        && super::legacy_services::active(
                            row["table"].as_str().unwrap_or(""),
                            &row[key],
                        )
                })
            {
                blockers.push(json!({"code":"CUTOVER_SERVICE_BASELINE_CONFLICT","table":row["table"],"id":row["id"]}));
            }
        }
    }
    // A source turn is closed deliberately before handing its writer over.
    // Its original cash/history remain preserved; no synthetic TURN_OPEN.
    let selected = transition::selected(c, run)?;
    for row in selected.get("cajas").into_iter().flatten() {
        if row["negocio_id"] != ctx.tenant_id {
            continue;
        }
        if row["estado"] != "cerrada" {
            blockers.push(json!({"code":"CUTOVER_CLOSE_WEB_CASH","id":row["id"]}))
        }
    }
    let mut services = vec![];
    for table in ["reparaciones", "apartados"] {
        for row in selected.get(table).into_iter().flatten() {
            if row["negocio_id"] != ctx.tenant_id {
                continue;
            }
            if super::legacy_services::active(table, row) {
                if super::legacy_services::project(table, row).is_err() {
                    blockers.push(json!({"code":"CUTOVER_SERVICE_REQUIRES_RECONCILIATION","table":table,"id":row["id"]}));
                } else {
                    services.push(json!({"table":table,"id":row["id"],"folio":row["folio"]}));
                }
            }
        }
    }
    let mut service_history_warnings = vec![];
    let mut legacy_cash_history_warnings = vec![];
    for issue in report["issues"].as_array().ok_or_else(invalid)? {
        if issue["code"] == "CASH_LINK_UNKNOWN" && issue["table"] == "ventas" {
            // These rows stay UNKNOWN_LEGACY in the published history. The
            // closed cloud baseline, not this missing link, governs new cash.
            legacy_cash_history_warnings.push(issue.clone());
            continue;
        }
        // Current acknowledged aggregates are distinct from unverifiable past
        // payment details. Preserve these warnings; never reconstruct cash.
        let service = services
            .iter()
            .any(|s| s["table"] == issue["table"] && s["id"] == issue["id"]);
        if service
            && matches!(
                issue["code"].as_str(),
                Some(
                    "PAYMENT_HISTORY_MISSING"
                        | "PAYMENT_SUM_MISMATCH"
                        | "PAYMENT_UNKNOWN"
                        | "CASH_REFERENCE_MISSING"
                )
            )
        {
            service_history_warnings.push(issue.clone());
            continue;
        }
        // A shared browser may preserve another explicitly identified business.
        // Keep its raw copy, but never adopt it into the selected tenant.
        let known_foreign = issue["code"] == "TENANT_UNPROVEN"
            && selected
                .get(issue["table"].as_str().unwrap_or(""))
                .into_iter()
                .flatten()
                .any(|row| {
                    row["id"] == issue["id"]
                        && row["negocio_id"]
                            .as_str()
                            .is_some_and(|n| n != ctx.tenant_id && uuid::Uuid::parse_str(n).is_ok())
                });
        if known_foreign {
            continue;
        }
        if !matches!(
            issue["code"].as_str(),
            Some("SCOPE_FROM_LINKED_SALE" | "SCOPE_FROM_SAVED_CHECKOUT")
        ) {
            blockers.push(issue.clone())
        }
    }
    Ok(
        json!({"runId":run,"revision":report["revision"],"canPrepare":blockers.is_empty(),"blockers":blockers,"services":services,"serviceHistoryWarnings":service_history_warnings,"legacyCashHistoryWarnings":legacy_cash_history_warnings,"differences":diff.as_ref().map(|d|d.rows.len()),"baselineReviewed":diff.as_ref().map(|d|reviewed(c,ctx,run,d)).transpose()?.unwrap_or(false),"coverage":"REVIEWED_CLOSED_CLOUD_BASELINE","legacyReplay":false}),
    )
}
pub fn load(c: &Connection, ctx: &CatalogueContext, id: &str) -> Result<Pending, Error> {
    let (saved, intent, hash, state): (String, String, String, String) = c.query_row(
        "SELECT context,intent,intent_hash,state FROM legacy_cutovers_v1 WHERE cutover_id=?1",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    )?;
    if saved != ctx_json(ctx)? {
        return Err(Error("CUTOVER_CONTEXT"));
    }
    if canonical_document(intent.as_bytes())?.1 != hash {
        return Err(Error("CUTOVER_SOURCE_CONFLICT"));
    }
    let receipt: Option<String> = c.query_row(
        "SELECT receipt FROM legacy_cutovers_v1 WHERE cutover_id=?1",
        [id],
        |r| r.get(0),
    )?;
    if state == "UNKNOWN" {
        if receipt.is_some() {
            return Err(Error("CUTOVER_RECEIPT_INVALID"));
        }
    } else {
        let plan: Value = serde_json::from_str(&intent).map_err(|_| invalid())?;
        let receipt: Value =
            serde_json::from_str(&receipt.ok_or(Error("CUTOVER_RECEIPT_INVALID"))?)
                .map_err(|_| invalid())?;
        let mut expected = expected_receipt(ctx, id, &hash, &plan);
        if state == "ABANDONED" {
            expected["status"] = json!("ABANDONED");
            expected["coverage"] = json!("NO_BASELINE_CHANGE");
        }
        if receipt != expected {
            return Err(Error("CUTOVER_RECEIPT_INVALID"));
        }
    }
    Ok(Pending {
        intent,
        hash,
        state,
    })
}
fn expected_receipt(ctx: &CatalogueContext, id: &str, hash: &str, plan: &Value) -> Value {
    json!({"protocol":"ventard.web.cutover.receipt.1","status":"BASELINE_ADOPTED","cutoverId":id,"planHash":hash,"context":ctx,"runId":plan["runId"],"revision":plan["revision"],"backupId":plan["backupId"],"coverage":if plan.get("reconciliation").is_some(){"RECONCILED_SELECTED_BASELINE"}else{"CLOUD_CONVERGED_BASELINE"},"legacyReplay":false})
}
pub fn view(c: &Connection, ctx: &CatalogueContext) -> Result<Value, Error> {
    let id:Option<String>=c.query_row("SELECT cutover_id FROM legacy_cutovers_v1 WHERE context=?1 ORDER BY rowid DESC LIMIT 1",[ctx_json(ctx)?],|r|r.get(0)).optional()?;
    id.map(|id| {
        let p = load(c, ctx, &id)?;
        let input: Input = serde_json::from_str(&c.query_row(
            "SELECT input FROM legacy_cutovers_v1 WHERE cutover_id=?1",
            [&id],
            |r| r.get::<_, String>(0),
        )?)
        .map_err(|_| invalid())?;
        Ok(json!({"cutoverId":id,"state":p.state,"runId":input.run_id,"backupId":input.backup_id}))
    })
    .transpose()
    .map(|v| v.unwrap_or(Value::Null))
}
pub fn prepare(
    c: &mut Connection,
    ctx: &CatalogueContext,
    input: &Input,
    at: &str,
) -> Result<Pending, Error> {
    for id in [&input.cutover_id, &input.run_id, &input.backup_id] {
        uuid::Uuid::parse_str(id).map_err(|_| invalid())?;
    }
    if input.confirmation != "WEB_WRITERS_CLOSED_BALANCES_REVIEWED"
        || !matches!(input.free_tax.as_str(), "0" | "0.18")
    {
        return Err(invalid());
    }
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let raw_input = serde_json::to_string(input).map_err(|_| invalid())?;
    let old: Option<String> = tx
        .query_row(
            "SELECT input FROM legacy_cutovers_v1 WHERE cutover_id=?1",
            [&input.cutover_id],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(old) = old {
        if old != raw_input {
            return Err(Error("CUTOVER_ID_CONFLICT"));
        }
        return load(&tx, ctx, &input.cutover_id);
    }
    if input.reconcile_selected == Some(false) {
        return Err(invalid());
    }
    let ready = if input.reconcile_selected == Some(true) {
        selected_readiness(&tx, ctx, &input.run_id)?
    } else {
        readiness(&tx, ctx, &input.run_id)?
    };
    if ready["canPrepare"] != true || ready["revision"] != input.revision {
        return Err(Error("CUTOVER_REVIEW_REQUIRED"));
    }
    if ready["services"].as_array().is_some_and(|s| !s.is_empty())
        && input.service_reservations_confirmed != Some(true)
    {
        return Err(Error("CUTOVER_SERVICE_RESERVATIONS_REQUIRED"));
    }
    if (input.reconcile_selected == Some(true)
        || ready["legacyCashHistoryWarnings"]
            .as_array()
            .is_some_and(|v| !v.is_empty()))
        && input.legacy_cash_history_confirmed != Some(true)
    {
        return Err(Error("CUTOVER_CASH_HISTORY_CONFIRMATION_REQUIRED"));
    }
    let raw:Option<String>=tx.query_row("SELECT result FROM native_backup_jobs_v1 WHERE operation_id=?1 AND tenant_id=?2 AND installation_id=?3 AND actor_id=?4 AND state='VERIFIED'",(&input.backup_id,&ctx.tenant_id,&ctx.installation_id,&ctx.actor_id),|r|r.get(0)).optional()?.flatten();
    let backup: Value = serde_json::from_str(&raw.ok_or(Error("CUTOVER_BACKUP_REQUIRED"))?)
        .map_err(|_| invalid())?;
    let manifest = &backup["manifest"];
    let source = &manifest["source"];
    let fingerprint = fingerprints(&tx)?
        .remove(&input.run_id)
        .ok_or_else(invalid)?;
    if source["tenantId"] != ctx.tenant_id
        || source["actorId"] != ctx.actor_id
        || source["installationId"] != ctx.installation_id
        || source["deviceId"] != ctx.device_id
        || source["writerEpoch"] != ctx.writer_epoch
        || source["scopeType"] != ctx.scope_type
        || source["branchId"] != json!(ctx.branch_id)
        || manifest["backupId"] != input.backup_id
        || manifest["transitionRuns"][&input.run_id] != fingerprint
        || manifest["databaseHash"]
            .as_str()
            .is_none_or(|h| h.len() != 64 || !h.bytes().all(|b| b.is_ascii_hexdigit()))
    {
        return Err(Error("CUTOVER_BACKUP_REQUIRED"));
    }
    let report = transition::report(&tx, ctx, &input.run_id)?;
    let base_tables = if input.reconcile_selected == Some(true) {
        comparison(&tx, ctx, &input.run_id)?.tables
    } else {
        tables(&tx, ctx, &input.run_id)?
    };
    let mut plan = json!({"protocol":"ventard.web.cutover.1","cutoverId":input.cutover_id,"runId":input.run_id,"revision":input.revision,"context":ctx,"backupId":input.backup_id,"backupHash":manifest["databaseHash"],"runHash":fingerprint,"confirmation":input.confirmation,"freeTax":input.free_tax,"sources":report["sources"],"tables":base_tables});
    if input.reconcile_selected == Some(true) {
        plan["reconciliation"] = resolution_plan(&tx, ctx, &input.run_id)?;
    }
    if let Some(confirmed) = input.service_reservations_confirmed {
        plan["serviceReservationsConfirmed"] = json!(confirmed);
    }
    if let Some(confirmed) = input.legacy_cash_history_confirmed {
        plan["legacyCashHistoryConfirmed"] = json!(confirmed);
    }
    let (intent, hash) = canonical(&plan)?;
    if intent.len() > transition::MAX_CAPTURE {
        return Err(Error("RESOLUTION_TOO_LARGE"));
    }
    tx.execute(
        "INSERT INTO legacy_cutovers_v1 VALUES(?1,?2,?3,?4,?5,?6,'UNKNOWN',NULL,?7)",
        (
            &input.cutover_id,
            ctx_json(ctx)?,
            &input.run_id,
            raw_input,
            &intent,
            &hash,
            at,
        ),
    )?;
    tx.commit()?;
    Ok(Pending {
        intent,
        hash,
        state: "UNKNOWN".into(),
    })
}
pub fn accept(
    c: &mut Connection,
    ctx: &CatalogueContext,
    id: &str,
    receipt: &Value,
) -> Result<(), Error> {
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let pending = load(&tx, ctx, id)?;
    let plan: Value = serde_json::from_str(&pending.intent).map_err(|_| invalid())?;
    let mut expected = expected_receipt(ctx, id, &pending.hash, &plan);
    let abandoned = receipt["status"] == "ABANDONED";
    if abandoned {
        expected["status"] = json!("ABANDONED");
        expected["coverage"] = json!("NO_BASELINE_CHANGE");
    }
    if *receipt != expected {
        return Err(Error("CUTOVER_RECEIPT_INVALID"));
    }
    if pending.state != "UNKNOWN" && ((pending.state == "ABANDONED") != abandoned) {
        return Err(Error("CUTOVER_RECEIPT_INVALID"));
    }
    tx.execute("UPDATE legacy_cutovers_v1 SET state=CASE WHEN state='ACTIVE' THEN state ELSE ?3 END,receipt=?2 WHERE cutover_id=?1",(id,receipt.to_string(),if abandoned{"ABANDONED"}else{"ADOPTED"}))?;
    tx.commit()?;
    Ok(())
}
pub fn mark_active(c: &mut Connection, ctx: &CatalogueContext, id: &str) -> Result<Value, Error> {
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let p = load(&tx, ctx, id)?;
    if !matches!(p.state.as_str(), "ADOPTED" | "ACTIVE")
        || !crate::application::sales_sync::operational(&tx, ctx).map_err(|_| invalid())?
    {
        return Err(Error("CUTOVER_BOOTSTRAP_REQUIRED"));
    }
    tx.execute(
        "UPDATE legacy_cutovers_v1 SET state='ACTIVE' WHERE cutover_id=?1",
        [id],
    )?;
    tx.commit()?;
    view(c, ctx)
}

#[cfg(test)]
mod bulk_document_tests {
    use super::*;
    #[test]
    fn cutover_documents_remain_bounded_to_the_migration_transport_limit() {
        let oversized = vec![b' '; transition::MAX_CAPTURE + 1];
        assert_eq!(
            canonical_document(&oversized).unwrap_err().code(),
            "RESOLUTION_TOO_LARGE"
        );
        assert_eq!(
            canonical_document(br#"{"x":-1}"#).unwrap_err().code(),
            "CUTOVER_INVALID"
        );
    }
}
