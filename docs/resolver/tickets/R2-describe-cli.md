# R2 — Describe CLI for manual testing

**Depends on:** R1 · **Blocks:** —
**Owns:** `scripts/describe-image.ts`

Read [`../PLAN.md`](../PLAN.md) first.

## Context

We need a fast way to try prompts against real photos without driving the
camera UI. R1 already added `npm run describe` →
`node --conditions=react-server --import tsx scripts/describe-image.ts`.
Look at `scripts/smoke-chain.ts` / `scripts/fund-wallet.ts` for how existing
scripts load env (`.env.local`) and structure output — match them.

## Tasks

1. Usage: `npm run describe -- <imagePath> "<question>" [--context "<text>"] [--json]`.
2. Read the file, infer MIME from extension (`.jpg/.jpeg/.png/.webp/.gif`),
   build a data URL, call `describeImage` from `src/lib/resolver/describe.ts`.
3. Default output: `formatDescription(...)` plus a footer line with `model`,
   `responseId`, `stub`, and elapsed ms. `--json` prints the full
   `DescribeResult` as JSON.
4. On `DescribeError`, print `code` + message to stderr and exit 1. Print usage
   and exit 2 on bad args.
5. Load `.env.local` the same way the other scripts do so `OPENAI_API_KEY` is
   picked up. Never print the key.

## Definition of done

- `npx tsc --noEmit` and `npm run lint` pass.
- Ran it against a local image: without a key it prints the stub result; with a
  key (if available) it prints a real description. Report which ran.
- Bad path / unsupported extension produce a clean error, not a stack trace.

## Report back

Commands you ran and their (trimmed) output.
