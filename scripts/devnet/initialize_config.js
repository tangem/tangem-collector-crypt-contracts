// Initialize only the pinned Day 1 DEVNET deployment. Never updates a Config.
// node scripts/devnet/initialize_config.js --check   (no network writes)
// node scripts/devnet/initialize_config.js --execute
// Signed bytes are durably journaled before submission. An interrupted run
// reuses those bytes; an expired, unresolved transaction requires investigation.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const anchor = require("@coral-xyz/anchor");
const {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} = require("@solana/web3.js");
const {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  unpackAccount,
  unpackMint,
} = require("@solana/spl-token");

const REPO = path.resolve(__dirname, "../..");
const RPC = "https://api.devnet.solana.com";
const GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const PROGRAM = new PublicKey("FKWs2cd5E9Fi8t2Gqbq6SkgekL4MJwZgkRMrGFcPGVvt");
const ADMIN = new PublicKey("CfzgiAsor8k46oAr1zLybapCbAK44892DYxBJUerNX31");
const MINT = new PublicKey("Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr");
const GACHA = new PublicKey("9ZSgA3PMjeAU8K6CWzgJ8oDnhZwwSgHZu6KP3X95t7Jq");
const GACHA_OWNER = new PublicKey(
  "A4ahkivAG4NoZAE8Sy4qv8nn2DU9yoXRQcttuCeGtTJv",
);
const FEE = new PublicKey("9qsWLjBgicHNncaM1qtLb4jqj4a4NixMwvNXNmsqQyV9");
const LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const [CONFIG, CONFIG_BUMP] = PublicKey.findProgramAddressSync(
  [Buffer.from("config")],
  PROGRAM,
);
const [PROGRAM_DATA] = PublicKey.findProgramAddressSync(
  [PROGRAM.toBuffer()],
  LOADER,
);
const ARTIFACT = path.join(REPO, "target/deploy-v3/tangem_gacha_vault.so");
const ARTIFACT_SHA =
  "6492ac4c8465d0724b8666fde81da1a0542f02f62253e75415208aa7954b4260";
const DIRECTORY = path.join(REPO, "target/verification/day1-config");
const JOURNAL = path.join(DIRECTORY, "initialize-config.transaction.json");
const SNAPSHOT = path.join(DIRECTORY, "config.confirmed.json");
const PREFLIGHT = path.join(DIRECTORY, "config.preflight.json");
const LOCK = path.join(DIRECTORY, "initialize-config.lock");
const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const pubkey = (value) => (value ? value.toBase58() : null);

// Rename is atomic; fsync both file and directory before any send can occur.
function save(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, file);
  const directory = fs.openSync(path.dirname(file), "r");
  try {
    fs.fsyncSync(directory);
  } finally {
    fs.closeSync(directory);
  }
}

function verifyProgram(programInfo, dataInfo, artifact) {
  assert(
    artifact.length === 367392 && sha256(artifact) === ARTIFACT_SHA,
    "Local v3 artifact differs from the reviewed deployment artifact",
  );
  assert(
    programInfo && programInfo.owner.equals(LOADER) && programInfo.executable,
    "Expected executable upgradeable-loader Program is absent or has the wrong owner",
  );
  assert(
    programInfo.data.length === 36 &&
      programInfo.data.readUInt32LE(0) === 2 &&
      new PublicKey(programInfo.data.subarray(4, 36)).equals(PROGRAM_DATA),
    "Program does not reference its canonical ProgramData",
  );
  assert(
    dataInfo &&
      dataInfo.owner.equals(LOADER) &&
      !dataInfo.executable &&
      dataInfo.data.length === 400045 &&
      dataInfo.data.readUInt32LE(0) === 3,
    "ProgramData owner, state or planned allocation differs",
  );
  assert(
    dataInfo.data[12] === 1 &&
      new PublicKey(dataInfo.data.subarray(13, 45)).equals(ADMIN),
    "ProgramData upgrade authority is not the expected devnet admin",
  );
  const executable = dataInfo.data.subarray(45);
  assert(
    executable.subarray(0, artifact.length).equals(artifact) &&
      executable.subarray(artifact.length).every((byte) => byte === 0),
    "Deployed executable differs from the reviewed artifact or has nonzero trailing bytes",
  );
  return {
    address: pubkey(PROGRAM),
    program_data: pubkey(PROGRAM_DATA),
    upgrade_authority: pubkey(ADMIN),
    last_deploy_slot: dataInfo.data.readBigUInt64LE(4).toString(),
    artifact_sha256: ARTIFACT_SHA,
    artifact_bytes: artifact.length,
    allocated_executable_bytes: executable.length,
    trailing_bytes_are_zero: true,
  };
}

