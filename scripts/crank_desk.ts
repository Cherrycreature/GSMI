/**
 * Permissionless mint desk.
 * Owner signs open_mint on the site. This process finishes the ticket.
 *
 *   export ANCHOR_PROVIDER_URL='https://YOUR_RPC'
 *   export ANCHOR_WALLET=~/.config/solana/id.json
 *   cd ~/gsmi-wrapper
 *   npx --yes tsx scripts/crank_desk.ts
 *
 * Needs a few SOL for fees + first-time ATA rent. Not a custodian.
 */
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, createSyncNativeInstruction } from "@solana/spl-token";
import { liveShape, padBudgets, impliedShares, tokensForShares } from "./shape";
import {
  CONFIG,
  DESK,
  JUPITER,
  MINTS,
  NAMES,
  SHARES,
  STATUS,
  VAULT,
  VAULT_PROGRAM,
  WRAP,
  WSOL,
  amtOf,
  ataIx,
  destAta,
  disc,
  infos,
  jupQuote,
  jupSwapIx,
  loadJupLuts,
  openDoor,
  ownerShares,
  ownerWsol,
  seatWsol,
  seatsOf,
  sendV0,
  sleep,
  ticketShares,
  tok,
  tokenAmt,
  treasuryAta,
  u64,
  u8,
  vaultAta,
  vecU8,
} from "./door";

const TICKET_SIZE = 8 + 32 + 8 + 1 + 1 + 8 + 8 + 8 + 8 + 4 + 1 + 16;

function readTicket(data: Buffer) {
  const owner = new PublicKey(data.subarray(8, 40));
  const nonce = data.readBigUInt64LE(40);
  const side = data[48];
  const status = data[49];
  const solIn = data.readBigUInt64LE(50);
  const minOut = data.readBigUInt64LE(66);
  return { owner, nonce, side, status, solIn, minOut };
}

