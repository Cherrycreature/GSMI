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

describe("wrapper redeem — basket out + owner cancel", () => {
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

  const nonce = new BN(200);
  const nonceBuf = Buffer.alloc(8);
  nonceBuf.writeBigUInt64LE(BigInt(200));
  const [ticket] = PublicKey.findProgramAddressSync(
    [Buffer.from("ticket"), owner.toBuffer(), nonceBuf],
    wrap.programId
  );

  const mints: PublicKey[] = [];
  const burnShares = new BN(100_000_000);

  it("need vault 99 open + owner GSMI", async () => {
    const vaultInfo = await conn.getAccountInfo(vault);
    if (!vaultInfo) throw new Error("vault 99 missing — run chip tests first, do not reset validator");
    const v = await vaultProg.account.vault.fetch(vault);
    if (!v.opened) throw new Error("vault 99 not opened — finish_mint first fill has not landed");
    for (let i = 0; i < 8; i++) mints.push(v.assets[i].mint);

    const ownerShares = getAssociatedTokenAddressSync(sharesMint, owner);
    const bal = await conn.getTokenAccountBalance(ownerShares);
    console.log("owner GSMI", bal.value.amount);
    if (BigInt(bal.value.amount) < BigInt(burnShares.toString())) {
      throw new Error("owner needs at least 1e8 GSMI from the mint test");
    }
  });

  it("open_redeem 0.1 GSMI", async () => {
    const ownerShares = getAssociatedTokenAddressSync(sharesMint, owner);
    await getOrCreateAssociatedTokenAccount(conn, payer, sharesMint, ticket, true);
    const ticketShares = getAssociatedTokenAddressSync(sharesMint, ticket, true);

    if (await conn.getAccountInfo(ticket)) {
      console.log("ticket 200 already open");
      return;
    }

    const sig = await wrap.methods
      .openRedeem(nonce, burnShares, new BN(1), 32)
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
    console.log("open_redeem", sig);
    const t = await wrap.account.ticket.fetch(ticket);
    if (!t.side.redeemGsmi) throw new Error("side not redeem");
    if (t.sharesIn.toString() !== burnShares.toString()) throw new Error("shares_in");
  });

  it("crank_redeem_basket CPI", async () => {
    const t0 = await wrap.account.ticket.fetch(ticket);
    if (t0.status.basketOut || t0.status.cancelled || t0.status.done) {
      console.log("ticket 200 already past redeem CPI");
      return;
    }

    const ticketShares = getAssociatedTokenAddressSync(sharesMint, ticket, true);
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
    console.log("crank_redeem_basket", sig);

    const t = await wrap.account.ticket.fetch(ticket);
    if (!t.status.basketOut) throw new Error("expected BasketOut");
    for (let i = 0; i < 8; i++) {
      const uAta = getAssociatedTokenAddressSync(mints[i], ticket, true);
      const b = await conn.getTokenAccountBalance(uAta);
      console.log("ticket seat", i, b.value.amount);
    }
  });

  it("cancel after 32 slots returns seat tokens to owner", async () => {
    const t0 = await wrap.account.ticket.fetch(ticket);
    if (t0.status.cancelled || t0.status.done) {
      console.log("ticket 200 already closed");
      return;
    }

    const start = await conn.getSlot();
    const due = t0.openSlot.toNumber() + t0.cancelSlots;
    while ((await conn.getSlot()) < due) {
      await new Promise((r) => setTimeout(r, 400));
    }
    console.log("waited", (await conn.getSlot()) - start, "slots");

    const pairs = [];
    for (let i = 0; i < 8; i++) {
      const from = getAssociatedTokenAddressSync(mints[i], ticket, true);
      const toAcc = await getOrCreateAssociatedTokenAccount(conn, payer, mints[i], owner);
      pairs.push({ pubkey: from, isWritable: true, isSigner: false });
      pairs.push({ pubkey: toAcc.address, isWritable: true, isSigner: false });
    }

    const sig = await wrap.methods
      .cancel()
      .accounts({
        owner,
        ticket,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .remainingAccounts(pairs)
      .rpc();
    console.log("cancel redeem", sig);

    const closed = await conn.getAccountInfo(ticket);
    if (closed) throw new Error("ticket still open after cancel");
    for (let i = 0; i < 8; i++) {
      const ownerAta = getAssociatedTokenAddressSync(mints[i], owner);
      const b = await conn.getTokenAccountBalance(ownerAta);
      console.log("owner seat", i, b.value.amount);
    }
  });
});
