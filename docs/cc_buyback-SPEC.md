<!--
Vendored copy of Collector Crypt's cc_buyback wire contract.

It describes the program at CcBuyM7sDhedBGLZxivBvgZVdqzrQAG66KYHgnTTEpLF on
devnet — sha256 09c66589d9ead5fd37f30fa4ff1b89775b749de8a37e67043a74e305dacae012,
byte-identical to tests/fixtures/cc_buyback.so, which every litesvm test here
runs. CC's copy is authoritative; refresh this one and the fixture together.
Live addresses and the devnet bring-up are in CC-DEVNET.md.
-->

# cc_buyback — wire contract

Authoritative definition of the quote digest and the `authorize_and_pay` ABI.
Both this program and every integrating custody program compile against this file.
Changing anything here is a breaking change: bump `QUOTE_DOMAIN`.

**v2** — the caller allow-list and `seller_nonce` are gone, `payment_mint` is signed, and
payment is now conditional on the card having already moved. See *Trust boundary*.

## Quote digest

CC's quote signer signs a 32-byte SHA-256 digest. The preimage never goes on the wire —
the program recomputes it from accounts and arguments it already holds.

```
digest = SHA256(
    QUOTE_DOMAIN          19 bytes  b"cc-buyback-quote-v2"
    cc_buyback_program    32        this program's id
    seller_authority      32        the PDA or wallet that owns the asset
    asset                 32        AssetV1 (Core), mint (pNFT/NFT), asset id (cNFT)
    destination_owner     32        where the asset goes; must be allow-listed
    payment_mint          32        which payment lane settles it
    price                  8        u64 LE, in payment-mint base units
    expires_at             8        i64 LE, unix seconds
    quote_id               8        u64 LE, buyback_txns.id
    memo                   N        UTF-8, unpadded, <= 256 bytes
)
```

Field-by-field rationale, and what each one stops:

| Field | Stops |
|---|---|
| `QUOTE_DOMAIN` | A signature from another protocol being replayed here |
| `cc_buyback_program` | Replay against a different deployment of this program |
| `seller_authority` | The quote being spent by a seller it was not issued to |
| `asset` | Being spent against a different, more valuable card |
| `destination_owner` | The asset being routed somewhere else |
| `payment_mint` | A quote priced in USDC drawing on the CASH treasury — see below |
| `price` | Amount tampering |
| `expires_at` | Indefinite spendability after a signer leak |
| `quote_id` | Ambiguity when two quotes exist for one seller |
| `memo` | Decoupling the on-chain swap from CC's reconciliation row |

This mirrors `QUOTE_TYPES` in `lib/evm/quote.ts` one-for-one, plus `memo` (Solana
reconciles off a memo instruction, EVM off events). `payment_mint` is the direct
analogue of `token` in `Quote(seller,token,tokenId,amount,deadline,quoteId)`.

### Why `payment_mint` is signed

The policy carries up to 8 payment lanes, because the gacha wallet holds USDC, USDT,
CASH and RIP in separate token accounts and a spl-token delegate is a property of the
TOKEN ACCOUNT — so one policy PDA is delegate on all of them at once. Without the mint
in the preimage, a quote for 25 USDC would be redeemable against the CASH treasury for
25 CASH. CC's EVM vault learned this first: its signed quote carries the token too.

### Replay: a per-quote marker, not a client-side counter

`authorize_and_pay` creates a PDA at `[b"quote", digest]` and refuses if one already
exists. Existence means "this quote paid" — spl-token's `quoteUsed[quoteId]` with a PDA
instead of a map. **There is no client contract.** No integrating program has to keep a
counter, which is what lets a generic smart wallet integrate at all.

This is not the design the v1 spec argued for, and the arithmetic that rejected it was
wrong. A marker only has to outlive `expires_at` plus the window CC needs to read it as a
receipt — after that the quote fails the expiry check anyway — so `close_quote_marker` is
permissionless past that point and refunds the rent to the `[b"rent"]` vault. At
`QUOTE_TTL_SECONDS = 600`, `MARKER_CLOSE_DELAY = 1800` and 10k buybacks/day, a marker
lives at most 45 minutes and steady state is ~312 live markers, about 0.23 SOL **parked**,
not spent. The old $690k–$1.1M/yr figure assumed a permanent marker.

A per-*seller* counter was the alternative and is worse here: it serialises a wallet's
buybacks. `app/components/BuyBacks/index.tsx` quotes every selected card in one
`Promise.all`, so N quotes would read counter N and exactly one could land.

Marker creation is **transfer → allocate → assign**, not `create_account`: anyone can
send lamports to a derivable address, and `create_account` fails on an already-funded
one. Only the shortfall is topped up.

## Ed25519 verification

