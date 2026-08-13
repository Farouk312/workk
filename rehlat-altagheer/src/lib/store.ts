/**
 * All domain reads and writes.
 *
 * This is the seam. Components and route handlers call these functions and know
 * nothing about SQL. Moving to Supabase later means reimplementing this file
 * against Postgres and leaving the rest of the app alone.
 *
 * Two invariants everything else relies on:
 *   1. Elapsed time is never stored as a total, only derived from intervals.
 *   2. At most one task per participant may be running at a time, so overlapping
 *      timers can never inflate a daily total past the wall clock.
 */

import 'server-only';

import { all, bool, get, run, transaction } from './db/index.ts';
import {
  activeMs,
  dailyStreak,
  isDaySuccess,
  percentage,
  tasksNeededForSuccess,
  weekQualifyingDays,
  type Interval,
  type TaskStatus,
} from './engine.ts';
import { dayKeyOf, todayKey, type DayKey } from './time.ts';
import { hashPin } from './auth.ts';

/* ------------------------------------------------------------------ *
 * Types crossing the seam
 * ------------------------------------------------------------------ */

export interface TaskView {
  taskId: number;
  name: string;
  counts: boolean;
  status: TaskStatus;
  /** Time from finished intervals only. The client adds the live segment itself. */
  closedMs: number;
  /** Server timestamp the open interval began, or null when not running. */
  runningSince: number | null;
  pauseCount: number;
  reopenCount: number;
  completedAt: number | null;
}

export interface DayView {
  dayKey: DayKey;
  serverNow: number;
  dayStartedAt: number | null;
  dayEndedAt: number | null;
  dayState: 'not_started' | 'active' | 'ended';
  tasks: TaskView[];
  closedTotalMs: number;
  completedCount: number;
  countedTotal: number;
  percentage: number;
  isSuccess: boolean;
  tasksNeeded: number;
}

export interface LeaderRow {
  participantId: number;
  name: string;
  completedCount: number;
  countedTotal: number;
  percentage: number;
  activeMs: number;
  isSuccess: boolean;
  dayState: 'not_started' | 'active' | 'ended';
  dailyStreak: number;
  weekQualifyingDays: number;
}

export type ActivityEvent =
  | 'day_started'
  | 'day_ended'
  | 'task_started'
  | 'task_paused'
  | 'task_auto_paused'
  | 'task_resumed'
  | 'task_completed'
  | 'task_attempted'
  | 'task_reopened'
  | 'pin_set'
  | 'pin_reset'
  | 'participant_added'
  | 'participant_removed'
  | 'task_added'
  | 'task_renamed'
  | 'task_archived';

/* ------------------------------------------------------------------ *
 * Audit log — append only
 * ------------------------------------------------------------------ */

function logEvent(
  participantId: number,
  event: ActivityEvent,
  at: number,
  taskId: number | null = null,
  detail: string | null = null,
  dayKey: DayKey = dayKeyOf(at),
): void {
  run(
    'INSERT INTO activity_log (participant_id, task_id, day_key, event, at, detail) VALUES (?, ?, ?, ?, ?, ?)',
    participantId,
    taskId,
    dayKey,
    event,
    at,
    detail,
  );
}

/* ------------------------------------------------------------------ *
 * Participants
 * ------------------------------------------------------------------ */

export interface ParticipantRow {
  id: number;
  name: string;
  is_admin: number;
  must_set_pin: number;
  pin_hash: string | null;
  pin_salt: string | null;
  locale: string;
  whatsapp: string | null;
  active: number;
}

/** Names only — the login screen must never receive PIN material. */
export function listParticipantsForLogin(): { id: number; name: string; needsPin: boolean }[] {
  return all<{ id: number; name: string; must_set_pin: number; pin_hash: string | null }>(
    'SELECT id, name, must_set_pin, pin_hash FROM participants WHERE active = 1 ORDER BY name COLLATE NOCASE',
  ).map((row) => ({
    id: row.id,
    name: row.name,
    needsPin: row.must_set_pin === 1 || row.pin_hash === null,
  }));
}

