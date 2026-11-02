// Offline boundary checks. No RPC requests and no repository key files.
// node --test scripts/devnet/day1_smoke.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
} = require("@solana/web3.js");
const {
  getAssociatedTokenAddressSync,
  createTransferCheckedInstruction,
} = require("@solana/spl-token");
const {
  GENESIS,
  checkNetwork,
  quotedPrincipal,
  sendJournaled,
  saveJson,
} = require("./day1_smoke");
const { USDC, GACHA_WALLET, GACHA_USDC, anchor } = require("./common");

test("devnet guard accepts the full 32-byte genesis hash and rejects the abbreviated CAIP reference", async () => {
  const fullGenesis = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
  const abbreviatedGenesis = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
  assert.equal(GENESIS, fullGenesis);
  assert.equal(anchor.utils.bytes.bs58.decode(GENESIS).length, 32);
  assert.notEqual(
    anchor.utils.bytes.bs58.decode(abbreviatedGenesis).length,
    32,
  );
  await checkNetwork({ getGenesisHash: async () => fullGenesis });
  await assert.rejects(
    checkNetwork({ getGenesisHash: async () => abbreviatedGenesis }),
    /RPC is not Solana devnet/,
  );
});

function quote(
  owner,
  amount = 50_000_000n,
  destination = GACHA_USDC,
  decimals = 6,
) {
  const tx = new Transaction({
    feePayer: owner,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
  }).add(
    createTransferCheckedInstruction(
      getAssociatedTokenAddressSync(USDC, owner),
      USDC,
      destination,
      owner,
      amount,
      decimals,
    ),
  );
  return tx;
}

function encode(tx) {
  return tx
    .serialize({ requireAllSignatures: false, verifySignatures: false })
    .toString("base64");
}

test("CC quote accepts the exact 50 USDC payment, rejects wrong amount, treasury, decimals and duplicate payment", () => {
  const owner = Keypair.generate().publicKey;
  assert.equal(quotedPrincipal(encode(quote(owner)), owner), 50_000_000n);
  assert.throws(
    () => quotedPrincipal(encode(quote(owner, 50_000_001n)), owner),
    /exactly 50/,
  );
  assert.throws(
    () =>
      quotedPrincipal(
        encode(quote(owner, 50_000_000n, Keypair.generate().publicKey)),
        owner,
      ),
    /destination/,
  );
  assert.throws(
    () =>
      quotedPrincipal(encode(quote(owner, 50_000_000n, GACHA_USDC, 9)), owner),
    /decimals/,
  );
  const duplicate = quote(owner);
  duplicate.add(duplicate.instructions[0]);
  assert.throws(() => quotedPrincipal(encode(duplicate), owner), /exactly one/);
  assert.throws(() => quotedPrincipal("invalid", owner));
});

test("CC-sponsored quote accepts the redundant owner signer used by the live builder", () => {
  const owner = Keypair.generate().publicKey;
  const tx = quote(owner);
  tx.feePayer = GACHA_WALLET;
  tx.instructions[0].keys.push({
    pubkey: owner,
    isSigner: true,
    isWritable: false,
  });
  const serialized = encode(tx);
  const restored = Transaction.from(Buffer.from(serialized, "base64"));
  assert(restored.feePayer.equals(GACHA_WALLET));
  assert.equal(restored.signatures.length, 2);
  assert.equal(restored.instructions[0].keys.length, 5);
  for (const index of [3, 4]) {
    assert(restored.instructions[0].keys[index].pubkey.equals(owner));
    assert.equal(restored.instructions[0].keys[index].isSigner, true);
  }
  assert.equal(quotedPrincipal(serialized, owner), 50_000_000n);
});

test("CC quote still rejects arbitrary extra accounts, whether signing or not", () => {
  const owner = Keypair.generate().publicKey;
  const stranger = Keypair.generate().publicKey;
  for (const isSigner of [true, false]) {
    const tx = quote(owner);
    tx.feePayer = GACHA_WALLET;
    tx.instructions[0].keys.push(
      { pubkey: owner, isSigner: true, isWritable: false },
      { pubkey: stranger, isSigner, isWritable: false },
    );
    assert.throws(
      () => quotedPrincipal(encode(tx), owner),
      /unsupported additional signer/,
    );
  }
});

