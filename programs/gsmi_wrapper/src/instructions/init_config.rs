use anchor_lang::prelude::*;
use crate::constants::*;
use crate::error::WrapError;
use crate::state::Config;

#[derive(Accounts)]
pub struct InitConfig<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = 8 + 32 * 4 + 4 + 1 + 16,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, Config>,
    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<InitConfig>,
    cancel_slots_default: u32,
    vault: Pubkey,
    shares_mint: Pubkey,
    vault_program: Pubkey,
    jupiter: Pubkey,
) -> Result<()> {
    require!(
        cancel_slots_default >= CANCEL_SLOTS_MIN && cancel_slots_default <= CANCEL_SLOTS_MAX,
        WrapError::BadClock
    );
    let c = &mut ctx.accounts.config;
    c.vault = vault;
    c.shares_mint = shares_mint;
    c.vault_program = vault_program;
    c.jupiter = jupiter;
    c.cancel_slots_default = cancel_slots_default;
    c.bump = ctx.bumps.config;
    Ok(())
}
