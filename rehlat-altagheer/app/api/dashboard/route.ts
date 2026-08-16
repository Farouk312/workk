import { NextResponse } from "next/server";
import { supabase } from "../../../src/lib/supabase";
import {
  requireActor,
  HttpError,
} from "../../../src/lib/auth";
export async function GET() {
  try {
    const actor = await requireActor();

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
        .select(
          "id,name,is_admin,whatsapp,locale,active,must_set_pin,pin_hash"
        )
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
  participants: (participantsResult.data ?? []).map((p: any) => ({
    id: p.id,
    name: p.name,

    // Frontend uses camelCase
    isAdmin: Boolean(p.is_admin),

    whatsapp: p.whatsapp ?? null,
    locale: p.locale ?? "ar",
    active: p.active !== false,

    // PIN status
    mustSetPin: Boolean(p.must_set_pin),
    hasPin: Boolean(p.pin_hash),

    // Never send the real PIN hash/salt to the browser
    pinHash: null,
    pinSalt: null,
  })),

  tasks: (tasksResult.data ?? []).map((t: any) => ({
    id: t.id,
    name: t.name,

    // Frontend uses these names
    counts: t.counts_toward_percentage !== false,
    archived: Boolean(t.archived),
    pos: Number(t.position ?? 0),
  })),

  daily_sessions: sessionsResult.data ?? [],
  task_days: taskDaysResult.data ?? [],
  task_intervals: intervalsResult.data ?? [],
  activity_log: activityResult.data ?? [],
  settings: settingsResult.data ?? [],
});
  } catch (error) {
  console.error("Dashboard GET error:", error);

  if (error instanceof HttpError) {
    return NextResponse.json(
      {
        success: false,
        error: error.message,
      },
      { status: error.status }
    );
  }

  return NextResponse.json(
    {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : String(error),
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
    const actor = await requireActor();

    const body = await request.json();

    const participants = Array.isArray(body.participants)
      ? body.participants
      : [];

    const tasks = Array.isArray(body.tasks)
      ? body.tasks
      : [];

    const days =
      body.days && typeof body.days === "object"
        ? body.days
        : {};

    const log = Array.isArray(body.log)
      ? body.log
      : [];

    const settings = body.settings ?? null;

    /* -----------------------------------------------------
       Participants + Tasks
       Batch upsert to reduce Supabase requests.
    ----------------------------------------------------- */

   const participantRows = participants.map((p: any) => {
  const row: any = {
    ...(p.id != null ? { id: Number(p.id) } : {}),
    name: p.name,
    active: p.active ?? true,
  };

  if (
    p.mustSetPin !== undefined ||
    p.must_set_pin !== undefined
  ) {
    row.must_set_pin =
      p.mustSetPin ?? p.must_set_pin;
  }

  if (p.whatsapp !== undefined) {
    row.whatsapp = p.whatsapp;
  }

  if (p.locale !== undefined) {
    row.locale = p.locale;
  }

  /*
   * IMPORTANT:
   * Do NOT update is_admin from the dashboard payload.
   *
   * The browser can contain stale participant data.
   * If we accept p.isAdmin here, a normal dashboard save
   * can accidentally turn an administrator into a normal user.
   *
   * Admin permissions must be changed separately/server-side.
   */

  return row;
});
    if (participantRows.length > 0) {
      const { error } = await supabase
        .from("participants")
        .upsert(
          participantRows,
          { onConflict: "id" }
        );

      if (error) {
        return NextResponse.json(
          {
            step: "participants",
            error: error.message,
            details: error.details,
            hint: error.hint,
            code: error.code,
          },
          { status: 500 }
        );
      }
    }

    const taskRows = tasks.map((task: any) => ({
  ...(task.id != null
    ? { id: Number(task.id) }
    : {}),

  name: task.name,

  position: Number(
    task.pos ??
    task.position ??
    0
  ),

  counts_toward_percentage:
    task.counts ??
    task.counts_toward_percentage ??
    true,

  archived:
    task.archived ??
    false,
}));

    if (taskRows.length > 0) {
      const { error } = await supabase
        .from("tasks")
        .upsert(
          taskRows,
          { onConflict: "id" }
        );

      if (error) {
        return NextResponse.json(
          {
            step: "tasks",
            error: error.message,
            details: error.details,
            hint: error.hint,
            code: error.code,
          },
          { status: 500 }
        );
      }
    }

    /* -----------------------------------------------------
       Daily sessions + task state
       Batch task_days writes to reduce Supabase requests.
    ----------------------------------------------------- */

    const sessionRows: any[] = [];
    const taskDayRows: any[] = [];

    for (const [
      pidKey,
      participantDays,
    ] of Object.entries(days)) {
      const participantId = Number(pidKey);

      if (
        !participantId ||
        !participantDays ||
        typeof participantDays !== "object"
      ) {
        continue;
      }

      for (const [
        dayKey,
        day,
      ] of Object.entries(
        participantDays as Record<string, any>
      )) {
        if (
          !day ||
          typeof day !== "object"
        ) {
          continue;
        }

        if (day.startedAt != null) {
          sessionRows.push({
            participant_id:
              participantId,

            day_key:
              dayKey,

            started_at:
              Number(day.startedAt),

            ended_at:
              day.endedAt == null
                ? null
                : Number(day.endedAt),

            state:
              day.state ||
              "active",

            end_reason:
              day.endReason ??
              null,
          });
        }

        const taskRows =
          day.tasks &&
          typeof day.tasks === "object"
            ? (
                day.tasks as Record<
                  string,
                  any
                >
              )
            : {};

        for (const [
          taskIdKey,
          task,
        ] of Object.entries(taskRows)) {
          const taskId =
            Number(taskIdKey);

          if (
            !taskId ||
            !task ||
            typeof task !== "object"
          ) {
            continue;
          }

          taskDayRows.push({
            participant_id:
              participantId,

            task_id:
              taskId,

            day_key:
              dayKey,

            status:
              task.status ||
              "idle",

            completed_at:
              task.completedAt == null
                ? null
                : Number(
                    task.completedAt
                  ),

            pause_count:
              Number(
                task.pauses
              ) || 0,

            reopen_count:
              Number(
                task.reopens
              ) || 0,
          });
        }
      }
    }

    /* Save daily sessions in one request */

    if (sessionRows.length > 0) {
      const { error } =
        await supabase
          .from("daily_sessions")
          .upsert(
            sessionRows,
            {
              onConflict:
                "participant_id,day_key",
            }
          );

      if (error) {
        return NextResponse.json(
          {
            step:
              "daily_sessions",

            error:
              error.message,

            details:
              error.details,

            hint:
              error.hint,

            code:
              error.code,
          },
          { status: 500 }
        );
      }
    }

    /* Save all task days in one request */

    if (taskDayRows.length > 0) {
      const { error } =
        await supabase
          .from("task_days")
          .upsert(
            taskDayRows,
            {
              onConflict:
                "participant_id,task_id,day_key",
            }
          );

      if (error) {
        return NextResponse.json(
          {
            step:
              "task_days",

            error:
              error.message,

            details:
              error.details,

            hint:
              error.hint,

            code:
              error.code,
          },
          { status: 500 }
        );
      }
    }

    /* -----------------------------------------------------
       Task intervals
       Match by participant/task/day/start.
    ----------------------------------------------------- */

    const {
      data: existingIntervals,
      error: intervalReadError,
    } = await supabase
      .from("task_intervals")
      .select(
        "id,participant_id,task_id,day_key,started_at,ended_at"
      );

    if (intervalReadError) {
      return NextResponse.json(
        {
          step:
            "task_intervals_read",

          error:
            intervalReadError.message,

          details:
            intervalReadError.details,

          hint:
            intervalReadError.hint,

          code:
            intervalReadError.code,
        },
        { status: 500 }
      );
    }

    const intervalMap =
      new Map<string, any>();

    for (
      const row of
        existingIntervals ?? []
    ) {
      const key =
        `${row.participant_id}|${row.task_id}|${row.day_key}|${row.started_at}`;

      intervalMap.set(
        key,
        row
      );
    }

    const intervalInserts:
      any[] = [];

    const intervalUpdates =
      new Map<
        number,
        number | null
      >();

    for (const [
      pidKey,
      participantDays,
    ] of Object.entries(days)) {
      const participantId =
        Number(pidKey);

      if (
        !participantId ||
        !participantDays ||
        typeof participantDays !== "object"
      ) {
        continue;
      }

      for (const [
        dayKey,
        day,
      ] of Object.entries(
        participantDays as Record<
          string,
          any
        >
      )) {
        const intervals =
          Array.isArray(
            (day as any)?.intervals
          )
            ? (day as any).intervals
            : [];

        for (
          const interval of intervals
        ) {
          const taskId =
            Number(
              interval?.taskId
            );

          const startedAt =
            Number(
              interval?.start
            );

          if (
            !participantId ||
            !taskId ||
            !startedAt
          ) {
            continue;
          }

          const endedAt =
            interval?.end == null
              ? null
              : Number(
                  interval.end
                );

          const key =
            `${participantId}|${taskId}|${dayKey}|${startedAt}`;

          const existing =
            intervalMap.get(
              key
            );

          if (existing) {
            if (
              (existing.ended_at ??
                null) !==
              endedAt
            ) {
              intervalUpdates.set(
                existing.id,
                endedAt
              );

              existing.ended_at =
                endedAt;
            }
          } else {
            intervalInserts.push({
              participant_id:
                participantId,

              task_id:
                taskId,

              day_key:
                dayKey,

              started_at:
                startedAt,

              ended_at:
                endedAt,
            });
          }
        }
      }
    }

    /* Insert all new intervals */

    if (
      intervalInserts.length > 0
    ) {
      const { error } =
        await supabase
          .from("task_intervals")
          .insert(
            intervalInserts
          );

      if (error) {
        return NextResponse.json(
          {
            step:
              "task_intervals_insert",

            error:
              error.message,

            details:
              error.details,

            hint:
              error.hint,

            code:
              error.code,
          },
          { status: 500 }
        );
      }
    }

    /* Update existing intervals */

    for (
      const [
        id,
        endedAt,
      ] of intervalUpdates
    ) {
      const { error } =
        await supabase
          .from("task_intervals")
          .update({
            ended_at:
              endedAt,
          })
          .eq(
            "id",
            id
          );

      if (error) {
        return NextResponse.json(
          {
            step:
              "task_intervals_update",

            error:
              error.message,

            details:
              error.details,

            hint:
              error.hint,

            code:
              error.code,
          },
          { status: 500 }
        );
      }
    }

    /* -----------------------------------------------------
       Activity log
       Batch insert new events after de-duplication.
    ----------------------------------------------------- */

    const {
      data: existingLogs,
      error: logReadError,
    } = await supabase
      .from("activity_log")
      .select(
        "participant_id,task_id,day_key,event,at,detail"
      );

    if (logReadError) {
      return NextResponse.json(
        {
          step:
            "activity_log_read",

          error:
            logReadError.message,

          details:
            logReadError.details,

          hint:
            logReadError.hint,

          code:
            logReadError.code,
        },
        { status: 500 }
      );
    }

    const logKeys =
      new Set(
        (existingLogs ?? [])
          .map((row) =>
            JSON.stringify([
              row.participant_id,
              row.task_id ??
                null,
              row.day_key,
              row.event,
              row.at,
              row.detail ??
                null,
            ])
          )
      );

    const newLogRows:
      any[] = [];

    for (
      const entry of log
    ) {
      if (
        !entry ||
        entry.pid == null ||
        !entry.dk ||
        !entry.event ||
        entry.at == null
      ) {
        continue;
      }

      const row = {
        participant_id:
          Number(entry.pid),

        task_id:
          entry.taskId == null
            ? null
            : Number(
                entry.taskId
              ),

        day_key:
          entry.dk,

        event:
          entry.event,

        at:
          Number(entry.at),

        detail:
          entry.detail ??
          null,
      };

      const key =
        JSON.stringify([
          row.participant_id,
          row.task_id,
          row.day_key,
          row.event,
          row.at,
          row.detail,
        ]);

      if (
        logKeys.has(key)
      ) {
        continue;
      }

      newLogRows.push(
        row
      );

      logKeys.add(key);
    }

    if (
      newLogRows.length > 0
    ) {
      const { error } =
        await supabase
          .from("activity_log")
          .insert(
            newLogRows
          );

      if (error) {
        return NextResponse.json(
          {
            step:
              "activity_log_insert",

            error:
              error.message,

            details:
              error.details,

            hint:
              error.hint,

            code:
              error.code,
          },
          { status: 500 }
        );
      }
    }

    /* -----------------------------------------------------
       Settings
    ----------------------------------------------------- */

    if (
      settings !== null
    ) {
      const settingsObject =
        settings?.data !==
        undefined
          ? settings.data
          : settings;

      const { error } =
        await supabase
          .from("settings")
          .upsert(
            {
              key:
                "dashboard",

              value:
                JSON.stringify(
                  settingsObject ??
                    {}
                ),
            },
            {
              onConflict:
                "key",
            }
          );

      if (error) {
        return NextResponse.json(
          {
            step:
              "settings",

            error:
              error.message,

            details:
              error.details,

            hint:
              error.hint,

            code:
              error.code,
          },
          { status: 500 }
        );
      }
    }

    return NextResponse.json({
      success: true,
      message:
        "Dashboard saved successfully",
    });
  } catch (error) {
  console.error("Dashboard GET error:", error);

  if (error instanceof HttpError) {
    return NextResponse.json(
      {
        success: false,
        error: error.message,
      },
      { status: error.status }
    );
  }

  return NextResponse.json(
    {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : String(error),
    },
    { status: 500 }
  );
}
}