//! Display information read with the authenticated actor's own RLS permissions.
//! Names and branding never supply a role, licence, grant or ticket header.
use super::*;
use ventard_core::storage::account_presentation::Profile;
fn name(v: &Value) -> Option<String> {
    v.as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty() && s.chars().count() <= 256 && !s.chars().any(char::is_control))
        .map(str::to_owned)
}
pub(super) fn auth_name(user: &Value) -> Option<String> {
    ["nombre", "full_name", "name"]
        .iter()
        .find_map(|k| name(&user["user_metadata"][k]))
}
fn only_row(data: &Value) -> Option<&Value> {
    let rows = data.as_array()?;
    if rows.len() == 1 {
        rows.first()
    } else {
        None
    }
}
fn logo_url(source: &str, tenant: &str) -> Option<reqwest::Url> {
    let mut url = reqwest::Url::parse(source).ok()?;
    if url.scheme() != "https"
        || url.host_str() != Some("res.cloudinary.com")
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    let (base, image) = url.path().split_once("/image/upload/")?;
    if base.is_empty() || base.trim_matches('/').contains('/') {
        return None;
    }
    let logo = format!("ventard/logos/{tenant}");
    if !["", ".png", ".jpg", ".jpeg", ".webp"].iter().any(|ext| {
        let suffix = format!("{logo}{ext}");
        image == suffix || image.ends_with(&format!("/{suffix}"))
    }) {
        return None;
    }
    url.set_path(&format!(
        "{base}/image/upload/c_limit,w_160,h_160/f_png/{image}"
    ));
    Some(url)
}
fn download_logo(source: &str, tenant: &str) -> Option<String> {
    let url = logo_url(source, tenant)?;
    let client = Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(3))
        .build()
        .ok()?;
    let r = client.get(url).header("accept", "image/png").send().ok()?;
    if r.status().as_u16() != 200 || r.content_length().is_some_and(|n| n > 98304) {
        return None;
    }
    let mut bytes = vec![];
    r.take(98305).read_to_end(&mut bytes).ok()?;
    if bytes.len() > 98304 {
        return None;
    }
    let data = format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    );
    ventard_core::application::product_media::validate(&data).ok()?;
    Some(data)
}
fn display_profile(
    tenant: &str,
    actor: &str,
    auth: Option<String>,
    business: &Value,
    member: &Value,
    branding: &Value,
    now: u64,
) -> Profile {
    let b = only_row(business).filter(|r| r["id"] == tenant);
    let m = only_row(member).filter(|r| r["negocio_id"] == tenant && r["user_id"] == actor);
    let brand = only_row(branding).filter(|r| r["id"] == tenant);
    Profile {
        tenant_id: tenant.into(),
        actor_id: actor.into(),
        actor_name: m.and_then(|r| name(&r["nombre"])).or(auth),
        business_name: b.and_then(|r| name(&r["nombre"])),
        logo: None,
        color: brand
            .and_then(|r| r["color_marca"].as_str())
            .filter(|c| {
                matches!(
                    *c,
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
            })
            .map(str::to_owned),
        font: brand
            .and_then(|r| r["fuente_marca"].as_str())
            .filter(|c| {
                matches!(
                    *c,
                    "syne" | "poppins" | "montserrat" | "spacegro" | "sora" | "outfit" | "playfair"
                )
            })
            .map(str::to_owned),
        captured_at_ms: now.to_string(),
    }
}
impl AccessState {
    pub(super) fn tenant_presentation(
        client: &Client,
        config: &Config,
        token: &str,
        tenant: &str,
        actor: &str,
        auth: Option<String>,
    ) -> Profile {
        let get = |path: String| -> Value {
            client
                .get(format!("{HOST}/rest/v1/{path}"))
                .header("apikey", &config.publishable_key)
                .bearer_auth(token)
                .send()
                .ok()
                .filter(|r| r.status().is_success())
                .and_then(|r| response(r).ok())
                .unwrap_or(Value::Null)
        };
        let business = get(format!("negocios?select=id,nombre&id=eq.{tenant}&limit=2"));
        let member=get(format!("usuarios_negocio?select=user_id,negocio_id,nombre&negocio_id=eq.{tenant}&user_id=eq.{actor}&activo=eq.true&limit=2"));
        let branding = get(format!(
            "negocios?select=id,logo_url,color_marca,fuente_marca&id=eq.{tenant}&limit=2"
        ));
        let mut p = display_profile(
            tenant,
            actor,
            auth,
            &business,
            &member,
            &branding,
            time().unwrap_or(0),
        );
        p.logo = only_row(&branding)
            .filter(|r| r["id"] == tenant)
            .and_then(|r| r["logo_url"].as_str())
            .and_then(|url| download_logo(url, tenant));
        p
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn profile_filters_foreign_rows_and_never_infers_permissions() {
        let n = "96500000-0000-4000-8000-000000000001";
        let a = "96500000-0000-4000-8000-000000000002";
        let p = display_profile(
            n,
            a,
            None,
            &json!([{"id":n,"nombre":"Negocio QA","role":"owner"}]),
            &json!([{"negocio_id":n,"user_id":a,"nombre":"Ana QA","role":"owner"}]),
            &Value::Null,
            2000,
        );
        assert_eq!(p.actor_name.as_deref(), Some("Ana QA"));
        assert_eq!(p.business_name.as_deref(), Some("Negocio QA"));
        assert!(serde_json::to_value(p).unwrap().get("role").is_none());
        let p = display_profile(
            n,
            a,
            None,
            &json!([{"id":a,"nombre":"Otro negocio"}]),
            &json!([{"negocio_id":n,"user_id":n,"nombre":"Otro usuario"}]),
            &Value::Null,
            2000,
        );
        assert!(p.actor_name.is_none());
        assert!(p.business_name.is_none());
    }
    #[test]
    fn business_logo_is_bound_to_original_cloudinary_tenant_path() {
        let n = "96500000-0000-4000-8000-000000000001";
        let url = format!("https://res.cloudinary.com/demo/image/upload/v1/ventard/logos/{n}.png");
        assert!(logo_url(&url, n).is_some());
        for bad in [
            url.replace("res.cloudinary.com", "127.0.0.1"),
            url.replace("res.cloudinary.com", "res.cloudinary.com.evil.test"),
            format!("{url}?token=secret"),
            url.replace(n, "96500000-0000-4000-8000-000000000002"),
        ] {
            assert!(logo_url(&bad, n).is_none());
        }
    }
}
