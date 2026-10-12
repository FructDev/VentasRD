//! Dinero exacto en centavos (T023, FR-011, FR-014).
//!
//! Contrato: `contracts/operations-v1.md` §Números y `data-model.md` §Reglas.
//! - DTO: string decimal normalizado (`^-?(0|[1-9][0-9]*)$`, sin `+`, sin `-0`).
//! - Magnitud ≤ 9007199254740991 centavos (Number.MAX_SAFE_INTEGER, compatible
//!   con el cliente legacy y PG bigint).
//! - Toda acumulación es checked; salir del rango es error, nunca saturación.

use std::fmt;

/// Magnitud máxima admitida, igual a `Number.MAX_SAFE_INTEGER`.
pub const MAX_MAGNITUDE_CENTS: i64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MoneyError {
    /// El DTO no es un entero decimal normalizado.
    Format,
    /// Magnitud fuera del rango técnico compatible.
    OutOfRange,
    /// Campo de precio/total que no admite negativos.
    Negative,
    /// Pago/abono que exige importe > 0.
    NotPositive,
    /// Abono mayor que el saldo pendiente (CREDIT_OVERPAY).
    Overpay,
    /// Pago mixto sin ambas partes > 0 o con suma distinta del total.
    MixedInvalid,
}

impl fmt::Display for MoneyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let code = match self {
            MoneyError::Format => "money_format_invalid",
            MoneyError::OutOfRange => "money_out_of_range",
            MoneyError::Negative => "money_negative",
            MoneyError::NotPositive => "money_not_positive",
            MoneyError::Overpay => "credit_overpay",
            MoneyError::MixedInvalid => "mixed_payment_invalid",
        };
        f.write_str(code)
    }
}

impl std::error::Error for MoneyError {}

/// Importe con signo en centavos. El signo permitido depende del campo y se
/// valida con [`MoneyCents::require_non_negative`] / [`MoneyCents::require_positive`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default)]
pub struct MoneyCents(i64);

impl MoneyCents {
    pub const ZERO: MoneyCents = MoneyCents(0);

    pub fn from_cents(cents: i64) -> Result<Self, MoneyError> {
        if cents.unsigned_abs() > MAX_MAGNITUDE_CENTS as u64 {
            return Err(MoneyError::OutOfRange);
        }
        Ok(MoneyCents(cents))
    }

    /// Acepta valores i128 (acumuladores intermedios) sólo si caben en rango.
    pub fn from_i128(cents: i128) -> Result<Self, MoneyError> {
        if cents.unsigned_abs() > MAX_MAGNITUDE_CENTS as u128 {
            return Err(MoneyError::OutOfRange);
        }
        Ok(MoneyCents(cents as i64))
    }

    /// Parse estricto del DTO. No hace trim ni acepta `+`, ceros a la
    /// izquierda, `-0`, exponentes ni decimales.
    pub fn parse_dto(s: &str) -> Result<Self, MoneyError> {
        let digits = s.strip_prefix('-').unwrap_or(s);
        let negative = digits.len() != s.len();
        let valid = !digits.is_empty()
            && digits.bytes().all(|b| b.is_ascii_digit())
            && (digits == "0" || !digits.starts_with('0'))
            && !(negative && digits == "0");
        if !valid {
            return Err(MoneyError::Format);
        }
        // 16 dígitos ya superan MAX_SAFE; evita overflow de parse.
        if digits.len() > 16 {
            return Err(MoneyError::OutOfRange);
        }
        let magnitude: i64 = digits.parse().map_err(|_| MoneyError::Format)?;
        Self::from_cents(if negative { -magnitude } else { magnitude })
    }

    pub fn to_dto(self) -> String {
        self.0.to_string()
    }

    pub fn cents(self) -> i64 {
        self.0
    }

    pub fn is_zero(self) -> bool {
        self.0 == 0
    }

    pub fn checked_add(self, other: MoneyCents) -> Result<Self, MoneyError> {
        Self::from_i128(self.0 as i128 + other.0 as i128)
    }

    pub fn checked_sub(self, other: MoneyCents) -> Result<Self, MoneyError> {
        Self::from_i128(self.0 as i128 - other.0 as i128)
    }

    /// Suma checked de una secuencia. El acumulador es i128 pero cada paso
    /// intermedio también debe quedar en rango (falla temprano y determinista).
    pub fn checked_sum<I: IntoIterator<Item = MoneyCents>>(items: I) -> Result<Self, MoneyError> {
        items
            .into_iter()
            .try_fold(MoneyCents::ZERO, |acc, item| acc.checked_add(item))
    }

