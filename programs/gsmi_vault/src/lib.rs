use anchor_lang::prelude::*;

pub mod constants;
pub mod error;
pub mod events;
pub mod instructions;
pub mod math;
pub mod state;
pub mod token_io;

use instructions::*;

declare_id!("4saonDbBXhXJQ8TPvb7gMdrDNrkmpuRvjwCxqu1UDPxQ");

/// $GSMI — eight-seat vault. No admin. No Jupiter. No oracle.
/// Mint: eight tokens in, fee on the way in, shares out.
/// Burn: shares in, same percent of each book out.
#[program]
pub mod gsmi_vault {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, vault_id: u64) -> Result<()> {
        instructions::initialize::handler(ctx, vault_id)
    }

    /// `offered` is the max of each seat the user is willing to put in.
    /// `shares` is only used on the first fill (site prices that at $0.69).
    /// Later fills ignore `shares` except as min_shares via `min_shares_out`.
    pub fn mint_shares<'a>(
        ctx: Context<'a, MintShares<'a>>,
        offered: [u64; 8],
        shares: u64,
        min_shares_out: u64,
    ) -> Result<()> {
        instructions::mint_shares::handler(ctx, offered, shares, min_shares_out)
    }

    pub fn redeem(ctx: Context<Redeem>, shares: u64) -> Result<()> {
        instructions::redeem::handler(ctx, shares)
    }

    pub fn write_share_meta(ctx: Context<WriteShareMeta>) -> Result<()> {
        instructions::write_share_meta::handler(ctx)
    }
}
