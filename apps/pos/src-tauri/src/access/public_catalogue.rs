use super::*;
pub(super) fn valid_web_origin(s: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(s) else {
        return false;
    };
    s.len() <= 256
        && url.scheme() == "https"
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && url.path() == "/"
        && url.query().is_none()
        && url.fragment().is_none()
        && url.origin().ascii_serialization() == s
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Remote {
    version: String,
    tenant_id: String,
    enabled: bool,
    revision: String,
    public_path: String,
}
pub(super) fn validate_remote(v: Value, tenant: &str) -> Result<Value, AccessError> {
    let r: Remote =
        serde_json::from_value(v.clone()).map_err(|_| error("CATALOGUE_RESPONSE_INVALID"))?;
    if r.version != "ventard.catalogue.publication.1"
        || r.tenant_id != tenant
        || r.public_path != format!("/catalogo/{tenant}")
        || r.revision
            .parse::<u32>()
            .ok()
            .is_none_or(|n| n > 2_147_483_647 || n.to_string() != r.revision)
    {
        return Err(error("CATALOGUE_RESPONSE_INVALID"));
    }
    let _ = r.enabled;
    Ok(v)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn web_origin_is_explicit_and_scoped_response_cannot_be_swapped() {
        assert!(valid_web_origin("https://staging.example.test"));
        for url in [
            "http://example.test",
            "https://user:pass@example.test",
            "https://example.test/catalogo",
            "https://example.test?x=1",
            "https://example.test/#x",
            "https://example.test/",
            "https://example.test:8443",
        ] {
            assert!(!valid_web_origin(url))
        }
        let v = json!({"version":"ventard.catalogue.publication.1","tenantId":TENANTS[0],"enabled":true,"revision":"1","publicPath":format!("/catalogo/{}",TENANTS[0])});
        assert!(validate_remote(v.clone(), TENANTS[0]).is_ok());
        assert!(validate_remote(v, TENANTS[1]).is_err());
    }
}
