use anchor_lang::prelude::*;
use anchor_lang::solana_program::{instruction::{AccountMeta, Instruction}, program::invoke_signed};
use anchor_spl::token::TokenAccount;
use crate::constants::*;
use crate::error::WrapError;
use crate::state::{Config, Side, Status, Ticket};

#[derive(Accounts)]
pub struct CrankSell<'info> {
    #[account(mut)]
    pub cranker: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [TICKET_SEED, ticket.owner.as_ref(), ticket.nonce.to_le_bytes().as_ref()],
        bump = ticket.bump,
        constraint = ticket.status == Status::BasketOut @ WrapError::Closed,
        constraint = ticket.side == Side::RedeemGsmi @ WrapError::BadSide
    )]
    pub ticket: Account<'info, Ticket>,
    #[account(
        mut,
        constraint = seat_ata.owner == ticket.key() @ WrapError::BadOut
    )]
    pub seat_ata: Account<'info, TokenAccount>,
}

pub fn handler<'a>(ctx: Context<'a, CrankSell<'a>>, seat: u8, data: Vec<u8>) -> Result<()> {
    require!((seat as usize) < BASKET_SIZE, WrapError::BadSeat);
    // seat scoreboard lives on Seat PDAs for mint; redeem parallel later
    require!(ctx.accounts.seat_ata.mint == seat_mint(seat)?, WrapError::BadSeat);
    require!(!ctx.remaining_accounts.is_empty(), WrapError::BadJup);
    require!(ctx.remaining_accounts[0].key() == ctx.accounts.config.jupiter, WrapError::BadJup);

    let before = ctx.accounts.seat_ata.amount;
    require!(before > 0, WrapError::SeatEmpty);

    let metas: Vec<AccountMeta> = ctx.remaining_accounts[1..].iter().map(|a| {
        if a.is_writable {
            AccountMeta::new(a.key(), a.is_signer)
        } else {
            AccountMeta::new_readonly(a.key(), a.is_signer)
        }
    }).collect();

    let ix = Instruction {
        program_id: ctx.accounts.config.jupiter,
        accounts: metas,
        data,
    };
    let nonce = ctx.accounts.ticket.nonce.to_le_bytes();
    let seeds: &[&[u8]] = &[
        TICKET_SEED,
        ctx.accounts.ticket.owner.as_ref(),
        nonce.as_ref(),
        &[ctx.accounts.ticket.bump],
    ];
    let infos: Vec<AccountInfo> = ctx.remaining_accounts[1..].iter().map(|a| a.clone()).collect();
    invoke_signed(&ix, &infos, &[seeds])?;

    ctx.accounts.seat_ata.reload()?;
    require!(ctx.accounts.seat_ata.amount < before, WrapError::NoFill);
    // redeem seat mark deferred
    Ok(())
}
