//! Explicit synthetic DATA adapter for the real sales engine. No business rules
//! are reimplemented here; legacy qa_* tables are projections for old harnesses.
use super::*;
use crate::application::{cash, checkout, sales, ticket_sequence};
use crate::fiscal::reservations::{store_allocated_block, AllocatedBlockEvidence, NcfKind};
use crate::security::offline_grant::*;
use crate::storage::catalogue_preview::CatalogueContext;
use ed25519_dalek::{Signer, SigningKey};
use rusqlite::TransactionBehavior;
const INSTALLATION: &str = "96000000-0000-4000-8000-000000000053";
pub(super) fn context() -> CatalogueContext {
    CatalogueContext {
        tenant_id: QA_TENANT.into(),
        actor_id: ACTOR.into(),
        device_id: DEVICE.into(),
        installation_id: INSTALLATION.into(),
        writer_epoch: "1".into(),
        scope_type: "GLOBAL".into(),
        branch_id: None,
    }
}
fn map(id: &str) -> String {
    sales::effect_id(QA_TENANT, id)
}
fn grant() -> Result<VerifiedGrant, AppError> {
    // Non-secret test signing key, compiled ONLY with qa-spike. Never trusted by
    // the account broker or used to mint an actual Supabase account grant.
    let key = SigningKey::from_bytes(&[0x7a; 32]);
    let p = json!({"protocol":"ventard.offline-grant.v1","keyId":"synthetic-sales-only","issuer":"ventard.staging","audience":"ventard.native.staging.v1","grantId":map("grant"),"grantSequence":"1","policyVersion":"1","tenantId":QA_TENANT,"actorId":ACTOR,"deviceId":DEVICE,"installationId":INSTALLATION,"writerEpoch":"1","scope":{"type":"GLOBAL","branchId":null},"role":"owner","capabilities":["READ","SELL"],"issuedAtMs":"1000","actorExpiresAtMs":null,"license":{"planActive":true,"accessUntilMs":null,"trialUntilMs":null,"graceDays":"5","warnAfterOpenings":"200","blockAfterOpenings":"300"}});
    let (bytes, _) =
        canonicalize(&serde_json::to_vec(&p).map_err(|_| invalid())?).map_err(|_| invalid())?;
    let signature = key
        .sign(bytes.as_bytes())
        .to_bytes()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    verify_grant(
        &serde_json::to_vec(&json!({"payload":p,"signature":signature})).map_err(|_| invalid())?,
        &[
            TrustedGrantKey::new("synthetic-sales-only", key.verifying_key().to_bytes())
                .map_err(|_| invalid())?,
        ],
        &GrantContext {
            tenant_id: QA_TENANT.into(),
            actor_id: ACTOR.into(),
            device_id: DEVICE.into(),
            installation_id: INSTALLATION.into(),
            writer_epoch: "1".into(),
            scope_type: "GLOBAL".into(),
            branch_id: None,
            min_grant_sequence: "1".into(),
            audience: "ventard.native.staging.v1".into(),
        },
    )
    .map_err(|_| invalid())
}
pub(super) fn initialize(c: &mut Connection) -> Result<(), AppError> {
    let key = format!("{QA_TENANT}/GLOBAL");
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    tx.execute(
        "INSERT OR IGNORE INTO scopes VALUES(?1,'GLOBAL',NULL,?2)",
        (&key, QA_TENANT),
    )?;
    tx.execute(
        "INSERT OR IGNORE INTO vault_meta VALUES(?1,?2,11,'SYNTHETIC_QA','SQLCipher','ACTIVE',0)",
        (map("vault"), QA_TENANT),
    )?;
    tx.execute(
        "INSERT OR IGNORE INTO installations VALUES(?1,?2,1,'QAN','1000','ACTIVE')",
        (INSTALLATION, DEVICE),
    )?;
    tx.execute_batch("CREATE TABLE IF NOT EXISTS qa_native_sale_requests_v1(operation_id TEXT PRIMARY KEY,request_bytes BLOB NOT NULL,request_hash TEXT NOT NULL,core_request TEXT NOT NULL) STRICT;")?;
    tx.execute(
        "INSERT OR IGNORE INTO sale_free_settings_v1 VALUES(?1,?2,?3)",
        (
            QA_TENANT,
            &key,
            json!({"numerator":"9","denominator":"50"}).to_string(),
        ),
    )?;
    tx.execute_batch("CREATE TABLE IF NOT EXISTS qa_native_sale_abandonments_v1(operation_id TEXT PRIMARY KEY,reason TEXT NOT NULL CHECK(reason='USER_ABANDONED')) STRICT;")?;
    for (id, name, limit) in [
        ("customer-1", "Cliente sintético contado/fiado", 500000i64),
        ("customer-2", "Cliente sintético límite bajo", 100i64),
    ] {
        tx.execute("INSERT OR IGNORE INTO sale_customer_accounts_v1 VALUES(?1,?2,?3,?4,0,?5,1,'VERIFIED',1)",(map(id),QA_TENANT,&key,name,limit))?;
    }
    tx.commit()?;
    refresh_products(c)?;
    let g = grant()?;
    let turns: i64 = c.query_row(
        "SELECT count(*) FROM cash_turns WHERE tenant_id=?1",
        [QA_TENANT],
        |r| r.get(0),
    )?;
    if turns == 0 {
        cash::open_turn(
            c,
            &g,
            1000,
            0,
            0,
            cash::TurnOpen {
                operation_id: map("opening"),
                opening_cents: "0".into(),
                expected_drawer_revision: "0".into(),
            },
        )?;
    }
    ticket_sequence::register_ticket_seed(
        c,
        &g,
        1000,
        0,
        0,
        &ticket_sequence::TicketSeedEvidence {
            prefix: "QAN".into(),
            last_issued: 0,
            source_ref: map("ticket-source"),
        },
    )?;
    for kind in [NcfKind::B01, NcfKind::B02] {
        store_allocated_block(
            c,
            &g,
            1000,
            0,
            0,
            &AllocatedBlockEvidence {
                request_id: map(kind.text()),
                tenant_id: QA_TENANT.into(),
                device_id: DEVICE.into(),
                installation_id: INSTALLATION.into(),
                writer_epoch: "1".into(),
                kind,
                first: 1,
                last: 20,
                source_ref: map("synthetic-ncf-not-dgii"),
            },
        )?;
    }
    Ok(())
}
pub(super) fn refresh_products(c: &mut Connection) -> Result<(), AppError> {
    let rows = {
        let mut q = c.prepare(
            "SELECT id,name,code,price_cents,stock,revision FROM qa_products ORDER BY id",
        )?;
        let rows = q
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, i32>(4)?,
                    r.get::<_, String>(5)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        rows
    };
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let key = sales::scope_key(&context())?;
    for (qa, name, code, price, stock, revision) in rows {
        let id = map(&qa);
        let serial_required = qa == "qa-product-10";
        let meta=json!({"taxRate":{"numerator":"9","denominator":"50"},"costCents":null,"serialRequired":serial_required,"recipe":[]}).to_string();
        tx.execute("INSERT INTO products VALUES(?1,?2,?3,NULL,?4,?5,?6,?7,0) ON CONFLICT(producto_id) DO UPDATE SET revision=excluded.revision,barcode=excluded.barcode,name=excluded.name,price_tiers=excluded.price_tiers,metadata=excluded.metadata",(&id,QA_TENANT,&revision,code,name,json!({"retailCents":price.to_string()}).to_string(),meta))?;
        tx.execute("INSERT INTO stock_projections VALUES(?1,?2,?3,0,'[]',?3,'VERIFIED') ON CONFLICT(producto_id,scope_key) DO UPDATE SET effective_stock=excluded.effective_stock",(&id,&key,stock.to_string()))?;
        if serial_required {
            for i in 1..=100 {
                tx.execute("INSERT OR IGNORE INTO sale_serial_inventory_v1 VALUES(?1,?2,?3,?4,'1','AVAILABLE',NULL)",(QA_TENANT,&key,&id,format!("000000000000{i:03}")))?;
            }
        }
    }
    let status: String = tx.query_row("SELECT status FROM qa_turn WHERE id=1", [], |r| r.get(0))?;
    if status == "CLOSED" {
        tx.execute(
            "UPDATE cash_turns SET status='CLOSED' WHERE tenant_id=?1 AND status='OPEN'",
            [QA_TENANT],
        )?;
    }
    tx.commit()?;
    Ok(())
}
pub(super) fn serials(c: &Connection, qa: &str) -> Result<Vec<String>, AppError> {
    let mut s=c.prepare("SELECT serial FROM sale_serial_inventory_v1 WHERE tenant_id=?1 AND producto_id=?2 AND state='AVAILABLE' ORDER BY serial LIMIT 100")?;
    let rows = s
        .query_map((QA_TENANT, map(qa)), |r| r.get(0))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}
