/**
 * The rules engine: elapsed time, daily percentage, and streaks.
 *
 * Everything here is a pure function over plain data. No database, no clock of
 * its own — `now` is always passed in. That is what makes the awkward cases
 * (the 90.00% boundary, a week's three scattered days, a paused task) testable
 * without standing up the app.
 */

import {
  DAILY_SUCCESS_DENOMINATOR,
  DAILY_SUCCESS_NUMERATOR,
  MONTHLY_REQUIRED_WEEKS,
  WEEKLY_REQUIRED_DAYS,
} from '../config.ts';
import { addDays, monthKeyOf, weekDays, weekStartOf, type DayKey } from './time.ts';

export type TaskStatus = 'idle' | 'running' | 'paused' | 'completed' | 'attempted';

export interface Interval {
  started_at: number;
  ended_at: number | null;
}

/**
 * Active working time across a set of intervals.
 *
 * An interval with ended_at === null is still running, so it contributes time
 * up to `now`. Gaps between intervals are pauses and contribute nothing, which
 * is the whole reason time is stored as segments rather than as a total.
 *
 * Note: a running interval keeps accruing even if the participant closed the
 * browser, which is the spec's literal requirement that timing survive a close.
 * If unattended tasks should instead auto-pause after some limit, that cap
 * belongs here.
 */
export function activeMs(intervals: Interval[], now: number): number {
  let total = 0;
  for (const interval of intervals) {
    const end = interval.ended_at ?? now;
    // Guard against a clock adjustment producing a negative segment.
    if (end > interval.started_at) total += end - interval.started_at;
  }
  return total;
}

/**
 * Does this completion count as a successful day?
 *
 * The spec draws a hard line: 90.00% succeeds, 89.99% fails. Comparing floats
 * would let 89.995 round up into a success, so this compares integers only —
 * completed/total >= 90/100 becomes completed*100 >= total*90.
 */
export function isDaySuccess(completed: number, total: number): boolean {
  if (total <= 0) return false;
  return completed * DAILY_SUCCESS_DENOMINATOR >= total * DAILY_SUCCESS_NUMERATOR;
}

/** Completion percentage rounded to two decimals, for display only. */
export function percentage(completed: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((completed / total) * 10_000) / 100;
}

/**
 * Consecutive successful days ending at today.
 *
 * Today is still in progress for most of its length, so an unsuccessful today
 * does not break the streak — the count simply starts from yesterday. Only a
 * finished day that failed breaks it.
 */
export function dailyStreak(successByDay: ReadonlyMap<DayKey, boolean>, today: DayKey): number {
  let cursor = successByDay.get(today) ? today : addDays(today, -1);
  let streak = 0;
  while (successByDay.get(cursor)) {
    streak += 1;
    cursor = addDays(cursor, -1);
  }
  return streak;
}

/** How many days in the Sunday–Saturday week containing `dayKey` succeeded. */
export function weekQualifyingDays(
  successByDay: ReadonlyMap<DayKey, boolean>,
  dayKey: DayKey,
): number {
  return weekDays(dayKey).filter((day) => successByDay.get(day)).length;
}

/**
 * A week succeeds on any three qualifying days, consecutive or not.
 * Sunday + Wednesday + Saturday is as valid as three days in a row.
 */
export function isWeekSuccess(
  successByDay: ReadonlyMap<DayKey, boolean>,
  dayKey: DayKey,
): boolean {
  return weekQualifyingDays(successByDay, dayKey) >= WEEKLY_REQUIRED_DAYS;
}

/**
 * Successful weeks within the calendar month containing `dayKey`.
 *
 * A week is attributed to the month its Sunday falls in. The spec does not say
 * how to handle a week straddling two months, so this picks one rule and
 * applies it consistently rather than counting such a week twice.
 */
export function monthSuccessfulWeeks(
  successByDay: ReadonlyMap<DayKey, boolean>,
  dayKey: DayKey,
): number {
  const month = monthKeyOf(dayKey);
  const seen = new Set<DayKey>();
  let count = 0;

  // Walk every week whose Sunday lands in this month.
  let cursor = weekStartOf(`${month}-01`);
  if (monthKeyOf(cursor) !== month) cursor = addDays(cursor, 7);

  while (monthKeyOf(cursor) === month) {
    if (!seen.has(cursor)) {
      seen.add(cursor);
      if (isWeekSuccess(successByDay, cursor)) count += 1;
    }
    cursor = addDays(cursor, 7);
  }
  return count;
}

/** The month succeeds once three of its weeks have succeeded. */
export function isMonthSuccess(
  successByDay: ReadonlyMap<DayKey, boolean>,
  dayKey: DayKey,
): boolean {
  return monthSuccessfulWeeks(successByDay, dayKey) >= MONTHLY_REQUIRED_WEEKS;
}

/**
 * How many more tasks are needed to reach the daily threshold.
 * Drives both the dashboard hint and the WhatsApp reminder text.
 */
export function tasksNeededForSuccess(completed: number, total: number): number {
  if (total <= 0) return 0;
  // Smallest c with c*100 >= total*90.
  const required = Math.ceil((total * DAILY_SUCCESS_NUMERATOR) / DAILY_SUCCESS_DENOMINATOR);
  return Math.max(0, required - completed);
}
