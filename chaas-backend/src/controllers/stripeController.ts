import { Request, Response } from 'express';
import { stripe } from '../lib/stripe';
import { prisma } from '../lib/prisma';
import { AuthRequest } from '../middlewares/authMiddleware';
import { logger } from '../lib/logger';

// =============================================================================
// PRICE → PLAN MAPPING
// Mapea cada priceId de Stripe a un PlanType de la DB.
// Mantener sincronizado con los productos creados en el Dashboard de Stripe.
// =============================================================================
const PRICE_TO_PLAN: Record<string, 'BASIC' | 'PRO'> = {
  // TODO: Reemplazar con los IDs reales del Dashboard de Stripe
  'price_basic_monthly': 'BASIC',
  'price_pro_monthly': 'PRO',
};

function resolvePlanType(priceId: string | null): 'BASIC' | 'PRO' | 'FREE' {
  if (!priceId) return 'FREE';
  return PRICE_TO_PLAN[priceId] ?? 'PRO'; // Fallback a PRO si no está mapeado
}

// =============================================================================
// 1. CHECKOUT SESSION — Crear sesión de pago segura
// =============================================================================
export const createCheckoutSession = async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    const { priceId } = req.body;

    if (!tenantId) return res.status(401).json({ error: 'No autorizado' });
    if (!priceId) return res.status(400).json({ error: 'priceId es obligatorio' });

    let tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) return res.status(404).json({ error: 'Tenant no encontrado' });

    // -----------------------------------------------------------------------
    // AUTO-CREATE STRIPE CUSTOMER (On-the-fly provisioning)
    // Si el tenant aún no tiene stripe_customer_id, lo creamos ahora.
    // Esto permite que el onboarding no dependa de Stripe hasta el checkout.
    // -----------------------------------------------------------------------
    let stripeCustomerId = tenant.stripe_customer_id;

    if (!stripeCustomerId) {
      const customer = await stripe.customers.create({
        name: tenant.name,
        metadata: {
          tenantId: tenant.id, // Enlace bidireccional Stripe ↔ DB
        },
      });

      await prisma.tenant.update({
        where: { id: tenantId },
        data: { stripe_customer_id: customer.id },
      });

      stripeCustomerId = customer.id;
      logger.info(`[Stripe] Customer creado on-the-fly: ${customer.id} → Tenant ${tenantId}`);
    }

    // Idempotency Key para prevenir doble cobro
    const idempotencyKey = req.header('Idempotency-Key');
    if (!idempotencyKey) {
      return res.status(400).json({ error: 'Idempotency-Key header es obligatorio' });
    }

    const session = await stripe.checkout.sessions.create({
      customer: stripeCustomerId,
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      mode: 'subscription',
      success_url: `${process.env.FRONTEND_URL}/dashboard?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/checkout?canceled=true`,
      // Metadata para trazar en el webhook sin queries extra
      subscription_data: {
        metadata: { tenantId },
      },
    }, {
      idempotencyKey,
    });

    logger.info(`[Stripe] Checkout session creada: ${session.id} para Tenant ${tenantId}`);
    res.status(200).json({ url: session.url });
  } catch (error: any) {
    logger.error(`[Stripe] Checkout error: ${error.message}`);
    res.status(500).json({ error: 'Error creando sesión de pago' });
  }
};

