#![cfg(feature = "encrypted-storage")]
use ed25519_dalek::{Signer, SigningKey};
use serde_json::{json, Value};
use ventard_core::{
    domain::canonical::canonicalize,
    security::offline_grant::{verify_grant, GrantContext, GrantError, TrustedGrantKey},
};
const TENANT: &str = "96000000-0000-4000-8000-000000000050";
const ACTOR: &str = "96000000-0000-4000-8000-000000000051";
const DEVICE: &str = "96000000-0000-4000-8000-000000000052";
const INSTALL: &str = "96000000-0000-4000-8000-000000000053";
fn signing() -> SigningKey {
    SigningKey::from_bytes(&[0x17; 32])
} // public fixture ONLY, never an app trust root
fn trusted() -> TrustedGrantKey {
    TrustedGrantKey::new("test-key-1", signing().verifying_key().to_bytes()).unwrap()
}
fn context() -> GrantContext {
    GrantContext {
        tenant_id: TENANT.into(),
        actor_id: ACTOR.into(),
        device_id: DEVICE.into(),
        installation_id: INSTALL.into(),
        writer_epoch: "1".into(),
        scope_type: "GLOBAL".into(),
        branch_id: None,
        min_grant_sequence: "1".into(),
        audience: "ventard.native.staging.v1".into(),
    }
}
fn payload() -> Value {
    json!({"protocol":"ventard.offline-grant.v1","keyId":"test-key-1","issuer":"ventard.staging","audience":"ventard.native.staging.v1","grantId":"96000000-0000-4000-8000-000000000054","grantSequence":"1","policyVersion":"1","tenantId":TENANT,"actorId":ACTOR,"deviceId":DEVICE,"installationId":INSTALL,"writerEpoch":"1","scope":{"type":"GLOBAL","branchId":null},"role":"owner","capabilities":["READ","SELL","INVENTORY_WRITE","MANAGE"],"issuedAtMs":"1000","actorExpiresAtMs":null,"license":{"planActive":true,"accessUntilMs":null,"trialUntilMs":null,"graceDays":"5","warnAfterOpenings":"200","blockAfterOpenings":"300"}})
}
fn signed(p: Value) -> Vec<u8> {
    let (c, _) = canonicalize(&serde_json::to_vec(&p).unwrap()).unwrap();
    let sig = signing().sign(c.as_bytes());
    let hex = sig
        .to_bytes()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    serde_json::to_vec(&json!({"payload":p,"signature":hex})).unwrap()
}
#[test]
fn pro_tier_is_signed_optional_and_never_inferred_from_plan_active() {
    let old = verify_grant(&signed(payload()), &[trusted()], &context()).unwrap();
    assert!(
        serde_json::to_value(old.evaluate(2000, 2000, 1).unwrap()).unwrap()["planTier"].is_null()
    );
    for tier in ["basico", "pro"] {
        let mut p = payload();
        p["license"]["planTier"] = json!(tier);
        let g = verify_grant(&signed(p), &[trusted()], &context()).unwrap();
        assert_eq!(
            serde_json::to_value(g.evaluate(2000, 2000, 1).unwrap()).unwrap()["planTier"],
            tier
        );
    }
    let mut p = payload();
    p["license"]["planTier"] = json!("premium");
    assert!(verify_grant(&signed(p), &[trusted()], &context()).is_err());
    let mut wire: Value = serde_json::from_slice(&signed(payload())).unwrap();
    wire["payload"]["license"]["planTier"] = json!("pro");
    assert_eq!(
        verify_grant(
            &serde_json::to_vec(&wire).unwrap(),
            &[trusted()],
            &context()
        )
        .unwrap_err(),
        GrantError::InvalidSignature
    );
}
#[test]
fn signed_grant_offline_is_independent_of_jwt_and_preserves_exact_policy() {
    let g = verify_grant(&signed(payload()), &[trusted()], &context()).unwrap();
    let a = g.evaluate(2000, 2000, 200).unwrap();
    assert!(a.allows("SELL"));
    assert!(!a.warn_connection);
    assert!(g.evaluate(2000, 2000, 201).unwrap().warn_connection);
    assert!(g.evaluate(2000, 2000, 300).unwrap().allows("SELL"));
    let blocked = g.evaluate(2000, 2000, 301).unwrap();
    assert!(!blocked.allows("SELL"));
    assert!(blocked.allows("READ"));
}
#[test]
fn signature_unknown_key_tamper_and_duplicate_fields_fail_closed() {
    let bytes = signed(payload());
    let mut wire: Value = serde_json::from_slice(&bytes).unwrap();
    wire["payload"]["role"] = json!("seller");
    assert_eq!(
        verify_grant(
            &serde_json::to_vec(&wire).unwrap(),
            &[trusted()],
            &context()
        )
        .unwrap_err(),
        GrantError::InvalidSignature
    );
    assert_eq!(
        verify_grant(&bytes, &[], &context()).unwrap_err(),
        GrantError::UnknownKey
    );
    let bad = b"{\"payload\":{},\"payload\":{},\"signature\":\"x\"}";
    assert!(verify_grant(bad, &[trusted()], &context()).is_err());
}
#[test]
fn tenant_actor_device_installation_epoch_scope_and_audience_are_bound() {
    for field in [
        "tenantId",
        "actorId",
        "deviceId",
        "installationId",
        "writerEpoch",
        "audience",
    ] {
        let mut p = payload();
        p[field] = if field == "writerEpoch" {
            json!("2")
        } else if field == "audience" {
            json!("other")
        } else {
            json!("96000000-0000-4000-8000-000000000099")
        };
        assert!(verify_grant(&signed(p), &[trusted()], &context()).is_err());
    }
    let mut p = payload();
    p["scope"] = json!({"type":"BRANCH","branchId":"96000000-0000-4000-8000-000000000099"});
    assert!(verify_grant(&signed(p), &[trusted()], &context()).is_err());
}
#[test]
fn seller_cannot_get_inventory_or_manage_even_with_a_signed_invalid_claim() {
    let mut p = payload();
    p["role"] = json!("seller");
    assert_eq!(
        verify_grant(&signed(p), &[trusted()], &context()).unwrap_err(),
        GrantError::InvalidClaims
    );
    let mut p = payload();
    p["role"] = json!("seller");
    p["capabilities"] = json!(["READ", "SELL"]);
    let g = verify_grant(&signed(p), &[trusted()], &context()).unwrap();
    assert!(g.evaluate(2000, 2000, 1).unwrap().allows("SELL"));
    assert!(!g.evaluate(2000, 2000, 1).unwrap().allows("INVENTORY_WRITE"));
}
#[test]
fn expiry_grace_fallback_no_date_and_clock_highwater_match_legacy() {
    let mut p = payload();
    p["license"]["accessUntilMs"] = json!("2000");
    let g = verify_grant(&signed(p), &[trusted()], &context()).unwrap();
    assert!(g.evaluate(2000, 2000, 0).unwrap().allows("SELL"));
    assert!(g
        .evaluate(2000 + 5 * 86400000, 2000, 0)
        .unwrap()
        .allows("SELL"));
    assert!(!g
        .evaluate(2001 + 5 * 86400000, 2000, 0)
        .unwrap()
        .allows("SELL"));
    assert!(!g
        .evaluate(1000, 2001 + 5 * 86400000, 0)
        .unwrap()
        .allows("SELL"));
    let mut p = payload();
    p["license"]["planActive"] = json!(false);
    p["license"]["trialUntilMs"] = json!("2000");
    assert!(verify_grant(&signed(p), &[trusted()], &context())
        .unwrap()
        .evaluate(2000, 0, 0)
        .unwrap()
        .allows("SELL"));
    let mut p = payload();
    p["license"]["planActive"] = json!(false);
    assert!(!verify_grant(&signed(p), &[trusted()], &context())
        .unwrap()
        .evaluate(2000, 0, 0)
        .unwrap()
        .allows("SELL"));
}
#[test]
fn authorization_expiry_is_not_extended_by_license_grace_and_grant_cannot_roll_back() {
    let mut p = payload();
    p["actorExpiresAtMs"] = json!("2000");
    assert!(!verify_grant(&signed(p), &[trusted()], &context())
        .unwrap()
        .evaluate(2001, 0, 0)
        .unwrap()
        .allows("SELL"));
    let mut c = context();
    c.min_grant_sequence = "2".into();
    assert_eq!(
        verify_grant(&signed(payload()), &[trusted()], &c).unwrap_err(),
        GrantError::StaleGrant
    );
}
#[test]
fn unknown_fields_short_lease_policy_and_noncanonical_numbers_are_rejected() {
    for (field, v) in [
        ("policyVersion", json!("2")),
        ("issuedAtMs", json!("01")),
        ("issuedAtMs", json!("99999999999999999")),
        ("grantSequence", json!("0")),
        ("unexpected", json!(true)),
    ] {
        let mut p = payload();
        p[field] = v;
        assert!(verify_grant(&signed(p), &[trusted()], &context()).is_err());
    }
    let mut p = payload();
    p["license"]["graceDays"] = json!("2");
    assert!(verify_grant(&signed(p), &[trusted()], &context()).is_err());
}
#[test]
fn unused_trial_date_must_also_be_canonical() {
    let mut p = payload();
    p["license"]["accessUntilMs"] = json!("3000");
    p["license"]["trialUntilMs"] = json!("01");
    assert!(verify_grant(&signed(p), &[trusted()], &context()).is_err());
}
