use anchor_lang::prelude::*;
use crate::constants::BASKET_SIZE;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum Side {
    MintSol,
    RedeemGsmi,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Open,
    Split,
    BasketOut,
    Done,
    Cancelled,
}

#[account]
pub struct Config {
    pub vault: Pubkey,
    pub shares_mint: Pubkey,
    pub vault_program: Pubkey,
    pub jupiter: Pubkey,
    pub cancel_slots_default: u32,
    pub bump: u8,
}

#[account]
pub struct Ticket {
    pub owner: Pubkey,
    pub nonce: u64,
    pub side: Side,
    pub status: Status,
    pub sol_in: u64,
    pub shares_in: u64,
    pub min_out: u64,
    pub open_slot: u64,
    pub cancel_slots: u32,
    pub bump: u8,
}

impl Ticket {
    pub const SIZE: usize = 8 + 32 + 8 + 1 + 1 + 8 + 8 + 8 + 8 + 4 + 1 + 16;

    pub fn cancellable(&self, now: u64) -> bool {
        now >= self.open_slot.saturating_add(self.cancel_slots as u64)
    }
}

/// One seat's SOL budget. Crank writes THIS account, not the parent ticket.
#[account]
pub struct Seat {
    pub ticket: Pubkey,
    pub index: u8,
    pub budget: u64,
    pub got: u64,
    pub done: bool,
    pub bump: u8,
}

impl Seat {
    pub const SIZE: usize = 8 + 32 + 1 + 8 + 8 + 1 + 1 + 16;
}

pub fn all_seats_done(seats: &[Seat; BASKET_SIZE]) -> bool {
    seats.iter().all(|s| s.done)
}
