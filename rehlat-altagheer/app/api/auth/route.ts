import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { supabase } from "../../../src/lib/supabase";

import {
  createSession,
  isValidPinFormat,
  hashPin,
  verifyPinHash,
  registerFailedAttempt,
  isThrottled,
  clearAttempts,
  requireAdmin,
} from "../../../src/lib/auth";




export async function GET() {
  try {
    const { data, error } = await supabase
      .from("participants")
      .select("id,name,active,must_set_pin,pin_hash")
      .eq("active", true)
      .order("id");

    if (error) {
      console.error("AUTH PARTICIPANTS READ ERROR:", {
        message: error.message,
        details: error.details,
        hint: error.hint,
        code: error.code,
      });

      return NextResponse.json(
        {
          success: false,
          error: "database_error",
        },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      participants: (data ?? []).map((p) => ({
        id: p.id,
        name: p.name,
        active: p.active,
        must_set_pin: p.must_set_pin,
        has_pin: Boolean(p.pin_hash),
      })),
    });
  } catch (error) {
    console.error("AUTH GET ERROR:", error);

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
   POST /api/auth
   Handles:
   - First-time PIN setup
   - Normal login
   - Admin PIN reset
   ========================================================= */

export async function POST(request: Request) {
  try {
    const body = await request.json();

    const action = body?.action;
    const participantId = Number(body?.participantId);
    const pin = String(body?.pin ?? "");

    /* =====================================================
       VALIDATE PARTICIPANT ID
       ===================================================== */

    if (
      !Number.isInteger(participantId) ||
      participantId <= 0
    ) {
      return NextResponse.json(
        {
          success: false,
          error: "invalid_participant",
        },
        { status: 400 }
      );
    }

    /* =====================================================
       ADMIN RESET PIN
       ===================================================== */

    if (action === "reset") {
      try {
        /*
         * IMPORTANT:
         * Do NOT trust adminId sent by the browser.
         * The authenticated admin is taken from the session cookie.
         */

        const admin = await requireAdmin();

        const { data: targetParticipant, error: targetError } =
          await supabase
            .from("participants")
            .select("id, name, active")
            .eq("id", participantId)
            .maybeSingle();

        if (targetError) {
          console.error("RESET TARGET READ ERROR:", {
            message: targetError.message,
            details: targetError.details,
            hint: targetError.hint,
            code: targetError.code,
          });

          return NextResponse.json(
            {
              success: false,
              error: "database_error",
              details: targetError.message,
            },
            { status: 500 }
          );
        }

        if (
          !targetParticipant ||
          targetParticipant.active === false
        ) {
          return NextResponse.json(
            {
              success: false,
              error: "participant_not_found",
            },
            { status: 404 }
          );
        }

        const { error: resetError } =
          await supabase
            .from("participants")
            .update({
              pin_hash: null,
              pin_salt: null,
              must_set_pin: true,
            })
            .eq("id", participantId);

        if (resetError) {
          console.error("PIN RESET ERROR:", {
            message: resetError.message,
            details: resetError.details,
            hint: resetError.hint,
            code: resetError.code,
          });

          return NextResponse.json(
            {
              success: false,
              error: "pin_reset_failed",
              details: resetError.message,
              code: resetError.code,
            },
            { status: 500 }
          );
        }

        /*
         * Clear any failed-login throttling for this participant.
         */
        clearAttempts(participantId);

        console.log(
          `PIN reset by admin ${admin.id} for participant ${participantId}`
        );

        return NextResponse.json({
          success: true,
        });
      } catch (error: any) {
        console.error("ADMIN RESET ERROR:", error);

        return NextResponse.json(
          {
            success: false,
            error:
              error?.message === "admin_only"
                ? "admin_only"
                : error?.message === "not_signed_in"
                  ? "not_signed_in"
                  : "Unauthorized",
          },
          {
            status:
              error?.status === 403
                ? 403
                : error?.status === 401
                  ? 401
                  : 500,
          }
        );
      }
    }

    /* =====================================================
       VALIDATE ACTION
       ===================================================== */

    if (
      action !== "set" &&
      action !== "login"
    ) {
      return NextResponse.json(
        {
          success: false,
          error: "invalid_action",
        },
        { status: 400 }
      );
    }

    /* =====================================================
       VALIDATE PIN FORMAT
       ===================================================== */

    if (!isValidPinFormat(pin)) {
      return NextResponse.json(
        {
          success: false,
          error: "Invalid PIN",
        },
        { status: 400 }
      );
    }

    /* =====================================================
       CHECK LOGIN THROTTLING
       ===================================================== */

    if (isThrottled(participantId)) {
      return NextResponse.json(
        {
          success: false,
          error: "too_many_attempts",
        },
        { status: 429 }
      );
    }

    /* =====================================================
       LOAD PARTICIPANT FROM SUPABASE
       ===================================================== */

    const {
      data: participant,
      error: readError,
    } = await supabase
      .from("participants")
      .select(
        "id, name, is_admin, pin_hash, pin_salt, must_set_pin, active, locale"
      )
      .eq("id", participantId)
      .maybeSingle();

    if (readError) {
      console.error("AUTH READ ERROR:", {
        message: readError.message,
        details: readError.details,
        hint: readError.hint,
        code: readError.code,
      });

      return NextResponse.json(
        {
          success: false,
          error: "database_error",
          details: readError.message,
          code: readError.code,
        },
        { status: 500 }
      );
    }

    if (
      !participant ||
      participant.active === false
    ) {
      return NextResponse.json(
        {
          success: false,
          error: "participant_not_found",
        },
        { status: 401 }
      );
    }

    /* =====================================================
       FIRST LOGIN / SET NEW PIN
       ===================================================== */

    if (action === "set") {
      /*
       * A participant is allowed to set a PIN when:
       *
       * 1. must_set_pin = true
       *
       * OR
       *
       * 2. there is no existing PIN hash/salt
       *
       * This is important after a database restore/reset.
       */

      const needsPinSetup =
        participant.must_set_pin === true ||
        !participant.pin_hash ||
        !participant.pin_salt;

      /*
       * If the database says the participant already has
       * a valid PIN and setup is not required, don't overwrite it.
       */

      if (!needsPinSetup) {
        return NextResponse.json(
          {
            success: false,
            error: "pin_already_set",
          },
          { status: 409 }
        );
      }

      /* Generate secure PIN hash + salt */
      const {
        hash,
        salt,
      } = hashPin(pin);

      const {
        data: updatedParticipant,
        error: updateError,
      } = await supabase
        .from("participants")
        .update({
          pin_hash: hash,
          pin_salt: salt,
          must_set_pin: false,
        })
        .eq("id", participantId)
        .select(
          "id, name, is_admin, locale, must_set_pin"
        )
        .maybeSingle();

      if (updateError) {
        console.error("PIN SET ERROR:", {
          message: updateError.message,
          details: updateError.details,
          hint: updateError.hint,
          code: updateError.code,
        });

        return NextResponse.json(
          {
            success: false,
            error: "pin_save_failed",
            details: updateError.message,
            code: updateError.code,
          },
          { status: 500 }
        );
      }

      if (!updatedParticipant) {
        console.error(
          "PIN SET ERROR: participant was not updated"
        );

        return NextResponse.json(
          {
            success: false,
            error: "pin_save_failed",
            details:
              "No participant was updated.",
          },
          { status: 500 }
        );
      }

      /*
       * Create the SAME session used by dashboard/auth.ts.
       * Cookie name = rt_session
       */

      await createSession(participantId);

      clearAttempts(participantId);

      return NextResponse.json({
        success: true,
        firstLogin: true,
        participant: {
          id: updatedParticipant.id,
          name: updatedParticipant.name,
          isAdmin:
            updatedParticipant.is_admin === true,
          locale:
            updatedParticipant.locale === "en"
              ? "en"
              : "ar",
        },
      });
    }

    /* =====================================================
       NORMAL LOGIN
       ===================================================== */

    /*
     * A normal login is impossible when there is no saved PIN.
     */

    if (
      !participant.pin_hash ||
      !participant.pin_salt
    ) {
      return NextResponse.json(
        {
          success: false,
          error: "pin_not_set",
        },
        { status: 409 }
      );
    }

    /* =====================================================
       VERIFY PIN
       ===================================================== */

    const validPin =
      verifyPinHash(
        pin,
        participant.pin_hash,
        participant.pin_salt
      );

    if (!validPin) {
      registerFailedAttempt(
        participantId
      );

      return NextResponse.json(
        {
          success: false,
          error: "wrong_pin",
        },
        { status: 401 }
      );
    }

    /* =====================================================
       SUCCESSFUL LOGIN
       ===================================================== */

    clearAttempts(participantId);

    /*
     * Create the SAME session used by src/lib/auth.ts.
     */

    await createSession(participantId);

    return NextResponse.json({
      success: true,
      firstLogin: false,
      participant: {
        id: participant.id,
        name: participant.name,
        isAdmin:
          participant.is_admin === true,
        locale:
          participant.locale === "en"
            ? "en"
            : "ar",
      },
    });
  } catch (error) {
    console.error(
      "AUTH ROUTE ERROR:",
      error
    );

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