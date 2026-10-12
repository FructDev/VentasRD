//! Public registration request IDs, never passwords or signing material.
//! Renew only after an authenticated issuer reports NATIVE_POLICY_CHANGED.
//! Network errors reuse the persisted current ID.
use crate::domain::identity::EntityId;
use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    path::Path,
};
fn invalid() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "REGISTRATION_REQUEST_INVALID")
}
fn read(path: &Path) -> io::Result<(String, Vec<u8>)> {
    if fs::metadata(path)?.len() > 128 {
        return Err(invalid());
    }
    let bytes = fs::read(path)?;
    let id: String = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    EntityId::parse(&id).map_err(|_| invalid())?;
    Ok((id, bytes))
}
fn create(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}
pub fn load_or_create(path: &Path) -> io::Result<String> {
    match read(path) {
        Ok((id, _)) => Ok(id),
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            let id = EntityId::new_random().to_string();
            let bytes = serde_json::to_vec(&id).map_err(|_| invalid())?;
            match create(path, &bytes) {
                Ok(()) => Ok(id),
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => read(path).map(|(id, _)| id),
                Err(e) => Err(e),
            }
        }
        Err(e) => Err(e),
    }
}
pub fn renew(path: &Path, expected: &str) -> io::Result<String> {
    EntityId::parse(expected).map_err(|_| invalid())?;
    let (current, bytes) = read(path)?;
    if current != expected {
        return Err(invalid());
    }
    let parent = path.parent().ok_or_else(invalid)?;
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(invalid)?;
    let archive = parent.join(format!("{stem}.previous-{current}.json"));
    match create(&archive, &bytes) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
            if fs::read(&archive)? != bytes {
                return Err(invalid());
            }
        }
        Err(e) => return Err(e),
    };
    let next = EntityId::new_random().to_string();
    let temp = parent.join(format!("{stem}.renewal-{next}.tmp"));
    create(&temp, &serde_json::to_vec(&next).map_err(|_| invalid())?)?;
    // Atomic replacement preserves old/new valid pointer after interruption.
    // Previous request is archived; financial IDs/history remain untouched.
    fs::rename(temp, path)?;
    Ok(next)
}
