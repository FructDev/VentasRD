//! Trusted native writer only; not an IPC API. A PIN unlocks a verified actor,
//! never produces a grant/DEK or resets a license. No plaintext/default PIN.
use super::offline_grant::{AccessDecision, VerifiedGrant};
use crate::domain::canonical::canonicalize;
use argon2::{
    password_hash::{PasswordHash, SaltString},
    Algorithm, Argon2, Params, PasswordHasher, PasswordVerifier, Version,
};
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use zeroize::Zeroizing;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PinError {
    Malformed,
    Invalid,
    RateLimited,
    Unauthorized,
    NotEnrolled,
    AlreadyEnrolled,
    Storage,
    RandomUnavailable,
    KdfUnavailable,
}
impl PinError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Malformed => "PIN_MALFORMED",
            Self::Invalid => "PIN_INVALID",
            Self::RateLimited => "PIN_RATE_LIMITED",
            Self::Unauthorized => "PIN_UNAUTHORIZED",
            Self::NotEnrolled => "PIN_NOT_ENROLLED",
            Self::AlreadyEnrolled => "PIN_ALREADY_ENROLLED",
            Self::Storage => "PIN_STORAGE_UNAVAILABLE",
            Self::RandomUnavailable => "PIN_RANDOM_UNAVAILABLE",
            Self::KdfUnavailable => "PIN_KDF_UNAVAILABLE",
        }
    }
}
impl From<rusqlite::Error> for PinError {
    fn from(_: rusqlite::Error) -> Self {
        Self::Storage
    }
}
fn kdf() -> Result<Argon2<'static>, PinError> {
    Ok(Argon2::new(
        Algorithm::Argon2id,
        Version::V0x13,
        Params::new(19456, 2, 1, None).map_err(|_| PinError::KdfUnavailable)?,
    ))
}
fn validate(pin: &str, now: u64) -> Result<(), PinError> {
    if pin.len() != 4 || !pin.bytes().all(|b| b.is_ascii_digit()) || now > 9_007_199_254_740_991 {
        return Err(PinError::Malformed);
    }
    Ok(())
}
fn scope(grant: &VerifiedGrant) -> String {
    grant
        .payload()
        .scope
        .branch_id
        .as_ref()
        .map_or_else(|| "GLOBAL".into(), |b| format!("BRANCH:{b}"))
}
fn fingerprint(grant: &VerifiedGrant) -> Result<String, PinError> {
    let bytes = serde_json::to_vec(grant.payload()).map_err(|_| PinError::Unauthorized)?;
    canonicalize(&bytes)
        .map(|(_, hash)| hash)
        .map_err(|_| PinError::Unauthorized)
}
pub(super) fn runtime(
    tx: &Transaction<'_>,
    g: &VerifiedGrant,
    now: u64,
) -> Result<(u64, u64), PinError> {
    let p = g.payload();
    let row:Option<(u64,u64)>=tx.query_row("SELECT highwater_ms,openings FROM local_access_runtime_v1 WHERE tenant_id=?1 AND installation_id=?2 AND device_id=?3 AND writer_epoch=?4",params![p.tenant_id,p.installation_id,p.device_id,p.writer_epoch],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
    let (highwater, openings) = row.unwrap_or((now, 0));
    Ok((highwater.max(now), openings))
}
pub(super) fn set_highwater(
    tx: &Transaction<'_>,
    g: &VerifiedGrant,
    now: u64,
) -> Result<(), PinError> {
    let p = g.payload();
    tx.execute("INSERT INTO local_access_runtime_v1(tenant_id,installation_id,device_id,writer_epoch,highwater_ms) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(tenant_id,installation_id,device_id,writer_epoch) DO UPDATE SET highwater_ms=max(highwater_ms,excluded.highwater_ms)",params![p.tenant_id,p.installation_id,p.device_id,p.writer_epoch,now])?;
    Ok(())
}
pub fn enroll_pin(
    conn: &mut Connection,
    g: &VerifiedGrant,
    pin: &Zeroizing<String>,
    now: u64,
) -> Result<(), PinError> {
    validate(pin, now)?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let (highwater, openings) = runtime(&tx, g, now)?;
    if !g
        .evaluate(now, highwater, openings)
        .map_err(|_| PinError::Unauthorized)?
        .allows("READ")
    {
        return Err(PinError::Unauthorized);
    }
    let p = g.payload();
    let scope = scope(g);
    let exists:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM local_pin_credentials_v1 WHERE tenant_id=?1 AND installation_id=?2 AND device_id=?3 AND writer_epoch=?4 AND scope_key=?5 AND actor_id=?6)",params![p.tenant_id,p.installation_id,p.device_id,p.writer_epoch,scope,p.actor_id],|r|r.get(0))?;
    if exists {
        return Err(PinError::AlreadyEnrolled);
    }
    let mut salt = Zeroizing::new([0u8; 16]);
    getrandom::fill(&mut *salt).map_err(|_| PinError::RandomUnavailable)?;
    let salt = SaltString::encode_b64(&*salt).map_err(|_| PinError::KdfUnavailable)?;
    let hash = Zeroizing::new(
        kdf()?
            .hash_password(pin.as_bytes(), &salt)
            .map_err(|_| PinError::KdfUnavailable)?
            .to_string(),
    );
    let seq = p
        .grant_sequence
        .parse::<u64>()
        .map_err(|_| PinError::Unauthorized)?;
    set_highwater(&tx, g, highwater)?;
    tx.execute("INSERT INTO local_pin_credentials_v1(tenant_id,installation_id,device_id,writer_epoch,scope_key,actor_id,pin_hash,grant_sequence,grant_hash) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",params![p.tenant_id,p.installation_id,p.device_id,p.writer_epoch,scope,p.actor_id,&*hash,seq,fingerprint(g)?])?;
    tx.commit()?;
    Ok(())
}
pub fn unlock_pin(
    conn: &mut Connection,
    g: &VerifiedGrant,
    pin: &Zeroizing<String>,
    now: u64,
) -> Result<AccessDecision, PinError> {
    validate(pin, now)?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let (highwater, openings) = runtime(&tx, g, now)?;
    let access = g
        .evaluate(now, highwater, openings)
        .map_err(|_| PinError::Unauthorized)?;
    if !access.allows("READ") {
        return Err(PinError::Unauthorized);
    }
    let p = g.payload();
    let scope = scope(g);
    type Row = (String, u64, String, u32, u64);
    let row:Option<Row>=tx.query_row("SELECT pin_hash,grant_sequence,grant_hash,failures,blocked_until_ms FROM local_pin_credentials_v1 WHERE tenant_id=?1 AND installation_id=?2 AND device_id=?3 AND writer_epoch=?4 AND scope_key=?5 AND actor_id=?6",params![p.tenant_id,p.installation_id,p.device_id,p.writer_epoch,scope,p.actor_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional()?;
    let (hash, sequence, old_hash, failures, blocked) = row.ok_or(PinError::NotEnrolled)?;
    let seq = p
        .grant_sequence
        .parse::<u64>()
        .map_err(|_| PinError::Unauthorized)?;
    let grant_hash = fingerprint(g)?;
    if seq < sequence || (seq == sequence && old_hash != grant_hash) {
        return Err(PinError::Unauthorized);
    }
    if highwater < blocked {
        return Err(PinError::RateLimited);
    }
    let hash = Zeroizing::new(hash);
    // Check bounded known KDF parameters before parsing; corrupted storage does not trigger arbitrary work.
    if !hash.starts_with("$argon2id$v=19$m=19456,t=2,p=1$") || hash.len() > 160 {
        return Err(PinError::Storage);
    }
    let phc = PasswordHash::new(&hash).map_err(|_| PinError::Storage)?;
    let valid = kdf()?.verify_password(pin.as_bytes(), &phc).is_ok();
    let failures = if valid {
        0
    } else {
        if failures == 5 {
            1
        } else {
            failures + 1
        }
    };
    let blocked = if failures == 5 {
        highwater
            .checked_add(30_000)
            .filter(|v| *v <= 9_007_199_254_740_991)
            .ok_or(PinError::Malformed)?
    } else {
        0
    };
    set_highwater(&tx, g, highwater)?;
    tx.execute("UPDATE local_pin_credentials_v1 SET failures=?7,blocked_until_ms=?8,grant_sequence=?9,grant_hash=?10 WHERE tenant_id=?1 AND installation_id=?2 AND device_id=?3 AND writer_epoch=?4 AND scope_key=?5 AND actor_id=?6",params![p.tenant_id,p.installation_id,p.device_id,p.writer_epoch,scope,p.actor_id,failures,blocked,seq,grant_hash])?;
    // A wrong PIN is an outcome AFTER commit, not an error which rolls back attempts.
    tx.commit()?;
    if valid {
        Ok(access)
    } else {
        Err(PinError::Invalid)
    }
}
