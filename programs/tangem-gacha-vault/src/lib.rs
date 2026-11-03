use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    self, CloseAccount, Mint, TokenAccount, TokenInterface, TransferChecked,
};

// Fresh local/devnet identity for the Day-1 program. Mainnet uses a separate key.
declare_id!("FKWs2cd5E9Fi8t2Gqbq6SkgekL4MJwZgkRMrGFcPGVvt");

pub const CONFIG_SEED: &[u8] = b"config";
pub const VAULT_SEED: &[u8] = b"vault";
pub const MAX_MEMO_LEN: usize = 256;
pub const SECONDS_PER_DAY: i64 = 86_400;
/// Hard ceiling for the Tangem fee (10%), independent of the configured corridor.
pub const MAX_FEE_BPS: u16 = 1_000;

/// Per-user USDC spending vault for the Collector Crypt Day-1 integration.
///
/// The Tangem card key (owner) controls withdrawals, caps, session-key rotation
/// and closure. The phone's session key can only purchase packs, spending the
/// vault's canonical USDC ATA within fee-inclusive per-purchase and UTC-day caps.
/// A separate sponsor may pay transaction fees and vault/ATA creation rent.
/// Rent reclaimed at offboarding goes to the owner, not the original sponsor.
///
/// Prizes and turbo-sale proceeds go directly to the owner's wallet via CC's
/// altPlayerAddress / altFundsRecipient parameters. This program handles the
/// payment leg only: it neither receives prizes in the intended flow nor
/// implements dedicated NFT transfers, delegation or buyback. Ordinary owner-wallet
/// buybacks use CC's transaction and the owner's signature outside this program.
///
/// Trust boundaries:
/// - purchase_pack fixes the USDC destinations and enforces spending caps, but
///   it does not bind CC's memo to a prize recipient, pack or price. The backend
///   must issue memos for the intended owner and reconcile delivery. A stolen
///   session key can buy spins for an attacker's recipient through CC, so the
///   daily cap is a theft budget, not merely a limit on wasted spins.
/// - The caller supplies fee_amount inside an admin-set corridor. Only its floor
///   is compulsory against that signer; a machine's exact rate is enforced and
///   reconciled by the backend using PackOpened.fee.
/// - The admin can replace either treasury address in one update and thereby
///   redirect future principal or fees from every vault. A multisig admin and
///   monitoring ConfigUpdated are operational requirements. The hard fee cap
///   does not protect against changing a principal treasury address.
/// - The program's upgrade authority can replace these rules. Owner withdrawals
///   and vault management do not read Config and remain available while paused.
///
/// The client must include a top-level SPL Memo instruction matching the memo
/// argument. CC reconciles it with the treasury transfer, including inner CPIs;
/// the program records the memo in PackOpened but does not emit or validate the
/// separate Memo instruction. Submit through a compatible RPC.
#[program]
pub mod tangem_gacha_vault {
    use super::*;

