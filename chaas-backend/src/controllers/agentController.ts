import { Request, Response } from 'express';
import { prisma, forTenant } from '../lib/prisma';
import axios from 'axios';
import { logger } from '../lib/logger';

// 1. Agente humano responde manualmente (Outbound Message)
export const replyToContact = async (req: Request, res: Response) => {
  try {
    const { tenantId, contactId, message } = req.body;
    const db = forTenant(tenantId);

    // forTenant inyecta tenantId automáticamente — si no pertenece al tenant, retorna null
    const contact = await db.contact.findUnique({
      where: { id: contactId },
      include: { tenant: true }
    });

    if (!contact) {
      return res.status(403).json({ error: 'No autorizado o contacto inexistente' });
    }

    // PARCHE VULN-06: Bloquear envío si la ventana de 24h de Meta expiró
    const hours24 = 24 * 60 * 60 * 1000;
    if (!contact.last_inbound_at) {
      return res.status(400).json({
        error: 'Sin mensajes previos',
        detail: 'El contacto nunca ha enviado un mensaje. No se puede iniciar conversación sin Template HSM.'
      });
    }
    const diff = Date.now() - contact.last_inbound_at.getTime();
    if (diff >= hours24) {
      logger.warn(`[Agent] Ventana 24h expirada para contacto ${contactId}`);
      return res.status(400).json({
        error: 'Ventana de 24 horas expirada',
        detail: 'Solo se pueden enviar plantillas HSM aprobadas por Meta.',
        expired_at: new Date(contact.last_inbound_at.getTime() + hours24),
        hours_elapsed: +(diff / 3_600_000).toFixed(1)
      });
    }

    const tenant = contact.tenant;

    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: contact.wa_id,
      type: 'text',
      text: {
        preview_url: false,
        body: message
      }
    };

    const META_URL = `https://graph.facebook.com/v17.0/${tenant.wa_phone_number_id}/messages`;

    // Enviar a WhatsApp API
    const response = await axios.post(META_URL, payload, {
      headers: {
        'Authorization': `Bearer ${tenant.wa_token}`,
        'Content-Type': 'application/json'
      }
    });

    // Guardar el mensaje en el historial como OUTBOUND manual
    // Message no tiene tenantId directo, pero usamos prisma base (seguro: contactId ya validado)
    const savedMessage = await prisma.message.create({
      data: {
        wa_message_id: response.data.messages[0].id,
        body: message,
        direction: 'OUTBOUND',
        status: 'SENT',
        contactId: contact.id
      }
    });

    res.status(200).json({ success: true, message: savedMessage });
  } catch (error: any) {
    logger.error('[Agent] Error enviando respuesta manual:', error?.response?.data || error.message);
    res.status(500).json({ error: 'Error enviando mensaje' });
  }
};

// 2. Agente devuelve el control a la IA (Handoff inverso)
export const reactivateBot = async (req: Request, res: Response) => {
  try {
    const { tenantId, contactId } = req.body;
    const db = forTenant(tenantId);

    // forTenant inyecta tenantId — imposible modificar contacto de otro tenant
    const contact = await db.contact.update({
      where: { id: contactId },
      data: {
        is_bot_active: true,
        assigned_agent_id: null
      }
    });

    res.status(200).json({ success: true, message: 'Control devuelto a n8n', contact });
  } catch (error) {
    logger.error('[Agent] Error reactivando bot:', error);
    res.status(500).json({ error: 'Error interno' });
  }
};
