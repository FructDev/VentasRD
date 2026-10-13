//! Fixed native ESC/POS transport. No renderer commands, shell, URLs or secrets.
use super::*;
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use ventard_core::application::printing::transport::Profile;
pub fn queues() -> Value {
    let default = ::printers::get_default_printer().map(|p| p.system_name);
    json!(::printers::get_printers().into_iter().take(100).map(|p|json!({"name":p.system_name,"label":p.name,"driver":p.driver_name,"port":p.port_name,"state":format!("{:?}",p.state),"default":default.as_deref()==Some(p.system_name.as_str())})).collect::<Vec<_>>())
}
pub fn validate_queue(p: &Profile) -> Result<(), AccessError> {
    if p.mode == "QUEUE"
        && ::printers::get_printer_by_name(p.queue.as_deref().unwrap_or("")).is_none()
    {
        return Err(error("PRINT_QUEUE_MISSING"));
    }
    Ok(())
}
pub fn send(p: &Profile, bytes: &[u8]) -> Result<Value, AccessError> {
    ventard_core::application::printing::transport::valid(p)
        .map_err(|_| error("PRINT_TARGET_INVALID"))?;
    match p.mode.as_str() {
        "QUEUE" => {
            let printer = ::printers::get_printer_by_name(p.queue.as_deref().unwrap_or(""))
                .ok_or(error("PRINT_QUEUE_MISSING"))?;
            let mut options = ::printers::common::base::job::PrinterJobOptions::none();
            options.name = Some("VentaRD ticket guardado");
            let id = printer
                .print(bytes, options)
                .map_err(|_| error("PRINT_TRANSPORT_UNCERTAIN"))?;
            // The library/Windows job id does not prove every byte reached paper.
            Ok(json!({"transport":"WINDOWS_QUEUE","jobId":id.to_string(),"paper":"UNKNOWN"}))
        }
        "NETWORK" => send_tcp(
            SocketAddr::from((
                p.host
                    .as_deref()
                    .unwrap_or("")
                    .parse::<Ipv4Addr>()
                    .map_err(|_| error("PRINT_TARGET_INVALID"))?,
                9100,
            )),
            bytes,
        ),
        _ => Err(error("PRINT_TARGET_INVALID")),
    }
}
fn send_tcp(address: SocketAddr, bytes: &[u8]) -> Result<Value, AccessError> {
    let mut socket = TcpStream::connect_timeout(&address, Duration::from_secs(3))
        .map_err(|_| error("PRINT_TRANSPORT_UNCERTAIN"))?;
    socket
        .set_write_timeout(Some(Duration::from_secs(3)))
        .map_err(|_| error("PRINT_TRANSPORT_UNCERTAIN"))?;
    let deadline = std::time::Instant::now() + Duration::from_secs(8);
    let mut offset = 0;
    while offset < bytes.len() {
        if std::time::Instant::now() > deadline {
            return Err(error("PRINT_TRANSPORT_UNCERTAIN"));
        }
        let count = socket
            .write(&bytes[offset..bytes.len().min(offset + 32768)])
            .map_err(|_| error("PRINT_TRANSPORT_UNCERTAIN"))?;
        if count == 0 {
            return Err(error("PRINT_TRANSPORT_UNCERTAIN"));
        }
        offset += count;
    }
    Ok(json!({"transport":"TCP","acceptedBytes":offset.to_string(),"paper":"UNKNOWN"}))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_tcp_transport_sends_exact_bytes_once_to_owned_loopback_fixture() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let worker = std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let mut bytes = Vec::new();
            s.read_to_end(&mut bytes).unwrap();
            bytes
        });
        let wire = vec![0x1b, 0x40, 0x1d, 0x76, 0x30, 0, 1, 0, 1, 0, 0xaa];
        let r = send_tcp(address, &wire).unwrap();
        assert_eq!(r["paper"], "UNKNOWN");
        assert_eq!(r["acceptedBytes"], wire.len().to_string());
        assert_eq!(worker.join().unwrap(), wire);
    }
    #[test]
    fn windows_printer_inventory_is_read_only_and_returns_only_queue_metadata() {
        let v = queues();
        assert!(v.is_array());
        for p in v.as_array().unwrap() {
            assert!(p["name"].is_string());
            assert!(p["default"].is_boolean());
            assert_eq!(p.as_object().unwrap().len(), 6);
        }
    }
}
