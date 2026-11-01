//! Day 1 fee corridor, published ABI and spending tests on real bytecode.
//! Config and Vault are fresh accounts under a new program ID; custody and
//! migration selectors must not remain callable. Run `anchor build` first.

mod common;

use anchor_lang::{
    AccountDeserialize, AccountSerialize, Discriminator, InstructionData, Space, ToAccountMetas,
};
use litesvm::LiteSVM;
use solana_sdk::{
    account::Account,
    instruction::{AccountMeta, Instruction},
    pubkey,
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    system_instruction, system_program,
    transaction::Transaction,
};
use tangem_gacha_vault::{
    accounts, instruction, Config, ConfigUpdated, PackOpened, Vault, VaultError, CONFIG_SEED,
    MAX_FEE_BPS, VAULT_SEED,
};

const PROGRAM_ID: Pubkey = tangem_gacha_vault::ID;
const TOKEN_PROGRAM_ID: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM_ID: Pubkey = pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
/// Default caps: generous, so only the fee logic binds in the corridor tests.
const D: u64 = 300_000_000;
/// Test corridor: 1% .. 5%.
const MIN_BPS: u16 = 100;
const MAX_BPS: u16 = 500;
/// Discriminator of the REMOVED `open_pack` (sha256("global:open_pack")[..8]).
const OLD_OPEN_PACK_DISCRIMINATOR: [u8; 8] = [75, 203, 144, 65, 63, 253, 103, 85];

fn ata(owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[owner.as_ref(), TOKEN_PROGRAM_ID.as_ref(), mint.as_ref()],
        &ATA_PROGRAM_ID,
    )
    .0
}

fn create_mint(svm: &mut LiteSVM, payer: &Keypair, authority: &Pubkey) -> Pubkey {
    let mint = Keypair::new();
    let rent = svm.minimum_balance_for_rent_exemption(82);
    let create = system_instruction::create_account(
        &payer.pubkey(),
        &mint.pubkey(),
        rent,
        82,
        &TOKEN_PROGRAM_ID,
    );
    let mut data = vec![20u8, 6]; // InitializeMint2, 6 decimals
    data.extend_from_slice(authority.as_ref());
    data.push(0);
    let init = Instruction {
        program_id: TOKEN_PROGRAM_ID,
        accounts: vec![AccountMeta::new(mint.pubkey(), false)],
        data,
    };
    let tx = Transaction::new_signed_with_payer(
        &[create, init],
        Some(&payer.pubkey()),
        &[payer, &mint],
        svm.latest_blockhash(),
    );
    svm.send_transaction(tx).expect("create mint");
    mint.pubkey()
}

fn create_ata(svm: &mut LiteSVM, payer: &Keypair, owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    let addr = ata(owner, mint);
    let ix = Instruction {
        program_id: ATA_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new(addr, false),
            AccountMeta::new_readonly(*owner, false),
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new_readonly(system_program::ID, false),
            AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
        ],
        data: vec![1], // CreateIdempotent
    };
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&payer.pubkey()),
        &[payer],
        svm.latest_blockhash(),
    );
    svm.send_transaction(tx).expect("create ata");
    addr
}

fn mint_to(
    svm: &mut LiteSVM,
    payer: &Keypair,
    mint: &Pubkey,
    dest: &Pubkey,
    authority: &Keypair,
    amount: u64,
) {
    let mut data = vec![7u8];
    data.extend_from_slice(&amount.to_le_bytes());
    let ix = Instruction {
        program_id: TOKEN_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*mint, false),
            AccountMeta::new(*dest, false),
            AccountMeta::new_readonly(authority.pubkey(), true),
        ],
        data,
    };
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&payer.pubkey()),
        &[payer, authority],
        svm.latest_blockhash(),
    );
    svm.send_transaction(tx).expect("mint_to");
}

fn token_amount(svm: &LiteSVM, account: &Pubkey) -> u64 {
    let acc = svm.get_account(account).expect("token account exists");
    u64::from_le_bytes(acc.data[64..72].try_into().unwrap())
}

struct World {
    svm: LiteSVM,
    admin: Keypair,
    cold: Keypair,
    hot: Keypair,
    payer: Keypair,
    mint: Pubkey,
    vault: Pubkey,
    vault_usdc: Pubkey,
    config: Pubkey,
    gacha_usdc: Pubkey,
    fee_usdc: Pubkey,
}

