/**
 * Vault book vs treasury dust.
 *
 *   cd ~/gsmi-wrapper
 *   npx --yes tsx scripts/snap.ts
 */
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { NAMES, openDoor, ownerShares, tokenAmt, tok, treasuryAta } from "./door";
import { DEC, liveShape } from "./shape";

function ui(n: bigint, d: number) {
  return Number(n) / 10 ** d;
}

async function main() {
  const door = await openDoor();
  const shape = await liveShape(door.conn, 50_000_000n);
  const oShares = await tokenAmt(door, ownerShares(door.owner), TOKEN_PROGRAM_ID);
  const sol = await door.conn.getBalance(door.owner, "confirmed");
  const nav = shape.tvlUsd / (Number(shape.totalShares) / 1e9);
  console.log("wallet", door.owner.toBase58());
  console.log("sol", sol / 1e9);
  console.log("owner GSMI", ui(oShares, 9).toFixed(9));
  console.log("book shares", Number(shape.totalShares) / 1e9, "nav", nav.toFixed(4), "tvl", shape.tvlUsd.toFixed(2));
  console.log("seat   vault-ui      vault-$   wgt     treas-ui     treas-$");
  let treasUsd = 0;
  for (let i = 0; i < 8; i++) {
    const t = await tokenAmt(door, treasuryAta(i), tok(i));
    const tUi = ui(t, DEC[i]);
    const px = shape.pxUsd[i];
    const tUsd = px ? tUi * px : 0;
    treasUsd += tUsd;
    console.log(
      `${NAMES[i].padEnd(6)} ${shape.bookUi[i].toFixed(4).padStart(12)} ${shape.usd[i]
        .toFixed(2)
        .padStart(9)} ${(shape.weights[i] * 100).toFixed(1).padStart(5)}% ${tUi
        .toFixed(4)
        .padStart(12)} ${tUsd.toFixed(4).padStart(10)}`
    );
  }
  console.log("treasury usd", treasUsd.toFixed(4), "vs tvl", ((treasUsd / shape.tvlUsd) * 100).toFixed(2) + "%");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
