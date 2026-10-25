-- Indexes run after the column migrations in db/index.js, so an index may
-- safely reference a column that was only added in a later version.

CREATE INDEX IF NOT EXISTS idx_documents_property ON documents(property_id);
CREATE INDEX IF NOT EXISTS idx_documents_expiry ON documents(expiry_date);
CREATE INDEX IF NOT EXISTS idx_documents_equipment ON documents(equipment_id);
CREATE INDEX IF NOT EXISTS idx_equipment_property ON equipment(property_id);
CREATE INDEX IF NOT EXISTS idx_equipment_photos_equipment ON equipment_photos(equipment_id);
CREATE INDEX IF NOT EXISTS idx_maintenance_logs_equipment ON maintenance_logs(equipment_id);
CREATE INDEX IF NOT EXISTS idx_reminders_property ON reminders(property_id);
CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(due_date);
CREATE INDEX IF NOT EXISTS idx_tasks_property ON tasks(property_id);
CREATE INDEX IF NOT EXISTS idx_tasks_date ON tasks(event_date);
CREATE INDEX IF NOT EXISTS idx_expenses_property ON expenses(property_id);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(expense_date);
CREATE INDEX IF NOT EXISTS idx_documents_category ON documents(property_id, category);
CREATE INDEX IF NOT EXISTS idx_reminders_equipment ON reminders(equipment_id);
CREATE INDEX IF NOT EXISTS idx_reminders_open ON reminders(property_id, completed_at, due_date);
CREATE INDEX IF NOT EXISTS idx_tasks_open ON tasks(property_id, completed_at, event_date);
CREATE INDEX IF NOT EXISTS idx_expenses_year ON expenses(property_id, expense_date);
CREATE INDEX IF NOT EXISTS idx_access_user ON property_access(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id, at);
CREATE INDEX IF NOT EXISTS idx_recovery_user ON recovery_codes(user_id);
CREATE INDEX IF NOT EXISTS idx_feeds_user ON calendar_feeds(user_id);
CREATE INDEX IF NOT EXISTS idx_integrations_property ON integrations(property_id);
CREATE INDEX IF NOT EXISTS idx_integrations_due ON integrations(paused, next_sync_at);
CREATE INDEX IF NOT EXISTS idx_external_events_range ON external_events(property_id, start_date);
CREATE INDEX IF NOT EXISTS idx_external_events_integration ON external_events(integration_id);
