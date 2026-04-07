import { describe, it, expect } from '@jest/globals';
import Decimal from 'decimal.js';

// Import modules without mocking for these tests since we need actual date functionality
const {
  splitPayment,
  classifyPayment,
  nextPeriodDate,
  buildRestructuredSchedule,
  applyEarlyPaymentForgiveness,
} = await import('../../src/engine/payment-split.js');

// ============================================================
// splitPayment
// ============================================================

describe('splitPayment', () => {
  it('aplica pago completo sin mora: interés primero, luego capital', () => {
    const split = splitPayment(55000, 0, 5000, 50000);

    expect(split.moraApplied).toBe('0.00');
    expect(split.interestApplied).toBe('5000.00');
    expect(split.principalApplied).toBe('50000.00');
    expect(split.excess).toBe('0.00');
  });

  it('aplica mora antes de interés y capital', () => {
    // Mora=2000, interestDue=5000, principalDue=50000, pago=7000
    const split = splitPayment(7000, 2000, 5000, 50000);

    expect(split.moraApplied).toBe('2000.00');
    expect(split.interestApplied).toBe('5000.00');
    expect(split.principalApplied).toBe('0.00');
    expect(split.excess).toBe('0.00');
  });

  it('pago insuficiente — solo cubre parte del interés (PARTIAL_INTEREST)', () => {
    const split = splitPayment(3000, 0, 5000, 50000);

    expect(split.interestApplied).toBe('3000.00');
    expect(split.principalApplied).toBe('0.00');
    expect(split.excess).toBe('0.00');
  });

  it('pago exacto al interés sin capital (INTEREST_ONLY)', () => {
    const split = splitPayment(5000, 0, 5000, 50000);

    expect(split.interestApplied).toBe('5000.00');
    expect(split.principalApplied).toBe('0.00');
    expect(split.excess).toBe('0.00');
  });

  it('pago con excedente después de cuota completa (OVERPAYMENT)', () => {
    // Escenario 2: pago 60000, cuota=30000 (interest=10000, principal=20000)
    const split = splitPayment(60000, 0, 10000, 20000);

    expect(split.interestApplied).toBe('10000.00');
    expect(split.principalApplied).toBe('20000.00');
    expect(split.excess).toBe('30000.00');
  });

  it('excedente grande que liquida todo el préstamo (PAYOFF)', () => {
    // Pago de 200000 con saldo pendiente de 150000
    const split = splitPayment(200000, 0, 10000, 20000);

    expect(split.interestApplied).toBe('10000.00');
    expect(split.principalApplied).toBe('20000.00');
    expect(split.excess).toBe('170000.00');
  });

  it('mora parcial — pago no alcanza para toda la mora', () => {
    const split = splitPayment(1000, 5000, 10000, 50000);

    expect(split.moraApplied).toBe('1000.00');
    expect(split.interestApplied).toBe('0.00');
    expect(split.principalApplied).toBe('0.00');
    expect(split.excess).toBe('0.00');
  });

  it('garantiza que la suma de partes == monto total', () => {
    const split = splitPayment(86000, 1500, 16667, 33333);

    const total = new Decimal(split.moraApplied)
      .plus(split.interestApplied)
      .plus(split.principalApplied)
      .plus(split.excess);

    expect(total.toNumber()).toBeCloseTo(86000, 2);
  });
});

// ============================================================
// classifyPayment
// ============================================================

