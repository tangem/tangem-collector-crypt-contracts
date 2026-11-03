//! Spending-cap and input-guard tests for purchase_pack / withdraw_token on real
//! bytecode (LiteSVM), incl. the UTC-day rollover exercised by warping the
//! Clock sysvar — the only place the roll_day path runs (no other test
//! advances the calendar).
//!
//! Run `anchor build` first so target/deploy/tangem_gacha_vault.so exists.

mod common;

use anchor_lang::{AccountDeserialize, AccountSerialize, InstructionData, ToAccountMetas};
use litesvm::LiteSVM;
use solana_sdk::{
    account::Account,
    clock::Clock,
    instruction::{AccountMeta, Instruction},
    pubkey,
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    system_instruction, system_program,
    transaction::Transaction,
};
use tangem_gacha_vault::{accounts, instruction, Config, Vault, CONFIG_SEED, VAULT_SEED};

const PROGRAM_ID: Pubkey = tangem_gacha_vault::ID;
const TOKEN_PROGRAM_ID: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM_ID: Pubkey = pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const SECONDS_PER_DAY: i64 = 86_400;
const D: u64 = 300_000_000; // per_spin_cap == daily_cap (min_fee_bps = 0 and fee_amount = 0)

fn ata(owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[owner.as_ref(), TOKEN_PROGRAM_ID.as_ref(), mint.as_ref()],
        &ATA_PROGRAM_ID,
    )
    .0
}

fn set_day(svm: &mut LiteSVM, unix: i64) {
    let mut clock = svm.get_sysvar::<Clock>();
    clock.unix_timestamp = unix;
    svm.set_sysvar::<Clock>(&clock);
}