function fixture(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "day1-smoke-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "journal.json");
  const sponsor = Keypair.generate();
  const lifetime = {
    blockhash: Keypair.generate().publicKey.toBase58(),
    lastValidBlockHeight: 12345,
  };
  const ctx = {
    sponsor,
    journal: { transactions: {} },
    saves: 0,
    sends: 0,
    save() {
      this.saves++;
      saveJson(file, this.journal);
    },
    conn: {
      async getLatestBlockhash() {
        return lifetime;
      },
      async getSignatureStatuses() {
        return { value: [null] };
      },
      async sendRawTransaction(raw, opts) {
        ctx.sends++;
        const persisted = JSON.parse(fs.readFileSync(file, "utf8")).transactions
          .purchase;
        const tx = Transaction.from(raw);
        assert.equal(persisted.state, "prepared");
        assert.equal(
          persisted.signature,
          anchor.utils.bytes.bs58.encode(tx.signature),
        );
        assert.equal(persisted.signedTransaction, raw.toString("base64"));
        assert.equal(persisted.blockhash, lifetime.blockhash);
        assert.equal(
          persisted.lastValidBlockHeight,
          lifetime.lastValidBlockHeight,
        );
        assert.equal(opts.skipPreflight, false);
        assert.equal(opts.preflightCommitment, "confirmed");
        return persisted.signature;
      },
      async confirmTransaction() {
        return { context: { slot: 777 }, value: { err: null } };
      },
      ...overrides,
    },
  };
  const tx = () =>
    new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: sponsor.publicKey,
        toPubkey: new PublicKey("11111111111111111111111111111111"),
        lamports: 1,
      }),
    );
  return { ctx, tx, file };
}

test("signed transaction and known signature are durable before the first send; confirmed payment cannot be repeated", async (t) => {
  const { ctx, tx } = fixture(t);
  const signature = await sendJournaled(ctx, "purchase", tx(), []);
  assert.equal(ctx.journal.transactions.purchase.state, "confirmed");
  assert.equal(ctx.journal.transactions.purchase.slot, 777);
  assert.equal(await sendJournaled(ctx, "purchase", tx(), []), signature);
  assert.equal(ctx.sends, 1);
});

test("transport failure after send keeps the same payment identity and blocks a new signature", async (t) => {
  const { ctx, tx, file } = fixture(t, {
    async confirmTransaction() {
      throw new Error("RPC timeout");
    },
  });
  await assert.rejects(sendJournaled(ctx, "purchase", tx(), []), /RPC timeout/);
  const persisted = JSON.parse(fs.readFileSync(file, "utf8"));
  const original = persisted.transactions.purchase.signature;
  ctx.journal = persisted; // Model a process restart from disk.
  await assert.rejects(sendJournaled(ctx, "purchase", tx(), []), /unresolved/);
  assert.equal(ctx.journal.transactions.purchase.signature, original);
  assert.equal(ctx.sends, 1);
});

test("a previously ambiguous payment can be reconciled as confirmed without another RPC send", async (t) => {
  const { ctx, tx } = fixture(t, {
    async confirmTransaction() {
      throw new Error("connection lost");
    },
  });
  await assert.rejects(
    sendJournaled(ctx, "purchase", tx(), []),
    /connection lost/,
  );
  const original = ctx.journal.transactions.purchase.signature;
  ctx.conn.getSignatureStatuses = async () => ({
    value: [{ err: null, confirmationStatus: "finalized", slot: 888 }],
  });
  assert.equal(await sendJournaled(ctx, "purchase", tx(), []), original);
  assert.equal(ctx.journal.transactions.purchase.state, "confirmed");
  assert.equal(ctx.journal.transactions.purchase.slot, 888);
  assert.equal(ctx.sends, 1);
});

test("on-chain failure also requires explicit investigation rather than silently rebuilding payment", async (t) => {
  const { ctx, tx } = fixture(t, {
    async confirmTransaction() {
      return {
        context: { slot: 999 },
        value: { err: { InstructionError: [0, "Custom"] } },
      };
    },
  });
  await assert.rejects(sendJournaled(ctx, "purchase", tx(), []), /Custom/);
  assert.equal(ctx.journal.transactions.purchase.state, "failed");
  ctx.conn.getSignatureStatuses = async () => ({
    value: [
      {
        err: { InstructionError: [0, "Custom"] },
        confirmationStatus: "confirmed",
        slot: 999,
      },
    ],
  });
  await assert.rejects(
    sendJournaled(ctx, "purchase", tx(), []),
    /failed on chain/,
  );
  assert.equal(ctx.sends, 1);
});

test("failure to persist a prepared journal prevents all network submission", async (t) => {
  const { ctx, tx } = fixture(t);
  ctx.save = () => {
    throw new Error("disk full");
  };
  await assert.rejects(sendJournaled(ctx, "purchase", tx(), []), /disk full/);
  assert.equal(ctx.sends, 0);
});
