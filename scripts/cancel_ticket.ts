/**
 * Owner cancel after the clock. Sweeps ticket dest ATAs, ticket WSOL,
 * seat WSOL (post-wrap), then closes seats + ticket.
 *
 *   export ANCHOR_PROVIDER_URL='https://YOUR_RPC'
 *   export ANCHOR_WALLET=~/.config/solana/id.json
 *   cd ~/gsmi-wrapper
 *   npx --yes tsx scripts/cancel_ticket.ts --send --ticket=TICKET
 */
import { ComputeBudgetProgram, PublicKey, TransactionInstruction } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createCloseAccountInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  MINTS,
  NAMES,
  SHARES,
  STATUS,
  WRAP,
  WSOL,
  arg,
  ataIx,
  destAta,
  disc,
  info,
  openDoor,
  seatsOf,
  seatWsol,
  sendV0,
  tokenAmt,
  tok,
} from "./door";

async function main() {
  const ticketArg = arg("ticket");
  if (!ticketArg) throw new Error("need --ticket=");
  const send = process.argv.includes("--send");
  const ticket = new PublicKey(ticketArg);
  const door = await openDoor();
  const raw = await info(door, ticket);
  if (!raw) throw new Error("ticket gone");
  const status = raw.data[8 + 32 + 8 + 1];
  const openSlot = raw.data.readBigUInt64LE(8 + 32 + 8 + 1 + 1 + 8 + 8 + 8);
  const cancelSlots = raw.data.readUInt32LE(8 + 32 + 8 + 1 + 1 + 8 + 8 + 8 + 8);
  const slot = await door.conn.getSlot("confirmed");
  console.log("ticket", ticket.toBase58());
  console.log("status", STATUS[status] || status);
  console.log("open_slot", openSlot.toString(), "cancel_slots", cancelSlots, "now", slot);
  console.log("cancellable", slot >= Number(openSlot) + cancelSlots);

  const ownerWsol = getAssociatedTokenAddressSync(WSOL, door.owner, false, TOKEN_PROGRAM_ID);
  const destWsol = getAssociatedTokenAddressSync(WSOL, ticket, true, TOKEN_PROGRAM_ID);
  const tShares = getAssociatedTokenAddressSync(SHARES, ticket, true, TOKEN_PROGRAM_ID);
  const oShares = getAssociatedTokenAddressSync(SHARES, door.owner, false, TOKEN_PROGRAM_ID);

  const rest: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] = [];
  const pairs: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] = [];
  let needOwnerWsol = false;

  const seats = seatsOf(ticket);
  if ((STATUS[status] || status) === "Split") {
    for (const s of seats) {
      console.log("seat", s.toBase58());
      rest.push({ pubkey: s, isSigner: false, isWritable: true });
    }
    for (let i = 0; i < 8; i++) {
      const wsol = seatWsol(seats[i]);
      const amt = await tokenAmt(door, wsol, TOKEN_PROGRAM_ID);
      const exists = !!(await info(door, wsol));
      console.log(NAMES[i], "seat-wsol", amt.toString(), exists ? "ata" : "none");
      if (!exists && amt === 0n) continue;
      needOwnerWsol = true;
      pairs.push({ pubkey: wsol, isSigner: false, isWritable: true });
      pairs.push({ pubkey: ownerWsol, isSigner: false, isWritable: true });
    }
  }

  const tw = await tokenAmt(door, destWsol, TOKEN_PROGRAM_ID);
  console.log("ticket wsol", tw.toString());
  if (tw > 0n || (await info(door, destWsol))) {
    needOwnerWsol = true;
    pairs.push({ pubkey: destWsol, isSigner: false, isWritable: true });
    pairs.push({ pubkey: ownerWsol, isSigner: false, isWritable: true });
  }

  const ts = await tokenAmt(door, tShares, TOKEN_PROGRAM_ID);
  console.log("ticket shares", ts.toString());
  const destCreates: TransactionInstruction[] = [];
  if (ts > 0n || (await info(door, tShares))) {
    destCreates.push(ataIx(door.owner, oShares, door.owner, SHARES, TOKEN_PROGRAM_ID));
    pairs.push({ pubkey: tShares, isSigner: false, isWritable: true });
    pairs.push({ pubkey: oShares, isSigner: false, isWritable: true });
  }

  for (let i = 0; i < 8; i++) {
    const from = destAta(ticket, i);
    const amt = await tokenAmt(door, from, tok(i));
    console.log(NAMES[i], "dest", amt.toString());
    if (amt === 0n && !(await info(door, from))) continue;
    const to = getAssociatedTokenAddressSync(MINTS[i], door.owner, false, tok(i));
    destCreates.push(ataIx(door.owner, to, door.owner, MINTS[i], tok(i)));
    pairs.push({ pubkey: from, isSigner: false, isWritable: true });
    pairs.push({ pubkey: to, isSigner: false, isWritable: true });
  }

  if (!send) {
    console.log("dry pairs", pairs.length / 2);
    return;
  }

  const before = await door.conn.getBalance(door.owner);
  const setup: TransactionInstruction[] = [];
  if (needOwnerWsol) setup.push(ataIx(door.owner, ownerWsol, door.owner, WSOL, TOKEN_PROGRAM_ID));
  setup.push(...destCreates);
  if (setup.length) {
    await sendV0(door, [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 80_000 }),
      ...setup,
    ], "setup");
  }
  await sendV0(door, [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
    new TransactionInstruction({
      programId: WRAP,
      keys: [
        { pubkey: door.owner, isSigner: true, isWritable: true },
        { pubkey: ticket, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
        ...rest,
        ...pairs,
      ],
      data: disc("cancel"),
    }),
  ], "cancel");

  const ow = await tokenAmt(door, ownerWsol, TOKEN_PROGRAM_ID);
  if (ow > 0n) {
    await sendV0(door, [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }),
      createCloseAccountInstruction(ownerWsol, door.owner, door.owner, [], TOKEN_PROGRAM_ID),
    ], "unwrap");
  }
  const after = await door.conn.getBalance(door.owner);
  console.log("owner sol", before, "->", after, "delta", after - before);
  console.log("DONE cancel", ticket.toBase58());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
