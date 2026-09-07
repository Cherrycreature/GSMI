# $GSMI

GameStop Memecoin Index. One token. The whole army.

Public source for the two frozen mainnet programs.

Site: https://gsmi.io
X: https://x.com/gsmi_io
Telegram: https://t.me/gsmi_io

## Programs

| | Program ID | Upgrade authority |
|---|---|---|
| Vault | `4saonDbBXhXJQ8TPvb7gMdrDNrkmpuRvjwCxqu1UDPxQ` | none |
| Wrapper | `4FMpDudDHnQkXp3Y6FjCfd4BKELxHzYrjTSwrMs3T5F2` | none |

Vault 1: `FvXKb7JVCmMa9tuAexF3zyAvj1vvRUVngrRgBpUFaCpe`
Share mint: `W1yo6FyJgfGTtj75S8qTxuN9qjTE5XKijq6DkCVRHU4`
Treasury: `1f8NG4HixGS6wREigBXMbK7rZn3NU3WpDzKWDij79g6`

Both binaries are frozen. A later wrapper can exist as a new program id. The vault id does not change.

## What the vault does

Eight locked Solana seats. No oracle. No Jupiter. No admin after init.

- First fill is a photograph of dollars, not equal tokens. That fill locks token counts.
- Later mints follow the thin seat (min-slice). Weights drift. Nobody rebalances.
- Fee is 69 / 100_000 of each offered seat on mint only. Remainder after the slice goes to treasury. No fee on burn.
- Book is `assets[i].amount`, not raw ATA balance. Donations do not tilt the index.

Seats, program order:

1. GME `8wXtPeU6557ETkp9WHFY1n1EcU6NxDvbAggHGsMYiHsB`
2. BP `3B1ijcocM5EDga6XxQ7JLW7weocQPWWjuhBYG8Vepump`
3. TSUKI `463SK47VkB7uE7XenTHKiVcMtxRsfNE2X4Q9wByaURVA`
4. RWA `G8aVC4nk5oPWzTHp4PDm3kAuixCebv9WRQMD93h9pump`
5. RKC `7HgfXftRBBqsYtAEYcqjGLQrNJLL6Tww9ek4rE3Apump`
6. TT `5dSW7m4EN1DWXk6782P1UYSddDz3xTQEAtL6gtZmpump`
7. BUCK `FLqmVrv6cp7icjobpRMQJMEyjF3kF84QmC4HXpySpump`
8. AT `HBByvsRPFwcJbV516QVmtHxYwEZhrDX3f9Bgn5M9pump`

Token-2022 seats: BP, RKC, AT. The rest are Tokenkeg. `$GSMI` is Tokenkeg.

## What the wrapper does

SOL in, ticket PDA, Jupiter off the ticket, vault CPI, `$GSMI` out. Reverse on redeem.

Owner cancel after the cancel clock. Cancel returns leftover to the ticket owner. Recover doors exist for Done tickets. Crank take is 0.012 SOL to `5Cz2YfDQkhgsGZ31so8oWRRMfcJDzBi7hW3rKRTQSrZo` on finish. Not a product fee. Locked in the binary.

`local-crank` / `local-mints` are test features. They are off in the live binaries.

## Verify

Source is public. Solscan Verified is a separate job: Docker rebuild via `solana-verify`, hash against the live `.so`, then the remote verify PDA.

This tree is the builder source of the frozen programs. Do not assume the hash already matches. Do not call this audited.

    solana program show 4saonDbBXhXJQ8TPvb7gMdrDNrkmpuRvjwCxqu1UDPxQ
    solana program show 4FMpDudDHnQkXp3Y6FjCfd4BKELxHzYrjTSwrMs3T5F2

## Build

Anchor 1.1.2. Solana CLI 3.x.

    anchor build

Do not deploy these ids. Authority is none.

## Contact

admin@gsmi.io