    /// Precios, totales y ventas: ≥ 0.
    pub fn require_non_negative(self) -> Result<Self, MoneyError> {
        if self.0 < 0 {
            Err(MoneyError::Negative)
        } else {
            Ok(self)
        }
    }

    /// Pagos y abonos: > 0.
    pub fn require_positive(self) -> Result<Self, MoneyError> {
        if self.0 <= 0 {
            Err(MoneyError::NotPositive)
        } else {
            Ok(self)
        }
    }
}

impl fmt::Display for MoneyCents {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// Abono a deuda: `> 0` y `≤ saldo`. El saldo debe ser no negativo.
pub fn validate_credit_payment(
    amount: MoneyCents,
    balance: MoneyCents,
) -> Result<MoneyCents, MoneyError> {
    let amount = amount.require_positive()?;
    let balance = balance.require_non_negative()?;
    if amount > balance {
        return Err(MoneyError::Overpay);
    }
    Ok(amount)
}

/// Pago mixto de dos partes: ambas `> 0` y suma exacta igual al total.
pub fn validate_mixed_payment(
    first: MoneyCents,
    second: MoneyCents,
    total: MoneyCents,
) -> Result<(), MoneyError> {
    if first.cents() <= 0 || second.cents() <= 0 {
        return Err(MoneyError::MixedInvalid);
    }
    let sum = first.checked_add(second)?;
    if sum != total.require_non_negative()? {
        return Err(MoneyError::MixedInvalid);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(c: i64) -> MoneyCents {
        MoneyCents::from_cents(c).unwrap()
    }

    #[test]
    fn dto_roundtrip_normalized() {
        for s in [
            "0",
            "1",
            "-1",
            "12345",
            "9007199254740991",
            "-9007199254740991",
        ] {
            assert_eq!(MoneyCents::parse_dto(s).unwrap().to_dto(), s);
        }
    }

    #[test]
    fn dto_rejects_non_canonical() {
        for s in [
            "", "-", "+1", "01", "-0", "00", "1.0", "1e2", " 1", "1 ", "0x10", "١",
        ] {
            assert_eq!(
                MoneyCents::parse_dto(s),
                Err(MoneyError::Format),
                "input {s:?}"
            );
        }
    }

    #[test]
    fn dto_rejects_out_of_range() {
        assert_eq!(
            MoneyCents::parse_dto("9007199254740992"),
            Err(MoneyError::OutOfRange)
        );
        assert_eq!(
            MoneyCents::parse_dto("-9007199254740992"),
            Err(MoneyError::OutOfRange)
        );
        assert_eq!(
            MoneyCents::parse_dto("99999999999999999999999"),
            Err(MoneyError::OutOfRange)
        );
    }

    #[test]
    fn checked_accumulation_never_saturates() {
        let max = m(MAX_MAGNITUDE_CENTS);
        assert_eq!(max.checked_add(m(1)), Err(MoneyError::OutOfRange));
        assert_eq!(
            m(-MAX_MAGNITUDE_CENTS).checked_sub(m(1)),
            Err(MoneyError::OutOfRange)
        );
        assert_eq!(
            MoneyCents::checked_sum([max, m(1), m(-1)]),
            Err(MoneyError::OutOfRange)
        );
        assert_eq!(MoneyCents::checked_sum([m(150), m(250)]).unwrap(), m(400));
    }

    #[test]
    fn sign_rules() {
        assert!(m(0).require_non_negative().is_ok());
        assert_eq!(m(-1).require_non_negative(), Err(MoneyError::Negative));
        assert_eq!(m(0).require_positive(), Err(MoneyError::NotPositive));
        assert!(m(1).require_positive().is_ok());
    }

    #[test]
    fn credit_payment_bounds() {
        assert_eq!(validate_credit_payment(m(500), m(500)).unwrap(), m(500));
        assert_eq!(
            validate_credit_payment(m(501), m(500)),
            Err(MoneyError::Overpay)
        );
        assert_eq!(
            validate_credit_payment(m(0), m(500)),
            Err(MoneyError::NotPositive)
        );
        assert_eq!(
            validate_credit_payment(m(1), m(-5)),
            Err(MoneyError::Negative)
        );
    }

    #[test]
    fn mixed_payment_rules() {
        assert!(validate_mixed_payment(m(300), m(700), m(1000)).is_ok());
        assert_eq!(
            validate_mixed_payment(m(0), m(1000), m(1000)),
            Err(MoneyError::MixedInvalid)
        );
        assert_eq!(
            validate_mixed_payment(m(300), m(699), m(1000)),
            Err(MoneyError::MixedInvalid)
        );
        assert_eq!(
            validate_mixed_payment(m(-1), m(1001), m(1000)),
            Err(MoneyError::MixedInvalid)
        );
    }
}
