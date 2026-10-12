-- Launch identity created/held by native process, never by React rerenders.
CREATE TABLE IF NOT EXISTS local_operational_openings_v1 (
 tenant_id TEXT NOT NULL, installation_id TEXT NOT NULL, device_id TEXT NOT NULL,
 writer_epoch TEXT NOT NULL, launch_id TEXT NOT NULL,
 PRIMARY KEY(tenant_id,installation_id,device_id,writer_epoch,launch_id),
 FOREIGN KEY(tenant_id,installation_id,device_id,writer_epoch)
 REFERENCES local_access_runtime_v1(tenant_id,installation_id,device_id,writer_epoch)
) STRICT;
