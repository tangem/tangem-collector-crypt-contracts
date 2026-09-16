# Tangem Gacha Vault

Anchor program for the **Tangem Collectibles × Collector Crypt** integration.
It gives every Tangem user a per-user smart-contract vault (PDA) so that gacha
spins run off a **session key** on the phone (a hot key, `session_key` in the
program), while the **cold key** (the Tangem card, `owner` in the program)
stays the root authority — no card tap per spin. The same two-key model
extends to prize custody and buybacks, which the product has scheduled as a
later phase (see "Integration status").

## Integration status

Everything on our side is implemented and tested; the devnet program id is
`29agFEruMu2jedVwnDgKPuq7ejmTiB7sEqzdhufQQS9u`. **This README describes the
build in this repository** — `purchase_pack` with an explicit `fee_amount`,
the admin-set fee corridor, `migrate_config`, the 176-byte `Config`, and the
`owner` / `session_key` identifiers. **Devnet has NOT been redeployed with it
yet:** the chain still runs the previous build (deployed 24-08-2026 at slot
487301012, 174-byte `Config`, `open_pack`). The committed IDL at
`idl/tangem_gacha_vault.json` matches this repository, so it is ahead of the
chain until the redeploy; the deploy ritual, including the mandatory
`migrate_config` call, is in "Devnet quickstart against CC".

**Product profile — "Day 1"** (decided 03-09-2026; both delivery addresses
still to be confirmed by product):

- The vault is a **USDC balance for spins**, nothing more. Prizes are
  delivered to the **owner (cold) wallet**: the backend passes
  `altPlayerAddress` = the owner address, not the vault PDA; turbo payouts go
  to the owner likewise, via `altFundsRecipient`. The monitoring invariant is
  therefore *the prize must land on the owner address*.
- CC's instant buyback (~72h after the win) is exercised from the owner wallet
  directly with CC — no vault instruction is involved.
- **Phase 2** — prize custody in the vault (`altPlayerAddress` = vault PDA),
  the atomic buybacks (`buyback_pnft` / `buyback_core`), the legacy template
  path and the two-party co-sign protocol. The code exists, is tested and has
  devnet reference runs, but the product has deferred it. Everything below
  that concerns prizes inside the vault is Phase 2 material unless stated
  otherwise.

What has been verified live:

- **Spin** — verified end-to-end against CC's dev backend (17-07-2026) with
  the then-current instruction `open_pack`; today's `purchase_pack` keeps the
  same eight accounts and adds the `fee_amount` argument. The instruction pays
  from the vault via inner CPI, CC credits the spin and delivers the prize to
  whatever `altPlayerAddress` the memo was minted with.
- **Atomic buyback (`buyback_pnft` / `buyback_core`)** (Phase 2) — the endgame
  custody path. `buyback_core` has reference live runs on devnet against the
  real Core prize in its current form (`destination_owner` included):
  `5AvPAqJjWkaDeKpSr5F7bs7NyrS8Rhi9KqEYQ6pZBHcqAtKjVHoizo8p1rXigQFQDxDBa7JG9UuFPLfbL2ZK3sg1`
  (24-08-2026) and
  `2xvN93qri67MWsUQXMR1Cw4ohdkhPntbA8HTypeRYwU2NoSmU9uad6foFdKUrrFuzFVKVupNv12DLRfX7eFa6qLc`
  (22-08-2026); in these runs `cc_authority` was temporarily substituted,
  since we cannot sign with CC's wallet. `buyback_pnft` has not been executed
  live — its first run is the joint e2e with CC (the litesvm happy paths
  cover the full current account list).
- **pNFT buyback via CC's template** (Phase 2, legacy) — verified end-to-end
  (28-07-2026): `approve_buyback` → `/api/buyback` with `transferAuthority`
  (no-closeAccount template, scoped API key) → session-key countersign →
  prize to CC, refund in the vault, slot cleared, ATA closed. Remains only
  until CC's backend migrates to the atomic path.
- **`sweep_prize_ata`** — our half of CC's rent-recovery cron; permissionless,
  so CC's cron calls it directly. Live, verified by a real sweep on devnet.
  It reads `Config`, so it is affected by the post-deploy migration window
  described in "Config layout and `migrate_config`".

CC confirmed (19-08-2026): their backend will build buyback transactions
against these instructions via a new endpoint, driven by our committed IDL;
the wallet that signs buybacks is the same gacha wallet the USDC goes to, and
their rent cron keys on it too — matching the single `config.gacha_wallet`
pin the program enforces. The remaining dependency for Phase 2 is that
endpoint, plus pinning `config.gacha_wallet` to the wallet CC actually signs
with. Read "Security model" before deploying — `gacha_wallet` is an
asset-custody authority, not a payment address.

Reference scripts live in `scripts/devnet/`: `vault_spin.js` (a vault-paid
spin: `generatePack` → memo → `purchase_pack` → `openPack`),
`migrate_config.js` (the one-shot `Config` migration, see the deploy ritual),
`vault_buyback_atomic.js` (builds the atomic buyback transaction — the
CC-side role), `vault_cosign_buyback.js` (validates the built transaction
against a whitelist and co-signs with the session key — the Tangem-side
role) and `vault_cosign_demo.js` (rehearses the full two-party protocol on
devnet with the two roles held by separate keys).

## Verified integration facts (July 2026)

Everything below was verified against Collector Crypt's live API, docs
(`docs.collectorcrypt.com/gacha/api`), frontend bundles, and decoded mainnet
transactions — not assumptions:

1. **CC's gacha has no on-chain program.** All gacha flows are backend-built,
   backend-co-signed ordinary transactions (Memo + SPL Token + Token Metadata
   only).
2. **Spin (`:open`)**: `POST /api/generatePack {playerAddress, packType,
   turbo?, altPlayerAddress?, altFundsRecipient?}` returns
   `{memo: "<slug>-<uuid>", transaction}` — a tx pre-signed by
   `GachaNgyXTU3zFogQ8Z5jR2BLXs8215X2AtEH18VxJq3` as **fee payer** (the SPL
   Memo instruction carries no accounts and needs no signature — verified by
   decoding a live devnet tx); the USDC transfer is a plain **top-level**
   transfer from the player's ATA to treasury ATA
   `D9CEogjHA6CpS12F8St9zpSco7pQKJB5uR1RqDsuzQZk`. The player countersigns as
   fee payer and transfer authority, then `POST /api/submitTransaction`, then
   `POST /api/openPack {memo}`.
