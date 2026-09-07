use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
};
use crate::constants::*;
use crate::error::WrapError;
use crate::state::{Config, Side, Status, Ticket};
use crate::token_io::{read_ata, tokenkeg};

#[derive(Accounts)]
pub struct FinishRedeemSol<'info> {
    #[account(mut)]
    pub cranker: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [TICKET_SEED, ticket.owner.as_ref(), ticket.nonce.to_le_bytes().as_ref()],
        bump = ticket.bump,
        constraint = ticket.status == Status::BasketOut @ WrapError::Closed,
        constraint = ticket.side == Side::RedeemGsmi @ WrapError::BadSide,
    )]
    pub ticket: Account<'info, Ticket>,
    /// CHECK: ticket owner
    #[account(mut, address = ticket.owner)]
    pub owner: UncheckedAccount<'info>,
    /// CHECK: desk network reserve.
    #[account(mut, address = DESK)]
    pub desk: UncheckedAccount<'info>,
    /// CHECK: ticket WSOL ATA. Closed into the ticket, then leftover SOL paid to owner.
    #[account(mut)]
    pub dest_wsol: UncheckedAccount<'info>,
    /// CHECK: Tokenkeg
    #[account(address = tokenkeg())]
    pub token_program: UncheckedAccount<'info>,
}

/// remaining_accounts = eight ticket seat ATAs. Must be empty (already sold).
pub fn handler(ctx: Context<FinishRedeemSol>) -> Result<()> {
    require!(
        ctx.remaining_accounts.len() >= BASKET_SIZE,
        WrapError::BadOut
    );
    let ticket_key = ctx.accounts.ticket.key();
    let expected = crate::constants::basket();
    for i in 0..BASKET_SIZE {
        let ata = &ctx.remaining_accounts[i];
        let (mint, owner, amount) = read_ata(ata)?;
        require!(owner == ticket_key, WrapError::BadOut);
        require!(mint == expected[i], WrapError::BadOut);
        require!(amount == 0, WrapError::SeatEmpty);
    }

    let (w_mint, w_owner, _) = read_ata(&ctx.accounts.dest_wsol.to_account_info())?;
    require!(w_mint == WSOL, WrapError::BadOut);
    require!(w_owner == ticket_key, WrapError::BadOut);

    let bump = ctx.accounts.ticket.bump;
    let nonce = ctx.accounts.ticket.nonce.to_le_bytes();
    let seeds: &[&[u8]] = &[
        TICKET_SEED,
        ctx.accounts.ticket.owner.as_ref(),
        nonce.as_ref(),
        &[bump],
    ];
    let close = Instruction {
        program_id: tokenkeg(),
        accounts: vec![
            AccountMeta::new(ctx.accounts.dest_wsol.key(), false),
            AccountMeta::new(ticket_key, false),
            AccountMeta::new_readonly(ticket_key, true),
        ],
        data: vec![9u8],
    };
    invoke_signed(
        &close,
        &[
            ctx.accounts.dest_wsol.to_account_info(),
            ctx.accounts.ticket.to_account_info(),
            ctx.accounts.ticket.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
        ],
        &[seeds],
    )?;

    pay_crank(
        &ctx.accounts.ticket.to_account_info(),
        &ctx.accounts.desk.to_account_info(),
    )?;
    let leftover = ctx.accounts.ticket.to_account_info().lamports();
    let rent = Rent::get()?.minimum_balance(Ticket::SIZE);
    let send = leftover.saturating_sub(rent);
    require!(send >= ctx.accounts.ticket.min_out, WrapError::Slip);
    if send > 0 {
        **ctx.accounts.ticket.to_account_info().try_borrow_mut_lamports()? -= send;
        **ctx.accounts.owner.to_account_info().try_borrow_mut_lamports()? += send;
    }
    ctx.accounts.ticket.status = Status::Done;
    Ok(())
}
