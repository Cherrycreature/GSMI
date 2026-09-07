use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token};
use crate::constants::*;
use crate::error::GsmiError;
use crate::events::VaultInitialized;
use crate::state::{AssetInfo, Vault};

#[derive(Accounts)]
#[instruction(vault_id: u64)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub opener: Signer<'info>,

    #[account(
        init,
        payer = opener,
        space = 8 + Vault::INIT_SPACE,
        seeds = [VAULT_SEED, vault_id.to_le_bytes().as_ref()],
        bump
    )]
    pub vault: Account<'info, Vault>,

    #[account(
        init,
        payer = opener,
        mint::decimals = SHARES_DECIMALS,
        mint::authority = vault,
        seeds = [SHARES_SEED, vault.key().as_ref()],
        bump
    )]
    pub shares_mint: Account<'info, Mint>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<Initialize>, vault_id: u64) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    vault.opener = ctx.accounts.opener.key();
    vault.vault_id = vault_id;
    vault.shares_mint = ctx.accounts.shares_mint.key();
    vault.total_shares = 0;
    vault.genesis_shares = 0;
    vault.bump = ctx.bumps.vault;
    vault.opened = false;
    vault.version = 1;
    vault.asset_count = BASKET_SIZE as u8;
    vault.shape = [0u64; BASKET_SIZE];

    let mints = {
        #[cfg(feature = "local-mints")]
        {
            require!(
                ctx.remaining_accounts.len() == BASKET_SIZE,
                GsmiError::BadAccounts
            );
            let mut m = [Pubkey::default(); BASKET_SIZE];
            for i in 0..BASKET_SIZE {
                m[i] = ctx.remaining_accounts[i].key();
            }
            m
        }
        #[cfg(not(feature = "local-mints"))]
        {
            basket_mints()
        }
    };
    let weights = basket_weights();
    let mut assets = [AssetInfo::default(); BASKET_SIZE];
    for i in 0..BASKET_SIZE {
        assets[i] = AssetInfo {
            mint: mints[i],
            weight_bps: weights[i],
            amount: 0,
            is_active: true,
            _padding: [0u8; 5],
        };
    }
    vault.assets = assets;

    emit!(VaultInitialized {
        vault: vault.key(),
        shares_mint: vault.shares_mint,
        vault_id,
    });
    msg!("$GSMI vault {} init. 8 seats. fee 69/100000. no admin.", vault_id);
    Ok(())
}
