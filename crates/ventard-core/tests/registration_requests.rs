#![cfg(feature = "encrypted-storage")]
use std::fs;
use ventard_core::security::registration_requests::{load_or_create, renew};
#[test]
fn policy_renewal_preserves_previous_request_and_reuses_persisted_new_id_after_restart() {
    let root = std::env::temp_dir().join(format!(
        "ventard-registration-test-{}",
        uuid::Uuid::new_v4()
    ));
    fs::create_dir(&root).unwrap();
    let pointer = root.join("registration.json");
    let original = load_or_create(&pointer).unwrap();
    let previous_bytes = fs::read(&pointer).unwrap();
    assert_eq!(load_or_create(&pointer).unwrap(), original);
    let new_id = renew(&pointer, &original).unwrap();
    assert_ne!(new_id, original);
    assert_eq!(load_or_create(&pointer).unwrap(), new_id);
    assert_eq!(
        fs::read(root.join(format!("registration.previous-{original}.json"))).unwrap(),
        previous_bytes
    );
    assert!(renew(&pointer, &original).is_err());
    assert_eq!(load_or_create(&pointer).unwrap(), new_id);
    // Cleanup only the exact newly-created test directory, containing no user data.
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn malformed_pointer_is_not_replaced_and_archive_conflict_leaves_current_identity_intact() {
    let root = std::env::temp_dir().join(format!(
        "ventard-registration-test-{}",
        uuid::Uuid::new_v4()
    ));
    fs::create_dir(&root).unwrap();
    let pointer = root.join("registration.json");
    fs::write(&pointer, b"bad").unwrap();
    assert!(load_or_create(&pointer).is_err());
    assert_eq!(fs::read(&pointer).unwrap(), b"bad");
    fs::remove_file(&pointer).unwrap();
    let original = load_or_create(&pointer).unwrap();
    fs::write(
        root.join(format!("registration.previous-{original}.json")),
        b"conflict",
    )
    .unwrap();
    assert!(renew(&pointer, &original).is_err());
    assert_eq!(load_or_create(&pointer).unwrap(), original);
    fs::remove_dir_all(root).unwrap();
}
