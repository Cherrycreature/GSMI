use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
};
use anchor_spl::token::spl_token;
use anchor_spl::token_2022::spl_token_2022;
use crate::error::WrapError;

pub fn tokenkeg() -> Pubkey {
    spl_token::ID
}
pub fn token22() -> Pubkey {
    spl_token_2022::ID
}

pub fn read_ata(ai: &AccountInfo) -> Result<(Pubkey, Pubkey, u64)> {
    require!(
        *ai.owner == tokenkeg() || *ai.owner == token22(),
        WrapError::BadOut
    );
    let data = ai.try_borrow_data()?;
    require!(data.len() >= 72, WrapError::BadOut);
    let mint = Pubkey::new_from_array(data[0..32].try_into().unwrap());
    let owner = Pubkey::new_from_array(data[32..64].try_into().unwrap());
    let amount = u64::from_le_bytes(data[64..72].try_into().unwrap());
    Ok((mint, owner, amount))
}

fn transfer_ix(program: &Pubkey, from: &Pubkey, to: &Pubkey, authority: &Pubkey, amount: u64) -> Instruction {
    let mut data = Vec::with_capacity(9);
    data.push(3u8);
    data.extend_from_slice(&amount.to_le_bytes());
    Instruction {
        program_id: *program,
        accounts: vec![
            AccountMeta::new(*from, false),
            AccountMeta::new(*to, false),
            AccountMeta::new_readonly(*authority, true),
        ],
        data,
    }
}

pub fn transfer_seat<'info>(
    tokenkeg_ai: AccountInfo<'info>,
    token22_ai: AccountInfo<'info>,
    from: AccountInfo<'info>,
    to: AccountInfo<'info>,
    authority: AccountInfo<'info>,
    amount: u64,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    require!(from.owner == to.owner, WrapError::BadOut);
    let program = if *from.owner == tokenkeg() {
        tokenkeg_ai
    } else if *from.owner == token22() {
        token22_ai
    } else {
        return err!(WrapError::BadOut);
    };
    let ix = transfer_ix(program.key, from.key, to.key, authority.key, amount);
    invoke_signed(&ix, &[from, to, authority, program], signer_seeds).map_err(|_| error!(WrapError::BadOut))
}

fn close_ix(program: &Pubkey, account: &Pubkey, dest: &Pubkey, authority: &Pubkey) -> Instruction {
    Instruction {
        program_id: *program,
        accounts: vec![
            AccountMeta::new(*account, false),
            AccountMeta::new(*dest, false),
            AccountMeta::new_readonly(*authority, true),
        ],
        data: vec![9u8],
    }
}

/// Close an ATA. Rent goes to `dest`. Authority must sign (ticket or seat PDA).
pub fn close_ata<'info>(
    tokenkeg_ai: AccountInfo<'info>,
    token22_ai: AccountInfo<'info>,
    account: AccountInfo<'info>,
    dest: AccountInfo<'info>,
    authority: AccountInfo<'info>,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let program = if *account.owner == tokenkeg() {
        tokenkeg_ai
    } else if *account.owner == token22() {
        token22_ai
    } else {
        return err!(WrapError::BadOut);
    };
    let ix = close_ix(program.key, account.key, dest.key, authority.key);
    invoke_signed(&ix, &[account, dest, authority, program], signer_seeds)
        .map_err(|_| error!(WrapError::BadOut))
}
