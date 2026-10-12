use serde_json::Value;
use ventard_core::domain::money::MoneyCents;
use ventard_core::domain::quantity::Ratio;
use ventard_core::domain::sale_quote::{calculate_totals, Discount, QuoteLine};

#[test]
fn native_totals_match_the_versioned_legacy_fixture() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../packages/contracts/fixtures/legacy-commercial.json"
    ))
    .unwrap();
    for case in fixture["cases"].as_array().unwrap() {
        let id = case["id"].as_str().unwrap();
        let native = &case["native"];
        if native.get("conversionError").is_some() {
            assert!(
                case["expected"].get("error").is_some(),
                "{id}: conversión imposible no puede ser éxito"
            );
            continue;
        }
        let parsed = native["lines"]
            .as_array()
            .unwrap()
            .iter()
            .map(|line| {
                Ok(QuoteLine {
                    unit_price: MoneyCents::parse_dto(line["unitPriceCents"].as_str().unwrap())
                        .map_err(|e| e.to_string())?,
                    quantity: Ratio::parse_legacy_decimal(line["quantity"].as_str().unwrap())
                        .map_err(|e| e.to_string())?,
                    tax_rate: Ratio::parse_legacy_decimal(line["taxRate"].as_str().unwrap())
                        .map_err(|e| e.to_string())?,
                })
            })
            .collect::<Result<Vec<_>, String>>();
        let discount = &native["discount"];
        let discount = if discount["kind"] == "AMOUNT" {
            Discount::Amount(MoneyCents::parse_dto(discount["cents"].as_str().unwrap()).unwrap())
        } else {
            Discount::Percent(
                Ratio::parse_legacy_decimal(discount["value"].as_str().unwrap()).unwrap(),
            )
        };
        let actual =
            parsed.and_then(|lines| calculate_totals(&lines, &discount).map_err(|e| e.to_string()));
        if let Some(expected) = case["expected"].get("ok") {
            let actual = actual.unwrap_or_else(|error| panic!("{id}: {error}"));
            assert_eq!(
                actual.subtotal.to_dto(),
                expected["subtotal"].as_str().unwrap(),
                "{id}: subtotal"
            );
            assert_eq!(
                actual.itbis.to_dto(),
                expected["itbis"].as_str().unwrap(),
                "{id}: ITBIS"
            );
            assert_eq!(
                actual.discount.to_dto(),
                expected["descuento"].as_str().unwrap(),
                "{id}: descuento"
            );
            assert_eq!(
                actual.total.to_dto(),
                expected["total"].as_str().unwrap(),
                "{id}: total"
            );
        } else {
            assert!(
                actual.is_err(),
                "{id}: legacy rechaza este caso; no fabricar compatibilidad"
            );
        }
    }
}
