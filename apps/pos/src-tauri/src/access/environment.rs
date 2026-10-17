//! Immutable build targets. A production package cannot use QA trust or fixtures.
use super::*;
#[cfg(not(feature = "production-pilot"))]
pub const PROJECT_REF: &str = "blzzinivvzadqjbnpsre";
#[cfg(feature = "production-pilot")]
pub const PROJECT_REF: &str = "oxbekqoecunsbjheqgqg";
#[cfg(not(feature = "production-pilot"))]
pub const HOST: &str = "https://blzzinivvzadqjbnpsre.supabase.co";
#[cfg(feature = "production-pilot")]
pub const HOST: &str = "https://oxbekqoecunsbjheqgqg.supabase.co";
#[cfg(not(feature = "production-pilot"))]
pub const HOSTED_ISSUER: &str =
    "https://blzzinivvzadqjbnpsre.supabase.co/functions/v1/native-provision-staging";
#[cfg(feature = "production-pilot")]
pub const HOSTED_ISSUER: &str =
    "https://oxbekqoecunsbjheqgqg.supabase.co/functions/v1/native-provision";
#[cfg(not(feature = "production-pilot"))]
pub const ISSUER: &str = "http://127.0.0.1:3107/api/native/provision";
#[cfg(feature = "production-pilot")]
pub const ISSUER: &str = HOSTED_ISSUER;
#[cfg(not(feature = "production-pilot"))]
pub const TENANTS: &[&str] = &[
    "96000000-0000-4000-8000-000000000001",
    "96000000-0000-4000-8000-000000000002",
    "96000000-0000-4000-8000-000000000003",
];
#[cfg(feature = "production-pilot")]
pub const TENANTS: &[&str] = &["864d08e5-2975-4b2d-a1e2-ba5a14f3d677"];
pub const NAME: &str = if cfg!(feature = "production-pilot") {
    "production-pilot"
} else {
    "staging"
};
pub const CONFIG_FILE: &str = if cfg!(feature = "production-pilot") {
    "public-production-config.json"
} else {
    "public-staging-config.json"
};
pub const AUDIENCE: &str = if cfg!(feature = "production-pilot") {
    "ventard.native.production.v1"
} else {
    "ventard.native.staging.v1"
};
pub const LICENSE_VIEW: &str = if cfg!(feature = "production-pilot") {
    "native_entitlements_v1"
} else {
    "native_staging_licenses_v1"
};
pub fn production_config() -> Result<Config, AccessError> {
    let config: Config = serde_json::from_str(
        option_env!("VENTARD_PRODUCTION_PUBLIC_CONFIG").ok_or(error("ACCESS_NOT_CONFIGURED"))?,
    )
    .map_err(|_| error("ACCESS_CONFIG_INVALID"))?;
    if config.issuer_url != HOSTED_ISSUER
        || config.web_origin.as_deref() != Some("https://ventard.vercel.app")
        || !config.key_id.starts_with("production-")
    {
        return Err(error("ACCESS_CONFIG_INVALID"));
    }
    Ok(config)
}
pub fn validate_production_config(config: &Config) -> Result<(), AccessError> {
    if cfg!(feature = "production-pilot") {
        let pinned = production_config()?;
        if serde_json::to_value(config).ok() != serde_json::to_value(pinned).ok() {
            return Err(error("ACCESS_CONFIG_INVALID"));
        }
    }
    Ok(())
}
#[cfg(all(test, feature = "production-pilot"))]
mod tests {
    use super::*;
    #[test]
    fn production_target_has_no_qa_or_loopback_fallback() {
        assert_eq!(PROJECT_REF, "oxbekqoecunsbjheqgqg");
        assert_eq!(ISSUER, HOSTED_ISSUER);
        assert!(!TENANTS.iter().any(|s| s.starts_with("96000000")));
        assert_eq!(CONFIG_FILE, "public-production-config.json");
        if option_env!("VENTARD_PRODUCTION_PUBLIC_CONFIG").is_none() {
            assert_eq!(
                production_config().err().unwrap().code,
                "ACCESS_NOT_CONFIGURED"
            )
        }
    }
}
