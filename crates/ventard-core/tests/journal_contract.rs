#![cfg(any(feature = "fixture-storage", feature = "encrypted-storage"))]

use rusqlite::Connection;
use serde_json::json;
use ventard_core::application::operations::{
    abandon_operation, commit_operation, execute_prepared_operation, get_operation_result,
    prepare_operation,
};
use ventard_core::domain::canonical::canonicalize;

const ID: &str = "96000000-0000-4000-8000-000000000101";
const ACTOR: &str = "96000000-0000-4000-8000-000000000102";
const DEVICE: &str = "96000000-0000-4000-8000-000000000103";

fn database() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
    conn.execute_batch(include_str!("../migrations/0001_core.sql"))
        .unwrap();
    conn
}

fn prepare(
    conn: &mut Connection,
    total: &str,
) -> Result<u64, ventard_core::application::errors::AppError> {
    let input = format!(r#"{{"operationId":"{ID}","totalCents":"{total}"}}"#);
    let (canonical, hash) = canonicalize(input.as_bytes()).unwrap();
    prepare_operation(
        conn,
        ID,
        "ventard.native.v1",
        "SALE_CONFIRM",
        1,
        canonical.as_bytes(),
        &hash,
        ACTOR,
        "GLOBAL",
        DEVICE,
        1,
        "1700000000000",
    )
}

#[test]
fn retry_same_prepared_identity_is_not_a_business_error() {
    let mut conn = database();
    let first = prepare(&mut conn, "11800").unwrap();
    let retry = prepare(&mut conn, "11800");
    assert!(
        retry.is_ok(),
        "mismo ID/hash debe recuperar la intención: {retry:?}"
    );
    assert_eq!(retry.unwrap(), first);
    let count: i64 = conn
        .query_row("SELECT count(*) FROM operation_journal", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 1);
}

#[test]
fn retry_after_commit_preserves_sequence_and_original_result() {
    let mut conn = database();
    let sequence = prepare(&mut conn, "11800").unwrap();
    let result = json!({"totalCents":"11800", "ticket":"QA-1"});
    commit_operation(&mut conn, ID, &result).unwrap();
    assert!(
        prepare(&mut conn, "11800").is_ok(),
        "COMMITTED no debe responder DuplicateOperation"
    );
    assert!(
        commit_operation(&mut conn, ID, &result).is_ok(),
        "respuesta perdida recupera el resultado original"
    );
    let persisted: (u64, String) = conn
        .query_row(
            "SELECT local_seq,result FROM operation_journal WHERE operation_id=?1",
            [ID],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(persisted.0, sequence);
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&persisted.1).unwrap(),
        result
    );
}

#[test]
fn same_id_different_payload_cannot_overwrite_history() {
    let mut conn = database();
    prepare(&mut conn, "11800").unwrap();
    assert!(prepare(&mut conn, "11900").is_err());
    let count: i64 = conn
        .query_row("SELECT count(*) FROM operation_journal", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 1);
}

#[test]
fn claimed_hash_must_match_canonical_bytes_before_inserting() {
    let mut conn = database();
    let rejected = prepare_operation(
        &mut conn,
        ID,
        "ventard.native.v1",
        "SALE_CONFIRM",
        1,
        br#"{"totalCents":"11800"}"#,
        &"0".repeat(64),
        ACTOR,
        "GLOBAL",
        DEVICE,
        1,
        "1700000000000",
    );
    assert!(rejected.is_err(), "no almacenar evidencia de hash falsa");
    let count: i64 = conn
        .query_row("SELECT count(*) FROM operation_journal", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 0);
}

