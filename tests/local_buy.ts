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

describe("wrapper local_crank_buy — same shape as Jupiter buy", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const wrap = anchor.workspace.GsmiWrapper as Program;
  const vaultProg = anchor.workspace.GsmiVault as Program;
  const owner = provider.wallet.publicKey;
  const conn = provider.connection;
  const payer = (provider.wallet as any).payer;

  const [config] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    wrap.programId
  );

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

  const nonce = new BN(202);
  const nonceBuf = Buffer.alloc(8);
  nonceBuf.writeBigUInt64LE(BigInt(202));
  const [ticket] = PublicKey.findProgramAddressSync(
    [Buffer.from("ticket"), owner.toBuffer(), nonceBuf],
    wrap.programId
  );
  const seats = [...Array(8)].map((_, i) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("seat"), ticket.toBuffer(), Buffer.from([i])],
      wrap.programId
    )[0]
  );

  const mints: PublicKey[] = [];
  const offered = 1_000_000;
  const solIn = 40_000_000;
  const budget = 5_000_000;

  it("open + split nonce 202", async () => {
    const v = await vaultProg.account.vault.fetch(vault);
    for (let i = 0; i < 8; i++) mints.push(v.assets[i].mint);

    const live = await conn.getAccountInfo(ticket);
    if (live) {
      const t = await wrap.account.ticket.fetch(ticket);
      if (t.status.done || t.status.cancelled) {
        console.log("ticket 202 already closed", ticket.toBase58());
        return;
      }
    }
    if (!live) {
      await wrap.methods
        .openMint(nonce, new BN(solIn), new BN(1), 32)
        .accounts({
          owner,
          config,
          ticket,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }
    if (!(await conn.getAccountInfo(seats[0]))) {
      const budgets = [...Array(8)].map(() => new BN(budget));
      await wrap.methods.splitMint(budgets).accounts({
        cranker: owner,
        ticket,
        seat0: seats[0],
        seat1: seats[1],
        seat2: seats[2],
        seat3: seats[3],
        seat4: seats[4],
        seat5: seats[5],
        seat6: seats[6],
        seat7: seats[7],
        systemProgram: SystemProgram.programId,
      }).rpc();
    }
    console.log("ticket 202", ticket.toBase58());
  });

  it("eight local_crank_buy then finish_mint", async () => {
    const t0 = await wrap.account.ticket.fetch(ticket);
    if (t0.status.done) {
      console.log("ticket 202 already Done");
      return;
    }

    for (let i = 0; i < 8; i++) {
      const s = await wrap.account.seat.fetch(seats[i]);
      if (s.done) continue;
      const pool = await getOrCreateAssociatedTokenAccount(conn, payer, mints[i], owner);
      const dest = await getOrCreateAssociatedTokenAccount(conn, payer, mints[i], ticket, true);
      await mintTo(conn, payer, mints[i], pool.address, owner, offered);
      const sig = await wrap.methods
        .localCrankBuy(i, new BN(offered))
        .accounts({
          cranker: owner,
          ticket,
          seatAcc: seats[i],
        })
        .remainingAccounts([
          { pubkey: TOKEN_PROGRAM_ID, isWritable: false, isSigner: false },
          { pubkey: TOKEN_2022_PROGRAM_ID, isWritable: false, isSigner: false },
          { pubkey: pool.address, isWritable: true, isSigner: false },
          { pubkey: dest.address, isWritable: true, isSigner: false },
        ])
        .rpc();
      console.log("buy", i, sig);
    }

    const ticketShares = getAssociatedTokenAddressSync(sharesMint, ticket, true);
    const ownerShares = getAssociatedTokenAddressSync(sharesMint, owner);
    await getOrCreateAssociatedTokenAccount(conn, payer, sharesMint, ticket, true);
    await getOrCreateAssociatedTokenAccount(conn, payer, sharesMint, owner);

    const TREASURY = new PublicKey("1f8NG4HixGS6wREigBXMbK7rZn3NU3WpDzKWDij79g6");
    const remaining = [
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

    const offeredArr = [...Array(8)].map(() => new BN(offered));
    const before = await conn.getTokenAccountBalance(ownerShares);
    const ix = await wrap.methods
      .finishMint(offeredArr, new BN(1_000_000_000), new BN(1))
      .accounts({
        cranker: owner,
        config,
        ticket,
        owner,
        vault,
        sharesMint,
        ticketShares,
        ownerShares,
        vaultProgram: VAULT_PROGRAM,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .remainingAccounts(remaining)
      .instruction();

    const slot = await conn.getSlot();
    const [createLut, lutPk] = AddressLookupTableProgram.createLookupTable({
      authority: owner,
      payer: owner,
      recentSlot: slot - 1,
    });
    const lutKeys = [
      owner, config, ticket, vault, sharesMint, ticketShares, ownerShares,
      VAULT_PROGRAM, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
      ...remaining.map((a) => a.pubkey),
    ];
    const sendV0 = async (instructions: any[]) => {
      const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
      const tx = new VersionedTransaction(
        new TransactionMessage({
          payerKey: owner,
          recentBlockhash: blockhash,
          instructions,
        }).compileToV0Message()
      );
      tx.sign([payer]);
      const s = await conn.sendTransaction(tx, { skipPreflight: false });
      await conn.confirmTransaction({ signature: s, blockhash, lastValidBlockHeight });
      return s;
    };
    await sendV0([createLut]);
    for (let i = 0; i < lutKeys.length; i += 12) {
      await sendV0([
        AddressLookupTableProgram.extendLookupTable({
          payer: owner,
          authority: owner,
          lookupTable: lutPk,
          addresses: lutKeys.slice(i, i + 12),
        }),
      ]);
    }
    await new Promise((r) => setTimeout(r, 1500));
    const lutAcc = await conn.getAddressLookupTable(lutPk);
    if (!lutAcc.value) throw new Error("LUT missing");
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
    const vtx = new VersionedTransaction(
      new TransactionMessage({
        payerKey: owner,
        recentBlockhash: blockhash,
        instructions: [
          ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
          ix,
        ],
      }).compileToV0Message([lutAcc.value])
    );
    vtx.sign([payer]);
    const sig = await conn.sendTransaction(vtx, { skipPreflight: false });
    await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight });
    console.log("finish after local buys", sig);
    const after = await conn.getTokenAccountBalance(ownerShares);
    console.log("owner GSMI", before.value.amount, "->", after.value.amount);
    if (BigInt(after.value.amount) <= BigInt(before.value.amount)) {
      throw new Error("expected more GSMI after finish");
    }
  });
});
