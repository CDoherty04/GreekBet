//! Shared helpers for the T04 integration suites.
//!
//! Deliberately self-contained: the `lmsr` crate is dependency-free by design,
//! and pulling `serde_json` in only to read four fixture files would put a
//! transitive dependency tree behind every `cargo test`. The parser below is
//! ~200 lines and reads the exact subset of JSON that
//! `reference/gen_vectors.py` emits.
//!
//! Two things about the fixture encoding drive the design (see
//! `reference/README.md`):
//!
//! * every integer field is a **decimal string** — `q` reaches `1e15` and
//!   `cost` `~1.0007e15`, both past `2^53`, so a `f64` round trip would corrupt
//!   them;
//! * every `*_exact` field is a **36-significant-digit decimal string**, not an
//!   integer, and may be as small as `7.12e-218`.
//!
//! `Dec` therefore carries exact values as an `i128` scaled by `10^12`
//! (`DEC_SCALE`), which spans `[-1.7e26, 1.7e26]` base units with a resolution
//! of `1e-12` base units. Both are far outside anything the LMSR domain can
//! produce (`|value| <= 1.0007e15`), so no measurement below is limited by the
//! helper.

#![allow(dead_code)]

use std::collections::BTreeMap;
use std::fmt;
use std::path::PathBuf;

// ---------------------------------------------------------------------------
// Minimal JSON
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    /// Numbers are kept as their source text: the fixtures only use JSON
    /// numbers for small counts (`index`, `step_count`, `count`).
    Num(String),
    Str(String),
    Arr(Vec<Json>),
    Obj(BTreeMap<String, Json>),
}

impl Json {
    pub fn get(&self, key: &str) -> Option<&Json> {
        match self {
            Json::Obj(m) => m.get(key),
            _ => None,
        }
    }

    pub fn arr(&self) -> &[Json] {
        match self {
            Json::Arr(v) => v,
            _ => panic!("expected JSON array, got {self:?}"),
        }
    }

    pub fn as_str(&self) -> &str {
        match self {
            Json::Str(s) => s,
            Json::Num(s) => s,
            _ => panic!("expected JSON string, got {self:?}"),
        }
    }

    pub fn as_bool(&self) -> bool {
        match self {
            Json::Bool(b) => *b,
            _ => panic!("expected JSON bool, got {self:?}"),
        }
    }

    pub fn is_null(&self) -> bool {
        matches!(self, Json::Null)
    }

    /// A `u64` from a decimal-string field. Panics with the field name on a
    /// malformed value — a corrupt fixture must not silently pass.
    pub fn u64_at(&self, key: &str) -> u64 {
        let v = self
            .get(key)
            .unwrap_or_else(|| panic!("missing field {key:?} in {self:?}"));
        v.as_str()
            .parse::<u64>()
            .unwrap_or_else(|e| panic!("field {key:?} = {:?}: {e}", v.as_str()))
    }

    pub fn usize_at(&self, key: &str) -> usize {
        self.get(key)
            .unwrap_or_else(|| panic!("missing field {key:?}"))
            .as_str()
            .parse::<usize>()
            .expect("usize field")
    }

    /// A real JSON boolean field (`exceeds_max_q`, `holds`).
    pub fn as_bool_at(&self, key: &str) -> bool {
        self.get(key)
            .unwrap_or_else(|| panic!("missing field {key:?}"))
            .as_bool()
    }

    pub fn str_at(&self, key: &str) -> &str {
        self.get(key)
            .unwrap_or_else(|| panic!("missing field {key:?}"))
            .as_str()
    }

    /// A high-precision `*_exact` field.
    pub fn dec_at(&self, key: &str) -> Dec {
        Dec::parse(
            self.get(key)
                .unwrap_or_else(|| panic!("missing field {key:?}"))
                .as_str(),
        )
    }

    pub fn opt(&self, key: &str) -> Option<&Json> {
        match self.get(key) {
            None | Some(Json::Null) => None,
            some => some,
        }
    }
}

pub fn parse_json(src: &str) -> Json {
    let b = src.as_bytes();
    let mut p = Parser { b, i: 0 };
    p.ws();
    let v = p.value();
    p.ws();
    assert!(p.i == b.len(), "trailing bytes at offset {}", p.i);
    v
}

struct Parser<'a> {
    b: &'a [u8],
    i: usize,
}

impl<'a> Parser<'a> {
    fn ws(&mut self) {
        while self.i < self.b.len() && matches!(self.b[self.i], b' ' | b'\t' | b'\n' | b'\r') {
            self.i += 1;
        }
    }

