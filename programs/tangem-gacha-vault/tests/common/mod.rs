//! Shared helpers for the LiteSVM integration suites.
//!
//! Every suite runs the REAL compiled `target/deploy/tangem_gacha_vault.so`
//! (or the artifact selected with `VAULT_SBF_PATH`).
//! `cargo test` does NOT rebuild that artifact — only `anchor build` /
//! `cargo build-sbf` does. Without a guard, editing `src/lib.rs` and running
//! `cargo test` silently exercises the PREVIOUS binary, so a broken change can
//! come back green and a new assertion can "pass" against code that was never
//! compiled. `program_so_path` fails loudly instead.
//!
//! Each suite includes this module separately and uses only some helpers.
#![allow(dead_code)]

// The AnchorDeserialize derive expands to `borsh::...` paths, so the crate
// alias must be in scope here.
use anchor_lang::prelude::borsh;
use base64::Engine;
use std::path::PathBuf;
use std::time::SystemTime;

fn mtime(path: &PathBuf) -> Option<SystemTime> {
    std::fs::metadata(path).ok()?.modified().ok()
}

/// Path to the compiled program, checked for staleness against the sources it
/// is built from. Panics with an actionable message when a rebuild is due.
pub fn program_so_path() -> String {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let so = std::env::var_os("VAULT_SBF_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join("../../target/deploy/tangem_gacha_vault.so"));

    let so_time = mtime(&so)
        .unwrap_or_else(|| panic!("{} does not exist — run `anchor build` first", so.display()));

    // Cargo.toml matters too: a dependency or feature change alters the binary
    // without touching lib.rs.
    for src in [
        "src/lib.rs",
        "Cargo.toml",
        "../../Cargo.toml",
        "../../Cargo.lock",
    ] {
        let path = root.join(src);
        if let Some(src_time) = mtime(&path) {
            if src_time > so_time {
                panic!(
                    "{} is OLDER than {src}.\n\
                     `cargo test` never rebuilds the .so, so this run would test \
                     the previous binary.\n\
                     Rebuild the selected artifact first (`anchor build` for the default path).",
                    so.display()
                );
            }
        }
    }

    so.to_string_lossy().into_owned()
}

/// Independent decoder for the spin event consumed by backend indexers.
/// Using the program's own event type would let incompatible layout changes
/// pass unnoticed when both encoder and decoder changed together.
#[derive(anchor_lang::AnchorDeserialize)]
pub struct PackOpenedWire {
    pub vault: anchor_lang::prelude::Pubkey,
    pub owner: anchor_lang::prelude::Pubkey,
    pub amount: u64,
    pub fee: u64,
    pub memo: String,
}

impl anchor_lang::Discriminator for PackOpenedWire {
    // sha256("event:PackOpened")[..8]
    const DISCRIMINATOR: &'static [u8] = &[107, 111, 64, 235, 140, 166, 46, 201];
}

/// Decodes the first Anchor event of type `T` out of a transaction's logs.
///
/// Anchor emits events as `Program data: <base64 of discriminator || borsh>`.
/// Nothing in the suite used to decode one, so an event's SHAPE (a renamed or
/// reordered field, a wrong value) was entirely unverified.
pub fn decode_event<T>(logs: &[String]) -> Option<T>
where
    T: anchor_lang::Discriminator + anchor_lang::AnchorDeserialize,
{
    let disc = T::DISCRIMINATOR;
    for line in logs {
        let Some(b64) = line.strip_prefix("Program data: ") else {
            continue;
        };
        let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(b64.trim()) else {
            continue;
        };
        if bytes.len() >= disc.len() && &bytes[..disc.len()] == disc {
            if let Ok(ev) = T::try_from_slice(&bytes[disc.len()..]) {
                return Some(ev);
            }
        }
    }
    None
}
