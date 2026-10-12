//! Identidad, scope y tiempo (T025; FR-006, FR-013, FR-035).
//!
//! - IDs nuevos: UUID v4 aleatorio (CSPRNG del OS); nunca se ordena por UUID.
//! - Clave compuesta tenant+id: ninguna referencia cruza tenants.
//! - Scope: GLOBAL y BRANCH son conocidos; UNKNOWN_LEGACY sólo existe en
//!   archivo importado y un comando nuevo no puede usarlo ni completarlo con
//!   la sesión actual (`operations-v1.md` §Envolvente).
//! - Tiempo: UTC epoch-ms entero, serializado como string decimal en DTO.

use std::fmt;
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IdentityError {
    UuidFormat,
    UuidNil,
    ScopeInvalid,
    ScopeUnknownNotAllowed,
    CrossTenant,
    TimeFormat,
}

impl fmt::Display for IdentityError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let code = match self {
            IdentityError::UuidFormat => "uuid_format_invalid",
            IdentityError::UuidNil => "uuid_nil",
            IdentityError::ScopeInvalid => "SCOPE_INVALID",
            IdentityError::ScopeUnknownNotAllowed => "SCOPE_INVALID",
            IdentityError::CrossTenant => "cross_tenant_reference",
            IdentityError::TimeFormat => "time_format_invalid",
        };
        f.write_str(code)
    }
}

impl std::error::Error for IdentityError {}

/// UUID canónico en minúsculas con guiones. Acepta versiones 1–8 como el
/// legacy (`UUID_PATTERN` de inventory/canonical-payload.ts) para referencias
/// existentes; los IDs nuevos se generan con [`EntityId::new_random`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct EntityId(Uuid);

impl EntityId {
    pub fn new_random() -> Self {
        EntityId(Uuid::new_v4())
    }

    pub fn parse(s: &str) -> Result<Self, IdentityError> {
        // Forma hyphenated de 36 caracteres en minúsculas; sin llaves/urn.
        let lower_hyphenated = s.len() == 36
            && s.bytes().enumerate().all(|(i, b)| match i {
                8 | 13 | 18 | 23 => b == b'-',
                _ => b.is_ascii_digit() || (b'a'..=b'f').contains(&b),
            });
        if !lower_hyphenated {
            return Err(IdentityError::UuidFormat);
        }
        let u = Uuid::parse_str(s).map_err(|_| IdentityError::UuidFormat)?;
        if u.is_nil() {
            return Err(IdentityError::UuidNil);
        }
        let version = u.get_version_num();
        let variant_ok = matches!(u.get_variant(), uuid::Variant::RFC4122);
        if !(1..=8).contains(&version) || !variant_ok {
            return Err(IdentityError::UuidFormat);
        }
        Ok(EntityId(u))
    }

    pub fn as_uuid(&self) -> &Uuid {
        &self.0
    }
}

impl fmt::Display for EntityId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0.hyphenated())
    }
}

/// Referencia tenant+id. La comparación de pertenencia es explícita.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct TenantRef {
    pub negocio_id: EntityId,
    pub id: EntityId,
}

impl TenantRef {
    /// Verifica que una referencia pertenezca al tenant del contexto.
    pub fn require_tenant(&self, negocio_id: &EntityId) -> Result<&Self, IdentityError> {
        if &self.negocio_id == negocio_id {
            Ok(self)
        } else {
            Err(IdentityError::CrossTenant)
        }
    }
}

/// Scope de un dato. `UnknownLegacy` existe sólo para historia importada.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Scope {
    Global,
    Branch(EntityId),
    UnknownLegacy,
}

impl Scope {
    /// Parse del DTO de comando nuevo: `{type:'GLOBAL',sucursalId:null}` o
    /// `{type:'BRANCH',sucursalId:UUID}`. Ausencia o UNKNOWN se rechazan.
    pub fn parse_command(
        kind: Option<&str>,
        sucursal_id: Option<&str>,
    ) -> Result<Scope, IdentityError> {
        match (kind, sucursal_id) {
            (Some("GLOBAL"), None) => Ok(Scope::Global),
            (Some("BRANCH"), Some(id)) => Ok(Scope::Branch(EntityId::parse(id)?)),
            (Some("UNKNOWN_LEGACY"), _) => Err(IdentityError::ScopeUnknownNotAllowed),
            _ => Err(IdentityError::ScopeInvalid),
        }
    }

    /// Clasificación de un registro legacy importado: ausencia → UNKNOWN,
    /// nunca GLOBAL. GLOBAL sólo si el origen lo declaró explícitamente.
    pub fn from_legacy(explicit_global: bool, sucursal_id: Option<&str>) -> Scope {
        match (explicit_global, sucursal_id) {
            (false, Some(id)) => EntityId::parse(id)
                .map(Scope::Branch)
                .unwrap_or(Scope::UnknownLegacy),
            (true, None) => Scope::Global,
            _ => Scope::UnknownLegacy,
        }
    }

