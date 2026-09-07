/**
 * World — Selfie Check integration (STUB).
 *
 * Bounty: use World to verify real, unique humans instead of traditional
 * OAuth, and reuse face-matching to confirm the person in an event photo.
 *
 * Two capabilities, both stubbed here with the same shape the real SDK/API
 * will expose so screens and API routes don't change when we wire it up:
 *
 *   1. `verifySelfie`  — proof-of-personhood at signup.
 *   2. `matchFace`     — confirm a resolution photo shows a given user.
 *
 * TODO(real): replace the bodies with the World Selfie Check SDK/API calls.
 * Keep the function signatures identical.
 */

export interface SelfieVerification {
  verified: boolean;
  /** Stable proof-of-personhood identifier. */
  worldId: string;
}

export interface FaceMatch {
  match: boolean;
  /** 0..1 confidence score. */
  confidence: number;
}

/** Simulate network latency so the UI's loading states are realistic. */
function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Verify a selfie represents a real, unique human (proof of personhood).
 * @param _selfieDataUrl base64 data URL of the captured selfie
 */
export async function verifySelfie(
  _selfieDataUrl: string,
): Promise<SelfieVerification> {
  await delay(700);
  // STUB: always succeeds with a deterministic-looking World id.
  const worldId = `0x${crypto.randomUUID().replace(/-/g, "").slice(0, 40)}`;
  return { verified: true, worldId };
}

/**
 * Check whether an event/resolution photo contains the given user's face.
 * @param _selfieDataUrl the user's reference selfie
 * @param _eventImageUrl the uploaded resolution photo
 */
export async function matchFace(
  _selfieDataUrl: string,
  _eventImageUrl: string,
): Promise<FaceMatch> {
  await delay(500);
  // STUB: high-confidence match.
  return { match: true, confidence: 0.94 };
}
