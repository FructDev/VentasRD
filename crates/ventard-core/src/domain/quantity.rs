//! Cantidades exactas: razones racionales y stock int4 (T024, FR-011, FR-012).
//!
//! Contrato C-N1 (`operations-v1.md` §Números):
//! - numerador ≥ 0, denominador > 0, reducido por gcd; cero = 0/1.
//! - cada entero ≤ 400 dígitos decimales (tope de diseño D26, revisable en G0).
//! - entradas decimales: denominador reducido sólo con factores 2 y 5.
//! - nunca f64 ni redondeo; una receta que no produce entero es error.
//! - efectos de stock: int4 `[-2147483648, 2147483647]`.

use num_bigint::{BigInt, BigUint};
use num_integer::Integer;
use num_traits::{One, ToPrimitive, Zero};
use std::fmt;

/// Tope inicial de dígitos por entero (D26). G0 confirma el límite efectivo.
pub const MAX_INTEGER_DIGITS: usize = 400;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuantityError {
    Format,
    ZeroDenominator,
    NotReduced,
    TooManyDigits,
    NotDecimal,
    NotInteger,
    StockOutOfRange,
    Negative,
}

impl fmt::Display for QuantityError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let code = match self {
            QuantityError::Format => "quantity_format_invalid",
            QuantityError::ZeroDenominator => "quantity_zero_denominator",
            QuantityError::NotReduced => "quantity_not_reduced",
            QuantityError::TooManyDigits => "quantity_too_many_digits",
            QuantityError::NotDecimal => "quantity_not_decimal",
            QuantityError::NotInteger => "quantity_not_integer",
            QuantityError::StockOutOfRange => "stock_out_of_range",
            QuantityError::Negative => "quantity_negative",
        };
        f.write_str(code)
    }
}

impl std::error::Error for QuantityError {}

/// Entero decimal C-N1 no negativo: `0` o `[1-9][0-9]*`, sin signo.
fn parse_canonical_uint(s: &str) -> Result<BigUint, QuantityError> {
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) || (s.len() > 1 && s.starts_with('0'))
    {
        return Err(QuantityError::Format);
    }
    if s.len() > MAX_INTEGER_DIGITS {
        return Err(QuantityError::TooManyDigits);
    }
    s.parse::<BigUint>().map_err(|_| QuantityError::Format)
}

fn check_digits(v: &BigUint) -> Result<(), QuantityError> {
    // Cálculo barato: bits·log10(2) acota dígitos; sólo convertir en el borde.
    let bits = v.bits();
    if bits <= 1300 {
        return Ok(()); // 2^1300 < 10^392
    }
    if v.to_str_radix(10).len() > MAX_INTEGER_DIGITS {
        return Err(QuantityError::TooManyDigits);
    }
    Ok(())
}

/// Razón exacta no negativa en forma canónica reducida.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Ratio {
    n: BigUint,
    d: BigUint,
}

impl Ratio {
    pub fn zero() -> Self {
        Ratio {
            n: BigUint::zero(),
            d: BigUint::one(),
        }
    }

    pub fn one() -> Self {
        Ratio {
            n: BigUint::one(),
            d: BigUint::one(),
        }
    }

    /// Construye y reduce. Verifica denominador > 0 y tope de dígitos.
    pub fn from_parts(n: BigUint, d: BigUint) -> Result<Self, QuantityError> {
        if d.is_zero() {
            return Err(QuantityError::ZeroDenominator);
        }
        let (n, d) = if n.is_zero() {
            (BigUint::zero(), BigUint::one())
        } else {
            let g = n.gcd(&d);
            (n / &g, d / g)
        };
        check_digits(&n)?;
        check_digits(&d)?;
        Ok(Ratio { n, d })
    }

    pub fn from_integer(v: u64) -> Self {
        Ratio {
            n: BigUint::from(v),
            d: BigUint::one(),
        }
    }

    /// Parse estricto del DTO C-N1: ambos enteros canónicos y ya reducidos.
    /// Una forma no reducida se rechaza en vez de normalizarse en silencio,
    /// porque cambiaría los bytes canónicos y el hash de la intención.
    pub fn parse_canonical(n: &str, d: &str) -> Result<Self, QuantityError> {
        let n = parse_canonical_uint(n)?;
        let d = parse_canonical_uint(d)?;
        let r = Ratio::from_parts(n.clone(), d.clone())?;
        if r.n != n || r.d != d {
            return Err(QuantityError::NotReduced);
        }
        Ok(r)
    }

