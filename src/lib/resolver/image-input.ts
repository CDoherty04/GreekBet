/**
 * Validation for resolution photos sent as `data:` URLs. **Server-only.**
 *
 * Runs before any vision API call so a malformed or oversized upload is a
 * clean 400 (`DescribeError("invalid_image")`) and never costs a request.
 */

import "server-only";

import { DescribeError } from "./errors";

/** Formats the vision model accepts (GIF must be non-animated). */
export const ALLOWED_IMAGE_TYPES: readonly string[] = Object.freeze([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

/** Largest decoded image we accept: 10 MB. */
export const MAX_IMAGE_BYTES: number = 10 * 1024 * 1024;

const HEADER_RE = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+)((?:;[^;,]*)*),/i;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** Leading bytes each allowed type must start with. `null` = wildcard byte. */
const SIGNATURES: Record<string, (number | null)[][]> = {
  "image/jpeg": [[0xff, 0xd8, 0xff]],
  "image/png": [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  // "RIFF" ???? "WEBP"
  "image/webp": [
    [0x52, 0x49, 0x46, 0x46, null, null, null, null, 0x57, 0x45, 0x42, 0x50],
  ],
  // "GIF87a" / "GIF89a"
  "image/gif": [
    [0x47, 0x49, 0x46, 0x38, 0x37, 0x61],
    [0x47, 0x49, 0x46, 0x38, 0x39, 0x61],
  ],
};

function invalid(message: string): DescribeError {
  return new DescribeError("invalid_image", message);
}

/**
 * Check that `dataUrl` is a base64 `data:` URL of an allowed image type within
 * the size limit. Returns the normalized MIME type and decoded byte size.
 * Throws `DescribeError("invalid_image")` on failure.
 */
export function parseImageDataUrl(dataUrl: string): {
  mimeType: string;
  bytes: number;
} {
  if (typeof dataUrl !== "string" || dataUrl.length === 0) {
    throw invalid("Image is missing");
  }

  const header = HEADER_RE.exec(dataUrl.slice(0, 256));
  if (!header) throw invalid("Image must be a data: URL");

  const mimeType = header[1].toLowerCase();
  if (!ALLOWED_IMAGE_TYPES.includes(mimeType)) {
    throw invalid(
      `Unsupported image type ${mimeType}; use JPEG, PNG, WEBP or GIF`,
    );
  }

  const params = header[2]
    .split(";")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  if (!params.includes("base64")) {
    throw invalid("Image data URL must be base64-encoded");
  }

  const payload = dataUrl.slice(header[0].length);
  if (payload.length === 0) throw invalid("Image data is empty");

  // Cheap size bound before scanning the whole string.
  if (payload.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) {
    throw invalid("Image is larger than 10 MB");
  }
  if (payload.length % 4 !== 0 || !BASE64_RE.test(payload)) {
    throw invalid("Image data is not valid base64");
  }

  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  const bytes = (payload.length / 4) * 3 - padding;
  if (bytes === 0) throw invalid("Image data is empty");
  if (bytes > MAX_IMAGE_BYTES) throw invalid("Image is larger than 10 MB");

  // Decode only the first few bytes to confirm the content matches the type.
  const head = Buffer.from(payload.slice(0, 16), "base64");
  const matches = SIGNATURES[mimeType].some(
    (sig) =>
      head.length >= sig.length &&
      sig.every((b, i) => b === null || head[i] === b),
  );
  if (!matches) {
    throw invalid(`Image data does not look like ${mimeType}`);
  }

  return { mimeType, bytes };
}
