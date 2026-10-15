//! Encrypted, actor/device-bound control intentions. Never applies a role or
//! membership locally: only the trusted online service can change authority.
use crate::{
    application::errors::{AppError, BusinessError, ProtocolError},
    domain::{canonical::canonicalize, identity::EntityId},
    storage::catalogue_preview::CatalogueContext,
};
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
#[derive(Clone, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "SCREAMING_SNAKE_CASE",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Command {
    Invite {
        name: String,
        email: String,
        role: String,
    },
    Patch {
        member_id: String,
        expected_version: String,
        role: String,
        active: bool,
    },
    Renew {
        member_id: String,
        expected_version: String,
    },
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Input {
    pub operation_id: String,
    pub command: Command,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Member {
    pub id: String,
    pub name: String,
    pub email: String,
    pub role: String,
    pub active: bool,
    pub pending: bool,
    pub user_id: Option<String>,
    pub expires_at_ms: Option<String>,
    pub protected: bool,
    pub version: String,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Receipt {
    version: String,
    status: String,
    operation_id: String,
    tenant_id: String,
    actor_id: String,
    request_hash: String,
    member: Option<Member>,
    invite_path: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct View {
    version: String,
    tenant_id: String,
    members: Vec<Member>,
}
pub struct Wire {
    pub operation_id: String,
    pub request: String,
    pub hash: String,
    pub input: Input,
}
fn invalid() -> AppError {
    AppError::Protocol(ProtocolError::MalformedPayload)
}
fn guard(code: &str) -> AppError {
    AppError::Business(BusinessError::SaleGuard { code: code.into() })
}
fn canonical(v: &Value) -> Result<(String, String), AppError> {
    canonicalize(&serde_json::to_vec(v).map_err(|_| invalid())?).map_err(|_| invalid())
}
fn role(s: &str) -> bool {
    matches!(s, "admin" | "vendedor" | "cajero")
}
fn hash(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn text(s: &str, max: usize) -> bool {
    !s.is_empty() && s.trim() == s && s.chars().count() <= max && !s.chars().any(char::is_control)
}
fn validate(input: &Input) -> Result<(), AppError> {
    EntityId::parse(&input.operation_id).map_err(|_| invalid())?;
    match &input.command {
        Command::Invite {
            name,
            email,
            role: r,
        } => {
            if !text(name, 100)
                || !text(email, 200)
                || email.to_lowercase() != *email
                || email.chars().any(char::is_whitespace)
                || email.split('@').count() != 2
                || !email.split('@').all(|s| !s.is_empty())
                || !email.rsplit('@').next().is_some_and(|s| s.contains('.'))
                || !role(r)
            {
                return Err(invalid());
            }
        }
        Command::Patch {
            member_id,
            expected_version,
            role: r,
            ..
        } => {
            EntityId::parse(member_id).map_err(|_| invalid())?;
            if !hash(expected_version) || !role(r) {
                return Err(invalid());
            }
        }
        Command::Renew {
            member_id,
            expected_version,
        } => {
            EntityId::parse(member_id).map_err(|_| invalid())?;
            if !hash(expected_version) {
                return Err(invalid());
            }
        }
    }
    Ok(())
}
fn context(ctx: &CatalogueContext) -> Result<String, AppError> {
    for id in [
        &ctx.tenant_id,
        &ctx.actor_id,
        &ctx.installation_id,
        &ctx.device_id,
    ] {
        EntityId::parse(id).map_err(|_| invalid())?;
    }
    Ok(canonical(&json!(ctx))?.0)
}
pub fn prepare(c: &mut Connection, ctx: &CatalogueContext, input: Input) -> Result<Wire, AppError> {
    validate(&input)?;
    let key = context(ctx)?;
    let (request, h) = canonical(
        &json!({"version":"ventard.team.request.1","operationId":input.operation_id,"context":ctx,"command":input.command}),
    )?;
    let tx = c.transaction()?;
    let old:Option<(String,String,String)>=tx.query_row("SELECT context,request,request_hash FROM native_team_requests_v1 WHERE operation_id=?1",[&input.operation_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
    if let Some((a, b, d)) = old {
        if a != key || b != request || d != h {
            return Err(guard("TEAM_ID_CONFLICT"));
        }
    } else {
        let pending:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM native_team_requests_v1 WHERE context=?1 AND state='PREPARED')",[&key],|r|r.get(0))?;
        if pending {
            return Err(guard("TEAM_PENDING"));
        }
        tx.execute(
            "INSERT INTO native_team_requests_v1 VALUES(?1,?2,?3,?4,'PREPARED',null)",
            (&input.operation_id, &key, &request, &h),
        )?;
    }
    tx.commit()?;
    Ok(Wire {
        operation_id: input.operation_id.clone(),
        request,
        hash: h,
        input,
    })
}
pub fn pending(c: &Connection, ctx: &CatalogueContext) -> Result<Option<Input>, AppError> {
    let raw: Option<String> = c
        .query_row(
            "SELECT request FROM native_team_requests_v1 WHERE context=?1 AND state='PREPARED'",
            [context(ctx)?],
            |r| r.get(0),
        )
        .optional()?;
    raw.map(|s| {
        let v: Value = serde_json::from_str(&s).map_err(|_| invalid())?;
        let input: Input =
            serde_json::from_value(json!({"operationId":v["operationId"],"command":v["command"]}))
                .map_err(|_| invalid())?;
        validate(&input)?;
        Ok(input)
    })
    .transpose()
}
pub fn local(c: &Connection, ctx: &CatalogueContext) -> Result<Value, AppError> {
    let raw:Option<String>=c.query_row("SELECT result FROM native_team_requests_v1 WHERE context=?1 AND state='APPLIED' ORDER BY rowid DESC LIMIT 1",[context(ctx)?],|r|r.get(0)).optional()?;
    let last = raw
        .map(|s| serde_json::from_str::<Value>(&s))
        .transpose()
        .map_err(|_| invalid())?;
    Ok(
        json!({"pending":pending(c,ctx)?,"lastReceipt":last,"remote":null,"remoteError":null,"webOrigin":null}),
    )
}
fn member(m: &Member) -> Result<(), AppError> {
    EntityId::parse(&m.id).map_err(|_| invalid())?;
    if let Some(id) = &m.user_id {
        EntityId::parse(id).map_err(|_| invalid())?;
    }
    if !text(&m.name, 256)
        || !text(&m.email, 200)
        || !role(&m.role)
        || !hash(&m.version)
        || m.pending != m.user_id.is_none()
    {
        return Err(invalid());
    }
    if let Some(t) = &m.expires_at_ms {
        crate::domain::identity::UtcMillis::parse_dto(t).map_err(|_| invalid())?;
    }
    Ok(())
}
pub fn remote(v: Value, ctx: &CatalogueContext) -> Result<Value, AppError> {
    let r: View = serde_json::from_value(v.clone()).map_err(|_| invalid())?;
    if r.version != "ventard.team.view.1" || r.tenant_id != ctx.tenant_id || r.members.len() > 500 {
        return Err(invalid());
    }
    let mut seen = std::collections::HashSet::new();
    for m in &r.members {
        member(m)?;
        if !seen.insert(&m.id) {
            return Err(invalid());
        }
    }
    Ok(v)
}
pub fn not_found(v: &Value, w: &Wire) -> bool {
    v == &json!({"status":"NOT_FOUND","operationId":w.operation_id,"requestHash":w.hash})
}
pub fn finish(
    c: &Connection,
    ctx: &CatalogueContext,
    w: &Wire,
    v: &Value,
) -> Result<Value, AppError> {
    let r: Receipt = serde_json::from_value(v.clone()).map_err(|_| invalid())?;
    if r.version != "ventard.team.receipt.1"
        || r.tenant_id != ctx.tenant_id
        || r.actor_id != ctx.actor_id
        || r.operation_id != w.operation_id
        || r.request_hash != w.hash
    {
        return Err(invalid());
    }
    if r.status == "CANCELLED" {
        if r.member.is_some() || r.invite_path.is_some() {
            return Err(invalid());
        }
    } else if r.status == "APPLIED" {
        let m = r.member.as_ref().ok_or_else(invalid)?;
        member(m)?;
        match &w.input.command {
            Command::Invite { name, email, role } => {
                if m.id != w.operation_id
                    || m.name != *name
                    || m.email != *email
                    || m.role != *role
                    || !m.active
                    || !m.pending
                    || r.invite_path.is_none()
                {
                    return Err(invalid());
                }
            }
            Command::Patch {
                member_id,
                role,
                active,
                ..
            } => {
                if m.id != *member_id
                    || m.role != *role
                    || m.active != *active
                    || r.invite_path.is_some()
                {
                    return Err(invalid());
                }
            }
            Command::Renew { member_id, .. } => {
                if m.id != *member_id || !m.active || !m.pending || r.invite_path.is_none() {
                    return Err(invalid());
                }
            }
        }
        if let Some(path) = &r.invite_path {
            let token = path.strip_prefix("/unirse?token=").ok_or_else(invalid)?;
            EntityId::parse(token).map_err(|_| invalid())?;
        }
    } else {
        return Err(invalid());
    }
    let raw = serde_json::to_string(v).map_err(|_| invalid())?;
    let n=c.execute("UPDATE native_team_requests_v1 SET state=?5,result=?6 WHERE operation_id=?1 AND context=?2 AND request=?3 AND request_hash=?4 AND (state='PREPARED' OR (state=?5 AND result=?6))",(&w.operation_id,context(ctx)?,&w.request,&w.hash,&r.status,raw))?;
    if n != 1 {
        return Err(guard("TEAM_ID_CONFLICT"));
    }
    Ok(v.clone())
}
