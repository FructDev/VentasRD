//! Publication intentions use the normal durable management journal. A local
//! commit never asserts that a public catalogue is enabled on the server.
use super::{
    errors::{AppError, ProtocolError},
    management::Command,
};
use crate::domain::identity::EntityId;
use crate::storage::catalogue_preview::CatalogueContext;
use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Value};
fn invalid() -> AppError {
    AppError::Protocol(ProtocolError::MalformedPayload)
}
pub fn document(tenant: &str, command: &Command) -> Result<Value, AppError> {
    EntityId::parse(tenant).map_err(|_| invalid())?;
    let Command::CataloguePublish {
        operation_id,
        expected_revision,
        expected_enabled,
        enabled,
    } = command
    else {
        return Err(invalid());
    };
    EntityId::parse(operation_id).map_err(|_| invalid())?;
    let revision = expected_revision
        .parse::<u32>()
        .ok()
        .filter(|n| n.to_string() == *expected_revision && *n < 2_147_483_647)
        .ok_or_else(invalid)?;
    if expected_enabled == enabled {
        return Err(invalid());
    }
    Ok(
        json!({"cataloguePublication":{"enabled":enabled,"revision":(revision+1).to_string(),"publicPath":format!("/catalogo/{tenant}")},"amountCents":"0","method":null,"concept":if *enabled{"Catálogo público activado"}else{"Catálogo público desactivado"}}),
    )
}
pub fn view(c: &Connection, ctx: &CatalogueContext) -> Result<Value, AppError> {
    let last:Option<String>=c.query_row("SELECT r.document FROM native_management_records_v1 r LEFT JOIN outbox o ON o.operation_id=r.operation_id WHERE r.tenant_id=?1 AND r.kind='CONFIG_PATCH' AND json_type(r.document,'$.cataloguePublication')='object' AND (o.state='APPLIED' OR o.operation_id IS NULL) ORDER BY cast(json_extract(r.document,'$.cataloguePublication.revision') AS INTEGER) DESC LIMIT 1",[&ctx.tenant_id],|r|r.get(0)).optional()?;
    let mut q=c.prepare("SELECT r.operation_id,o.state FROM native_management_records_v1 r JOIN outbox o ON o.operation_id=r.operation_id WHERE r.tenant_id=?1 AND json_type(r.document,'$.cataloguePublication')='object' AND o.state<>'APPLIED'")?;
    let pending = q
        .query_map([&ctx.tenant_id], |r| {
            Ok(json!({"operationId":r.get::<_,String>(0)?,"state":r.get::<_,String>(1)?}))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let confirmed = last
        .map(|s| serde_json::from_str::<Value>(&s).map(|d| d["cataloguePublication"].clone()))
        .transpose()
        .map_err(|_| invalid())?;
    Ok(
        json!({"lastConfirmed":confirmed,"pending":pending,"remote":null,"remoteError":null,"webOrigin":null}),
    )
}
pub fn validate(intent: &Value) -> Result<(), AppError> {
    let command: Command =
        serde_json::from_value(intent["payload"]["request"].clone()).map_err(|_| invalid())?;
    let tenant = intent["negocioId"].as_str().ok_or_else(invalid)?;
    if intent["kind"] != "CONFIG_PATCH"
        || !intent["originalTurnId"].is_null()
        || intent["operationId"] != intent["payload"]["request"]["operationId"]
        || intent["payload"]["document"] != document(tenant, &command)?
    {
        return Err(invalid());
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn publication_is_zero_money_and_exactly_bound_to_request() {
        let tenant = "96000000-0000-4000-8000-000000000001";
        let mut q = json!({"kind":"CATALOGUE_PUBLISH","operationId":"96000000-0000-4000-8000-000000000002","expectedRevision":"0","expectedEnabled":false,"enabled":true});
        let command = serde_json::from_value(q.clone()).unwrap();
        let doc = document(tenant, &command).unwrap();
        assert_eq!(doc["amountCents"], "0");
        let mut event = json!({"kind":"CONFIG_PATCH","negocioId":tenant,"operationId":q["operationId"],"originalTurnId":null,"payload":{"request":q,"document":doc}});
        validate(&event).unwrap();
        event["payload"]["document"]["cataloguePublication"]["enabled"] = json!(false);
        assert!(validate(&event).is_err());
        for rev in ["01", "-1", "2147483647", "9007199254740993"] {
            q["expectedRevision"] = json!(rev);
            assert!(document(tenant, &serde_json::from_value(q.clone()).unwrap()).is_err());
        }
        q["expectedRevision"] = json!("0");
        q["enabled"] = json!(false);
        assert!(document(tenant, &serde_json::from_value(q).unwrap()).is_err());
    }
}