#[test]
fn committed_result_is_immutable() {
    let mut conn = database();
    prepare(&mut conn, "11800").unwrap();
    let original = json!({"totalCents":"11800"});
    commit_operation(&mut conn, ID, &original).unwrap();
    assert!(commit_operation(&mut conn, ID, &json!({"totalCents":"11900"})).is_err());
    assert!(abandon_operation(&mut conn, ID).is_err());
    let state: String = conn
        .query_row(
            "SELECT local_state FROM operation_journal WHERE operation_id=?1",
            [ID],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(state, "COMMITTED");
}

#[test]
fn abandoned_intention_cannot_be_committed_or_reprepared() {
    let mut conn = database();
    prepare(&mut conn, "11800").unwrap();
    abandon_operation(&mut conn, ID).unwrap();
    assert!(prepare(&mut conn, "11800").is_err());
    assert!(commit_operation(&mut conn, ID, &json!({})).is_err());
}

#[test]
fn same_bytes_with_changed_origin_is_a_conflict() {
    let mut conn = database();
    prepare(&mut conn, "11800").unwrap();
    let input = format!(r#"{{"operationId":"{ID}","totalCents":"11800"}}"#);
    let (canonical, hash) = canonicalize(input.as_bytes()).unwrap();
    let retry = prepare_operation(
        &mut conn,
        ID,
        "ventard.native.v1",
        "SALE_CONFIRM",
        1,
        canonical.as_bytes(),
        &hash,
        "96000000-0000-4000-8000-000000000999",
        "GLOBAL",
        DEVICE,
        1,
        "1700000000000",
    );
    assert!(retry.is_err(), "no cambiar actor bajo el mismo ID/hash");
    let actor: String = conn
        .query_row(
            "SELECT origin_actor FROM operation_journal WHERE operation_id=?1",
            [ID],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(actor, ACTOR);
}

#[test]
fn noncanonical_bytes_are_not_silently_rewritten() {
    let mut conn = database();
    let (canonical, hash) = canonicalize(br#"{ "totalCents": "11800" }"#).unwrap();
    assert_ne!(canonical.as_bytes(), br#"{ "totalCents": "11800" }"#);
    let rejected = prepare_operation(
        &mut conn,
        ID,
        "ventard.native.v1",
        "SALE_CONFIRM",
        1,
        br#"{ "totalCents": "11800" }"#,
        &hash,
        ACTOR,
        "GLOBAL",
        DEVICE,
        1,
        "1700000000000",
    );
    assert!(rejected.is_err());
}

#[test]
fn effects_and_result_are_one_commit_and_replay_does_not_invoke_effects() {
    let mut conn = database();
    conn.execute_batch("CREATE TABLE fixture_effect(value INTEGER);")
        .unwrap();
    prepare(&mut conn, "11800").unwrap();
    let input = format!(r#"{{"operationId":"{ID}","totalCents":"11800"}}"#);
    let (_, hash) = canonicalize(input.as_bytes()).unwrap();
    let result = execute_prepared_operation(&mut conn, ID, &hash, |tx| {
        tx.execute("INSERT INTO fixture_effect VALUES(1)", [])?;
        Ok(json!({"totalCents":"11800", "ticket":"QA-1"}))
    })
    .unwrap();
    for _ in 0..100 {
        let repeat =
            execute_prepared_operation(&mut conn, ID, &hash, |_| panic!("no repetir efectos"))
                .unwrap();
        assert_eq!(repeat, result);
    }
    assert_eq!(
        get_operation_result(&conn, ID, &hash).unwrap(),
        Some(result)
    );
    let count: i64 = conn
        .query_row("SELECT count(*) FROM fixture_effect", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 1);
}

#[test]
fn mid_effect_failure_preserves_prepared_intention_and_no_partial_effect() {
    let mut conn = database();
    conn.execute_batch("CREATE TABLE fixture_effect(value INTEGER);")
        .unwrap();
    prepare(&mut conn, "11800").unwrap();
    let input = format!(r#"{{"operationId":"{ID}","totalCents":"11800"}}"#);
    let (_, hash) = canonicalize(input.as_bytes()).unwrap();
    let failure = execute_prepared_operation(&mut conn, ID, &hash, |tx| {
        tx.execute("INSERT INTO fixture_effect VALUES(1)", [])?;
        tx.execute("INSERT INTO missing_fixture_table VALUES(1)", [])?;
        Ok(json!({}))
    });
    assert!(failure.is_err());
    let count: i64 = conn
        .query_row("SELECT count(*) FROM fixture_effect", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 0);
    assert_eq!(get_operation_result(&conn, ID, &hash).unwrap(), None);
}
