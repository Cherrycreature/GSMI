use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, Token, TokenAccount};
use anchor_spl::token_2022::Token2022;
use crate::constants::*;
use crate::error::GsmiError;
use crate::events::RedeemEvent;
use crate::math::redeem_out;
use crate::state::Vault;
use crate::token_io::{read_ata, transfer_seat};

/// remaining_accounts, 8 seats × 2:
///   vault_ata, user_ata
#[derive(Accounts)]
pub struct Redeem<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, vault.vault_id.to_le_bytes().as_ref()],
        bump = vault.bump,
        constraint = vault.opened @ GsmiError::IncompleteBasket
    )]
    pub vault: Account<'info, Vault>,

    #[account(mut, address = vault.shares_mint)]
    pub shares_mint: Account<'info, Mint>,

    #[account(
        mut,
        token::mint = shares_mint,
        token::authority = user
    )]
    pub user_shares_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
}

pub fn handler(ctx: Context<Redeem>, shares: u64) -> Result<()> {
    require!(shares > 0, GsmiError::ZeroAmount);
    require!(
        ctx.remaining_accounts.len() == BASKET_SIZE * 2,
        GsmiError::BadAccounts
    );

    let total_shares = ctx.accounts.vault.total_shares;
    require!(
        ctx.accounts.user_shares_account.amount >= shares,
        GsmiError::InsufficientShares
    );

    let mut books = [0u64; BASKET_SIZE];
    for i in 0..BASKET_SIZE {
        books[i] = ctx.accounts.vault.assets[i].amount;
    }
    let out = redeem_out(books, shares, total_shares)?;

    let tokenkeg = ctx.accounts.token_program.to_account_info();
    let token22 = ctx.accounts.token_2022_program.to_account_info();
    let user_key = ctx.accounts.user.key();
    let vault_key = ctx.accounts.vault.key();
    let user_authority = ctx.accounts.user.to_account_info();

    token::burn(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            Burn {
                mint: ctx.accounts.shares_mint.to_account_info(),
                from: ctx.accounts.user_shares_account.to_account_info(),
                authority: user_authority,
            },
        ),
        shares,
    )?;

    let vault_id_bytes = ctx.accounts.vault.vault_id.to_le_bytes();
    let bump = ctx.accounts.vault.bump;
    let seeds: &[&[u8]] = &[VAULT_SEED, vault_id_bytes.as_ref(), &[bump]];
    let signer_seeds = &[seeds];
    let vault_authority = ctx.accounts.vault.to_account_info();

    for i in 0..BASKET_SIZE {
        if out[i] == 0 {
            continue;
        }
        let seat = ctx.accounts.vault.mint_at(i);
        let vault_ai = ctx.remaining_accounts[i * 2].clone();
        let user_ai = ctx.remaining_accounts[i * 2 + 1].clone();

        let (v_mint, v_owner, _) = read_ata(&vault_ai)?;
        let (u_mint, u_owner, _) = read_ata(&user_ai)?;
        require!(v_mint == seat && u_mint == seat, GsmiError::InvalidAssetMint);
        require!(v_owner == vault_key, GsmiError::Unauthorized);
        require!(u_owner == user_key, GsmiError::Unauthorized);

        transfer_seat(
            tokenkeg.clone(),
            token22.clone(),
            vault_ai,
            user_ai,
            vault_authority.clone(),
            out[i],
            signer_seeds,
        )?;
    }

    let vault = &mut ctx.accounts.vault;
    for i in 0..BASKET_SIZE {
        vault.assets[i].amount = vault.assets[i]
            .amount
            .checked_sub(out[i])
            .ok_or(GsmiError::MathOverflow)?;
    }
    vault.total_shares = vault
        .total_shares
        .checked_sub(shares)
        .ok_or(GsmiError::MathOverflow)?;

    emit!(RedeemEvent {
        user: ctx.accounts.user.key(),
        shares_burned: shares,
    });
    msg!("burn {} $GSMI", shares);
    Ok(())
}
