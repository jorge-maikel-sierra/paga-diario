import Decimal from 'decimal.js';
import prisma from '../config/prisma.js';
import { generateFixedDailySchedule } from '../engine/amortization.js';

/**
 * Lista los préstamos de una organización con filtros opcionales.
 *
 * @param {string} organizationId - UUID de la organización
 * @param {{ search?: string, status?: string }} [filters]
 * @returns {Promise<Array>}
 */
export const findLoans = async (organizationId, { search, status } = {}) => {
  /** @type {import('@prisma/client').Prisma.LoanWhereInput} */
  const where = { organizationId };

  if (status && status.trim() !== '') {
    where.status = status.trim();
  }

  if (search && search.trim() !== '') {
    const term = search.trim();
    where.client = {
      OR: [
        { firstName: { contains: term, mode: 'insensitive' } },
        { lastName: { contains: term, mode: 'insensitive' } },
      ],
    };
  }

  return prisma.loan.findMany({
    where,
    orderBy: { disbursementDate: 'desc' },
    select: {
      id: true,
      status: true,
      principalAmount: true,
      totalAmount: true,
      installmentAmount: true,
      outstandingBalance: true,
      numberOfPayments: true,
      paidPayments: true,
      disbursementDate: true,
      paymentFrequency: true,
      client: { select: { firstName: true, lastName: true } },
      collector: { select: { firstName: true, lastName: true } },
    },
  });
};

/**
 * Obtiene el detalle completo de un préstamo con cronograma, pagos e incidentes.
 * Lanza error 404 si el préstamo no pertenece a la organización.
 *
 * @param {string} id - UUID del préstamo
 * @param {string} organizationId - UUID de la organización (scope multi-tenant)
 * @returns {Promise<object>}
 */
export const findLoanById = async (id, organizationId) => {
  const loan = await prisma.loan.findFirst({
    where: { id, organizationId },
    include: {
      client: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          documentType: true,
          documentNumber: true,
          phone: true,
          address: true,
          businessName: true,
          isActive: true,
          route: { select: { id: true, name: true } },
        },
      },
      collector: {
        select: { id: true, firstName: true, lastName: true, phone: true },
      },
      paymentSchedule: {
        // Excluir cuotas reemplazadas por restructuración — solo mostrar el cronograma vigente
        where: { isRestructured: false },
        orderBy: { installmentNumber: 'asc' },
        select: {
          id: true,
          installmentNumber: true,
          dueDate: true,
          amountDue: true,
          principalDue: true,
          interestDue: true,
          amountPaid: true,
          moraCharged: true,
          isPaid: true,
          isRestructured: true,
          paidAt: true,
        },
      },
      payments: {
        orderBy: { collectedAt: 'desc' },
        take: 20,
        select: {
          id: true,
          amount: true,
          principalApplied: true,
          interestApplied: true,
          moraAmount: true,
          totalReceived: true,
          paymentType: true,
          paymentMethod: true,
          notes: true,
          collectedAt: true,
          collector: { select: { firstName: true, lastName: true } },
        },
      },
      incidents: {
        orderBy: { reportedAt: 'desc' },
        select: {
          id: true,
          type: true,
          description: true,
          reportedAt: true,
          collector: { select: { firstName: true, lastName: true } },
        },
      },
    },
  });

  if (!loan) {
    const err = new Error('Préstamo no encontrado');
    err.statusCode = 404;
    throw err;
  }

  return loan;
};

/**
 * Obtiene los datos necesarios para el formulario de nuevo préstamo:
 * clientes activos, cobradores y rutas de la organización.
 *
 * @param {string} organizationId - UUID de la organización
 * @returns {Promise<{ clients: Array, collectors: Array, routes: Array }>}
 */
export const getNewLoanFormData = async (organizationId) => {
  const [clients, collectors, routes] = await Promise.all([
    prisma.client.findMany({
      where: { organizationId, isActive: true },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      select: { id: true, firstName: true, lastName: true, documentNumber: true },
    }),
    prisma.user.findMany({
      where: { organizationId, role: 'COLLECTOR', isActive: true },
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
      select: { id: true, firstName: true, lastName: true },
    }),
    prisma.route.findMany({
      where: { organizationId, isActive: true },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    }),
  ]);

  return { clients, collectors, routes };
};

