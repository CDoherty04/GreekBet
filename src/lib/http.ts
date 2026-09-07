/**
 * Small helpers for JSON route handlers so responses stay consistent.
 */

/** Success JSON response. */
export function ok<T>(data: T, init?: ResponseInit): Response {
  return Response.json(data, init);
}

/** Error JSON response with a `{ error }` body and status code. */
export function fail(message: string, status = 400): Response {
  return Response.json({ error: message }, { status });
}

/** Parse a JSON request body, returning `null` if it isn't valid JSON. */
export async function readJson<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}
