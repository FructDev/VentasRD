#![cfg(feature = "encrypted-storage")]
use rusqlite::Connection;
use sha2::{Digest, Sha256};
use ventard_core::{
    application::drafts::*,
    storage::{catalogue_preview as catalogue, migrations},
};

fn context() -> catalogue::CatalogueContext {
    catalogue::CatalogueContext {
        tenant_id: id(1),
        actor_id: id(2),
        device_id: id(3),
        installation_id: id(4),
        writer_epoch: "1".into(),
        scope_type: "BRANCH".into(),
        branch_id: Some(id(5)),
    }
}
fn id(n: u32) -> String {
    format!("96000000-0000-4000-8000-{n:012}")
}
fn capture(c: &mut Connection, ctx: &catalogue::CatalogueContext, snapshot: u32) {
    let payload = serde_json::json!([
        {"id":id(11),"name":"Synthetic item","code":null,"priceCents":"103","stock":null,"stockEvidence":"MISSING_BRANCH_AUTHORITY"},
        {"id":id(12),"name":"Unknown price","code":null,"priceCents":null,"stock":"3","stockEvidence":"POINT_IN_TIME"}
    ]).to_string();
    let m = catalogue::Manifest {
        version: "ventard.native.catalogue.preview.1".into(),
        snapshot_id: id(snapshot),
        context: ctx.clone(),
        captured_at_ms: snapshot.to_string(),
        expires_at_ms: (snapshot as u64 + 86_400_000).to_string(),
        coverage: "CATALOGUE_PREVIEW_V1".into(),
        watermark: None,
        total_count: 2,
        pages: vec![catalogue::PageDescriptor {
            index: 0,
            count: 2,
            byte_length: payload.len(),
            sha256: format!("{:x}", Sha256::digest(payload.as_bytes())),
        }],
    };
    catalogue::begin(c, ctx, &m, 1000).unwrap();
    catalogue::stage_page(c, ctx, &m.snapshot_id, 0, &payload, 1000).unwrap();
    catalogue::activate(c, ctx, &m.snapshot_id).unwrap();
}
fn db() -> Connection {
    let mut c = Connection::open_in_memory().unwrap();
    migrations::apply(&mut c).unwrap();
    capture(&mut c, &context(), 21);
    c
}
#[test]
fn additive_v5_to_current_preserves_capture_hash_and_existing_scope() {
    use ventard_core::storage::{cipher::CipherKey, writer::VaultWriter};
    let path = std::env::temp_dir().join(format!(
        "ventard-account-draft-upgrade-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir(&path).unwrap();
    let key = CipherKey::new([0x3a; 32]);
    let original;
    {
        let mut w = VaultWriter::create_encrypted(&path, &key).unwrap();
        let c = w.connection();
        capture(c, &context(), 21);
        original = c
            .query_row(
                "SELECT manifest FROM catalogue_preview_manifests_v1",
                [],
                |r| r.get::<_, String>(0),
            )
            .unwrap();
        c.execute("INSERT INTO scopes(scope_key,type,sucursal_id,negocio_id)VALUES('existing-global','GLOBAL',NULL,?1)",[&context().tenant_id]).unwrap();
        // Only this unique synthetic vault: reproduce a tracked, complete v5.
        c.execute_batch("ALTER TABLE legacy_web_observation_plans_v1 DROP COLUMN source_kind;DROP TABLE fiscal_requests_v2;DROP TABLE fiscal_reservations;DROP TABLE fiscal_blocks;DROP TABLE fiscal_watermarks;DROP TABLE ticket_allocations;DROP TABLE ticket_sequences;DROP TABLE checkout_drafts;DROP TABLE cash_turns;DROP TABLE cash_drawers;DROP TABLE account_draft_requests;DROP TABLE account_drafts;DELETE FROM migration_history WHERE version>=6;PRAGMA user_version=5;").unwrap();
        migrations::validate_history(c).unwrap();
    }
    {
        let mut w = VaultWriter::open_encrypted(&path, &key).unwrap();
        let c = w.connection();
        assert_eq!(migrations::validate_history(c).unwrap(), 32);
        assert_eq!(
            c.query_row(
                "SELECT manifest FROM catalogue_preview_manifests_v1",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            original
        );
        assert_eq!(
            c.query_row::<i64, _, _>(
                "SELECT count(*) FROM scopes WHERE scope_key='existing-global'",
                [],
                |r| r.get(0)
            )
            .unwrap(),
            1
        );
        assert!(read(c, &context()).unwrap().active.is_none());
        assert!(save(c, &context(), request(30)).is_ok());
    }
    let absolute = path.canonicalize().unwrap();
    assert!(
        absolute.starts_with(std::env::temp_dir().canonicalize().unwrap())
            && absolute
                .file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .starts_with("ventard-account-draft-upgrade-")
    );
    std::fs::remove_dir_all(absolute).unwrap();
}
fn line(product: u32, quantity: &str) -> DraftLine {
    DraftLine {
        product_id: id(product),
        quantity: quantity.into(),
        revision: id(21),
        free: None,
    }
}
fn request(n: u32) -> DraftSave {
    DraftSave {
        request_id: id(n),
        cart_id: None,
        expected_revision: None,
        lines: vec![line(11, "2")],
    }
}
fn act(
    n: u32,
    action: DraftActionKind,
    cart: &DraftCart,
    active: Option<&DraftCart>,
) -> DraftAction {
    DraftAction {
        request_id: id(n),
        action,
        cart_id: cart.id.clone(),
        expected_revision: cart.revision.clone(),
        active_cart_id: active.map(|c| c.id.clone()),
        active_revision: active.map(|c| c.revision.clone()),
    }
}
fn business_counts(c: &Connection) -> Vec<i64> {
    [
        "products",
        "stock_projections",
        "operation_journal",
        "outbox",
    ]
    .iter()
    .map(|t| {
        c.query_row(&format!("SELECT count(*) FROM {t}"), [], |r| r.get(0))
            .unwrap()
    })
    .collect()
}

#[test]
fn durable_encrypted_cart_and_zero_commercial_effects() {
    use ventard_core::storage::{cipher::CipherKey, writer::VaultWriter};
    let path = std::env::temp_dir().join(format!("ventard-account-draft-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&path).unwrap();
    let key = CipherKey::new([0x39; 32]);
    {
        let mut w = VaultWriter::create_encrypted(&path, &key).unwrap();
        let c = w.connection();
        capture(c, &context(), 21);
        let before = business_counts(c);
        let result = save(c, &context(), request(30)).unwrap();
        assert_eq!(result.workspace.active.unwrap().lines, vec![line(11, "2")]);
        assert_eq!(business_counts(c), before);
    }
    {
        let mut w = VaultWriter::open_encrypted(&path, &key).unwrap();
        assert_eq!(
            read(w.connection(), &context()).unwrap().active.unwrap().id,
            id(30)
        );
        assert_eq!(
            catalogue::read(w.connection(), &context())
                .unwrap()
                .unwrap()
                .manifest
                .snapshot_id,
            id(21)
        );
    }
    assert!(!std::fs::read(path.join("pos_core.db"))
        .unwrap()
        .windows(14)
        .any(|b| b == b"Synthetic item"));
    let absolute = path.canonicalize().unwrap();
    assert!(
        absolute.starts_with(std::env::temp_dir().canonicalize().unwrap())
            && absolute
                .file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .starts_with("ventard-account-draft-")
    );
    std::fs::remove_dir_all(absolute).unwrap();
}
#[test]
fn replay_preserves_ack_but_returns_current_workspace_and_conflicting_identity_fails() {
    let mut c = db();
    let ctx = context();
    let first = save(&mut c, &ctx, request(30)).unwrap();
    let mut edit = request(31);
    edit.cart_id = Some(first.cart_id.clone());
    edit.expected_revision = Some(first.revision.clone());
    edit.lines[0].quantity = "3".into();
    save(&mut c, &ctx, edit).unwrap();
    for _ in 0..100 {
        let result = save(&mut c, &ctx, request(30)).unwrap();
        assert_eq!(result.revision, "1");
        assert_eq!(result.workspace.active.unwrap().lines[0].quantity, "3");
    }
    let mut conflict = request(30);
    conflict.lines[0].quantity = "4".into();
    assert_eq!(
        save(&mut c, &ctx, conflict).unwrap_err().code(),
        "OPERATION_ID_CONFLICT"
    );
    let mut stale = request(32);
    stale.cart_id = Some(first.cart_id);
    stale.expected_revision = Some("1".into());
    assert_eq!(
        save(&mut c, &ctx, stale).unwrap_err().code(),
        "VERSION_CONFLICT"
    );
    assert_eq!(read(&c, &ctx).unwrap().active.unwrap().revision, "2");
}
#[test]
fn pause_resume_swap_and_discard_are_atomic() {
    let mut c = db();
    let ctx = context();
    let a = save(&mut c, &ctx, request(30))
        .unwrap()
        .workspace
        .active
        .unwrap();
    let paused = action(&mut c, &ctx, act(31, DraftActionKind::Pause, &a, None))
        .unwrap()
        .workspace
        .paused[0]
        .clone();
    let b = save(&mut c, &ctx, request(32))
        .unwrap()
        .workspace
        .active
        .unwrap();
    let swapped = action(
        &mut c,
        &ctx,
        act(33, DraftActionKind::Resume, &paused, Some(&b)),
    )
    .unwrap()
    .workspace;
    assert_eq!(swapped.active.as_ref().unwrap().id, a.id);
    assert_eq!(swapped.paused[0].id, b.id);
    let result = action(
        &mut c,
        &ctx,
        act(34, DraftActionKind::Discard, &swapped.paused[0], None),
    )
    .unwrap();
    assert!(result.workspace.paused.is_empty());
    assert_eq!(business_counts(&c), vec![0, 0, 0, 0]);
}
#[test]
fn context_isolation_includes_actor_tenant_branch_and_device() {
    let mut c = db();
    let ctx = context();
    let a = save(&mut c, &ctx, request(30))
        .unwrap()
        .workspace
        .active
        .unwrap();
    for dimension in 0..4 {
        let mut other = ctx.clone();
        match dimension {
            0 => other.actor_id = id(90),
            1 => other.tenant_id = id(90),
            2 => other.branch_id = Some(id(90)),
            _ => other.device_id = id(90),
        };
        assert!(read(&c, &other).unwrap().active.is_none());
        assert!(save(&mut c, &other, request(30)).is_err());
        assert!(action(&mut c, &other, act(31, DraftActionKind::Pause, &a, None)).is_err());
    }
    assert_eq!(read(&c, &ctx).unwrap().active.unwrap(), a);
}
#[test]
fn preview_uses_exact_native_subtotal_but_never_fabricates_tax_total_or_stock() {
    let c = db();
    let before = c.total_changes();
    let q = quote(&c, &context(), &[line(11, "3")]).unwrap();
    assert_eq!(q.subtotal_cents.as_deref(), Some("309"));
    assert_eq!(q.line_totals[0].subtotal_cents.as_deref(), Some("309"));
    assert!(
        q.itbis_cents.is_none()
            && q.total_cents.is_none()
            && q.change_cents.is_none()
            && !q.payable
    );
    assert!(q.limits.contains(&"TAX_CONTEXT_UNAVAILABLE".into()));
    assert_eq!(
        quote(&c, &context(), &[line(12, "1")])
            .unwrap()
            .subtotal_cents,
        None
    );
    assert_eq!(c.total_changes(), before);
}
#[test]
fn refreshed_catalogue_preserves_cart_without_silently_repricing_it() {
    let mut c = db();
    let ctx = context();
    let cart = save(&mut c, &ctx, request(30))
        .unwrap()
        .workspace
        .active
        .unwrap();
    capture(&mut c, &ctx, 22);
    assert_eq!(read(&c, &ctx).unwrap().active.unwrap(), cart);
    let q = quote(&c, &ctx, &cart.lines).unwrap();
    assert!(q.subtotal_cents.is_none());
    assert!(q.limits.contains(&"CATALOGUE_CHANGED".into()));
    let mut edit = request(31);
    edit.cart_id = Some(cart.id);
    edit.expected_revision = Some(cart.revision);
    edit.lines[0].revision = id(22);
    assert!(save(&mut c, &ctx, edit).is_ok());
}
#[test]
fn invalid_quantities_products_duplicates_or_unbounded_lines_make_no_changes() {
    let mut c = db();
    let ctx = context();
    for quantity in ["0", "-1", "1.5", "01", "2147483648", "+1"] {
        let mut bad = request(30);
        bad.lines[0].quantity = quantity.into();
        assert!(save(&mut c, &ctx, bad).is_err());
    }
    let mut bad = request(30);
    bad.lines[0].product_id = id(99);
    assert!(save(&mut c, &ctx, bad).is_err());
    let mut duplicate = request(30);
    duplicate.lines.push(duplicate.lines[0].clone());
    assert!(save(&mut c, &ctx, duplicate).is_err());
    let mut large = request(30);
    large.lines = vec![line(11, "1"); 101];
    assert!(save(&mut c, &ctx, large).is_err());
    assert!(read(&c, &ctx).unwrap().active.is_none());
    assert_eq!(
        c.query_row::<i64, _, _>("SELECT count(*) FROM account_draft_requests", [], |r| r
            .get(0))
            .unwrap(),
        0
    );
}
#[test]
fn pause_limit_ten_does_not_block_swapping_or_lose_active_draft() {
    let mut c = db();
    let ctx = context();
    for n in 0..10 {
        let cart = save(&mut c, &ctx, request(100 + n * 2))
            .unwrap()
            .workspace
            .active
            .unwrap();
        action(
            &mut c,
            &ctx,
            act(101 + n * 2, DraftActionKind::Pause, &cart, None),
        )
        .unwrap();
    }
    let a = save(&mut c, &ctx, request(130))
        .unwrap()
        .workspace
        .active
        .unwrap();
    assert!(action(&mut c, &ctx, act(131, DraftActionKind::Pause, &a, None)).is_err());
    let workspace = read(&c, &ctx).unwrap();
    let target = &workspace.paused[0];
    let swapped = action(
        &mut c,
        &ctx,
        act(132, DraftActionKind::Resume, target, Some(&a)),
    )
    .unwrap()
    .workspace;
    assert_eq!(swapped.paused.len(), 10);
    assert_eq!(swapped.active.unwrap().id, target.id);
}
#[test]
fn failed_ack_write_rolls_back_cart_and_same_request_recovers() {
    let mut c = db();
    let ctx = context();
    c.execute_batch("CREATE TEMP TRIGGER fixture_fail_draft_ack BEFORE INSERT ON account_draft_requests BEGIN SELECT RAISE(ABORT,'fixture fault only'); END;").unwrap();
    assert!(save(&mut c, &ctx, request(30)).is_err());
    assert!(read(&c, &ctx).unwrap().active.is_none());
    assert_eq!(business_counts(&c), vec![0, 0, 0, 0]);
    c.execute_batch("DROP TRIGGER fixture_fail_draft_ack;")
        .unwrap();
    assert_eq!(
        save(&mut c, &ctx, request(30))
            .unwrap()
            .workspace
            .active
            .unwrap()
            .revision,
        "1"
    );
}