export function listParticipants(): ParticipantRow[] {
  return all<ParticipantRow>('SELECT * FROM participants ORDER BY name COLLATE NOCASE');
}

export function findParticipant(id: number): ParticipantRow | undefined {
  return get<ParticipantRow>('SELECT * FROM participants WHERE id = ?', id);
}

export function setParticipantPin(participantId: number, pin: string, now = Date.now()): void {
  const { hash, salt } = hashPin(pin);
  transaction(() => {
    run(
      'UPDATE participants SET pin_hash = ?, pin_salt = ?, must_set_pin = 0 WHERE id = ?',
      hash,
      salt,
      participantId,
    );
    logEvent(participantId, 'pin_set', now);
  });
}

/* ------------------------------------------------------------------ *
 * Tasks
 * ------------------------------------------------------------------ */

export interface TaskRow {
  id: number;
  name: string;
  position: number;
  counts_toward_percentage: number;
  archived: number;
}

export function listTasks(includeArchived = false): TaskRow[] {
  return all<TaskRow>(
    includeArchived
      ? 'SELECT * FROM tasks ORDER BY position, id'
      : 'SELECT * FROM tasks WHERE archived = 0 ORDER BY position, id',
  );
}

/* ------------------------------------------------------------------ *
 * The day
 * ------------------------------------------------------------------ */

interface DailySessionRow {
  id: number;
  started_at: number;
  ended_at: number | null;
  state: string;
}

function findDailySession(participantId: number, dayKey: DayKey): DailySessionRow | undefined {
  return get<DailySessionRow>(
    'SELECT id, started_at, ended_at, state FROM daily_sessions WHERE participant_id = ? AND day_key = ?',
    participantId,
    dayKey,
  );
}

/**
 * Begin the participant's day.
 *
 * Signing in must never do this implicitly — the spec is explicit that the day
 * starts only on the deliberate action. Creating the task_days rows here also
 * fixes the day's denominator, so a task archived next week cannot retroactively
 * change a percentage that was already earned.
 */
export function startDay(participantId: number, now = Date.now()): void {
  const dayKey = dayKeyOf(now);
  transaction(() => {
    const existing = findDailySession(participantId, dayKey);
    if (existing) {
      // Re-opening an ended day rather than creating a duplicate.
      if (existing.state === 'ended') {
        run("UPDATE daily_sessions SET state = 'active', ended_at = NULL, end_reason = NULL WHERE id = ?", existing.id);
        logEvent(participantId, 'day_started', now, null, 'resumed_after_end', dayKey);
      }
      return;
    }

    run(
      "INSERT INTO daily_sessions (participant_id, day_key, started_at, state) VALUES (?, ?, ?, 'active')",
      participantId,
      dayKey,
      now,
    );

    for (const task of listTasks()) {
      run(
        "INSERT OR IGNORE INTO task_days (participant_id, task_id, day_key, status) VALUES (?, ?, ?, 'idle')",
        participantId,
        task.id,
        dayKey,
      );
    }
    logEvent(participantId, 'day_started', now, null, null, dayKey);
  });
}

/** End the day manually, or automatically once every task is completed. */
export function endDay(
  participantId: number,
  now = Date.now(),
  reason: 'manual' | 'auto_all_complete' = 'manual',
): void {
  const dayKey = dayKeyOf(now);
  transaction(() => {
    const session = findDailySession(participantId, dayKey);
    if (!session || session.state === 'ended') return;

    // Close any running task first so no interval is left open forever.
    closeOpenInterval(participantId, dayKey, now);
    run(
      "UPDATE task_days SET status = 'paused' WHERE participant_id = ? AND day_key = ? AND status = 'running'",
      participantId,
      dayKey,
    );

    run(
      "UPDATE daily_sessions SET state = 'ended', ended_at = ?, end_reason = ? WHERE id = ?",
      now,
      reason,
      session.id,
    );
    logEvent(participantId, 'day_ended', now, null, reason, dayKey);
  });
}

