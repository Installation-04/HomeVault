const SEMVER = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/;

// "v1.2.3" or "1.2.3" -> [1, 2, 3]; anything else (including pre-release tags) -> null.
export function parseVersion(text) {
  const match = SEMVER.exec(String(text ?? '').trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

// Negative when a < b, 0 when equal, positive when a > b. Both must be parsed versions.
export function compareVersions(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

// The version this process was built as. Images are built with HOMEVAULT_VERSION set to the
// release tag; a checkout run from source reports "dev", which never offers an update.
export function currentVersion(env = process.env) {
  const parsed = parseVersion(env.HOMEVAULT_VERSION);
  return parsed ? parsed.join('.') : 'dev';
}
