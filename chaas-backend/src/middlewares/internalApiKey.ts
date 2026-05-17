import { Request, Response, NextFunction } from 'express';
import { logger } from '../lib/logger';

// ============================================================
// PARCHE VULN-05: API Key para proteger rutas internas (n8n)
// n8n debe enviar esta key en el header X-Internal-API-Key
// para poder acceder a /api/internal/*
// ============================================================

const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || 'chaas-internal-key-change-in-prod';

export const requireInternalApiKey = (req: Request, res: Response, next: NextFunction) => {
  const apiKey = req.headers['x-internal-api-key'];

  if (!apiKey || apiKey !== INTERNAL_API_KEY) {
    logger.warn(`[Security] Intento de acceso no autorizado a ruta interna desde IP: ${req.ip}`);
    return res.status(403).json({ error: 'Acceso denegado. API Key inválida.' });
  }

  next();
};
