use anchor_lang::prelude::*;
use anchor_lang::solana_program::{instruction::{AccountMeta, Instruction}, program::invoke_signed};
use anchor_spl::token::{Token, TokenAccount, Transfer, transfer};
use crate::constants::*;
use crate::error::WrapError;
use crate::state::{Config, Seat, Side, Status, Ticket};
use crate::token_io::{close_ata, read_ata, transfer_seat};

/// remaining_accounts = vault mint_shares remaining (8×3 user/vault/treasury ATA)
#[derive(Accounts)]
pub struct FinishMint<'info> {
    #[account(mut)]
    pub cranker: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [TICKET_SEED, ticket.owner.as_ref(), ticket.nonce.to_le_bytes().as_ref()],
        bump = ticket.bump,
        constraint = ticket.status == Status::Split @ WrapError::NotSplit,
        constraint = ticket.side == Side::MintSol @ WrapError::BadSide,
    )]
    pub ticket: Account<'info, Ticket>,
    /// CHECK: owner of the mint. Receives GSMI and leftover SOL.
    #[account(mut, address = ticket.owner)]
    pub owner: UncheckedAccount<'info>,
    /// CHECK: desk network reserve.
    #[account(mut, address = DESK)]
    pub desk: UncheckedAccount<'info>,
    #[account(mut, address = config.vault)]
    /// CHECK: frozen vault.
    pub vault: UncheckedAccount<'info>,
    #[account(mut, address = config.shares_mint)]
    /// CHECK: GSMI mint.
    pub shares_mint: UncheckedAccount<'info>,
    #[account(
        mut,
        token::mint = shares_mint,
        token::authority = ticket
    )]
    pub ticket_shares: Account<'info, TokenAccount>,
    #[account(
        mut,
        token::mint = shares_mint,
        token::authority = owner
    )]
    pub owner_shares: Account<'info, TokenAccount>,
    /// CHECK: frozen vault program.
    #[account(address = config.vault_program)]
    pub vault_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    /// CHECK: Token-2022
    pub token_2022_program: UncheckedAccount<'info>,
}

