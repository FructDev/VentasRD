#![cfg(feature = "encrypted-storage")]
use rusqlite::Connection;
use sha2::{Digest, Sha256};
use ventard_core::storage::{catalogue_preview::*, migrations};

fn context() -> CatalogueContext {
    CatalogueContext {
        tenant_id: "96000000-0000-4000-8000-000000000001".into(),
        actor_id: "96000000-0000-4000-8000-000000000002".into(),
        device_id: "96000000-0000-4000-8000-000000000003".into(),
        installation_id: "96000000-0000-4000-8000-000000000004".into(),
        writer_epoch: "1".into(),
        scope_type: "BRANCH".into(),
        branch_id: Some("96000000-0000-4000-8000-000000000005".into()),
    }
}
fn db() -> Connection {
    let mut c = Connection::open_in_memory().unwrap();
    migrations::apply(&mut c).unwrap();
    c
}
fn fixture(id: &str, name: &str) -> (Manifest, String) {
    let payload=serde_json::json!([{"id":"96000000-0000-4000-8000-000000000011","name":name,"code":null,"priceCents":"103","stock":null,"stockEvidence":"MISSING_BRANCH_AUTHORITY"}]).to_string();
    let manifest = Manifest {
        version: "ventard.native.catalogue.preview.1".into(),
        snapshot_id: id.into(),
        context: context(),
        captured_at_ms: "1000".into(),
        expires_at_ms: "86401000".into(),
        coverage: "CATALOGUE_PREVIEW_V1".into(),
        watermark: None,
        total_count: 1,
        pages: vec![PageDescriptor {
            index: 0,
            count: 1,
            byte_length: payload.len(),
            sha256: format!("{:x}", Sha256::digest(payload.as_bytes())),
        }],
    };
    (manifest, payload)
}
#[test]
fn interrupted_download_resumes_and_never_replaces_active_base() {
    let mut c = db();
    let ctx = context();
    let (m, p) = fixture("96000000-0000-4000-8000-000000000021", "Primero");
    begin(&mut c, &ctx, &m, 2000).unwrap();
    assert!(read(&c, &ctx).unwrap().is_none());
    assert!(activate(&mut c, &ctx, &m.snapshot_id).is_err());
    stage_page(&mut c, &ctx, &m.snapshot_id, 0, &p, 2000).unwrap();
    activate(&mut c, &ctx, &m.snapshot_id).unwrap();
    let (next, _) = fixture("96000000-0000-4000-8000-000000000022", "Segundo");
    begin(&mut c, &ctx, &next, 2000).unwrap();
    assert_eq!(
        pending(&c, &ctx, 2000).unwrap().unwrap().snapshot_id,
        next.snapshot_id
    );
    assert_eq!(read(&c, &ctx).unwrap().unwrap().products[0].name, "Primero");
    assert_eq!(missing_pages(&c, &ctx, &next.snapshot_id).unwrap(), vec![0]);
}
#[test]
fn exact_pages_replay_and_offline_read_preserve_unknown_stock() {
    let mut c = db();
    let ctx = context();
    let (m, p) = fixture("96000000-0000-4000-8000-000000000021", "Celular");
    begin(&mut c, &ctx, &m, 2000).unwrap();
    stage_page(&mut c, &ctx, &m.snapshot_id, 0, &p, 2000).unwrap();
    stage_page(&mut c, &ctx, &m.snapshot_id, 0, &p, 2000).unwrap();
    assert!(missing_pages(&c, &ctx, &m.snapshot_id).unwrap().is_empty());
    activate(&mut c, &ctx, &m.snapshot_id).unwrap();
    activate(&mut c, &ctx, &m.snapshot_id).unwrap();
    let view = read(&c, &ctx).unwrap().unwrap();
    assert_eq!(view.products[0].stock, None);
    assert_eq!(view.products[0].price_cents.as_deref(), Some("103"));
    assert_eq!(view.manifest.watermark, None);
}
#[test]
fn invalid_hash_scope_manifest_and_expired_capture_fail_closed() {
    let mut c = db();
    let ctx = context();
    let (m, p) = fixture("96000000-0000-4000-8000-000000000021", "Celular");
    let mut other = ctx.clone();
    other.tenant_id = "96000000-0000-4000-8000-000000000099".into();
    assert!(begin(&mut c, &other, &m, 2000).is_err());
    assert!(begin(&mut c, &ctx, &m, 86401001).is_err());
    begin(&mut c, &ctx, &m, 2000).unwrap();
    assert!(stage_page(
        &mut c,
        &ctx,
        &m.snapshot_id,
        0,
        &p.replace("Celular", "Alterado"),
        2000
    )
    .is_err());
    assert!(stage_page(&mut c, &other, &m.snapshot_id, 0, &p, 2000).is_err());
    assert!(stage_page(&mut c, &ctx, &m.snapshot_id, 0, &p, 86401001).is_err());
    assert_eq!(missing_pages(&c, &ctx, &m.snapshot_id).unwrap(), vec![0]);
    let mut incompatible = m.clone();
    incompatible.total_count = 2;
    assert!(begin(&mut c, &ctx, &incompatible, 2000).is_err());
    let mut ambiguous = m.clone();
    ambiguous.watermark = Some("0".into());
    assert!(begin(&mut c, &ctx, &ambiguous, 2000).is_err());
}
#[test]
fn duplicate_products_or_invalid_integer_money_do_not_activate() {
    for payload in [serde_json::json!([{"id":"96000000-0000-4000-8000-000000000011","name":"X","code":null,"priceCents":"1.03","stock":"1","stockEvidence":"POINT_IN_TIME"}]).to_string(),serde_json::json!([{"id":"96000000-0000-4000-8000-000000000011","name":"X","code":null,"priceCents":"103","stock":"1","stockEvidence":"POINT_IN_TIME"},{"id":"96000000-0000-4000-8000-000000000011","name":"X","code":null,"priceCents":"103","stock":"1","stockEvidence":"POINT_IN_TIME"}]).to_string()] {
        let mut c=db(); let ctx=context(); let (mut m,_)=fixture("96000000-0000-4000-8000-000000000021","X"); let n=serde_json::from_str::<Vec<serde_json::Value>>(&payload).unwrap().len(); m.total_count=n; m.pages[0].count=n;m.pages[0].byte_length=payload.len();m.pages[0].sha256=format!("{:x}",Sha256::digest(payload.as_bytes()));
        begin(&mut c,&ctx,&m,2000).unwrap(); let staged=stage_page(&mut c,&ctx,&m.snapshot_id,0,&payload,2000); assert!(staged.is_err()||activate(&mut c,&ctx,&m.snapshot_id).is_err()); assert!(read(&c,&ctx).unwrap().is_none());
    }
}
#[test]
fn preview_never_mutates_business_tables_and_cross_actor_reads_are_denied() {
    let mut c = db();
    let ctx = context();
    let before: i64 = c
        .query_row("SELECT count(*) FROM outbox", [], |r| r.get(0))
        .unwrap();
    let (m, p) = fixture("96000000-0000-4000-8000-000000000021", "Celular");
    begin(&mut c, &ctx, &m, 2000).unwrap();
    stage_page(&mut c, &ctx, &m.snapshot_id, 0, &p, 2000).unwrap();
    activate(&mut c, &ctx, &m.snapshot_id).unwrap();
    assert_eq!(
        c.query_row::<i64, _, _>("SELECT count(*) FROM products", [], |r| r.get(0))
            .unwrap(),
        0
    );
    assert_eq!(
        c.query_row::<i64, _, _>("SELECT count(*) FROM stock_projections", [], |r| r.get(0))
            .unwrap(),
        0
    );
    assert_eq!(
        c.query_row::<i64, _, _>("SELECT count(*) FROM outbox", [], |r| r.get(0))
            .unwrap(),
        before
    );
    let mut other = ctx;
    other.actor_id = "96000000-0000-4000-8000-000000000099".into();
    assert!(read(&c, &other).unwrap().is_none());
}
#[test]
fn empty_complete_catalogue_is_not_a_missing_download() {
    let mut c = db();
    let ctx = context();
    let (mut m, _) = fixture("96000000-0000-4000-8000-000000000021", "X");
    m.total_count = 0;
    m.pages.clear();
    begin(&mut c, &ctx, &m, 2000).unwrap();
    activate(&mut c, &ctx, &m.snapshot_id).unwrap();
    assert!(read(&c, &ctx).unwrap().unwrap().products.is_empty());
}

