//! Once-per-operational-launch counter, shared by actors in an installation.
//! Hold this opaque value in native app state, not in a React component.
//! Online counter reset requires verified transport contact (not implemented
//! here); navigator.online, JWT refresh and PIN success never reset it.
use super::{
    local_auth::{runtime, set_highwater, PinError},
    offline_grant::VerifiedGrant,
};
use rusqlite::{params, Connection, TransactionBehavior};

pub struct OperationalLaunch(uuid::Uuid);
impl Default for OperationalLaunch {
    fn default() -> Self {
        Self::new()
    }
}
impl OperationalLaunch {
    pub fn new() -> Self {
        Self(uuid::Uuid::new_v4())
    }
}
pub fn record_operational_open(
    conn: &mut Connection,
    g: &VerifiedGrant,
    launch: &OperationalLaunch,
    now: u64,
) -> Result<u64, PinError> {
    if now > 9_007_199_254_740_991 {
        return Err(PinError::Malformed);
    }
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let (highwater, _) = runtime(&tx, g, now)?;
    if !g
        .evaluate(now, highwater, 0)
        .map_err(|_| PinError::Unauthorized)?
        .allows("READ")
    {
        return Err(PinError::Unauthorized);
    }
    let p = g.payload();
    set_highwater(&tx, g, highwater)?;
    let inserted=tx.execute("INSERT INTO local_operational_openings_v1(tenant_id,installation_id,device_id,writer_epoch,launch_id) VALUES(?1,?2,?3,?4,?5) ON CONFLICT DO NOTHING",params![p.tenant_id,p.installation_id,p.device_id,p.writer_epoch,launch.0.to_string()])?;
    if inserted == 1 {
        tx.execute("UPDATE local_access_runtime_v1 SET openings=openings+1 WHERE tenant_id=?1 AND installation_id=?2 AND device_id=?3 AND writer_epoch=?4",params![p.tenant_id,p.installation_id,p.device_id,p.writer_epoch])?;
    }
    let (_, openings) = runtime(&tx, g, highwater)?;
    tx.commit()?;
    Ok(openings)
}
