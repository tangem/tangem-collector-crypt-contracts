// One bounded Day 1 devnet smoke run, with distinct owner/session/sponsor keys.
// node scripts/devnet/day1_smoke.js --setup
// node scripts/devnet/day1_smoke.js --simulate   # NO purchase is broadcast
// CC_API_KEY=... node scripts/devnet/day1_smoke.js --spin
// node scripts/devnet/day1_smoke.js --cleanup
// node scripts/devnet/day1_smoke.js --status
// Never delete the journal to retry a payment. Reconcile its signature first.
const fs = require("fs");
const path = require("path");
const assert = require("node:assert/strict");
const {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
} = require("@solana/web3.js");
const {
  getAccount,
  getMint,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  decodeTransferInstruction,
  decodeTransferCheckedInstruction,
  TokenInstruction,
  unpackAccount,
} = require("@solana/spl-token");
const {
  REPO,
  RPC,
  KEY,
  USDC,
  GACHA_WALLET,
  GACHA_USDC,
  MEMO_PROG,
  TOKEN_PROG,
  MPL_CORE_PROG,
  anchor,
  post,
  sleep,
} = require("./common");

const PROGRAM = new PublicKey("FKWs2cd5E9Fi8t2Gqbq6SkgekL4MJwZgkRMrGFcPGVvt");
const GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const SPONSOR = new PublicKey("CfzgiAsor8k46oAr1zLybapCbAK44892DYxBJUerNX31");
const SPONSOR_USDC = new PublicKey(
  "9qsWLjBgicHNncaM1qtLb4jqj4a4NixMwvNXNmsqQyV9",
);
const JOURNAL = path.join(REPO, "target", "verification", "day1-smoke.json");
const PRINCIPAL = 50_000_000n;
const FEE = 500_000n;
const FUNDING = 55_000_000n;
const PER_SPIN_CAP = 300_000_000n;
const DAILY_CAP = 1_000_000_000n;
const bn = (n) => new anchor.BN(n.toString());
const now = () => new Date().toISOString();

// Flush before rename so a signed transaction is durable before RPC submission.
function saveJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(temp, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value, null, 2) + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, file);
  const dir = fs.openSync(path.dirname(file), "r");
  try {
    fs.fsyncSync(dir);
  } finally {
    fs.closeSync(dir);
  }
}

function loadKey(name, create) {
  const file = path.join(REPO, "keys", name);
  if (!fs.existsSync(file)) {
    if (!create)
      throw new Error(
        `Missing key file ${name}; do not replace keys for an existing journal`,
      );
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const key = Keypair.generate();
    const fd = fs.openSync(file, "wx", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(Array.from(key.secretKey)) + "\n");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return key;
  }
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8"))),
  );
}

