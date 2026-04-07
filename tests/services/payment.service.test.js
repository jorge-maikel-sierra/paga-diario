import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// ── Mocks ─────────────────────────────────────────────────────────────────────
const mockTransaction = jest.fn();

jest.unstable_mockModule('../../src/config/prisma.js', () => ({
  default: { $transaction: mockTransaction },
}));

const { processPayment, registerPayment, batchSync, registerAdminPayment } = await import(
  '../../src/services/payment.service.js'
);

// ── Fixtures ──────────────────────────────────────────────────────────────────
const LOAN_ID = '550e8400-e29b-41d4-a716-446655440000';
const COLLECTOR_ID = '660e8400-e29b-41d4-a716-446655440000';
const SCHEDULE_ID = '770e8400-e29b-41d4-a716-446655440000';
const PAYMENT_ID = '880e8400-e29b-41d4-a716-446655440000';

/**
 * Préstamo base: 5 cuotas de 30 000 c/u (20 000 capital + 10 000 interés).
 * totalAmount = 150 000, principalAmount = 100 000
 */
const baseLoan = {
  id: LOAN_ID,
  status: 'ACTIVE',
  totalPaid: '0.00',
  totalAmount: '150000.00',
  principalAmount: '100000.00',
  outstandingBalance: '150000.00',
  paidPayments: 0,
  numberOfPayments: 5,
  installmentAmount: '30000.00',
  moraAmount: '0.00',
  interestPaid: '0.00',
  paymentFrequency: 'MONTHLY',
  client: { firstName: 'Juan', lastName: 'Pérez', phone: '3001234567' },
};

/** Cuota base: 30 000 total = 20 000 capital + 10 000 interés */
const baseSchedule = {
  id: SCHEDULE_ID,
  loanId: LOAN_ID,
  installmentNumber: 1,
  dueDate: new Date('2026-02-01'),
  amountDue: '30000.00',
  amountPaid: '0.00',
  principalDue: '20000.00',
  interestDue: '10000.00',
  isPaid: false,
  isRestructured: false,
};

/** Construye un tx mock con todos los métodos requeridos por processPayment */
const makeDb = (overrides = {}) => ({
  loan: {
    findUnique: jest.fn().mockResolvedValue(baseLoan),
    update: jest.fn().mockResolvedValue(baseLoan),
    ...overrides.loan,
  },
  paymentSchedule: {
    findFirst: jest.fn().mockResolvedValue(baseSchedule),
    findUnique: jest.fn().mockResolvedValue(baseSchedule),
    findMany: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockResolvedValue({}),
    createMany: jest.fn().mockResolvedValue({ count: 0 }),
    update: jest.fn().mockResolvedValue(baseSchedule),
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    ...overrides.paymentSchedule,
  },
  payment: {
    create: jest.fn().mockResolvedValue({ id: PAYMENT_ID, amount: '30000.00' }),
    ...overrides.payment,
  },
});

const baseInput = {
  loanId: LOAN_ID,
  amountPaid: 30000,
  offlineCreatedAt: '2026-02-22T14:30:00.000Z',
  collectorId: COLLECTOR_ID,
};

