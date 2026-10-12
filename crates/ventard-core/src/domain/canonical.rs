//! Canonicalización C-N1 y hash de intención (T022; FR-006, FR-008, FR-053).
//!
//! Contrato: `contracts/operations-v1.md` §Canonicalización C-N1. Subconjunto
//! estricto de RFC 8785 (JCS):
//! - claves ASCII, únicas, ordenadas por unidades UTF-16 (= bytes para ASCII);
//! - arrays conservan orden; strings sin normalización Unicode;
//! - escapes mínimos de RFC 8785 (`\"`, `\\`, `\b\f\n\r\t`, resto de controles `\u00xx`);
//! - números JSON sólo enteros canónicos no negativos ≤ 2^53-1 (versiones/enums);
//!   dinero, cantidades, tiempos y secuencias viajan como strings;
//! - hash = SHA-256 hex minúscula de los bytes canónicos.
//!
//! Los formatos legacy (SALE1, INVENTORY2, `canonicalCommand`) NO pasan por
//! aquí: se conservan con su propio algoritmo (ver `LegacyHash`).

use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fmt;

pub const CANONICALIZATION_VERSION: &str = "C-N1";
/// Tope de diseño D26 para una intención; G0 confirma el valor efectivo.
pub const MAX_INPUT_BYTES: usize = 1024 * 1024;
pub const MAX_DEPTH: usize = 64;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CanonError {
    TooLarge,
    TooDeep,
    Syntax(usize),
    DuplicateKey(String),
    NonAsciiKey,
    NumberNotAllowed(usize),
    InvalidEscape(usize),
    LoneSurrogate(usize),
    TrailingData(usize),
}

impl fmt::Display for CanonError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CanonError::TooLarge => f.write_str("canon_too_large"),
            CanonError::TooDeep => f.write_str("canon_too_deep"),
            CanonError::Syntax(p) => write!(f, "canon_syntax@{p}"),
            CanonError::DuplicateKey(k) => write!(f, "canon_duplicate_key:{k}"),
            CanonError::NonAsciiKey => f.write_str("canon_non_ascii_key"),
            CanonError::NumberNotAllowed(p) => write!(f, "canon_number_not_allowed@{p}"),
            CanonError::InvalidEscape(p) => write!(f, "canon_invalid_escape@{p}"),
            CanonError::LoneSurrogate(p) => write!(f, "canon_lone_surrogate@{p}"),
            CanonError::TrailingData(p) => write!(f, "canon_trailing_data@{p}"),
        }
    }
}

impl std::error::Error for CanonError {}

/// Valor JSON admitido por C-N1. `BTreeMap<String,_>` ordena por bytes, que
/// coincide con el orden UTF-16 de RFC 8785 porque las claves son ASCII.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CanonValue {
    Null,
    Bool(bool),
    /// Sólo versiones/enums acotados.
    Int(u64),
    String(String),
    Array(Vec<CanonValue>),
    Object(BTreeMap<String, CanonValue>),
}

impl CanonValue {
    /// Bytes canónicos C-N1.
    pub fn to_canonical_string(&self) -> String {
        let mut out = String::new();
        write_value(self, &mut out);
        out
    }

    pub fn hash_hex(&self) -> String {
        sha256_hex(self.to_canonical_string().as_bytes())
    }

    /// Construye un objeto validando claves ASCII y unicidad.
    pub fn object<I, K>(entries: I) -> Result<CanonValue, CanonError>
    where
        I: IntoIterator<Item = (K, CanonValue)>,
        K: Into<String>,
    {
        let mut map = BTreeMap::new();
        for (k, v) in entries {
            let k = k.into();
            if !k.is_ascii() {
                return Err(CanonError::NonAsciiKey);
            }
            if map.contains_key(&k) {
                return Err(CanonError::DuplicateKey(k));
            }
            map.insert(k, v);
        }
        Ok(CanonValue::Object(map))
    }
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut s = String::with_capacity(64);
    for b in digest {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

fn write_value(v: &CanonValue, out: &mut String) {
    match v {
        CanonValue::Null => out.push_str("null"),
        CanonValue::Bool(true) => out.push_str("true"),
        CanonValue::Bool(false) => out.push_str("false"),
        CanonValue::Int(n) => out.push_str(&n.to_string()),
        CanonValue::String(s) => write_string(s, out),
        CanonValue::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_value(item, out);
            }
            out.push(']');
        }
        CanonValue::Object(map) => {
            out.push('{');
            for (i, (k, item)) in map.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_string(k, out);
                out.push(':');
                write_value(item, out);
            }
            out.push('}');
        }
    }
}