fn converted(
    lines: &[QaLine],
    options: &sales::SaleOptions,
) -> (Vec<sales::SaleLine>, sales::SaleOptions) {
    let mut options = options.clone();
    options.serials = options
        .serials
        .into_iter()
        .map(|(id, serial)| (map(&id), serial))
        .collect();
    (
        lines
            .iter()
            .map(|l| sales::SaleLine {
                product_id: map(&l.product_id),
                quantity: l.quantity.clone(),
                revision: l.revision.clone(),
                free: l.free.clone(),
            })
            .collect(),
        options,
    )
}
fn default_options(tender: Option<MoneyCents>) -> sales::SaleOptions {
    sales::SaleOptions {
        payment: sales::SalePayment::Cash {
            tender_cents: tender.unwrap_or(MoneyCents::ZERO).to_string(),
        },
        discount_cents: "0".into(),
        serials: Default::default(),
        customer: None,
        discount_percent_basis_points: None,
        warranty_days: None,
    }
}
pub(super) fn quote(
    c: &mut Connection,
    lines: &[QaLine],
    tender: Option<MoneyCents>,
    options: Option<sales::SaleOptions>,
) -> Result<QaQuote, AppError> {
    refresh_products(c)?;
    let (selected, opts) = converted(lines, &options.unwrap_or_else(|| default_options(tender)));
    let result = sales::quote(c, &context(), &selected, &opts)?;
    // Preserve the existing stale-cart contract: a changed product revision is
    // not a new quote for the old cart. The UI must ask the user to reselect.
    if result.limits.iter().any(|code| code == "VERSION_CONFLICT") {
        return Err(stale());
    }
    let by_id: HashMap<String, String> = lines
        .iter()
        .map(|l| (map(&l.product_id), l.product_id.clone()))
        .collect();
    let line_totals = result
        .line_totals
        .iter()
        .map(|l| {
            Ok(QaQuoteLine {
                product_id: by_id
                    .get(l["productId"].as_str().ok_or_else(invalid)?)
                    .ok_or_else(invalid)?
                    .clone(),
                subtotal_cents: l["subtotalCents"].as_str().ok_or_else(invalid)?.into(),
            })
        })
        .collect::<Result<Vec<_>, AppError>>()?;
    Ok(QaQuote {
        subtotal_cents: result.subtotal_cents,
        itbis_cents: result.itbis_cents,
        total_cents: result.total_cents,
        change_cents: result.change_cents,
        payable: result.payable,
        line_totals,
        quote_hash: result.quote_hash,
        discount_cents: result.discount_cents,
        limits: result.limits,
    })
}
pub(super) fn pending_request(bytes: &[u8]) -> Result<QaSaleRequest, AppError> {
    let v: Value = serde_json::from_slice(bytes).map_err(|_| invalid())?;
    let request = if v["qaOnly"] == true {
        v["request"].clone()
    } else {
        // Original presentation request is preserved separately, never guessed from
        // current prices, reduced stock or the normalized commercial envelope.
        return Err(invalid());
    };
    serde_json::from_value(request).map_err(|_| invalid())
}
pub(super) fn pending(c: &Connection) -> Result<Option<QaSaleRequest>, AppError> {
    let row:Option<Vec<u8>>=c.query_row("SELECT r.request_bytes FROM qa_native_sale_requests_v1 r LEFT JOIN operation_journal j ON j.operation_id=r.operation_id WHERE (j.local_state IS NULL OR j.local_state='PREPARED') AND NOT EXISTS(SELECT 1 FROM qa_native_sale_abandonments_v1 a WHERE a.operation_id=r.operation_id) ORDER BY r.rowid LIMIT 1",[],|r|r.get(0)).optional()?;
    row.map(|bytes| serde_json::from_slice(&bytes).map_err(|_| invalid()))
        .transpose()
}
pub(super) fn confirm(c: &mut Connection, request: QaSaleRequest) -> Result<QaResult, AppError> {
    let abandoned: bool = c.query_row(
        "SELECT EXISTS(SELECT 1 FROM qa_native_sale_abandonments_v1 WHERE operation_id=?1)",
        [&request.operation_id],
        |r| r.get(0),
    )?;
    if abandoned {
        return Err(AppError::Business(BusinessError::OperationAbandoned));
    }
    refresh_products(c)?;
    let wire = serde_json::to_value(&request).map_err(|_| invalid())?;
    let (bytes, hash) =
        canonicalize(&serde_json::to_vec(&wire).map_err(|_| invalid())?).map_err(|_| invalid())?;
    let old:Option<(String,String)>=c.query_row("SELECT request_hash,core_request FROM qa_native_sale_requests_v1 WHERE operation_id=?1",[&request.operation_id],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
    let core = if let Some((old_hash, raw)) = old {
        if hash != old_hash {
            return Err(AppError::Protocol(ProtocolError::OperationIdConflict));
        }
        serde_json::from_str::<sales::SaleRequest>(&raw).map_err(|_| invalid())?
    } else {
        let options = request
            .options
            .clone()
            .unwrap_or_else(|| default_options(MoneyCents::parse_dto(&request.tender_cents).ok()));
        let (lines, options) = converted(&request.lines, &options);
        let q = sales::quote(c, &context(), &lines, &options)?;
        let accepted = request
            .accepted_quote_hash
            .clone()
            .or(q.quote_hash.clone())
            .ok_or_else(|| {
                crate::application::errors::AppError::Business(BusinessError::SaleGuard {
                    code: q
                        .limits
                        .first()
                        .cloned()
                        .unwrap_or("CONTRACT_INVALID".into()),
                })
            })?;
        let cart = request.cart_id.clone().ok_or_else(invalid)?;
        let revision = request.expected_cart_revision.clone().ok_or_else(invalid)?;
        let original: Option<(String, String)> = c
            .query_row(
                "SELECT revision,lines FROM qa_carts WHERE id=?1 AND status='ACTIVE'",
                [&cart],
                |r| Ok((r.get::<_, i64>(0)?.to_string(), r.get(1)?)),
            )
            .optional()?;
        let (rev, raw) = original.ok_or_else(stale)?;
        let original: Vec<QaLine> = serde_json::from_str(&raw).map_err(|_| invalid())?;
        if revision != rev || original != request.lines {
            return Err(stale());
        }
        let native_lines = lines
            .iter()
            .map(|l| json!({"productId":l.product_id,"quantity":l.quantity,"revision":l.revision}))
            .collect::<Vec<_>>();
        let key = crate::storage::catalogue_preview::key(&context()).map_err(|_| invalid())?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing: Option<String> = tx
            .query_row(
                "SELECT lines FROM account_drafts WHERE context_key=?1 AND id=?2",
                (&key, &cart),
                |r| r.get(0),
            )
            .optional()?;
        if existing.is_some() {
            checkout::ensure_editable(&tx, &key, &cart)?;
            tx.execute("UPDATE account_drafts SET revision=?3,lines=?4,status='ACTIVE' WHERE context_key=?1 AND id=?2",(&key,&cart,&revision,serde_json::to_string(&native_lines).map_err(|_|invalid())?))?;
        } else {
            tx.execute("INSERT INTO account_drafts VALUES(?1,?2,COALESCE((SELECT MAX(seq) FROM account_drafts WHERE context_key=?1),0)+1,?3,'ACTIVE',?4)",(&key,&cart,&revision,serde_json::to_string(&native_lines).map_err(|_|invalid())?))?;
        }
        let core = sales::SaleRequest {
            operation_id: request.operation_id.clone(),
            cart_id: cart,
            expected_cart_revision: revision,
            accepted_quote_hash: accepted,
            lines,
            options,
            fiscal_type: request.fiscal_type.clone(),
        };
        tx.execute(
            "INSERT INTO qa_native_sale_requests_v1 VALUES(?1,?2,?3,?4)",
            (
                &request.operation_id,
                bytes.as_bytes(),
                hash,
                serde_json::to_string(&core).map_err(|_| invalid())?,
            ),
        )?;
        tx.commit()?;
        core
    };
    let original = request.clone();
    let result = sales::confirm_with(c, &grant()?, 1000, 0, 0, core, |tx, r| {
        let op = &r.operation_id;
        tx.execute(
            "INSERT INTO qa_sales VALUES(?1,?2,?3)",
            (
                op,
                MoneyCents::parse_dto(&r.total_cents)
                    .map_err(|_| invalid())?
                    .cents(),
                &r.ticket,
            ),
        )?;
        for l in &original.lines {
            if l.free.is_some() {
                continue;
            }
            let id = map(&l.product_id);
            let stock:String=tx.query_row("SELECT effective_stock FROM stock_projections WHERE producto_id=?1 AND scope_key=?2",(&id,sales::scope_key(&context())?),|r|r.get(0))?;
            tx.execute(
                "UPDATE qa_products SET stock=?2 WHERE id=?1",
                (&l.product_id, stock),
            )?;
            let price: i64 = tx.query_row(
                "SELECT precio_cents FROM sale_lines WHERE sale_id=?1 AND producto_id=?2",
                (op, &id),
                |r| r.get(0),
            )?;
            tx.execute(
                "INSERT INTO qa_sale_lines VALUES(?1,?2,?3,?4)",
                (op, &l.product_id, quantity(&l.quantity)?, price),
            )?;
        }
        // Mirror the committed native effects, not the selected line quantities
        // (a recipe can consume ingredients instead of the parent product).
        let movements = {
            let mut query = tx.prepare("SELECT producto_id,delta_qty FROM inventory_movements WHERE owner_operation_id=?1 ORDER BY producto_id")?;
            let rows = query
                .query_map([op], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };
        let mut products = tx.prepare("SELECT id FROM qa_products")?;
        let identities = products
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        for (native_id, delta) in movements {
            let qa_id = identities
                .iter()
                .find(|id| map(id) == native_id)
                .ok_or_else(invalid)?;
            let stock: String = tx.query_row("SELECT effective_stock FROM stock_projections WHERE producto_id=?1 AND scope_key=?2", (&native_id, sales::scope_key(&context())?), |row| row.get(0))?;
            tx.execute(
                "UPDATE qa_products SET stock=?2 WHERE id=?1",
                (qa_id, stock),
            )?;
            tx.execute(
                "INSERT INTO qa_stock_movements VALUES(?1,?2,?3)",
                (op, qa_id, delta.parse::<i32>().map_err(|_| invalid())?),
            )?;
        }
        let sum: i64 = tx.query_row(
            "SELECT coalesce(sum(amount_cents),0) FROM payments WHERE operation_id=?1",
            [op],
            |r| r.get(0),
        )?;
        let tender: i64 = tx.query_row(
            "SELECT coalesce(sum(tender_cents),0) FROM payments WHERE operation_id=?1",
            [op],
            |r| r.get(0),
        )?;
        tx.execute(
            "INSERT INTO qa_payments VALUES(?1,?2,?3,?4)",
            (
                op,
                sum,
                tender,
                MoneyCents::parse_dto(&r.change_cents)
                    .map_err(|_| invalid())?
                    .cents(),
            ),
        )?;
        let cash: Option<i64> = tx
            .query_row(
                "SELECT amount_cents FROM sale_cash_entries_v1 WHERE operation_id=?1",
                [op],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(cash) = cash {
            tx.execute("INSERT INTO qa_cash_entries VALUES(?1,1,?2)", (op, cash))?;
        }
        tx.execute("INSERT INTO qa_outbox VALUES(?1,'NOT_ENABLED')", [op])?;
        let snapshot = sales::ticket(tx, &context(), op)?;
        tx.execute(
            "INSERT INTO qa_print_jobs VALUES(?1,'NOT_CONFIGURED',?2)",
            (op, snapshot.to_string()),
        )?;
        cart::consume_in_sale(tx, &original)?;
        Ok(())
    })?;
    let mut result: QaResult =
        serde_json::from_value(serde_json::to_value(result).map_err(|_| invalid())?)
            .map_err(|_| invalid())?;
    result.remote_status = "NOT_ENABLED".into();
    Ok(result)
}
pub(super) fn abandon(c: &mut Connection, op: &str) -> Result<(), AppError> {
    EntityId::parse(op).map_err(|_| invalid())?;
    let h: Option<String> = c
        .query_row(
            "SELECT hash FROM operation_journal WHERE operation_id=?1",
            [op],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(h) = h {
        checkout::abandon_checkout(c, &grant()?, 1000, 0, 0, op, &h)?;
    }
    let exists: bool = c.query_row(
        "SELECT EXISTS(SELECT 1 FROM qa_native_sale_requests_v1 WHERE operation_id=?1)",
        [op],
        |r| r.get(0),
    )?;
    if !exists {
        return Err(invalid());
    }
    c.execute(
        "INSERT OR IGNORE INTO qa_native_sale_abandonments_v1 VALUES(?1,'USER_ABANDONED')",
        [op],
    )?;
    Ok(())
}
