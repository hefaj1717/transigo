// Calendar helpers for surcharges. Dates are evaluated in Italian local time (D51).

export const PRICING_TIME_ZONE = "Europe/Rome";

const formatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: PRICING_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  weekday: "short",
});

/** Calendar date ("YYYY-MM-DD") and weekday of an instant in Europe/Rome. */
export function romeDate(instant: Date): { date: string; weekday: string } {
  const parts = Object.fromEntries(formatter.formatToParts(instant).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, weekday: parts.weekday };
}

/** Saturday, Sunday or a national holiday (D51). One surcharge, never counted twice. */
export function isWeekendOrHoliday(instant: Date, holidays: ReadonlySet<string>): boolean {
  const { date, weekday } = romeDate(instant);
  return weekday === "Sat" || weekday === "Sun" || holidays.has(date);
}

const offsetFormatter = new Intl.DateTimeFormat("en-US", { timeZone: PRICING_TIME_ZONE, timeZoneName: "longOffset" });

/** Offset of Europe/Rome from UTC at an instant, in minutes (60 in winter, 120 in summer). */
function romeOffsetMinutes(instant: Date): number {
  const name = offsetFormatter.formatToParts(instant).find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const m = /GMT([+-])(\d{2}):?(\d{2})?/.exec(name);
  if (!m) return 0;
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0));
}

/** Parses "YYYY-MM-DDTHH:mm" (an <input type="datetime-local"> value) as Italian local time. */
export function romeLocalToDate(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!m) return null;
  const asUtc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  let result = asUtc - romeOffsetMinutes(new Date(asUtc)) * 60_000;
  // Second pass fixes the hours around the DST switch.
  result = asUtc - romeOffsetMinutes(new Date(result)) * 60_000;
  return Number.isNaN(result) ? null : new Date(result);
}