/// A test corridor (1% .. 5%) with caps that never bind.
fn setup() -> World {
    setup_with(MIN_BPS, MAX_BPS, D, 100 * D)
}

fn setup_with(min_fee_bps: u16, max_fee_bps: u16, per_spin_cap: u64, daily_cap: u64) -> World {
    let mut svm = LiteSVM::new();
    svm.add_program_from_file(PROGRAM_ID, common::program_so_path())
        .expect("run `anchor build` first");

    let payer = Keypair::new();
    let admin = Keypair::new();
    let cold = Keypair::new();
    let hot = Keypair::new();
    for kp in [&payer, &admin, &cold, &hot] {
        svm.airdrop(&kp.pubkey(), 10_000_000_000).unwrap();
    }

    let mint = create_mint(&mut svm, &payer, &payer.pubkey());
    let (vault, _) =
        Pubkey::find_program_address(&[VAULT_SEED, cold.pubkey().as_ref()], &PROGRAM_ID);
    let vault_usdc = create_ata(&mut svm, &payer, &vault, &mint);
    mint_to(&mut svm, &payer, &mint, &vault_usdc, &payer, 1_000 * D);
    let gacha_owner = Keypair::new().pubkey();
    let gacha_usdc = create_ata(&mut svm, &payer, &gacha_owner, &mint);
    let fee_owner = Keypair::new();
    let fee_usdc = create_ata(&mut svm, &payer, &fee_owner.pubkey(), &mint);

    let (config, _) = Pubkey::find_program_address(&[CONFIG_SEED], &PROGRAM_ID);
    let mut w = World {
        svm,
        admin,
        cold,
        hot,
        payer,
        mint,
        vault,
        vault_usdc,
        config,
        gacha_usdc,
        fee_usdc,
    };
    // Config written directly (initialize_config's upgrade-authority gate needs
    // ProgramData, which litesvm's add_program does not create).
    let image = config_image(&w, min_fee_bps, max_fee_bps);
    write_config(&mut w, image);

    let ix = Instruction {
        program_id: PROGRAM_ID,
        accounts: accounts::InitVault {
            vault: w.vault,
            owner: w.cold.pubkey(),
            payer: w.payer.pubkey(),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: instruction::InitVault {
            session_key: w.hot.pubkey(),
            per_spin_cap,
            daily_cap,
        }
        .data(),
    };
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&w.payer.pubkey()),
        &[&w.payer, &w.cold],
        w.svm.latest_blockhash(),
    );
    w.svm.send_transaction(tx).expect("init_vault");
    w
}

/// Full 174-byte serialization of a Config for this world (discriminator
/// included). The corridor is NOT validated here on purpose: tests use this
/// to plant images `update_config` would refuse.
fn config_image(w: &World, min_fee_bps: u16, max_fee_bps: u16) -> Vec<u8> {
    let (_, bump) = Pubkey::find_program_address(&[CONFIG_SEED], &PROGRAM_ID);
    let cfg = Config {
        admin: w.admin.pubkey(),
        usdc_mint: w.mint,
        gacha_usdc_account: w.gacha_usdc,
        fee_usdc_account: w.fee_usdc,
        min_fee_bps,
        paused: false,
        _reserved: [0; 32],
        bump,
        max_fee_bps,
    };
    let mut data = Vec::new();
    cfg.try_serialize(&mut data).unwrap();
    data
}

/// Plants a test Config image at its PDA, funded for its full allocation.
fn write_config(w: &mut World, data: Vec<u8>) {
    let lamports = w.svm.minimum_balance_for_rent_exemption(data.len());
    w.svm
        .set_account(
            w.config,
            Account {
                lamports,
                data,
                owner: PROGRAM_ID,
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
}

fn read_config(w: &World) -> Config {
    let acc = w.svm.get_account(&w.config).expect("config exists");
    Config::try_deserialize(&mut acc.data.as_slice()).expect("config deserializes")
}

fn read_vault(w: &World) -> Vault {
    let acc = w.svm.get_account(&w.vault).expect("vault exists");
    Vault::try_deserialize(&mut acc.data.as_slice()).expect("vault deserializes")
}

fn send(w: &mut World, ix: Instruction, signers: &[&Keypair]) -> Result<Vec<String>, String> {
    // Every helper expires the blockhash so byte-identical retries (same
    // memo, same args) are not swallowed by the dedup cache.
    w.svm.expire_blockhash();
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&signers[0].pubkey()),
        signers,
        w.svm.latest_blockhash(),
    );
    w.svm
        .send_transaction(tx)
        .map(|m| m.logs)
        .map_err(|f| f.meta.logs.join("\n"))
}

