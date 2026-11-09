// Pickup time windows (D73): fixed 2-hour windows 08:00–20:00 in Europe/Rome. The leg's pickupAt is the
// start of its window. Pure helpers, shared by the wizard (browser) and the server.
import { romeDate, romeLocalToDate } from "../pricing/calendar";

export const TIME_WINDOWS = ["08-10", "10-12", "12-14", "14-16", "16-18", "18-20"] as const;
export type TimeWindow = (typeof TIME_WINDOWS)[number];

export const TIME_WINDOW_LABEL: Record<TimeWindow, string> = {
  "08-10": "08:00 – 10:00",
  "10-12": "10:00 – 12:00",
  "12-14": "12:00 – 14:00",
  "14-16": "14:00 – 16:00",
  "16-18": "16:00 – 18:00",
  "18-20": "18:00 – 20:00",
};

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for a real calendar date "YYYY-MM-DD". */
export function isIsoDate(value: string): boolean {
  const m = ISO_DATE.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === value;
}

/** Start and end instant of a window on a Rome calendar date (DST-aware). */
export function windowRange(date: string, window: TimeWindow): { start: Date; end: Date } | null {
  if (!isIsoDate(date)) return null;
  const [from, to] = window.split("-");
  const start = romeLocalToDate(`${date}T${from}:00`);
  const end = romeLocalToDate(`${date}T${to}:00`);
  return start && end ? { start, end } : null;
}

/** Whole calendar days from `fromDate` to `toDate` (both "YYYY-MM-DD"); negative when toDate is earlier. */
export function daysBetween(fromDate: string, toDate: string): number {
  return Math.round((Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / 86_400_000);
}

/** Today's date in Rome ("YYYY-MM-DD"), e.g. for the min attribute of the date input. */
/** Calendar date `days` after an ISO date (YYYY-MM-DD), as ISO. Pure date arithmetic (no time zone). */
export function addDaysIso(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function romeToday(now: Date = new Date()): string {
  return romeDate(now).date;
}
