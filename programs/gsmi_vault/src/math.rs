use anchor_lang::prelude::*;
use crate::constants::*;
use crate::error::GsmiError;

pub fn fee_of(amount: u64) -> Result<u64> {
    Ok((amount as u128)
        .checked_mul(DEPOSIT_FEE_NUM as u128)
        .ok_or(GsmiError::MathOverflow)?
        .checked_div(DEPOSIT_FEE_DEN as u128)
        .ok_or(GsmiError::MathOverflow)? as u64)
}

pub fn nets_of(offered: [u64; BASKET_SIZE]) -> Result<([u64; BASKET_SIZE], [u64; BASKET_SIZE])> {
    let mut nets = [0u64; BASKET_SIZE];
    let mut fees = [0u64; BASKET_SIZE];
    for i in 0..BASKET_SIZE {
        require!(offered[i] > 0, GsmiError::ZeroAmount);
        fees[i] = fee_of(offered[i])?;
        nets[i] = offered[i]
            .checked_sub(fees[i])
            .ok_or(GsmiError::MathOverflow)?;
        require!(nets[i] > 0, GsmiError::ZeroAmount);
    }
    Ok((nets, fees))
}

/// Later mint. `books` is current vault inventory. `base_shares` is total_shares.
/// Returns (take per seat, shares out).
pub fn min_slice(
    nets: [u64; BASKET_SIZE],
    books: [u64; BASKET_SIZE],
    base_shares: u64,
) -> Result<([u64; BASKET_SIZE], u64)> {
    require!(base_shares > 0, GsmiError::InsufficientShares);
    let mut implied = [0u128; BASKET_SIZE];
    for i in 0..BASKET_SIZE {
        require!(books[i] > 0, GsmiError::ShapeMismatch);
        implied[i] = (nets[i] as u128)
            .checked_mul(base_shares as u128)
            .ok_or(GsmiError::MathOverflow)?
            .checked_div(books[i] as u128)
            .ok_or(GsmiError::MathOverflow)?;
        require!(implied[i] > 0, GsmiError::ShapeMismatch);
    }
    let mut slice = implied[0];
    for i in 1..BASKET_SIZE {
        if implied[i] < slice {
            slice = implied[i];
        }
    }
    require!(slice > 0 && slice <= u64::MAX as u128, GsmiError::MathOverflow);
    let slice = slice as u64;
    let mut take = [0u64; BASKET_SIZE];
    for i in 0..BASKET_SIZE {
        take[i] = (books[i] as u128)
            .checked_mul(slice as u128)
            .ok_or(GsmiError::MathOverflow)?
            .checked_div(base_shares as u128)
            .ok_or(GsmiError::MathOverflow)? as u64;
        require!(take[i] > 0, GsmiError::ShapeMismatch);
        require!(take[i] <= nets[i], GsmiError::ShapeMismatch);
    }
    Ok((take, slice))
}

pub fn redeem_out(
    books: [u64; BASKET_SIZE],
    shares: u64,
    total_shares: u64,
) -> Result<[u64; BASKET_SIZE]> {
    require!(shares > 0, GsmiError::ZeroAmount);
    require!(total_shares > 0, GsmiError::InsufficientShares);
    require!(shares <= total_shares, GsmiError::InsufficientShares);
    let mut out = [0u64; BASKET_SIZE];
    for i in 0..BASKET_SIZE {
        out[i] = (books[i] as u128)
            .checked_mul(shares as u128)
            .ok_or(GsmiError::MathOverflow)?
            .checked_div(total_shares as u128)
            .ok_or(GsmiError::MathOverflow)? as u64;
        require!(out[i] <= books[i], GsmiError::InsufficientAssets);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fee_is_69_per_100000() {
        assert_eq!(fee_of(100_000).unwrap(), 69);
        assert_eq!(fee_of(1_000_000).unwrap(), 690);
        assert_eq!(fee_of(69).unwrap(), 0);
        assert_eq!(fee_of(144_928).unwrap(), 100);
    }

    #[test]
    fn first_fill_books_net_not_offered() {
        let offered = [100_000u64; 8];
        let (nets, fees) = nets_of(offered).unwrap();
        assert_eq!(fees, [69u64; 8]);
        assert_eq!(nets, [99_931u64; 8]);
    }

    #[test]
    fn later_mint_follows_the_thin_seat() {
        // vault already holds uneven books after drift
        let books = [1000, 2000, 1000, 1000, 1000, 1000, 1000, 1000];
        let base = 1000u64;
        // offer plenty of every seat
        let nets = [10_000u64; 8];
        let (take, shares) = min_slice(nets, books, base).unwrap();
        // thinnest implied is seat 0 and 2-7 at 1000 book → 10_000*1000/1000 = 10_000
        // seat 1 is 10_000*1000/2000 = 5_000 — that is the slice
        assert_eq!(shares, 5_000);
        assert_eq!(take[0], 5_000);
        assert_eq!(take[1], 10_000);
        assert_eq!(take[2], 5_000);
    }

    #[test]
    fn later_mint_rejects_a_zero_book() {
        let books = [1000, 0, 1000, 1000, 1000, 1000, 1000, 1000];
        let nets = [100u64; 8];
        assert!(min_slice(nets, books, 1000).is_err());
    }

    #[test]
    fn burn_is_same_percent_of_each_book() {
        let books = [800, 400, 200, 100, 50, 25, 10, 8];
        let out = redeem_out(books, 250, 1000).unwrap();
        assert_eq!(out, [200, 100, 50, 25, 12, 6, 2, 2]);
    }

    #[test]
    fn full_burn_empties_the_books() {
        let books = [9_991u64; 8];
        let out = redeem_out(books, 1_000, 1_000).unwrap();
        assert_eq!(out, books);
    }

    #[test]
    fn dust_burn_can_round_to_zero_on_a_thin_seat() {
        let books = [8, 8, 8, 8, 8, 8, 8, 1];
        let out = redeem_out(books, 1, 10).unwrap();
        assert_eq!(out[0], 0);
        assert_eq!(out[7], 0);
    }
}
