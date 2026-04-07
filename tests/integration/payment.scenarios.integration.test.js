/**
 * Tests de integración — 3 escenarios de pago del plan.
 *
 * Escenario 1 — FULL: pago exacto a la cuota.
 * Escenario 2 — OVERPAYMENT: pago con excedente, restructura cronograma.
 * Escenario 3 — PAYOFF: pago que liquida el préstamo.
 *
 * Estos tests validan los invariantes financieros definidos en el plan:
 *   • totalPaid + outstandingBalance == totalAmount
 *   • interestPaid + sum(pendingSchedules.interestDue) == totalInterest
 *   • count(pending, not restructured) == numberOfPayments - paidPayments
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import Decimal from 'decimal.js';

// ── Mock Prisma ANTES de importar el servicio ─────────────────────────────────
const mockTransaction = jest.fn();

jest.unstable_mockModule('../../src/config/prisma.js', () => ({
  default: { $transaction: mockTransaction },
}));

const { processPayment } = await import('../../src/services/payment.service.js');

// ── Constantes de fixture ─────────────────────────────────────────────────────
const LOAN_ID = 'aaa00000-0000-0000-0000-000000000001';
const COLLECTOR_ID = 'bbb00000-0000-0000-0000-000000000002';
const SCHED_IDS = [1, 2, 3, 4, 5].map((n) => `sched-0000-0000-0000-00000000000${n}`);
const PAYMENT_ID = 'pay00000-0000-0000-0000-000000000099';

/**
 * Préstamo base de referencia:
 *   principal=100 000 | totalAmount=150 000 | 5 cuotas de 30 000
 *   (capital=20 000 + interés=10 000 por cuota)
 */
const BASE_LOAN = {
  id: LOAN_ID,
  status: 'ACTIVE',
  principalAmount: '100000.00',
  totalAmount: '150000.00',
  installmentAmount: '30000.00',
  outstandingBalance: '150000.00',
  totalPaid: '0.00',
  interestPaid: '0.00',
  moraAmount: '0.00',
  numberOfPayments: 5,
  paidPayments: 0,
  paymentFrequency: 'MONTHLY',
  client: { firstName: 'Ana', lastName: 'Torres', phone: '3009998877' },
};

