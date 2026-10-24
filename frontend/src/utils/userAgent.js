// A short human label for a User-Agent string ("Chrome on Windows"), good
// enough for a "where am I signed in" list. Nothing here is used for security.
export function describeUserAgent(ua) {
  if (!ua) return null;
  const browser =
    /Edg\//.test(ua) ? 'Edge' :
    /OPR\/|Opera/.test(ua) ? 'Opera' :
    /Firefox\//.test(ua) ? 'Firefox' :
    /Chrome\/|CriOS\//.test(ua) ? 'Chrome' :
    /Safari\//.test(ua) ? 'Safari' :
    /curl\//i.test(ua) ? 'curl' : null;
  const os =
    /iPhone|iPad|iPod/.test(ua) ? 'iOS' :
    /Android/.test(ua) ? 'Android' :
    /Windows/.test(ua) ? 'Windows' :
    /Mac OS X|Macintosh/.test(ua) ? 'macOS' :
    /CrOS/.test(ua) ? 'ChromeOS' :
    /Linux/.test(ua) ? 'Linux' : null;
  if (browser && os) return `${browser} · ${os}`;
  return browser || os || null;
}