function verifyConfig(info, coder) {
  if (!info) return null;
  assert(
    info.owner.equals(PROGRAM) && !info.executable && info.data.length === 174,
    "Existing Config has the wrong owner or layout; refusing to overwrite",
  );
  const config = coder.decode("config", info.data);
  for (const [field, expected] of Object.entries({
    admin: ADMIN,
    usdcMint: MINT,
    gachaUsdcAccount: GACHA,
    feeUsdcAccount: FEE,
  }))
    assert(
      config[field].equals(expected),
      `Existing Config ${field} differs; refusing to overwrite`,
    );
  assert(
    config.minFeeBps === 100 &&
      config.maxFeeBps === 500 &&
      config.paused === false &&
      config.bump === CONFIG_BUMP &&
      info.data[140] === 0 &&
      info.data.subarray(142).every((byte) => byte === 0),
    "Existing Config corridor, pause, bump or reserved bytes differ; refusing to overwrite",
  );
  return {
    address: pubkey(CONFIG),
    admin: pubkey(config.admin),
    usdc_mint: pubkey(config.usdcMint),
    gacha_usdc_account: pubkey(config.gachaUsdcAccount),
    fee_usdc_account: pubkey(config.feeUsdcAccount),
    min_fee_bps: config.minFeeBps,
    max_fee_bps: config.maxFeeBps,
    paused: config.paused,
    bump: config.bump,
    reserved_are_zero: true,
    data_bytes: info.data.length,
    data_base64: info.data.toString("base64"),
    lamports: info.lamports,
  };
}

function verifyTreasury(address, expectedOwner, info) {
  assert(
    info &&
      info.owner.equals(TOKEN_PROGRAM_ID) &&
      !info.executable &&
      info.data.length === 165,
    `Expected legacy SPL treasury account missing: ${address}`,
  );
  const account = unpackAccount(address, info, TOKEN_PROGRAM_ID);
  assert(
    account.mint.equals(MINT) &&
      account.owner.equals(expectedOwner) &&
      account.isInitialized &&
      !account.isFrozen &&
      !account.isNative &&
      getAssociatedTokenAddressSync(MINT, expectedOwner).equals(address),
    `Treasury mint, authority, state or canonical ATA differs: ${address}`,
  );
  // The CC destination has an existing delegate. It is not a debit authority
  // for this operation and is recorded, not mistaken for a different owner.
  return {
    address: pubkey(address),
    mint: pubkey(account.mint),
    authority: pubkey(account.owner),
    amount: account.amount.toString(),
    delegate: pubkey(account.delegate),
    close_authority: pubkey(account.closeAuthority),
    initialized: true,
    frozen: false,
  };
}

async function inspect(connection, program, artifact, minContextSlot) {
  assert(
    (await connection.getGenesisHash()) === GENESIS,
    "RPC is not the expected devnet chain",
  );
  const response = await connection.getMultipleAccountsInfoAndContext(
    [PROGRAM, PROGRAM_DATA, CONFIG, MINT, GACHA, FEE, ADMIN],
    { commitment: "confirmed", ...(minContextSlot ? { minContextSlot } : {}) },
  );
  const [
    programInfo,
    dataInfo,
    configInfo,
    mintInfo,
    gachaInfo,
    feeInfo,
    adminInfo,
  ] = response.value;
  const deployment = verifyProgram(programInfo, dataInfo, artifact);
  assert(
    mintInfo &&
      mintInfo.owner.equals(TOKEN_PROGRAM_ID) &&
      !mintInfo.executable &&
      mintInfo.data.length === 82,
    "Expected legacy SPL CC dev-USDC mint missing",
  );
  const mint = unpackMint(MINT, mintInfo, TOKEN_PROGRAM_ID);
  assert(
    mint.isInitialized && mint.decimals === 6,
    "CC dev-USDC mint state or decimals differ",
  );
  assert(
    adminInfo &&
      adminInfo.owner.equals(SystemProgram.programId) &&
      !adminInfo.executable &&
      adminInfo.data.length === 0,
    "Expected admin is not a plain system wallet",
  );
  return {
    observed_at: new Date().toISOString(),
    rpc: RPC,
    genesis: GENESIS,
    commitment: "confirmed",
    read_slot: response.context.slot,
    program: deployment,
    mint: {
      address: pubkey(MINT),
      program_owner: pubkey(mintInfo.owner),
      decimals: mint.decimals,
      mint_authority: pubkey(mint.mintAuthority),
      freeze_authority: pubkey(mint.freezeAuthority),
    },
    gacha_usdc: verifyTreasury(GACHA, GACHA_OWNER, gachaInfo),
    fee_usdc: verifyTreasury(FEE, ADMIN, feeInfo),
    admin: { address: pubkey(ADMIN), lamports: adminInfo.lamports },
    config: verifyConfig(configInfo, program.coder.accounts),
  };
}

