import prisma from '../config/prisma.js';

/**
 * Lista las rutas de cobro de una organización.
 *
 * @param {string} organizationId - UUID de la organización
 * @returns {Promise<Array>}
 */
export const findRoutes = async (organizationId) =>
  prisma.route.findMany({
    where: { organizationId },
    orderBy: { name: 'asc' },
    select: {
      id: true,
      name: true,
      description: true,
      isActive: true,
      collector: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        },
      },
      _count: {
        select: {
          clients: true,
        },
      },
    },
  });

/**
 * Búsqueda tipo typeahead de rutas de cobro.
 * Busca por name o por id/code parcial (si existe código almacenado en name o descripción).
 *
 * @param {string} organizationId
 * @param {string} q
 * @param {number} [limit=15]
 * @returns {Promise<Array>}
 */
export const searchRoutes = async (organizationId, q, limit = 15) => {
  if (!q || q.trim() === '') return [];
  const term = q.trim();

  return prisma.route.findMany({
    where: {
      organizationId,
      isActive: true,
      OR: [
        { name: { contains: term, mode: 'insensitive' } },
        { description: { contains: term, mode: 'insensitive' } },
      ],
    },
    take: limit,
    orderBy: { name: 'asc' },
    select: { id: true, name: true, description: true },
  });
};

/**
 * Crea una nueva ruta de cobro en la organización.
 *
 * @param {string} organizationId
 * @param {{ name: string, description?: string, collectorId?: string, isActive?: boolean }} data
 * @returns {Promise<import('@prisma/client').Route>}
 */
export const createRoute = async (organizationId, data) => {
  const { name, description, collectorId, isActive } = data;

  return prisma.route.create({
    data: {
      organizationId,
      name,
      description: description || null,
      collectorId: collectorId || null,
      isActive: isActive ?? true,
    },
  });
};

/**
 * Obtiene una ruta por id y verifica que pertenezca a la organización.
 * Lanza error si no se encuentra.
 *
 * @param {string} id
 * @param {string} organizationId
 * @returns {Promise<import('@prisma/client').Route>}
 */
export const findRouteById = async (id, organizationId) => {
  const route = await prisma.route.findFirst({
    where: { id, organizationId },
    select: {
      id: true,
      organizationId: true,
      collectorId: true,
      name: true,
      description: true,
      isActive: true,
      collector: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        },
      },
    },
  });

  if (!route) {
    const err = new Error('Ruta no encontrada');
    err.statusCode = 404;
    err.isOperational = true;
    throw err;
  }

  return route;
};

/**
 * Obtiene una ruta con su cobrador y sus clientes (incluye coordenadas
 * para el mapa). Verifica que pertenezca a la organización.
 *
 * @param {string} id
 * @param {string} organizationId
 * @returns {Promise<import('@prisma/client').Route>}
 */
export const findRouteWithClients = async (id, organizationId) => {
  const route = await prisma.route.findFirst({
    where: { id, organizationId },
    select: {
      id: true,
      name: true,
      description: true,
      isActive: true,
      collector: {
        select: { id: true, firstName: true, lastName: true, phone: true },
      },
      clients: {
        orderBy: { firstName: 'asc' },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          phone: true,
          address: true,
          businessName: true,
          latitude: true,
          longitude: true,
          isActive: true,
          _count: { select: { loans: true } },
        },
      },
    },
  });

  if (!route) {
    const err = new Error('Ruta no encontrada');
    err.statusCode = 404;
    err.isOperational = true;
    throw err;
  }

  return route;
};

/**
 * Actualiza una ruta verificando organización.
 *
 * @param {string} id
 * @param {string} organizationId
 * @param {Object} data
 * @param {string} [data.name]
 * @param {string} [data.description]
 * @param {string|null} [data.collectorId]
 * @param {boolean} [data.isActive]
 * @returns {Promise<import('@prisma/client').Route>}
 */
export const updateRoute = async (id, organizationId, data) => {
  await prisma.route.findFirstOrThrow({ where: { id, organizationId } });

  const { name, description, collectorId, isActive } = data;

  return prisma.route.update({
    where: { id },
    data: {
      name,
      description: description ?? null,
      collectorId: collectorId || null,
      isActive: isActive ?? true,
    },
  });
};
