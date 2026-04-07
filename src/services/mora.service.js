import Decimal from 'decimal.js';
import prisma from '../config/prisma.js';
import { getDaysOverdue, calcMora } from '../engine/mora.js';

/**
 * @typedef {object} MoraUpdateResult
 * @property {string} loanId - UUID del préstamo actualizado
 * @property {string} moraAmount - Mora total calculada y guardada
 * @property {number} overdueSchedules - Número de cuotas vencidas procesadas
 */

/**
 * Calcula y actualiza la mora de un préstamo y de cada cuota vencida
 * dentro de una única transacción Prisma.
 *
 * Por cuota vencida e impaga:
 *  - Calcula la mora diaria sobre el saldo impago de esa cuota.
 *  - Persiste el valor en `paymentSchedule.moraCharged` para que la
 *    vista de detalle del préstamo pueda mostrarlo por fila.
 *
 * En el préstamo:
 *  - Acumula la suma de todas las moras y la persiste en `loan.moraAmount`.
 *
 * @param {string} loanId - UUID del préstamo a procesar
 * @returns {Promise<MoraUpdateResult>}
 */
export const calculateAndUpdateLoanMora = async (loanId) =>
  prisma.$transaction(async (tx) => {
    const loan = await tx.loan.findUniqueOrThrow({
      where: { id: loanId },
      select: {
        id: true,
        interestRate: true,
        paymentSchedule: {
          where: { isPaid: false, isRestructured: false },
          select: {
            id: true,
            dueDate: true,
            amountDue: true,
            amountPaid: true,
          },
        },
      },
    });

    const dailyRate = new Decimal(loan.interestRate);
    const today = new Date().toISOString().slice(0, 10);

    // Calcular el resultado de mora para cada cuota sin await en el loop
    const scheduleResults = loan.paymentSchedule.map((schedule) => {
      const daysOverdue = getDaysOverdue(schedule.dueDate.toISOString().slice(0, 10), today);
      const unpaidOnSchedule = new Decimal(schedule.amountDue).minus(
        new Decimal(schedule.amountPaid),
      );

      const isOverdueWithBalance = daysOverdue > 0 && unpaidOnSchedule.gt(0);

      if (!isOverdueWithBalance) {
        // Sin mora: limpiar moraCharged si la cuota ya no está vencida
        return { scheduleId: schedule.id, moraCharged: '0.00', isOverdue: false };
      }

      const { moraAmount: schedMora } = calcMora({
        outstandingAmount: unpaidOnSchedule.toFixed(2),
        dailyRate: dailyRate.toFixed(8),
        daysOverdue,
      });

      return { scheduleId: schedule.id, moraCharged: schedMora, isOverdue: true };
    });

    // Persistir todas las actualizaciones de cuotas en paralelo
    await Promise.all(
      scheduleResults.map((r) =>
        tx.paymentSchedule.update({
          where: { id: r.scheduleId },
          data: { moraCharged: r.moraCharged },
        }),
      ),
    );

    const overdueResults = scheduleResults.filter((r) => r.isOverdue);
    const totalMora = overdueResults.reduce(
      (acc, r) => acc.plus(new Decimal(r.moraCharged)),
      new Decimal(0),
    );

    const updatedLoan = await tx.loan.update({
      where: { id: loanId },
      data: { moraAmount: totalMora.toFixed(2) },
      select: { id: true, moraAmount: true },
    });

    return {
      loanId: updatedLoan.id,
      moraAmount: updatedLoan.moraAmount.toString(),
      overdueSchedules: overdueResults.length,
    };
  });

/**
 * Obtiene los IDs de todos los préstamos activos de una organización
 * que tienen al menos una cuota vencida e impaga.
 *
 * @param {string} organizationId - UUID de la organización
 * @returns {Promise<string[]>} Array de loanIds con mora pendiente
 */
export const findActiveLoansWithOverdueSchedules = async (organizationId) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const loans = await prisma.loan.findMany({
    where: {
      organizationId,
      status: 'ACTIVE',
      paymentSchedule: {
        some: {
          isPaid: false,
          isRestructured: false,
          dueDate: { lt: today },
        },
      },
    },
    select: { id: true },
  });

  return loans.map((l) => l.id);
};

/**
 * Procesa la mora de todos los préstamos activos con cuotas vencidas
 * de una organización. Diseñado para ser llamado desde el moraWorker.
 *
 * Procesa cada préstamo de forma individual para que un error en uno
 * no bloquee el resto del lote.
 *
 * @param {string} organizationId - UUID de la organización
 * @returns {Promise<{ processed: number, errors: number, totalMora: string }>}
 */
export const processMoraForOrganization = async (organizationId) => {
  const loanIds = await findActiveLoansWithOverdueSchedules(organizationId);

  // Procesar préstamos en serie con reduce para aislar errores por préstamo
  // sin usar await-in-loop (cada iteración encadena la promesa anterior)
  const { processed, errors, totalMora } = await loanIds.reduce(
    async (accPromise, loanId) => {
      const acc = await accPromise;
      try {
        const result = await calculateAndUpdateLoanMora(loanId);
        return {
          processed: acc.processed + 1,
          errors: acc.errors,
          totalMora: acc.totalMora.plus(new Decimal(result.moraAmount)),
        };
      } catch (err) {
        // Un error en un préstamo no debe detener el procesamiento del lote
        console.error(`[MoraService] Error calculando mora para préstamo ${loanId}:`, err.message);
        return { ...acc, errors: acc.errors + 1 };
      }
    },
    Promise.resolve({ processed: 0, errors: 0, totalMora: new Decimal(0) }),
  );

  return {
    processed,
    errors,
    totalMora: totalMora.toFixed(2),
  };
};