fn day_start(day: i64) -> i64 {
    day * SECONDS_PER_DAY + 10
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

struct World {
    svm: LiteSVM,
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

fn setup() -> World {
    let mut svm = LiteSVM::new();
    svm.add_program_from_file(PROGRAM_ID, common::program_so_path())
        .expect("run `anchor build` first");

    let payer = Keypair::new();
    let cold = Keypair::new();
    let hot = Keypair::new();
    // Owner and session key have no SOL: a separate sponsor funds all fees.
    svm.airdrop(&payer.pubkey(), 10_000_000_000).unwrap();
    set_day(&mut svm, day_start(100));

    let mint = create_mint(&mut svm, &payer, &payer.pubkey());
    let (vault, _) =
        Pubkey::find_program_address(&[VAULT_SEED, cold.pubkey().as_ref()], &PROGRAM_ID);
    let vault_usdc = create_ata(&mut svm, &payer, &vault, &mint);
    mint_to(&mut svm, &payer, &mint, &vault_usdc, &payer, 100 * D);
    let gacha_owner = Keypair::new();
    let gacha_usdc = create_ata(&mut svm, &payer, &gacha_owner.pubkey(), &mint);
    let fee_owner = Keypair::new();
    let fee_usdc = create_ata(&mut svm, &payer, &fee_owner.pubkey(), &mint);

    // Config written directly (initialize_config's upgrade-authority gate needs
    // ProgramData, which litesvm's add_program does not create); min_fee_bps = 0 and fee_amount = 0.
    let (config, bump) = Pubkey::find_program_address(&[CONFIG_SEED], &PROGRAM_ID);
    let cfg = Config {
        admin: Pubkey::new_unique(),
        usdc_mint: mint,
        gacha_usdc_account: gacha_usdc,
        fee_usdc_account: fee_usdc,
        min_fee_bps: 0,
        max_fee_bps: 1_000,
        paused: false,
        _reserved: [0; 32],
        bump,
    };
    let mut data = Vec::new();
    cfg.try_serialize(&mut data).unwrap();
    let lamports = svm.minimum_balance_for_rent_exemption(data.len());
    svm.set_account(
        config,
        Account {
            lamports,
            data,
            owner: PROGRAM_ID,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();

    let ix = Instruction {
        program_id: PROGRAM_ID,
        accounts: accounts::InitVault {
            vault,
            owner: cold.pubkey(),
            payer: payer.pubkey(),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: instruction::InitVault {
            session_key: hot.pubkey(),
            per_spin_cap: D,
            daily_cap: D,
        }
        .data(),
    };
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&payer.pubkey()),
        &[&payer, &cold],
        svm.latest_blockhash(),
    );
    svm.send_transaction(tx).expect("init_vault");

    World {
        svm,
        cold,
        hot,
        payer,
        mint,
        vault,
        vault_usdc,
        config,
        gacha_usdc,
        fee_usdc,
    }
}

/// Rewrites the config PDA in place — the direct-write analogue of an admin
/// `update_config`, for pointing treasuries at arbitrary accounts.
fn set_config(w: &mut World, gacha_usdc_account: Pubkey, fee_usdc_account: Pubkey) {
    let (config, bump) = Pubkey::find_program_address(&[CONFIG_SEED], &PROGRAM_ID);
    let cfg = Config {
        admin: Pubkey::new_unique(),
        usdc_mint: w.mint,
        gacha_usdc_account,
        fee_usdc_account,
        min_fee_bps: 0,
        max_fee_bps: 1_000,
        paused: false,
        _reserved: [0; 32],
        bump,
    };
    let mut data = Vec::new();
    cfg.try_serialize(&mut data).unwrap();
    let lamports = w.svm.minimum_balance_for_rent_exemption(data.len());
    w.svm
        .set_account(
            config,
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

fn send_spin(w: &mut World, amount: u64, tag: u8) -> Result<(), String> {
    // unique memo per call so identical spins do not collide on the
    // blockhash-based dedup
    send_spin_memo(w, amount, format!("dev-test-{tag}:open"))
}

fn send_spin_memo(w: &mut World, amount: u64, memo: String) -> Result<(), String> {
    let ix = Instruction {
        program_id: PROGRAM_ID,
        accounts: accounts::PurchasePack {
            config: w.config,
            vault: w.vault,
            session_key: w.hot.pubkey(),
            usdc_mint: w.mint,
            vault_usdc: w.vault_usdc,
            gacha_usdc: w.gacha_usdc,
            fee_usdc: w.fee_usdc,
            token_program: TOKEN_PROGRAM_ID,
        }
        .to_account_metas(None),
        data: instruction::PurchasePack {
            amount,
            fee_amount: 0,
            memo,
        }
        .data(),
    };
    w.svm.expire_blockhash();
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&w.payer.pubkey()),
        &[&w.payer, &w.hot],
        w.svm.latest_blockhash(),
    );
    w.svm
        .send_transaction(tx)
        .map(|_| ())
        .map_err(|f| f.meta.logs.join("\n"))
}

/// Two full-cap spins on the same UTC day: the second must be refused.
#[test]
fn same_day_second_full_spin_blocked() {
    let mut w = setup();
    send_spin(&mut w, D, 1).expect("first spin fits the fresh day");
    let err = send_spin(&mut w, D, 2).expect_err("second same-day spin must exceed the cap");
    assert!(err.contains("ExceedsDailyCap"), "got:\n{err}");
}

/// After UTC midnight the budget resets and a full-cap spin fits again.
#[test]
fn day_rollover_resets_the_budget() {
    let mut w = setup();
    send_spin(&mut w, D, 1).expect("day-0 spin");
    let err = send_spin(&mut w, D, 2).expect_err("same-day repeat blocked");
    assert!(err.contains("ExceedsDailyCap"), "got:\n{err}");

    set_day(&mut w.svm, day_start(101));
    send_spin(&mut w, D, 3).expect("fresh UTC day allows a full spin again");
}

/// per_spin_cap binds independently of the daily budget.
#[test]
fn per_spin_cap_enforced() {
    let mut w = setup();
    let err = send_spin(&mut w, D + 1, 1).expect_err("above per-spin cap");
    assert!(err.contains("ExceedsPerSpinCap"), "got:\n{err}");
}

/// The memo is CC's reconciliation key: an empty or over-long one is refused
/// before any USDC moves.
#[test]
fn memo_bounds_enforced() {
    let mut w = setup();
    let err = send_spin_memo(&mut w, D, String::new()).expect_err("empty memo must fail");
    assert!(err.contains("InvalidMemo"), "got:\n{err}");

    let err = send_spin_memo(&mut w, D, "x".repeat(257)).expect_err("over-long memo must fail");
    assert!(err.contains("InvalidMemo"), "got:\n{err}");

    // 256 is the boundary and must still pass.
    send_spin_memo(&mut w, D, "x".repeat(256)).expect("256-byte memo is the limit, not past it");
}

/// A zero-amount spin is refused (it would burn a memo for nothing).
#[test]
fn zero_amount_spin_rejected() {
    let mut w = setup();
    let err = send_spin(&mut w, 0, 1).expect_err("zero amount must fail");
    assert!(err.contains("ZeroAmount"), "got:\n{err}");
}

/// A wrong-mint treasury in the config must fail the FIRST spin loudly — even
/// at min_fee_bps = 0 and fee_amount = 0, when no fee transfer would touch the account. Without the
/// `token::mint` pin this misconfiguration passes silently until the fee is
/// raised, then breaks every spin of every vault at once.
#[test]
fn wrong_mint_fee_treasury_fails_first_spin_even_at_zero_fee() {
    let mut w = setup();

    let payer = w.payer.insecure_clone();
    let wrong_mint = create_mint(&mut w.svm, &payer, &payer.pubkey());
    let wrong_owner = Keypair::new();
    let wrong_fee = create_ata(&mut w.svm, &payer, &wrong_owner.pubkey(), &wrong_mint);

    let (gacha_usdc, real_fee) = (w.gacha_usdc, w.fee_usdc);
    set_config(&mut w, gacha_usdc, wrong_fee);
    w.fee_usdc = wrong_fee; // pass the account the config now names
    let err = send_spin(&mut w, D, 1).expect_err("wrong-mint fee treasury must fail the spin");
    assert!(err.contains("ConstraintTokenMint"), "got:\n{err}");

    // Positive control: restoring the correct account makes the same spin pass,
    // so the failure above is the mint pin and nothing else.
    set_config(&mut w, gacha_usdc, real_fee);
    w.fee_usdc = real_fee;
    send_spin(&mut w, D, 2).expect("correct fee treasury spins fine");
}

/// Same trap on the spin-payment leg: a wrong-mint `gacha_usdc_account` must
/// be a constraint failure, not a token-program error inside the CPI.
#[test]
fn wrong_mint_gacha_treasury_fails_spin() {
    let mut w = setup();

    let payer = w.payer.insecure_clone();
    let wrong_mint = create_mint(&mut w.svm, &payer, &payer.pubkey());
    let wrong_owner = Keypair::new();
    let wrong_gacha = create_ata(&mut w.svm, &payer, &wrong_owner.pubkey(), &wrong_mint);

    let fee_usdc = w.fee_usdc;
    set_config(&mut w, wrong_gacha, fee_usdc);
    w.gacha_usdc = wrong_gacha; // pass the account the config now names
    let err = send_spin(&mut w, D, 1).expect_err("wrong-mint gacha treasury must fail the spin");
    assert!(err.contains("ConstraintTokenMint"), "got:\n{err}");
}

fn send_withdraw(w: &mut World, destination: Pubkey, amount: u64) -> Result<(), String> {
    let ix = Instruction {
        program_id: PROGRAM_ID,
        accounts: accounts::WithdrawToken {
            vault: w.vault,
            owner: w.cold.pubkey(),
            source: w.vault_usdc,
            mint: w.mint,
            destination,
            token_program: TOKEN_PROGRAM_ID,
        }
        .to_account_metas(None),
        data: instruction::WithdrawToken { amount }.data(),
    };
    w.svm.expire_blockhash();
    let cold = w.cold.insecure_clone();
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&w.payer.pubkey()),
        &[&w.payer, &cold],
        w.svm.latest_blockhash(),
    );
    w.svm
        .send_transaction(tx)
        .map(|_| ())
        .map_err(|f| f.meta.logs.join("\n"))
}

/// `withdraw_token` with the source as its own destination must be rejected:
/// spl-token's self-transfer returns Ok having moved nothing, and the
/// TokenWithdrawn event would falsely report the full amount.
#[test]
fn withdraw_token_rejects_source_as_destination() {
    let mut w = setup();
    let vault_usdc = w.vault_usdc;
    let err = send_withdraw(&mut w, vault_usdc, D).expect_err("self-transfer must fail");
    assert!(err.contains("Unauthorized"), "got:\n{err}");

    // Positive control: a real destination of the same mint receives the funds.
    let payer = w.payer.insecure_clone();
    let recipient = Keypair::new();
    let dest = create_ata(&mut w.svm, &payer, &recipient.pubkey(), &w.mint);
    send_withdraw(&mut w, dest, D).expect("withdraw to a distinct account succeeds");
    let acc = w.svm.get_account(&dest).unwrap();
    let amount = u64::from_le_bytes(acc.data[64..72].try_into().unwrap());
    assert_eq!(amount, D, "the full amount must actually arrive");
}

fn send_owner(w: &mut World, ix: Instruction) -> Result<Vec<String>, String> {
    w.svm.expire_blockhash();
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&w.payer.pubkey()),
        &[&w.payer, &w.cold],
        w.svm.latest_blockhash(),
    );
    w.svm
        .send_transaction(tx)
        .map(|m| m.logs)
        .map_err(|f| f.meta.logs.join("\n"))
}

