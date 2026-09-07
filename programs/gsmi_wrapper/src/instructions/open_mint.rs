use anchor_lang::prelude::*;
use anchor_lang::solana_program::{program::invoke, system_instruction};
use crate::constants::*;
use crate::error::WrapError;
use crate::state::{Config, Side, Status, Ticket};

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct OpenMint<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = owner,
        space = Ticket::SIZE,
        seeds = [TICKET_SEED, owner.key().as_ref(), nonce.to_le_bytes().as_ref()],
        bump
    )]
    pub ticket: Account<'info, Ticket>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<OpenMint>, nonce: u64, lamports: u64, min_shares: u64, cancel_slots: u32) -> Result<()> {
    require!(lamports > 0, WrapError::Zero);
    let clock = if cancel_slots == 0 {
        ctx.accounts.config.cancel_slots_default
    } else {
        cancel_slots
    };
    require!(clock >= CANCEL_SLOTS_MIN && clock <= CANCEL_SLOTS_MAX, WrapError::BadClock);

    let pull = lamports
        .checked_add(CRANK_TAKE)
        .ok_or(error!(WrapError::BadBudget))?;
    invoke(
        &system_instruction::transfer(
            &ctx.accounts.owner.key(),
            &ctx.accounts.ticket.key(),
            pull,
        ),
        &[
            ctx.accounts.owner.to_account_info(),
            ctx.accounts.ticket.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        ],
    )?;

    let t = &mut ctx.accounts.ticket;
    t.owner = ctx.accounts.owner.key();
    t.nonce = nonce;
    t.side = Side::MintSol;
    t.status = Status::Open;
    t.sol_in = lamports;
    t.shares_in = 0;
    t.min_out = min_shares;
    t.open_slot = Clock::get()?.slot;
    t.cancel_slots = clock;
    t.bump = ctx.bumps.ticket;
    Ok(())
}
