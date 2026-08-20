/**
 * Acceso a la instancia de Socket.io fuera del ciclo request/response.
 *
 * Los controladores acceden a `io` vía `req.app.get('io')`. Los workers de
 * BullMQ no tienen `req` — este singleton les da la misma instancia para
 * poder emitir eventos (ej. progreso de importación) desde background jobs.
 */
let ioInstance = null;

/**
 * @param {import('socket.io').Server} io
 */
export const setIO = (io) => {
  ioInstance = io;
};

/**
 * @returns {import('socket.io').Server|null}
 */
export const getIO = () => ioInstance;