    fn eat(&mut self, c: u8) {
        assert!(
            self.i < self.b.len() && self.b[self.i] == c,
            "expected {:?} at offset {}",
            c as char,
            self.i
        );
        self.i += 1;
    }

    fn value(&mut self) -> Json {
        match self.b[self.i] {
            b'{' => self.object(),
            b'[' => self.array(),
            b'"' => Json::Str(self.string()),
            b't' => {
                self.lit(b"true");
                Json::Bool(true)
            }
            b'f' => {
                self.lit(b"false");
                Json::Bool(false)
            }
            b'n' => {
                self.lit(b"null");
                Json::Null
            }
            _ => self.number(),
        }
    }

    fn lit(&mut self, s: &[u8]) {
        assert!(self.b[self.i..].starts_with(s), "bad literal at {}", self.i);
        self.i += s.len();
    }

    fn number(&mut self) -> Json {
        let start = self.i;
        while self.i < self.b.len()
            && matches!(self.b[self.i], b'-' | b'+' | b'.' | b'e' | b'E' | b'0'..=b'9')
        {
            self.i += 1;
        }
        assert!(self.i > start, "bad number at {start}");
        Json::Num(String::from_utf8(self.b[start..self.i].to_vec()).expect("ascii number"))
    }

    fn string(&mut self) -> String {
        self.eat(b'"');
        let mut out = String::new();
        loop {
            let c = self.b[self.i];
            self.i += 1;
            match c {
                b'"' => return out,
                b'\\' => {
                    let e = self.b[self.i];
                    self.i += 1;
                    out.push(match e {
                        b'"' => '"',
                        b'\\' => '\\',
                        b'/' => '/',
                        b'b' => '\u{8}',
                        b'f' => '\u{c}',
                        b'n' => '\n',
                        b'r' => '\r',
                        b't' => '\t',
                        b'u' => {
                            let hex = std::str::from_utf8(&self.b[self.i..self.i + 4]).unwrap();
                            self.i += 4;
                            char::from_u32(u32::from_str_radix(hex, 16).unwrap()).unwrap()
                        }
                        other => panic!("bad escape {:?}", other as char),
                    });
                }
                _ => {
                    // The fixtures are UTF-8; copy the raw byte run.
                    let s = self.i - 1;
                    let mut e = self.i;
                    while self.b[e] != b'"' && self.b[e] != b'\\' {
                        e += 1;
                    }
                    out.push_str(std::str::from_utf8(&self.b[s..e]).expect("utf8"));
                    self.i = e;
                }
            }
        }
    }

    fn array(&mut self) -> Json {
        self.eat(b'[');
        let mut v = Vec::new();
        self.ws();
        if self.b[self.i] == b']' {
            self.i += 1;
            return Json::Arr(v);
        }
        loop {
            self.ws();
            v.push(self.value());
            self.ws();
            match self.b[self.i] {
                b',' => self.i += 1,
                b']' => {
                    self.i += 1;
                    return Json::Arr(v);
                }
                c => panic!("bad array separator {:?} at {}", c as char, self.i),
            }
        }
    }

