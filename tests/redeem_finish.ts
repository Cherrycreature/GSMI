import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import BN from "bn.js";

const VAULT_PROGRAM = new PublicKey("4saonDbBXhXJQ8TPvb7gMdrDNrkmpuRvjwCxqu1UDPxQ");

describe("wrapper redeem — finish_redeem_sol", () => {
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

  const nonce = new BN(201);
  const nonceBuf = Buffer.alloc(8);
  nonceBuf.writeBigUInt64LE(BigInt(201));
  const [ticket] = PublicKey.findProgramAddressSync(
    [Buffer.from("ticket"), owner.toBuffer(), nonceBuf],
    wrap.programId
  );

  const mints: PublicKey[] = [];
  const burnShares = new BN(100_000_000);
  const minSol = new BN(1_000_000);
  const ticketAtas: PublicKey[] = [];

  it("open_redeem + basket CPI nonce 201", async () => {
    const v = await vaultProg.account.vault.fetch(vault);
    if (!v.opened) throw new Error("vault 99 not opened");
    for (let i = 0; i < 8; i++) mints.push(v.assets[i].mint);

    const ownerShares = getAssociatedTokenAddressSync(sharesMint, owner);
    const bal = await conn.getTokenAccountBalance(ownerShares);
    if (BigInt(bal.value.amount) < BigInt(burnShares.toString())) {
      throw new Error("need 1e8 GSMI left after the cancel redeem");
    }

    await getOrCreateAssociatedTokenAccount(conn, payer, sharesMint, ticket, true);
    const ticketShares = getAssociatedTokenAddressSync(sharesMint, ticket, true);

    if (!(await conn.getAccountInfo(ticket))) {
      await wrap.methods
        .openRedeem(nonce, burnShares, minSol, 32)
        .accounts({
          owner,
          config,
          ticket,
          ownerShares,
          ticketShares,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }

    const t0 = await wrap.account.ticket.fetch(ticket);
    if (t0.status.open) {
      const remaining = [];
      for (let i = 0; i < 8; i++) {
        const vAta = await getOrCreateAssociatedTokenAccount(conn, payer, mints[i], vault, true);
        const uAta = await getOrCreateAssociatedTokenAccount(conn, payer, mints[i], ticket, true);
        ticketAtas.push(uAta.address);
        remaining.push({ pubkey: vAta.address, isWritable: true, isSigner: false });
        remaining.push({ pubkey: uAta.address, isWritable: true, isSigner: false });
      }
      const sig = await wrap.methods
        .crankRedeemBasket(burnShares)
        .accounts({
          cranker: owner,
          config,
          ticket,
          vault,
          sharesMint,
          ticketShares,
          vaultProgram: VAULT_PROGRAM,
          tokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .remainingAccounts(remaining)
        .rpc();
      console.log("basket 201", sig);
    } else {
      for (let i = 0; i < 8; i++) {
        ticketAtas.push(getAssociatedTokenAddressSync(mints[i], ticket, true));
      }
    }
  });

  it("local_clear_seats then finish_redeem_sol", async () => {
    const t0 = await wrap.account.ticket.fetch(ticket);
    if (t0.status.done) {
      console.log("ticket 201 already Done");
      return;
    }
    if (!t0.status.basketOut) throw new Error("expected BasketOut");

    if (ticketAtas.length !== 8) {
      for (let i = 0; i < 8; i++) {
        ticketAtas.push(getAssociatedTokenAddressSync(mints[i], ticket, true));
      }
    }

    const pairs = [];
    for (let i = 0; i < 8; i++) {
      const to = await getOrCreateAssociatedTokenAccount(conn, payer, mints[i], owner);
      pairs.push({ pubkey: ticketAtas[i], isWritable: true, isSigner: false });
      pairs.push({ pubkey: to.address, isWritable: true, isSigner: false });
    }

    const clearSig = await wrap.methods
      .localClearSeats()
      .accounts({
        cranker: owner,
        ticket,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .remainingAccounts(pairs)
      .rpc();
    console.log("local_clear_seats", clearSig);

    for (let i = 0; i < 8; i++) {
      const b = await conn.getTokenAccountBalance(ticketAtas[i]);
      if (b.value.amount !== "0") throw new Error("seat " + i + " still " + b.value.amount);
    }

    const ix = SystemProgram.transfer({
      fromPubkey: owner,
      toPubkey: ticket,
      lamports: 2_000_000,
    });
    await provider.sendAndConfirm(new Transaction().add(ix));

    const before = await conn.getBalance(owner);
    const finishSig = await wrap.methods
      .finishRedeemSol()
      .accounts({
        cranker: owner,
        config,
        ticket,
        owner,
      })
      .remainingAccounts(
        ticketAtas.map((a) => ({ pubkey: a, isWritable: false, isSigner: false }))
      )
      .rpc();
    console.log("finish_redeem_sol", finishSig);

    const t = await wrap.account.ticket.fetch(ticket);
    if (!t.status.done) throw new Error("expected Done");
    const after = await conn.getBalance(owner);
    console.log("owner lamports delta", after - before);
    if (after <= before - 20_000) {
      // fee eats some; still must have received the 2e6 minus rent stay
      console.log("owner did not obviously receive SOL — check ticket leftover");
    }
    const ticketLamports = (await conn.getAccountInfo(ticket))?.lamports ?? 0;
    console.log("ticket rent left", ticketLamports);
  });
});
