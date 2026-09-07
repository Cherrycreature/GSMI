use anchor_lang::prelude::*;

#[event]
pub struct VaultInitialized {
    pub vault: Pubkey,
    pub shares_mint: Pubkey,
    pub vault_id: u64,
}

#[event]
pub struct MintEvent {
    pub user: Pubkey,
    pub shares_minted: u64,
    pub first_fill: bool,
}

#[event]
pub struct RedeemEvent {
    pub user: Pubkey,
    pub shares_burned: u64,
}
