use anchor_lang::prelude::*;
use anchor_lang::solana_program::{program::invoke, system_instruction};
use anchor_spl::token::{Token, TokenAccount, Transfer, transfer};
use crate::constants::*;
use crate::error::WrapError;
use crate::state::{Config, Side, Status, Ticket};

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct OpenRedeem<'info> {
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
    #[account(
        mut,
        token::mint = config.shares_mint,
        token::authority = owner
    )]
    pub owner_shares: Account<'info, TokenAccount>,
    #[account(
        mut,
        token::mint = config.shares_mint,
        token::authority = ticket
    )]
    pub ticket_shares: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<OpenRedeem>, nonce: u64, shares: u64, min_sol: u64, cancel_slots: u32) -> Result<()> {
    require!(shares > 0, WrapError::Zero);
    let clock = if cancel_slots == 0 {
        ctx.accounts.config.cancel_slots_default
    } else {
        cancel_slots
    };
    require!(clock >= CANCEL_SLOTS_MIN && clock <= CANCEL_SLOTS_MAX, WrapError::BadClock);

    invoke(
        &system_instruction::transfer(
            &ctx.accounts.owner.key(),
            &ctx.accounts.ticket.key(),
            CRANK_TAKE,
        ),
        &[
            ctx.accounts.owner.to_account_info(),
            ctx.accounts.ticket.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        ],
    )?;

    transfer(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.owner_shares.to_account_info(),
                to: ctx.accounts.ticket_shares.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            },
        ),
        shares,
    )?;

    let t = &mut ctx.accounts.ticket;
    t.owner = ctx.accounts.owner.key();
    t.nonce = nonce;
    t.side = Side::RedeemGsmi;
    t.status = Status::Open;
    t.sol_in = 0;
    t.shares_in = shares;
    t.min_out = min_sol;
    t.open_slot = Clock::get()?.slot;
    t.cancel_slots = clock;
    t.bump = ctx.bumps.ticket;
    Ok(())
}
