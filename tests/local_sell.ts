import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import BN from "bn.js";

const VAULT_PROGRAM = new PublicKey("4saonDbBXhXJQ8TPvb7gMdrDNrkmpuRvjwCxqu1UDPxQ");

describe("wrapper local_crank_sell — same shape as Jupiter sell", () => {
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

  const nonce = new BN(203);
  const nonceBuf = Buffer.alloc(8);
  nonceBuf.writeBigUInt64LE(BigInt(203));
  const [ticket] = PublicKey.findProgramAddressSync(
    [Buffer.from("ticket"), owner.toBuffer(), nonceBuf],
    wrap.programId
  );

  const mints: PublicKey[] = [];
  const burnShares = new BN(100_000_000);
  const minSol = new BN(1_000_000);
  const solEach = new BN(200_000);

  it("open_redeem + basket CPI nonce 203", async () => {
    const v = await vaultProg.account.vault.fetch(vault);
    if (!v.opened) throw new Error("vault 99 not opened");
    for (let i = 0; i < 8; i++) mints.push(v.assets[i].mint);

    const ownerShares = getAssociatedTokenAddressSync(sharesMint, owner);
    const bal = await conn.getTokenAccountBalance(ownerShares);
    if (BigInt(bal.value.amount) < BigInt(burnShares.toString())) {
      throw new Error("need 1e8 GSMI for sell path");
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
    if (t0.status.basketOut || t0.status.done) {
      console.log("ticket 203 already past redeem CPI");
      return;
    }

    const remaining = [];
    for (let i = 0; i < 8; i++) {
      const vAta = await getOrCreateAssociatedTokenAccount(conn, payer, mints[i], vault, true);
      const uAta = await getOrCreateAssociatedTokenAccount(conn, payer, mints[i], ticket, true);
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
    console.log("redeem basket 203", sig);
  });

  it("eight local_crank_sell then finish_redeem_sol", async () => {
    const t0 = await wrap.account.ticket.fetch(ticket);
    if (t0.status.done) {
      console.log("ticket 203 already Done");
      return;
    }
    if (!t0.status.basketOut) throw new Error("expected BasketOut");

    const ticketAtas: PublicKey[] = [];
    for (let i = 0; i < 8; i++) {
      const from = getAssociatedTokenAddressSync(mints[i], ticket, true);
      ticketAtas.push(from);
      const bal = await conn.getTokenAccountBalance(from);
      if (BigInt(bal.value.amount) === BigInt(0)) {
        console.log("seat", i, "already sold");
        continue;
      }
      const pool = await getOrCreateAssociatedTokenAccount(conn, payer, mints[i], owner);
      const sig = await wrap.methods
        .localCrankSell(i, solEach)
        .accounts({
          cranker: owner,
          ticket,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts([
          { pubkey: TOKEN_PROGRAM_ID, isWritable: false, isSigner: false },
          { pubkey: TOKEN_2022_PROGRAM_ID, isWritable: false, isSigner: false },
          { pubkey: from, isWritable: true, isSigner: false },
          { pubkey: pool.address, isWritable: true, isSigner: false },
        ])
        .rpc();
      console.log("sell", i, sig);
    }

    const before = await conn.getBalance(owner);
    const sig = await wrap.methods
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
    console.log("finish sell path", sig);
    const after = await conn.getBalance(owner);
    console.log("owner SOL", before, "->", after);
    const t = await wrap.account.ticket.fetch(ticket);
    if (!t.status.done) throw new Error("expected Done");
    if (after <= before) throw new Error("expected SOL back");
  });
});
