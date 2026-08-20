import 'dotenv/config';
import { createServer } from 'node:http';
import { Server as SocketServer } from 'socket.io';

// env debe importarse antes que cualquier otro módulo del proyecto para que
// la validación falle rápido (fail-fast) si faltan variables críticas.
import env from './config/env.js';
import app from './app.js';
import prisma from './config/prisma.js';
import redisClient from './config/redis.js';
import { initTelegramBot } from './config/telegram.js';
import startTelegramWorker from './jobs/telegramWorker.js';
import startMoraWorker from './jobs/moraWorker.js';
import startPdfWorker from './jobs/pdfWorker.js';
import startImportWorker from './jobs/importWorker.js';
import scheduleMoraJobs from './jobs/mora.scheduler.js';
import { setIO } from './config/socket.js';

// ============================================
// CONFIGURACIÓN
// ============================================

const { PORT } = env;
const { CORS_ORIGIN } = env;

// ============================================
// HTTP SERVER + SOCKET.IO
// ============================================

const httpServer = createServer(app);

const io = new SocketServer(httpServer, {
  cors: {
    origin: CORS_ORIGIN,
    credentials: true,
  },
  transports: ['websocket', 'polling'],
});

// Exponer io en la app para uso en controladores / servicios, y en el
// singleton de src/config/socket.js para uso en workers de BullMQ (que no
// tienen acceso a `req.app`).
app.set('io', io);
setIO(io);

io.on('connection', (socket) => {
  console.log(`[Socket.io] Cliente conectado: ${socket.id}`);

  socket.on('disconnect', (reason) => {
    console.log(`[Socket.io] Cliente desconectado: ${socket.id} (${reason})`);
  });
});

// ============================================
// BACKGROUND WORKERS (BullMQ)
// ============================================

let telegramWorker;
let moraWorker;
let pdfWorker;
let importWorker;

/**
 * Inicia los workers de BullMQ para procesar colas en segundo plano.
 */
const startWorkers = () => {
  telegramWorker = startTelegramWorker();
  moraWorker = startMoraWorker();
  pdfWorker = startPdfWorker();
  importWorker = startImportWorker();
};

// ============================================
// GRACEFUL SHUTDOWN
// ============================================

/**
 * Cierra todos los recursos de forma ordenada.
 * @param {string} signal - Señal que disparó el cierre (SIGINT | SIGTERM)
 */
const shutdown = async (signal) => {
  console.log(`\n[Server] Señal ${signal} recibida. Cerrando...`);

  // 1. Dejar de aceptar nuevas conexiones HTTP
  httpServer.close(() => {
    console.log('[Server] HTTP server cerrado');
  });

  // 2. Cerrar Socket.io
  io.close(() => {
    console.log('[Server] Socket.io cerrado');
  });

  // 3. Cerrar workers de BullMQ
  try {
    if (telegramWorker) await telegramWorker.close();
    if (moraWorker) await moraWorker.close();
    if (pdfWorker) await pdfWorker.close();
    if (importWorker) await importWorker.close();
    console.log('[Server] Workers cerrados');
  } catch (err) {
    console.error('[Server] Error cerrando workers:', err.message);
  }

  // 4. Desconectar Prisma
  try {
    await prisma.$disconnect();
    console.log('[Server] Prisma desconectado');
  } catch (err) {
    console.error('[Server] Error desconectando Prisma:', err.message);
  }

  // 5. Desconectar Redis (solo si está configurado)
  if (redisClient) {
    try {
      await redisClient.quit();
      console.log('[Server] Redis desconectado');
    } catch (err) {
      console.error('[Server] Error desconectando Redis:', err.message);
    }
  }

  process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ============================================
// ARRANQUE
// ============================================

/**
 * Conecta dependencias e inicia el servidor HTTP.
 * @returns {Promise<void>}
 */
const startServer = async () => {
  try {
    // Conectar Prisma (verifica conexión a PostgreSQL)
    await prisma.$connect();
    console.log('[Server] ✓ PostgreSQL conectado');

    // Conectar Redis solo si está configurado
    if (redisClient) {
      if (redisClient.status === 'wait') {
        await redisClient.connect();
      }
      console.log('[Server] ✓ Redis conectado');

      // BullMQ requiere Redis — solo iniciar workers si Redis está disponible
      startWorkers();
      console.log('[Server] ✓ Workers iniciados');

      // Programa jobs de mora: inmediato (startup) + diario (02:00 UTC)
      await scheduleMoraJobs();
      console.log('[Server] ✓ Jobs de mora programados');
    } else {
      console.warn('[Server] Redis no configurado — workers BullMQ desactivados');
    }

    // Inicializar bot de Telegram
    initTelegramBot({
      token: env.TELEGRAM_BOT_TOKEN,
      webhookUrl: env.TELEGRAM_WEBHOOK_URL,
      isProduction: env.NODE_ENV === 'production',
    });
    console.log('[Server] ✓ Telegram configurado');

    // Levantar servidor HTTP.
    // El callback recibe err para no silenciar fallos de arranque inesperados
    // (p. ej. puerto en uso antes del evento 'error' del socket).
    httpServer.listen(PORT, (err) => {
      if (err) throw err;
      console.log(`[Server] ✓ Escuchando en http://localhost:${PORT}`);
      console.log(`[Server]   Entorno: ${env.NODE_ENV}`);
    });

    // Puerto ya en uso → mensaje claro en vez de excepción sin capturar
    httpServer.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`[Server] ✗ El puerto ${PORT} ya está en uso.`);
        console.error(`[Server]   Ejecuta: lsof -nP -iTCP:${PORT} -sTCP:LISTEN`);
        console.error('[Server]   Luego:   kill -9 <PID>   o usa PORT=XXXX npm run dev');
      } else {
        console.error('[Server] Error de red:', err);
      }
      process.exit(1);
    });
  } catch (err) {
    console.error('[Server] Error fatal al iniciar:', err);
    process.exit(1);
  }
};

startServer();