The transaction carries a top-level Ed25519 precompile instruction. `authorize_and_pay`
reads it through the instructions sysvar and requires:

- exactly **one** ed25519 instruction in the transaction
- `num_signatures == 1`
- every `*_instruction_index == u16::MAX` — the offsets must point inside the ed25519
  instruction's own data, never at another instruction
- `pubkey == policy.quote_signer`
- `message == digest`

The `u16::MAX` requirement is load-bearing. Without it an attacker points the offsets at
a different instruction's bytes and gets a valid-looking verification over data the
program never checked.

Ed25519 instruction data layout:

```
offset  0   u8    num_signatures
offset  1   u8    padding
offset  2   u16   signature_offset
offset  4   u16   signature_instruction_index
offset  6   u16   public_key_offset
offset  8   u16   public_key_instruction_index
offset 10   u16   message_data_offset
offset 12   u16   message_data_size
offset 14   u16   message_instruction_index
offset 16   ..    pubkey (32) | signature (64) | message (N)
```

## `authorize_and_pay`

```rust
authorize_and_pay(
    price: u64,
    quote_id: u64,
    expires_at: i64,
    memo: String,
)
```

| # | Account | Signer | Writable | Constraint |
|---|---|---|---|---|
| 0 | `policy` | | | PDA `[b"policy"]`; also the spl-token delegate |
| 1 | `seller_authority` | yes | | a PDA signing via its caller's `invoke_signed`, or a wallet signing directly. Its owner is NOT inspected |
| 2 | `asset` | | | matched against the sibling transfer; never read or written |
| 3 | `destination_owner` | | | must be in `policy.destinations` |
| 4 | `treasury_token` | | yes | `== policy.lanes[payment_mint].treasury`; owner stays CC's wallet |
| 5 | `seller_token` | | yes | receives the payment; owner must be `seller_authority` |
| 6 | `payment_mint` | | | must have a lane in `policy.lanes` |
| 7 | `sysvar_instructions` | | | pinned |
| 8 | `quote_marker` | | yes | PDA `[b"quote", digest]`; must be empty on the way in |
| 9 | `rent_vault` | | yes | PDA `[b"rent"]`; funds the marker |
| 10 | `system_program` | | | |
| 11 | `token_program` | | | |
| 12 | `memo_program` | | | pinned to SPL Memo; appended last so every index above is stable |

`quote_marker` cannot carry a `seeds =` constraint: the digest is not known until it is
recomputed in step 12, so the handler checks the address itself.

Checks run in this order; the order is the security property.

1. `sysvar_instructions` is the real sysvar
2. `!policy.paused`
3. `price > 0`
4. `memo` non-empty and `<= MAX_MEMO_LEN`
5. `now <= expires_at`
6. `seller_authority.is_signer`
7. **delivery** — a processed sibling transferred `asset` to `destination_owner`
8. **rent return, nft/pnft only** — a processed sibling gave back the token-account rent
9. `destination_owner` is in `policy.destinations`
10. lane lookup: `payment_mint` is listed, and `treasury_token` is that lane's treasury
11. **float, checked before the transfer** — delegate is `policy`,
    `delegated_amount >= price`, `amount >= price`
12. recompute the digest; verify the ed25519 instruction
13. marker `[b"quote", digest]` is empty, then create it
14. `transfer_checked` treasury → seller, signed by `policy` as delegate
15. `emit!(SoldBack { digest, .. })`

**Step 8 is easy to miss and fails closed.** CC funds the destination token account when it
awards an `nft` or `pnft`, so a buyback of one owes that rent back in the same transaction or
the gacha wallet bleeds it. Two accepted shapes, both read off the processed-sibling list:

- spl-token `CloseAccount` on the emptied prize account, paying out to `policy.rent_destination`
- a System `Transfer` to `policy.rent_destination` of at least the rent-exempt minimum for a
  165-byte token account — read live from the rent sysvar, currently 1,488,440 lamports

`rent_destination` is the gacha wallet (`/api/getGachaWalletPubkeys`). Miss this and redemption
reverts with `RentNotReturned`. `core` and `cnft-core` own no token account, owe nothing, and are
exempt — charging them would invent a fee.

Step 7 before step 14 is what replaces the v1 client contract: the caller cannot be paid
without having already delivered. Step 11 before step 14 keeps the EVM ordering invariant
— a short allowance fails with a clear error instead of half-completing — though within a
single transaction either ordering is atomic.

## `close_quote_marker`

```rust
close_quote_marker()   //  0 quote_marker (mut, close = rent_vault)
                       //  1 rent_vault   (mut, PDA [b"rent"])
```

