import Decimal from 'decimal.js';
import prisma from '../config/prisma.js';
import {
  splitPayment,
  classifyPayment,
  nextPeriodDate,
  buildRestructuredSchedule,
  applyEarlyPaymentForgiveness,
} from '../engine/payment-split.js';

/**
 * @typedef {object} RegisterPaymentInput
 * @property {string} loanId
 * @property {number} amountPaid
 * @property {string} offlineCreatedAt - ISO 8601
 * @property {string} collectorId
 * @property {string} [paymentScheduleId]
 * @property {number} [latitude]
 * @property {number} [longitude]
 * @property {string} [paymentMethod]
 * @property {string} [notes]
 */

/**
 * @typedef {object} PaymentResult
 * @property {object} payment       - Registro creado en la tabla payments
 * @property {object} loan          - Préstamo actualizado
 * @property {object} [schedule]    - Cuota del cronograma actualizada (si aplica)
 * @property {string} paymentType   - Clasificación: PARTIAL_INTEREST | INTEREST_ONLY
 *                                    | FULL | OVERPAYMENT | PAYOFF
 */

/**
 * Registra un pago individual dentro de una transacción Prisma.
 *
 * Flujo:
 * 1. Carga el préstamo y la cuota pendiente más antigua.
 * 2. Desglosa el monto en mora / interés / capital / excedente con splitPayment().
 * 3. Clasifica el tipo de pago con classifyPayment().
 * 4. Crea el registro Payment con el desglose.
 * 5. Actualiza la cuota y el préstamo según el tipo:
 *    - PARTIAL_INTEREST: cuota sigue pendiente.
 *    - INTEREST_ONLY: cuota marcada pagada; se agrega cuota nueva al final.
 *    - FULL: cuota marcada pagada; sin cambios al cronograma.
 *    - OVERPAYMENT: cuota pagada; cuotas restantes restructuradas con nuevo monto.
 *    - PAYOFF: préstamo liquidado; cuotas restantes marcadas restructured.
 *
 * @param {RegisterPaymentInput} input
 * @param {import('@prisma/client').PrismaClient} [tx] - Prisma transaction client (opcional)
 * @returns {Promise<PaymentResult>}
 * @throws {Error} Si el préstamo no existe, no está activo o no hay cuotas pendientes
 */
