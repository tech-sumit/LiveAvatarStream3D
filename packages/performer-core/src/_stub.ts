/**
 * Phase-0 stub marker — replaced by real math in Phase 2. Takes the call's args so the real
 * parameter names stay in each solver's signature (and `.d.ts`) without tripping
 * `no-unused-vars`, while the args themselves are intentionally discarded.
 */
export function notImplemented(name: string, _args: unknown): never {
  throw new Error(`${name}: not implemented (Phase 2)`);
}
