import { db } from '../db/index.js';
import { sendMail } from './mailer.js';

// Finds reminders due within their own lead time and not yet notified today,
// and emails everyone with access to that property.
export async function runReminderCheck() {
  const dueReminders = db
    .prepare(
      `SELECT * FROM reminders
       WHERE completed_at IS NULL
       AND date(due_date) <= date('now', '+' || lead_time_days || ' days')
       AND notify_email = 1`
    )
    .all();

  let sent = 0;
  for (const reminder of dueReminders) {
    const recipients = db
      .prepare(
        `SELECT u.email FROM users u
         JOIN property_access pa ON pa.user_id = u.id
         WHERE pa.property_id = ?`
      )
      .all(reminder.property_id)
      .map((r) => r.email);

    const property = db.prepare('SELECT name FROM properties WHERE id = ?').get(reminder.property_id);

    for (const email of recipients) {
      await sendMail({
        to: email,
        subject: `HomeVault reminder: ${reminder.title} (${property?.name || ''})`,
        text: `Reminder "${reminder.title}" for ${property?.name || 'your property'} is due on ${reminder.due_date}.`,
      });
      sent++;
    }
  }
  return { checked: dueReminders.length, emailsSent: sent };
}
