"""
GreekBet LMSR — high-precision Python reference implementation ("the oracle").

This module is an INDEPENDENT derivation from the formulas in
``docs/LMSR_ANCHOR_BUILD_PLAN.md`` §1.1 and the log-sum-exp stabilisation in
``docs/DESIGN_DECISIONS.md`` §D4.  It exists so the fixed-point Rust crate can be
validated against something that was not derived from the Rust code.  Nothing in
here may be ported from, or checked against, the Rust implementation.

--------------------------------------------------------------------------------
UNITS  (docs/DESIGN_DECISIONS.md D1)
--------------------------------------------------------------------------------
Every public function takes and returns plain Python ``int`` values expressed in
**6-decimal base units**: ``1_000_000`` base units == 1 USDC == 1 share.
Prices are also returned in base units, so ``500_000`` means a price of 0.5 and
``UNIT`` (== 1_000_000) means a price of 1.0.

--------------------------------------------------------------------------------
NUMERICAL FORM  (docs/DESIGN_DECISIONS.md D4)
--------------------------------------------------------------------------------
The cost function is *never* evaluated as ``b * ln(exp(q_yes/b) + exp(q_no/b))``.
It is always evaluated in log-sum-exp stabilised form::

    m    = max(q_yes, q_no)
    u_y  = exp((q_yes - m) / b)          # in (0, 1]
    u_n  = exp((q_no  - m) / b)          # in (0, 1]
    C    = m + b * ln(u_y + u_n)

Both exponent arguments are <= 0, so neither ``exp`` can overflow no matter how
large ``q`` is or how small ``b`` is.  Extreme skew makes one term underflow
towards zero, which is the numerically correct limit (price -> 0 or 1).

Trade costs are likewise NOT computed as ``round(C_new) - round(C_old)`` nor even
as a raw subtraction of two ~1e15-magnitude numbers.  They are computed in a
cancellation-free form (see ``buy_cost_exact`` / ``sell_return_exact``)::

    dC = (m_new - m_old) + b * ln(S_new / S_old)

where ``m_new - m_old`` is an *exact integer* and ``S_new / S_old`` is a ratio of
two numbers in [1, 2].

--------------------------------------------------------------------------------
ROUNDING POLICY  (frozen — the Rust implementation must match this exactly)
--------------------------------------------------------------------------------
Money never rounds in the user's favour, or the vault drains over many trades.

    cost()            floor  (truncate)  informational / state valuation
    price_yes()       floor  (truncate)  of price_yes * UNIT
    price_no()        = UNIT - price_yes()   (defined as the complement, so
                                             price_yes + price_no == UNIT holds
                                             EXACTLY, always)
    buy_cost()        CEIL   -> user pays at least the true cost
    sell_return()     FLOOR  -> user receives at most the true return
    shares_for_cost() FLOOR  -> user receives at most the true share count

CRITICAL for the Rust port: ``buy_cost`` and ``sell_return`` round the *exact
difference* once.  They are **not** ``cost(new) - cost(old)`` on already-rounded
costs; doing that would introduce a +/-1 base-unit error in the wrong direction.

--------------------------------------------------------------------------------
PRECISION
--------------------------------------------------------------------------------
``mpmath`` at ``mp.dps = 60`` (60 significant decimal digits).  Largest value
handled is ``C <= MAX_Q + B_MAX*ln 2 ~= 1.0007e15``, so 60 digits leaves ~45
decimal digits of headroom below the 1-base-unit rounding boundary.
"""

from __future__ import annotations

import mpmath as mp

__all__ = [
    "DECIMALS",
    "UNIT",
    "B_MIN",
    "B_MAX",
    "MAX_Q",
    "DPS",
    "YES",
    "NO",
    "OUTCOMES",
    "ROUNDING_POLICY",
    "PRECISION_INFO",
    "set_precision",
    "exact_str",
    "cost",
    "cost_exact",
    "price_yes",
    "price_yes_exact",
    "price_no",
    "price_no_exact",
    "buy_cost",
    "buy_cost_exact",
    "sell_return",
    "sell_return_exact",
    "shares_for_cost",
    "shares_for_cost_exact",
    "max_loss_bound",
    "max_loss_bound_exact",
]

