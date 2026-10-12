//! Totales exactos de venta (núcleo de T053; FR-010, FR-011).
//!
//! Porte 1:1 de la política aprobada en `src/lib/domain/ventas/totales.ts`
//! (`calcularTotalesExactos`), caracterizada en
//! `packages/contracts/fixtures/legacy-commercial.json`:
//! - subtotal de línea = precio × cantidad, debe ser centavos exactos;
//! - ITBIS acumulado exacto sin redondeo por línea y half-up una vez por ticket;
//! - descuento sobre bruto (subtotal + ITBIS); porcentaje ≥ 100 o monto mayor
//!   que el bruto se limitan al bruto; porcentaje se redondea half-up.

use crate::domain::identity::EntityId;
use crate::domain::money::{MoneyCents, MoneyError};
use crate::domain::quantity::{QuantityError, Ratio};
use num_bigint::BigUint;
use num_traits::{ToPrimitive, Zero};
use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuoteLine {
    /// Precio unitario en centavos (≥ 0).
    pub unit_price: MoneyCents,
    /// Cantidad exacta (> 0).
    pub quantity: Ratio,
    /// Tasa ITBIS como fracción en [0, 1] (0.18 = 9/50).
    pub tax_rate: Ratio,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Discount {
    /// Porcentaje como número de puntos (10 = 10 %).
    Percent(Ratio),
    Amount(MoneyCents),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct QuoteTotals {
    pub subtotal: MoneyCents,
    pub itbis: MoneyCents,
    pub discount: MoneyCents,
    pub total: MoneyCents,
}

pub const CALCULATION_VERSION: &str = "ventard.sale.calculation.1";

/// Hechos de catálogo seleccionados por el core; no se reconstruyen al imprimir
/// o sincronizar. None conserva costo/revisión desconocidos, nunca los fabrica.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistoricalIngredient {
    pub product_id: EntityId,
    pub quantity_per_unit: Ratio,
    pub revision: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistoricalQuoteLine {
    pub product_id: Option<EntityId>,
    pub product_revision: Option<String>,
    pub name: String,
    pub unit_price: MoneyCents,
    pub quantity: Ratio,
    pub tax_rate: Ratio,
    pub cost: Option<MoneyCents>,
    pub recipe: Vec<HistoricalIngredient>,
    pub serial: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuoteSnapshot {
    pub calculation_version: &'static str,
    pub lines: Vec<HistoricalQuoteLine>,
    pub discount: Discount,
    pub totals: QuoteTotals,
}

/// Quote es puro y dueño de sus snapshots. Autorización, versiones vigentes,
/// disponibilidad, reservas/serial y turno se revalidan en commit (T054–T060).
pub fn quote_snapshot(
    lines: &[HistoricalQuoteLine],
    discount: &Discount,
) -> Result<QuoteSnapshot, QuoteError> {
    let calculation: Vec<_> = lines
        .iter()
        .map(|line| QuoteLine {
            unit_price: line.unit_price,
            quantity: line.quantity.clone(),
            tax_rate: line.tax_rate.clone(),
        })
        .collect();
    let totals = calculate_totals(&calculation, discount)?;
    Ok(QuoteSnapshot {
        calculation_version: CALCULATION_VERSION,
        lines: lines.to_vec(),
        discount: discount.clone(),
        totals,
    })
}

/// Errores con los mismos códigos que el legacy para paridad de fixtures.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuoteError {
    QuantityInvalid,
    SubtotalNotRepresentable,
    TaxInvalid,
    OutOfRange,
    Money(MoneyError),
    Quantity(QuantityError),
}

impl QuoteError {
    /// Código legacy equivalente (`importe_*`).
    pub fn code(&self) -> &'static str {
        match self {
            QuoteError::QuantityInvalid => "importe_cantidad_invalida",
            QuoteError::SubtotalNotRepresentable => "importe_subtotal_no_representable",
            QuoteError::TaxInvalid => "importe_tasa_invalida",
            QuoteError::OutOfRange => "importe_centavos_fuera_rango",
            QuoteError::Money(_) => "importe_no_representable_en_centavos",
            QuoteError::Quantity(_) => "importe_decimal_invalido",
        }
    }
}

impl fmt::Display for QuoteError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.code())
    }
}

impl std::error::Error for QuoteError {}

impl From<MoneyError> for QuoteError {
    fn from(e: MoneyError) -> Self {
        match e {
            MoneyError::OutOfRange => QuoteError::OutOfRange,
            other => QuoteError::Money(other),
        }
    }
}

impl From<QuantityError> for QuoteError {
    fn from(e: QuantityError) -> Self {
        QuoteError::Quantity(e)
    }
}

fn round_half_up(n: &BigUint, d: &BigUint) -> BigUint {
    (n * 2u8 + d) / (d * 2u8)
}