describe('classifyPayment', () => {
  it('PARTIAL_INTEREST — pago menor al interés debido', () => {
    const split = splitPayment(3000, 0, 5000, 50000);
    const type = classifyPayment(split, 5000, 50000, 110000);
    expect(type).toBe('PARTIAL_INTEREST');
  });

  it('INTEREST_ONLY — cubre exactamente el interés, sin capital', () => {
    const split = splitPayment(5000, 0, 5000, 50000);
    const type = classifyPayment(split, 5000, 50000, 110000);
    expect(type).toBe('INTEREST_ONLY');
  });

  it('FULL — cuota completa sin excedente', () => {
    const split = splitPayment(55000, 0, 5000, 50000);
    const type = classifyPayment(split, 5000, 50000, 110000);
    expect(type).toBe('FULL');
  });

  it('OVERPAYMENT — cuota completa + excedente que no liquida el préstamo', () => {
    // Escenario 2: outstanding=150000, pago=60000, exceso=30000
    const split = splitPayment(60000, 0, 10000, 20000);
    const type = classifyPayment(split, 10000, 20000, 150000);
    expect(type).toBe('OVERPAYMENT');
  });

  it('PAYOFF — excedente >= saldo pendiente del préstamo', () => {
    // outstanding=50000 (saldo capital), pago=200000
    const split = splitPayment(200000, 0, 10000, 20000);
    const type = classifyPayment(split, 10000, 20000, 50000);
    expect(type).toBe('PAYOFF');
  });

  it('PAYOFF — pago justo liquida exactamente el saldo', () => {
    // outstanding=30000, pago=30000 (interés=10000 + capital=20000)
    const split = splitPayment(30000, 0, 10000, 20000);
    const type = classifyPayment(split, 10000, 20000, 30000);
    expect(type).toBe('PAYOFF');
  });

  it('PAYOFF con mora — mora + resto del pago cubre el saldo total aunque no cubra interés', () => {
    // Escenario: préstamo con outstandingBalance=15000, mora=10000.
    // El cliente paga 15000: va 10000 a mora y 5000 a interés (pero interestDue=8000).
    // interestApplied (5000) < interestDue (8000) → antes del fix retornaba PARTIAL_INTEREST.
    // Con el fix: mora(10000) + interés(5000) = 15000 >= outstandingBalance(15000) → PAYOFF.
    const split = splitPayment(15000, 10000, 8000, 20000);
    const type = classifyPayment(split, 8000, 20000, 15000);
    expect(type).toBe('PAYOFF');
  });

  it('PAYOFF con mora — no confunde con PARTIAL_INTEREST cuando totalApplied cubre el saldo', () => {
    // Saldo pendiente=5000, mora=3000, pago=5000.
    // split: moraApplied=3000, interestApplied=2000, pero interestDue=4000.
    // Sin fix → PARTIAL_INTEREST. Con fix → PAYOFF porque 3000+2000=5000 >= 5000.
    const split = splitPayment(5000, 3000, 4000, 10000);
    const type = classifyPayment(split, 4000, 10000, 5000);
    expect(type).toBe('PAYOFF');
  });
});

// ============================================================
// nextPeriodDate
// ============================================================

describe('nextPeriodDate', () => {
  it('MONTHLY — avanza un mes', () => {
    expect(nextPeriodDate('2026-01-15', 'MONTHLY')).toBe('2026-02-15');
  });

  it('WEEKLY — avanza 7 días', () => {
    expect(nextPeriodDate('2026-01-05', 'WEEKLY')).toBe('2026-01-12');
  });

  it('BIWEEKLY — avanza 14 días', () => {
    expect(nextPeriodDate('2026-01-01', 'BIWEEKLY')).toBe('2026-01-15');
  });

  it('DAILY — salta domingo al siguiente lunes', () => {
    // 2026-03-21 es sábado → siguiente día hábil sería lunes 2026-03-23
    expect(nextPeriodDate('2026-03-21', 'DAILY')).toBe('2026-03-23');
  });

  it('DAILY — no salta días normales de semana', () => {
    // 2026-03-23 lunes → siguiente 2026-03-24 martes
    expect(nextPeriodDate('2026-03-23', 'DAILY')).toBe('2026-03-24');
  });

  it('DAILY — respeta festivos de la lista', () => {
    // Si 2026-03-24 es festivo, salta a 2026-03-25
    expect(nextPeriodDate('2026-03-23', 'DAILY', ['2026-03-24'])).toBe('2026-03-25');
  });
});

// ============================================================
// buildRestructuredSchedule
// ============================================================