    /// Decimal legacy (salida de `Number.prototype.toString` en el PWA),
    /// incluida notación científica: `1.5`, `1e-7`, `2.5e+21`.
    /// Mismo resultado que `decimalRatio` de `src/lib/domain/local/decimal.ts`,
    /// pero reducido. Negativos se rechazan como en legacy.
    pub fn parse_legacy_decimal(s: &str) -> Result<Self, QuantityError> {
        let lower = s.to_ascii_lowercase();
        let (mantissa, exponent) = match lower.split_once('e') {
            Some((m, e)) => (m, e),
            None => (lower.as_str(), "0"),
        };
        if mantissa.starts_with('-') {
            return Err(QuantityError::Negative);
        }
        let (integer, fraction) = mantissa.split_once('.').unwrap_or((mantissa, ""));
        if integer.is_empty()
            || !integer.bytes().all(|b| b.is_ascii_digit())
            || !fraction.bytes().all(|b| b.is_ascii_digit())
            || (mantissa.contains('.') && fraction.is_empty())
        {
            return Err(QuantityError::Format);
        }
        let exp_digits = exponent.strip_prefix(['+', '-']).unwrap_or(exponent);
        if exp_digits.is_empty()
            || exp_digits.len() > 4
            || !exp_digits.bytes().all(|b| b.is_ascii_digit())
        {
            return Err(QuantityError::Format);
        }
        let exp: i64 = exponent.parse().map_err(|_| QuantityError::Format)?;
        let scale = fraction.len() as i64 - exp;
        if scale.unsigned_abs() as usize > MAX_INTEGER_DIGITS {
            return Err(QuantityError::TooManyDigits);
        }
        let digits = format!("{integer}{fraction}");
        if digits.len() > MAX_INTEGER_DIGITS {
            return Err(QuantityError::TooManyDigits);
        }
        let n: BigUint = digits.parse().map_err(|_| QuantityError::Format)?;
        let ten = BigUint::from(10u8);
        if scale < 0 {
            Ratio::from_parts(n * ten.pow((-scale) as u32), BigUint::one())
        } else {
            Ratio::from_parts(n, ten.pow(scale as u32))
        }
    }

    pub fn numerator(&self) -> &BigUint {
        &self.n
    }

    pub fn denominator(&self) -> &BigUint {
        &self.d
    }

    pub fn is_zero(&self) -> bool {
        self.n.is_zero()
    }

    /// Representación DTO `(numerador, denominador)` como strings decimales.
    pub fn to_dto(&self) -> (String, String) {
        (self.n.to_str_radix(10), self.d.to_str_radix(10))
    }

    /// Denominador reducido con factores sólo 2/5 (entrada decimal válida).
    pub fn is_decimal(&self) -> bool {
        let mut d = self.d.clone();
        let two = BigUint::from(2u8);
        let five = BigUint::from(5u8);
        while d.is_even() {
            d /= &two;
        }
        while (&d % &five).is_zero() {
            d /= &five;
        }
        d.is_one()
    }

    pub fn require_decimal(self) -> Result<Self, QuantityError> {
        if self.is_decimal() {
            Ok(self)
        } else {
            Err(QuantityError::NotDecimal)
        }
    }

    pub fn checked_mul(&self, other: &Ratio) -> Result<Ratio, QuantityError> {
        Ratio::from_parts(&self.n * &other.n, &self.d * &other.d)
    }

    pub fn checked_add(&self, other: &Ratio) -> Result<Ratio, QuantityError> {
        Ratio::from_parts(&self.n * &other.d + &other.n * &self.d, &self.d * &other.d)
    }

    /// Entero exacto o error; nunca redondea ni trunca.
    pub fn to_exact_integer(&self) -> Result<BigUint, QuantityError> {
        if self.d.is_one() {
            Ok(self.n.clone())
        } else {
            Err(QuantityError::NotInteger)
        }
    }
}

impl fmt::Display for Ratio {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}/{}", self.n, self.d)
    }
}

/// Delta o nivel de stock en rango int4 (PG `integer`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct StockQty(i32);

impl StockQty {
    pub fn new(v: i64) -> Result<Self, QuantityError> {
        i32::try_from(v)
            .map(StockQty)
            .map_err(|_| QuantityError::StockOutOfRange)
    }

    pub fn from_bigint(v: &BigInt) -> Result<Self, QuantityError> {
        v.to_i32()
            .map(StockQty)
            .ok_or(QuantityError::StockOutOfRange)
    }

    /// DTO: entero canónico con signo, `-0` y `+` prohibidos.
    pub fn parse_dto(s: &str) -> Result<Self, QuantityError> {
        let digits = s.strip_prefix('-').unwrap_or(s);
        let negative = digits.len() != s.len();
        if digits.is_empty()
            || !digits.bytes().all(|b| b.is_ascii_digit())
            || (digits.len() > 1 && digits.starts_with('0'))
            || (negative && digits == "0")
        {
            return Err(QuantityError::Format);
        }
        if digits.len() > 10 {
            return Err(QuantityError::StockOutOfRange);
        }
        let v: i64 = s.parse().map_err(|_| QuantityError::Format)?;
        StockQty::new(v)
    }

    pub fn value(self) -> i32 {
        self.0
    }

    pub fn to_dto(self) -> String {
        self.0.to_string()
    }

    pub fn checked_add(self, other: StockQty) -> Result<Self, QuantityError> {
        self.0
            .checked_add(other.0)
            .map(StockQty)
            .ok_or(QuantityError::StockOutOfRange)
    }

    pub fn checked_neg(self) -> Result<Self, QuantityError> {
        self.0
            .checked_neg()
            .map(StockQty)
            .ok_or(QuantityError::StockOutOfRange)
    }
}

