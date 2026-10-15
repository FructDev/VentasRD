//! Encrypted display metadata, separate from grants, business headers and journals.
use crate::{
    application::{
        errors::{AppError, ProtocolError},
        settings,
    },
    domain::identity::{EntityId, UtcMillis},
};
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Profile {
    pub tenant_id: String,
    pub actor_id: String,
    pub actor_name: Option<String>,
    pub business_name: Option<String>,
    pub logo: Option<String>,
    pub color: Option<String>,
    pub font: Option<String>,
    pub captured_at_ms: String,
}
fn invalid() -> AppError {
    AppError::Protocol(ProtocolError::MalformedPayload)
}
pub fn validate(p: &Profile) -> Result<(), AppError> {
    EntityId::parse(&p.tenant_id).map_err(|_| invalid())?;
    EntityId::parse(&p.actor_id).map_err(|_| invalid())?;
    UtcMillis::parse_dto(&p.captured_at_ms).map_err(|_| invalid())?;
    for name in [&p.actor_name, &p.business_name].into_iter().flatten() {
        if name.is_empty()
            || name.trim() != name
            || name.chars().count() > 256
            || name.chars().any(char::is_control)
        {
            return Err(invalid());
        }
    }
    if let Some(logo) = &p.logo {
        settings::validate_png(logo)?;
    }
    if p.color.as_deref().is_some_and(|s| {
        !matches!(
            s,
            "dorado"
                | "ambar"
                | "naranja"
                | "coral"
                | "rosa"
                | "lima"
                | "esmeralda"
                | "turquesa"
                | "cielo"
        )
    }) || p.font.as_deref().is_some_and(|s| {
        !matches!(
            s,
            "syne" | "poppins" | "montserrat" | "spacegro" | "sora" | "outfit" | "playfair"
        )
    }) {
        return Err(invalid());
    }
    Ok(())
}
pub fn save(c: &Connection, p: &Profile) -> Result<(), AppError> {
    validate(p)?;
    let raw = serde_json::to_string(p).map_err(|_| invalid())?;
    c.execute("INSERT INTO native_account_presentation_v1 VALUES(?1,?2,?3) ON CONFLICT(tenant_id,actor_id) DO UPDATE SET profile=excluded.profile WHERE profile<>excluded.profile",(&p.tenant_id,&p.actor_id,raw))?;
    Ok(())
}
pub fn read(c: &Connection, tenant: &str, actor: &str) -> Result<Option<Profile>, AppError> {
    EntityId::parse(tenant).map_err(|_| invalid())?;
    EntityId::parse(actor).map_err(|_| invalid())?;
    let present:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='native_account_presentation_v1')",[],|r|r.get(0))?;
    if !present {
        return Ok(None);
    }
    let raw: Option<String> = c
        .query_row(
            "SELECT profile FROM native_account_presentation_v1 WHERE tenant_id=?1 AND actor_id=?2",
            (tenant, actor),
            |r| r.get(0),
        )
        .optional()?;
    raw.map(|raw| {
        let p: Profile = serde_json::from_str(&raw).map_err(|_| invalid())?;
        validate(&p)?;
        if p.tenant_id != tenant || p.actor_id != actor {
            return Err(invalid());
        }
        Ok(p)
    })
    .transpose()
}
