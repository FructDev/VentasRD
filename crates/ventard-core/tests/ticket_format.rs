use ventard_core::domain::ticket_sequence::{format_ticket, next_ticket_number};
#[test]
fn ticket_format_is_pure_preserves_prefix_and_never_truncates_numbers() {
    assert_eq!(format_ticket("QA1", 41).unwrap(), "QA1-000041");
    assert_eq!(format_ticket("QA1", 1_000_001).unwrap(), "QA1-1000001");
    for p in ["", "../QA", "QA/PC", "QA\n"] {
        assert!(format_ticket(p, 1).is_err());
    }
    assert!(format_ticket("QA1", 0).is_err());
}
#[test]
fn counter_has_checked_boundaries_and_no_history_or_clock_input() {
    assert_eq!(next_ticket_number(0).unwrap(), 1);
    assert_eq!(
        next_ticket_number(9_007_199_254_740_990).unwrap(),
        9_007_199_254_740_991
    );
    assert!(next_ticket_number(9_007_199_254_740_991).is_err());
}