3. **The API's `memo` field is the bare `<slug>-<uuid>` join key.** The
   on-chain memo per leg appends a suffix: `:open` / `:send:r<hex>` /
   `:buyback`. Whoever builds the payment tx must append `":open"` itself.
   That join key drives all reconciliation (`/api/pack/status?memo=`,
   `/api/stats`, `/api/vrf/verify?memo=`).
   **Glossary:** `spin_id` (proposed backend term) = `memo` (CC API) =
   `join_key` (this README); `chain_memo` = `join_key + ":open"` (buyback:
   `":buyback"`). CC's API field names, endpoints (`generatePack`, `openPack`,
   `altPlayerAddress`, `altFundsRecipient`, `submitTransaction`), the SPL Memo
   instruction and the on-chain event name `PackOpened` are fixed and do not
   follow our internal renames.
4. **Prizes are MOSTLY Metaplex Core assets now** (per CC, 17-07-2026;
   AssetV1, collection `CCryptUfeFSZ3Fgc9FLeKrhLVAP67FSqi1GuVoj9CRac`, no
   token accounts, ships unfrozen — but the collection carries
   `PermanentTransferDelegate`/`PermanentBurnDelegate` with authority = CC,
   so CC retains seize/burn power over Core prizes regardless of custody).
   Older prizes are **Token Metadata pNFTs**, verified collection
   `CCryptWBYktukHDQ2vHGtVcmtjXxYzvw8XNVY64YN2Yf`, ruleset = Metaplex
   Foundation Rule Set (`eBJLFYPx…`, currently blocks nothing); their token
   accounts are **permanently frozen** — every move goes through Token
   Metadata `TransferV1`; SPL `approve`/`transfer` do not work; delegation =
   `DelegateV1` with `TokenDelegateRole::Transfer` written into the per-token
   `TokenRecord` PDA (auto-cleared on transfer). The machines can also emit
   compressed NFTs but do not today (candidate for future $5 packs).
5. **A PDA can receive prizes** (recipient never signs the `:send` leg;
   `altPlayerAddress` is an explicit API field; ME/Tensor escrow PDAs hold CC
   pNFTs today). `/api/buyback` takes an optional **`transferAuthority`** (a
   delegate that countersigns the NFT transfer instead of the owner) and
   builds for off-curve owners, and CC scopes a no-closeAccount template to
   our API key — which is what makes the legacy template path work at all.
6. Buyback eligibility (per CC, 21-07-2026): **any current holder**, within
   ~3 days of the prize leaving the gacha (the receiver-based rule in the docs
   is stale); the `/api/buyback/available` wallet param is to become optional.
   Refund = `instantBuyback%` (85/90/93 by pack tier) of insured value, capped
   at 40 000 USDC; `altRecipient` redirects the USDC refund only and is an
   **owner wallet** — an off-curve PDA works (CC derives and creates the ATA;
   verified by decoding the built tx).
7. Randomness: their own `cc-vrf` (RFC 9381 ECVRF), commit tx per spin by their
   operator key; verification is public per memo — nothing VRF-related touches
   the payer transaction.

## Architecture

```
cold key (Tangem card)  ──owns──►  Vault PDA ["vault", owner]
  = vault.owner                      ├── USDC ATA   (spins are paid from here)
                                     └── prize ATAs / Core assets (Phase 2:
                                         prizes land here; Day 1: prizes go
                                         to the owner wallet directly)
session key (phone)     ──delegate── limited actions only
  = vault.session_key
```

