use anchor_lang::prelude::*;
use crate::constants::*;
use crate::error::WrapError;
use crate::state::{Side, Status, Ticket};
use crate::token_io::{read_ata, transfer_seat};

/// Localnet only. Empties ticket seat ATAs into the owner.
/// Stand-in for eight Jupiter sells. Feature `local-crank`.
/// remaining: 8 × (ticket_ata, owner_ata)
#[derive(Accounts)]
pub struct LocalClearSeats<'info> {
    pub cranker: Signer<'info>,
    #[account(
        seeds = [TICKET_SEED, ticket.owner.as_ref(), ticket.nonce.to_le_bytes().as_ref()],
        bump = ticket.bump,
        constraint = ticket.status == Status::BasketOut @ WrapError::Closed,
        constraint = ticket.side == Side::RedeemGsmi @ WrapError::BadSide,
        constraint = ticket.owner == cranker.key() @ WrapError::NotOwner,
    )]
    pub ticket: Account<'info, Ticket>,
    /// CHECK: Tokenkeg
    pub token_program: UncheckedAccount<'info>,
    /// CHECK: Token-2022
    pub token_2022_program: UncheckedAccount<'info>,
}

pub fn handler<'a>(ctx: Context<'a, LocalClearSeats<'a>>) -> Result<()> {
    let rest = ctx.remaining_accounts;
    require!(rest.len() == BASKET_SIZE * 2, WrapError::SeatMismatch);

    let ticket_key = ctx.accounts.ticket.key();
    let owner_key = ctx.accounts.ticket.owner;
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
    let authority = ctx.accounts.ticket.to_account_info();

    for i in 0..BASKET_SIZE {
        let from = rest[i * 2].clone();
        let to = rest[i * 2 + 1].clone();
        let (f_mint, f_owner, f_amt) = read_ata(&from)?;
        let (t_mint, t_owner, _) = read_ata(&to)?;
        require!(f_mint == t_mint, WrapError::BadOut);
        require!(f_owner == ticket_key, WrapError::BadOut);
        require!(t_owner == owner_key, WrapError::NotOwner);
        transfer_seat(
            tokenkeg.clone(),
            token22.clone(),
            from,
            to,
            authority.clone(),
            f_amt,
            signer,
        )?;
    }
    Ok(())
}
