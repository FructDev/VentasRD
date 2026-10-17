//! Server-signed authorization, distinct from JWT, PIN and license.
//! Trust keys/context come from native provisioning, never renderer input.
use crate::domain::{canonical::canonicalize, identity::EntityId};
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GrantError {
    Malformed,
    UnknownKey,
    InvalidSignature,
    InvalidClaims,
    ContextMismatch,
    StaleGrant,
}
impl GrantError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Malformed => "GRANT_MALFORMED",
            Self::UnknownKey => "GRANT_UNKNOWN_KEY",
            Self::InvalidSignature => "GRANT_INVALID_SIGNATURE",
            Self::InvalidClaims => "GRANT_INVALID_CLAIMS",
            Self::ContextMismatch => "GRANT_CONTEXT_MISMATCH",
            Self::StaleGrant => "GRANT_STALE",
        }
    }
}
#[derive(Debug)]
pub struct TrustedGrantKey {
    key_id: String,
    key: VerifyingKey,
}
impl TrustedGrantKey {
    pub fn new(id: &str, bytes: [u8; 32]) -> Result<Self, GrantError> {
        if id.is_empty()
            || id.len() > 64
            || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        {
            return Err(GrantError::Malformed);
        }
        let key = VerifyingKey::from_bytes(&bytes).map_err(|_| GrantError::Malformed)?;
        if key.is_weak() {
            return Err(GrantError::Malformed);
        }
        Ok(Self {
            key_id: id.into(),
            key,
        })
    }
}
#[derive(Debug, Clone)]
pub struct GrantContext {
    pub tenant_id: String,
    pub actor_id: String,
    pub device_id: String,
    pub installation_id: String,
    pub writer_epoch: String,
    pub scope_type: String,
    pub branch_id: Option<String>,
    pub min_grant_sequence: String,
    pub audience: String,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GrantLicense {
    pub plan_active: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan_tier: Option<String>,
    pub access_until_ms: Option<String>,
    pub trial_until_ms: Option<String>,
    pub grace_days: String,
    pub warn_after_openings: String,
    pub block_after_openings: String,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GrantScope {
    pub r#type: String,
    pub branch_id: Option<String>,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GrantPayload {
    pub protocol: String,
    pub key_id: String,
    pub issuer: String,
    pub audience: String,
    pub grant_id: String,
    pub grant_sequence: String,
    pub policy_version: String,
    pub tenant_id: String,
    pub actor_id: String,
    pub device_id: String,
    pub installation_id: String,
    pub writer_epoch: String,
    pub scope: GrantScope,
    pub role: String,
    pub capabilities: Vec<String>,
    pub issued_at_ms: String,
    pub actor_expires_at_ms: Option<String>,
    pub license: GrantLicense,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    payload: serde_json::Value,
    signature: String,
}
#[derive(Debug)]
pub struct VerifiedGrant {
    payload: GrantPayload,
    issued: u64,
    actor_expires: Option<u64>,
    license_expires: Option<u64>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessDecision {
    pub role: String,
    pub plan_tier: Option<String>,
    pub actor_allowed: bool,
    pub license_state: &'static str,
    pub warn_connection: bool,
    pub clock_rollback: bool,
    pub effective_time_ms: String,
    capabilities: Vec<String>,
    writes_allowed: bool,
}
impl AccessDecision {
    pub fn allows(&self, cap: &str) -> bool {
        self.actor_allowed
            && self.capabilities.iter().any(|c| c == cap)
            && (cap == "READ" || self.writes_allowed)
    }
}
fn number(s: &str) -> Result<u64, GrantError> {
    if s.is_empty()
        || s.len() > 16
        || (s.len() > 1 && s.starts_with('0'))
        || !s.bytes().all(|b| b.is_ascii_digit())
    {
        return Err(GrantError::InvalidClaims);
    }
    s.parse::<u64>()
        .ok()
        .filter(|n| *n <= 9_007_199_254_740_991)
        .ok_or(GrantError::InvalidClaims)
}
pub fn verify_grant(
    bytes: &[u8],
    trusted: &[TrustedGrantKey],
    ctx: &GrantContext,
) -> Result<VerifiedGrant, GrantError> {
    if bytes.len() > 8192 {
        return Err(GrantError::Malformed);
    }
    canonicalize(bytes).map_err(|_| GrantError::Malformed)?;
    let envelope: Envelope = serde_json::from_slice(bytes).map_err(|_| GrantError::Malformed)?;
    let key_id = envelope
        .payload
        .get("keyId")
        .and_then(|s| s.as_str())
        .ok_or(GrantError::Malformed)?;
    let key = trusted
        .iter()
        .find(|k| k.key_id == key_id)
        .ok_or(GrantError::UnknownKey)?;
    let (canonical, _) =
        canonicalize(&serde_json::to_vec(&envelope.payload).map_err(|_| GrantError::Malformed)?)
            .map_err(|_| GrantError::Malformed)?;
    if envelope.signature.len() != 128
        || !envelope
            .signature
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(GrantError::Malformed);
    }
    let mut sig = [0u8; 64];
    for (i, b) in sig.iter_mut().enumerate() {
        *b = u8::from_str_radix(&envelope.signature[i * 2..i * 2 + 2], 16)
            .map_err(|_| GrantError::Malformed)?;
    }
    key.key
        .verify_strict(canonical.as_bytes(), &Signature::from_bytes(&sig))
        .map_err(|_| GrantError::InvalidSignature)?;
    let p: GrantPayload =
        serde_json::from_value(envelope.payload).map_err(|_| GrantError::InvalidClaims)?;
    if p.protocol != "ventard.offline-grant.v1"
        || p.license
            .plan_tier
            .as_deref()
            .is_some_and(|tier| !matches!(tier, "basico" | "pro"))
        || p.policy_version != "1"
        || !matches!((p.issuer.as_str(), p.audience.as_str()),
            ("ventard.staging", "ventard.native.staging.v1") |
            ("ventard.production", "ventard.native.production.v1"))
        || p.license.grace_days != "5"
        || p.license.warn_after_openings != "200"
        || p.license.block_after_openings != "300"
    {
        return Err(GrantError::InvalidClaims);
    }
    for id in [
        &p.grant_id,
        &p.tenant_id,
        &p.actor_id,
        &p.device_id,
        &p.installation_id,
    ] {
        EntityId::parse(id).map_err(|_| GrantError::InvalidClaims)?;
    }
    match (p.scope.r#type.as_str(), &p.scope.branch_id) {
        ("GLOBAL", None) => {}
        ("BRANCH", Some(id)) => {
            EntityId::parse(id).map_err(|_| GrantError::InvalidClaims)?;
        }
        _ => return Err(GrantError::InvalidClaims),
    }
    let epoch = number(&p.writer_epoch)?;
    let seq = number(&p.grant_sequence)?;
    if epoch == 0 || seq == 0 {
        return Err(GrantError::InvalidClaims);
    }
    if seq < number(&ctx.min_grant_sequence)? {
        return Err(GrantError::StaleGrant);
    }
    if p.tenant_id != ctx.tenant_id
        || p.actor_id != ctx.actor_id
        || p.device_id != ctx.device_id
        || p.installation_id != ctx.installation_id
        || p.writer_epoch != ctx.writer_epoch
        || p.scope.r#type != ctx.scope_type
        || p.scope.branch_id != ctx.branch_id
        || p.audience != ctx.audience
    {
        return Err(GrantError::ContextMismatch);
    }
    let permitted: &[&str] = match p.role.as_str() {
        "owner" | "admin" => &["READ", "SELL", "INVENTORY_WRITE", "MANAGE"],
        "seller" | "cashier" => &["READ", "SELL"],
        _ => return Err(GrantError::InvalidClaims),
    };
    let mut seen = std::collections::HashSet::new();
    if p.capabilities.is_empty()
        || p.capabilities.len() > 4
        || p.capabilities
            .iter()
            .any(|c| !permitted.contains(&c.as_str()) || !seen.insert(c))
    {
        return Err(GrantError::InvalidClaims);
    }
    let issued = number(&p.issued_at_ms)?;
    let actor_expires = p.actor_expires_at_ms.as_deref().map(number).transpose()?;
    if actor_expires.is_some_and(|n| n < issued) {
        return Err(GrantError::InvalidClaims);
    }
    // Validate both claims, even when the trial fallback is not selected.
    let access_expires = p
        .license
        .access_until_ms
        .as_deref()
        .map(number)
        .transpose()?;
    let trial_expires = p
        .license
        .trial_until_ms
        .as_deref()
        .map(number)
        .transpose()?;
    let license_expires = access_expires.or(trial_expires);
    Ok(VerifiedGrant {
        payload: p,
        issued,
        actor_expires,
        license_expires,
    })
}
impl VerifiedGrant {
    pub fn payload(&self) -> &GrantPayload {
        &self.payload
    }
    pub fn evaluate(
        &self,
        now_ms: u64,
        highwater_ms: u64,
        openings: u64,
    ) -> Result<AccessDecision, GrantError> {
        if now_ms > 9_007_199_254_740_991 || highwater_ms > 9_007_199_254_740_991 {
            return Err(GrantError::InvalidClaims);
        }
        let now = now_ms.max(highwater_ms);
        let actor_allowed = now >= self.issued && self.actor_expires.is_none_or(|e| now <= e);
        let license_state = match self.license_expires {
            Some(e) if now <= e => "ACTIVE",
            Some(e)
                if now
                    <= e.checked_add(5 * 86_400_000)
                        .ok_or(GrantError::InvalidClaims)? =>
            {
                "GRACE"
            }
            Some(_) => "BLOCKED",
            None if self.payload.license.plan_active => "ACTIVE",
            None => "BLOCKED",
        };
        Ok(AccessDecision {
            role: self.payload.role.clone(),
            plan_tier: self.payload.license.plan_tier.clone(),
            actor_allowed,
            license_state,
            warn_connection: openings > 200,
            clock_rollback: now_ms < highwater_ms,
            effective_time_ms: now.to_string(),
            capabilities: self.payload.capabilities.clone(),
            writes_allowed: actor_allowed && license_state != "BLOCKED" && openings <= 300,
        })
    }
}
