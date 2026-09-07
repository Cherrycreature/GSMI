use anchor_lang::prelude::*;
use crate::constants::BASKET_SIZE;

/// One seat. `amount` is the BOOK, not the raw ATA balance.
/// Tokens sent straight at the ATA do not change this number.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace)]
pub struct AssetInfo {
    pub mint: Pubkey,
    pub weight_bps: u16,
    pub amount: u64,
    pub is_active: bool,
    pub _padding: [u8; 5],
}

#[account]
#[derive(InitSpace)]
pub struct Vault {
    /// Payer of initialize. Inert after init. Not an admin.
    pub opener: Pubkey,
    pub vault_id: u64,
    pub shares_mint: Pubkey,
    pub total_shares: u64,
    /// Share count minted on the first fill. Used if supply later hits zero.
    pub genesis_shares: u64,
    pub asset_count: u8,
    pub bump: u8,
    /// True after the first eight-wide mint. Photograph cannot be retaken.
    pub opened: bool,
    pub version: u8,
    pub assets: [AssetInfo; BASKET_SIZE],
    /// Token counts written by the first fill. Later mints copy this ratio
    /// when the book is empty. Live mints copy `assets[i].amount`.
    pub shape: [u64; BASKET_SIZE],
}

impl Vault {
    pub fn mint_at(&self, i: usize) -> Pubkey {
        self.assets[i].mint
    }

    /// Live ratio source: book if the vault has inventory, else the photograph.
    pub fn ratio_i(&self, i: usize) -> u64 {
        if self.opened && self.assets.iter().any(|a| a.amount > 0) {
            self.assets[i].amount
        } else {
            self.shape[i]
        }
    }
}
