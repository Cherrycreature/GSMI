use anchor_lang::prelude::*;

#[error_code]
pub enum WrapError {
    #[msg("config already set")]
    ConfigLive,
    #[msg("wrong vault")]
    BadVault,
    #[msg("wrong seat")]
    BadSeat,
    #[msg("ticket not open")]
    Closed,
    #[msg("wrong side")]
    BadSide,
    #[msg("already filled that seat")]
    SeatDone,
    #[msg("seat not filled")]
    SeatEmpty,
    #[msg("cancel clock still running")]
    TooEarly,
    #[msg("cancel clock out of range")]
    BadClock,
    #[msg("zero")]
    Zero,
    #[msg("min out missed")]
    Slip,
    #[msg("Jupiter program mismatch")]
    BadJup,
    #[msg("output ATA is not the ticket")]
    BadOut,
    #[msg("swap did not increase the seat")]
    NoFill,
    #[msg("not the owner")]
    NotOwner,
    #[msg("ticket not split yet")]
    NotSplit,
    #[msg("budgets do not fit the ticket")]
    BadBudget,
    #[msg("seat pda mismatch")]
    SeatMismatch,
}