fn write_string(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0C}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

/// Parse estricto de bytes JSON a [`CanonValue`]. Rechaza claves duplicadas,
/// números no enteros/negativos/no canónicos, surrogates sueltos, BOM y basura final.
pub fn parse(input: &[u8]) -> Result<CanonValue, CanonError> {
    if input.len() > MAX_INPUT_BYTES {
        return Err(CanonError::TooLarge);
    }
    let text = std::str::from_utf8(input).map_err(|e| CanonError::Syntax(e.valid_up_to()))?;
    let mut p = Parser {
        s: text.as_bytes(),
        src: text,
        i: 0,
    };
    p.ws();
    let v = p.value(0)?;
    p.ws();
    if p.i != p.s.len() {
        return Err(CanonError::TrailingData(p.i));
    }
    Ok(v)
}

/// Canonicaliza y calcula el hash en un paso (lo que hace el API al recibir).
pub fn canonicalize(input: &[u8]) -> Result<(String, String), CanonError> {
    let v = parse(input)?;
    let c = v.to_canonical_string();
    let h = sha256_hex(c.as_bytes());
    Ok((c, h))
}

struct Parser<'a> {
    s: &'a [u8],
    src: &'a str,
    i: usize,
}

impl<'a> Parser<'a> {
    fn ws(&mut self) {
        while let Some(b' ' | b'\t' | b'\n' | b'\r') = self.s.get(self.i) {
            self.i += 1;
        }
    }

    fn peek(&self) -> Option<u8> {
        self.s.get(self.i).copied()
    }

    fn expect_lit(&mut self, lit: &str, v: CanonValue) -> Result<CanonValue, CanonError> {
        if self.s[self.i..].starts_with(lit.as_bytes()) {
            self.i += lit.len();
            Ok(v)
        } else {
            Err(CanonError::Syntax(self.i))
        }
    }

    fn value(&mut self, depth: usize) -> Result<CanonValue, CanonError> {
        if depth > MAX_DEPTH {
            return Err(CanonError::TooDeep);
        }
        match self.peek() {
            Some(b'n') => self.expect_lit("null", CanonValue::Null),
            Some(b't') => self.expect_lit("true", CanonValue::Bool(true)),
            Some(b'f') => self.expect_lit("false", CanonValue::Bool(false)),
            Some(b'"') => Ok(CanonValue::String(self.string()?)),
            Some(b'[') => self.array(depth),
            Some(b'{') => self.object(depth),
            Some(b'-' | b'0'..=b'9') => self.number(),
            _ => Err(CanonError::Syntax(self.i)),
        }
    }

    fn number(&mut self) -> Result<CanonValue, CanonError> {
        let start = self.i;
        while let Some(b'-' | b'+' | b'.' | b'e' | b'E' | b'0'..=b'9') = self.peek() {
            self.i += 1;
        }
        let raw = &self.src[start..self.i];
        let canonical = !raw.is_empty()
            && raw.bytes().all(|b| b.is_ascii_digit())
            && (raw == "0" || !raw.starts_with('0'))
            && raw.len() <= 16;
        if !canonical {
            return Err(CanonError::NumberNotAllowed(start));
        }
        let n: u64 = raw
            .parse()
            .map_err(|_| CanonError::NumberNotAllowed(start))?;
        if n > MAX_SAFE_INTEGER {
            return Err(CanonError::NumberNotAllowed(start));
        }
        Ok(CanonValue::Int(n))
    }

