/** Shared mint/redeem rails. No keys in this file. RPC from ANCHOR_PROVIDER_URL. */
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
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  getAccount,
} from "@solana/spl-token";
import { createHash } from "crypto";
import fs from "fs";
import os from "os";

export const WRAP = new PublicKey("4FMpDudDHnQkXp3Y6FjCfd4BKELxHzYrjTSwrMs3T5F2");
export const CONFIG = new PublicKey("J6tQMxY3fDfXcUJ85nYJPZzJxVQSvreP5zjYBxoF2nMB");
export const VAULT = new PublicKey("FvXKb7JVCmMa9tuAexF3zyAvj1vvRUVngrRgBpUFaCpe");
export const SHARES = new PublicKey("W1yo6FyJgfGTtj75S8qTxuN9qjTE5XKijq6DkCVRHU4");
export const VAULT_PROGRAM = new PublicKey("4saonDbBXhXJQ8TPvb7gMdrDNrkmpuRvjwCxqu1UDPxQ");
export const JUPITER = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
export const TREASURY = new PublicKey("1f8NG4HixGS6wREigBXMbK7rZn3NU3WpDzKWDij79g6");
export const DESK = new PublicKey("5Cz2YfDQkhgsGZ31so8oWRRMfcJDzBi7hW3rKRTQSrZo");
export const CRANK_TAKE = 12_000_000;
export const LUT = new PublicKey("9RpTgfk5n2K1J52Dk89hhc6bNzua5nsKkWquuJ5y6iMX");
export const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
export const JUP_API = "https://lite-api.jup.ag/swap/v1";
export const NAMES = ["GME", "BP", "TSUKI", "RWA", "RKC", "TT", "BUCK", "AT"] as const;
export const MINTS = [
  new PublicKey("8wXtPeU6557ETkp9WHFY1n1EcU6NxDvbAggHGsMYiHsB"),
  new PublicKey("3B1ijcocM5EDga6XxQ7JLW7weocQPWWjuhBYG8Vepump"),
  new PublicKey("463SK47VkB7uE7XenTHKiVcMtxRsfNE2X4Q9wByaURVA"),
  new PublicKey("G8aVC4nk5oPWzTHp4PDm3kAuixCebv9WRQMD93h9pump"),
  new PublicKey("7HgfXftRBBqsYtAEYcqjGLQrNJLL6Tww9ek4rE3Apump"),
  new PublicKey("5dSW7m4EN1DWXk6782P1UYSddDz3xTQEAtL6gtZmpump"),
  new PublicKey("FLqmVrv6cp7icjobpRMQJMEyjF3kF84QmC4HXpySpump"),
  new PublicKey("HBByvsRPFwcJbV516QVmtHxYwEZhrDX3f9Bgn5M9pump"),
];
export const T22 = new Set([1, 4, 7]);
export const SLIP_BPS = 200;
export const STATUS = ["Open", "Split", "BasketOut", "Done", "Cancelled"];

export function disc(name: string) {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}
export function u8(n: number) {
  return Buffer.from([n]);
}
export function u32(n: number) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
}
export function u64(n: number | bigint) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}
export function vecU8(data: Buffer) {
  return Buffer.concat([u32(data.length), data]);
}
export function tok(i: number) {
  return T22.has(i) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
}
export function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
export function loadKeypair() {
  let p = process.env.ANCHOR_WALLET || "~/.config/solana/id.json";
  if (p.startsWith("~")) p = os.homedir() + "/" + p.slice(2);
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}
export function rpcUrl() {
  return process.env.ANCHOR_PROVIDER_URL || "https://api.mainnet-beta.solana.com";
}
export function arg(name: string) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}
export function isHot(e: unknown) {
  const s = String(e);
  return (
    s.includes("429") ||
    s.includes("Too many requests") ||
    s.includes("403 Forbidden") ||
    s.includes("Blockhash not found") ||
    s.includes("block height exceeded")
  );
}
export function isNoRoute(e: unknown) {
  const s = String(e);
  return s.includes("NO_ROUTES_FOUND") || s.includes("No routes found");
}

export async function retry<T>(label: string, fn: () => Promise<T>, tries = 8): Promise<T> {
  let wait = 250;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      const hot = isHot(e) || (label === "quote-out" && isNoRoute(e) && i < 3);
      if (!hot || i === tries - 1) throw e;
      console.log(label, "backoff", wait);
      await sleep(wait);
      wait = Math.min(wait * 2, 6000);
    }
  }
  throw new Error(label);
}

export function ticketPda(owner: PublicKey, nonce: bigint) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("ticket"), owner.toBuffer(), u64(nonce)],
    WRAP
  )[0];
}
export function seatsOf(ticket: PublicKey) {
  return [...Array(8)].map(
    (_, i) =>
      PublicKey.findProgramAddressSync(
        [Buffer.from("seat"), ticket.toBuffer(), Buffer.from([i])],
        WRAP
      )[0]
  );
}

export async function jupQuote(inputMint: string, outputMint: string, amount: string) {
  const url = `${JUP_API}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${SLIP_BPS}&swapMode=ExactIn`;
  return retry("quote", async () => {
    const r = await fetch(url);
    const j = await r.json();
    if (j.error || !j.outAmount) throw new Error(`quote: ${JSON.stringify(j).slice(0, 240)}`);
    return j;
  });
}

