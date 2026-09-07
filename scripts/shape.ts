/**
 * Live vault shape. Token book from the vault account.
 * Dollar weights from DexScreener. SOL budgets from those weights.
 *
 * Not 1/8. Not 12.5%. Not the first-fill dollar photo.
 */
import { Connection, PublicKey } from "@solana/web3.js";

export const NAMES = ["GME", "BP", "TSUKI", "RWA", "RKC", "TT", "BUCK", "AT"] as const;
export const MINTS = [
  "8wXtPeU6557ETkp9WHFY1n1EcU6NxDvbAggHGsMYiHsB",
  "3B1ijcocM5EDga6XxQ7JLW7weocQPWWjuhBYG8Vepump",
  "463SK47VkB7uE7XenTHKiVcMtxRsfNE2X4Q9wByaURVA",
  "G8aVC4nk5oPWzTHp4PDm3kAuixCebv9WRQMD93h9pump",
  "7HgfXftRBBqsYtAEYcqjGLQrNJLL6Tww9ek4rE3Apump",
  "5dSW7m4EN1DWXk6782P1UYSddDz3xTQEAtL6gtZmpump",
  "FLqmVrv6cp7icjobpRMQJMEyjF3kF84QmC4HXpySpump",
  "HBByvsRPFwcJbV516QVmtHxYwEZhrDX3f9Bgn5M9pump",
];
export const DEC = [9, 6, 9, 6, 6, 6, 6, 6];
/** Thin seats get a slightly fatter min_shares haircut. */
export const PAD_BPS = [15, 20, 15, 20, 25, 40, 25, 40];
/** Extra SOL on every seat so ExactOut still clears a 20s tick. Comes back on finish. */
export const PAD_SOL_BPS = 500;
export const FEE_NUM = 69n;
export const FEE_DEN = 100_000n;
export const VAULT = new PublicKey("FvXKb7JVCmMa9tuAexF3zyAvj1vvRUVngrRgBpUFaCpe");
export const SOL_MINT = "So11111111111111111111111111111111111111112";

export type Shape = {
  totalShares: bigint;
  genesisShares: bigint;
  book: bigint[];
  bookUi: number[];
  pxUsd: number[];
  usd: number[];
  tvlUsd: number;
  solUsd: number;
  weights: number[];
  budgets: bigint[];
};

export function decodeVault(data: Buffer) {
  let off = 8 + 32 + 8 + 32;
  const totalShares = data.readBigUInt64LE(off);
  off += 8;
  const genesisShares = data.readBigUInt64LE(off);
  off += 8 + 4; // flags
  const book: bigint[] = [];
  for (let i = 0; i < 8; i++) {
    off += 32 + 2;
    book.push(data.readBigUInt64LE(off));
    off += 8 + 1 + 5;
  }
  return { totalShares, genesisShares, book };
}

export async function pricesUsd(): Promise<{ tokens: number[]; sol: number }> {
  const ids = [...MINTS, SOL_MINT].join(",");
  const r = await fetch("https://api.dexscreener.com/tokens/v1/solana/" + ids, {
    headers: { "user-agent": "gsmi-shape" },
  });
  const rows = (await r.json()) as any[];
  const px = new Map<string, number>();
  for (const p of rows) {
    const addr = p?.baseToken?.address;
    const usd = Number(p?.priceUsd);
    if (addr && usd > 0 && !px.has(addr)) px.set(addr, usd);
  }
  const tokens = MINTS.map((m) => {
    const v = px.get(m);
    if (!v) throw new Error("no price " + m.slice(0, 6));
    return v;
  });
  const sol = px.get(SOL_MINT);
  if (!sol) throw new Error("no SOL price");
  return { tokens, sol };
}

