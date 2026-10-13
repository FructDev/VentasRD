//! Journal local. Helpers de core Rust; no son autorización ni IPC público.
//! Prepare/abandon no generan outbox. Effects/result confirman juntos.
use super::errors::{AppError, BusinessError, ProtocolError};
use crate::domain::canonical::canonicalize;
use crate::domain::identity::{EntityId, UtcMillis};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde_json::Value;

#[derive(Debug, PartialEq)]
pub enum OperationState {
    Prepared,
    Committed(Value),
    Abandoned,
}
fn invalid() -> AppError {
    AppError::Protocol(ProtocolError::MalformedPayload)
}
fn conflict() -> AppError {
    AppError::Protocol(ProtocolError::OperationIdConflict)
}

/// Mismo ID/hash devuelve la misma secuencia. Resultado en get_operation_result.
#[allow(clippy::too_many_arguments)]
pub fn prepare_operation(
    conn: &mut Connection,
    operation_id: &str,
    protocol: &str,
    kind: &str,
    version: u32,
    canonical_bytes: &[u8],
    hash: &str,
    origin_actor: &str,
    origin_scope: &str,
    origin_device: &str,
    origin_epoch: u32,
    prepared_at: &str,
) -> Result<u64, AppError> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let sequence = prepare_in_transaction(
        &tx,
        operation_id,
        protocol,
        kind,
        version,
        canonical_bytes,
        hash,
        origin_actor,
        origin_scope,
        origin_device,
        origin_epoch,
        prepared_at,
    )?;
    tx.commit()?;
    Ok(sequence)
}
#[allow(clippy::too_many_arguments)]
pub(crate) fn prepare_in_transaction(
    tx: &Transaction<'_>,
    operation_id: &str,
    protocol: &str,
    kind: &str,
    version: u32,
    canonical_bytes: &[u8],
    hash: &str,
    origin_actor: &str,
    origin_scope: &str,
    origin_device: &str,
    origin_epoch: u32,
    prepared_at: &str,
) -> Result<u64, AppError> {
    let (canonical, actual_hash) = canonicalize(canonical_bytes).map_err(|_| invalid())?;
    if actual_hash != hash {
        return Err(AppError::Protocol(ProtocolError::HashMismatch));
    }
    if canonical.as_bytes() != canonical_bytes {
        return Err(invalid());
    }
    for id in [operation_id, origin_actor, origin_device] {
        EntityId::parse(id).map_err(|_| invalid())?;
    }
    UtcMillis::parse_dto(prepared_at).map_err(|_| invalid())?;
    let scope_valid = origin_scope == "GLOBAL"
        || origin_scope
            .strip_prefix("BRANCH:")
            .is_some_and(|id| EntityId::parse(id).is_ok());
    if protocol != "ventard.native.v1"
        || version != 1
        || origin_epoch == 0
        || !scope_valid
        || !supported_kind(kind)
    {
        return Err(invalid());
    }
    let existing = tx.query_row(
        "SELECT protocol,kind,version,canonical_bytes,hash,origin_actor,origin_scope,origin_device,origin_epoch,prepared_at,local_seq,local_state FROM operation_journal WHERE operation_id=?1",
        [operation_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, u32>(2)?,
            row.get::<_, Vec<u8>>(3)?, row.get::<_, String>(4)?, row.get::<_, String>(5)?, row.get::<_, String>(6)?,
            row.get::<_, String>(7)?, row.get::<_, u32>(8)?, row.get::<_, String>(9)?, row.get::<_, u64>(10)?, row.get::<_, String>(11)?)),
    ).optional()?;
    if let Some(row) = existing {
        if row.0 != protocol
            || row.1 != kind
            || row.2 != version
            || row.3 != canonical_bytes
            || row.4 != hash
            || row.5 != origin_actor
            || row.6 != origin_scope
            || row.7 != origin_device
            || row.8 != origin_epoch
            || row.9 != prepared_at
        {
            return Err(conflict());
        }
        if row.11 == "ABANDONED" {
            return Err(AppError::Business(BusinessError::OperationAbandoned));
        }
        if !matches!(row.11.as_str(), "PREPARED" | "COMMITTED") {
            return Err(invalid());
        }
        return Ok(row.10);
    }
    tx.execute(
        "INSERT INTO operation_journal(operation_id,protocol,kind,version,canonical_bytes,hash,origin_actor,origin_scope,origin_device,origin_epoch,prepared_at,local_seq,local_state)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,COALESCE((SELECT MAX(local_seq) FROM operation_journal),0)+1,'PREPARED')",
        (operation_id, protocol, kind, version, canonical_bytes, hash, origin_actor, origin_scope, origin_device, origin_epoch, prepared_at),
    )?;
    let sequence = tx.query_row(
        "SELECT local_seq FROM operation_journal WHERE operation_id=?1",
        [operation_id],
        |r| r.get(0),
    )?;
    Ok(sequence)
}
fn supported_kind(kind: &str) -> bool {
    matches!(
        kind,
        "SALE_CONFIRM"
            | "SALE_RETURN"
            | "CREDIT_PAYMENT"
            | "CREDIT_ADJUSTMENT"
            | "TURN_OPEN"
            | "CUT_X"
            | "TURN_CLOSE"
            | "EXPENSE_RECORD"
            | "CASH_ENTRY"
            | "INVENTORY_DELTA"
            | "COUNT"
            | "INVENTORY_COUNT"
            | "PRODUCT_CREATE"
            | "PRODUCT_PATCH"
            | "PRODUCT_DELETE"
            | "CUSTOMER_CREATE"
            | "CUSTOMER_PATCH"
            | "CUSTOMER_DELETE"
            | "REPAIR_CREATE"
            | "REPAIR_EDIT"
            | "REPAIR_STATUS"
            | "REPAIR_PAYMENT"
            | "REPAIR_DELIVER"
            | "REPAIR_DISASSEMBLE"
            | "LAYAWAY_CREATE"
            | "LAYAWAY_PAYMENT"
            | "LAYAWAY_COMPLETE"
            | "LAYAWAY_CANCEL"
            | "FISCAL_RESERVE_RANGE"
            | "CONFIG_PATCH"
            | "WARRANTY_PATCH"
    )
}
pub fn get_operation_result(
    conn: &Connection,
    operation_id: &str,
    hash: &str,
) -> Result<Option<Value>, AppError> {
    let (stored_hash, state, result): (String, String, Option<String>) = conn.query_row(
        "SELECT hash,local_state,result FROM operation_journal WHERE operation_id=?1",
        [operation_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    if stored_hash != hash {
        return Err(conflict());
    }
    match state.as_str() {
        "PREPARED" => Ok(None),
        "COMMITTED" => Ok(Some(
            serde_json::from_str(result.as_deref().ok_or_else(invalid)?).map_err(|_| invalid())?,
        )),
        "ABANDONED" => Err(AppError::Business(BusinessError::OperationAbandoned)),
        _ => Err(invalid()),
    }
}
pub(crate) fn commit_in_transaction(
    tx: &Transaction<'_>,
    operation_id: &str,
    result: &Value,
) -> Result<(), AppError> {
    if result.is_null() {
        return Err(invalid());
    }
    let (state, stored): (String, Option<String>) = tx.query_row(
        "SELECT local_state,result FROM operation_journal WHERE operation_id=?1",
        [operation_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    if state == "COMMITTED" {
        let original: Value =
            serde_json::from_str(stored.as_deref().ok_or_else(invalid)?).map_err(|_| invalid())?;
        return if original == *result {
            Ok(())
        } else {
            Err(conflict())
        };
    }
    if state != "PREPARED" {
        return Err(AppError::Protocol(ProtocolError::InvalidStateTransition));
    }
    let serialized = serde_json::to_string(result).map_err(|_| invalid())?;
    tx.execute("UPDATE operation_journal SET local_state='COMMITTED',result=?2 WHERE operation_id=?1 AND local_state='PREPARED'", (operation_id, serialized))?;
    Ok(())
}
/// Sólo journal. Los comandos comerciales deben usar execute_prepared_operation.
pub fn commit_operation(
    conn: &mut Connection,
    operation_id: &str,
    result: &Value,
) -> Result<(), AppError> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    commit_in_transaction(&tx, operation_id, result)?;
    tx.commit()?;
    Ok(())
}
/// Callback exclusivamente Rust de confianza. No effects repetidos tras COMMIT.
pub fn execute_prepared_operation<F>(
    conn: &mut Connection,
    operation_id: &str,
    hash: &str,
    effects: F,
) -> Result<Value, AppError>
where
    F: FnOnce(&Transaction<'_>) -> Result<Value, AppError>,
{
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if let Some(result) = get_operation_result(&tx, operation_id, hash)? {
        return Ok(result);
    }
    let result = effects(&tx)?;
    commit_in_transaction(&tx, operation_id, &result)?;
    tx.commit()?;
    Ok(result)
}
pub fn abandon_operation(conn: &mut Connection, operation_id: &str) -> Result<(), AppError> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let state: String = tx.query_row(
        "SELECT local_state FROM operation_journal WHERE operation_id=?1",
        [operation_id],
        |r| r.get(0),
    )?;
    match state.as_str() {
        "ABANDONED" => return Ok(()),
        "PREPARED" => {
            tx.execute(
                "UPDATE operation_journal SET local_state='ABANDONED' WHERE operation_id=?1",
                [operation_id],
            )?;
        }
        _ => return Err(AppError::Protocol(ProtocolError::InvalidStateTransition)),
    }
    tx.commit()?;
    Ok(())
}
