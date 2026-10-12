use ventard_core::domain::identity::EntityId;
use ventard_core::domain::money::MoneyCents;
use ventard_core::domain::quantity::Ratio;
use ventard_core::domain::sale_quote::{
    quote_snapshot, Discount, HistoricalIngredient, HistoricalQuoteLine, CALCULATION_VERSION,
};

fn line() -> HistoricalQuoteLine {
    HistoricalQuoteLine {
        product_id: Some(EntityId::parse("96000000-0000-4000-8000-000000000001").unwrap()),
        product_revision: Some("7".into()),
        name: "Equipo sintético".into(),
        unit_price: MoneyCents::from_cents(10000).unwrap(),
        quantity: Ratio::one(),
        tax_rate: Ratio::parse_legacy_decimal("0.18").unwrap(),
        cost: None,
        recipe: vec![HistoricalIngredient {
            product_id: EntityId::parse("96000000-0000-4000-8000-000000000002").unwrap(),
            quantity_per_unit: Ratio::parse_legacy_decimal("0.5").unwrap(),
            revision: Some("3".into()),
        }],
        serial: Some("001234567890123".into()),
    }
}

#[test]
fn quote_owns_price_rate_recipe_cost_and_serial_snapshots() {
    let mut lines = vec![line()];
    let quote = quote_snapshot(&lines, &Discount::Amount(MoneyCents::ZERO)).unwrap();
    lines[0].unit_price = MoneyCents::from_cents(99999).unwrap();
    lines[0].tax_rate = Ratio::zero();
    lines[0].product_revision = Some("8".into());
    lines[0].recipe.clear();
    lines[0].serial = None;
    assert_eq!(quote.calculation_version, CALCULATION_VERSION);
    assert_eq!(quote.totals.total.cents(), 11800);
    assert_eq!(quote.lines[0].product_revision.as_deref(), Some("7"));
    assert_eq!(quote.lines[0].unit_price.cents(), 10000);
    assert_eq!(quote.lines[0].tax_rate.to_dto(), ("9".into(), "50".into()));
    assert_eq!(
        quote.lines[0].recipe[0].quantity_per_unit.to_dto(),
        ("1".into(), "2".into())
    );
    assert_eq!(quote.lines[0].serial.as_deref(), Some("001234567890123"));
    assert_eq!(
        quote.lines[0].cost, None,
        "costo desconocido no se convierte en cero"
    );
}

#[test]
fn same_snapshot_input_is_deterministic_without_clock_or_random_ids() {
    let lines = vec![line()];
    let discount = Discount::Percent(Ratio::from_integer(10));
    let first = quote_snapshot(&lines, &discount).unwrap();
    let second = quote_snapshot(&lines, &discount).unwrap();
    assert_eq!(first, second);
    assert_eq!(first.totals.total.cents(), 10620);
}