# --------------------------------------------------------------------------- #
# Constants (docs/DESIGN_DECISIONS.md D1 + D4)
# --------------------------------------------------------------------------- #

DECIMALS: int = 6
UNIT: int = 1_000_000              # base units per 1 USDC / 1 share
B_MIN: int = 10_000_000            # 10 USDC
B_MAX: int = 1_000_000_000_000     # 1,000,000 USDC
MAX_Q: int = 1_000_000_000_000_000  # 1e9 shares

DPS: int = 60                      # mpmath significant decimal digits
mp.mp.dps = DPS

YES: str = "yes"
NO: str = "no"
OUTCOMES = (YES, NO)

ROUNDING_POLICY = {
    "cost": "floor",
    "price_yes": "floor",
    "price_no": "complement",          # UNIT - price_yes
    "buy_cost": "ceil",
    "sell_return": "floor",
    "shares_for_cost": "floor",
    "note": (
        "buy_cost and sell_return round the exact trade difference once; they are "
        "NOT cost(new) - cost(old) computed on already-rounded costs."
    ),
}

PRECISION_INFO = {
    "library": "mpmath",
    "version": getattr(mp, "__version__", "unknown"),
    "dps": DPS,
    "form": "log-sum-exp stabilised",
}


def set_precision(dps: int) -> None:
    """Override the working precision (used by the self-tests to prove stability)."""
    global DPS
    DPS = int(dps)
    mp.mp.dps = DPS
    PRECISION_INFO["dps"] = DPS


# --------------------------------------------------------------------------- #
# Validation helpers
# --------------------------------------------------------------------------- #


def _check_int(name: str, value) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise TypeError(f"{name} must be a plain int in base units, got {type(value).__name__}")
    return value


def _check_b(b) -> int:
    _check_int("b", b)
    if not (B_MIN <= b <= B_MAX):
        raise ValueError(f"b={b} outside [B_MIN={B_MIN}, B_MAX={B_MAX}]")
    return b


def _check_q(name: str, q) -> int:
    _check_int(name, q)
    if not (0 <= q <= MAX_Q):
        raise ValueError(f"{name}={q} outside [0, MAX_Q={MAX_Q}]")
    return q


def _check_outcome(outcome) -> str:
    if not isinstance(outcome, str) or outcome.lower() not in OUTCOMES:
        raise ValueError(f"outcome must be one of {OUTCOMES!r}, got {outcome!r}")
    return outcome.lower()


def _check_state(q_yes, q_no, b):
    _check_q("q_yes", q_yes)
    _check_q("q_no", q_no)
    _check_b(b)


# --------------------------------------------------------------------------- #
# Rounding helpers (exact integer conversion from an mpf)
# --------------------------------------------------------------------------- #


def _floor_int(x: mp.mpf) -> int:
    return int(mp.floor(x))


def _ceil_int(x: mp.mpf) -> int:
    return int(mp.ceil(x))


def exact_str(x, digits: int = 36) -> str:
    """Render an mpf as a plain decimal string with `digits` significant digits.

    Used for the ``*_exact`` fields in the golden vectors so that a consumer can
    do tolerance-based comparison rather than exact-integer comparison.
    """
    return mp.nstr(mp.mpf(x), digits, strip_zeros=False)


# --------------------------------------------------------------------------- #
# Log-sum-exp core
# --------------------------------------------------------------------------- #


def _terms(q_yes: int, q_no: int, b: int):
    """Return ``(m, u_yes, u_no)`` with ``m = max(q_yes, q_no)`` an exact int and
    ``u_i = exp((q_i - m) / b)`` in (0, 1] (at least one of them exactly 1)."""
    m = q_yes if q_yes >= q_no else q_no
    bb = mp.mpf(b)
    u_yes = mp.exp(mp.mpf(q_yes - m) / bb)
    u_no = mp.exp(mp.mpf(q_no - m) / bb)
    return m, u_yes, u_no


# --------------------------------------------------------------------------- #
# C(q_yes, q_no)
# --------------------------------------------------------------------------- #


def cost_exact(q_yes: int, q_no: int, b: int) -> mp.mpf:
    """Exact (60-digit) LMSR cost ``C = b ln(e^(q_y/b) + e^(q_n/b))`` in base units."""
    _check_state(q_yes, q_no, b)
    m, u_yes, u_no = _terms(q_yes, q_no, b)
    return mp.mpf(m) + mp.mpf(b) * mp.log(u_yes + u_no)