const processPayment = async (input, tx) => {
  const db = tx || prisma;

  const {
    loanId,
    amountPaid,
    offlineCreatedAt,
    collectorId,
    paymentScheduleId,
    latitude,
    longitude,
    paymentMethod,
    notes,
  } = input;

  const collectedAt = new Date(offlineCreatedAt);

  // ── 1. Cargar préstamo ──────────────────────────────────────────────────────
  const loan = await db.loan.findUnique({
    where: { id: loanId },
    include: {
      client: { select: { firstName: true, lastName: true, phone: true } },
    },
  });

  if (!loan) {
    const err = new Error('Préstamo no encontrado');
    err.statusCode = 404;
    err.isOperational = true;
    throw err;
  }

  if (loan.status !== 'ACTIVE') {
    const err = new Error(`El préstamo no está activo (estado actual: ${loan.status})`);
    err.statusCode = 409;
    err.isOperational = true;
    throw err;
  }

  // ── 2. Cargar cuota objetivo ────────────────────────────────────────────────
  let schedule;

  if (paymentScheduleId) {
    schedule = await db.paymentSchedule.findUnique({ where: { id: paymentScheduleId } });

    if (!schedule || schedule.loanId !== loanId) {
      const err = new Error('Cuota del cronograma no encontrada para este préstamo');
      err.statusCode = 404;
      err.isOperational = true;
      throw err;
    }
  } else {
    schedule = await db.paymentSchedule.findFirst({
      where: { loanId, isPaid: false, isRestructured: false },
      orderBy: { dueDate: 'asc' },
    });
  }

  if (!schedule) {
    const err = new Error('No hay cuotas pendientes para este préstamo');
    err.statusCode = 409;
    err.isOperational = true;
    throw err;
  }

  // ── 3. Desglosar y clasificar el pago ──────────────────────────────────────
  let split = splitPayment(
    amountPaid,
    loan.moraAmount,
    schedule.interestDue,
    schedule.principalDue,
  );

  // ── 3.1. Aplicar condonación para pagos anticipados mensuales ──────────────
  const paymentDate = new Date(offlineCreatedAt).toISOString().split('T')[0]; // YYYY-MM-DD
  const dueDate = schedule.dueDate.toISOString().split('T')[0]; // YYYY-MM-DD

  split = applyEarlyPaymentForgiveness(
    paymentDate,
    dueDate,
    loan.paymentFrequency,
    split,
    schedule.principalDue,
  );

  // Cuando hay condonación de interés, el interés efectivo a cubrir es 0 (ya fue perdonado).
  // Pasamos ese valor a classifyPayment para que no interprete el interestApplied=0
  // como un pago insuficiente (PARTIAL_INTEREST) cuando en realidad el interés fue condonado.
  const effectiveInterestDue = split.isEarlyPayment ? '0.00' : schedule.interestDue;

  const paymentType = classifyPayment(
    split,
    effectiveInterestDue,
    schedule.principalDue,
    loan.outstandingBalance,
  );

  // ── 4. Crear registro Payment ───────────────────────────────────────────────
  // Agregar nota de condonación si aplicó
  let paymentNotes = notes || '';
  if (split.isEarlyPayment) {
    const forgivenAmount = split.forgivenInterest || '0.00';
    const condonationNote = `Interés condonado por pago anticipado: $${forgivenAmount}`;
    paymentNotes = paymentNotes ? `${paymentNotes}. ${condonationNote}` : condonationNote;
  }

  const payment = await db.payment.create({
    data: {
      loanId,
      paymentScheduleId: schedule.id,
      collectorId,
      amount: new Decimal(amountPaid).toFixed(2),
      principalApplied: split.principalApplied,
      interestApplied: split.interestApplied,
      moraAmount: split.moraApplied,
      totalReceived: new Decimal(amountPaid).toFixed(2),
      // Persiste la clasificación del engine para auditoría y visualización en panel
      paymentType,
      latitude,
      longitude,
      paymentMethod: paymentMethod || 'CASH',
      notes: paymentNotes,
      collectedAt,
    },
  });

  // ── 5. Valores comunes para actualizar el préstamo ──────────────────────────
  const newInterestPaid = new Decimal(loan.interestPaid).plus(split.interestApplied);
  const newMora = Decimal.max(new Decimal(loan.moraAmount).minus(split.moraApplied), 0);

  // ── 6. Actualizar cuota y préstamo según tipo de pago ──────────────────────
  let updatedSchedule;
  let updatedLoan;

  if (paymentType === 'PARTIAL_INTEREST') {
    // Cuota sigue pendiente; solo acumula lo pagado
    updatedSchedule = await db.paymentSchedule.update({
      where: { id: schedule.id },
      data: {
        amountPaid: new Decimal(schedule.amountPaid).plus(amountPaid).toFixed(2),
      },
    });

    updatedLoan = await db.loan.update({
      where: { id: loanId },
      data: {
        interestPaid: newInterestPaid.toFixed(2),
        moraAmount: newMora.toFixed(2),
      },
    });
  } else if (paymentType === 'INTEREST_ONLY') {
    // El pago cubrió el interés pero no alcanzó exactamente el capital (diferencia de redondeo
    // o pago genuinamente parcial de capital). Se marca la cuota pagada y se extiende el
    // cronograma con la deuda de capital restante diferida a una nueva cuota.
    updatedSchedule = await db.paymentSchedule.update({
      where: { id: schedule.id },
      data: {
        amountPaid: new Decimal(schedule.amountPaid).plus(amountPaid).toFixed(2),
        isPaid: true,
        paidAt: collectedAt,
      },
    });

    // Capital no cubierto por este pago → se difiere a la nueva cuota extendida
    const unpaidPrincipal = Decimal.max(
      new Decimal(schedule.principalDue).minus(split.principalApplied),
      0,
    );

    // Reducir el saldo pendiente por el monto total aplicado (capital + interés),
    // igual que en FULL, para mantener la invariante outstandingBalance = totalAmount - totalPaid.
    const newOutstanding = Decimal.max(
      new Decimal(loan.outstandingBalance)
        .minus(split.principalApplied)
        .minus(split.interestApplied),
      0,
    );

    const newTotalPaid = new Decimal(loan.totalPaid)
      .plus(split.principalApplied)
      .plus(split.interestApplied);

    // Última cuota del cronograma para calcular la siguiente fecha de vencimiento
    const lastSchedule = await db.paymentSchedule.findFirst({
      where: { loanId },
      orderBy: { installmentNumber: 'desc' },
    });

    const newDueDate = nextPeriodDate(lastSchedule.dueDate, loan.paymentFrequency);

    // La nueva cuota acumula el capital diferido más el interés del período siguiente
    const newInstallmentPrincipal = unpaidPrincipal.plus(schedule.principalDue);
    const newInstallmentAmount = newInstallmentPrincipal.plus(schedule.interestDue);

    await db.paymentSchedule.create({
      data: {
        loanId,
        installmentNumber: lastSchedule.installmentNumber + 1,
        dueDate: new Date(newDueDate),
        amountDue: newInstallmentAmount.toFixed(2),
        principalDue: newInstallmentPrincipal.toFixed(2),
        interestDue: schedule.interestDue,
      },
    });

    updatedLoan = await db.loan.update({
      where: { id: loanId },
      data: {
        totalPaid: newTotalPaid.toFixed(2),
        outstandingBalance: newOutstanding.toFixed(2),
        interestPaid: newInterestPaid.toFixed(2),
        moraAmount: newMora.toFixed(2),
        numberOfPayments: { increment: 1 },
        paidPayments: { increment: 1 },
      },
    });
  } else if (paymentType === 'FULL') {
    updatedSchedule = await db.paymentSchedule.update({
      where: { id: schedule.id },
      data: {
        amountPaid: new Decimal(schedule.amountPaid).plus(amountPaid).toFixed(2),
        isPaid: true,
        paidAt: collectedAt,
      },
    });

    const newTotalPaid = new Decimal(loan.totalPaid)
      .plus(split.principalApplied)
      .plus(split.interestApplied);
    const newOutstanding = Decimal.max(
      new Decimal(loan.outstandingBalance)
        .minus(split.principalApplied)
        .minus(split.interestApplied),
      0,
    );

    updatedLoan = await db.loan.update({
      where: { id: loanId },
      data: {
        totalPaid: newTotalPaid.toFixed(2),
        outstandingBalance: newOutstanding.toFixed(2),
        interestPaid: newInterestPaid.toFixed(2),
        moraAmount: newMora.toFixed(2),
        paidPayments: { increment: 1 },
      },
    });
  } else if (paymentType === 'OVERPAYMENT') {
    updatedSchedule = await db.paymentSchedule.update({
      where: { id: schedule.id },
      data: {
        amountPaid: new Decimal(schedule.amountPaid).plus(amountPaid).toFixed(2),
        isPaid: true,
        paidAt: collectedAt,
      },
    });

    // Cuotas pendientes a reemplazar: excluir la cuota actual (ya marcada pagada arriba)
    const pendingSchedules = await db.paymentSchedule.findMany({
      where: { loanId, isPaid: false, isRestructured: false, id: { not: schedule.id } },
      orderBy: { installmentNumber: 'asc' },
    });

    if (pendingSchedules.length > 0) {
      await db.paymentSchedule.updateMany({
        where: { id: { in: pendingSchedules.map((s) => s.id) } },
        data: { isRestructured: true },
      });

      const newOutstandingBalance = Decimal.max(
        new Decimal(loan.outstandingBalance)
          .minus(split.principalApplied)
          .minus(split.interestApplied)
          .minus(split.excess),
        0,
      );

      const totalInterest = new Decimal(loan.totalAmount).minus(loan.principalAmount);

      // El interés condonado por pago anticipado debe contarse como "cubierto" para
      // no inflar el remainingInterest y evitar que buildRestructuredSchedule genere
      // más cuotas de las necesarias.
      const forgivenInterest = new Decimal(split.forgivenInterest ?? '0');
      const remainingInterest = Decimal.max(
        totalInterest.minus(newInterestPaid).minus(forgivenInterest),
        0,
      );
      const remainingCapital = Decimal.max(newOutstandingBalance.minus(remainingInterest), 0);

      const newInstallments = buildRestructuredSchedule({
        remainingCapital: remainingCapital.toFixed(2),
        remainingInterest: remainingInterest.toFixed(2),
        originalInstallmentAmount: loan.installmentAmount,
        pendingInstallments: pendingSchedules,
        frequency: loan.paymentFrequency,
      });

      if (newInstallments.length > 0) {
        // Las cuotas originales siguen en BD marcadas como isRestructured=true.
        // Para evitar colisión con el índice único (loan_id, installment_number),
        // numeramos las nuevas cuotas desde el máximo existente en el cronograma.
        const lastExisting = await db.paymentSchedule.findFirst({
          where: { loanId },
          orderBy: { installmentNumber: 'desc' },
        });
        const baseNumber = lastExisting?.installmentNumber ?? 0;

        await db.paymentSchedule.createMany({
          data: newInstallments.map((inst, idx) => ({
            loanId,
            installmentNumber: baseNumber + idx + 1,
            dueDate: new Date(inst.dueDate),
            amountDue: inst.amountDue,
            principalDue: inst.principalDue,
            interestDue: inst.interestDue,
          })),
        });
      }

      const newNumberOfPayments =
        loan.numberOfPayments - pendingSchedules.length + newInstallments.length;

      const newTotalPaid = new Decimal(loan.totalPaid)
        .plus(split.principalApplied)
        .plus(split.interestApplied)
        .plus(split.excess);

      updatedLoan = await db.loan.update({
        where: { id: loanId },
        data: {
          totalPaid: newTotalPaid.toFixed(2),
          outstandingBalance: newOutstandingBalance.toFixed(2),
          interestPaid: newInterestPaid.toFixed(2),
          moraAmount: newMora.toFixed(2),
          numberOfPayments: newNumberOfPayments,
          paidPayments: { increment: 1 },
          installmentAmount: newInstallments[0]?.amountDue ?? loan.installmentAmount,
        },
      });
    } else {
      // Sin cuotas pendientes: el préstamo queda completado
      updatedLoan = await db.loan.update({
        where: { id: loanId },
        data: {
          outstandingBalance: '0.00',
          interestPaid: newInterestPaid.toFixed(2),
          moraAmount: newMora.toFixed(2),
          status: 'COMPLETED',
          actualEndDate: collectedAt,
          paidPayments: { increment: 1 },
        },
      });
    }
  } else if (paymentType === 'PAYOFF') {
    updatedSchedule = await db.paymentSchedule.update({
      where: { id: schedule.id },
      data: {
        amountPaid: new Decimal(schedule.amountPaid).plus(amountPaid).toFixed(2),
        isPaid: true,
        paidAt: collectedAt,
      },
    });

    // PAYOFF: marcar todas las cuotas pendientes como pagadas (liquidación completa)
    // También eliminar cualquier mora y restructuring previo, ya que el préstamo se liquida.
    // Excluimos la cuota actual (schedule.id) porque ya fue actualizada arriba.
    const pendingSchedules = await db.paymentSchedule.findMany({
      where: { loanId, isPaid: false, id: { not: schedule.id } },
      select: { id: true, amountDue: true },
    });

    // Actualizar cada cuota pendiente individualmente para establecer amountPaid = amountDue
    if (pendingSchedules.length > 0) {
      await Promise.all(
        pendingSchedules.map((s) =>
          db.paymentSchedule.update({
            where: { id: s.id },
            data: {
              isPaid: true,
              paidAt: collectedAt,
              amountPaid: s.amountDue, // Marcar como completamente pagada
              moraCharged: '0.00',
              isRestructured: false, // Limpiar flag de restructuración
            },
          }),
        ),
      );
    }

    // Ajustar paidPayments para que sea igual a numberOfPayments (progreso 100%)
    updatedLoan = await db.loan.update({
      where: { id: loanId },
      data: {
        totalPaid: new Decimal(loan.totalAmount).toFixed(2),
        outstandingBalance: '0.00',
        interestPaid: newInterestPaid.toFixed(2),
        moraAmount: '0.00', // PAYOFF elimina toda la mora pendiente
        status: 'COMPLETED',
        actualEndDate: collectedAt,
        paidPayments: loan.numberOfPayments, // Forzar progreso 100%
      },
    });
  }

  return {
    payment,
    loan: updatedLoan,
    schedule: updatedSchedule,
    paymentType,
    clientName: `${loan.client.firstName} ${loan.client.lastName}`,
    clientPhone: loan.client.phone,
    numberOfPayments: loan.numberOfPayments,
  };
};