fn purchase_pack_metas(w: &World) -> Vec<AccountMeta> {
    accounts::PurchasePack {
        config: w.config,
        vault: w.vault,
        session_key: w.hot.pubkey(),
        usdc_mint: w.mint,
        vault_usdc: w.vault_usdc,
        gacha_usdc: w.gacha_usdc,
        fee_usdc: w.fee_usdc,
        token_program: TOKEN_PROGRAM_ID,
    }
    .to_account_metas(None)
}

/// `purchase_pack` signed by the session key, with an explicit `fee_amount`.
fn spin(w: &mut World, amount: u64, fee_amount: u64, tag: &str) -> Result<Vec<String>, String> {
    let ix = Instruction {
        program_id: PROGRAM_ID,
        accounts: purchase_pack_metas(w),
        data: instruction::PurchasePack {
            amount,
            fee_amount,
            memo: format!("fee-test-{tag}:open"),
        }
        .data(),
    };
    let hot = w.hot.insecure_clone();
    send(w, ix, &[&hot])
}

/// `update_config` touching only the corridor, signed by `signer`.
fn update_fees(
    w: &mut World,
    signer: &Keypair,
    min_fee_bps: Option<u16>,
    max_fee_bps: Option<u16>,
) -> Result<Vec<String>, String> {
    let ix = Instruction {
        program_id: PROGRAM_ID,
        accounts: accounts::UpdateConfig {
            config: w.config,
            admin: signer.pubkey(),
        }
        .to_account_metas(None),
        data: instruction::UpdateConfig {
            new_admin: None,
            gacha_usdc_account: None,
            fee_usdc_account: None,
            min_fee_bps,
            max_fee_bps,
            paused: None,
        }
        .data(),
    };
    send(w, ix, &[signer])
}

/// What Tangem's backend computes for a machine rate: floor(amount * bps / 1e4).
fn floor_fee(amount: u64, bps: u16) -> u64 {
    (amount as u128 * bps as u128 / 10_000) as u64
}

// ---------------------------------------------------------------------------
// 1. Layout & wire pins
// ---------------------------------------------------------------------------

/// Raw state readers depend on this Day 1 schema, independently of Rust names.
#[test]
fn day1_account_layouts_are_pinned() {
    assert_eq!(
        PROGRAM_ID,
        pubkey!("FKWs2cd5E9Fi8t2Gqbq6SkgekL4MJwZgkRMrGFcPGVvt")
    );
    assert_eq!(8 + Config::INIT_SPACE, 174);
    assert_eq!(8 + Vault::INIT_SPACE, 137);
    assert_eq!(MAX_FEE_BPS, 1_000);
    let config = Config {
        admin: Pubkey::new_unique(),
        usdc_mint: Pubkey::new_unique(),
        gacha_usdc_account: Pubkey::new_unique(),
        fee_usdc_account: Pubkey::new_unique(),
        min_fee_bps: 0x1234,
        max_fee_bps: 0x5678,
        paused: true,
        bump: 0xAB,
        _reserved: [0xCD; 32],
    };
    let mut data = Vec::new();
    config.try_serialize(&mut data).unwrap();
    assert_eq!(data.len(), 174);
    assert_eq!(&data[..8], &[155, 12, 170, 224, 30, 250, 204, 130]);
    for (offset, key) in [
        (8, config.admin),
        (40, config.usdc_mint),
        (72, config.gacha_usdc_account),
        (104, config.fee_usdc_account),
    ] {
        assert_eq!(&data[offset..offset + 32], key.as_ref());
    }
    assert_eq!(&data[136..138], &0x1234u16.to_le_bytes());
    assert_eq!(&data[138..140], &0x5678u16.to_le_bytes());
    assert_eq!(&data[140..142], &[1, 0xAB]);
    assert_eq!(&data[142..174], &[0xCD; 32]);

    let vault = Vault {
        owner: Pubkey::new_unique(),
        session_key: Pubkey::new_unique(),
        per_spin_cap: 11,
        daily_cap: 22,
        spent_today: 7,
        day_index: -3,
        bump: 0xEF,
        _reserved: [0x98; 32],
    };
    data.clear();
    vault.try_serialize(&mut data).unwrap();
    assert_eq!(data.len(), 137);
    assert_eq!(&data[..8], &[211, 8, 232, 43, 2, 152, 117, 119]);
    assert_eq!(&data[8..40], vault.owner.as_ref());
    assert_eq!(&data[40..72], vault.session_key.as_ref());
    for (offset, value) in [(72, 11u64), (80, 22), (88, 7)] {
        assert_eq!(&data[offset..offset + 8], &value.to_le_bytes());
    }
    assert_eq!(&data[96..104], &(-3i64).to_le_bytes());
    assert_eq!(data[104], 0xEF);
    assert_eq!(&data[105..137], &[0x98; 32]);
}

