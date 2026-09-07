use crate::constants::{BASKET_SIZE, DEPOSIT_FEE_DEN, DEPOSIT_FEE_NUM};
use crate::error::GsmiError;
use anchor_lang::prelude::*;

/// Fee 69 / 100_000 of each offered pile. Net is what the book can take.
pub fn nets_of(offered: [u64; BASKET_SIZE]) -> Result<([u64; BASKET_SIZE], [u64; BASKET_SIZE])> {
    let mut nets = [0u64; BASKET_SIZE];
    let mut fees = [0u64; BASKET_SIZE];
    for i in 0..BASKET_SIZE {
        require!(offered[i] > 0, GsmiError::ZeroAmount);
        let fee = offered[i]
            .checked_mul(DEPOSIT_FEE_NUM)
            .ok_or(error!(GsmiError::MathOverflow))?
            / DEPOSIT_FEE_DEN;
        let net = offered[i]
            .checked_sub(fee)
            .ok_or(error!(GsmiError::MathOverflow))?;
        require!(net > 0, GsmiError::ZeroAmount);
        fees[i] = fee;
        nets[i] = net;
    }
    Ok((nets, fees))
}

/// Later mint. Shares limited by the thinnest seat vs the live book.
/// take[i] = shares_out * book[i] / base_shares.
pub fn min_slice(
    nets: [u64; BASKET_SIZE],
    books: [u64; BASKET_SIZE],
    base_shares: u64,
) -> Result<([u64; BASKET_SIZE], u64)> {
    require!(base_shares > 0, GsmiError::ZeroAmount);
    let mut shares_out = u64::MAX;
    for i in 0..BASKET_SIZE {
        require!(books[i] > 0, GsmiError::InsufficientAssets);
        let s = nets[i]
            .checked_mul(base_shares)
            .ok_or(error!(GsmiError::MathOverflow))?
            / books[i];
        if s < shares_out {
            shares_out = s;
        }
    }
    require!(shares_out > 0, GsmiError::InsufficientAssets);
    let mut take = [0u64; BASKET_SIZE];
    for i in 0..BASKET_SIZE {
        take[i] = shares_out
            .checked_mul(books[i])
            .ok_or(error!(GsmiError::MathOverflow))?
            / base_shares;
        require!(take[i] <= nets[i], GsmiError::InsufficientAssets);
        require!(take[i] > 0, GsmiError::InsufficientAssets);
    }
    Ok((take, shares_out))
}

/// Burn: same percent of each book.
pub fn redeem_out(
    books: [u64; BASKET_SIZE],
    shares: u64,
    total_shares: u64,
) -> Result<[u64; BASKET_SIZE]> {
    require!(shares > 0 && total_shares > 0, GsmiError::ZeroAmount);
    require!(shares <= total_shares, GsmiError::InsufficientShares);
    let mut out = [0u64; BASKET_SIZE];
    for i in 0..BASKET_SIZE {
        out[i] = (books[i] as u128)
            .checked_mul(shares as u128)
            .ok_or(error!(GsmiError::MathOverflow))?
            .checked_div(total_shares as u128)
            .ok_or(error!(GsmiError::MathOverflow))? as u64;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ones(v: u64) -> [u64; BASKET_SIZE] {
        [v; BASKET_SIZE]
    }

    #[test]
    fn fee_69_of_100000() {
        let (nets, fees) = nets_of(ones(100_000)).unwrap();
        assert_eq!(fees[0], 69);
        assert_eq!(nets[0], 99_931);
    }

    #[test]
    fn fee_rejects_zero() {
        assert!(nets_of(ones(0)).is_err());
    }

    #[test]
    fn first_fill_net_is_book_input() {
        let (nets, _) = nets_of(ones(1_000_000)).unwrap();
        assert_eq!(nets[0], 1_000_000 - 690);
    }

    #[test]
    fn min_slice_even_book() {
        let nets = ones(10_000);
        let books = ones(100_000);
        let (take, shares) = min_slice(nets, books, 1_000_000).unwrap();
        assert_eq!(shares, 100_000);
        assert_eq!(take[0], 10_000);
    }

    #[test]
    fn min_slice_thin_seat_limits() {
        let mut nets = ones(10_000);
        nets[7] = 1_000;
        let books = ones(100_000);
        let (take, shares) = min_slice(nets, books, 1_000_000).unwrap();
        assert_eq!(shares, 10_000);
        assert_eq!(take[0], 1_000);
        assert_eq!(take[7], 1_000);
    }

    #[test]
    fn redeem_half() {
        let out = redeem_out(ones(1_000), 500, 1_000).unwrap();
        assert_eq!(out[0], 500);
    }

    #[test]
    fn redeem_rejects_over_supply() {
        assert!(redeem_out(ones(1_000), 2_000, 1_000).is_err());
    }
}
