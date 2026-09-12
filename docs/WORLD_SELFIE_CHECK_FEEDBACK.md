# World Selfie Check — integration feedback (ETHOnline 2026)

Prize track notes for [Selfie Check](https://docs.world.org/world-id/credentials/11).

## How we use it

- **Signup** — Selfie Check is required before an app profile is created (bot / multi-account friction).
- **Resolve** — a fresh Selfie Check is required before submitting an event photo (continuity / abuse prevention on the high-stakes path).
- **AI** — only judges what the event photo shows (yes/no). It does not do identity or face-matching against a stored selfie.

Split: **World = who may act. AI = what the photo means.**

## Docs & integration flow

- IDKit v4 + `selfieCheckLegacy()` is the documented path; Selfie Check still returns World ID 3.0 proofs, so `allow_legacy_proofs` must be true.
- RP signatures must be server-side (`@worldcoin/idkit-core/signing`). The signing key is easy to accidentally put in `NEXT_PUBLIC_*` — docs should scream louder.
- Forwarding the IDKit result **unchanged** to `/api/v4/verify/{rp_id}` is clear; the “don’t remap `verification_level`” warning for Selfie Check (`selfie` vs legacy `face`) is easy to miss if you only read old blog posts.
- Per-action nullifiers mean a single `resolve` action would lock a user to one resolution forever — we use `resolve-{marketId}` so each market can require its own check. The docs could show this pattern for “fresh liveness per high-value action.”

## Developer Portal

- App / RP / action creation is straightforward once you know you need `app_id`, `rp_id`, and a one-time `signing_key`.
- Selfie Check is **access-gated**; a valid app does not imply the feature flag. That should be called out on the action create screen, not only in credential docs.
- Searching for “selfie” vs “face” vs “device” is confusing during migration from older Device verification.

## Sandbox App

- End-to-end testing depends on Sandbox App access (TestFlight / private Play track) — cold/semi-cold install paths differ from production store listing.
- Environment mismatch (`staging` action + production World App, or vice versa) fails silently from the RP’s perspective; IDKit error surfaces help, but a portal “environment checklist” would save hours.
- Invite-code / Cold flow differences between iOS and Android (documented) still bite when demoing remotely.

## What was hard to test without keys

- Without Portal credentials the app runs a **labeled stub** so UX and API wiring can be demoed. Live Selfie Check needs `NEXT_PUBLIC_WORLD_APP_ID`, `NEXT_PUBLIC_WORLD_RP_ID`, `WORLD_RP_SIGNING_KEY`, feature-flag access, and Sandbox App for remote demos.

## References

- https://docs.world.org/world-id/idkit/integrate
- https://docs.world.org/world-id/idkit/credentials#selfie-check-beta
- https://docs.world.org/world-id/sandbox/testing-selfie-check
