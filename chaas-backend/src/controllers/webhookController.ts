import { Request, Response } from 'express';
import { prisma, forTenant } from '../lib/prisma';
import { messageQueue } from '../services/queueService';
import { io } from '../index';
import { downloadMedia, transcribeAudio } from '../lib/media';
import { logger } from '../lib/logger';

// 1. Verificación del Webhook de Meta
export const verifyWebhook = (req: Request, res: Response) => {
  const mode = req.query['hub.mode'];
  const challenge = req.query['hub.challenge'];
  const token = req.query['hub.verify_token'];

  const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

  if (mode && token) {
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      logger.info('[Webhook] Webhook verificado por Meta.');
      res.status(200).send(challenge);
    } else {
      res.sendStatus(403);
    }
  } else {
    res.sendStatus(400);
  }
};

// 2. Recepción y Encolamiento de Mensajes (Post)
export const receiveMessage = async (req: Request, res: Response) => {
  try {
    const body = req.body;

    if (body.object === 'whatsapp_business_account') {
      for (const entry of body.entry) {
        for (const change of entry.changes) {
          if (change.value && change.value.messages && change.value.messages[0]) {
            
            const message = change.value.messages[0];
            const metadata = change.value.metadata;
            
            // Extracción: Número receptor (Tenant) y Número del Cliente
            const display_phone_number = metadata.display_phone_number;
            const wa_id = message.from; 

            // ============================================================
            // PARCHE VULN-03: IDEMPOTENCIA — Evitar procesar duplicados
            // Meta reintenta webhooks si tardamos >5s. Verificamos si el 
            // wa_message_id ya fue guardado antes de hacer CUALQUIER cosa.
            // ============================================================
            if (message.id) {
              const existing = await prisma.message.findUnique({
                where: { wa_message_id: message.id }
              });
              if (existing) {
                logger.warn(`[Webhook] Mensaje duplicado ignorado: ${message.id}`);
                continue; // Saltar sin error — Meta recibirá su 200 OK al final
              }
            }
            
            // Identificación INMEDIATA del Tenant usando Prisma
            const tenant = await prisma.tenant.findFirst({
              where: {
                wa_phone_number_id: display_phone_number
              }
            });

            if (!tenant) {
              logger.error(`[Webhook] ERROR: Ninguna empresa registrada con el número receptor: ${display_phone_number}`);
              continue; // Ignorar el mensaje
            }

            // forTenant para create/update; prisma base para findUnique con include (tenantId ya en el where compuesto)
            const db = forTenant(tenant.id);

            let contact = await prisma.contact.findUnique({
              where: {
                tenantId_wa_id: {
                  tenantId: tenant.id,
                  wa_id: wa_id
                }
              },
              include: {
                tags: { include: { tag: true } }
              }
            });

            if (!contact) {
              contact = await prisma.contact.create({
                data: {
                  wa_id: wa_id,
                  tenantId: tenant.id,
                  last_inbound_at: new Date()
                },
                include: {
                  tags: { include: { tag: true } }
                }
              });
            } else {
              // PARCHE VULN-06: Actualizar ventana de 24h en cada mensaje entrante
              await db.contact.update({
                where: { id: contact.id },
                data: { last_inbound_at: new Date() }
              });
            }

            // Guardar el mensaje en la base de datos como INBOUND
            await prisma.message.create({
              data: {
                wa_message_id: message.id,
                body: message.text ? message.text.body : '[Media]',
                direction: 'INBOUND',
                contactId: contact.id
              }
            });

            // Lógica Zenvia/Trengo: Verificar Handoff (Si el bot está apagado para este cliente)
            if (!contact.is_bot_active) {
              logger.info(`[Handoff] Bot pausado. Mensaje de ${wa_id} enviado a la bandeja humana.`);
              
              // Emitir evento por WebSockets para la bandeja del Agente en el Frontend (Live Chat)
              const tenantRoom = `tenant_${tenant.id}`;
              io.to(tenantRoom).emit('new_user_message', {
                contactId: contact.id,
                wa_id: contact.wa_id,
                message: message.text ? message.text.body : '[Media]',
                timestamp: new Date()
              });

              continue; 
            }

            // Si el mensaje es audio, descargamos y transcribimos antes de encolar
            if (message.type === 'audio' && message.audio && message.audio.id) {
              try {
                const mediaBuffer = await downloadMedia(message.audio.id, tenant.wa_token!);
                const transcription = await transcribeAudio(mediaBuffer);
                // Reemplazamos el cuerpo del mensaje con la transcripción
                message.text = { body: transcription };
              } catch (err) {
                logger.error('[Webhook] Error transcribiendo audio:', err);
              }
            }

            // Mapeo de los Tags para enviar a n8n
            const tagNames = contact.tags.map(t => t.tag.name);

            // 3. Encolar el mensaje en BullMQ para procesar en n8n
            await messageQueue.add('process-whatsapp-message', {
              message,
              tenantId: tenant.id,
              wa_id: contact.wa_id,
              current_state: 'default',
              tags: tagNames
            }, {
              attempts: 3, 
              backoff: { type: 'exponential', delay: 1000 }
            });

          }
        }
      }
      
      // 4. Responder a Meta de forma síncrona INMEDIATA para evitar Timeout loop
      res.status(200).send('EVENT_RECEIVED');
    } else {
      res.sendStatus(404);
    }
  } catch (error) {
    logger.error('[Webhook] Error crítico procesando mensaje:', error);
    // PARCHE: Incluso en error, respondemos 200 a Meta para evitar reintentos infinitos
    res.status(200).send('EVENT_RECEIVED');
  }
};