#[test]
fn ten_thousand_products_fifty_pages_preserve_order_and_integer_precision() {
    let mut c = db();
    let ctx = context();
    let (mut m, _) = fixture("96000000-0000-4000-8000-000000000021", "X");
    m.total_count = 10_000;
    m.pages.clear();
    let mut raw = Vec::new();
    for index in 0..50 {
        let rows:Vec<_>=(0..200).map(|n|serde_json::json!({"id":format!("96000000-0000-4000-8000-{:012}",1000+index*200+n),"name":format!("Producto {}",index*200+n),"code":null,"priceCents":"999999999999","stock":"2147483647","stockEvidence":"POINT_IN_TIME"})).collect();
        let p = serde_json::to_string(&rows).unwrap();
        m.pages.push(PageDescriptor {
            index,
            count: 200,
            byte_length: p.len(),
            sha256: format!("{:x}", Sha256::digest(p.as_bytes())),
        });
        raw.push(p);
    }
    begin(&mut c, &ctx, &m, 2000).unwrap();
    for (index, p) in raw.iter().enumerate() {
        stage_page(&mut c, &ctx, &m.snapshot_id, index, p, 2000).unwrap();
    }
    activate(&mut c, &ctx, &m.snapshot_id).unwrap();
    let view = read(&c, &ctx).unwrap().unwrap();
    assert_eq!(view.products.len(), 10_000);
    assert_eq!(
        view.products[9999].price_cents.as_deref(),
        Some("999999999999")
    );
    assert_eq!(view.products[9999].stock.as_deref(), Some("2147483647"));
}

