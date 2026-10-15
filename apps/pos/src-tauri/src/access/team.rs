//! Private online administration through fixed RPCs. No membership effects,
//! tokens, signed permissions or URLs are accepted from the renderer.
use super::*;
use ventard_core::{security::offline_grant::VerifiedGrant, storage::team as core};
fn authorize(g: &VerifiedGrant, high: u64, opens: u64) -> Result<(), AppError> {
    let now = time().map_err(|_| {
        AppError::Protocol(ventard_core::application::errors::ProtocolError::MalformedPayload)
    })?;
    if !g
        .evaluate(now, high, opens)
        .map_err(|_| {
            AppError::Protocol(ventard_core::application::errors::ProtocolError::MalformedPayload)
        })?
        .allows("MANAGE")
    {
        return Err(AppError::Auth(
            ventard_core::application::errors::AuthError::PermissionDenied {
                required: "MANAGE".into(),
            },
        ));
    }
    Ok(())
}
fn http(e: SalesHttpFailure) -> AccessError {
    error(match e {
        (401, _, _) => "ACCESS_LOGIN_REQUIRED",
        (403, _, _) => "TEAM_DENIED",
        (404, _, _) => "TEAM_MIGRATION_REQUIRED",
        (_, _, Some("TEAM_ID_CONFLICT")) => "TEAM_ID_CONFLICT",
        (_, _, Some("TEAM_VERSION")) => "TEAM_VERSION",
        (_, _, Some("TEAM_EMAIL_EXISTS")) => "TEAM_EMAIL_EXISTS",
        (_, _, Some("TEAM_PROTECTED")) => "TEAM_PROTECTED",
        _ => "TEAM_REMOTE_UNAVAILABLE",
    })
}
#[cfg(test)]mod tests{
 use super::*;
 #[test]fn team_requires_unlocked_owner_before_storage_network_or_links(){
  let state=AccessState::new(PathBuf::from("unused-team-fixture-path"));
  assert_eq!(state.team_read().err().unwrap().code,"ACCESS_PIN_REQUIRED");
  assert_eq!(state.team_send(None,false).err().unwrap().code,"ACCESS_PIN_REQUIRED");
  assert_eq!(state.team_share(TENANTS[0].into()).err().unwrap().code,"ACCESS_PIN_REQUIRED");
  assert!(serde_json::from_value::<SalesAction>(json!({"action":"TEAM_SHARE","operationId":TENANTS[0],"url":"https://foreign.example.test"})).is_err());
 }
}
impl AccessState {
    pub(super) fn team_share(&self, operation_id: String) -> Result<Value, AccessError> {
        id(&operation_id)?;
        let v = self.team_read()?;
        let receipt = &v["lastReceipt"];
        if receipt["operationId"] != operation_id || receipt["status"] != "APPLIED" {
            return Err(error("TEAM_LINK_CHANGED"));
        }
        let member = &receipt["member"];
        if member["pending"] != true
            || member["active"] != true
            || member["expiresAtMs"]
                .as_str()
                .and_then(|s| s.parse::<u64>().ok())
                .is_none_or(|t| t <= time().unwrap_or(u64::MAX))
            || v["remote"]["members"].as_array().is_none_or(|rows| {
                !rows
                    .iter()
                    .any(|m| m["id"] == member["id"] && m["version"] == member["version"])
            })
        {
            return Err(error("TEAM_LINK_CHANGED"));
        }
        let origin = v["webOrigin"]
            .as_str()
            .ok_or(error("CATALOGUE_WEB_REQUIRED"))?;
        let path = receipt["invitePath"]
            .as_str()
            .ok_or(error("TEAM_LINK_CHANGED"))?;
        let token = path
            .strip_prefix("/unirse?token=")
            .ok_or(error("TEAM_LINK_CHANGED"))?;
        id(token)?;
        let mut url = reqwest::Url::parse("https://wa.me/").map_err(|_|error("CONTACT_OPEN_FAILED"))?;
        url.query_pairs_mut().append_pair("text",&format!("Hola {}, aquí está tu acceso a VentaRD:\n\n{origin}{path}\n\nActiva tu cuenta con este enlace de un solo uso. Vence en 24 horas desde su creación.",member["name"].as_str().unwrap_or("")));
        use std::os::windows::process::CommandExt;
        std::process::Command::new("rundll32.exe")
            .arg("url.dll,FileProtocolHandler")
            .arg(url.as_str())
            .creation_flags(0x08000000)
            .spawn()
            .map_err(|_| error("CONTACT_OPEN_FAILED"))?;
        Ok(json!({"status":"DRAFT_REQUESTED"}))
    }
    pub(super) fn team_read(&self) -> Result<Value, AccessError> {
        self.deny_archive()?;
        let mut cached = self.sales_local(|c, ctx, g, hi, op| {
            authorize(&g, hi, op)?;
            core::local(c, &ctx)
        })?;
        let n = match self.sales_network() {
            Ok(n) => n,
            Err(e) if e.code == "ACCESS_LOGIN_REQUIRED" => {
                cached["remoteError"] = json!(e.code);
                return Ok(cached);
            }
            Err(e) => return Err(e),
        };
        cached["webOrigin"] = json!(n.config.web_origin);
        let response = Self::sales_rpc(
            &n,
            "native_team_read_v1",
            body(&n.selected.catalogue_context()),
        );
        self.sales_current(&n)?;
        match response {
            Ok(v) => {
                cached["remote"] =
                    core::remote(v, &n.selected.catalogue_context()).map_err(|e| error(e.code()))?
            }
            Err(e) => cached["remoteError"] = json!(http(e).code),
        }
        Ok(cached)
    }
    pub(super) fn team_send(
        &self,
        input: Option<core::Input>,
        cancel: bool,
    ) -> Result<Value, AccessError> {
        self.deny_archive()?;
        let _gate = self.team_gate.lock().map_err(|_| error("ACCESS_BUSY"))?;
        let (ctx, w) = self.sales_local(move |c, ctx, g, hi, opens| {
            authorize(&g, hi, opens)?;
            let input = input.or(core::pending(c, &ctx)?).ok_or(AppError::Business(
                ventard_core::application::errors::BusinessError::SaleGuard {
                    code: "TEAM_NO_PENDING".into(),
                },
            ))?;
            Ok((ctx.clone(), core::prepare(c, &ctx, input)?))
        })?;
        let n = self.sales_network()?;
        if n.selected.catalogue_context() != ctx {
            return Err(error("ACCESS_CONTEXT_CHANGED"));
        }
        let args = json!({"p_request":w.request,"p_hash":w.hash});
        let lookup = Self::sales_rpc(&n, "native_team_lookup_v1", args.clone()).map_err(http)?;
        self.sales_current(&n)?;
        let result = if core::not_found(&lookup, &w) {
            Self::sales_rpc(
                &n,
                if cancel {
                    "native_team_cancel_v1"
                } else {
                    "native_team_submit_v1"
                },
                args,
            )
            .map_err(http)?
        } else {
            lookup
        };
        self.sales_current(&n)?;
        self.sales_local(move |c, current, g, hi, opens| {
            authorize(&g, hi, opens)?;
            if current != ctx {
                return Err(AppError::Protocol(
                    ventard_core::application::errors::ProtocolError::MalformedPayload,
                ));
            }
            core::finish(c, &ctx, &w, &result)
        })
    }
}
