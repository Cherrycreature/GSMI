use anchor_lang::prelude::*;
use crate::constants::*;
use crate::error::WrapError;
use crate::state::{Seat, Side, Status, Ticket};

/// Localnet only. Marks one seat done with no Jupiter.
/// Feature `local-crank`. Production binary must not include this.
#[derive(Accounts)]
#[instruction(seat: u8)]
pub struct MarkSeat<'info> {
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

pub fn handler(ctx: Context<MarkSeat>, seat: u8) -> Result<()> {
    require!((seat as usize) < BASKET_SIZE, WrapError::BadSeat);
    ctx.accounts.seat_acc.got = 1;
    ctx.accounts.seat_acc.done = true;
    Ok(())
}
