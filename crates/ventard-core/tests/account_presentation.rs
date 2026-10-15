#![cfg(feature = "encrypted-storage")]
use ventard_core::storage::{
    account_presentation as profile, cipher::CipherKey, writer::VaultWriter,
};
fn id(n: u32) -> String {
    format!("96500000-0000-4000-8000-{n:012}")
}
#[test]
fn presentation_is_encrypted_actor_scoped_and_never_grants_business_authority() {
    let root = std::env::temp_dir().join(format!(
        "ventard-presentation-fixture-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir(&root).unwrap();
    let key = CipherKey::new([0x73; 32]);
    let p:profile::Profile=serde_json::from_value(serde_json::json!({"tenantId":id(1),"actorId":id(2),"actorName":"Ana QA","businessName":"Negocio sintético","logo":null,"color":"cielo","font":"syne","capturedAtMs":"2000"})).unwrap();
    let mut w = VaultWriter::create_encrypted(&root, &key).unwrap();
    let c = w.connection();
    profile::save(c, &p).unwrap();
    let ctx = ventard_core::storage::catalogue_preview::CatalogueContext {
        tenant_id: id(1),
        actor_id: id(2),
        device_id: id(3),
        installation_id: id(4),
        writer_epoch: "1".into(),
        scope_type: "GLOBAL".into(),
        branch_id: None,
    };
    let defaults = ventard_core::application::settings::read(c, &ctx).unwrap();
    assert_eq!(defaults["definition"]["name"], "Negocio sintético");
    assert_eq!(defaults["definition"]["color"], "cielo");
    let changes = c.total_changes();
    profile::save(c, &p).unwrap();
    assert_eq!(changes, c.total_changes());
    assert!(profile::read(c, &id(1), &id(3)).unwrap().is_none());
    assert!(profile::read(c, &id(3), &id(2)).unwrap().is_none());
    for table in [
        "operation_journal",
        "outbox",
        "offline_grants",
        "cash_turns",
    ] {
        assert_eq!(
            c.query_row::<i64, _, _>(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
                .unwrap(),
            0
        );
    }
    let mut invalid = p.clone();
    invalid.actor_name = Some("nombre\nforjado".into());
    assert!(profile::save(c, &invalid).is_err());
    let mut forged = serde_json::to_value(&p).unwrap();
    forged["role"] = serde_json::json!("owner");
    assert!(serde_json::from_value::<profile::Profile>(forged).is_err());
    drop(w);
    let mut w = VaultWriter::open_encrypted(&root, &key).unwrap();
    assert_eq!(
        profile::read(w.connection(), &id(1), &id(2))
            .unwrap()
            .unwrap()
            .actor_name
            .as_deref(),
        Some("Ana QA")
    );
    let file = std::fs::read(root.join("pos_core.db")).unwrap();
    assert!(!file.windows(6).any(|w| w == b"Ana QA"));
}
#[test]
fn schema31_upgrade_preserves_prior_data_and_checksums() {
    let root = std::env::temp_dir().join(format!(
        "ventard-presentation-upgrade-fixture-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir(&root).unwrap();
    let key = CipherKey::new([0x74; 32]);
    let mut w = VaultWriter::create_encrypted(&root, &key).unwrap();
    let c = w.connection();
    let previous: String = c
        .query_row(
            "SELECT checksum FROM migration_history WHERE version=31",
            [],
            |r| r.get(0),
        )
        .unwrap();
    c.execute(
        "INSERT INTO scopes VALUES('GLOBAL','GLOBAL',NULL,?1)",
        [id(1)],
    )
    .unwrap();
    // Reconstruct only the immediately previous schema in an isolated fixture.
    c.execute_batch("DROP TABLE native_team_requests_v1;DROP TABLE native_account_presentation_v1;DELETE FROM migration_history WHERE version>=32;PRAGMA user_version=31;").unwrap();
    assert!(profile::read(c, &id(1), &id(2)).unwrap().is_none());
    drop(w);
    let mut w = VaultWriter::open_encrypted(&root, &key).unwrap();
    let c = w.connection();
    assert_eq!(
        c.query_row::<i64, _, _>("PRAGMA user_version", [], |r| r.get(0))
            .unwrap(),
        33
    );
    assert_eq!(
        c.query_row::<String, _, _>(
            "SELECT checksum FROM migration_history WHERE version=31",
            [],
            |r| r.get(0)
        )
        .unwrap(),
        previous
    );
    assert_eq!(
        c.query_row::<i64, _, _>("SELECT count(*) FROM scopes", [], |r| r.get(0))
            .unwrap(),
        1
    );
}
