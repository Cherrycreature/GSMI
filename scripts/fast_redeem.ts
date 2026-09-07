/**
 * Redeem. Same rails as fast_mint. Resume with --ticket= or --nonce=.
 *
 *   export ANCHOR_PROVIDER_URL='https://YOUR_RPC'
 *   export ANCHOR_WALLET=~/.config/solana/id.json
 *   cd ~/gsmi-wrapper
 *   npx --yes tsx scripts/fast_redeem.ts --send
 *   npx --yes tsx scripts/fast_redeem.ts --send --shares=1000000000
 *   npx --yes tsx scripts/fast_redeem.ts --send --ticket=TICKET
 */
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
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
  quotesExactIn,
  sendV0,
  ticketPda,
  ticketShares,
  ticketWsol,
  tok,
  u32,
  u64,
  u8,
  vaultAta,
  vecU8,
} from "./door";

function readTicket(buf: Buffer) {
  return {
    owner: new PublicKey(buf.subarray(8, 40)),
    nonce: buf.readBigUInt64LE(40),
    side: buf[48],
    status: buf[49],
    sharesIn: buf.readBigUInt64LE(58),
    minOut: buf.readBigUInt64LE(66),
  };
}

async function main() {
  const send = process.argv.includes("--send");
  const shares = BigInt(arg("shares") || "1000000000");
  const minSol = BigInt(arg("min") || "1000000");
  const nonce = BigInt(arg("nonce") || Date.now());
  const door = await openDoor();

  let ticket: PublicKey;
  const ticketArg = arg("ticket");
  if (ticketArg) ticket = new PublicKey(ticketArg);
  else ticket = ticketPda(door.owner, nonce);

  const oShares = ownerShares(door.owner);
  const tShares = ticketShares(ticket);
  const destWsol = ticketWsol(ticket);

  console.log("ticket", ticket.toBase58());
  console.log("nonce", ticketArg ? "(from ticket)" : nonce.toString());
  console.log("shares", shares.toString());
  if (!ticketArg) console.log("WRITE THIS NONCE. resume --nonce=" + nonce.toString());

  if (!send) {
    console.log("dry");
    return;
  }
  const t0 = Date.now();

  const dests = [...Array(8)].map((_, i) => destAta(ticket, i));
  const ataMetas = [
    { ata: tShares, owner: ticket, mint: SHARES, prog: TOKEN_PROGRAM_ID },
    { ata: destWsol, owner: ticket, mint: WSOL, prog: TOKEN_PROGRAM_ID },
    ...dests.map((ata, i) => ({ ata, owner: ticket, mint: MINTS[i], prog: tok(i) })),
  ];
  const probe = await infos(door, [ticket, oShares, ...ataMetas.map((m) => m.ata)]);
  const need = ataMetas
    .filter((_, i) => !probe[i + 2])
    .map((m) => ataIx(door.owner, m.ata, m.owner, m.mint, m.prog));

  // OpenRedeem requires ticket_shares already live. ATAs first, then open.
  for (let i = 0; i < need.length; i += 6) {
    await sendV0(
      door,
      [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ...need.slice(i, i + 6)],
      "atas " + i
    );
  }
  if (need.length === 0) console.log("atas ready");

  let acc = probe[0];
  if (!acc) {
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
            { pubkey: oShares, isSigner: false, isWritable: true },
            { pubkey: tShares, isSigner: false, isWritable: true },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ],
          data: Buffer.concat([disc("open_redeem"), u64(nonce), u64(shares), u64(minSol), u32(150)]),
        }),
      ],
      "open"
    );
    acc = await info(door, ticket);
  } else console.log("ticket open");

  const t = readTicket(acc!.data);
  console.log("status", STATUS[t.status] || t.status, "shares_in", t.sharesIn.toString());
  if (t.status === 3 || t.status === 4) {
    console.log("already closed");
    return;
  }

  if (t.status === 0) {
    const remaining = [];
    for (let i = 0; i < 8; i++) {
      remaining.push({ pubkey: vaultAta(i), isSigner: false, isWritable: true });
      remaining.push({ pubkey: destAta(ticket, i), isSigner: false, isWritable: true });
    }
    await sendV0(door, [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      new TransactionInstruction({
        programId: WRAP,
        keys: [
          { pubkey: door.owner, isSigner: true, isWritable: true },
          { pubkey: CONFIG, isSigner: false, isWritable: false },
          { pubkey: ticket, isSigner: false, isWritable: true },
          { pubkey: VAULT, isSigner: false, isWritable: true },
          { pubkey: SHARES, isSigner: false, isWritable: true },
          { pubkey: tShares, isSigner: false, isWritable: true },
          { pubkey: VAULT_PROGRAM, isSigner: false, isWritable: false },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
          ...remaining,
        ],
        data: Buffer.concat([disc("crank_redeem_basket"), u64(t.sharesIn)]),
      }),
    ], "crank_redeem_basket");
  }

  const held = await infos(door, dests);
  const amounts = held.map((row) => amtOf(row as { data: Buffer } | null));
  const live = amounts
    .map((n, i) => ({ i, n }))
    .filter((x) => x.n > 0n);
  for (let i = 0; i < 8; i++) {
    if (amounts[i] === 0n) console.log("empty", NAMES[i]);
  }

  const packedBy = new Map<number, Awaited<ReturnType<typeof jupSwapIx>>>();
  if (live.length) {
    const qs = await quotesExactIn(
      live.map((x) => ({
        inMint: MINTS[x.i].toBase58(),
        outMint: WSOL.toBase58(),
        amount: x.n.toString(),
      }))
    );
    const packs = await Promise.all(live.map((x, k) => jupSwapIx(qs[k], ticket, destWsol)));
    for (let k = 0; k < live.length; k++) packedBy.set(live[k].i, packs[k]);
  }

  async function sell(i: number) {
    const packed = packedBy.get(i);
    if (!packed) return;
    const seatAta = dests[i];
    const swap = packed.swapInstruction as {
      accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
      data: string;
    };
    const extra = await loadJupLuts(door, packed);
    await sendV0(door, [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      new TransactionInstruction({
        programId: WRAP,
        keys: [
          { pubkey: door.owner, isSigner: true, isWritable: true },
          { pubkey: CONFIG, isSigner: false, isWritable: false },
          { pubkey: ticket, isSigner: false, isWritable: true },
          { pubkey: seatAta, isSigner: false, isWritable: true },
          { pubkey: JUPITER, isSigner: false, isWritable: false },
          ...swap.accounts.map((a) => ({
            pubkey: new PublicKey(a.pubkey),
            isSigner: false,
            isWritable: a.isWritable,
          })),
        ],
        data: Buffer.concat([disc("crank_sell"), u8(i), vecU8(Buffer.from(swap.data, "base64"))]),
      }),
    ], "sell " + NAMES[i], extra);
  }

  for (let i = 0; i < 8; i += 2) {
    const pair = [i, i + 1].filter((n) => n < 8);
    const res = await Promise.allSettled(pair.map((n) => sell(n)));
    for (let p = 0; p < pair.length; p++) {
      if (res[p].status === "rejected") {
        console.log("retry", NAMES[pair[p]], String((res[p] as PromiseRejectedResult).reason).slice(0, 160));
        const n = amounts[pair[p]];
        if (n > 0n) {
          const q = await jupQuote(MINTS[pair[p]].toBase58(), WSOL.toBase58(), n.toString());
          packedBy.set(pair[p], await jupSwapIx(q, ticket, destWsol));
          await sell(pair[p]);
        }
      }
    }
  }

  const before = await door.conn.getBalance(door.owner);
  await sendV0(door, [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    new TransactionInstruction({
      programId: WRAP,
      keys: [
        { pubkey: door.owner, isSigner: true, isWritable: true },
        { pubkey: CONFIG, isSigner: false, isWritable: false },
        { pubkey: ticket, isSigner: false, isWritable: true },
        { pubkey: door.owner, isSigner: false, isWritable: true },
        { pubkey: DESK, isSigner: false, isWritable: true },
        { pubkey: destWsol, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ...[...Array(8)].map((_, i) => ({
          pubkey: destAta(ticket, i),
          isSigner: false,
          isWritable: true,
        })),
      ],
      data: disc("finish_redeem_sol"),
    }),
  ], "finish_redeem_sol");
  const after = await door.conn.getBalance(door.owner);
  console.log("owner sol", before, "->", after, "delta", after - before);

  console.log("ms", Date.now() - t0);
  console.log("DONE", ticket.toBase58());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
