import rateLimit from 'express-rate-limit';

// ============================================================
// PARCHE VULN-04: Rate Limiting escalonado por ruta
// Protege contra DDoS, brute-force e inflación de costos.
// ============================================================

// Límite global (todo el servidor)
export const globalLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minuto
  max: 200, // Máximo 200 peticiones por IP por minuto
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas peticiones. Intente de nuevo en 1 minuto.' }
});

// Límite estricto para el webhook de WhatsApp (Meta envía mucho, pero un atacante más)
export const webhookLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 300, // Meta puede enviar ráfagas legítimas, así que más holgura
  standardHeaders: true,
  legacyHeaders: false,
  message: 'EVENT_RECEIVED' // Meta espera este formato
});

// Límite agresivo para auth (anti brute-force)
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 10, // Máximo 10 intentos de login por IP cada 15 min
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos. Cuenta bloqueada temporalmente por 15 minutos.' }
});