export async function jupQuoteExactOut(inputMint: string, outputMint: string, outAmount: string) {
  const url = `${JUP_API}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${outAmount}&slippageBps=${SLIP_BPS}&swapMode=ExactOut`;
  return retry("quote-out", async () => {
    const r = await fetch(url);
    const j = await r.json();
    if (j.error || !j.inAmount) throw new Error(`quote-out: ${JSON.stringify(j).slice(0, 240)}`);
    return j;
  });
}

export async function jupSwapIx(quote: any, user: PublicKey, destAta: PublicKey) {
  return retry("swap-ix", async () => {
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
  });
}

export type Door = {
  conn: Connection;
  payer: Keypair;
  owner: PublicKey;
  lut: AddressLookupTableAccount;
};

export async function openDoor(): Promise<Door> {
  const url = rpcUrl();
  const conn = new Connection(url, { commitment: "confirmed", disableRetryOnRateLimit: false });
  const payer = loadKeypair();
  const lut = await retry("lut", async () => {
    const v = (await conn.getAddressLookupTable(LUT)).value;
    if (!v) throw new Error("LUT missing");
    return v;
  });
  console.log("rpc", url.includes("helius") ? "helius" : url);
  console.log("wallet", payer.publicKey.toBase58());
  return { conn, payer, owner: payer.publicKey, lut };
}

export const PRIORITY_MICROS = 200_000;

export async function sendV0(
  door: Door,
  ixs: TransactionInstruction[],
  label: string,
  extra: AddressLookupTableAccount[] = []
) {
  return retry(label, async () => {
    const { blockhash } = await door.conn.getLatestBlockhash("confirmed");
    const tx = new VersionedTransaction(
      new TransactionMessage({
        payerKey: door.owner,
        recentBlockhash: blockhash,
        instructions: [
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_MICROS }),
          ...ixs,
        ],
      }).compileToV0Message([door.lut, ...extra])
    );
    tx.sign([door.payer]);
    const sig = await door.conn.sendTransaction(tx, { skipPreflight: false, maxRetries: 6 });
    for (let t = 0; t < 40; t++) {
      const st = await door.conn.getSignatureStatuses([sig]);
      const v = st.value[0];
      if (v?.err) throw new Error(`${label} err ${JSON.stringify(v.err)} ${sig}`);
      if (v?.confirmationStatus === "confirmed" || v?.confirmationStatus === "finalized") {
        console.log(label, sig);
        return sig;
      }
      await sleep(200);
    }
    console.log(label, "landed?", sig);
    return sig;
  });
}

export async function info(door: Door, pk: PublicKey) {
  return retry("info", () => door.conn.getAccountInfo(pk, "confirmed"));
}

export async function infos(door: Door, pks: PublicKey[]) {
  const out: (Awaited<ReturnType<Door["conn"]["getAccountInfo"]>>)[] = [];
  for (let i = 0; i < pks.length; i += 100) {
    const chunk = pks.slice(i, i + 100);
    const rows = await retry("infos", () => door.conn.getMultipleAccountsInfo(chunk, "confirmed"));
    out.push(...rows);
  }
  return out;
}

export function amtOf(acc: { data: Buffer } | null | undefined): bigint {
  if (!acc || acc.data.length < 72) return 0n;
  return acc.data.readBigUInt64LE(64);
}

export async function quotesExactIn(jobs: { inMint: string; outMint: string; amount: string }[]) {
  return Promise.all(jobs.map((j) => jupQuote(j.inMint, j.outMint, j.amount)));
}

export async function tokenAmt(door: Door, ata: PublicKey, program: PublicKey) {
  try {
    return (await getAccount(door.conn, ata, "confirmed", program)).amount;
  } catch {
    return 0n;
  }
}

export function ataIx(
  payer: PublicKey,
  ata: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
  program: PublicKey
) {
  return createAssociatedTokenAccountIdempotentInstruction(
    payer,
    ata,
    owner,
    mint,
    program,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
}

export async function loadJupLuts(door: Door, packed: any) {
  const extra: AddressLookupTableAccount[] = [];
  for (const a of packed.addressLookupTableAddresses || []) {
    const acc = await retry("jup-lut", async () => (await door.conn.getAddressLookupTable(new PublicKey(a))).value);
    if (acc) extra.push(acc);
  }
  return extra;
}

export function destAta(ticket: PublicKey, i: number) {
  return getAssociatedTokenAddressSync(MINTS[i], ticket, true, tok(i));
}
export function vaultAta(i: number) {
  return getAssociatedTokenAddressSync(MINTS[i], VAULT, true, tok(i));
}
export function treasuryAta(i: number) {
  return getAssociatedTokenAddressSync(MINTS[i], TREASURY, true, tok(i));
}
export function seatWsol(seat: PublicKey) {
  return getAssociatedTokenAddressSync(WSOL, seat, true, TOKEN_PROGRAM_ID);
}
export function ticketShares(ticket: PublicKey) {
  return getAssociatedTokenAddressSync(SHARES, ticket, true, TOKEN_PROGRAM_ID);
}
export function ownerShares(owner: PublicKey) {
  return getAssociatedTokenAddressSync(SHARES, owner, false, TOKEN_PROGRAM_ID);
}
export function ticketWsol(ticket: PublicKey) {
  return getAssociatedTokenAddressSync(WSOL, ticket, true, TOKEN_PROGRAM_ID);
}
export function ownerWsol(owner: PublicKey) {
  return getAssociatedTokenAddressSync(WSOL, owner, false, TOKEN_PROGRAM_ID);
}
