/**
 * Live 0.05 SOL mint ticket. No Anchor Program constructor.
 *
 *   cd ~/gsmi-wrapper
 *   ANCHOR_PROVIDER_URL=https://api.mainnet-beta.solana.com \
 *   ANCHOR_WALLET=~/.config/solana/id.json \
 *   npx --yes tsx scripts/live_mint.ts
 *
 *   ... npx --yes tsx scripts/live_mint.ts --send
 */
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  getAccount,
} from "@solana/spl-token";
import { createHash } from "crypto";
import fs from "fs";
import os from "os";
import { liveShape, printShape, impliedShares, minSharesFromQuotes, padBudgets, tokensForShares } from "./shape";

const WRAP = new PublicKey("4FMpDudDHnQkXp3Y6FjCfd4BKELxHzYrjTSwrMs3T5F2");
const CONFIG = new PublicKey("J6tQMxY3fDfXcUJ85nYJPZzJxVQSvreP5zjYBxoF2nMB");
const VAULT = new PublicKey("FvXKb7JVCmMa9tuAexF3zyAvj1vvRUVngrRgBpUFaCpe");
const SHARES = new PublicKey("W1yo6FyJgfGTtj75S8qTxuN9qjTE5XKijq6DkCVRHU4");
const VAULT_PROGRAM = new PublicKey("4saonDbBXhXJQ8TPvb7gMdrDNrkmpuRvjwCxqu1UDPxQ");
const JUPITER = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
const TREASURY = new PublicKey("1f8NG4HixGS6wREigBXMbK7rZn3NU3WpDzKWDij79g6");
const DESK = new PublicKey("5Cz2YfDQkhgsGZ31so8oWRRMfcJDzBi7hW3rKRTQSrZo");
const LUT = new PublicKey("9RpTgfk5n2K1J52Dk89hhc6bNzua5nsKkWquuJ5y6iMX");
const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
const JUP_API = "https://lite-api.jup.ag/swap/v1";

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
const SOL_IN = 50_000_000;
const SLIP_BPS = 200;

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
function u64(n: number | bigint) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
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

async function jupQuote(inputMint: string, outputMint: string, amount: string) {
  const url = `${JUP_API}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${SLIP_BPS}&swapMode=ExactIn`;
  const r = await fetch(url);
  const j = await r.json();
  if (j.error || !j.outAmount) throw new Error(`quote ${inputMint.slice(0, 4)}: ${JSON.stringify(j).slice(0, 240)}`);
  return j;
}

async function jupQuoteExactOut(inputMint: string, outputMint: string, outAmount: string) {
  const url = `${JUP_API}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${outAmount}&slippageBps=${SLIP_BPS}&swapMode=ExactOut`;
  const r = await fetch(url);
  const j = await r.json();
  if (j.error || !j.inAmount) throw new Error(`quote-out ${outputMint.slice(0, 4)}: ${JSON.stringify(j).slice(0, 240)}`);
  return j;
}

