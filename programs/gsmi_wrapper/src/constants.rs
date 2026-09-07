use anchor_lang::prelude::*;

pub const BASKET_SIZE: usize = 8;

pub const VAULT_PROGRAM: Pubkey = pubkey!("4saonDbBXhXJQ8TPvb7gMdrDNrkmpuRvjwCxqu1UDPxQ");
pub const VAULT: Pubkey = pubkey!("FvXKb7JVCmMa9tuAexF3zyAvj1vvRUVngrRgBpUFaCpe");
pub const SHARES_MINT: Pubkey = pubkey!("W1yo6FyJgfGTtj75S8qTxuN9qjTE5XKijq6DkCVRHU4");
pub const JUPITER: Pubkey = pubkey!("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
pub const WSOL: Pubkey = pubkey!("So11111111111111111111111111111111111111112");

pub const GME: Pubkey = pubkey!("8wXtPeU6557ETkp9WHFY1n1EcU6NxDvbAggHGsMYiHsB");
pub const BP: Pubkey = pubkey!("3B1ijcocM5EDga6XxQ7JLW7weocQPWWjuhBYG8Vepump");
pub const TSUKI: Pubkey = pubkey!("463SK47VkB7uE7XenTHKiVcMtxRsfNE2X4Q9wByaURVA");
pub const RWA: Pubkey = pubkey!("G8aVC4nk5oPWzTHp4PDm3kAuixCebv9WRQMD93h9pump");
pub const RKC: Pubkey = pubkey!("7HgfXftRBBqsYtAEYcqjGLQrNJLL6Tww9ek4rE3Apump");
pub const TT: Pubkey = pubkey!("5dSW7m4EN1DWXk6782P1UYSddDz3xTQEAtL6gtZmpump");
pub const BUCK: Pubkey = pubkey!("FLqmVrv6cp7icjobpRMQJMEyjF3kF84QmC4HXpySpump");
pub const AT: Pubkey = pubkey!("HBByvsRPFwcJbV516QVmtHxYwEZhrDX3f9Bgn5M9pump");

pub const CONFIG_SEED: &[u8] = b"config";
pub const TICKET_SEED: &[u8] = b"ticket";
pub const SEAT_SEED: &[u8] = b"seat";

pub const CANCEL_SLOTS_MIN: u32 = 32;
pub const CANCEL_SLOTS_MAX: u32 = 2_500;
pub const CANCEL_SLOTS_DEFAULT: u32 = 150;

/// Desk that signs wrap / buy / finish. Network reserve lands here at finish.
pub const DESK: Pubkey = pubkey!("5Cz2YfDQkhgsGZ31so8oWRRMfcJDzBi7hW3rKRTQSrZo");
/// Fixed network reserve per ticket. Not a product fee. Locked in this binary.
pub const CRANK_TAKE: u64 = 12_000_000;

pub const TICKET_SPACE: usize = 8 + 32 + 8 + 1 + 1 + 8 + 8 + 8 + 8 + 4 + 1 + 16;

pub fn pay_crank(ticket: &AccountInfo, desk: &AccountInfo) -> Result<()> {
    require!(desk.key() == DESK, crate::error::WrapError::BadOut);
    let rent = Rent::get()?.minimum_balance(TICKET_SPACE);
    let take = CRANK_TAKE.min(ticket.lamports().saturating_sub(rent));
    if take == 0 {
        return Ok(());
    }
    **ticket.try_borrow_mut_lamports()? -= take;
    **desk.try_borrow_mut_lamports()? += take;
    Ok(())
}

/// sha256("global:mint_shares")[:8] / sha256("global:redeem")[:8]
pub const MINT_SHARES_DISC: [u8; 8] = [24, 196, 132, 0, 183, 158, 216, 142];
pub const REDEEM_DISC: [u8; 8] = [184, 12, 86, 149, 70, 196, 97, 225];

pub fn seat_mint(i: u8) -> Result<Pubkey> {
    Ok(match i {
        0 => GME,
        1 => BP,
        2 => TSUKI,
        3 => RWA,
        4 => RKC,
        5 => TT,
        6 => BUCK,
        7 => AT,
        _ => return err!(crate::error::WrapError::BadSeat),
    })
}

pub fn basket() -> [Pubkey; BASKET_SIZE] {
    [GME, BP, TSUKI, RWA, RKC, TT, BUCK, AT]
}
