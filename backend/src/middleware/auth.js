import jwt from 'jsonwebtoken';
import { db } from '../db/index.js';

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = (header.startsWith('Bearer ') ? header.slice(7) : null) || req.query.token || null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Ensures req.user has access to req.params.propertyId (or body.property_id).
// Attaches req.propertyRole = 'owner' | 'viewer'.
export function requirePropertyAccess({ minRole = 'viewer' } = {}) {
  return (req, res, next) => {
    const propertyId = Number(req.params.propertyId || req.body.property_id);
    if (!propertyId) return res.status(400).json({ error: 'property_id required' });

    if (req.user.is_admin) {
      req.propertyRole = 'owner';
      req.propertyId = propertyId;
      return next();
    }

    const access = db
      .prepare('SELECT role FROM property_access WHERE property_id = ? AND user_id = ?')
      .get(propertyId, req.user.id);

    if (!access) return res.status(403).json({ error: 'No access to this property' });
    if (minRole === 'owner' && access.role !== 'owner') {
      return res.status(403).json({ error: 'Owner role required' });
    }
    req.propertyRole = access.role;
    req.propertyId = propertyId;
    next();
  };
}
