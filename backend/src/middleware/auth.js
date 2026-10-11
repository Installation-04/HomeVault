import jwt from 'jsonwebtoken';
import { db } from '../db/index.js';
import { jwtSecret } from '../config.js';
import { parseId } from '../utils/http.js';

// Browser-initiated GETs (<a href>, <img src>) can't send an Authorization
// header, so these -- and only these -- also accept ?token=. Keeping the list
// narrow means a JWT pasted into a URL can't be used against the JSON API.
const QUERY_TOKEN_ROUTES = [
  /^\/api\/documents\/\d+\/download$/,
  /^\/api\/equipment\/\d+\/photos\/\d+$/,
  /^\/api\/export\/property\/\d+\/bundle\.zip$/,
  /^\/api\/expenses\/property\/\d+\/export\.csv$/,
];

const userStmt = db.prepare('SELECT id, email, name, is_admin FROM users WHERE id = ?');

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  let token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token && req.method === 'GET' && typeof req.query.token === 'string') {
    const fullPath = req.baseUrl + req.path;
    if (QUERY_TOKEN_ROUTES.some((re) => re.test(fullPath))) token = req.query.token;
  }
  if (!token) return res.status(401).json({ error: 'Missing token' });

  let payload;
  try {
    payload = jwt.verify(token, jwtSecret());
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  // The token only proves who signed in; role and existence come from the DB
  // so deleting or demoting a user takes effect immediately, not in 30 days.
  const user = userStmt.get(payload.id);
  if (!user) return res.status(401).json({ error: 'Account no longer exists' });
  req.user = { id: user.id, email: user.email, name: user.name, is_admin: !!user.is_admin };
  next();
}

const propertyExistsStmt = db.prepare('SELECT 1 FROM properties WHERE id = ?');
const accessStmt = db.prepare('SELECT role FROM property_access WHERE property_id = ? AND user_id = ?');

// Ensures req.user has access to req.params.propertyId (or body.property_id).
// Attaches req.propertyRole = 'owner' | 'viewer'.
export function requirePropertyAccess({ minRole = 'viewer' } = {}) {
  return (req, res, next) => {
    const propertyId = parseId(req.params.propertyId ?? req.body?.property_id);
    if (!propertyId) return res.status(400).json({ error: 'A valid property_id is required' });

    if (req.user.is_admin) {
      if (!propertyExistsStmt.get(propertyId)) return res.status(404).json({ error: 'Property not found' });
      req.propertyRole = 'owner';
      req.propertyId = propertyId;
      return next();
    }

    const access = accessStmt.get(propertyId, req.user.id);
    if (!access) return res.status(403).json({ error: 'No access to this property' });
    if (minRole === 'owner' && access.role !== 'owner') {
      return res.status(403).json({ error: 'Owner role required' });
    }
    req.propertyRole = access.role;
    req.propertyId = propertyId;
    next();
  };
}