    /// One-time global setup. Only the program's upgrade authority can call
    /// this (prevents config-admin front-running between deploy and init).
    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        gacha_usdc_account: Pubkey,
        fee_usdc_account: Pubkey,
        min_fee_bps: u16,
        max_fee_bps: u16,
    ) -> Result<()> {
        validate_fee_corridor(min_fee_bps, max_fee_bps)?;
        // `usdc_mint` is written here and NOWHERE else — `update_config` has no
        // parameter for it and the config PDA can neither be closed nor
        // re-initialized, so this choice is permanent for the life of the
        // program id. Narrow it to legacy SPL Token, the only standard the
        // suite exercises: a Token-2022 mint with a transfer-fee or
        // transfer-hook extension would silently short every `transfer_checked`
        // in this program (a spin that under-delivers to the treasury is a paid
        // spin CC never credits), and there would be no way to undo it.
        require_keys_eq!(
            *ctx.accounts.usdc_mint.to_account_info().owner,
            anchor_spl::token::ID,
            VaultError::UnsupportedMint
        );
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.usdc_mint = ctx.accounts.usdc_mint.key();
        config.gacha_usdc_account = gacha_usdc_account;
        config.fee_usdc_account = fee_usdc_account;
        config.min_fee_bps = min_fee_bps;
        config.max_fee_bps = max_fee_bps;
        config.paused = false;
        config._reserved = [0; 32];
        config.bump = ctx.bumps.config;
        Ok(())
    }

    /// Admin-only partial updates of the global config. Treasury changes take
    /// effect for every subsequent purchase; the mint remains immutable.
    pub fn update_config(
        ctx: Context<UpdateConfig>,
        new_admin: Option<Pubkey>,
        gacha_usdc_account: Option<Pubkey>,
        fee_usdc_account: Option<Pubkey>,
        min_fee_bps: Option<u16>,
        max_fee_bps: Option<u16>,
        paused: Option<bool>,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        if let Some(v) = new_admin {
            config.admin = v;
        }
        if let Some(v) = gacha_usdc_account {
            config.gacha_usdc_account = v;
        }
        if let Some(v) = fee_usdc_account {
            config.fee_usdc_account = v;
        }
        if let Some(v) = min_fee_bps {
            config.min_fee_bps = v;
        }
        if let Some(v) = max_fee_bps {
            config.max_fee_bps = v;
        }
        validate_fee_corridor(config.min_fee_bps, config.max_fee_bps)?;
        if let Some(v) = paused {
            config.paused = v;
        }
        emit!(ConfigUpdated {
            admin: config.admin,
            gacha_usdc_account: config.gacha_usdc_account,
            fee_usdc_account: config.fee_usdc_account,
            min_fee_bps: config.min_fee_bps,
            max_fee_bps: config.max_fee_bps,
            paused: config.paused,
        });
        Ok(())
    }

    /// Creates the per-user vault. The Tangem card signs as owner; any payer
    /// signer (phone or sponsor) may fund rent. session_key is a public-key
    /// argument and need not sign this instruction. The transaction fee payer
    /// is independent of these roles.
    pub fn init_vault(
        ctx: Context<InitVault>,
        session_key: Pubkey,
        per_spin_cap: u64,
        daily_cap: u64,
    ) -> Result<()> {
        require!(
            per_spin_cap > 0 && daily_cap >= per_spin_cap,
            VaultError::InvalidCaps
        );
        let vault = &mut ctx.accounts.vault;
        vault.owner = ctx.accounts.owner.key();
        vault.session_key = session_key;
        vault.per_spin_cap = per_spin_cap;
        vault.daily_cap = daily_cap;
        vault.spent_today = 0;
        vault.day_index = Clock::get()?.unix_timestamp.div_euclid(SECONDS_PER_DAY);
        vault._reserved = [0; 32];
        vault.bump = ctx.bumps.vault;
        emit!(VaultInitialized {
            vault: vault.key(),
            owner: vault.owner,
            session_key,
        });
        Ok(())
    }

    /// Owner-only: rotate the session key and/or adjust caps.
    pub fn update_vault(
        ctx: Context<OwnerAuthority>,
        session_key: Option<Pubkey>,
        per_spin_cap: Option<u64>,
        daily_cap: Option<u64>,
    ) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        if let Some(v) = session_key {
            vault.session_key = v;
            emit!(SessionKeyRotated {
                vault: vault.key(),
                session_key: v
            });
        }
        if let Some(v) = per_spin_cap {
            vault.per_spin_cap = v;
        }
        if let Some(v) = daily_cap {
            vault.daily_cap = v;
        }
        require!(
            vault.per_spin_cap > 0 && vault.daily_cap >= vault.per_spin_cap,
            VaultError::InvalidCaps
        );
        Ok(())
    }

    /// Pay for one gacha spin straight from the vault, signed only by the
    /// session key.
    ///
    /// Sends `amount` USDC from the vault to the whitelisted Collector Crypt
    /// treasury token account. The `memo` argument must be
    /// `<memo returned by /api/generatePack>` + `":open"` — the API field is
    /// the bare `<slug>-<uuid>` join key; the BACKEND appends the suffix.
    /// `fee_amount` is the Tangem fee, charged ON TOP of `amount` into the fee
    /// treasury, atomically. The exact per-machine rate lives on Tangem's
    /// backend; on-chain the fee must fall inside the admin-set corridor —
    /// both bounds are inclusive floors,
    /// `floor(amount * min_fee_bps / 10_000) <= fee_amount <=
    /// floor(amount * max_fee_bps / 10_000)`, so a backend MUST round down —
    /// and under the hard `MAX_FEE_BPS` ceiling regardless of config contents.
    /// Honest scope: only the FLOOR is enforced against the signer. The session
    /// key is the user's, so a hand-built transaction can pay `min_fee_bps`
    /// instead of the machine's rate; the ceiling protects the user from the
    /// backend, the floor protects Tangem from the user, and the backend-chosen
    /// rate in between is reconciled off-chain via `PackOpened.fee`.
    ///
    /// CLIENT CONTRACT: the transaction MUST carry a TOP-LEVEL spl-memo
    /// instruction with the same string — that memo plus the treasury
    /// transfer (inner CPI transfers are parsed) is what credits the spin.
    /// No gacha-wallet co-signature and no payer registration are needed;
    /// submit via any RPC (CC's /api/submitTransaction rejects foreign
    /// signatures). The
    /// `memo` arg here is validated and recorded in the PackOpened event for
    /// reconciliation; the program does NOT emit its own memo instruction —
    /// CC's indexer only reads the top-level one.
    pub fn purchase_pack(
        ctx: Context<PurchasePack>,
        amount: u64,
        fee_amount: u64,
        memo: String,
    ) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(!config.paused, VaultError::Paused);
        require!(amount > 0, VaultError::ZeroAmount);
        require!(
            !memo.is_empty() && memo.len() <= MAX_MEMO_LEN,
            VaultError::InvalidMemo
        );

        require_fee_in_corridor(amount, fee_amount, config.min_fee_bps, config.max_fee_bps)?;
        let fee = fee_amount;
        let total = amount.checked_add(fee).ok_or(VaultError::MathOverflow)?;
        charge_spending(&mut ctx.accounts.vault, total)?;

        let vault_key = ctx.accounts.vault.key();
        let seeds: &[&[u8]] = &[
            VAULT_SEED,
            ctx.accounts.vault.owner.as_ref(),
            &[ctx.accounts.vault.bump],
        ];
        let signer_seeds: &[&[&[u8]]] = &[seeds];

        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.vault_usdc.to_account_info(),
                    mint: ctx.accounts.usdc_mint.to_account_info(),
                    to: ctx.accounts.gacha_usdc.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                signer_seeds,
            ),
            amount,
            ctx.accounts.usdc_mint.decimals,
        )?;

        if fee > 0 {
            token_interface::transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.vault_usdc.to_account_info(),
                        mint: ctx.accounts.usdc_mint.to_account_info(),
                        to: ctx.accounts.fee_usdc.to_account_info(),
                        authority: ctx.accounts.vault.to_account_info(),
                    },
                    signer_seeds,
                ),
                fee,
                ctx.accounts.usdc_mint.decimals,
            )?;
        }

        emit!(PackOpened {
            vault: vault_key,
            owner: ctx.accounts.vault.owner,
            amount,
            fee,
            memo,
        });
        Ok(())
    }

    /// Owner-only: withdraw an SPL asset (USDC in the Day-1 product) to any
    /// different token account of the same mint. This remains a generic token
    /// withdrawal, independent of Config, the pause and spending caps. The
    /// transaction fee payer may be a separate sponsor.
    pub fn withdraw_token(ctx: Context<WithdrawToken>, amount: u64) -> Result<()> {
        require!(amount > 0, VaultError::ZeroAmount);
        // The source as its own destination would be a silent no-op: spl-token
        // returns Ok on a self-transfer without moving anything, yet
        // TokenWithdrawn would still fire for the full amount — an event that
        // proves nothing. Same rationale as the withdraw_sol recipient check.
        require_keys_neq!(
            ctx.accounts.destination.key(),
            ctx.accounts.source.key(),
            VaultError::Unauthorized
        );
        let vault = &ctx.accounts.vault;
        let seeds: &[&[u8]] = &[VAULT_SEED, vault.owner.as_ref(), &[vault.bump]];
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.source.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.destination.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                &[seeds],
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;
        emit!(TokenWithdrawn {
            vault: vault.key(),
            mint: ctx.accounts.mint.key(),
            amount,
        });
        Ok(())
    }

    /// Owner-only: close an empty vault-owned token account and return its
    /// entire lamport balance to the owner. The account must have no SPL
    /// delegate. This is also the cleanup path for the USDC ATA at offboarding;
    /// the original rent payer (including a sponsor) does not receive a refund.
    pub fn close_token_account(ctx: Context<CloseTokenAccountCtx>) -> Result<()> {
        require!(
            ctx.accounts.token.amount == 0,
            VaultError::TokenAccountNotEmpty
        );
        require!(
            ctx.accounts.token.delegate.is_none(),
            VaultError::DelegateStillSet
        );
        let vault = &ctx.accounts.vault;
        let seeds: &[&[u8]] = &[VAULT_SEED, vault.owner.as_ref(), &[vault.bump]];
        token_interface::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account: ctx.accounts.token.to_account_info(),
                destination: ctx.accounts.owner.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            &[seeds],
        ))?;
        emit!(TokenAccountClosed {
            vault: vault.key(),
            token_account: ctx.accounts.token.key(),
        });
        Ok(())
    }

    /// Owner-only: withdraw excess SOL from the vault PDA. Keeps the vault
    /// rent-exempt.
    pub fn withdraw_sol(ctx: Context<WithdrawSol>, lamports: u64) -> Result<()> {
        require!(lamports > 0, VaultError::ZeroAmount);
        // The vault as its own recipient is a duplicate account: the debit and
        // the credit would cancel and the call would report success having
        // moved nothing.
        require_keys_neq!(
            ctx.accounts.recipient.key(),
            ctx.accounts.vault.key(),
            VaultError::Unauthorized
        );
        let vault_info = ctx.accounts.vault.to_account_info();
        let rent_min = Rent::get()?.minimum_balance(vault_info.data_len());
        let remaining = vault_info
            .lamports()
            .checked_sub(lamports)
            .ok_or(VaultError::InsufficientSol)?;
        require!(remaining >= rent_min, VaultError::InsufficientSol);
        **vault_info.try_borrow_mut_lamports()? -= lamports;
        **ctx.accounts.recipient.try_borrow_mut_lamports()? += lamports;
        emit!(SolWithdrawn {
            vault: ctx.accounts.vault.key(),
            recipient: ctx.accounts.recipient.key(),
            lamports,
        });
        Ok(())
    }

    /// Owner-only: close the vault state account, returning its lamports to
    /// the owner. The program does not enumerate token accounts or assets:
    /// withdraw balances and close token accounts BEFORE closing the vault.
    /// Re-running `init_vault` with the same owner recreates the same PDA and
    /// restores access to assets left at that address. No Config is required,
    /// so the global pause does not block offboarding.
    pub fn close_vault(ctx: Context<CloseVault>) -> Result<()> {
        emit!(VaultClosed {
            vault: ctx.accounts.vault.key(),
            owner: ctx.accounts.owner.key(),
        });
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn compute_fee(amount: u64, fee_bps: u16) -> Result<u64> {
    (amount as u128)
        .checked_mul(fee_bps as u128)
        .and_then(|v| v.checked_div(10_000))
        .and_then(|v| u64::try_from(v).ok())
        .ok_or_else(|| VaultError::MathOverflow.into())
}

/// Corridor sanity, enforced wherever the pair is written (initialize_config,
/// update_config): `min <= max <= MAX_FEE_BPS`, so no config
/// state can ever authorize a fee above the hard ceiling.
fn validate_fee_corridor(min_bps: u16, max_bps: u16) -> Result<()> {
    require!(
        min_bps <= max_bps && max_bps <= MAX_FEE_BPS,
        VaultError::InvalidFeeBps
    );
    Ok(())
}

/// The fee a spin may carry. Three bounds, all cross-multiplied in u128 with no
/// division by `amount`: (1) never above `MAX_FEE_BPS` of `amount` — a hard,
/// config-independent backstop; (2) never above the admin corridor ceiling;
/// (3) never below the corridor floor. `f * 10_000 <= a * bps` is exactly
/// `f <= floor(a * bps / 10_000)`, so BOTH bounds are inclusive floors and a
/// backend that computes `floor(amount * rate_bps / 10_000)` for any rate
/// inside the corridor always passes (with min == max exactly one value is
/// accepted — a backend that rounds up fails with FeeAboveMaximum).
fn require_fee_in_corridor(amount: u64, fee: u64, min_bps: u16, max_bps: u16) -> Result<()> {
    let a = amount as u128;
    let f = fee as u128;
    require!(
        f * 10_000 <= a * (MAX_FEE_BPS as u128),
        VaultError::FeeAboveMaximum
    );
    require!(
        f * 10_000 <= a * (max_bps as u128),
        VaultError::FeeAboveMaximum
    );
    require!(
        fee >= compute_fee(amount, min_bps)?,
        VaultError::FeeBelowMinimum
    );
    Ok(())
}

/// Rolls the UTC-day window: a new day starts with a fresh `daily_cap`
/// budget. Note: as with any calendar-bucket limiter, a sliding 24h window
/// can still see up to ~2x daily_cap across a day boundary — size `daily_cap`
/// with that in mind.
fn roll_day(vault: &mut Account<Vault>) -> Result<()> {
    let day = Clock::get()?.unix_timestamp.div_euclid(SECONDS_PER_DAY);
    if day != vault.day_index {
        vault.day_index = day;
        vault.spent_today = 0;
    }
    Ok(())
}

/// Charges `total` against the per-spin and daily caps.
fn charge_spending(vault: &mut Account<Vault>, total: u64) -> Result<()> {
    require!(total <= vault.per_spin_cap, VaultError::ExceedsPerSpinCap);
    roll_day(vault)?;
    let spent = vault
        .spent_today
        .checked_add(total)
        .ok_or(VaultError::MathOverflow)?;
    require!(spent <= vault.daily_cap, VaultError::ExceedsDailyCap);
    vault.spent_today = spent;
    Ok(())
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    /// Fixed at initialization for the lifetime of this program id. Only a
    /// legacy SPL Token mint is accepted; update_config cannot change it.
    pub usdc_mint: Pubkey,
    /// Exact token account receiving spin principal. An admin can redirect
    /// all future spin payments by changing this address in one update.
    pub gacha_usdc_account: Pubkey,
    /// Exact token account receiving the Tangem fee. Subject to the same
    /// admin-routing trust as the principal treasury.
    pub fee_usdc_account: Pubkey,
    /// Inclusive floor of the backend-supplied fee, in basis points.
    pub min_fee_bps: u16,
    /// Inclusive ceiling, itself limited by MAX_FEE_BPS.
    pub max_fee_bps: u16,
    /// Stops purchases only; owner withdrawals and vault management remain
    /// available because those instructions do not read Config.
    pub paused: bool,
    pub bump: u8,
    /// Zeroed capacity for future fields. This fresh layout is not compatible
    /// with Config accounts of the historical custody program.
    pub _reserved: [u8; 32],
}

#[account]
#[derive(InitSpace)]
pub struct Vault {
    /// Tangem card key; controls withdrawals, caps, key rotation and closure.
    pub owner: Pubkey,
    /// Phone key; authorized only for purchases within the spending caps.
    pub session_key: Pubkey,
    /// Max USDC (including the fee) a single purchase may spend.
    pub per_spin_cap: u64,
    /// Max USDC (including fees) spendable per UTC calendar day.
    pub daily_cap: u64,
    /// Rolled lazily by purchase_pack. If day_index is stale, the available
    /// budget is the full daily_cap rather than daily_cap minus this value.
    pub spent_today: u64,
    pub day_index: i64,
    pub bump: u8,
    /// Zeroed capacity for future fields. This fresh layout is not compatible
    /// with Vault accounts of the historical custody program.
    pub _reserved: [u8; 32],
}

// ---------------------------------------------------------------------------
// Contexts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(
        init,
        payer = admin,
        space = 8 + Config::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, Config>,
    pub usdc_mint: InterfaceAccount<'info, Mint>,
    #[account(mut)]
    pub admin: Signer<'info>,
    /// Gate initialization to the program's upgrade authority so the config
    /// admin cannot be front-run between deploy and init.
    #[account(constraint = program.programdata_address()? == Some(program_data.key()))]
    pub program: Program<'info, crate::program::TangemGachaVault>,
    #[account(
        constraint = program_data.upgrade_authority_address == Some(admin.key())
            @ VaultError::Unauthorized
    )]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin)]
    pub config: Account<'info, Config>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct InitVault<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + Vault::INIT_SPACE,
        seeds = [VAULT_SEED, owner.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, Vault>,
    /// The Tangem card key — must sign vault creation.
    pub owner: Signer<'info>,
    /// Rent payer: any signer, including a gasless sponsor. The owner only
    /// needs to sign; this payer need not equal session_key.
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct OwnerAuthority<'info> {
    #[account(
        mut,
        seeds = [VAULT_SEED, owner.key().as_ref()],
        bump = vault.bump,
        has_one = owner
    )]
    pub vault: Account<'info, Vault>,
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct PurchasePack<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [VAULT_SEED, vault.owner.as_ref()],
        bump = vault.bump,
        has_one = session_key
    )]
    pub vault: Account<'info, Vault>,
    /// Need not be the transaction fee payer and needs no SOL balance here.
    pub session_key: Signer<'info>,
    #[account(address = config.usdc_mint)]
    pub usdc_mint: InterfaceAccount<'info, Mint>,
    /// Pinned to the vault's CANONICAL ATA (not just any vault-owned USDC
    /// account).
    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = vault,
        associated_token::token_program = token_program,
    )]
    pub vault_usdc: InterfaceAccount<'info, TokenAccount>,
    /// Whitelisted Collector Crypt treasury account — the ONLY spin
    /// destination the session key can pay. The mint pin turns a wrong-mint
    /// address in the config into a loud first-spin failure
    /// (ConstraintTokenMint, 2014) instead of a token-program error mid-CPI.
    #[account(mut, address = config.gacha_usdc_account, token::mint = usdc_mint)]
    pub gacha_usdc: InterfaceAccount<'info, TokenAccount>,
    /// The mint pin matters MOST here: while `fee_amount == 0` the fee transfer is
    /// skipped, so without it a wrong-mint `fee_usdc_account` in the config
    /// would pass silently for as long as the fee stays zero — and then break
    /// every spin of every vault the moment the fee is raised. Failing the
    /// first spin makes the misconfiguration visible at rollout, when it is
    /// still one `update_config` away from harmless.
    #[account(mut, address = config.fee_usdc_account, token::mint = usdc_mint)]
    pub fee_usdc: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct WithdrawToken<'info> {
    #[account(
        seeds = [VAULT_SEED, owner.key().as_ref()],
        bump = vault.bump,
        has_one = owner
    )]
    pub vault: Account<'info, Vault>,
    pub owner: Signer<'info>,
    #[account(mut, token::authority = vault, token::mint = mint)]
    pub source: InterfaceAccount<'info, TokenAccount>,
    pub mint: InterfaceAccount<'info, Mint>,
    /// Any token account of the same mint — destination is the owner's
    /// free choice, except the source itself (rejected in the handler).
    #[account(mut, token::mint = mint)]
    pub destination: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct CloseTokenAccountCtx<'info> {
    #[account(
        seeds = [VAULT_SEED, owner.key().as_ref()],
        bump = vault.bump,
        has_one = owner
    )]
    pub vault: Account<'info, Vault>,
    /// Receives all lamports from the closed account, regardless of who
    /// originally funded its rent.
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, token::authority = vault)]
    pub token: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct WithdrawSol<'info> {
    #[account(
        mut,
        seeds = [VAULT_SEED, owner.key().as_ref()],
        bump = vault.bump,
        has_one = owner
    )]
    pub vault: Account<'info, Vault>,
    pub owner: Signer<'info>,
    /// CHECK: recipient is the owner's free choice; only receives lamports.
    #[account(mut)]
    pub recipient: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct CloseVault<'info> {
    #[account(
        mut,
        close = owner,
        seeds = [VAULT_SEED, owner.key().as_ref()],
        bump = vault.bump,
        has_one = owner
    )]
    pub vault: Account<'info, Vault>,
    #[account(mut)]
    pub owner: Signer<'info>,
}

