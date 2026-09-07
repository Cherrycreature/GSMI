use anchor_lang::prelude::*;

pub const MAX_ASSETS: usize = 8;
pub const BASKET_SIZE: usize = 8;

pub const GME_MINT: Pubkey = pubkey!("8wXtPeU6557ETkp9WHFY1n1EcU6NxDvbAggHGsMYiHsB");
pub const BP_MINT: Pubkey = pubkey!("3B1ijcocM5EDga6XxQ7JLW7weocQPWWjuhBYG8Vepump");
pub const TSUKI_MINT: Pubkey = pubkey!("463SK47VkB7uE7XenTHKiVcMtxRsfNE2X4Q9wByaURVA");
pub const RWA_MINT: Pubkey = pubkey!("G8aVC4nk5oPWzTHp4PDm3kAuixCebv9WRQMD93h9pump");
pub const RKC_MINT: Pubkey = pubkey!("7HgfXftRBBqsYtAEYcqjGLQrNJLL6Tww9ek4rE3Apump");
pub const TT_MINT: Pubkey = pubkey!("5dSW7m4EN1DWXk6782P1UYSddDz3xTQEAtL6gtZmpump");
pub const BUCK_MINT: Pubkey = pubkey!("FLqmVrv6cp7icjobpRMQJMEyjF3kF84QmC4HXpySpump");
pub const AT_MINT: Pubkey = pubkey!("HBByvsRPFwcJbV516QVmtHxYwEZhrDX3f9Bgn5M9pump");

pub const GME_WEIGHT_BPS: u16 = 1250;
pub const BP_WEIGHT_BPS: u16 = 1250;
pub const TSUKI_WEIGHT_BPS: u16 = 1250;
pub const RWA_WEIGHT_BPS: u16 = 1250;
pub const RKC_WEIGHT_BPS: u16 = 1250;
pub const TT_WEIGHT_BPS: u16 = 1250;
pub const BUCK_WEIGHT_BPS: u16 = 1250;
pub const AT_WEIGHT_BPS: u16 = 1250;

pub const DEPOSIT_FEE_NUM: u64 = 69;
pub const DEPOSIT_FEE_DEN: u64 = 100_000;
pub const DEPOSIT_FEE_BPS: u16 = 7;

pub const TREASURY: Pubkey = pubkey!("1f8NG4HixGS6wREigBXMbK7rZn3NU3WpDzKWDij79g6");
pub const WSOL_MINT: Pubkey = pubkey!("So11111111111111111111111111111111111111112");

pub const VAULT_SEED: &[u8] = b"gsmi_vault";
pub const SHARES_SEED: &[u8] = b"gsmi_shares";
pub const ASSET_VAULT_SEED: &[u8] = b"gsmi_asset";
pub const SHARES_DECIMALS: u8 = 9;
pub const BPS_DENOMINATOR: u16 = 10_000;

pub fn basket_mints() -> [Pubkey; BASKET_SIZE] {
    [GME_MINT, BP_MINT, TSUKI_MINT, RWA_MINT, RKC_MINT, TT_MINT, BUCK_MINT, AT_MINT]
}

pub fn basket_weights() -> [u16; BASKET_SIZE] {
    [
        GME_WEIGHT_BPS,
        BP_WEIGHT_BPS,
        TSUKI_WEIGHT_BPS,
        RWA_WEIGHT_BPS,
        RKC_WEIGHT_BPS,
        TT_WEIGHT_BPS,
        BUCK_WEIGHT_BPS,
        AT_WEIGHT_BPS,
    ]
}