def cost(q_yes: int, q_no: int, b: int) -> int:
    """C(q_yes, q_no) in base units, rounded **DOWN** (floor)."""
    return _floor_int(cost_exact(q_yes, q_no, b))


# --------------------------------------------------------------------------- #
# Prices
# --------------------------------------------------------------------------- #


def price_yes_exact(q_yes: int, q_no: int, b: int) -> mp.mpf:
    """Exact YES price as a fraction in [0, 1]."""
    _check_state(q_yes, q_no, b)
    _m, u_yes, u_no = _terms(q_yes, q_no, b)
    return u_yes / (u_yes + u_no)


def price_no_exact(q_yes: int, q_no: int, b: int) -> mp.mpf:
    """Exact NO price as a fraction in [0, 1]."""
    return mp.mpf(1) - price_yes_exact(q_yes, q_no, b)


def price_yes(q_yes: int, q_no: int, b: int) -> int:
    """YES price in base units (0 .. UNIT), rounded **DOWN** (floor)."""
    p = price_yes_exact(q_yes, q_no, b) * UNIT
    v = _floor_int(p)
    # exp/ln can never push the ratio outside [0, 1], but clamp defensively so the
    # complement below can never produce a negative NO price.
    return 0 if v < 0 else (UNIT if v > UNIT else v)


def price_no(q_yes: int, q_no: int, b: int) -> int:
    """NO price in base units, defined as ``UNIT - price_yes`` so the invariant
    ``price_yes + price_no == UNIT`` holds exactly for every input."""
    return UNIT - price_yes(q_yes, q_no, b)


# --------------------------------------------------------------------------- #
# Trades
# --------------------------------------------------------------------------- #


def _apply(q_yes: int, q_no: int, outcome: str, delta: int):
    if outcome == YES:
        return q_yes + delta, q_no
    return q_yes, q_no + delta


def buy_cost_exact(q_yes: int, q_no: int, b: int, outcome: str, shares: int) -> mp.mpf:
    """Exact collateral required to buy ``shares`` of ``outcome``.

    Computed cancellation-free as ``(m' - m) + b*ln(S'/S)``, never as a raw
    difference of two ~1e15 magnitude cost values.
    """
    _check_state(q_yes, q_no, b)
    outcome = _check_outcome(outcome)
    _check_int("shares", shares)
    if shares < 0:
        raise ValueError(f"shares={shares} must be >= 0")
    if shares == 0:
        return mp.mpf(0)

    n_yes, n_no = _apply(q_yes, q_no, outcome, shares)
    _check_q("q_yes after buy", n_yes)
    _check_q("q_no after buy", n_no)

    m0, uy0, un0 = _terms(q_yes, q_no, b)
    m1, uy1, un1 = _terms(n_yes, n_no, b)
    return mp.mpf(m1 - m0) + mp.mpf(b) * mp.log((uy1 + un1) / (uy0 + un0))


def buy_cost(q_yes: int, q_no: int, b: int, outcome: str, shares: int) -> int:
    """Collateral **in** for buying ``shares`` of ``outcome``, rounded **UP** (ceil)."""
    return _ceil_int(buy_cost_exact(q_yes, q_no, b, outcome, shares))


def sell_return_exact(q_yes: int, q_no: int, b: int, outcome: str, shares: int) -> mp.mpf:
    """Exact collateral returned for selling ``shares`` of ``outcome``."""
    _check_state(q_yes, q_no, b)
    outcome = _check_outcome(outcome)
    _check_int("shares", shares)
    if shares < 0:
        raise ValueError(f"shares={shares} must be >= 0")
    held = q_yes if outcome == YES else q_no
    if shares > held:
        raise ValueError(f"cannot sell {shares} of {outcome}: supply is only {held}")
    if shares == 0:
        return mp.mpf(0)

    n_yes, n_no = _apply(q_yes, q_no, outcome, -shares)
    m0, uy0, un0 = _terms(q_yes, q_no, b)
    m1, uy1, un1 = _terms(n_yes, n_no, b)
    return mp.mpf(m0 - m1) + mp.mpf(b) * mp.log((uy0 + un0) / (uy1 + un1))


