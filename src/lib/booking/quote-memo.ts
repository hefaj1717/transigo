// Browser-side memo for the wizards' live quotes (speed, owner 2026-11-13). The wizard asks for a quote while the
// customer edits and again on "Avanti": with the same state and session the second request reuses the first one
// (even while it is still on its way), so "Avanti" does not wait for a duplicate round trip.
// The server stays the only place where prices are computed (D76) — this only avoids asking twice for the same thing.

export type QuoteMemo<R> = (key: string, load: () => Promise<R>) => Promise<R>;

export function createQuoteMemo<R>(opts: { ttlMs?: number; max?: number; keep?: (result: R) => boolean } = {}): QuoteMemo<R> {
  const ttl = opts.ttlMs ?? 60_000; // well below the stored quote's validity (settings.quote_valid_minutes)
  const max = opts.max ?? 8;
  const entries = new Map<string, { at: number; promise: Promise<R> }>();

  return (key, load) => {
    const hit = entries.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.promise;
    const entry = { at: Date.now(), promise: load() };
    entries.delete(key);
    entries.set(key, entry);
    if (entries.size > max) entries.delete(entries.keys().next().value as string);
    // Transient failures (connection, maps or pricing unavailable) are not remembered: the next ask retries.
    void entry.promise.then(
      (r) => {
        if (opts.keep && !opts.keep(r) && entries.get(key) === entry) entries.delete(key);
      },
      () => {
        if (entries.get(key) === entry) entries.delete(key);
      },
    );
    return entry.promise;
  };
}

const TRANSIENT = new Set(["pricing_unavailable", "maps_unavailable"]);

/** Default `keep` for the wizards' quote responses: everything except transient errors. */
export function keepQuoteResult(r: { ok: boolean; error?: { code: string } }): boolean {
  return r.ok || !TRANSIENT.has(r.error?.code ?? "");
}
