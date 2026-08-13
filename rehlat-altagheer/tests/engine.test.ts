import test from 'node:test';
import assert from 'node:assert/strict';

import {
  activeMs,
  dailyStreak,
  isDaySuccess,
  isMonthSuccess,
  isWeekSuccess,
  monthSuccessfulWeeks,
  percentage,
  tasksNeededForSuccess,
} from '../src/lib/engine.ts';
import {
  addDays,
  daysBetween,
  formatDuration,
  weekDays,
  weekEndOf,
  weekStartOf,
  weekdayOf,
} from '../src/lib/time.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

// 2026-08-11 is a Tuesday; its week runs Sun 2026-08-09 .. Sat 2026-08-15.
const TUESDAY = '2026-08-11';

test('paused time is excluded from active time', () => {
  // Worked 10 min, paused 50 min, worked 10 min. Only the work counts.
  const intervals = [
    { started_at: 0, ended_at: 10 * MINUTE },
    { started_at: 60 * MINUTE, ended_at: 70 * MINUTE },
  ];
  assert.equal(activeMs(intervals, 999 * HOUR), 20 * MINUTE);
});

test('a running interval accrues time up to now', () => {
  const intervals = [
    { started_at: 0, ended_at: 10 * MINUTE },
    { started_at: 30 * MINUTE, ended_at: null },
  ];
  assert.equal(activeMs(intervals, 45 * MINUTE), 25 * MINUTE);
});

test('active time survives a refresh: recomputed from the same stored rows', () => {
  const intervals = [{ started_at: 1_000_000, ended_at: null }];
  const first = activeMs(intervals, 1_000_000 + 5 * MINUTE);
  const afterReload = activeMs(intervals, 1_000_000 + 5 * MINUTE);
  assert.equal(first, afterReload);
  assert.equal(first, 5 * MINUTE);
});

test("the spec's worked example sums to 03:10:00", () => {
  const task1 = 40 * MINUTE + 12_000; // 00:40:12
  const task2 = 1 * HOUR + 20 * MINUTE + 3_000; // 01:20:03
  const task3 = 1 * HOUR + 9 * MINUTE + 45_000; // 01:09:45
  assert.equal(formatDuration(task1 + task2 + task3), '03:10:00');
});

test('90.00% succeeds and 89.99% does not', () => {
  assert.equal(isDaySuccess(9, 10), true, '9/10 is exactly 90%');
  assert.equal(isDaySuccess(90, 100), true);
  assert.equal(isDaySuccess(89, 100), false);
  // 8999/10000 = 89.99%, the boundary the spec calls out explicitly.
  assert.equal(isDaySuccess(8999, 10_000), false);
  assert.equal(isDaySuccess(9000, 10_000), true);
});

test('a near miss is not rounded up into a success', () => {
  // 89.995% would become 90.00% under naive 2-decimal rounding.
  assert.equal(percentage(17_999, 20_000), 90);
  assert.equal(isDaySuccess(17_999, 20_000), false);
});

test('a day with no tasks is not a success', () => {
  assert.equal(isDaySuccess(0, 0), false);
  assert.equal(percentage(0, 0), 0);
});

test('tasksNeededForSuccess reports what is still missing', () => {
  assert.equal(tasksNeededForSuccess(8, 10), 1);
  assert.equal(tasksNeededForSuccess(9, 10), 0);
  assert.equal(tasksNeededForSuccess(10, 10), 0);
  assert.equal(tasksNeededForSuccess(0, 10), 9);
});