#[test]
fn spin_fee_can_be_sponsored_without_owner_or_session_sol() {
    let mut w = setup();
    let sponsor_before = w.svm.get_balance(&w.payer.pubkey()).unwrap();
    send_spin(&mut w, D, 1).expect("session consent with a separate fee payer");
    assert_eq!(w.svm.get_balance(&w.hot.pubkey()).unwrap_or(0), 0);
    assert_eq!(w.svm.get_balance(&w.cold.pubkey()).unwrap_or(0), 0);
    assert!(w.svm.get_balance(&w.payer.pubkey()).unwrap() < sponsor_before);
    let treasury = w.svm.get_account(&w.gacha_usdc).unwrap();
    assert_eq!(
        u64::from_le_bytes(treasury.data[64..72].try_into().unwrap()),
        D
    );
}

/// Funding is an ordinary SPL transfer, with owner consent but no owner SOL.
#[test]
fn owner_can_fund_vault_with_separate_sponsor() {
    let mut w = setup();
    let payer = w.payer.insecure_clone();
    let sponsor_before = w.svm.get_balance(&payer.pubkey()).unwrap();
    let owner_usdc = create_ata(&mut w.svm, &payer, &w.cold.pubkey(), &w.mint);
    mint_to(&mut w.svm, &payer, &w.mint, &owner_usdc, &payer, D);
    let before = w.svm.get_account(&w.vault_usdc).unwrap();
    let before_amount = u64::from_le_bytes(before.data[64..72].try_into().unwrap());
    let mut data = vec![12]; // TransferChecked
    data.extend_from_slice(&D.to_le_bytes());
    data.push(6);
    let ix = Instruction {
        program_id: TOKEN_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(owner_usdc, false),
            AccountMeta::new_readonly(w.mint, false),
            AccountMeta::new(w.vault_usdc, false),
            AccountMeta::new_readonly(w.cold.pubkey(), true),
        ],
        data,
    };
    send_owner(&mut w, ix).expect("sponsor pays network fee; owner authorizes USDC");
    let after = w.svm.get_account(&w.vault_usdc).unwrap();
    assert_eq!(
        u64::from_le_bytes(after.data[64..72].try_into().unwrap()),
        before_amount + D
    );
    assert_eq!(w.svm.get_balance(&w.cold.pubkey()).unwrap_or(0), 0);
    assert_eq!(w.svm.get_balance(&w.hot.pubkey()).unwrap_or(0), 0);
    assert!(w.svm.get_balance(&payer.pubkey()).unwrap() < sponsor_before);
}