/* ------------------------------------------------------------------ *
 * Task actions
 * ------------------------------------------------------------------ */

function openIntervalOf(
  participantId: number,
  dayKey: DayKey,
): { id: number; task_id: number; started_at: number } | undefined {
  return get<{ id: number; task_id: number; started_at: number }>(
    'SELECT id, task_id, started_at FROM task_intervals WHERE participant_id = ? AND day_key = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1',
    participantId,
    dayKey,
  );
}

/** Close whichever interval is currently running. Returns the task it belonged to. */
function closeOpenInterval(participantId: number, dayKey: DayKey, now: number): number | null {
  const open = openIntervalOf(participantId, dayKey);
  if (!open) return null;
  run('UPDATE task_intervals SET ended_at = ? WHERE id = ?', Math.max(now, open.started_at), open.id);
  return open.task_id;
}

function requireActiveDay(participantId: number, dayKey: DayKey): DailySessionRow {
  const session = findDailySession(participantId, dayKey);
  if (!session) throw new Error('day_not_started');
  if (session.state === 'ended') throw new Error('day_ended');
  return session;
}

function taskDayStatus(participantId: number, taskId: number, dayKey: DayKey): TaskStatus | null {
  const row = get<{ status: string }>(
    'SELECT status FROM task_days WHERE participant_id = ? AND task_id = ? AND day_key = ?',
    participantId,
    taskId,
    dayKey,
  );
  return (row?.status as TaskStatus) ?? null;
}

/**
 * Start or resume a task's timer.
 *
 * Any other running task is paused first. Two timers running at once would let
 * a participant record more task time in a day than the day physically contains.
 */
export function startTask(participantId: number, taskId: number, now = Date.now()): void {
  const dayKey = dayKeyOf(now);
  transaction(() => {
    requireActiveDay(participantId, dayKey);

    const status = taskDayStatus(participantId, taskId, dayKey);
    if (status === null) throw new Error('task_not_in_day');
    if (status === 'running') return; // already running; nothing to do
    if (status === 'completed') throw new Error('task_completed');

    const pausedTaskId = closeOpenInterval(participantId, dayKey, now);
    if (pausedTaskId !== null && pausedTaskId !== taskId) {
      run(
        "UPDATE task_days SET status = 'paused', pause_count = pause_count + 1 WHERE participant_id = ? AND task_id = ? AND day_key = ?",
        participantId,
        pausedTaskId,
        dayKey,
      );
      logEvent(participantId, 'task_auto_paused', now, pausedTaskId, 'another_task_started', dayKey);
    }

    run(
      'INSERT INTO task_intervals (participant_id, task_id, day_key, started_at) VALUES (?, ?, ?, ?)',
      participantId,
      taskId,
      dayKey,
      now,
    );
    run(
      "UPDATE task_days SET status = 'running' WHERE participant_id = ? AND task_id = ? AND day_key = ?",
      participantId,
      taskId,
      dayKey,
    );
    logEvent(participantId, status === 'paused' ? 'task_resumed' : 'task_started', now, taskId, null, dayKey);
  });
}

/** Pause a running task. The gap until resume is simply not recorded. */
export function pauseTask(participantId: number, taskId: number, now = Date.now()): void {
  const dayKey = dayKeyOf(now);
  transaction(() => {
    requireActiveDay(participantId, dayKey);
    if (taskDayStatus(participantId, taskId, dayKey) !== 'running') return;

    closeOpenInterval(participantId, dayKey, now);
    run(
      "UPDATE task_days SET status = 'paused', pause_count = pause_count + 1 WHERE participant_id = ? AND task_id = ? AND day_key = ?",
      participantId,
      taskId,
      dayKey,
    );
    logEvent(participantId, 'task_paused', now, taskId, null, dayKey);
  });
}

/**
 * Finish a task, either way.
 *
 * 'completed' counts toward the percentage. 'attempted' does not, but its time
 * is kept in full — the spec is explicit that an unsuccessful attempt is still
 * real work and is exactly the kind of signal the analysis needs.
 */
