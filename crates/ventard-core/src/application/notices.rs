//! Original VentaRD WhatsApp notices: recipient/message from scoped native data.
//! The shell opens a draft only after the operator clicks; never sends a message.
use super::{
    errors::{AppError, BusinessError, ProtocolError},
    layaways, management, repairs,
};
use crate::{
    domain::{identity::EntityId, money::MoneyCents},
    storage::catalogue_preview::CatalogueContext,
};
use rusqlite::{Connection, OptionalExtension};
use serde_json::Value;
fn invalid() -> AppError {
    AppError::Protocol(ProtocolError::MalformedPayload)
}
fn guard(code: &str) -> AppError {
    AppError::Business(BusinessError::SaleGuard { code: code.into() })
}
fn s(v: &Value) -> Result<&str, AppError> {
    v.as_str().ok_or_else(invalid)
}
fn money(v: &Value) -> Result<i64, AppError> {
    MoneyCents::parse_dto(s(v)?)
        .map(|v| v.cents())
        .map_err(|_| invalid())
}
fn dop(n: i64) -> String {
    let whole = (n / 100).to_string();
    let mut grouped = String::new();
    for (i, c) in whole.chars().enumerate() {
        if i > 0 && (whole.len() - i).is_multiple_of(3) {
            grouped.push(',')
        }
        grouped.push(c)
    }
    format!("RD$ {grouped}.{:02}", n % 100)
}
pub fn notice(
    c: &Connection,
    ctx: &CatalogueContext,
    family: &str,
    id: &str,
) -> Result<(String, String), AppError> {
    EntityId::parse(id).map_err(|_| invalid())?;
    let profile: Option<String> = c
        .query_row(
            "SELECT profile FROM native_business_profile_v1 WHERE tenant_id=?1",
            [&ctx.tenant_id],
            |r| r.get(0),
        )
        .optional()?;
    let profile: Value = profile
        .map(|v| serde_json::from_str(&v).map_err(|_| invalid()))
        .transpose()?
        .unwrap_or(Value::Null);
    let store = profile["name"]
        .as_str()
        .filter(|s| !s.is_empty())
        .unwrap_or(if family == "CREDIT" {
            "nuestro negocio"
        } else {
            "nuestra tienda"
        });
    let (phone, message) = match family {
        "REPAIR" => {
            let data = repairs::read(c, ctx)?;
            let r = data["rows"]
                .as_array()
                .ok_or_else(invalid)?
                .iter()
                .find(|r| r["id"] == id)
                .ok_or_else(invalid)?;
            if r["state"] != "listo" {
                return Err(guard("SERVICE_STATE_INVALID"));
            }
            if matches!(
                r["remoteStatus"].as_str(),
                Some("CONFLICT" | "INTERVENTION" | "DENIED")
            ) {
                return Err(guard("SERVICE_SYNC_CONFLICT"));
            }
            let d = &r["definition"];
            let balance = (money(&r["totalCents"])? - money(&r["paidCents"])?).max(0);
            let equipment = [s(&d["brand"])?, s(&d["model"])?]
                .into_iter()
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join(" ");
            let mut msg=format!("Hola {} 👋, le saluda *{}*.\n\nSu equipo *{}* ({}) ya está *listo* para retirar. ✅\n",s(&d["customerName"])?,store,equipment,s(&r["folio"])?);
            if balance > 0 {
                msg.push_str(&format!("Saldo pendiente: *{}*.\n", dop(balance)))
            }
            msg.push_str("\n¡Le esperamos!\n\n_Hecho con VentaRD_");
            (s(&d["phone"])?.to_owned(), msg)
        }
        "LAYAWAY" => {
            let data = layaways::read(c, ctx)?;
            let a = data["rows"]
                .as_array()
                .ok_or_else(invalid)?
                .iter()
                .find(|a| a["id"] == id)
                .ok_or_else(invalid)?;
            if a["state"] != "activo" {
                return Err(guard("SERVICE_STATE_INVALID"));
            }
            if matches!(
                a["remoteStatus"].as_str(),
                Some("CONFLICT" | "INTERVENTION" | "DENIED")
            ) {
                return Err(guard("SERVICE_SYNC_CONFLICT"));
            }
            let balance = (money(&a["totalCents"])? - money(&a["paidCents"])?).max(0);
            (s(&a["definition"]["phone"])?.to_owned(),format!("Hola {} 👋, le saluda *{}*.\n\nLe recordamos su apartado *{}*.\nTotal: *{}* · Abonado: *{}*\n{}\n_Hecho con VentaRD_",s(&a["definition"]["customerName"])?,store,s(&a["folio"])?,dop(money(&a["totalCents"])?),dop(money(&a["paidCents"])?),if balance>0{format!("Saldo pendiente: *{}*.\n",dop(balance))}else{"Ya está saldado, ¡puede pasar a retirarlo! ✅\n".into()}))
        }
        "CREDIT" => {
            let a = management::customer(c, ctx, id)?;
            let amount = money(&a["balanceCents"])?;
            if amount <= 0 {
                return Err(guard("CREDIT_OVERPAY"));
            }
            (a["phone"].as_str().unwrap_or("").to_owned(),format!("Hola {}, te contactamos de {}. Tu saldo pendiente actual es de {}. Por favor, acércate a realizar un abono cuando puedas. ¡Gracias!",s(&a["name"])?,store,dop(amount)))
        }
        _ => return Err(invalid()),
    };
    let digits = phone
        .chars()
        .filter(|c| c.is_ascii_digit())
        .collect::<String>();
    if !(7..=15).contains(&digits.len()) {
        return Err(guard("CONTACT_PHONE_INVALID"));
    }
    let digits = if digits.len() == 10 {
        format!("1{digits}")
    } else {
        digits
    };
    Ok((digits, message))
}