/// Discriminators the backend and CC's indexer hardcode, per the release spec.
#[test]
fn wire_discriminators_are_pinned() {
    assert_eq!(
        instruction::PurchasePack::DISCRIMINATOR,
        &[43, 116, 135, 75, 251, 67, 81, 26],
        "purchase_pack"
    );
    assert_eq!(
        PackOpened::DISCRIMINATOR,
        &[107, 111, 64, 235, 140, 166, 46, 201],
        "PackOpened must keep its discriminator (CC parses it)"
    );
    assert_eq!(
        ConfigUpdated::DISCRIMINATOR,
        &[40, 241, 230, 122, 11, 19, 198, 194],
        "ConfigUpdated"
    );
    assert_ne!(
        instruction::PurchasePack::DISCRIMINATOR,
        &OLD_OPEN_PACK_DISCRIMINATOR,
        "purchase_pack is a new instruction, not open_pack under another name"
    );
}

/// The old `open_pack` selector is gone: a client still sending it must get
/// Anchor's InstructionFallbackNotFound (101), not a silent spin.
#[test]
fn old_open_pack_discriminator_is_rejected() {
    let mut w = setup();
    let mut data = OLD_OPEN_PACK_DISCRIMINATOR.to_vec();
    data.extend_from_slice(&10_000u64.to_le_bytes());
    let memo = b"fee-test-legacy:open";
    data.extend_from_slice(&(memo.len() as u32).to_le_bytes());
    data.extend_from_slice(memo);
    let ix = Instruction {
        program_id: PROGRAM_ID,
        accounts: purchase_pack_metas(&w),
        data,
    };
    let hot = w.hot.insecure_clone();
    let err = send(&mut w, ix, &[&hot]).expect_err("open_pack no longer exists");
    assert!(err.contains("InstructionFallbackNotFound"), "got:\n{err}");
    assert_eq!(token_amount(&w.svm, &w.gacha_usdc), 0, "nothing moved");
}

// ---------------------------------------------------------------------------
// 2. Corridor boundaries
// ---------------------------------------------------------------------------

/// Round amount (10_000 units): the corridor is [100, 500] exactly.
#[test]
fn corridor_boundaries_on_round_amount() {
    let mut w = setup();
    let amount = 10_000;
    let min = floor_fee(amount, MIN_BPS);
    let max = floor_fee(amount, MAX_BPS);
    assert_eq!((min, max), (100, 500));

    let logs = spin(&mut w, amount, min, "min").expect("fee == floor(amount*min/1e4) passes");
    let ev: common::PackOpenedWire = common::decode_event(&logs).expect("PackOpened emitted");
    assert_eq!(ev.vault, w.vault);
    assert_eq!(ev.owner, w.cold.pubkey());
    assert_eq!(ev.amount, amount);
    assert_eq!(ev.fee, min, "event fee is the backend-supplied fee_amount");
    assert_eq!(ev.memo, "fee-test-min:open");

    let err = spin(&mut w, amount, min - 1, "min-1").expect_err("one unit below the floor");
    assert!(err.contains("FeeBelowMinimum"), "got:\n{err}");

    spin(&mut w, amount, max, "max").expect("fee == amount*max/1e4 passes");

    let err = spin(&mut w, amount, max + 1, "max+1").expect_err("one unit above the ceiling");
    assert!(err.contains("FeeAboveMaximum"), "got:\n{err}");

    // Both legs actually moved what the accepted spins said.
    assert_eq!(token_amount(&w.svm, &w.gacha_usdc), 2 * amount);
    assert_eq!(token_amount(&w.svm, &w.fee_usdc), min + max);
}

