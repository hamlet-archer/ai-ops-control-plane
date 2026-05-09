import { createHash } from "node:crypto";

/**
 * Sender-scoped dedupe key. SHA256 hex of the parts joined by ":".
 *
 * Convention from CLAUDE.md + ARCHITECTURE.md §6.6:
 *   computeDedupeKey(["comms-adviser", staffId, channel, threadRef])
 * The first part should be the sender agent id so two agents can't
 * collide on the same natural key.
 */
export function computeDedupeKey(parts: readonly string[]): string {
  if (parts.length === 0) {
    throw new Error("computeDedupeKey: parts must be non-empty");
  }
  const h = createHash("sha256");
  h.update(parts.join(":"));
  return h.digest("hex");
}