export function finishTask(
  participantId: number,
  taskId: number,
  outcome: 'completed' | 'attempted',
  now = Date.now(),
): void {
  const dayKey = dayKeyOf(now);
  transaction(() => {
    requireActiveDay(participantId, dayKey);

    const status = taskDayStatus(participantId, taskId, dayKey);
    if (status === null) throw new Error('task_not_in_day');
    // Guard against a double submit turning one completion into two events.
    if (status === 'completed' && outcome === 'completed') return;

    const open = openIntervalOf(participantId, dayKey);
    if (open && open.task_id === taskId) closeOpenInterval(participantId, dayKey, now);

    run(
      'UPDATE task_days SET status = ?, completed_at = ? WHERE participant_id = ? AND task_id = ? AND day_key = ?',
      outcome,
      outcome === 'completed' ? now : null,
      participantId,
      taskId,
      dayKey,
    );
    logEvent(participantId, outcome === 'completed' ? 'task_completed' : 'task_attempted', now, taskId, null, dayKey);
  });

  if (outcome === 'completed') autoEndDayIfAllComplete(participantId, now);
}

/** Reopen a completed task. The previous completion stays in the audit log. */
export function reopenTask(participantId: number, taskId: number, now = Date.now()): void {
  const dayKey = dayKeyOf(now);
  transaction(() => {
    const session = findDailySession(participantId, dayKey);
    if (!session) throw new Error('day_not_started');

    const status = taskDayStatus(participantId, taskId, dayKey);
    if (status !== 'completed' && status !== 'attempted') return;

    run(
      "UPDATE task_days SET status = 'paused', completed_at = NULL, reopen_count = reopen_count + 1 WHERE participant_id = ? AND task_id = ? AND day_key = ?",
      participantId,
      taskId,
      dayKey,
    );
    // Reopening revives a day that auto-ended when the last task was completed.
    if (session.state === 'ended') {
      run("UPDATE daily_sessions SET state = 'active', ended_at = NULL, end_reason = NULL WHERE id = ?", session.id);
    }
    logEvent(participantId, 'task_reopened', now, taskId, `was_${status}`, dayKey);
  });
}

/** Once every counting task is completed, the day reaches its finished state. */
function autoEndDayIfAllComplete(participantId: number, now: number): void {
  const dayKey = dayKeyOf(now);
  const totals = get<{ counted: number; completed: number }>(
    `SELECT COUNT(*) AS counted,
            SUM(CASE WHEN td.status = 'completed' THEN 1 ELSE 0 END) AS completed
       FROM task_days td
       JOIN tasks t ON t.id = td.task_id
      WHERE td.participant_id = ? AND td.day_key = ? AND t.counts_toward_percentage = 1`,
    participantId,
    dayKey,
  );
  if (totals && totals.counted > 0 && totals.completed === totals.counted) {
    endDay(participantId, now, 'auto_all_complete');
  }
}

/* ------------------------------------------------------------------ *
 * Reading a day
 * ------------------------------------------------------------------ */

function intervalsFor(participantId: number, dayKey: DayKey): Map<number, Interval[]> {
  const rows = all<{ task_id: number; started_at: number; ended_at: number | null }>(
    'SELECT task_id, started_at, ended_at FROM task_intervals WHERE participant_id = ? AND day_key = ? ORDER BY started_at',
    participantId,
    dayKey,
  );
  const byTask = new Map<number, Interval[]>();
  for (const row of rows) {
    const list = byTask.get(row.task_id) ?? [];
    list.push({ started_at: row.started_at, ended_at: row.ended_at });
    byTask.set(row.task_id, list);
  }
  return byTask;
}

