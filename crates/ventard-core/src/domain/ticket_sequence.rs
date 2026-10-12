//! Pure ticket formatting/bounds. No storage, network, clock or identity allocation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TicketSequenceError;
pub fn next_ticket_number(last: u64) -> Result<u64, TicketSequenceError> {
    last.checked_add(1)
        .filter(|n| *n <= 9_007_199_254_740_991)
        .ok_or(TicketSequenceError)
}
pub fn format_ticket(prefix: &str, number: u64) -> Result<String, TicketSequenceError> {
    if prefix.is_empty()
        || prefix.len() > 64
        || !prefix
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        || number == 0
        || number > 9_007_199_254_740_991
    {
        return Err(TicketSequenceError);
    }
    Ok(format!("{prefix}-{number:06}"))
}
