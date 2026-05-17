import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import { createServer } from 'http';
import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';

import webhookRoutes from './routes/webhookRoutes';
import internalRoutes from './routes/internalRoutes';
import agentRoutes from './routes/agentRoutes';
import authRoutes from './routes/authRoutes';
import stripeRoutes from './routes/stripeRoutes';
import { globalLimiter } from './middlewares/rateLimiter';
import { logger } from './lib/logger';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-key-change-in-prod';

// Extraer el servidor HTTP para Socket.io
const httpServer = createServer(app);

// Configurar Socket.io con soporte para CORS
export const io = new Server(httpServer, {
  cors: {
    // PARCHE WEAK-01: Restringir CORS al frontend específico
    origin: process.env.FRONTEND_URL || 'http://localhost:3001',
    methods: ['GET', 'POST']
  },
  // Configuración de heartbeat para detectar conexiones zombi
  pingTimeout: 60000,
  pingInterval: 25000
});

// PARCHE WEAK-01: CORS restrictivo en Express también
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3001',
  credentials: true
}));
app.use(helmet());

// PARCHE VULN-04: Rate limiter GLOBAL (primera línea de defensa)
app.use(globalLimiter);

app.use(express.json());

// Endpoint de prueba de vida
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', message: 'CHaaS API is running with Sockets' });
});

// Registrar Rutas
app.use('/api/webhook', webhookRoutes);
app.use('/api/internal', internalRoutes);
app.use('/api/agent', agentRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/stripe', stripeRoutes);

// ============================================================
// PARCHE WEAK-02: Socket.io con autenticación JWT
// El agente debe enviar su token JWT al conectarse.
// Si no tiene token válido, no entra.
// ============================================================
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) {
    return next(new Error('Autenticación requerida'));
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    (socket as any).user = decoded;
    next();
  } catch (err) {
    return next(new Error('Token inválido o expirado'));
  }
});

// Lógica de Conexión de WebSockets (Handoff/Trengo)
io.on('connection', (socket) => {
  const user = (socket as any).user;
  logger.info(`[Socket] Agente conectado: ${user.id} (Tenant: ${user.tenantId})`);

  // PARCHE: Solo puede unirse a la sala de SU tenant (no a cualquiera)
  socket.on('join_tenant_room', (tenantId: string) => {
    if (tenantId !== user.tenantId) {
      logger.warn(`[Socket] Intento de acceso no autorizado a sala tenant_${tenantId} por user ${user.id}`);
      socket.emit('error', 'No autorizado para esta sala');
      return;
    }
    const roomName = `tenant_${tenantId}`;
    socket.join(roomName);
    logger.info(`[Socket] Agente ${user.id} unido a sala: ${roomName}`);
  });

  // PARCHE: Limpieza al desconectar (Memory Leak Prevention)
  socket.on('disconnect', (reason) => {
    logger.info(`[Socket] Agente ${user.id} desconectado. Razón: ${reason}`);
    // Socket.io limpia automáticamente las rooms al desconectar,
    // pero removemos listeners explícitamente por seguridad.
    socket.removeAllListeners();
  });
});

// Escuchar sobre httpServer en lugar de app.listen
httpServer.listen(PORT, () => {
  logger.info(`[Server] CHaaS API corriendo en http://localhost:${PORT}`);
  logger.info(`[Server] Entorno: ${process.env.NODE_ENV || 'development'}`);
});
