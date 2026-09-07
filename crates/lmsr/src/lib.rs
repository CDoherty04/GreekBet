//! Minimal crate root.
//!
//! **This file is owned by T03**, which replaces it with the real public LMSR
//! API. T02 only needs the `#![no_std]` crate attribute and a `mod`
//! declaration here so that `fixed.rs` can compile and run its tests.
#![no_std]

#[cfg(test)]
extern crate std;

pub mod fixed;
