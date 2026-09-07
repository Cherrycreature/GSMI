/**
 * One-seat resume. Ticket already open+split. Buys RWA only.
 *   ANCHOR_PROVIDER_URL=... npx --yes tsx scripts/buy_rwa.ts
 */
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  getAccount,
} from "@solana/spl-token";
import { createHash } from "crypto";
import fs from "fs";
import os from "os";

const WRAP = new PublicKey("4FMpDudDHnQkXp3Y6FjCfd4BKELxHzYrjTSwrMs3T5F2");
const CONFIG = new PublicKey("J6tQMxY3fDfXcUJ85nYJPZzJxVQSvreP5zjYBxoF2nMB");
const JUPITER = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
const LUT = new PublicKey("9RpTgfk5n2K1J52Dk89hhc6bNzua5nsKkWquuJ5y6iMX");
const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
const RWA = new PublicKey("G8aVC4nk5oPWzTHp4PDm3kAuixCebv9WRQMD93h9pump");
const TICKET = new PublicKey("CpatCp4ry9Sg1GzDnyUrr8ULRPtBiP4BXTrprg2meXtH");
const I = 3;
const JUP_API = "https://lite-api.jup.ag/swap/v1";

function disc(name: string) {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}
function u8(n: number) {
  return Buffer.from([n]);
}
function u32(n: number) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
}
function vecU8(buf: Buffer) {
  return Buffer.concat([u32(buf.length), buf]);
}

const url = process.env.ANCHOR_PROVIDER_URL!;
const kp = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(os.homedir() + "/.config/solana/id.json", "utf8")))
);
const owner = kp.publicKey;
const conn = new Connection(url, "confirmed");
const seat = PublicKey.findProgramAddressSync(
  [Buffer.from("seat"), TICKET.toBuffer(), Buffer.from([I])],
  WRAP
)[0];
const dest = getAssociatedTokenAddressSync(RWA, TICKET, true, TOKEN_PROGRAM_ID);
const wsol = getAssociatedTokenAddressSync(WSOL, seat, true, TOKEN_PROGRAM_ID);

async function sendV0(ixs: TransactionInstruction[], label: string, extra: AddressLookupTableAccount[] = []) {
  const lut = (await conn.getAddressLookupTable(LUT)).value;
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({
    payerKey: owner,
    recentBlockhash: blockhash,
    instructions: ixs,
  }).compileToV0Message(lut ? [lut, ...extra] : extra);
  const tx = new VersionedTransaction(msg);
  tx.sign([kp]);
  const sim = await conn.simulateTransaction(tx, { sigVerify: false });
  if (sim.value.err) {
    console.log(label, "SIM", JSON.stringify(sim.value.err));
    console.log((sim.value.logs || []).slice(-16).join("\n"));
    throw new Error(label + " sim");
  }
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 6 });
  console.log(label, sig);
  for (let t = 0; t < 80; t++) {
    const st = await conn.getSignatureStatuses([sig], { searchTransactionHistory: true });
    const v = st.value[0];
    if (v?.err) throw new Error(label + " err " + JSON.stringify(v.err));
    if (v && (v.confirmationStatus === "confirmed" || v.confirmationStatus === "finalized")) return sig;
    await new Promise((r) => setTimeout(r, 400));
  }
  const got = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  if (got && !got.meta?.err) return sig;
  throw new Error(label + " timeout " + sig);
}

