/**
 * Sell GME on the live redeem ticket.
 * Outer wrapper keys: nobody but the wallet is a signer.
 * Inner Jupiter signers are forced by the live crank_sell binary.
 *
 *   cd ~/gsmi-wrapper
 *   npx --yes tsx scripts/sell_gme.ts
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
} from "@solana/spl-token";
import { createHash } from "crypto";
import fs from "fs";
import os from "os";

const WRAP = new PublicKey("4FMpDudDHnQkXp3Y6FjCfd4BKELxHzYrjTSwrMs3T5F2");
const CONFIG = new PublicKey("J6tQMxY3fDfXcUJ85nYJPZzJxVQSvreP5zjYBxoF2nMB");
const JUPITER = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
const LUT = new PublicKey("9RpTgfk5n2K1J52Dk89hhc6bNzua5nsKkWquuJ5y6iMX");
const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
const GME = new PublicKey("8wXtPeU6557ETkp9WHFY1n1EcU6NxDvbAggHGsMYiHsB");
const TICKET = new PublicKey("56QGxqS2w2dQhT7Gj5SD4H8yGfLh26SndHrHcdsybz76");
const JUP_API = "https://lite-api.jup.ag/swap/v1";
const SLIP_BPS = 200;
const SEAT = 0;

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

  const seatAta = getAssociatedTokenAddressSync(GME, TICKET, true, TOKEN_PROGRAM_ID);
  const destWsol = getAssociatedTokenAddressSync(WSOL, TICKET, true, TOKEN_PROGRAM_ID);
  const gme = await conn.getTokenAccountBalance(seatAta);
  const amount = gme.value.amount;
  console.log("ticket", TICKET.toBase58());
  console.log("wallet", owner.toBase58());
  console.log("gme ata", seatAta.toBase58(), amount);
  console.log("dest wsol", destWsol.toBase58());
  if (amount === "0") {
    console.log("GME already empty. Next seat.");
    return;
  }

  const qUrl = `${JUP_API}/quote?inputMint=${GME.toBase58()}&outputMint=${WSOL.toBase58()}&amount=${amount}&slippageBps=${SLIP_BPS}&swapMode=ExactIn`;
  const quote = await (await fetch(qUrl)).json();
  if (!quote.outAmount) throw new Error(`quote ${JSON.stringify(quote).slice(0, 240)}`);
  console.log("quote out", quote.outAmount, "impact", quote.priceImpactPct);

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
  if (!swap.swapInstruction) throw new Error(`swap-ix ${JSON.stringify(swap).slice(0, 300)}`);
  const jupIx = swap.swapInstruction as {
    programId: string;
    accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
    data: string;
  };
  const altKeys: string[] = swap.addressLookupTableAddresses || [];
  console.log("jup accounts", jupIx.accounts.length, "alts", altKeys.length);

  const luts: AddressLookupTableAccount[] = [];
  const gsmiLut = (await conn.getAddressLookupTable(LUT)).value;
  if (gsmiLut) luts.push(gsmiLut);
  for (const k of altKeys) {
    const acc = (await conn.getAddressLookupTable(new PublicKey(k))).value;
    if (acc) luts.push(acc);
  }

  // Outer remaining: Jupiter + every jup account. No extra signers.
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
    u8(SEAT),
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
  console.log("sim err", sim.value.err);
  if (sim.value.err) {
    for (const line of sim.value.logs || []) console.log(line);
    throw new Error("sim failed");
  }

  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  console.log("crank_sell GME", sig);
  const left = await conn.getTokenAccountBalance(seatAta);
  console.log("gme left", left.value.amount);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
