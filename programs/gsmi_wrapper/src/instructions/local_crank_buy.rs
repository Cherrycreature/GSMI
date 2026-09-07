use anchor_lang::prelude::*;
use crate::constants::*;
use crate::error::WrapError;
use crate::state::{Seat, Side, Status, Ticket};
use crate::token_io::{read_ata, transfer_seat};

/// Localnet only. Same shape as crank_buy: tokens land on the ticket ATA,
/// seat SOL budget leaves the seat, seat marked done.
/// Pool is the cranker's ATA. Worker later swaps this for Jupiter.
/// remaining: tokenkeg, token-2022, pool_ata (cranker owned), dest_ata (ticket owned)
#[derive(Accounts)]
#[instruction(seat: u8)]
pub struct LocalCrankBuy<'info> {
    #[account(mut)]
    pub cranker: Signer<'info>,
    #[account(
        seeds = [TICKET_SEED, ticket.owner.as_ref(), ticket.nonce.to_le_bytes().as_ref()],
        bump = ticket.bump,
        constraint = ticket.status == Status::Split @ WrapError::NotSplit,
        constraint = ticket.side == Side::MintSol @ WrapError::BadSide
    )]
    pub ticket: Account<'info, Ticket>,
    #[account(
        mut,
        seeds = [SEAT_SEED, ticket.key().as_ref(), &[seat]],
        bump = seat_acc.bump,
        constraint = seat_acc.ticket == ticket.key() @ WrapError::SeatMismatch,
        constraint = seat_acc.index == seat @ WrapError::SeatMismatch,
        constraint = !seat_acc.done @ WrapError::SeatDone
    )]
    pub seat_acc: Account<'info, Seat>,
}

pub fn handler<'a>(ctx: Context<'a, LocalCrankBuy<'a>>, seat: u8, out: u64) -> Result<()> {
    require!((seat as usize) < BASKET_SIZE, WrapError::BadSeat);
    require!(out > 0, WrapError::Zero);
    require!(ctx.remaining_accounts.len() == 4, WrapError::SeatMismatch);

    let tokenkeg = ctx.remaining_accounts[0].clone();
    let token22 = ctx.remaining_accounts[1].clone();
    let pool = ctx.remaining_accounts[2].clone();
    let dest = ctx.remaining_accounts[3].clone();

    let ticket_key = ctx.accounts.ticket.key();
    let cranker_key = ctx.accounts.cranker.key();
    let (p_mint, p_owner, p_amt) = read_ata(&pool)?;
    let (d_mint, d_owner, before) = read_ata(&dest)?;
    require!(p_mint == d_mint, WrapError::BadOut);
    require!(p_owner == cranker_key, WrapError::NotOwner);
    require!(d_owner == ticket_key, WrapError::BadOut);
    require!(p_amt >= out, WrapError::NoFill);

    transfer_seat(
        tokenkeg,
        token22,
        pool,
        dest,
        ctx.accounts.cranker.to_account_info(),
        out,
        &[],
    )?;

    let rent = Rent::get()?.minimum_balance(Seat::SIZE);
    let seat_ai = ctx.accounts.seat_acc.to_account_info();
    let take = ctx.accounts.seat_acc.budget.min(seat_ai.lamports().saturating_sub(rent));
    require!(take > 0, WrapError::NoFill);
    **seat_ai.try_borrow_mut_lamports()? -= take;
    **ctx.accounts.cranker.to_account_info().try_borrow_mut_lamports()? += take;

    ctx.accounts.seat_acc.got = out;
    ctx.accounts.seat_acc.done = true;
    let _ = before;
    Ok(())
}
