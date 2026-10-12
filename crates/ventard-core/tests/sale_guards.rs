use ventard_core::domain::{
    identity::{EntityId, Scope, TenantRef},
    money::MoneyCents,
    quantity::Ratio,
    sale_inventory::*,
    sale_payment::*,
};
fn id(n: u32) -> EntityId {
    EntityId::parse(&format!("96000000-0000-4000-8000-{n:012}")).unwrap()
}
fn money(n: i64) -> MoneyCents {
    MoneyCents::from_cents(n).unwrap()
}
fn product(n: u32, stock: Option<i32>) -> InventoryProduct {
    InventoryProduct {
        reference: TenantRef {
            negocio_id: id(1),
            id: id(n),
        },
        scope: Scope::Branch(id(2)),
        revision: "1".into(),
        deleted: false,
        serial_required: false,
        recipe: vec![],
        authority: stock.map(|available| StockAuthority {
            available,
            revision: "1".into(),
            verified: true,
        }),
    }
}
fn line(n: u32, qty: u64) -> InventoryLine {
    InventoryLine {
        product_id: id(n),
        quantity: Ratio::from_integer(qty),
        expected_revision: "1".into(),
        serial: None,
    }
}
fn check(
    lines: &[InventoryLine],
    products: &[InventoryProduct],
    serials: &[SerialAvailability],
) -> Result<InventoryPlan, InventoryError> {
    validate_inventory(id(1), Scope::Branch(id(2)), lines, products, serials)
}
#[test]
fn unknown_or_wrong_scope_stock_never_becomes_saleable_zero_or_global_fallback() {
    assert_eq!(
        check(&[line(3, 1)], &[product(3, None)], &[])
            .unwrap_err()
            .code(),
        "STOCK_UNVERIFIED"
    );
    let mut p = product(3, Some(100));
    p.scope = Scope::Global;
    assert_eq!(
        check(&[line(3, 1)], &[p], &[]).unwrap_err().code(),
        "SCOPE_INVALID"
    );
    let mut p = product(3, Some(100));
    p.authority.as_mut().unwrap().verified = false;
    assert_eq!(
        check(&[line(3, 1)], &[p], &[]).unwrap_err().code(),
        "STOCK_UNVERIFIED"
    );
}
#[test]
fn direct_and_recipe_consumptions_aggregate_before_stock_check() {
    let mut combo = product(4, None);
    combo.recipe = vec![RecipePart {
        product_id: id(3),
        per_unit: Ratio::from_integer(2),
    }];
    let products = [product(3, Some(5)), combo];
    assert_eq!(
        check(&[line(3, 2), line(4, 2)], &products, &[])
            .unwrap_err()
            .code(),
        "STOCK_UNAVAILABLE"
    );
    let plan = check(&[line(3, 1), line(4, 2)], &products, &[]).unwrap();
    assert_eq!(plan.effects.len(), 1);
    assert_eq!(plan.effects[0].delta, -5);
}
#[test]
fn fractional_recipe_effects_overflow_and_obsolete_product_fail() {
    let mut combo = product(4, None);
    combo.recipe = vec![RecipePart {
        product_id: id(3),
        per_unit: Ratio::parse_canonical("1", "2").unwrap(),
    }];
    assert_eq!(
        check(&[line(4, 1)], &[product(3, Some(5)), combo.clone()], &[])
            .unwrap_err()
            .code(),
        "CONTRACT_INVALID"
    );
    assert_eq!(
        check(&[line(4, 2)], &[product(3, Some(5)), combo], &[])
            .unwrap()
            .effects[0]
            .delta,
        -1
    );
    assert_eq!(
        check(&[line(3, 2147483648)], &[product(3, Some(i32::MAX))], &[])
            .unwrap_err()
            .code(),
        "CONTRACT_INVALID"
    );
    let mut stale = line(3, 1);
    stale.expected_revision = "2".into();
    assert_eq!(
        check(&[stale], &[product(3, Some(5))], &[])
            .unwrap_err()
            .code(),
        "VERSION_CONFLICT"
    );
}
#[test]
fn serial_requires_exact_unit_owner_scope_available_state_and_no_duplicate() {
    let mut p = product(3, Some(5));
    p.serial_required = true;
    let serial = SerialAvailability {
        text: "000012345678901".into(),
        product_id: id(3),
        tenant_id: id(1),
        scope: Scope::Branch(id(2)),
        available: true,
        revision: "1".into(),
    };
    let mut l = line(3, 1);
    l.serial = Some(serial.text.clone());
    assert!(check(
        std::slice::from_ref(&l),
        std::slice::from_ref(&p),
        std::slice::from_ref(&serial)
    )
    .is_ok());
    assert_eq!(
        check(
            &[l.clone(), l.clone()],
            std::slice::from_ref(&p),
            std::slice::from_ref(&serial)
        )
        .unwrap_err()
        .code(),
        "SERIAL_CONFLICT"
    );
    l.quantity = Ratio::from_integer(2);
    assert_eq!(
        check(&[l], &[p], &[serial]).unwrap_err().code(),
        "SERIAL_CONFLICT"
    );
}
#[test]
fn tenant_deleted_and_unknown_legacy_scope_fail_without_effect_plan() {
    let mut p = product(3, Some(5));
    p.reference.negocio_id = id(99);
    assert_eq!(
        check(&[line(3, 1)], &[p], &[]).unwrap_err().code(),
        "PERMISSION_DENIED"
    );
    let mut p = product(3, Some(5));
    p.deleted = true;
    assert!(check(&[line(3, 1)], &[p], &[]).is_err());
    assert!(validate_inventory(
        id(1),
        Scope::UnknownLegacy,
        &[line(3, 1)],
        &[product(3, Some(5))],
        &[]
    )
    .is_err());
}
fn turn() -> PaymentTurn {
    PaymentTurn {
        id: id(20),
        tenant_id: id(1),
        scope: Scope::Branch(id(2)),
        open: true,
    }
}
fn pay(
    p: Payment,
    t: Option<&PaymentTurn>,
    credit: Option<&CreditContext>,
) -> Result<PaymentPlan, PaymentError> {
    validate_payment(id(1), Scope::Branch(id(2)), money(11800), &p, t, credit)
}
#[test]
fn cash_requires_correct_open_turn_and_records_net_not_tender() {
    assert_eq!(
        pay(
            Payment::Cash {
                tender: money(20000)
            },
            None,
            None
        )
        .unwrap_err()
        .code(),
        "TURN_REQUIRED"
    );
    let p = pay(
        Payment::Cash {
            tender: money(20000),
        },
        Some(&turn()),
        None,
    )
    .unwrap();
    assert_eq!(p.cash_net, money(11800));
    assert_eq!(p.change, money(8200));
    assert_eq!(p.turn_id, Some(id(20)));
    let mut closed = turn();
    closed.open = false;
    assert!(pay(
        Payment::Cash {
            tender: money(20000)
        },
        Some(&closed),
        None
    )
    .is_err());
    let mut wrong = turn();
    wrong.scope = Scope::Global;
    assert!(pay(
        Payment::Cash {
            tender: money(20000)
        },
        Some(&wrong),
        None
    )
    .is_err());
    assert!(pay(
        Payment::Cash {
            tender: money(10000)
        },
        Some(&turn()),
        None
    )
    .is_err());
}
#[test]
fn non_cash_is_a_recorded_method_not_bank_settlement_and_needs_no_cash_turn() {
    for payment in [Payment::Card, Payment::Transfer] {
        let p = pay(payment, None, None).unwrap();
        assert_eq!(p.cash_net, MoneyCents::ZERO);
        assert_eq!(p.change, MoneyCents::ZERO);
        assert_eq!(p.turn_id, None);
        assert_eq!(p.paid, money(11800));
        assert!(!p.bank_settlement_verified);
    }
}
#[test]
fn mixed_requires_both_positive_exact_sum_and_change_only_on_cash_portion() {
    let p = pay(
        Payment::Mixed {
            cash: money(4000),
            transfer: money(7800),
            tender: money(5000),
        },
        Some(&turn()),
        None,
    )
    .unwrap();
    assert_eq!(p.change, money(1000));
    assert_eq!(p.cash_net, money(4000));
    assert_eq!(p.paid, money(11800));
    for (cash, transfer) in [(0, 11800), (4000, 7801)] {
        assert!(pay(
            Payment::Mixed {
                cash: money(cash),
                transfer: money(transfer),
                tender: money(5000)
            },
            Some(&turn()),
            None
        )
        .is_err());
    }
    assert!(pay(
        Payment::Mixed {
            cash: money(4000),
            transfer: money(7800),
            tender: money(3000)
        },
        Some(&turn()),
        None
    )
    .is_err());
}
#[test]
fn credit_requires_verifiable_customer_balance_limit_and_scope_without_cash_entry() {
    let c = CreditContext {
        customer_id: id(30),
        tenant_id: id(1),
        scope: Scope::Branch(id(2)),
        balance: money(1000),
        limit: Some(money(15000)),
        active: true,
        verified: true,
    };
    let p = pay(
        Payment::Credit {
            customer_id: id(30),
        },
        None,
        Some(&c),
    )
    .unwrap();
    assert_eq!(p.credit_charge, money(11800));
    assert_eq!(p.paid, MoneyCents::ZERO);
    assert_eq!(p.cash_net, MoneyCents::ZERO);
    assert!(pay(
        Payment::Credit {
            customer_id: id(30)
        },
        None,
        None
    )
    .is_err());
    let mut c = c;
    c.limit = Some(money(12000));
    assert!(pay(
        Payment::Credit {
            customer_id: id(30)
        },
        None,
        Some(&c)
    )
    .is_err());
    c.verified = false;
    assert!(pay(
        Payment::Credit {
            customer_id: id(30)
        },
        None,
        Some(&c)
    )
    .is_err());
}
#[test]
fn zero_ticket_is_preserved_and_compatible_with_cash_turn_rule() {
    assert!(validate_payment(
        id(1),
        Scope::Branch(id(2)),
        MoneyCents::ZERO,
        &Payment::Cash {
            tender: MoneyCents::ZERO
        },
        Some(&turn()),
        None
    )
    .is_ok());
    assert!(validate_payment(
        id(1),
        Scope::Branch(id(2)),
        MoneyCents::ZERO,
        &Payment::Cash {
            tender: MoneyCents::ZERO
        },
        None,
        None
    )
    .is_err());
}
#[test]
fn characterized_zero_credit_limit_is_unlimited_but_missing_limit_is_not() {
    let mut c = CreditContext {
        customer_id: id(30),
        tenant_id: id(1),
        scope: Scope::Global,
        balance: money(1000),
        limit: Some(MoneyCents::ZERO),
        active: true,
        verified: true,
    };
    assert!(pay(
        Payment::Credit {
            customer_id: id(30)
        },
        None,
        Some(&c)
    )
    .is_ok());
    c.limit = None;
    assert!(pay(
        Payment::Credit {
            customer_id: id(30)
        },
        None,
        Some(&c)
    )
    .is_err());
}