export function getDayView(participantId: number, now = Date.now(), dayKey = dayKeyOf(now)): DayView {
  const session = findDailySession(participantId, dayKey);
  const intervals = intervalsFor(participantId, dayKey);

  const taskDayRows = all<{
    task_id: number;
    name: string;
    counts_toward_percentage: number;
    status: string;
    completed_at: number | null;
    pause_count: number;
    reopen_count: number;
  }>(
    `SELECT td.task_id, t.name, t.counts_toward_percentage, td.status, td.completed_at,
            td.pause_count, td.reopen_count
       FROM task_days td
       JOIN tasks t ON t.id = td.task_id
      WHERE td.participant_id = ? AND td.day_key = ?
      ORDER BY t.position, t.id`,
    participantId,
    dayKey,
  );

  // Before the day is started there are no task_days rows yet, so preview the
  // current shared task list in an idle state.
  const source =
    taskDayRows.length > 0
      ? taskDayRows
      : listTasks().map((task) => ({
          task_id: task.id,
          name: task.name,
          counts_toward_percentage: task.counts_toward_percentage,
          status: 'idle',
          completed_at: null,
          pause_count: 0,
          reopen_count: 0,
        }));

  const tasks: TaskView[] = source.map((row) => {
    const list = intervals.get(row.task_id) ?? [];
    const open = list.find((interval) => interval.ended_at === null) ?? null;
    const closed = list.filter((interval) => interval.ended_at !== null);
    return {
      taskId: row.task_id,
      name: row.name,
      counts: row.counts_toward_percentage === 1,
      status: row.status as TaskStatus,
      closedMs: activeMs(closed, now),
      runningSince: open ? open.started_at : null,
      pauseCount: row.pause_count,
      reopenCount: row.reopen_count,
      completedAt: row.completed_at,
    };
  });

  const counting = tasks.filter((task) => task.counts);
  const completedCount = counting.filter((task) => task.status === 'completed').length;
  const countedTotal = counting.length;

  return {
    dayKey,
    serverNow: now,
    dayStartedAt: session?.started_at ?? null,
    dayEndedAt: session?.ended_at ?? null,
    dayState: !session ? 'not_started' : session.state === 'ended' ? 'ended' : 'active',
    tasks,
    closedTotalMs: tasks.reduce((sum, task) => sum + task.closedMs, 0),
    completedCount,
    countedTotal,
    percentage: percentage(completedCount, countedTotal),
    isSuccess: isDaySuccess(completedCount, countedTotal),
    tasksNeeded: tasksNeededForSuccess(completedCount, countedTotal),
  };
}

/* ------------------------------------------------------------------ *
 * History and streaks
 * ------------------------------------------------------------------ */

/**
 * Per-day success for one participant across all recorded history.
 * The streak functions in engine.ts consume this map.
 */
export function successByDay(participantId: number): Map<DayKey, boolean> {
  const rows = all<{ day_key: string; counted: number; completed: number }>(
    `SELECT td.day_key,
            COUNT(*) AS counted,
            SUM(CASE WHEN td.status = 'completed' THEN 1 ELSE 0 END) AS completed
       FROM task_days td
       JOIN tasks t ON t.id = td.task_id
      WHERE td.participant_id = ? AND t.counts_toward_percentage = 1
      GROUP BY td.day_key`,
    participantId,
  );
  const map = new Map<DayKey, boolean>();
  for (const row of rows) map.set(row.day_key, isDaySuccess(row.completed, row.counted));
  return map;
}

export interface DailyResult {
  dayKey: DayKey;
  completed: number;
  counted: number;
  percentage: number;
  isSuccess: boolean;
  activeMs: number;
}