#[test]
fn session_key_cannot_withdraw_rotate_or_close() {
    let mut w = setup();
    let hot = w.hot.pubkey();
    let instructions = [
        Instruction {
            program_id: PROGRAM_ID,
            accounts: accounts::WithdrawToken {
                vault: w.vault,
                owner: hot,
                source: w.vault_usdc,
                mint: w.mint,
                destination: w.gacha_usdc,
                token_program: TOKEN_PROGRAM_ID,
            }
            .to_account_metas(None),
            data: instruction::WithdrawToken { amount: 1 }.data(),
        },
        Instruction {
            program_id: PROGRAM_ID,
            accounts: accounts::WithdrawSol {
                vault: w.vault,
                owner: hot,
                recipient: hot,
            }
            .to_account_metas(None),
            data: instruction::WithdrawSol { lamports: 1 }.data(),
        },
        Instruction {
            program_id: PROGRAM_ID,
            accounts: accounts::OwnerAuthority {
                vault: w.vault,
                owner: hot,
            }
            .to_account_metas(None),
            data: instruction::UpdateVault {
                session_key: Some(Pubkey::new_unique()),
                per_spin_cap: None,
                daily_cap: None,
            }
            .data(),
        },
        Instruction {
            program_id: PROGRAM_ID,
            accounts: accounts::CloseTokenAccountCtx {
                vault: w.vault,
                owner: hot,
                token: w.vault_usdc,
                token_program: TOKEN_PROGRAM_ID,
            }
            .to_account_metas(None),
            data: instruction::CloseTokenAccount {}.data(),
        },
        Instruction {
            program_id: PROGRAM_ID,
            accounts: accounts::CloseVault {
                vault: w.vault,
                owner: hot,
            }
            .to_account_metas(None),
            data: instruction::CloseVault {}.data(),
        },
    ];
    let vault_before = w.svm.get_account(&w.vault).unwrap();
    let funds_before = w.svm.get_account(&w.vault_usdc).unwrap();
    for ix in instructions {
        w.svm.expire_blockhash();
        let tx = Transaction::new_signed_with_payer(
            &[ix],
            Some(&w.payer.pubkey()),
            &[&w.payer, &w.hot],
            w.svm.latest_blockhash(),
        );
        let err = w
            .svm
            .send_transaction(tx)
            .expect_err("session key is not the owner");
        assert!(
            err.meta.logs.iter().any(|l| l.contains("ConstraintSeeds")),
            "{:?}",
            err.meta.logs
        );
    }
    assert_eq!(w.svm.get_account(&w.vault).unwrap().data, vault_before.data);
    assert_eq!(
        w.svm.get_account(&w.vault_usdc).unwrap().data,
        funds_before.data
    );
}

