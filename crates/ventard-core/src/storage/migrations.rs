use super::writer::StorageError;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior};
use sha2::{Digest, Sha256};

/// Represents an embedded SQL migration script.
pub struct Migration {
    pub version: u32,
    pub name: &'static str,
    pub sql: &'static str,
    pub checksum: String,
}

impl Migration {
    /// Computes the SHA-256 checksum of the migration SQL string.
    pub fn compute_checksum(sql: &str) -> String {
        let mut hasher = Sha256::new();
        hasher.update(sql.as_bytes());
        format!("{:x}", hasher.finalize())
    }
}

/// Returns the ordered list of embedded migrations.
pub fn get_embedded_migrations() -> Vec<Migration> {
    let mut migrations = Vec::new();

    let sql_0001 = include_str!("../../migrations/0001_core.sql");
    migrations.push(Migration {
        version: 1,
        name: "0001_core",
        sql: sql_0001,
        checksum: Migration::compute_checksum(sql_0001),
    });
    let sql_0002 = include_str!("../../migrations/0002_local_access.sql");
    migrations.push(Migration {
        version: 2,
        name: "0002_local_access",
        sql: sql_0002,
        checksum: Migration::compute_checksum(sql_0002),
    });
    let sql_0003 = include_str!("../../migrations/0003_operational_openings.sql");
    migrations.push(Migration {
        version: 3,
        name: "0003_operational_openings",
        sql: sql_0003,
        checksum: Migration::compute_checksum(sql_0003),
    });

    let sql_0004 = include_str!("../../migrations/0004_native_access_cache.sql");
    migrations.push(Migration {
        version: 4,
        name: "0004_native_access_cache",
        sql: sql_0004,
        checksum: Migration::compute_checksum(sql_0004),
    });
    let sql_0005 = include_str!("../../migrations/0005_catalogue_preview.sql");
    migrations.push(Migration {
        version: 5,
        name: "0005_catalogue_preview",
        sql: sql_0005,
        checksum: Migration::compute_checksum(sql_0005),
    });
    let sql_0006 = include_str!("../../migrations/0006_account_drafts.sql");
    migrations.push(Migration {
        version: 6,
        name: "0006_account_drafts",
        sql: sql_0006,
        checksum: Migration::compute_checksum(sql_0006),
    });
    let sql_0007 = include_str!("../../migrations/0007_cash_turns.sql");
    migrations.push(Migration {
        version: 7,
        name: "0007_cash_turns",
        sql: sql_0007,
        checksum: Migration::compute_checksum(sql_0007),
    });
    let sql_0008 = include_str!("../../migrations/0008_checkout_drafts.sql");
    migrations.push(Migration {
        version: 8,
        name: "0008_checkout_drafts",
        sql: sql_0008,
        checksum: Migration::compute_checksum(sql_0008),
    });
    let sql_0009 = include_str!("../../migrations/0009_fiscal_ticket.sql");
    migrations.push(Migration {
        version: 9,
        name: "0009_fiscal_ticket",
        sql: sql_0009,
        checksum: Migration::compute_checksum(sql_0009),
    });
    let sql_0010 = include_str!("../../migrations/0010_fiscal_requests.sql");
    migrations.push(Migration {
        version: 10,
        name: "0010_fiscal_requests",
        sql: sql_0010,
        checksum: Migration::compute_checksum(sql_0010),
    });
    // Validar orden estricto de las versiones
    let sql_0011 = include_str!("../../migrations/0011_complete_sales.sql");
    migrations.push(Migration {
        version: 11,
        name: "0011_complete_sales",
        sql: sql_0011,
        checksum: Migration::compute_checksum(sql_0011),
    });
    let sql_0012 = include_str!("../../migrations/0012_sales_sync.sql");
    migrations.push(Migration {
        version: 12,
        name: "0012_sales_sync",
        sql: sql_0012,
        checksum: Migration::compute_checksum(sql_0012),
    });
    let sql_0013 = include_str!("../../migrations/0013_management.sql");
    migrations.push(Migration {
        version: 13,
        name: "0013_management",
        sql: sql_0013,
        checksum: Migration::compute_checksum(sql_0013),
    });
    migrations.sort_by_key(|m| m.version);
    let sql_0014 = include_str!("../../migrations/0014_cut_printing.sql");
    migrations.push(Migration {
        version: 14,
        name: "0014_cut_printing",
        sql: sql_0014,
        checksum: Migration::compute_checksum(sql_0014),
    });
    let sql_0015 = include_str!("../../migrations/0015_repair_private.sql");
    migrations.push(Migration {
        version: 15,
        name: "0015_repair_private",
        sql: sql_0015,
        checksum: Migration::compute_checksum(sql_0015),
    });
    let sql_0016 = include_str!("../../migrations/0016_print_layout.sql");
    migrations.push(Migration {
        version: 16,
        name: "0016_print_layout",
        sql: sql_0016,
        checksum: Migration::compute_checksum(sql_0016),
    });
    let sql_0017 = include_str!("../../migrations/0017_business_settings.sql");
    migrations.push(Migration {
        version: 17,
        name: "0017_business_settings",
        sql: sql_0017,
        checksum: Migration::compute_checksum(sql_0017),
    });
    let sql_0018 = include_str!("../../migrations/0018_backup_jobs.sql");
    migrations.push(Migration {
        version: 18,
        name: "0018_backup_jobs",
        sql: sql_0018,
        checksum: Migration::compute_checksum(sql_0018),
    });
    let sql_0019 = include_str!("../../migrations/0019_inventory_import.sql");
    migrations.push(Migration {
        version: 19,
        name: "0019_inventory_import",
        sql: sql_0019,
        checksum: Migration::compute_checksum(sql_0019),
    });
    let sql_0020 = include_str!("../../migrations/0020_fiscal_settings.sql");
    migrations.push(Migration {
        version: 20,
        name: "0020_fiscal_settings",
        sql: sql_0020,
        checksum: Migration::compute_checksum(sql_0020),
    });
    let sql_0021 = include_str!("../../migrations/0021_native_printer_transport.sql");
    migrations.push(Migration {
        version: 21,
        name: "0021_native_printer_transport",
        sql: sql_0021,
        checksum: Migration::compute_checksum(sql_0021),
    });
    let sql_0022 = include_str!("../../migrations/0022_legacy_web_preservation.sql");
    migrations.push(Migration {
        version: 22,
        name: "0022_legacy_web_preservation",
        sql: sql_0022,
        checksum: Migration::compute_checksum(sql_0022),
    });
    let sql_0023 = include_str!("../../migrations/0023_legacy_web_observations.sql");
    migrations.push(Migration {
        version: 23,
        name: "0023_legacy_web_observations",
        sql: sql_0023,
        checksum: Migration::compute_checksum(sql_0023),
    });
    let sql_0024 = include_str!("../../migrations/0024_legacy_inventory_evidence.sql");
    migrations.push(Migration {
        version: 24,
        name: "0024_legacy_inventory_evidence",
        sql: sql_0024,
        checksum: Migration::compute_checksum(sql_0024),
    });
    migrations
}