export function dailyHistory(participantId: number, limit = 60): DailyResult[] {
  const rows = all<{ day_key: string; counted: number; completed: number }>(
    `SELECT td.day_key,
            COUNT(*) AS counted,
            SUM(CASE WHEN td.status = 'completed' THEN 1 ELSE 0 END) AS completed
       FROM task_days td
       JOIN tasks t ON t.id = td.task_id
      WHERE td.participant_id = ? AND t.counts_toward_percentage = 1
      GROUP BY td.day_key
      ORDER BY td.day_key DESC
      LIMIT ?`,
    participantId,
    limit,
  );

  const times = all<{ day_key: string; ms: number }>(
    `SELECT day_key, SUM(COALESCE(ended_at, ?) - started_at) AS ms
       FROM task_intervals WHERE participant_id = ? GROUP BY day_key`,
    Date.now(),
    participantId,
  );
  const timeByDay = new Map(times.map((row) => [row.day_key, row.ms ?? 0]));

  return rows.map((row) => ({
    dayKey: row.day_key,
    completed: row.completed,
    counted: row.counted,
    percentage: percentage(row.completed, row.counted),
    isSuccess: isDaySuccess(row.completed, row.counted),
    activeMs: timeByDay.get(row.day_key) ?? 0,
  }));
}

export interface ActivityRow {
  id: number;
  participantId: number;
  participantName: string;
  taskName: string | null;
  dayKey: string;
  event: string;
  at: number;
  detail: string | null;
}

