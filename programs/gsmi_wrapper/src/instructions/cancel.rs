use anchor_lang::prelude::*;
use anchor_spl::token::Token;
use anchor_spl::token_2022::Token2022;
use crate::constants::*;
use crate::error::WrapError;
use crate::state::{Status, Ticket};
use crate::token_io::{close_ata, read_ata, transfer_seat};

/// Owner only. After the clock.
/// remaining: seat 0..7 if Split, then (from_ata, owner_ata) pairs.
/// from_ata may be ticket-owned (dest tokens / dest WSOL / ticket shares)
/// or seat-owned (seat WSOL after wrap). Seat WSOL is transferred then closed
/// before the seat PDA itself is closed.
#[derive(Accounts)]
pub struct Cancel<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds = [TICKET_SEED, ticket.owner.as_ref(), ticket.nonce.to_le_bytes().as_ref()],
        bump = ticket.bump,
        constraint = ticket.owner == owner.key() @ WrapError::NotOwner,
        constraint = ticket.status != Status::Done @ WrapError::Closed,
        constraint = ticket.status != Status::Cancelled @ WrapError::Closed,
        close = owner
    )]
    pub ticket: Account<'info, Ticket>,
    pub token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
}

fn close_seat_to_owner(seat: &AccountInfo, owner: &AccountInfo) -> Result<()> {
    let lamports = seat.lamports();
    **seat.try_borrow_mut_lamports()? = 0;
    **owner.try_borrow_mut_lamports()? += lamports;
    seat.assign(&anchor_lang::solana_program::system_program::ID);
    let mut data = seat.try_borrow_mut_data()?;
    for b in data.iter_mut() {
        *b = 0;
    }
    Ok(())
}

fn seat_bump(ai: &AccountInfo) -> Result<u8> {
    let data = ai.try_borrow_data()?;
    require!(data.len() >= 59, WrapError::SeatMismatch);
    Ok(data[58])
}

pub fn handler<'a>(ctx: Context<'a, Cancel<'a>>) -> Result<()> {
    let now = Clock::get()?.slot;
    require!(ctx.accounts.ticket.cancellable(now), WrapError::TooEarly);

    let ticket_key = ctx.accounts.ticket.key();
    let owner_key = ctx.accounts.owner.key();
    let rest = ctx.remaining_accounts;
    let mut offset = 0;
    let split = ctx.accounts.ticket.status == Status::Split;

    if split {
        require!(rest.len() >= BASKET_SIZE, WrapError::SeatMismatch);
        for i in 0..BASKET_SIZE {
            let seat_ai = &rest[i];
            let idx = [i as u8];
            let (pda, _) = Pubkey::find_program_address(
                &[SEAT_SEED, ticket_key.as_ref(), idx.as_ref()],
                ctx.program_id,
            );
            require!(seat_ai.key() == pda, WrapError::SeatMismatch);
            require!(seat_ai.owner == ctx.program_id, WrapError::SeatMismatch);
        }
        offset = BASKET_SIZE;
    }

    let pairs = &rest[offset..];
    require!(pairs.len() % 2 == 0, WrapError::BadOut);

    let nonce = ctx.accounts.ticket.nonce.to_le_bytes();
    let ticket_seeds: &[&[u8]] = &[
        TICKET_SEED,
        ctx.accounts.ticket.owner.as_ref(),
        nonce.as_ref(),
        &[ctx.accounts.ticket.bump],
    ];

    let tokenkeg = ctx.accounts.token_program.to_account_info();
    let token22 = ctx.accounts.token_2022_program.to_account_info();
    let ticket_ai = ctx.accounts.ticket.to_account_info();
    let owner_ai = ctx.accounts.owner.to_account_info();

    let n = pairs.len() / 2;
    for i in 0..n {
        let from = pairs[i * 2].clone();
        let to = pairs[i * 2 + 1].clone();
        let (f_mint, f_owner, f_amt) = read_ata(&from)?;
        let (t_mint, t_owner, _) = read_ata(&to)?;
        require!(f_mint == t_mint, WrapError::BadOut);
        require!(t_owner == owner_key, WrapError::NotOwner);

        if f_owner == ticket_key {
            let signer = &[ticket_seeds];
            transfer_seat(
                tokenkeg.clone(),
                token22.clone(),
                from.clone(),
                to,
                ticket_ai.clone(),
                f_amt,
                signer,
            )?;
            continue;
        }

        require!(split, WrapError::BadOut);
        let mut hit: Option<usize> = None;
        for s in 0..BASKET_SIZE {
            if rest[s].key() == f_owner {
                hit = Some(s);
                break;
            }
        }
        let s = hit.ok_or(error!(WrapError::BadOut))?;
        let seat_ai = rest[s].clone();
        let bump = seat_bump(&seat_ai)?;
        let idx = [s as u8];
        let seat_seed_1 = SEAT_SEED;
        let seat_seed_2 = ticket_key.as_ref();
        let seat_seeds: &[&[u8]] = &[seat_seed_1, seat_seed_2, idx.as_ref(), &[bump]];
        let signer = &[seat_seeds];
        transfer_seat(
            tokenkeg.clone(),
            token22.clone(),
            from.clone(),
            to,
            seat_ai.clone(),
            f_amt,
            signer,
        )?;
        // Empty seat ATA would trap rent after the seat PDA closes.
        close_ata(
            tokenkeg.clone(),
            token22.clone(),
            from,
            owner_ai.clone(),
            seat_ai,
            signer,
        )?;
    }

    if split {
        for i in 0..BASKET_SIZE {
            close_seat_to_owner(&rest[i], &owner_ai)?;
        }
    }

    ctx.accounts.ticket.status = Status::Cancelled;
    Ok(())
}