// =============================================================================
// 2. WEBHOOK — Motor de eventos con Signature Verification
// =============================================================================
export const handleStripeWebhook = async (req: Request, res: Response) => {
  const sig = req.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!endpointSecret) {
    logger.error('[Stripe] STRIPE_WEBHOOK_SECRET no configurado');
    return res.status(500).send('Webhook secret no configurado');
  }

  // -------------------------------------------------------------------------
  // SIGNATURE VERIFICATION (PCI DSS Mandatorio)
  // Sin esto, cualquier atacante podría enviar eventos falsos a tu API.
  // -------------------------------------------------------------------------
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,          // DEBE ser el raw body (Buffer), no JSON parseado
      sig as string,
      endpointSecret
    );
  } catch (err: any) {
    logger.error(`[Stripe] ⚠️ Signature verification FAILED: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  logger.info(`[Stripe] Evento recibido: ${event.type} (${event.id})`);

  try {
    switch (event.type) {
      // =====================================================================
      // CHECKOUT COMPLETADO — El cliente acaba de pagar por primera vez
      // =====================================================================
      case 'checkout.session.completed': {
        const session = event.data.object as any;
        const customerId = session.customer as string;
        const subscriptionId = session.subscription as string;

        // Obtener el subscription para extraer el priceId
        const subscription = await stripe.subscriptions.retrieve(subscriptionId) as any;
        const priceId = subscription.items?.data?.[0]?.price?.id ?? null;

        // ─── BullMQ INJECTION POINT ─────────────────────────────────
        // En producción, en lugar de update directo, despachar a cola:
        //
        //   await billingQueue.add('subscription.activated', {
        //     eventId: event.id,
        //     customerId,
        //     subscriptionId,
        //     priceId,
        //     currentPeriodEnd: subscription.current_period_end
        //   });
        //
        // Esto garantiza retry automático si la DB falla temporalmente,
        // idempotencia via eventId, y desacoplamiento del webhook (3s SLA).
        // ─────────────────────────────────────────────────────────────

        await prisma.tenant.update({
          where: { stripe_customer_id: customerId },
          data: {
            stripe_subscription_id: subscriptionId,
            stripe_price_id: priceId,
            subscription_status: 'ACTIVE',
            plan_type: resolvePlanType(priceId),
            current_period_end: subscription.current_period_end
              ? new Date(subscription.current_period_end * 1000)
              : null,
          },
        });

        logger.info(`[Stripe] ✅ Tenant activado: customer=${customerId}, plan=${resolvePlanType(priceId)}`);
        break;
      }

      // =====================================================================
      // SUBSCRIPTION UPDATED — Upgrade, downgrade, o renovación
      // =====================================================================
      case 'customer.subscription.updated': {
        const subscription = event.data.object as any;
        const priceId = subscription.items?.data?.[0]?.price?.id ?? null;

        // ─── BullMQ INJECTION POINT ─────────────────────────────────
        // await billingQueue.add('subscription.updated', {
        //   eventId: event.id,
        //   subscriptionId: subscription.id,
        //   status: subscription.status,
        //   priceId,
        //   currentPeriodEnd: subscription.current_period_end,
        //   cancelAtPeriodEnd: subscription.cancel_at_period_end
        // });
        // ─────────────────────────────────────────────────────────────

        const statusMap: Record<string, string> = {
          active: 'ACTIVE',
          past_due: 'PAST_DUE',
          canceled: 'CANCELED',
          unpaid: 'PAST_DUE',
        };

        await prisma.tenant.update({
          where: { stripe_subscription_id: subscription.id },
          data: {
            stripe_price_id: priceId,
            subscription_status: (statusMap[subscription.status] ?? 'INACTIVE') as any,
            plan_type: resolvePlanType(priceId),
            current_period_end: subscription.current_period_end
              ? new Date(subscription.current_period_end * 1000)
              : null,
          },
        });

        logger.info(`[Stripe] 🔄 Subscription updated: ${subscription.id} → ${subscription.status}`);
        break;
      }

      // =====================================================================
      // PAYMENT FAILED — Factura no cobrada (tarjeta rechazada, fondos insuficientes)
      // =====================================================================
      case 'invoice.payment_failed': {
        const invoice = event.data.object as any;

        // ─── BullMQ INJECTION POINT ─────────────────────────────────
        // await billingQueue.add('payment.failed', {
        //   eventId: event.id,
        //   subscriptionId: invoice.subscription,
        //   customerId: invoice.customer,
        //   attemptCount: invoice.attempt_count
        // });
        // Aquí también podrías disparar un email de aviso al tenant.
        // ─────────────────────────────────────────────────────────────

        await prisma.tenant.update({
          where: { stripe_subscription_id: invoice.subscription as string },
          data: { subscription_status: 'PAST_DUE' },
        });

        logger.warn(`[Stripe] ⚠️ Pago fallido: subscription=${invoice.subscription}, intento #${invoice.attempt_count}`);
        break;
      }

      // =====================================================================
      // SUBSCRIPTION DELETED — Cancelación definitiva
      // =====================================================================
      case 'customer.subscription.deleted': {
        const subscription = event.data.object as any;

        // ─── BullMQ INJECTION POINT ─────────────────────────────────
        // await billingQueue.add('subscription.canceled', {
        //   eventId: event.id,
        //   subscriptionId: subscription.id,
        //   customerId: subscription.customer
        // });
        // Disparar flujo de downgrade: revocar features PRO, notificar, etc.
        // ─────────────────────────────────────────────────────────────

        await prisma.tenant.update({
          where: { stripe_subscription_id: subscription.id },
          data: {
            subscription_status: 'CANCELED',
            plan_type: 'FREE',
            stripe_price_id: null,
            current_period_end: null,
          },
        });

        logger.info(`[Stripe] ❌ Subscription cancelada: ${subscription.id}`);
        break;
      }

      default:
        logger.info(`[Stripe] Evento no manejado: ${event.type}`);
    }

    // Stripe requiere 200 dentro de 3 segundos o reintenta el webhook
    res.status(200).json({ received: true });
  } catch (error: any) {
    logger.error(`[Stripe] Error procesando evento ${event.type}: ${error.message}`);
    // Retornamos 500 para que Stripe reintente el delivery
    res.status(500).end();
  }
};
