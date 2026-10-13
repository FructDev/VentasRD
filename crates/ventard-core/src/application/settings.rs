//! Tenant-wide business metadata. Permission comes from the evaluated grant.
//! Public settings never authorize licences, fiscal numbers or bank settlement.
use super::{
    errors::{AppError, BusinessError, ProtocolError},
    management::Command,
    sales_sync,
};
use crate::{
    domain::{canonical::canonicalize, identity::EntityId},
    storage::catalogue_preview::CatalogueContext,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::{Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Bank {
    pub name: String,
    pub account: String,
    pub holder: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Definition {
    pub name: String,
    pub whatsapp: String,
    pub phone: String,
    pub rnc: String,
    pub address: String,
    pub footer: String,
    pub logo: Option<String>,
    pub color: String,
    pub font: String,
    pub bank: Option<Bank>,
}
fn invalid() -> AppError {
    AppError::Protocol(ProtocolError::MalformedPayload)
}
fn guard(code: &str) -> AppError {
    AppError::Business(BusinessError::SaleGuard { code: code.into() })
}
fn s(v: &Value) -> Result<&str, AppError> {
    v.as_str().ok_or_else(invalid)
}
pub fn supported(c: &Connection, ctx: &CatalogueContext) -> Result<bool, AppError> {
    Ok(c.query_row(
        "SELECT EXISTS(SELECT 1 FROM native_business_settings_protocol_v1 WHERE tenant_id=?1)",
        [&ctx.tenant_id],
        |r| r.get(0),
    )?)
}
pub fn import_protocol(
    tx: &Transaction<'_>,
    ctx: &CatalogueContext,
    packet: &Value,
) -> Result<(), AppError> {
    if packet["businessSettingsProtocol"] == "ventard.business.settings.1" {
        tx.execute("INSERT OR IGNORE INTO native_business_settings_protocol_v1 VALUES(?1,'ventard.business.settings.1')",[&ctx.tenant_id])?;
    }
    Ok(())
}
fn n(v: &str) -> Result<i64, AppError> {
    if v.is_empty()
        || v.len() > 10
        || v.starts_with('0') && v != "0"
        || !v.bytes().all(|b| b.is_ascii_digit())
    {
        return Err(invalid());
    }
    let n = v.parse::<i64>().map_err(|_| invalid())?;
    if n > 2147483647 {
        return Err(invalid());
    }
    Ok(n)
}
pub fn validate(d: &Definition) -> Result<(), AppError> {
    for (value, max, multiline) in [
        (&d.name, 256, false),
        (&d.whatsapp, 64, false),
        (&d.phone, 64, false),
        (&d.rnc, 32, false),
        (&d.address, 1000, true),
        (&d.footer, 1000, true),
    ] {
        if value.trim() != value
            || value.chars().count() > max
            || value
                .chars()
                .any(|c| c.is_control() && !(multiline && c == '\n'))
        {
            return Err(invalid());
        }
    }
    if d.name.is_empty()
        || !matches!(
            d.color.as_str(),
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
        || !matches!(
            d.font.as_str(),
            "syne" | "poppins" | "montserrat" | "spacegro" | "sora" | "outfit" | "playfair"
        )
    {
        return Err(invalid());
    }
    if let Some(b) = &d.bank {
        for (v, max) in [(&b.name, 128), (&b.account, 128), (&b.holder, 256)] {
            if v.trim() != v || v.chars().count() > max || v.chars().any(char::is_control) {
                return Err(invalid());
            }
        }
        if b.account.is_empty() {
            return Err(invalid());
        }
    }
    if let Some(logo) = &d.logo {
        let data = logo
            .strip_prefix("data:image/png;base64,")
            .ok_or_else(invalid)?;
        if data.len() > 131072 {
            return Err(invalid());
        }
        let raw = STANDARD.decode(data).map_err(|_| invalid())?;
        if raw.len() < 45
            || raw.len() > 98304
            || STANDARD.encode(&raw) != data
            || raw[..8] != [137, 80, 78, 71, 13, 10, 26, 10]
            || raw[8..16] != [0, 0, 0, 13, 73, 72, 68, 82]
            || raw[raw.len() - 12..] != [0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]
        {
            return Err(invalid());
        }
        let width = u32::from_be_bytes(raw[16..20].try_into().map_err(|_| invalid())?);
        let height = u32::from_be_bytes(raw[20..24].try_into().map_err(|_| invalid())?);
        if !(1..=480).contains(&width)
            || !(1..=480).contains(&height)
            || raw[24] != 8
            || !matches!(raw[25], 2 | 6)
            || raw[26..29] != [0, 0, 0]
        {
            return Err(invalid());
        }
    }
    Ok(())
}
pub fn profile(d: &Definition, revision: &str, op: &str) -> Value {
    let nullable = |s: &str| if s.is_empty() { Value::Null } else { json!(s) };
    json!({"name":d.name,"rnc":nullable(&d.rnc),"address":nullable(&d.address),"phone":nullable(&d.phone),"footer":nullable(&d.footer),"whatsapp":nullable(&d.whatsapp),"logo":d.logo,"color":d.color,"font":d.font,"bank":d.bank,"settingsRevision":revision,"settingsOperationId":op})
}
pub fn read(c: &Connection, ctx: &CatalogueContext) -> Result<Value, AppError> {
    let raw:Option<(i64,String,String,Option<String>)>=c.query_row("SELECT revision,definition,operation_id,remote_event FROM native_business_settings_v1 WHERE tenant_id=?1",[&ctx.tenant_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
    if let Some((revision, raw, op, remote)) = raw {
        let d: Definition = serde_json::from_str(&raw).map_err(|_| invalid())?;
        validate(&d)?;
        let state: Option<String> = c
            .query_row(
                "SELECT state FROM outbox WHERE operation_id=?1",
                [&op],
                |r| r.get(0),
            )
            .optional()?;
        let conflict = matches!(
            state.as_deref(),
            Some("CONFLICT" | "INTERVENTION" | "DENIED")
        );
        return Ok(
            json!({"revision":revision.to_string(),"definition":d,"operationId":op,"remoteStatus":state.unwrap_or("APPLIED".into()),"canLoadRemote":conflict&&remote.is_some(),"coverage":"NATIVE_BUSINESS_SETTINGS"}),
        );
    }
    let raw: Option<String> = c
        .query_row(
            "SELECT profile FROM native_business_profile_v1 WHERE tenant_id=?1",
            [&ctx.tenant_id],
            |r| r.get(0),
        )
        .optional()?;
    let p: Value = raw
        .map(|s| serde_json::from_str(&s).map_err(|_| invalid()))
        .transpose()?
        .unwrap_or(Value::Null);
    Ok(
        json!({"revision":"0","definition":{"name":p["name"].as_str().unwrap_or(""),"rnc":p["rnc"].as_str().unwrap_or(""),"address":p["address"].as_str().unwrap_or(""),"phone":p["phone"].as_str().unwrap_or(""),"footer":p["footer"].as_str().unwrap_or(""),"whatsapp":p["whatsapp"].as_str().unwrap_or(""),"logo":null,"color":"dorado","font":"syne","bank":null},"operationId":null,"remoteStatus":"CAPTURED","canLoadRemote":false,"coverage":"CAPTURED_PUBLIC_FIELDS_ONLY"}),
    )
}
pub fn document(c: &Connection, ctx: &CatalogueContext, req: &Command) -> Result<Value, AppError> {
    if !supported(c, ctx)? {
        return Err(guard("SETTINGS_MIGRATION_REQUIRED"));
    }
    let Command::BusinessSave {
        operation_id,
        expected_revision,
        definition,
    } = req
    else {
        return Err(invalid());
    };
    let current = read(c, ctx)?;
    if current["revision"] != *expected_revision {
        return Err(guard("VERSION_CONFLICT"));
    }
    if matches!(
        current["remoteStatus"].as_str(),
        Some("CONFLICT" | "INTERVENTION" | "DENIED")
    ) {
        return Err(guard("SERVICE_SYNC_CONFLICT"));
    }
    validate(definition)?;
    let revision = (n(expected_revision)?
        .checked_add(1)
        .filter(|v| *v <= 2147483647)
        .ok_or_else(invalid)?)
    .to_string();
    Ok(
        json!({"operationId":operation_id,"businessSettings":{"revision":revision,"definition":definition},"business":profile(definition,&revision,operation_id),"amountCents":"0","method":null,"concept":"Configuración del negocio"}),
    )
}
/// Freeze headers only from an accepted or still pending business edit.
/// A rejected concurrent edit requires an explicit verified remote choice.
pub fn public_profile(c: &Connection, ctx: &CatalogueContext) -> Result<Value, AppError> {
    let current = read(c, ctx)?;
    if matches!(
        current["remoteStatus"].as_str(),
        Some("CONFLICT" | "INTERVENTION" | "DENIED")
    ) {
        return Err(guard("SERVICE_SYNC_CONFLICT"));
    }
    let raw: Option<String> = c
        .query_row(
            "SELECT profile FROM native_business_profile_v1 WHERE tenant_id=?1",
            [&ctx.tenant_id],
            |r| r.get(0),
        )
        .optional()?;
    raw.map(|v| serde_json::from_str(&v).map_err(|_| invalid()))
        .transpose()
        .map(|v| v.unwrap_or(Value::Null))
}
fn validate_document(v: &Value) -> Result<(Definition, i64, String), AppError> {
    let req: Command =
        serde_json::from_value(v["payload"]["request"].clone()).map_err(|_| invalid())?;
    let Command::BusinessSave {
        operation_id,
        expected_revision,
        definition,
    } = req
    else {
        return Err(invalid());
    };
    EntityId::parse(&operation_id).map_err(|_| invalid())?;
    validate(&definition)?;
    let rev = n(&expected_revision)?
        .checked_add(1)
        .filter(|v| *v <= 2147483647)
        .ok_or_else(invalid)?;
    let d = json!({"operationId":operation_id,"businessSettings":{"revision":rev.to_string(),"definition":definition},"business":profile(&definition,&rev.to_string(),&operation_id),"amountCents":"0","method":null,"concept":"Configuración del negocio"});
    if v["kind"] != "CONFIG_PATCH"
        || v["operationId"] != operation_id
        || !v["originalTurnId"].is_null()
        || v["payload"]["document"] != d
    {
        return Err(invalid());
    }
    Ok((*definition, rev, operation_id))
}
fn store(
    tx: &Transaction<'_>,
    ctx: &CatalogueContext,
    d: &Definition,
    rev: i64,
    op: &str,
) -> Result<(), AppError> {
    tx.execute("INSERT INTO native_business_settings_v1 VALUES(?1,?2,?3,?4,NULL) ON CONFLICT(tenant_id) DO UPDATE SET revision=excluded.revision,definition=excluded.definition,operation_id=excluded.operation_id",(&ctx.tenant_id,rev,serde_json::to_string(d).map_err(|_|invalid())?,op))?;
    tx.execute("INSERT INTO native_business_profile_v1 VALUES(?1,?2) ON CONFLICT(tenant_id) DO UPDATE SET profile=excluded.profile",(&ctx.tenant_id,profile(d,&rev.to_string(),op).to_string()))?;
    Ok(())
}
pub fn apply(
    tx: &Transaction<'_>,
    ctx: &CatalogueContext,
    v: &Value,
    remote: bool,
) -> Result<(), AppError> {
    let (d, rev, op) = validate_document(v)?;
    let cur = read(tx, ctx)?;
    if !remote {
        if v["payload"]["document"]
            != document(
                tx,
                ctx,
                &serde_json::from_value(v["payload"]["request"].clone()).map_err(|_| invalid())?,
            )?
        {
            return Err(guard("VERSION_CONFLICT"));
        }
        return store(tx, ctx, &d, rev, &op);
    }
    let current = n(s(&cur["revision"])?)?;
    let own_pending = matches!(
        cur["remoteStatus"].as_str(),
        Some("PENDING" | "IN_FLIGHT" | "RETRYABLE_ERROR" | "CONFLICT" | "INTERVENTION" | "DENIED")
    );
    if cur["operationId"] != op && own_pending {
        if rev >= current {
            tx.execute("UPDATE outbox SET state='CONFLICT',claim_id=NULL,lease_expires=NULL WHERE operation_id=?1",[s(&cur["operationId"])?])?;
        }
        return Ok(());
    }
    if rev < current {
        return Ok(());
    }
    if rev == current && cur["operationId"] != op {
        return Err(guard("VERSION_CONFLICT"));
    }
    store(tx, ctx, &d, rev, &op)
}
pub fn import_current(
    tx: &Transaction<'_>,
    ctx: &CatalogueContext,
    event: &Value,
    watermark: i64,
) -> Result<(), AppError> {
    let raw = s(&event["intent"])?;
    let (canonical, _) = canonicalize(raw.as_bytes()).map_err(|_| invalid())?;
    if canonical != raw || !event["snapshot"].is_null() {
        return Err(invalid());
    }
    let v: Value = serde_json::from_str(raw).map_err(|_| invalid())?;
    let mut source = ctx.clone();
    source.scope_type = s(&v["scope"]["type"])?.into();
    source.branch_id = v["scope"]["sucursalId"].as_str().map(str::to_owned);
    sales_sync::validate_event(&source, &v, None, &event["receipt"])?;
    let seq = s(&event["receipt"]["remoteSequence"])?
        .parse::<i64>()
        .map_err(|_| invalid())?;
    if seq <= 0 || seq > watermark {
        return Err(invalid());
    }
    let (_, revision, _) = validate_document(&v)?;
    let cached: Option<String> = tx
        .query_row(
            "SELECT remote_event FROM native_business_settings_v1 WHERE tenant_id=?1",
            [&ctx.tenant_id],
            |r| r.get(0),
        )
        .optional()?
        .flatten();
    if let Some(raw) = cached {
        let old: Value = serde_json::from_str(&raw).map_err(|_| invalid())?;
        let old_intent: Value = serde_json::from_str(s(&old["intent"])?).map_err(|_| invalid())?;
        let (_, old_revision, _) = validate_document(&old_intent)?;
        let old_seq = s(&old["receipt"]["remoteSequence"])?
            .parse::<i64>()
            .map_err(|_| invalid())?;
        if seq < old_seq || revision < old_revision {
            return Ok(());
        }
        if seq == old_seq && old != *event {
            return Err(invalid());
        }
    }
    apply(tx, ctx, &v, true)?;
    tx.execute(
        "UPDATE native_business_settings_v1 SET remote_event=?2 WHERE tenant_id=?1",
        (&ctx.tenant_id, event.to_string()),
    )?;
    Ok(())
}
pub fn load_remote(c: &mut Connection, ctx: &CatalogueContext) -> Result<Value, AppError> {
    let tx = c.transaction()?;
    let old = read(&tx, ctx)?;
    if old["canLoadRemote"] != true {
        return Err(guard("SERVICE_SYNC_CONFLICT"));
    }
    let raw: String = tx.query_row(
        "SELECT remote_event FROM native_business_settings_v1 WHERE tenant_id=?1",
        [&ctx.tenant_id],
        |r| r.get(0),
    )?;
    let event: Value = serde_json::from_str(&raw).map_err(|_| invalid())?;
    let v: Value = serde_json::from_str(s(&event["intent"])?).map_err(|_| invalid())?;
    let (d, rev, op) = validate_document(&v)?;
    let (mut source, canonical) = (
        ctx.clone(),
        canonicalize(s(&event["intent"])?.as_bytes())
            .map_err(|_| invalid())?
            .0,
    );
    if canonical != s(&event["intent"])? || !event["snapshot"].is_null() {
        return Err(invalid());
    }
    source.scope_type = s(&v["scope"]["type"])?.into();
    source.branch_id = v["scope"]["sucursalId"].as_str().map(str::to_owned);
    sales_sync::validate_event(&source, &v, None, &event["receipt"])?;
    if let Some(id) = old["operationId"].as_str() {
        if id != op {
            tx.execute("UPDATE outbox SET state='CONFLICT',claim_id=NULL,lease_expires=NULL WHERE operation_id=?1 AND state<>'APPLIED'",[id])?;
        }
    }
    store(&tx, ctx, &d, rev, &op)?;
    tx.commit()?;
    read(c, ctx)
}