Permissionless, and gated on `now > marker.expires_at + MARKER_CLOSE_DELAY`, where the
delay is **1800 seconds**. Replay stops at `expires_at` either way — `authorize_and_pay`
refuses a stale quote — so the extra window costs only parked rent. It exists because the
marker is the only receipt a quoted buyback produces, and CC's reconcile cron reads its
ABSENCE after expiry as proof the quote never paid: close it at `expires_at` and a buyback
that settled near the deadline with a missed webhook loses its receipt before the cron
sees it. The delay must exceed that cron's 600-second grace window.

The refund goes to the rent vault rather than to whoever closed it, so it cannot be farmed.

## Trust boundary

This program **never touches an NFT**. It verifies a quote, confirms the card already
moved, and moves the payment token. A total compromise of it cannot move a card — which
is stronger than the EVM side, where a compromised `GachaVault` can pull anything with an
outstanding `approve`.

**It trusts no caller.** There is no client allow-list. `GachaVault.sellBack` has none
either: `msg.sender` may be any EOA or any contract, because what makes a caller harmless
is that the card has to arrive, not who they are. Any program — or a plain wallet doing
three top-level instructions — may present a quote it can satisfy.

The v1 spec took the other route: pay first, and trust an allow-listed program to move the
card afterwards. That was unsound as soon as an integrator was a *generic* wallet rather
than a purpose-built vault. Neither Tangem nor Crossmint is ours, and a Crossmint wallet
executes whatever instruction list its owner hands it — so an allow-listed user could
submit `[ed25519, ExecuteTransaction → cc_buyback]`, omit the transfer, and keep the card.
Repeatable per card, up to the delegate allowance.

### Delivery check

`authorize_and_pay` requires that a transfer of THIS asset to THIS `destination_owner`
already completed **in this transaction**, read from `get_processed_sibling_instruction`.
The list only contains successfully processed siblings, and both supported shapes put the
transfer and this CPI under the same parent:

```
custody program / ExecuteTransaction        depth 1
  ├─ transfer  asset -> destination_owner   depth 2   <- must come first
  └─ cc_buyback::authorize_and_pay          depth 2
```

Recognised transfers, one row per `hashlists.nft_standard`:

| Standard | Program | Data prefix | Destination | Asset identified by |
|---|---|---|---|---|
| `core` | mpl-core | `[14, 0]` | `accounts[4]` | `accounts[0]` |
| `pnft`, `nft` | mpl-token-metadata | `[49, 0]` | `accounts[3]` | `accounts[4]` (mint) |
| `cnft-core` | bubblegum | `[119,40,6,235,234,221,248,49]` | `accounts[5]` | `PDA(["asset", accounts[6], nonce])` |

Optional accounts in these instructions are passed as the program id rather than omitted,
which is what keeps those indices stable.

**Why a sibling and not the end state.** "Is the card at `destination_owner` now" is true
whenever the card is in the pool — including when it was never this seller's. CC re-pools
a card on buyback and `webhook_confirmed` lags behind settlement, so there is a real
window in which a second seller could be paid for a card they never held.

cNFTs are the strongest case here, not the weakest. A compressed NFT has no account to
read, but a bubblegum `transferV2` appearing in the sibling list means bubblegum already
verified the Merkle proof, the current leaf owner and the delegate, and rewrote the root.
This program inherits that without touching a single proof account. Note `nonce` sits at a
VARIABLE offset — 106, 107, 138 or 139 — because two `Option`s precede it.

## Bound on the hot signer

The quote signer **is the gacha wallet key** (`GACHA_WALLET_PRIVATE_KEY`, `lib/ccQuote.ts`),
so it does hold funds and does send transactions — what it cannot do is move a card, since
prize wallets sign their own transfers. Key separation is therefore NOT the bound here. The
bound is the allowance: a quote can authorise payment only up to the outstanding spl-token
delegate allowance on the lane's treasury — the direct analogue of `sellBack` being bounded by `balanceOf(vault)` on EVM,
where the lane float is the cap. There is deliberately no per-swap price ceiling.

Treat `delegated_amount` as a **rate limit, not a budget**. The allowance is decremented
only when the signing authority IS the delegate (`spl-token-2022/src/processor.rs`), so
the gacha wallet spending millions a day with its own key never draws it down; only
cc_buyback's own payouts do. At zero the delegate auto-clears, so it needs periodic
re-approval, and an exhausted allowance 503s every quote.

Two operational rules follow:

- **Monitor remaining allowance per lane.** It is a live dependency, not a setup step.
- **Nothing else may call `approve` on a lane treasury.** A token account has one delegate
  slot; a second `approve` silently replaces cc_buyback's and quotes start refusing.

Mitigations, fastest first: the `emergency_stop` KV switch (off-chain, instant), the
`pauser` key (`set_paused`, one signature), `remove_lane` for one token, and Squads
rotation of `quote_signer`.
