import { Router } from 'express';
import { requireAuth, requirePropertyAccess } from '../middleware/auth.js';
import { withResourceAccess } from '../middleware/resource.js';
import { audit } from '../utils/audit.js';
import { wrap } from '../utils/http.js';
import { createIntegration, deleteIntegration, integrationsEnabled, integrationTypes, listForProperty, publicView, syncIntegration, updateIntegration } from '../integrations/service.js';

// Connections to outside services (calendars, banks). Managing them is an owner's job: they decide
// what flows into the household's records. The API never returns a connection's address or token.
export const integrationsRouter = Router();
integrationsRouter.use(requireAuth);

integrationsRouter.get('/property/:propertyId', requirePropertyAccess({ minRole: 'owner' }), (req, res) => {
  res.json({ enabled: integrationsEnabled(), types: integrationTypes(), integrations: listForProperty(req.propertyId) });
});

integrationsRouter.post(
  '/',
  requirePropertyAccess({ minRole: 'owner' }),
  wrap(async (req, res) => {
    const created = await createIntegration({ user: req.user, propertyId: req.propertyId, body: req.body ?? {} });
    audit(req, 'integration_created', { target: String(created.id), detail: { type: created.type, name: created.name, source: created.source ?? null } });
    res.status(201).json(created);
  })
);

integrationsRouter.post(
  '/:id/sync',
  withResourceAccess('integrations', 'owner'),
  wrap(async (req, res) => {
    res.json(await syncIntegration(req.resource.id, { manual: true }));
  })
);

integrationsRouter.patch('/:id', withResourceAccess('integrations', 'owner'), (req, res) => {
  const updated = updateIntegration(req.resource, req.body ?? {});
  if (updated.paused !== Boolean(req.resource.paused)) audit(req, updated.paused ? 'integration_paused' : 'integration_resumed', { target: String(req.resource.id) });
  if (req.body?.accounts !== undefined && updated.selected_accounts) audit(req, 'integration_accounts', { target: String(req.resource.id), detail: { count: updated.selected_accounts?.length ?? 0 } });
  res.json(updated);
});

integrationsRouter.delete('/:id', withResourceAccess('integrations', 'owner'), (req, res) => {
  const view = publicView(req.resource);
  deleteIntegration(req.resource);
  audit(req, 'integration_removed', { target: String(req.resource.id), detail: { type: view.type, name: view.name } });
  res.status(204).end();
});
