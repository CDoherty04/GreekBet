"""
Self-tests for the LMSR reference oracle.

A broken oracle is worse than no oracle, so these tests check the reference
against mathematical identities that do not depend on the reference being right:
price/cost duality, exact price complementarity, monotonicity, the b*ln2 subsidy
bound, no-arbitrage on a buy/sell round trip, and -- most importantly -- the
closed-form ``shares_for_cost`` is cross-checked against an independent integer
bisection of ``buy_cost_exact``.

Run:  python reference/test_ref.py
Exit code 0 == all passed.  No third-party test runner required (works under
pytest too, since every check is a plain ``test_*`` function).
"""

from __future__ import annotations

import os
import random
import sys
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import mpmath as mp  # noqa: E402

import lmsr_ref as R  # noqa: E402

SEED = 20260907

B_VALUES = [R.B_MIN, 100_000_000, 1_000_000_000, 10_000_000_000, 100_000_000_000, R.B_MAX]


def _states_for(b: int):
    """A deterministic spread of (q_yes, q_no) states, balanced through extreme."""
    qs = sorted({0, 1, b // 100, b // 4, b, 3 * b, 12 * b, 60 * b, 1000 * b})
    qs = [q for q in qs if 0 <= q <= R.MAX_Q]
    out = []
    for a in qs:
        for c in qs:
            out.append((a, c))
    out.append((R.MAX_Q, 0))
    out.append((0, R.MAX_Q))
    out.append((R.MAX_Q, R.MAX_Q))
    return out


# --------------------------------------------------------------------------- #
# 1. Prices
# --------------------------------------------------------------------------- #


def test_prices_sum_to_one():
    n = 0
    for b in B_VALUES:
        for q_yes, q_no in _states_for(b):
            py = R.price_yes(q_yes, q_no, b)
            pn = R.price_no(q_yes, q_no, b)
            assert 0 <= py <= R.UNIT, (b, q_yes, q_no, py)
            assert 0 <= pn <= R.UNIT, (b, q_yes, q_no, pn)
            assert py + pn == R.UNIT, (b, q_yes, q_no, py, pn)
            # exact prices sum to 1 to full precision as well
            e = R.price_yes_exact(q_yes, q_no, b) + R.price_no_exact(q_yes, q_no, b)
            assert abs(e - 1) < mp.mpf("1e-50"), (b, q_yes, q_no, R.exact_str(e))
            n += 1
    return f"{n} states"


def test_balanced_price_is_exactly_half():
    n = 0
    for b in B_VALUES:
        for q in (0, 1, R.UNIT, b, 7 * b, R.MAX_Q):
            if q > R.MAX_Q:
                continue
            assert R.price_yes_exact(q, q, b) == mp.mpf("0.5"), (b, q)
            assert R.price_yes(q, q, b) == 500_000, (b, q)
            assert R.price_no(q, q, b) == 500_000, (b, q)
            n += 1
    return f"{n} balanced states (incl. the market-open q=0 case)"


def test_price_monotonic_in_q_yes():
    n = 0
    for b in B_VALUES:
        for q_no in (0, b, 10 * b):
            prev = mp.mpf(-1)
            for k in (0, 1, b // 10, b, 2 * b, 5 * b, 25 * b, 200 * b):
                if k > R.MAX_Q:
                    continue
                p = R.price_yes_exact(k, q_no, b)
                assert p > prev, (b, q_no, k)
                prev = p
                n += 1
    return f"{n} points, price_yes strictly increasing in q_yes"


def test_price_is_derivative_of_cost():
    """dC/dq_yes == price_yes.  Central difference must match to ~h^2."""
    n = 0
    for b in B_VALUES:
        for q_yes, q_no in [(0, 0), (b, 0), (0, b), (3 * b, b), (b // 3, 7 * b)]:
            h = max(1, b // 1000)
            if q_yes < h:
                continue
            d = (R.cost_exact(q_yes + h, q_no, b) - R.cost_exact(q_yes - h, q_no, b)) / (2 * h)
            p = R.price_yes_exact(q_yes, q_no, b)
            assert abs(d - p) < mp.mpf("1e-6"), (b, q_yes, q_no, R.exact_str(d), R.exact_str(p))
            n += 1
    return f"{n} central-difference checks"


# --------------------------------------------------------------------------- #
# 2. Cost function
# --------------------------------------------------------------------------- #


def test_cost_at_origin_is_b_ln2():
    n = 0
    for b in B_VALUES + [123_456_789, 999_999_999_999]:
        exact = R.cost_exact(0, 0, b)
        expect = mp.mpf(b) * mp.log(2)
        rel = abs(exact - expect) / expect
        assert rel < mp.mpf("1e-50"), (b, R.exact_str(exact), R.exact_str(expect))
        assert R.cost(0, 0, b) == int(mp.floor(expect)), b
        n += 1
    return f"{n} b values, C(0,0) == b*ln2"


def test_cost_monotonic_in_q():
    n = 0
    for b in B_VALUES:
        for q_no in (0, b, 40 * b):
            prev = mp.mpf(-1)
            for q_yes in (0, 1, b // 7, b, 4 * b, 30 * b, 500 * b):
                if q_yes > R.MAX_Q or q_no > R.MAX_Q:
                    continue
                c = R.cost_exact(q_yes, q_no, b)
                assert c > prev, (b, q_yes, q_no)
                prev = c
                n += 1
    return f"{n} points, cost strictly increasing in q_yes"


def test_cost_bracketed_by_max_and_max_plus_bln2():
    """max(q) <= C(q) <= max(q) + b*ln2 for every reachable state."""
    n = 0
    for b in B_VALUES:
        for q_yes, q_no in _states_for(b):
            c = R.cost_exact(q_yes, q_no, b)
            m = mp.mpf(max(q_yes, q_no))
            assert c >= m - mp.mpf("1e-40"), (b, q_yes, q_no)
            assert c <= m + R.max_loss_bound_exact(b) + mp.mpf("1e-40"), (b, q_yes, q_no)
            n += 1
    return f"{n} states inside [max(q), max(q)+b*ln2]"


def test_cost_symmetric():
    n = 0
    for b in B_VALUES:
        for q_yes, q_no in _states_for(b):
            assert R.cost_exact(q_yes, q_no, b) == R.cost_exact(q_no, q_yes, b), (b, q_yes, q_no)
            n += 1
    return f"{n} states, C(a,b) == C(b,a)"


# --------------------------------------------------------------------------- #
# 3. Trades
# --------------------------------------------------------------------------- #


def test_buy_cost_matches_cost_difference():
    """The cancellation-free trade form must agree with the naive difference of
    two stabilised cost evaluations (to full precision, when no cancellation)."""
    n = 0
    for b in B_VALUES:
        for q_yes, q_no in [(0, 0), (b, 0), (0, b), (2 * b, 5 * b), (b // 3, b // 7)]:
            for outcome in R.OUTCOMES:
                for shares in (1, b // 10, b, 9 * b):
                    ny, nn = (q_yes + shares, q_no) if outcome == R.YES else (q_yes, q_no + shares)
                    if ny > R.MAX_Q or nn > R.MAX_Q:
                        continue
                    a = R.buy_cost_exact(q_yes, q_no, b, outcome, shares)
                    d = R.cost_exact(ny, nn, b) - R.cost_exact(q_yes, q_no, b)
                    assert abs(a - d) <= mp.mpf("1e-30") * max(mp.mpf(1), abs(d)), (
                        b, q_yes, q_no, outcome, shares, R.exact_str(a), R.exact_str(d))
                    n += 1
    return f"{n} trades agree with C(new)-C(old)"


def test_zero_amount_trades_are_zero():
    n = 0
    for b in B_VALUES:
        for q_yes, q_no in [(0, 0), (5 * b, 0), (R.MAX_Q, 0), (0, R.MAX_Q)]:
            for outcome in R.OUTCOMES:
                assert R.buy_cost(q_yes, q_no, b, outcome, 0) == 0
                assert R.sell_return(q_yes, q_no, b, outcome, 0) == 0
                assert R.shares_for_cost(q_yes, q_no, b, outcome, 0) == 0
                n += 3
    return f"{n} zero-amount calls all return exactly 0"


def test_buy_then_sell_never_profits():
    """Round trip: buy `s` shares, immediately sell them back.  The user must
    never receive more than they paid.  This is the rounding policy's whole
    reason for existing."""
    n = 0
    worst = 0
    for b in B_VALUES:
        for q_yes, q_no in [(0, 0), (b, 0), (0, b), (4 * b, b), (b, 30 * b), (b // 5, b // 3)]:
            for outcome in R.OUTCOMES:
                for shares in (1, 7, b // 100 or 1, b // 2, 3 * b):
                    ny, nn = (q_yes + shares, q_no) if outcome == R.YES else (q_yes, q_no + shares)
                    if ny > R.MAX_Q or nn > R.MAX_Q:
                        continue
                    paid = R.buy_cost(q_yes, q_no, b, outcome, shares)
                    got = R.sell_return(ny, nn, b, outcome, shares)
                    assert got <= paid, (b, q_yes, q_no, outcome, shares, paid, got)
                    worst = max(worst, paid - got)
                    n += 1
    return f"{n} round trips, all non-profitable (max protocol margin {worst} base units)"


def test_sell_then_buy_never_profits():
    n = 0
    for b in B_VALUES:
        for q_yes, q_no in [(5 * b, 2 * b), (b, b), (60 * b, b), (b, 60 * b)]:
            for outcome in R.OUTCOMES:
                held = q_yes if outcome == R.YES else q_no
                for shares in (1, held // 3, held):
                    if shares <= 0 or held == 0:
                        continue
                    ny, nn = (q_yes - shares, q_no) if outcome == R.YES else (q_yes, q_no - shares)
                    got = R.sell_return(q_yes, q_no, b, outcome, shares)
                    back = R.buy_cost(ny, nn, b, outcome, shares)
                    assert back >= got, (b, q_yes, q_no, outcome, shares, got, back)
                    n += 1
    return f"{n} sell/buy round trips, all non-profitable"


def test_buy_cost_bounds():
    """0 < buy_cost <= shares (a share can never cost more than its 1.0 payout),
    and buy_cost >= shares * price_before."""
    n = 0
    for b in B_VALUES:
        for q_yes, q_no in [(0, 0), (b, 0), (0, 9 * b), (2 * b, 2 * b)]:
            for outcome in R.OUTCOMES:
                for shares in (1, b // 50 or 1, b, 20 * b):
                    ny, nn = (q_yes + shares, q_no) if outcome == R.YES else (q_yes, q_no + shares)
                    if ny > R.MAX_Q or nn > R.MAX_Q:
                        continue
                    c = R.buy_cost_exact(q_yes, q_no, b, outcome, shares)
                    p0 = (R.price_yes_exact(q_yes, q_no, b) if outcome == R.YES
                          else R.price_no_exact(q_yes, q_no, b))
                    assert c > 0, (b, q_yes, q_no, outcome, shares)
                    assert c <= shares + mp.mpf("1e-30"), (b, q_yes, q_no, outcome, shares)
                    assert c >= p0 * shares - mp.mpf("1e-30"), (b, q_yes, q_no, outcome, shares)
                    n += 1
    return f"{n} trades within [p0*s, s]"


def test_sell_return_bounds():
    n = 0
    for b in B_VALUES:
        for q_yes, q_no in [(6 * b, 2 * b), (b, b), (40 * b, 0), (0, 40 * b)]:
            for outcome in R.OUTCOMES:
                held = q_yes if outcome == R.YES else q_no
                for shares in (1, held // 4, held):
                    if held == 0 or shares <= 0:
                        continue
                    r = R.sell_return_exact(q_yes, q_no, b, outcome, shares)
                    assert 0 <= r <= shares + mp.mpf("1e-30"), (b, q_yes, q_no, outcome, shares)
                    n += 1
    return f"{n} sells within [0, s]"


def test_oversell_and_bounds_rejected():
    n = 0
    for bad_b in (R.B_MIN - 1, R.B_MAX + 1, 0, -1):
        try:
            R.cost(0, 0, bad_b)
        except ValueError:
            n += 1
        else:
            raise AssertionError(f"b={bad_b} should have been rejected")
    for bad_q in (-1, R.MAX_Q + 1):
        try:
            R.cost(bad_q, 0, R.B_MIN)
        except ValueError:
            n += 1
        else:
            raise AssertionError(f"q={bad_q} should have been rejected")
    try:
        R.sell_return(10, 0, R.B_MIN, R.YES, 11)
    except ValueError:
        n += 1
    else:
        raise AssertionError("overselling should have been rejected")
    try:
        R.buy_cost(R.MAX_Q, 0, R.B_MIN, R.YES, 1)
    except ValueError:
        n += 1
    else:
        raise AssertionError("buying past MAX_Q should have been rejected")
    return f"{n} out-of-bounds inputs correctly rejected"


# --------------------------------------------------------------------------- #
# 4. shares_for_cost -- closed form cross-checked against bisection
# --------------------------------------------------------------------------- #


def _bisect_shares(q_yes, q_no, b, outcome, collateral):
    """Largest integer d with buy_cost_exact(d) <= collateral, found by bisection.

    Fully independent of the closed form: only calls buy_cost_exact.
    """
    lo = 0
    hi = 1
    held = q_yes if outcome == R.YES else q_no
    room = R.MAX_Q - held
    while hi <= room:
        if R.buy_cost_exact(q_yes, q_no, b, outcome, hi) > collateral:
            break
        lo = hi
        hi *= 2
    else:
        return None  # answer would exceed MAX_Q; caller skips
    while lo + 1 < hi:
        mid = (lo + hi) // 2
        if R.buy_cost_exact(q_yes, q_no, b, outcome, mid) <= collateral:
            lo = mid
        else:
            hi = mid
    return lo


def test_shares_for_cost_matches_bisection():
    n = 0
    for b in B_VALUES:
        for q_yes, q_no in [(0, 0), (b, 0), (0, b), (3 * b, b), (b // 3, 5 * b)]:
            for outcome in R.OUTCOMES:
                for coll in (1, 1000, b // 10 or 1, b, 5 * b):
                    ref = _bisect_shares(q_yes, q_no, b, outcome, mp.mpf(coll))
                    if ref is None:
                        continue
                    got = R.shares_for_cost(q_yes, q_no, b, outcome, coll)
                    assert got == ref, (b, q_yes, q_no, outcome, coll, got, ref)
                    n += 1
    return f"{n} closed-form results identical to independent bisection"


def test_shares_for_cost_never_overspends():
    """floor(shares) must be affordable, and one more share must not be."""
    n = 0
    for b in B_VALUES:
        for q_yes, q_no in [(0, 0), (2 * b, 0), (0, 2 * b), (b, 7 * b)]:
            for outcome in R.OUTCOMES:
                for coll in (1, 999, b // 3 or 1, 2 * b, 40 * b):
                    d = R.shares_for_cost(q_yes, q_no, b, outcome, coll)
                    held = q_yes if outcome == R.YES else q_no
                    if held + d + 1 > R.MAX_Q:
                        continue
                    if d > 0:
                        assert R.buy_cost(q_yes, q_no, b, outcome, d) <= coll, (
                            b, q_yes, q_no, outcome, coll, d)
                    assert R.buy_cost(q_yes, q_no, b, outcome, d + 1) > coll, (
                        b, q_yes, q_no, outcome, coll, d)
                    n += 1
    return f"{n} inverse round trips, never overspending and always tight"


def test_shares_for_cost_monotonic():
    n = 0
    for b in B_VALUES:
        for q_yes, q_no in [(0, 0), (4 * b, b)]:
            for outcome in R.OUTCOMES:
                prev = -1
                for coll in (0, 1, 100, b // 10 or 1, b, 3 * b, 50 * b):
                    d = R.shares_for_cost(q_yes, q_no, b, outcome, coll)
                    assert d >= prev, (b, q_yes, q_no, outcome, coll, d, prev)
                    prev = d
                    n += 1
    return f"{n} points, shares_for_cost non-decreasing in collateral"


# --------------------------------------------------------------------------- #
# 5. Invariants: subsidy bound and vault solvency
# --------------------------------------------------------------------------- #


def test_max_loss_bound_holds():
    """Starting from (0,0), the maker's loss if either side wins never exceeds
    b*ln2."""
    n = 0
    for b in B_VALUES:
        c0 = R.cost_exact(0, 0, b)
        bound = R.max_loss_bound_exact(b)
        for q_yes, q_no in _states_for(b):
            collected = R.cost_exact(q_yes, q_no, b) - c0
            for payout in (q_yes, q_no):
                loss = mp.mpf(payout) - collected
                assert loss <= bound + mp.mpf("1e-30"), (b, q_yes, q_no, payout,
                                                         R.exact_str(loss), R.exact_str(bound))
            n += 1
    return f"{n} states, maker loss <= b*ln2"


def test_vault_solvency_over_random_sequences():
    """Over a random trade walk, collateral in minus collateral out must always
    cover the exact change in C.  If this ever fails, the vault drains."""
    rng = random.Random(SEED)
    n = 0
    worst = None
    for b in B_VALUES:
        for _ in range(12):
            q_yes = q_no = 0
            c0 = R.cost_exact(0, 0, b)
            net = 0
            for _step in range(25):
                outcome = rng.choice(R.OUTCOMES)
                held = q_yes if outcome == R.YES else q_no
                if held > 0 and rng.random() < 0.4:
                    s = rng.randint(1, held)
                    net -= R.sell_return(q_yes, q_no, b, outcome, s)
                    q_yes, q_no = ((q_yes - s, q_no) if outcome == R.YES else (q_yes, q_no - s))
                else:
                    s = rng.randint(1, 5 * b)
                    ny, nn = ((q_yes + s, q_no) if outcome == R.YES else (q_yes, q_no + s))
                    if ny > R.MAX_Q or nn > R.MAX_Q:
                        continue
                    net += R.buy_cost(q_yes, q_no, b, outcome, s)
                    q_yes, q_no = ny, nn
                delta = R.cost_exact(q_yes, q_no, b) - c0
                margin = mp.mpf(net) - delta
                assert margin >= 0, (b, q_yes, q_no, net, R.exact_str(delta))
                worst = margin if worst is None else min(worst, margin)
                n += 1
    return f"{n} steps solvent (tightest margin {R.exact_str(worst, 12)} base units)"


# --------------------------------------------------------------------------- #
# 6. Precision stability
# --------------------------------------------------------------------------- #


def test_results_stable_at_higher_precision():
    """Every integer result must be identical at dps=60 and dps=120.  If it is
    not, 60 digits is not enough and the vectors are not trustworthy."""
    cases = []
    for b in B_VALUES:
        for q_yes, q_no in [(0, 0), (1, 0), (b, 0), (R.MAX_Q, 0), (0, R.MAX_Q),
                            (R.MAX_Q, R.MAX_Q), (3 * b, 11 * b), (b // 7, b // 3)]:
            for outcome in R.OUTCOMES:
                cases.append((q_yes, q_no, b, outcome))

    def snapshot():
        out = []
        for q_yes, q_no, b, outcome in cases:
            row = [R.cost(q_yes, q_no, b), R.price_yes(q_yes, q_no, b)]
            for s in (1, b // 3 or 1, b):
                ny, nn = ((q_yes + s, q_no) if outcome == R.YES else (q_yes, q_no + s))
                row.append(R.buy_cost(q_yes, q_no, b, outcome, s)
                           if ny <= R.MAX_Q and nn <= R.MAX_Q else None)
                held = q_yes if outcome == R.YES else q_no
                row.append(R.sell_return(q_yes, q_no, b, outcome, s) if s <= held else None)
                row.append(R.shares_for_cost(q_yes, q_no, b, outcome, s))
            out.append(tuple(row))
        return out

    R.set_precision(60)
    at60 = snapshot()
    R.set_precision(120)
    at120 = snapshot()
    R.set_precision(60)
    for i, (a, c) in enumerate(zip(at60, at120)):
        assert a == c, (cases[i], a, c)
    return f"{len(cases)} cases identical at dps=60 and dps=120"


# --------------------------------------------------------------------------- #
# 7. The emitted vectors themselves
# --------------------------------------------------------------------------- #

VECTOR_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "vectors")
_INT_FIELDS = {
    "b", "q_yes", "q_no", "shares", "collateral", "cost", "cost_initial",
    "cost_at_origin", "cost_after", "price_yes", "price_no", "price_sum",
    "price_yes_after", "collateral_in", "collateral_out", "collateral_in_for_shares",
    "q_yes_after", "q_no_after", "net_collateral_after", "payout_yes", "payout_no",
    "max_loss_bound",
}


def _load_vectors():
    import json
    docs = {}
    for kind in ("grid", "edge", "trades", "invariants"):
        path = os.path.join(VECTOR_DIR, f"{kind}.json")
        if not os.path.exists(path):
            return None
        with open(path, "r", encoding="utf-8") as fh:
            docs[kind] = json.load(fh)
    return docs


def _walk(case):
    yield case
    for step in case.get("steps", ()):
        yield step


def test_vectors_are_wellformed():
    docs = _load_vectors()
    if docs is None:
        return "SKIPPED (run gen_vectors.py first)"
    n = 0
    for kind, doc in docs.items():
        assert doc["schema"] == "greekbet.lmsr.vectors.v1", kind
        assert doc["kind"] == kind
        assert doc["count"] == len(doc["cases"]), kind
        assert doc["constants"]["B_MIN"] == str(R.B_MIN)
        assert doc["constants"]["B_MAX"] == str(R.B_MAX)
        assert doc["constants"]["MAX_Q"] == str(R.MAX_Q)
        assert doc["constants"]["UNIT"] == str(R.UNIT)
        assert doc["rounding"]["buy_cost"] == "ceil"
        assert doc["rounding"]["sell_return"] == "floor"
        assert doc["rounding"]["shares_for_cost"] == "floor"
        ids = set()
        for case in doc["cases"]:
            assert case["id"] not in ids, case["id"]
            ids.add(case["id"])
            for obj in _walk(case):
                for k, v in obj.items():
                    if k in _INT_FIELDS:
                        assert isinstance(v, str) or v is None, (kind, case["id"], k, v)
                        if v is not None:
                            int(v)  # must parse as a plain decimal integer
                    if k.endswith("_exact"):
                        assert isinstance(v, str), (kind, case["id"], k)
                        float(v)  # must parse as a decimal number
                    if k == "outcome":
                        assert v in R.OUTCOMES, (kind, case["id"], v)
                n += 1
    return f"{n} case/step objects, all integers encoded as strings"


def test_vector_domain_bounds():
    docs = _load_vectors()
    if docs is None:
        return "SKIPPED"
    n = 0
    for kind, doc in docs.items():
        for case in doc["cases"]:
            for obj in _walk(case):
                for k in ("q_yes", "q_no", "q_yes_after", "q_no_after"):
                    if obj.get(k) is not None and k in obj:
                        assert 0 <= int(obj[k]) <= R.MAX_Q, (kind, case["id"], k, obj[k])
                if "b" in obj:
                    assert R.B_MIN <= int(obj["b"]) <= R.B_MAX, (kind, case["id"])
                n += 1
    return f"{n} objects inside [0, MAX_Q] and [B_MIN, B_MAX]"


def test_vector_price_invariant():
    docs = _load_vectors()
    if docs is None:
        return "SKIPPED"
    n = 0
    for kind, doc in docs.items():
        for case in doc["cases"]:
            if "price_yes" in case and "price_no" in case:
                py, pn = int(case["price_yes"]), int(case["price_no"])
                assert py + pn == R.UNIT, (kind, case["id"], py, pn)
                assert 0 <= py <= R.UNIT and 0 <= pn <= R.UNIT
                if case.get("price_sum") is not None:
                    assert int(case["price_sum"]) == R.UNIT, (kind, case["id"])
                n += 1
    return f"{n} priced cases sum to exactly {R.UNIT}"


def test_vector_market_open_prices_are_half():
    docs = _load_vectors()
    if docs is None:
        return "SKIPPED"
    n = 0
    for case in docs["edge"]["cases"]:
        if case["type"] == "state_market_open":
            assert case["q_yes"] == "0" and case["q_no"] == "0"
            assert case["price_yes"] == "500000", case["id"]
            assert case["price_no"] == "500000", case["id"]
            assert case["cost"] == str(R.cost(0, 0, int(case["b"]))), case["id"]
            n += 1
    assert n > 0, "edge.json must contain q_yes == q_no == 0 cases"
    return f"{n} market-open cases price exactly 0.5"


def test_vector_shares_for_cost_never_overspends():
    docs = _load_vectors()
    if docs is None:
        return "SKIPPED"
    n = 0
    flagged = 0
    for kind, doc in docs.items():
        for case in doc["cases"]:
            if case.get("type") != "shares_for_cost":
                continue
            if case["exceeds_max_q"]:
                assert case["collateral_in_for_shares"] is None, case["id"]
                flagged += 1
                continue
            assert int(case["collateral_in_for_shares"]) <= int(case["collateral"]), case["id"]
            n += 1
    return f"{n} inverse cases affordable ({flagged} flagged exceeds_max_q)"


def test_vector_sequences_stay_solvent():
    docs = _load_vectors()
    if docs is None:
        return "SKIPPED"
    steps = 0
    for case in docs["trades"]["cases"]:
        assert case["step_count"] == len(case["steps"]), case["id"]
        net = 0
        q_yes, q_no = int(case["q_yes"]), int(case["q_no"])
        b = int(case["b"])
        for step in case["steps"]:
            net += int(step.get("collateral_in", 0)) - int(step.get("collateral_out", 0))
            assert int(step["net_collateral_after"]) == net, (case["id"], step["index"])
            q_yes, q_no = int(step["q_yes_after"]), int(step["q_no_after"])
            assert int(step["cost_after"]) == R.cost(q_yes, q_no, b), (case["id"], step["index"])
            assert mp.mpf(step["solvency_margin_exact"]) >= 0, (case["id"], step["index"])
            steps += 1
    return f"{steps} sequence steps: balances reconcile and the vault stays solvent"


def test_vector_max_loss_cases_hold():
    docs = _load_vectors()
    if docs is None:
        return "SKIPPED"
    n = 0
    for case in docs["invariants"]["cases"]:
        if case["type"] != "max_loss":
            continue
        assert case["holds"] is True, case["id"]
        bound = mp.mpf(int(case["max_loss_bound"]))
        assert mp.mpf(case["loss_if_yes_exact"]) <= bound, case["id"]
        assert mp.mpf(case["loss_if_no_exact"]) <= bound, case["id"]
        n += 1
    assert n > 0
    return f"{n} max-loss cases all within b*ln2"


# --------------------------------------------------------------------------- #

def main() -> int:
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failures = 0
    print(f"lmsr_ref self-tests -- {R.PRECISION_INFO['library']} "
          f"{R.PRECISION_INFO['version']}, dps={R.DPS}\n")
    for t in tests:
        try:
            detail = t()
        except Exception:
            failures += 1
            print(f"  FAIL  {t.__name__}")
            traceback.print_exc()
        else:
            print(f"  ok    {t.__name__:<45} {detail or ''}")
    print()
    if failures:
        print(f"{failures} of {len(tests)} tests FAILED")
        return 1
    print(f"all {len(tests)} tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
