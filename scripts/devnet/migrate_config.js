// One-shot Config layout migration on devnet: 174 -> 176 bytes, appends
// max_fee_bps (the old fee_bps slot becomes min_fee_bps in place).
// Run IMMEDIATELY after `solana program deploy` of the purchase_pack build —
// until then every Config-reading instruction fails with Anchor 3003.
// Idempotent: a second run is a no-op on-chain.
//   MAX_FEE_BPS=500 node scripts/devnet/migrate_config.js     (no CC_API_KEY needed)
const { PublicKey } = require("@solana/web3.js");
const { load } = require("./common");

const MAX_FEE_BPS = Number(process.env.MAX_FEE_BPS || 500);
if (!Number.isInteger(MAX_FEE_BPS) || MAX_FEE_BPS < 0 || MAX_FEE_BPS > 65535) {
  throw new Error(`MAX_FEE_BPS must be an integer in 0..65535, got ${process.env.MAX_FEE_BPS}`);
}
const CONFIG_LEGACY_LEN = 174;
const CONFIG_NEW_LEN = 176;

(async () => {
  const { player, conn, program, configPda } = load();
  const before = await conn.getAccountInfo(configPda);
  if (!before) throw new Error(`config ${configPda} not found`);
  console.log(`[0] config ${configPda.toBase58()}: ${before.data.length} bytes`);
  if (before.data.length < CONFIG_LEGACY_LEN) {
    throw new Error(`unexpected config size ${before.data.length} (expected ${CONFIG_LEGACY_LEN} or ${CONFIG_NEW_LEN})`);
  }
  const minFeeBps = before.data.readUInt16LE(168);
  console.log(`    stored admin: ${new PublicKey(before.data.subarray(8, 40)).toBase58()}`);
  console.log(`    min_fee_bps (old fee_bps @168): ${minFeeBps}, target max_fee_bps: ${MAX_FEE_BPS}`);
  if (before.data.length >= CONFIG_NEW_LEN) {
    console.log(`[1] already ${before.data.length} bytes — nothing to migrate`);
  } else if (before.data.length !== CONFIG_LEGACY_LEN) {
    throw new Error(`unexpected config size ${before.data.length} (expected ${CONFIG_LEGACY_LEN})`);
  } else {
    if (MAX_FEE_BPS < minFeeBps || MAX_FEE_BPS > 1000) {
      throw new Error(`max_fee_bps ${MAX_FEE_BPS} must satisfy min (${minFeeBps}) <= max <= 1000`);
    }
    const sig = await program.methods.migrateConfig(MAX_FEE_BPS)
      .accountsPartial({ config: configPda, admin: player.publicKey })
      .signers([player]).rpc();
    console.log(`[1] migrate_config sig: ${sig}`);
  }
  const cfg = await program.account.config.fetch(configPda);
  const after = await conn.getAccountInfo(configPda);
  console.log(`[2] config now ${after.data.length} bytes: min_fee_bps=${cfg.minFeeBps} max_fee_bps=${cfg.maxFeeBps} paused=${cfg.paused} _reserved=${cfg.reserved ?? cfg._reserved}`);
})().catch((e) => { console.error(e); process.exit(1); });
