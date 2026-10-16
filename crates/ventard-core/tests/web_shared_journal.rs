#![cfg(feature = "encrypted-storage")]
use serde_json::Value;
use ventard_core::{
    application::sales_sync,
    storage::{catalogue_preview::CatalogueContext, cipher::CipherKey, writer::VaultWriter},
};

#[test]
#[ignore = "requires the explicitly generated isolated browser/PostgreSQL fixture"]
fn browser_and_native_journal_feed_converges_in_real_sqlcipher_without_replay() {
    let path =
        std::env::var("VENTARD_SHARED_WEB_FIXTURE").expect("explicit local synthetic fixture path");
    let data: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let context: CatalogueContext =
        serde_json::from_value(data["manifest"]["context"].clone()).unwrap();
    let now = data["manifest"]["capturedAtMs"]
        .as_str()
        .unwrap()
        .parse::<u64>()
        .unwrap();
    let root = std::env::temp_dir().join(format!(
        "ventard-shared-journal-fixture-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir(&root).unwrap();
    let key = CipherKey::new([0x57; 32]);
    let mut writer = VaultWriter::create_encrypted(&root, &key).unwrap();
    let c = writer.connection();
    sales_sync::begin_bootstrap(c, &context, &data["manifest"], now).unwrap();
    for (index, page) in data["pages"].as_array().unwrap().iter().enumerate() {
        sales_sync::stage_bootstrap_page(c, &context, index, page.as_str().unwrap(), now).unwrap()
    }
    sales_sync::activate_bootstrap(c, &context, now, &uuid::Uuid::new_v4().to_string()).unwrap();
    for event in data["feed"]["events"].as_array().unwrap() {
        sales_sync::receive_event(c, &context, event).unwrap()
    }
    let changes = c.total_changes();
    for event in data["feed"]["events"].as_array().unwrap() {
        sales_sync::receive_event(c, &context, event).unwrap()
    }
    assert_eq!(changes, c.total_changes());
    assert_eq!(
        c.query_row::<i64, _, _>("SELECT count(*) FROM sales", [], |r| r.get(0))
            .unwrap(),
        data["saleCount"].as_i64().unwrap()
    );
    assert_eq!(
        c.query_row::<String, _, _>(
            "SELECT effective_stock FROM stock_projections WHERE producto_id=?1",
            [data["productId"].as_str().unwrap()],
            |r| r.get(0)
        )
        .unwrap(),
        data["stock"].as_str().unwrap()
    );
    assert_eq!(
        c.query_row::<String, _, _>(
            "SELECT status FROM cash_turns WHERE turn_id=?1",
            [data["turnId"].as_str().unwrap()],
            |r| r.get(0)
        )
        .unwrap(),
        "CLOSED"
    );
    assert_eq!(c.query_row::<i64,_,_>("SELECT count(*) FROM native_management_records_v1 WHERE operation_id=?1 AND kind='SALE_RETURN'",[data["returnId"].as_str().unwrap()],|r|r.get(0)).unwrap(),1);
    for event in data["feed"]["events"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| e["snapshot"].is_string())
    {
        let raw: Vec<u8> = c
            .query_row(
                "SELECT snapshot_bytes FROM sale_ticket_snapshots_v1 WHERE operation_id=?1",
                [event["receipt"]["operationId"].as_str().unwrap()],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(raw, event["snapshot"].as_str().unwrap().as_bytes())
    }
    drop(writer);
    let mut reopened = VaultWriter::open_encrypted(&root, &key).unwrap();
    assert_eq!(
        reopened
            .connection()
            .query_row::<i64, _, _>("SELECT count(*) FROM sales", [], |r| r.get(0))
            .unwrap(),
        2
    );
    drop(reopened);
    std::fs::remove_dir_all(root).unwrap();
}
