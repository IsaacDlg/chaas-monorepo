import { Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma';

export const requireActiveSubscription = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.body;

    // Solo validamos webhooks de mensajes entrantes
    if (body.object === 'whatsapp_business_account' && body.entry) {
      const entry = body.entry[0];
      const change = entry?.changes[0];
      
      if (change?.value?.messages && change.value.messages[0]) {
        const metadata = change.value.metadata;
        const display_phone_number = metadata.display_phone_number;

        // Búsqueda en caché o base de datos
        const tenant = await prisma.tenant.findFirst({
          where: { wa_phone_number_id: display_phone_number },
          select: { subscription_status: true, plan_type: true }
        });

        if (!tenant) {
          return res.status(200).send('EVENT_RECEIVED'); // Ignorar si no existe
        }

        // FIREWALL LÓGICO
        if (tenant.plan_type !== 'FREE' && 
           (tenant.subscription_status === 'PAST_DUE' || tenant.subscription_status === 'CANCELED')) {
          
          console.warn(`[Firewall] Webhook bloqueado para número ${display_phone_number}. Suscripción: ${tenant.subscription_status}`);
          
          // CRÍTICO: Devolvemos 200 OK a Meta para que NO reintente enviar el webhook.
          // Pero NO llamamos a next(), cortando la ejecución aquí mismo. 
          // El mensaje muere pacíficamente, sin tocar n8n ni la base de datos.
          return res.status(200).send('EVENT_RECEIVED');
        }
      }
    }

    // Si todo está bien, permitimos que el webhook siga su curso normal
    next();
  } catch (error) {
    console.error('[Firewall] Error crítico:', error);
    // En caso de error, dejamos pasar para no romper el sistema (Fail-Open) o Fail-Closed dependiendo del apetito de riesgo.
    next();
  }
};
