import prisma from '../config/prisma.js';

const EXPENSE_CATEGORIES = ['FUEL', 'VEHICLE_REPAIR', 'FOOD', 'OTHER'];

/**
 * Lista los gastos operativos de una organización con filtros y paginación.
 * Si se provee collectorId, se restringe a ese cobrador (usado para forzar
 * que un COLLECTOR solo vea sus propios gastos).
 *
 * @param {string} organizationId
 * @param {{ collectorId?: string, category?: string, dateFrom?: string,
 *   dateTo?: string, page?: number, pageSize?: number }} [filters]
 * @returns {Promise<{ expenses: Array, collectors: Array, total: number,
 *   totalAmount: string, page: number, totalPages: number }>}
 */
export const findExpenses = async (
  organizationId,
  { collectorId, category, dateFrom, dateTo, page = 1, pageSize = 25 } = {},
) => {
  const currentPage = Math.max(1, page);
  const skip = (currentPage - 1) * pageSize;

  /** @type {import('@prisma/client').Prisma.DateTimeFilter|undefined} */
  let expenseDateFilter;
  if (dateFrom || dateTo) {
    expenseDateFilter = {};
    if (dateFrom) expenseDateFilter.gte = new Date(dateFrom);
    if (dateTo) expenseDateFilter.lte = new Date(`${dateTo}T23:59:59.999Z`);
  }

  /** @type {import('@prisma/client').Prisma.ExpenseWhereInput} */
  const where = {
    organizationId,
    ...(expenseDateFilter && { expenseDate: expenseDateFilter }),
    ...(collectorId && { collectorId }),
    ...(category && EXPENSE_CATEGORIES.includes(category) && { category }),
  };

  const [expenses, total, totalAmountResult, collectors] = await Promise.all([
    prisma.expense.findMany({
      where,
      orderBy: { expenseDate: 'desc' },
      skip,
      take: pageSize,
      select: {
        id: true,
        category: true,
        amount: true,
        description: true,
        expenseDate: true,
        photoUrl: true,
        createdAt: true,
        collector: { select: { id: true, firstName: true, lastName: true } },
      },
    }),
    prisma.expense.count({ where }),
    prisma.expense.aggregate({ where, _sum: { amount: true } }),
    prisma.user.findMany({
      where: { organizationId, role: 'COLLECTOR', isActive: true },
      select: { id: true, firstName: true, lastName: true },
      orderBy: { firstName: 'asc' },
    }),
  ]);

  return {
    expenses,
    collectors,
    total,
    totalAmount: totalAmountResult._sum.amount ?? 0,
    page: currentPage,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
};

/**
 * Registra un gasto operativo. El collectorId siempre lo decide el caller
 * (el controller fuerza req.user.id cuando el rol es COLLECTOR).
 *
 * @param {string} organizationId
 * @param {string} collectorId
 * @param {{ category: string, amount: number|string, description?: string,
 *   expenseDate: string }} data
 * @returns {Promise<import('@prisma/client').Expense>}
 */
export const createExpense = async (organizationId, collectorId, data) => {
  const { category, amount, description, expenseDate } = data;

  return prisma.expense.create({
    data: {
      organizationId,
      collectorId,
      category,
      amount,
      description: description?.trim() || null,
      expenseDate: new Date(expenseDate),
    },
  });
};

/**
 * Elimina un gasto. Solo permite borrar al propio cobrador que lo registró
 * o a un ADMIN/SUPER_ADMIN de la misma organización.
 *
 * @param {string} id
 * @param {string} organizationId
 * @param {{ id: string, role: string }} requester
 * @returns {Promise<void>}
 */
export const deleteExpense = async (id, organizationId, requester) => {
  const expense = await prisma.expense.findFirst({
    where: { id, organizationId },
    select: { id: true, collectorId: true },
  });

  if (!expense) {
    const err = new Error('Gasto no encontrado');
    err.statusCode = 404;
    err.isOperational = true;
    throw err;
  }

  const isOwner = expense.collectorId === requester.id;
  const isAdmin = ['ADMIN', 'SUPER_ADMIN'].includes(requester.role);

  if (!isOwner && !isAdmin) {
    const err = new Error('No tienes permiso para eliminar este gasto');
    err.statusCode = 403;
    err.isOperational = true;
    throw err;
  }

  await prisma.expense.delete({ where: { id } });
};
