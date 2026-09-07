import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  AddressLookupTableProgram,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import BN from "bn.js";

const TREASURY = new PublicKey("1f8NG4HixGS6wREigBXMbK7rZn3NU3WpDzKWDij79g6");
const VAULT_PROGRAM = new PublicKey("4saonDbBXhXJQ8TPvb7gMdrDNrkmpuRvjwCxqu1UDPxQ");
const JUPITER = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
const VAULT_ID = new BN(99);

describe("wrapper chip — finish_mint into local-mints vault", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const wrap = anchor.workspace.GsmiWrapper as Program;
  const vaultProg = anchor.workspace.GsmiVault as Program;
  const owner = provider.wallet.publicKey;
  const conn = provider.connection;

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

  const nonce = new BN(99);
  const nonceBuf = Buffer.alloc(8);
  nonceBuf.writeBigUInt64LE(BigInt(99));
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

  it("local eight mints + vault 99", async () => {
    if (!vaultProg) {
      throw new Error("workspace missing GsmiVault — build both programs");
    }
    const vaultInfo = await conn.getAccountInfo(vault);
    if (vaultInfo) {
      const v = await vaultProg.account.vault.fetch(vault);
      for (let i = 0; i < 8; i++) {
        mints.push(v.assets[i].mint);
        console.log("mint", i, mints[i].toBase58(), "(from vault 99)");
      }
    } else {
    for (let i = 0; i < 8; i++) {
      const mint = await createMint(conn, (provider.wallet as any).payer, owner, null, 6);
      mints.push(mint);
      console.log("mint", i, mint.toBase58());
    }
      const sig = await vaultProg.methods
        .initialize(VAULT_ID)
        .accounts({
          opener: owner,
          vault,
          sharesMint,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .remainingAccounts(mints.map((m) => ({ pubkey: m, isWritable: false, isSigner: false })))
        .rpc();
      console.log("vault 99 init", sig);
    }
    console.log("shares", sharesMint.toBase58());
  });

  it("wrapper config → vault 99", async () => {
    const info = await conn.getAccountInfo(config);
    if (!info) {
      const sig = await wrap.methods
        .initConfig(32, vault, sharesMint, VAULT_PROGRAM, JUPITER)
        .accounts({
          payer: owner,
          config,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      console.log("init_config chip", sig);
      return;
    }
    const c = await wrap.account.config.fetch(config);
    if (!c.vault.equals(vault)) {
      throw new Error(
        "config already points at " +
          c.vault.toBase58() +
          " not vault 99 " +
          vault.toBase58() +
          " — restart local validator, redeploy both, rerun"
      );
    }
    console.log("config already chip", config.toBase58());
  });

  it("open + split + mark + first fill CPI", async () => {
    if (mints.length !== 8) throw new Error("mints missing — previous it failed");

    const existingTicket = await conn.getAccountInfo(ticket);
    if (existingTicket) {
      const t0 = await wrap.account.ticket.fetch(ticket);
      if (t0.status.done) {
        console.log("ticket 99 already Done — chip already filled");
        return;
      }
    }

    if (!(await conn.getAccountInfo(ticket))) {
      await wrap.methods
        .openMint(nonce, new BN(50_000_000), new BN(1), 32)
        .accounts({
          owner,
          config,
          ticket,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }
    if (!(await conn.getAccountInfo(seats[0]))) {
      const budgets = [...Array(8)].map(() => new BN(5_000_000));
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

    for (let i = 0; i < 8; i++) {
      const s = await wrap.account.seat.fetch(seats[i]);
      if (!s.done) {
        await wrap.methods.markSeat(i).accounts({
          cranker: owner,
          ticket,
          seatAcc: seats[i],
        }).rpc();
      }
    }

    const offered = 1_000_000;
    const ticketAtas: PublicKey[] = [];
    const vaultAtas: PublicKey[] = [];
    const treasAtas: PublicKey[] = [];
    const payer = (provider.wallet as any).payer;

    for (let i = 0; i < 8; i++) {
      const tAta = await getOrCreateAssociatedTokenAccount(conn, payer, mints[i], ticket, true);
      const vAta = await getOrCreateAssociatedTokenAccount(conn, payer, mints[i], vault, true);
      const rAta = await getOrCreateAssociatedTokenAccount(conn, payer, mints[i], TREASURY, true);
      await mintTo(conn, payer, mints[i], tAta.address, owner, offered);
      ticketAtas.push(tAta.address);
      vaultAtas.push(vAta.address);
      treasAtas.push(rAta.address);
    }

    const ticketShares = getAssociatedTokenAddressSync(sharesMint, ticket, true);
    const ownerShares = getAssociatedTokenAddressSync(sharesMint, owner);
    await getOrCreateAssociatedTokenAccount(conn, payer, sharesMint, ticket, true);
    await getOrCreateAssociatedTokenAccount(conn, payer, sharesMint, owner);

    const remaining = [
      ...seats.map((s) => ({ pubkey: s, isWritable: true, isSigner: false })),
      ...mints.flatMap((_, i) => [
        { pubkey: ticketAtas[i], isWritable: true, isSigner: false },
        { pubkey: vaultAtas[i], isWritable: true, isSigner: false },
        { pubkey: treasAtas[i], isWritable: true, isSigner: false },
      ]),
    ];

    const shares = new BN(1_000_000_000);
    const ix = await wrap.methods
      .finishMint(
        [...Array(8)].map(() => new BN(offered)),
        shares,
        new BN(1)
      )
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
      owner,
      config,
      ticket,
      vault,
      sharesMint,
      ticketShares,
      ownerShares,
      VAULT_PROGRAM,
      TOKEN_PROGRAM_ID,
      TOKEN_2022_PROGRAM_ID,
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
      const batch = lutKeys.slice(i, i + 12);
      await sendV0([
        AddressLookupTableProgram.extendLookupTable({
          payer: owner,
          authority: owner,
          lookupTable: lutPk,
          addresses: batch,
        }),
      ]);
    }
    await new Promise((r) => setTimeout(r, 1500));
    const lutAcc = await conn.getAddressLookupTable(lutPk);
    if (!lutAcc.value) throw new Error("LUT missing " + lutPk.toBase58());

    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
    const vtx = new VersionedTransaction(
      new TransactionMessage({
        payerKey: owner,
        recentBlockhash: blockhash,
        instructions: [ix],
      }).compileToV0Message([lutAcc.value])
    );
    vtx.sign([payer]);
    const sig = await conn.sendTransaction(vtx, { skipPreflight: false });
    await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight });

    const t = await wrap.account.ticket.fetch(ticket);
    const ownerAta = await conn.getTokenAccountBalance(ownerShares);
    console.log("finish_mint", sig);
    console.log("ticket status", t.status);
    console.log("owner GSMI", ownerAta.value.amount);
    if (ownerAta.value.amount !== "1000000000") {
      throw new Error("expected 1e9 shares on owner, got " + ownerAta.value.amount);
    }
  });
});
