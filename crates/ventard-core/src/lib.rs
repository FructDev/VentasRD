//! Núcleo de operaciones del POS nativo Ventard (feature 003).
//!
//! Este crate es la única autoridad local de reglas comerciales. La UI nunca
//! calcula importes ni ejecuta SQL: llama comandos tipados que validan aquí.
//! Contratos normativos: `specs/003-pos-nativo-multiplataforma/contracts/`.

#![forbid(unsafe_code)]

#[cfg(all(feature = "fixture-storage", feature = "encrypted-storage"))]
compile_error!("fixture-storage y encrypted-storage son mutuamente excluyentes");

#[cfg(any(feature = "fixture-storage", feature = "encrypted-storage"))]
pub mod application;
pub mod domain;
#[cfg(feature = "encrypted-storage")]
pub mod fiscal;
#[cfg(feature = "qa-spike")]
pub mod qa;
#[cfg(feature = "encrypted-storage")]
pub mod security;
#[cfg(any(feature = "fixture-storage", feature = "encrypted-storage"))]
pub mod storage;
