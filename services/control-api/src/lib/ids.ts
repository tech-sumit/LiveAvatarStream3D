/** Short, URL-safe, sortable-ish ids. */
export function newId(prefix: string): string {
  const ts = Date.now().toString(36);
  const rand = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  return `${prefix}_${ts}${rand}`;
}

export function now(): number {
  return Date.now();
}