test('the week runs Sunday to Saturday', () => {
  assert.equal(weekdayOf(TUESDAY), 2);
  assert.equal(weekStartOf(TUESDAY), '2026-08-09');
  assert.equal(weekEndOf(TUESDAY), '2026-08-15');
  assert.equal(weekdayOf('2026-08-09'), 0, 'week start is a Sunday');
  assert.equal(weekdayOf('2026-08-15'), 6, 'week end is a Saturday');
  // A Sunday belongs to its own week, not the previous one.
  assert.equal(weekStartOf('2026-08-09'), '2026-08-09');
  // A Saturday is the last day of its week, not the first of the next.
  assert.equal(weekStartOf('2026-08-15'), '2026-08-09');
  assert.deepEqual(weekDays(TUESDAY)[0], '2026-08-09');
  assert.equal(weekDays(TUESDAY).length, 7);
});

test('date arithmetic crosses month and year boundaries', () => {
  assert.equal(addDays('2026-08-31', 1), '2026-09-01');
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29', '2028 is a leap year');
  assert.equal(daysBetween('2026-08-09', '2026-08-15'), 6);
});

test('three scattered days satisfy the week', () => {
  // Sunday + Wednesday + Saturday, the spec's own example.
  const success = new Map([
    ['2026-08-09', true],
    ['2026-08-12', true],
    ['2026-08-15', true],
  ]);
  assert.equal(isWeekSuccess(success, TUESDAY), true);
});

test('two qualifying days are not enough for the week', () => {
  const success = new Map([
    ['2026-08-09', true],
    ['2026-08-12', true],
  ]);
  assert.equal(isWeekSuccess(success, TUESDAY), false);
});

test('qualifying days from a neighbouring week do not count', () => {
  // Two days inside the week, plus two from the week before.
  const success = new Map([
    ['2026-08-02', true],
    ['2026-08-08', true],
    ['2026-08-09', true],
    ['2026-08-12', true],
  ]);
  assert.equal(isWeekSuccess(success, TUESDAY), false);
});

test('daily streak counts consecutive successful days', () => {
  const success = new Map([
    ['2026-08-09', true],
    ['2026-08-10', true],
    ['2026-08-11', true],
  ]);
  assert.equal(dailyStreak(success, TUESDAY), 3);
});

test('a today still in progress does not break the streak', () => {
  // Today has not reached 90% yet, but yesterday and the day before did.
  const success = new Map([
    ['2026-08-09', true],
    ['2026-08-10', true],
    ['2026-08-11', false],
  ]);
  assert.equal(dailyStreak(success, TUESDAY), 2);
});

test('a failed day breaks the streak', () => {
  const success = new Map([
    ['2026-08-08', true],
    ['2026-08-09', false],
    ['2026-08-10', true],
  ]);
  assert.equal(dailyStreak(success, TUESDAY), 1, 'only yesterday survives');
});

test('three successful weeks satisfy the month', () => {
  // August 2026 Sundays: 2, 9, 16, 23, 30. Make the first three weeks succeed.
  const success = new Map<string, boolean>();
  for (const sunday of ['2026-08-02', '2026-08-09', '2026-08-16']) {
    success.set(sunday, true);
    success.set(addDays(sunday, 2), true);
    success.set(addDays(sunday, 4), true);
  }
  assert.equal(monthSuccessfulWeeks(success, TUESDAY), 3);
  assert.equal(isMonthSuccess(success, TUESDAY), true);
});

test('two successful weeks do not satisfy the month', () => {
  const success = new Map<string, boolean>();
  for (const sunday of ['2026-08-02', '2026-08-09']) {
    success.set(sunday, true);
    success.set(addDays(sunday, 2), true);
    success.set(addDays(sunday, 4), true);
  }
  assert.equal(monthSuccessfulWeeks(success, TUESDAY), 2);
  assert.equal(isMonthSuccess(success, TUESDAY), false);
});

test('formatDuration pads every field', () => {
  assert.equal(formatDuration(0), '00:00:00');
  assert.equal(formatDuration(9_000), '00:00:09');
  assert.equal(formatDuration(HOUR + MINUTE + 1_000), '01:01:01');
  assert.equal(formatDuration(-5_000), '00:00:00', 'never renders a negative');
});
