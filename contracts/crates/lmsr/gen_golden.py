"""Generate the golden accuracy tables embedded in src/fixed.rs.

Not part of the build. Run with Windows CPython + mpmath:
    python crates/lmsr/gen_golden.py
It rewrites the `// __GOLDEN_TABLES__` region of src/fixed.rs in place.
"""
import random
import re
import pathlib
from mpmath import mp, mpf, exp, log, expm1

mp.prec = 500
S = mpf(2) ** 64
HALF = mpf(1) / 2


def q(v):
    return int(mp.floor(v * S + HALF))


def real(raw):
    return mpf(raw) / S


def fmt(rows, name):
    out = [f"    const {name}: &[(i128, i128)] = &["]
    for x, y in rows:
        out.append(f"        ({x}, {y}),")
    out.append("    ];")
    return "\n".join(out)


rng = random.Random(20260907)

# ---------------------------------------------------------------- exp
exp_xs = set()
exp_xs.add(0)
for e in (0, 1, 8, 16, 24, 32, 40, 48, 56, 60, 62):
    exp_xs.add(-(1 << e))
for v in ("0.001", "0.01", "0.1", "0.25", "0.5", "1", "1.5", "2", "3", "5", "7",
          "10", "15", "20", "25", "30", "35", "40", "42", "43", "43.5", "44",
          "44.2", "44.36", "44.5", "44.9"):
    exp_xs.add(-q(mpf(v)))
exp_xs.add(-q(log(2)))
exp_xs.add(-q(log(2)) + 1)
exp_xs.add(-q(log(2)) - 1)
exp_xs.add(-q(mpf(45)) + 1)
while len(exp_xs) < 128:
    exp_xs.add(-rng.randrange(1, q(mpf(45))))
exp_rows = sorted((x, q(exp(real(x)))) for x in exp_xs)

# ---------------------------------------------------------------- ln
ln_xs = set()
for e in range(0, 127, 3):
    ln_xs.add(1 << e)
for v in ("0.5", "1", "1.5", "2", "2.5", "3", "10", "100", "1000",
          "1000000", "1000000000000", "1000000000000000"):
    ln_xs.add(q(mpf(v)))
ln_xs.add(q(mp.e))
ln_xs.add(q(mp.sqrt(2)))
ln_xs.add(q(mp.sqrt(2)) - 1)
ln_xs.add(q(mp.sqrt(2)) + 1)
ln_xs.add((1 << 64) - 1)
ln_xs.add((1 << 64) + 1)
ln_xs.add(2)
ln_xs.add(3)
ln_xs.add((1 << 127) - 1)
while len(ln_xs) < 128:
    b = rng.randrange(1, 127)
    ln_xs.add(rng.randrange(1 << (b - 1), 1 << b) if b > 1 else 1)
ln_rows = sorted((x, q(log(real(x)))) for x in ln_xs)

# ---------------------------------------------------------------- expm1
m1_xs = set()
m1_xs.add(0)
for e in (0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52, 56, 60, 62):
    m1_xs.add(-(1 << e))
for v in ("0.0000000001", "0.000001", "0.001", "0.01", "0.1", "0.25", "0.4",
          "0.49", "0.5", "0.51", "0.6", "1", "2", "5", "10", "20", "30", "40",
          "44", "44.9"):
    m1_xs.add(-q(mpf(v)))
while len(m1_xs) < 128:
    if rng.random() < 0.4:
        m1_xs.add(-rng.randrange(1, 1 << 40))
    else:
        m1_xs.add(-rng.randrange(1, q(mpf(45))))
m1_rows = sorted((x, q(expm1(real(x)))) for x in m1_xs)

# ---------------------------------------------------------------- report
d = mpf(log(2)) * S - 12786308645202655660
print("LN_2 constant residual (ulp):", mp.nstr(d, 10))
print("counts:", len(exp_rows), len(ln_rows), len(m1_rows))

block = "\n".join([
    fmt(exp_rows, "EXP_GOLDEN"),
    "",
    fmt(ln_rows, "LN_GOLDEN"),
    "",
    fmt(m1_rows, "EXPM1_GOLDEN"),
])

path = pathlib.Path(__file__).with_name("src") / "fixed.rs"
src = path.read_text(encoding="utf-8")
new, n = re.subn(r"[ \t]*include_golden!\(\);|"
                 r"[ \t]*// __GOLDEN_BEGIN__.*?// __GOLDEN_END__",
                 "    // __GOLDEN_BEGIN__\n" + block + "\n    // __GOLDEN_END__",
                 src, count=1, flags=re.S)
assert n == 1, "marker not found"
path.write_text(new, encoding="utf-8")
print("wrote", path)
