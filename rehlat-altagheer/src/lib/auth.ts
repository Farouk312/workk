/**
 * PIN hashing and session cookies.
 *
 * The spec's security requirements that shape this file:
 *   * PINs are never stored in plain text.
 *   * Permissions are enforced server-side. Hiding a button is not access control.
 *   * A participant must never reach another participant's records by changing
 *     an id in a request — so route handlers take the actor from the cookie,
 *     never from the request body.
 */

import 'server-only';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { cookies } from 'next/headers';

import { PIN_LENGTH } from '../config.ts';
import { get, run } from './db/index.ts';

const COOKIE_NAME = 'rt_session';
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days
const SECRET_PATH = path.join(process.cwd(), 'data', '.session-secret');

/**
 * A four-digit PIN has only 10,000 possibilities, so the hash alone cannot
 * carry the security. Login attempts are rate limited below, and the app is
 * private by link. scrypt still matters: it means a leaked database file does
 * not immediately reveal everyone's PIN.
 */
const SCRYPT_KEYLEN = 32;

function sessionSecret(): Buffer {
  fs.mkdirSync(path.dirname(SECRET_PATH), { recursive: true });
  if (!fs.existsSync(SECRET_PATH)) {
    // Generated on first run so the project works with no configuration.
    fs.writeFileSync(SECRET_PATH, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  }
  return Buffer.from(fs.readFileSync(SECRET_PATH, 'utf8').trim(), 'hex');
}

export function isValidPinFormat(pin: string): boolean {
  return new RegExp(`^\\d{${PIN_LENGTH}}$`).test(pin);
}

export function hashPin(pin: string, salt?: string): { hash: string; salt: string } {
  const useSalt = salt ?? crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pin, useSalt, SCRYPT_KEYLEN).toString('hex');
  return { hash, salt: useSalt };
}

export function verifyPinHash(pin: string, hash: string, salt: string): boolean {
  const candidate = crypto.scryptSync(pin, salt, SCRYPT_KEYLEN);
  const expected = Buffer.from(hash, 'hex');
  if (candidate.length !== expected.length) return false;
  // Constant time: a length-independent comparison would leak how much matched.
  return crypto.timingSafeEqual(candidate, expected);
}

/* ------------------------------------------------------------------ *
 * Login throttling
 * ------------------------------------------------------------------ */

const attempts = new Map<number, { count: number; firstAt: number }>();
const MAX_ATTEMPTS = 8;
const ATTEMPT_WINDOW_MS = 10 * 60_000;

/** Returns false once a participant id has burned through its attempts. */
export function registerFailedAttempt(participantId: number, now = Date.now()): void {
  const record = attempts.get(participantId);
  if (!record || now - record.firstAt > ATTEMPT_WINDOW_MS) {
    attempts.set(participantId, { count: 1, firstAt: now });
    return;
  }
  record.count += 1;
}

export function isThrottled(participantId: number, now = Date.now()): boolean {
  const record = attempts.get(participantId);
  if (!record) return false;
  if (now - record.firstAt > ATTEMPT_WINDOW_MS) {
    attempts.delete(participantId);
    return false;
  }
  return record.count >= MAX_ATTEMPTS;
}

export function clearAttempts(participantId: number): void {
  attempts.delete(participantId);
}

/* ------------------------------------------------------------------ *
 * Session cookie
 * ------------------------------------------------------------------ */

function sign(payload: string): string {
  return crypto.createHmac('sha256', sessionSecret()).update(payload).digest('hex');
}

function encodeToken(participantId: number, issuedAt: number): string {
  const payload = `${participantId}.${issuedAt}`;
  return `${payload}.${sign(payload)}`;
}

function decodeToken(token: string): { participantId: number; issuedAt: number } | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [rawId, rawIssued, signature] = parts;
  const expected = sign(`${rawId}.${rawIssued}`);
  const a = Buffer.from(signature, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  const participantId = Number(rawId);
  const issuedAt = Number(rawIssued);
  if (!Number.isInteger(participantId) || !Number.isFinite(issuedAt)) return null;
  if (Date.now() - issuedAt > SESSION_MAX_AGE_SECONDS * 1000) return null;
  return { participantId, issuedAt };
}

export async function createSession(participantId: number): Promise<void> {
  const store = await cookies();
  store.set(COOKIE_NAME, encodeToken(participantId, Date.now()), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

export async function destroySession(): Promise<void> {
  const store = await cookies();
  store.delete(COOKIE_NAME);
}

export interface Actor {
  id: number;
  name: string;
  isAdmin: boolean;
  locale: 'ar' | 'en';
  mustSetPin: boolean;
}

/**
 * The signed-in participant, or null. This is the single source of identity for
 * every write in the app; no handler should ever trust an id sent by the client.
 */
export async function currentActor(): Promise<Actor | null> {
  const store = await cookies();
  const token = store.get(COOKIE_NAME)?.value;
  if (!token) return null;

  const decoded = decodeToken(token);
  if (!decoded) return null;

  const row = get<{
    id: number;
    name: string;
    is_admin: number;
    locale: string;
    must_set_pin: number;
    active: number;
  }>('SELECT id, name, is_admin, locale, must_set_pin, active FROM participants WHERE id = ?', decoded.participantId);

  if (!row || row.active !== 1) return null;

  return {
    id: row.id,
    name: row.name,
    isAdmin: row.is_admin === 1,
    locale: row.locale === 'en' ? 'en' : 'ar',
    mustSetPin: row.must_set_pin === 1,
  };
}

/** Throws unless someone is signed in. Use at the top of every protected handler. */
export async function requireActor(): Promise<Actor> {
  const actor = await currentActor();
  if (!actor) throw new HttpError(401, 'not_signed_in');
  return actor;
}

/** Throws unless the signed-in participant is the administrator. */
export async function requireAdmin(): Promise<Actor> {
  const actor = await requireActor();
  if (!actor.isAdmin) throw new HttpError(403, 'admin_only');
  return actor;
}

export async function setLocale(participantId: number, locale: 'ar' | 'en'): Promise<void> {
  run('UPDATE participants SET locale = ? WHERE id = ?', locale, participantId);
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
