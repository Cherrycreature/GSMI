use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount};
use anchor_spl::token_2022::Token2022;
use crate::constants::*;
use crate::error::GsmiError;
use crate::events::MintEvent;
use crate::math::{min_slice, nets_of};
use crate::state::Vault;
use crate::token_io::{read_ata, transfer_seat};

/// remaining_accounts, 8 seats × 3:
///   user_ata, vault_ata, treasury_ata
/// Seat mint is vault.assets[i].mint. Do not pass the mint account.
#[derive(Accounts)]
pub struct MintShares<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, vault.vault_id.to_le_bytes().as_ref()],
        bump = vault.bump,
        constraint = vault.asset_count == BASKET_SIZE as u8 @ GsmiError::IncompleteBasket
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

pub fn handler<'a>(
    ctx: Context<'a, MintShares<'a>>,
    offered: [u64; BASKET_SIZE],
    shares: u64,
    min_shares_out: u64,
) -> Result<()> {
    let stride = if ctx.remaining_accounts.len() == BASKET_SIZE * 3 {
        3usize
    } else if ctx.remaining_accounts.len() == BASKET_SIZE * 4 {
        4usize
    } else {
        return err!(GsmiError::BadAccounts);
    };

    let (nets, fees) = nets_of(offered)?;
    let first_fill = !ctx.accounts.vault.opened;

    let (take, shares_out) = if first_fill {
        require!(shares > 0, GsmiError::ZeroAmount);
        (nets, shares)
    } else {
        let base_shares = if ctx.accounts.vault.total_shares > 0 {
            ctx.accounts.vault.total_shares
        } else {
            ctx.accounts.vault.genesis_shares
        };
        let mut books = [0u64; BASKET_SIZE];
        for i in 0..BASKET_SIZE {
            books[i] = ctx.accounts.vault.ratio_i(i);
        }
        min_slice(nets, books, base_shares)?
    };

    require!(shares_out >= min_shares_out, GsmiError::SlippageExceeded);

    let tokenkeg = ctx.accounts.token_program.to_account_info();
    let token22 = ctx.accounts.token_2022_program.to_account_info();
    let user_key = ctx.accounts.user.key();
    let vault_key = ctx.accounts.vault.key();
    let user_authority = ctx.accounts.user.to_account_info();

    for i in 0..BASKET_SIZE {
        let seat = ctx.accounts.vault.mint_at(i);
        let (user_ai, vault_ai, treas_ai) = if stride == 4 {
            (
                ctx.remaining_accounts[i * 4 + 1].clone(),
                ctx.remaining_accounts[i * 4 + 2].clone(),
                ctx.remaining_accounts[i * 4 + 3].clone(),
            )
        } else {
            (
                ctx.remaining_accounts[i * 3].clone(),
                ctx.remaining_accounts[i * 3 + 1].clone(),
                ctx.remaining_accounts[i * 3 + 2].clone(),
            )
        };

        let (u_mint, u_owner, u_amt) = read_ata(&user_ai)?;
        let (v_mint, v_owner, _) = read_ata(&vault_ai)?;
        let (t_mint, t_owner, _) = read_ata(&treas_ai)?;

        require!(u_mint == seat && v_mint == seat && t_mint == seat, GsmiError::InvalidAssetMint);
        require!(u_owner == user_key, GsmiError::Unauthorized);
        require!(v_owner == vault_key, GsmiError::Unauthorized);
        require!(t_owner == TREASURY, GsmiError::Unauthorized);
        require!(u_amt >= offered[i], GsmiError::InsufficientAssets);

        if fees[i] > 0 {
            transfer_seat(
                tokenkeg.clone(),
                token22.clone(),
                user_ai.clone(),
                treas_ai.clone(),
                user_authority.clone(),
                fees[i],
                &[],
            )?;
        }

        transfer_seat(
            tokenkeg.clone(),
            token22.clone(),
            user_ai.clone(),
            vault_ai,
            user_authority.clone(),
            take[i],
            &[],
        )?;

        let remainder = offered[i]
            .checked_sub(fees[i])
            .ok_or(GsmiError::MathOverflow)?
            .checked_sub(take[i])
            .ok_or(GsmiError::MathOverflow)?;
        if remainder > 0 {
            transfer_seat(
                tokenkeg.clone(),
                token22.clone(),
                user_ai,
                treas_ai,
                user_authority.clone(),
                remainder,
                &[],
            )?;
        }
    }

    let vault_id_bytes = ctx.accounts.vault.vault_id.to_le_bytes();
    let bump = ctx.accounts.vault.bump;
    let seeds: &[&[u8]] = &[VAULT_SEED, vault_id_bytes.as_ref(), &[bump]];
    let signer_seeds = &[seeds];
    token::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            MintTo {
                mint: ctx.accounts.shares_mint.to_account_info(),
                to: ctx.accounts.user_shares_account.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            signer_seeds,
        ),
        shares_out,
    )?;

    let vault = &mut ctx.accounts.vault;
    if first_fill {
        vault.opened = true;
        vault.genesis_shares = shares_out;
        vault.shape = take;
    }
    for i in 0..BASKET_SIZE {
        vault.assets[i].amount = vault.assets[i]
            .amount
            .checked_add(take[i])
            .ok_or(GsmiError::MathOverflow)?;
    }
    vault.total_shares = vault
        .total_shares
        .checked_add(shares_out)
        .ok_or(GsmiError::MathOverflow)?;

    emit!(MintEvent {
        user: ctx.accounts.user.key(),
        shares_minted: shares_out,
        first_fill,
    });
    msg!("mint {} $GSMI first={}", shares_out, first_fill);
    Ok(())
}
