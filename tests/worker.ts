import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  AddressLookupTableProgram,
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddressSync,
  mintTo,
} from "@solana/spl-token";
import BN from "bn.js";

const VAULT_PROGRAM = new PublicKey("4saonDbBXhXJQ8TPvb7gMdrDNrkmpuRvjwCxqu1UDPxQ");
const TREASURY = new PublicKey("1f8NG4HixGS6wREigBXMbK7rZn3NU3WpDzKWDij79g6");

describe("wrapper worker — one ticket, no hands", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const wrap = anchor.workspace.GsmiWrapper as Program;
  const vaultProg = anchor.workspace.GsmiVault as Program;
  const owner = provider.wallet.publicKey;
  const conn = provider.connection;
  const payer = (provider.wallet as any).payer;

  const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], wrap.programId);
  const vaultIdBuf = Buffer.alloc(8);
  vaultIdBuf.writeBigUInt64LE(BigInt(99));
  const [vault] = PublicKey.findProgramAddressSync(
    [Buffer.from("gsmi_vault"), vaultIdBuf],
    VAULT_PROGRAM
  );
  const [sharesMint] = PublicKey.findProgramAddressSync(
    [Buffer.from("gsmi_shares"), vault.toBuffer()],
    VAULT_PROGRAM
  );

  const mints: PublicKey[] = [];
  const offered = 1_000_000;
  const solIn = 40_000_000;
  const budget = 5_000_000;

  function ticketPda(n: number) {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(BigInt(n));
    return PublicKey.findProgramAddressSync(
      [Buffer.from("ticket"), owner.toBuffer(), buf],
      wrap.programId
    )[0];
  }

  async function sendV0(instructions: any[], luts: any[] = []) {
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
    const tx = new VersionedTransaction(
      new TransactionMessage({
        payerKey: owner,
        recentBlockhash: blockhash,
        instructions,
      }).compileToV0Message(luts)
    );
    tx.sign([payer]);
    const s = await conn.sendTransaction(tx, { skipPreflight: false });
    await conn.confirmTransaction({ signature: s, blockhash, lastValidBlockHeight });
    return s;
  }

  it("crank mint ticket 204 to Done", async () => {
    const v = await vaultProg.account.vault.fetch(vault);
    for (let i = 0; i < 8; i++) mints.push(v.assets[i].mint);

    const nonce = new BN(204);
    const ticket = ticketPda(204);
    const seats = [...Array(8)].map((_, i) =>
      PublicKey.findProgramAddressSync(
        [Buffer.from("seat"), ticket.toBuffer(), Buffer.from([i])],
        wrap.programId
      )[0]
    );

    const live = await conn.getAccountInfo(ticket);
    if (live) {
      const t = await wrap.account.ticket.fetch(ticket);
      if (t.status.done) {
        console.log("204 already Done");
        return;
      }
    } else {
      await wrap.methods
        .openMint(nonce, new BN(solIn), new BN(1), 32)
        .accounts({ owner, config, ticket, systemProgram: SystemProgram.programId })
        .rpc();
    }

    if (!(await conn.getAccountInfo(seats[0]))) {
      const budgets = [...Array(8)].map(() => new BN(budget));
      await wrap.methods.splitMint(budgets).accounts({
        cranker: owner,
        ticket,
        seat0: seats[0], seat1: seats[1], seat2: seats[2], seat3: seats[3],
        seat4: seats[4], seat5: seats[5], seat6: seats[6], seat7: seats[7],
        systemProgram: SystemProgram.programId,
      }).rpc();
    }

    for (let i = 0; i < 8; i++) {
      const s = await wrap.account.seat.fetch(seats[i]);
      if (s.done) continue;
      const pool = await getOrCreateAssociatedTokenAccount(conn, payer, mints[i], owner);
      const dest = await getOrCreateAssociatedTokenAccount(conn, payer, mints[i], ticket, true);
      await mintTo(conn, payer, mints[i], pool.address, owner, offered);
      await wrap.methods.localCrankBuy(i, new BN(offered)).accounts({
        cranker: owner,
        ticket,
        seatAcc: seats[i],
      }).remainingAccounts([
        { pubkey: TOKEN_PROGRAM_ID, isWritable: false, isSigner: false },
        { pubkey: TOKEN_2022_PROGRAM_ID, isWritable: false, isSigner: false },
        { pubkey: pool.address, isWritable: true, isSigner: false },
        { pubkey: dest.address, isWritable: true, isSigner: false },
      ]).rpc();
    }

    const t = await wrap.account.ticket.fetch(ticket);
    if (t.status.done) return;

    const ticketShares = getAssociatedTokenAddressSync(sharesMint, ticket, true);
    const ownerShares = getAssociatedTokenAddressSync(sharesMint, owner);
    await getOrCreateAssociatedTokenAccount(conn, payer, sharesMint, ticket, true);
    await getOrCreateAssociatedTokenAccount(conn, payer, sharesMint, owner);

    const remaining: { pubkey: PublicKey; isWritable: boolean; isSigner: boolean }[] = [
      ...seats.map((s) => ({ pubkey: s, isWritable: true, isSigner: false })),
    ];
    for (let i = 0; i < 8; i++) {
      const tAta = await getOrCreateAssociatedTokenAccount(conn, payer, mints[i], ticket, true);
      const vAta = await getOrCreateAssociatedTokenAccount(conn, payer, mints[i], vault, true);
      const rAta = await getOrCreateAssociatedTokenAccount(conn, payer, mints[i], TREASURY, true);
      remaining.push({ pubkey: tAta.address, isWritable: true, isSigner: false });
      remaining.push({ pubkey: vAta.address, isWritable: true, isSigner: false });
      remaining.push({ pubkey: rAta.address, isWritable: true, isSigner: false });
    }

    const ix = await wrap.methods
      .finishMint([...Array(8)].map(() => new BN(offered)), new BN(1_000_000_000), new BN(1))
      .accounts({
        cranker: owner, config, ticket, owner, vault, sharesMint, ticketShares, ownerShares,
        vaultProgram: VAULT_PROGRAM,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .remainingAccounts(remaining)
      .instruction();

    const slot = await conn.getSlot();
    const [createLut, lutPk] = AddressLookupTableProgram.createLookupTable({
      authority: owner, payer: owner, recentSlot: slot - 1,
    });
    await sendV0([createLut]);
    const lutKeys = [
      owner, config, ticket, vault, sharesMint, ticketShares, ownerShares,
      VAULT_PROGRAM, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
      ...remaining.map((a) => a.pubkey),
    ];
    for (let i = 0; i < lutKeys.length; i += 12) {
      await sendV0([
        AddressLookupTableProgram.extendLookupTable({
          payer: owner, authority: owner, lookupTable: lutPk,
          addresses: lutKeys.slice(i, i + 12),
        }),
      ]);
    }
    await new Promise((r) => setTimeout(r, 1500));
    const lutAcc = await conn.getAddressLookupTable(lutPk);
    if (!lutAcc.value) throw new Error("LUT missing");
    const before = await conn.getTokenAccountBalance(ownerShares);
    const sig = await sendV0(
      [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ix],
      [lutAcc.value]
    );
    console.log("worker mint finish", sig);
    const after = await conn.getTokenAccountBalance(ownerShares);
    console.log("owner GSMI", before.value.amount, "->", after.value.amount);
    const done = await wrap.account.ticket.fetch(ticket);
    if (!done.status.done) throw new Error("204 not Done");
  });

  it("crank redeem ticket 205 to Done", async () => {
    const nonce = new BN(205);
    const ticket = ticketPda(205);
    const burnShares = new BN(100_000_000);
    const ownerShares = getAssociatedTokenAddressSync(sharesMint, owner);
    const bal = await conn.getTokenAccountBalance(ownerShares);
    if (BigInt(bal.value.amount) < BigInt(burnShares.toString())) {
      throw new Error("need GSMI after worker mint");
    }
    await getOrCreateAssociatedTokenAccount(conn, payer, sharesMint, ticket, true);
    const ticketShares = getAssociatedTokenAddressSync(sharesMint, ticket, true);

    const live = await conn.getAccountInfo(ticket);
    if (live) {
      const t = await wrap.account.ticket.fetch(ticket);
      if (t.status.done) {
        console.log("205 already Done");
        return;
      }
    } else {
      await wrap.methods
        .openRedeem(nonce, burnShares, new BN(1_000_000), 32)
        .accounts({
          owner, config, ticket, ownerShares, ticketShares,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }

    const t0 = await wrap.account.ticket.fetch(ticket);
    if (!t0.status.basketOut && !t0.status.done) {
      const remaining = [];
      for (let i = 0; i < 8; i++) {
        const vAta = await getOrCreateAssociatedTokenAccount(conn, payer, mints[i], vault, true);
        const uAta = await getOrCreateAssociatedTokenAccount(conn, payer, mints[i], ticket, true);
        remaining.push({ pubkey: vAta.address, isWritable: true, isSigner: false });
        remaining.push({ pubkey: uAta.address, isWritable: true, isSigner: false });
      }
      await wrap.methods.crankRedeemBasket(burnShares).accounts({
        cranker: owner, config, ticket, vault, sharesMint, ticketShares,
        vaultProgram: VAULT_PROGRAM,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      }).remainingAccounts(remaining).rpc();
    }

    const t1 = await wrap.account.ticket.fetch(ticket);
    if (t1.status.done) return;

    const ticketAtas: PublicKey[] = [];
    for (let i = 0; i < 8; i++) {
      const from = getAssociatedTokenAddressSync(mints[i], ticket, true);
      ticketAtas.push(from);
      const amt = (await conn.getTokenAccountBalance(from)).value.amount;
      if (BigInt(amt) === BigInt(0)) continue;
      const pool = await getOrCreateAssociatedTokenAccount(conn, payer, mints[i], owner);
      await wrap.methods.localCrankSell(i, new BN(200_000)).accounts({
        cranker: owner,
        ticket,
        systemProgram: SystemProgram.programId,
      }).remainingAccounts([
        { pubkey: TOKEN_PROGRAM_ID, isWritable: false, isSigner: false },
        { pubkey: TOKEN_2022_PROGRAM_ID, isWritable: false, isSigner: false },
        { pubkey: from, isWritable: true, isSigner: false },
        { pubkey: pool.address, isWritable: true, isSigner: false },
      ]).rpc();
    }

    const before = await conn.getBalance(owner);
    await wrap.methods.finishRedeemSol().accounts({
      cranker: owner, config, ticket, owner,
    }).remainingAccounts(
      ticketAtas.map((a) => ({ pubkey: a, isWritable: false, isSigner: false }))
    ).rpc();
    const after = await conn.getBalance(owner);
    const done = await wrap.account.ticket.fetch(ticket);
    if (!done.status.done) throw new Error("205 not Done");
    if (after <= before) throw new Error("expected SOL back");
    console.log("worker redeem Done, SOL", before, "->", after);
  });
});