    fn object(&mut self) -> Json {
        self.eat(b'{');
        let mut m = BTreeMap::new();
        self.ws();
        if self.b[self.i] == b'}' {
            self.i += 1;
            return Json::Obj(m);
        }
        loop {
            self.ws();
            let k = self.string();
            self.ws();
            self.eat(b':');
            self.ws();
            let v = self.value();
            m.insert(k, v);
            self.ws();
            match self.b[self.i] {
                b',' => self.i += 1,
                b'}' => {
                    self.i += 1;
                    return Json::Obj(m);
                }
                c => panic!("bad object separator {:?} at {}", c as char, self.i),
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Exact decimals
// ---------------------------------------------------------------------------

/// `10^12`: the fixed scale `Dec` carries.
pub const DEC_SCALE: i128 = 1_000_000_000_000;

/// A `*_exact` fixture value, held as `round(value * 10^12)`.
///
/// Saturating rather than wrapping at both ends: an input of `7.12e-218`
/// becomes `0`, and nothing in the LMSR domain approaches the upper limit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Dec(pub i128);

impl Dec {
    pub fn parse(s: &str) -> Dec {
        let s = s.trim();
        let (neg, s) = match s.as_bytes().first() {
            Some(b'-') => (true, &s[1..]),
            Some(b'+') => (false, &s[1..]),
            _ => (false, s),
        };
        let (mant, exp) = match s.find(['e', 'E']) {
            Some(i) => (&s[..i], s[i + 1..].parse::<i32>().expect("exponent")),
            None => (s, 0),
        };
        let (int_part, frac_part) = match mant.find('.') {
            Some(i) => (&mant[..i], &mant[i + 1..]),
            None => (mant, ""),
        };

        // value == <all digits concatenated> * 10^(exp - frac_len).
        // Leading zeros contribute nothing to that integer, so they are
        // skipped without any exponent adjustment; digits past the 30th
        // significant one are dropped and paid for with `dropped`. Thirty
        // significant digits is 12 more than the fixtures' own 36-digit
        // strings need once scaled to `1e-12` base units.
        let mut digits: i128 = 0;
        let mut used = 0u32;
        let mut dropped: i32 = 0;
        for c in int_part.bytes().chain(frac_part.bytes()) {
            assert!(c.is_ascii_digit(), "bad decimal {s:?}");
            let d = i128::from(c - b'0');
            if used == 0 && d == 0 {
                continue;
            }
            if used < 30 {
                digits = digits * 10 + d;
                used += 1;
            } else {
                dropped += 1;
            }
        }
        let frac_len = frac_part.len() as i32;
        // value = digits * 10^(exp - frac_len + dropped)
        let mut shift = exp - frac_len + dropped + 12; // + log10(DEC_SCALE)
        if digits == 0 {
            return Dec(0);
        }
        let mut v = digits;
        while shift > 0 {
            match v.checked_mul(10) {
                Some(n) => {
                    v = n;
                    shift -= 1;
                }
                None => return Dec(if neg { i128::MIN } else { i128::MAX }),
            }
        }
        while shift < 0 {
            if v == 0 {
                break;
            }
            // round half away from zero on the last division only
            if shift == -1 {
                v = (v + 5) / 10;
            } else {
                v /= 10;
            }
            shift += 1;
        }
        Dec(if neg { -v } else { v })
    }

    pub fn from_base_units(n: u64) -> Dec {
        Dec(i128::from(n) * DEC_SCALE)
    }

    /// `self` as base units, rounded toward negative infinity.
    pub fn floor_units(self) -> i128 {
        self.0.div_euclid(DEC_SCALE)
    }

    pub fn ceil_units(self) -> i128 {
        -((-self.0).div_euclid(DEC_SCALE))
    }

    /// `got - self`, in base units, as a `f64` **for reporting only**. Every
    /// assertion in the suites compares `Dec` values directly.
    pub fn err_units(self, got: u64) -> f64 {
        (Dec::from_base_units(got).0 - self.0) as f64 / DEC_SCALE as f64
    }

    pub fn to_f64(self) -> f64 {
        self.0 as f64 / DEC_SCALE as f64
    }
}

impl fmt::Display for Dec {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.to_f64())
    }
}

// ---------------------------------------------------------------------------
// Vector loading
// ---------------------------------------------------------------------------

pub fn vectors_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("reference")
        .join("vectors")
}

pub const VECTOR_FILES: [&str; 4] = ["grid.json", "edge.json", "trades.json", "invariants.json"];

pub struct VectorFile {
    pub name: String,
    pub kind: String,
    pub count: usize,
    pub cases: Vec<Json>,
}

pub fn load_vectors(name: &str) -> VectorFile {
    let path = vectors_dir().join(name);
    let src = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()));
    let doc = parse_json(&src);
    assert_eq!(
        doc.str_at("schema"),
        "greekbet.lmsr.vectors.v1",
        "{name}: unexpected schema"
    );
    // The suites assume the frozen domain constants; a fixture regenerated
    // against different ones must not be compared silently.
    let c = doc.get("constants").expect("constants envelope");
    assert_eq!(c.u64_at("UNIT"), lmsr::UNIT);
    assert_eq!(c.u64_at("B_MIN"), lmsr::B_MIN);
    assert_eq!(c.u64_at("B_MAX"), lmsr::B_MAX);
    assert_eq!(c.u64_at("MAX_Q"), lmsr::MAX_Q);

    let count = doc.usize_at("count");
    let cases = doc.get("cases").expect("cases").arr().to_vec();
    assert_eq!(cases.len(), count, "{name}: count/cases mismatch");
    VectorFile {
        name: name.to_string(),
        kind: doc.str_at("kind").to_string(),
        count,
        cases,
    }
}