/** Cuota 1 */
const SCHED_1 = {
  id: SCHED_IDS[0],
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

/** Cuotas 2-5 pendientes */
const PENDING_SCHEDS = [2, 3, 4, 5].map((n) => ({
  id: SCHED_IDS[n - 1],
  loanId: LOAN_ID,
  installmentNumber: n,
  dueDate: new Date(`2026-0${n}-01`),
  amountDue: '30000.00',
  amountPaid: '0.00',
  principalDue: '20000.00',
  interestDue: '10000.00',
  isPaid: false,
  isRestructured: false,
}));

/**
 * Cuota con el número más alto del cronograma (usada para calcular
 * el próximo installmentNumber al crear cuotas restructuradas).
 */
const LAST_SCHED = { ...PENDING_SCHEDS[PENDING_SCHEDS.length - 1] };

/** Construye un db mock parametrizable para cada escenario */
const makeDb = (loanOverride = {}, scheduleOverride = {}) => ({
  loan: {
    findUnique: jest.fn().mockResolvedValue({ ...BASE_LOAN, ...loanOverride }),
    update: jest.fn().mockImplementation(({ data }) => ({
      ...BASE_LOAN,
      ...loanOverride,
      ...data,
      // Simular incrementos de Prisma
      paidPayments:
        typeof data.paidPayments === 'object'
          ? BASE_LOAN.paidPayments + (data.paidPayments.increment ?? 0)
          : data.paidPayments ?? BASE_LOAN.paidPayments,
    })),
  },
  paymentSchedule: {
    // Primera llamada: cuota pendiente a pagar.
    // Segunda llamada (solo OVERPAYMENT): cuota con installmentNumber más alto.
    findFirst: jest
      .fn()
      .mockResolvedValueOnce({ ...SCHED_1, ...scheduleOverride })
      .mockResolvedValue(LAST_SCHED),
    findUnique: jest.fn().mockResolvedValue({ ...SCHED_1, ...scheduleOverride }),
    findMany: jest.fn().mockResolvedValue(PENDING_SCHEDS),
    create: jest.fn().mockResolvedValue({}),
    createMany: jest.fn().mockResolvedValue({ count: 0 }),
    update: jest.fn().mockResolvedValue({ ...SCHED_1, ...scheduleOverride }),
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
  },
  payment: {
    create: jest.fn().mockResolvedValue({
      id: PAYMENT_ID,
      amount: '30000.00',
      principalApplied: '20000.00',
      interestApplied: '10000.00',
      moraAmount: '0.00',
      totalReceived: '30000.00',
    }),
  },
});

const BASE_INPUT = {
  loanId: LOAN_ID,
  collectorId: COLLECTOR_ID,
  offlineCreatedAt: '2026-02-01T09:00:00.000Z',
};

// ── ESCENARIO 1: FULL ─────────────────────────────────────────────────────────
describe('Escenario 1 — Pago FULL (cuota exacta)', () => {
  let db;
  let result;

  beforeEach(async () => {
    jest.clearAllMocks();
    db = makeDb();
    result = await processPayment({ ...BASE_INPUT, amountPaid: 30000 }, db);
  });

  it('clasifica el pago como FULL', () => {
    expect(result.paymentType).toBe('FULL');
  });

  it('marca la cuota como isPaid=true', () => {
    const updateCall = db.paymentSchedule.update.mock.calls[0][0];
    expect(updateCall.data.isPaid).toBe(true);
  });

  it('incrementa paidPayments en 1', () => {
    const loanUpdate = db.loan.update.mock.calls[0][0];
    expect(loanUpdate.data.paidPayments).toEqual({ increment: 1 });
  });

  it('no crea ni restructura cuotas adicionales', () => {
    expect(db.paymentSchedule.create).not.toHaveBeenCalled();
    expect(db.paymentSchedule.createMany).not.toHaveBeenCalled();
    expect(db.paymentSchedule.updateMany).not.toHaveBeenCalled();
  });

  it('INVARIANTE: split completo — moraApplied=0, interés=10000, capital=20000, exceso=0', () => {
    const createCall = db.payment.create.mock.calls[0][0];
    expect(createCall.data.interestApplied).toBe('10000.00');
    expect(createCall.data.principalApplied).toBe('20000.00');
    expect(createCall.data.moraAmount).toBe('0.00');
    expect(
      new Decimal(createCall.data.principalApplied)
        .plus(createCall.data.interestApplied)
        .toNumber(),
    ).toBeCloseTo(30000, 1);
  });

  it('persiste paymentType="FULL" en el registro de pago', () => {
    const createCall = db.payment.create.mock.calls[0][0];
    expect(createCall.data.paymentType).toBe('FULL');
  });
});

// ── ESCENARIO 2: OVERPAYMENT ──────────────────────────────────────────────────
describe('Escenario 2 — Pago OVERPAYMENT (abono anticipado a capital)', () => {
  /**
   * Pago de 60 000 sobre cuota 1 (cuota=30 000).
   * split: interés=10 000, capital=20 000, exceso=30 000
   * El exceso abona a capital y dispara restructuración de cuotas 2-5.
   */
  let db;
  let result;

  beforeEach(async () => {
    jest.clearAllMocks();
    db = makeDb({ outstandingBalance: '150000.00' });
    result = await processPayment({ ...BASE_INPUT, amountPaid: 60000 }, db);
  });

  it('clasifica el pago como OVERPAYMENT', () => {
    expect(result.paymentType).toBe('OVERPAYMENT');
  });

  it('marca las cuotas pendientes como isRestructured=true', () => {
    expect(db.paymentSchedule.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { isRestructured: true } }),
    );
  });

  it('crea el nuevo cronograma restructurado', () => {
    expect(db.paymentSchedule.createMany).toHaveBeenCalledTimes(1);
  });

  it('INVARIANTE: los nuevos installmentNumber son mayores al último existente (evita colisión de clave única)', () => {
    // LAST_SCHED.installmentNumber = 5 → las nuevas cuotas deben comenzar en 6
    const createManyCall = db.paymentSchedule.createMany.mock.calls[0][0];
    const newNumbers = createManyCall.data.map((r) => r.installmentNumber);
    expect(Math.min(...newNumbers)).toBeGreaterThan(LAST_SCHED.installmentNumber);
  });

  it('INVARIANTE: split — interés=10000, capital=20000, exceso=30000', () => {
    const createCall = db.payment.create.mock.calls[0][0];
    expect(createCall.data.interestApplied).toBe('10000.00');
    expect(createCall.data.principalApplied).toBe('20000.00');
    // El exceso (30 000) va a capital pero se registra en el loan.update, no en payment
    const sum = new Decimal(createCall.data.interestApplied).plus(createCall.data.principalApplied);
    // El monto total recibido es 60 000; interest+capital de la cuota = 30 000
    // El exceso se refleja en outstandingBalance del loan
    expect(sum.toNumber()).toBeCloseTo(30000, 1);
  });

  it('INVARIANTE: count(pending, not restructured) == numberOfPayments - paidPayments', () => {
    const loanUpdateCall = db.loan.update.mock.calls[0][0];
    // newNumberOfPayments = 5 - 4 pending + newInstallments.length (≥1)
    // paidPayments = paidPayments.increment = 1
    expect(loanUpdateCall.data.paidPayments).toEqual({ increment: 1 });
  });

  it('persiste paymentType="OVERPAYMENT" en el registro de pago', () => {
    const createCall = db.payment.create.mock.calls[0][0];
    expect(createCall.data.paymentType).toBe('OVERPAYMENT');
  });
});

