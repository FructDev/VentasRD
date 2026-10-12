#![cfg(feature = "encrypted-storage")]
use ed25519_dalek::{Signer, SigningKey};
use serde_json::json;
use ventard_core::{
    domain::canonical::canonicalize,
    security::{
        access_cache::{load_grant, save_grant, CacheError},
        offline_grant::{GrantContext, TrustedGrantKey},
    },
    storage::{cipher::CipherKey, writer::VaultWriter},
};
fn context() -> GrantContext {
    GrantContext {
        tenant_id: "96000000-0000-4000-8000-000000000001".into(),
        actor_id: "96000000-0000-4000-8000-000000000051".into(),
        device_id: "96000000-0000-4000-8000-000000000011".into(),
        installation_id: "96000000-0000-4000-8000-000000000012".into(),
        writer_epoch: "1".into(),
        scope_type: "GLOBAL".into(),
        branch_id: None,
        min_grant_sequence: "1".into(),
        audience: "ventard.native.staging.v1".into(),
    }
}
fn key() -> TrustedGrantKey {
    TrustedGrantKey::new(
        "fixture-only",
        SigningKey::from_bytes(&[0x17; 32])
            .verifying_key()
            .to_bytes(),
    )
    .unwrap()
}
fn wire(seq: &str, active: bool) -> Vec<u8> {
    let c = context();
    let p = json!({"protocol":"ventard.offline-grant.v1","keyId":"fixture-only","issuer":"ventard.staging","audience":c.audience,"grantId":"96000000-0000-4000-8000-000000000010","grantSequence":seq,"policyVersion":"1","tenantId":c.tenant_id,"actorId":c.actor_id,"deviceId":c.device_id,"installationId":c.installation_id,"writerEpoch":c.writer_epoch,"scope":{"type":"GLOBAL","branchId":null},"role":"seller","capabilities":["READ","SELL"],"issuedAtMs":"1000","actorExpiresAtMs":null,"license":{"planActive":active,"accessUntilMs":null,"trialUntilMs":null,"graceDays":"5","warnAfterOpenings":"200","blockAfterOpenings":"300"}});
    let (bytes, _) = canonicalize(&serde_json::to_vec(&p).unwrap()).unwrap();
    let signature = SigningKey::from_bytes(&[0x17; 32])
        .sign(bytes.as_bytes())
        .to_bytes()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    serde_json::to_vec(&json!({"payload":p,"signature":signature})).unwrap()
}
#[test]
fn cache_is_encrypted_reverified_on_reopen_and_cannot_roll_back_or_change_same_sequence() {
    let dir = std::env::temp_dir().join(format!("ventard-access-fixture-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&dir).unwrap();
    let cipher = CipherKey::new([0x79; 32]);
    {
        let mut w = VaultWriter::create_encrypted(&dir, &cipher).unwrap();
        save_grant(w.connection(), &wire("1", true), &[key()], &context()).unwrap();
        save_grant(w.connection(), &wire("2", true), &[key()], &context()).unwrap();
        assert_eq!(
            save_grant(w.connection(), &wire("2", false), &[key()], &context()).unwrap_err(),
            CacheError::Conflict
        );
        assert!(save_grant(w.connection(), &wire("1", true), &[key()], &context()).is_err());
    }
    {
        let mut w = VaultWriter::open_encrypted(&dir, &cipher).unwrap();
        assert_eq!(
            load_grant(w.connection(), &[key()], &context())
                .unwrap()
                .payload()
                .grant_sequence,
            "2"
        );
        assert!(load_grant(w.connection(), &[], &context()).is_err());
        let mut other = context();
        other.actor_id = "96000000-0000-4000-8000-000000000099".into();
        assert_eq!(
            load_grant(w.connection(), &[key()], &other).unwrap_err(),
            CacheError::NotFound
        );
        assert_eq!(
            w.connection()
                .query_row("SELECT count(*) FROM sales", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
    let target = dir.canonicalize().unwrap();
    assert!(
        target.starts_with(std::env::temp_dir().canonicalize().unwrap())
            && target
                .file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .starts_with("ventard-access-fixture-")
    );
    std::fs::remove_dir_all(target).unwrap();
}
