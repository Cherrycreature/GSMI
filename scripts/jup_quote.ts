/**
 * Off-chain Jupiter quote. Does not send.
 * Worker later stuffs the swap ix into crank_buy / crank_sell remaining + data.
 *
 * Seat source authority on buy  = seat PDA ["seat", ticket, [i]]
 * Ticket source authority on sell = ticket PDA
 *
 *   ANCHOR_PROVIDER_URL=https://api.mainnet-beta.solana.com \
 *   npx --yes tsx scripts/jup_quote.ts buy 0 5000000
 */
const JUP = "https://quote-api.jup.ag/v6";
const WSOL = "So11111111111111111111111111111111111111112";
const BASKET = [
  "8wXtPeU6557ETkp9WHFY1n1EcU6NxDvbAggHGsMYiHsB",
  "3B1ijcocM5EDga6XxQ7JLW7weocQPWWjuhBYG8Vepump",
  "463SK47VkB7uE7XenTHKiVcMtxRsfNE2X4Q9wByaURVA",
  "G8aVC4nk5oPWzTHp4PDm3kAuixCebv9WRQMD93h9pump",
  "7HgfXftRBBqsYtAEYcqjGLQrNJLL6Tww9ek4rE3Apump",
  "5dSW7m4EN1DWXk6782P1UYSddDz3xTQEAtL6gtZmpump",
  "FLqmVrv6cp7icjobpRMQJMEyjF3kF84QmC4HXpySpump",
  "HBByvsRPFwcJbV516QVmtHxYwEZhrDX3f9Bgn5M9pump",
];

async function main() {
  const side = process.argv[2] || "buy";
  const seat = Number(process.argv[3] || "0");
  const amount = process.argv[4] || "1000000";
  if (seat < 0 || seat > 7) throw new Error("seat 0-7");
  const mint = BASKET[seat];
  const input = side === "sell" ? mint : WSOL;
  const output = side === "sell" ? WSOL : mint;
  const qurl = `${JUP}/quote?inputMint=${input}&outputMint=${output}&amount=${amount}&slippageBps=150`;
  const quote = await fetch(qurl).then((r) => r.json());
  if (quote.error) {
    console.log(JSON.stringify(quote, null, 2));
    return;
  }
  console.log("in", quote.inAmount, "out", quote.outAmount, "impact", quote.priceImpactPct);
  console.log("route", (quote.routePlan || []).map((s: any) => s.swapInfo?.label).join(" -> "));
  console.log("next: POST /swap with userPublicKey = seat PDA (buy) or ticket PDA (sell)");
  console.log("then crank_buy(seat, swapIx.data) remaining = [Jupiter, ...swapIx.accounts]");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
