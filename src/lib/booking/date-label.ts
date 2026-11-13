// Italian label for a wizard date ("YYYY-MM-DD", a calendar day without time zone).
// Formatted at noon UTC with timeZone UTC, so the day never shifts with the browser's time zone.
export function bookingDateLabel(iso: string | null | undefined, opts: { weekday?: boolean } = {}): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return "";
  const d = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("it-IT", {
    timeZone: "UTC",
    weekday: opts.weekday ? "long" : undefined,
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}
