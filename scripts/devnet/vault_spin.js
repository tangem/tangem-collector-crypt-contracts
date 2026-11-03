// E2E spin: pay for a CC gacha spin FROM THE VAULT via purchase_pack
// (inner CPI transfer + client-added top-level memo), prize to the OWNER.
// Requires the fresh Day 1 devnet deployment and initialized Config/Vault/ATA.
//   NODE_PATH=$REPO/node_modules node scripts/devnet/vault_spin.js
const {
  load, post, get, sleep, anchor, KEY, USDC, GACHA_USDC, MEMO_PROG, TOKEN_PROG, MPL_CORE_PROG,
  PACK, AMOUNT,
} = require("./common");
const { PublicKey, Transaction, TransactionInstruction } = require("@solana/web3.js");
const {
  getAssociatedTokenAddressSync, getAccount, createTransferCheckedInstruction,
  decodeTransferInstruction, decodeTransferCheckedInstruction, TokenInstruction,
} = require("@solana/spl-token");

// Extract the principal from CC's legacy quote; the template is never signed
// or submitted. Unsupported formats and ambiguous payments must fail closed.
function quotedPrincipal(serialized, playerUsdc, player) {
  if (typeof serialized !== "string" || !serialized.length) {
    throw new Error("generatePack did not provide a legacy transaction quote");
  }
  let template;
  try {
    template = Transaction.from(Buffer.from(serialized, "base64"));
  } catch (e) {
    throw new Error(`Unsupported CC transaction quote (legacy only): ${e.message}`);
  }
  const payments = [];
  for (const ix of template.instructions) {
    if (!ix.programId.equals(TOKEN_PROG)) continue;
    const checked = ix.data[0] === TokenInstruction.TransferChecked;
    if (!checked && ix.data[0] !== TokenInstruction.Transfer) continue;
    const decoded = checked ? decodeTransferCheckedInstruction(ix) : decodeTransferInstruction(ix);
    if (!decoded.keys.source.pubkey.equals(playerUsdc)) continue;
    if (!decoded.keys.destination.pubkey.equals(GACHA_USDC) ||
        !decoded.keys.owner.pubkey.equals(player) || !decoded.keys.owner.isSigner ||
        decoded.keys.multiSigners.length !== 0) {
      throw new Error("CC quote contains an unsupported payment from player USDC");
    }
    if (checked && (!decoded.keys.mint.pubkey.equals(USDC) || decoded.data.decimals !== 6)) {
      throw new Error("CC quote does not use CC dev-USDC with 6 decimals");
    }
    payments.push(decoded.data.amount);
  }
  if (payments.length !== 1) throw new Error("CC quote must contain exactly one player-USDC payment to the CC treasury");
  return payments[0];
}