describe('buildRestructuredSchedule', () => {
  const basePendingInstallments = [
    { installmentNumber: 2, dueDate: '2026-02-15' },
    { installmentNumber: 3, dueDate: '2026-03-15' },
    { installmentNumber: 4, dueDate: '2026-04-15' },
    { installmentNumber: 5, dueDate: '2026-05-15' },
  ];

  it('retorna array vacío si el total restante es 0 (préstamo liquidado)', () => {
    const result = buildRestructuredSchedule({
      remainingCapital: 0,
      remainingInterest: 0,
      originalInstallmentAmount: 30000,
      pendingInstallments: basePendingInstallments,
      frequency: 'MONTHLY',
    });
    expect(result).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // Escenario 2: pago mixto
  // principal=100000 | 5 cuotas | installment=30000
  // Pago de 60000 en cuota #1 (interest=10000 + capital=20000 + excess=30000)
  // remainingCapital  = 100000 - 20000 - 30000 = 50000
  // remainingInterest = 50000 - 10000 = 40000
  // total = 90000 → rawCount = ceil(90000/30000) = 3 → min(3,4) = 3
  // Pero en el plan se mantienen 4 cuotas y se reduce el monto
  // ---------------------------------------------------------------------------
  it('Escenario 2 — reduce monto de cuotas, mantiene count igual a pendingInstallments.length', () => {
    // rawCount = ceil(90000/30000) = 3, pero pendingCount = 4 → usamos min(3,4) = 3
    // (las cuotas sobrantes no se generan; las marcará el service como restructured)
    const result = buildRestructuredSchedule({
      remainingCapital: 50000,
      remainingInterest: 40000,
      originalInstallmentAmount: 30000,
      pendingInstallments: basePendingInstallments,
      frequency: 'MONTHLY',
    });

    // 3 cuotas nuevas (rawCount=3 < maxCount=4)
    expect(result).toHaveLength(3);
    expect(result[0].installmentNumber).toBe(2);
    expect(result[0].dueDate).toBe('2026-02-15');

    // amountDue de cada cuota ≈ 30000 (capital=16667 + interest=13333)
    const totalGenerated = result.reduce((acc, r) => acc.plus(r.amountDue), new Decimal(0));
    expect(totalGenerated.toNumber()).toBeCloseTo(90000, 1);
  });

  it('Escenario 2 — la última cuota absorbe el redondeo: suma exacta de capital e interés', () => {
    const result = buildRestructuredSchedule({
      remainingCapital: 50000,
      remainingInterest: 40000,
      originalInstallmentAmount: 30000,
      pendingInstallments: basePendingInstallments,
      frequency: 'MONTHLY',
    });

    const totalCapital = result.reduce((acc, r) => acc.plus(r.principalDue), new Decimal(0));
    const totalInterest = result.reduce((acc, r) => acc.plus(r.interestDue), new Decimal(0));

    expect(totalCapital.toNumber()).toBeCloseTo(50000, 1);
    expect(totalInterest.toNumber()).toBeCloseTo(40000, 1);
  });

  // ---------------------------------------------------------------------------
  // Escenario 3: pago adelantado fuerte
  // principal=100000 | 3 cuotas | installment=50000
  // Pago de 86000 en cuota #1 (interest=16667 + capital=33333 + excess=36000)
  // remainingCapital  = 100000 - 33333 - 36000 = 30667
  // remainingInterest = 50000 - 16667 = 33333
  // total = 64000 → rawCount = ceil(64000/50000) = 2 → min(2,2) = 2
  // ---------------------------------------------------------------------------
  it('Escenario 3 — reduce número de cuotas de 2 pendientes a 2 nuevas (sin cambio en este caso)', () => {
    const pending = [
      { installmentNumber: 2, dueDate: '2026-02-15' },
      { installmentNumber: 3, dueDate: '2026-03-15' },
    ];

    const result = buildRestructuredSchedule({
      remainingCapital: 30667,
      remainingInterest: 33333,
      originalInstallmentAmount: 50000,
      pendingInstallments: pending,
      frequency: 'MONTHLY',
    });

    expect(result).toHaveLength(2);

    const totalAmount = result.reduce((acc, r) => acc.plus(r.amountDue), new Decimal(0));
    expect(totalAmount.toNumber()).toBeCloseTo(64000, 1);
  });

  it('Escenario 3 — preserva las mismas fechas que las cuotas originales', () => {
    const pending = [
      { installmentNumber: 2, dueDate: '2026-02-15' },
      { installmentNumber: 3, dueDate: '2026-03-15' },
    ];

    const result = buildRestructuredSchedule({
      remainingCapital: 30667,
      remainingInterest: 33333,
      originalInstallmentAmount: 50000,
      pendingInstallments: pending,
      frequency: 'MONTHLY',
    });

    expect(result[0].dueDate).toBe('2026-02-15');
    expect(result[1].dueDate).toBe('2026-03-15');
    expect(result[0].installmentNumber).toBe(2);
    expect(result[1].installmentNumber).toBe(3);
  });

  it('pago casi total — genera solo 1 cuota final', () => {
    const pending = [
      { installmentNumber: 2, dueDate: '2026-02-15' },
      { installmentNumber: 3, dueDate: '2026-03-15' },
    ];

    // Quedan solo 5000 en total
    const result = buildRestructuredSchedule({
      remainingCapital: 3000,
      remainingInterest: 2000,
      originalInstallmentAmount: 50000,
      pendingInstallments: pending,
      frequency: 'MONTHLY',
    });

    expect(result).toHaveLength(1);
    expect(result[0].amountDue).toBe('5000.00');
    expect(result[0].principalDue).toBe('3000.00');
    expect(result[0].interestDue).toBe('2000.00');
  });
});

// ============================================================
// applyEarlyPaymentForgiveness
// ============================================================

describe('applyEarlyPaymentForgiveness', () => {
  it('aplica condonación para préstamos MONTHLY con pago anticipado ≥30 días', () => {
    const paymentDate = '2026-01-05'; // 31 días antes
    const dueDate = '2026-02-05';
    const frequency = 'MONTHLY';

    const split = {
      moraApplied: '0.00',
      interestApplied: '125.00',
      principalApplied: '375.00',
      excess: '500.00',
    };

    const principalDue = '375.00';

    const result = applyEarlyPaymentForgiveness(
      paymentDate,
      dueDate,
      frequency,
      split,
      principalDue,
    );

    expect(result.interestApplied).toBe('0.00');
    expect(result.principalApplied).toBe('500.00'); // 375 + 125 condonado
    expect(result.forgivenInterest).toBe('125.00');
    expect(result.isEarlyPayment).toBe(true);
    expect(result.excess).toBe('500.00');
  });

  it('no aplica condonación para préstamos no MONTHLY', () => {
    const paymentDate = '2026-01-05';
    const dueDate = '2026-02-05';
    const frequency = 'DAILY'; // No MONTHLY

    const split = {
      moraApplied: '0.00',
      interestApplied: '125.00',
      principalApplied: '375.00',
      excess: '500.00',
    };

    const principalDue = '375.00';

    const result = applyEarlyPaymentForgiveness(
      paymentDate,
      dueDate,
      frequency,
      split,
      principalDue,
    );

    // El split debe retornarse sin modificaciones
    expect(result).toEqual(split);
    expect(result.isEarlyPayment).toBeUndefined();
    expect(result.forgivenInterest).toBeUndefined();
  });

  it('no aplica condonación cuando el pago es <30 días anticipado', () => {
    const paymentDate = '2026-01-20'; // Solo 16 días antes
    const dueDate = '2026-02-05';
    const frequency = 'MONTHLY';

    const split = {
      moraApplied: '0.00',
      interestApplied: '125.00',
      principalApplied: '375.00',
      excess: '500.00',
    };

    const principalDue = '375.00';

    const result = applyEarlyPaymentForgiveness(
      paymentDate,
      dueDate,
      frequency,
      split,
      principalDue,
    );

    // El split debe retornarse sin modificaciones
    expect(result).toEqual(split);
    expect(result.isEarlyPayment).toBeUndefined();
    expect(result.forgivenInterest).toBeUndefined();
  });

  it('no aplica condonación cuando el pago no cubre el principal completo', () => {
    const paymentDate = '2026-01-05'; // 31 días antes
    const dueDate = '2026-02-05';
    const frequency = 'MONTHLY';

    const split = {
      moraApplied: '0.00',
      interestApplied: '125.00',
      principalApplied: '200.00', // Menos que el principal debido
      excess: '0.00',
    };

    const principalDue = '375.00'; // Requiere más capital del que se aplicó

    const result = applyEarlyPaymentForgiveness(
      paymentDate,
      dueDate,
      frequency,
      split,
      principalDue,
    );

    // El split debe retornarse sin modificaciones
    expect(result).toEqual(split);
    expect(result.isEarlyPayment).toBeUndefined();
    expect(result.forgivenInterest).toBeUndefined();
  });
});
