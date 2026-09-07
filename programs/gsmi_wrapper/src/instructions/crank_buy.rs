use anchor_lang::prelude::*;
use anchor_lang::solana_program::{instruction::{AccountMeta, Instruction}, program::invoke_signed};
use anchor_spl::token::{Token, TokenAccount};
use crate::constants::*;
use crate::error::WrapError;
use crate::state::{Config, Seat, Side, Status, Ticket};
use crate::token_io::read_ata;

/// Anyone. One seat. Does not write the parent ticket.
/// remaining_accounts[0] = Jupiter. [1..] = swap.
/// Swap source authority = this seat PDA (WSOL wrapped from the seat budget).
#[derive(Accounts)]
#[instruction(seat: u8)]
pub struct CrankBuy<'info> {
    #[account(mut)]
    pub cranker: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
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
    )]
    pub seat_acc: Account<'info, Seat>,
    /// CHECK: ticket ATA. Tokenkeg or Token-2022. Mint/owner checked in handler.
    #[account(mut)]
    pub seat_ata: UncheckedAccount<'info>,
    /// Seat-owned WSOL ATA. Native budget is wrapped here before the CPI.
    #[account(
        mut,
        token::mint = wsol_mint,
        token::authority = seat_acc
    )]
    pub seat_wsol: Account<'info, TokenAccount>,
    /// CHECK: native mint
    #[account(address = WSOL)]
    pub wsol_mint: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

pub fn handler<'a>(ctx: Context<'a, CrankBuy<'a>>, seat: u8, data: Vec<u8>) -> Result<()> {
    require!((seat as usize) < BASKET_SIZE, WrapError::BadSeat);
    let (ata_mint, ata_owner, before) = read_ata(&ctx.accounts.seat_ata.to_account_info())?;
    require!(ata_owner == ctx.accounts.ticket.key(), WrapError::BadOut);
    require!(ata_mint == seat_mint(seat)?, WrapError::BadSeat);
    require!(!ctx.remaining_accounts.is_empty(), WrapError::BadJup);
    require!(ctx.remaining_accounts[0].key() == ctx.accounts.config.jupiter, WrapError::BadJup);

    require!(ctx.accounts.seat_wsol.amount > 0, WrapError::BadOut);

    let metas: Vec<AccountMeta> = ctx.remaining_accounts[1..].iter().map(|a| {
        if a.is_writable {
            if a.is_signer { AccountMeta::new(a.key(), true) } else { AccountMeta::new(a.key(), false) }
        } else if a.is_signer {
            AccountMeta::new_readonly(a.key(), true)
        } else {
            AccountMeta::new_readonly(a.key(), false)
        }
    }).collect();

    let ix = Instruction {
        program_id: ctx.accounts.config.jupiter,
        accounts: metas,
        data,
    };

    let ticket_key = ctx.accounts.ticket.key();
    let idx = [seat];
    let seeds: &[&[u8]] = &[
        SEAT_SEED,
        ticket_key.as_ref(),
        idx.as_ref(),
        &[ctx.accounts.seat_acc.bump],
    ];
    let infos: Vec<AccountInfo> = ctx.remaining_accounts[1..].iter().map(|a| a.clone()).collect();
    invoke_signed(&ix, &infos, &[seeds])?;

    let (_, _, got) = read_ata(&ctx.accounts.seat_ata.to_account_info())?;
    require!(got > before, WrapError::NoFill);
    // Cumulative. A second ExactIn on leftover WSOL pad is allowed.
    ctx.accounts.seat_acc.got = ctx.accounts.seat_acc.got.saturating_add(got.saturating_sub(before));
    ctx.accounts.seat_acc.done = true;
    Ok(())
}
