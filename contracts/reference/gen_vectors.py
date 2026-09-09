"""
Deterministic golden-vector generator for the GreekBet LMSR.

Writes ``reference/vectors/{grid,edge,trades,invariants}.json``.  Running it
twice produces byte-identical files (fixed inputs, one seeded RNG, sorted keys,
no timestamps).

Run:  python reference/gen_vectors.py
      python reference/gen_vectors.py --check    # regenerate + diff, no write

All integer quantities are emitted as JSON **strings**: q values reach 1e15 and
costs reach ~1.0007e15, both beyond the 2^53 exact-integer range of a JS/JSON
double, so a naive consumer would silently corrupt them.  ``*_exact`` fields are
high-precision decimal strings (36 significant digits) for tolerance-based
comparison; they are *not* integers.

Schema is documented in reference/README.md.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import lmsr_ref as R  # noqa: E402

SCHEMA = "greekbet.lmsr.vectors.v1"
SEED = 20260907

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(HERE, "vectors")

# b values spanning the whole allowed range: 10, 100, 1k, 10k, 100k, 1M USDC.
GRID_B = [10_000_000, 100_000_000, 1_000_000_000,
          10_000_000_000, 100_000_000_000, 1_000_000_000_000]

assert GRID_B[0] == R.B_MIN and GRID_B[-1] == R.B_MAX


# --------------------------------------------------------------------------- #
# emit helpers
# --------------------------------------------------------------------------- #

def S(v: int) -> str:
    """Integer -> JSON string (see module docstring)."""
    return str(int(v))


def X(v) -> str:
    return R.exact_str(v, 36)


class Builder:
    def __init__(self, kind: str, description: str):
        self.kind = kind
        self.description = description
        self.cases = []
        self._n = 0

    def add(self, case_type: str, **fields):
        self._n += 1
        case = {"id": f"{self.kind}-{self._n:05d}", "type": case_type}
        case.update(fields)
        self.cases.append(case)
        return case

    def document(self):
        return {
            "schema": SCHEMA,
            "kind": self.kind,
            "description": self.description,
            "generated_by": "reference/gen_vectors.py",
            "reference": "reference/lmsr_ref.py",
            "encoding": {
                "integers": "decimal strings (values exceed 2^53)",
                "exact": "high-precision decimal strings, 36 significant digits, non-integer",
                "outcome": "\"yes\" | \"no\"",
            },
            "units": {"decimals": R.DECIMALS, "unit": S(R.UNIT),
                      "note": "1000000 base units = 1 USDC = 1 share; prices also in base units"},
            "constants": {"B_MIN": S(R.B_MIN), "B_MAX": S(R.B_MAX),
                          "MAX_Q": S(R.MAX_Q), "UNIT": S(R.UNIT)},
            "precision": dict(R.PRECISION_INFO),
            "rounding": dict(R.ROUNDING_POLICY),
            "count": len(self.cases),
            "cases": self.cases,
        }


# --------------------------------------------------------------------------- #
# case emitters
# --------------------------------------------------------------------------- #

def emit_state(bld: Builder, q_yes: int, q_no: int, b: int, case_type: str = "state"):
    return bld.add(
        case_type,
        b=S(b), q_yes=S(q_yes), q_no=S(q_no),
        cost=S(R.cost(q_yes, q_no, b)),
        cost_exact=X(R.cost_exact(q_yes, q_no, b)),
        price_yes=S(R.price_yes(q_yes, q_no, b)),
        price_no=S(R.price_no(q_yes, q_no, b)),
        price_yes_exact=X(R.price_yes_exact(q_yes, q_no, b)),
    )


def emit_buy(bld: Builder, q_yes: int, q_no: int, b: int, outcome: str, shares: int):
    ny, nn = ((q_yes + shares, q_no) if outcome == R.YES else (q_yes, q_no + shares))
    if shares < 0 or ny > R.MAX_Q or nn > R.MAX_Q:
        return None
    return bld.add(
        "buy",
        b=S(b), q_yes=S(q_yes), q_no=S(q_no), outcome=outcome, shares=S(shares),
        collateral_in=S(R.buy_cost(q_yes, q_no, b, outcome, shares)),
        collateral_in_exact=X(R.buy_cost_exact(q_yes, q_no, b, outcome, shares)),
        q_yes_after=S(ny), q_no_after=S(nn),
    )


def emit_sell(bld: Builder, q_yes: int, q_no: int, b: int, outcome: str, shares: int):
    held = q_yes if outcome == R.YES else q_no
    if shares < 0 or shares > held:
        return None
    ny, nn = ((q_yes - shares, q_no) if outcome == R.YES else (q_yes, q_no - shares))
    return bld.add(
        "sell",
        b=S(b), q_yes=S(q_yes), q_no=S(q_no), outcome=outcome, shares=S(shares),
        collateral_out=S(R.sell_return(q_yes, q_no, b, outcome, shares)),
        collateral_out_exact=X(R.sell_return_exact(q_yes, q_no, b, outcome, shares)),
        q_yes_after=S(ny), q_no_after=S(nn),
    )


def emit_sfc(bld: Builder, q_yes: int, q_no: int, b: int, outcome: str, collateral: int):
    if collateral < 0:
        return None
    d = R.shares_for_cost(q_yes, q_no, b, outcome, collateral)
    held = q_yes if outcome == R.YES else q_no
    exceeds = held + d > R.MAX_Q
    fields = dict(
        b=S(b), q_yes=S(q_yes), q_no=S(q_no), outcome=outcome,
        collateral=S(collateral),
        shares=S(d),
        shares_exact=X(R.shares_for_cost_exact(q_yes, q_no, b, outcome, collateral)),
        exceeds_max_q=exceeds,
    )
    # Cross-check field: what those shares actually cost.  Must be <= collateral.
    fields["collateral_in_for_shares"] = (
        None if exceeds else S(R.buy_cost(q_yes, q_no, b, outcome, d)))
    return bld.add("shares_for_cost", **fields)


# --------------------------------------------------------------------------- #
# grid.json
# --------------------------------------------------------------------------- #

def q_ladder(b: int):
    qs = {0, 1, b // 100, b // 4, b, 3 * b, 12 * b, 60 * b}
    return sorted(q for q in qs if 0 <= q <= R.MAX_Q)


def build_grid() -> Builder:
    bld = Builder("grid", "Cross product of b in {10,100,1e3,1e4,1e5,1e6} USDC with "
                          "(q_yes, q_no) states from balanced to extreme skew, plus a "
                          "buy / sell / shares_for_cost probe at each state.")
    for b in GRID_B:
        ladder = q_ladder(b)
        for q_yes in ladder:
            for q_no in ladder:
                emit_state(bld, q_yes, q_no, b)
                emit_buy(bld, q_yes, q_no, b, R.YES, max(1, b // 10))
                emit_buy(bld, q_yes, q_no, b, R.NO, 3 * b)
                if q_yes >= 3:
                    emit_sell(bld, q_yes, q_no, b, R.YES, q_yes // 3)
                if q_no >= 2:
                    emit_sell(bld, q_yes, q_no, b, R.NO, q_no // 2)
                emit_sfc(bld, q_yes, q_no, b, R.YES, max(1, b // 4))
                emit_sfc(bld, q_yes, q_no, b, R.NO, 2 * b)
    return bld


# --------------------------------------------------------------------------- #
# edge.json
# --------------------------------------------------------------------------- #

def build_edge() -> Builder:
    bld = Builder("edge", "Boundary conditions from plan section 1.3: q=0 market open, "
                          "b at B_MIN/B_MAX, one side at MAX_Q, skews deep enough that "
                          "exp((q_min-q_max)/b) underflows, 1-unit trades, full "
                          "liquidation, and buys that land exactly on MAX_Q.")

    b_all = sorted(set(GRID_B + [R.B_MIN, R.B_MAX, 12_345_678, 999_999_999_999]))

    # -- market open: q_yes == q_no == 0 must price exactly 0.5 ---------------
    for b in b_all:
        emit_state(bld, 0, 0, b, "state_market_open")
        emit_buy(bld, 0, 0, b, R.YES, 1)
        emit_buy(bld, 0, 0, b, R.NO, 1)
        emit_sfc(bld, 0, 0, b, R.YES, 1)
        emit_sfc(bld, 0, 0, b, R.NO, R.UNIT)

    # -- b exactly at each bound, q across the whole allowed range ------------
    q_corners = [0, 1, R.UNIT, R.MAX_Q // 2, R.MAX_Q - 1, R.MAX_Q]
    for b in (R.B_MIN, R.B_MAX):
        for q_yes in q_corners:
            for q_no in q_corners:
                emit_state(bld, q_yes, q_no, b, "state_b_bound")

    # -- one side at MAX_Q, the other at 0 ------------------------------------
    for b in b_all:
        for q_yes, q_no in ((R.MAX_Q, 0), (0, R.MAX_Q)):
            emit_state(bld, q_yes, q_no, b, "state_max_q")
            # trade the *worthless* side and the *certain* side
            emit_buy(bld, q_yes, q_no, b, R.NO if q_yes else R.YES, 1)
            emit_buy(bld, q_yes, q_no, b, R.NO if q_yes else R.YES, b)
            emit_sell(bld, q_yes, q_no, b, R.YES if q_yes else R.NO, 1)
            emit_sell(bld, q_yes, q_no, b, R.YES if q_yes else R.NO, b)
            # a tiny spend on the near-zero-price side buys an absurd number of
            # shares -- flagged with exceeds_max_q so T04 knows to expect the
            # program-level rejection rather than a value match.
            emit_sfc(bld, q_yes, q_no, b, R.NO if q_yes else R.YES, R.UNIT)
            emit_sfc(bld, q_yes, q_no, b, R.YES if q_yes else R.NO, R.UNIT)

    # -- underflow ladder: (q_min - q_max)/b from mild to -1e8 ----------------
    for b in GRID_B:
        for ratio in (5, 50, 500, 5_000, 50_000, 1_000_000, 10_000_000, 100_000_000):
            q_hi = ratio * b
            if q_hi > R.MAX_Q:
                continue
            emit_state(bld, q_hi, 0, b, "state_underflow_skew")
            emit_state(bld, 0, q_hi, b, "state_underflow_skew")
            emit_buy(bld, q_hi, 0, b, R.YES, b)
            emit_buy(bld, q_hi, 0, b, R.NO, b)
            emit_sell(bld, q_hi, 0, b, R.YES, b)
            emit_sfc(bld, q_hi, 0, b, R.YES, b)
            emit_sfc(bld, q_hi, 0, b, R.NO, 1)

    # -- one base unit everywhere ---------------------------------------------
    for b in GRID_B:
        for q_yes, q_no in ((0, 0), (1, 0), (0, 1), (b, b), (b, 0), (R.MAX_Q - 1, 0)):
            for outcome in R.OUTCOMES:
                emit_buy(bld, q_yes, q_no, b, outcome, 1)
                emit_sell(bld, q_yes, q_no, b, outcome, 1)
                emit_sfc(bld, q_yes, q_no, b, outcome, 1)

    # -- buys landing exactly on MAX_Q, and full liquidation -------------------
    for b in GRID_B:
        for k in (1, R.UNIT, b):
            emit_buy(bld, R.MAX_Q - k, 0, b, R.YES, k)
            emit_buy(bld, R.MAX_Q - k, R.MAX_Q, b, R.YES, k)
        for q in (1, R.UNIT, b, 100 * b, R.MAX_Q):
            if q > R.MAX_Q:
                continue
            emit_sell(bld, q, 0, b, R.YES, q)        # sell everything
            emit_sell(bld, q, q, b, R.NO, q)
            emit_sell(bld, q, R.MAX_Q, b, R.YES, q)  # sell everything, other side huge

    # -- extreme collateral inputs --------------------------------------------
    for b in GRID_B:
        for coll in (1, 2, R.UNIT, 1000 * R.UNIT, R.MAX_Q // 1000, R.MAX_Q):
            emit_sfc(bld, 0, 0, b, R.YES, coll)
            emit_sfc(bld, b, 0, b, R.NO, coll)

    # -- inverse results that legitimately blow past MAX_Q --------------------
    # At heavy skew the worthless side costs ~nothing, so a modest spend buys
    # more shares than the protocol allows to exist.  The oracle returns the
    # mathematical answer and flags it; rejecting the trade is the program's job.
    for b in GRID_B:
        for q_hi in sorted({min(500 * b, R.MAX_Q), R.MAX_Q // 2, R.MAX_Q}):
            for coll in (10 * b, 100 * b):
                emit_sfc(bld, q_hi, 0, b, R.NO, coll)
                emit_sfc(bld, 0, q_hi, b, R.YES, coll)

    return bld


# --------------------------------------------------------------------------- #
# trades.json
# --------------------------------------------------------------------------- #

def _sequence(bld: Builder, name: str, b: int, q_yes: int, q_no: int, plan):
    """`plan` is a list of (op, outcome, amount) with op in
    {buy, sell, buy_with_collateral}.  Amounts are share counts except for
    buy_with_collateral, which takes collateral."""
    q_yes0, q_no0 = q_yes, q_no
    c_start = R.cost_exact(q_yes, q_no, b)
    steps = []
    net = 0
    for op, outcome, amount in plan:
        step = {"index": len(steps), "op": op, "outcome": outcome}
        if op == "buy":
            ny, nn = ((q_yes + amount, q_no) if outcome == R.YES else (q_yes, q_no + amount))
            if ny > R.MAX_Q or nn > R.MAX_Q:
                continue
            paid = R.buy_cost(q_yes, q_no, b, outcome, amount)
            step["shares"] = S(amount)
            step["collateral_in"] = S(paid)
            step["collateral_in_exact"] = X(R.buy_cost_exact(q_yes, q_no, b, outcome, amount))
            net += paid
            q_yes, q_no = ny, nn
        elif op == "buy_with_collateral":
            d = R.shares_for_cost(q_yes, q_no, b, outcome, amount)
            held = q_yes if outcome == R.YES else q_no
            if held + d > R.MAX_Q:
                continue
            paid = R.buy_cost(q_yes, q_no, b, outcome, d) if d else 0
            step["collateral"] = S(amount)
            step["shares"] = S(d)
            step["shares_exact"] = X(R.shares_for_cost_exact(q_yes, q_no, b, outcome, amount))
            step["collateral_in"] = S(paid)
            net += paid
            q_yes, q_no = ((q_yes + d, q_no) if outcome == R.YES else (q_yes, q_no + d))
        elif op == "sell":
            held = q_yes if outcome == R.YES else q_no
            amount = min(amount, held)
            if amount <= 0:
                continue
            got = R.sell_return(q_yes, q_no, b, outcome, amount)
            step["shares"] = S(amount)
            step["collateral_out"] = S(got)
            step["collateral_out_exact"] = X(
                R.sell_return_exact(q_yes, q_no, b, outcome, amount))
            net -= got
            q_yes, q_no = ((q_yes - amount, q_no) if outcome == R.YES else (q_yes, q_no - amount))
        else:  # pragma: no cover
            raise ValueError(op)

        step["q_yes_after"] = S(q_yes)
        step["q_no_after"] = S(q_no)
        step["cost_after"] = S(R.cost(q_yes, q_no, b))
        step["price_yes_after"] = S(R.price_yes(q_yes, q_no, b))
        step["net_collateral_after"] = S(net)
        # Vault solvency: net collateral held must cover the exact rise in C.
        step["solvency_margin_exact"] = X(
            net - (R.cost_exact(q_yes, q_no, b) - c_start))
        steps.append(step)

    return bld.add(
        "sequence",
        name=name,
        b=S(b),
        q_yes=S(q_yes0),
        q_no=S(q_no0),
        cost_initial=S(R.cost(q_yes0, q_no0, b)),
        step_count=len(steps),
        steps=steps,
    )


def build_trades() -> Builder:
    bld = Builder("trades", "Multi-step buy/sell sequences with the expected state, cost "
                            "and running vault balance after every step. These catch "
                            "cumulative drift that single-shot vectors miss.")
    rng = random.Random(SEED)

    for b in GRID_B:
        specs = []

        # 1. YES ladder from a fresh market
        specs.append(("yes_ladder", 0, 0,
                      [("buy", R.YES, b // 4), ("buy", R.YES, b // 2), ("buy", R.YES, b),
                       ("buy", R.YES, 2 * b), ("buy", R.YES, 4 * b), ("buy", R.YES, 8 * b),
                       ("buy", R.YES, 16 * b), ("buy", R.YES, 32 * b)]))

        # 2. alternating two-sided flow
        specs.append(("alternating", 0, 0,
                      [("buy", R.YES, b), ("buy", R.NO, b), ("buy", R.YES, 3 * b),
                       ("buy", R.NO, 5 * b), ("buy", R.YES, 7 * b), ("buy", R.NO, 2 * b),
                       ("buy", R.YES, 11 * b), ("buy", R.NO, 13 * b)]))

        # 3. buy up then unwind completely
        specs.append(("buy_then_unwind", 0, 0,
                      [("buy", R.YES, 5 * b), ("buy", R.NO, 2 * b), ("buy", R.YES, 3 * b),
                       ("sell", R.YES, 4 * b), ("sell", R.NO, b), ("sell", R.YES, 4 * b),
                       ("sell", R.NO, b), ("sell", R.YES, 10 * b), ("sell", R.NO, 10 * b)]))

        # 4. collateral-denominated buys (the path buy_shares actually takes)
        specs.append(("collateral_ladder", 0, 0,
                      [("buy_with_collateral", R.YES, b // 10),
                       ("buy_with_collateral", R.YES, b // 2),
                       ("buy_with_collateral", R.NO, b),
                       ("buy_with_collateral", R.YES, 2 * b),
                       ("buy_with_collateral", R.NO, 3 * b),
                       ("buy_with_collateral", R.YES, 5 * b),
                       ("buy_with_collateral", R.NO, 8 * b),
                       ("buy_with_collateral", R.YES, 13 * b)]))

        # 5. one-unit dust trades (worst case for rounding drift)
        specs.append(("dust", 0, 0, [("buy", R.YES, 1), ("buy", R.NO, 1)] * 6 +
                      [("sell", R.YES, 1), ("sell", R.NO, 1)] * 3))

        # 6. starting from an already-skewed book
        start = min(40 * b, R.MAX_Q)
        specs.append(("skewed_start", start, 0,
                      [("buy", R.NO, b), ("buy", R.NO, 10 * b), ("buy", R.NO, 100 * b),
                       ("sell", R.YES, 20 * b), ("buy_with_collateral", R.NO, b),
                       ("sell", R.NO, 30 * b), ("buy", R.YES, 5 * b),
                       ("sell", R.YES, 5 * b)]))

        # 7-8. seeded pseudo-random walks
        for k in (1, 2):
            plan = []
            for _ in range(14):
                outcome = rng.choice(R.OUTCOMES)
                roll = rng.random()
                if roll < 0.30:
                    plan.append(("sell", outcome, rng.randint(1, 6 * b)))
                elif roll < 0.65:
                    plan.append(("buy", outcome, rng.randint(1, 9 * b)))
                else:
                    plan.append(("buy_with_collateral", outcome, rng.randint(1, 4 * b)))
            specs.append((f"random_walk_{k}", 0, 0, plan))

        for name, q_yes, q_no, plan in specs:
            _sequence(bld, name, b, q_yes, q_no, plan)

    return bld


# --------------------------------------------------------------------------- #
# invariants.json
# --------------------------------------------------------------------------- #

def build_invariants() -> Builder:
    bld = Builder("invariants", "Cases that exist purely to pin the two protocol "
                                "invariants: price_yes + price_no == UNIT exactly, and "
                                "the market maker's worst-case loss <= b*ln2.")
    b_all = sorted(set(GRID_B + [R.B_MIN, R.B_MAX, 12_345_678, 777_777_777_777]))

    # -- b*ln2 constant itself -------------------------------------------------
    for b in b_all:
        bld.add("max_loss_constant",
                b=S(b),
                max_loss_bound=S(R.max_loss_bound(b)),
                max_loss_bound_exact=X(R.max_loss_bound_exact(b)),
                cost_at_origin=S(R.cost(0, 0, b)),
                cost_at_origin_exact=X(R.cost_exact(0, 0, b)))

    # -- price complementarity across the full skew range ---------------------
    for b in b_all:
        qs = sorted({0, 1, 7, R.UNIT, b // 1000, b // 10, b, 2 * b, 9 * b, 40 * b,
                     250 * b, R.MAX_Q})
        qs = [q for q in qs if 0 <= q <= R.MAX_Q]
        for q_yes in qs:
            for q_no in (0, b, q_yes):
                if q_no > R.MAX_Q:
                    continue
                py = R.price_yes(q_yes, q_no, b)
                pn = R.price_no(q_yes, q_no, b)
                bld.add("price_sum",
                        b=S(b), q_yes=S(q_yes), q_no=S(q_no),
                        price_yes=S(py), price_no=S(pn),
                        price_sum=S(py + pn),
                        price_yes_exact=X(R.price_yes_exact(q_yes, q_no, b)),
                        price_no_exact=X(R.price_no_exact(q_yes, q_no, b)))

    # -- max-loss bound on real reachable states ------------------------------
    for b in b_all:
        c0_exact = R.cost_exact(0, 0, b)
        bound = R.max_loss_bound(b)
        for q_yes in (0, 1, b // 4, b, 5 * b, 25 * b, 400 * b, R.MAX_Q):
            for q_no in (0, b, 3 * b, q_yes):
                if q_yes > R.MAX_Q or q_no > R.MAX_Q:
                    continue
                collected = R.cost_exact(q_yes, q_no, b) - c0_exact
                # Collateral actually banked is floored at each step in the worst
                # case, so use the exact value: it is the strictest form of the test.
                loss_yes = q_yes - collected
                loss_no = q_no - collected
                bld.add("max_loss",
                        b=S(b), q_yes=S(q_yes), q_no=S(q_no),
                        cost=S(R.cost(q_yes, q_no, b)),
                        cost_at_origin=S(R.cost(0, 0, b)),
                        collateral_collected_exact=X(collected),
                        payout_yes=S(q_yes), payout_no=S(q_no),
                        loss_if_yes_exact=X(loss_yes),
                        loss_if_no_exact=X(loss_no),
                        max_loss_bound=S(bound),
                        holds=bool(loss_yes <= bound and loss_no <= bound))
    return bld


# --------------------------------------------------------------------------- #
# main
# --------------------------------------------------------------------------- #

def render(doc) -> str:
    return json.dumps(doc, indent=1, sort_keys=False, ensure_ascii=True) + "\n"


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--check", action="store_true",
                    help="regenerate in memory and verify the files on disk match")
    args = ap.parse_args(argv)

    os.makedirs(OUT_DIR, exist_ok=True)
    builders = [build_grid(), build_edge(), build_trades(), build_invariants()]

    total = 0
    mismatched = 0
    for bld in builders:
        doc = bld.document()
        text = render(doc)
        path = os.path.join(OUT_DIR, f"{bld.kind}.json")
        if args.check:
            existing = open(path, "r", encoding="utf-8").read() if os.path.exists(path) else None
            state = "MATCH" if existing == text else "DIFFERS"
            if existing != text:
                mismatched += 1
        else:
            with open(path, "w", encoding="utf-8", newline="\n") as fh:
                fh.write(text)
            state = "written"
        steps = sum(len(c.get("steps", ())) for c in doc["cases"])
        extra = f" ({steps} steps)" if steps else ""
        total += doc["count"]
        print(f"  {bld.kind + '.json':<20} {doc['count']:>5} cases{extra:<14} "
              f"{len(text) / 1024:>8.1f} KiB  {state}")

    print(f"  {'TOTAL':<20} {total:>5} cases")
    if args.check and mismatched:
        print(f"\n{mismatched} file(s) differ from the committed vectors")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
