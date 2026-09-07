use anchor_lang::prelude::*;
use anchor_lang::solana_program::{program::invoke, system_instruction};
use crate::constants::*;
use crate::error::WrapError;
use crate::state::{Side, Status, Ticket};
use crate::token_io::{read_ata, transfer_seat};

/// Localnet only. Same shape as crank_sell: seat tokens leave the ticket ATA,
/// SOL lands on the ticket. Worker later swaps this for Jupiter.
/// remaining: tokenkeg, token-2022, ticket_ata, pool_ata (cranker owned)
#[derive(Accounts)]
pub struct LocalCrankSell<'info> {
    #[account(mut)]
    pub cranker: Signer<'info>,
    #[account(
        mut,
        seeds = [TICKET_SEED, ticket.owner.as_ref(), ticket.nonce.to_le_bytes().as_ref()],
        bump = ticket.bump,
        constraint = ticket.status == Status::BasketOut @ WrapError::Closed,
        constraint = ticket.side == Side::RedeemGsmi @ WrapError::BadSide
    )]
    pub ticket: Account<'info, Ticket>,
    pub system_program: Program<'info, System>,
}

pub fn handler<'a>(ctx: Context<'a, LocalCrankSell<'a>>, seat: u8, sol_out: u64) -> Result<()> {
    require!((seat as usize) < BASKET_SIZE, WrapError::BadSeat);
    require!(sol_out > 0, WrapError::Zero);
    require!(ctx.remaining_accounts.len() == 4, WrapError::SeatMismatch);

    let tokenkeg = ctx.remaining_accounts[0].clone();
    let token22 = ctx.remaining_accounts[1].clone();
    let from = ctx.remaining_accounts[2].clone();
    let pool = ctx.remaining_accounts[3].clone();

    let ticket_key = ctx.accounts.ticket.key();
    let cranker_key = ctx.accounts.cranker.key();
    let (f_mint, f_owner, f_amt) = read_ata(&from)?;
    let (p_mint, p_owner, _) = read_ata(&pool)?;
    require!(f_mint == p_mint, WrapError::BadOut);
    require!(f_owner == ticket_key, WrapError::BadOut);
    require!(p_owner == cranker_key, WrapError::NotOwner);
    require!(f_amt > 0, WrapError::SeatEmpty);

    let nonce = ctx.accounts.ticket.nonce.to_le_bytes();
    let seeds: &[&[u8]] = &[
        TICKET_SEED,
        ctx.accounts.ticket.owner.as_ref(),
        nonce.as_ref(),
        &[ctx.accounts.ticket.bump],
    ];
    transfer_seat(
        tokenkeg,
        token22,
        from,
        pool,
        ctx.accounts.ticket.to_account_info(),
        f_amt,
        &[seeds],
    )?;

    invoke(
        &system_instruction::transfer(
            ctx.accounts.cranker.key,
            ctx.accounts.ticket.to_account_info().key,
            sol_out,
        ),
        &[
            ctx.accounts.cranker.to_account_info(),
            ctx.accounts.ticket.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        ],
    )?;
    Ok(())
}
