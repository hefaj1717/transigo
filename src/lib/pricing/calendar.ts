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
