import { MAX_PASSWORD_LENGTH } from './crypto.js';

export const MIN_PASSWORD_LENGTH = 10;

// The passwords people actually pick first, at lengths that would otherwise
// pass a length-only rule. Compared after lowercasing and stripping
// punctuation, so "Password-123!" is caught as well.
const COMMON = new Set(
  `password123 password1234 passw0rd123 qwertyuiop qwerty1234 qwerty12345 qwertyuiop1 1234567890 12345678901 123456789012
   0123456789 1q2w3e4r5t 1qaz2wsx3edc iloveyou12 iloveyou123 letmein1234 welcome123 welcome1234 administrator adminadmin1
   admin12345 admin123456 changeme123 changeme1234 abc1234567 abcdefghij abcd123456 monkey1234 dragon1234 football123
   baseball123 superman123 trustno1234 sunshine123 princess123 whatever123 starwars123 passwordpassword homevault123
   homevault1234 myhomevault houseowner1 mypassword1 mypassword12 mypassword123 letmeinplease correcthorse`
    .split(/\s+/)
    .filter(Boolean)
);

const squash = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

function isTrivial(pw) {
  if (/^(.)\1+$/.test(pw)) return true; // aaaaaaaaaa
  const chars = [...pw].map((c) => c.charCodeAt(0));
  const steps = chars.slice(1).map((c, i) => c - chars[i]);
  return steps.every((d) => d === 1) || steps.every((d) => d === -1); // 123456789a, zyxwvutsrq
}

// Returns an error message, or null when the password is acceptable.
// `context` lets us refuse passwords built from the person's own details.
export function passwordProblem(password, context = {}) {
  if (typeof password !== 'string') return 'Password is required';
  if ([...password].length < MIN_PASSWORD_LENGTH) return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  if (password.length > MAX_PASSWORD_LENGTH) return `Password must be at most ${MAX_PASSWORD_LENGTH} characters`;
  const flat = squash(password);
  if (COMMON.has(flat) || isTrivial(password)) return 'That password is too common or too predictable';
  // Any real word of the person's name or email address (jordan.smith@... -> "jordan", "smith").
  const words = [...String(context.email || '').split('@')[0].split(/[^a-z0-9]+/i), ...String(context.name || '').split(/\s+/)]
    .map(squash)
    .filter((w) => w.length >= 4);
  if (words.some((w) => flat.includes(w))) return 'Password must not contain your name or email address';
  return null;
}
