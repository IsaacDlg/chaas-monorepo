import axios from 'axios';
import fs from 'fs';
import os from 'os';
import path from 'path';
import OpenAI from 'openai';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const WHATSAPP_MEDIA_URL = 'https://graph.facebook.com/v17.0';

// =============================================================================
// PARCHE VULN-08: S3/R2 client — compatible con AWS S3 y Cloudflare R2.
// ENVs requeridas: S3_ENDPOINT, S3_BUCKET, S3_REGION, S3_ACCESS_KEY, S3_SECRET_KEY, S3_PUBLIC_URL
// =============================================================================
const s3 = new S3Client({
  region: process.env.S3_REGION || 'auto',
  endpoint: process.env.S3_ENDPOINT, // Para R2: https://<account_id>.r2.cloudflarestorage.com
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY || '',
    secretAccessKey: process.env.S3_SECRET_KEY || '',
  },
  forcePathStyle: true, // Requerido para R2 y MinIO
});

const S3_BUCKET = process.env.S3_BUCKET || 'chaas-media';
// URL pública base (ej: https://pub-xxx.r2.dev o https://cdn.tudominio.com)
const S3_PUBLIC_URL = process.env.S3_PUBLIC_URL || '';

// Download media from WhatsApp using the media ID and token, returns Buffer
export async function downloadMedia(mediaId: string, token: string): Promise<Buffer> {
  // Paso 1: Obtener la URL real del archivo
  const metaResp = await axios.get(`${WHATSAPP_MEDIA_URL}/${mediaId}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const mediaUrl = metaResp.data.url;

  // Paso 2: Descargar el archivo binario
  const fileResp = await axios.get(mediaUrl, {
    responseType: 'arraybuffer',
    headers: { Authorization: `Bearer ${token}` }
  });
  return Buffer.from(fileResp.data);
}

// Sube un buffer a S3/R2 y retorna la URL pública. Reemplaza escritura a disco local.
export async function uploadMediaToS3(
  buffer: Buffer,
  key: string,
  contentType: string = 'application/octet-stream'
): Promise<string> {
  await s3.send(new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType,
  }));
  return `${S3_PUBLIC_URL}/${key}`;
}

// Descarga de WhatsApp + sube a S3 en un solo paso. Retorna URL pública.
export async function downloadAndStoreMedia(
  mediaId: string,
  token: string,
  tenantId: string,
  ext: string = 'bin'
): Promise<string> {
  const buffer = await downloadMedia(mediaId, token);
  const key = `${tenantId}/${Date.now()}_${mediaId}.${ext}`;
  return uploadMediaToS3(buffer, key, ext === 'ogg' ? 'audio/ogg' : `image/${ext}`);
}

// Transcribe audio using OpenAI Whisper v4+ SDK
export async function transcribeAudio(audioBuffer: Buffer): Promise<string> {
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) throw new Error('OPENAI_API_KEY not configured');

  const openai = new OpenAI({ apiKey: openaiKey });

  // Escribir buffer a archivo temporal (Whisper necesita un File object)
  const tmpPath = path.join(os.tmpdir(), `whisper_${Date.now()}.ogg`);
  fs.writeFileSync(tmpPath, audioBuffer);

  try {
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tmpPath),
      model: 'whisper-1',
    });
    return transcription.text;
  } finally {
    // Limpiar archivo temporal SIEMPRE
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  }
}
