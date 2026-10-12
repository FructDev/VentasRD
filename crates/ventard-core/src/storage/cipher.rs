//! SQLCipher sin fallback plaintext. La custodia OS/DEK aleatoria sigue en T039;
//! este módulo recibe una llave del core nativo, nunca del renderer ni del PIN.
use super::writer::StorageError;
use rusqlite::Connection;
use std::fmt::Write;
use zeroize::Zeroizing;

/// No Debug, Clone, Serialize ni acceso a bytes fuera de este módulo.
pub struct CipherKey(Zeroizing<[u8; 32]>);
impl CipherKey {
    pub fn new(bytes: [u8; 32]) -> Self {
        Self(Zeroizing::new(bytes))
    }
    pub(crate) fn from_zeroizing(bytes: Zeroizing<[u8; 32]>) -> Self {
        Self(bytes)
    }
    pub(crate) fn raw_native(&self) -> &[u8; 32] {
        &self.0
    }
}

/// PRAGMA key precede cualquier lectura del archivo. La lectura real posterior
/// comprueba la llave; ejecutar sólo PRAGMA key NO demuestra descifrado.
pub(super) fn key_connection(conn: &Connection, key: &CipherKey) -> Result<(), StorageError> {
    // Logs internos no sanitizados nunca deben salir a stdout/stderr. Además
    // evita la recursión Windows del logger del motor 4.14 (upstream #619).
    // Mantener memory_security ON; NONE no cambia cifrado, HMAC ni durabilidad.
    // La actualización al motor con fix upstream sigue requerida por G1.
    conn.execute_batch("PRAGMA cipher_log_level = NONE;")
        .map_err(|_| StorageError::CipherUnavailable)?;
    let log_level: String = conn
        .query_row("PRAGMA cipher_log_level", [], |r| r.get(0))
        .map_err(|_| StorageError::CipherUnavailable)?;
    if log_level != "NONE" {
        return Err(StorageError::CipherUnavailable);
    }
    let mut sql = Zeroizing::new(String::with_capacity(100));
    sql.push_str("PRAGMA key = \"x'");
    for byte in key.0.iter() {
        // String no falla al implementar fmt::Write; capacidad suficiente,
        // sin realloc intermedia de copias del secreto.
        write!(&mut *sql, "{byte:02x}").expect("writing into String");
    }
    sql.push_str("'\";");
    // No retornar errores SQL que puedan contener el PRAGMA/llave.
    conn.execute_batch(&sql)
        .map_err(|_| StorageError::CipherUnavailable)?;
    drop(sql);
    let version: String = conn
        .query_row("PRAGMA cipher_version", [], |r| r.get(0))
        .map_err(|_| StorageError::CipherUnavailable)?;
    if version.is_empty() || rusqlite::version_number() < 3_051_003 {
        return Err(StorageError::CipherUnavailable);
    }
    conn.execute_batch("PRAGMA cipher_memory_security = ON;")
        .map_err(|_| StorageError::CipherUnavailable)?;
    let memory: String = conn
        .query_row("PRAGMA cipher_memory_security", [], |r| r.get(0))
        .map_err(|_| StorageError::CipherUnavailable)?;
    if memory != "1" {
        return Err(StorageError::CipherUnavailable);
    }
    Ok(())
}

pub(super) fn validate_key(conn: &Connection) -> Result<(), StorageError> {
    conn.query_row("SELECT count(*) FROM sqlite_master", [], |r| {
        r.get::<_, i64>(0)
    })
    .map_err(|_| StorageError::CipherKeyRejected)?;
    Ok(())
}
