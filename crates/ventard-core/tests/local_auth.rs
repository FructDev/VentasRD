#![cfg(feature = "encrypted-storage")]
use ed25519_dalek::{Signer, SigningKey};
use serde_json::json;
use ventard_core::security::license_policy::{record_operational_open, OperationalLaunch};
use ventard_core::{
    domain::canonical::canonicalize,
    security::{
        local_auth::{enroll_pin, unlock_pin, PinError},
        offline_grant::{verify_grant, GrantContext, TrustedGrantKey, VerifiedGrant},
    },
    storage::{cipher::CipherKey, writer::VaultWriter},
};
use zeroize::Zeroizing;
const TENANT: &str = "96000000-0000-4000-8000-000000000050";
const ACTOR: &str = "96000000-0000-4000-8000-000000000051";
const DEVICE: &str = "96000000-0000-4000-8000-000000000052";
const INSTALL: &str = "96000000-0000-4000-8000-000000000053";
fn grant(actor: &str) -> VerifiedGrant {
    grant_variant(actor, false)
}
fn grant_variant(actor: &str, recovery_owner: bool) -> VerifiedGrant {
    let signer = SigningKey::from_bytes(&[0x17; 32]);
    let p = json!({"protocol":"ventard.offline-grant.v1","keyId":"test-key-1","issuer":"ventard.staging","audience":"ventard.native.staging.v1","grantId":"96000000-0000-4000-8000-000000000054","grantSequence":"1","policyVersion":"1","tenantId":TENANT,"actorId":actor,"deviceId":DEVICE,"installationId":INSTALL,"writerEpoch":"1","scope":{"type":"GLOBAL","branchId":null},"role":"seller","capabilities":["READ","SELL"],"issuedAtMs":"1000","actorExpiresAtMs":null,"license":{"planActive":true,"accessUntilMs":null,"trialUntilMs":null,"graceDays":"5","warnAfterOpenings":"200","blockAfterOpenings":"300"}});
    let mut p = p;
    if recovery_owner {
        p["role"] = json!("owner");
        p["capabilities"] = json!(["READ", "SELL", "MANAGE"]);
        p["actorExpiresAtMs"] = json!("3000");
    }
    let (c, _) = canonicalize(&serde_json::to_vec(&p).unwrap()).unwrap();
    let signature = signer
        .sign(c.as_bytes())
        .to_bytes()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    let ctx = GrantContext {
        tenant_id: TENANT.into(),
        actor_id: actor.into(),
        device_id: DEVICE.into(),
        installation_id: INSTALL.into(),
        writer_epoch: "1".into(),
        scope_type: "GLOBAL".into(),
        branch_id: None,
        min_grant_sequence: "1".into(),
        audience: "ventard.native.staging.v1".into(),
    };
    verify_grant(
        &serde_json::to_vec(&json!({"payload":p,"signature":signature})).unwrap(),
        &[TrustedGrantKey::new("test-key-1", signer.verifying_key().to_bytes()).unwrap()],
        &ctx,
    )
    .unwrap()
}
struct Fixture(std::path::PathBuf);
impl Fixture {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!("ventard-pin-fixture-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&p).unwrap();
        Self(p)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let root = std::env::temp_dir().canonicalize().unwrap();
        let p = self.0.canonicalize().unwrap();
        assert!(
            p.starts_with(root)
                && p.file_name()
                    .unwrap()
                    .to_str()
                    .unwrap()
                    .starts_with("ventard-pin-fixture-")
        );
        std::fs::remove_dir_all(p).unwrap();
    }
}
fn pin(s: &str) -> Zeroizing<String> {
    Zeroizing::new(s.into())
}
#[test]
fn recovery_pin_keeps_rate_limits_and_never_renews_expired_operational_authority() {
    use ventard_core::security::local_auth::verify_recovery_pin;
    let f = Fixture::new();
    let key = CipherKey::new([0x79; 32]);
    let mut w = VaultWriter::create_encrypted(&f.0, &key).unwrap();
    let g = grant_variant(ACTOR, true);
    let c = w.connection();
    enroll_pin(c, &g, &pin("9876"), 2000).unwrap();
    assert!(unlock_pin(c, &g, &pin("9876"), 6000).is_err());
    for _ in 0..5 {
        assert_eq!(
            verify_recovery_pin(c, &g, &pin("0000"), 6000).unwrap_err(),
            PinError::Invalid
        )
    }
    assert_eq!(
        verify_recovery_pin(c, &g, &pin("9876"), 6001).unwrap_err(),
        PinError::RateLimited
    );
    verify_recovery_pin(c, &g, &pin("9876"), 36001).unwrap();
    assert!(unlock_pin(c, &g, &pin("9876"), 36001).is_err());
    assert_eq!(
        c.query_row("SELECT openings FROM local_access_runtime_v1", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert!(verify_recovery_pin(c, &grant(ACTOR), &pin("9876"), 36001).is_err());
}
#[test]
fn pin_is_salted_no_plaintext_or_default_and_survives_encrypted_reopen() {
    let f = Fixture::new();
    let key = CipherKey::new([0x71; 32]);
    {
        let mut w = VaultWriter::create_encrypted(&f.0, &key).unwrap();
        enroll_pin(w.connection(), &grant(ACTOR), &pin("9876"), 2000).unwrap();
        assert_eq!(
            enroll_pin(w.connection(), &grant(ACTOR), &pin("1234"), 2000).unwrap_err(),
            PinError::AlreadyEnrolled
        );
        let other = "96000000-0000-4000-8000-000000000099";
        enroll_pin(w.connection(), &grant(other), &pin("9876"), 2000).unwrap();
        let hashes = w
            .connection()
            .prepare("SELECT pin_hash FROM local_pin_credentials_v1 ORDER BY actor_id")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert!(hashes
            .iter()
            .all(|h| h.starts_with("$argon2id$v=19$m=19456,t=2,p=1$") && !h.contains("9876")));
        assert_ne!(hashes[0], hashes[1]);
    }
    let mut w = VaultWriter::open_encrypted(&f.0, &key).unwrap();
    assert!(
        unlock_pin(w.connection(), &grant(ACTOR), &pin("9876"), 2100)
            .unwrap()
            .allows("SELL")
    );
    assert_eq!(
        unlock_pin(w.connection(), &grant(ACTOR), &pin("1234"), 2100).unwrap_err(),
        PinError::Invalid
    );
}
#[test]
fn failed_attempts_commit_before_error_persist_on_reopen_and_clock_rollback_does_not_bypass() {
    let f = Fixture::new();
    let key = CipherKey::new([0x72; 32]);
    {
        let mut w = VaultWriter::create_encrypted(&f.0, &key).unwrap();
        enroll_pin(w.connection(), &grant(ACTOR), &pin("9876"), 2000).unwrap();
        for _ in 0..5 {
            assert_eq!(
                unlock_pin(w.connection(), &grant(ACTOR), &pin("1111"), 2100).unwrap_err(),
                PinError::Invalid
            );
        }
    }
    let mut w = VaultWriter::open_encrypted(&f.0, &key).unwrap();
    assert_eq!(
        unlock_pin(w.connection(), &grant(ACTOR), &pin("9876"), 2000).unwrap_err(),
        PinError::RateLimited
    );
    assert_eq!(
        unlock_pin(w.connection(), &grant(ACTOR), &pin("9876"), 32099).unwrap_err(),
        PinError::RateLimited
    );
    assert!(
        unlock_pin(w.connection(), &grant(ACTOR), &pin("9876"), 32100)
            .unwrap()
            .allows("SELL")
    );
}
#[test]
fn other_actor_bad_format_future_grant_and_license_counter_do_not_bypass() {
    let f = Fixture::new();
    let key = CipherKey::new([0x73; 32]);
    let mut w = VaultWriter::create_encrypted(&f.0, &key).unwrap();
    assert_eq!(
        enroll_pin(w.connection(), &grant(ACTOR), &pin("98x6"), 2000).unwrap_err(),
        PinError::Malformed
    );
    assert_eq!(
        enroll_pin(w.connection(), &grant(ACTOR), &pin("9876"), 999).unwrap_err(),
        PinError::Unauthorized
    );
    enroll_pin(w.connection(), &grant(ACTOR), &pin("9876"), 2000).unwrap();
    assert_eq!(
        unlock_pin(
            w.connection(),
            &grant("96000000-0000-4000-8000-000000000099"),
            &pin("9876"),
            2000
        )
        .unwrap_err(),
        PinError::NotEnrolled
    );
    w.connection()
        .execute("UPDATE local_access_runtime_v1 SET openings=301", [])
        .unwrap();
    let a = unlock_pin(w.connection(), &grant(ACTOR), &pin("9876"), 2100).unwrap();
    assert!(a.allows("READ"));
    assert!(!a.allows("SELL"));
    assert_eq!(
        w.connection()
            .query_row("SELECT count(*) FROM sales", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
}
#[test]
fn opening_is_once_per_native_launch_not_rerender_or_actor_switch() {
    let f = Fixture::new();
    let key = CipherKey::new([0x74; 32]);
    let launch = OperationalLaunch::new();
    {
        let mut w = VaultWriter::create_encrypted(&f.0, &key).unwrap();
        assert_eq!(
            record_operational_open(w.connection(), &grant(ACTOR), &launch, 2000).unwrap(),
            1
        );
        for _ in 0..10 {
            assert_eq!(
                record_operational_open(w.connection(), &grant(ACTOR), &launch, 2000).unwrap(),
                1
            );
        }
        assert_eq!(
            record_operational_open(
                w.connection(),
                &grant("96000000-0000-4000-8000-000000000099"),
                &launch,
                2000
            )
            .unwrap(),
            1
        );
    }
    let mut w = VaultWriter::open_encrypted(&f.0, &key).unwrap();
    assert_eq!(
        record_operational_open(w.connection(), &grant(ACTOR), &launch, 2100).unwrap(),
        1
    );
    assert_eq!(
        record_operational_open(
            w.connection(),
            &grant(ACTOR),
            &OperationalLaunch::new(),
            2100
        )
        .unwrap(),
        2
    );
    assert!(record_operational_open(
        w.connection(),
        &grant(ACTOR),
        &OperationalLaunch::new(),
        999
    )
    .is_ok());
    assert_eq!(
        w.connection()
            .query_row(
                "SELECT highwater_ms FROM local_access_runtime_v1",
                [],
                |r| r.get::<_, u64>(0)
            )
            .unwrap(),
        2100
    );
}
#[test]
fn additive_access_upgrade_preserves_v1_rows_and_original_checksum() {
    let f = Fixture::new();
    let key = CipherKey::new([0x75; 32]);
    let original_checksum;
    {
        let mut w = VaultWriter::create_encrypted(&f.0, &key).unwrap();
        let c = w.connection();
        c.execute("INSERT INTO scopes(scope_key,type,sucursal_id,negocio_id) VALUES('preserved-v1','GLOBAL',NULL,?1)",[TENANT]).unwrap();
        original_checksum = c
            .query_row(
                "SELECT checksum FROM migration_history WHERE version=1",
                [],
                |r| r.get::<_, String>(0),
            )
            .unwrap();
        // Construct a valid historical v1 in this isolated synthetic fixture only.
        c.execute_batch("ALTER TABLE legacy_web_observation_plans_v1 DROP COLUMN source_kind;DROP TABLE fiscal_requests_v2;DROP TABLE local_operational_openings_v1;DROP TABLE local_pin_credentials_v1;DROP TABLE local_access_runtime_v1;DELETE FROM migration_history WHERE version>1;PRAGMA user_version=1;").unwrap();
    }
    let mut w = VaultWriter::open_encrypted(&f.0, &key).unwrap();
    assert_eq!(
        w.connection()
            .query_row("PRAGMA user_version", [], |r| r.get::<_, u32>(0))
            .unwrap(),
        34
    );
    assert_eq!(
        w.connection()
            .query_row(
                "SELECT checksum FROM migration_history WHERE version=1",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        original_checksum
    );
    assert_eq!(
        w.connection()
            .query_row(
                "SELECT negocio_id FROM scopes WHERE scope_key='preserved-v1'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        TENANT
    );
    assert_eq!(
        unlock_pin(w.connection(), &grant(ACTOR), &pin("1234"), 2000).unwrap_err(),
        PinError::NotEnrolled
    );
}
