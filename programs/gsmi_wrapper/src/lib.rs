use anchor_lang::prelude::*;

pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;
pub mod token_io;

use instructions::*;

declare_id!("4FMpDudDHnQkXp3Y6FjCfd4BKELxHzYrjTSwrMs3T5F2");

/// SOL door for the frozen $GSMI vault.
/// No admin after init. Ticket PDA is the only authority on in-flight funds.
#[program]
pub mod gsmi_wrapper {
    use super::*;

    pub fn init_config(
        ctx: Context<InitConfig>,
        cancel_slots_default: u32,
        vault: Pubkey,
        shares_mint: Pubkey,
        vault_program: Pubkey,
        jupiter: Pubkey,
    ) -> Result<()> {
        instructions::init_config::handler(ctx, cancel_slots_default, vault, shares_mint, vault_program, jupiter)
    }

    pub fn open_mint(ctx: Context<OpenMint>, nonce: u64, lamports: u64, min_shares: u64, cancel_slots: u32) -> Result<()> {
        instructions::open_mint::handler(ctx, nonce, lamports, min_shares, cancel_slots)
    }

    /// remaining_accounts = eight empty seat PDAs `["seat", ticket, [i]]`.
    pub fn split_mint(ctx: Context<SplitMint>, budgets: [u64; 8]) -> Result<()> {
        instructions::split_mint::handler(ctx, budgets)
    }

    /// remaining_accounts[0] = Jupiter program
    /// remaining_accounts[1..] = that program's swap accounts (source authority = ticket)
    pub fn wrap_seat(ctx: Context<WrapSeat>, seat: u8) -> Result<()> {
        instructions::wrap_seat::handler(ctx, seat)
    }

    pub fn crank_buy<'a>(ctx: Context<'a, CrankBuy<'a>>, seat: u8, data: Vec<u8>) -> Result<()> {
        instructions::crank_buy::handler(ctx, seat, data)
    }

    #[cfg(feature = "local-crank")]
    pub fn mark_seat(ctx: Context<MarkSeat>, seat: u8) -> Result<()> {
        instructions::mark_seat::handler(ctx, seat)
    }

    #[cfg(feature = "local-crank")]
    pub fn local_crank_buy<'a>(ctx: Context<'a, LocalCrankBuy<'a>>, seat: u8, out: u64) -> Result<()> {
        instructions::local_crank_buy::handler(ctx, seat, out)
    }

    pub fn finish_mint<'a>(ctx: Context<'a, FinishMint<'a>>, offered: [u64; 8], shares: u64, min_shares: u64) -> Result<()> {
        instructions::finish_mint::handler(ctx, offered, shares, min_shares)
    }

    pub fn open_redeem(ctx: Context<OpenRedeem>, nonce: u64, shares: u64, min_sol: u64, cancel_slots: u32) -> Result<()> {
        instructions::open_redeem::handler(ctx, nonce, shares, min_sol, cancel_slots)
    }

    pub fn crank_redeem_basket<'a>(ctx: Context<'a, CrankRedeemBasket<'a>>, shares: u64) -> Result<()> {
        instructions::crank_redeem_basket::handler(ctx, shares)
    }

    pub fn crank_sell<'a>(ctx: Context<'a, CrankSell<'a>>, seat: u8, data: Vec<u8>) -> Result<()> {
        instructions::crank_sell::handler(ctx, seat, data)
    }

    #[cfg(feature = "local-crank")]
    pub fn local_clear_seats<'a>(ctx: Context<'a, LocalClearSeats<'a>>) -> Result<()> {
        instructions::local_clear_seats::handler(ctx)
    }

    #[cfg(feature = "local-crank")]
    pub fn local_crank_sell<'a>(ctx: Context<'a, LocalCrankSell<'a>>, seat: u8, sol_out: u64) -> Result<()> {
        instructions::local_crank_sell::handler(ctx, seat, sol_out)
    }

    pub fn finish_redeem_sol(ctx: Context<FinishRedeemSol>) -> Result<()> {
        instructions::finish_redeem_sol::handler(ctx)
    }

    pub fn cancel<'a>(ctx: Context<'a, Cancel<'a>>) -> Result<()> {
        instructions::cancel::handler(ctx)
    }

    pub fn recover_seat_wsol(ctx: Context<RecoverSeatWsol>, seat: u8) -> Result<()> {
        instructions::recover::recover_seat_wsol(ctx, seat)
    }

    pub fn recover_ticket_ata(ctx: Context<RecoverTicketAta>) -> Result<()> {
        instructions::recover::recover_ticket_ata(ctx)
    }
}