/// amount = 99 with min 1%: floor(0.99) = 0, so a zero fee is inside the
/// corridor; the ceiling is exact (99 * 500 = 49_500 < 5 * 10_000), so 4 passes
/// and 5 does not — a division-based ceiling would be off by one here.
#[test]
fn corridor_floor_semantics_on_tiny_amount() {
    let mut w = setup();
    let amount = 99;
    assert_eq!(floor_fee(amount, MIN_BPS), 0);

    spin(&mut w, amount, 0, "zero-fee").expect("required minimum is floor(0.99) = 0");
    assert_eq!(token_amount(&w.svm, &w.fee_usdc), 0, "no fee leg ran");

    spin(&mut w, amount, 4, "max-4").expect("4 * 10_000 = 40_000 <= 99 * 500");
    let err = spin(&mut w, amount, 5, "max-5").expect_err("5 * 10_000 = 50_000 > 49_500");
    assert!(err.contains("FeeAboveMaximum"), "got:\n{err}");
}

/// Non-round amount where both bounds have a fractional remainder:
/// 1_999 -> floor 19.99 = 19 on the min side, 99.95 -> 99 on the max side.
#[test]
fn corridor_boundaries_on_fractional_amount() {
    let mut w = setup();
    let amount = 1_999;
    assert_eq!(floor_fee(amount, MIN_BPS), 19);

    let err = spin(&mut w, amount, 18, "below").expect_err("18 < floor(19.99)");
    assert!(err.contains("FeeBelowMinimum"), "got:\n{err}");
    spin(&mut w, amount, 19, "floor").expect("floor(19.99) = 19 passes");
    spin(&mut w, amount, 99, "ceil").expect("99 * 10_000 = 990_000 <= 1_999 * 500 = 999_500");
    let err = spin(&mut w, amount, 100, "above").expect_err("1_000_000 > 999_500");
    assert!(err.contains("FeeAboveMaximum"), "got:\n{err}");
}

/// A machine rate anywhere inside the corridor, floored the way the backend
/// does it, must always be accepted.
#[test]
fn any_floored_rate_inside_corridor_passes() {
    let mut w = setup();
    for (i, (amount, bps)) in [
        (7_777u64, 100u16),
        (7_777, 250),
        (7_777, 333),
        (7_777, 500),
        (3, 100),
        (3, 500),
    ]
    .into_iter()
    .enumerate()
    {
        let fee = floor_fee(amount, bps);
        spin(&mut w, amount, fee, &format!("rate-{i}"))
            .unwrap_or_else(|e| panic!("amount {amount} at {bps} bps (fee {fee}) refused:\n{e}"));
    }
}

// ---------------------------------------------------------------------------
// 3. Hard backstop
// ---------------------------------------------------------------------------

/// A Config image with max_fee_bps = 5000 (50%) cannot exist through
/// update_config, but a planted one must still not authorize more than the
/// hard MAX_FEE_BPS (10%).
#[test]
fn hard_backstop_ignores_planted_config_ceiling() {
    let mut w = setup();
    let image = config_image(&w, 0, 5_000);
    write_config(&mut w, image);
    assert_eq!(read_config(&w).max_fee_bps, 5_000, "planted image is live");

    let amount = 10_000;
    let err = spin(&mut w, amount, 2_000, "20pct").expect_err("20% fee must be refused");
    assert!(err.contains("FeeAboveMaximum"), "got:\n{err}");
    let err = spin(&mut w, amount, 1_001, "10pct+1").expect_err("one unit above 10%");
    assert!(err.contains("FeeAboveMaximum"), "got:\n{err}");
    // Exactly 10% is the ceiling itself, and the planted config allows it.
    spin(&mut w, amount, 1_000, "10pct").expect("exactly MAX_FEE_BPS passes");
    assert_eq!(token_amount(&w.svm, &w.fee_usdc), 1_000);
}

// ---------------------------------------------------------------------------
// 5. update_config corridor validation
// ---------------------------------------------------------------------------

