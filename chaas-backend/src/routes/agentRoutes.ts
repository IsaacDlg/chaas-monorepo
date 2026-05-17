import { Router } from 'express';
import { replyToContact, reactivateBot } from '../controllers/agentController';
import { requireAuth } from '../middlewares/authMiddleware';

const router = Router();

// PARCHE VULN-05: Todas las rutas de agente requieren JWT
router.post('/send-message', requireAuth as any, replyToContact as any);
router.post('/reactivate-bot', requireAuth as any, reactivateBot as any);

export default router;