// ---------------------------------------------------------------------------
// Events & errors
// ---------------------------------------------------------------------------

#[event]
pub struct VaultInitialized {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub session_key: Pubkey,
}

#[event]
pub struct SessionKeyRotated {
    pub vault: Pubkey,
    pub session_key: Pubkey,
}

#[event]
pub struct ConfigUpdated {
    pub admin: Pubkey,
    pub gacha_usdc_account: Pubkey,
    pub fee_usdc_account: Pubkey,
    pub min_fee_bps: u16,
    pub max_fee_bps: u16,
    pub paused: bool,
}

/// Emitted by `purchase_pack`. The name predates the open_pack → purchase_pack
/// rename and is kept ON PURPOSE: indexers key on the event discriminator,
/// which is derived from this name.
#[event]
pub struct PackOpened {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
    pub fee: u64,
    pub memo: String,
}

#[event]
pub struct TokenWithdrawn {
    pub vault: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
}

#[event]
pub struct TokenAccountClosed {
    pub vault: Pubkey,
    pub token_account: Pubkey,
}

#[event]
pub struct SolWithdrawn {
    pub vault: Pubkey,
    pub recipient: Pubkey,
    pub lamports: u64,
}

#[event]
pub struct VaultClosed {
    pub vault: Pubkey,
    pub owner: Pubkey,
}