function loadContext(phase) {
  assert.equal(
    RPC,
    "https://api.devnet.solana.com",
    "Only the fixed devnet RPC is allowed",
  );
  const existing = fs.existsSync(JOURNAL);
  const journal = existing
    ? JSON.parse(fs.readFileSync(JOURNAL, "utf8"))
    : null;
  if (!existing && phase !== "setup")
    throw new Error("Run --setup first; no smoke journal exists");
  const sponsor = loadKey("devnet-player.json", false);
  const owner = loadKey(
    "devnet-day1-smoke-owner.json",
    !existing && phase === "setup",
  );
  const session = loadKey(
    "devnet-day1-smoke-session.json",
    !existing && phase === "setup",
  );
  assert(sponsor.publicKey.equals(SPONSOR), "Unexpected devnet sponsor");
  assert.equal(
    new Set([sponsor, owner, session].map((k) => k.publicKey.toBase58())).size,
    3,
    "Owner, session and sponsor must be different keys",
  );
  const conn = new Connection(RPC, "confirmed");
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(sponsor), {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  const idl = JSON.parse(
    fs.readFileSync(path.join(REPO, "idl", "tangem_gacha_vault.json"), "utf8"),
  );
  assert.equal(
    idl.address,
    PROGRAM.toBase58(),
    "The smoke requires the new Day 1 program ID",
  );
  assert.equal(idl.instructions.length, 9, "The smoke requires the Day 1 IDL");
  const program = new anchor.Program(idl, provider);
  const [config] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    PROGRAM,
  );
  const [vault] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), owner.publicKey.toBuffer()],
    PROGRAM,
  );
  const vaultUsdc = getAssociatedTokenAddressSync(USDC, vault, true);
  const identity = {
    version: 1,
    rpc: RPC,
    genesis: GENESIS,
    program: PROGRAM.toBase58(),
    config: config.toBase58(),
    sponsor: SPONSOR.toBase58(),
    owner: owner.publicKey.toBase58(),
    session: session.publicKey.toBase58(),
    vault: vault.toBase58(),
    vaultUsdc: vaultUsdc.toBase58(),
  };
  if (journal) {
    for (const [key, value] of Object.entries(identity))
      assert.equal(journal[key], value, `Journal ${key} mismatch`);
  }
  const ctx = {
    conn,
    program,
    sponsor,
    owner,
    session,
    config,
    vault,
    vaultUsdc,
    journal: journal || { ...identity, createdAt: now(), transactions: {} },
    save() {
      saveJson(JOURNAL, this.journal);
    },
  };
  if (!existing) ctx.save();
  return ctx;
}

function checkToken(account, authority, label, isSource = true) {
  assert(account.mint.equals(USDC), `${label}: wrong mint`);
  assert(account.owner.equals(authority), `${label}: wrong authority`);
  assert(
    account.isInitialized && !account.isFrozen,
    `${label}: uninitialized or frozen`,
  );
  // CC controls its receive-only treasury and already has a delegate there.
  // Only accounts whose funds this smoke spends must have no outside control.
  if (isSource) {
    assert.equal(account.delegate, null, `${label}: unexpected delegate`);
    assert(
      !account.closeAuthority || account.closeAuthority.equals(authority),
      `${label}: unexpected close authority`,
    );
  }
}

async function checkConfig(ctx, requireUnpaused = false) {
  const [cfg, mint, gacha, sponsorToken, info] = await Promise.all([
    ctx.program.account.config.fetch(ctx.config),
    getMint(ctx.conn, USDC, "confirmed", TOKEN_PROG),
    getAccount(ctx.conn, GACHA_USDC, "confirmed", TOKEN_PROG),
    getAccount(ctx.conn, SPONSOR_USDC, "confirmed", TOKEN_PROG),
    ctx.conn.getAccountInfo(PROGRAM, "confirmed"),
  ]);
  assert(info?.executable, "New Day 1 program is not deployed");
  assert(cfg.admin.equals(SPONSOR), "Unexpected Config admin");
  assert(cfg.usdcMint.equals(USDC), "Config mint mismatch");
  assert(
    cfg.gachaUsdcAccount.equals(GACHA_USDC),
    "Config CC treasury mismatch",
  );
  assert(
    cfg.feeUsdcAccount.equals(SPONSOR_USDC),
    "Config fee treasury mismatch",
  );
  assert.equal(
    cfg.minFeeBps,
    100,
    "This smoke assumes the agreed 1% minimum fee",
  );
  assert.equal(
    cfg.maxFeeBps,
    500,
    "This smoke assumes the agreed 5% maximum fee",
  );
  if (requireUnpaused) assert.equal(cfg.paused, false, "Config is paused");
  assert.equal(mint.decimals, 6, "Unexpected USDC decimals");
  assert(getAssociatedTokenAddressSync(USDC, GACHA_WALLET).equals(GACHA_USDC));
  assert(getAssociatedTokenAddressSync(USDC, SPONSOR).equals(SPONSOR_USDC));
  checkToken(gacha, GACHA_WALLET, "CC treasury", false);
  checkToken(sponsorToken, SPONSOR, "Sponsor/fee treasury");
  return { cfg, sponsorToken };
}