(async () => {
  console.log("ticket", TICKET.toBase58());
  console.log("seat", seat.toBase58());
  console.log("seat lamports", await conn.getBalance(seat));
  let destAmt = 0n;
  try {
    destAmt = (await getAccount(conn, dest, "confirmed", TOKEN_PROGRAM_ID)).amount;
  } catch {
    destAmt = 0n;
  }
  console.log("dest", destAmt.toString());
  if (destAmt > 0n) {
    console.log("RWA already filled");
    return;
  }

  await sendV0(
    [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 80_000 }),
      createAssociatedTokenAccountIdempotentInstruction(owner, dest, TICKET, RWA, TOKEN_PROGRAM_ID),
      createAssociatedTokenAccountIdempotentInstruction(owner, wsol, seat, WSOL, TOKEN_PROGRAM_ID),
    ],
    "ata"
  );

  const lamports = await conn.getBalance(seat);
  let wamt = 0n;
  try {
    wamt = (await getAccount(conn, wsol, "confirmed", TOKEN_PROGRAM_ID)).amount;
  } catch {
    wamt = 0n;
  }
  console.log("wsol", wamt.toString(), "seatLamports", lamports);

  if (wamt === 0n && lamports > 0) {
    await sendV0(
      [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 80_000 }),
        new TransactionInstruction({
          programId: WRAP,
          keys: [
            { pubkey: owner, isSigner: true, isWritable: false },
            { pubkey: TICKET, isSigner: false, isWritable: false },
            { pubkey: seat, isSigner: false, isWritable: true },
            { pubkey: wsol, isSigner: false, isWritable: true },
            { pubkey: WSOL, isSigner: false, isWritable: false },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          ],
          data: Buffer.concat([disc("wrap_seat"), u8(I)]),
        }),
        createSyncNativeInstruction(wsol),
      ],
      "wrap"
    );
    for (let t = 0; t < 20; t++) {
      try {
        wamt = (await getAccount(conn, wsol, "confirmed", TOKEN_PROGRAM_ID)).amount;
      } catch {
        wamt = 0n;
      }
      console.log("wsol wait", wamt.toString());
      if (wamt > 0n) break;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  if (wamt === 0n) throw new Error("RWA wsol empty — seat has no SOL left to buy with");

  const q = await (
    await fetch(
      `${JUP_API}/quote?inputMint=${WSOL}&outputMint=${RWA}&amount=${wamt}&slippageBps=300&swapMode=ExactIn`
    )
  ).json();
  console.log("quote in", q.inAmount, "out", q.outAmount, "impact", q.priceImpactPct);
  if (!q.outAmount) throw new Error("RWA quote empty " + JSON.stringify(q).slice(0, 300));

  const packed = await (
    await fetch(`${JUP_API}/swap-instructions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        quoteResponse: q,
        userPublicKey: seat.toBase58(),
        destinationTokenAccount: dest.toBase58(),
        wrapAndUnwrapSol: false,
        useSharedAccounts: true,
      }),
    })
  ).json();
  if (!packed.swapInstruction) {
    console.log(JSON.stringify(packed).slice(0, 500));
    throw new Error("RWA swap ix missing");
  }
  const extra: AddressLookupTableAccount[] = [];
  for (const a of packed.addressLookupTableAddresses || []) {
    const acc = (await conn.getAddressLookupTable(new PublicKey(a))).value;
    if (acc) extra.push(acc);
  }
  const sw = packed.swapInstruction;
  await sendV0(
    [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      new TransactionInstruction({
        programId: WRAP,
        keys: [
          { pubkey: owner, isSigner: true, isWritable: true },
          { pubkey: CONFIG, isSigner: false, isWritable: false },
          { pubkey: TICKET, isSigner: false, isWritable: false },
          { pubkey: seat, isSigner: false, isWritable: true },
          { pubkey: dest, isSigner: false, isWritable: true },
          { pubkey: wsol, isSigner: false, isWritable: true },
          { pubkey: WSOL, isSigner: false, isWritable: false },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: JUPITER, isSigner: false, isWritable: false },
          ...sw.accounts.map((a: { pubkey: string; isWritable: boolean }) => ({
            pubkey: new PublicKey(a.pubkey),
            isWritable: a.isWritable,
            isSigner: false,
          })),
        ],
        data: Buffer.concat([disc("crank_buy"), u8(I), vecU8(Buffer.from(sw.data, "base64"))]),
      }),
    ],
    "buy RWA",
    extra
  );

  const got = (await getAccount(conn, dest, "confirmed", TOKEN_PROGRAM_ID)).amount;
  console.log("RWA dest", got.toString());
  if (got === 0n) throw new Error("buy landed but dest still 0");
  console.log("RWA filled. rerun live_mint --nonce=1788649048557 --send");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
