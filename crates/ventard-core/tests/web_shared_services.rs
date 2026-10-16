#![cfg(feature = "encrypted-storage")]
use serde_json::Value;
use ventard_core::{
    application::sales_sync,
    storage::{catalogue_preview::CatalogueContext, cipher::CipherKey, writer::VaultWriter},
};
#[test]
#[ignore = "requires the explicitly generated isolated browser/PostgreSQL service fixture"]
fn browser_services_deposit_refund_and_disassembly_converge_in_sqlcipher() {
    let data: Value = serde_json::from_slice(
        &std::fs::read(std::env::var("VENTARD_SHARED_SERVICE_FIXTURE").unwrap()).unwrap(),
    )
    .unwrap();
    let context: CatalogueContext =
        serde_json::from_value(data["manifest"]["context"].clone()).unwrap();
    let now = data["manifest"]["capturedAtMs"]
        .as_str()
        .unwrap()
        .parse::<u64>()
        .unwrap();
    let root = std::env::temp_dir().join(format!(
        "ventard-web-services-fixture-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir(&root).unwrap();
    let key = CipherKey::new([0x58; 32]);
    let mut writer = VaultWriter::create_encrypted(&root, &key).unwrap();
    let c = writer.connection();
    sales_sync::begin_bootstrap(c, &context, &data["manifest"], now).unwrap();
    for (index, page) in data["pages"].as_array().unwrap().iter().enumerate() {
        sales_sync::stage_bootstrap_page(c, &context, index, page.as_str().unwrap(), now).unwrap()
    }
    sales_sync::activate_bootstrap(c, &context, now, &uuid::Uuid::new_v4().to_string()).unwrap();
    for event in data["feed"]["events"].as_array().unwrap() {
        sales_sync::receive_event(c, &context, event)
            .unwrap_or_else(|error| panic!("{}: {:?}", event["receipt"]["operationId"], error))
    }
    let changes = c.total_changes();
    for event in data["feed"]["events"].as_array().unwrap() {
        sales_sync::receive_event(c, &context, event).unwrap()
    }
    assert_eq!(c.total_changes(), changes);
    assert_eq!(
        c.query_row::<String, _, _>(
            "SELECT effective_stock FROM stock_projections WHERE producto_id=?1",
            [data["productId"].as_str().unwrap()],
            |r| r.get(0)
        )
        .unwrap(),
        "1"
    );
    assert_eq!(c.query_row::<i64,_,_>("SELECT count(*) FROM native_management_records_v1 WHERE operation_id=?1 AND kind='SERVICE_REFUND'",[data["refundId"].as_str().unwrap()],|r|r.get(0)).unwrap(),1);
    let raw: String = c
        .query_row(
            "SELECT document FROM native_management_records_v1 WHERE kind='REPAIR_DISASSEMBLE'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let document: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(document["repair"]["paidCents"], "300");
    assert_eq!(document["repair"]["payments"].as_array().unwrap().len(), 3);
    assert_eq!(document["repair"]["state"], "cancelado");
    assert_eq!(
        c.query_row::<i64, _, _>("SELECT count(*) FROM sales", [], |r| r.get(0))
            .unwrap(),
        0
    );
    drop(writer);
    let mut reopened = VaultWriter::open_encrypted(&root, &key).unwrap();
    assert_eq!(
        reopened
            .connection()
            .query_row::<String, _, _>(
                "SELECT effective_stock FROM stock_projections WHERE producto_id=?1",
                [data["productId"].as_str().unwrap()],
                |r| r.get(0)
            )
            .unwrap(),
        "1"
    );
    drop(reopened);
    std::fs::remove_dir_all(root).unwrap();
}
