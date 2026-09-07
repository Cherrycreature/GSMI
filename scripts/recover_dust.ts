/**
 * Sweep ExactOut pad WSOL + empty dest ATAs off a Done ticket.
 *
 *   export ANCHOR_PROVIDER_URL='https://YOUR_RPC'
 *   export ANCHOR_WALLET=~/.config/solana/id.json
 *   npx --yes tsx scripts/recover_dust.ts --send --nonce=1788683720590
 */
import { ComputeBudgetProgram, PublicKey, TransactionInstruction } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  MINTS,
  NAMES,
  WRAP,
  WSOL,
  arg,
  destAta,
  disc,
  openDoor,
  ownerWsol,
  seatWsol,
  seatsOf,
  sendV0,
  ticketPda,
  tok,
  tokenAmt,
  u8,
} from "./door";

async function main() {
  const nonce = BigInt(arg("nonce") || "1788683720590");
  const send = process.argv.includes("--send");
  const door = await openDoor();
  const ticket = ticketPda(door.owner, nonce);
  const seats = seatsOf(ticket);
  const ow = ownerWsol(door.owner);
  console.log("ticket", ticket.toBase58());
  console.log("nonce", nonce.toString());
  console.log("send", send);

  if (!send) {
    for (let i = 0; i < 8; i++) {
      const w = seatWsol(seats[i]);
      const n = await tokenAmt(door, w, TOKEN_PROGRAM_ID);
      console.log("seat wsol", NAMES[i], w.toBase58(), n.toString());
    }
    return;
  }

  await sendV0(door, [
    createAssociatedTokenAccountIdempotentInstruction(
      door.owner,
      ow,
      door.owner,
      WSOL,
      TOKEN_PROGRAM_ID
    ),
  ], "owner wsol");

  for (let i = 0; i < 8; i++) {
    const w = seatWsol(seats[i]);
    const n = await tokenAmt(door, w, TOKEN_PROGRAM_ID);
    const acc = await door.conn.getAccountInfo(w, "confirmed");
    if (!acc) {
      console.log("no wsol ata", NAMES[i]);
      continue;
    }
    console.log("sweep wsol", NAMES[i], n.toString());
    await sendV0(door, [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      new TransactionInstruction({
        programId: WRAP,
        keys: [
          { pubkey: door.owner, isSigner: true, isWritable: true },
          { pubkey: ticket, isSigner: false, isWritable: false },
          { pubkey: seats[i], isSigner: false, isWritable: false },
          { pubkey: w, isSigner: false, isWritable: true },
          { pubkey: ow, isSigner: false, isWritable: true },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        data: Buffer.concat([disc("recover_seat_wsol"), u8(i)]),
      }),
    ], "recover wsol " + NAMES[i]);
  }

  for (let i = 0; i < 8; i++) {
    const from = destAta(ticket, i);
    const acc = await door.conn.getAccountInfo(from, "confirmed");
    if (!acc) {
      console.log("no dest", NAMES[i]);
      continue;
    }
    const ownerAta = getAssociatedTokenAddressSync(MINTS[i], door.owner, false, tok(i));
    const left = await tokenAmt(door, from, tok(i));
    console.log("close dest", NAMES[i], left.toString());
    await sendV0(door, [
      createAssociatedTokenAccountIdempotentInstruction(
        door.owner,
        ownerAta,
        door.owner,
        MINTS[i],
        tok(i)
      ),
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      new TransactionInstruction({
        programId: WRAP,
        keys: [
          { pubkey: door.owner, isSigner: true, isWritable: true },
          { pubkey: ticket, isSigner: false, isWritable: false },
          { pubkey: from, isSigner: false, isWritable: true },
          { pubkey: ownerAta, isSigner: false, isWritable: true },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        data: disc("recover_ticket_ata"),
      }),
    ], "recover dest " + NAMES[i]);
  }
  console.log("DONE recover", ticket.toBase58());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
