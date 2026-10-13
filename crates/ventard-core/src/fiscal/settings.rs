//! Typed durable configuration requests. They never mint/replace fiscal blocks.
use crate::{
    application::{
        errors::{AppError, AuthError, BusinessError, ProtocolError},
        sales_sync,
    },
    domain::{canonical::canonicalize, identity::EntityId, money::MoneyCents},
    security::offline_grant::VerifiedGrant,
    storage::catalogue_preview::CatalogueContext,
};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Input {
    pub operation_id: String,
    pub expected_revision: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub first: String,
    pub last: String,
    pub enabled: bool,
}
#[derive(Clone)]
pub struct Request {
    pub payload: Value,
    pub bytes: String,
    pub hash: String,
}
impl Request {
    pub fn rpc_body(&self) -> Value {
        json!({"p_request":self.bytes,"p_hash":self.hash})
    }
    pub fn id(&self) -> &str {
        self.payload["requestId"].as_str().unwrap_or("")
    }
}
fn invalid() -> AppError {
    AppError::Business(BusinessError::SaleGuard {
        code: "FISCAL_SETTINGS_EVIDENCE_INVALID".into(),
    })
}
fn guard(code: &str) -> AppError {
    AppError::Business(BusinessError::SaleGuard { code: code.into() })
}
fn key(ctx: &CatalogueContext) -> Result<String, AppError> {
    serde_json::to_string(ctx).map_err(|_| invalid())
}
fn encode(v: &Value) -> Result<(String, String), AppError> {
    canonicalize(&serde_json::to_vec(v).map_err(|_| invalid())?).map_err(|_| invalid())
}
fn uint(v: &Value, max: i64) -> Result<i64, AppError> {
    let n = MoneyCents::parse_dto(v.as_str().ok_or_else(invalid)?)
        .map_err(|_| invalid())?
        .cents();
    if n < 1 || n > max {
        return Err(invalid());
    }
    Ok(n)
}
fn same_context(v: &Value, ctx: &CatalogueContext) -> bool {
    v["tenantId"] == ctx.tenant_id
        && v["actorId"] == ctx.actor_id
        && v["installationId"] == ctx.installation_id
        && v["deviceId"] == ctx.device_id
        && v["writerEpoch"] == ctx.writer_epoch
        && v["scopeType"] == ctx.scope_type
        && v["branchId"] == json!(ctx.branch_id)
}
pub fn authorize(
    c: &Connection,
    g: &VerifiedGrant,
    now: u64,
    high: u64,
    opens: u64,
) -> Result<CatalogueContext, AppError> {
    let d = g.evaluate(now, high, opens).map_err(|_| invalid())?;
    if !d.allows("MANAGE") {
        return Err(AppError::Auth(AuthError::PermissionDenied {
            required: "MANAGE".into(),
        }));
    }
    let p = g.payload();
    let x = CatalogueContext {
        tenant_id: p.tenant_id.clone(),
        actor_id: p.actor_id.clone(),
        installation_id: p.installation_id.clone(),
        device_id: p.device_id.clone(),
        writer_epoch: p.writer_epoch.clone(),
        scope_type: p.scope.r#type.clone(),
        branch_id: p.scope.branch_id.clone(),
    };
    if !sales_sync::operational(c, &x)? {
        return Err(guard("LEGACY_NOT_VERIFIABLE"));
    }
    Ok(x)
}
pub fn configuration(v: &Value) -> Result<(), AppError> {
    if v.is_null() {
        return Ok(());
    }
    if v.as_object().is_none_or(|o| o.len() != 6)
        || !matches!(v["type"].as_str(), Some("B01" | "B02"))
        || !v["enabled"].is_boolean()
    {
        return Err(invalid());
    }
    let first = uint(&v["first"], 99999999)?;
    let last = uint(&v["last"], 99999999)?;
    let next = uint(&v["next"], 100000000)?;
    if last < first || next < first || next > last + 1 {
        return Err(invalid());
    }
    let mut base = v.clone();
    base.as_object_mut().ok_or_else(invalid)?.remove("revision");
    if v["revision"] != encode(&base)?.1 {
        return Err(invalid());
    }
    Ok(())
}
pub fn cache(c: &Connection, ctx: &CatalogueContext, capture: &Value) -> Result<(), AppError> {
    if capture.as_object().is_none_or(|o| o.len() != 10)
        || capture["protocol"] != "ventard.fiscal.settings.1"
        || !same_context(capture, ctx)
    {
        return Err(invalid());
    }
    uint(&capture["capturedAtMs"], 9007199254740991)?;
    configuration(&capture["configuration"])?;
    let previous: Option<String> = c
        .query_row(
            "SELECT capture FROM native_fiscal_settings_cache_v1 WHERE context_key=?1",
            [key(ctx)?],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(previous) = previous {
        let old: Value = serde_json::from_str(&previous).map_err(|_| invalid())?;
        if uint(&old["capturedAtMs"], 9007199254740991)?
            >= uint(&capture["capturedAtMs"], 9007199254740991)?
        {
            return Ok(());
        }
    }
    c.execute("INSERT INTO native_fiscal_settings_cache_v1 VALUES(?1,?2) ON CONFLICT(context_key) DO UPDATE SET capture=excluded.capture",(key(ctx)?,capture.to_string()))?;
    Ok(())
}
pub fn view(c: &Connection, ctx: &CatalogueContext) -> Result<Value, AppError> {
    let cached: Option<String> = c
        .query_row(
            "SELECT capture FROM native_fiscal_settings_cache_v1 WHERE context_key=?1",
            [key(ctx)?],
            |r| r.get(0),
        )
        .optional()?;
    let pending:Option<Vec<u8>>=c.query_row("SELECT payload_bytes FROM native_fiscal_settings_requests_v1 WHERE context_key=?1 AND state='UNKNOWN'",[key(ctx)?],|r|r.get(0)).optional()?;
    let status:Option<String>=c.query_row("SELECT state FROM native_fiscal_settings_requests_v1 WHERE context_key=?1 ORDER BY rowid DESC LIMIT 1",[key(ctx)?],|r|r.get(0)).optional()?;
    let capture = cached
        .map(|v| serde_json::from_str::<Value>(&v).map_err(|_| invalid()))
        .transpose()?
        .unwrap_or(Value::Null);
    Ok(
        json!({"configuration":capture["configuration"],"capturedAtMs":capture["capturedAtMs"],"pending":pending.map(|v|serde_json::from_slice::<Value>(&v)).transpose().map_err(|_|invalid())?,"lastStatus":status,"coverage":"CAPTURED_CENTRAL_CONFIGURATION_NO_DGII_CERTIFICATION"}),
    )
}
pub fn get(c: &Connection, ctx: &CatalogueContext, id: &str) -> Result<Request, AppError> {
    EntityId::parse(id).map_err(|_| invalid())?;
    let(k,b,h):(String,Vec<u8>,String)=c.query_row("SELECT context_key,payload_bytes,payload_hash FROM native_fiscal_settings_requests_v1 WHERE request_id=?1",[id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
    if k != key(ctx)? {
        return Err(invalid());
    }
    let payload: Value = serde_json::from_slice(&b).map_err(|_| invalid())?;
    let (bytes, hash) = encode(&payload)?;
    if bytes.as_bytes() != b || hash != h || !same_context(&payload, ctx) {
        return Err(invalid());
    }
    Ok(Request {
        payload,
        bytes,
        hash,
    })
}
pub fn prepare(
    c: &mut Connection,
    g: &VerifiedGrant,
    now: u64,
    high: u64,
    opens: u64,
    input: Input,
) -> Result<Request, AppError> {
    let ctx = authorize(c, g, now, high, opens)?;
    EntityId::parse(&input.operation_id).map_err(|_| invalid())?;
    if !matches!(input.kind.as_str(), "B01" | "B02")
        || uint(&json!(input.first), 99999999)? > uint(&json!(input.last), 99999999)?
        || (input.expected_revision != "0"
            && (input.expected_revision.len() != 64
                || !input
                    .expected_revision
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))))
    {
        return Err(AppError::Protocol(ProtocolError::MalformedPayload));
    }
    let old: bool = c.query_row(
        "SELECT EXISTS(SELECT 1 FROM native_fiscal_settings_requests_v1 WHERE request_id=?1)",
        [&input.operation_id],
        |r| r.get(0),
    )?;
    if old {
        let r = get(c, &ctx, &input.operation_id)?;
        for (k, v) in [
            ("expectedRevision", json!(input.expected_revision)),
            ("type", json!(input.kind)),
            ("first", json!(input.first)),
            ("last", json!(input.last)),
            ("enabled", json!(input.enabled)),
        ] {
            if r.payload[k] != v {
                return Err(AppError::Protocol(ProtocolError::OperationIdConflict));
            }
        }
        return Ok(r);
    }
    let pending:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM native_fiscal_settings_requests_v1 WHERE context_key=?1 AND state='UNKNOWN')",[key(&ctx)?],|r|r.get(0))?;
    if pending {
        return Err(guard("FISCAL_SETTINGS_PENDING"));
    }
    let p = g.payload();
    let payload = json!({"protocol":"ventard.fiscal.settings.request.1","version":"1","requestId":input.operation_id,"actorId":ctx.actor_id,"tenantId":ctx.tenant_id,"installationId":ctx.installation_id,"deviceId":ctx.device_id,"writerEpoch":ctx.writer_epoch,"scopeType":ctx.scope_type,"branchId":ctx.branch_id,"permissionGrantId":p.grant_id,"expectedRevision":input.expected_revision,"type":input.kind,"first":input.first,"last":input.last,"enabled":input.enabled});
    let (bytes, hash) = encode(&payload)?;
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    tx.execute(
        "INSERT INTO native_fiscal_settings_requests_v1 VALUES(?1,?2,?3,?4,'UNKNOWN',NULL)",
        (&input.operation_id, key(&ctx)?, bytes.as_bytes(), &hash),
    )?;
    tx.commit()?;
    Ok(Request {
        payload,
        bytes,
        hash,
    })
}
pub fn accept(
    c: &mut Connection,
    ctx: &CatalogueContext,
    r: &Request,
    receipt: &Value,
) -> Result<(), AppError> {
    let stored = get(c, ctx, r.id())?;
    if stored.bytes != r.bytes
        || stored.hash != r.hash
        || receipt.as_object().is_none_or(|o| o.len() != 6)
        || receipt["protocol"] != "ventard.fiscal.settings.receipt.1"
        || receipt["request"] != r.payload
        || receipt["payloadHash"] != r.hash
        || !matches!(receipt["status"].as_str(), Some("APPLIED" | "ABANDONED"))
    {
        return Err(invalid());
    }
    configuration(&receipt["configuration"])?;
    uint(&receipt["capturedAtMs"], 9007199254740991)?;
    let state = if receipt["status"] == "APPLIED" {
        for field in ["type", "first", "last", "enabled"] {
            if receipt["configuration"][field] != r.payload[field] {
                return Err(invalid());
            }
        }
        "RECEIVED"
    } else {
        "ABANDONED"
    };
    let mut capture = json!({"protocol":"ventard.fiscal.settings.1","configuration":receipt["configuration"],"capturedAtMs":receipt["capturedAtMs"]});
    for field in [
        "tenantId",
        "actorId",
        "installationId",
        "deviceId",
        "writerEpoch",
        "scopeType",
        "branchId",
    ] {
        capture[field] = r.payload[field].clone()
    }
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let (previous_state, previous): (String, Option<String>) = tx.query_row(
        "SELECT state,receipt FROM native_fiscal_settings_requests_v1 WHERE request_id=?1",
        [r.id()],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    if let Some(previous) = previous {
        if previous_state != state
            || serde_json::from_str::<Value>(&previous).map_err(|_| invalid())? != *receipt
        {
            return Err(invalid());
        }
        return Ok(());
    }
    if previous_state != "UNKNOWN" {
        return Err(invalid());
    }
    if tx.execute("UPDATE native_fiscal_settings_requests_v1 SET state=?2,receipt=?3 WHERE request_id=?1 AND state='UNKNOWN'",(r.id(),state,receipt.to_string()))? != 1 {
        return Err(invalid());
    }
    cache(&tx, ctx, &capture)?;
    tx.commit()?;
    Ok(())
}
