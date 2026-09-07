use anchor_lang::prelude::*;
use crate::constants::*;
use crate::error::WrapError;
use crate::state::{Seat, Side, Status, Ticket};

/// Anyone. Cuts ticket SOL into eight seat PDAs so later buys do not share a write.
#[derive(Accounts)]
pub struct SplitMint<'info> {
    #[account(mut)]
    pub cranker: Signer<'info>,
    #[account(
        mut,
        seeds = [TICKET_SEED, ticket.owner.as_ref(), ticket.nonce.to_le_bytes().as_ref()],
        bump = ticket.bump,
        constraint = ticket.status == Status::Open @ WrapError::Closed,
        constraint = ticket.side == Side::MintSol @ WrapError::BadSide
    )]
    pub ticket: Account<'info, Ticket>,
    #[account(init, payer = cranker, space = Seat::SIZE, seeds = [SEAT_SEED, ticket.key().as_ref(), &[0]], bump)]
    pub seat0: Account<'info, Seat>,
    #[account(init, payer = cranker, space = Seat::SIZE, seeds = [SEAT_SEED, ticket.key().as_ref(), &[1]], bump)]
    pub seat1: Account<'info, Seat>,
    #[account(init, payer = cranker, space = Seat::SIZE, seeds = [SEAT_SEED, ticket.key().as_ref(), &[2]], bump)]
    pub seat2: Account<'info, Seat>,
    #[account(init, payer = cranker, space = Seat::SIZE, seeds = [SEAT_SEED, ticket.key().as_ref(), &[3]], bump)]
    pub seat3: Account<'info, Seat>,
    #[account(init, payer = cranker, space = Seat::SIZE, seeds = [SEAT_SEED, ticket.key().as_ref(), &[4]], bump)]
    pub seat4: Account<'info, Seat>,
    #[account(init, payer = cranker, space = Seat::SIZE, seeds = [SEAT_SEED, ticket.key().as_ref(), &[5]], bump)]
    pub seat5: Account<'info, Seat>,
    #[account(init, payer = cranker, space = Seat::SIZE, seeds = [SEAT_SEED, ticket.key().as_ref(), &[6]], bump)]
    pub seat6: Account<'info, Seat>,
    #[account(init, payer = cranker, space = Seat::SIZE, seeds = [SEAT_SEED, ticket.key().as_ref(), &[7]], bump)]
    pub seat7: Account<'info, Seat>,
    pub system_program: Program<'info, System>,
}

fn fill(seat: &mut Seat, ticket: Pubkey, index: u8, budget: u64, bump: u8) -> Result<()> {
    require!(budget > 0, WrapError::Zero);
    seat.ticket = ticket;
    seat.index = index;
    seat.budget = budget;
    seat.got = 0;
    seat.done = false;
    seat.bump = bump;
    Ok(())
}

pub fn handler(ctx: Context<SplitMint>, budgets: [u64; 8]) -> Result<()> {
    let sum = budgets
        .iter()
        .try_fold(0u64, |a, b| a.checked_add(*b))
        .ok_or(error!(WrapError::BadBudget))?;
    require!(sum > 0, WrapError::Zero);

    let rent = Rent::get()?.minimum_balance(Ticket::SIZE);
    let ticket_ai = ctx.accounts.ticket.to_account_info();
    let available = ticket_ai
        .lamports()
        .saturating_sub(rent)
        .saturating_sub(CRANK_TAKE);
    require!(sum <= available, WrapError::BadBudget);

    let ticket_key = ctx.accounts.ticket.key();
    fill(&mut ctx.accounts.seat0, ticket_key, 0, budgets[0], ctx.bumps.seat0)?;
    fill(&mut ctx.accounts.seat1, ticket_key, 1, budgets[1], ctx.bumps.seat1)?;
    fill(&mut ctx.accounts.seat2, ticket_key, 2, budgets[2], ctx.bumps.seat2)?;
    fill(&mut ctx.accounts.seat3, ticket_key, 3, budgets[3], ctx.bumps.seat3)?;
    fill(&mut ctx.accounts.seat4, ticket_key, 4, budgets[4], ctx.bumps.seat4)?;
    fill(&mut ctx.accounts.seat5, ticket_key, 5, budgets[5], ctx.bumps.seat5)?;
    fill(&mut ctx.accounts.seat6, ticket_key, 6, budgets[6], ctx.bumps.seat6)?;
    fill(&mut ctx.accounts.seat7, ticket_key, 7, budgets[7], ctx.bumps.seat7)?;

    let seats = [
        ctx.accounts.seat0.to_account_info(),
        ctx.accounts.seat1.to_account_info(),
        ctx.accounts.seat2.to_account_info(),
        ctx.accounts.seat3.to_account_info(),
        ctx.accounts.seat4.to_account_info(),
        ctx.accounts.seat5.to_account_info(),
        ctx.accounts.seat6.to_account_info(),
        ctx.accounts.seat7.to_account_info(),
    ];
    for i in 0..BASKET_SIZE {
        **ticket_ai.try_borrow_mut_lamports()? -= budgets[i];
        **seats[i].try_borrow_mut_lamports()? += budgets[i];
    }

    ctx.accounts.ticket.status = Status::Split;
    Ok(())
}
