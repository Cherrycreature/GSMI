use anchor_lang::prelude::*;

#[error_code]
pub enum GsmiError {
    #[msg("Invalid asset mint")]
    InvalidAssetMint,
    #[msg("Slippage tolerance exceeded")]
    SlippageExceeded,
    #[msg("Zero amount not allowed")]
    ZeroAmount,
    #[msg("Insufficient shares")]
    InsufficientShares,
    #[msg("Insufficient assets in vault book")]
    InsufficientAssets,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Need all eight seats")]
    IncompleteBasket,
    #[msg("Deposit does not match vault shape")]
    ShapeMismatch,
    #[msg("Vault already opened")]
    AlreadyOpened,
    #[msg("Wrong account order")]
    BadAccounts,
}
