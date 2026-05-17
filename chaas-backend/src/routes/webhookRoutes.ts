import { Router } from 'express';
import { verifyWebhook, receiveMessage } from '../controllers/webhookController';
import { requireActiveSubscription } from '../middlewares/subscriptionGuard';
import { webhookLimiter } from '../middlewares/rateLimiter';

const router = Router();

// Rutas base para Meta
router.get('/whatsapp', verifyWebhook);
// PARCHE VULN-04: Rate limiter + Firewall de suscripción ANTES de recibir el mensaje
router.post('/whatsapp', webhookLimiter, requireActiveSubscription, receiveMessage);

export default router;
