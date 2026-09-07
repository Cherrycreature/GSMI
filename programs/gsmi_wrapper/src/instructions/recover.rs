use anchor_lang::prelude::*;
use anchor_spl::token::Token;
use crate::constants::*;
use crate::error::WrapError;
use crate::state::{Status, Ticket};
use crate::token_io::{close_ata, read_ata, transfer_seat};

/// Owner only. Ticket must be Done.
/// Pulls leftover seat WSOL (ExactOut pad) back to the owner and closes the ATA.
/// Seat account itself may already be gone — PDA still signs.
#[derive(Accounts)]
pub struct RecoverSeatWsol<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        seeds = [TICKET_SEED, ticket.owner.as_ref(), ticket.nonce.to_le_bytes().as_ref()],
        bump = ticket.bump,
        constraint = ticket.owner == owner.key() @ WrapError::NotOwner,
        constraint = ticket.status == Status::Done @ WrapError::Closed,
    )]
    pub ticket: Account<'info, Ticket>,
    /// CHECK: seat PDA. May be closed (0 lamports).
    pub seat: UncheckedAccount<'info>,
    /// CHECK: seat-owned WSOL ATA.
    #[account(mut)]
    pub seat_wsol: UncheckedAccount<'info>,
    /// CHECK: owner WSOL ATA.
    #[account(mut)]
    pub owner_wsol: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

pub fn recover_seat_wsol(ctx: Context<RecoverSeatWsol>, seat: u8) -> Result<()> {
    require!(seat < BASKET_SIZE as u8, WrapError::BadSeat);
    let ticket_key = ctx.accounts.ticket.key();
    let idx = [seat];
    let (pda, bump) = Pubkey::find_program_address(
        &[SEAT_SEED, ticket_key.as_ref(), idx.as_ref()],
        ctx.program_id,
    );
    require!(ctx.accounts.seat.key() == pda, WrapError::SeatMismatch);

    let (w_mint, w_owner, w_amt) = read_ata(&ctx.accounts.seat_wsol.to_account_info())?;
    require!(w_mint == WSOL, WrapError::BadOut);
    require!(w_owner == pda, WrapError::BadOut);

    let (o_mint, o_owner, _) = read_ata(&ctx.accounts.owner_wsol.to_account_info())?;
    require!(o_mint == WSOL, WrapError::BadOut);
    require!(o_owner == ctx.accounts.owner.key(), WrapError::NotOwner);

    let seeds: &[&[u8]] = &[SEAT_SEED, ticket_key.as_ref(), idx.as_ref(), &[bump]];
    let signer = &[seeds];
    let tokenkeg = ctx.accounts.token_program.to_account_info();
    // WSOL is Tokenkeg. token22 slot reused as dummy.
    transfer_seat(
        tokenkeg.clone(),
        tokenkeg.clone(),
        ctx.accounts.seat_wsol.to_account_info(),
        ctx.accounts.owner_wsol.to_account_info(),
        ctx.accounts.seat.to_account_info(),
        w_amt,
        signer,
    )?;
    close_ata(
        tokenkeg.clone(),
        tokenkeg,
        ctx.accounts.seat_wsol.to_account_info(),
        ctx.accounts.owner.to_account_info(),
        ctx.accounts.seat.to_account_info(),
        signer,
    )?;
    Ok(())
}

/// Owner only. Ticket Done. Close a ticket-owned dest ATA (empty leftover) and
/// send rent home. If it still holds tokens, send those to owner_ata first.
#[derive(Accounts)]
pub struct RecoverTicketAta<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        seeds = [TICKET_SEED, ticket.owner.as_ref(), ticket.nonce.to_le_bytes().as_ref()],
        bump = ticket.bump,
        constraint = ticket.owner == owner.key() @ WrapError::NotOwner,
        constraint = ticket.status == Status::Done @ WrapError::Closed,
    )]
    pub ticket: Account<'info, Ticket>,
    /// CHECK: ticket-owned ATA.
    #[account(mut)]
    pub from_ata: UncheckedAccount<'info>,
    /// CHECK: owner ATA, same mint.
    #[account(mut)]
    pub owner_ata: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    /// CHECK: Token-2022
    pub token_2022_program: UncheckedAccount<'info>,
}

pub fn recover_ticket_ata(ctx: Context<RecoverTicketAta>) -> Result<()> {
    let (f_mint, f_owner, f_amt) = read_ata(&ctx.accounts.from_ata.to_account_info())?;
    require!(f_owner == ctx.accounts.ticket.key(), WrapError::BadOut);
    let (t_mint, t_owner, _) = read_ata(&ctx.accounts.owner_ata.to_account_info())?;
    require!(f_mint == t_mint, WrapError::BadOut);
    require!(t_owner == ctx.accounts.owner.key(), WrapError::NotOwner);

    let nonce = ctx.accounts.ticket.nonce.to_le_bytes();
    let seeds: &[&[u8]] = &[
        TICKET_SEED,
        ctx.accounts.ticket.owner.as_ref(),
        nonce.as_ref(),
        &[ctx.accounts.ticket.bump],
    ];
    let signer = &[seeds];
    let tokenkeg = ctx.accounts.token_program.to_account_info();
    let token22 = ctx.accounts.token_2022_program.to_account_info();
    transfer_seat(
        tokenkeg.clone(),
        token22.clone(),
        ctx.accounts.from_ata.to_account_info(),
        ctx.accounts.owner_ata.to_account_info(),
        ctx.accounts.ticket.to_account_info(),
        f_amt,
        signer,
    )?;
    close_ata(
        tokenkeg,
        token22,
        ctx.accounts.from_ata.to_account_info(),
        ctx.accounts.owner.to_account_info(),
        ctx.accounts.ticket.to_account_info(),
        signer,
    )?;
    Ok(())
}
