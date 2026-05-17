import { Router, raw } from 'express';
import { createCheckoutSession, handleStripeWebhook } from '../controllers/stripeController';
import { requireAuth } from '../middlewares/authMiddleware';

const router = Router();

// Ruta protegida para que el Frontend pida la URL de pago
router.post('/create-checkout-session', requireAuth as any, createCheckoutSession as any);

// Ruta abierta para Stripe (Requiere raw payload para verificar la firma)
router.post('/webhook', raw({ type: 'application/json' }), handleStripeWebhook as any);

export default router;
