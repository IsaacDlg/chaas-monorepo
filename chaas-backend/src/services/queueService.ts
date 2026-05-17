import { Queue, Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import axios from 'axios';
import { logger } from '../lib/logger';

// Conexión a Redis con maxRetriesPerRequest: null (REQUERIDO por BullMQ)
const connection = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null
});

// Definición de la cola de mensajes
export const messageQueue = new Queue('whatsapp-messages', { connection });

// El Worker procesará los mensajes encolados asíncronamente
export const messageWorker = new Worker(
  'whatsapp-messages',
  async (job: Job) => {
    const { message, tenantId, wa_id, current_state, tags } = job.data;
    
    // Payload estructurado para enviar a n8n
    const n8nPayload = {
      tenantId,
      user_phone: wa_id,
      message: message.text ? message.text.body : '[Media/Other]',
      current_state,
      tags
    };

    const N8N_URL = process.env.N8N_WEBHOOK_URL || 'http://localhost:5678/webhook/';

    try {
      logger.info(`[Queue] Procesando mensaje hacia n8n. Tenant: ${tenantId}, Contact: ${wa_id}`);
      
      // POST hacia el Webhook local de n8n
      const response = await axios.post(N8N_URL, n8nPayload);
      
      logger.info(`[Queue] Mensaje enviado a n8n exitosamente. Status: ${response.status}`);
    } catch (error: any) {
      logger.error(`[Queue] Error enviando payload a n8n: ${error.message}`);
      // Lanzar el error permite a BullMQ reintentar el trabajo según la configuración (backoff)
      throw error; 
    }
  },
  { 
    connection, 
    concurrency: 10 // Limitar la concurrencia para proteger la RAM de n8n
  } 
);

messageWorker.on('completed', job => {
  logger.info(`[Queue] Job ${job.id} completado.`);
});

messageWorker.on('failed', (job, err) => {
  logger.error(`[Queue] Job ${job?.id} falló permanentemente: ${err.message}`);
});
