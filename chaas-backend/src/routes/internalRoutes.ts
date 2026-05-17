import { Router } from 'express';
import { getTenantConfig, executeHandoff, sendWhatsappMessage } from '../controllers/internalController';
import { requireInternalApiKey } from '../middlewares/internalApiKey';

const router = Router();

// PARCHE VULN-05: Todas las rutas internas requieren API Key
// n8n debe enviar el header: X-Internal-API-Key: <value>
router.get('/tenant/:tenantId', requireInternalApiKey, getTenantConfig);
router.post('/handoff', requireInternalApiKey, executeHandoff);
router.post('/send-message', requireInternalApiKey, sendWhatsappMessage);

export default router;
