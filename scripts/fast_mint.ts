/**
 * Shape mint. Wrap+buy fused. Resume with --nonce=.
 *
 *   export ANCHOR_PROVIDER_URL='https://YOUR_RPC'
 *   export ANCHOR_WALLET=~/.config/solana/id.json
 *   cd ~/gsmi-wrapper
 *   npx --yes tsx scripts/fast_mint.ts --send
 *   npx --yes tsx scripts/fast_mint.ts --send --nonce=N
 */
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, createSyncNativeInstruction } from "@solana/spl-token";
import { liveShape, printShape, impliedShares, minSharesFromQuotes, padBudgets, tokensForShares } from "./shape";
import {
  CONFIG,
  DESK,
  JUPITER,
  MINTS,
  NAMES,
  SHARES,
  VAULT,
  VAULT_PROGRAM,
  WRAP,
  WSOL,
  amtOf,
  arg,
  ataIx,
  destAta,
  disc,
  info,
  infos,
  jupQuote,
  jupSwapIx,
  loadJupLuts,
  openDoor,
  ownerShares,
  ownerWsol,
  quotesExactIn,
  seatWsol,
  seatsOf,
  sendV0,
  ticketPda,
  ticketShares,
  tok,
  tokenAmt,
  treasuryAta,
  u32,
  u64,
  u8,
  vaultAta,
  vecU8,
} from "./door";

const SOL_IN = Number(arg("sol") || "50000000");