async function jupSwapIx(quote: any, user: PublicKey, destAta: PublicKey) {
  const r = await fetch(`${JUP_API}/swap-instructions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: user.toBase58(),
      destinationTokenAccount: destAta.toBase58(),
      wrapAndUnwrapSol: false,
      useSharedAccounts: true,
    }),
  });
  const j = await r.json();
  if (!j.swapInstruction) throw new Error(`swap-ix: ${JSON.stringify(j).slice(0, 300)}`);
  return j;
}

async function main() {
  const send = process.argv.includes("--send");
  const nonceArg = process.argv.find((a) => a.startsWith("--nonce="));
  const nonce = BigInt(nonceArg ? nonceArg.split("=")[1] : Date.now() % 1_000_000_000);
  if (!nonceArg && process.argv.includes("--send")) {
    console.log("hint: resume an open ticket with --nonce=N");
  }

  const url = process.env.ANCHOR_PROVIDER_URL || "https://api.mainnet-beta.solana.com";
  const conn = new Connection(url, "confirmed");
  const payer = loadKeypair();
  const owner = payer.publicKey;

  const [ticket] = PublicKey.findProgramAddressSync(
    [Buffer.from("ticket"), owner.toBuffer(), u64(nonce)],
    WRAP
  );
  const seats = [...Array(8)].map((_, i) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("seat"), ticket.toBuffer(), Buffer.from([i])],
      WRAP
    )[0]
  );

  const shape = await liveShape(conn, BigInt(SOL_IN));
  const padded = padBudgets(shape.budgets);
  const budgets = padded.map((b) => Number(b));
  const solOpen = Number(padded.reduce((a, b) => a + b, 0n));
  printShape(shape, BigInt(SOL_IN));
  console.log("pad 3%  open_lamports", solOpen, "vs asked", SOL_IN);

  console.log("send", send);
  console.log("wallet", owner.toBase58());
  console.log("wrapper", WRAP.toBase58());
  console.log("nonce", nonce.toString());
  console.log("ticket", ticket.toBase58());
  console.log("sol_in", SOL_IN);

  const lutAcc = (await conn.getAddressLookupTable(LUT)).value;
  if (!lutAcc) throw new Error("LUT missing");
  const luts: AddressLookupTableAccount[] = [lutAcc];

  console.log("\nquotes WSOL -> seat  (book dollar shape)");
  const implied: bigint[] = [];
  for (let i = 0; i < 8; i++) {
    const q = await jupQuote(WSOL.toBase58(), MINTS[i].toBase58(), String(budgets[i]));
    const route = (q.routePlan || []).map((s: any) => s.swapInfo?.label).join(">") || "?";
    const impl = impliedShares(BigInt(q.outAmount), shape.book[i], shape.totalShares);
    implied.push(impl);
    console.log(
      `  ${i} ${NAMES[i].padEnd(5)} budget ${budgets[i]} out ${q.outAmount} impl ${impl} impact ${q.priceImpactPct} ${route}`
    );
  }
  const minShares = minSharesFromQuotes(implied);
  const targetOut = shape.book.map((book) => tokensForShares(minShares, book, shape.totalShares));
  console.log("min_shares", minShares.toString(), Number(minShares) / 1e9);
  for (let i = 0; i < 8; i++) console.log("target_out", NAMES[i], targetOut[i].toString());

  console.log("\nPDAs");
  for (let i = 0; i < 8; i++) {
    const dest = getAssociatedTokenAddressSync(MINTS[i], ticket, true, tokenProgram(i));
    const wsol = getAssociatedTokenAddressSync(WSOL, seats[i], true, TOKEN_PROGRAM_ID);
    console.log(`  ${NAMES[i]} seat ${seats[i].toBase58()}`);
    console.log(`         ata  ${dest.toBase58()}`);
    console.log(`         wsol ${wsol.toBase58()}`);
  }

  if (!send) {
    console.log("\ndry. rerun with --send to spend 0.05 + fees.");
    return;
  }

  async function sendV0(ixs: TransactionInstruction[], label: string, extra: AddressLookupTableAccount[] = []) {
    const { blockhash } = await conn.getLatestBlockhash("confirmed");
    const tx = new VersionedTransaction(
      new TransactionMessage({
        payerKey: owner,
        recentBlockhash: blockhash,
        instructions: ixs,
      }).compileToV0Message([...luts, ...extra])
    );
    tx.sign([payer]);
    const sig = await conn.sendTransaction(tx, { skipPreflight: false, maxRetries: 8 });
    for (let t = 0; t < 45; t++) {
      const st = await conn.getSignatureStatuses([sig]);
      const v = st.value[0];
      if (v?.err) throw new Error(`${label} err ${JSON.stringify(v.err)} ${sig}`);
      if (v?.confirmationStatus === "confirmed" || v?.confirmationStatus === "finalized") {
        console.log(label, sig);
        return sig;
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    console.log(label, "unconfirmed", sig);
    return sig;
  }

  if (!(await conn.getAccountInfo(ticket))) {
    const data = Buffer.concat([disc("open_mint"), u64(nonce), u64(solOpen), u64(minShares), u32(150)]);
    const ix = new TransactionInstruction({
      programId: WRAP,
      keys: [
        { pubkey: owner, isSigner: true, isWritable: true },
        { pubkey: CONFIG, isSigner: false, isWritable: false },
        { pubkey: ticket, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    });
    await sendV0([ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }), ix], "open_mint");
  } else {
    console.log("ticket already open");
  }

  if (!(await conn.getAccountInfo(seats[0]))) {
    const data = Buffer.concat([disc("split_mint"), ...budgets.map((b) => u64(b))]);
    const ix = new TransactionInstruction({
      programId: WRAP,
      keys: [
        { pubkey: owner, isSigner: true, isWritable: true },
        { pubkey: ticket, isSigner: false, isWritable: true },
        ...seats.map((s) => ({ pubkey: s, isSigner: false, isWritable: true })),
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    });
    await sendV0([ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }), ix], "split_mint");
  } else {
    console.log("seats already split");
  }

  const ticketShares = getAssociatedTokenAddressSync(SHARES, ticket, true, TOKEN_PROGRAM_ID);
  const ownerShares = getAssociatedTokenAddressSync(SHARES, owner, false, TOKEN_PROGRAM_ID);
  const ataNeed: TransactionInstruction[] = [];
  async function wantAta(addr: PublicKey, ownerPk: PublicKey, mint: PublicKey, prog: PublicKey) {
    if (await conn.getAccountInfo(addr, "confirmed")) return;
    ataNeed.push(
      createAssociatedTokenAccountIdempotentInstruction(
        owner, addr, ownerPk, mint, prog, ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
  }
  for (let i = 0; i < 8; i++) {
    const dest = getAssociatedTokenAddressSync(MINTS[i], ticket, true, tokenProgram(i));
    const wsol = getAssociatedTokenAddressSync(WSOL, seats[i], true, TOKEN_PROGRAM_ID);
    await wantAta(dest, ticket, MINTS[i], tokenProgram(i));
    await wantAta(wsol, seats[i], WSOL, TOKEN_PROGRAM_ID);
  }
  await wantAta(ticketShares, ticket, SHARES, TOKEN_PROGRAM_ID);
  await wantAta(ownerShares, owner, SHARES, TOKEN_PROGRAM_ID);
  await wantAta(getAssociatedTokenAddressSync(WSOL, owner, false, TOKEN_PROGRAM_ID), owner, WSOL, TOKEN_PROGRAM_ID);
  if (ataNeed.length === 0) {
    console.log("atas already live");
  } else {
    for (let n = 0; n < ataNeed.length; n += 2) {
      await sendV0(
        [ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }), ...ataNeed.slice(n, n + 2)],
        `atas ${n / 2 + 1}`
      );
    }
  }

  async function wsolAmount(wsol: PublicKey) {
    try {
      return (await getAccount(conn, wsol, "confirmed", TOKEN_PROGRAM_ID)).amount;
    } catch {
      return 0n;
    }
  }

  for (let i = 0; i < 8; i++) {
    const dest = getAssociatedTokenAddressSync(MINTS[i], ticket, true, tokenProgram(i));
    const wsol = getAssociatedTokenAddressSync(WSOL, seats[i], true, TOKEN_PROGRAM_ID);
    try {
      const destAcc = await getAccount(conn, dest, "confirmed", tokenProgram(i));
      if (destAcc.amount > 0n) {
        console.log("seat", NAMES[i], "already has", destAcc.amount.toString());
        continue;
      }
    } catch {
      /* empty */
    }

    if ((await wsolAmount(wsol)) === 0n) {
      const wrapIx = new TransactionInstruction({
        programId: WRAP,
        keys: [
          { pubkey: owner, isSigner: true, isWritable: false },
          { pubkey: ticket, isSigner: false, isWritable: false },
          { pubkey: seats[i], isSigner: false, isWritable: true },
          { pubkey: wsol, isSigner: false, isWritable: true },
          { pubkey: WSOL, isSigner: false, isWritable: false },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        data: Buffer.concat([disc("wrap_seat"), u8(i)]),
      });
      try {
        await sendV0(
          [
            ComputeBudgetProgram.setComputeUnitLimit({ units: 80_000 }),
            wrapIx,
            createSyncNativeInstruction(wsol),
          ],
          `wrap ${NAMES[i]}`
        );
      } catch (e) {
        console.log("wrap", NAMES[i], "err", String(e).slice(0, 220));
        try {
          await sendV0(
            [ComputeBudgetProgram.setComputeUnitLimit({ units: 40_000 }), createSyncNativeInstruction(wsol)],
            `sync ${NAMES[i]}`
          );
        } catch (e2) {
          console.log("sync", NAMES[i], "err", String(e2).slice(0, 180));
        }
      }
    } else {
      console.log("wsol already", NAMES[i]);
    }

    let wamt = 0n;
    for (let t = 0; t < 20; t++) {
      wamt = await wsolAmount(wsol);
      if (wamt > 0n) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    if (wamt === 0n) throw new Error("wsol 0 " + NAMES[i]);
    console.log("wsol", NAMES[i], wamt.toString());

    const wantOut = targetOut[i];
    if (wantOut === 0n) throw new Error("target 0 " + NAMES[i]);
    let q = await jupQuoteExactOut(WSOL.toBase58(), MINTS[i].toBase58(), wantOut.toString());
    const maxIn = (BigInt(q.inAmount) * 10200n) / 10000n;
    if (maxIn > wamt) {
      console.log("exact-out over pad", NAMES[i], "need", maxIn.toString(), "have", wamt.toString(), "exact-in");
      q = await jupQuote(WSOL.toBase58(), MINTS[i].toBase58(), wamt.toString());
    }
    const packed = await jupSwapIx(q, seats[i], dest);
    const swap = packed.swapInstruction as {
      programId: string;
      accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
      data: string;
    };
    if (swap.programId !== JUPITER.toBase58()) {
      throw new Error(`${NAMES[i]} swap program ${swap.programId}`);
    }
    const extra: AddressLookupTableAccount[] = [];
    for (const a of packed.addressLookupTableAddresses || []) {
      const acc = (await conn.getAddressLookupTable(new PublicKey(a))).value;
      if (acc) extra.push(acc);
    }
    const data = Buffer.concat([disc("crank_buy"), u8(i), vecU8(Buffer.from(swap.data, "base64"))]);
    const keys = [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: CONFIG, isSigner: false, isWritable: false },
      { pubkey: ticket, isSigner: false, isWritable: false },
      { pubkey: seats[i], isSigner: false, isWritable: true },
      { pubkey: dest, isSigner: false, isWritable: true },
      { pubkey: wsol, isSigner: false, isWritable: true },
      { pubkey: WSOL, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: JUPITER, isSigner: false, isWritable: false },
      ...swap.accounts.map((a) => ({
        pubkey: new PublicKey(a.pubkey),
        isWritable: a.isWritable,
        isSigner: false,
      })),
    ];
    const ix = new TransactionInstruction({ programId: WRAP, keys, data });
    await sendV0(
      [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ix],
      `crank_buy ${NAMES[i]}`,
      extra
    );
    let got = 0n;
    for (let t = 0; t < 16; t++) {
      try {
        got = (await getAccount(conn, dest, "confirmed", tokenProgram(i))).amount;
      } catch {
        got = 0n;
      }
      if (got > 0n) break;
      await new Promise((r) => setTimeout(r, 400));
    }
    if (got === 0n) {
      await sendV0(
        [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ix],
        `crank_buy retry ${NAMES[i]}`,
        extra
      );
    }
    await new Promise((r) => setTimeout(r, 600));
  }

  const offered: bigint[] = [];
  for (let i = 0; i < 8; i++) {
    const dest = getAssociatedTokenAddressSync(MINTS[i], ticket, true, tokenProgram(i));
    const acc = await getAccount(conn, dest, "confirmed", tokenProgram(i));
    offered.push(acc.amount);
    console.log("offered", NAMES[i], acc.amount.toString());
  }

  const finKeys = [
    { pubkey: owner, isSigner: true, isWritable: true },
    { pubkey: CONFIG, isSigner: false, isWritable: false },
    { pubkey: ticket, isSigner: false, isWritable: true },
    { pubkey: owner, isSigner: false, isWritable: true },
    { pubkey: DESK, isSigner: false, isWritable: true },
    { pubkey: VAULT, isSigner: false, isWritable: true },
    { pubkey: SHARES, isSigner: false, isWritable: true },
    { pubkey: ticketShares, isSigner: false, isWritable: true },
    { pubkey: ownerShares, isSigner: false, isWritable: true },
    { pubkey: VAULT_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
    ...seats.map((s) => ({ pubkey: s, isSigner: false, isWritable: true })),
    { pubkey: getAssociatedTokenAddressSync(WSOL, owner, false, TOKEN_PROGRAM_ID), isSigner: false, isWritable: true },
    ...seats.map((s) => ({
      pubkey: getAssociatedTokenAddressSync(WSOL, s, true, TOKEN_PROGRAM_ID),
      isSigner: false,
      isWritable: true,
    })),
  ];
  for (let i = 0; i < 8; i++) {
    const prog = tokenProgram(i);
    finKeys.push({ pubkey: getAssociatedTokenAddressSync(MINTS[i], ticket, true, prog), isSigner: false, isWritable: true });
    finKeys.push({ pubkey: getAssociatedTokenAddressSync(MINTS[i], VAULT, true, prog), isSigner: false, isWritable: true });
    finKeys.push({ pubkey: getAssociatedTokenAddressSync(MINTS[i], TREASURY, true, prog), isSigner: false, isWritable: true });
  }
  const impliedNow = offered.map((n, i) => impliedShares(n, shape.book[i], shape.totalShares));
  const slice = impliedNow.reduce((a, b) => (b < a ? b : a));
  const finishMin = (slice * 9900n) / 10000n;
  console.log(
    "slice",
    Number(slice) / 1e9,
    "finish_min",
    Number(finishMin) / 1e9,
    "ticket_min",
    Number(minShares) / 1e9
  );
  const finData = Buffer.concat([
    disc("finish_mint"),
    ...offered.map((n) => u64(n)),
    u64(1),
    u64(finishMin),
  ]);
  await sendV0(
    [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 }),
      new TransactionInstruction({ programId: WRAP, keys: finKeys, data: finData }),
    ],
    "finish_mint"
  );

  try {
    const sh = await getAccount(conn, ownerShares, "confirmed", TOKEN_PROGRAM_ID);
    console.log("owner GSMI", sh.amount.toString());
  } catch {
    console.log("owner GSMI unread");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