#[test]
fn encrypted_pending_and_active_capture_survive_reopening_without_network() {
    use ventard_core::storage::{cipher::CipherKey, writer::VaultWriter};
    let path = std::env::temp_dir().join(format!(
        "ventard-catalogue-fixture-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir(&path).unwrap();
    let key = CipherKey::new([0x46; 32]);
    let ctx = context();
    let (m, p) = fixture(
        "96000000-0000-4000-8000-000000000021",
        "Encrypted fixture only",
    );
    {
        let mut writer = VaultWriter::create_encrypted(&path, &key).unwrap();
        begin(writer.connection(), &ctx, &m, 2000).unwrap();
        stage_page(writer.connection(), &ctx, &m.snapshot_id, 0, &p, 2000).unwrap();
    }
    {
        let mut writer = VaultWriter::open_encrypted(&path, &key).unwrap();
        assert!(missing_pages(writer.connection(), &ctx, &m.snapshot_id)
            .unwrap()
            .is_empty());
        activate(writer.connection(), &ctx, &m.snapshot_id).unwrap();
    }
    {
        let mut writer = VaultWriter::open_encrypted(&path, &key).unwrap();
        assert_eq!(
            read(writer.connection(), &ctx).unwrap().unwrap().products[0].name,
            "Encrypted fixture only"
        );
    }
    let bytes = std::fs::read(path.join("pos_core.db")).unwrap();
    assert!(!bytes.windows(22).any(|w| w == b"Encrypted fixture only"));
    // Only the unique synthetic directory created above; never appData/user vaults.
    let absolute = path.canonicalize().unwrap();
    assert!(
        absolute.starts_with(std::env::temp_dir().canonicalize().unwrap())
            && absolute
                .file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .starts_with("ventard-catalogue-fixture-")
    );
    std::fs::remove_dir_all(absolute).unwrap();
}

#[test]
fn older_capture_cannot_replace_a_newer_visible_capture() {
    let mut c = db();
    let ctx = context();
    let (a, pa) = fixture("96000000-0000-4000-8000-000000000021", "Anterior");
    let (mut b, pb) = fixture("96000000-0000-4000-8000-000000000022", "Nueva");
    b.captured_at_ms = "2000".into();
    b.expires_at_ms = "86402000".into();
    for (m, p) in [(&a, &pa), (&b, &pb)] {
        begin(&mut c, &ctx, m, 3000).unwrap();
        stage_page(&mut c, &ctx, &m.snapshot_id, 0, p, 3000).unwrap();
    }
    activate(&mut c, &ctx, &b.snapshot_id).unwrap();
    assert!(activate(&mut c, &ctx, &a.snapshot_id).is_err());
    assert_eq!(read(&c, &ctx).unwrap().unwrap().products[0].name, "Nueva");
}

#[test]
fn capture_created_during_network_request_keeps_expiry_strict() {
    let mut c = db();
    let ctx = context();
    let (m, _) = fixture("96000000-0000-4000-8000-000000000021", "X");
    begin(&mut c, &ctx, &m, 1001).unwrap(); // response received after server capture
    assert!(begin(&mut c, &ctx, &m, 86_401_000).is_err()); // expiry still enforced
}

#[test]
fn ordinary_clock_skew_is_bounded_and_does_not_extend_capture_expiry() {
    let mut c = db();
    let ctx = context();
    let (mut m, p) = fixture("96000000-0000-4000-8000-000000000021", "X");
    m.captured_at_ms = "10000".into();
    m.expires_at_ms = "86410000".into();
    begin(&mut c, &ctx, &m, 9678).unwrap(); // device behind reference by measured ~322ms
    stage_page(&mut c, &ctx, &m.snapshot_id, 0, &p, 9680).unwrap();
    assert_eq!(
        pending(&c, &ctx, 9678).unwrap().unwrap().snapshot_id,
        m.snapshot_id
    );
    begin(&mut c, &ctx, &m, 5000).unwrap(); // exactly the 5s creation bound
    assert_eq!(
        begin(&mut c, &ctx, &m, 4999).unwrap_err().code(),
        "CATALOGUE_CLOCK_SKEW"
    );
    assert_eq!(
        stage_page(&mut c, &ctx, &m.snapshot_id, 0, &p, 4999)
            .unwrap_err()
            .code(),
        "CATALOGUE_CLOCK_SKEW"
    );
    assert_eq!(
        begin(&mut c, &ctx, &m, 86410000).unwrap_err().code(),
        "CATALOGUE_CAPTURE_EXPIRED"
    );
    assert_eq!(
        stage_page(&mut c, &ctx, &m.snapshot_id, 0, &p, 86410000)
            .unwrap_err()
            .code(),
        "CATALOGUE_CAPTURE_EXPIRED"
    );
    assert!(pending(&c, &ctx, 86410000).unwrap().is_none());
    assert!(read(&c, &ctx).unwrap().is_none()); // no business activation
}
