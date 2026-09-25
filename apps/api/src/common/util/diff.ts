/**
 * Audit diffs.
 *
 * Storing whole rows before and after makes an audit log unreadable and leaks
 * fields nobody asked about. Storing only what changed keeps "who moved the
 * platform fee from 3.50 to 6.00" answerable at a glance.
 */

/** Structural comparison good enough for the scalars and dates we audit. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a === null || a === undefined || b === null || b === undefined) return false;
  if (typeof a === 'object' && typeof b === 'object') {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
  return false;
}

export interface AuditDiff {
  readonly before: Record<string, unknown>;
  readonly after: Record<string, unknown>;
  readonly changedKeys: readonly string[];
}

/**
 * Keys present in `next` whose value differs from `current`.
 *
 * `undefined` in `next` means "not supplied", not "set to undefined", so it is
 * skipped — otherwise every PATCH would claim to have cleared every field it
 * did not mention.
 */
export function diffFields(
  current: Record<string, unknown>,
  next: Record<string, unknown>,
): AuditDiff {
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  const changedKeys: string[] = [];

  for (const [key, nextValue] of Object.entries(next)) {
    if (nextValue === undefined) continue;
    const currentValue = current[key];
    if (sameValue(currentValue, nextValue)) continue;

    before[key] = currentValue ?? null;
    after[key] = nextValue;
    changedKeys.push(key);
  }

  return { before, after, changedKeys };
}
