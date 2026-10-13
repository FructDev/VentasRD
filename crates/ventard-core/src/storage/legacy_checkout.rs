//! The original web canonicalCommand/checkout codec, never C-N1. Matching a
//! locally saved command hash proves its preserved content, not remote effects.
use super::{
    catalogue_preview::CatalogueContext,
    legacy_reconciliation::{decimal, number},
    legacy_transition::{cents, normalize},
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
#[derive(Clone)]
pub(crate) struct Snapshot {
    pub sale_id: String,
    pub operation_id: String,
    pub hash: String,
    pub branch: Option<String>,
    pub invoice: Value,
}
impl Snapshot {
    pub fn in_scope(&self, ctx: &CatalogueContext) -> bool {
        self.branch == ctx.branch_id
    }
    pub fn proof(&self) -> Value {
        json!({"saleId":self.sale_id,"sourceOperationId":self.operation_id,"payloadHash":self.hash,"algorithm":"WEB_CHECKOUT_COMMAND1","scope":{"type":if self.branch.is_some(){"BRANCH"}else{"GLOBAL"},"branchId":self.branch},"effectStatus":"UNKNOWN_LEGACY"})
    }
}
fn numeric(raw: &str) -> Option<String> {
    let (n, scale) = decimal(raw)?;
    let s = n.to_string();
    if s == "0" {
        return Some(s);
    }
    let (negative, digits) = s
        .strip_prefix('-')
        .map_or((false, s.as_str()), |d| (true, d));
    let exponent = digits.len() as i32 - 1 - scale as i32;
    let sign = if negative { "-" } else { "" };
    if !(-6..21).contains(&exponent) {
        let tail = digits[1..].trim_end_matches('0');
        return Some(format!(
            "{sign}{}{}e{}{exponent}",
            &digits[..1],
            if tail.is_empty() {
                String::new()
            } else {
                format!(".{tail}")
            },
            if exponent >= 0 { "+" } else { "" }
        ));
    }
    if scale == 0 {
        return Some(s);
    }
    let padded = format!("{:0>width$}", digits, width = scale as usize + 1);
    let split = padded.len() - scale as usize;
    Some(format!("{sign}{}.{}", &padded[..split], &padded[split..]))
}
fn canonical(v: &Value, depth: u32) -> Option<String> {
    if depth > 64 {
        return None;
    }
    match v {
        Value::Number(_) => numeric(&number(v)?),
        Value::Array(a) => Some(format!(
            "[{}]",
            a.iter()
                .map(|v| canonical(v, depth + 1))
                .collect::<Option<Vec<_>>>()?
                .join(",")
        )),
        Value::Object(o) => {
            let mut keys = o.keys().collect::<Vec<_>>();
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            Some(format!(
                "{{{}}}",
                keys.into_iter()
                    .map(|key| Some(format!(
                        "{}:{}",
                        serde_json::to_string(key).ok()?,
                        canonical(&o[key], depth + 1)?
                    )))
                    .collect::<Option<Vec<_>>>()?
                    .join(",")
            ))
        }
        _ => serde_json::to_string(v).ok(),
    }
}
pub(crate) fn read(tenant: &str, source: &Value, sale: &Value) -> Option<Snapshot> {
    let result = &source["resultado"];
    let command = &result["comando"];
    let id = sale["id"].as_str()?;
    if source["tipo"] != "CHECKOUT"
        || source["contract_version"] != 1
        || source["estado_local"] != "COMMITTED"
        || source["negocio_id"] != tenant
        || source["operation_id"] != id
        || result["version"] != 1
        || result["estado"] != "COMMITTED"
        || result["cartId"] != id
        || command["operacionId"] != id
        || command["negocioId"] != tenant
        || result["scope"]["negocioId"] != tenant
    {
        return None;
    }
    let branch = match result["scope"].get("sucursalId")? {
        Value::Null => None,
        Value::String(s) => {
            uuid::Uuid::parse_str(s).ok()?;
            Some(s.clone())
        }
        _ => return None,
    };
    if command
        .get("sucursalId")
        .filter(|v| !v.is_null())
        .and_then(Value::as_str)
        != branch.as_deref()
        || sale.get("sucursal_id").is_some_and(|v| v != &json!(branch))
        || sale["metodo_pago"] != command["metodoPago"]
        || cents(&sale["total"])? != cents(&command["total"])?
        || normalize(&sale["fecha_creacion"], 0).ok()? != normalize(&command["fecha"], 0).ok()?
    {
        return None;
    }
    let mut invoice = result["comprobante"].clone();
    let items = invoice["items"].as_array_mut()?;
    if items.is_empty() || items.len() > 1000 {
        return None;
    }
    for item in items {
        let o = item.as_object_mut()?;
        for key in ["ubicacion", "serial_id", "serial_numero"] {
            o.entry(key).or_insert(Value::Null);
        }
    }
    let mut intent = json!({"kind":"CHECKOUT","contractVersion":1,"cartId":id,"scope":result["scope"],"comando":command,"comprobante":invoice});
    if let Some(fiscal) = result.get("solicitudFiscal") {
        intent["solicitudFiscal"] = fiscal.clone();
        intent["comando"]["ncf"] = Value::Null;
    }
    let canonical = canonical(&intent, 0)?;
    let hash = format!("{:x}", Sha256::digest(canonical.as_bytes()));
    if source["payload_hash"] != hash {
        return None;
    }
    let invoice = result["comprobante"].clone();
    let total = cents(&invoice["total"])?;
    let subtotal = cents(&invoice["subtotal"])?;
    let tax = cents(&invoice["itbis"])?;
    let discount = cents(&invoice["descuento"])?;
    let received = cents(&invoice["montoRecibido"])?;
    if [total, subtotal, tax, discount, received]
        .iter()
        .any(|n| *n < 0)
        || subtotal as i128 + tax as i128 - discount as i128 != total as i128
        || total != cents(&sale["total"])?
        || !invoice["negocio"]["nombre"].is_string()
    {
        return None;
    }
    Some(Snapshot {
        sale_id: id.into(),
        operation_id: source["id"].as_str()?.into(),
        hash,
        branch,
        invoice,
    })
}