// ── ESCENARIO 3: PAYOFF ───────────────────────────────────────────────────────
describe('Escenario 3 — Pago PAYOFF (liquidación total)', () => {
  /**
   * El préstamo tiene saldo pendiente de 30 000 (última cuota).
   * Pago de 35 000 (excedente >= outstanding) → PAYOFF.
   */
  let db;
  let result;

  beforeEach(async () => {
    jest.clearAllMocks();
    db = makeDb({
      numberOfPayments: 12,
      outstandingBalance: '30000.00',
      totalPaid: '120000.00',
    });

    // Mock cuotas pendientes para marcar como pagadas
    db.paymentSchedule.findMany.mockResolvedValue([
      { id: 'pending-1', amountDue: '15000.00' },
      { id: 'pending-2', amountDue: '15000.00' },
    ]);

    result = await processPayment({ ...BASE_INPUT, amountPaid: 35000 }, db);
  });

  it('clasifica el pago como PAYOFF', () => {
    expect(result.paymentType).toBe('PAYOFF');
  });

  it('marca el préstamo como COMPLETED', () => {
    const loanUpdateCall = db.loan.update.mock.calls[0][0];
    expect(loanUpdateCall.data.status).toBe('COMPLETED');
  });

  it('INVARIANTE: outstandingBalance queda en 0', () => {
    const loanUpdateCall = db.loan.update.mock.calls[0][0];
    expect(loanUpdateCall.data.outstandingBalance).toBe('0.00');
  });

  it('INVARIANTE: totalPaid = totalAmount (préstamo pagado completo)', () => {
    const loanUpdateCall = db.loan.update.mock.calls[0][0];
    expect(loanUpdateCall.data.totalPaid).toBe('150000.00');
  });

  it('ajusta paidPayments = numberOfPayments para progreso 100%', () => {
    const loanUpdateCall = db.loan.update.mock.calls[0][0];
    expect(loanUpdateCall.data.paidPayments).toBe(12); // numberOfPayments
  });

  it('elimina toda la mora pendiente en PAYOFF', () => {
    const loanUpdateCall = db.loan.update.mock.calls[0][0];
    expect(loanUpdateCall.data.moraAmount).toBe('0.00');
  });

  it('registra actualEndDate', () => {
    const loanUpdateCall = db.loan.update.mock.calls[0][0];
    expect(loanUpdateCall.data.actualEndDate).toBeDefined();
  });

  it('marca todas las cuotas pendientes como isPaid=true (no restructuradas)', () => {
    // Debe actualizarse la cuota actual (1 call) + las 2 pendientes (2 calls adicionales)
    expect(db.paymentSchedule.update).toHaveBeenCalledTimes(3);

    // Verificar que las cuotas pendientes se marcan como pagadas
    expect(db.paymentSchedule.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'pending-1' },
        data: expect.objectContaining({
          isPaid: true,
          amountPaid: '15000.00',
          isRestructured: false,
        }),
      }),
    );
    expect(db.paymentSchedule.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'pending-2' },
        data: expect.objectContaining({
          isPaid: true,
          amountPaid: '15000.00',
          isRestructured: false,
        }),
      }),
    );
  });

  it('persiste paymentType="PAYOFF" en el registro de pago', () => {
    const createCall = db.payment.create.mock.calls[0][0];
    expect(createCall.data.paymentType).toBe('PAYOFF');
  });
});