def sell_return(q_yes: int, q_no: int, b: int, outcome: str, shares: int) -> int:
    """Collateral **out** for selling ``shares`` of ``outcome``, rounded **DOWN**."""
    v = _floor_int(sell_return_exact(q_yes, q_no, b, outcome, shares))
    return 0 if v < 0 else v


# --------------------------------------------------------------------------- #
# Inverse: shares obtainable for a given collateral spend
# --------------------------------------------------------------------------- #
#
# CLOSED FORM (derived here, not bisected).
#
#   Solve  C(q_out + d, q_other) - C(q_out, q_other) = X  for d.
#
#     b ln(e^((q_out+d)/b) + e^(q_other/b)) = C0 + X
#     e^((q_out+d)/b)                      = e^((C0+X)/b) - e^(q_other/b)
#     d = b ln( e^((C0+X)/b) - e^(q_other/b) ) - q_out
#
#   Substituting the stabilised C0 = m + b ln(u_out + u_other) and factoring
#   e^(m/b) out of the bracket:
#
#     d = (m - q_out) + b * ln( (u_out + u_other) * e^(X/b) - u_other )
#
#   Pulling e^(X/b) out of the logarithm removes the only term that can grow
#   without bound (X/b reaches 1e8 at the corners of the allowed domain):
#
#     d = (m - q_out) + X + b * ln( u_out + u_other * (1 - e^(-X/b)) )
#
#   The logarithm's argument now lies in (0, 2] and every exponent is <= 0, so
#   this evaluates safely everywhere in the domain.  Sanity checks:
#     X = 0                -> d = (m - q_out) + b*ln(u_out) = 0
#     q_yes = q_no = 0     -> d = X + b*ln(2 - e^(-X/b))    (matches direct solve)
#     X/b -> inf           -> d -> (m - q_out) + X + b*ln(u_out + u_other)
# --------------------------------------------------------------------------- #


def shares_for_cost_exact(q_yes: int, q_no: int, b: int, outcome: str, collateral: int) -> mp.mpf:
    """Exact number of ``outcome`` shares purchasable with ``collateral``.

    Closed form -- no bisection.  See the derivation above.
    """
    _check_state(q_yes, q_no, b)
    outcome = _check_outcome(outcome)
    _check_int("collateral", collateral)
    if collateral < 0:
        raise ValueError(f"collateral={collateral} must be >= 0")
    if collateral == 0:
        return mp.mpf(0)

    m = q_yes if q_yes >= q_no else q_no
    bb = mp.mpf(b)
    q_out = q_yes if outcome == YES else q_no
    q_other = q_no if outcome == YES else q_yes

    u_out = mp.exp(mp.mpf(q_out - m) / bb)
    u_other = mp.exp(mp.mpf(q_other - m) / bb)
    t = mp.mpf(collateral) / bb
    # -expm1(-t) == 1 - e^(-t), accurate for tiny t as well.
    arg = u_out + u_other * (-mp.expm1(-t))
    return mp.mpf(m - q_out) + mp.mpf(collateral) + bb * mp.log(arg)


def shares_for_cost(q_yes: int, q_no: int, b: int, outcome: str, collateral: int) -> int:
    """Shares received for spending ``collateral``, rounded **DOWN** (floor).

    Note: the returned share count is the pure mathematical answer.  It is NOT
    clamped to ``MAX_Q`` -- at extreme skew a tiny collateral amount legitimately
    buys more than ``MAX_Q`` shares of the near-worthless side, and it is the
    *program's* job to reject that trade.  Callers should check
    ``q + shares <= MAX_Q`` themselves.
    """
    v = _floor_int(shares_for_cost_exact(q_yes, q_no, b, outcome, collateral))
    return 0 if v < 0 else v


# --------------------------------------------------------------------------- #
# Max-loss bound
# --------------------------------------------------------------------------- #


def max_loss_bound_exact(b: int) -> mp.mpf:
    """The LMSR market-maker max subsidy, ``b * ln 2``, in base units."""
    _check_b(b)
    return mp.mpf(b) * mp.log(2)


def max_loss_bound(b: int) -> int:
    """``b * ln 2`` in base units, rounded **UP** (ceil) -- it is an upper bound,
    so rounding up keeps it a valid bound."""
    return _ceil_int(max_loss_bound_exact(b))