#[test]
fn update_config_validates_corridor() {
    let mut w = setup();
    let admin = w.admin.insecure_clone();

    let err = update_fees(&mut w, &admin, None, Some(MIN_BPS - 1)).expect_err("max < min");
    assert!(err.contains("InvalidFeeBps"), "got:\n{err}");

    let err = update_fees(&mut w, &admin, None, Some(MAX_FEE_BPS + 1)).expect_err("max > 1000");
    assert!(err.contains("InvalidFeeBps"), "got:\n{err}");

    let err = update_fees(&mut w, &admin, Some(MAX_BPS + 1), None).expect_err("min > max");
    assert!(err.contains("InvalidFeeBps"), "got:\n{err}");

    // An inverted pair is refused even when both halves are written together...
    let err = update_fees(&mut w, &admin, Some(600), Some(400)).expect_err("min 600 > max 400");
    assert!(err.contains("InvalidFeeBps"), "got:\n{err}");
    let cfg = read_config(&w);
    assert_eq!(
        (cfg.min_fee_bps, cfg.max_fee_bps),
        (MIN_BPS, MAX_BPS),
        "failed updates leave it alone"
    );

    // ...while a pair is validated as a whole: (600, 900) passes although
    // min 600 alone would exceed the previous max 500.
    update_fees(&mut w, &admin, Some(600), Some(900)).expect("valid as a pair");
    let cfg = read_config(&w);
    assert_eq!((cfg.min_fee_bps, cfg.max_fee_bps), (600, 900));

    let logs = update_fees(&mut w, &admin, Some(200), Some(800)).expect("valid corridor");
    let ev: ConfigUpdated = common::decode_event(&logs).expect("ConfigUpdated emitted");
    assert_eq!(ev.admin, admin.pubkey());
    assert_eq!(ev.gacha_usdc_account, w.gacha_usdc);
    assert_eq!(ev.fee_usdc_account, w.fee_usdc);
    assert_eq!((ev.min_fee_bps, ev.max_fee_bps), (200, 800));
    assert!(!ev.paused);
    let cfg = read_config(&w);
    assert_eq!((cfg.min_fee_bps, cfg.max_fee_bps), (200, 800));

    // Spins follow the new corridor immediately.
    let err = spin(&mut w, 10_000, 100, "old-min").expect_err("1% is below the new 2% floor");
    assert!(err.contains("FeeBelowMinimum"), "got:\n{err}");
    spin(&mut w, 10_000, 800, "new-max").expect("8% is the new ceiling");

    // Exactly the hard cap is allowed as a ceiling.
    update_fees(&mut w, &admin, None, Some(MAX_FEE_BPS)).expect("max == MAX_FEE_BPS");
    assert_eq!(read_config(&w).max_fee_bps, MAX_FEE_BPS);
}

/// `update_config` is `has_one = admin`: a stranger cannot widen the corridor.
#[test]
fn update_config_requires_admin() {
    let mut w = setup();
    let stranger = Keypair::new();
    w.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
    let err = update_fees(&mut w, &stranger, Some(0), Some(MAX_FEE_BPS)).expect_err("non-admin");
    assert!(err.contains("ConstraintHasOne"), "got:\n{err}");
    let cfg = read_config(&w);
    assert_eq!((cfg.min_fee_bps, cfg.max_fee_bps), (MIN_BPS, MAX_BPS));
}

// ---------------------------------------------------------------------------
// 6. Caps include the fee
// ---------------------------------------------------------------------------

/// The caps bound what leaves the vault, i.e. amount + fee_amount: a spin whose
/// amount alone fits per_spin_cap is refused once the fee pushes it over.
#[test]
fn caps_are_charged_with_amount_plus_fee() {
    let cap = 10_000;
    let mut w = setup_with(MIN_BPS, MAX_BPS, cap, 2 * cap);

    let err = spin(&mut w, cap, 100, "over").expect_err("10_000 + 100 > per_spin_cap");
    assert!(err.contains("ExceedsPerSpinCap"), "got:\n{err}");
    assert_eq!(read_vault(&w).spent_today, 0, "nothing charged on failure");

    // amount + fee == cap fits exactly, and the whole total is booked.
    let amount = 9_900;
    let fee = 100; // 1.01% of 9_900, inside [1%, 5%]
    spin(&mut w, amount, fee, "fit").expect("9_900 + 100 == per_spin_cap");
    assert_eq!(
        read_vault(&w).spent_today,
        amount + fee,
        "spent_today books amount + fee"
    );
    assert_eq!(
        token_amount(&w.svm, &w.vault_usdc),
        1_000 * D - amount - fee
    );

    // Daily budget is 2 * cap; the fee counts there too.
    spin(&mut w, amount, fee, "fit-2").expect("second full spin fills the day exactly");
    assert_eq!(read_vault(&w).spent_today, 2 * cap);
    let err = spin(&mut w, 1, 0, "day-over").expect_err("day is spent");
    assert!(err.contains("ExceedsDailyCap"), "got:\n{err}");
}