pub fn outcome_of(s: &str) -> lmsr::Outcome {
    match s {
        "yes" => lmsr::Outcome::Yes,
        "no" => lmsr::Outcome::No,
        other => panic!("bad outcome {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// Skew
// ---------------------------------------------------------------------------

/// Skew below which the Q64.64 implementation and the 60-digit oracle must
/// agree **exactly**, mirroring `lmsr.rs`'s own `EXACT_SKEW_LIMIT`.
///
/// T03 measured the first disagreement over all 3,988 committed vectors at
/// skew 59; 48 is the asserted margin. A disagreement below it is a genuine
/// regression, not oracle noise.
pub const EXACT_SKEW_LIMIT: u128 = 48;

/// `|q_yes - q_no| / b`, as an exact rational comparison against `limit`.
pub fn within_exact_range(q_yes: u64, q_no: u64, b: u64) -> bool {
    let d = u128::from(q_yes.max(q_no) - q_yes.min(q_no));
    d < EXACT_SKEW_LIMIT * u128::from(b)
}

/// `|q_yes - q_no| / b` as a float, for reporting.
pub fn skew(q_yes: u64, q_no: u64, b: u64) -> f64 {
    (q_yes.max(q_no) - q_yes.min(q_no)) as f64 / b as f64
}

/// Identifies one comparison: which case, which function, and the market state
/// whose skew decides which half of the envelope applies.
///
/// A trade touches *two* states. [`Ctx::trade`] keeps the more skewed of the
/// two, because that is the one whose minority weight has underflowed — the
/// exact-agreement guarantee can only be demanded when **every** state involved
/// is inside the exact range.
pub struct Ctx<'a> {
    pub id: &'a str,
    pub what: &'a str,
    pub q_yes: u64,
    pub q_no: u64,
    pub b: u64,
}

impl<'a> Ctx<'a> {
    pub fn state(id: &'a str, what: &'a str, q_yes: u64, q_no: u64, b: u64) -> Self {
        Ctx {
            id,
            what,
            q_yes,
            q_no,
            b,
        }
    }

    /// The more skewed of the two states a trade moves between.
    #[allow(clippy::too_many_arguments)]
    pub fn trade(
        id: &'a str,
        what: &'a str,
        q_yes0: u64,
        q_no0: u64,
        q_yes1: u64,
        q_no1: u64,
        b: u64,
    ) -> Self {
        let d0 = q_yes0.max(q_no0) - q_yes0.min(q_no0);
        let d1 = q_yes1.max(q_no1) - q_yes1.min(q_no1);
        if d1 > d0 {
            Ctx::state(id, what, q_yes1, q_no1, b)
        } else {
            Ctx::state(id, what, q_yes0, q_no0, b)
        }
    }

    pub fn skew(&self) -> f64 {
        skew(self.q_yes, self.q_no, self.b)
    }

    pub fn exact_required(&self) -> bool {
        within_exact_range(self.q_yes, self.q_no, self.b)
    }
}

// ---------------------------------------------------------------------------
// Disagreement bookkeeping
// ---------------------------------------------------------------------------

#[derive(Debug, Default)]
pub struct Stats {
    pub checks: u64,
    pub disagreements: u64,
    pub max_abs_delta: i128,
    /// Smallest skew at which any disagreement was seen.
    pub min_bad_skew: f64,
    pub worst_id: String,
    /// Worst `|got - exact_ideal|` seen, in base units (reporting only).
    pub max_exact_err: f64,
    pub max_exact_err_id: String,
}

impl Stats {
    pub fn new() -> Self {
        Stats {
            min_bad_skew: f64::INFINITY,
            ..Default::default()
        }
    }

    /// Record one comparison and enforce the T04 envelope:
    /// exact below [`EXACT_SKEW_LIMIT`], `<= 1` base unit above it.
    pub fn check(&mut self, ctx: &Ctx<'_>, got: u64, want: u64) {
        self.checks += 1;
        if got == want {
            return;
        }
        let Ctx {
            id,
            what,
            q_yes,
            q_no,
            b,
        } = *ctx;
        let delta = i128::from(got) - i128::from(want);
        assert!(
            !ctx.exact_required(),
            "REGRESSION {id}: {what} = {got}, oracle {want} (delta {delta}) at skew {:.4} \
             (q_yes={q_yes} q_no={q_no} b={b}) — inside the exact-agreement range (< {})",
            ctx.skew(),
            EXACT_SKEW_LIMIT
        );
        assert!(
            delta.abs() <= 1,
            "REGRESSION {id}: {what} = {got}, oracle {want} (delta {delta}) at skew {:.4} \
             (q_yes={q_yes} q_no={q_no} b={b}) — extreme skew may cost 1 base unit, never more",
            ctx.skew()
        );
        self.disagreements += 1;
        let s = ctx.skew();
        if s < self.min_bad_skew {
            self.min_bad_skew = s;
            self.worst_id = id.to_string();
        }
        if delta.abs() > self.max_abs_delta {
            self.max_abs_delta = delta.abs();
        }
    }

    /// Fold another `Stats` in (per-file into a grand total).
    pub fn merge(&mut self, other: &Stats) {
        self.checks += other.checks;
        self.disagreements += other.disagreements;
        if other.max_abs_delta > self.max_abs_delta {
            self.max_abs_delta = other.max_abs_delta;
        }
        if other.min_bad_skew < self.min_bad_skew {
            self.min_bad_skew = other.min_bad_skew;
            self.worst_id = other.worst_id.clone();
        }
        if other.max_exact_err > self.max_exact_err {
            self.max_exact_err = other.max_exact_err;
            self.max_exact_err_id = other.max_exact_err_id.clone();
        }
    }

    /// Track the error against the unrounded oracle value (reporting only).
    pub fn note_exact(&mut self, id: &str, got: u64, exact: Dec) {
        let e = exact.err_units(got).abs();
        if e > self.max_exact_err {
            self.max_exact_err = e;
            self.max_exact_err_id = id.to_string();
        }
    }

    pub fn report(&self, name: &str) {
        let skew_s = if self.min_bad_skew.is_finite() {
            format!("{:.2} ({})", self.min_bad_skew, self.worst_id)
        } else {
            "-".to_string()
        };
        println!(
            "  {name:<18} checks {:>6}  disagreements {:>4}  max|delta| {:>2}  first-bad-skew {skew_s:<24} \
             max|got-exact| {:.6} ({})",
            self.checks,
            self.disagreements,
            self.max_abs_delta,
            self.max_exact_err,
            if self.max_exact_err_id.is_empty() { "-" } else { &self.max_exact_err_id }
        );
    }
}

// ---------------------------------------------------------------------------
// Extrema tracking (reporting)
// ---------------------------------------------------------------------------

/// Remembers the largest value ever offered, with the input that produced it.
#[derive(Debug, Default)]
pub struct WorstMax {
    pub value: i128,
    pub label: String,
    pub seen: bool,
}

impl WorstMax {
    pub fn offer(&mut self, value: i128, label: impl FnOnce() -> String) {
        if !self.seen || value > self.value {
            self.value = value;
            self.label = label();
            self.seen = true;
        }
    }
}

/// Remembers the smallest value ever offered, with the input that produced it.
#[derive(Debug, Default)]
pub struct WorstMin {
    pub value: i128,
    pub label: String,
    pub seen: bool,
}

impl WorstMin {
    pub fn offer(&mut self, value: i128, label: impl FnOnce() -> String) {
        if !self.seen || value < self.value {
            self.value = value;
            self.label = label();
            self.seen = true;
        }
    }
}

// ---------------------------------------------------------------------------
// Panic capture
// ---------------------------------------------------------------------------

/// Run `f`, converting a panic into `Err(message)`.
///
/// The boundary suite's contract is *"every input returns `Ok` or an
/// `LmsrError`; a panic is a failure"*. `catch_unwind` is what turns "the test
/// binary died somewhere inside a 400k-case loop" into "case
/// (q_yes=…, b=…) panicked with …", which is the difference between a usable
/// bug report and a stack trace.
///
/// The panic hook is deliberately **not** swapped out: `libtest` installs its
/// own to capture per-test output, and replacing it would throw away the
/// message of any genuine assertion failure in the surrounding test. A caught
/// panic therefore also prints its own `thread … panicked at …` line, which is
/// extra evidence, and only ever appears on a run that is already failing.
pub fn catch<T>(f: impl FnOnce() -> T + std::panic::UnwindSafe) -> std::result::Result<T, String> {
    std::panic::catch_unwind(f).map_err(|e| {
        if let Some(s) = e.downcast_ref::<&str>() {
            (*s).to_string()
        } else if let Some(s) = e.downcast_ref::<String>() {
            s.clone()
        } else {
            "<non-string panic payload>".to_string()
        }
    })
}