    pub fn require_known(self) -> Result<Scope, IdentityError> {
        match self {
            Scope::UnknownLegacy => Err(IdentityError::ScopeUnknownNotAllowed),
            s => Ok(s),
        }
    }

    pub fn type_str(&self) -> &'static str {
        match self {
            Scope::Global => "GLOBAL",
            Scope::Branch(_) => "BRANCH",
            Scope::UnknownLegacy => "UNKNOWN_LEGACY",
        }
    }
}

/// Instante UTC en milisegundos desde epoch. No participa en dedupe ni orden causal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct UtcMillis(i64);

impl UtcMillis {
    pub fn new(ms: i64) -> Self {
        UtcMillis(ms)
    }

    /// DTO: entero decimal canónico (permite negativos para fechas < 1970).
    pub fn parse_dto(s: &str) -> Result<Self, IdentityError> {
        let digits = s.strip_prefix('-').unwrap_or(s);
        let negative = digits.len() != s.len();
        if digits.is_empty()
            || digits.len() > 16
            || !digits.bytes().all(|b| b.is_ascii_digit())
            || (digits.len() > 1 && digits.starts_with('0'))
            || (negative && digits == "0")
        {
            return Err(IdentityError::TimeFormat);
        }
        s.parse()
            .map(UtcMillis)
            .map_err(|_| IdentityError::TimeFormat)
    }

    pub fn to_dto(self) -> String {
        self.0.to_string()
    }

    pub fn millis(self) -> i64 {
        self.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
    const B: &str = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

    #[test]
    fn random_ids_are_v4_and_unique() {
        let a = EntityId::new_random();
        let b = EntityId::new_random();
        assert_ne!(a, b);
        assert_eq!(a.as_uuid().get_version_num(), 4);
        assert_eq!(EntityId::parse(&a.to_string()).unwrap(), a);
    }

    #[test]
    fn uuid_parse_strict() {
        assert!(EntityId::parse(A).is_ok());
        assert_eq!(
            EntityId::parse(&A.to_uppercase()),
            Err(IdentityError::UuidFormat)
        );
        assert_eq!(
            EntityId::parse(&format!("{{{A}}}")),
            Err(IdentityError::UuidFormat)
        );
        assert_eq!(
            EntityId::parse("3f2504e04f8941d39a0c0305e82c3301"),
            Err(IdentityError::UuidFormat)
        );
        assert_eq!(
            EntityId::parse("00000000-0000-0000-0000-000000000000"),
            Err(IdentityError::UuidNil)
        );
        // variante no RFC 4122
        assert_eq!(
            EntityId::parse("3f2504e0-4f89-41d3-ca0c-0305e82c3301"),
            Err(IdentityError::UuidFormat)
        );
    }

    #[test]
    fn command_scope_never_unknown() {
        assert_eq!(
            Scope::parse_command(Some("GLOBAL"), None).unwrap(),
            Scope::Global
        );
        assert!(matches!(
            Scope::parse_command(Some("BRANCH"), Some(A)).unwrap(),
            Scope::Branch(_)
        ));
        assert_eq!(
            Scope::parse_command(Some("GLOBAL"), Some(A)),
            Err(IdentityError::ScopeInvalid)
        );
        assert_eq!(
            Scope::parse_command(Some("BRANCH"), None),
            Err(IdentityError::ScopeInvalid)
        );
        assert_eq!(
            Scope::parse_command(None, None),
            Err(IdentityError::ScopeInvalid)
        );
        assert_eq!(
            Scope::parse_command(Some("UNKNOWN_LEGACY"), None),
            Err(IdentityError::ScopeUnknownNotAllowed)
        );
    }

    #[test]
    fn legacy_absence_is_unknown_not_global() {
        assert_eq!(Scope::from_legacy(false, None), Scope::UnknownLegacy);
        assert_eq!(Scope::from_legacy(true, None), Scope::Global);
        assert_eq!(
            Scope::from_legacy(false, Some("no-uuid")),
            Scope::UnknownLegacy
        );
        assert_eq!(
            Scope::from_legacy(true, Some(A)),
            Scope::UnknownLegacy,
            "contradictorio"
        );
        assert_eq!(
            Scope::UnknownLegacy.require_known(),
            Err(IdentityError::ScopeUnknownNotAllowed)
        );
    }

    #[test]
    fn cross_tenant_rejected() {
        let t1 = EntityId::parse(A).unwrap();
        let t2 = EntityId::parse(B).unwrap();
        let r = TenantRef {
            negocio_id: t1,
            id: EntityId::new_random(),
        };
        assert!(r.require_tenant(&t1).is_ok());
        assert_eq!(r.require_tenant(&t2), Err(IdentityError::CrossTenant));
    }

    #[test]
    fn time_dto() {
        assert_eq!(
            UtcMillis::parse_dto("1791489998000").unwrap().millis(),
            1_791_489_998_000
        );
        for bad in ["", "-0", "+1", "01", "1.0", "1e3", "12345678901234567"] {
            assert_eq!(
                UtcMillis::parse_dto(bad),
                Err(IdentityError::TimeFormat),
                "{bad:?}"
            );
        }
    }
}
