import { Worker } from 'bullmq';
import redisClient from '../config/redis.js';
import { runImportBatch } from '../services/import.service.js';

const QUEUE_NAME = 'import-processing';

/**
 * Inicia el worker de BullMQ que procesa lotes de importación en segundo
 * plano. Cada job corresponde a un ImportBatch completo; el progreso
 * fila-por-fila se emite vía Socket.io desde runImportBatch.
 *
 * Cola: import-processing
 * - Concurrencia: 2 (importaciones grandes pueden ser largas; no saturar la DB)
 * - Reintentos: 2 — si un lote entero falla (ej. Redis se cae a mitad de proceso),
 *   reintentar es seguro porque cada fila ya procesada queda marcada IMPORTED/SKIPPED
 *   y no se vuelve a tocar (runImportBatch solo toma filas en estado VALID).
 *
 * @returns {Worker}
 */
const startImportWorker = () => {
  const worker = new Worker(
    QUEUE_NAME,
    async (job) => runImportBatch(job.data.batchId),
    {
      connection: redisClient,
      concurrency: 2,
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: 'exponential', delay: 3000 },
        removeOnComplete: { count: 200 },
        removeOnFail: { count: 500 },
      },
    },
  );

  worker.on('completed', (job) => {
    console.log(`[ImportWorker] Lote ${job.data.batchId} procesado`);
  });

  worker.on('failed', (job, err) => {
    console.error(
      `[ImportWorker] Lote ${job?.data?.batchId} falló (intento ${job?.attemptsMade}/${job?.opts?.attempts}):`,
      err.message,
    );
  });

  console.log(`[ImportWorker] Escuchando cola "${QUEUE_NAME}"`);
  return worker;
};

export default startImportWorker;
export { QUEUE_NAME };
