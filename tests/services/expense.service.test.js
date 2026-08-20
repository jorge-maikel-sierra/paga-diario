import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const mockFindMany = jest.fn();
const mockCount = jest.fn();
const mockAggregate = jest.fn();
const mockFindManyUsers = jest.fn();
const mockCreate = jest.fn();
const mockFindFirst = jest.fn();
const mockDelete = jest.fn();

jest.unstable_mockModule('../../src/config/prisma.js', () => ({
  default: {
    expense: {
      findMany: mockFindMany,
      count: mockCount,
      aggregate: mockAggregate,
      create: mockCreate,
      findFirst: mockFindFirst,
      delete: mockDelete,
    },
    user: { findMany: mockFindManyUsers },
  },
}));

const { findExpenses, createExpense, deleteExpense } = await import(
  '../../src/services/expense.service.js'
);

beforeEach(() => jest.clearAllMocks());

describe('expense.service', () => {
  describe('findExpenses', () => {
    it('devuelve gastos, total y suma correctamente', async () => {
      mockFindMany.mockResolvedValue([{ id: 'e1', amount: 20000 }]);
      mockCount.mockResolvedValue(1);
      mockAggregate.mockResolvedValue({ _sum: { amount: 20000 } });
      mockFindManyUsers.mockResolvedValue([{ id: 'c1', firstName: 'Carlos', lastName: 'López' }]);

      const result = await findExpenses('org1', {});

      expect(result.expenses).toEqual([{ id: 'e1', amount: 20000 }]);
      expect(result.total).toBe(1);
      expect(result.totalAmount).toBe(20000);
      expect(result.page).toBe(1);
    });

    it('fuerza collectorId cuando se provee (vista de cobrador)', async () => {
      mockFindMany.mockResolvedValue([]);
      mockCount.mockResolvedValue(0);
      mockAggregate.mockResolvedValue({ _sum: { amount: null } });
      mockFindManyUsers.mockResolvedValue([]);

      await findExpenses('org1', { collectorId: 'collector-1' });

      const whereArg = mockFindMany.mock.calls[0][0].where;
      expect(whereArg.collectorId).toBe('collector-1');
    });

    it('totalAmount es 0 cuando no hay gastos', async () => {
      mockFindMany.mockResolvedValue([]);
      mockCount.mockResolvedValue(0);
      mockAggregate.mockResolvedValue({ _sum: { amount: null } });
      mockFindManyUsers.mockResolvedValue([]);

      const result = await findExpenses('org1', {});

      expect(result.totalAmount).toBe(0);
    });
  });

  describe('createExpense', () => {
    it('crea el gasto con el collectorId indicado', async () => {
      mockCreate.mockResolvedValue({ id: 'e1' });

      await createExpense('org1', 'collector-1', {
        category: 'FUEL',
        amount: 30000,
        expenseDate: '2026-01-01',
      });

      expect(mockCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          organizationId: 'org1',
          collectorId: 'collector-1',
          category: 'FUEL',
          amount: 30000,
        }),
      });
    });
  });

  describe('deleteExpense', () => {
    it('lanza 404 cuando el gasto no existe', async () => {
      mockFindFirst.mockResolvedValue(null);

      await expect(
        deleteExpense('no-existe', 'org1', { id: 'u1', role: 'COLLECTOR' }),
      ).rejects.toThrow('Gasto no encontrado');
    });

    it('permite borrar al propio cobrador que lo registró', async () => {
      mockFindFirst.mockResolvedValue({ id: 'e1', collectorId: 'u1' });

      await deleteExpense('e1', 'org1', { id: 'u1', role: 'COLLECTOR' });

      expect(mockDelete).toHaveBeenCalledWith({ where: { id: 'e1' } });
    });

    it('bloquea a un cobrador que intenta borrar el gasto de otro', async () => {
      mockFindFirst.mockResolvedValue({ id: 'e1', collectorId: 'otro-cobrador' });

      await expect(deleteExpense('e1', 'org1', { id: 'u1', role: 'COLLECTOR' })).rejects.toThrow(
        'No tienes permiso para eliminar este gasto',
      );
      expect(mockDelete).not.toHaveBeenCalled();
    });

    it('permite a un ADMIN borrar el gasto de cualquier cobrador', async () => {
      mockFindFirst.mockResolvedValue({ id: 'e1', collectorId: 'otro-cobrador' });

      await deleteExpense('e1', 'org1', { id: 'admin-1', role: 'ADMIN' });

      expect(mockDelete).toHaveBeenCalledWith({ where: { id: 'e1' } });
    });
  });
});