/// Computes the compatibility floor for the current schema.
/// Devices with a lower schema version cannot safely open this vault.
pub fn compatibility_floor(current_version: u32) -> u32 {
    // For now, version 1 is the floor.
    // In the future, this might return 5 if breaking changes occurred at v5.
    if current_version >= 1 {
        1
    } else {
        0
    }
}

/// Validación read-only antes de WAL o de cualquier escritura de esquema.
pub fn validate_history(conn: &Connection) -> Result<u32, StorageError> {
    let current: u32 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    let migrations = get_embedded_migrations();
    let latest = migrations.last().map_or(0, |m| m.version);
    if current > latest || (current > 0 && current < compatibility_floor(latest)) {
        return Err(StorageError::IncompatibleSchema);
    }
    let history_exists: i64 = conn.query_row(
        "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='migration_history'",
        [],
        |r| r.get(0),
    )?;
    if current == 0 {
        let tables: i64 = conn.query_row(
            "SELECT count(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
            [],
            |r| r.get(0),
        )?;
        if tables != 0 {
            return Err(StorageError::MigrationError("UNTRACKED_SCHEMA".into()));
        }
        return Ok(0);
    }
    if history_exists != 1 {
        return Err(StorageError::MigrationError("UNTRACKED_SCHEMA".into()));
    }
    let count: usize =
        conn.query_row("SELECT count(*) FROM migration_history", [], |r| r.get(0))?;
    let expected = migrations.iter().filter(|m| m.version <= current).count();
    if count != expected {
        return Err(StorageError::MigrationError(
            "MIGRATION_HISTORY_INVALID".into(),
        ));
    }
    for migration in migrations.iter().filter(|m| m.version <= current) {
        let row: Option<(String, String)> = conn
            .query_row(
                "SELECT name,checksum FROM migration_history WHERE version=?1",
                [migration.version],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if row != Some((migration.name.into(), migration.checksum.clone())) {
            return Err(StorageError::MigrationError(
                "MIGRATION_CHECKSUM_MISMATCH".into(),
            ));
        }
    }
    Ok(current)
}

pub fn apply(conn: &mut Connection) -> Result<(), StorageError> {
    let current = validate_history(conn)?;
    let migrations = get_embedded_migrations();
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    tx.execute_batch("CREATE TABLE IF NOT EXISTS migration_history(version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL CHECK(length(checksum)=64)) STRICT;")?;
    for migration in migrations.iter().filter(|m| m.version > current) {
        tx.execute_batch(migration.sql)?;
        tx.execute(
            "INSERT INTO migration_history(version,name,checksum) VALUES(?1,?2,?3)",
            (migration.version, migration.name, &migration.checksum),
        )?;
    }
    if let Some(latest) = migrations.last() {
        tx.pragma_update(None, "user_version", latest.version)?;
    }
    tx.commit()?;
    validate_history(conn)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_migrations_ordered_and_checksum_valid() {
        let migrations = get_embedded_migrations();
        assert!(!migrations.is_empty());
        assert_eq!(migrations[0].version, 1);

        let checksum = Migration::compute_checksum(migrations[0].sql);
        assert_eq!(migrations[0].checksum, checksum);
    }
}