async function main() {
  const send = process.argv.includes("--send");
  const nonce = BigInt(arg("nonce") || Date.now());
  const door = await openDoor();
  const ticket = ticketPda(door.owner, nonce);
  const seats = seatsOf(ticket);
  const tShares = ticketShares(ticket);
  const oShares = ownerShares(door.owner);

  const shape = await liveShape(door.conn, BigInt(SOL_IN));
  const padded = padBudgets(shape.budgets);
  const budgets = padded.map((b) => Number(b));
  const solOpen = Number(padded.reduce((a, b) => a + b, 0n));
  printShape(shape, BigInt(SOL_IN));
  console.log("pad 3%  open_lamports", solOpen, "vs asked", SOL_IN);

  console.log("send", send);
  console.log("nonce", nonce.toString());
  console.log("ticket", ticket.toBase58());
  console.log("WRITE THIS NONCE. resume --nonce=" + nonce.toString());

  const quotes = await quotesExactIn(
    budgets.map((b, i) => ({
      inMint: WSOL.toBase58(),
      outMint: MINTS[i].toBase58(),
      amount: String(b),
    }))
  );
  const implied: bigint[] = [];
  for (let i = 0; i < 8; i++) {
    implied.push(impliedShares(BigInt(quotes[i].outAmount), shape.book[i], shape.totalShares));
    console.log("quote", NAMES[i], quotes[i].outAmount, "impl", implied[i].toString());
  }
  const minShares = minSharesFromQuotes(implied);
  const targetOut = shape.book.map((book) => tokensForShares(minShares, book, shape.totalShares));
  console.log("min_shares", Number(minShares) / 1e9);
  for (let i = 0; i < 8; i++) console.log("target_out", NAMES[i], targetOut[i].toString());
  if (!send) {
    console.log("dry. --send to spend");
    return;
  }

  const t0 = Date.now();

  const dests = [...Array(8)].map((_, i) => destAta(ticket, i));
  const wsols = seats.map((s) => seatWsol(s));
  const ownWsol = ownerWsol(door.owner);
  const ataMetas: { ata: PublicKey; owner: PublicKey; mint: PublicKey; prog: PublicKey }[] = [];
  for (let i = 0; i < 8; i++) {
    ataMetas.push({ ata: dests[i], owner: ticket, mint: MINTS[i], prog: tok(i) });
    ataMetas.push({ ata: wsols[i], owner: seats[i], mint: WSOL, prog: TOKEN_PROGRAM_ID });
  }
  ataMetas.push({ ata: tShares, owner: ticket, mint: SHARES, prog: TOKEN_PROGRAM_ID });
  ataMetas.push({ ata: oShares, owner: door.owner, mint: SHARES, prog: TOKEN_PROGRAM_ID });
  ataMetas.push({ ata: ownWsol, owner: door.owner, mint: WSOL, prog: TOKEN_PROGRAM_ID });
  const probeKeys = [ticket, seats[0], ...ataMetas.map((m) => m.ata)];
  const probe = await infos(door, probeKeys);
  const ticketLive = !!probe[0];
  const seatsLive = !!probe[1];
  const need = ataMetas
    .filter((_, i) => !probe[i + 2])
    .map((m) => ataIx(door.owner, m.ata, m.owner, m.mint, m.prog));

  // One v0 cannot hold open + split + ~19 ATA creates. New PDAs are not in the LUT.
  if (!ticketLive) {
    await sendV0(
      door,
      [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
        new TransactionInstruction({
          programId: WRAP,
          keys: [
            { pubkey: door.owner, isSigner: true, isWritable: true },
            { pubkey: CONFIG, isSigner: false, isWritable: false },
            { pubkey: ticket, isSigner: false, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ],
          data: Buffer.concat([disc("open_mint"), u64(nonce), u64(solOpen), u64(minShares), u32(150)]),
        }),
      ],
      "open"
    );
  } else console.log("ticket open");
  if (!seatsLive) {
    await sendV0(
      door,
      [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
        new TransactionInstruction({
          programId: WRAP,
          keys: [
            { pubkey: door.owner, isSigner: true, isWritable: true },
            { pubkey: ticket, isSigner: false, isWritable: true },
            ...seats.map((s) => ({ pubkey: s, isSigner: false, isWritable: true })),
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ],
          data: Buffer.concat([disc("split_mint"), ...budgets.map((b) => u64(b))]),
        }),
      ],
      "split"
    );
  } else console.log("seats split");
  for (let i = 0; i < need.length; i += 6) {
    await sendV0(
      door,
      [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ...need.slice(i, i + 6)],
      "atas " + i
    );
  }
  if (need.length === 0) console.log("atas ready");

  if (process.argv.includes("--until=split")) {
    console.log("STOPPED after split. wait ~90s then cancel --ticket=" + ticket.toBase58());
    console.log("ms", Date.now() - t0);
    return;
  }

  if (process.argv.includes("--until=wrap")) {
    for (let i = 0; i < 8; i++) {
      const wsol = seatWsol(seats[i]);
      const already = await tokenAmt(door, wsol, TOKEN_PROGRAM_ID);
      if (already > 0n) {
        console.log("wrapped", NAMES[i], already.toString());
        continue;
      }
      await sendV0(door, [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 80_000 }),
        new TransactionInstruction({
          programId: WRAP,
          keys: [
            { pubkey: door.owner, isSigner: true, isWritable: false },
            { pubkey: ticket, isSigner: false, isWritable: false },
            { pubkey: seats[i], isSigner: false, isWritable: true },
            { pubkey: wsol, isSigner: false, isWritable: true },
            { pubkey: WSOL, isSigner: false, isWritable: false },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          ],
          data: Buffer.concat([disc("wrap_seat"), u8(i)]),
        }),
        createSyncNativeInstruction(wsol),
      ], "wrap " + NAMES[i]);
      console.log("wrapped", NAMES[i], (await tokenAmt(door, wsol, TOKEN_PROGRAM_ID)).toString());
    }
    console.log("STOPPED after wrap. wait ~90s then cancel --ticket=" + ticket.toBase58());
    console.log("ms", Date.now() - t0);
    return;
  }

  const T22 = new Set([1, 4, 7]);
  const PAD_DUST = 50_000n;

  async function crankBuy(i: number, q: any, wrap: boolean) {
    const dest = destAta(ticket, i);
    const wsol = seatWsol(seats[i]);
    const packed = await jupSwapIx(q, seats[i], dest);
    const swap = packed.swapInstruction as {
      programId: string;
      accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
      data: string;
    };
    if (swap.programId !== JUPITER.toBase58()) throw new Error(NAMES[i] + " swap program");
    const extra = await loadJupLuts(door, packed);
    const ixs: TransactionInstruction[] = [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })];
    if (wrap) {
      ixs.push(
        new TransactionInstruction({
          programId: WRAP,
          keys: [
            { pubkey: door.owner, isSigner: true, isWritable: false },
            { pubkey: ticket, isSigner: false, isWritable: false },
            { pubkey: seats[i], isSigner: false, isWritable: true },
            { pubkey: wsol, isSigner: false, isWritable: true },
            { pubkey: WSOL, isSigner: false, isWritable: false },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          ],
          data: Buffer.concat([disc("wrap_seat"), u8(i)]),
        }),
        createSyncNativeInstruction(wsol)
      );
    }
    ixs.push(
      new TransactionInstruction({
        programId: WRAP,
        keys: [
          { pubkey: door.owner, isSigner: true, isWritable: true },
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
        ],
        data: Buffer.concat([disc("crank_buy"), u8(i), vecU8(Buffer.from(swap.data, "base64"))]),
      })
    );
    await sendV0(door, ixs, (wrap ? "wrap+buy " : "buy ") + NAMES[i], extra);
  }

  async function gaugeIn(i: number, inAmt: bigint, wantOut: bigint) {
    const probe = await jupQuote(WSOL.toBase58(), MINTS[i].toBase58(), inAmt.toString());
    const implied = BigInt(probe.outAmount);
    if (implied === 0n) throw new Error("gauge 0 " + NAMES[i]);
    let need = (inAmt * wantOut + implied - 1n) / implied;
    if (need < 1n) need = 1n;
    if (need > inAmt) need = inAmt;
    const q = need === inAmt ? probe : await jupQuote(WSOL.toBase58(), MINTS[i].toBase58(), need.toString());
    console.log(
      "exact-in gauge",
      NAMES[i],
      "want",
      wantOut.toString(),
      "need",
      need.toString(),
      "have",
      inAmt.toString(),
      "out",
      q.outAmount
    );
    return q;
  }

  async function seatWork(i: number) {
    const dest = destAta(ticket, i);
    const wantOut = targetOut[i];
    if (wantOut === 0n) throw new Error("target 0 " + NAMES[i]);
    const have = await tokenAmt(door, dest, tok(i));
    if (have >= wantOut) {
      console.log("have", NAMES[i], have.toString());
      return;
    }
    const wsol = seatWsol(seats[i]);
    let inAmt = await tokenAmt(door, wsol, TOKEN_PROGRAM_ID);
    let wrap = false;
    if (inAmt === 0n) {
      inAmt = BigInt(budgets[i]);
      wrap = true;
    }
    let q: any = quotes[i];
    const quotedIn = BigInt(q.inAmount || budgets[i]);
    if (!wrap && quotedIn > inAmt) {
      q = await gaugeIn(i, inAmt, wantOut);
    } else {
      console.log("reuse quote", NAMES[i], "in", q.inAmount, "out", q.outAmount, wrap ? "wrap" : "");
    }
    await crankBuy(i, q, wrap);
    let got = await tokenAmt(door, dest, tok(i));
    console.log("got", NAMES[i], got.toString(), "want", wantOut.toString());
    if (got >= wantOut) return;
    const left = await tokenAmt(door, wsol, TOKEN_PROGRAM_ID);
    if (left <= PAD_DUST) {
      console.log("short", NAMES[i], "pad left", left.toString());
      return;
    }
    console.log("second exact-in", NAMES[i], "pad", left.toString());
    const q2 = await gaugeIn(i, left, wantOut - got);
    await crankBuy(i, q2, false);
    got = await tokenAmt(door, dest, tok(i));
    console.log("got2", NAMES[i], got.toString());
  }

  if (process.argv.includes("--until=buy")) {
    await seatWork(0);
    console.log("STOPPED after buy GME. other seven still wrapped.");
    console.log("wait ~90s then: npx --yes tsx scripts/cancel_ticket.ts --send --ticket=" + ticket.toBase58());
    console.log("ms", Date.now() - t0);
    return;
  }

  for (let i = 0; i < 8; i += 2) {
    const pair = [i, i + 1].filter((n) => n < 8);
    const res = await Promise.allSettled(pair.map((n) => seatWork(n)));
    for (let p = 0; p < pair.length; p++) {
      if (res[p].status === "rejected") {
        console.log("retry", NAMES[pair[p]], String((res[p] as PromiseRejectedResult).reason).slice(0, 160));
        await seatWork(pair[p]);
      }
    }
  }

  const destRows = await infos(door, dests);
  const offered: bigint[] = [];
  for (let i = 0; i < 8; i++) {
    const n = amtOf(destRows[i] as { data: Buffer } | null);
    if (n === 0n) throw new Error("empty dest " + NAMES[i] + " — same --nonce=");
    offered.push(n);
    console.log("offered", NAMES[i], n.toString());
  }
  const slice = offered
    .map((n, i) => impliedShares(n, shape.book[i], shape.totalShares))
    .reduce((a, b) => (b < a ? b : a));
  const finishMin = (slice * 9900n) / 10000n;
  console.log("slice", Number(slice) / 1e9, "finish_min", Number(finishMin) / 1e9);

  const finKeys = [
    { pubkey: door.owner, isSigner: true, isWritable: true },
    { pubkey: CONFIG, isSigner: false, isWritable: false },
    { pubkey: ticket, isSigner: false, isWritable: true },
    { pubkey: door.owner, isSigner: false, isWritable: true },
    { pubkey: DESK, isSigner: false, isWritable: true },
    { pubkey: VAULT, isSigner: false, isWritable: true },
    { pubkey: SHARES, isSigner: false, isWritable: true },
    { pubkey: tShares, isSigner: false, isWritable: true },
    { pubkey: oShares, isSigner: false, isWritable: true },
    { pubkey: VAULT_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
    ...seats.map((s) => ({ pubkey: s, isSigner: false, isWritable: true })),
  ];
  // Slim finish: seats + vault 8×3. WSOL pad sweep made the v0 message overrun.
  // Pad stays on seat WSOL ATAs until a later sweep door. Mint still lands.
  for (let i = 0; i < 8; i++) {
    finKeys.push({ pubkey: destAta(ticket, i), isSigner: false, isWritable: true });
    finKeys.push({ pubkey: vaultAta(i), isSigner: false, isWritable: true });
    finKeys.push({ pubkey: treasuryAta(i), isSigner: false, isWritable: true });
  }
  await sendV0(door, [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 }),
    new TransactionInstruction({
      programId: WRAP,
      keys: finKeys,
      data: Buffer.concat([disc("finish_mint"), ...offered.map((n) => u64(n)), u64(1), u64(finishMin)]),
    }),
  ], "finish_mint");

  try {
    console.log("owner GSMI", (await tokenAmt(door, oShares, TOKEN_PROGRAM_ID)).toString());
  } catch {
    console.log("owner GSMI unread");
  }
  console.log("ms", Date.now() - t0);
  console.log("DONE", ticket.toBase58());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
