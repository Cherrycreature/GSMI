use anchor_lang::prelude::*;
use anchor_lang::solana_program::{instruction::{AccountMeta, Instruction}, program::invoke_signed};
use crate::constants::*;
use crate::error::WrapError;
use crate::state::{Config, Side, Status, Ticket};

/// remaining_accounts = vault redeem remaining (8×2 ticket ATA / vault ATA) + token programs as needed.
#[derive(Accounts)]
pub struct CrankRedeemBasket<'info> {
    #[account(mut)]
    pub cranker: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [TICKET_SEED, ticket.owner.as_ref(), ticket.nonce.to_le_bytes().as_ref()],
        bump = ticket.bump,
        constraint = ticket.status == Status::Open @ WrapError::Closed,
        constraint = ticket.side == Side::RedeemGsmi @ WrapError::BadSide
    )]
    pub ticket: Account<'info, Ticket>,
    #[account(mut, address = config.vault)]
    /// CHECK: frozen vault
    pub vault: UncheckedAccount<'info>,
    #[account(mut, address = config.shares_mint)]
    /// CHECK: GSMI mint
    pub shares_mint: UncheckedAccount<'info>,
    /// CHECK: ticket GSMI ATA. Vault redeem burns from here.
    #[account(mut)]
    pub ticket_shares: UncheckedAccount<'info>,
    /// CHECK: frozen vault program
    #[account(address = config.vault_program)]
    pub vault_program: UncheckedAccount<'info>,
    /// CHECK: Tokenkeg
    pub token_program: UncheckedAccount<'info>,
    /// CHECK: Token-2022
    pub token_2022_program: UncheckedAccount<'info>,
}

pub fn handler<'a>(ctx: Context<'a, CrankRedeemBasket<'a>>, shares: u64) -> Result<()> {
    require!(shares == ctx.accounts.ticket.shares_in, WrapError::Slip);

    let mut data = REDEEM_DISC.to_vec();
    data.extend_from_slice(&shares.to_le_bytes());

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
    for a in ctx.remaining_accounts.iter() {
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

    ctx.accounts.ticket.status = Status::BasketOut;
    Ok(())
}
