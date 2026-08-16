import "server-only";

import crypto from "node:crypto";
import { cookies } from "next/headers";

import { supabase } from "./supabase";
import { PIN_LENGTH } from "../config";

const COOKIE_NAME = "rt_session";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

const SCRYPT_KEYLEN = 32;

/* =========================================================
   PIN
   ========================================================= */

export function isValidPinFormat(pin: string): boolean {
  return new RegExp(`^\\d{${PIN_LENGTH}}$`).test(pin);
}

export function hashPin(
  pin: string,
  salt?: string
): { hash: string; salt: string } {
  const useSalt =
    salt ?? crypto.randomBytes(16).toString("hex");

  const hash = crypto
    .scryptSync(
      pin,
      useSalt,
      SCRYPT_KEYLEN
    )
    .toString("hex");

  return {
    hash,
    salt: useSalt,
  };
}

export function verifyPinHash(
  pin: string,
  hash: string,
  salt: string
): boolean {
  try {
    const candidate = crypto.scryptSync(
      pin,
      salt,
      SCRYPT_KEYLEN
    );

    const expected = Buffer.from(
      hash,
      "hex"
    );

    if (
      candidate.length !==
      expected.length
    ) {
      return false;
    }

    return crypto.timingSafeEqual(
      candidate,
      expected
    );
  } catch {
    return false;
  }
}

/* =========================================================
   LOGIN THROTTLING
   ========================================================= */

const attempts = new Map<
  number,
  {
    count: number;
    firstAt: number;
  }
>();

const MAX_ATTEMPTS = 8;
const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;

export function registerFailedAttempt(
  participantId: number,
  now = Date.now()
): void {
  const record =
    attempts.get(participantId);

  if (
    !record ||
    now - record.firstAt >
      ATTEMPT_WINDOW_MS
  ) {
    attempts.set(participantId, {
      count: 1,
      firstAt: now,
    });

    return;
  }

  record.count += 1;
}

export function isThrottled(
  participantId: number,
  now = Date.now()
): boolean {
  const record =
    attempts.get(participantId);

  if (!record) {
    return false;
  }

  if (
    now - record.firstAt >
    ATTEMPT_WINDOW_MS
  ) {
    attempts.delete(participantId);
    return false;
  }

  return record.count >= MAX_ATTEMPTS;
}

export function clearAttempts(
  participantId: number
): void {
  attempts.delete(participantId);
}

/* =========================================================
   SESSION
   ========================================================= */

function getSessionSecret(): string {
  const secret =
    process.env.SESSION_SECRET ||
    process.env.NEXTAUTH_SECRET;

  if (!secret) {
    throw new Error(
      "SESSION_SECRET is not configured"
    );
  }

  return secret;
}

function sign(payload: string): string {
  return crypto
    .createHmac(
      "sha256",
      getSessionSecret()
    )
    .update(payload)
    .digest("hex");
}

function createSessionToken(
  participantId: number
): string {
  const issuedAt = Date.now();

  const payload =
    `${participantId}.${issuedAt}`;

  const signature = sign(payload);

  return `${payload}.${signature}`;
}

function decodeSessionToken(
  token: string
): {
  participantId: number;
  issuedAt: number;
} | null {
  const parts = token.split(".");

  if (parts.length !== 3) {
    return null;
  }

  const [
    rawId,
    rawIssuedAt,
    signature,
  ] = parts;

  const payload =
    `${rawId}.${rawIssuedAt}`;

  const expected = sign(payload);

  try {
    const actualBuffer =
      Buffer.from(signature, "hex");

    const expectedBuffer =
      Buffer.from(expected, "hex");

    if (
      actualBuffer.length !==
      expectedBuffer.length
    ) {
      return null;
    }

    if (
      !crypto.timingSafeEqual(
        actualBuffer,
        expectedBuffer
      )
    ) {
      return null;
    }
  } catch {
    return null;
  }

  const participantId =
    Number(rawId);

  const issuedAt =
    Number(rawIssuedAt);

  if (
    !Number.isInteger(
      participantId
    ) ||
    !Number.isFinite(issuedAt)
  ) {
    return null;
  }

  if (
    Date.now() - issuedAt >
    SESSION_MAX_AGE_SECONDS * 1000
  ) {
    return null;
  }

  return {
    participantId,
    issuedAt,
  };
}

/* =========================================================
   CREATE SESSION
   ========================================================= */

export async function createSession(
  participantId: number
): Promise<void> {
  const store = await cookies();

  store.set(
    COOKIE_NAME,
    createSessionToken(
      participantId
    ),
    {
      httpOnly: true,
      sameSite: "lax",
      secure:
        process.env.NODE_ENV ===
        "production",
      path: "/",
      maxAge:
        SESSION_MAX_AGE_SECONDS,
    }
  );
}

/* =========================================================
   DESTROY SESSION
   ========================================================= */

export async function destroySession(): Promise<void> {
  const store = await cookies();

  store.delete(COOKIE_NAME);
}

/* =========================================================
   ACTOR
   ========================================================= */

export interface Actor {
  id: number;
  name: string;
  isAdmin: boolean;
  locale: "ar" | "en";
  mustSetPin: boolean;
}

/* =========================================================
   CURRENT ACTOR
   ========================================================= */

export async function currentActor(): Promise<
  Actor | null
> {
  const store = await cookies();

  const token =
    store.get(COOKIE_NAME)?.value;

  if (!token) {
    return null;
  }

  const decoded =
    decodeSessionToken(token);

  if (!decoded) {
    return null;
  }

  const {
    data: participant,
    error,
  } = await supabase
    .from("participants")
    .select(
      "id,name,is_admin,locale,must_set_pin,active"
    )
    .eq(
      "id",
      decoded.participantId
    )
    .maybeSingle();

  if (error) {
    console.error(
      "CURRENT ACTOR ERROR:",
      error
    );

    return null;
  }

  if (
    !participant ||
    participant.active === false
  ) {
    return null;
  }

  return {
    id: participant.id,
    name: participant.name,
    isAdmin:
      participant.is_admin === true,
    locale:
      participant.locale === "en"
        ? "en"
        : "ar",
    mustSetPin:
      participant.must_set_pin === true,
  };
}

/* =========================================================
   REQUIRE ACTOR
   ========================================================= */

export async function requireActor(): Promise<Actor> {
  const actor =
    await currentActor();

  if (!actor) {
    throw new HttpError(
      401,
      "not_signed_in"
    );
  }

  return actor;
}

/* =========================================================
   REQUIRE ADMIN
   ========================================================= */

export async function requireAdmin(): Promise<Actor> {
  const actor =
    await requireActor();

  if (!actor.isAdmin) {
    throw new HttpError(
      403,
      "admin_only"
    );
  }

  return actor;
}

/* =========================================================
   LOCALE
   ========================================================= */

export async function setLocale(
  participantId: number,
  locale: "ar" | "en"
): Promise<void> {
  const actor =
    await requireActor();

  if (
    actor.id !== participantId &&
    !actor.isAdmin
  ) {
    throw new HttpError(
      403,
      "forbidden"
    );
  }

  const { error } =
    await supabase
      .from("participants")
      .update({
        locale,
      })
      .eq(
        "id",
        participantId
      );

  if (error) {
    throw new Error(
      error.message
    );
  }
}

/* =========================================================
   HTTP ERROR
   ========================================================= */

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}