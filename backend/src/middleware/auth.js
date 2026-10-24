import { db } from '../db/index.js';
import { parseId } from '../utils/http.js';
import { loadSession } from '../utils/sessions.js';

function authenticate(req, res) {
  const session = loadSession(req);
  if (!session) {
    res.status(401).json({ error: 'Not signed in', code: 'unauthenticated' });
    return null;
  }
  req.user = session.user;
  req.sessionId = session.sessionId;
  return session;
}

// Requires a valid login session (HttpOnly cookie). If an admin has forced a
// password change, everything except changing it is refused until it's done.
export function requireAuth(req, res, next) {
  if (!authenticate(req, res)) return;
  if (req.user.must_change_password) {
    return res.status(403).json({ error: 'You must change your password before continuing', code: 'password_change_required' });
  }
  next();
}

// Same, but usable while a password change is pending (me / password / logout).
export function requireSession(req, res, next) {
  if (!authenticate(req, res)) return;
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.user?.is_admin) return res.status(403).json({ error: 'Admin only' });
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
