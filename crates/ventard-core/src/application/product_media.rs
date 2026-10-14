//! Disposable encrypted image cache. It never rewrites catalog authority,
//! operation hashes, original URLs, payments, stock or tickets.
use super::{
    errors::{AppError, ProtocolError},
    inventory,
};
use crate::{domain::canonical::sha256_hex, storage::catalogue_preview::CatalogueContext};
use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::{Connection, OptionalExtension};
use serde_json::Value;
fn invalid() -> AppError {
    AppError::Protocol(ProtocolError::MalformedPayload)
}
pub fn source(
    c: &Connection,
    ctx: &CatalogueContext,
    pid: &str,
) -> Result<Option<String>, AppError> {
    let p = inventory::product(c, ctx, pid)?;
    if p["deleted"] == true || p["metadata"]["photo"]["data"].is_string() {
        return Ok(None);
    }
    let Some(source) = p["metadata"]["photo"]["source"].as_str() else {
        return Ok(None);
    };
    if source.is_empty() || source.len() > 4096 || source.chars().any(char::is_control) {
        return Ok(None);
    }
    Ok(Some(source.into()))
}
pub fn validate(data: &str) -> Result<(), AppError> {
    let encoded = data
        .strip_prefix("data:image/png;base64,")
        .ok_or_else(invalid)?;
    if encoded.len() > 131072 {
        return Err(invalid());
    }
    let raw = STANDARD.decode(encoded).map_err(|_| invalid())?;
    if raw.len() < 45
        || raw.len() > 98304
        || STANDARD.encode(&raw) != encoded
        || raw[..16] != [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]
        || raw[raw.len() - 12..] != [0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]
    {
        return Err(invalid());
    }
    let w = u32::from_be_bytes(raw[16..20].try_into().map_err(|_| invalid())?);
    let h = u32::from_be_bytes(raw[20..24].try_into().map_err(|_| invalid())?);
    if !(1..=480).contains(&w)
        || !(1..=480).contains(&h)
        || raw[24] != 8
        || !matches!(raw[25], 0 | 2 | 3 | 4 | 6)
        || raw[26..29] != [0, 0, 0]
    {
        return Err(invalid());
    }
    Ok(())
}
pub fn cached(
    c: &Connection,
    ctx: &CatalogueContext,
    pid: &str,
    url: &str,
) -> Result<Option<String>, AppError> {
    let available:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='native_product_media_cache_v1')",[],|r|r.get(0))?;
    if !available {
        return Ok(None);
    }
    let found:Option<(String,String)>=c.query_row("SELECT data,sha256 FROM native_product_media_cache_v1 WHERE tenant_id=?1 AND product_id=?2 AND source=?3",(&ctx.tenant_id,pid,url),|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
    if let Some((data, hash)) = found {
        if sha256_hex(data.as_bytes()) != hash || validate(&data).is_err() {
            return Ok(None);
        }
        return Ok(Some(data));
    }
    Ok(None)
}
pub fn save(
    c: &Connection,
    ctx: &CatalogueContext,
    pid: &str,
    url: &str,
    data: &str,
) -> Result<bool, AppError> {
    validate(data)?;
    if source(c, ctx, pid)?.as_deref() != Some(url) {
        return Ok(false);
    }
    c.execute("INSERT INTO native_product_media_cache_v1 VALUES(?1,?2,?3,?4,?5) ON CONFLICT(tenant_id,product_id) DO UPDATE SET source=excluded.source,data=excluded.data,sha256=excluded.sha256",(&ctx.tenant_id,pid,url,data,sha256_hex(data.as_bytes())))?;
    Ok(true)
}
pub fn requests(
    c: &Connection,
    ctx: &CatalogueContext,
    ids: &[String],
) -> Result<Vec<Value>, AppError> {
    if ids.len() > 60 {
        return Err(invalid());
    }
    let mut result = vec![];
    let mut seen = std::collections::HashSet::new();
    for id in ids {
        if !seen.insert(id) {
            return Err(invalid());
        }
        if let Some(url) = source(c, ctx, id)? {
            if cached(c, ctx, id, &url)?.is_none() {
                result.push(serde_json::json!({"id":id,"source":url}));
            }
        }
    }
    Ok(result)
}