async function readVault(ctx) {
  const [vault, token, ownerLamports, sessionLamports] = await Promise.all([
    ctx.program.account.vault.fetch(ctx.vault),
    getAccount(ctx.conn, ctx.vaultUsdc, "confirmed", TOKEN_PROG),
    ctx.conn.getBalance(ctx.owner.publicKey, "confirmed"),
    ctx.conn.getBalance(ctx.session.publicKey, "confirmed"),
  ]);
  assert(vault.owner.equals(ctx.owner.publicKey), "Vault owner mismatch");
  assert(
    vault.sessionKey.equals(ctx.session.publicKey),
    "Vault session mismatch",
  );
  assert.equal(vault.perSpinCap.toString(), PER_SPIN_CAP.toString());
  assert.equal(vault.dailyCap.toString(), DAILY_CAP.toString());
  checkToken(token, ctx.vault, "Vault USDC");
  return { vault, token, ownerLamports, sessionLamports };
}

async function reconcile(ctx, name) {
  const row = ctx.journal.transactions[name];
  if (!row) return false;
  if (row.state === "confirmed") return true;
  const {
    value: [status],
  } = await ctx.conn.getSignatureStatuses([row.signature], {
    searchTransactionHistory: true,
  });
  if (status?.err) {
    row.state = "failed";
    row.chainError = status.err;
    ctx.save();
    throw new Error(
      `${name} failed on chain: ${row.signature}; inspect the journal before any manual retry`,
    );
  }
  if (
    status &&
    ["confirmed", "finalized"].includes(status.confirmationStatus)
  ) {
    row.state = "confirmed";
    row.slot = status.slot;
    row.confirmedAt = now();
    ctx.save();
    return true;
  }
  throw new Error(
    `${name} is unresolved (${row.signature}). No replacement transaction will be sent; reconcile this signature and blockheight ${row.lastValidBlockHeight} first`,
  );
}

async function sendJournaled(ctx, name, tx, signers, details = {}) {
  if (await reconcile(ctx, name))
    return ctx.journal.transactions[name].signature;
  const lifetime = await ctx.conn.getLatestBlockhash("confirmed");
  tx.feePayer = ctx.sponsor.publicKey;
  tx.recentBlockhash = lifetime.blockhash;
  tx.sign(ctx.sponsor, ...signers);
  const raw = tx.serialize();
  const signature = anchor.utils.bytes.bs58.encode(tx.signature);
  const row = {
    state: "prepared",
    signature,
    ...lifetime,
    preparedAt: now(),
    details,
    signedTransaction: raw.toString("base64"),
  };
  ctx.journal.transactions[name] = row;
  ctx.save(); // MUST happen before the first RPC send, including preflight.
  try {
    const returned = await ctx.conn.sendRawTransaction(raw, {
      skipPreflight: false,
      preflightCommitment: "confirmed",
      maxRetries: 3,
    });
    assert.equal(
      returned,
      signature,
      "RPC returned an unexpected transaction signature",
    );
    const confirmation = await ctx.conn.confirmTransaction(
      { signature, ...lifetime },
      "confirmed",
    );
    if (confirmation.value.err) {
      row.state = "failed";
      row.chainError = confirmation.value.err;
      throw new Error(JSON.stringify(confirmation.value.err));
    }
    row.state = "confirmed";
    row.slot = confirmation.context.slot;
    row.confirmedAt = now();
    ctx.save();
    console.log(`${name}: ${signature}`);
    return signature;
  } catch (error) {
    row.lastError = error.message;
    ctx.save();
    throw new Error(
      `${name}: ${error.message}; saved signature ${signature}. Reconcile before retrying; no new payment is automatic`,
    );
  }
}