/// Efecto de una receta: `cantidad_vendida × ratio_insumo`, que debe ser un
/// entero exacto dentro de int4. El efecto agregado por producto se acumula
/// después con [`StockQty::checked_add`].
pub fn recipe_effect(sold: &Ratio, per_unit: &Ratio) -> Result<StockQty, QuantityError> {
    let product = sold.checked_mul(per_unit)?;
    let integer = product.to_exact_integer()?;
    StockQty::from_bigint(&BigInt::from(integer))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(n: u64, d: u64) -> Ratio {
        Ratio::from_parts(BigUint::from(n), BigUint::from(d)).unwrap()
    }

    #[test]
    fn reduces_and_zero_is_canonical() {
        assert_eq!(r(6, 4).to_dto(), ("3".into(), "2".into()));
        assert_eq!(r(0, 7).to_dto(), ("0".into(), "1".into()));
        assert_eq!(
            Ratio::from_parts(BigUint::from(1u8), BigUint::zero()),
            Err(QuantityError::ZeroDenominator)
        );
    }

    #[test]
    fn canonical_parse_is_strict() {
        assert_eq!(Ratio::parse_canonical("3", "2").unwrap(), r(3, 2));
        assert_eq!(Ratio::parse_canonical("0", "1").unwrap(), Ratio::zero());
        assert_eq!(
            Ratio::parse_canonical("6", "4"),
            Err(QuantityError::NotReduced)
        );
        assert_eq!(
            Ratio::parse_canonical("0", "5"),
            Err(QuantityError::NotReduced)
        );
        assert_eq!(
            Ratio::parse_canonical("1", "0"),
            Err(QuantityError::ZeroDenominator)
        );
        for bad in ["-1", "+1", "01", "1.5", "", " 1"] {
            assert_eq!(
                Ratio::parse_canonical(bad, "1"),
                Err(QuantityError::Format),
                "{bad:?}"
            );
        }
        let big = "1".repeat(MAX_INTEGER_DIGITS + 1);
        assert_eq!(
            Ratio::parse_canonical(&big, "1"),
            Err(QuantityError::TooManyDigits)
        );
        let ok = format!("1{}", "0".repeat(MAX_INTEGER_DIGITS - 1));
        assert!(Ratio::parse_canonical(&ok, "1").is_ok());
    }

    #[test]
    fn legacy_decimal_matches_decimal_ratio() {
        assert_eq!(Ratio::parse_legacy_decimal("1.5").unwrap(), r(3, 2));
        assert_eq!(Ratio::parse_legacy_decimal("0.18").unwrap(), r(9, 50));
        assert_eq!(
            Ratio::parse_legacy_decimal("1e-7").unwrap(),
            r(1, 10_000_000)
        );
        assert_eq!(Ratio::parse_legacy_decimal("2.5e+3").unwrap(), r(2500, 1));
        assert_eq!(Ratio::parse_legacy_decimal("0").unwrap(), Ratio::zero());
        assert_eq!(
            Ratio::parse_legacy_decimal("-1"),
            Err(QuantityError::Negative)
        );
        for bad in [
            "", "abc", "1.", ".5", "1e", "1e+", "NaN", "Infinity", "1..2",
        ] {
            assert!(Ratio::parse_legacy_decimal(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn decimal_denominator_only_two_and_five() {
        assert!(r(1, 40).is_decimal());
        assert!(!r(1, 3).is_decimal());
        assert_eq!(r(1, 3).require_decimal(), Err(QuantityError::NotDecimal));
    }

    #[test]
    fn recipe_effects_are_exact_integers() {
        // 4 unidades × 1/2 kg = 2
        assert_eq!(recipe_effect(&r(4, 1), &r(1, 2)).unwrap().value(), 2);
        // 3 × 1/2 = 3/2 no se redondea
        assert_eq!(
            recipe_effect(&r(3, 1), &r(1, 2)),
            Err(QuantityError::NotInteger)
        );
        // fuera de int4
        assert_eq!(
            recipe_effect(&r(2_147_483_648, 1), &r(1, 1)),
            Err(QuantityError::StockOutOfRange)
        );
    }

    #[test]
    fn stock_int4_bounds() {
        assert_eq!(StockQty::parse_dto("2147483647").unwrap().value(), i32::MAX);
        assert_eq!(
            StockQty::parse_dto("-2147483648").unwrap().value(),
            i32::MIN
        );
        assert_eq!(
            StockQty::parse_dto("2147483648"),
            Err(QuantityError::StockOutOfRange)
        );
        assert_eq!(StockQty::parse_dto("-0"), Err(QuantityError::Format));
        assert_eq!(StockQty::parse_dto("+1"), Err(QuantityError::Format));
        let max = StockQty::new(i32::MAX as i64).unwrap();
        assert_eq!(
            max.checked_add(StockQty::new(1).unwrap()),
            Err(QuantityError::StockOutOfRange)
        );
        assert_eq!(
            StockQty::new(i32::MIN as i64).unwrap().checked_neg(),
            Err(QuantityError::StockOutOfRange)
        );
    }
}
