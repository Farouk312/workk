/**
 * Central rules configuration.
 *
 * Every day/week boundary in the whole system is derived from APP_TIMEZONE.
 * Change it in this one place and all day keys, week keys, streaks and
 * leaderboards follow. Never read the browser's local timezone for these.
 */

/**
 * The single fixed timezone used for all day and week boundaries.
 *
 * Currently 'UTC' by explicit choice. Note the practical effect: midnight UTC
 * is 3:00 AM in Riyadh, so work done between midnight and 3 AM local counts
 * toward the previous day, and the Sunday week boundary lands at 3 AM Sunday
 * local. Set to 'Asia/Riyadh' to make boundaries match local midnight.
 */
export const APP_TIMEZONE = 'UTC';

/**
 * Daily success threshold. The spec is exact: 90.00% qualifies, 89.99% does not.
 * Comparison is done with integer math (completed * 100 >= total * 90) so that
 * floating point rounding can never turn a near miss into a success.
 */
export const DAILY_SUCCESS_NUMERATOR = 90;
export const DAILY_SUCCESS_DENOMINATOR = 100;

/** Qualifying days needed within one Sunday–Saturday week. */
export const WEEKLY_REQUIRED_DAYS = 3;

/** Successful weeks needed within one calendar month. */
export const MONTHLY_REQUIRED_WEEKS = 3;

/** PIN format. Participants cannot change their own PIN; only an admin resets it. */
export const PIN_LENGTH = 4;

/** Default UI language. Participants can switch at runtime. */
export const DEFAULT_LOCALE: 'ar' | 'en' = 'ar';
