import { db } from '../db/index.js';
import { sendMail } from './mailer.js';
import { addDays, localToday } from './dates.js';

// How far ahead document expiries / equipment warranties are announced, and
// how far back (so switching the feature on doesn't dump years of history).
const LOOKBACK_DAYS = 30;
const expiryNoticeDays = () => {
  const raw = process.env.EXPIRY_NOTICE_DAYS;
  return raw === undefined || raw === '' ? 30 : Number(raw);
};

const STRINGS = {
  en: {
    subject: (n, property) => `HomeVault: ${n} ${n === 1 ? 'item needs' : 'items need'} attention (${property})`,
    intro: (property) => `Here is what needs attention for "${property}":`,
    reminders: 'Reminders',
    documents: 'Documents expiring',
    warranties: 'Equipment warranties ending',
    due: (d) => `due ${d}`,
    expires: (d) => `expires ${d}`,
    ends: (d) => `ends ${d}`,
    footer: 'You receive this because you have access to this property in HomeVault.',
  },
  fr: {
    subject: (n, property) => `HomeVault : ${n} ${n === 1 ? 'élément à traiter' : 'éléments à traiter'} (${property})`,
    intro: (property) => `Voici ce qui demande votre attention pour « ${property} » :`,
    reminders: 'Rappels',
    documents: 'Documents bientôt expirés',
    warranties: 'Garanties d\'équipement qui se terminent',
    due: (d) => `échéance le ${d}`,
    expires: (d) => `expire le ${d}`,
    ends: (d) => `se termine le ${d}`,
    footer: 'Vous recevez ce message car vous avez accès à cette propriété dans HomeVault.',
  },
};

function composeDigest(locale, property, { reminders, documents, equipment }) {
  const s = STRINGS[locale] || STRINGS.en;
  const total = reminders.length + documents.length + equipment.length;
  const lines = [s.intro(property.name), ''];
  if (reminders.length) {
    lines.push(`${s.reminders}:`, ...reminders.map((r) => `  - ${r.title} (${s.due(r.due_date)})`), '');
  }
  if (documents.length) {
    lines.push(`${s.documents}:`, ...documents.map((d) => `  - ${d.title} (${s.expires(d.expiry_date)})`), '');
  }
  if (equipment.length) {
    lines.push(`${s.warranties}:`, ...equipment.map((e) => `  - ${e.name} (${s.ends(e.warranty_expiry)})`), '');
  }
  lines.push(s.footer);
  return { subject: s.subject(total, property.name), text: lines.join('\n') };
}

// Emails each member of a property one digest of whatever newly needs attention:
//   - reminders inside their lead window (or overdue)
//   - documents about to expire, equipment warranties about to end
// Each item is announced once per due/expiry date (tracked in *_notified_for
// columns), not on every daily run. Items are only marked after at least one
// email actually went out, so an unconfigured/unreachable SMTP server means
// they are retried later instead of being silently dropped.
export async function runReminderCheck({ send = sendMail, today = localToday() } = {}) {
  const noticeDays = expiryNoticeDays();
  const upTo = addDays(today, noticeDays);
  const since = addDays(today, -LOOKBACK_DAYS);

  const dueReminders = db.prepare(
    `SELECT id, title, due_date FROM reminders
     WHERE property_id = ? AND completed_at IS NULL AND notify_email = 1
       AND date(due_date) <= date(?, '+' || lead_time_days || ' days')
       AND (notified_for_due_date IS NULL OR notified_for_due_date != due_date)
     ORDER BY due_date`
  );
  const expiringDocuments = db.prepare(
    `SELECT id, title, expiry_date FROM documents
     WHERE property_id = ? AND expiry_date >= ? AND expiry_date <= ?
       AND (expiry_notified_for IS NULL OR expiry_notified_for != expiry_date)
     ORDER BY expiry_date`
  );
  const expiringWarranties = db.prepare(
    `SELECT id, name, warranty_expiry FROM equipment
     WHERE property_id = ? AND warranty_expiry >= ? AND warranty_expiry <= ?
       AND (warranty_notified_for IS NULL OR warranty_notified_for != warranty_expiry)
     ORDER BY warranty_expiry`
  );
  const markReminder = db.prepare('UPDATE reminders SET notified_for_due_date = due_date WHERE id = ?');
  const markDocument = db.prepare('UPDATE documents SET expiry_notified_for = expiry_date WHERE id = ?');
  const markWarranty = db.prepare('UPDATE equipment SET warranty_notified_for = warranty_expiry WHERE id = ?');
  const recipientsStmt = db.prepare(
    `SELECT u.email, u.locale FROM users u
     JOIN property_access pa ON pa.user_id = u.id
     WHERE pa.property_id = ? ORDER BY u.id`
  );

  let items = 0;
  let emailsSent = 0;

  for (const property of db.prepare('SELECT id, name FROM properties ORDER BY id').all()) {
    const found = {
      reminders: dueReminders.all(property.id, today),
      documents: noticeDays > 0 ? expiringDocuments.all(property.id, since, upTo) : [],
      equipment: noticeDays > 0 ? expiringWarranties.all(property.id, since, upTo) : [],
    };
    const count = found.reminders.length + found.documents.length + found.equipment.length;
    if (count === 0) continue;
    items += count;

    let delivered = 0;
    for (const recipient of recipientsStmt.all(property.id)) {
      const { subject, text } = composeDigest(recipient.locale, property, found);
      try {
        const result = await send({ to: recipient.email, subject, text });
        if (result && !result.skipped) delivered++;
      } catch (err) {
        // One bad mailbox must not stop the rest of the household's notices.
        console.error(`Reminder email to ${recipient.email} failed:`, err.message);
      }
    }

    if (delivered > 0) {
      db.transaction(() => {
        for (const r of found.reminders) markReminder.run(r.id);
        for (const d of found.documents) markDocument.run(d.id);
        for (const e of found.equipment) markWarranty.run(e.id);
      })();
    }
    emailsSent += delivered;
  }

  return { items, emailsSent };
}
