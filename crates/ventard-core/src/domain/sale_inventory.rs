//! Pure pre-commit inventory guard. Inputs belong to the trusted read-model,
//! never a renderer stock scalar or a POINT_IN_TIME catalogue preview.
use super::{
    identity::{EntityId, Scope, TenantRef},
    quantity::{recipe_effect, Ratio, StockQty},
};
use std::collections::{BTreeMap, HashMap, HashSet};
#[derive(Debug, Clone)]
pub struct StockAuthority {
    pub available: i32,
    pub revision: String,
    pub verified: bool,
}
#[derive(Debug, Clone)]
pub struct RecipePart {
    pub product_id: EntityId,
    pub per_unit: Ratio,
}
#[derive(Debug, Clone)]
pub struct InventoryProduct {
    pub reference: TenantRef,
    pub scope: Scope,
    pub revision: String,
    pub deleted: bool,
    pub serial_required: bool,
    pub recipe: Vec<RecipePart>,
    pub authority: Option<StockAuthority>,
}
#[derive(Debug, Clone)]
pub struct InventoryLine {
    pub product_id: EntityId,
    pub quantity: Ratio,
    pub expected_revision: String,
    pub serial: Option<String>,
}
#[derive(Debug, Clone)]
pub struct SerialAvailability {
    pub text: String,
    pub product_id: EntityId,
    pub tenant_id: EntityId,
    pub scope: Scope,
    pub available: bool,
    pub revision: String,
}
#[derive(Debug, PartialEq, Eq)]
pub struct InventoryEffect {
    pub product_id: EntityId,
    pub delta: i32,
    pub expected_revision: String,
}
#[derive(Debug, PartialEq, Eq)]
pub struct SerialEffect {
    pub text: String,
    pub product_id: EntityId,
    pub expected_revision: String,
}
#[derive(Debug, PartialEq, Eq)]
pub struct InventoryPlan {
    pub effects: Vec<InventoryEffect>,
    pub serials: Vec<SerialEffect>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InventoryError {
    Invalid,
    Unknown,
    Tenant,
    Scope,
    Version,
    Insufficient,
    Serial,
    Effect,
}
impl InventoryError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Invalid => "CONTRACT_INVALID",
            Self::Unknown => "STOCK_UNVERIFIED",
            Self::Tenant => "PERMISSION_DENIED",
            Self::Scope => "SCOPE_INVALID",
            Self::Version => "VERSION_CONFLICT",
            Self::Insufficient => "STOCK_UNAVAILABLE",
            Self::Serial => "SERIAL_CONFLICT",
            Self::Effect => "CONTRACT_INVALID",
        }
    }
}
fn member(p: &InventoryProduct, tenant: EntityId, scope: Scope) -> Result<(), InventoryError> {
    if p.reference.negocio_id != tenant {
        return Err(InventoryError::Tenant);
    }
    if p.scope != scope {
        return Err(InventoryError::Scope);
    }
    if p.deleted || p.revision.is_empty() {
        return Err(InventoryError::Invalid);
    }
    Ok(())
}
pub fn validate_inventory(
    tenant: EntityId,
    scope: Scope,
    lines: &[InventoryLine],
    products: &[InventoryProduct],
    serials: &[SerialAvailability],
) -> Result<InventoryPlan, InventoryError> {
    if scope == Scope::UnknownLegacy
        || lines.is_empty()
        || lines.len() > 100
        || products.len() > 10_000
        || serials.len() > 10_000
    {
        return Err(InventoryError::Invalid);
    }
    let mut catalogue = HashMap::new();
    for p in products {
        if catalogue.insert(p.reference.id, p).is_some() {
            return Err(InventoryError::Invalid);
        }
    }
    let mut serial_index = HashMap::new();
    for s in serials {
        if serial_index.insert(s.text.as_str(), s).is_some() {
            return Err(InventoryError::Serial);
        }
    }
    let mut consumed: BTreeMap<EntityId, StockQty> = BTreeMap::new();
    let mut used_serials = HashSet::new();
    let mut serial_effects = Vec::new();
    for line in lines {
        let p = catalogue
            .get(&line.product_id)
            .ok_or(InventoryError::Unknown)?;
        member(p, tenant, scope)?;
        if p.revision != line.expected_revision {
            return Err(InventoryError::Version);
        }
        if line.quantity.is_zero() {
            return Err(InventoryError::Invalid);
        }
        if p.serial_required {
            if line.quantity != Ratio::one() || !p.recipe.is_empty() {
                return Err(InventoryError::Serial);
            }
            let text = line
                .serial
                .as_deref()
                .filter(|s| !s.is_empty() && s.len() <= 256 && !s.chars().any(char::is_control))
                .ok_or(InventoryError::Serial)?;
            let serial = serial_index.get(text).ok_or(InventoryError::Serial)?;
            if !used_serials.insert(text)
                || !serial.available
                || serial.product_id != p.reference.id
                || serial.tenant_id != tenant
                || serial.scope != scope
                || serial.revision.is_empty()
            {
                return Err(InventoryError::Serial);
            }
            serial_effects.push(SerialEffect {
                text: text.into(),
                product_id: line.product_id,
                expected_revision: serial.revision.clone(),
            });
        } else if line.serial.is_some() {
            return Err(InventoryError::Serial);
        }
        let mut demand = |id: EntityId, ratio: &Ratio| -> Result<(), InventoryError> {
            if ratio.is_zero() {
                return Err(InventoryError::Effect);
            }
            let target = catalogue.get(&id).ok_or(InventoryError::Unknown)?;
            member(target, tenant, scope)?;
            // Recursive/cyclic recipes require separately characterized expansion. Never
            // silently decrement a combo scalar in place of its ingredients.
            if !target.recipe.is_empty() {
                return Err(InventoryError::Invalid);
            }
            if target.serial_required && id != line.product_id {
                return Err(InventoryError::Serial);
            }
            let qty = recipe_effect(&line.quantity, ratio).map_err(|_| InventoryError::Effect)?;
            let total = consumed
                .get(&id)
                .copied()
                .unwrap_or(StockQty::new(0).map_err(|_| InventoryError::Effect)?)
                .checked_add(qty)
                .map_err(|_| InventoryError::Effect)?;
            consumed.insert(id, total);
            Ok(())
        };
        if p.recipe.is_empty() {
            demand(line.product_id, &Ratio::one())?;
        } else {
            if p.recipe.len() > 100 {
                return Err(InventoryError::Invalid);
            }
            for ingredient in &p.recipe {
                demand(ingredient.product_id, &ingredient.per_unit)?;
            }
        }
    }
    let mut effects = Vec::new();
    for (id, qty) in consumed {
        let stock = catalogue[&id]
            .authority
            .as_ref()
            .filter(|s| s.verified && !s.revision.is_empty())
            .ok_or(InventoryError::Unknown)?;
        if qty.value() > stock.available {
            return Err(InventoryError::Insufficient);
        }
        effects.push(InventoryEffect {
            product_id: id,
            delta: qty
                .checked_neg()
                .map_err(|_| InventoryError::Effect)?
                .value(),
            expected_revision: stock.revision.clone(),
        });
    }
    serial_effects.sort_by(|a, b| a.text.cmp(&b.text));
    Ok(InventoryPlan {
        effects,
        serials: serial_effects,
    })
}
