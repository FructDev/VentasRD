//! Exact payment plan, without bank settlement, storage or inferred refunds.
use super::{
    identity::{EntityId, Scope},
    money::{validate_mixed_payment, MoneyCents},
};
#[derive(Debug, Clone)]
pub enum Payment {
    Cash {
        tender: MoneyCents,
    },
    Card,
    Transfer,
    Mixed {
        cash: MoneyCents,
        transfer: MoneyCents,
        tender: MoneyCents,
    },
    Credit {
        customer_id: EntityId,
    },
}
#[derive(Debug, Clone)]
pub struct PaymentTurn {
    pub id: EntityId,
    pub tenant_id: EntityId,
    pub scope: Scope,
    pub open: bool,
}
#[derive(Debug, Clone)]
pub struct CreditContext {
    pub customer_id: EntityId,
    pub tenant_id: EntityId,
    pub scope: Scope,
    pub balance: MoneyCents,
    pub limit: Option<MoneyCents>,
    pub active: bool,
    pub verified: bool,
}
#[derive(Debug, PartialEq, Eq)]
pub struct PaymentPlan {
    pub paid: MoneyCents,
    pub credit_charge: MoneyCents,
    pub cash_net: MoneyCents,
    pub card: MoneyCents,
    pub transfer: MoneyCents,
    pub tender: MoneyCents,
    pub change: MoneyCents,
    pub turn_id: Option<EntityId>,
    pub bank_settlement_verified: bool,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PaymentError {
    Invalid,
    TurnRequired,
    TurnChanged,
    Insufficient,
    CreditUnverifiable,
    CreditLimit,
}
impl PaymentError {
    pub fn code(self) -> &'static str {
        match self {
            Self::TurnRequired => "TURN_REQUIRED",
            Self::TurnChanged => "TURN_CHANGED",
            Self::Insufficient => "CONTRACT_INVALID",
            Self::CreditUnverifiable => "LEGACY_NOT_VERIFIABLE",
            Self::CreditLimit => "CREDIT_LIMIT",
            Self::Invalid => "CONTRACT_INVALID",
        }
    }
}
pub fn validate_payment(
    tenant: EntityId,
    scope: Scope,
    total: MoneyCents,
    payment: &Payment,
    turn: Option<&PaymentTurn>,
    credit: Option<&CreditContext>,
) -> Result<PaymentPlan, PaymentError> {
    if scope == Scope::UnknownLegacy {
        return Err(PaymentError::Invalid);
    }
    total
        .require_non_negative()
        .map_err(|_| PaymentError::Invalid)?;
    let mut plan = PaymentPlan {
        paid: total,
        credit_charge: MoneyCents::ZERO,
        cash_net: MoneyCents::ZERO,
        card: MoneyCents::ZERO,
        transfer: MoneyCents::ZERO,
        tender: MoneyCents::ZERO,
        change: MoneyCents::ZERO,
        turn_id: None,
        bank_settlement_verified: false,
    };
    let cash_turn = || -> Result<EntityId, PaymentError> {
        let t = turn.ok_or(PaymentError::TurnRequired)?;
        if !t.open || t.tenant_id != tenant || t.scope != scope {
            return Err(PaymentError::TurnChanged);
        }
        Ok(t.id)
    };
    match payment {
        Payment::Cash { tender } => {
            plan.turn_id = Some(cash_turn()?);
            tender
                .require_non_negative()
                .map_err(|_| PaymentError::Invalid)?;
            if *tender < total {
                return Err(PaymentError::Insufficient);
            }
            plan.cash_net = total;
            plan.tender = *tender;
            plan.change = tender
                .checked_sub(total)
                .map_err(|_| PaymentError::Invalid)?;
        }
        Payment::Card => plan.card = total,
        Payment::Transfer => plan.transfer = total,
        Payment::Mixed {
            cash,
            transfer,
            tender,
        } => {
            validate_mixed_payment(*cash, *transfer, total).map_err(|_| PaymentError::Invalid)?;
            plan.turn_id = Some(cash_turn()?);
            if *tender < *cash {
                return Err(PaymentError::Insufficient);
            }
            plan.cash_net = *cash;
            plan.transfer = *transfer;
            plan.tender = *tender;
            plan.change = tender
                .checked_sub(*cash)
                .map_err(|_| PaymentError::Invalid)?;
        }
        Payment::Credit { customer_id } => {
            let c = credit
                .filter(|c| {
                    c.customer_id == *customer_id
                        && c.tenant_id == tenant
                        && (c.scope == scope || c.scope == Scope::Global)
                        && c.active
                        && c.verified
                })
                .ok_or(PaymentError::CreditUnverifiable)?;
            // Verified legacy limit zero is unlimited. Missing limit is NOT zero.
            // GLOBAL means explicitly verified tenant-wide debt coverage.
            let limit = c.limit.ok_or(PaymentError::CreditUnverifiable)?;
            limit
                .require_non_negative()
                .map_err(|_| PaymentError::Invalid)?;
            let projected = c
                .balance
                .checked_add(total)
                .map_err(|_| PaymentError::Invalid)?;
            if !limit.is_zero() && projected > limit {
                return Err(PaymentError::CreditLimit);
            }
            plan.paid = MoneyCents::ZERO;
            plan.credit_charge = total;
        }
    }
    if plan.turn_id.is_none() {
        if let Some(t) = turn.filter(|t| t.open && t.tenant_id == tenant && t.scope == scope) {
            plan.turn_id = Some(t.id);
        }
    }
    Ok(plan)
}
