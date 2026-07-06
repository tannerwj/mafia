// Spec 17 D1 — structured server logging. One tiny helper: every event is a
// single JSON line on stdout, which Cloudflare Workers Logs captures at
// `head_sampling_rate: 1` (wrangler.jsonc) with no extra plumbing needed.
//
// THE LOG HYGIENE HARD RULE (spec-pinned, unit-tested): log payloads must
// NEVER contain role assignments keyed to a player, seat tokens, host keys,
// night-action targets, vote contents, story text/theme, or player names.
// Player IDs and aggregate counts are fine. `logEvent` itself can't enforce
// this (it has no idea what a field "means") — the discipline lives in each
// call site's payload builder, and `assertLogHygiene` (test/server-only, see
// below) is the generic checker the test suite runs over every one of them.

/**
 * Emits one structured JSON log line: `{ evt: event, ...fields }`, `evt`
 * first (spec-pinned field order — makes eyeballing `wrangler tail` output
 * easier; JSON key order is preserved by `JSON.stringify` for
 * plain-object insertion order, which is exactly what we build here).
 *
 * Never throws and never awaited by callers — logging must never be able to
 * fail a game path. If `fields` contains something `JSON.stringify` can't
 * handle (a circular reference, a BigInt), we fall back to a minimal
 * "unloggable fields" line rather than let the exception escape.
 */
export function logEvent(event: string, fields: Record<string, unknown> = {}): void {
  try {
    console.log(JSON.stringify({ evt: event, ...fields }));
  } catch {
    try {
      console.log(JSON.stringify({ evt: event, logError: "unserializable_fields" }));
    } catch {
      // If even that fails, give up silently — never throw out of logEvent.
    }
  }
}
