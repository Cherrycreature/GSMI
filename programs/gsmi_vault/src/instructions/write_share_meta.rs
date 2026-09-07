use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
};
use crate::constants::*;
use crate::error::GsmiError;
use crate::state::Vault;

/// Metaplex Token Metadata. Locked strings. No admin after this fires.
pub const MPL_TOKEN_METADATA: Pubkey =
    pubkey!("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
pub const GSMI_NAME: &str = "GSMI";
pub const GSMI_SYMBOL: &str = "GSMI";
pub const GSMI_URI: &str = "https://gsmi.io/gsmi.json";

#[derive(Accounts)]
pub struct WriteShareMeta<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        seeds = [VAULT_SEED, vault.vault_id.to_le_bytes().as_ref()],
        bump = vault.bump
    )]
    pub vault: Account<'info, Vault>,

    /// CHECK: $GSMI mint. Authority is the vault PDA.
    #[account(address = vault.shares_mint)]
    pub shares_mint: UncheckedAccount<'info>,

    /// CHECK: Metaplex metadata PDA for the mint.
    #[account(mut)]
    pub metadata: UncheckedAccount<'info>,

    /// CHECK: Token Metadata program.
    #[account(address = MPL_TOKEN_METADATA)]
    pub token_metadata_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,

    /// CHECK: rent sysvar
    pub rent: Sysvar<'info, Rent>,
}

fn borsh_string(s: &str) -> Vec<u8> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(4 + bytes.len());
    out.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
    out.extend_from_slice(bytes);
    out
}

/// CreateMetadataAccountV3 (ix 33), is_mutable = false.
fn create_v3_data() -> Vec<u8> {
    let mut data = vec![33u8];
    data.extend_from_slice(&borsh_string(GSMI_NAME));
    data.extend_from_slice(&borsh_string(GSMI_SYMBOL));
    data.extend_from_slice(&borsh_string(GSMI_URI));
    data.extend_from_slice(&0u16.to_le_bytes()); // seller fee
    data.push(0); // creators None
    data.push(0); // collection None
    data.push(0); // uses None
    data.push(0); // is_mutable = false
    data.push(0); // collection_details None
    data
}

pub fn handler(ctx: Context<WriteShareMeta>) -> Result<()> {
    require!(
        ctx.accounts.metadata.data_is_empty(),
        GsmiError::AlreadyOpened
    );

    let mint = ctx.accounts.shares_mint.key();
    let mpl = MPL_TOKEN_METADATA;
    let (expected, _) = Pubkey::find_program_address(
        &[b"metadata", mpl.as_ref(), mint.as_ref()],
        &mpl,
    );
    require!(ctx.accounts.metadata.key() == expected, GsmiError::BadAccounts);

    let vault_id_bytes = ctx.accounts.vault.vault_id.to_le_bytes();
    let bump = ctx.accounts.vault.bump;
    let seeds: &[&[u8]] = &[VAULT_SEED, vault_id_bytes.as_ref(), &[bump]];
    let signer = &[seeds];

    let ix = Instruction {
        program_id: mpl,
        accounts: vec![
            AccountMeta::new(ctx.accounts.metadata.key(), false),
            AccountMeta::new_readonly(mint, false),
            AccountMeta::new_readonly(ctx.accounts.vault.key(), true),
            AccountMeta::new(ctx.accounts.payer.key(), true),
            AccountMeta::new_readonly(ctx.accounts.vault.key(), false),
            AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
            AccountMeta::new_readonly(ctx.accounts.rent.key(), false),
        ],
        data: create_v3_data(),
    };

    invoke_signed(
        &ix,
        &[
            ctx.accounts.metadata.to_account_info(),
            ctx.accounts.shares_mint.to_account_info(),
            ctx.accounts.vault.to_account_info(),
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
            ctx.accounts.rent.to_account_info(),
        ],
        signer,
    )
    .map_err(|_| error!(GsmiError::BadAccounts))?;

    msg!("$GSMI metadata locked. GSMI / https://gsmi.io/gsmi.json");
    Ok(())
}
