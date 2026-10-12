//! Envelope primitivo del spike, NO enrollment READY/activación/provisión.
//! XChaCha20Poly1305 con nonce OS aleatoria y secreto de recuperación de 256 bits
//! independiente del PIN. Backup/custodia/manifest completos siguen en T040/G6.
use super::key_provider::{KeyBinding, KeyError};
use crate::storage::cipher::CipherKey;
use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    XChaCha20Poly1305, XNonce,
};
use zeroize::Zeroizing;

pub struct RecoverySecret(Zeroizing<[u8; 32]>);
impl RecoverySecret {
    pub fn generate() -> Result<Self, KeyError> {
        let mut b = Zeroizing::new([0u8; 32]);
        getrandom::fill(&mut *b).map_err(|_| KeyError::RandomUnavailable)?;
        Ok(Self(b))
    }
}
pub struct RecoveryEnvelope(Vec<u8>);
impl RecoveryEnvelope {
    pub fn as_bytes(&self) -> &[u8] {
        &self.0
    }
}
pub fn seal_recovery_key(
    binding: &KeyBinding,
    key: &CipherKey,
    secret: &RecoverySecret,
) -> Result<RecoveryEnvelope, KeyError> {
    let cipher =
        XChaCha20Poly1305::new_from_slice(&secret.0[..]).map_err(|_| KeyError::RecoveryInvalid)?;
    let mut nonce = [0u8; 24];
    getrandom::fill(&mut nonce).map_err(|_| KeyError::RandomUnavailable)?;
    let mut header = Vec::with_capacity(68);
    header.extend_from_slice(b"VRREC001");
    header.extend_from_slice(&binding.aad());
    let ciphertext = cipher
        .encrypt(
            &XNonce::from(nonce),
            Payload {
                msg: key.raw_native(),
                aad: &header,
            },
        )
        .map_err(|_| KeyError::RecoveryInvalid)?;
    let mut envelope = header;
    envelope.extend_from_slice(&nonce);
    envelope.extend_from_slice(&ciphertext);
    Ok(RecoveryEnvelope(envelope))
}
pub fn recover_key(
    binding: &KeyBinding,
    secret: &RecoverySecret,
    envelope: &[u8],
) -> Result<CipherKey, KeyError> {
    if envelope.len() != 140 || &envelope[..8] != b"VRREC001" || envelope[8..68] != binding.aad() {
        return Err(KeyError::RecoveryInvalid);
    }
    let cipher =
        XChaCha20Poly1305::new_from_slice(&secret.0[..]).map_err(|_| KeyError::RecoveryInvalid)?;
    let nonce: XNonce = (&envelope[68..92])
        .try_into()
        .map_err(|_| KeyError::RecoveryInvalid)?;
    let plaintext = Zeroizing::new(
        cipher
            .decrypt(
                &nonce,
                Payload {
                    msg: &envelope[92..],
                    aad: &envelope[..68],
                },
            )
            .map_err(|_| KeyError::RecoveryInvalid)?,
    );
    if plaintext.len() != 32 {
        return Err(KeyError::RecoveryInvalid);
    }
    let mut key = Zeroizing::new([0u8; 32]);
    key.copy_from_slice(&plaintext);
    Ok(CipherKey::from_zeroizing(key))
}