fn to_money(v: &BigUint) -> Result<MoneyCents, QuoteError> {
    let cents = v.to_i64().ok_or(QuoteError::OutOfRange)?;
    Ok(MoneyCents::from_cents(cents)?)
}

pub fn calculate_totals(
    lines: &[QuoteLine],
    discount: &Discount,
) -> Result<QuoteTotals, QuoteError> {
    let mut subtotal = BigUint::zero();
    let mut tax = Ratio::zero();
    for line in lines {
        let price = line.unit_price.require_non_negative()?;
        if line.quantity.is_zero() {
            return Err(QuoteError::QuantityInvalid);
        }
        if line.tax_rate.numerator() > line.tax_rate.denominator() {
            return Err(QuoteError::TaxInvalid);
        }
        let product = BigUint::from(price.cents() as u64) * line.quantity.numerator();
        if !(&product % line.quantity.denominator()).is_zero() {
            return Err(QuoteError::SubtotalNotRepresentable);
        }
        let line_total = product / line.quantity.denominator();
        tax = tax.checked_add(
            &Ratio::from_parts(line_total.clone(), BigUint::from(1u8))?
                .checked_mul(&line.tax_rate)?,
        )?;
        subtotal += line_total;
    }
    let itbis = round_half_up(tax.numerator(), tax.denominator());
    let gross = &subtotal + &itbis;
    let requested = match discount {
        Discount::Amount(m) => BigUint::from(m.require_non_negative()?.cents() as u64),
        Discount::Percent(p) => {
            let hundred = BigUint::from(100u8);
            if p.numerator() >= &(p.denominator() * &hundred) {
                gross.clone()
            } else {
                round_half_up(&(&gross * p.numerator()), &(p.denominator() * hundred))
            }
        }
    };
    let applied = if requested > gross {
        gross.clone()
    } else {
        requested
    };
    let total = &gross - &applied;
    Ok(QuoteTotals {
        subtotal: to_money(&subtotal)?,
        itbis: to_money(&itbis)?,
        discount: to_money(&applied)?,
        total: to_money(&total)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(price: i64, qty: &str, tax: &str) -> QuoteLine {
        QuoteLine {
            unit_price: MoneyCents::from_cents(price).unwrap(),
            quantity: Ratio::parse_legacy_decimal(qty).unwrap(),
            tax_rate: Ratio::parse_legacy_decimal(tax).unwrap(),
        }
    }

    #[test]
    fn itbis_aggregated_then_rounded_once() {
        // 3 líneas de 0.03 con 18 %: por línea 0.54 c cada una (redondeo por
        // línea daría 3 c); agregado 1.62 c → 2 c.
        let lines = vec![
            line(3, "1", "0.18"),
            line(3, "1", "0.18"),
            line(3, "1", "0.18"),
        ];
        let t = calculate_totals(&lines, &Discount::Amount(MoneyCents::ZERO)).unwrap();
        assert_eq!(
            (t.subtotal.cents(), t.itbis.cents(), t.total.cents()),
            (9, 2, 11)
        );
    }

    #[test]
    fn discount_on_gross_and_capped() {
        let lines = vec![line(10000, "1", "0.18")];
        let pct = calculate_totals(&lines, &Discount::Percent(Ratio::from_integer(10))).unwrap();
        assert_eq!((pct.discount.cents(), pct.total.cents()), (1180, 10620));
        let over = calculate_totals(
            &lines,
            &Discount::Amount(MoneyCents::from_cents(999999).unwrap()),
        )
        .unwrap();
        assert_eq!((over.discount.cents(), over.total.cents()), (11800, 0));
        let full = calculate_totals(&lines, &Discount::Percent(Ratio::from_integer(150))).unwrap();
        assert_eq!(full.total.cents(), 0);
    }

    #[test]
    fn non_representable_subtotal_is_error() {
        let lines = vec![line(1, "0.5", "0")];
        assert_eq!(
            calculate_totals(&lines, &Discount::Amount(MoneyCents::ZERO)),
            Err(QuoteError::SubtotalNotRepresentable)
        );
    }

    #[test]
    fn zero_quantity_and_invalid_tax() {
        assert_eq!(
            calculate_totals(&[line(100, "0", "0")], &Discount::Amount(MoneyCents::ZERO)),
            Err(QuoteError::QuantityInvalid)
        );
        assert_eq!(
            calculate_totals(
                &[line(100, "1", "1.5")],
                &Discount::Amount(MoneyCents::ZERO)
            ),
            Err(QuoteError::TaxInvalid)
        );
    }

    #[test]
    fn empty_ticket_is_zero() {
        let t = calculate_totals(&[], &Discount::Amount(MoneyCents::ZERO)).unwrap();
        assert_eq!(t.total, MoneyCents::ZERO);
    }
}
