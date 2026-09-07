import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import BN from "bn.js";

const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

describe("wrapper door on localnet", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.GsmiWrapper as Program;
  const owner = provider.wallet.publicKey;

  const [config] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    program.programId
  );

  const nonce = new BN(4);
  const nonceBuf = Buffer.alloc(8);
  nonceBuf.writeBigUInt64LE(BigInt(4));
  const [ticket] = PublicKey.findProgramAddressSync(
    [Buffer.from("ticket"), owner.toBuffer(), nonceBuf],
    program.programId
  );

  const seats = [...Array(8)].map((_, i) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("seat"), ticket.toBuffer(), Buffer.from([i])],
      program.programId
    )[0]
  );

  it("init_config", async () => {
    const info = await provider.connection.getAccountInfo(config);
    if (info) {
      console.log("config already live", config.toBase58());
      return;
    }
    const sig = await program.methods
      .initConfig(
        32,
        new PublicKey("FvXKb7JVCmMa9tuAexF3zyAvj1vvRUVngrRgBpUFaCpe"),
        new PublicKey("W1yo6FyJgfGTtj75S8qTxuN9qjTE5XKijq6DkCVRHU4"),
        new PublicKey("4saonDbBXhXJQ8TPvb7gMdrDNrkmpuRvjwCxqu1UDPxQ"),
        new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4")
      )
      .accounts({
        payer: owner,
        config,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log("init_config", sig);
  });

  it("open_mint 0.05 SOL", async () => {
    const existing = await provider.connection.getAccountInfo(ticket);
    if (existing) {
      console.log("ticket already open", ticket.toBase58());
      return;
    }
    const lamports = new BN(50_000_000);
    const sig = await program.methods
      .openMint(nonce, lamports, new BN(0), 32)
      .accounts({
        owner,
        config,
        ticket,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    const t = await program.account.ticket.fetch(ticket);
    console.log("open_mint", sig);
    console.log("ticket", ticket.toBase58());
    console.log("sol_in", t.solIn.toString(), "status", t.status);
  });

  it("split_mint eight seats", async () => {
    const already = await provider.connection.getAccountInfo(seats[0]);
    if (already) {
      console.log("already split");
      return;
    }
    const slice = 5_000_000;
    const budgets = [...Array(8)].map(() => new BN(slice));
    const sig = await program.methods
      .splitMint(budgets)
      .accounts({
        cranker: owner,
        ticket,
        seat0: seats[0],
        seat1: seats[1],
        seat2: seats[2],
        seat3: seats[3],
        seat4: seats[4],
        seat5: seats[5],
        seat6: seats[6],
        seat7: seats[7],
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    const t = await program.account.ticket.fetch(ticket);
    const s0 = await program.account.seat.fetch(seats[0]);
    console.log("split_mint", sig);
    console.log("status", t.status);
    console.log("seat0 budget", s0.budget.toString(), "done", s0.done);
  });


  it("mark_seat eight parallel", async () => {
    if (typeof (program.methods as { markSeat?: unknown }).markSeat !== "function") {
      console.log("mark_seat gated (release IDL) — skip");
      return;
    }
    const sigs = await Promise.all(
      seats.map((s, i) =>
        program.methods
          .markSeat(i)
          .accounts({
            cranker: owner,
            ticket,
            seatAcc: s,
          })
          .rpc()
      )
    );
    const done = [];
    for (let i = 0; i < 8; i++) {
      const seat = await program.account.seat.fetch(seats[i]);
      done.push(seat.done);
      console.log("seat", i, "done", seat.done, "got", seat.got.toString());
    }
    if (done.some((d) => !d)) throw new Error("seat not marked");
    console.log("mark_seat", sigs[0], "...", sigs[7]);
  });

  it("cancel after 32 slots", async () => {
    const t0 = await program.account.ticket.fetch(ticket);
    const ready = t0.openSlot.add(new BN(t0.cancelSlots));
    for (;;) {
      const slot = new BN(await provider.connection.getSlot());
      if (slot.gte(ready)) break;
      await new Promise((r) => setTimeout(r, 400));
    }
    const sig = await program.methods
      .cancel()
      .accounts({
        owner,
        ticket,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022,
      })
      .remainingAccounts(
        seats.map((s) => ({ pubkey: s, isWritable: true, isSigner: false }))
      )
      .rpc();
    const gone = await provider.connection.getAccountInfo(ticket);
    const seatGone = await provider.connection.getAccountInfo(seats[0]);
    console.log("cancel", sig);
    console.log("ticket closed", gone === null);
    console.log("seat0 closed", seatGone === null);
  });
});