    fn hex4(&mut self) -> Result<u32, CanonError> {
        let start = self.i;
        let digits = self
            .src
            .get(self.i..self.i + 4)
            .ok_or(CanonError::InvalidEscape(start))?;
        if !digits.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(CanonError::InvalidEscape(start));
        }
        self.i += 4;
        u32::from_str_radix(digits, 16).map_err(|_| CanonError::InvalidEscape(start))
    }

    fn string(&mut self) -> Result<String, CanonError> {
        self.i += 1; // comilla inicial
        let mut out = String::new();
        loop {
            let start = self.i;
            // Copia en bloque los bytes sin escape (UTF-8 ya validado).
            while let Some(b) = self.peek() {
                if b == b'"' || b == b'\\' || b < 0x20 {
                    break;
                }
                self.i += 1;
            }
            out.push_str(&self.src[start..self.i]);
            match self.peek() {
                Some(b'"') => {
                    self.i += 1;
                    return Ok(out);
                }
                Some(b'\\') => {
                    let esc_pos = self.i;
                    self.i += 1;
                    let c = self.peek().ok_or(CanonError::InvalidEscape(esc_pos))?;
                    self.i += 1;
                    match c {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{08}'),
                        b'f' => out.push('\u{0C}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => {
                            let hi = self.hex4()?;
                            let cp = if (0xD800..0xDC00).contains(&hi) {
                                if !self.s[self.i..].starts_with(b"\\u") {
                                    return Err(CanonError::LoneSurrogate(esc_pos));
                                }
                                self.i += 2;
                                let lo = self.hex4()?;
                                if !(0xDC00..0xE000).contains(&lo) {
                                    return Err(CanonError::LoneSurrogate(esc_pos));
                                }
                                0x10000 + ((hi - 0xD800) << 10) + (lo - 0xDC00)
                            } else if (0xDC00..0xE000).contains(&hi) {
                                return Err(CanonError::LoneSurrogate(esc_pos));
                            } else {
                                hi
                            };
                            out.push(char::from_u32(cp).ok_or(CanonError::InvalidEscape(esc_pos))?);
                        }
                        _ => return Err(CanonError::InvalidEscape(esc_pos)),
                    }
                }
                // Control sin escapar o fin de entrada.
                _ => return Err(CanonError::Syntax(self.i)),
            }
        }
    }

    fn array(&mut self, depth: usize) -> Result<CanonValue, CanonError> {
        self.i += 1;
        let mut items = Vec::new();
        self.ws();
        if self.peek() == Some(b']') {
            self.i += 1;
            return Ok(CanonValue::Array(items));
        }
        loop {
            self.ws();
            items.push(self.value(depth + 1)?);
            self.ws();
            match self.peek() {
                Some(b',') => self.i += 1,
                Some(b']') => {
                    self.i += 1;
                    return Ok(CanonValue::Array(items));
                }
                _ => return Err(CanonError::Syntax(self.i)),
            }
        }
    }

    fn object(&mut self, depth: usize) -> Result<CanonValue, CanonError> {
        self.i += 1;
        let mut map = BTreeMap::new();
        self.ws();
        if self.peek() == Some(b'}') {
            self.i += 1;
            return Ok(CanonValue::Object(map));
        }
        loop {
            self.ws();
            if self.peek() != Some(b'"') {
                return Err(CanonError::Syntax(self.i));
            }
            let key = self.string()?;
            if !key.is_ascii() {
                return Err(CanonError::NonAsciiKey);
            }
            self.ws();
            if self.peek() != Some(b':') {
                return Err(CanonError::Syntax(self.i));
            }
            self.i += 1;
            self.ws();
            let v = self.value(depth + 1)?;
            if map.contains_key(&key) {
                return Err(CanonError::DuplicateKey(key));
            }
            map.insert(key, v);
            self.ws();
            match self.peek() {
                Some(b',') => self.i += 1,
                Some(b'}') => {
                    self.i += 1;
                    return Ok(CanonValue::Object(map));
                }
                _ => return Err(CanonError::Syntax(self.i)),
            }
        }
    }
}

/// Hash legacy conservado con su algoritmo original; nunca se recalcula con C-N1.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LegacyHash {
    /// (a) bytes originales disponibles y hash coincidente.
    OriginalBytes {
        algorithm: String,
        bytes: Vec<u8>,
        hash: String,
    },
    /// (b) reconstrucción demostrable con hash coincidente bajo el algoritmo original.
    Reconstructed {
        algorithm: String,
        bytes: Vec<u8>,
        hash: String,
    },
    /// (c) raw/hash conservados pero intención no reconstruible.
    UnknownLegacy { algorithm: String, hash: String },
}

