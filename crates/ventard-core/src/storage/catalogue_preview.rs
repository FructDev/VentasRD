//! Frozen, encrypted catalogue preview. No stock authority, receipt or business activation.
use crate::domain::identity::EntityId;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CatalogueContext {
    pub tenant_id: String,
    pub actor_id: String,
    pub device_id: String,
    pub installation_id: String,
    pub writer_epoch: String,
    pub scope_type: String,
    pub branch_id: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PageDescriptor {
    pub index: usize,
    pub count: usize,
    pub byte_length: usize,
    pub sha256: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub version: String,
    pub snapshot_id: String,
    pub context: CatalogueContext,
    pub captured_at_ms: String,
    pub expires_at_ms: String,
    pub coverage: String,
    pub watermark: Option<String>,
    pub total_count: usize,
    pub pages: Vec<PageDescriptor>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewProduct {
    pub id: String,
    pub name: String,
    pub code: Option<String>,
    pub price_cents: Option<String>,
    pub stock: Option<String>,
    pub stock_evidence: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CataloguePreview {
    pub manifest: Manifest,
    pub products: Vec<PreviewProduct>,
}
#[derive(Debug)]
pub struct PreviewError(&'static str);
impl PreviewError {
    pub fn code(&self) -> &'static str {
        self.0
    }
}
impl From<rusqlite::Error> for PreviewError {
    fn from(_: rusqlite::Error) -> Self {
        Self("CATALOGUE_STORAGE_UNAVAILABLE")
    }
}
type Result<T> = std::result::Result<T, PreviewError>;
fn invalid() -> PreviewError {
    PreviewError("CATALOGUE_EVIDENCE_INVALID")
}
fn uuid(s: &str) -> Result<()> {
    EntityId::parse(s).map(|_| ()).map_err(|_| invalid())
}
fn unsigned(s: &str) -> Result<u64> {
    let n = s.parse::<u64>().map_err(|_| invalid())?;
    if n.to_string() != s || n > 9_007_199_254_740_991 {
        return Err(invalid());
    }
    Ok(n)
}
fn hash(s: &str) -> String {
    format!("{:x}", Sha256::digest(s.as_bytes()))
}
pub(crate) fn key(ctx: &CatalogueContext) -> Result<String> {
    for v in [
        &ctx.tenant_id,
        &ctx.actor_id,
        &ctx.device_id,
        &ctx.installation_id,
    ] {
        uuid(v)?;
    }
    if unsigned(&ctx.writer_epoch)? == 0 {
        return Err(invalid());
    }
    match (ctx.scope_type.as_str(), ctx.branch_id.as_deref()) {
        ("GLOBAL", None) => {}
        ("BRANCH", Some(b)) => uuid(b)?,
        _ => return Err(invalid()),
    }
    Ok(hash(&serde_json::to_string(ctx).map_err(|_| invalid())?))
}
fn validate(m: &Manifest, ctx: &CatalogueContext) -> Result<()> {
    key(ctx)?;
    uuid(&m.snapshot_id)?;
    if &m.context != ctx
        || m.version != "ventard.native.catalogue.preview.1"
        || m.coverage != "CATALOGUE_PREVIEW_V1"
        || m.watermark.is_some()
        || m.total_count > 10_000
        || m.pages.len() > 50
    {
        return Err(invalid());
    }
    let captured = unsigned(&m.captured_at_ms)?;
    let expires = unsigned(&m.expires_at_ms)?;
    if expires <= captured || expires - captured > 86_400_000 {
        return Err(invalid());
    }
    let mut count = 0;
    for (i, p) in m.pages.iter().enumerate() {
        if p.index != i
            || p.count == 0
            || p.count > 200
            || p.byte_length == 0
            || p.byte_length > 1_048_576
            || p.sha256.len() != 64
            || !p
                .sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(invalid());
        }
        count += p.count;
    }
    if count != m.total_count || (m.total_count == 0) != m.pages.is_empty() {
        return Err(invalid());
    }
    Ok(())
}
fn live(m: &Manifest, now: u64) -> Result<()> {
    // Technical read-only capture, not a license/grant or operative stock lease.
    // PCs and PostgreSQL do not have millisecond-identical clocks. Permit only
    // a bounded creation-time skew; never add that allowance to the expiry.
    const MAX_CREATION_SKEW_MS: u64 = 5_000;
    if now >= unsigned(&m.expires_at_ms)? {
        return Err(PreviewError("CATALOGUE_CAPTURE_EXPIRED"));
    }
    if unsigned(&m.captured_at_ms)?.saturating_sub(now) > MAX_CREATION_SKEW_MS {
        return Err(PreviewError("CATALOGUE_CLOCK_SKEW"));
    }
    Ok(())
}
fn manifest(conn: &Connection, ctx: &CatalogueContext, id: &str) -> Result<Manifest> {
    let raw:Option<String>=conn.query_row("SELECT manifest FROM catalogue_preview_manifests_v1 WHERE snapshot_id=?1 AND context_key=?2",(id,key(ctx)?),|r|r.get(0)).optional()?;
    let m: Manifest = serde_json::from_str(&raw.ok_or(invalid())?).map_err(|_| invalid())?;
    validate(&m, ctx)?;
    Ok(m)
}
pub fn begin(conn: &mut Connection, ctx: &CatalogueContext, m: &Manifest, now: u64) -> Result<()> {
    validate(m, ctx)?;
    live(m, now)?;
    let raw = serde_json::to_string(m).map_err(|_| invalid())?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let old: Option<String> = tx
        .query_row(
            "SELECT manifest FROM catalogue_preview_manifests_v1 WHERE snapshot_id=?1",
            [&m.snapshot_id],
            |r| r.get(0),
        )
        .optional()?;
    if old.as_ref().is_some_and(|s| s != &raw) {
        return Err(PreviewError("CATALOGUE_ID_CONFLICT"));
    }
    tx.execute("INSERT OR IGNORE INTO catalogue_preview_manifests_v1(snapshot_id,context_key,manifest,state)VALUES(?1,?2,?3,'DOWNLOADING')",(&m.snapshot_id,key(ctx)?,raw))?;
    tx.commit()?;
    Ok(())
}
pub fn pending(conn: &Connection, ctx: &CatalogueContext, now: u64) -> Result<Option<Manifest>> {
    let mut stmt=conn.prepare("SELECT manifest FROM catalogue_preview_manifests_v1 WHERE context_key=?1 AND state='DOWNLOADING' ORDER BY snapshot_id")?;
    let mut found = None;
    for row in stmt.query_map([key(ctx)?], |r| r.get::<_, String>(0))? {
        let m: Manifest = serde_json::from_str(&row?).map_err(|_| invalid())?;
        validate(&m, ctx)?;
        if live(&m, now).is_ok()
            && found.as_ref().is_none_or(|previous: &Manifest| {
                m.captured_at_ms.parse::<u64>().unwrap()
                    > previous.captured_at_ms.parse::<u64>().unwrap()
            })
        {
            found = Some(m);
        }
    }
    Ok(found)
}
pub fn missing_pages(conn: &Connection, ctx: &CatalogueContext, id: &str) -> Result<Vec<usize>> {
    let m = manifest(conn, ctx, id)?;
    let mut missing = Vec::new();
    for p in m.pages {
        let exists:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM catalogue_preview_pages_v1 WHERE snapshot_id=?1 AND page_index=?2)",(id,p.index as i64),|r|r.get(0))?;
        if !exists {
            missing.push(p.index)
        }
    }
    Ok(missing)
}
fn products(p: &PageDescriptor, payload: &str) -> Result<Vec<PreviewProduct>> {
    if payload.len() != p.byte_length || hash(payload) != p.sha256 {
        return Err(invalid());
    }
    let rows: Vec<PreviewProduct> = serde_json::from_str(payload).map_err(|_| invalid())?;
    if rows.len() != p.count {
        return Err(invalid());
    }
    for r in &rows {
        uuid(&r.id)?;
        if r.name.trim().is_empty()
            || r.name.chars().count() > 256
            || r.code.as_ref().is_some_and(|s| s.chars().count() > 128)
        {
            return Err(invalid());
        }
        if let Some(s) = &r.price_cents {
            unsigned(s)?;
        }
        match (r.stock.as_deref(), r.stock_evidence.as_str()) {
            (Some(s), "POINT_IN_TIME") => {
                let n = s.parse::<i32>().map_err(|_| invalid())?;
                if n.to_string() != s {
                    return Err(invalid());
                }
            }
            (None, "MISSING_BRANCH_AUTHORITY" | "MISSING_GLOBAL_AUTHORITY") => {}
            _ => return Err(invalid()),
        }
    }
    Ok(rows)
}
pub fn stage_page(
    conn: &mut Connection,
    ctx: &CatalogueContext,
    id: &str,
    index: usize,
    payload: &str,
    now: u64,
) -> Result<()> {
    let m = manifest(conn, ctx, id)?;
    live(&m, now)?;
    let p = m.pages.get(index).ok_or(invalid())?;
    products(p, payload)?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let old: Option<String> = tx
        .query_row(
            "SELECT payload FROM catalogue_preview_pages_v1 WHERE snapshot_id=?1 AND page_index=?2",
            (id, index as i64),
            |r| r.get(0),
        )
        .optional()?;
    if old.as_ref().is_some_and(|s| s != payload) {
        return Err(PreviewError("CATALOGUE_ID_CONFLICT"));
    }
    tx.execute("INSERT OR IGNORE INTO catalogue_preview_pages_v1(snapshot_id,page_index,payload)VALUES(?1,?2,?3)",(id,index as i64,payload))?;
    tx.commit()?;
    Ok(())
}
fn collect(conn: &Connection, m: &Manifest) -> Result<Vec<PreviewProduct>> {
    let mut all = Vec::with_capacity(m.total_count);
    let mut ids = HashSet::new();
    let mut previous = None;
    for p in &m.pages {
        let raw:Option<String>=conn.query_row("SELECT payload FROM catalogue_preview_pages_v1 WHERE snapshot_id=?1 AND page_index=?2",(&m.snapshot_id,p.index as i64),|r|r.get(0)).optional()?;
        for row in products(p, &raw.ok_or(PreviewError("CATALOGUE_INCOMPLETE"))?)? {
            if !ids.insert(row.id.clone())
                || previous.as_ref().is_some_and(|v: &String| v >= &row.id)
            {
                return Err(invalid());
            }
            previous = Some(row.id.clone());
            all.push(row);
        }
    }
    if all.len() != m.total_count {
        return Err(invalid());
    }
    Ok(all)
}
pub fn activate(conn: &mut Connection, ctx: &CatalogueContext, id: &str) -> Result<()> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let m = manifest(&tx, ctx, id)?;
    collect(&tx, &m)?;
    let previous: Option<String> = tx
        .query_row(
            "SELECT snapshot_id FROM catalogue_preview_active_v1 WHERE context_key=?1",
            [key(ctx)?],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(previous) = previous {
        let current = manifest(&tx, ctx, &previous)?;
        if previous != id && unsigned(&m.captured_at_ms)? <= unsigned(&current.captured_at_ms)? {
            return Err(PreviewError("CATALOGUE_CAPTURE_SUPERSEDED"));
        }
    }
    tx.execute(
        "UPDATE catalogue_preview_manifests_v1 SET state='COMPLETE' WHERE snapshot_id=?1",
        [id],
    )?;
    tx.execute("INSERT INTO catalogue_preview_active_v1(context_key,snapshot_id)VALUES(?1,?2)ON CONFLICT(context_key)DO UPDATE SET snapshot_id=excluded.snapshot_id",(key(ctx)?,id))?;
    tx.commit()?;
    Ok(())
}
pub fn read(conn: &Connection, ctx: &CatalogueContext) -> Result<Option<CataloguePreview>> {
    let id: Option<String> = conn
        .query_row(
            "SELECT snapshot_id FROM catalogue_preview_active_v1 WHERE context_key=?1",
            [key(ctx)?],
            |r| r.get(0),
        )
        .optional()?;
    id.map(|id| {
        let m = manifest(conn, ctx, &id)?;
        let rows = collect(conn, &m)?;
        Ok(CataloguePreview {
            manifest: m,
            products: rows,
        })
    })
    .transpose()
}
