//! INVENTORY2 evidence only. Never authorizes aggregate replay, stock projection,
//! debt/cash changes or business activation. Preserve the original hash codec.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
#[derive(Debug)]
pub struct Invalid;
fn sha(s: &str) -> String {
    format!("{:x}", Sha256::digest(s.as_bytes()))
}
fn uuid(s: &str) -> bool {
    uuid::Uuid::parse_str(s).is_ok_and(|u| {
        (1..=8).contains(&u.get_version_num()) && u.get_variant() == uuid::Variant::RFC4122
    })
}
fn hash(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn text(v: &Value, key: &str) -> Result<String, Invalid> {
    v[key].as_str().map(str::to_owned).ok_or(Invalid)
}
fn id(v: &Value, key: &str) -> Result<String, Invalid> {
    let s = text(v, key)?;
    if !uuid(&s) {
        return Err(Invalid);
    }
    Ok(s)
}
fn optional_id(v: &Value, key: &str) -> Result<Option<String>, Invalid> {
    if v.get(key).is_none_or(Value::is_null) {
        Ok(None)
    } else {
        Ok(Some(id(v, key)?))
    }
}
fn sequence(v: &Value, key: &str) -> Result<Option<String>, Invalid> {
    if v.get(key).is_none_or(Value::is_null) {
        return Ok(None);
    }
    let s = text(v, key)?;
    if s.is_empty()
        || !s.bytes().all(|b| b.is_ascii_digit())
        || s.parse::<i64>().ok().filter(|v| *v >= 0).is_none()
    {
        return Err(Invalid);
    }
    Ok(Some(s))
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Payload {
    version: u8,
    operation_id: String,
    negocio_id: String,
    sucursal_id: Option<String>,
    producto_id: String,
    effect: Effect,
    tipo: String,
    referencia_id: Option<String>,
    fecha_origen: u64,
    expected_remote_sequence: Option<String>,
}
#[derive(Serialize)]
struct Effect {
    kind: String,
    value: String,
}
fn payload(v: &Value) -> Result<Payload, Invalid> {
    if v["sync_protocol_version"] != 2 {
        return Err(Invalid);
    }
    let absolute = v.get("valor_absoluto").is_some();
    let field = if absolute { "valor_absoluto" } else { "delta" };
    let value = v[field]
        .as_i64()
        .and_then(|n| i32::try_from(n).ok())
        .ok_or(Invalid)?;
    let expected = sequence(v, "expected_remote_sequence")?;
    if absolute != expected.is_some() {
        return Err(Invalid);
    }
    let tipo = text(v, "tipo")?;
    if !matches!(
        tipo.as_str(),
        "venta"
            | "devolucion"
            | "entrada"
            | "merma"
            | "conteo"
            | "importacion"
            | "reparacion"
            | "apartado"
    ) {
        return Err(Invalid);
    }
    let fecha = v["fecha_creacion"]
        .as_u64()
        .filter(|v| *v > 0 && *v <= 9_007_199_254_740_991)
        .ok_or(Invalid)?;
    Ok(Payload {
        version: 2,
        operation_id: id(v, "id")?,
        negocio_id: id(v, "negocio_id")?,
        sucursal_id: optional_id(v, "sucursal_id")?,
        producto_id: id(v, "producto_id")?,
        effect: Effect {
            kind: if absolute { "ABSOLUTE" } else { "DELTA" }.into(),
            value: value.to_string(),
        },
        tipo,
        referencia_id: optional_id(v, "referencia_id")?,
        fecha_origen: fecha,
        expected_remote_sequence: expected,
    })
}
pub fn reconstruct(v: &Value) -> Result<String, Invalid> {
    serde_json::to_string(&payload(v)?).map_err(|_| Invalid)
}
pub fn candidate(v: &Value) -> bool {
    v["payload_hash"]
        .as_str()
        .filter(|s| hash(s))
        .is_some_and(|declared| reconstruct(v).is_ok_and(|raw| sha(&raw) == declared))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LedgerRow {
    negocio_id: String,
    operacion_id: String,
    payload_version: u8,
    payload_hash: String,
    authority_kind: String,
    producto_id: String,
    #[serde(deserialize_with = "required_optional")]
    sucursal_id: Option<String>,
    effect_kind: String,
    effect_value: i32,
    tipo: String,
    #[serde(deserialize_with = "required_optional")]
    referencia_id: Option<String>,
    fecha_origen: u64,
    #[serde(deserialize_with = "required_optional")]
    expected_remote_sequence: Option<i64>,
    remote_sequence: i64,
    stock_before: i32,
    stock_after: i32,
    applied_at: String,
    applied_by: String,
    warning_codes: Vec<String>,
}
fn required_optional<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(
    d: D,
) -> Result<Option<T>, D::Error> {
    Option::<T>::deserialize(d)
}
impl LedgerRow {
    pub fn operation_id(&self) -> &str {
        &self.operacion_id
    }
    pub fn tenant_id(&self) -> &str {
        &self.negocio_id
    }
    pub fn branch_id(&self) -> Option<&str> {
        self.sucursal_id.as_deref()
    }
    pub fn authority(&self) -> &str {
        &self.authority_kind
    }
    fn canonical(&self) -> Result<String, Invalid> {
        let mut source = json!({"sync_protocol_version":self.payload_version,"id":self.operacion_id,"negocio_id":self.negocio_id,"sucursal_id":self.sucursal_id,"producto_id":self.producto_id,"tipo":self.tipo,"referencia_id":self.referencia_id,"fecha_creacion":self.fecha_origen});
        match self.effect_kind.as_str() {
            "DELTA" => source["delta"] = json!(self.effect_value),
            "ABSOLUTE" => source["valor_absoluto"] = json!(self.effect_value),
            _ => return Err(Invalid),
        }
        source["expected_remote_sequence"] =
            json!(self.expected_remote_sequence.map(|s| s.to_string()));
        reconstruct(&source)
    }
    fn valid(&self) -> bool {
        self.remote_sequence > 0
            && uuid(&self.applied_by)
            && hash(&self.payload_hash)
            && self.authority_kind
                == if self.sucursal_id.is_some() {
                    "BRANCH"
                } else {
                    "GLOBAL"
                }
            && time::OffsetDateTime::parse(
                &self.applied_at,
                &time::format_description::well_known::Rfc3339,
            )
            .is_ok()
            && self.warning_codes.len() <= 1
            && self.warning_codes.iter().all(|s| s == "OFFLINE_OVERSELL")
            && match self.effect_kind.as_str() {
                "DELTA" => {
                    self.expected_remote_sequence.is_none()
                        && self.stock_before.checked_add(self.effect_value)
                            == Some(self.stock_after)
                }
                "ABSOLUTE" => {
                    self.expected_remote_sequence == Some(self.remote_sequence - 1)
                        && self.stock_after == self.effect_value
                }
                _ => false,
            }
            && self.canonical().is_ok_and(|s| sha(&s) == self.payload_hash)
    }
}
pub fn parse_rows(raw: &str) -> Result<Vec<LedgerRow>, Invalid> {
    let rows: Vec<LedgerRow> = serde_json::from_str(raw).map_err(|_| Invalid)?;
    if rows.len() > 100 {
        return Err(Invalid);
    }
    let mut ids = BTreeSet::new();
    let mut sequences = BTreeSet::new();
    for row in &rows {
        if !row.valid()
            || !ids.insert((&row.negocio_id, &row.operacion_id))
            || !sequences.insert((&row.negocio_id, &row.sucursal_id, row.remote_sequence))
        {
            return Err(Invalid);
        }
    }
    Ok(rows)
}
pub fn pending(local: &Value) -> Value {
    let Some(declared) = local["payload_hash"].as_str().filter(|s| hash(s)) else {
        return json!({"status":"UNKNOWN_LEGACY","code":"NO_ORIGINAL_HASH"});
    };
    let Ok(raw) = reconstruct(local) else {
        return json!({"status":"UNKNOWN_LEGACY","code":"LOCAL_PAYLOAD_UNVERIFIABLE"});
    };
    if sha(&raw) != declared {
        return json!({"status":"CONFLICT","code":"LOCAL_PAYLOAD_HASH_MISMATCH"});
    }
    json!({"status":"PENDING_LOOKUP","code":"LEDGER_LOOKUP_PENDING"})
}
pub fn classify(local: &Value, row: Option<&LedgerRow>) -> Value {
    let initial = pending(local);
    if initial["status"] != "PENDING_LOOKUP" {
        return initial;
    }
    let Some(row) = row else {
        return json!({"status":"UNKNOWN_LEGACY","code":"NO_LEDGER_IN_AUTHORIZED_OBSERVATION"});
    };
    let Ok(raw) = reconstruct(local) else {
        return json!({"status":"UNKNOWN_LEGACY","code":"LOCAL_PAYLOAD_UNVERIFIABLE"});
    };
    if !row.valid()
        || sha(&raw) != row.payload_hash
        || row.canonical().ok().as_deref() != Some(raw.as_str())
    {
        return json!({"status":"CONFLICT","code":"REMOTE_PAYLOAD_MISMATCH","localHash":local["payload_hash"],"remoteHash":row.payload_hash});
    }
    json!({"status":"APPLIED_VERIFIED","code":"EXACT_IMMUTABLE_LEDGER","algorithm":"INVENTORY2","receipt":{"operationId":row.operacion_id,"negocioId":row.negocio_id,"productoId":row.producto_id,"sucursalId":row.sucursal_id,"authority":row.authority_kind,"payloadHash":row.payload_hash,"stockBefore":row.stock_before.to_string(),"stockAfter":row.stock_after.to_string(),"remoteSequence":row.remote_sequence.to_string(),"appliedAt":row.applied_at,"warningCodes":row.warning_codes}})
}