/**
 * Registra un pago individual envuelto en una transacción Prisma.
 *
 * @param {RegisterPaymentInput} input
 * @returns {Promise<PaymentResult>}
 */
const registerPayment = async (input) =>
  prisma.$transaction(async (tx) => processPayment(input, tx), { timeout: 10000 });

/**
 * @typedef {object} BatchSyncItem
 * @property {string} localId - ID local del dispositivo
 * @property {string} loanId
 * @property {number} amountPaid
 * @property {string} offlineCreatedAt
 * @property {string} [paymentScheduleId]
 * @property {number} [latitude]
 * @property {number} [longitude]
 * @property {string} [notes]
 */

/**
 * @typedef {object} BatchSyncResult
 * @property {string} localId
 * @property {'synced'|'conflict'|'error'} status
 * @property {string} [paymentId] - UUID del pago creado (si synced)
 * @property {string} [message] - Mensaje descriptivo (si conflict o error)
 */

/**
 * Procesa un array de pagos registrados offline.
 * Cada pago se ejecuta en su propia transacción para que un fallo
 * individual no afecte al resto del lote.
 *
 * @param {BatchSyncItem[]} payments
 * @param {string} collectorId
 * @returns {Promise<BatchSyncResult[]>}
 */
const batchSync = async (payments, collectorId) => {
  const results = [];

  // Sequential processing is intentional: each payment in its own transaction
  // eslint-disable-next-line no-restricted-syntax
  for (const item of payments) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const result = await registerPayment({
        ...item,
        collectorId,
      });

      results.push({
        localId: item.localId,
        status: 'synced',
        paymentId: result.payment.id,
      });
    } catch (err) {
      const isConflict = err.statusCode === 409 || err.code === 'P2002';

      results.push({
        localId: item.localId,
        status: isConflict ? 'conflict' : 'error',
        message: err.message,
      });
    }
  }

  return results;
};