/// Pause stops spending, while the card can rotate and recover every balance.
#[test]
fn paused_vault_still_allows_sponsored_owner_recovery_and_offboarding() {
    let mut w = setup();
    let mut config_account = w.svm.get_account(&w.config).unwrap();
    let mut cfg = Config::try_deserialize(&mut config_account.data.as_slice()).unwrap();
    cfg.paused = true;
    config_account.data.clear();
    cfg.try_serialize(&mut config_account.data).unwrap();
    w.svm.set_account(w.config, config_account).unwrap();
    let err = send_spin(&mut w, 1, 1).expect_err("pause blocks spins");
    assert!(err.contains("Paused"), "{err}");

    let replacement = Pubkey::new_unique();
    let rotate = Instruction {
        program_id: PROGRAM_ID,
        accounts: accounts::OwnerAuthority {
            vault: w.vault,
            owner: w.cold.pubkey(),
        }
        .to_account_metas(None),
        data: instruction::UpdateVault {
            session_key: Some(replacement),
            per_spin_cap: Some(D / 2),
            daily_cap: None,
        }
        .data(),
    };
    send_owner(&mut w, rotate).expect("owner can rotate while paused");
    let account = w.svm.get_account(&w.vault).unwrap();
    let vault = Vault::try_deserialize(&mut account.data.as_slice()).unwrap();
    assert_eq!(vault.session_key, replacement);
    assert_eq!(vault.per_spin_cap, D / 2);

    let recipient = w.gacha_usdc;
    send_withdraw(&mut w, recipient, 100 * D).expect("owner recovers all USDC while paused");
    assert_eq!(
        w.svm.get_balance(&w.cold.pubkey()).unwrap_or(0),
        0,
        "withdraw paid no SOL from owner"
    );

    let mut vault_account = w.svm.get_account(&w.vault).unwrap();
    let rent = vault_account.lamports;
    vault_account.lamports += 1234;
    w.svm.set_account(w.vault, vault_account).unwrap();
    let withdraw_sol = Instruction {
        program_id: PROGRAM_ID,
        accounts: accounts::WithdrawSol {
            vault: w.vault,
            owner: w.cold.pubkey(),
            recipient: w.cold.pubkey(),
        }
        .to_account_metas(None),
        data: instruction::WithdrawSol { lamports: 1234 }.data(),
    };
    send_owner(&mut w, withdraw_sol).expect("owner recovers excess SOL while paused");
    assert_eq!(w.svm.get_balance(&w.vault).unwrap(), rent);
    assert_eq!(w.svm.get_balance(&w.cold.pubkey()).unwrap(), 1234);

    let ata_rent = w.svm.get_balance(&w.vault_usdc).unwrap();
    let close_token = Instruction {
        program_id: PROGRAM_ID,
        accounts: accounts::CloseTokenAccountCtx {
            vault: w.vault,
            owner: w.cold.pubkey(),
            token: w.vault_usdc,
            token_program: TOKEN_PROGRAM_ID,
        }
        .to_account_metas(None),
        data: instruction::CloseTokenAccount {}.data(),
    };
    send_owner(&mut w, close_token).expect("owner closes empty ATA while paused");
    assert!(w
        .svm
        .get_account(&w.vault_usdc)
        .is_none_or(|a| a.data.is_empty()));
    let close = Instruction {
        program_id: PROGRAM_ID,
        accounts: accounts::CloseVault {
            vault: w.vault,
            owner: w.cold.pubkey(),
        }
        .to_account_metas(None),
        data: instruction::CloseVault {}.data(),
    };
    send_owner(&mut w, close).expect("owner closes vault while paused");
    assert!(w
        .svm
        .get_account(&w.vault)
        .is_none_or(|a| a.data.is_empty()));
    assert_eq!(
        w.svm.get_balance(&w.cold.pubkey()).unwrap(),
        1234 + ata_rent + rent
    );
}