/**
 * Crea un préstamo junto con su cronograma de amortización en una transacción.
 *
 * @param {string} organizationId - UUID de la organización
 * @param {{ clientId: string, collectorId: string, principalAmount: string,
 *   interestRate: string, termMonths: number, disbursementDate: Date,
 *   paymentFrequency: string, amortizationType: string, notes?: string }} data
 * @returns {Promise<import('@prisma/client').Loan>}
 */
export const createLoan = async (organizationId, data) => {
  const {
    clientId,
    collectorId,
    principalAmount,
    interestRate,
    termMonths,
    disbursementDate,
    paymentFrequency,
    amortizationType,
    notes,
  } = data;

  const amortization = generateFixedDailySchedule({
    principal: principalAmount,
    monthlyRate: interestRate,
    termMonths,
    startDate: disbursementDate,
    frequency: paymentFrequency,
  });

  const principalDec = new Decimal(principalAmount);
  const totalAmountDec = new Decimal(amortization.totalAmount);
  const installmentAmountDec = new Decimal(amortization.installmentAmount);

  return prisma.$transaction(async (tx) => {
    const loan = await tx.loan.create({
      data: {
        organizationId,
        clientId,
        collectorId,
        status: 'ACTIVE',
        amortizationType,
        paymentFrequency,
        principalAmount: principalDec.toFixed(2),
        interestRate,
        totalAmount: totalAmountDec.toFixed(2),
        installmentAmount: installmentAmountDec.toFixed(2),
        totalPaid: '0.00',
        outstandingBalance: totalAmountDec.toFixed(2),
        moraAmount: '0.00',
        // Guardar el número de cuotas calculado por el engine según la frecuencia
        numberOfPayments: amortization.numberOfPayments,
        paidPayments: 0,
        disbursementDate: new Date(disbursementDate),
        expectedEndDate: new Date(amortization.expectedEndDate),
        notes,
      },
    });

    const scheduleData = amortization.schedule.map((inst) => ({
      loanId: loan.id,
      installmentNumber: inst.installmentNumber,
      dueDate: new Date(inst.dueDate),
      amountDue: inst.amountDue,
      principalDue: inst.principalDue,
      interestDue: inst.interestDue,
      amountPaid: '0.00',
      moraCharged: '0.00',
      isPaid: false,
    }));

    await tx.paymentSchedule.createMany({ data: scheduleData });

    return loan;
  });
};

/**
 * Obtiene los datos para el formulario de nuevo pago desde el panel admin:
 * préstamos activos y cobradores de la organización.
 *
 * @param {string} organizationId - UUID de la organización
 * @returns {Promise<{ loans: Array, collectors: Array }>}
 */