async function finishMintTicket(
  door: Awaited<ReturnType<typeof openDoor>>,
  ticket: PublicKey,
  raw: Buffer,
) {
  const t = readTicket(raw);
  if (t.side !== 0) return;
  if (t.status >= 3) return;
  const seats = seatsOf(ticket);
  const tShares = ticketShares(ticket);
  const oShares = ownerShares(t.owner);
  const dests = [...Array(8)].map((_, i) => destAta(ticket, i));
  const wsols = seats.map((s) => seatWsol(s));
  const ownWsol = ownerWsol(t.owner);

  const shape = await liveShape(door.conn, t.solIn);
  const padded = padBudgets(shape.budgets);
  const budgets = padded.map((b) => Number(b));
  const sum = padded.reduce((a, b) => a + b, 0n);
  if (sum > t.solIn) {
    console.log(ticket.toBase58(), "budget > sol_in", String(sum), String(t.solIn));
    return;
  }

  const probe = await infos(door, [ticket, seats[0]]);
  if (!probe[0]) return;
  if (!probe[1]) {
    console.log("split", ticket.toBase58());
    await sendV0(
      door,
      [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
        new TransactionInstruction({
          programId: WRAP,
          keys: [
            { pubkey: door.payer.publicKey, isSigner: true, isWritable: true },
            { pubkey: ticket, isSigner: false, isWritable: true },
            ...seats.map((s) => ({ pubkey: s, isSigner: false, isWritable: true })),
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ],
          data: Buffer.concat([disc("split_mint"), ...budgets.map((b) => u64(b))]),
        }),
      ],
      "split",
    );
  }

  const ataMetas = [];
  for (let i = 0; i < 8; i++) {
    ataMetas.push({ ata: dests[i], owner: ticket, mint: MINTS[i], prog: tok(i) });
    ataMetas.push({ ata: wsols[i], owner: seats[i], mint: WSOL, prog: TOKEN_PROGRAM_ID });
  }
  ataMetas.push({ ata: tShares, owner: ticket, mint: SHARES, prog: TOKEN_PROGRAM_ID });
  ataMetas.push({ ata: oShares, owner: t.owner, mint: SHARES, prog: TOKEN_PROGRAM_ID });
  ataMetas.push({ ata: ownWsol, owner: t.owner, mint: WSOL, prog: TOKEN_PROGRAM_ID });
  const rows = await infos(door, ataMetas.map((m) => m.ata));
  const need = ataMetas
    .filter((_, i) => !rows[i])
    .map((m) => ataIx(door.payer.publicKey, m.ata, m.owner, m.mint, m.prog));
  for (let i = 0; i < need.length; i += 6) {
    console.log("atas", ticket.toBase58(), i);
    await sendV0(
      door,
      [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ...need.slice(i, i + 6)],
      "ata",
    );
  }

  const quotes = await Promise.all(
    budgets.map((b, i) => jupQuote(WSOL.toBase58(), MINTS[i].toBase58(), String(b))),
  );
  const implied = quotes.map((q, i) =>
    impliedShares(BigInt(q.outAmount), shape.book[i], shape.totalShares),
  );
  const minShares = implied.reduce((a, b) => (b < a ? b : a));
  const targetOut = shape.book.map((book) => tokensForShares(minShares, book, shape.totalShares));

  for (let i = 0; i < 8; i++) {
    const have = await tokenAmt(door, dests[i], tok(i));
    if (have >= targetOut[i] && targetOut[i] > 0n) continue;
    console.log("buy", NAMES[i], ticket.toBase58());
    const inAmt = await tokenAmt(door, wsols[i], TOKEN_PROGRAM_ID);
    const wrap = inAmt === 0n;
    const packed = await jupSwapIx(quotes[i], seats[i], dests[i]);
    const swap = packed.swapInstruction;
    const extra = await loadJupLuts(door, packed);
    const ixs: TransactionInstruction[] = [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })];
    if (wrap) {
      ixs.push(
        new TransactionInstruction({
          programId: WRAP,
          keys: [
            { pubkey: door.payer.publicKey, isSigner: true, isWritable: false },
            { pubkey: ticket, isSigner: false, isWritable: false },
            { pubkey: seats[i], isSigner: false, isWritable: true },
            { pubkey: wsols[i], isSigner: false, isWritable: true },
            { pubkey: WSOL, isSigner: false, isWritable: false },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          ],
          data: Buffer.concat([disc("wrap_seat"), u8(i)]),
        }),
        createSyncNativeInstruction(wsols[i]),
      );
    }
    ixs.push(
      new TransactionInstruction({
        programId: WRAP,
        keys: [
          { pubkey: door.payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: CONFIG, isSigner: false, isWritable: false },
          { pubkey: ticket, isSigner: false, isWritable: false },
          { pubkey: seats[i], isSigner: false, isWritable: true },
          { pubkey: dests[i], isSigner: false, isWritable: true },
          { pubkey: wsols[i], isSigner: false, isWritable: true },
          { pubkey: WSOL, isSigner: false, isWritable: false },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: JUPITER, isSigner: false, isWritable: false },
          ...swap.accounts.map((a: { pubkey: string; isWritable: boolean }) => ({
            pubkey: new PublicKey(a.pubkey),
            isWritable: a.isWritable,
            isSigner: false,
          })),
        ],
        data: Buffer.concat([disc("crank_buy"), u8(i), vecU8(Buffer.from(swap.data, "base64"))]),
      }),
    );
    await sendV0(door, ixs, "buy-" + NAMES[i], extra);
  }

  const destRows = await infos(door, dests);
  const offered = destRows.map((row) => amtOf(row?.data as Buffer | undefined));
  if (offered.some((n) => n === 0n)) {
    console.log("empty seat", ticket.toBase58(), offered.map(String).join(","));
    return;
  }
  const slice = offered
    .map((n, i) => impliedShares(n, shape.book[i], shape.totalShares))
    .reduce((a, b) => (b < a ? b : a));
  const finishMin = (slice * 9900n) / 10000n;
  const finKeys = [
    { pubkey: door.payer.publicKey, isSigner: true, isWritable: true },
    { pubkey: CONFIG, isSigner: false, isWritable: false },
    { pubkey: ticket, isSigner: false, isWritable: true },
    { pubkey: t.owner, isSigner: false, isWritable: true },
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
  for (let i = 0; i < 8; i++) {
    finKeys.push({ pubkey: dests[i], isSigner: false, isWritable: true });
    finKeys.push({ pubkey: vaultAta(i), isSigner: false, isWritable: true });
    finKeys.push({ pubkey: treasuryAta(i), isSigner: false, isWritable: true });
  }
  console.log("finish", ticket.toBase58(), String(slice));
  await sendV0(
    door,
    [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 }),
      new TransactionInstruction({
        programId: WRAP,
        keys: finKeys,
        data: Buffer.concat([disc("finish_mint"), ...offered.map((n) => u64(n)), u64(1), u64(finishMin)]),
      }),
    ],
    "finish",
  );
}

async function main() {
  const door = await openDoor();
  console.log("desk live. wrap anyone. cancel still owner.");
  for (;;) {
    try {
      const accs = await door.conn.getProgramAccounts(WRAP, {
        commitment: "confirmed",
        filters: [{ dataSize: TICKET_SIZE }],
      });
      for (const a of accs) {
        const t = readTicket(a.account.data as Buffer);
        if (t.side !== 0) continue;
        if (t.status !== 0 && t.status !== 1) continue;
        console.log("ticket", a.pubkey.toBase58(), STATUS[t.status] || t.status, t.owner.toBase58());
        try {
          await finishMintTicket(door, a.pubkey, a.account.data as Buffer);
        } catch (e) {
          console.log("desk miss", a.pubkey.toBase58(), e instanceof Error ? e.message : e);
        }
      }
    } catch (e) {
      console.log("scan", e instanceof Error ? e.message : e);
    }
    await sleep(2500);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
