/**
 * One redeem round. Resume-safe.
 *
 *   cd ~/gsmi-wrapper
 *   npx --yes tsx scripts/redeem_round.ts
 *   npx --yes tsx scripts/redeem_round.ts --shares=1000000000
 *   npx --yes tsx scripts/redeem_round.ts --ticket=56QG...
 *
 * Default burns 1 GSMI (1e9). Skips empty seats. One open ticket at a time.
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
} from "@solana/spl-token";
import { createHash } from "crypto";
import fs from "fs";
import os from "os";

const WRAP = new PublicKey("4FMpDudDHnQkXp3Y6FjCfd4BKELxHzYrjTSwrMs3T5F2");
const CONFIG = new PublicKey("J6tQMxY3fDfXcUJ85nYJPZzJxVQSvreP5zjYBxoF2nMB");
const VAULT = new PublicKey("FvXKb7JVCmMa9tuAexF3zyAvj1vvRUVngrRgBpUFaCpe");
const SHARES = new PublicKey("W1yo6FyJgfGTtj75S8qTxuN9qjTE5XKijq6DkCVRHU4");
const VAULT_PROGRAM = new PublicKey("4saonDbBXhXJQ8TPvb7gMdrDNrkmpuRvjwCxqu1UDPxQ");
const JUPITER = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
const DESK = new PublicKey("5Cz2YfDQkhgsGZ31so8oWRRMfcJDzBi7hW3rKRTQSrZo");
const LUT = new PublicKey("9RpTgfk5n2K1J52Dk89hhc6bNzua5nsKkWquuJ5y6iMX");
const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
const JUP_API = "https://lite-api.jup.ag/swap/v1";
const SLIP_BPS = 200;
const STATUS = ["Open", "Split", "BasketOut", "Done", "Cancelled"];

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
function tok(i: number) {
  return T22.has(i) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
}
function loadKeypair() {
  let p = process.env.ANCHOR_WALLET || "~/.config/solana/id.json";
  if (p.startsWith("~")) p = os.homedir() + "/" + p.slice(2);
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}
function arg(name: string) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}
function readTicket(buf: Buffer) {
  return {
    owner: new PublicKey(buf.subarray(8, 40)),
    nonce: buf.readBigUInt64LE(40),
    side: buf[48],
    status: buf[49],
    sharesIn: buf.readBigUInt64LE(58),
    minOut: buf.readBigUInt64LE(66),
    bump: buf[86],
  };
}

async function main() {
  const url = process.env.ANCHOR_PROVIDER_URL || "https://api.mainnet-beta.solana.com";
  const conn = new Connection(url, "confirmed");
  const payer = loadKeypair();
  const owner = payer.publicKey;
  const shares = BigInt(arg("shares") || "1000000000");
  const minSol = BigInt(arg("min") || "1000000");
  const nonce = BigInt(arg("nonce") || Date.now());

  let ticket: PublicKey;
  const ticketArg = arg("ticket");
  if (ticketArg) ticket = new PublicKey(ticketArg);
  else {
    ticket = PublicKey.findProgramAddressSync(
      [Buffer.from("ticket"), owner.toBuffer(), u64(nonce)],
      WRAP
    )[0];
  }

  const ownerShares = getAssociatedTokenAddressSync(SHARES, owner, false, TOKEN_PROGRAM_ID);
  const ticketShares = getAssociatedTokenAddressSync(SHARES, ticket, true, TOKEN_PROGRAM_ID);
  const destWsol = getAssociatedTokenAddressSync(WSOL, ticket, true, TOKEN_PROGRAM_ID);
  const seatAtas = MINTS.map((m, i) => getAssociatedTokenAddressSync(m, ticket, true, tok(i)));
  const vaultAtas = MINTS.map((m, i) => getAssociatedTokenAddressSync(m, VAULT, true, tok(i)));

  console.log("wallet", owner.toBase58());
  console.log("ticket", ticket.toBase58());
  console.log("nonce", ticketArg ? "(from ticket)" : nonce.toString());
  console.log("shares", shares.toString());
  console.log("owner sol", await conn.getBalance(owner));
  const gsmiBal = await conn.getTokenAccountBalance(ownerShares);
  console.log("owner gsmi", gsmiBal.value.uiAmountString, gsmiBal.value.amount);

  const gsmiLut = (await conn.getAddressLookupTable(LUT)).value;
  if (!gsmiLut) throw new Error("GSMI LUT missing");

  async function sendV0(ixs: TransactionInstruction[], luts: AddressLookupTableAccount[], label: string) {
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
    const tx = new VersionedTransaction(
      new TransactionMessage({
        payerKey: owner,
        recentBlockhash: blockhash,
        instructions: ixs,
      }).compileToV0Message(luts)
    );
    tx.sign([payer]);
    const sim = await conn.simulateTransaction(tx, { sigVerify: true });
    console.log(label, "sim", sim.value.err);
    if (sim.value.err) {
      for (const line of sim.value.logs || []) console.log(line);
      throw new Error(label + " sim failed");
    }
    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
    await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    console.log(label, sig);
    return sig;
  }

  const ensure: TransactionInstruction[] = [];
  for (const ata of [ticketShares, destWsol, ...seatAtas]) {
    if (!(await conn.getAccountInfo(ata))) {
      const mint =
        ata.equals(ticketShares) ? SHARES :
        ata.equals(destWsol) ? WSOL :
        MINTS[seatAtas.findIndex((s) => s.equals(ata))];
      const program =
        ata.equals(ticketShares) || ata.equals(destWsol)
          ? TOKEN_PROGRAM_ID
          : tok(seatAtas.findIndex((s) => s.equals(ata)));
      ensure.push(
        createAssociatedTokenAccountIdempotentInstruction(owner, ata, ticket, mint, program)
      );
    }
  }
  if (ensure.length) {
    await sendV0(
      [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
        ...ensure,
      ],
      [gsmiLut],
      "create atas"
    );
  }

  let info = await conn.getAccountInfo(ticket);
  if (!info) {
    if (BigInt(gsmiBal.value.amount) < shares) throw new Error("not enough GSMI");
    const ix = new TransactionInstruction({
      programId: WRAP,
      keys: [
        { pubkey: owner, isSigner: true, isWritable: true },
        { pubkey: CONFIG, isSigner: false, isWritable: false },
        { pubkey: ticket, isSigner: false, isWritable: true },
        { pubkey: ownerShares, isSigner: false, isWritable: true },
        { pubkey: ticketShares, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([disc("open_redeem"), u64(nonce), u64(shares), u64(minSol), u32(150)]),
    });
    await sendV0(
      [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
        ix,
      ],
      [],
      "open_redeem"
    );
    info = await conn.getAccountInfo(ticket);
  }

  const t = readTicket(info!.data);
  console.log("status", STATUS[t.status] || t.status, "shares_in", t.sharesIn.toString());
  if (t.status === 3 || t.status === 4) {
    console.log("ticket already closed");
    return;
  }

  if (t.status === 0) {
    const remaining = [];
    for (let i = 0; i < 8; i++) {
      remaining.push({ pubkey: vaultAtas[i], isSigner: false, isWritable: true });
      remaining.push({ pubkey: seatAtas[i], isSigner: false, isWritable: true });
    }
    const ix = new TransactionInstruction({
      programId: WRAP,
      keys: [
        { pubkey: owner, isSigner: true, isWritable: true },
        { pubkey: CONFIG, isSigner: false, isWritable: false },
        { pubkey: ticket, isSigner: false, isWritable: true },
        { pubkey: VAULT, isSigner: false, isWritable: true },
        { pubkey: SHARES, isSigner: false, isWritable: true },
        { pubkey: ticketShares, isSigner: false, isWritable: true },
        { pubkey: VAULT_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
        ...remaining,
      ],
      data: Buffer.concat([disc("crank_redeem_basket"), u64(t.sharesIn)]),
    });
    await sendV0(
      [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
        ix,
      ],
      [gsmiLut],
      "crank_redeem_basket"
    );
  }

  for (let i = 0; i < 8; i++) {
    const seatAta = seatAtas[i];
    const exists = await conn.getAccountInfo(seatAta);
    if (!exists) {
      console.log(i, NAMES[i], "no ata");
      continue;
    }
    const bal = await conn.getTokenAccountBalance(seatAta);
    console.log(i, NAMES[i], bal.value.amount);
    if (bal.value.amount === "0") continue;

    const qUrl = `${JUP_API}/quote?inputMint=${MINTS[i].toBase58()}&outputMint=${WSOL.toBase58()}&amount=${bal.value.amount}&slippageBps=${SLIP_BPS}&swapMode=ExactIn`;
    const quote = await (await fetch(qUrl)).json();
    if (!quote.outAmount) throw new Error(`${NAMES[i]} quote ${JSON.stringify(quote).slice(0, 240)}`);
    console.log("  quote out", quote.outAmount);

    const swapRes = await fetch(`${JUP_API}/swap-instructions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: ticket.toBase58(),
        destinationTokenAccount: destWsol.toBase58(),
        wrapAndUnwrapSol: false,
        useSharedAccounts: true,
      }),
    });
    const swap = await swapRes.json();
    if (!swap.swapInstruction) throw new Error(`${NAMES[i]} swap-ix ${JSON.stringify(swap).slice(0, 300)}`);
    const jupIx = swap.swapInstruction as {
      accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
      data: string;
    };
    const luts: AddressLookupTableAccount[] = [gsmiLut];
    for (const k of swap.addressLookupTableAddresses || []) {
      const acc = (await conn.getAddressLookupTable(new PublicKey(k))).value;
      if (acc) luts.push(acc);
    }
    const ix = new TransactionInstruction({
      programId: WRAP,
      keys: [
        { pubkey: owner, isSigner: true, isWritable: true },
        { pubkey: CONFIG, isSigner: false, isWritable: false },
        { pubkey: ticket, isSigner: false, isWritable: true },
        { pubkey: seatAta, isSigner: false, isWritable: true },
        { pubkey: JUPITER, isSigner: false, isWritable: false },
        ...jupIx.accounts.map((a) => ({
          pubkey: new PublicKey(a.pubkey),
          isSigner: false,
          isWritable: a.isWritable,
        })),
      ],
      data: Buffer.concat([
        disc("crank_sell"),
        Buffer.from([i]),
        vecU8(Buffer.from(jupIx.data, "base64")),
      ]),
    });
    await sendV0(
      [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
        ix,
      ],
      luts,
      "crank_sell " + NAMES[i]
    );
  }

  const ix = new TransactionInstruction({
    programId: WRAP,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: CONFIG, isSigner: false, isWritable: false },
      { pubkey: ticket, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: true },
      { pubkey: DESK, isSigner: false, isWritable: true },
      { pubkey: destWsol, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ...seatAtas.map((a) => ({ pubkey: a, isSigner: false, isWritable: false })),
    ],
    data: disc("finish_redeem_sol"),
  });
  const before = await conn.getBalance(owner);
  await sendV0(
    [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
      ix,
    ],
    [],
    "finish_redeem_sol"
  );
  const after = await conn.getBalance(owner);
  const done = await conn.getAccountInfo(ticket);
  const st = done ? readTicket(done.data) : null;
  console.log("status", st ? STATUS[st.status] : "gone");
  console.log("owner sol", before, "->", after, "delta", after - before);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
