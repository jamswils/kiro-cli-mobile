/**
 * Shared constants for the CLI bridge.
 */
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_LOCKOUT_MS = 60000;

// Cookie name — intentionally different from the IDE bridge's `kmb_session`
// so the two bridges don't collide when hosted on the same origin/subnet.
export const SESSION_COOKIE = 'kcmb_session';
