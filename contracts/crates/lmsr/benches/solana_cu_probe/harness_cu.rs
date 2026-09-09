//! LiteSVM harness for the compute-unit probe (T04 item 4).
//!
//! Copied to `$HOME/gb-cu/harness/tests/cu.rs` by `run.sh`. Reads the probe's
//! `.so` path from `PROBE_SO`.

use litesvm::LiteSVM;
use solana_sdk::instruction::Instruction;
use solana_sdk::message::Message;
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::Keypair;
use solana_sdk::signer::Signer;
use solana_sdk::transaction::Transaction;
use std::str::FromStr;

const OPS: &[(u8, &str)] = &[
    (0, "cost              typical (b=1000 USDC)"),
    (1, "price_yes         typical"),
    (2, "buy_cost          typical"),
    (3, "sell_return       typical"),
    (4, "shares_for_cost   typical"),
    (5, "max_loss_bound"),
    (6, "cost              max skew, b=B_MIN"),
    (7, "price_yes         max skew, b=B_MIN"),
    (8, "buy_cost          max skew, b=B_MIN"),
    (9, "sell_return       max skew, b=B_MIN"),
    (10, "shares_for_cost   max skew, b=B_MIN"),
    (11, "buy_shares-shaped sfc + buy_cost + price_yes"),
    (12, "buy_shares-shaped WORST (max skew, b=B_MIN)"),
    (13, "  Fixed::exp        (x ~ -3)"),
    (14, "  Fixed::ln         (x ~ 1234)"),
    (15, "  Fixed::from_ratio (128-bit divide)"),
    (16, "  Fixed::expm1      (x ~ -3)"),
];

/// `ComputeBudgetInstruction::SetComputeUnitLimit` is discriminant `0x02`
/// followed by a little-endian `u32`. Hand-encoded so the harness does not have
/// to pull a second, version-skewed `solana-instruction` into the graph.
///
/// It is only here so that a 16-iteration probe run does not hit the 200k
/// default; it is present in **both** halves of every difference, so it costs
/// the measurement nothing.
fn cu_limit_ix(limit: u32) -> Instruction {
    let id = Pubkey::from_str("ComputeBudget111111111111111111111111111111").unwrap();
    let mut data = vec![2u8];
    data.extend_from_slice(&limit.to_le_bytes());
    Instruction::new_with_bytes(id, &data, vec![])
}

fn run(svm: &mut LiteSVM, pid: Pubkey, payer: &Keypair, op: u8, reps: u16, seed: u8) -> u64 {
    let data = vec![op, (reps & 0xff) as u8, (reps >> 8) as u8, seed];
    let ixs = vec![
        cu_limit_ix(1_400_000),
        Instruction::new_with_bytes(pid, &data, vec![]),
    ];
    let msg = Message::new(&ixs, Some(&payer.pubkey()));
    let tx = Transaction::new(&[payer], msg, svm.latest_blockhash());
    let meta = svm
        .send_transaction(tx)
        .unwrap_or_else(|e| panic!("op {op} reps {reps}: {e:?}"));
    meta.compute_units_consumed
}

#[test]
fn measure() {
    let so = std::env::var("PROBE_SO").expect("PROBE_SO");
    let mut svm = LiteSVM::new();
    let pid = Pubkey::new_unique();
    svm.add_program_from_file(pid, &so).expect("load .so");
    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 100_000_000_000).unwrap();

    let floor = run(&mut svm, pid, &payer, 200, 0, 1);
    println!("\nprobe transaction floor (cu-limit ix + entrypoint + deserialise): {floor} CU");
    println!("default per-instruction compute budget: 200000 CU\n");
    println!(
        "{:<48} {:>10} {:>10} {:>10} {:>14}",
        "op", "1 rep", "4 reps", "CU/call", "fit in 200k"
    );
    println!("{}", "-".repeat(96));
    for &(op, name) in OPS {
        let a = run(&mut svm, pid, &payer, op, 0, 1);
        let b1 = run(&mut svm, pid, &payer, op, 1, 1);
        let b4 = run(&mut svm, pid, &payer, op, 4, 1);
        let b16 = run(&mut svm, pid, &payer, op, 16, 1);
        let per = (b16 - a) as f64 / 16.0;
        // b1 and b4/4 must match per-call to well under 1%, or the difference
        // is picking up something other than the loop body.
        println!(
            "{name:<48} {:>10} {:>10} {per:>10.1} {:>14.1}",
            b1 - a,
            b4 - a,
            200_000.0 / per.max(1.0)
        );
    }
}
