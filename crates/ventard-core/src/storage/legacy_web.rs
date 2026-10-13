//! Authenticated browser preservation. Never inserts legacy facts into live
//! projections, invents receipts, promotes flags, or sends historical operations.
use openssl::symm::{decrypt_aead, Cipher};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::File,
    io::Read,
    path::Path,
};
use zeroize::Zeroizing;
pub const MAX_BYTES: usize = 32 * 1024 * 1024;
pub const TABLES: [&str; 18] = [
    "apartados",
    "cajas",
    "clientes",
    "composiciones",
    "cortes_caja",
    "devoluciones",
    "gastos",
    "inventario_sync_cursors",
    "movimientos_stock",
    "operaciones_locales",
    "productos",
    "reparaciones",
    "secuencias",
    "seriales",
    "sucursales",
    "transacciones_fiado",
    "venta_detalles",
    "ventas",
];
#[derive(Debug, Clone, Copy)]
pub struct ImportError(&'static str);
impl ImportError {
    pub fn code(self) -> &'static str {
        self.0
    }
}
fn invalid() -> ImportError {
    ImportError("WEB_IMPORT_INVALID")
}
impl From<rusqlite::Error> for ImportError {
    fn from(_: rusqlite::Error) -> Self {
        ImportError("WEB_IMPORT_STORAGE")
    }
}
fn hash(bytes: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(bytes.as_ref()))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Table {
    name: String,
    count: usize,
    rows_json: String,
    sha256: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Envelope {
    migration_version: u32,
    export_id: String,
    tenant_id: String,
    origin: String,
    profile_alias: String,
    generated_at_ms: String,
    database_name: String,
    schema_version: u32,
    source_build: String,
    boundary: String,
    writers_stopped: bool,
    tables: Vec<Table>,
    storage_json: String,
    storage_sha256: String,
}
pub struct Package {
    export_id: String,
    raw: Zeroizing<String>,
    envelope: Envelope,
    summary: Value,
}
impl Package {
    pub fn export_id(&self) -> &str {
        &self.export_id
    }
    pub fn raw_body(&self) -> &str {
        &self.raw
    }
}
fn secrets(v: &Value) -> bool {
    match v {
        Value::Object(o) => o.iter().any(|(k, v)| {
            matches!(
                k.to_ascii_lowercase().as_str(),
                "pinadmin"
                    | "pin"
                    | "access_token"
                    | "refresh_token"
                    | "password"
                    | "secret"
                    | "session"
                    | "firmaacc"
                    | "recoverysecret"
            ) || secrets(v)
        }),
        Value::Array(a) => a.iter().any(secrets),
        _ => false,
    }
}
pub fn read_files(file: &Path, key: &Path) -> Result<Package, ImportError> {
    fn read(path: &Path, max: usize) -> Result<Zeroizing<Vec<u8>>, ImportError> {
        let f = File::open(path).map_err(|_| ImportError("WEB_IMPORT_IO"))?;
        if !f
            .metadata()
            .map_err(|_| ImportError("WEB_IMPORT_IO"))?
            .is_file()
        {
            return Err(invalid());
        }
        let mut bytes = Zeroizing::new(Vec::new());
        f.take((max + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|_| ImportError("WEB_IMPORT_IO"))?;
        if bytes.len() > max {
            return Err(ImportError("WEB_IMPORT_TOO_LARGE"));
        }
        Ok(bytes)
    }
    decrypt(&read(file, MAX_BYTES + 36)?, &read(key, 40)?)
}
pub fn decrypt(file: &[u8], key: &[u8]) -> Result<Package, ImportError> {
    if file.len() > MAX_BYTES + 36 {
        return Err(ImportError("WEB_IMPORT_TOO_LARGE"));
    }
    if file.len() < 36
        || file.get(..8) != Some(b"VRWEB001")
        || key.len() != 40
        || key.get(..8) != Some(b"VRWKY001")
    {
        return Err(invalid());
    }
    let bytes = Zeroizing::new(
        decrypt_aead(
            Cipher::aes_256_gcm(),
            &key[8..],
            Some(&file[8..20]),
            b"VRWEB001",
            &file[20..file.len() - 16],
            &file[file.len() - 16..],
        )
        .map_err(|_| ImportError("WEB_IMPORT_KEY_INVALID"))?,
    );
    let raw = String::from_utf8(bytes.to_vec()).map_err(|_| invalid())?;
    parse(raw)
}
pub fn parse(raw: String) -> Result<Package, ImportError> {
    let raw = Zeroizing::new(raw);
    if raw.len() > MAX_BYTES {
        return Err(ImportError("WEB_IMPORT_TOO_LARGE"));
    }
    let e: Envelope = serde_json::from_str(&raw).map_err(|_| invalid())?;
    for id in [&e.export_id, &e.tenant_id] {
        uuid::Uuid::parse_str(id).map_err(|_| invalid())?;
    }
    if e.migration_version != 1
        || e.source_build.is_empty()
        || e.source_build.len() > 160
        || ![21, 22, 23].contains(&e.schema_version)
        || e.writers_stopped
        || e.boundary != "IDB_ATOMIC_STORAGE_OBSERVED"
        || e.tables.len() != 16 + (e.schema_version - 21) as usize
        || e.database_name.is_empty()
        || e.database_name.len() > 160
        || e.profile_alias.trim().is_empty()
        || e.profile_alias.chars().count() > 80
        || e.origin.len() > 2048
        || !(e.origin.starts_with("https://") || e.origin.starts_with("http://"))
        || e.generated_at_ms
            .parse::<u64>()
            .ok()
            .filter(|n| *n <= 9_007_199_254_740_991)
            .is_none()
    {
        return Err(invalid());
    }
    let storage: Value = serde_json::from_str(&e.storage_json).map_err(|_| invalid())?;
    if hash(&e.storage_json) != e.storage_sha256
        || secrets(&storage)
        || storage["config"]["negocioId"] != e.tenant_id
    {
        return Err(invalid());
    }
    let o = storage.as_object().ok_or_else(invalid)?;
    for (k, v) in o {
        if k != "config"
            && k != "ventard-cart"
            && k != "vrd_logo_cache"
            && !k.starts_with("vrd_sync_")
        {
            return Err(invalid());
        }
        if k == "ventard-cart" || k == "vrd_logo_cache" {
            let saved: Value =
                serde_json::from_str(v.as_str().ok_or_else(invalid)?).map_err(|_| invalid())?;
            if secrets(&saved) {
                return Err(invalid());
            }
        }
    }
    let mut counts = BTreeMap::new();
    let (mut pending, mut unverified, mut unknown_scope, mut foreign, mut unknown_tenant) =
        (0usize, 0usize, 0usize, 0usize, 0usize);
    let mut names = BTreeSet::new();
    let mut all_rows = BTreeMap::new();
    for t in &e.tables {
        if !TABLES.contains(&t.name.as_str())
            || (t.name == "operaciones_locales" && e.schema_version < 23)
            || (t.name == "inventario_sync_cursors" && e.schema_version < 22)
            || !names.insert(t.name.clone())
            || hash(&t.rows_json) != t.sha256
            || t.count > 200_000
        {
            return Err(invalid());
        }
        let rows: Vec<Value> = serde_json::from_str(&t.rows_json).map_err(|_| invalid())?;
        if rows.len() != t.count {
            return Err(invalid());
        }
        let mut ids = BTreeSet::new();
        for row in &rows {
            let o = row.as_object().ok_or_else(invalid)?;
            let id = row["id"].as_str().ok_or_else(invalid)?;
            if id.is_empty() || id.len() > 512 || !ids.insert(id.to_owned()) || secrets(row) {
                return Err(invalid());
            }
            if o.get("estado_sincronizacion") == Some(&json!(0)) {
                pending += 1;
            }
            if o.contains_key("estado_sincronizacion")
                || o.contains_key("sync_state")
                || t.name == "operaciones_locales"
            {
                unverified += 1;
            }
            match o.get("negocio_id").and_then(Value::as_str) {
                Some(id) if id != e.tenant_id => foreign += 1,
                None => unknown_tenant += 1,
                _ => {}
            }
            if [
                "ventas",
                "cajas",
                "gastos",
                "transacciones_fiado",
                "movimientos_stock",
            ]
            .contains(&t.name.as_str())
                && !o.contains_key("sucursal_id")
            {
                unknown_scope += 1;
            }
        }
        counts.insert(t.name.clone(), t.count);
        all_rows.insert(t.name.clone(), rows);
    }
    let mut missing = 0usize;
    for (table, field, parent) in [
        ("venta_detalles", "venta_id", "ventas"),
        ("venta_detalles", "producto_id", "productos"),
        ("transacciones_fiado", "cliente_id", "clientes"),
        ("composiciones", "producto_padre_id", "productos"),
        ("composiciones", "insumo_id", "productos"),
        ("movimientos_stock", "producto_id", "productos"),
    ] {
        let ids: BTreeSet<&str> = all_rows[parent]
            .iter()
            .filter_map(|r| r["id"].as_str())
            .collect();
        for row in &all_rows[table] {
            if let Some(id) = row[field].as_str() {
                if !ids.contains(id) && row["sin_stock"] != true {
                    missing += 1;
                }
            }
        }
    }
    let external_images = all_rows["productos"]
        .iter()
        .filter(|r| {
            r["imagen_url"]
                .as_str()
                .is_some_and(|s| s.starts_with("http"))
        })
        .count()
        + usize::from(
            storage["config"]["negocioLogo"]
                .as_str()
                .is_some_and(|s| s.starts_with("http")),
        );
    let summary = json!({"exportId":e.export_id,"tenantId":e.tenant_id,"origin":e.origin,"profileAlias":e.profile_alias,"capturedAtMs":e.generated_at_ms,"state":"PRESERVED_REVIEW_REQUIRED","writersStopped":false,"counts":counts,"pendingRows":pending,"remoteUnverifiedRows":unverified,"unknownScopeRows":unknown_scope,"foreignTenantRows":foreign,"unknownTenantRows":unknown_tenant,"missingReferences":missing,"externalImageReferences":external_images,"canActivate":false});
    Ok(Package {
        export_id: e.export_id.clone(),
        raw,
        envelope: e,
        summary,
    })
}
pub fn store(c: &mut Connection, tenant: &str, p: &Package) -> Result<Value, ImportError> {
    if tenant != p.envelope.tenant_id {
        return Err(ImportError("WEB_IMPORT_TENANT_MISMATCH"));
    }
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let digest = hash(p.raw_body());
    let old: Option<(String, String, String)> = tx
        .query_row(
            "SELECT tenant_id,body_hash,summary FROM legacy_web_packages_v1 WHERE export_id=?1",
            [&p.export_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    if let Some((t, h, s)) = old {
        if t != tenant || h != digest {
            return Err(ImportError("WEB_IMPORT_ID_CONFLICT"));
        }
        return serde_json::from_str(&s).map_err(|_| invalid());
    }
    tx.execute("INSERT INTO legacy_web_packages_v1(export_id,tenant_id,body_hash,body,summary,state) VALUES(?1,?2,?3,?4,?5,'PRESERVED_REVIEW_REQUIRED')",rusqlite::params![p.export_id,tenant,digest,p.raw_body(),p.summary.to_string()])?;
    for t in &p.envelope.tables {
        tx.execute("INSERT INTO legacy_web_tables_v1(export_id,table_name,row_count,rows_json,sha256) VALUES(?1,?2,?3,?4,?5)",rusqlite::params![p.export_id,t.name,t.count,t.rows_json,t.sha256])?;
    }
    tx.commit()?;
    Ok(p.summary.clone())
}
pub fn list(c: &Connection, tenant: &str) -> Result<Value, ImportError> {
    let mut s=c.prepare("SELECT summary FROM legacy_web_packages_v1 WHERE tenant_id=?1 ORDER BY rowid DESC LIMIT 50")?;
    let mut rows = Vec::new();
    for row in s.query_map([tenant], |r| r.get::<_, String>(0))? {
        rows.push(serde_json::from_str::<Value>(&row?).map_err(|_| invalid())?);
    }
    Ok(json!({"rows":rows}))
}
pub fn rows(
    c: &Connection,
    tenant: &str,
    export_id: &str,
    table: &str,
    page: u32,
) -> Result<Value, ImportError> {
    if !TABLES.contains(&table) || page > 20_000 {
        return Err(invalid());
    }
    let (raw,digest,count):(String,String,usize)=c.query_row("SELECT t.rows_json,t.sha256,t.row_count FROM legacy_web_tables_v1 t JOIN legacy_web_packages_v1 p USING(export_id) WHERE p.tenant_id=?1 AND p.export_id=?2 AND t.table_name=?3",rusqlite::params![tenant,export_id,table],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
    if hash(&raw) != digest {
        return Err(invalid());
    }
    let rows: Vec<Value> = serde_json::from_str(&raw).map_err(|_| invalid())?;
    let total = rows.len();
    if total != count {
        return Err(invalid());
    }
    let selected: Vec<_> = rows.into_iter().skip(page as usize * 10).take(10).collect();
    Ok(json!({"rows":selected,"total":total,"page":page}))
}
