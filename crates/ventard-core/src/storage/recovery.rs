//! Recovery transfers custody and verifies historical facts; never sends old
//! intents as a new actor/device or promotes a restored database to a writer.
use super::{
    backup::{PreservedArchive, Source},
    catalogue_preview::{self, CatalogueContext},
};
use crate::{
    application::{
        errors::{AppError, BusinessError},
        sales, sales_sync,
    },
    domain::{canonical::canonicalize, identity::EntityId},
};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::Digest;
type StoredEvidence = (Vec<u8>, String, Option<Vec<u8>>, String, i64);
#[derive(Debug)]
pub struct Error(&'static str);
impl Error {
    pub fn code(&self) -> &'static str {
        self.0
    }
}
impl From<rusqlite::Error> for Error {
    fn from(_: rusqlite::Error) -> Self {
        Self("RECOVERY_STORAGE")
    }
}
fn invalid() -> Error {
    Error("RECOVERY_INVALID")
}
fn id(v: &str) -> Result<(), Error> {
    EntityId::parse(v).map(|_| ()).map_err(|_| invalid())
}
fn key(ctx: &CatalogueContext) -> Result<String, Error> {
    catalogue_preview::key(ctx).map_err(|_| invalid())
}
fn canonical(v: &Value) -> Result<(String, String), Error> {
    canonicalize(&serde_json::to_vec(v).map_err(|_| invalid())?).map_err(|_| invalid())
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Fact {
    pub operation_id: String,
    pub intent: String,
    pub hash: String,
    pub snapshot: Option<String>,
    pub pending: bool,
}
pub fn facts(c: &Connection, source: &Source) -> Result<Vec<Fact>, Error> {
    source.validate().map_err(|_| invalid())?;
    let mut query=c.prepare("SELECT j.operation_id,j.canonical_bytes,j.hash,t.snapshot_bytes,coalesce(o.state<>'APPLIED',0) FROM operation_journal j LEFT JOIN outbox o USING(operation_id) LEFT JOIN sale_ticket_snapshots_v1 t USING(operation_id) WHERE j.local_state='COMMITTED' ORDER BY j.local_seq LIMIT 60001")?;
    let mut facts = vec![];
    for row in query.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, Vec<u8>>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, Option<Vec<u8>>>(3)?,
            r.get::<_, bool>(4)?,
        ))
    })? {
        let (operation_id, raw, hash, snapshot, pending) = row?;
        id(&operation_id)?;
        let (intent, h) = canonicalize(&raw).map_err(|_| invalid())?;
        let v: Value = serde_json::from_str(&intent).map_err(|_| invalid())?;
        if intent.as_bytes() != raw
            || h != hash
            || v["protocol"] != "ventard.native.v1"
            || v["operationId"] != operation_id
            || v["negocioId"] != source.tenant_id
            || v["scope"] != json!({"type":source.scope_type,"sucursalId":source.branch_id})
        {
            return Err(invalid());
        }
        let snapshot = snapshot
            .map(|s| String::from_utf8(s).map_err(|_| invalid()))
            .transpose()?;
        facts.push(Fact {
            operation_id,
            intent,
            hash,
            snapshot,
            pending,
        });
    }
    if facts.len() > 60000 || facts.iter().filter(|f| f.pending).count() > 1000 {
        return Err(Error("RECOVERY_TOO_LARGE"));
    }
    Ok(facts)
}
fn same_business(ctx: &CatalogueContext, source: &Source) -> bool {
    ctx.tenant_id == source.tenant_id
        && ctx.scope_type == source.scope_type
        && ctx.branch_id == source.branch_id
}
fn fresh(c: &Connection, ctx: &CatalogueContext, source: &Source) -> Result<(), Error> {
    if !same_business(ctx, source)
        || ctx.device_id == source.device_id
        || ctx.installation_id == source.installation_id
    {
        return Err(Error("RECOVERY_NEW_IDENTITY_REQUIRED"));
    }
    let dirty:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM operation_journal WHERE json_extract(CAST(canonical_bytes AS TEXT),'$.installationId')=?1)",[&ctx.installation_id],|r|r.get(0))?;
    if dirty || !sales_sync::operational(c, ctx).map_err(|_| invalid())? {
        return Err(Error("RECOVERY_FRESH_INSTALLATION_REQUIRED"));
    }
    Ok(())
}
pub fn inspect(
    c: &Connection,
    ctx: &CatalogueContext,
    source: &Source,
    facts: &[Fact],
) -> Result<Value, Error> {
    fresh(c, ctx, source)?;
    let sk = sales::scope_key(ctx).map_err(|_| invalid())?;
    let through: i64 = c.query_row(
        "SELECT sequence FROM native_sales_cursor_v1 WHERE tenant_id=?1 AND scope_key=?2",
        (&ctx.tenant_id, &sk),
        |r| r.get(0),
    )?;
    let mut issues = vec![];
    let mut verified = 0;
    for fact in facts {
        let local:Option<StoredEvidence>=c.query_row("SELECT j.canonical_bytes,j.hash,t.snapshot_bytes,r.receipt,r.remote_sequence FROM operation_journal j LEFT JOIN sale_ticket_snapshots_v1 t USING(operation_id) JOIN native_sales_receipts_v1 r USING(operation_id) WHERE j.operation_id=?1 AND r.tenant_id=?2 AND r.scope_key=?3",(&fact.operation_id,&ctx.tenant_id,&sk),|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional()?;
        let code = if let Some((raw, hash, snapshot, receipt, sequence)) = local {
            if raw != fact.intent.as_bytes()
                || hash != fact.hash
                || snapshot.as_deref() != fact.snapshot.as_ref().map(|s| s.as_bytes())
            {
                Some("CONTENT_CONFLICT")
            } else {
                let v: Value = serde_json::from_str(&fact.intent).map_err(|_| invalid())?;
                let receipt: Value = serde_json::from_str(&receipt).map_err(|_| invalid())?;
                if sequence > through
                    || sales_sync::validate_event(ctx, &v, fact.snapshot.as_deref(), &receipt)
                        .is_err()
                {
                    Some("RECEIPT_UNVERIFIED")
                } else {
                    None
                }
            }
        } else {
            Some("CLOUD_OPERATION_MISSING")
        };
        if let Some(code) = code {
            issues.push(
                json!({"operationId":fact.operation_id,"code":code,"pendingInBackup":fact.pending}),
            );
        } else {
            verified += 1;
        }
    }
    Ok(
        json!({"verified":verified.to_string(),"total":facts.len().to_string(),"unresolved":issues.len().to_string(),"issues":issues.into_iter().take(50).collect::<Vec<_>>(),"canTransfer":verified==facts.len(),"replay":false}),
    )
}
pub fn prepare(
    c: &mut Connection,
    ctx: &CatalogueContext,
    recovery_id: &str,
    custody_directory: &str,
    custody: &PreservedArchive,
    facts: Vec<Fact>,
    ciphertext: Vec<u8>,
) -> Result<Value, Error> {
    id(recovery_id)?;
    id(custody_directory)?;
    let context_key = key(ctx)?;
    if ciphertext.len() > 128 * 1024 * 1024
        || ciphertext.len() as u64 != custody.manifest.database_bytes
        || format!("{:x}", sha2::Sha256::digest(&ciphertext)) != custody.manifest.database_hash
    {
        return Err(invalid());
    }
    let existing:Option<(String,String,String)>=c.query_row("SELECT context_key,custody_json,facts_json FROM native_recovery_plans_v1 WHERE recovery_id=?1",[recovery_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
    if let Some((old_context, old_custody, old_facts)) = existing {
        let old: PreservedArchive = serde_json::from_str(&old_custody).map_err(|_| invalid())?;
        if old_context != context_key
            || old.manifest != custody.manifest
            || old_facts != serde_json::to_string(&facts).map_err(|_| invalid())?
        {
            return Err(Error("RECOVERY_ID_CONFLICT"));
        }
        return view(c, ctx, recovery_id)?.ok_or_else(invalid);
    }
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let review = inspect(&tx, ctx, &custody.manifest.source, &facts)?;
    let state = if review["canTransfer"] == true {
        "REVIEW"
    } else {
        "BLOCKED"
    };
    tx.execute(
        "INSERT INTO native_recovery_plans_v1 VALUES(?1,?2,?3,?4,?5,?6,?7,NULL,NULL,NULL,?8)",
        (
            recovery_id,
            &ctx.tenant_id,
            &context_key,
            custody_directory,
            serde_json::to_string(custody).map_err(|_| invalid())?,
            serde_json::to_string(&facts).map_err(|_| invalid())?,
            review.to_string(),
            state,
        ),
    )?;
    tx.execute(
        "INSERT INTO native_recovery_assets_v1 VALUES(?1,?2)",
        (custody_directory, ciphertext),
    )?;
    tx.commit()?;
    view(c, ctx, recovery_id)?.ok_or_else(invalid)
}
pub fn ciphertext(
    c: &Connection,
    ctx: &CatalogueContext,
    recovery_id: &str,
) -> Result<Vec<u8>, Error> {
    id(recovery_id)?;
    c.query_row("SELECT a.ciphertext FROM native_recovery_assets_v1 a JOIN native_recovery_plans_v1 p USING(custody_directory) WHERE p.recovery_id=?1 AND p.tenant_id=?2 AND p.context_key=?3",(recovery_id,&ctx.tenant_id,key(ctx)?),|r|r.get(0)).map_err(Into::into)
}
pub fn archived_list(c: &Connection, source: &Source) -> Result<Value, Error> {
    let present:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='native_recovery_assets_v1')",[],|r|r.get(0))?;
    if !present {
        return Ok(json!({"rows":[]}));
    }
    let mut query=c.prepare("SELECT p.recovery_id,p.custody_json FROM native_recovery_plans_v1 p JOIN native_recovery_assets_v1 a USING(custody_directory) WHERE p.tenant_id=?1 ORDER BY p.rowid DESC LIMIT 100")?;
    let mut rows = vec![];
    for row in query.query_map([&source.tenant_id], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })? {
        let (id, raw) = row?;
        let custody: PreservedArchive = serde_json::from_str(&raw).map_err(|_| invalid())?;
        if custody.manifest.source.tenant_id == source.tenant_id
            && custody.manifest.source.scope_type == source.scope_type
            && custody.manifest.source.branch_id == source.branch_id
        {
            rows.push(json!({"recoveryId":id,"backupId":custody.manifest.backup_id,"capturedAtMs":custody.manifest.source.captured_at_ms}));
        }
    }
    Ok(json!({"rows":rows}))
}
pub fn list(c: &Connection, ctx: &CatalogueContext) -> Result<Value, Error> {
    let mut query=c.prepare("SELECT recovery_id FROM native_recovery_plans_v1 WHERE tenant_id=?1 AND context_key=?2 ORDER BY rowid DESC LIMIT 20")?;
    let ids = query
        .query_map((&ctx.tenant_id, key(ctx)?), |r| r.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(
        json!({"rows":ids.iter().map(|id|view(c,ctx,id)).collect::<Result<Vec<_>,_>>()?.into_iter().flatten().collect::<Vec<_>>()}),
    )
}
pub fn custody(
    c: &Connection,
    ctx: &CatalogueContext,
    recovery_id: &str,
) -> Result<(String, PreservedArchive), Error> {
    id(recovery_id)?;
    let row:Option<(String,String)>=c.query_row("SELECT custody_directory,custody_json FROM native_recovery_plans_v1 WHERE recovery_id=?1 AND tenant_id=?2 AND context_key=?3",(recovery_id,&ctx.tenant_id,key(ctx)?),|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
    let (directory, raw) = row.ok_or(Error("RECOVERY_NOT_FOUND"))?;
    id(&directory)?;
    Ok((
        directory,
        serde_json::from_str(&raw).map_err(|_| invalid())?,
    ))
}
pub fn freeze(
    c: &mut Connection,
    ctx: &CatalogueContext,
    recovery_id: &str,
    snapshot_id: &str,
    confirmed: bool,
) -> Result<(String, String), Error> {
    id(recovery_id)?;
    id(snapshot_id)?;
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let (state,custody,facts,request,hash):(String,String,String,Option<String>,Option<String>)=tx.query_row("SELECT state,custody_json,facts_json,request_json,request_hash FROM native_recovery_plans_v1 WHERE recovery_id=?1 AND tenant_id=?2 AND context_key=?3",(recovery_id,&ctx.tenant_id,key(ctx)?),|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?)))?;
    if let (Some(request), Some(hash)) = (request, hash) {
        return Ok((request, hash));
    }
    if state == "ABANDONED" {
        return Err(Error("RECOVERY_ABANDONED"));
    }
    if !confirmed {
        return Err(Error("RECOVERY_CONFIRMATION_REQUIRED"));
    }
    let custody: PreservedArchive = serde_json::from_str(&custody).map_err(|_| invalid())?;
    let facts: Vec<Fact> = serde_json::from_str(&facts).map_err(|_| invalid())?;
    let review = inspect(&tx, ctx, &custody.manifest.source, &facts)?;
    if review["canTransfer"] != true {
        return Err(Error("RECOVERY_PENDING_UNVERIFIED"));
    }
    let pending=facts.iter().filter(|f|f.pending).map(|f|Ok(json!({"operationId":f.operation_id,"intentHash":f.hash,"snapshotHash":f.snapshot.as_ref().map(|s|canonicalize(s.as_bytes()).map(|c|c.1)).transpose().map_err(|_|invalid())?}))).collect::<Result<Vec<_>,Error>>()?;
    let request = json!({"protocol":"ventard.native.recovery.1","requestId":recovery_id,"backupId":custody.manifest.backup_id,"backupHash":custody.manifest.database_hash,"source":custody.manifest.source,"target":ctx,"snapshotId":snapshot_id,"confirmation":"ORIGINAL_DEVICE_RETIRED_BACKUP_RECONCILED","pending":pending});
    let (raw, hash) = canonical(&request)?;
    if raw.len() > 1_048_576 {
        return Err(Error("RECOVERY_TOO_LARGE"));
    }
    tx.execute("UPDATE native_recovery_plans_v1 SET state='PREPARED',review_json=?2,request_json=?3,request_hash=?4 WHERE recovery_id=?1",(recovery_id,review.to_string(),&raw,&hash))?;
    tx.commit()?;
    Ok((raw, hash))
}
pub fn request(
    c: &Connection,
    ctx: &CatalogueContext,
    recovery_id: &str,
) -> Result<(String, String), Error> {
    id(recovery_id)?;
    let row:Option<(String,String)>=c.query_row("SELECT request_json,request_hash FROM native_recovery_plans_v1 WHERE recovery_id=?1 AND tenant_id=?2 AND context_key=?3 AND request_json IS NOT NULL",(recovery_id,&ctx.tenant_id,key(ctx)?),|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
    row.ok_or(Error("RECOVERY_NOT_PREPARED"))
}
pub fn record(
    c: &mut Connection,
    ctx: &CatalogueContext,
    recovery_id: &str,
    receipt: &Value,
) -> Result<Value, Error> {
    let (raw, hash) = request(c, ctx, recovery_id)?;
    let request: Value = serde_json::from_str(&raw).map_err(|_| invalid())?;
    if receipt["protocol"] != "ventard.native.recovery.receipt.1"
        || receipt["requestId"] != recovery_id
        || receipt["requestHash"] != hash
        || receipt["backupId"] != request["backupId"]
        || receipt["backupHash"] != request["backupHash"]
        || receipt["source"] != request["source"]
        || receipt["target"] != request["target"]
        || !matches!(receipt["status"].as_str(), Some("APPLIED" | "ABANDONED"))
        || receipt["replay"] != false
        || receipt["retiredSource"] != json!(receipt["status"] == "APPLIED")
    {
        return Err(invalid());
    }
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let old: Option<String> = tx.query_row(
        "SELECT receipt FROM native_recovery_plans_v1 WHERE recovery_id=?1",
        [recovery_id],
        |r| r.get(0),
    )?;
    let receipt_raw = canonical(receipt)?.0;
    if old.as_ref().is_some_and(|r| r != &receipt_raw) {
        return Err(Error("RECOVERY_RECEIPT_CONFLICT"));
    }
    let state = if receipt["status"] == "APPLIED" {
        "ACTIVE"
    } else {
        "ABANDONED"
    };
    tx.execute(
        "UPDATE native_recovery_plans_v1 SET state=?2,receipt=?3 WHERE recovery_id=?1",
        (recovery_id, state, receipt_raw),
    )?;
    tx.commit()?;
    view(c, ctx, recovery_id)?.ok_or_else(invalid)
}
pub fn abandon_unprepared(
    c: &mut Connection,
    ctx: &CatalogueContext,
    recovery_id: &str,
) -> Result<Value, Error> {
    id(recovery_id)?;
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let frozen:Option<Option<String>>=tx.query_row("SELECT request_json FROM native_recovery_plans_v1 WHERE recovery_id=?1 AND tenant_id=?2 AND context_key=?3",(recovery_id,&ctx.tenant_id,key(ctx)?),|r|r.get(0)).optional()?;
    if frozen.ok_or(Error("RECOVERY_NOT_FOUND"))?.is_some() {
        return Err(Error("RECOVERY_REMOTE_ABANDON_REQUIRED"));
    }
    tx.execute(
        "UPDATE native_recovery_plans_v1 SET state='ABANDONED' WHERE recovery_id=?1",
        [recovery_id],
    )?;
    tx.commit()?;
    view(c, ctx, recovery_id)?.ok_or_else(invalid)
}
pub fn view(
    c: &Connection,
    ctx: &CatalogueContext,
    recovery_id: &str,
) -> Result<Option<Value>, Error> {
    id(recovery_id)?;
    let row:Option<(String,String,String)>=c.query_row("SELECT state,custody_json,review_json FROM native_recovery_plans_v1 WHERE recovery_id=?1 AND tenant_id=?2 AND context_key=?3",(recovery_id,&ctx.tenant_id,key(ctx)?),|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
    row.map(|(state,custody,review)|{let custody:PreservedArchive=serde_json::from_str(&custody).map_err(|_|invalid())?;Ok(json!({"recoveryId":recovery_id,"state":state,"backupId":custody.manifest.backup_id,"capturedAtMs":custody.manifest.source.captured_at_ms,"review":serde_json::from_str::<Value>(&review).map_err(|_|invalid())?}))}).transpose()
}
pub fn ensure_writable(c: &Connection, raw: &[u8]) -> Result<(), AppError> {
    let present:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='native_recovery_plans_v1')",[],|r|r.get(0))?;
    if !present {
        return Ok(());
    }
    let v: Value = serde_json::from_slice(raw).map_err(|_| {
        AppError::Business(BusinessError::SaleGuard {
            code: "RECOVERY_REVIEW_REQUIRED".into(),
        })
    })?;
    let blocked:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM native_recovery_plans_v1 WHERE tenant_id=?1 AND state NOT IN('ACTIVE','ABANDONED'))",[v["negocioId"].as_str().unwrap_or_default()],|r|r.get(0))?;
    if blocked {
        return Err(AppError::Business(BusinessError::SaleGuard {
            code: "RECOVERY_REVIEW_REQUIRED".into(),
        }));
    }
    Ok(())
}
pub fn pending(
    c: &Connection,
    ctx: &CatalogueContext,
    recovery_id: &str,
) -> Result<Vec<Fact>, Error> {
    id(recovery_id)?;
    let row:Option<String>=c.query_row("SELECT facts_json FROM native_recovery_plans_v1 WHERE recovery_id=?1 AND tenant_id=?2 AND context_key=?3 AND state IN('BLOCKED','REVIEW')",(recovery_id,&ctx.tenant_id,key(ctx)?),|r|r.get(0)).optional()?;
    let facts: Vec<Fact> = serde_json::from_str(&row.ok_or(Error("RECOVERY_NOT_REVIEWABLE"))?)
        .map_err(|_| invalid())?;
    Ok(facts.into_iter().filter(|f| f.pending).collect())
}
pub fn review(
    c: &mut Connection,
    ctx: &CatalogueContext,
    recovery_id: &str,
) -> Result<Value, Error> {
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let (state,custody,facts):(String,String,String)=tx.query_row("SELECT state,custody_json,facts_json FROM native_recovery_plans_v1 WHERE recovery_id=?1 AND tenant_id=?2 AND context_key=?3",(recovery_id,&ctx.tenant_id,key(ctx)?),|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
    if !matches!(state.as_str(), "BLOCKED" | "REVIEW") {
        return view(&tx, ctx, recovery_id)?.ok_or_else(invalid);
    }
    let custody: PreservedArchive = serde_json::from_str(&custody).map_err(|_| invalid())?;
    let facts: Vec<Fact> = serde_json::from_str(&facts).map_err(|_| invalid())?;
    let review = inspect(&tx, ctx, &custody.manifest.source, &facts)?;
    tx.execute(
        "UPDATE native_recovery_plans_v1 SET state=?2,review_json=?3 WHERE recovery_id=?1",
        (
            recovery_id,
            if review["canTransfer"] == true {
                "REVIEW"
            } else {
                "BLOCKED"
            },
            review.to_string(),
        ),
    )?;
    tx.commit()?;
    view(c, ctx, recovery_id)?.ok_or_else(invalid)
}