/// Old clients must fail at dispatch, not accidentally call a different method.
#[test]
fn all_removed_custody_and_migration_selectors_are_rejected() {
    let mut w = setup();
    let sponsor = w.payer.insecure_clone();
    let removed: [(&str, [u8; 8]); 9] = [
        ("approve_buyback", [79, 220, 204, 199, 181, 27, 86, 204]),
        ("revoke_buyback", [214, 118, 102, 101, 177, 127, 242, 141]),
        ("clear_buyback_slot", [255, 87, 21, 11, 164, 182, 47, 20]),
        ("buyback_pnft", [229, 155, 236, 186, 92, 43, 99, 54]),
        ("buyback_core", [1, 108, 17, 204, 52, 40, 164, 144]),
        ("withdraw_pnft", [208, 1, 50, 181, 217, 48, 202, 162]),
        ("withdraw_core", [49, 97, 48, 114, 218, 116, 73, 96]),
        ("sweep_prize_ata", [68, 115, 36, 117, 204, 209, 252, 144]),
        ("migrate_config", [92, 131, 58, 105, 210, 154, 224, 193]),
    ];
    let vault_before = w.svm.get_account(&w.vault).unwrap().data;
    let config_before = w.svm.get_account(&w.config).unwrap().data;
    let funds_before = token_amount(&w.svm, &w.vault_usdc);
    for (name, discriminator) in removed {
        let ix = Instruction {
            program_id: PROGRAM_ID,
            accounts: vec![],
            data: discriminator.to_vec(),
        };
        let err = send(&mut w, ix, &[&sponsor]).expect_err(name);
        assert!(err.contains("InstructionFallbackNotFound"), "{name}: {err}");
        assert!(err.contains("101"), "{name}: {err}");
    }
    assert_eq!(w.svm.get_account(&w.vault).unwrap().data, vault_before);
    assert_eq!(w.svm.get_account(&w.config).unwrap().data, config_before);
    assert_eq!(token_amount(&w.svm, &w.vault_usdc), funds_before);
}

/// Applications already handle these numeric errors; removed codes stay holes.
#[test]
fn surviving_error_numbers_keep_their_published_values() {
    let errors = [
        (VaultError::Paused, 6000),
        (VaultError::ZeroAmount, 6001),
        (VaultError::InvalidMemo, 6002),
        (VaultError::InvalidFeeBps, 6003),
        (VaultError::InvalidCaps, 6004),
        (VaultError::ExceedsPerSpinCap, 6005),
        (VaultError::ExceedsDailyCap, 6006),
        (VaultError::MathOverflow, 6007),
        (VaultError::TokenAccountNotEmpty, 6015),
        (VaultError::DelegateStillSet, 6016),
        (VaultError::InsufficientSol, 6017),
        (VaultError::Unauthorized, 6018),
        (VaultError::UnsupportedMint, 6021),
        (VaultError::FeeBelowMinimum, 6022),
        (VaultError::FeeAboveMaximum, 6023),
    ];
    for (error, expected) in errors {
        assert_eq!(u32::from(error), expected);
    }
}

/// If the second transfer cannot pay the fee, neither the principal nor the
/// spending counter may remain committed.
#[test]
fn insufficient_balance_for_fee_rolls_back_principal_and_spending() {
    let mut w = setup();
    let amount = 10_000u64;
    let mut source = w.svm.get_account(&w.vault_usdc).unwrap();
    source.data[64..72].copy_from_slice(&amount.to_le_bytes());
    w.svm.set_account(w.vault_usdc, source).unwrap();
    let spent_before = read_vault(&w).spent_today;
    spin(&mut w, amount, 100, "fee-underfunded").expect_err("principal fits, fee does not");
    assert_eq!(token_amount(&w.svm, &w.vault_usdc), amount);
    assert_eq!(token_amount(&w.svm, &w.gacha_usdc), 0);
    assert_eq!(token_amount(&w.svm, &w.fee_usdc), 0);
    assert_eq!(read_vault(&w).spent_today, spent_before);
}