/// Keep the money-account GC guards previously exercised by the rent-sweep
/// suite, without loading any Metaplex programs or prize fixtures.
#[test]
fn close_token_account_rejects_nonempty_or_delegated_accounts() {
    let mut w = setup();
    let close = Instruction {
        program_id: PROGRAM_ID,
        accounts: accounts::CloseTokenAccountCtx {
            vault: w.vault,
            owner: w.cold.pubkey(),
            token: w.vault_usdc,
            token_program: TOKEN_PROGRAM_ID,
        }
        .to_account_metas(None),
        data: instruction::CloseTokenAccount {}.data(),
    };
    let err = send_owner(&mut w, close.clone()).expect_err("balance must be recovered first");
    assert!(err.contains("TokenAccountNotEmpty"), "{err}");

    // A valid empty SPL account can retain a delegate. Plant this legacy
    // token state directly: the Day 1 program never grants SPL delegation.
    let mut token = w.svm.get_account(&w.vault_usdc).unwrap();
    let rent = token.lamports;
    token.data[64..72].copy_from_slice(&0u64.to_le_bytes());
    token.data[72..76].copy_from_slice(&1u32.to_le_bytes());
    token.data[76..108].copy_from_slice(Pubkey::new_unique().as_ref());
    token.data[121..129].copy_from_slice(&0u64.to_le_bytes());
    w.svm.set_account(w.vault_usdc, token.clone()).unwrap();
    let err = send_owner(&mut w, close.clone()).expect_err("delegate must be revoked first");
    assert!(err.contains("DelegateStillSet"), "{err}");
    assert_eq!(w.svm.get_account(&w.vault_usdc).unwrap().data, token.data);

    token.data[72..76].copy_from_slice(&0u32.to_le_bytes());
    w.svm.set_account(w.vault_usdc, token).unwrap();
    send_owner(&mut w, close).expect("empty, delegate-free account closes");
    assert!(w
        .svm
        .get_account(&w.vault_usdc)
        .is_none_or(|a| a.data.is_empty()));
    assert_eq!(w.svm.get_balance(&w.cold.pubkey()).unwrap(), rent);
}
