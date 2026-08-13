/**
 * Timezone-aware calendar helpers.
 *
 * Two kinds of value are used throughout the system and must not be confused:
 *
 *   instant  — an exact moment, stored as epoch milliseconds (UTC). All
 *              timestamps in the database are instants.
 *   dayKey   — a calendar date 'YYYY-MM-DD' as seen in APP_TIMEZONE. All
 *              grouping (a participant's day, a week, a month) uses these.
 *
 * Converting instant -> dayKey is the only place the timezone matters, and it
 * happens here.
 */

// Relative rather than aliased: these modules are also loaded directly by the
// Node test runner, which does not know about the bundler's '@/' path alias.
import { APP_TIMEZONE } from '../config.ts';

export type DayKey = string; // 'YYYY-MM-DD'
export type MonthKey = string; // 'YYYY-MM'

const dayKeyFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: APP_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** The calendar date, in the app timezone, that a given instant falls on. */
export function dayKeyOf(instantMs: number): DayKey {
  // 'en-CA' formats as YYYY-MM-DD, which is exactly the shape we want.
  return dayKeyFormatter.format(new Date(instantMs));
}

export function todayKey(now: number = Date.now()): DayKey {
  return dayKeyOf(now);
}

/**
 * Day-of-week for a calendar date, 0 = Sunday .. 6 = Saturday.
 *
 * A dayKey is a plain calendar date with no timezone of its own, so it is
 * anchored at noon UTC purely for the arithmetic. Noon leaves ~12 hours of
 * slack on either side, which keeps whole-day addition from ever slipping into
 * the neighbouring date.
 */
export function weekdayOf(dayKey: DayKey): number {
  return new Date(`${dayKey}T12:00:00Z`).getUTCDay();
}

/** Shift a calendar date by a whole number of days. */
export function addDays(dayKey: DayKey, delta: number): DayKey {
  const anchor = new Date(`${dayKey}T12:00:00Z`);
  anchor.setUTCDate(anchor.getUTCDate() + delta);
  return anchor.toISOString().slice(0, 10);
}

/**
 * The Sunday that begins the week containing dayKey.
 *
 * The spec defines the week as Sunday 12:00 AM through Saturday 11:59 PM, so
 * the Sunday's dayKey is used as the week's identity.
 */
export function weekStartOf(dayKey: DayKey): DayKey {
  return addDays(dayKey, -weekdayOf(dayKey));
}

/** The Saturday that ends the week containing dayKey. */
export function weekEndOf(dayKey: DayKey): DayKey {
  return addDays(weekStartOf(dayKey), 6);
}

/** All seven dayKeys of the week containing dayKey, Sunday first. */
export function weekDays(dayKey: DayKey): DayKey[] {
  const start = weekStartOf(dayKey);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

export function monthKeyOf(dayKey: DayKey): MonthKey {
  return dayKey.slice(0, 7);
}

/** Inclusive count of days from `from` to `to`. Negative if `to` precedes `from`. */
export function daysBetween(from: DayKey, to: DayKey): number {
  const a = new Date(`${from}T12:00:00Z`).getTime();
  const b = new Date(`${to}T12:00:00Z`).getTime();
  return Math.round((b - a) / 86_400_000);
}

/** Format a duration in milliseconds as HH:MM:SS, as the spec's examples show. */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((n) => String(n).padStart(2, '0')).join(':');
}
