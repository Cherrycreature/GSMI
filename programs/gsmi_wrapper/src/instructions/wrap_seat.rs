use anchor_lang::prelude::*;
use anchor_spl::token::Token;
use crate::constants::*;
use crate::error::WrapError;
use crate::state::{Side, Status, Ticket};
use crate::token_io::read_ata;

/// Anyone. Move this seat's native budget into its WSOL ATA.
/// Desk signs as cranker. Ticket owner does not need to sign.
/// No sync CPI — the desk sends `sync_native` as the next ix in the same tx.
#[derive(Accounts)]
#[instruction(seat: u8)]
pub struct WrapSeat<'info> {
    /// CHECK: permissionless. desk or owner.
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
    pub seat_acc: Account<'info, crate::state::Seat>,
    /// CHECK: seat-owned WSOL ATA. Mint/owner checked in handler.
    #[account(mut)]
    pub seat_wsol: UncheckedAccount<'info>,
    /// CHECK: native mint
    #[account(address = WSOL)]
    pub wsol_mint: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<WrapSeat>, seat: u8) -> Result<()> {
    require!((seat as usize) < BASKET_SIZE, WrapError::BadSeat);
    let (mint, owner, amount) = read_ata(&ctx.accounts.seat_wsol.to_account_info())?;
    require!(mint == WSOL, WrapError::BadOut);
    require!(owner == ctx.accounts.seat_acc.key(), WrapError::BadOut);
    if amount > 0 {
        return Ok(());
    }

    let seat_ai = ctx.accounts.seat_acc.to_account_info();
    let wsol_ai = ctx.accounts.seat_wsol.to_account_info();
    let rent = Rent::get()?.minimum_balance(seat_ai.data_len());
    let extra = seat_ai.lamports().saturating_sub(rent);
    require!(extra > 0, WrapError::BadOut);

    {
        let mut from = seat_ai.try_borrow_mut_lamports()?;
        let mut to = wsol_ai.try_borrow_mut_lamports()?;
        **from = from.saturating_sub(extra);
        **to = to.saturating_add(extra);
    }
    Ok(())
}