async function initializeInstruction(program) {
  return program.methods
    .initializeConfig(GACHA, FEE, 100, 500)
    .accountsStrict({
      config: CONFIG,
      usdcMint: MINT,
      admin: ADMIN,
      program: PROGRAM,
      programData: PROGRAM_DATA,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}

function verifyJournal(journal, instruction) {
  assert(
    journal.version === 1 &&
      journal.rpc === RPC &&
      journal.program === pubkey(PROGRAM) &&
      journal.config === pubkey(CONFIG) &&
      journal.artifact_sha256 === ARTIFACT_SHA &&
      Number.isSafeInteger(journal.last_valid_block_height) &&
      journal.last_valid_block_height > 0,
    "Transaction journal does not match this deployment",
  );
  const raw = Buffer.from(journal.transaction_base64, "base64");
  const transaction = Transaction.from(raw);
  assert(
    transaction.feePayer.equals(ADMIN) &&
      transaction.recentBlockhash === journal.blockhash &&
      transaction.signatures.length === 1 &&
      transaction.verifySignatures() &&
      anchor.utils.bytes.bs58.encode(transaction.signature) ===
        journal.signature,
    "Transaction journal signature, payer or lifetime is invalid",
  );
  const expected = new Transaction({
    feePayer: ADMIN,
    recentBlockhash: journal.blockhash,
  }).add(instruction);
  assert(
    transaction.serializeMessage().equals(expected.serializeMessage()),
    "Transaction journal instruction differs from the exact expected initialization",
  );
  return raw;
}

async function execute(connection, program, payer, artifact, preflight) {
  if (preflight.config) {
    save(SNAPSHOT, { ...preflight, status: "existing_config_verified" });
    return { status: "existing_config_verified", snapshot: SNAPSHOT };
  }
  const instruction = await initializeInstruction(program);
  let journal;
  if (fs.existsSync(JOURNAL)) {
    journal = JSON.parse(fs.readFileSync(JOURNAL, "utf8"));
    verifyJournal(journal, instruction);
    const {
      value: [status],
    } = await connection.getSignatureStatuses([journal.signature], {
      searchTransactionHistory: true,
    });
    assert(
      !status || !status.err,
      `Prior initialization failed on chain: ${JSON.stringify(status && status.err)}. Inspect ${JOURNAL}`,
    );
    if (
      status &&
      ["confirmed", "finalized"].includes(status.confirmationStatus)
    ) {
      const snapshot = await inspect(
        connection,
        program,
        artifact,
        status.slot,
      );
      assert(
        snapshot.config,
        "Confirmed initialization has no Config; investigate before retrying",
      );
      save(SNAPSHOT, {
        ...snapshot,
        signature: journal.signature,
        status: "confirmed",
      });
      save(JOURNAL, {
        ...journal,
        state: "confirmed",
        confirmed_slot: status.slot,
      });
      return {
        status: "confirmed",
        signature: journal.signature,
        snapshot: SNAPSHOT,
      };
    }
    const height = await connection.getBlockHeight("confirmed");
    assert(
      height <= journal.last_valid_block_height,
      `Prior initialization expired without a resolved outcome. Inspect signature ${journal.signature}; do not delete the journal or build a new transaction blindly`,
    );
  } else {
    const lifetime = await connection.getLatestBlockhash("confirmed");
    const transaction = new Transaction({
      feePayer: ADMIN,
      recentBlockhash: lifetime.blockhash,
    }).add(instruction);
    const { value: fee } = await connection.getFeeForMessage(
      transaction.compileMessage(),
      "confirmed",
    );
    const rent = await connection.getMinimumBalanceForRentExemption(
      174,
      "confirmed",
    );
    assert(
      fee !== null && preflight.admin.lamports >= rent + fee,
      "Admin lacks SOL for Config rent and transaction fee",
    );
    transaction.sign(payer);
    journal = {
      version: 1,
      state: "signed_before_send",
      created_at: new Date().toISOString(),
      rpc: RPC,
      program: pubkey(PROGRAM),
      config: pubkey(CONFIG),
      artifact_sha256: ARTIFACT_SHA,
      blockhash: lifetime.blockhash,
      last_valid_block_height: lifetime.lastValidBlockHeight,
      signature: anchor.utils.bytes.bs58.encode(transaction.signature),
      transaction_base64: transaction.serialize().toString("base64"),
    };
    save(JOURNAL, journal);
  }
  const raw = verifyJournal(journal, instruction);
  // Any send/confirmation error leaves the durable signed journal in place.
  // Retrying this command can only rebroadcast the same initialization bytes.
  const signature = await connection.sendRawTransaction(raw, {
    skipPreflight: false,
    preflightCommitment: "confirmed",
    maxRetries: 3,
  });
  assert(
    signature === journal.signature,
    "RPC returned an unexpected transaction signature",
  );
  save(JOURNAL, {
    ...journal,
    state: "submitted",
    submitted_at: new Date().toISOString(),
  });
  const confirmation = await connection.confirmTransaction(
    {
      signature,
      blockhash: journal.blockhash,
      lastValidBlockHeight: journal.last_valid_block_height,
    },
    "confirmed",
  );
  assert(
    !confirmation.value.err,
    `Initialization failed: ${JSON.stringify(confirmation.value.err)}`,
  );
  const snapshot = await inspect(
    connection,
    program,
    artifact,
    confirmation.context.slot,
  );
  assert(snapshot.config, "Initialization confirmed but Config is absent");
  save(SNAPSHOT, { ...snapshot, signature, status: "confirmed" });
  save(JOURNAL, {
    ...journal,
    state: "confirmed",
    confirmed_slot: confirmation.context.slot,
  });
  return {
    status: "confirmed",
    signature,
    snapshot: SNAPSHOT,
    journal: JOURNAL,
  };
}

async function main() {
  const args = process.argv.slice(2);
  assert(
    args.length <= 1 &&
      (!args.length || ["--check", "--execute"].includes(args[0])),
    "Usage: node scripts/devnet/initialize_config.js [--check|--execute]",
  );
  const shouldExecute = args[0] === "--execute";
  const idl = JSON.parse(
    fs.readFileSync(path.join(REPO, "idl/tangem_gacha_vault.json"), "utf8"),
  );
  assert(
    idl.address === pubkey(PROGRAM) && idl.instructions.length === 9,
    "Expected pinned Day 1 IDL",
  );
  const artifact = fs.readFileSync(ARTIFACT);
  const payer = Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(
        fs.readFileSync(path.join(REPO, "keys/devnet-player.json"), "utf8"),
      ),
    ),
  );
  assert(
    payer.publicKey.equals(ADMIN),
    "Payer key is not the expected devnet admin",
  );
  const connection = new Connection(RPC, "confirmed");
  const provider = new anchor.AnchorProvider(
    connection,
    new anchor.Wallet(payer),
    { commitment: "confirmed", preflightCommitment: "confirmed" },
  );
  const program = new anchor.Program(idl, provider);
  let lock;
  try {
    if (shouldExecute) {
      fs.mkdirSync(DIRECTORY, { recursive: true });
      lock = fs.openSync(LOCK, "wx", 0o600);
      fs.writeFileSync(lock, `${process.pid}\n`);
    }
    const preflight = await inspect(connection, program, artifact);
    save(PREFLIGHT, preflight);
    const result = shouldExecute
      ? await execute(connection, program, payer, artifact, preflight)
      : {
          status: preflight.config
            ? "existing_config_verified"
            : "ready_to_initialize",
          network_writes: false,
          preflight: PREFLIGHT,
          config: pubkey(CONFIG),
        };
    console.log(JSON.stringify(result, null, 2));
  } finally {
    if (lock !== undefined) {
      fs.closeSync(lock);
      fs.unlinkSync(LOCK);
    }
  }
}

module.exports = {
  verifyConfig,
  verifyProgram,
  verifyTreasury,
  verifyJournal,
  initializeInstruction,
};
if (require.main === module)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
