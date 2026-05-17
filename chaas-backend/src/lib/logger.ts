import winston from 'winston';

// ============================================================
// NICE-TO-HAVE ENTERPRISE: Logger estructurado con Winston
// Reemplaza todos los console.log/error/warn con logs formateados,
// con timestamp, nivel, y opcionalmente exportables a Datadog/Grafana.
// ============================================================

const { combine, timestamp, printf, colorize, errors } = winston.format;

const logFormat = printf(({ level, message, timestamp, stack }) => {
  return `${timestamp} [${level}]: ${stack || message}`;
});

export const logger = winston.createLogger({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  format: combine(
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    errors({ stack: true }),
    logFormat
  ),
  defaultMeta: { service: 'chaas-backend' },
  transports: [
    // Consola (coloreada en dev)
    new winston.transports.Console({
      format: combine(colorize(), logFormat)
    }),
    // Archivo de errores (producción)
    new winston.transports.File({ 
      filename: 'logs/error.log', 
      level: 'error',
      maxsize: 5242880, // 5MB
      maxFiles: 5
    }),
    // Archivo combinado (todo)
    new winston.transports.File({ 
      filename: 'logs/combined.log',
      maxsize: 5242880,
      maxFiles: 5
    })
  ],
});
