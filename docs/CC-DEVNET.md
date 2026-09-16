# Collector Crypt on devnet — wiring sheet

Everything needed to run `buyback_core_v2` / `buyback_pnft_v2` against CC's live
devnet deployment. Read `cc_buyback-SPEC.md` next to this file for the wire
contract itself (digest preimage, account order, check order).

Verified against devnet on **2026-09-16**.

## CC's accounts

| What | Address |
|---|---|
| `cc_buyback` program | `CcBuyM7sDhedBGLZxivBvgZVdqzrQAG66KYHgnTTEpLF` |
| ↳ binary | `sha256 09c66589d9ead5fd37f30fa4ff1b89775b749de8a37e67043a74e305dacae012`, byte-identical to `tests/fixtures/cc_buyback.so` |
| `policy` PDA `[b"policy"]` | `6UjEiB4XzrFmxxfzchy95Vygaeo11uvstBYJTqDTbHjq` |
| `rent_vault` PDA `[b"rent"]` | `HypwMQDGznHy2h3mTwkTAViCnT11TxAFti1dpWeV4Vyk` |
| `policy.quote_signer` / `pauser` / `rent_destination` | `A4ahkivAG4NoZAE8Sy4qv8nn2DU9yoXRQcttuCeGtTJv` (CC's gacha wallet) |
| `policy.authority` | `daxsSgG4iPvhxWr2jrY76HKtRSjWjQLFveKHdmZKJFc` |
| Payment lane mint (devnet USDC, legacy SPL Token) | `Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr` |
| Lane treasury (`treasury_token`) | `9ZSgA3PMjeAU8K6CWzgJ8oDnhZwwSgHZu6KP3X95t7Jq` |
| SPL Memo (`memo_program`) | `MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr` |
| Address lookup table (pNFT path) | `HKv5pvGESQB7EQyzrypGyhJvP1YSn74uVx9mQWqEH9B8` (12 entries) |

One lane only on devnet, so `payment_mint` is always the address above. The lane
treasury is the same token account that receives `open_pack` payments: pack
revenue *is* the buyback float, which is what lets it always afford the cards it
sold.

### `policy.destinations` — the prize wallets

`destination_owner` comes from the quote and must be one of these six. CC picks
it from the inventory row for that card, so treat it as opaque and pass it
through; it is not always the wallet that awarded the card.

```
Lowovruwau5pKnA7yhGj3JiE5moXTsn7mGG6dU53S2z
MidJLFXyuVs6s7kKuc9BtwZ22jzJ9zNz6T32RKHen4u
HighMAxSUE24YG8YApCcZ9dio4N1Uuuu99rbixg4opgm
EpicazwKcqPdTAonDy4c1WDKAomUWkPSBpMbeqgAmMqr
LGNDksoD6WSHvr9jC2VupAxzWmcpp29Wu4tvJte62gh
Sport49Rgh4Vcjz5mW5euuoRLUTM7UJ6uiMpacj7Fu5
```

## Values for `initialize_config`

`rent_destination` is the one that has to match CC exactly. `cc_buyback` reads
the rent target off **its own** policy — deliberately, so no custody admin can
redirect CC's rent — and compares it against the closed-account sibling. Point
`config.rent_destination` anywhere else and every `nft`/`pnft` buyback reverts
with `RentNotReturned` while the `CloseAccount` itself succeeds.

```
usdc_mint            Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr
rent_destination     A4ahkivAG4NoZAE8Sy4qv8nn2DU9yoXRQcttuCeGtTJv
gacha_usdc_account   9ZSgA3PMjeAU8K6CWzgJ8oDnhZwwSgHZu6KP3X95t7Jq
fee_usdc_account     9qsWLjBgicHNncaM1qtLb4jqj4a4NixMwvNXNmsqQyV9   (yours)
fee_bps              100                                            (yours)
```

The last two are the values on your current live config, carried over for
continuity — they are Tangem's to set.

### The existing devnet config blocks this branch

The config at `53EDbBLB1sQuVv6aH7us9TQ7XSGXFijPmPdAGNcY8Y1d` is **176 bytes**:
the pre-freeze layout, written by the program currently deployed at
`29agFEruMu2jedVwnDgKPuq7ejmTiB7sEqzdhufQQS9u`. This branch's `Config` is 334
bytes and `Vault` is 307. `Config` is `init`-only at fixed seeds `[b"config"]`
with no `realloc` and no `close`, so deploying this branch over that account
leaves every instruction failing `AccountDidNotDeserialize`.

Cleanest route on devnet is a **fresh program id** for the v2 build, which also
keeps the v1 path alive for comparison. Nothing on CC's side has to change when
you do that: the lookup table holds CC's constants only, so this program's config
PDA travels in the transaction's static keys and a new program id costs 31 bytes,
not a table amendment. (An earlier cut of the table did include the config PDA of
`29agFEru…`; it was dropped for exactly this reason, since table entries are
append-only and a frozen table could never have followed you.)

Recreating vaults needs a `cold_owner` signature — a physical card tap per user
— so plan the devnet test users around that.

## Per-standard client contract

| `nft_standard` | Instruction | Transaction | Compute | Rent leg |
|---|---|---|---|---|
| `core` | `buyback_core_v2` | legacy fits — 1046 bytes, 18 accounts | 250k | none — a Core asset owns no token account |
| `pnft`, `nft` | `buyback_pnft_v2` | **v0 + the lookup table required** — 27 accounts, 1383 bytes legacy against the 1232-byte cap, 1047 with the table | 500k | 1,488,440 lamports back to `rent_destination`; the handler's `CloseAccount` on the emptied prize ATA already does it |
| `cnft-core` | **not supported** | — | — | — |

`cnft-core` is the real gap, and it is on this side: `cc_buyback` recognises a
bubblegum `transferV2` in the sibling list (it is the strongest delivery proof of
the three — bubblegum has already verified the Merkle proof), but this vault has
no bubblegum instruction, so a compressed prize can neither be transferred out
of a vault nor sold back. CC's devnet Mid pool currently holds 77 of them
against 10,013 `core` and 993 `pnft`. Either CC keeps `cnft-core` out of
Tangem-facing inventory, or the vault gains a bubblegum leg.

## Transaction the phone builds

```
[0] ed25519 quote instruction   <- verbatim from the API response
[1] ComputeBudget::SetComputeUnitLimit(250_000 | 500_000)
[2] (optional) create vault_usdc ATA, idempotent
[3] buyback_core_v2 | buyback_pnft_v2
```

The ed25519 instruction must be **top level**, exactly one per transaction, and
its offsets must all be `u16::MAX` — the API's `ed25519Instruction` is already
built that way, so pass its `data` through unmodified. No memo instruction is
needed: `cc_buyback` CPIs SPL Memo itself with the quote's memo, which is what
CC's settlement webhook keys on.

## Getting a quote

`POST https://dev-gacha.collectorcrypt.com/api/buyback` with your scoped API
key and:

```json
{ "playerAddress": "<vault PDA>", "nftAddress": "<asset>", "sellerProgram": "<vault program id>" }
```

`sellerProgram` is what selects quote mode; it is recorded for reporting only,
since `cc_buyback` has no caller allow-list. `playerAddress` must be the current
on-chain holder — the vault PDA, not the cold owner — and it becomes
`seller_authority` in the digest, so `seller_token` must be owned by it.

Response, under `quote`:

| Field | Use |
|---|---|
| `ed25519Instruction` | instruction `[0]` above |
| `price`, `quoteId`, `expiresAt`, `memo` | the four `authorize_and_pay` arguments, in that order |
| `destinationOwner` | `destination_owner` |
| `paymentMint`, `treasury` | `payment_mint`, `treasury_token` |
| `quoteMarker`, `rentVault` | `cc_quote_marker`, `cc_rent_vault` |
| `memoProgram`, `tokenProgram` | pinned program accounts |
| `standard` | which of the two handlers to call |
| `computeUnitLimit` | instruction `[1]` |
| `addressLookupTable` | the table to resolve against (`null` until CC sets it in the environment; the literal is in the table above) |
| `hash` | the digest, base58 — useful for correlating with CC's row |

Quotes live `QUOTE_TTL_SECONDS = 600`. Re-requesting identical terms inside that
window returns the **same** quote rather than a new one, so a retry after a
wallet rejection or an expired blockhash is free. Two live quotes for one card
cannot both pay: the card can only be delivered once.

## Errors you will actually hit

| Code | Name | Cause |
|---|---|---|
| 6003 | `QuoteExpired` | past `expires_at`; request a new quote |
| 6006 | `DestinationNotAllowed` | `destination_owner` not in `policy.destinations` |
| 6025 | `AssetNotDelivered` | no processed sibling moved this asset to this destination — wrong order, wrong destination, or the transfer is not one of the three recognised shapes |
| 6027 | `QuoteAlreadyUsed` | the `[b"quote", digest]` marker exists; this quote already paid |
| 6029 | `LaneNotFound` | `payment_mint` has no lane |
| 6030 | `RentNotReturned` | `nft`/`pnft` only — no `CloseAccount` or ≥1,488,440-lamport transfer to `policy.rent_destination` |

A spent marker is closable by anyone 1800 seconds after `expires_at`, not at
expiry: it is the only receipt a quoted buyback produces, and CC's reconcile
cron reads its absence as proof the quote never paid.

## Checking CC's side before you debug yours

```bash
solana account 6UjEiB4XzrFmxxfzchy95Vygaeo11uvstBYJTqDTbHjq -u d   # policy: paused, lanes, destinations
bash scripts/build-sbf.sh && STACK_LOG=build.log scripts/check_fixtures.sh
```

`check_fixtures.sh` now diffs `tests/fixtures/cc_buyback.so` against the live
devnet program, so a green run means the binary you tested against is the one
you will transact against.

Two things on CC's side stop a buyback with no on-chain trace: the lane's
spl-token delegate allowance running out (`AllowanceExhausted`, and the quote
endpoint 503s before signing), and `policy.paused`. Both are CC's to clear.
