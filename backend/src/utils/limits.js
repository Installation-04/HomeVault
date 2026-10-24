import { FailureThrottle } from './throttle.js';

// Shared in-memory brakes on credential guessing (see throttle.js).
export const loginThrottle = new FailureThrottle({ limit: 10, windowMs: 15 * 60 * 1000 }); // per email
export const mfaThrottle = new FailureThrottle({ limit: 6, windowMs: 10 * 60 * 1000 }); // per user id
export const reauthThrottle = new FailureThrottle({ limit: 8, windowMs: 15 * 60 * 1000 }); // per user id: "confirm your password" prompts

export function blocked(res, gate, message = 'Too many failed attempts. Try again later.') {
  res.set('Retry-After', String(gate.retryAfterSeconds));
  return res.status(429).json({ error: message, code: 'rate_limited', retry_after: gate.retryAfterSeconds });
}