| Action | Signer | Instruction | Funds can go to |
|---|---|---|---|
| Global setup (once) | program upgrade authority (becomes admin) | `initialize_config` | — |
| One-shot `Config` layout migration (174 → 176 B) | Tangem admin | `migrate_config` | — |
| Create vault | cold (+phone pays rent) | `init_vault` | — |
| Deposit USDC | cold (plain SPL transfer, 1 tap) | none needed | vault ATA |
| Spin | session key | `purchase_pack` | CC treasury + fee treasury only |
| Buyback (atomic, Phase 2) | CC operator + session key (consent) | `buyback_pnft` / `buyback_core` | NFT → `destination_owner` (CC's free per-transaction choice — their prizes live across rotating prize wallets), USDC → the vault's canonical ATA (pinned). The signer is pinned to `config.gacha_wallet` — but that field is admin-writable, so the pin is only as strong as the admin key |
| Prepare buyback (legacy template path, Phase 2) | session key | `approve_buyback` (pNFT `DelegateV1`) | — |
| Free buyback slot | session key or cold | `revoke_buyback` / `clear_buyback_slot` | — |
| Withdraw USDC | cold | `withdraw_token` | anywhere |
| Withdraw prize pNFT | cold | `withdraw_pnft` (`TransferV1`) | anywhere |
| Withdraw prize Core asset | cold | `withdraw_core` (mpl-core `TransferV1`) | anywhere (not the only Core exit — see `buyback_core`) |
| GC empty token accounts | cold | `close_token_account` | everything → owner |
| Sweep empty prize ATAs | anyone (permissionless; CC's cron) | `sweep_prize_ata` | exactly the rent → CC gacha wallet; any excess stays in the vault |
| Sweep excess SOL | cold | `withdraw_sol` | anywhere (rent floor stays) |
| Close vault (offboarding) | cold | `close_vault` | rent → owner |
| Rotate session key / caps | cold | `update_vault` | — |
| Pause / fee corridor / treasuries / feature flags | Tangem admin | `update_config` | — |

Caps: `per_spin_cap` and `daily_cap` (UTC-day bucket) bound everything the
session key can spend — `purchase_pack` charges `amount + fee_amount` in one
check, and a new UTC day starts with a fresh budget. As with any
calendar-bucket limiter, a sliding 24h window can still see up to ~2×
`daily_cap` across a day boundary — size the cap with that in mind.

## The spin payment (`purchase_pack`)

Our backend calls `generatePack` only to obtain the memo — with
`altPlayerAddress` = the **owner wallet** on Day 1 (Phase 2: the vault PDA, so
the prize lands under cold-key control) — DISCARDS CC's transaction, and the
phone sends our own: a client-added TOP-LEVEL memo (`<memo>:open` — we append
the suffix) + `purchase_pack(amount, fee_amount, memo)`, which transfers
`amount` USDC to the **whitelisted** treasury ATA via inner CPI and
`fee_amount` to the Tangem fee treasury, atomically. CC's webhook credits the
spin by matching memo + treasury transfer; their indexer parses inner (CPI)
transfers, needs no GachaNgy co-signature and no trusted-payor registration
(verified end-to-end on CC's dev backend, 17-07-2026). Submit via any RPC —
CC's `/api/submitTransaction` rejects foreign signatures. Guarantees:
destination fixed on-chain, fee atomic, caps enforced in the same
instruction. Accounts (8): `config`, `vault` (w), `session_key` (signer),
`usdc_mint`, `vault_usdc` (w, the vault's canonical ATA), `gacha_usdc` (w,
= `config.gacha_usdc_account`), `fee_usdc` (w, = `config.fee_usdc_account`),
`token_program`. Event: `PackOpened { vault, owner, amount, fee, memo }`
with `fee` = `fee_amount`.

### Fee corridor

The contract does not derive the fee from a single global rate. Tangem's
backend knows the rate of each gacha machine and passes the resulting fee
explicitly:

```
fee_amount = floor(amount * machine_rate_bps / 10_000),
  with machine_rate_bps inside [config.min_fee_bps, config.max_fee_bps]
```

On-chain, `require_fee_in_corridor` applies three checks, all cross-multiplied
in `u128` with no division by `amount`, so the backend's floor rule always
passes for any rate inside the corridor:

1. **Hard backstop, independent of config:**
   `fee_amount * 10_000 <= amount * MAX_FEE_BPS` (`MAX_FEE_BPS` = 1000 = 10%)
   — else `6023 FeeAboveMaximum`.
2. **Corridor ceiling, exact:** `fee_amount * 10_000 <= amount * max_fee_bps`
   — else `6023 FeeAboveMaximum`. The payer keeps any sub-unit remainder.
3. **Corridor floor, floor semantics:**
   `fee_amount >= floor(amount * min_fee_bps / 10_000)` — else
   `6022 FeeBelowMinimum`.

**Honest scope.** The corridor is the only on-chain bound. The session key is
the user's, so a hand-built `purchase_pack` can carry
`fee_amount = floor(amount * min_fee_bps / 10_000)` instead of the machine's
rate: the ceiling protects the user from the backend, the floor protects
Tangem from the user, and the backend-chosen rate in between is reconciled
off-chain from `PackOpened.fee` (a fee below the expected machine rate but
inside the corridor is a hand-built transaction — alert and rotate).

The corridor itself is admin-set and validated wherever it is written
(`initialize_config`, `update_config`, `migrate_config`):
`min_fee_bps <= max_fee_bps <= 1000`, else `6003 InvalidFeeBps` — so no config
state can ever authorize a fee above the hard ceiling. Planned devnet values
after the migration: `min_fee_bps` = 100 (1%), `max_fee_bps` = 500 (5%). A
`fee_amount` of zero passes the floor check only when
`floor(amount * min_fee_bps / 10_000)` is itself zero (`min_fee_bps` = 0, or
a sub-unit amount); when `fee_amount` is zero the fee transfer is skipped,
but `fee_usdc` is still pinned and mint-checked so a misconfigured fee
treasury fails the first spin rather than the first non-zero fee.

**History.** Until this release the spin instruction was `open_pack(amount,
memo)`, with the fee computed on-chain from a single global `config.fee_bps`.
It was replaced — not extended — by `purchase_pack`: the old discriminator is
gone, and a client still sending `open_pack` gets Anchor's
`InstructionFallbackNotFound` (101). The account list is unchanged. An older
fallback "Plan B" (`approve_usdc_spending`: SPL-delegate to the hot key + a
top-level delegated transfer, working against CC's pre-17-07 top-level-only
indexer) was implemented, verified on devnet, and then REMOVED once the CPI
path was confirmed: it was strictly weaker (a delegate can send the allowance
anywhere; the whole `outstanding_approval` day-carry machinery existed only to
bound that). `Config._reserved` (`u8`) and `Vault._reserved` (`u64`) are
layout padding where its state lived — kept so already-deployed accounts stay
compatible (the live devnet `Config` still carries 1 in that byte).

## Config layout and `migrate_config`

`Config` is a singleton PDA (`["config"]`), **176 bytes** since this release
(174 before). Offsets include the 8-byte discriminator:

| Offset | Field | Type | Note |
|---|---|---|---|
| 8 | `admin` | `Pubkey` | |
| 40 | `usdc_mint` | `Pubkey` | permanent — see "Mainnet TODO" |
| 72 | `gacha_wallet` | `Pubkey` | custody authority, see "Security model" |
| 104 | `gacha_usdc_account` | `Pubkey` | spin destination |
| 136 | `fee_usdc_account` | `Pubkey` | fee destination |
| 168 | `min_fee_bps` | `u16` LE | the pre-corridor `fee_bps` slot, reused in place |
| 170 | `paused` | `bool` | |
| 171 | `_reserved` | `u8` | padding; live devnet carries 1 |
| 172 | `allow_buyback_delegation` | `bool` | gates `approve_buyback` only |
| 173 | `bump` | `u8` | |
| 174 | `max_fee_bps` | `u16` LE | **appended** — every earlier offset is unchanged for raw readers |

The corresponding constants in `lib.rs` are `CONFIG_LEGACY_LEN` = 174,
`CONFIG_MIN_FEE_OFFSET` = 168, `CONFIG_MAX_FEE_OFFSET` = 174.

An existing 174-byte `Config` is migrated in place by
**`migrate_config(max_fee_bps: u16)`** — accounts: `config` (w, passed as an
`UncheckedAccount` because Anchor cannot deserialize the short legacy image
with the new type), `admin` (signer, w — pays the rent top-up for the two
extra bytes), `system_program`. The handler validates program ownership and
the discriminator (`6024 InvalidConfigAccount`), checks the stored admin at
bytes 8..40 against the signer (`6018 Unauthorized`), returns `Ok` early if
the account is already 176 bytes (idempotent), tops up rent, resizes 174 → 176,
validates `min_fee_bps <= max_fee_bps <= 1000` against the old rate now
serving as the floor (`6003 InvalidFeeBps`), writes `max_fee_bps` at offset
174 and emits `ConfigUpdated`. The old `fee_bps` value becomes `min_fee_bps`
without being touched.

**Operational fact:** between the program upgrade and this call, every
instruction that deserializes `Config` — `purchase_pack`, `approve_buyback`,
both buybacks, `update_config` **and `sweep_prize_ata`, which CC's rent cron
calls** — fails with Anchor `3003 AccountDidNotDeserialize`. Run
`migrate_config` in the same operator session as the deploy, and warn CC
about the window before upgrading.

## Buyback — atomic path (`buyback_pnft` / `buyback_core`) — Phase 2

This is the endgame custody path CC's backend is migrating to. Atomic swap in
one instruction: CC pays `price` USDC into the vault's canonical USDC ATA
(pinned), then the vault PDA signs the NFT transfer as the OWNER — no
standing delegate exists at any point. Two signers:

- **`cc_authority`** — the CC operator wallet fixed in the config
  (`config.gacha_wallet`). It pays the refund and the fees; on the pNFT path
  it also receives the closed prize ATA's rent (CC fronted that rent at
  delivery).
- **`session_key`** — user consent to the offered price. The phone MUST
  decode the transaction and display the `price` ARGUMENT before signing
  (nothing on-chain bounds `price` beyond `> 0`).

The NFT lands at **`destination_owner`** (account slot 5 in both
instructions), deliberately unconstrained: CC confirmed (19-08-2026) that
prizes return to rotating prize wallets — "could be 10 different wallets and
it changes often" — not to the signing operator wallet. On the pNFT path the
emptied prize ATA is closed in the same instruction (lamports back to CC) and
a stale `approve_buyback` slot pointing at this token is freed —
`clear_buyback_slot` is NOT needed afterwards.

Builder contract for CC (also encoded in
`scripts/devnet/vault_buyback_atomic.js`):

- Prepend `createAssociatedTokenAccountIdempotent` for the vault's USDC ATA
  (payer = `cc_authority`) — the instruction pins the canonical ATA but does
  not create it.
- `buyback_pnft`: 22 accounts, request ~400k CU (the TransferV1 creates the
  destination ATA + TokenRecord and evaluates the rule set — the 200k default
  does not fit). The full transaction measures **1128 bytes** — inside the
  1232-byte packet, no address lookup tables needed.
- `buyback_core`: 12 accounts, a single light mpl-core CPI — the default
  compute budget suffices.
- Add a top-level memo for CC's own reconciliation. Our devnet runs use
  `<slug>-<uuid>:buyback`, mirroring the spin's `:open`; the final format is
  CC's call. The `memo` argument is additionally recorded in the
  `BuybackExecuted` event.

**Submission protocol** (proposed to CC in August 2026; their written
confirmation pending): CC builds the transaction (their wallet as fee payer, fresh
blockhash) and partially signs → the Tangem endpoint validates it against a
whitelist (`scripts/devnet/vault_cosign_buyback.js` is the reference), the
phone displays the `price` argument and co-signs — a step that can take tens
of seconds → CC submits and retries; if the blockhash expires, CC rebuilds
with a new memo.

## Buyback — legacy template path (Phase 2, to be retired)

The flow below is the delegate-based path that remains only until CC's
backend migrates to the atomic instructions; the moment it does,
`allow_buyback_delegation` should be set `false` permanently, which retires
the standing-delegate drain risk entirely (see "Security model").

1. Prize pNFT sits in the vault's ATA (frozen, owner = vault PDA).
2. The session key calls `approve_buyback` → vault CPIs `DelegateTransferV1`
   (invoke_signed), the session key becomes the Transfer delegate in the
   TokenRecord. Only ONE delegate may be live per vault (`live_buyback_mint`
   slot).
3. Our backend calls `POST /api/buyback {playerAddress: <vault PDA>,
   nftAddress, altRecipient: <vault PDA>, transferAuthority: <session key>}`.
   `altRecipient` is an owner wallet; CC derives (and create-idempotents) the
   vault's USDC ATA, off-curve included — verified by decoding the built tx.
4. CC's builder returns: TransferV1 with **authority = `transferAuthority`**
   (+ token record), **fee payer = the gacha wallet** (pre-signed — we do not
   even pay the fee), the USDC refund straight into the vault's ATA, and a
   `:buyback` memo. Two template defects were fixed along the way: a trailing
   `closeAccount` with the gacha as authority (only the ATA owner can close;
   a frozen pNFT ATA cannot be given a close delegate at all) — solved by the
   no-closeAccount template scoped to our API key plus `sweep_prize_ata`; and
   Core assets, over which `transferAuthority` has no rights at all — mooted
   by the atomic `buyback_core`: Core never goes through the template.
5. The session key countersigns; NFT returns to the prize wallet, USDC lands
   in the vault. The TokenRecord delegate is consumed by the transfer; the
   client then calls `clear_buyback_slot` on **the exact account that was
   delegated** (proof: it is now empty / delegate-free) to free the vault's
   slot.
6. The emptied NFT ATA is later closed. **Policy:** CC fronted the rent for
   every prize ATA, so the app should call `sweep_prize_ata` (rent → CC) for
   those and reserve `close_token_account` (everything → owner) for
   accounts the user paid for, such as the USDC ATA at offboarding. Nothing
   on-chain arbitrates between the two — whoever calls first wins — so this
   is a client-side commitment. Either way it must happen only *after* the
   slot is freed (closing it first would strand the slot). The TokenRecord
   takes care of itself: TransferV1 closes the source record and refunds its
   rent to the transfer's fee payer — verified in
   `programs/tangem-gacha-vault/tests/pnft.rs`, both for
   the delegate-authority and the owner path.

**Offboarding order:** `revoke_buyback`/`clear_buyback_slot` (free the slot)
→ `withdraw_token` / `withdraw_pnft` / `withdraw_core` → **`sweep_prize_ata`
for CC-created prize ATAs and `close_token_account` for the USDC ATA and
anything the user paid for** (per the policy in step 6 above) →
`close_vault`. `close_vault` refuses to run while a buyback delegate is still
live, so a close + re-init cannot silently reset the slot while an old
session-key Metaplex delegate stays live on-chain. Rotating the session key
via `update_vault` changes who may *call* instructions but does NOT revoke an
already-granted pNFT transfer delegate — pair a rotation with
`revoke_buyback` if the old key may be compromised.

## Physical card redemption — known gap (Phase 2 roadmap)

On Day 1 prizes land on the owner wallet — an ordinary on-curve wallet — so
CC's redemption flow applies to them unchanged. The gap below concerns
vault-held prizes (Phase 2). CC's Shipping API
(`docs.collectorcrypt.com/vault/shipping-api`) requires the card to be
**owned by an on-curve wallet on the user's CC user row**: the wallet
authenticates (Privy or SIWS message-signing) and signs the
burn+shipping-payment transactions built by `/redeem/prepare`. A program PDA
can satisfy neither requirement, so **redemption of a vault-held prize has no
direct path today**. Interim flow: `withdraw_pnft` to the cold wallet (1 tap)
→ SIWS-authenticate the cold wallet → cold key signs CC's burn+payment txs
(1-2 more taps; tx size vs the card budget unvalidated; blockhash expiry vs
cold-signing latency is an open question to CC). If CC supports a
**Utility-role burn delegate** (open question to CC; for Core prizes their
collection-level `PermanentBurnDelegate` could serve the same role), a future
`redeem_physical` instruction (cold-gated — redemption redirects a physical
asset to a postal address, so it must NOT be session-key-triggerable) could
reduce this to one tap. Blocked on CC-side answers — see "Open questions to
CC".

## Security model — honest worst cases

- **Cold key (`owner`)**: root authority; can withdraw/rotate/close at any
  time; never needed for spins/buybacks.
- **The custody guarantee assumes the owner key is a cold key.** The model
  is "a stolen phone is not stolen funds": the session key on the phone is
  bounded by the caps and by the whitelisted destinations, and everything
  else needs the card. If the `owner` of a vault is instead a hot/software
  wallet key that lives on the same phone as the session key, both keys fall
  together and that guarantee disappears — the contract still works, and the
  caps still bound the spin path, but such a setup MUST NOT be advertised as
  protecting the user's balance or prizes.
- **Fee corridor scope**: on-chain only `[min_fee_bps, max_fee_bps]` and the
  10% hard cap bind a spin's fee; the exact machine rate is a backend
  decision enforced by reconciliation, not by the program (see "Fee
  corridor").
- **Session-key compromise**:
  - USDC: can spend the deposited balance on gacha spins within per-spin and
    daily caps, and ONLY to the whitelisted treasury/fee accounts fixed in the
    config. It can NOT withdraw USDC or redirect it anywhere else. **But the
    caps are a theft budget, not a waste budget.** The prize *recipient* is
    `altPlayerAddress`, chosen off-chain when the memo is minted, and CC
    credits whichever memo accompanies a treasury transfer regardless of who
    paid (verified on-chain). A stolen phone can therefore mint its own memos
    and spend the vault's USDC on spins whose prizes are delivered to the
    attacker's own wallet — realizing ~100% of `daily_cap` as value, and CC's
    any-holder buyback turns those prizes straight back into USDC. This cannot
    be closed on-chain (the memo carries no recipient the program can check);
    the control is operational: our backend must mint memos ONLY with
    `altPlayerAddress` = the owner wallet (Day 1) or the vault PDA (Phase 2),
    index every `PackOpened.memo`, and alarm on a memo it did not issue or a
    prize not delivered to that address. Size `daily_cap` accordingly.
  - Prize pNFTs (Phase 2, legacy path only): **can be drained, serially**.
    `approve_buyback` lets the session key make itself a transfer delegate
    and a transfer delegate can move that pNFT anywhere (the CC ruleset blocks
    nothing) — approve + transfer even fits in one atomic tx, so
    pause/revoke are reactive. The `live_buyback_mint` slot forces one NFT at
    a time (the next approval needs on-chain proof the previous NFT left),
    and `allow_buyback_delegation` is the admin kill switch for **this path
    only** — these bound the *rate*, not the outcome. Eliminating this
    entirely would require a cold-key tap per buyback; the product accepts
    the risk for NFTs, whose intended lifecycle in the vault is short (72h
    buyback window), and long-term holdings should be moved to cold storage
    via `withdraw_pnft`. This path is retired the moment CC's backend moves
    to `buyback_pnft` — then set `allow_buyback_delegation = false`
    permanently.
  - Prizes via atomic buyback (Phase 2): the session key alone cannot move
    one — `buyback_pnft` / `buyback_core` also need CC's signature, the
    refund destination is pinned (the vault's canonical USDC ATA) and the
    payment lands there first; the NFT goes to whatever `destination_owner`
    the CC signer chose. See the admin bullet for the case where both keys
    are held.
- **Tangem admin key — larger than it looks.** It cannot touch assets by
  itself, but `config.gacha_wallet` is **an asset-custody authority, not a
  payment address**: it is the `address =` pin on `cc_authority`, i.e. the
  only key that may execute a buyback — a buyback that sends the prize to an
  unconstrained `destination_owner` of that signer's choosing.
  `update_config` rewrites it with one signature, no timelock, for every
  vault at once (Config is a singleton). So **admin + a vault's session key
  can move any prize out of that vault at any `price > 0`** — no cold tap, no
  caps (they apply only to `purchase_pack`), no one-live-delegate slot, no
  price floor. In particular this is the first path by which anything other
  than the cold key can move a **Core** asset: before these instructions
  `withdraw_core` was their sole exit. Both keys are Tangem-controlled
  artefacts, so this is a single-organization compromise — precisely what
  the cold card is meant to prevent. Consequences:
  - **Hold the admin key in a multisig (Squads) — a prerequisite, not a
    nicety** — and alarm on `ConfigUpdated` (emitted by `update_config` and
    by `migrate_config`), treating a change to ANY of `gacha_wallet`,
    `gacha_usdc_account` or `fee_usdc_account` as a break-glass event rather
    than routine config.
  - Incident levers, least to most blunt: repoint `gacha_wallet` (disables
    both buybacks globally and moves the sweep rent away, while spins keep
    working — `purchase_pack` pins the separate `gacha_usdc_account`);
    `paused` (stops spins and buybacks for everyone); per vault, a cold-key
    `update_vault` session-key rotation. `allow_buyback_delegation` is
    **not** a brake here.
  - **The admin key reaches value on a second, independent path.**
    `update_config` also rewrites `gacha_usdc_account` and
    `fee_usdc_account`, and those two pins are the ONLY destination checks
    `purchase_pack` performs. One admin signature therefore diverts 100% of
    every FUTURE spin payment — principal and fee, every vault, Config being
    a singleton — to an attacker-owned USDC account, with no session key
    involved and no cap: users keep spinning, CC never credits the spins, and
    the money lands elsewhere. `MAX_FEE_BPS` bounds the fee rate, not this.
    Repointing `gacha_wallet` (above) is the buyback-side equivalent; both
    are one-step and untimelocked.
  - The fee corridor is admin-set, but hard-capped: `max_fee_bps` can never
    exceed `MAX_FEE_BPS` (10%), and `purchase_pack` re-checks the 10% ceiling
    against `amount` independently of what the config says. There is no
    analogous ceiling on the buyback path.
  - Admin handover is one-step and irreversible (`initialize_config` is
    `init` at fixed seeds and the config can never be closed or re-created),
    so a mistyped `new_admin` permanently freezes pause, the fee corridor,
    treasuries and `gacha_wallet`. Only ever set it to a multisig that has
    already proven it can sign a no-op `update_config` on devnet.
  - `initialize_config` is gated to the program's upgrade authority, so the
    admin slot cannot be front-run at deploy time.
- **Buyback scope** (Phase 2): `buyback_pnft`/`buyback_core` pin no
  collection or creator, so any NFT the user parks in the vault — not just CC
  prizes — is inside that blast radius. The phone must refuse to co-sign for
  an asset its inventory does not tag as a CC prize.
- **Client contract for CC-built transactions** (Phase 2): the phone's one
  signature covers the whole transaction, and CC builds it. The phone MUST
  decode it, display the `price` **argument** (not the API quote), and refuse
  any transaction carrying an instruction of this program other than the
  single buyback it is showing — consent is instruction-scoped, not
  transaction-scoped, and a bundled `purchase_pack` would be signed by the
  same session key and would send vault USDC to CC's treasury.
- **Collector Crypt itself**: for Core prizes CC holds collection-level
  `PermanentTransferDelegate`/`PermanentBurnDelegate`, so it can seize or
  burn them regardless of custody. For Core prizes the vault protects
  against key theft, not against CC.
- All PDAs derive from the owner key: with the owner on the card, losing the
  phone loses nothing; `close_vault` + re-`init_vault` with the same owner key
  restores access to anything delivered late.

## Cold-key transaction size

Tangem cards have a tighter message-size budget than Solana. Cold-signed
messages here are: a plain USDC transfer (deposit), `init_vault` (4 accounts),
`update_vault`, `withdraw_token` (6 accounts), `close_token_account`
(4 accounts), `withdraw_sol` (3 accounts), `close_vault` (2 accounts),
`withdraw_core` (7 accounts, a single CPI — far lighter than the pNFT path,
no compute-budget instruction needed), and `withdraw_pnft`.

**withdraw_pnft measured** (`programs/tangem-gacha-vault/tests/pnft.rs`,
18 accounts incl. the Metaplex
Foundation Rule Set that CC cards carry, + the REQUIRED compute-budget
instruction — the pNFT TransferV1 does not fit the default 200k CU):
**682-byte cold-signed message, 811-byte serialized transaction** (Solana cap
1232). The card's signing budget was confirmed at 928/964 bytes (28-07-2026),
so this fits with room to spare — no address lookup table and no
versioned-transaction support needed on the card side. Budget ≥300k CU for
the transaction.

The atomic buybacks are session-key-signed, not cold-signed, so the card
budget does not apply — but for the record, the full 22-account
`buyback_pnft` transaction measures 1128 bytes: inside the packet, no lookup
tables.

## Instructions, events and errors at a glance

Instructions (18): `initialize_config`, `update_config`, `migrate_config`,
`init_vault`, `update_vault`, `purchase_pack`, `approve_buyback`,
`revoke_buyback`, `clear_buyback_slot`, `buyback_pnft`, `buyback_core`,
`withdraw_token`, `withdraw_pnft`, `withdraw_core`, `withdraw_sol`,
`close_token_account`, `sweep_prize_ata`, `close_vault`. Signers by role:
`owner` — `init_vault`, `update_vault`, `withdraw_*`, `close_*`
(`init_vault`, `withdraw_pnft` and `withdraw_core` take a separate rent/fee
`payer` signer so the cold-signed message stays small); `session_key` —
`purchase_pack`, `approve_buyback`;
`session_key` + `cc_authority` — `buyback_pnft`, `buyback_core`; `owner` OR
`session_key` (`authority`) — `revoke_buyback`, `clear_buyback_slot`;
admin — `update_config`, `migrate_config`; anyone — `sweep_prize_ata`.
Discriminators, full account lists and argument types are in
`idl/tangem_gacha_vault.json`.

Events whose shape changed in this release: `VaultInitialized { vault, owner,
session_key }`, `SessionKeyRotated { vault, session_key }` (replaces the
former hot-delegate rotation event — new name, new discriminator),
`VaultClosed { vault, owner }`, `PackOpened { vault, owner, amount, fee, memo }`
(name and discriminator unchanged; one field renamed), `ConfigUpdated { admin,
gacha_wallet, gacha_usdc_account, fee_usdc_account, min_fee_bps, max_fee_bps,
paused, allow_buyback_delegation }` (discriminator unchanged).

Errors: the enum is append-only (6000–6024). New in this release: `6022
FeeBelowMinimum`, `6023 FeeAboveMaximum` (corridor ceiling or the 10% hard
cap), `6024 InvalidConfigAccount` (`migrate_config` given something that is
not a migratable `Config` image). `6003 InvalidFeeBps` now means "corridor
pair out of range" (`min > max` or `max > 1000`).

## Open questions to CC

Most integration questions were closed empirically on CC's dev backend
(vault-paid spins, off-curve `altPlayerAddress` and `altRecipient`,
`transferAuthority`, the no-closeAccount template) or answered directly
(rotating prize wallets, single gacha wallet for signing and rent cron, the
IDL-driven buyback endpoint). Still open:

1. **Written confirmation of the submission protocol** (proposed to CC in
   August 2026; Phase 2): CC builds (gacha wallet as fee payer, fresh
   blockhash) and partially signs → Tangem's endpoint validates against a
   whitelist, the phone displays the `price` argument and co-signs (tens of
   seconds) → CC submits and retries; on an expired blockhash CC rebuilds
   with a new memo.
2. **Final buyback memo format** (Phase 2). Our runs use
   `<slug>-<uuid>:buyback` (mirroring the spin's `:open`); the final
   convention is CC's call.
3. **Royalties rule set — standing dependency, to confirm at the first joint
   e2e** (Phase 2). mpl-core's Royalties plugin evaluates the OWNER PROGRAM
   of the transfer authority; ours is the vault PDA, owned by this program.
   CC's Core collection carries a permissive rule set today; if CC ever
   switches it to a `ProgramAllowList` that omits our program id, BOTH
   `withdraw_core` and `buyback_core` break for every vault — including the
   cold-key rescue path. CC's answer (19-08-2026): "I think our royalties
   rule will allow that" — to be confirmed live (our litesvm suites already
   pass against the real dumped CC collection with its live Royalties
   plugin), and the collection's plugins must not change without telling us.
4. Whether `altFundsRecipient` (turbo proceeds) is an owner wallet like
   `altRecipient`, and off-curve-safe. On Day 1 it is set to the owner
   wallet (on-curve), so only the owner-wallet semantics matter immediately;
   off-curve safety becomes relevant in Phase 2.
5. Physical redemption for vault-held prizes (Phase 2): burn-delegate path or
   eligibility after `withdraw_pnft` (see the roadmap section above).
6. Prod parity of the 17-07 webhook fixes — not asked; will be verified by a
   cheapest-pack probe before the mainnet launch.

## Mainnet TODO

**Layout freeze — decide before the first mainnet Config/Vault exists.**
These are free now and expensive later. `migrate_config` shows that a
singleton `Config` can be resized by one admin transaction; a `Vault` change
would need a migration per user, i.e. a per-user card tap or a permissionless
resize instruction, because `Vault` is allocated at exactly `8 + INIT_SPACE`:

- **Growth padding.** `Config` (176 B after this release) and `Vault` (179 B)
  have no growth padding beyond the two legacy `_reserved` fields (1 B in
  `Config`, 8 B in `Vault`), so any field that does not fit there forces a
  resize. `Vault`'s maximum serialization with both
  `Option<Pubkey>`s set is exactly 179 B, so adding any field later makes
  `Account::exit` fail for every existing vault. Append explicit padding
  (e.g. `[u8; 64]` / `[u8; 32]`) at the freeze.
- **Two-step admin handover** (`pending_admin` + `accept_admin`), since the
  current one-step write is irreversible.
- **`config.usdc_mint` is permanent** — written once in `initialize_config`,
  with no `update_config` parameter, no `close_config`, and `init` (not
  `init_if_needed`) at fixed seeds. A wrong mint is only recoverable by
  redeploying under a new program id, which changes every vault PDA. The
  program rejects a non-legacy-SPL mint at init; still verify the value by
  hand. Same care for `gacha_usdc_account` / `fee_usdc_account`: they are
  bare pubkeys validated only when `purchase_pack` runs. A malformed one
  halts spins — non-token account → 3007, wrong mint → 2014 on the very first
  spin. A well-formed USDC account owned by the wrong party is worse — spins
  keep succeeding and every payment silently goes to that owner instead of
  CC, so the failure surfaces only as CC not crediting the spins.
- **mpl-core wire format.** The two Core CPIs are hand-encoded (`data =
  [14, 0]` + a 7-meta account list) with no `mpl-core` crate dependency, so a
  Metaplex-side change to `TransferV1` would break both Core paths with no
  compile-time or Cargo.lock signal — and the tests could not catch it
  either, since they run the DUMPED program from `tests/fixtures/`. Covered
  by `./scripts/check_fixtures.sh`, which re-dumps all three upstream
  programs from mainnet-beta and exits non-zero on any hash change: **run it
  before every deploy.** Taking the `mpl-core` dependency and using its
  generated CpiBuilder would make this a compile-time check instead — worth
  doing at the mainnet freeze if the extra dependency is acceptable.

**Operational prerequisites:**

- Squads 2/2 on the upgrade authority (agreed with CC, to set up towards
  mainnet) and a multisig behind the admin key — see "Security model".
- Pin `config.gacha_wallet` to the wallet CC actually signs buybacks with
  (Phase 2).
- Cheapest-pack probe on prod to confirm webhook parity (open question 6).
- External audit before mainnet.

## Build & test

Requires Rust + Solana CLI (Agave) 2.x + Anchor 0.31.1.

```bash
# Building needs no keypair: declare_id! pins 29agFEru… and `anchor build`
# produces the same .so on any clone. The devnet/localnet program keypair is
# NOT committed (keys/ is gitignored; a clone has no keys/ at all). Only
# `anchor test` / a deploy need one:
#   - Tangem maintainers: copy the private keys/tangem_gacha_vault-keypair.json
#     to target/deploy/ BEFORE the first build (or `anchor keys list` shows a
#     freshly minted id that disagrees with declare_id!).
#   - external readers: `anchor keys sync` re-points declare_id!/Anchor.toml at
#     a keypair of your own for a local run — expected, just do not commit it.
anchor build              # → target/deploy/tangem_gacha_vault.so + IDL
                          # NB: the .so and IDL must be byte-identical to what
                          # gets deployed — re-verify the dump after redeploying.
yarn install
anchor test               # TS suite; needs a working solana-test-validator
```

**Compile status (verified):** `cargo check`, `cargo build-sbf`, and
`anchor build` all pass against anchor-lang 0.31.1 / anchor-spl 0.31.1 /
mpl-token-metadata 5.1.1, producing the ~685 KB deployable `.so` (684 792
bytes for this build) and the IDL. Only Anchor's standard benign warnings
remain. Note the SBF 4 KB stack limit: `BuybackPnft` is the widest context
(its accounts are Boxed for that reason) and its generated `try_accounts`
sits close to the limit — adding another `#[account(address = …)]` constraint
there overflows the frame (which is why the auth-rules program id is pinned
in the handlers).

**Execution tests:** in-process LiteSVM Rust tests run the real compiled `.so`
without a validator (run `anchor build` first so the `.so` exists):

- `cargo test --test smoke` — init_vault basics.
- `cargo test --test pnft` — the full pNFT lifecycle against the REAL
  mainnet-dumped Metaplex programs and the REAL CC rule set
  (tests/fixtures/, dump commands in Anchor.toml): approve_buyback →
  delegate TransferV1 (CC's buyback leg) → clear_buyback_slot →
  close_token_account; revoke_buyback; the one-live-delegate slot; the
  `allow_buyback_delegation` kill switch; cold-only withdraw_pnft + the
  cold-signed transaction size measurement.
- `cargo test --test caps` — `purchase_pack` spending caps, incl. the
  **UTC-day rollover** exercised by warping the LiteSVM `Clock`: a full-cap
  spin is refused within the same UTC day and allowed again after midnight;
  the per-spin cap; the memo bounds (empty / 256 / 257 bytes); a zero amount;
  and a wrong-mint treasury or fee treasury failing the very first spin.
- `cargo test --test sweep` — the permissionless rent sweep: a random caller
  closes an empty prize ATA and exactly its rent lands on the config-pinned CC
  wallet; non-empty / USDC / live-buyback-slot accounts and a substituted rent
  destination are refused; dust on the ATA does NOT block the sweep (CC still
  gets the rent, the excess stays in the vault, and the emitted
  `PrizeAtaSwept.rent_refund` is decoded and pinned to what CC received); and
  an account with a stuck SPL delegate — which `close_token_account` refuses —
  is sweepable, pinning the deliberate asymmetry between the two GC paths.
- `cargo test --test pnft` (buyback part) / `--test core` (buyback part) —
  the atomic `buyback_pnft`/`buyback_core`: happy paths against the real
  Metaplex programs, payment-failure atomicity (an underfunded CC account
  reverts the whole swap — the NFT stays), non-CC signer / missing
  session-key consent / paused / zero price / non-canonical vault USDC all
  refused; a buyback consumes a stale `approve_buyback` delegate
  and frees the slot.
- `cargo test --test core` — `withdraw_core` against the REAL mainnet mpl-core
  program and the REAL CC Core prize + collection accounts dumped from devnet
  (owner patched to the test vault): CC prizes are now MOSTLY Metaplex Core
  (per CC, 17-07-2026), which have no token accounts and ship unfrozen — a
  single-CPI owner transfer. TRUST NOTE: CC's Core collection carries
  PermanentTransferDelegate/PermanentBurnDelegate (authority = CC), so for
  Core prizes the vault protects against key theft, not against CC itself.

All suites load the REAL compiled `.so`, which `cargo test` never rebuilds.
`tests/common/mod.rs` guards that: it compares the binary's mtime against
`src/lib.rs` and `Cargo.toml`, and panics with ``run `anchor build` first``
rather than silently testing the previous build. The same module carries
`decode_event`, used to assert the shape of emitted events.

The full TypeScript suite is `anchor test` (23 tests: SPL-level auth/caps
logic, `purchase_pack` with an explicit `fee_amount`, the corridor boundary
rejections 6022/6023, `update_config` corridor validation, and the
`SessionKeyRotated` event). The corridor and the migration have their own
litesvm suite, `programs/tangem-gacha-vault/tests/fee.rs` (16 tests: pinned
Config layout and discriminators, corridor boundaries incl. the 10% backstop
against a planted config, `migrate_config` on a 174-byte legacy image, its
idempotence, admin gate and rejections, caps charged with `amount +
fee_amount`); `scripts/devnet/migrate_config.js` is the operational runbook
step for the live migration.

## Devnet quickstart against CC

- Devnet program `29agFEruMu2jedVwnDgKPuq7ejmTiB7sEqzdhufQQS9u` still runs
  the **previous** build (slot 487301012; 174-byte `Config`, `open_pack`);
  the redeploy of this build is pending. The committed IDL at
  `idl/tangem_gacha_vault.json` (regenerated into `target/idl` by
  `anchor build`) describes THIS build — keep the committed copy in sync on
  redeploys. The `Vault` layout (179 B) and the append-only error enum are
  the constraints on any change that must keep existing accounts valid; the
  `Config` layout is versioned by `migrate_config`.
- **Deploy ritual for this build:**
  1. `anchor build 2>&1 | tee build.log`, then
     `STACK_LOG=build.log ./scripts/check_fixtures.sh` (fixture drift +
     SBF stack guard).
  2. ⚠️ **Check the programdata size** before any redeploy. The binary has
     outgrown the account more than once (`solana program extend` costs
     non-refundable rent each time, ~0.23 SOL for +45000 at current devnet
     rent). Run
     `solana program show <id> --url devnet`, compare `Data Length` (750784
     as of the last deploy) with the local `.so` (684 792 bytes for this
     build — fits with ~66 KB spare), and when extending, extend with slack
     rather than exactly. The upgrade buffer costs the rent-exempt minimum
     for `.so size + 37` bytes (~3.5 SOL for this build at current devnet
     rent; check `solana rent <bytes> -u d`), refunded when the upgrade lands;
     a failed attempt leaves it in a buffer account — reclaim with
     `solana program close --buffers`.
  3. Tell CC the sweep cron will fail for a few minutes.
  4. `solana program deploy target/deploy/tangem_gacha_vault.so
     --program-id 29agFEruMu2jedVwnDgKPuq7ejmTiB7sEqzdhufQQS9u -k <upgrade
     authority keypair> -u d` — pass `-k` explicitly: the CLI default key is
     neither the upgrade authority nor funded.
  5. **Immediately** run `migrate_config` with the admin key — e.g.
     `MAX_FEE_BPS=500 node scripts/devnet/migrate_config.js` (planned devnet
     corridor: min 100 / max 500 bps). Until it lands, every
     `Config`-reading instruction, `sweep_prize_ata` included, fails with
     Anchor 3003. The call is idempotent, so re-running it is safe.
  6. Verify: `Config` is 176 bytes, `min_fee_bps` / `max_fee_bps` read as
     expected, then dump the program and compare it against the local `.so`;
     then update the slot and hash recorded under "Integration status".
- Reference scripts: `scripts/devnet/vault_spin.js` runs a vault-paid spin
  (`generatePack` → `purchase_pack` with the corridor floor as the fee →
  `openPack`); `scripts/devnet/vault_buyback_atomic.js` builds the atomic
  buyback transaction (the CC-side role);
  `scripts/devnet/vault_cosign_buyback.js` validates a built transaction
  against a whitelist and co-signs with the session key (the Tangem-side
  role).
- Base URL: `https://dev-gacha.collectorcrypt.com/api`
- Dev USDC mint: `Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr` (faucet:
  spl-token-faucet.com)
- Dev gacha wallet: `A4ahkivAG4NoZAE8Sy4qv8nn2DU9yoXRQcttuCeGtTJv`
- The x-api-key issued by CC sets our memo slug (attribution + rev-share
  filter).
- When decoding txs via public RPC, verify `signatures[0]` matches the
  requested signature — mainnet-beta was observed returning a wrong tx once.
