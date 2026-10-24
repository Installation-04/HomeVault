// Cross-site request forgery guard for cookie-authenticated requests.
//
// Sessions use `SameSite=Strict` cookies, which already stops other websites
// from riding a logged-in browser. This is the second layer: for anything that
// changes state, a browser must tell us where the request came from (the
// `Origin` header, plus `Sec-Fetch-Site` on modern browsers) and we refuse
// foreign origins. That also covers sibling subdomains, which SameSite
// considers "same site".
//
// Non-browser clients (curl, scripts) send neither header and are allowed:
// they don't carry a victim's ambient cookies, so there's nothing to forge.

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function trustedOrigins() {
  return (process.env.TRUSTED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function originAllowed(origin, req) {
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false; // includes the literal "null" origin
  }
  const allowedHosts = new Set([String(req.get('host') || '').toLowerCase()]);
  if (req.app.get('trust proxy')) {
    const forwarded = req.get('x-forwarded-host');
    if (forwarded) allowedHosts.add(forwarded.split(',')[0].trim().toLowerCase());
  }
  return allowedHosts.has(url.host.toLowerCase()) || trustedOrigins().includes(url.origin.toLowerCase());
}

export function csrfGuard(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();

  const origin = req.get('origin');
  const fetchSite = req.get('sec-fetch-site');
  let ok = true;
  if (origin) ok = originAllowed(origin, req);
  else if (fetchSite) ok = fetchSite === 'same-origin' || fetchSite === 'none';

  if (!ok) return res.status(403).json({ error: 'Cross-site request blocked', code: 'csrf' });
  next();
}
