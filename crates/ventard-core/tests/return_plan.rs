use serde_json::json;
use ventard_core::domain::return_plan::{plan, Item};
fn sale() -> serde_json::Value {
    json!({"lines":[{"productId":"a","name":"Original","quantity":{"numerator":"3","denominator":"1"},"unitPriceCents":"33","subtotalCents":"99","recipe":[]}],"totals":{"totalCents":"100"},"payment":{"method":"MIXTO","cashNetCents":"50","transferCents":"50"},"serials":[]})
}
fn item(q: &str) -> Vec<Item> {
    vec![Item {
        key: "a".into(),
        quantity: q.into(),
    }]
}
#[test]
fn original_gross_basis_rounds_once_and_last_return_captures_remaining_cent() {
    let s = sale();
    let a = plan(&s, &[], &item("1"), &[]).unwrap();
    assert_eq!(a["amountCents"], "33");
    assert_eq!(a["cashRefundCents"], "17");
    let b = plan(&s, std::slice::from_ref(&a), &item("1"), &[]).unwrap();
    assert_eq!(b["amountCents"], "33");
    let c = plan(&s, &[a, b], &item("1"), &[]).unwrap();
    assert_eq!(c["amountCents"], "34");
    assert!(plan(&s, &[c], &item("3"), &[]).is_err());
}
#[test]
fn frozen_combo_recipe_is_reversed_only_when_stock_is_integral() {
    let mut s = sale();
    s["lines"][0]["recipe"] =
        json!([{"productId":"ingredient","perUnit":{"numerator":"1","denominator":"2"}}]);
    assert!(plan(&s, &[], &item("1"), &[]).is_err());
    let d = plan(&s, &[], &item("2"), &[]).unwrap();
    assert_eq!(
        d["inventory"],
        json!([{"productId":"ingredient","delta":"1"}])
    );
}
#[test]
fn serials_are_selected_by_original_product_and_cannot_be_returned_twice() {
    let mut s = sale();
    s["lines"][0]["quantity"]["numerator"] = json!("1");
    s["serials"] = json!([{"productId":"a","text":"000001"}]);
    assert!(plan(&s, &[], &item("1"), &[]).is_err());
    let d = plan(&s, &[], &item("1"), &["000001".into()]).unwrap();
    assert_eq!(d["serials"], s["serials"]);
    assert!(plan(&s, &[d], &item("1"), &["000001".into()]).is_err());
}
#[test]
fn duplicate_lines_weight_original_prices_and_reject_ambiguous_recipes() {
    let mut s = sale();
    s["lines"][0]["quantity"]["numerator"] = json!("1");
    let mut l = s["lines"][0].clone();
    l["subtotalCents"] = json!("101");
    l["unitPriceCents"] = json!("101");
    s["lines"].as_array_mut().unwrap().push(l);
    assert_eq!(plan(&s, &[], &item("1"), &[]).unwrap()["amountCents"], "50");
    s["lines"][1]["recipe"] =
        json!([{"productId":"b","perUnit":{"numerator":"1","denominator":"1"}}]);
    assert!(plan(&s, &[], &item("1"), &[]).is_err());
    assert_eq!(
        plan(&s, &[], &item("2"), &[]).unwrap()["amountCents"],
        "100"
    );
}
