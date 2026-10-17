//! Local release preparation only. Reads public key/signature/artifact; no IPC.
use base64::Engine;
use minisign_verify::{PublicKey, Signature};
fn verify() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() != 4 {
        return Err("ARGUMENTS_INVALID".into());
    }
    let public = base64::engine::general_purpose::STANDARD
        .decode(std::fs::read_to_string(&args[0])?.trim())?;
    let signature = base64::engine::general_purpose::STANDARD
        .decode(std::fs::read_to_string(&args[1])?.trim())?;
    let public = PublicKey::decode(std::str::from_utf8(&public)?)?;
    let signature = Signature::decode(std::str::from_utf8(&signature)?)?;
    let bytes = std::fs::read(&args[2])?;
    public.verify(&bytes, &signature, true)?;
    let version = args[3].to_str().ok_or("VERSION_INVALID")?;
    if !signature
        .trusted_comment()
        .split('\t')
        .any(|field| field.strip_prefix("version:") == Some(version))
    {
        return Err("SIGNED_VERSION_MISMATCH".into());
    }
    Ok(())
}
fn main() {
    if verify().is_ok() {
        println!("DESKTOP_RELEASE_SIGNATURE_VERIFIED")
    } else {
        eprintln!("DESKTOP_RELEASE_VERIFICATION_FAILED");
        std::process::exit(1)
    }
}
