# Tangem Gacha Vault

Solana program for the Day 1 Tangem Collectibles integration with Collector
Crypt (CC). Each owner has a PDA vault with a USDC balance. A session key on
the phone pays for packs within owner-set limits; the owner authorizes
withdrawals, session-key rotation and vault closure. Prizes and turbo
proceeds go directly to the owner's wallet.

## Release and deployment status

This tree contains the **nine-instruction Day 1 program**, deployed to
**devnet on 2026-11-02** at
[`FKWs2cd5E9Fi8t2Gqbq6SkgekL4MJwZgkRMrGFcPGVvt`](https://explorer.solana.com/address/FKWs2cd5E9Fi8t2Gqbq6SkgekL4MJwZgkRMrGFcPGVvt?cluster=devnet),
slot `517670608`.
The deployed sBPF v3 executable matches the reviewed 367,392-byte artifact:
SHA-256 `6492ac4c8465d0724b8666fde81da1a0542f02f62253e75415208aa7954b4260`.
ProgramData is `Fqm28fSfaeCj6zPVjGBGdJq5kEiqz56HNnH4Bmq7fhg3`, with
400,000 bytes allocated for code and a verified zero-filled tail. Upgrade
authority is the devnet test signer
`CfzgiAsor8k46oAr1zLybapCbAK44892DYxBJUerNX31`. A separate mainnet
program id and deployment configuration are still to be selected.

The new Config was initialized and read back successfully on devnet:

| Parameter | Verified value |
|---|---|
| Config PDA | `2jrR9vtzhxYiuxB5aTKWQvgH8FVp3xcC9EinhMGwbsZt` |
| Admin | `CfzgiAsor8k46oAr1zLybapCbAK44892DYxBJUerNX31` |
| CC dev-USDC mint | `Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr` (legacy SPL, 6 decimals) |
| CC treasury token account | `9ZSgA3PMjeAU8K6CWzgJ8oDnhZwwSgHZu6KP3X95t7Jq` |
| Fee treasury token account | `9qsWLjBgicHNncaM1qtLb4jqj4a4NixMwvNXNmsqQyV9` (test admin's ATA) |
| Fee corridor / pause | 100–500 bps / `false` |

These are devnet test values, including the shared admin/sponsor/fee wallet.
The [initialization transaction](https://explorer.solana.com/tx/5Vu2oXojsH4VRgNQQpKcPn9N1vjLUoKEv5vdWUNZutR9xpsCoCS3dv2LpNQZJuefXF9RGfHpChr3eGYcyTixydU?cluster=devnet)
and decoded state are recorded locally in
`target/verification/day1-config/config.confirmed.json`.

The full custody implementation is preserved at Git tag **`custody-full`**
(commit `a00e8c8`). The existing devnet program
`29agFEruMu2jedVwnDgKPuq7ejmTiB7sEqzdhufQQS9u` remains that full release,
last recorded at slot `499213881`. It has not been upgraded to this tree.
Use the archived IDL for that program, not this tree's IDL.

Deployment evidence is recorded locally in
`target/verification/day1-devnet-deployment.json`. A devnet smoke completed
sponsored onboarding → 55 dev-USDC funding → `pokemon_50` purchase → Core
prize delivery to owner → withdrawal and account closure. The
[purchase](https://explorer.solana.com/tx/5b7UBj4UkzVeDbsumTR51LksRNDkaaEHNuUMAYdWA2rS4mmDX2XRN46TgLgG2YJ4gjoN8aPvn8tEcFBiS226Bpha?cluster=devnet)
paid 50 dev-USDC principal plus a 0.5 dev-USDC fee at slot `518023881`.
CC delivered [the Core prize](https://explorer.solana.com/address/GZFPHF4B5n3AK5QDpxKVVgnpemmHRMsiZ7U47A5UgTt6?cluster=devnet)
to the owner. The [cleanup](https://explorer.solana.com/tx/2xba458XJjRG55yQyzxaLVZReRS4328ZSWnfJdGqUHr44mDAsA7qDWbF2pQSUjxvqbJfj9D3iZHAxyvmHEJEzoJX?cluster=devnet)
returned the remaining 4.5 dev-USDC to the sponsor and 2,834,640 rent
lamports to the owner, closing both vault and ATA. The journal is
`target/verification/day1-smoke.json`.

Owner, session and sponsor were distinct software keys; owner/session held
zero SOL through purchase and prize delivery. The sponsor paid transaction
fees and onboarding rent. A separate purchase simulation used 26,903 CU
and left live state unchanged. This run did not exercise a Tangem card,
the mobile app, the central Gasless service, turbo or buyback. Mainnet
integration testing, external audit and public product launch remain
separate milestones.

## Scope and roles

```text
owner (Tangem card) ── owns ──► vault PDA ["vault", owner]
                                  └── canonical USDC ATA
session key (phone) ── purchase_pack ──► CC treasury + Tangem fee treasury
CC delivery ─────────────────────────► owner wallet
```

| Instruction | Required signer(s) | Purpose |
|---|---|---|
| `initialize_config` | upgrade authority, initially also admin | Set the mint, two treasury accounts and fee corridor |
| `update_config` | admin | Change admin, treasuries, fee corridor or purchase pause |
| `init_vault` | owner and separate payer | Create vault state and set session key/caps |
| `update_vault` | owner | Rotate the session key and/or change caps |
| `purchase_pack` | session key | Pay pack price and fee atomically |
| `withdraw_token` | owner | Transfer supported tokens from a vault-owned token account |
| `close_token_account` | owner | Close an empty, delegate-free token account; lamports go to owner |
| `withdraw_sol` | owner | Withdraw vault lamports above its rent-exempt balance |
| `close_vault` | owner | Close vault state; lamports go to owner |

A transaction also needs a fee payer. It may be a backend sponsor distinct
from both user keys. `init_vault` has a separate rent payer account, so
sponsored onboarding does not require SOL in the owner's wallet. The program
does not provide, fund or operate that sponsor.

There is no deposit instruction: fund the vault's canonical USDC ATA with a
normal token transfer. `init_vault` does not create that ATA; the client can
add its idempotent creation to the onboarding transaction.

The product uses a USDC balance, but `withdraw_token` and
`close_token_account` are intentionally generic owner-authorized token
operations. They do not read Config or enforce its USDC mint. There are no
Metaplex Core/pNFT transfer, delegation, buyback or redemption instructions.
An unsolicited Core asset or frozen pNFT sent to the vault has **no recovery
path in this program**. CC must deliver prizes to the owner wallet.

## Pack purchase and reconciliation

The backend requests `generatePack` with all recipient fields explicit:
`playerAddress = owner`, `altPlayerAddress = owner`, and, for turbo,
`altFundsRecipient = owner`. The session key is not the user's stable CC
identity. The CC API key stays on the backend.

The response's `memo` is a bare join key, such as `<slug>-<uuid>`. Obtain the
pack price from CC's authoritative response/transaction, then build a new
transaction with a top-level SPL Memo and
`purchase_pack(amount, fee_amount, memo)`. Both memo locations use the exact
same `join_key + ":open"`. The returned standard CC payment transaction is
not the vault payment transaction.

`purchase_pack` transfers `amount` to `config.gacha_usdc_account` and
`fee_amount` to `config.fee_usdc_account`, using the vault PDA as authority.
It checks the canonical source ATA, treasury addresses and mints, session
signature, pause, memo length (1–256 UTF-8 bytes), fee corridor and caps. Both
transfers and the cap update are atomic. A zero fee skips its transfer, but
the fee account must still exist and pass validation.

The eight accounts, in order, are `config`, `vault` (w), `session_key` (s),
`usdc_mint`, `vault_usdc` (w), `gacha_usdc` (w), `fee_usdc` (w),
`token_program`. Submit the custom payment through RPC, then continue CC's
`openPack`/status flow with the bare join key. CC must recognize inner token
transfers; the previous deployment's devnet integration demonstrated this,
and the current Day 1 devnet smoke reconfirmed payment recognition and Core
prize delivery to owner.

The program neither validates CC's pack price nor binds a memo to a prize
recipient. It also does not check that the top-level Memo exists or matches
the argument, and does not deduplicate a memo. The backend must store issued
join keys, prices, rates, expected owner and transaction signatures; compare
the actual memo and transfers; and confirm prize/turbo delivery to owner.

If submission is uncertain, establish the outcome before rebuilding a
payment. Resubmitting the **same signed transaction** is different from
signing a new transaction with the same memo: the latter can pay twice.
An `openPack` timeout is never a reason to pay again.

### Fees and spending limits

All amounts are integer base units; USDC has six decimal places. The backend
calculates `fee_amount = floor(amount * machine_rate_bps / 10_000)`.
The program enforces:

```text
0 <= min_fee_bps <= max_fee_bps <= 1000
floor(amount * min_fee_bps / 10_000) <= fee_amount
fee_amount * 10_000 <= amount * max_fee_bps
fee_amount * 10_000 <= amount * 1000
```

Multiplication uses `u128`. The maximum is equivalent to a floor-rounded
upper bound, including for small amounts. The exact per-machine rate is an
off-chain agreement: a custom client may choose any fee inside the corridor.
Reconcile `PackOpened.fee` against the rate recorded when issuing the memo.

Both `per_spin_cap` and `daily_cap` include `amount + fee_amount`.
`0 < per_spin_cap <= daily_cap` is required on vault creation and every cap
update. The daily counter resets lazily on the next purchase after the UTC
date changes. UI remaining budget is:

```text
today = floor(unix_timestamp / 86400)
remaining = day_index == today ? max(0, daily_cap - spent_today) : daily_cap
```

The limiter uses UTC calendar days, so a sliding 24-hour interval can span
two budgets. There is one session key, no expiry and no multi-device session
list. Owner-authorized close/recreate also resets vault state; caps bound
the session key, not the owner.

## Account layouts

Sizes and offsets include the eight-byte Anchor discriminator. Both layouts
are fixed-width, with 32 reserved bytes initialized to zero.

| Config offset | Field | Type |
|---|---|---|
| 0 | discriminator | `[u8; 8]` |
| 8 | `admin` | `Pubkey` |
| 40 | `usdc_mint` | `Pubkey` |
| 72 | `gacha_usdc_account` | `Pubkey` |
| 104 | `fee_usdc_account` | `Pubkey` |
| 136 | `min_fee_bps` | `u16` |
| 138 | `max_fee_bps` | `u16` |
| 140 | `paused` | `bool` |
| 141 | `bump` | `u8` |
| 142 | `_reserved` | `[u8; 32]` |

Config is **174 bytes**. Its mint is set once at initialization and must be
owned by legacy SPL Token. No instruction changes the mint or closes Config.

| Vault offset | Field | Type |
|---|---|---|
| 0 | discriminator | `[u8; 8]` |
| 8 | `owner` | `Pubkey` |
| 40 | `session_key` | `Pubkey` |
| 72 | `per_spin_cap` | `u64` |
| 80 | `daily_cap` | `u64` |
| 88 | `spent_today` | `u64` |
| 96 | `day_index` | `i64` |
| 104 | `bump` | `u8` |
| 105 | `_reserved` | `[u8; 32]` |

Vault is **137 bytes**. The old variable-length buyback slots are absent.
Reserved bytes support a deliberately compatible future layout change;
they do not automatically make an arbitrary upgrade compatible.

## Compatibility and deployment identities

| Area | Full custody release (`custody-full`) | Day 1 build |
|---|---|---|
| Program | Existing devnet `29agFEru…`, unchanged | Devnet `FKWs2cd5…`, deployed at slot `517670608`; separate mainnet id later |
| Instructions | 18 | 9 |
| Seven user instructions | Vault lifecycle, purchase and generic owner withdrawals | Same names, discriminators, arguments and account order/flags; different program/PDA addresses |
| `initialize_config` | Gacha wallet, two treasuries, corridor, delegation flag | Two treasuries and corridor only; same discriminator and account list |
| `update_config` | Eight optional arguments | Six: admin, two treasuries, min, max, paused; same discriminator and account list |
| Config | 176 B, custody fields | 174 B, new field order and 32 B reserve |
| Vault | 179 B allocation, optional buyback fields | 137 B fixed layout and 32 B reserve |
| `ConfigUpdated` | Custody fields included | Six fields; same event discriminator, new payload |
| Other retained events | User lifecycle/purchase/withdrawal events | Unchanged payloads |
| Error numbers | Includes custody and migration errors | Retained errors keep their numbers; deleted numbers are not reused |
| Migration | `migrate_config` for the old fee-corridor upgrade | No migration instruction; initialize new accounts under the new id |

Removed instructions: `approve_buyback`, `revoke_buyback`,
`clear_buyback_slot`, `buyback_pnft`, `buyback_core`, `withdraw_pnft`,
`withdraw_core`, `sweep_prize_ata`, `migrate_config`.

**Do not upgrade the old custody program in place with this build.** Its
accounts and active assets require the archived implementation. A new
program id derives new Config/Vault addresses and new vault ATAs; balances
and settings do not move automatically. Existing users can use the old
owner-authorized paths to withdraw, then onboard and fund the new vault.
An unsolicited NFT is not made recoverable by recreating a Day 1 vault.

Account/event discriminators alone do not identify the schema: struct and
event names were retained. Decode using the program id and the matching
release IDL. In particular, this 174-byte Config is not the older 174-byte
pre-corridor Config. For future upgrades at the same id, preserve the stored
layout and client ABI or design and test an explicit migration first.

## Owner operations and closure

Owner withdrawals, session rotation, token-account closure and vault closure
do not read Config and remain usable during a purchase pause. A token
withdrawal needs an existing destination token account of the same mint;
source and destination must differ. A SOL withdrawal must leave the vault's
rent-exempt minimum and cannot target the vault itself.

Before offboarding, stop issuing purchases, reconcile pending payments,
withdraw supported token balances, close empty token accounts, and then
close vault state. `close_vault` receives only the vault and owner: it
**cannot inspect token balances or discover external holdings** and can
succeed with assets still addressed to the PDA. Reinitializing with the same
owner and program id recreates that PDA and restores the supported owner
paths, but resets the session key and limits. Late arrivals and unsupported
NFTs therefore require explicit operational handling.

## Trust and operational controls

- A stolen session key can purchase within caps. Since recipient binding is
  off-chain, this can represent theft through attacker-chosen memos, not
  merely unwanted spending. Memo issuance, payment reconciliation and
  delivery monitoring are required parts of the integration.
- The owner is the root user authority. If both owner and session keys live
  on one compromised phone, the cold-key separation no longer applies.
- Admin can redirect future purchase and fee payments by changing the two
  treasury accounts. Account mint checks cannot prove the recipient is CC
  or Tangem. Admin handover is one-step; an incorrect key can strand config
  management. The admin cannot directly withdraw a vault's current balance.
- Upgrade authority controls program behavior, including PDA signing. Record
  the concrete admin/upgrade signers and governance for each deployment.
  The earlier mainnet plan used multisig admin and Squads 2/2 upgrade
  authority (Tangem + CC); it is not configured merely by building this code.
- `paused` stops purchases only. A session-key incident can be addressed by
  owner rotation; an unexpected config change requires reconciliation of
  the affected payments.

Prizes live on owner wallets. An optional owner-wallet CC buyback uses CC's
own transaction and the owner's signature, without a vault instruction.
Shipping/redemption is also a separate owner-wallet integration. Asset
standards, signing size/version support and CC eligibility must be checked
for those flows. Do not hard-code a 72-hour window: an October devnet probe
returned a different expiry. CC's collection-level control of Core assets
remains independent of this vault.

## Build and verification

Use the versions pinned in `Anchor.toml`, Cargo manifests/lockfile and the
JavaScript lockfile. Avoid a blanket dependency update: the existing Anchor,
Solana and LiteSVM versions must remain mutually compatible. Metaplex
fixtures and NFT-specific dependencies are not part of the Day 1 build.

The local/devnet program keypair is private and untracked:
`keys/tangem_gacha_vault-day1-keypair.json`. For a maintainer's local run,
copy that keypair to `target/deploy/tangem_gacha_vault-keypair.json` before
Anchor creates another identity. Mainnet uses a separate keypair.

An external clone needs no maintainer key. To use its own local identity,
generate a program keypair in the ignored build directory (do not overwrite
an existing keypair):

```bash
mkdir -p target/deploy
solana-keygen new --no-bip39-passphrase --silent \
  --outfile target/deploy/tangem_gacha_vault-keypair.json
solana-keygen pubkey target/deploy/tangem_gacha_vault-keypair.json
```

Use that public key in `declare_id!` in `programs/tangem-gacha-vault/src/lib.rs`,
both `[programs.localnet]` and `[[test.genesis]].address` in `Anchor.toml`,
and document that local identity separately in this README (and the private
`INTEGRATION.md`, if present). Keep the recorded devnet identities, slots and
hashes unchanged: changing the program id produces a different binary and
new PDAs. The generated local identity is not a deployed Tangem program;
the pinned devnet operational scripts below still target the existing
Tangem devnet deployment. Configure
`[provider].wallet` in `Anchor.toml` to an available local-test payer keypair.

Then run the build and checks below. The build regenerates the local IDL and
TypeScript types; copying the generated IDL updates its published address.
No test constants or archived ABI snapshots need changing for a new identity.

```bash
yarn install
mkdir -p target
set -o pipefail
anchor build 2>&1 | tee target/day1-build.log
python3 scripts/check_build.py --log target/day1-build.log --expect-sbpf 0
cp target/idl/tangem_gacha_vault.json idl/tangem_gacha_vault.json
cargo test -p tangem-gacha-vault
anchor test --skip-build
yarn tsc --noEmit
python3 scripts/verify_interface.py
```

`cargo test` loads the previously compiled SBF binary and does not rebuild
it. The shared test helper checks freshness; `VAULT_SBF_PATH` can select an
alternative binary for the Rust integration suites. `check_build.py` checks
the complete build log and ELF metadata, including stack warnings; use
`--binary <path>` when checking an artifact outside the default
`target/deploy/tangem_gacha_vault.so` location.

`verify_interface.py` checks the local IDL, schema, error numbers and retained
user ABI against `tests/abi/purchase_pack_release.json`, the committed
interface snapshot from `custody-full` commit `a00e8c8`. The check needs no
Git tag lookup or RPC. It also validates the internal integration guide when
that file exists. Binary, generated IDL and committed IDL must correspond to
the same source.

**Verified v0 build:** Anchor 0.31.1 with Solana CLI 2.2.19 produced a
413,144-byte sBPF v0 artifact (ELF flags 0), SHA-256
`933056097dd850f0ea5cc968967cc5a66d70b8d807022abe798d013eda60313d`.
The build guard, 31 Rust tests (30 integration + one unit), 24 TypeScript
tests, TypeScript type-check and offline interface verification passed.
These are local checks of the new Day 1 build. No transactions were sent to
devnet or mainnet as part of them.

**Verified v3 build:** the official Agave 4.4.0 distribution (bundled
`cargo-build-sbf` 4.5.0, platform-tools v1.57 / Rust 1.95) produced
`target/deploy-v3/tangem_gacha_vault.so`, 367,392 bytes, ELF flags 3, SHA-256
`6492ac4c8465d0724b8666fde81da1a0542f02f62253e75415208aa7954b4260`.
All 24 TypeScript integration tests passed against that exact binary on
`solana-test-validator` 4.4.0. Before the suite, the local program dump was
matched to the binary prefix and any trailing bytes were checked as zeros.

| Artifact | Build toolchain | Execution checks |
|---|---|---|
| sBPF v0, 413,144 B | Anchor 0.31.1, Solana CLI 2.2.19 | 31 Rust tests and 24 TypeScript tests passed |
| sBPF v3, 367,392 B | Anchor dependencies unchanged; Agave 4.4.0 distribution, cargo-build-sbf 4.5.0, platform-tools v1.57 | 24 TypeScript tests passed on validator 4.4.0; pinned LiteSVM cannot load this ELF |

The Rust tests are therefore **v0 runtime coverage**, not v3 execution
coverage. The pinned LiteSVM rejects v3 with `InvalidAccountData`;
`VAULT_SBF_PATH` selects a file but does not add runtime support. No Anchor
upgrade is included. Three TypeScript transaction sends now explicitly use
`preflightCommitment: "confirmed"` to match the provider's blockhash
commitment on the newer validator; this fixes the observed blockhash race
without adding retries.

To reproduce the v3 build, select the modern Agave binaries on PATH and
retain the same source/program id and generated/committed IDL used above:

```bash
export PATH="/path/to/agave/bin:$PATH"
mkdir -p target/deploy-v3
set -o pipefail
cargo-build-sbf \
  --manifest-path programs/tangem-gacha-vault/Cargo.toml \
  --arch v3 --tools-version v1.57 --sbf-out-dir target/deploy-v3 \
  -- --locked 2>&1 | tee target/day1-v3-build.log

AGAVE_BIN=/path/to/agave/bin \
ANCHOR_WALLET=/path/to/local-test-keypair.json \
V3_BUILD_LOG="$PWD/target/day1-v3-build.log" \
bash scripts/test_v3.sh
```

For a fully cached environment, add `--offline` before the `-- --locked`
separator. `test_v3.sh` verifies ELF metadata and IDL, starts an isolated
local validator on RPC/faucet ports 18999/19900 with dynamic ports
20000–20100, checks the loaded program bytes, runs the TypeScript suite and
cleans up the validator. `VAULT_SBF_PATH` can override its default v3
artifact path. Use a local-test payer keypair; the script sends no devnet or
mainnet transactions. These local runs do not establish CC live e2e or
external audit completion.

The deployment-specific scripts are
[`initialize_config.js`](scripts/devnet/initialize_config.js) and
[`day1_smoke.js`](scripts/devnet/day1_smoke.js). They pin the new devnet
program, test mint, treasury accounts and test signer; they cannot be reused
for another cluster or a locally generated program identity unchanged.

```bash
node scripts/devnet/initialize_config.js --check
node scripts/devnet/initialize_config.js --execute
node scripts/devnet/day1_smoke.js --setup
node scripts/devnet/day1_smoke.js --simulate
node scripts/devnet/day1_smoke.js --status
```

The initializer verifies the deployed artifact and exact Config settings;
an already matching Config is accepted without sending another transaction.
It never updates or migrates the old program's Config. Smoke setup creates
one vault with distinct owner/session/sponsor keys and funds it with 55
dev-USDC. `--simulate` checks a 50 dev-USDC purchase plus a 0.5 dev-USDC fee
without broadcasting that purchase. For a live CC run, supply `CC_API_KEY`
securely through the environment and run `--spin` before `--cleanup`.
`--cleanup` withdraws the remaining dev-USDC to the sponsor and closes the
vault/ATA; their rent goes to the owner. Cleanup ends this journaled run.
The initializer and smoke write durable transaction journals under
`target/verification`; an unresolved signature blocks a replacement payment.
Never delete a journal to retry a transaction.

`scripts/devnet/common.js` and `vault_spin.js` remain historical integration
helpers; `vault_spin.js` uses one key for owner/session and is not the
distinct-role sponsorship smoke. Before the first mainnet test, select the
program id, actual mint, both existing treasury token accounts, fee corridor,
admin/upgrade roles and sponsor; then initialize and verify those concrete
values. Record the deployed binary hash and slot after deployment, and run
the owner-onboarding → sponsored purchase → owner-delivery → withdrawal
flow against that deployment. Mainnet e2e does not replace the planned
external audit and fixes before product launch.

## Public repository mirror

The mirror workflow prepares a separate bare repository containing only
`main` and the explicitly allowed `custody-full` tag, when that tag is an
ancestor of `main`. It rewrites commit authors/committers and annotated-tag
taggers to the service identity and removes `.github` and `.gitignore` from
the published history. Rewriting changes commit/tag ids and removes old tag
signatures. Additional public tags require an explicit allowlist change.

Publication uses explicit refspecs rather than `--mirror`. The same atomic
push removes legacy `refs/original/*` and `refs/remotes/*` exported by the
old workflow, while retaining other remote branches, tags and PR refs.
This cleanup takes effect when the updated workflow runs; changing these
scripts locally does not change the public repository or erase cached objects.

The workflow first runs the local mirror regression tests. To run them
without publishing or using GitHub credentials:

```bash
python3 -m unittest discover -s scripts/tests -v
```
