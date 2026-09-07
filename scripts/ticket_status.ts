/**
 * Dump one wrapper ticket. Resume-safe. Does not send.
 *
 *   npx --yes tsx scripts/ticket_status.ts --nonce=661472941
 *   npx --yes tsx scripts/ticket_status.ts --ticket=AbRMB...
 */
import { Connection, PublicKey } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import fs from "fs";
import os from "os";

const WRAP = new PublicKey("4FMpDudDHnQkXp3Y6FjCfd4BKELxHzYrjTSwrMs3T5F2");
const SHARES = new PublicKey("W1yo6FyJgfGTtj75S8qTxuN9qjTE5XKijq6DkCVRHU4");
const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
const NAMES = ["GME", "BP", "TSUKI", "RWA", "RKC", "TT", "BUCK", "AT"] as const;
const MINTS = [
  new PublicKey("8wXtPeU6557ETkp9WHFY1n1EcU6NxDvbAggHGsMYiHsB"),
  new PublicKey("3B1ijcocM5EDga6XxQ7JLW7weocQPWWjuhBYG8Vepump"),
  new PublicKey("463SK47VkB7uE7XenTHKiVcMtxRsfNE2X4Q9wByaURVA"),
  new PublicKey("G8aVC4nk5oPWzTHp4PDm3kAuixCebv9WRQMD93h9pump"),
  new PublicKey("7HgfXftRBBqsYtAEYcqjGLQrNJLL6Tww9ek4rE3Apump"),
  new PublicKey("5dSW7m4EN1DWXk6782P1UYSddDz3xTQEAtL6gtZmpump"),
  new PublicKey("FLqmVrv6cp7icjobpRMQJMEyjF3kF84QmC4HXpySpump"),
  new PublicKey("HBByvsRPFwcJbV516QVmtHxYwEZhrDX3f9Bgn5M9pump"),
];
const T22 = new Set([1, 4, 7]);
const STATUS = ["Open", "Split", "BasketOut", "Done", "Cancelled"];
const SIDE = ["MintSol", "RedeemGsmi"];

function tok(i: number) {
  return T22.has(i) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
}
function u64(n: bigint) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
}
function arg(name: string) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}
function loadOwner() {
  let p = process.env.ANCHOR_WALLET || "~/.config/solana/id.json";
  if (p.startsWith("~")) p = os.homedir() + "/" + p.slice(2);
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  const { Keypair } = require("@solana/web3.js");
  return Keypair.fromSecretKey(Uint8Array.from(raw)).publicKey as PublicKey;
}

async function main() {
  const url = process.env.ANCHOR_PROVIDER_URL || "https://api.mainnet-beta.solana.com";
  const conn = new Connection(url, "confirmed");
  const owner = loadOwner();
  const ticketArg = arg("ticket");
  const nonceArg = arg("nonce");
  let ticket: PublicKey;
  let nonce: bigint | null = nonceArg ? BigInt(nonceArg) : null;
  if (ticketArg) ticket = new PublicKey(ticketArg);
  else if (nonce !== null) {
    ticket = PublicKey.findProgramAddressSync(
      [Buffer.from("ticket"), owner.toBuffer(), u64(nonce)],
      WRAP
    )[0];
  } else {
    throw new Error("pass --nonce=N or --ticket=...");
  }

  const info = await conn.getAccountInfo(ticket);
  console.log("wallet", owner.toBase58());
  console.log("ticket", ticket.toBase58());
  if (!info) {
    console.log("ticket: missing (safe to open a new one)");
    return;
  }
  const buf = info.data;
  const tOwner = new PublicKey(buf.subarray(8, 40));
  const tNonce = buf.readBigUInt64LE(40);
  const side = buf[48];
  const status = buf[49];
  const sharesIn = buf.readBigUInt64LE(58);
  const minOut = buf.readBigUInt64LE(66);
  console.log("owner", tOwner.toBase58());
  console.log("nonce", tNonce.toString());
  console.log("side", SIDE[side] || side);
  console.log("status", STATUS[status] || status);
  console.log("shares_in", sharesIn.toString());
  console.log("min_out", minOut.toString());
  console.log("ticket_lamports", info.lamports);

  if (status === 3 || status === 4) {
    console.log("closed. safe to open a new ticket.");
    return;
  }

  for (let i = 0; i < 8; i++) {
    const idx = Buffer.from([i]);
    const [seat] = PublicKey.findProgramAddressSync(
      [Buffer.from("seat"), ticket.toBuffer(), idx],
      WRAP
    );
    const dest = getAssociatedTokenAddressSync(MINTS[i], ticket, true, tok(i));
    const wsol = getAssociatedTokenAddressSync(WSOL, seat, true, TOKEN_PROGRAM_ID);
    const seatInfo = await conn.getAccountInfo(seat);
    const destInfo = await conn.getAccountInfo(dest);
    const destBal = destInfo ? await conn.getTokenAccountBalance(dest).catch(() => null) : null;
    const wsolInfo = await conn.getAccountInfo(wsol);
    console.log(
      NAMES[i].padEnd(5),
      "seat",
      seatInfo ? `${seatInfo.lamports} lamports` : "gone",
      "dest",
      destBal ? destBal.value.amount : destInfo ? "ata" : "none",
      "wsol",
      wsolInfo ? `${wsolInfo.lamports}` : "none"
    );
  }

  if (side === 0) {
    console.log("resume mint:");
    console.log(
      `npx --yes tsx scripts/live_mint.ts --send --nonce=${tNonce.toString()}`
    );
  } else {
    console.log("resume redeem:");
    console.log(`npx --yes tsx scripts/redeem_round.ts --ticket=${ticket.toBase58()}`);
  }
  console.log("rule: do not open a second ticket while this one is Open/Split/BasketOut.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