export function splitSol(solIn: bigint, weights: number[]): bigint[] {
  const budgets = weights.map((w) => (solIn * BigInt(Math.floor(w * 1_000_000_000))) / 1_000_000_000n);
  let sum = budgets.reduce((a, b) => a + b, 0n);
  // dump leftover lamports onto the fattest seat so the ticket empties
  let fat = 0;
  for (let i = 1; i < 8; i++) if (weights[i] > weights[fat]) fat = i;
  if (sum < solIn) budgets[fat] += solIn - sum;
  if (sum > solIn) {
    const over = sum - solIn;
    if (budgets[fat] <= over) throw new Error("budget overflow");
    budgets[fat] -= over;
  }
  if (budgets.some((b) => b === 0n)) throw new Error("zero seat budget");
  return budgets;
}

export async function liveShape(conn: Connection, solIn: bigint): Promise<Shape> {
  const acc = await conn.getAccountInfo(VAULT, "confirmed");
  if (!acc) throw new Error("vault missing");
  const { totalShares, genesisShares, book } = decodeVault(acc.data);
  if (totalShares === 0n) throw new Error("vault empty");
  const { tokens: pxUsd, sol: solUsd } = await pricesUsd();
  const bookUi = book.map((b, i) => Number(b) / 10 ** DEC[i]);
  const usd = bookUi.map((ui, i) => ui * pxUsd[i]);
  const tvlUsd = usd.reduce((a, b) => a + b, 0);
  if (tvlUsd <= 0) throw new Error("tvl zero");
  const weights = usd.map((u) => u / tvlUsd);
  const budgets = splitSol(solIn, weights);
  return {
    totalShares,
    genesisShares,
    book,
    bookUi,
    pxUsd,
    usd,
    tvlUsd,
    solUsd,
    weights,
    budgets,
  };
}

export function impliedShares(outAmount: bigint, book: bigint, totalShares: bigint): bigint {
  const net = (outAmount * (FEE_DEN - FEE_NUM)) / FEE_DEN;
  if (book === 0n || net === 0n) return 0n;
  return (net * totalShares) / book;
}

/** Haircut implied shares by the widest pad so a light Jupiter fill still clears. */
export function minSharesFromQuotes(implied: bigint[]): bigint {
  const raw = implied.reduce((a, b) => (b < a ? b : a));
  const pad = Math.max(...PAD_BPS);
  return (raw * BigInt(10_000 - pad)) / 10_000n;
}

export function padBudgets(budgets: bigint[], padBps = PAD_SOL_BPS): bigint[] {
  return budgets.map((b) => (b * BigInt(10_000 + padBps)) / 10_000n);
}

/** Tokens to offer so net after 69 still prints `shares` against this pile. */
export function tokensForShares(shares: bigint, book: bigint, totalShares: bigint): bigint {
  if (shares === 0n || book === 0n || totalShares === 0n) return 0n;
  const net = (shares * book + totalShares - 1n) / totalShares;
  return (net * FEE_DEN + (FEE_DEN - FEE_NUM) - 1n) / (FEE_DEN - FEE_NUM);
}

export function printShape(s: Shape, solIn: bigint) {
  const nav = s.tvlUsd / (Number(s.totalShares) / 1e9);
  const solUsd = (Number(solIn) / 1e9) * s.solUsd;
  console.log("book shares", Number(s.totalShares) / 1e9, "genesis", Number(s.genesisShares) / 1e9);
  console.log("tvl usd", s.tvlUsd.toFixed(2), "nav", nav.toFixed(4), "ticket usd", solUsd.toFixed(2));
  console.log("seat   book-ui        $     wgt   sol-lamports   vs-1/8");
  const eighth = solIn / 8n;
  for (let i = 0; i < 8; i++) {
    const vs = Number(s.budgets[i] - eighth);
    console.log(
      `${NAMES[i].padEnd(6)} ${s.bookUi[i].toFixed(4).padStart(12)} ${s.usd[i]
        .toFixed(2)
        .padStart(7)} ${(s.weights[i] * 100).toFixed(1).padStart(5)}% ${s.budgets[i]
        .toString()
        .padStart(12)} ${vs >= 0 ? "+" : ""}${vs}`
    );
  }
}
