import * as anchor from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";

describe("init_config mainnet", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.GsmiWrapper as anchor.Program;
  const [config] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    program.programId
  );

  it("points the door at the live vault", async () => {
    console.log("wallet", provider.wallet.publicKey.toBase58());
    console.log("program", program.programId.toBase58());
    console.log("config", config.toBase58());
    if (program.programId.toBase58() !== "4FMpDudDHnQkXp3Y6FjCfd4BKELxHzYrjTSwrMs3T5F2") {
      throw new Error("wrong program id — rebuild stamped 4FMp");
    }
    const info = await provider.connection.getAccountInfo(config);
    if (info) {
      console.log("already live");
      return;
    }
    const sig = await program.methods
      .initConfig(
        150,
        new PublicKey("FvXKb7JVCmMa9tuAexF3zyAvj1vvRUVngrRgBpUFaCpe"),
        new PublicKey("W1yo6FyJgfGTtj75S8qTxuN9qjTE5XKijq6DkCVRHU4"),
        new PublicKey("4saonDbBXhXJQ8TPvb7gMdrDNrkmpuRvjwCxqu1UDPxQ"),
        new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4")
      )
      .accounts({
        payer: provider.wallet.publicKey,
        config,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log("init_config", sig);
  });
});