async function main() {
  if (!KEY || !KEY.trim()) throw new Error("set CC_API_KEY (dev API key from CC)");
  if (!Number.isSafeInteger(AMOUNT) || AMOUNT <= 0) throw new Error("AMOUNT must be a positive integer in base units");
  const { player, conn, provider, program, configPda, vaultPda, vaultUsdc, playerUsdc } = load();

  // Tangem fee: the backend picks the machine's rate inside the on-chain
  // corridor [min_fee_bps, max_fee_bps]; here we charge the floor rate.
  const cfg = await program.account.config.fetch(configPda);
  const vault = await program.account.vault.fetch(vaultPda);
  if (!cfg.usdcMint.equals(USDC)) throw new Error("Config is not using CC dev-USDC");
  if (cfg.paused) throw new Error("Config is paused; no funding or purchase will be sent");
  if (!cfg.gachaUsdcAccount.equals(GACHA_USDC)) throw new Error("Config does not route principal to the known CC dev treasury");
  if (!vault.owner.equals(player.publicKey) || !vault.sessionKey.equals(player.publicKey)) {
    throw new Error("This devnet probe requires player to be both owner and session key");
  }
  const gachaUsdc = cfg.gachaUsdcAccount;
  const feeUsdc = cfg.feeUsdcAccount;
  const feeAmount = new anchor.BN(AMOUNT).muln(cfg.minFeeBps).divn(10_000);
  const total = new anchor.BN(AMOUNT).add(feeAmount);
  if (total.gt(vault.perSpinCap)) throw new Error("AMOUNT + fee exceeds the vault per-spin cap");
  const feeAccount = await getAccount(conn, feeUsdc);
  if (!feeAccount.mint.equals(USDC) || feeAccount.isFrozen) throw new Error("Config fee account must accept CC dev-USDC");
  console.log(`fee_amount=${feeAmount.toString()} (min_fee_bps=${cfg.minFeeBps}, max_fee_bps=${cfg.maxFeeBps})`);

  console.log(`[1] generatePack ${PACK}: playerAddress=owner, prize and turbo proceeds to owner`);
  const gp = await post("generatePack", {
    playerAddress: player.publicKey.toBase58(),
    packType: PACK,
    altPlayerAddress: vault.owner.toBase58(),
    altFundsRecipient: vault.owner.toBase58(),
    turbo: false,
  });
  if (gp.status !== 200 || typeof gp.json?.memo !== "string" || !gp.json.memo.length) {
    throw new Error(`generatePack failed (${gp.status}): ${JSON.stringify(gp.json)}`);
  }
  const memo = gp.json.memo;
  const onchainMemo = `${memo}:open`;
  console.log(`  memo=${memo}`);
  if (Buffer.byteLength(onchainMemo, "utf8") > 256) throw new Error("CC memo exceeds the on-chain 256-byte limit");
  const principal = quotedPrincipal(gp.json.transaction, playerUsdc, player.publicKey);
  if (principal !== BigInt(AMOUNT)) {
    throw new Error(`CC quoted ${principal} base units for ${PACK}, but AMOUNT=${AMOUNT}; no funding or purchase was sent`);
  }
  console.log(`  verified principal=${principal}; discarding CC's tx and paying from the vault`);

  const memoIx = new TransactionInstruction({ programId: MEMO_PROG, keys: [], data: Buffer.from(onchainMemo, "utf8") });
  const purchasePackIx = await program.methods
    .purchasePack(new anchor.BN(AMOUNT), feeAmount, onchainMemo)
    .accountsPartial({
      config: configPda, vault: vaultPda, sessionKey: player.publicKey,
      usdcMint: USDC, vaultUsdc, gachaUsdc, feeUsdc,
      tokenProgram: TOKEN_PROG,
    })
    .instruction();

  // Funding starts only after config, caps, fee account and CC quote checks.
  // A later failure may leave this memo pending: never create a new payment
  // automatically when the outcome of an existing payment is uncertain.
  const target = BigInt(total.toString()) + 5_000_000n;
  const vaultAccount = await getAccount(conn, vaultUsdc);
  if (!vaultAccount.mint.equals(USDC) || !vaultAccount.owner.equals(vaultPda) || vaultAccount.isFrozen) {
    throw new Error("Vault USDC account is invalid or frozen");
  }
  let vRaw = vaultAccount.amount;
  if (vRaw < target) {
    const funding = new Transaction().add(
      createTransferCheckedInstruction(playerUsdc, USDC, vaultUsdc, player.publicKey, target - vRaw, 6));
    await provider.sendAndConfirm(funding);
    vRaw = (await getAccount(conn, vaultUsdc)).amount;
  }
  console.log(`vault USDC before: ${Number(vRaw) / 1e6}`);

  const tx = new Transaction().add(memoIx, purchasePackIx);
  tx.feePayer = player.publicKey;
  const lifetime = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = lifetime.blockhash;
  tx.sign(player);
  let sig;
  try {
    sig = await conn.sendRawTransaction(tx.serialize());
    console.log(`[2] purchase_pack sig: ${sig}`);
    const confirmation = await conn.confirmTransaction({ signature: sig, ...lifetime }, "confirmed");
    if (confirmation.value.err) throw new Error(JSON.stringify(confirmation.value.err));
  } catch (e) {
    throw new Error(`purchase_pack submission/confirmation failed: ${e.message}; reconcile memo ${memo}${sig ? `, tx ${sig}` : ""} before another payment`);
  }

  console.log(`[3] openPack {memo} — waiting for CC to credit the spin`);
  let opened;
  for (let i = 0; i < 25; i++) {
    try {
      const op = await post("openPack", { memo });
      if (op.status === 200 && op.json?.success && op.json.nft_address) { opened = op.json; break; }
      console.log(`  ...${op.json?.code || op.json?.error || JSON.stringify(op.json)}`);
    } catch (e) {
      console.log(`  ...openPack request failed for this memo: ${e.message}`);
    }
    await sleep(3000);
  }
  if (!opened) {
    console.log(`\n>>> Payment confirmed, but CC has not confirmed the spin outcome.`);
    try {
      const st = await get(`pack/status?memo=${encodeURIComponent(memo)}`);
      console.log("    pack/status:", JSON.stringify(st?.pack ?? st ?? null).slice(0, 300));
    } catch (e) {
      console.log(`    pack/status unavailable: ${e.message}`);
    }
    throw new Error(`Payment was sent (${sig}); reconcile memo ${memo} before creating another spin`);
  }
  console.log(`  OPENED: nft=${opened.nft_address} rarity=${opened.rarity}`);

  // Prizes come in two standards and the check has to know which. A Core
  // AssetV1 has no mint and no token account — the owner lives inside the
  // asset, whose account is owned by the mpl-core program — so deriving an ATA
  // for it yields a junk address that never resolves. Decide by owner program.
  const asset = new PublicKey(opened.nft_address);
  let delivered = false;
  for (let i = 0; i < 10 && !delivered; i++) {
    try {
      const info = await conn.getAccountInfo(asset);
      if (info && info.owner.equals(MPL_CORE_PROG)) {
        // Core AssetV1 starts with Key::AssetV1 (1), then the owner's pubkey.
        // Merely finding a Core account does NOT prove delivery to this owner.
        delivered = info.data.length >= 33 && info.data[0] === 1 &&
          new PublicKey(info.data.subarray(1, 33)).equals(vault.owner);
        console.log(`  Core prize delivered to owner: ${delivered}`);
      } else if (info && info.owner.equals(TOKEN_PROG)) {
        const acc = await getAccount(conn, getAssociatedTokenAddressSync(asset, vault.owner));
        delivered = acc.amount === 1n && acc.owner.equals(vault.owner) && acc.mint.equals(asset);
        console.log(`  pNFT prize delivered to owner: ${delivered}`);
      }
    } catch (e) {
      console.log(`  ...prize not visible yet: ${e.message}`);
    }
    if (!delivered) await sleep(3000);
  }

  if (!delivered) {
    console.log(`\n>>> PAID AND CREDITED, BUT PRIZE NOT SEEN on the owner after ~30s.`);
    console.log(`    Check ${asset.toBase58()} by hand — the USDC has already left the vault.`);
    process.exit(1);
  }
  console.log(`\n>>> SPIN OK: CPI payment from the vault credited by CC, prize on the owner wallet.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