export function activityLog(
  options: { participantId?: number; dayKey?: DayKey; limit?: number } = {},
): ActivityRow[] {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (options.participantId !== undefined) {
    clauses.push('a.participant_id = ?');
    params.push(options.participantId);
  }
  if (options.dayKey !== undefined) {
    clauses.push('a.day_key = ?');
    params.push(options.dayKey);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(options.limit ?? 200);

  return all<{
    id: number;
    participant_id: number;
    participant_name: string;
    task_name: string | null;
    day_key: string;
    event: string;
    at: number;
    detail: string | null;
  }>(
    `SELECT a.id, a.participant_id, p.name AS participant_name, t.name AS task_name,
            a.day_key, a.event, a.at, a.detail
       FROM activity_log a
       JOIN participants p ON p.id = a.participant_id
       LEFT JOIN tasks t ON t.id = a.task_id
       ${where}
      ORDER BY a.at DESC, a.id DESC
      LIMIT ?`,
    ...params,
  ).map((row) => ({
    id: row.id,
    participantId: row.participant_id,
    participantName: row.participant_name,
    taskName: row.task_name,
    dayKey: row.day_key,
    event: row.event,
    at: row.at,
    detail: row.detail,
  }));
}

/* ------------------------------------------------------------------ *
 * Leaderboard
 * ------------------------------------------------------------------ */

/**
 * Public competitive data for everyone.
 *
 * Deliberately limited to what the spec calls public: percentage, active time,
 * rank and streaks. No task names, no per-task detail, nothing from a
 * participant's private analysis.
 */
export function leaderboard(now = Date.now(), dayKey = dayKeyOf(now)): LeaderRow[] {
  const participants = all<{ id: number; name: string }>(
    'SELECT id, name FROM participants WHERE active = 1',
  );

  const dayRows = all<{ participant_id: number; counted: number; completed: number }>(
    `SELECT td.participant_id, COUNT(*) AS counted,
            SUM(CASE WHEN td.status = 'completed' THEN 1 ELSE 0 END) AS completed
       FROM task_days td
       JOIN tasks t ON t.id = td.task_id
      WHERE td.day_key = ? AND t.counts_toward_percentage = 1
      GROUP BY td.participant_id`,
    dayKey,
  );
  const byParticipant = new Map(dayRows.map((row) => [row.participant_id, row]));

  const timeRows = all<{ participant_id: number; ms: number | null }>(
    `SELECT participant_id, SUM(COALESCE(ended_at, ?) - started_at) AS ms
       FROM task_intervals WHERE day_key = ? GROUP BY participant_id`,
    now,
    dayKey,
  );
  const timeByParticipant = new Map(timeRows.map((row) => [row.participant_id, row.ms ?? 0]));

  const sessions = all<{ participant_id: number; state: string }>(
    'SELECT participant_id, state FROM daily_sessions WHERE day_key = ?',
    dayKey,
  );
  const stateByParticipant = new Map(sessions.map((row) => [row.participant_id, row.state]));

  const rows = participants.map<LeaderRow>((participant) => {
    const totals = byParticipant.get(participant.id);
    const completed = totals?.completed ?? 0;
    const counted = totals?.counted ?? 0;
    const history = successByDay(participant.id);
    const sessionState = stateByParticipant.get(participant.id);

    return {
      participantId: participant.id,
      name: participant.name,
      completedCount: completed,
      countedTotal: counted,
      percentage: percentage(completed, counted),
      activeMs: timeByParticipant.get(participant.id) ?? 0,
      isSuccess: isDaySuccess(completed, counted),
      dayState: !sessionState ? 'not_started' : sessionState === 'ended' ? 'ended' : 'active',
      dailyStreak: dailyStreak(history, dayKey),
      weekQualifyingDays: weekQualifyingDays(history, dayKey),
    };
  });

  // Percentage first, then whoever got there in less active time.
  rows.sort((a, b) => b.percentage - a.percentage || a.activeMs - b.activeMs || a.name.localeCompare(b.name));
  return rows;
}

/* ------------------------------------------------------------------ *
 * Admin operations
 * ------------------------------------------------------------------ */

export function addParticipant(
  name: string,
  options: { isAdmin?: boolean; whatsapp?: string | null } = {},
  actorId?: number,
  now = Date.now(),
): number {
  return transaction(() => {
    const result = run(
      'INSERT INTO participants (name, is_admin, whatsapp, must_set_pin, created_at) VALUES (?, ?, ?, 1, ?)',
      name.trim(),
      bool(options.isAdmin ?? false),
      options.whatsapp ?? null,
      now,
    );
    // Mid-day joiners get task_days rows only when they start their own day.
    if (actorId) logEvent(actorId, 'participant_added', now, null, name.trim());
    return result.lastInsertRowid;
  });
}

/** Deactivates rather than deletes, so the participant's history stays intact. */
export function deactivateParticipant(participantId: number, actorId: number, now = Date.now()): void {
  transaction(() => {
    const row = findParticipant(participantId);
    run('UPDATE participants SET active = 0 WHERE id = ?', participantId);
    logEvent(actorId, 'participant_removed', now, null, row?.name ?? String(participantId));
  });
}

/**
 * Clear a participant's PIN. They are prompted to set a new one on next sign in,
 * which is the flow the spec describes.
 */
export function resetParticipantPin(participantId: number, actorId: number, now = Date.now()): void {
  transaction(() => {
    run('UPDATE participants SET pin_hash = NULL, pin_salt = NULL, must_set_pin = 1 WHERE id = ?', participantId);
    logEvent(actorId, 'pin_reset', now, null, `participant_${participantId}`);
  });
}

export function addTask(name: string, counts: boolean, actorId: number, now = Date.now()): number {
  return transaction(() => {
    const maxPosition = get<{ p: number | null }>('SELECT MAX(position) AS p FROM tasks');
    const result = run(
      'INSERT INTO tasks (name, position, counts_toward_percentage, created_at) VALUES (?, ?, ?, ?)',
      name.trim(),
      (maxPosition?.p ?? 0) + 1,
      bool(counts),
      now,
    );
    logEvent(actorId, 'task_added', now, result.lastInsertRowid, name.trim());
    return result.lastInsertRowid;
  });
}

export function renameTask(taskId: number, name: string, actorId: number, now = Date.now()): void {
  transaction(() => {
    run('UPDATE tasks SET name = ? WHERE id = ?', name.trim(), taskId);
    logEvent(actorId, 'task_renamed', now, taskId, name.trim());
  });
}

/** Archiving hides a task from today without disturbing any past day's total. */
export function setTaskArchived(taskId: number, archived: boolean, actorId: number, now = Date.now()): void {
  transaction(() => {
    run('UPDATE tasks SET archived = ? WHERE id = ?', bool(archived), taskId);
    logEvent(actorId, 'task_archived', now, taskId, archived ? 'archived' : 'restored');
  });
}

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

export function getSetting(key: string): string | null {
  return get<{ value: string }>('SELECT value FROM settings WHERE key = ?', key)?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  run(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key,
    value,
  );
}

export { todayKey };
