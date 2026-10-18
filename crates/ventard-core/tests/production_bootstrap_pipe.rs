#![cfg(feature = "encrypted-storage")]
//! Explicit isolated PostgreSQL -> SQLCipher rehearsal. JSON travels only on
//! stdin; the temporary database uses a random ephemeral key, never a live PIN.
use serde_json::Value;
use ventard_core::{
    application::sales_sync,
    domain::canonical::canonicalize,
    storage::{catalogue_preview::CatalogueContext, cipher::CipherKey,
        legacy_cutover, legacy_transition, writer::VaultWriter},
};

#[test]
#[ignore = "requires explicitly supplied isolated PostgreSQL packet over stdin"]
fn isolated_postgres_packet_preserves_full_pica_catalogue_and_original_history() {
    assert_eq!(std::env::var("VENTARD_ISOLATED_BOOTSTRAP_PIPE").as_deref(), Ok("1"));
    let packet: Value = serde_json::from_reader(std::io::stdin().lock()).expect("isolated packet");
    assert_eq!(packet["protocol"], "ventard.isolated.pica.bootstrap.1");
    let ctx: CatalogueContext = serde_json::from_value(packet["context"].clone()).unwrap();
    assert_eq!(ctx.tenant_id, "864d08e5-2975-4b2d-a1e2-ba5a14f3d677");
    let root = std::env::temp_dir().canonicalize().unwrap();
    let dir = root.join(format!("ventard-isolated-bootstrap-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&dir).unwrap();
    let mut bytes = [0u8; 32];getrandom::fill(&mut bytes).unwrap();
    let key = CipherKey::new(bytes);bytes.fill(0);
    let mut writer = VaultWriter::create_encrypted(&dir, &key).unwrap();
    let manifest = &packet["manifest"];
    let now = manifest["capturedAtMs"].as_str().unwrap().parse::<u64>().unwrap();
    sales_sync::begin_bootstrap(writer.connection(), &ctx, manifest, now).unwrap();
    for (index, page) in packet["pages"].as_array().unwrap().iter().enumerate() {
        sales_sync::stage_bootstrap_page(writer.connection(), &ctx, index, page.as_str().unwrap(), now).unwrap();
    }
    legacy_cutover::stage_resolution_history(writer.connection(), &ctx, &packet["history"]).unwrap();
    sales_sync::activate_bootstrap(writer.connection(), &ctx, now, &uuid::Uuid::new_v4().to_string()).unwrap();
    let snapshot = sales_sync::read(writer.connection(), &ctx).unwrap();
    let products = snapshot["products"].as_array().unwrap();
    assert_eq!(products.len(), 309);
    assert_eq!(products.iter().map(|p|p["stock"].as_str().unwrap().parse::<i64>().unwrap()).sum::<i64>(),7172);
    assert!(products.iter().all(|p|p["preview"]["stockVerifiable"]==true && p["costCents"].is_string()));
    assert_eq!(snapshot["inventorySummary"]["unknownCapitalProducts"],"0");
    assert_eq!(snapshot["pendingOperations"],"0");
    assert_eq!(snapshot["confirmedSales"],"0");
    let customers = snapshot["customers"].as_array().unwrap();
    assert_eq!(customers.iter().map(|c|c["balanceCents"].as_str().unwrap().parse::<i64>().unwrap()).sum::<i64>(),36897666);
    assert_eq!(legacy_transition::history(writer.connection(), &ctx,"",None,None,None,1).unwrap()["total"],"3056");
    for ticket in packet["sampleTickets"].as_array().unwrap() {
        let actual=legacy_transition::ticket(writer.connection(), &ctx,ticket["id"].as_str().unwrap()).unwrap();
        assert_eq!(canonicalize(actual.to_string().as_bytes()).unwrap().1,ticket["hash"].as_str().unwrap());
    }
    drop(writer);
    let mut writer=VaultWriter::open_encrypted(&dir,&key).unwrap();
    let reopened=sales_sync::read(writer.connection(),&ctx).unwrap();
    assert_eq!(canonicalize(snapshot.to_string().as_bytes()).unwrap().1,canonicalize(reopened.to_string().as_bytes()).unwrap().1);
    assert_eq!(legacy_transition::history(writer.connection(), &ctx,"",None,None,None,1).unwrap()["total"],"3056");
    drop(writer);
    // Delete only this newly created, canonical temporary child directory.
    let checked=dir.canonicalize().unwrap();assert_eq!(checked.parent(),Some(root.as_path()));
    assert!(checked.file_name().unwrap().to_str().unwrap().starts_with("ventard-isolated-bootstrap-"));
    std::fs::remove_dir_all(checked).unwrap();
}
