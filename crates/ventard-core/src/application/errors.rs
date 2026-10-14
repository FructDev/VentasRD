use serde::{Deserialize, Serialize};

/// Strongly typed errors across the application.
#[derive(Debug)]
pub enum AppError {
    Storage(String),
    Business(BusinessError),
    Auth(AuthError),
    Protocol(ProtocolError),
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub enum BusinessError {
    SaleGuard {
        code: String,
    },
    InsufficientStock {
        product: String,
        available: String,
        requested: String,
    },
    InvalidAmount {
        message: String,
    },
    DuplicateOperation {
        operation_id: String,
    },
    Conflict {
        message: String,
    },
    OperationAbandoned,
    ProductCodeExists,
    FiscalUnknown,
    FiscalExhausted,
    HistorySnapshotUnavailable,
    HistorySnapshotCorrupt,
}

#[derive(Debug, Serialize, Deserialize)]
pub enum AuthError {
    TokenExpired,
    PermissionDenied { required: String },
    InvalidSignature,
}

#[derive(Debug, Serialize, Deserialize)]
pub enum ProtocolError {
    MalformedPayload,
    HashMismatch,
    OperationIdConflict,
    InvalidStateTransition,
}

/// Única forma prevista para diagnóstico/IPC: ningún raw SQL, path o mensaje
/// libre del error cruza esta frontera. Correlación se añade por el shell.
#[derive(Debug, Serialize)]
pub struct SafeError {
    pub code: &'static str,
    pub retryable: bool,
}

impl AppError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Business(BusinessError::SaleGuard { code }) => match code.as_str() {
                "HISTORY_MIGRATION_REQUIRED" => "HISTORY_MIGRATION_REQUIRED",
                "HISTORY_SYNC_REQUIRED" => "HISTORY_SYNC_REQUIRED",
                "TURN_REQUIRED" => "TURN_REQUIRED",
                "TURN_CHANGED" => "TURN_CHANGED",
                "STOCK_UNVERIFIED" => "STOCK_UNVERIFIED",
                "STOCK_UNAVAILABLE" => "STOCK_UNAVAILABLE",
                "VERSION_CONFLICT" => "VERSION_CONFLICT",
                "SERIAL_CONFLICT" => "SERIAL_CONFLICT",
                "SERIAL_INVENTORY_DIVERGED" => "SERIAL_INVENTORY_DIVERGED",
                "CREDIT_LIMIT" => "CREDIT_LIMIT",
                "CREDIT_OVERPAY" => "CREDIT_OVERPAY",
                "CREDIT_BALANCE_PENDING" => "CREDIT_BALANCE_PENDING",
                "CASH_PENDING" => "CASH_PENDING",
                "CASH_UNVERIFIED" => "CASH_UNVERIFIED",
                "RETURN_FISCAL_PENDING" => "RETURN_FISCAL_PENDING",
                "PRO_REQUIRED" => "PRO_REQUIRED",
                "SETTINGS_MIGRATION_REQUIRED" => "SETTINGS_MIGRATION_REQUIRED",
                "SERVICE_STATE_INVALID" => "SERVICE_STATE_INVALID",
                "SERVICE_OVERPAY" => "SERVICE_OVERPAY",
                "SERVICE_REFUND_EXCESS" => "SERVICE_REFUND_EXCESS",
                "SERVICE_REFUND_DIVERGED" => "SERVICE_REFUND_DIVERGED",
                "SERVICE_REFUND_UNVERIFIED" => "SERVICE_REFUND_UNVERIFIED",
                "SERVICE_PART_UNSUPPORTED" => "SERVICE_PART_UNSUPPORTED",
                "SERVICE_SYNC_CONFLICT" => "SERVICE_SYNC_CONFLICT",
                "SERVICE_GUARANTEE_FREE" => "SERVICE_GUARANTEE_FREE",
                "SERVICE_GUARANTEE_EXPIRED" => "SERVICE_GUARANTEE_EXPIRED",
                "WARRANTY_ORIGIN_UNKNOWN" => "WARRANTY_ORIGIN_UNKNOWN",
                "CONTACT_PHONE_INVALID" => "CONTACT_PHONE_INVALID",
                "CONTACT_OPEN_FAILED" => "CONTACT_OPEN_FAILED",
                "PRIVATE_VERSION_CONFLICT" => "PRIVATE_VERSION_CONFLICT",
                "RETURN_CHANGED" => "RETURN_CHANGED",
                "RETURN_QUANTITY_INVALID" => "RETURN_QUANTITY_INVALID",
                "RETURN_NOTHING_REMAINING" => "RETURN_NOTHING_REMAINING",
                "RETURN_STOCK_AMBIGUOUS" => "RETURN_STOCK_AMBIGUOUS",
                "RETURN_STOCK_FRACTIONAL" => "RETURN_STOCK_FRACTIONAL",
                "RETURN_SERIAL_INVALID" => "RETURN_SERIAL_INVALID",
                "RETURN_CREDIT_UNVERIFIED" => "RETURN_CREDIT_UNVERIFIED",
                "RETURN_PAID_CREDIT_PENDING" => "RETURN_PAID_CREDIT_PENDING",
                "RETURN_BASIS_UNAVAILABLE" => "RETURN_BASIS_UNAVAILABLE",
                "PRODUCT_CODE_EXISTS" => "PRODUCT_CODE_EXISTS",
                "PRODUCT_RECIPE_IN_USE" => "PRODUCT_RECIPE_IN_USE",
                "PRODUCT_TYPE_IN_USE" => "PRODUCT_TYPE_IN_USE",
                "RECIPE_COST_INVALID" => "RECIPE_COST_INVALID",
                "RECIPE_INVALID" => "RECIPE_INVALID",
                "SERIAL_REQUIRED" => "SERIAL_REQUIRED",
                "SERIAL_UNAVAILABLE" => "SERIAL_UNAVAILABLE",
                "STOCK_OUT_OF_RANGE" => "STOCK_OUT_OF_RANGE",
                "EXPORT_TOO_LARGE" => "EXPORT_TOO_LARGE",
                "LEGACY_NOT_VERIFIABLE" => "LEGACY_NOT_VERIFIABLE",
                "PERMISSION_DENIED" => "PERMISSION_DENIED",
                "SCOPE_INVALID" => "SCOPE_INVALID",
                _ => "CONTRACT_INVALID",
            },
            Self::Storage(code) if code == "LOCAL_STORAGE_FULL" => "LOCAL_STORAGE_FULL",
            Self::Storage(_) => "LOCAL_STORAGE_IO",
            Self::Business(BusinessError::InsufficientStock { .. }) => "STOCK_UNAVAILABLE",
            Self::Business(BusinessError::ProductCodeExists) => "PRODUCT_CODE_EXISTS",
            Self::Business(BusinessError::FiscalUnknown) => "FISCAL_UNKNOWN",
            Self::Business(BusinessError::FiscalExhausted) => "FISCAL_EXHAUSTED",
            Self::Business(BusinessError::HistorySnapshotUnavailable) => {
                "HISTORY_SNAPSHOT_UNAVAILABLE"
            }
            Self::Business(BusinessError::HistorySnapshotCorrupt) => "HISTORY_SNAPSHOT_CORRUPT",
            Self::Business(BusinessError::DuplicateOperation { .. })
            | Self::Protocol(ProtocolError::OperationIdConflict) => "OPERATION_ID_CONFLICT",
            Self::Business(BusinessError::Conflict { .. })
            | Self::Protocol(ProtocolError::InvalidStateTransition) => "VERSION_CONFLICT",
            Self::Business(_) | Self::Protocol(_) => "CONTRACT_INVALID",
            Self::Auth(AuthError::TokenExpired) => "AUTH_REQUIRED",
            Self::Auth(_) => "PERMISSION_DENIED",
        }
    }

    pub fn safe_response(&self) -> SafeError {
        SafeError {
            code: self.code(),
            retryable: matches!(self, Self::Storage(code) if code == "LOCAL_STORAGE_BUSY"),
        }
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.code())
    }
}
impl std::error::Error for AppError {}

impl From<rusqlite::Error> for AppError {
    fn from(err: rusqlite::Error) -> Self {
        let code = match &err {
            rusqlite::Error::SqliteFailure(e, _) if e.code == rusqlite::ErrorCode::DiskFull => {
                "LOCAL_STORAGE_FULL"
            }
            rusqlite::Error::SqliteFailure(e, _)
                if matches!(
                    e.code,
                    rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked
                ) =>
            {
                "LOCAL_STORAGE_BUSY"
            }
            _ => "LOCAL_STORAGE_IO",
        };
        AppError::Storage(code.into())
    }
}
