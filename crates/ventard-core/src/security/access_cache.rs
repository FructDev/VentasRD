//! Signed evidence in encrypted storage. No flag/row is an authorization;
//! signatures/context are verified on every load and before every replacement.
use super::offline_grant::{
    verify_grant, GrantContext, GrantError, TrustedGrantKey, VerifiedGrant,
};
use crate::domain::canonical::canonicalize;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CacheError {
    Grant(GrantError),
    Conflict,
    Storage,
    NotFound,
}
impl CacheError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Grant(e) => e.code(),
            Self::Conflict => "GRANT_CACHE_CONFLICT",
            Self::Storage => "GRANT_CACHE_UNAVAILABLE",
            Self::NotFound => "GRANT_NOT_CACHED",
        }
    }
}
impl From<rusqlite::Error> for CacheError {
    fn from(_: rusqlite::Error) -> Self {
        Self::Storage
    }
}
fn scope(c: &GrantContext) -> String {
    c.branch_id
        .as_ref()
        .map_or_else(|| "GLOBAL".into(), |id| format!("BRANCH:{id}"))
}
type Row = (u64, Vec<u8>, String);
fn row(conn: &Connection, c: &GrantContext) -> Result<Option<Row>, CacheError> {
    Ok(conn.query_row("SELECT grant_sequence,wire,wire_hash FROM native_access_grant_cache_v1 WHERE tenant_id=?1 AND installation_id=?2 AND device_id=?3 AND writer_epoch=?4 AND scope_key=?5 AND actor_id=?6",params![c.tenant_id,c.installation_id,c.device_id,c.writer_epoch,scope(c),c.actor_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?)
}
pub fn save_grant(
    conn: &mut Connection,
    wire: &[u8],
    trusted: &[TrustedGrantKey],
    ctx: &GrantContext,
) -> Result<VerifiedGrant, CacheError> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let previous = row(&tx, ctx)?;
    let mut expected = ctx.clone();
    if let Some((seq, _, _)) = &previous {
        let minimum = expected
            .min_grant_sequence
            .parse::<u64>()
            .map_err(|_| CacheError::Storage)?;
        expected.min_grant_sequence = minimum.max(*seq).to_string();
    }
    let grant = verify_grant(wire, trusted, &expected).map_err(CacheError::Grant)?;
    let (_, hash) = canonicalize(wire).map_err(|_| CacheError::Storage)?;
    let seq = grant
        .payload()
        .grant_sequence
        .parse::<u64>()
        .map_err(|_| CacheError::Storage)?;
    if previous
        .as_ref()
        .is_some_and(|(old, _, old_hash)| *old == seq && *old_hash != hash)
    {
        return Err(CacheError::Conflict);
    }
    tx.execute("INSERT INTO native_access_grant_cache_v1(tenant_id,installation_id,device_id,writer_epoch,scope_key,actor_id,grant_sequence,wire,wire_hash) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9) ON CONFLICT(tenant_id,installation_id,device_id,writer_epoch,scope_key,actor_id) DO UPDATE SET grant_sequence=excluded.grant_sequence,wire=excluded.wire,wire_hash=excluded.wire_hash",params![ctx.tenant_id,ctx.installation_id,ctx.device_id,ctx.writer_epoch,scope(ctx),ctx.actor_id,seq,wire,hash])?;
    tx.commit()?;
    Ok(grant)
}
pub fn load_grant(
    conn: &Connection,
    trusted: &[TrustedGrantKey],
    ctx: &GrantContext,
) -> Result<VerifiedGrant, CacheError> {
    let (seq, wire, hash) = row(conn, ctx)?.ok_or(CacheError::NotFound)?;
    if canonicalize(&wire).map_err(|_| CacheError::Storage)?.1 != hash {
        return Err(CacheError::Storage);
    }
    let mut expected = ctx.clone();
    let minimum = expected
        .min_grant_sequence
        .parse::<u64>()
        .map_err(|_| CacheError::Storage)?;
    expected.min_grant_sequence = minimum.max(seq).to_string();
    verify_grant(&wire, trusted, &expected).map_err(CacheError::Grant)
}
