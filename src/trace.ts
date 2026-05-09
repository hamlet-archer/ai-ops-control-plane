import { uuidv7 } from "uuidv7";

/**
 * Generate a new trace id (UUIDv7 hex string with dashes).
 *
 * UUIDv7 is time-ordered: lexical sort matches chronological sort within
 * a single process, with monotonicity guarantees from the underlying lib
 * (`uuidv7` by LiosK — per-process counter bumps sub-millisecond
 * collisions instead of dropping resolution).
 *
 * Mixing UUIDv7 implementations within a process breaks monotonicity (no
 * shared counter). Always import from this module — never construct a
 * trace id from elsewhere.
 */
export function newTraceId(): string {
  return uuidv7();
}
