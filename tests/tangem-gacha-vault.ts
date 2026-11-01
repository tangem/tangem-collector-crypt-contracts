import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAssociatedTokenAccount,
  getAssociatedTokenAddressSync,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { assert } from "chai";
import { TangemGachaVault } from "../target/types/tangem_gacha_vault";

const BPF_UPGRADEABLE_LOADER = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111"
);

describe("tangem-gacha-vault", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace
    .TangemGachaVault as Program<TangemGachaVault>;
  const connection = provider.connection;
  const admin = (provider.wallet as anchor.Wallet).payer;

  // Actors
  const owner = Keypair.generate(); // simulates the Tangem card key
  const coldOwner2 = Keypair.generate(); // second vault for daily-cap test
  const sessionKey2 = Keypair.generate(); // rotated-in session key of the second vault
  // Field names of an IDL struct type, normalized to snake_case: Anchor's
  // Program converts the loaded IDL (type and field names) to camelCase.
  const snake = (n: string) => n.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase());
  const idlStructFields = (typeName: string): string[] => {
    const t = (program.idl as any).types.find(
      (x: any) => x.name.toLowerCase() === typeName.toLowerCase()
    );
    assert.ok(t, `IDL type ${typeName} not found`);
    return (t.type.fields as any[]).map((f) => snake(f.name));
  };
  const sessionKey = Keypair.generate(); // simulates the phone key
  const gachaWallet = Keypair.generate(); // simulates Collector Crypt treasury
  const feeTreasury = Keypair.generate(); // Tangem fee wallet
  const attacker = Keypair.generate();

  const USDC_DECIMALS = 6;
  const usd = (n: number) => new anchor.BN(n * 10 ** USDC_DECIMALS);

  let usdcMint: PublicKey;
  let gachaUsdc: PublicKey;
  let feeUsdc: PublicKey;
  let attackerUsdc: PublicKey;
  let vaultPda: PublicKey;
  let vault2Pda: PublicKey;
  let configPda: PublicKey;
  let programDataPda: PublicKey;
  let vaultUsdc: PublicKey;
  let vault2Usdc: PublicKey;

  const FEE_BPS = 100; // 1% on top — corridor floor (min_fee_bps)
  const MAX_FEE_BPS_CFG = 500; // corridor ceiling (max_fee_bps), admin-set
  // What a compliant backend sends as fee_amount: floor(amount * rate / 10_000).
  const feeFor = (a: anchor.BN) => a.muln(FEE_BPS).divn(10_000);
  const PER_SPIN_CAP = usd(300); // covers a 250 USDC pack + fee
  const DAILY_CAP = usd(1000);

  // On-chain memo = generatePack's "<slug>-<uuid>" + ":open" (appended by our
  // backend; the API field is the bare join key).
  const memo = (uuid: string) => `tangem-${uuid}:open`;

  // Decode the program's Anchor events from a confirmed transaction's logs —
  // deterministic, unlike addEventListener on a local validator.
  const eventsOf = async (sig: string) => {
    let tx = null;
    for (let i = 0; i < 40 && !tx; i++) {
      tx = await connection.getTransaction(sig, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      if (!tx) await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(tx, `transaction ${sig} not found`);
    const parser = new anchor.EventParser(program.programId, program.coder);
    return [...parser.parseLogs(tx!.meta!.logMessages ?? [])];
  };

  before(async () => {
    await Promise.all(
      [attacker].map(
        async (kp) => {
          const sig = await connection.requestAirdrop(
            kp.publicKey,
            5 * LAMPORTS_PER_SOL
          );
          const latest = await connection.getLatestBlockhash();
          await connection.confirmTransaction({ signature: sig, ...latest });
        }
      )
    );

    usdcMint = await createMint(
      connection,
      admin,
      admin.publicKey,
      null,
      USDC_DECIMALS
    );
    gachaUsdc = await createAssociatedTokenAccount(
      connection,
      admin,
      usdcMint,
      gachaWallet.publicKey
    );
    feeUsdc = await createAssociatedTokenAccount(
      connection,
      admin,
      usdcMint,
      feeTreasury.publicKey
    );
    attackerUsdc = await createAssociatedTokenAccount(
      connection,
      admin,
      usdcMint,
      attacker.publicKey
    );

    [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId
    );
    [programDataPda] = PublicKey.findProgramAddressSync(
      [program.programId.toBuffer()],
      BPF_UPGRADEABLE_LOADER
    );
    [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), owner.publicKey.toBuffer()],
      program.programId
    );
    [vault2Pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), coldOwner2.publicKey.toBuffer()],
      program.programId
    );
    vaultUsdc = getAssociatedTokenAddressSync(usdcMint, vaultPda, true);
    vault2Usdc = getAssociatedTokenAddressSync(usdcMint, vault2Pda, true);
  });

  it("publishes exactly the Day 1 ABI and preserves the seven user instructions", () => {
    assert.equal(program.programId.toBase58(), "FKWs2cd5E9Fi8t2Gqbq6SkgekL4MJwZgkRMrGFcPGVvt");
    const instructions = (program.idl as any).instructions;
    const names = instructions.map((i: any) => snake(i.name)).sort();
    assert.deepEqual(names, [
      "initialize_config", "update_config", "init_vault", "update_vault",
      "purchase_pack", "withdraw_token", "withdraw_sol", "close_token_account", "close_vault",
    ].sort());
    const userAbi: Record<string, { accounts: string[]; args: string[] }> = {
      init_vault: { accounts: ["vault", "owner", "payer", "system_program"], args: ["session_key", "per_spin_cap", "daily_cap"] },
      update_vault: { accounts: ["vault", "owner"], args: ["session_key", "per_spin_cap", "daily_cap"] },
      purchase_pack: { accounts: ["config", "vault", "session_key", "usdc_mint", "vault_usdc", "gacha_usdc", "fee_usdc", "token_program"], args: ["amount", "fee_amount", "memo"] },
      withdraw_token: { accounts: ["vault", "owner", "source", "mint", "destination", "token_program"], args: ["amount"] },
      withdraw_sol: { accounts: ["vault", "owner", "recipient"], args: ["lamports"] },
      close_token_account: { accounts: ["vault", "owner", "token", "token_program"], args: [] },
      close_vault: { accounts: ["vault", "owner"], args: [] },
    };
    for (const [name, expected] of Object.entries(userAbi)) {
      const ix = instructions.find((i: any) => snake(i.name) === name);
      assert.deepEqual(ix.accounts.map((a: any) => snake(a.name)), expected.accounts, `${name} accounts`);
      assert.deepEqual(ix.args.map((a: any) => snake(a.name)), expected.args, `${name} args`);
    }
    assert.deepEqual(idlStructFields("Config"), [
      "admin", "usdc_mint", "gacha_usdc_account", "fee_usdc_account", "min_fee_bps", "max_fee_bps", "paused", "bump", "reserved",
    ]);
    assert.deepEqual(idlStructFields("Vault"), [
      "owner", "session_key", "per_spin_cap", "daily_cap", "spent_today", "day_index", "bump", "reserved",
    ]);
    assert.deepEqual(idlStructFields("PackOpened"), ["vault", "owner", "amount", "fee", "memo"]);
    assert.deepEqual((program.idl as any).errors.map((e: any) => [e.code, e.name[0].toUpperCase() + e.name.slice(1)]), [
      [6000, "Paused"], [6001, "ZeroAmount"], [6002, "InvalidMemo"], [6003, "InvalidFeeBps"],
      [6004, "InvalidCaps"], [6005, "ExceedsPerSpinCap"], [6006, "ExceedsDailyCap"], [6007, "MathOverflow"],
      [6015, "TokenAccountNotEmpty"], [6016, "DelegateStillSet"], [6017, "InsufficientSol"],
      [6018, "Unauthorized"], [6021, "UnsupportedMint"], [6022, "FeeBelowMinimum"], [6023, "FeeAboveMaximum"],
    ]);
  });

  it("initialize_config: rejects an admin that is not the upgrade authority", async () => {
    // Front-running protection: only the program's upgrade authority may
    // initialize the config (program_data.upgrade_authority_address == admin).
    try {
      await program.methods
        .initializeConfig(
          gachaUsdc,
          feeUsdc,
          FEE_BPS,
          MAX_FEE_BPS_CFG
        )
        .accountsPartial({
          config: configPda,
          usdcMint,
          admin: attacker.publicKey, // <-- not the upgrade authority
          program: program.programId,
          programData: programDataPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([attacker])
        .rpc();
      assert.fail("should have thrown");
    } catch (e: any) {
      assert.include(e.toString(), "Unauthorized");
    }
    // Nothing was written — the positive init below still starts from scratch.
    assert.isNull(await program.account.config.fetchNullable(configPda));
  });

  it("initializes config (upgrade authority only)", async () => {
    await program.methods
      .initializeConfig(
        gachaUsdc,
        feeUsdc,
        FEE_BPS,
        MAX_FEE_BPS_CFG
      )
      .accountsPartial({
        config: configPda,
        usdcMint,
        admin: admin.publicKey,
        program: program.programId,
        programData: programDataPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const cfg = await program.account.config.fetch(configPda);
    assert.ok(cfg.gachaUsdcAccount.equals(gachaUsdc));
    assert.equal(cfg.minFeeBps, FEE_BPS);
    assert.equal(cfg.maxFeeBps, MAX_FEE_BPS_CFG);
    assert.isFalse(cfg.paused);
    assert.lengthOf((await connection.getAccountInfo(configPda))!.data, 174);
  });

  it("initializes a vault with a separate fee/rent sponsor and funds it", async () => {
    await program.methods
      .initVault(sessionKey.publicKey, PER_SPIN_CAP, DAILY_CAP)
      .accountsPartial({
        vault: vaultPda,
        owner: owner.publicKey,
        payer: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([owner])
      .rpc();

    const vault = await program.account.vault.fetch(vaultPda);
    assert.ok(vault.owner.equals(owner.publicKey));
    assert.ok(vault.sessionKey.equals(sessionKey.publicKey));
    assert.lengthOf((await connection.getAccountInfo(vaultPda))!.data, 137);
    assert.equal(await connection.getBalance(owner.publicKey), 0);
    assert.equal(await connection.getBalance(sessionKey.publicKey), 0);

    // Deposit: in production a plain SPL transfer signed by the cold key
    // (one tap). Here we just mint directly to the vault ATA.
    await createAssociatedTokenAccount(
      connection,
      admin,
      usdcMint,
      vaultPda,
      undefined,
      undefined,
      undefined,
      true
    );
    await mintTo(connection, admin, usdcMint, vaultUsdc, admin, 500_000_000); // 500 USDC
  });

  it("purchase_pack: pays gacha + fee with memo, signed only by hot key", async () => {
    await program.methods
      .purchasePack(usd(50), feeFor(usd(50)), memo("11111111-aaaa-bbbb-cccc-000000000001"))
      .accountsPartial({
        config: configPda,
        vault: vaultPda,
        sessionKey: sessionKey.publicKey,
        usdcMint,
        vaultUsdc,
        gachaUsdc,
        feeUsdc,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([sessionKey])
      .rpc();

    const gacha = await getAccount(connection, gachaUsdc);
    const fee = await getAccount(connection, feeUsdc);
    assert.equal(gacha.amount.toString(), usd(50).toString());
    assert.equal(fee.amount.toString(), usd(0.5).toString()); // 1% of 50

    const vault = await program.account.vault.fetch(vaultPda);
    assert.equal(vault.spentToday.toString(), usd(50.5).toString());
  });

  it("purchase_pack: rejects a non-whitelisted destination", async () => {
    try {
      await program.methods
        .purchasePack(usd(10), feeFor(usd(10)), memo("11111111-aaaa-bbbb-cccc-000000000002"))
        .accountsPartial({
          config: configPda,
          vault: vaultPda,
          sessionKey: sessionKey.publicKey,
          usdcMint,
          vaultUsdc,
          gachaUsdc: attackerUsdc, // <-- attacker swaps destination
          feeUsdc,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([sessionKey])
        .rpc();
      assert.fail("should have thrown");
    } catch (e: any) {
      assert.include(e.toString(), "ConstraintAddress");
    }
  });

  it("purchase_pack: rejects a non-delegate signer", async () => {
    try {
      await program.methods
        .purchasePack(usd(10), feeFor(usd(10)), memo("11111111-aaaa-bbbb-cccc-000000000003"))
        .accountsPartial({
          config: configPda,
          vault: vaultPda,
          sessionKey: attacker.publicKey,
          usdcMint,
          vaultUsdc,
          gachaUsdc,
          feeUsdc,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([attacker])
        .rpc();
      assert.fail("should have thrown");
    } catch (e: any) {
      assert.include(e.toString(), "ConstraintHasOne");
    }
  });

  it("purchase_pack: fee below the corridor floor is rejected (FeeBelowMinimum)", async () => {
    // floor(50 USDC * 1%) = 0.5 USDC; one base unit less is under the floor.
    const amount = usd(50);
    const fee = feeFor(amount).subn(1);
    assert.isTrue(feeFor(amount).gtn(0)); // floor(min) > 0 for this amount
    try {
      await program.methods
        .purchasePack(amount, fee, memo("11111111-aaaa-bbbb-cccc-000000000006"))
        .accountsPartial({
          config: configPda,
          vault: vaultPda,
          sessionKey: sessionKey.publicKey,
          usdcMint,
          vaultUsdc,
          gachaUsdc,
          feeUsdc,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([sessionKey])
        .rpc();
      assert.fail("should have thrown");
    } catch (e: any) {
      assert.include(e.toString(), "FeeBelowMinimum");
    }
  });

  it("purchase_pack: fee above the corridor ceiling is rejected (FeeAboveMaximum)", async () => {
    // max_fee_bps = 5%: 50 USDC * 5% = 2.5 USDC; one base unit more breaks
    // fee * 10_000 <= amount * max_fee_bps (exact cross-multiplication).
    const amount = usd(50);
    const fee = amount.muln(MAX_FEE_BPS_CFG).divn(10_000).addn(1);
    try {
      await program.methods
        .purchasePack(amount, fee, memo("11111111-aaaa-bbbb-cccc-000000000007"))
        .accountsPartial({
          config: configPda,
          vault: vaultPda,
          sessionKey: sessionKey.publicKey,
          usdcMint,
          vaultUsdc,
          gachaUsdc,
          feeUsdc,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([sessionKey])
        .rpc();
      assert.fail("should have thrown");
    } catch (e: any) {
      assert.include(e.toString(), "FeeAboveMaximum");
    }
  });

  it("purchase_pack: fee exactly at the corridor ceiling passes, PackOpened carries owner + fee", async () => {
    // 20 USDC * 5% = 1 USDC — the boundary itself must be accepted.
    const amount = usd(20);
    const fee = amount.muln(MAX_FEE_BPS_CFG).divn(10_000);
    const m = memo("11111111-aaaa-bbbb-cccc-000000000008");
    const gachaBefore = (await getAccount(connection, gachaUsdc)).amount;
    const feeBefore = (await getAccount(connection, feeUsdc)).amount;
    const sig = await program.methods
      .purchasePack(amount, fee, m)
      .accountsPartial({
        config: configPda,
        vault: vaultPda,
        sessionKey: sessionKey.publicKey,
        usdcMint,
        vaultUsdc,
        gachaUsdc,
        feeUsdc,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([sessionKey])
      .rpc({ commitment: "confirmed", preflightCommitment: "confirmed" });

    const gachaAfter = (await getAccount(connection, gachaUsdc)).amount;
    const feeAfter = (await getAccount(connection, feeUsdc)).amount;
    assert.equal((gachaAfter - gachaBefore).toString(), amount.toString());
    assert.equal((feeAfter - feeBefore).toString(), fee.toString());

    const opened = (await eventsOf(sig)).find((e) => e.name === "packOpened");
    assert.ok(opened, "PackOpened not emitted");
    assert.ok((opened!.data.vault as PublicKey).equals(vaultPda));
    assert.ok((opened!.data.owner as PublicKey).equals(owner.publicKey)); // was cold_owner
    // The rename is pinned at the IDL level (a decoder can only ever produce
    // names that exist in the IDL, so asserting on decoded data would be vacuous).
    const packOpenedFields = idlStructFields("PackOpened");
    assert.include(packOpenedFields, "owner");
    assert.notInclude(packOpenedFields, "cold_owner");
    assert.equal(opened!.data.amount.toString(), amount.toString());
    assert.equal(opened!.data.fee.toString(), fee.toString());
    assert.equal(opened!.data.memo, m);
  });

  it("purchase_pack: per-spin cap is fee-inclusive (fee pushes total over)", async () => {
    // 299 alone fits the 300 cap; 299 + 1% fee = 301.99 must be refused.
    // (The bare above-cap case is covered by caps.rs::per_spin_cap_enforced.)
    try {
      await program.methods
        .purchasePack(usd(299), feeFor(usd(299)), memo("11111111-aaaa-bbbb-cccc-000000000004"))
        .accountsPartial({
          config: configPda,
          vault: vaultPda,
          sessionKey: sessionKey.publicKey,
          usdcMint,
          vaultUsdc,
          gachaUsdc,
          feeUsdc,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([sessionKey])
        .rpc();
      assert.fail("should have thrown");
    } catch (e: any) {
      assert.include(e.toString(), "ExceedsPerSpinCap");
    }
  });

  it("purchase_pack: enforces the daily cap (second vault, tight caps)", async () => {
    await program.methods
      .initVault(sessionKey.publicKey, usd(100 * 1.01), usd(150))
      .accountsPartial({
        vault: vault2Pda,
        owner: coldOwner2.publicKey,
        payer: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([coldOwner2])
      .rpc();
    await createAssociatedTokenAccount(
      connection,
      admin,
      usdcMint,
      vault2Pda,
      undefined,
      undefined,
      undefined,
      true
    );
    await mintTo(connection, admin, usdcMint, vault2Usdc, admin, 300_000_000);

    const spin = (uuid: string, amount: anchor.BN) =>
      program.methods
        .purchasePack(amount, feeFor(amount), memo(uuid))
        .accountsPartial({
          config: configPda,
          vault: vault2Pda,
          sessionKey: sessionKey.publicKey,
          usdcMint,
          vaultUsdc: vault2Usdc,
          gachaUsdc,
          feeUsdc,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([sessionKey])
        .rpc();

    // 100 + 1% fee = 101 charged; next 50-spin needs 50.5 more > 150 cap.
    await spin("22222222-aaaa-bbbb-cccc-000000000001", usd(100));
    try {
      await spin("22222222-aaaa-bbbb-cccc-000000000002", usd(50));
      assert.fail("should have thrown");
    } catch (e: any) {
      assert.include(e.toString(), "ExceedsDailyCap");
    }
  });

  it("update_vault: owner rotates the session key and SessionKeyRotated is emitted", async () => {
    const sig = await program.methods
      .updateVault(sessionKey2.publicKey, null, null)
      .accountsPartial({ vault: vault2Pda, owner: coldOwner2.publicKey })
      .signers([coldOwner2])
      .rpc({ commitment: "confirmed", preflightCommitment: "confirmed" });

    const vault = await program.account.vault.fetch(vault2Pda);
    assert.ok(vault.sessionKey.equals(sessionKey2.publicKey));

    const events = await eventsOf(sig);
    const rotated = events.find((e) => e.name === "sessionKeyRotated");
    assert.ok(
      rotated,
      `SessionKeyRotated not emitted, got: ${events.map((e) => e.name).join(",")}`
    );
    // Old event name gone — pinned at the IDL level.
    assert.notInclude(
      (program.idl as any).events.map((e: any) => e.name.toLowerCase()),
      "hotdelegaterotated"
    );
    assert.ok((rotated!.data.vault as PublicKey).equals(vault2Pda));
    assert.ok((rotated!.data.sessionKey as PublicKey).equals(sessionKey2.publicKey));
    assert.deepEqual(idlStructFields("SessionKeyRotated"), ["vault", "session_key"]);

    // Caps-only update: no rotation event.
    const sig2 = await program.methods
      .updateVault(null, null, usd(200))
      .accountsPartial({ vault: vault2Pda, owner: coldOwner2.publicKey })
      .signers([coldOwner2])
      .rpc({ commitment: "confirmed", preflightCommitment: "confirmed" });
    assert.isUndefined(
      (await eventsOf(sig2)).find((e) => e.name === "sessionKeyRotated")
    );
  });

  it("update_vault: the session key cannot rotate itself", async () => {
    // sessionKey2 is vault2's CURRENT session key after the rotation above.
    try {
      await program.methods
        .updateVault(attacker.publicKey, null, null)
        .accountsPartial({ vault: vault2Pda, owner: sessionKey2.publicKey })
        .signers([sessionKey2])
        .rpc();
      assert.fail("should have thrown");
    } catch (e: any) {
      assert.include(e.toString(), "ConstraintSeeds");
    }
  });

  it("close_vault: closes a clean vault, rent returns to the cold owner", async () => {
    // Recover the balance and close its ATA before closing the vault itself.
    const recipient = await createAssociatedTokenAccount(
      connection, admin, usdcMint, coldOwner2.publicKey
    );
    const balance = (await getAccount(connection, vault2Usdc)).amount;
    await program.methods
      .withdrawToken(new anchor.BN(balance.toString()))
      .accountsPartial({
        vault: vault2Pda, owner: coldOwner2.publicKey, source: vault2Usdc,
        mint: usdcMint, destination: recipient, tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([coldOwner2]).rpc();
    await program.methods.closeTokenAccount()
      .accountsPartial({ vault: vault2Pda, owner: coldOwner2.publicKey,
        token: vault2Usdc, tokenProgram: TOKEN_PROGRAM_ID })
      .signers([coldOwner2]).rpc();
    await program.methods
      .closeVault()
      .accountsPartial({ vault: vault2Pda, owner: coldOwner2.publicKey })
      .signers([coldOwner2])
      .rpc();
    assert.isNull(await program.account.vault.fetchNullable(vault2Pda));
  });

  it("withdraw_token: hot key cannot withdraw", async () => {
    try {
      await program.methods
        .withdrawToken(usd(1))
        .accountsPartial({
          vault: vaultPda,
          owner: sessionKey.publicKey, // wrong authority
          source: vaultUsdc,
          mint: usdcMint,
          destination: attackerUsdc,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([sessionKey])
        .rpc();
      assert.fail("should have thrown");
    } catch (e: any) {
      // vault PDA seeds derive from owner, so a wrong signer breaks them
      assert.include(e.toString(), "ConstraintSeeds");
    }
  });

  it("withdraw_token: cold key withdraws anywhere", async () => {
    const coldUsdc = await createAssociatedTokenAccount(
      connection,
      admin,
      usdcMint,
      owner.publicKey
    );
    await program.methods
      .withdrawToken(usd(100))
      .accountsPartial({
        vault: vaultPda,
        owner: owner.publicKey,
        source: vaultUsdc,
        mint: usdcMint,
        destination: coldUsdc,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([owner])
      .rpc();
    const acc = await getAccount(connection, coldUsdc);
    assert.equal(acc.amount.toString(), usd(100).toString());
  });

  it("close_token_account: cold key reclaims rent from an empty vault ATA", async () => {
    // A separate throwaway mint stands in for a GC'able empty account.
    const junkMint = await createMint(connection, admin, admin.publicKey, null, 0);
    const junkAta = await createAssociatedTokenAccount(
      connection,
      admin,
      junkMint,
      vaultPda,
      undefined,
      undefined,
      undefined,
      true
    );

    const before = await connection.getBalance(owner.publicKey);
    await program.methods
      .closeTokenAccount()
      .accountsPartial({
        vault: vaultPda,
        owner: owner.publicKey,
        token: junkAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([owner])
      .rpc();

    assert.isNull(await connection.getAccountInfo(junkAta));
    const after = await connection.getBalance(owner.publicKey);
    assert.isAbove(after, before); // rent came back (minus tx fee paid by provider)
  });

  it("withdraw_sol: cold key sweeps excess lamports, rent floor stays", async () => {
    const topUp = anchor.web3.SystemProgram.transfer({
      fromPubkey: admin.publicKey,
      toPubkey: vaultPda,
      lamports: 0.1 * LAMPORTS_PER_SOL,
    });
    await provider.sendAndConfirm(new anchor.web3.Transaction().add(topUp));

    await program.methods
      .withdrawSol(new anchor.BN(0.1 * LAMPORTS_PER_SOL))
      .accountsPartial({
        vault: vaultPda,
        owner: owner.publicKey,
        recipient: owner.publicKey,
      })
      .signers([owner])
      .rpc();

    try {
      await program.methods
        .withdrawSol(new anchor.BN(LAMPORTS_PER_SOL)) // more than remains above rent
        .accountsPartial({
          vault: vaultPda,
          owner: owner.publicKey,
          recipient: owner.publicKey,
        })
        .signers([owner])
        .rpc();
      assert.fail("should have thrown");
    } catch (e: any) {
      assert.include(e.toString(), "InsufficientSol");
    }
  });

  it("withdraw_sol: rejects a zero amount and the vault as its own recipient", async () => {
    try {
      await program.methods
        .withdrawSol(new anchor.BN(0))
        .accountsPartial({
          vault: vaultPda,
          owner: owner.publicKey,
          recipient: owner.publicKey,
        })
        .signers([owner])
        .rpc();
      assert.fail("should have thrown");
    } catch (e: any) {
      assert.include(e.toString(), "ZeroAmount");
    }

    // Aliasing the vault into the recipient slot would net out to a no-op and
    // report success, so it is refused outright.
    try {
      await program.methods
        .withdrawSol(new anchor.BN(1))
        .accountsPartial({
          vault: vaultPda,
          owner: owner.publicKey,
          recipient: vaultPda,
        })
        .signers([owner])
        .rpc();
      assert.fail("should have thrown");
    } catch (e: any) {
      assert.include(e.toString(), "Unauthorized");
    }
  });

  it("pause blocks purchase_pack", async () => {
    await program.methods
      .updateConfig(null, null, null, null, null, true)
      .accountsPartial({ config: configPda, admin: admin.publicKey })
      .rpc();
    try {
      await program.methods
        .purchasePack(usd(10), feeFor(usd(10)), memo("11111111-aaaa-bbbb-cccc-000000000005"))
        .accountsPartial({
          config: configPda,
          vault: vaultPda,
          sessionKey: sessionKey.publicKey,
          usdcMint,
          vaultUsdc,
          gachaUsdc,
          feeUsdc,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([sessionKey])
        .rpc();
      assert.fail("should have thrown");
    } catch (e: any) {
      assert.include(e.toString(), "Paused");
    }
  });

  it("update_config: non-admin is rejected", async () => {
    try {
      await program.methods
        .updateConfig(null, null, null, null, null, false)
        .accountsPartial({ config: configPda, admin: attacker.publicKey })
        .signers([attacker])
        .rpc();
      assert.fail("should have thrown");
    } catch (e: any) {
      assert.include(e.toString(), "ConstraintHasOne");
    }
  });

  it("update_config: fee above MAX_FEE_BPS is rejected", async () => {
    try {
      await program.methods
        .updateConfig(null, null, null, null, 5000, null)
        .accountsPartial({ config: configPda, admin: admin.publicKey })
        .rpc();
      assert.fail("should have thrown");
    } catch (e: any) {
      assert.include(e.toString(), "InvalidFeeBps");
    }
  });

  it("update_config: max_fee_bps below min_fee_bps is rejected", async () => {
    // min stays 100 (1%); max = 50 would invert the corridor.
    try {
      await program.methods
        .updateConfig(null, null, null, null, FEE_BPS - 50, null)
        .accountsPartial({ config: configPda, admin: admin.publicKey })
        .rpc();
      assert.fail("should have thrown");
    } catch (e: any) {
      assert.include(e.toString(), "InvalidFeeBps");
    }
    // Raising min above the current max in one call fails the same way.
    try {
      await program.methods
        .updateConfig(null, null, null, MAX_FEE_BPS_CFG + 1, null, null)
        .accountsPartial({ config: configPda, admin: admin.publicKey })
        .rpc();
      assert.fail("should have thrown");
    } catch (e: any) {
      assert.include(e.toString(), "InvalidFeeBps");
    }
    const cfg = await program.account.config.fetch(configPda);
    assert.equal(cfg.minFeeBps, FEE_BPS);
    assert.equal(cfg.maxFeeBps, MAX_FEE_BPS_CFG);
  });
});
