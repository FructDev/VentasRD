#![cfg(feature = "encrypted-storage")]
use serde_json::{json, Value};
use ventard_core::storage::legacy_inventory_proof as proof;
fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/legacy-inventory-proof.json")).unwrap()
}
#[test]
#[ignore = "Requires an authorized synthetic Staging read-only ledger sample"]
fn actual_staging_ledger_decodes_without_float_or_scope_loss() {
    let path = std::env::var("VENTARD_STAGING_INVENTORY_SAMPLE")
        .expect("explicit Staging fixture path required");
    let raw = std::fs::read_to_string(path).unwrap();
    let start = raw.find('{').expect("CLI JSON required");
    let response: Value = serde_json::from_str(&raw[start..]).unwrap();
    let rows = proof::parse_rows(
        response["rows"][0]["raw_ledger"]
            .as_str()
            .expect("scoped raw ledger JSON required"),
    )
    .expect("actual ledger must match the native contract");
    assert!(!rows.is_empty());
    for row in &rows {
        assert_eq!(row.tenant_id(), "96000000-0000-4000-8000-000000000001");
    }
    println!("PASS scoped Staging ledger rows: {}", rows.len());
}
#[test]
fn original_web_payload_and_real_postgres_ledger_are_exact_evidence_only_for_inventory() {
    let f = fixture();
    let ledger = proof::parse_rows(f["rawLedgerRows"].as_str().unwrap()).unwrap();
    for (index, row) in ledger.iter().enumerate() {
        let local = &f["fixtures"][index]["local"];
        assert_eq!(
            proof::reconstruct(local).unwrap(),
            f["fixtures"][index]["canonical"]
        );
        let result = proof::classify(local, Some(row));
        assert_eq!(result["status"], "APPLIED_VERIFIED");
        assert_eq!(
            result["receipt"]["remoteSequence"],
            if index == 0 {
                "9007199254740993"
            } else {
                "9007199254740994"
            }
        );
        assert_eq!(
            result["receipt"]["stockAfter"],
            if index == 0 { "8" } else { "5" }
        );
    }
}
#[test]
fn flags_cached_receipts_absence_and_changed_payloads_never_prove_complete_application() {
    let f = fixture();
    let row = proof::parse_rows(f["rawLedgerRows"].as_str().unwrap())
        .unwrap()
        .remove(0);
    let mut local = f["fixtures"][0]["local"].clone();
    assert_eq!(proof::classify(&local, None)["status"], "UNKNOWN_LEGACY");
    local["estado_sincronizacion"] = json!(1);
    local["remote_receipt"] = json!({"outcome":"APPLIED"});
    assert_eq!(proof::classify(&local, None)["status"], "UNKNOWN_LEGACY");
    local["delta"] = json!(-3);
    assert_eq!(proof::classify(&local, Some(&row))["status"], "CONFLICT");
    use sha2::{Digest, Sha256};
    local["payload_hash"] = json!(format!(
        "{:x}",
        Sha256::digest(proof::reconstruct(&local).unwrap().as_bytes())
    ));
    assert_eq!(
        proof::classify(&local, Some(&row))["code"],
        "REMOTE_PAYLOAD_MISMATCH"
    );
    local = f["fixtures"][0]["local"].clone();
    local.as_object_mut().unwrap().remove("payload_hash");
    assert_eq!(
        proof::classify(&local, Some(&row))["status"],
        "UNKNOWN_LEGACY"
    );
    local = f["fixtures"][0]["local"].clone();
    local["delta"] = json!(-2.5);
    assert_eq!(
        proof::classify(&local, Some(&row))["status"],
        "UNKNOWN_LEGACY"
    );
}
#[test]
fn malformed_or_tampered_ledger_is_rejected_before_it_can_be_persisted_as_proof() {
    let f = fixture();
    let original: Value = serde_json::from_str(f["rawLedgerRows"].as_str().unwrap()).unwrap();
    for (key, v) in [
        ("payload_hash", json!("a".repeat(64))),
        ("stock_after", json!(7)),
        ("effect_value", json!(-2.5)),
        ("authority_kind", json!("GLOBAL")),
        ("applied_at", json!("2026-02-31T25:90:00Z")),
        ("expected_remote_sequence", json!(1)),
        ("remote_sequence", json!(0)),
    ] {
        let mut raw = original.clone();
        raw[0][key] = v;
        assert!(proof::parse_rows(&raw.to_string()).is_err(), "{key}");
    }
    for key in ["sucursal_id", "referencia_id", "expected_remote_sequence"] {
        let mut raw = original.clone();
        raw[0].as_object_mut().unwrap().remove(key);
        assert!(
            proof::parse_rows(&raw.to_string()).is_err(),
            "{key} must be explicit"
        );
    }
}