async function setup(ctx) {
  assert(
    !ctx.journal.transactions.cleanup,
    "This run has entered cleanup; do not recreate its vault",
  );
  if (await reconcile(ctx, "setup")) {
    const state = await readVault(ctx);
    console.log(
      `Setup already confirmed; vault balance ${state.token.amount} base units`,
    );
    return;
  }
  const { sponsorToken } = await checkConfig(ctx, true);
  assert(sponsorToken.amount >= FUNDING, "Sponsor has insufficient dev-USDC");
  const [vaultInfo, tokenInfo, ownerLamports, sessionLamports] =
    await Promise.all([
      ctx.conn.getAccountInfo(ctx.vault),
      ctx.conn.getAccountInfo(ctx.vaultUsdc),
      ctx.conn.getBalance(ctx.owner.publicKey),
      ctx.conn.getBalance(ctx.session.publicKey),
    ]);
  assert(
    !vaultInfo && !tokenInfo,
    "Unjournaled vault/ATA already exists; inspect it before setup",
  );
  assert.equal(ownerLamports, 0, "Smoke owner must start with zero SOL");
  assert.equal(sessionLamports, 0, "Smoke session must start with zero SOL");
  const init = await ctx.program.methods
    .initVault(ctx.session.publicKey, bn(PER_SPIN_CAP), bn(DAILY_CAP))
    .accountsPartial({
      vault: ctx.vault,
      owner: ctx.owner.publicKey,
      payer: SPONSOR,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  const tx = new Transaction().add(
    init,
    createAssociatedTokenAccountIdempotentInstruction(
      SPONSOR,
      ctx.vaultUsdc,
      ctx.vault,
      USDC,
    ),
    createTransferCheckedInstruction(
      SPONSOR_USDC,
      USDC,
      ctx.vaultUsdc,
      SPONSOR,
      FUNDING,
      6,
    ),
  );
  await sendJournaled(ctx, "setup", tx, [ctx.owner], {
    funding: FUNDING.toString(),
  });
  const state = await readVault(ctx);
  assert.equal(state.token.amount, FUNDING);
  assert.equal(state.ownerLamports, 0);
  assert.equal(state.sessionLamports, 0);
  ctx.journal.setupVerifiedAt = now();
  ctx.save();
  console.log(
    `Setup verified: ${FUNDING} dev-USDC base units, owner/session both 0 SOL`,
  );
}

async function purchaseTransaction(ctx, memo) {
  assert(
    Buffer.byteLength(memo, "utf8") > 0 &&
      Buffer.byteLength(memo, "utf8") <= 256,
    "Invalid memo length",
  );
  const ix = await ctx.program.methods
    .purchasePack(bn(PRINCIPAL), bn(FEE), memo)
    .accountsPartial({
      config: ctx.config,
      vault: ctx.vault,
      sessionKey: ctx.session.publicKey,
      usdcMint: USDC,
      vaultUsdc: ctx.vaultUsdc,
      gachaUsdc: GACHA_USDC,
      feeUsdc: SPONSOR_USDC,
      tokenProgram: TOKEN_PROG,
    })
    .instruction();
  return new Transaction().add(
    new TransactionInstruction({
      programId: MEMO_PROG,
      keys: [],
      data: Buffer.from(memo, "utf8"),
    }),
    ix,
  );
}

async function purchasePreconditions(ctx) {
  assert(!ctx.journal.transactions.cleanup, "This run has entered cleanup");
  assert(await reconcile(ctx, "setup"), "No confirmed setup");
  await checkConfig(ctx, true);
  const state = await readVault(ctx);
  assert.equal(
    state.ownerLamports,
    0,
    "Owner must have zero SOL for the sponsorship check",
  );
  assert.equal(
    state.sessionLamports,
    0,
    "Session must have zero SOL for the sponsorship check",
  );
  assert(state.token.amount >= PRINCIPAL + FEE, "Insufficient vault funds");
  assert.equal(
    state.vault.spentToday.toString(),
    "0",
    "Unexpected previous vault spending",
  );
  return state;
}

function simulatedInfo(value) {
  assert(
    value && value.data?.[1] === "base64",
    "RPC did not return a simulated account",
  );
  return {
    ...value,
    owner: new PublicKey(value.owner),
    data: Buffer.from(value.data[0], "base64"),
  };
}

async function simulate(ctx) {
  assert(
    !ctx.journal.transactions.purchase,
    "A live purchase already exists; reconcile it instead",
  );
  const before = await purchasePreconditions(ctx);
  const tx = await purchaseTransaction(ctx, "day1-smoke-simulation-only");
  tx.feePayer = SPONSOR;
  tx.recentBlockhash = (
    await ctx.conn.getLatestBlockhash("confirmed")
  ).blockhash;
  const signed = new VersionedTransaction(tx.compileMessage());
  signed.sign([ctx.sponsor, ctx.session]);
  // This transaction is NEVER handed to sendJournaled or sendRawTransaction.
  const result = await ctx.conn.simulateTransaction(signed, {
    sigVerify: true,
    commitment: "confirmed",
    innerInstructions: true,
    accounts: {
      encoding: "base64",
      addresses: [ctx.vault.toBase58(), ctx.vaultUsdc.toBase58()],
    },
  });
  ctx.journal.simulation = {
    at: now(),
    slot: result.context.slot,
    result: result.value,
    broadcast: false,
  };
  ctx.save();
  assert.equal(
    result.value.err,
    null,
    `Purchase simulation failed: ${JSON.stringify(result.value.err)}`,
  );
  const [vaultInfo, tokenInfo] = result.value.accounts.map(simulatedInfo);
  const simulatedVault = ctx.program.coder.accounts.decode(
    "vault",
    vaultInfo.data,
  );
  const simulatedToken = unpackAccount(ctx.vaultUsdc, tokenInfo, TOKEN_PROG);
  assert.equal(
    simulatedToken.amount,
    before.token.amount - PRINCIPAL - FEE,
    "Simulated vault debit mismatch",
  );
  assert.equal(
    simulatedVault.spentToday.toString(),
    (PRINCIPAL + FEE).toString(),
    "Simulated daily spending mismatch",
  );
  const transfers = (result.value.innerInstructions || [])
    .flatMap((group) => group.instructions)
    .filter(
      (ix) =>
        ix.programId.equals(TOKEN_PROG) &&
        ix.parsed?.type === "transferChecked",
    )
    .map((ix) => ix.parsed.info);
  assert.equal(
    transfers.length,
    2,
    "Expected two simulated SPL transferChecked calls",
  );
  for (const [index, destination, amount] of [
    [0, GACHA_USDC, PRINCIPAL],
    [1, SPONSOR_USDC, FEE],
  ]) {
    const transfer = transfers[index];
    assert.equal(transfer.source, ctx.vaultUsdc.toBase58());
    assert.equal(transfer.destination, destination.toBase58());
    assert.equal(transfer.mint, USDC.toBase58());
    assert.equal(transfer.authority, ctx.vault.toBase58());
    assert.equal(transfer.tokenAmount.amount, amount.toString());
    assert.equal(transfer.tokenAmount.decimals, 6);
  }
  const after = await readVault(ctx);
  assert.equal(
    after.token.amount,
    before.token.amount,
    "Simulation changed live vault balance",
  );
  assert.equal(
    after.vault.spentToday.toString(),
    before.vault.spentToday.toString(),
  );
  assert.equal(after.ownerLamports, 0);
  assert.equal(after.sessionLamports, 0);
  ctx.journal.simulation.verified = true;
  ctx.save();
  console.log(
    `Simulation verified: 50 USDC principal + 0.5 fee, spending counter updated, live state unchanged; ${result.value.unitsConsumed} CU`,
  );
}

// The CC quote is parsed for price only. Its instructions are never submitted.
function quotedPrincipal(serialized, owner) {
  assert.equal(
    typeof serialized,
    "string",
    "CC quote is missing a legacy transaction",
  );
  const tx = Transaction.from(Buffer.from(serialized, "base64"));
  const source = getAssociatedTokenAddressSync(USDC, owner);
  const payments = [];
  for (const ix of tx.instructions) {
    if (!ix.programId.equals(TOKEN_PROG)) continue;
    const checked = ix.data[0] === TokenInstruction.TransferChecked;
    if (!checked && ix.data[0] !== TokenInstruction.Transfer) continue;
    const decoded = checked
      ? decodeTransferCheckedInstruction(ix)
      : decodeTransferInstruction(ix);
    if (!decoded.keys.source.pubkey.equals(source)) continue;
    assert(
      decoded.keys.destination.pubkey.equals(GACHA_USDC),
      "Quote payment destination mismatch",
    );
    assert(
      decoded.keys.owner.pubkey.equals(owner) && decoded.keys.owner.isSigner,
      "Quote owner mismatch",
    );
    // CC's builder may repeat the signing owner after the authority meta.
    // That is redundant for a single-key account, not a multisig authority.
    assert(
      decoded.keys.multiSigners.every(
        (signer) => signer.pubkey.equals(owner) && signer.isSigner,
      ),
      "Quote contains an unsupported additional signer",
    );
    if (checked) {
      assert(decoded.keys.mint.pubkey.equals(USDC), "Quote mint mismatch");
      assert.equal(decoded.data.decimals, 6, "Quote decimals mismatch");
    }
    payments.push(decoded.data.amount);
  }
  assert.equal(
    payments.length,
    1,
    "Expected exactly one owner-USDC payment in the quote",
  );
  assert.equal(
    payments[0],
    PRINCIPAL,
    "pokemon_50 quote must be exactly 50 dev-USDC",
  );
  return payments[0];
}

async function spin(ctx) {
  assert(KEY?.trim(), "Set CC_API_KEY for --spin; --simulate does not need it");
  assert(!ctx.journal.transactions.cleanup, "This run has entered cleanup");
  if (!ctx.journal.transactions.purchase) {
    await purchasePreconditions(ctx);
    if (!ctx.journal.quote) {
      const owner = ctx.owner.publicKey.toBase58();
      const response = await post("generatePack", {
        playerAddress: owner,
        packType: "pokemon_50",
        altPlayerAddress: owner,
        altFundsRecipient: owner,
        turbo: false,
      });
      assert.equal(
        response.status,
        200,
        `generatePack failed (${response.status})`,
      );
      assert(
        typeof response.json?.memo === "string" && response.json.memo.length,
        "CC returned no memo",
      );
      const memo = response.json.memo;
      assert(
        Buffer.byteLength(`${memo}:open`, "utf8") <= 256,
        "CC memo too long",
      );
      quotedPrincipal(response.json.transaction, ctx.owner.publicKey);
      ctx.journal.quote = {
        memo,
        onchainMemo: `${memo}:open`,
        owner,
        pack: "pokemon_50",
        principal: PRINCIPAL.toString(),
        receivedAt: now(),
      };
      ctx.save();
    }
    const quote = ctx.journal.quote;
    assert.equal(quote.owner, ctx.owner.publicKey.toBase58());
    assert.equal(quote.principal, PRINCIPAL.toString());
    assert.equal(quote.pack, "pokemon_50");
    assert.equal(quote.onchainMemo, `${quote.memo}:open`);
    await sendJournaled(
      ctx,
      "purchase",
      await purchaseTransaction(ctx, quote.onchainMemo),
      [ctx.session],
      {
        memo: quote.memo,
        principal: PRINCIPAL.toString(),
        fee: FEE.toString(),
        ownerLamports: 0,
        sessionLamports: 0,
      },
    );
  } else {
    await reconcile(ctx, "purchase");
  }
  const memo = ctx.journal.quote.memo;
  if (!ctx.journal.opened) {
    for (let attempt = 0; attempt < 25; attempt++) {
      try {
        const response = await post("openPack", { memo });
        if (
          response.status === 200 &&
          response.json?.success &&
          response.json.nft_address
        ) {
          ctx.journal.opened = {
            asset: new PublicKey(response.json.nft_address).toBase58(),
            at: now(),
          };
          ctx.save();
          break;
        }
      } catch (error) {
        console.log(`openPack retry for the SAME memo: ${error.message}`);
      }
      await sleep(3000);
    }
  }
  assert(
    ctx.journal.opened,
    `Purchase paid, but CC outcome unresolved for memo ${memo}; do not create another spin`,
  );
  const asset = new PublicKey(ctx.journal.opened.asset);
  for (let attempt = 0; attempt < 10; attempt++) {
    const info = await ctx.conn.getAccountInfo(asset, "confirmed");
    let standard;
    if (
      info?.owner.equals(MPL_CORE_PROG) &&
      info.data.length >= 33 &&
      info.data[0] === 1 &&
      new PublicKey(info.data.subarray(1, 33)).equals(ctx.owner.publicKey)
    ) {
      standard = "Core";
    } else if (info?.owner.equals(TOKEN_PROG)) {
      try {
        const token = await getAccount(
          ctx.conn,
          getAssociatedTokenAddressSync(asset, ctx.owner.publicKey),
          "confirmed",
          TOKEN_PROG,
        );
        if (
          token.amount === 1n &&
          token.owner.equals(ctx.owner.publicKey) &&
          token.mint.equals(asset)
        )
          standard = "SPL NFT";
      } catch {
        /* Delivery can lag the openPack response. */
      }
    }
    if (standard) {
      const state = await readVault(ctx);
      assert.equal(state.token.amount, FUNDING - PRINCIPAL - FEE);
      assert.equal(
        state.vault.spentToday.toString(),
        (PRINCIPAL + FEE).toString(),
      );
      assert.equal(state.ownerLamports, 0);
      assert.equal(state.sessionLamports, 0);
      ctx.journal.prize = {
        asset: asset.toBase58(),
        owner: ctx.owner.publicKey.toBase58(),
        standard,
        verifiedAt: now(),
      };
      ctx.save();
      console.log(
        `Live spin verified: ${standard} prize ${asset.toBase58()} on owner; 4.5 dev-USDC remains in vault`,
      );
      return;
    }
    await sleep(3000);
  }
  throw new Error(
    `Payment and opening succeeded, but prize ownership is unverified: ${asset.toBase58()}; do not repeat payment`,
  );
}

async function cleanup(ctx) {
  if (await reconcile(ctx, "cleanup")) {
    const infos = await ctx.conn.getMultipleAccountsInfo(
      [ctx.vault, ctx.vaultUsdc],
      "confirmed",
    );
    assert(
      infos.every((info) => !info),
      "Confirmed cleanup did not close both accounts",
    );
    console.log("Cleanup already confirmed; vault and USDC ATA are closed");
    return;
  }
  assert(await reconcile(ctx, "setup"), "No confirmed setup");
  await reconcile(ctx, "purchase"); // Blocks cleanup if a payment remains ambiguous.
  await checkConfig(ctx);
  const state = await readVault(ctx);
  assert(
    state.token.amount <= FUNDING,
    "Unexpected funds in smoke vault; review before cleanup",
  );
  const infos = await ctx.conn.getMultipleAccountsInfo(
    [ctx.vault, ctx.vaultUsdc],
    "confirmed",
  );
  const rent = infos.reduce((sum, info) => sum + info.lamports, 0);
  const tx = new Transaction();
  if (state.token.amount)
    tx.add(
      await ctx.program.methods
        .withdrawToken(bn(state.token.amount))
        .accountsPartial({
          vault: ctx.vault,
          owner: ctx.owner.publicKey,
          source: ctx.vaultUsdc,
          mint: USDC,
          destination: SPONSOR_USDC,
          tokenProgram: TOKEN_PROG,
        })
        .instruction(),
    );
  tx.add(
    await ctx.program.methods
      .closeTokenAccount()
      .accountsPartial({
        vault: ctx.vault,
        owner: ctx.owner.publicKey,
        token: ctx.vaultUsdc,
        tokenProgram: TOKEN_PROG,
      })
      .instruction(),
  );
  tx.add(
    await ctx.program.methods
      .closeVault()
      .accountsPartial({ vault: ctx.vault, owner: ctx.owner.publicKey })
      .instruction(),
  );
  await sendJournaled(ctx, "cleanup", tx, [ctx.owner], {
    withdrawn: state.token.amount.toString(),
    expectedRentToOwner: rent,
    ownerLamportsBefore: state.ownerLamports,
  });
  const [afterInfos, ownerLamports, sessionLamports] = await Promise.all([
    ctx.conn.getMultipleAccountsInfo([ctx.vault, ctx.vaultUsdc], "confirmed"),
    ctx.conn.getBalance(ctx.owner.publicKey, "confirmed"),
    ctx.conn.getBalance(ctx.session.publicKey, "confirmed"),
  ]);
  assert(
    afterInfos.every((info) => !info),
    "Cleanup did not close both accounts",
  );
  assert.equal(
    ownerLamports,
    state.ownerLamports + rent,
    "Rent refund did not reach owner",
  );
  assert.equal(sessionLamports, 0);
  ctx.journal.cleanupVerifiedAt = now();
  ctx.save();
  console.log(
    `Cleanup verified: ${state.token.amount} base units returned to sponsor; ${rent} rent lamports returned to owner`,
  );
}

async function status(ctx) {
  for (const name of Object.keys(ctx.journal.transactions)) {
    try {
      await reconcile(ctx, name);
    } catch (error) {
      console.log(error.message);
    }
  }
  const { transactions, ...summary } = ctx.journal;
  delete summary.simulation;
  console.log(
    JSON.stringify(
      {
        ...summary,
        transactions: Object.fromEntries(
          Object.entries(transactions).map(([name, row]) => [
            name,
            {
              state: row.state,
              signature: row.signature,
              slot: row.slot,
              details: row.details,
            },
          ]),
        ),
      },
      null,
      2,
    ),
  );
}

async function checkNetwork(connection) {
  assert.equal(
    await connection.getGenesisHash(),
    GENESIS,
    "RPC is not Solana devnet",
  );
}

async function main() {
  const phases = { setup, simulate, spin, cleanup, status };
  const args = process.argv.slice(2);
  const phase =
    args.length === 1 && args[0].startsWith("--") ? args[0].slice(2) : "";
  assert(
    phases[phase],
    "Usage: node scripts/devnet/day1_smoke.js --setup|--simulate|--spin|--cleanup|--status",
  );
  fs.mkdirSync(path.dirname(JOURNAL), { recursive: true });
  const lockPath = `${JOURNAL}.lock`;
  let lock;
  try {
    lock = fs.openSync(lockPath, "wx", 0o600);
  } catch {
    throw new Error(
      `Smoke lock exists: ${lockPath}. Confirm no other run is active before removing a stale lock`,
    );
  }
  try {
    fs.writeFileSync(lock, `${process.pid}\n`);
    const ctx = loadContext(phase);
    await checkNetwork(ctx.conn);
    console.log(
      `Day 1 devnet ${phase}: owner=${ctx.owner.publicKey.toBase58()} session=${ctx.session.publicKey.toBase58()} sponsor=${SPONSOR.toBase58()}`,
    );
    await phases[phase](ctx);
  } finally {
    fs.closeSync(lock);
    fs.unlinkSync(lockPath);
  }
}

// Exports permit offline checks of the money-moving boundaries using fake RPC.
module.exports = {
  GENESIS,
  checkNetwork,
  quotedPrincipal,
  sendJournaled,
  reconcile,
  saveJson,
};
if (require.main === module)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
