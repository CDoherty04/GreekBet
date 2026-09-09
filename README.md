# 🎲 Groupbet

Private prediction markets for small groups of friends. Create an account with
just a **selfie + phone number**, join a group with a 6-character code, spin up
yes/no markets, bet with internal tokens, and **resolve markets from a photo**
that an AI reads and settles automatically.

Built mobile-first for ETH Global Online. Sponsor integrations are isolated
behind stub modules so the real SDKs drop in without touching the UI or API.

## The flow

1. **Onboarding** — selfie → World Selfie Check verifies a real human → Privy
   auto-creates an embedded wallet. No passwords, no email.
2. **Groups** — create a group (get an invite code) or join one with a code.
3. **Markets** — create a yes/no market with an expiry; friends bet tokens.
4. **Odds** — pricing is parimutuel: the winning side splits the whole pot.
5. **Resolve** — upload a photo → World face-match confirms the uploader → the
   AI resolver (describe → sanitize → decide) picks the outcome → winners are
   paid out in tokens.

## Sponsor fit

| Sponsor | Where | File |
| --- | --- | --- |
| **World** — Selfie Check | signup verification + resolution face-match | `src/lib/integrations/world.ts` |
| **Privy** — embedded wallet | auto-provisioned at signup | `src/lib/integrations/privy.ts` |
| **Bazantic** — API recipe | the photo→outcome resolver pipeline | `src/lib/integrations/resolver.ts` |

Each is a stub with the same signature the real integration will have — swap
the body, keep the interface.

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
    onboarding/              # selfie + phone signup
    groups/                  # list, create, join, detail, create-market
    markets/[marketId]/      # market detail (bet) + resolve
    api/                     # route handlers (the "backend")
  components/                # UI: shell, session, cards, photo capture…
    ui/                      # low-level primitives (Button, Card, TextField)
  lib/
    store.ts                 # in-memory DB (swap for a real one later)
    session.ts               # cookie-based auth
    markets.ts               # parimutuel pricing + settlement
    ids.ts                   # id + invite-code generation
    api.ts                   # typed client-side fetch helpers
    integrations/            # World / Privy / resolver stubs
    db/                      # seed data (+ future DB adapter)
  types/                     # shared domain types
contracts/                   # (empty) future on-chain settlement
docs/                        # (empty) design notes
```

## Team split

- **Front of house** — `app/**` screens, `components/**`, World + Privy
  integrations, the demo.
- **Back of house** — `app/api/**`, `lib/store.ts`, `lib/markets.ts`, the
  resolver recipe, settlement.

The seam is the typed `api` client (`src/lib/api.ts`) ↔ the route handlers, so
both sides can work against the same contract in parallel.
