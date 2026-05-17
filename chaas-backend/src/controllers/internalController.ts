import { Request, Response } from 'express';
import { prisma, forTenant } from '../lib/prisma';
import axios from 'axios';
import { io } from '../index';
import { logger } from '../lib/logger';

// ============================================================
// HELPER: Verificar ventana de 24h de WhatsApp (VULN-06)
// Retorna true si la ventana está abierta, false si expiró.
// ============================================================
async function isWithin24hWindow(contactId: string, tenantId: string): Promise<boolean> {
  const db = forTenant(tenantId);
  const contact = await db.contact.findUnique({
    where: { id: contactId },
    select: { last_inbound_at: true }
  });

  if (!contact?.last_inbound_at) return false;
  return (Date.now() - contact.last_inbound_at.getTime()) < 24 * 60 * 60 * 1000;
}

// ============================================================
// HELPER: Enviar mensaje HSM (Template) cuando la ventana expiró
// ============================================================
async function sendTemplateMessage(tenantId: string, wa_id: string, templateName: string = 'hello_world') {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant?.wa_token || !tenant?.wa_phone_number_id) return;

  const payload = {
    messaging_product: 'whatsapp',
    to: wa_id,
    type: 'template',
    template: {
      name: templateName,
      language: { code: 'es' }
    }
  };

  const META_URL = `https://graph.facebook.com/v17.0/${tenant.wa_phone_number_id}/messages`;

  try {
    await axios.post(META_URL, payload, {
      headers: {
        'Authorization': `Bearer ${tenant.wa_token}`,
        'Content-Type': 'application/json'
      }
    });
    logger.info(`[Internal] Template HSM enviado a ${wa_id} (ventana 24h expirada)`);
  } catch (err: any) {
    logger.error(`[Internal] Error enviando template HSM:`, err?.response?.data || err.message);
  }
}

// 1. Obtener la Configuración del Tenant para n8n
export const getTenantConfig = async (req: Request, res: Response) => {
  try {
    const { tenantId } = req.params;
    
    // Tenant no tiene tenantId propio — prisma base es correcto aquí
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { system_prompt: true, wa_phone_number_id: true }
    });

    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    res.status(200).json(tenant);
  } catch (error) {
    logger.error('[Internal] Error getting tenant config:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

// 2. Ejecutar un Handoff (Asignar a humano y apagar bot)
export const executeHandoff = async (req: Request, res: Response) => {
  try {
    const { tenantId, wa_id } = req.body;
    const db = forTenant(tenantId);

    const contact = await db.contact.update({
      where: {
        tenantId_wa_id: { tenantId, wa_id }
      },
      data: {
        is_bot_active: false
      }
    });

    // Alertar a todos los agentes de esta empresa en tiempo real
    const tenantRoom = `tenant_${tenantId}`;
    io.to(tenantRoom).emit('requires_human', {
      contactId: contact.id,
      wa_id: contact.wa_id,
      message: 'El usuario ha solicitado hablar con un humano o la IA necesita ayuda.'
    });

    res.status(200).json({ success: true, message: 'Bot paused. Handoff completed.' });
  } catch (error) {
    logger.error('[Internal] Error executing handoff:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

// 3. Enviar mensaje de vuelta a WhatsApp API (Callback de n8n)
export const sendWhatsappMessage = async (req: Request, res: Response) => {
  try {
    const { tenantId, wa_id, message } = req.body;

    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId }
    });

    if (!tenant || !tenant.wa_token || !tenant.wa_phone_number_id) {
      return res.status(400).json({ error: 'Tenant missing WhatsApp credentials' });
    }

    // ============================================================
    // PARCHE VULN-06: Verificar ventana de 24 horas
    // Si la ventana expiró, usamos Template HSM en lugar de texto libre
    // ============================================================
    const db = forTenant(tenantId);

    const contact = await db.contact.findUnique({
      where: { tenantId_wa_id: { tenantId, wa_id } }
    });

    if (contact && !(await isWithin24hWindow(contact.id, tenantId))) {
      logger.warn(`[Internal] Ventana de 24h expirada para ${wa_id}. Enviando template HSM.`);
      await sendTemplateMessage(tenantId, wa_id);
      return res.status(200).json({ 
        success: true, 
        status: 'template_sent',
        reason: 'Ventana de 24h expirada. Se envió plantilla HSM.'
      });
    }

    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: wa_id,
      type: 'text',
      text: {
        preview_url: false,
        body: message
      }
    };

    const META_URL = `https://graph.facebook.com/v17.0/${tenant.wa_phone_number_id}/messages`;

    // Enviar a Meta de forma asíncrona pero devolviendo 200 a n8n rápido
    axios.post(META_URL, payload, {
      headers: {
        'Authorization': `Bearer ${tenant.wa_token}`,
        'Content-Type': 'application/json'
      }
    }).then(async response => {
      await prisma.message.create({
        data: {
          wa_message_id: response.data.messages[0].id,
          body: message,
          direction: 'OUTBOUND',
          status: 'SENT',
          contact: {
            connect: { tenantId_wa_id: { tenantId, wa_id } }
          }
        }
      });
      logger.info(`[Internal] Message sent successfully to ${wa_id}`);
    }).catch(err => {
      logger.error(`[Internal] Failed sending message to Meta for ${wa_id}:`, err?.response?.data || err.message);
    });

    // n8n no necesita esperar la respuesta de Meta
    res.status(200).json({ success: true, status: 'sending' });
  } catch (error) {
    logger.error('[Internal] Error in sendWhatsappMessage:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};