/// Explicit discriminants retain the published error numbers. Removed
/// custody errors leave gaps; do not reuse their numbers for new meanings.
#[error_code]
pub enum VaultError {
    #[msg("Program is paused")]
    Paused = 0,
    #[msg("Amount must be greater than zero")]
    ZeroAmount = 1,
    #[msg("Memo is empty or too long")]
    InvalidMemo = 2,
    #[msg("Fee basis points out of range")]
    InvalidFeeBps = 3,
    #[msg("Caps must satisfy 0 < per_spin_cap <= daily_cap")]
    InvalidCaps = 4,
    #[msg("Amount exceeds per-spin cap")]
    ExceedsPerSpinCap = 5,
    #[msg("Amount exceeds the daily cap")]
    ExceedsDailyCap = 6,
    #[msg("Arithmetic overflow")]
    MathOverflow = 7,
    #[msg("Token account is not empty")]
    TokenAccountNotEmpty = 15,
    #[msg("Token account still has a delegate — revoke first")]
    DelegateStillSet = 16,
    #[msg("Insufficient SOL above rent-exempt minimum")]
    InsufficientSol = 17,
    #[msg("Account is not authorized for this operation")]
    Unauthorized = 18,
    #[msg("USDC mint must be a legacy SPL Token mint")]
    UnsupportedMint = 21,
    #[msg("Fee is below the configured minimum")]
    FeeBelowMinimum = 22,
    #[msg("Fee is above the configured maximum or the hard cap")]
    FeeAboveMaximum = 23,
}
