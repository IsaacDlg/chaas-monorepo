import Stripe from 'stripe';

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder';

export const stripe = new Stripe(STRIPE_SECRET_KEY, {
  apiVersion: '2023-10-16' as any, // Usa la versión actual soportada
  appInfo: {
    name: 'CHaaS SaaS Platform',
    version: '1.0.0'
  }
});