pub fn handler<'a>(
    ctx: Context<'a, FinishMint<'a>>,
    offered: [u64; 8],
    shares: u64,
    min_shares: u64,
) -> Result<()> {
    require!(min_shares > 0, WrapError::Slip);
    if min_shares < ctx.accounts.ticket.min_out {
        require!(ctx.accounts.cranker.key() == ctx.accounts.ticket.owner, WrapError::NotOwner);
    }
    require!(ctx.remaining_accounts.len() >= BASKET_SIZE, WrapError::SeatMismatch);
    let ticket_key = ctx.accounts.ticket.key();
    for i in 0..BASKET_SIZE {
        let seat = Seat::try_deserialize(&mut &ctx.remaining_accounts[i].try_borrow_data()?[..])
            .map_err(|_| error!(WrapError::SeatMismatch))?;
        require!(seat.ticket == ticket_key, WrapError::SeatMismatch);
        require!(seat.index == i as u8, WrapError::SeatMismatch);
        require!(seat.done, WrapError::SeatEmpty);
    }

    // Optional ExactOut pad return:
    // remaining = seats[8] + owner_wsol + seat_wsol[8] + vault 8×3
    // Old clients omit the 9 WSOL accounts; skip the sweep.
    let sweep = ctx.remaining_accounts.len() >= BASKET_SIZE + 1 + BASKET_SIZE + BASKET_SIZE * 3;
    let vault_off = if sweep {
        BASKET_SIZE + 1 + BASKET_SIZE
    } else {
        BASKET_SIZE
    };

    let mut data = MINT_SHARES_DISC.to_vec();
    for x in offered {
        data.extend_from_slice(&x.to_le_bytes());
    }
    data.extend_from_slice(&shares.to_le_bytes());
    data.extend_from_slice(&min_shares.to_le_bytes());

    let mut metas = vec![
        AccountMeta::new(ctx.accounts.ticket.key(), true),
        AccountMeta::new(ctx.accounts.vault.key(), false),
        AccountMeta::new(ctx.accounts.shares_mint.key(), false),
        AccountMeta::new(ctx.accounts.ticket_shares.key(), false),
        AccountMeta::new_readonly(ctx.accounts.token_program.key(), false),
        AccountMeta::new_readonly(ctx.accounts.token_2022_program.key(), false),
    ];
    let mut infos = vec![
        ctx.accounts.ticket.to_account_info(),
        ctx.accounts.vault.to_account_info(),
        ctx.accounts.shares_mint.to_account_info(),
        ctx.accounts.ticket_shares.to_account_info(),
        ctx.accounts.token_program.to_account_info(),
        ctx.accounts.token_2022_program.to_account_info(),
    ];
    for a in ctx.remaining_accounts.iter().skip(vault_off) {
        metas.push(if a.is_writable {
            AccountMeta::new(a.key(), a.is_signer)
        } else {
            AccountMeta::new_readonly(a.key(), a.is_signer)
        });
        infos.push(a.clone());
    }

    let nonce = ctx.accounts.ticket.nonce.to_le_bytes();
    let seeds: &[&[u8]] = &[
        TICKET_SEED,
        ctx.accounts.ticket.owner.as_ref(),
        nonce.as_ref(),
        &[ctx.accounts.ticket.bump],
    ];
    invoke_signed(
        &Instruction {
            program_id: ctx.accounts.config.vault_program,
            accounts: metas,
            data,
        },
        &infos,
        &[seeds],
    )?;

    ctx.accounts.ticket_shares.reload()?;
    let out = ctx.accounts.ticket_shares.amount;
    require!(out >= min_shares, WrapError::Slip);

    transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.ticket_shares.to_account_info(),
                to: ctx.accounts.owner_shares.to_account_info(),
                authority: ctx.accounts.ticket.to_account_info(),
            },
            &[seeds],
        ),
        out,
    )?;

    // Happy path: leftover seat WSOL (ExactOut pad) + native seat SOL + ticket rent go home.
    let owner_ai = ctx.accounts.owner.to_account_info();
    if sweep {
        let owner_wsol = ctx.remaining_accounts[BASKET_SIZE].clone();
        let (ow_mint, ow_owner, _) = read_ata(&owner_wsol)?;
        require!(ow_mint == WSOL, WrapError::BadOut);
        require!(ow_owner == ctx.accounts.ticket.owner, WrapError::NotOwner);
        let tokenkeg = ctx.accounts.token_program.to_account_info();
        let token22 = ctx.accounts.token_2022_program.to_account_info();
        for i in 0..BASKET_SIZE {
            let seat_ai = ctx.remaining_accounts[i].clone();
            let wsol_ai = ctx.remaining_accounts[BASKET_SIZE + 1 + i].clone();
            let (w_mint, w_owner, w_amt) = read_ata(&wsol_ai)?;
            require!(w_mint == WSOL, WrapError::BadOut);
            require!(w_owner == seat_ai.key(), WrapError::BadOut);
            let data = seat_ai.try_borrow_data()?;
            require!(data.len() >= 59, WrapError::SeatMismatch);
            let bump = data[58];
            drop(data);
            let idx = [i as u8];
            let seeds: &[&[u8]] = &[SEAT_SEED, ticket_key.as_ref(), idx.as_ref(), &[bump]];
            let signer = &[seeds];
            transfer_seat(
                tokenkeg.clone(),
                token22.clone(),
                wsol_ai.clone(),
                owner_wsol.clone(),
                seat_ai.clone(),
                w_amt,
                signer,
            )?;
            close_ata(
                tokenkeg.clone(),
                token22.clone(),
                wsol_ai,
                owner_ai.clone(),
                seat_ai,
                signer,
            )?;
        }
    }
    for i in 0..BASKET_SIZE {
        let seat_ai = ctx.remaining_accounts[i].clone();
        let idx = [i as u8];
        let (pda, _) = Pubkey::find_program_address(
            &[SEAT_SEED, ticket_key.as_ref(), idx.as_ref()],
            ctx.program_id,
        );
        require!(seat_ai.key() == pda, WrapError::SeatMismatch);
        require!(seat_ai.owner == ctx.program_id, WrapError::SeatMismatch);
        let lamports = seat_ai.lamports();
        **seat_ai.try_borrow_mut_lamports()? = 0;
        **owner_ai.try_borrow_mut_lamports()? += lamports;
        seat_ai.assign(&anchor_lang::solana_program::system_program::ID);
        let mut data = seat_ai.try_borrow_mut_data()?;
        for b in data.iter_mut() {
            *b = 0;
        }
    }

    pay_crank(
        &ctx.accounts.ticket.to_account_info(),
        &ctx.accounts.desk.to_account_info(),
    )?;
    let leftover = ctx.accounts.ticket.to_account_info().lamports();
    let rent = Rent::get()?.minimum_balance(Ticket::SIZE);
    if leftover > rent {
        **ctx.accounts.ticket.to_account_info().try_borrow_mut_lamports()? -= leftover - rent;
        **ctx.accounts.owner.to_account_info().try_borrow_mut_lamports()? += leftover - rent;
    }

    ctx.accounts.ticket.status = Status::Done;
    Ok(())
}
