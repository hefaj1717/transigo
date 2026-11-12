// Warehouses the customer can pick in the Deposito wizard (D178). Pure: search by city, province or name.

export type PublicWarehouse = { id: string; name: string; address: string; city: string; province: string };

/** Lower case, without accents and extra spaces ("Forlì" → "forli"). */
const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Warehouses matching the query: every word must appear in the city, province code, name or address. An empty
 * query returns all of them. Order: city match first, then city name, then warehouse name.
 */
export function searchWarehouses(list: readonly PublicWarehouse[], query: string): PublicWarehouse[] {
  const words = norm(query).split(" ").filter(Boolean);
  const hay = (w: PublicWarehouse) => norm(`${w.city} ${w.province} ${w.name} ${w.address}`);
  const sorted = [...list].sort((a, b) => a.city.localeCompare(b.city, "it") || a.name.localeCompare(b.name, "it"));
  if (!words.length) return sorted;
  const hits = sorted.filter((w) => words.every((x) => hay(w).includes(x)));
  const q = norm(query);
  return [...hits.filter((w) => norm(w.city).startsWith(q)), ...hits.filter((w) => !norm(w.city).startsWith(q))];
}