impl LegacyHash {
    /// Clasifica evidencia legacy: sólo acepta (a)/(b) si SHA-256 de los bytes
    /// coincide exactamente con el hash declarado; en otro caso UNKNOWN_LEGACY.
    pub fn classify(
        algorithm: &str,
        declared_hash: &str,
        original: Option<&[u8]>,
        reconstructed: Option<&[u8]>,
    ) -> LegacyHash {
        let declared = declared_hash.to_ascii_lowercase();
        if !matches!(algorithm, "SALE1" | "INVENTORY2" | "canonicalCommand") {
            return LegacyHash::UnknownLegacy {
                algorithm: algorithm.into(),
                hash: declared,
            };
        }
        if let Some(b) = original {
            if sha256_hex(b) == declared {
                return LegacyHash::OriginalBytes {
                    algorithm: algorithm.into(),
                    bytes: b.to_vec(),
                    hash: declared,
                };
            }
        }
        if let Some(b) = reconstructed {
            if sha256_hex(b) == declared {
                return LegacyHash::Reconstructed {
                    algorithm: algorithm.into(),
                    bytes: b.to_vec(),
                    hash: declared,
                };
            }
        }
        LegacyHash::UnknownLegacy {
            algorithm: algorithm.into(),
            hash: declared,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn canon(s: &str) -> String {
        canonicalize(s.as_bytes()).unwrap().0
    }

    #[test]
    fn sorts_keys_and_keeps_array_order() {
        assert_eq!(
            canon(r#"{ "b": [3,1,2], "a": null }"#),
            r#"{"a":null,"b":[3,1,2]}"#
        );
    }

    #[test]
    fn unicode_preserved_not_normalized() {
        // "é" precompuesta vs "e"+U+0301 producen bytes distintos.
        let nfc = canon("{\"n\":\"\u{e9}\"}");
        let nfd = canon("{\"n\":\"e\u{301}\"}");
        assert_ne!(nfc, nfd);
        assert_eq!(canon(r#"{"n":"\u00e9"}"#), nfc);
        assert_eq!(canon(r#"{"e":"\ud83d\ude00"}"#), "{\"e\":\"\u{1F600}\"}");
    }

    #[test]
    fn escapes_follow_rfc8785() {
        assert_eq!(
            canon(r#"["\u0001\b\t\n\f\r\"\\\/\u007f"]"#),
            "[\"\\u0001\\b\\t\\n\\f\\r\\\"\\\\/\u{7f}\"]"
        );
    }

    #[test]
    fn rejects_duplicates_numbers_and_garbage() {
        assert_eq!(
            parse(br#"{"a":1,"a":1}"#),
            Err(CanonError::DuplicateKey("a".into()))
        );
        for bad in [
            r#"{"a":1.5}"#,
            r#"{"a":-1}"#,
            r#"{"a":1e2}"#,
            r#"{"a":01}"#,
            r#"{"a":9007199254740992}"#,
        ] {
            assert!(
                matches!(parse(bad.as_bytes()), Err(CanonError::NumberNotAllowed(_))),
                "{bad}"
            );
        }
        assert!(matches!(
            parse(br#"{"a":1} x"#),
            Err(CanonError::TrailingData(_))
        ));
        assert!(matches!(
            parse(br#"["\ud800"]"#),
            Err(CanonError::LoneSurrogate(_))
        ));
        assert!(matches!(
            parse(br#"["\udc00\ud800"]"#),
            Err(CanonError::LoneSurrogate(_))
        ));
        assert_eq!(
            parse("{\"\u{e9}\":1}".as_bytes()),
            Err(CanonError::NonAsciiKey)
        );
        assert!(parse(b"\xEF\xBB\xBF{}").is_err(), "BOM rechazado");
        assert!(parse(b"[\"a\x01\"]").is_err(), "control sin escapar");
    }

    #[test]
    fn depth_and_size_limits() {
        let deep = "[".repeat(MAX_DEPTH + 2) + &"]".repeat(MAX_DEPTH + 2);
        assert_eq!(parse(deep.as_bytes()), Err(CanonError::TooDeep));
        let big = vec![b' '; MAX_INPUT_BYTES + 1];
        assert_eq!(parse(&big), Err(CanonError::TooLarge));
    }

    #[test]
    fn hash_is_lowercase_sha256_of_canonical_bytes() {
        let (c, h) = canonicalize(b"{}").unwrap();
        assert_eq!(c, "{}");
        assert_eq!(
            h,
            "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"
        );
    }

    #[test]
    fn legacy_hash_never_adopts_mismatch() {
        let bytes = b"legacy-payload";
        let h = sha256_hex(bytes);
        assert!(matches!(
            LegacyHash::classify("SALE1", &h, Some(bytes), None),
            LegacyHash::OriginalBytes { .. }
        ));
        assert!(matches!(
            LegacyHash::classify("SALE1", &h, None, Some(bytes)),
            LegacyHash::Reconstructed { .. }
        ));
        assert!(matches!(
            LegacyHash::classify("SALE1", &h, None, Some(b"otro")),
            LegacyHash::UnknownLegacy { .. }
        ));
    }

    #[test]
    fn unsupported_legacy_algorithm_cannot_become_verified_evidence() {
        let bytes = b"payload";
        let hash = sha256_hex(bytes);
        assert!(matches!(
            LegacyHash::classify("future-unknown-format", &hash, Some(bytes), None),
            LegacyHash::UnknownLegacy { .. }
        ));
    }
}