export const getNewPaymentFormData = async (organizationId) => {
  const [loans, collectors] = await Promise.all([
    prisma.loan.findMany({
      where: { organizationId, status: 'ACTIVE' },
      select: {
        id: true,
        principalAmount: true,
        outstandingBalance: true,
        installmentAmount: true,
        client: { select: { firstName: true, lastName: true } },
      },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.user.findMany({
      where: { organizationId, role: 'COLLECTOR', isActive: true },
      select: { id: true, firstName: true, lastName: true },
      orderBy: { firstName: 'asc' },
    }),
  ]);

  return { loans, collectors };
};

/**
 * Obtiene la cuota pendiente más antigua de un préstamo y el saldo de mora actual.
 * Usado por el panel de pago para mostrar el desglose predictivo.
 *
 * @param {string} id - UUID del préstamo
 * @param {string} organizationId - UUID de la organización (scope multi-tenant)
 * @returns {Promise<{ installmentAmount: string, principalDue: string,
 *   interestDue: string, amountPaid: string, moraAmount: string,
 *   outstandingBalance: string, installmentNumber: number,
 *   dueDate: string } | null>}
 */
export const getNextInstallment = async (id, organizationId) => {
  const loan = await prisma.loan.findFirst({
    where: { id, organizationId },
    select: {
      outstandingBalance: true,
      moraAmount: true,
      installmentAmount: true,
      status: true,
      // Cargar todas las cuotas pendientes para calcular el payoff real
      paymentSchedule: {
        where: { isPaid: false, isRestructured: false },
        orderBy: { dueDate: 'asc' },
        select: {
          id: true,
          installmentNumber: true,
          dueDate: true,
          amountDue: true,
          principalDue: true,
          interestDue: true,
          amountPaid: true,
        },
      },
    },
  });

  if (!loan) return null;

  const pendingSchedules = loan.paymentSchedule;
  const nextSchedule = pendingSchedules[0] ?? null;

  // ── Calcular payoffAmount (liquidación anticipada) ─────────────────────────
  // Regla: el cliente solo paga el capital que aún debe + los intereses de las
  // cuotas YA VENCIDAS (dueDate ≤ hoy). Los intereses de cuotas futuras no
  // vencidas no se cobran — el préstamo se salda con lo que se ha devengado.
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const payoffAmount = pendingSchedules.reduce((acc, s) => {
    const dueDate = new Date(s.dueDate);
    dueDate.setHours(0, 0, 0, 0);

    const principal = new Decimal(s.principalDue).minus(new Decimal(s.amountPaid ?? 0));
    // Solo cobrar interés si la cuota ya venció (dueDate <= hoy)
    const interest = dueDate <= today ? new Decimal(s.interestDue) : new Decimal(0);

    return acc.plus(Decimal.max(principal, 0)).plus(interest);
  }, new Decimal(loan.moraAmount));

  return {
    outstandingBalance: loan.outstandingBalance.toString(),
    moraAmount: loan.moraAmount.toString(),
    installmentAmount: loan.installmentAmount.toString(),
    status: loan.status,
    nextSchedule,
    // Monto real para liquidar el préstamo hoy (capital pendiente + interés devengado + mora)
    payoffAmount: payoffAmount.toFixed(2),
  };
};

/**
 * Genera una previsualización del cronograma sin persistir en BD.
 *
 * @param {{ principalAmount: string, interestRate: string,
 *   termMonths: number, disbursementDate: Date, paymentFrequency: string }} data
 * @returns {AmortizationResult}
 */
export const previewAmortizationSchedule = (data) =>
  generateFixedDailySchedule({
    principal: data.principalAmount,
    monthlyRate: data.interestRate,
    termMonths: data.termMonths,
    startDate: data.disbursementDate,
    frequency: data.paymentFrequency ?? 'DAILY',
  });

/**
 * Obtiene los préstamos activos de una organización con cronograma completo
 * para la generación de PDFs en segundo plano (uso exclusivo de pdfWorker).
 *
 * @param {string} organizationId - UUID de la organización
 * @returns {Promise<Array>}
 */
export const findLoansWithScheduleForPDF = async (organizationId) =>
  prisma.loan.findMany({
    where: { organizationId, status: 'ACTIVE' },
    select: {
      id: true,
      principalAmount: true,
      interestRate: true,
      totalAmount: true,
      totalPaid: true,
      outstandingBalance: true,
      moraAmount: true,
      numberOfPayments: true,
      paidPayments: true,
      disbursementDate: true,
      expectedEndDate: true,
      status: true,
      paymentFrequency: true,
      client: {
        select: {
          firstName: true,
          lastName: true,
          documentNumber: true,
        },
      },
      collector: {
        select: { firstName: true, lastName: true },
      },
      paymentSchedule: {
        select: {
          installmentNumber: true,
          dueDate: true,
          amountDue: true,
          principalDue: true,
          interestDue: true,
          amountPaid: true,
          isPaid: true,
        },
        orderBy: { installmentNumber: 'asc' },
      },
    },
    orderBy: { client: { lastName: 'asc' } },
  });
