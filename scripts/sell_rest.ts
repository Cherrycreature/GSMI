/**
 * Sell remaining basket seats on the live redeem ticket. Skips empty ATAs.
 *
 *   cd ~/gsmi-wrapper
 *   npx --yes tsx scripts/sell_rest.ts
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
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { createHash } from "crypto";
import fs from "fs";
import os from "os";

const WRAP = new PublicKey("4FMpDudDHnQkXp3Y6FjCfd4BKELxHzYrjTSwrMs3T5F2");
const CONFIG = new PublicKey("J6tQMxY3fDfXcUJ85nYJPZzJxVQSvreP5zjYBxoF2nMB");
const JUPITER = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
const LUT = new PublicKey("9RpTgfk5n2K1J52Dk89hhc6bNzua5nsKkWquuJ5y6iMX");
const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
const TICKET = new PublicKey("56QGxqS2w2dQhT7Gj5SD4H8yGfLh26SndHrHcdsybz76");
const JUP_API = "https://lite-api.jup.ag/swap/v1";
const SLIP_BPS = 200;

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
function vecU8(data: Buffer) {
  return Buffer.concat([u32(data.length), data]);
}
function tokenProgram(i: number) {
  return T22.has(i) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
}
function loadKeypair() {
  let p = process.env.ANCHOR_WALLET || "~/.config/solana/id.json";
  if (p.startsWith("~")) p = os.homedir() + "/" + p.slice(2);
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

async function main() {
  const url = process.env.ANCHOR_PROVIDER_URL || "https://api.mainnet-beta.solana.com";
  const conn = new Connection(url, "confirmed");
  const payer = loadKeypair();
  const owner = payer.publicKey;
  const destWsol = getAssociatedTokenAddressSync(WSOL, TICKET, true, TOKEN_PROGRAM_ID);
  console.log("ticket", TICKET.toBase58());
  console.log("dest wsol", destWsol.toBase58());

  const gsmiLut = (await conn.getAddressLookupTable(LUT)).value;
  if (!gsmiLut) throw new Error("GSMI LUT missing");

  for (let i = 1; i < 8; i++) {
    const seatAta = getAssociatedTokenAddressSync(MINTS[i], TICKET, true, tokenProgram(i));
    const info = await conn.getAccountInfo(seatAta);
    if (!info) {
      console.log(i, NAMES[i], "no ata");
      continue;
    }
    const bal = await conn.getTokenAccountBalance(seatAta);
    const amount = bal.value.amount;
    console.log(i, NAMES[i], seatAta.toBase58(), amount);
    if (amount === "0") continue;

    const qUrl = `${JUP_API}/quote?inputMint=${MINTS[i].toBase58()}&outputMint=${WSOL.toBase58()}&amount=${amount}&slippageBps=${SLIP_BPS}&swapMode=ExactIn`;
    const quote = await (await fetch(qUrl)).json();
    if (!quote.outAmount) throw new Error(`${NAMES[i]} quote ${JSON.stringify(quote).slice(0, 240)}`);
    console.log("  quote out", quote.outAmount, "impact", quote.priceImpactPct);

    const swapRes = await fetch(`${JUP_API}/swap-instructions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: TICKET.toBase58(),
        destinationTokenAccount: destWsol.toBase58(),
        wrapAndUnwrapSol: false,
        useSharedAccounts: true,
      }),
    });
    const swap = await swapRes.json();
    if (!swap.swapInstruction) throw new Error(`${NAMES[i]} swap-ix ${JSON.stringify(swap).slice(0, 300)}`);
    const jupIx = swap.swapInstruction as {
      programId: string;
      accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
      data: string;
    };
    const altKeys: string[] = swap.addressLookupTableAddresses || [];
    const luts: AddressLookupTableAccount[] = [gsmiLut];
    for (const k of altKeys) {
      const acc = (await conn.getAddressLookupTable(new PublicKey(k))).value;
      if (acc) luts.push(acc);
    }

    const remaining = [
      { pubkey: JUPITER, isSigner: false, isWritable: false },
      ...jupIx.accounts.map((a) => ({
        pubkey: new PublicKey(a.pubkey),
        isSigner: false,
        isWritable: a.isWritable,
      })),
    ];
    const data = Buffer.concat([
      disc("crank_sell"),
      u8(i),
      vecU8(Buffer.from(jupIx.data, "base64")),
    ]);
    const ix = new TransactionInstruction({
      programId: WRAP,
      keys: [
        { pubkey: owner, isSigner: true, isWritable: true },
        { pubkey: CONFIG, isSigner: false, isWritable: false },
        { pubkey: TICKET, isSigner: false, isWritable: true },
        { pubkey: seatAta, isSigner: false, isWritable: true },
        ...remaining,
      ],
      data,
    });
    const cu = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });
    const price = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 });
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
    const msg = new TransactionMessage({
      payerKey: owner,
      recentBlockhash: blockhash,
      instructions: [cu, price, ix],
    }).compileToV0Message(luts);
    const tx = new VersionedTransaction(msg);
    tx.sign([payer]);
    const sim = await conn.simulateTransaction(tx, { sigVerify: true, replaceRecentBlockhash: false });
    console.log("  sim err", sim.value.err);
    if (sim.value.err) {
      for (const line of sim.value.logs || []) console.log(line);
      throw new Error(`${NAMES[i]} sim failed`);
    }
    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
    await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    const left = await conn.getTokenAccountBalance(seatAta);
    console.log("  crank_sell", NAMES[i], sig, "left", left.value.amount);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
