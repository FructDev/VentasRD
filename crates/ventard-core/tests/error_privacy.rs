#![cfg(any(feature = "fixture-storage", feature = "encrypted-storage"))]

use ventard_core::application::errors::{AppError, BusinessError, ProtocolError};

#[test]
fn storage_errors_do_not_export_raw_sql_paths_or_secrets() {
    let error =
        AppError::Storage("SELECT secret FROM clients; C:/private/token=do-not-export".into());
    let json = serde_json::to_string(&error.safe_response()).unwrap();
    assert_eq!(error.code(), "LOCAL_STORAGE_IO");
    for sensitive in ["SELECT", "private", "token", "do-not-export"] {
        assert!(!json.contains(sensitive));
    }
}

#[test]
fn business_messages_are_not_serialized_as_diagnostics() {
    let error = AppError::Business(BusinessError::Conflict {
        message: "client@example.test PIN=9999 IMEI=123456789012345".into(),
    });
    assert_eq!(error.code(), "VERSION_CONFLICT");
    let json = serde_json::to_string(&error.safe_response()).unwrap();
    assert!(!json.contains("client@example"));
    assert!(!json.contains("9999"));
    assert!(!json.contains("123456789012345"));
    assert_eq!(error.to_string(), "VERSION_CONFLICT");
}

#[test]
fn identity_conflict_and_storage_full_are_distinct_and_not_retryable() {
    let conflict = AppError::Protocol(ProtocolError::OperationIdConflict);
    let full = AppError::Storage("LOCAL_STORAGE_FULL".into());
    assert_eq!(conflict.code(), "OPERATION_ID_CONFLICT");
    assert_eq!(full.code(), "LOCAL_STORAGE_FULL");
    assert!(!conflict.safe_response().retryable);
    assert!(!full.safe_response().retryable);
}
