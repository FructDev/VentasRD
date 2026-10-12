#![cfg(feature = "fixture-storage")]

use std::{path::PathBuf, sync::Arc, thread};
use ventard_core::application::errors::{AppError, BusinessError};
use ventard_core::storage::writer::WriterActor;

struct FixtureDir(PathBuf);
impl FixtureDir {
    fn new() -> Self {
        let dir =
            std::env::temp_dir().join(format!("ventard-native-actor-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        Self(dir)
    }
}
impl Drop for FixtureDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn concurrent_commands_are_serialized_by_one_native_writer() {
    let dir = FixtureDir::new();
    let actor = Arc::new(WriterActor::open_fixture(&dir.0).unwrap());
    actor.transaction(|tx| { tx.execute_batch("CREATE TABLE fixture_counter(value INTEGER); INSERT INTO fixture_counter VALUES(0);")?; Ok(()) }).unwrap();
    let caller = thread::current().id();
    let writer = actor.call(|_| Ok(thread::current().id())).unwrap();
    assert_ne!(caller, writer, "I/O fuera del hilo que solicita el comando");
    let threads: Vec<_> = (0..20)
        .map(|_| {
            let actor = Arc::clone(&actor);
            thread::spawn(move || {
                actor
                    .transaction(|tx| {
                        tx.execute("UPDATE fixture_counter SET value=value+1", [])?;
                        Ok(())
                    })
                    .unwrap()
            })
        })
        .collect();
    for t in threads {
        t.join().unwrap();
    }
    let total: i64 = actor
        .call(|conn| Ok(conn.query_row("SELECT value FROM fixture_counter", [], |r| r.get(0))?))
        .unwrap();
    assert_eq!(total, 20);
    drop(actor);
    assert!(WriterActor::open_fixture(&dir.0).is_ok());
}

#[test]
fn failed_command_rolls_back_and_independent_commands_can_continue() {
    let dir = FixtureDir::new();
    let actor = WriterActor::open_fixture(&dir.0).unwrap();
    actor
        .transaction(|tx| {
            tx.execute_batch("CREATE TABLE fixture_effect(value INTEGER);")?;
            Ok(())
        })
        .unwrap();
    let failure: Result<(), AppError> = actor.transaction(|tx| {
        tx.execute("INSERT INTO fixture_effect VALUES(99)", [])?;
        Err(AppError::Business(BusinessError::Conflict {
            message: "fixture failure".into(),
        }))
    });
    assert!(failure.is_err());
    actor
        .transaction(|tx| {
            tx.execute("INSERT INTO fixture_effect VALUES(1)", [])?;
            Ok(())
        })
        .unwrap();
    let rows: i64 = actor
        .call(|c| Ok(c.query_row("SELECT count(*) FROM fixture_effect", [], |r| r.get(0))?))
        .unwrap();
    assert_eq!(rows, 1);
}

#[test]
fn secondary_actor_cannot_write_or_migrate_the_same_vault() {
    let dir = FixtureDir::new();
    let owner = WriterActor::open_fixture(&dir.0).unwrap();
    assert!(WriterActor::open_fixture(&dir.0).is_err());
    drop(owner);
    assert!(WriterActor::open_fixture(&dir.0).is_ok());
}
