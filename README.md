# 🎲 GroupBet

Private prediction markets for small groups of friends. Create an account with
just a **profile photo + phone number**, join a group with a 6-character code,
spin up yes/no markets, bet with internal tokens, and **resolve markets from a
photo** that an AI reads and settles automatically.

Built mobile-first for ETH Global Online. Sponsor integrations are isolated
behind modules so the real SDKs drop in without touching the UI or API.

## The flow

1. **Onboarding** — name + phone via Privy SMS → take a profile photo → Privy
   auto-creates an embedded wallet. No passwords, no email.
2. **Groups** — create a group (get an invite code) or join one with a code.
3. **Markets** — create a yes/no market with an expiry; friends bet tokens.
4. **Odds** — LMSR pricing on Solana: a market maker sets prices along a bonding
   curve; traders can buy and sell before resolution.
5. **Resolve** — upload a photo of the outcome → the AI resolver (describe →
   sanitize → validate) uses group profile photos to recognize people when it
   can, picks the outcome → winners redeem on chain.

## Sponsor fit

| Sponsor | Where | File |
| --- | --- | --- |
| **Privy** — embedded wallet | SMS login + Solana wallet at signup | `src/lib/integrations/privy.ts` |
| **Bazantic** — API recipe | the photo→outcome resolver pipeline | `src/lib/integrations/resolver.ts` |

## Run it

```bash
npm install
npm run dev
# open http://localhost:3000 on your phone (same network) or in a mobile
# viewport. Camera capture needs https or localhost.
```

The app ships with seed data (a "Roommates" group, code `DEMO24`) so screens
aren't empty on first load.

## Project structure

```
src/
  app/
    page.tsx                 # entry → redirects to onboarding or groups
    onboarding/              # profile photo + phone signup
    groups/                  # list, create, join, detail, create-market
    markets/[marketId]/      # market detail (bet) + resolve
    api/                     # route handlers (the "backend")
  components/                # UI: shell, session, cards, photo capture…
    ui/                      # low-level primitives (Button, Card, TextField)
  lib/
    store.ts                 # MongoDB off-chain store
    session.ts               # Privy auth helpers
    markets.ts               # view models + settlement triggers
    ids.ts                   # id + invite-code generation
    api.ts                   # typed client-side fetch helpers
    integrations/            # Privy / resolver
    resolver/                # describe → validate → policy → settle
    db/                      # seed data + Mongo connection
  types/                     # shared domain types
contracts/                   # Solana LMSR program
docs/                        # design notes
```

## Team split

- **Front of house** — `app/**` screens, `components/**`, Privy, the demo.
- **Back of house** — `app/api/**`, `lib/store.ts`, `lib/markets.ts`, the
  resolver recipe, settlement.

The seam is the typed `api` client (`src/lib/api.ts`) ↔ the route handlers, so
both sides can work against the same contract in parallel.
