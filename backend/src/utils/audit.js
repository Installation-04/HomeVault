import { db } from '../db/index.js';

const insert = db.prepare(
  'INSERT INTO audit_log (user_id, actor, action, target, detail, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)'
);

const clip = (value, max) => (value == null ? null : String(value).slice(0, max));

// Records a security-relevant event. Never throws: losing an audit line must
// not turn a successful action into a 500, but it is reported on stderr.
//
//   audit(req, 'password_changed')
//   audit(req, 'login_failed', { user: null, actor: 'x@y.z', detail: { reason: 'bad_password' } })
//
// Never put secrets (passwords, tokens, codes) in `detail`.
export function audit(req, action, { user, actor, target, detail } = {}) {
  try {
    const who = user === undefined ? req?.user : user;
    insert.run(
      who?.id ?? null,
      clip(actor ?? who?.email, 254),
      action,
      clip(target, 200),
      detail === undefined ? null : clip(JSON.stringify(detail), 1000),
      clip(req?.ip, 64),
      clip(req?.get?.('user-agent'), 200)
    );
  } catch (err) {
    console.error('Audit log write failed:', err.message);
  }
}