/**
 * @typedef {object} AdminPaymentInput
 * @property {string} loanId
 * @property {string} amountPaid - Monto total recibido
 * @property {string} paymentDate - Fecha del pago (YYYY-MM-DD o ISO)
 * @property {string} collectorId
 * @property {string} [paymentMethod]
 * @property {string} [notes]
 */

/**
 * Registra un pago desde el panel administrativo.
 *
 * Delega al core `processPayment` reutilizando toda la lógica de desglose
 * interés/capital y restructuración del cronograma. La única diferencia con
 * la API móvil es el campo de fecha: aquí se recibe `paymentDate` (formulario HTML)
 * en lugar de `offlineCreatedAt`.
 *
 * @param {AdminPaymentInput} input
 * @returns {Promise<PaymentResult>}
 */
export const registerAdminPayment = async (input) => {
  const { loanId, amountPaid, paymentDate, collectorId, paymentMethod, notes } = input;

  const parseLocalDateTime = (value) => {
    if (!value) return new Date().toISOString();
    if (value.includes('T')) return value;
    const [y, m, d] = value.split('-').map(Number);
    const now = new Date();
    return new Date(
      y,
      (m || 1) - 1,
      d || 1,
      now.getHours(),
      now.getMinutes(),
      now.getSeconds(),
    ).toISOString();
  };

  return prisma.$transaction(
    (tx) =>
      processPayment(
        {
          loanId,
          amountPaid,
          offlineCreatedAt: parseLocalDateTime(paymentDate),
          collectorId,
          paymentMethod: paymentMethod || 'CASH',
          notes,
        },
        tx,
      ),
    { timeout: 10000 },
  );
};

export { processPayment, registerPayment, batchSync };
