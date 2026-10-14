//! Native-owned destinations and frozen presentation bytes, never renderer ESC/POS.
//! Sending is at most once per attempt; a spool/TCP acknowledgement is not paper.
use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::net::Ipv4Addr;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Profile {
    pub mode: String,
    pub connection: String,
    pub queue: Option<String>,
    pub host: Option<String>,
    pub dots: u16,
    pub cut: bool,
    pub drawer: bool,
}
impl Default for Profile {
    fn default() -> Self {
        Self {
            mode: "DIALOG".into(),
            connection: "USB".into(),
            queue: None,
            host: None,
            dots: 576,
            cut: true,
            drawer: false,
        }
    }
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Raster {
    pub width: u16,
    pub height: u32,
    pub data: String,
}
pub struct Dispatch {
    pub fresh: bool,
    pub profile: Profile,
    pub bytes: Vec<u8>,
    pub wire_hash: String,
}
pub fn probe(
    c: &mut Connection,
    ctx: &CatalogueContext,
    g: &crate::security::offline_grant::VerifiedGrant,
    now: u64,
    high: u64,
    opens: u64,
    attempt: &str,
) -> Result<Dispatch, AppError> {
    if !g
        .evaluate(now, high, opens)
        .map_err(|_| invalid())?
        .allows("MANAGE")
    {
        return Err(AppError::Auth(
            super::super::errors::AuthError::PermissionDenied {
                required: "MANAGE".into(),
            },
        ));
    }
    EntityId::parse(attempt).map_err(|_| invalid())?;
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let old:Option<(String,String,Vec<u8>,String)>=tx.query_row("SELECT context_key,target,wire_bytes,wire_hash FROM native_printer_probes_v1 WHERE attempt_id=?1",[attempt],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
    if let Some((k, p, b, wh)) = old {
        if k != context(ctx)? || hash(&b) != wh {
            return Err(invalid());
        }
        let p: Profile = serde_json::from_str(&p).map_err(|_| invalid())?;
        valid(&p)?;
        return Ok(Dispatch {
            fresh: false,
            profile: p,
            bytes: b,
            wire_hash: wh,
        });
    }
    if tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM native_document_print_attempts_v1 WHERE attempt_id=?1 UNION ALL SELECT 1 FROM legacy_service_print_attempts_v1 WHERE attempt_id=?1)",
        [attempt],
        |r| r.get::<_, bool>(0),
    )? {
        return Err(invalid());
    }
    let p = profile(&tx, ctx)?;
    if p.mode == "DIALOG" {
        return Err(guard("PRINT_DIRECT_REQUIRED"));
    }
    let mut bytes = vec![0x1b, 0x40, 0x1b, 0x61, 1, 0x1b, 0x45, 1];
    bytes.extend_from_slice(b"VentaRD POS\n*** PAGINA DE PRUEBA ***\nNO VALIDO FISCALMENTE\n");
    bytes.extend_from_slice(&[0x1b, 0x45, 0, 0x1b, 0x61, 0]);
    bytes.extend_from_slice(format!("Puntos: {}\nConexion: {}\n", p.dots, p.connection).as_bytes());
    bytes.extend_from_slice(b"--------------------------------\nCaracteres: ");
    bytes.extend_from_slice(&[
        0x1b, 0x74, 2, 0xa0, 0x82, 0xa1, 0xa2, 0xa3, b' ', 0xa4, 0xa5, b' ', 0xa8, 0xad,
    ]);
    bytes.extend_from_slice(b" RD$\n\nComprueba alineacion y papel.\n\n\n");
    if p.cut {
        bytes.extend_from_slice(&[0x1d, 0x56, 66, 3]);
    }
    let wh = hash(&bytes);
    tx.execute(
        "INSERT INTO native_printer_probes_v1 VALUES(?1,?2,?3,?4,?5,NULL)",
        (
            attempt,
            context(ctx)?,
            serde_json::to_string(&p).map_err(|_| invalid())?,
            &bytes,
            &wh,
        ),
    )?;
    tx.commit()?;
    Ok(Dispatch {
        fresh: true,
        profile: p,
        bytes,
        wire_hash: wh,
    })
}
fn guard(code: &str) -> AppError {
    AppError::Business(super::super::errors::BusinessError::SaleGuard { code: code.into() })
}
fn hash(b: &[u8]) -> String {
    format!("{:x}", Sha256::digest(b))
}
fn context(ctx: &CatalogueContext) -> Result<String, AppError> {
    serde_json::to_string(ctx).map_err(|_| invalid())
}
pub fn valid(p: &Profile) -> Result<(), AppError> {
    if !matches!(p.dots, 384 | 512 | 576)
        || !matches!(
            p.connection.as_str(),
            "USB" | "BLUETOOTH" | "NETWORK" | "SERIAL"
        )
    {
        return Err(invalid());
    }
    match p.mode.as_str() {
        "DIALOG" if p.queue.is_none() && p.host.is_none() => Ok(()),
        "QUEUE"
            if p.host.is_none()
                && p.queue.as_ref().is_some_and(|n| {
                    !n.is_empty() && n.len() <= 256 && !n.chars().any(char::is_control)
                }) =>
        {
            Ok(())
        }
        "NETWORK" if p.queue.is_none() && p.connection == "NETWORK" => {
            let ip = p
                .host
                .as_deref()
                .ok_or_else(invalid)?
                .parse::<Ipv4Addr>()
                .map_err(|_| invalid())?;
            if !ip.is_private()
                || ip.octets()[3] == 0
                || ip.octets()[3] == 255
                || p.host.as_deref() != Some(ip.to_string().as_str())
            {
                return Err(invalid());
            }
            Ok(())
        }
        _ => Err(invalid()),
    }
}
pub fn profile(c: &Connection, ctx: &CatalogueContext) -> Result<Profile, AppError> {
    // Read-only recovery archives keep their original schema. A pre-v21 copy
    // has no direct transport preference; do not write/migrate it to read tickets.
    let version: u32 = c.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if version < 21 {
        return Ok(Profile::default());
    }
    let raw:Option<String>=c.query_row("SELECT profile FROM native_printer_targets_v1 WHERE tenant_id=?1 AND installation_id=?2",(&ctx.tenant_id,&ctx.installation_id),|r|r.get(0)).optional()?;
    let p = raw
        .map(|s| serde_json::from_str(&s).map_err(|_| invalid()))
        .transpose()?
        .unwrap_or_default();
    valid(&p)?;
    Ok(p)
}
pub fn last_probe(c: &Connection, ctx: &CatalogueContext) -> Result<Option<Value>, AppError> {
    Ok(c.query_row("SELECT attempt_id FROM native_printer_probes_v1 WHERE context_key=?1 ORDER BY rowid DESC LIMIT 1",[context(ctx)?],|r|Ok(json!({"attemptId":r.get::<_,String>(0)?,"state":"UNKNOWN"}))).optional()?)
}
pub fn save(
    c: &Connection,
    g: &crate::security::offline_grant::VerifiedGrant,
    now: u64,
    high: u64,
    opens: u64,
    p: Profile,
) -> Result<Profile, AppError> {
    if !g
        .evaluate(now, high, opens)
        .map_err(|_| invalid())?
        .allows("MANAGE")
    {
        return Err(AppError::Auth(
            super::super::errors::AuthError::PermissionDenied {
                required: "MANAGE".into(),
            },
        ));
    }
    valid(&p)?;
    let g = g.payload();
    c.execute("INSERT INTO native_printer_targets_v1 VALUES(?1,?2,?3) ON CONFLICT(tenant_id,installation_id) DO UPDATE SET profile=excluded.profile",(&g.tenant_id,&g.installation_id,serde_json::to_string(&p).map_err(|_|invalid())?))?;
    Ok(p)
}
fn raster_wire(p: &Profile, r: &Raster, copies: u8, drawer: bool) -> Result<Vec<u8>, AppError> {
    if r.width != p.dots || r.height == 0 || r.height > 20000 || r.data.len() > 2_000_000 {
        return Err(guard("PRINT_RASTER_INVALID"));
    }
    let pixels = STANDARD
        .decode(&r.data)
        .map_err(|_| guard("PRINT_RASTER_INVALID"))?;
    let stride = usize::from(r.width) / 8;
    if pixels.len() != stride * r.height as usize {
        return Err(guard("PRINT_RASTER_INVALID"));
    }
    let mut out = vec![0x1b, 0x40, 0x1b, 0x61, 0];
    if drawer {
        out.extend_from_slice(&[0x1b, 0x70, 0, 0x19, 0xfa]);
    }
    for _ in 0..copies {
        for chunk in pixels.chunks(stride * 256) {
            let rows = chunk.len() / stride;
            out.extend_from_slice(&[
                0x1d,
                0x76,
                0x30,
                0,
                stride as u8,
                (stride >> 8) as u8,
                rows as u8,
                (rows >> 8) as u8,
            ]);
            out.extend_from_slice(chunk);
        }
        out.extend_from_slice(&[0x0a, 0x0a, 0x0a]);
        if p.cut {
            out.extend_from_slice(&[0x1d, 0x56, 66, 3]);
        }
    }
    Ok(out)
}
pub fn prepare(
    c: &mut Connection,
    ctx: &CatalogueContext,
    op: &str,
    snapshot: &str,
    attempt: &str,
    document: bool,
    raster: Option<Raster>,
) -> Result<Dispatch, AppError> {
    EntityId::parse(attempt).map_err(|_| invalid())?;
    if c.query_row(
        "SELECT EXISTS(SELECT 1 FROM native_printer_probes_v1 WHERE attempt_id=?1)",
        [attempt],
        |r| r.get::<_, bool>(0),
    )? {
        return Err(invalid());
    }
    let ticket = if document {
        super::management_ticket(c, ctx, op)?
    } else {
        super::ticket(c, ctx, op)?
    };
    if ticket["printSnapshotHash"] != snapshot {
        return Err(invalid());
    }
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let stored:Option<(String,String,String,String,Vec<u8>,String)>=tx.query_row("SELECT operation_id,context_key,snapshot_hash,target,wire_bytes,wire_hash FROM native_printer_dispatch_v1 WHERE attempt_id=?1 UNION ALL SELECT operation_id,context_key,snapshot_hash,target,wire_bytes,wire_hash FROM legacy_service_printer_dispatch_v1 WHERE attempt_id=?1",[attempt],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).optional()?;
    if let Some((old_op, k, s, p, b, h)) = stored {
        if old_op != op || k != context(ctx)? || s != snapshot || hash(&b) != h {
            return Err(invalid());
        }
        let p: Profile = serde_json::from_str(&p).map_err(|_| invalid())?;
        valid(&p)?;
        return Ok(Dispatch {
            fresh: false,
            profile: p,
            bytes: b,
            wire_hash: h,
        });
    }
    // Old dialog attempts remain terminal/unknown and cannot become a direct send.
    let old:Option<(String,String)>=tx.query_row("SELECT operation_id,snapshot_hash FROM native_document_print_attempts_v1 WHERE attempt_id=?1 UNION ALL SELECT operation_id,snapshot_hash FROM legacy_service_print_attempts_v1 WHERE attempt_id=?1",[attempt],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
    if let Some((a, b)) = old {
        if a != op || b != snapshot {
            return Err(invalid());
        }
        return Ok(Dispatch {
            fresh: false,
            profile: Profile::default(),
            bytes: vec![],
            wire_hash: hash(&[]),
        });
    }
    let p = profile(&tx, ctx)?;
    let l = layout(&tx, ctx)?;
    let bytes = if p.mode == "DIALOG" {
        if raster.is_some() {
            return Err(guard("PRINT_TARGET_CHANGED"));
        }
        vec![]
    } else {
        if (l.paper_width == "58mm" && p.dots != 384) || (l.paper_width == "80mm" && p.dots == 384)
        {
            return Err(guard("PRINT_WIDTH_CONFLICT"));
        }
        let r = raster
            .as_ref()
            .ok_or_else(|| guard("PRINT_RASTER_REQUIRED"))?;
        let auto: bool = if document {
            false
        } else {
            tx.query_row("SELECT EXISTS(SELECT 1 FROM sale_print_jobs_v1 WHERE operation_id=?1 AND job_id=?2 AND state='QUEUED')",(op,attempt),|r|r.get(0))?
        };
        let cash = ticket["sale"]["payment"]["cashNetCents"]
            .as_str()
            .and_then(|s| s.parse::<u64>().ok())
            .is_some_and(|n| n > 0);
        raster_wire(
            &p,
            r,
            if document { 1 } else { l.copies },
            p.drawer && auto && cash,
        )?
    };
    if document {
        super::request_document_in_transaction(&tx, op, snapshot, attempt)?;
    } else {
        super::request_sale_in_transaction(&tx, op, snapshot, attempt)?;
    }
    let h = hash(&bytes);
    tx.execute(
        if document && super::document_attempt_table(&tx, op)? == "legacy_service_print_attempts_v1"
        {
            "INSERT INTO legacy_service_printer_dispatch_v1 VALUES(?1,?2,?3,?4,?5,?6,?7,NULL)"
        } else {
            "INSERT INTO native_printer_dispatch_v1 VALUES(?1,?2,?3,?4,?5,?6,?7,NULL)"
        },
        (
            attempt,
            op,
            context(ctx)?,
            snapshot,
            serde_json::to_string(&p).map_err(|_| invalid())?,
            &bytes,
            &h,
        ),
    )?;
    tx.commit()?;
    Ok(Dispatch {
        fresh: true,
        profile: p,
        bytes,
        wire_hash: h,
    })
}
pub fn acknowledge(
    c: &Connection,
    ctx: &CatalogueContext,
    attempt: &str,
    wire_hash: &str,
    receipt: &Value,
) -> Result<(), AppError> {
    let(table,k,h,old):(String,String,String,Option<String>)=c.query_row("SELECT 'DISPATCH',context_key,wire_hash,transport_receipt FROM native_printer_dispatch_v1 WHERE attempt_id=?1 UNION ALL SELECT 'BASELINE',context_key,wire_hash,transport_receipt FROM legacy_service_printer_dispatch_v1 WHERE attempt_id=?1 UNION ALL SELECT 'PROBE',context_key,wire_hash,transport_receipt FROM native_printer_probes_v1 WHERE attempt_id=?1",[attempt],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)))?;
    if k != context(ctx)? || h != wire_hash {
        return Err(invalid());
    }
    if let Some(old) = old {
        if serde_json::from_str::<Value>(&old).map_err(|_| invalid())? != *receipt {
            return Err(invalid());
        }
        return Ok(());
    }
    c.execute(if table=="PROBE"{"UPDATE native_printer_probes_v1 SET transport_receipt=?2 WHERE attempt_id=?1 AND transport_receipt IS NULL"}else if table=="BASELINE"{"UPDATE legacy_service_printer_dispatch_v1 SET transport_receipt=?2 WHERE attempt_id=?1 AND transport_receipt IS NULL"}else{"UPDATE native_printer_dispatch_v1 SET transport_receipt=?2 WHERE attempt_id=?1 AND transport_receipt IS NULL"},(attempt,receipt.to_string()))?;
    Ok(())
}
