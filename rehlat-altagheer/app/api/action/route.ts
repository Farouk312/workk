import { NextResponse } from "next/server";
import { supabase } from "../../../src/lib/supabase";

export async function POST(request: Request) {
  try {
    const body = await request.json();

    const action = body.action;
    const participantId = Number(body.participantId);
    const taskId = Number(body.taskId);

    if (!action) {
      return NextResponse.json(
        { success: false, error: "action is required" },
        { status: 400 }
      );
    }

    if (!participantId || Number.isNaN(participantId)) {
      return NextResponse.json(
        { success: false, error: "participantId is required" },
        { status: 400 }
      );
    }

    /*
     * =========================================
     * START DAY
     * =========================================
     */

    if (action === "start_day") {
      const dayKey =
        body.dayKey ??
        new Date().toISOString().slice(0, 10);

      const now = Date.now();

      // Check if there is already an active session
      const existing = await supabase
        .from("daily_sessions")
        .select("*")
        .eq("participant_id", participantId)
        .eq("day_key", dayKey)
        .maybeSingle();

      if (existing.error) {
        return NextResponse.json(
          {
            success: false,
            step: "check_session",
            error: existing.error.message,
          },
          { status: 500 }
        );
      }

      if (existing.data?.state === "active") {
        return NextResponse.json(
          {
            success: false,
            error: "Day is already active",
            session: existing.data,
          },
          { status: 409 }
        );
      }

      let session;

      if (existing.data) {
        const result = await supabase
          .from("daily_sessions")
          .update({
            started_at: now,
            ended_at: null,
            state: "active",
            end_reason: null,
          })
          .eq("id", existing.data.id)
          .select()
          .single();

        if (result.error) {
          return NextResponse.json(
            {
              success: false,
              step: "update_session",
              error: result.error.message,
            },
            { status: 500 }
          );
        }

        session = result.data;
      } else {
        const result = await supabase
          .from("daily_sessions")
          .insert({
            participant_id: participantId,
            day_key: dayKey,
            started_at: now,
            ended_at: null,
            state: "active",
            end_reason: null,
          })
          .select()
          .single();

        if (result.error) {
          return NextResponse.json(
            {
              success: false,
              step: "insert_session",
              error: result.error.message,
            },
            { status: 500 }
          );
        }

        session = result.data;
      }

      // Log activity
      const log = await supabase
        .from("activity_log")
        .insert({
          participant_id: participantId,
          task_id: null,
          day_key: dayKey,
          event: "start_day",
          at: now,
          detail: null,
        });

      if (log.error) {
        return NextResponse.json(
          {
            success: false,
            step: "activity_log",
            error: log.error.message,
          },
          { status: 500 }
        );
      }

      return NextResponse.json({
        success: true,
        action: "start_day",
        session,
      });
    }

    /*
     * =========================================
     * END DAY
     * =========================================
     */

    if (action === "end_day") {
      const dayKey =
        body.dayKey ??
        new Date().toISOString().slice(0, 10);

      const now = Date.now();
      const reason = body.reason ?? "manual";

      const existing = await supabase
        .from("daily_sessions")
        .select("*")
        .eq("participant_id", participantId)
        .eq("day_key", dayKey)
        .maybeSingle();

      if (existing.error) {
        return NextResponse.json(
          {
            success: false,
            step: "find_session",
            error: existing.error.message,
          },
          { status: 500 }
        );
      }

      if (!existing.data) {
        return NextResponse.json(
          {
            success: false,
            error: "No day session found",
          },
          { status: 404 }
        );
      }

      if (existing.data.state !== "active") {
        return NextResponse.json(
          {
            success: false,
            error: "Day is not active",
            session: existing.data,
          },
          { status: 409 }
        );
      }

      const result = await supabase
        .from("daily_sessions")
        .update({
          ended_at: now,
          state: "ended",
          end_reason: reason,
        })
        .eq("id", existing.data.id)
        .select()
        .single();

      if (result.error) {
        return NextResponse.json(
          {
            success: false,
            step: "end_session",
            error: result.error.message,
          },
          { status: 500 }
        );
      }

      const log = await supabase
        .from("activity_log")
        .insert({
          participant_id: participantId,
          task_id: null,
          day_key: dayKey,
          event: "end_day",
          at: now,
          detail: reason,
        });

      if (log.error) {
        return NextResponse.json(
          {
            success: false,
            step: "activity_log",
            error: log.error.message,
          },
          { status: 500 }
        );
      }

      return NextResponse.json({
        success: true,
        action: "end_day",
        session: result.data,
      });
    }

    /*
     * =========================================
     * START TASK
     * =========================================
     */

    if (action === "start_task") {
      if (!taskId || Number.isNaN(taskId)) {
        return NextResponse.json(
          {
            success: false,
            error: "taskId is required",
          },
          { status: 400 }
        );
      }

      const dayKey =
        body.dayKey ??
        new Date().toISOString().slice(0, 10);

      const now = Date.now();

      // Make sure the day is active
      const session = await supabase
        .from("daily_sessions")
        .select("*")
        .eq("participant_id", participantId)
        .eq("day_key", dayKey)
        .maybeSingle();

      if (session.error) {
        return NextResponse.json(
          {
            success: false,
            step: "find_session",
            error: session.error.message,
          },
          { status: 500 }
        );
      }

      if (!session.data) {
        return NextResponse.json(
          {
            success: false,
            error: "No day session found",
          },
          { status: 404 }
        );
      }

      if (session.data.state !== "active") {
        return NextResponse.json(
          {
            success: false,
            error: "Day is not active",
          },
          { status: 409 }
        );
      }

      // Make sure the task exists
      const task = await supabase
        .from("tasks")
        .select("*")
        .eq("id", taskId)
        .maybeSingle();

      if (task.error) {
        return NextResponse.json(
          {
            success: false,
            step: "find_task",
            error: task.error.message,
          },
          { status: 500 }
        );
      }

      if (!task.data) {
        return NextResponse.json(
          {
            success: false,
            error: "Task not found",
          },
          { status: 404 }
        );
      }

      // Check if another task is already running
      const openInterval = await supabase
        .from("task_intervals")
        .select("*")
        .eq("participant_id", participantId)
        .eq("day_key", dayKey)
        .is("ended_at", null)
        .maybeSingle();

      if (openInterval.error) {
        return NextResponse.json(
          {
            success: false,
            step: "check_open_interval",
            error: openInterval.error.message,
          },
          { status: 500 }
        );
      }

      if (openInterval.data) {
        return NextResponse.json(
          {
            success: false,
            error: "Another task is already running",
            interval: openInterval.data,
          },
          { status: 409 }
        );
      }

      // Create or update task day
      const taskDay = await supabase
        .from("task_days")
        .upsert(
          {
            participant_id: participantId,
            task_id: taskId,
            day_key: dayKey,
            status: "running",
          },
          {
            onConflict: "participant_id,task_id,day_key",
          }
        )
        .select()
        .single();

      if (taskDay.error) {
        return NextResponse.json(
          {
            success: false,
            step: "task_day",
            error: taskDay.error.message,
          },
          { status: 500 }
        );
      }

      // Start timer interval
      const interval = await supabase
        .from("task_intervals")
        .insert({
          participant_id: participantId,
          task_id: taskId,
          day_key: dayKey,
          started_at: now,
          ended_at: null,
        })
        .select()
        .single();

      if (interval.error) {
        return NextResponse.json(
          {
            success: false,
            step: "task_interval",
            error: interval.error.message,
          },
          { status: 500 }
        );
      }

      // Log activity
      const log = await supabase
        .from("activity_log")
        .insert({
          participant_id: participantId,
          task_id: taskId,
          day_key: dayKey,
          event: "start_task",
          at: now,
          detail: null,
        });

      if (log.error) {
        return NextResponse.json(
          {
            success: false,
            step: "activity_log",
            error: log.error.message,
          },
          { status: 500 }
        );
      }
    

      return NextResponse.json({
        success: true,
        action: "start_task",
        task: task.data,
        taskDay: taskDay.data,
        interval: interval.data,
      });
    }

    /*
 * =========================================
 * COMPLETE TASK
 * =========================================
 */

if (action === "complete_task") {
  const dayKey =
    body.dayKey ??
    new Date().toISOString().slice(0, 10);

  const now = Date.now();

  // Make sure the day is active
  const session = await supabase
    .from("daily_sessions")
    .select("*")
    .eq("participant_id", participantId)
    .eq("day_key", dayKey)
    .maybeSingle();

  if (session.error) {
    return NextResponse.json(
      {
        success: false,
        step: "find_session",
        error: session.error.message,
      },
      { status: 500 }
    );
  }

  if (!session.data) {
    return NextResponse.json(
      {
        success: false,
        error: "No day session found",
      },
      { status: 404 }
    );
  }

  if (session.data.state !== "active") {
    return NextResponse.json(
      {
        success: false,
        error: "Day is not active",
      },
      { status: 409 }
    );
  }

  // Find the task
  const task = await supabase
    .from("tasks")
    .select("*")
    .eq("id", taskId)
    .maybeSingle();

  if (task.error) {
    return NextResponse.json(
      {
        success: false,
        step: "find_task",
        error: task.error.message,
      },
      { status: 500 }
    );
  }

  if (!task.data) {
    return NextResponse.json(
      {
        success: false,
        error: "Task not found",
      },
      { status: 404 }
    );
  }

  // Find the current task day
  const taskDay = await supabase
    .from("task_days")
    .select("*")
    .eq("participant_id", participantId)
    .eq("task_id", taskId)
    .eq("day_key", dayKey)
    .maybeSingle();

  if (taskDay.error) {
    return NextResponse.json(
      {
        success: false,
        step: "find_task_day",
        error: taskDay.error.message,
      },
      { status: 500 }
    );
  }

  if (!taskDay.data) {
    return NextResponse.json(
      {
        success: false,
        error: "Task has not been started",
      },
      { status: 404 }
    );
  }

  if (taskDay.data.status === "completed") {
    return NextResponse.json(
      {
        success: false,
        error: "Task is already completed",
        taskDay: taskDay.data,
      },
      { status: 409 }
    );
  }

  // Find the currently running interval
  const openInterval = await supabase
    .from("task_intervals")
    .select("*")
    .eq("participant_id", participantId)
    .eq("task_id", taskId)
    .eq("day_key", dayKey)
    .is("ended_at", null)
    .maybeSingle();

  if (openInterval.error) {
    return NextResponse.json(
      {
        success: false,
        step: "find_open_interval",
        error: openInterval.error.message,
      },
      { status: 500 }
    );
  }

  // Close the running interval if one exists
  let interval = openInterval.data;

  if (interval) {
    const intervalResult = await supabase
      .from("task_intervals")
      .update({
        ended_at: Math.max(now, interval.started_at),
      })
      .eq("id", interval.id)
      .select()
      .single();

    if (intervalResult.error) {
      return NextResponse.json(
        {
          success: false,
          step: "close_interval",
          error: intervalResult.error.message,
        },
        { status: 500 }
      );
    }

    interval = intervalResult.data;
  }

  // Mark task as completed
  const completedTaskDay = await supabase
    .from("task_days")
    .update({
      status: "completed",
      completed_at: now,
    })
    .eq("participant_id", participantId)
    .eq("task_id", taskId)
    .eq("day_key", dayKey)
    .select()
    .single();

  if (completedTaskDay.error) {
    return NextResponse.json(
      {
        success: false,
        step: "complete_task_day",
        error: completedTaskDay.error.message,
      },
      { status: 500 }
    );
  }

  // Log activity
  const log = await supabase
    .from("activity_log")
    .insert({
      participant_id: participantId,
      task_id: taskId,
      day_key: dayKey,
      event: "complete_task",
      at: now,
      detail: null,
    });

  if (log.error) {
    return NextResponse.json(
      {
        success: false,
        step: "activity_log",
        error: log.error.message,
      },
      { status: 500 }
    );
  }

  return NextResponse.json({
    success: true,
    action: "complete_task",
    task: task.data,
    taskDay: completedTaskDay.data,
    interval,
  });
}

    return NextResponse.json(
      {
        success: false,
        error: `Unknown action: ${action}`,
      },
      { status: 400 }
    );
  } catch (error) {
    console.error("Action API error:", error);

    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}