import { NextResponse } from "next/server";
import { supabase } from "../../../src/lib/supabase";

export async function GET() {
  try {
    const [
      participantsResult,
      tasksResult,
      sessionsResult,
      taskDaysResult,
      intervalsResult,
      activityResult,
      settingsResult,
    ] = await Promise.all([
      supabase
        .from("participants")
        .select("*")
        .order("id"),

      supabase
        .from("tasks")
        .select("*")
        .order("position")
        .order("id"),

      supabase
        .from("daily_sessions")
        .select("*")
        .order("id"),

      supabase
        .from("task_days")
        .select("*")
        .order("day_key"),

      supabase
        .from("task_intervals")
        .select("*")
        .order("id"),

      supabase
        .from("activity_log")
        .select("*")
        .order("id"),

      supabase
        .from("settings")
        .select("*")
        .order("key"),
    ]);

    const results = [
      ["participants", participantsResult],
      ["tasks", tasksResult],
      ["daily_sessions", sessionsResult],
      ["task_days", taskDaysResult],
      ["task_intervals", intervalsResult],
      ["activity_log", activityResult],
      ["settings", settingsResult],
    ] as const;

    for (const [step, result] of results) {
      if (result.error) {
        return NextResponse.json(
          {
            step,
            error: result.error.message,
            details: result.error.details,
            hint: result.error.hint,
            code: result.error.code,
          },
          { status: 500 }
        );
      }
    }

    return NextResponse.json({
      participants: participantsResult.data ?? [],
      tasks: tasksResult.data ?? [],
      daily_sessions: sessionsResult.data ?? [],
      task_days: taskDaysResult.data ?? [],
      task_intervals: intervalsResult.data ?? [],
      activity_log: activityResult.data ?? [],
      settings: settingsResult.data ?? [],
    });
  } catch (error) {
    console.error("Dashboard GET error:", error);

    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}


/* =========================================================
   POST - Save dashboard data
   ========================================================= */

export async function POST(request: Request) {
  try {
    const body = await request.json();

    const participants = Array.isArray(body.participants) ? body.participants : [];
    const tasks = Array.isArray(body.tasks) ? body.tasks : [];
    const days = body.days && typeof body.days === "object" ? body.days : {};
    const log = Array.isArray(body.log) ? body.log : [];
    const settings = body.settings ?? null;

    /* -----------------------------------------------------
       Participants
    ----------------------------------------------------- */
    for (const p of participants) {
      const participant = {
        ...(p.id != null ? { id: Number(p.id) } : {}),
        name: p.name,
        pin_hash: p.pinHash ?? p.pin_hash ?? null,
        pin_salt: p.pinSalt ?? p.pin_salt ?? null,
        must_set_pin: p.mustSetPin ?? p.must_set_pin ?? true,
        is_admin: p.isAdmin ?? p.is_admin ?? false,
        whatsapp: p.whatsapp ?? null,
        locale: p.locale ?? "ar",
        active: p.active ?? true,
      };

      const { error } = await supabase
        .from("participants")
        .upsert(participant, { onConflict: "id" });

      if (error) {
        return NextResponse.json(
          { step: "participants", error: error.message, details: error.details, hint: error.hint, code: error.code },
          { status: 500 }
        );
      }
    }

    /* -----------------------------------------------------
       Tasks
    ----------------------------------------------------- */
    for (const task of tasks) {
      const taskData = {
        ...(task.id != null ? { id: Number(task.id) } : {}),
        name: task.name,
        position: Number(task.position ?? task.pos ?? 0),
        counts_toward_percentage: task.counts_toward_percentage ?? task.counts ?? true,
        archived: task.archived ?? false,
      };

      const { error } = await supabase
        .from("tasks")
        .upsert(taskData, { onConflict: "id" });

      if (error) {
        return NextResponse.json(
          { step: "tasks", error: error.message, details: error.details, hint: error.hint, code: error.code },
          { status: 500 }
        );
      }
    }

    /* -----------------------------------------------------
       Daily sessions + task state
       The browser sends the complete current state. Upserts make
       refreshes/restarts safe without creating duplicate rows.
    ----------------------------------------------------- */
    for (const [pidKey, participantDays] of Object.entries(days)) {
      const participantId = Number(pidKey);
      if (!participantId || !participantDays || typeof participantDays !== "object") continue;

      for (const [dayKey, day] of Object.entries(participantDays as Record<string, any>)) {
        if (!day || typeof day !== "object") continue;

        if (day.startedAt != null) {
          const sessionRow = {
            participant_id: participantId,
            day_key: dayKey,
            started_at: Number(day.startedAt),
            ended_at: day.endedAt == null ? null : Number(day.endedAt),
            state: day.state || "active",
            end_reason: day.endReason ?? null,
          };

          const { error } = await supabase
            .from("daily_sessions")
            .upsert(sessionRow, { onConflict: "participant_id,day_key" });

          if (error) {
            return NextResponse.json(
              { step: "daily_sessions", error: error.message, details: error.details, hint: error.hint, code: error.code },
              { status: 500 }
            );
          }
        }

        const taskRows =
  day.tasks && typeof day.tasks === "object"
    ? (day.tasks as Record<string, any>)
    : {};

for (const [taskIdKey, task] of Object.entries(taskRows)) {
          const taskId = Number(taskIdKey);
          if (!taskId || !task || typeof task !== "object") continue;

          const taskDayRow = {
            participant_id: participantId,
            task_id: taskId,
            day_key: dayKey,
            status: task.status || "idle",
            completed_at: task.completedAt == null ? null : Number(task.completedAt),
            pause_count: Number(task.pauses) || 0,
            reopen_count: Number(task.reopens) || 0,
          };

          const { error } = await supabase
            .from("task_days")
            .upsert(taskDayRow, { onConflict: "participant_id,task_id,day_key" });

          if (error) {
            return NextResponse.json(
              { step: "task_days", error: error.message, details: error.details, hint: error.hint, code: error.code },
              { status: 500 }
            );
          }
        }
      }
    }

    /* -----------------------------------------------------
       Task intervals
       Match by participant/task/day/start. This lets an open
       interval become closed on the next save without duplicates.
    ----------------------------------------------------- */
    const { data: existingIntervals, error: intervalReadError } = await supabase
      .from("task_intervals")
      .select("id,participant_id,task_id,day_key,started_at,ended_at");

    if (intervalReadError) {
      return NextResponse.json(
        { step: "task_intervals_read", error: intervalReadError.message, details: intervalReadError.details, hint: intervalReadError.hint, code: intervalReadError.code },
        { status: 500 }
      );
    }

    const intervalMap = new Map<string, any>();
    for (const row of existingIntervals ?? []) {
      const key = `${row.participant_id}|${row.task_id}|${row.day_key}|${row.started_at}`;
      intervalMap.set(key, row);
    }

    for (const [pidKey, participantDays] of Object.entries(days)) {
      const participantId = Number(pidKey);
      if (!participantId || !participantDays || typeof participantDays !== "object") continue;

      for (const [dayKey, day] of Object.entries(participantDays as Record<string, any>)) {
        const intervals = Array.isArray((day as any)?.intervals) ? (day as any).intervals : [];

        for (const interval of intervals) {
          const taskId = Number(interval?.taskId);
          const startedAt = Number(interval?.start);
          if (!participantId || !taskId || !startedAt) continue;

          const endedAt = interval?.end == null ? null : Number(interval.end);
          const key = `${participantId}|${taskId}|${dayKey}|${startedAt}`;
          const existing = intervalMap.get(key);

          if (existing) {
            if ((existing.ended_at ?? null) !== endedAt) {
              const { error } = await supabase
                .from("task_intervals")
                .update({ ended_at: endedAt })
                .eq("id", existing.id);

              if (error) {
                return NextResponse.json(
                  { step: "task_intervals_update", error: error.message, details: error.details, hint: error.hint, code: error.code },
                  { status: 500 }
                );
              }
              existing.ended_at = endedAt;
            }
          } else {
            const { data: inserted, error } = await supabase
              .from("task_intervals")
              .insert({
                participant_id: participantId,
                task_id: taskId,
                day_key: dayKey,
                started_at: startedAt,
                ended_at: endedAt,
              })
              .select("id,participant_id,task_id,day_key,started_at,ended_at")
              .single();

            if (error) {
              return NextResponse.json(
                { step: "task_intervals_insert", error: error.message, details: error.details, hint: error.hint, code: error.code },
                { status: 500 }
              );
            }

            intervalMap.set(key, inserted);
          }
        }
      }
    }

    /* -----------------------------------------------------
       Activity log
       Append-only, but de-duplicate the same event so every
       normal save does not create another copy.
    ----------------------------------------------------- */
    const { data: existingLogs, error: logReadError } = await supabase
      .from("activity_log")
      .select("id,participant_id,task_id,day_key,event,at,detail");

    if (logReadError) {
      return NextResponse.json(
        { step: "activity_log_read", error: logReadError.message, details: logReadError.details, hint: logReadError.hint, code: logReadError.code },
        { status: 500 }
      );
    }

    const logKeys = new Set(
      (existingLogs ?? []).map((row) =>
        JSON.stringify([
          row.participant_id,
          row.task_id ?? null,
          row.day_key,
          row.event,
          row.at,
          row.detail ?? null,
        ])
      )
    );

    for (const entry of log) {
      if (!entry || entry.pid == null || !entry.dk || !entry.event || entry.at == null) continue;

      const row = {
        participant_id: Number(entry.pid),
        task_id: entry.taskId == null ? null : Number(entry.taskId),
        day_key: entry.dk,
        event: entry.event,
        at: Number(entry.at),
        detail: entry.detail ?? null,
      };

      const key = JSON.stringify([
        row.participant_id,
        row.task_id,
        row.day_key,
        row.event,
        row.at,
        row.detail,
      ]);

      if (logKeys.has(key)) continue;

      const { error } = await supabase.from("activity_log").insert(row);

      if (error) {
        return NextResponse.json(
          { step: "activity_log_insert", error: error.message, details: error.details, hint: error.hint, code: error.code },
          { status: 500 }
        );
      }

      logKeys.add(key);
    }

    /* -----------------------------------------------------
       Settings
    ----------------------------------------------------- */
    if (settings !== null) {
      const settingsObject =
        settings?.data !== undefined ? settings.data : settings;

      const { error } = await supabase
        .from("settings")
        .upsert(
          {
            key: "dashboard",
            value: JSON.stringify(settingsObject ?? {}),
          },
          { onConflict: "key" }
        );

      if (error) {
        return NextResponse.json(
          { step: "settings", error: error.message, details: error.details, hint: error.hint, code: error.code },
          { status: 500 }
        );
      }
    }

    return NextResponse.json({
      success: true,
      message: "Dashboard saved successfully",
    });
  } catch (error) {
    console.error("Dashboard POST error:", error);

    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}