// ── processPayment ─────────────────────────────────────────────────────────────
describe('processPayment', () => {
  let db;

  beforeEach(() => {
    jest.clearAllMocks();
    db = makeDb();
  });

  // ── Validaciones ─────────────────────────────────────────────────────────────
  it('lanza 404 si el préstamo no existe', async () => {
    db.loan.findUnique.mockResolvedValue(null);
    await expect(processPayment(baseInput, db)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('lanza 409 si el préstamo no está activo', async () => {
    db.loan.findUnique.mockResolvedValue({ ...baseLoan, status: 'COMPLETED' });
    await expect(processPayment(baseInput, db)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('lanza 404 si paymentScheduleId no existe', async () => {
    db.paymentSchedule.findUnique.mockResolvedValue(null);
    await expect(
      processPayment({ ...baseInput, paymentScheduleId: SCHEDULE_ID }, db),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('lanza 404 si paymentScheduleId pertenece a otro préstamo', async () => {
    db.paymentSchedule.findUnique.mockResolvedValue({ ...baseSchedule, loanId: 'otro-id' });
    await expect(
      processPayment({ ...baseInput, paymentScheduleId: SCHEDULE_ID }, db),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  // ── FULL: pago exacto ────────────────────────────────────────────────────────
  it('FULL — cuota exacta: marca isPaid y actualiza outstandingBalance', async () => {
    db.loan.update.mockResolvedValue({
      ...baseLoan,
      outstandingBalance: '120000.00',
      paidPayments: 1,
    });

    const result = await processPayment(baseInput, db);

    expect(result.paymentType).toBe('FULL');
    const schedUpdate = db.paymentSchedule.update.mock.calls[0][0];
    expect(schedUpdate.data.isPaid).toBe(true);
    const loanUpdate = db.loan.update.mock.calls[0][0];
    expect(loanUpdate.data.paidPayments).toEqual({ increment: 1 });
  });

  // ── PARTIAL_INTEREST ─────────────────────────────────────────────────────────
  it('PARTIAL_INTEREST — cuota sigue pendiente (isPaid=false)', async () => {
    db.loan.update.mockResolvedValue(baseLoan);

    const result = await processPayment({ ...baseInput, amountPaid: 5000 }, db);

    expect(result.paymentType).toBe('PARTIAL_INTEREST');
    // PARTIAL_INTEREST solo acumula amountPaid; no toca isPaid
    expect(db.paymentSchedule.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.not.objectContaining({ isPaid: true }) }),
    );
  });

  // ── INTEREST_ONLY ─────────────────────────────────────────────────────────────
  it('INTEREST_ONLY — extiende cronograma con nueva cuota', async () => {
    // primera llamada: cuota pendiente; segunda: última cuota del préstamo
    db.paymentSchedule.findFirst
      .mockResolvedValueOnce(baseSchedule)
      .mockResolvedValueOnce({ ...baseSchedule, installmentNumber: 5 });
    db.loan.update.mockResolvedValue({ ...baseLoan, numberOfPayments: 6, paidPayments: 1 });

    const result = await processPayment({ ...baseInput, amountPaid: 10000 }, db);

    expect(result.paymentType).toBe('INTEREST_ONLY');
    expect(db.paymentSchedule.create).toHaveBeenCalledTimes(1);
    const newSched = db.paymentSchedule.create.mock.calls[0][0].data;
    expect(newSched.installmentNumber).toBe(6);
    const loanUpdate = db.loan.update.mock.calls[0][0];
    expect(loanUpdate.data.numberOfPayments).toEqual({ increment: 1 });
  });

  // ── OVERPAYMENT ───────────────────────────────────────────────────────────────
  it('OVERPAYMENT — restructura cuotas pendientes', async () => {
    const pending = [2, 3, 4, 5].map((n) => ({
      ...baseSchedule,
      id: `sched-${n}`,
      installmentNumber: n,
      dueDate: new Date(`2026-0${n}-01`),
    }));
    db.paymentSchedule.findMany.mockResolvedValue(pending);
    db.loan.update.mockResolvedValue({ ...baseLoan, outstandingBalance: '90000.00' });

    const result = await processPayment({ ...baseInput, amountPaid: 60000 }, db);

    expect(result.paymentType).toBe('OVERPAYMENT');
    expect(db.paymentSchedule.updateMany).toHaveBeenCalledTimes(1);
    expect(db.paymentSchedule.updateMany.mock.calls[0][0].data.isRestructured).toBe(true);
    expect(db.paymentSchedule.createMany).toHaveBeenCalledTimes(1);
  });

  // ── PAYOFF ────────────────────────────────────────────────────────────────────
  it('PAYOFF — préstamo queda COMPLETED, balance en 0 y todas las cuotas pagadas', async () => {
    db.loan.findUnique.mockResolvedValue({
      ...baseLoan,
      numberOfPayments: 12,
      outstandingBalance: '30000.00',
      totalPaid: '120000.00',
    });
    db.loan.update.mockResolvedValue({
      ...baseLoan,
      outstandingBalance: '0.00',
      status: 'COMPLETED',
      paidPayments: 12,
    });

    // Mock para cuotas pendientes que se marcarán como pagadas
    db.paymentSchedule.findMany.mockResolvedValue([
      { id: 'pending-1', amountDue: '5000.00' },
      { id: 'pending-2', amountDue: '5000.00' },
    ]);

    const result = await processPayment(baseInput, db);

    expect(result.paymentType).toBe('PAYOFF');

    // Verificar que el préstamo se marca como COMPLETED con paidPayments = numberOfPayments
    const loanUpdate = db.loan.update.mock.calls[0][0];
    expect(loanUpdate.data.status).toBe('COMPLETED');
    expect(loanUpdate.data.outstandingBalance).toBe('0.00');
    expect(loanUpdate.data.paidPayments).toBe(12); // numberOfPayments (progreso 100%)
    expect(loanUpdate.data.moraAmount).toBe('0.00'); // Mora eliminada en PAYOFF

    // Verificar que se marcaron todas las cuotas pendientes como pagadas (no restructuradas)
    expect(db.paymentSchedule.update).toHaveBeenCalledTimes(3); // cuota actual + 2 pendientes
    expect(db.paymentSchedule.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'pending-1' },
        data: expect.objectContaining({
          isPaid: true,
          amountPaid: '5000.00',
          isRestructured: false,
        }),
      }),
    );
  });

  it('PAYOFF — paymentType persiste como PAYOFF en el registro de pago creado', async () => {
    db.loan.findUnique.mockResolvedValue({
      ...baseLoan,
      outstandingBalance: '30000.00',
      totalPaid: '120000.00',
    });
    db.loan.update.mockResolvedValue({
      ...baseLoan,
      outstandingBalance: '0.00',
      status: 'COMPLETED',
      paidPayments: baseLoan.numberOfPayments,
    });
    db.paymentSchedule.findMany.mockResolvedValue([]);

    await processPayment(baseInput, db);

    const createCall = db.payment.create.mock.calls[0][0];
    expect(createCall.data.paymentType).toBe('PAYOFF');
  });

  it('PAYOFF con mora — mora cubre parte del saldo y se clasifica PAYOFF correctamente', async () => {
    // outstandingBalance=30000, mora=10000 — el cliente paga exactamente 30000
    db.loan.findUnique.mockResolvedValue({
      ...baseLoan,
      outstandingBalance: '30000.00',
      moraAmount: '10000.00',
      totalAmount: '30000.00',
      totalPaid: '0.00',
    });
    db.loan.update.mockResolvedValue({
      ...baseLoan,
      outstandingBalance: '0.00',
      status: 'COMPLETED',
      paidPayments: baseLoan.numberOfPayments,
    });
    db.paymentSchedule.findMany.mockResolvedValue([]);

    const result = await processPayment({ ...baseInput, amountPaid: 30000 }, db);

    expect(result.paymentType).toBe('PAYOFF');
    const loanUpdate = db.loan.update.mock.calls[0][0];
    expect(loanUpdate.data.status).toBe('COMPLETED');
    expect(loanUpdate.data.outstandingBalance).toBe('0.00');
  });

  it('PAYOFF — no actualiza dos veces la cuota actual (id excluido del findMany)', async () => {
    db.loan.findUnique.mockResolvedValue({
      ...baseLoan,
      outstandingBalance: '30000.00',
      totalPaid: '120000.00',
    });
    db.loan.update.mockResolvedValue({
      ...baseLoan,
      outstandingBalance: '0.00',
      status: 'COMPLETED',
      paidPayments: baseLoan.numberOfPayments,
    });
    // findMany retorna vacío: la cuota actual ya fue excluida con id: { not: schedule.id }
    db.paymentSchedule.findMany.mockResolvedValue([]);

    await processPayment(baseInput, db);

    // Solo 1 update: la cuota actual; el findMany no devolvió duplicados
    expect(db.paymentSchedule.update).toHaveBeenCalledTimes(1);

    // Verificar que el WHERE del findMany excluye la cuota actual
    const findManyCall = db.paymentSchedule.findMany.mock.calls[0][0];
    expect(findManyCall.where).toMatchObject({
      loanId: LOAN_ID,
      isPaid: false,
      id: { not: SCHEDULE_ID },
    });
  });

  // ── Opcionales ────────────────────────────────────────────────────────────────
  it('incluye coordenadas GPS en el pago creado', async () => {
    db.loan.update.mockResolvedValue(baseLoan);
    await processPayment({ ...baseInput, latitude: 4.609, longitude: -74.081 }, db);
    const createCall = db.payment.create.mock.calls[0][0];
    expect(createCall.data.latitude).toBe(4.609);
    expect(createCall.data.longitude).toBe(-74.081);
  });

  it('usa paymentScheduleId explícito cuando se provee', async () => {
    db.loan.update.mockResolvedValue(baseLoan);
    await processPayment({ ...baseInput, paymentScheduleId: SCHEDULE_ID }, db);
    expect(db.paymentSchedule.findUnique).toHaveBeenCalledWith({ where: { id: SCHEDULE_ID } });
    expect(db.paymentSchedule.findFirst).not.toHaveBeenCalled();
  });

  it('retorna clientName compuesto desde loan.client', async () => {
    db.loan.update.mockResolvedValue(baseLoan);
    const result = await processPayment(baseInput, db);
    expect(result.clientName).toBe('Juan Pérez');
  });
});

// ── registerPayment ───────────────────────────────────────────────────────────
describe('registerPayment', () => {
  beforeEach(() => jest.clearAllMocks());

  it('ejecuta processPayment dentro de una transacción', async () => {
    const db = makeDb();
    db.loan.update.mockResolvedValue(baseLoan);
    mockTransaction.mockImplementation((fn) => fn(db));

    const result = await registerPayment(baseInput);

    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(result.payment.id).toBe(PAYMENT_ID);
  });

  it('propaga errores de la transacción', async () => {
    mockTransaction.mockRejectedValue(new Error('DB Error'));
    await expect(registerPayment(baseInput)).rejects.toThrow('DB Error');
  });
});

// ── batchSync ──────────────────────────────────────────────────────────────────
describe('batchSync', () => {
  beforeEach(() => jest.clearAllMocks());

  it('procesa múltiples pagos y retorna estado por cada uno', async () => {
    let callCount = 0;
    mockTransaction.mockImplementation(async (fn) => {
      callCount += 1;
      if (callCount === 2) {
        const err = new Error('El préstamo no está activo');
        err.statusCode = 409;
        throw err;
      }
      const db = makeDb();
      db.loan.update.mockResolvedValue(baseLoan);
      return fn(db);
    });

    const items = [1, 2, 3].map((n) => ({
      localId: `local-${n}`,
      loanId: LOAN_ID,
      amountPaid: 30000,
      offlineCreatedAt: `2026-02-22T14:3${n}:00.000Z`,
    }));

    const results = await batchSync(items, COLLECTOR_ID);

    expect(results).toHaveLength(3);
    expect(results[0].status).toBe('synced');
    expect(results[1].status).toBe('conflict');
    expect(results[2].status).toBe('synced');
  });

  it('retorna conflict para errores P2002 (duplicado)', async () => {
    const err = Object.assign(new Error('Unique constraint'), { code: 'P2002' });
    mockTransaction.mockRejectedValue(err);

    const results = await batchSync(
      [
        {
          localId: 'local-1',
          loanId: LOAN_ID,
          amountPaid: 30000,
          offlineCreatedAt: '2026-02-22T14:30:00.000Z',
        },
      ],
      COLLECTOR_ID,
    );

    expect(results[0].status).toBe('conflict');
  });

  it('retorna error para errores genéricos', async () => {
    mockTransaction.mockRejectedValue(new Error('DB connection lost'));

    const results = await batchSync(
      [
        {
          localId: 'local-1',
          loanId: LOAN_ID,
          amountPaid: 30000,
          offlineCreatedAt: '2026-02-22T14:30:00.000Z',
        },
      ],
      COLLECTOR_ID,
    );

    expect(results[0].status).toBe('error');
    expect(results[0].message).toBe('DB connection lost');
  });

  it('retorna array vacío si se pasa array vacío', async () => {
    expect(await batchSync([], COLLECTOR_ID)).toEqual([]);
  });
});

// ── registerAdminPayment ───────────────────────────────────────────────────────
describe('registerAdminPayment', () => {
  const adminInput = {
    loanId: LOAN_ID,
    amountPaid: '30000',
    paymentDate: '2026-05-01',
    collectorId: COLLECTOR_ID,
    paymentMethod: 'CASH',
    notes: 'Pago en efectivo',
  };

  beforeEach(() => jest.clearAllMocks());

  it('delega a processPayment mediante $transaction', async () => {
    const db = makeDb();
    db.loan.update.mockResolvedValue(baseLoan);
    mockTransaction.mockImplementation((fn) => fn(db));

    const result = await registerAdminPayment(adminInput);

    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(result.payment.id).toBe(PAYMENT_ID);
  });

  it('lanza 404 cuando el préstamo no existe', async () => {
    const db = makeDb({
      loan: { findUnique: jest.fn().mockResolvedValue(null), update: jest.fn() },
    });
    mockTransaction.mockImplementation((fn) => fn(db));

    await expect(registerAdminPayment(adminInput)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('lanza 409 cuando el préstamo no está activo', async () => {
    const db = makeDb({
      loan: {
        findUnique: jest.fn().mockResolvedValue({ ...baseLoan, status: 'COMPLETED' }),
        update: jest.fn(),
      },
    });
    mockTransaction.mockImplementation((fn) => fn(db));

    await expect(registerAdminPayment(adminInput)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('convierte paymentDate YYYY-MM-DD a fecha correcta', async () => {
    const db = makeDb();
    db.loan.update.mockResolvedValue(baseLoan);
    mockTransaction.mockImplementation((fn) => fn(db));

    await registerAdminPayment(adminInput);

    const createCall = db.payment.create.mock.calls[0][0];
    const collectedAt = new Date(createCall.data.collectedAt);
    expect(collectedAt.getFullYear()).toBe(2026);
    expect(collectedAt.getMonth()).toBe(4); // mayo = índice 4
  });

  it('acepta paymentDate en formato ISO string', async () => {
    const db = makeDb();
    db.loan.update.mockResolvedValue(baseLoan);
    mockTransaction.mockImplementation((fn) => fn(db));

    await registerAdminPayment({ ...adminInput, paymentDate: '2026-05-01T10:00:00Z' });

    expect(db.payment.create).toHaveBeenCalledTimes(1);
  });

  it('usa fecha actual cuando paymentDate es null', async () => {
    const db = makeDb();
    db.loan.update.mockResolvedValue(baseLoan);
    mockTransaction.mockImplementation((fn) => fn(db));

    await registerAdminPayment({ ...adminInput, paymentDate: null });

    expect(db.payment.create).toHaveBeenCalledTimes(1);
  });

  it('pasa paymentMethod al payment.create', async () => {
    const db = makeDb();
    db.loan.update.mockResolvedValue(baseLoan);
    mockTransaction.mockImplementation((fn) => fn(db));

    await registerAdminPayment({ ...adminInput, paymentMethod: 'TRANSFER' });

    const createCall = db.payment.create.mock.calls[0][0];
    expect(createCall.data.paymentMethod).toBe('TRANSFER');
  });
});
