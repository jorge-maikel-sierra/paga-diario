import Decimal from 'decimal.js';
import dayjs from 'dayjs';
import { isBusinessDay } from './amortization.js';

/**
 * @typedef {'PARTIAL_INTEREST'|'INTEREST_ONLY'|'FULL'|'OVERPAYMENT'|'PAYOFF'} PaymentType
 */

/**
 * @typedef {object} PaymentSplit
 * @property {string} moraApplied       - Monto aplicado a mora pendiente
 * @property {string} interestApplied   - Monto aplicado a interés de la cuota
 * @property {string} principalApplied  - Monto aplicado a capital de la cuota
 * @property {string} excess            - Excedente después de cubrir la cuota completa
 *                                        (abono a capital)
 * @property {string} [forgivenInterest] - Interés condonado por pago anticipado (auditoría)
 * @property {boolean} [isEarlyPayment] - Flag si aplica condonación de interés
 */

/**
 * Desglosa un monto de pago en mora, interés, capital y excedente.
 *
 * Prioridad de aplicación: mora → interés → capital → exceso
 *
 * @param {string|number} amount       - Monto total recibido
 * @param {string|number} moraOwed     - Mora pendiente del préstamo
 * @param {string|number} interestDue  - Interés de la cuota actual
 * @param {string|number} principalDue - Capital de la cuota actual
 * @returns {PaymentSplit}
 */
export const splitPayment = (amount, moraOwed, interestDue, principalDue) => {
  const P = new Decimal(amount);
  const M = new Decimal(moraOwed);
  const I = new Decimal(interestDue);
  const K = new Decimal(principalDue);

  const moraApplied = Decimal.min(P, M);
  const r1 = P.minus(moraApplied);

  const interestApplied = Decimal.min(r1, I);
  const r2 = r1.minus(interestApplied);

  const principalApplied = Decimal.min(r2, K);
  const excess = r2.minus(principalApplied);

  return {
    moraApplied: moraApplied.toFixed(2),
    interestApplied: interestApplied.toFixed(2),
    principalApplied: principalApplied.toFixed(2),
    excess: excess.toFixed(2),
  };
};

/**
 * Aplica condonación de intereses para pagos anticipados mensuales.
 *
 * Regla de negocio: si el pago se registra ≥30 días antes del próximo vencimiento
 * en préstamos MONTHLY y el monto cubre al menos el principal de la cuota,
 * se condona el interés de esa cuota.
 *
 * @param {string} paymentDate - Fecha del pago (YYYY-MM-DD)
 * @param {string} dueDate - Fecha de vencimiento de la cuota (YYYY-MM-DD)
 * @param {'DAILY'|'WEEKLY'|'BIWEEKLY'|'MONTHLY'} frequency - Frecuencia del préstamo
 * @param {PaymentSplit} split - Desglose original del pago
 * @param {string|number} principalDue - Capital requerido de la cuota
 * @returns {PaymentSplit} Split modificado con condonación aplicada si corresponde
 */
export const applyEarlyPaymentForgiveness = (
  paymentDate,
  dueDate,
  frequency,
  split,
  principalDue,
) => {
  // Solo aplicar en préstamos mensuales
  if (frequency !== 'MONTHLY') {
    return split;
  }

  const paymentDay = dayjs(paymentDate);
  const dueDateDay = dayjs(dueDate);
  const daysDiff = dueDateDay.diff(paymentDay, 'days');

  // Verificar si es pago anticipado (≥30 días antes)
  const isEarlyPayment = daysDiff >= 30;

  // Verificar si el pago cubre al menos el principal
  const principalAppliedDecimal = new Decimal(split.principalApplied);
  const principalDueDecimal = new Decimal(principalDue);
  const coversPrincipal = principalAppliedDecimal.gte(principalDueDecimal);

  if (isEarlyPayment && coversPrincipal) {
    // Condonar el interés: mover el interés aplicado al principal
    const forgivenInterest = split.interestApplied;
    const newPrincipalApplied = principalAppliedDecimal.plus(split.interestApplied);

    return {
      ...split,
      interestApplied: '0.00',
      principalApplied: newPrincipalApplied.toFixed(2),
      forgivenInterest,
      isEarlyPayment: true,
    };
  }

  return split;
};

/**
 * Clasifica el tipo de pago a partir del desglose y el saldo pendiente del préstamo.
 *
 * | Tipo              | Condición                                                            |
 * |-------------------|----------------------------------------------------------------------|
 * | PAYOFF            | mora+interés+capital+exceso >= saldo pendiente (liquidación total)   |
 * | PARTIAL_INTEREST  | interestApplied < interestDue (no cubre todo el interés)             |
 * | INTEREST_ONLY     | interestApplied >= interestDue AND principalApplied < principalDue  |
 * | FULL              | cuota completa cubierta, sin excedente                               |
 * | OVERPAYMENT       | cuota completa + excedente que no liquida el préstamo                |
 *
 * La verificación de PAYOFF se realiza PRIMERO porque un pago con mora alta puede
 * no cubrir el interés de la cuota actual pero sí liquidar el saldo total del préstamo
 * (ej: mora + capital restante = outstandingBalance). Sin este orden, el clasificador
 * retornaría PARTIAL_INTEREST incorrectamente y el préstamo nunca quedaría COMPLETED.
 *
 * @param {PaymentSplit}   split
 * @param {string|number}  interestDue        - Interés de la cuota
 * @param {string|number}  principalDue       - Capital de la cuota
 * @param {string|number}  outstandingBalance - Saldo total pendiente del préstamo
 * @returns {PaymentType}
 */
export const classifyPayment = (split, interestDue, principalDue, outstandingBalance) => {
  // moraApplied puede ser undefined en splits construidos manualmente (ej: tests de integración)
  const moraApplied = new Decimal(split.moraApplied ?? '0');
  const interestApplied = new Decimal(split.interestApplied);
  const principalApplied = new Decimal(split.principalApplied);
  const excess = new Decimal(split.excess);

  // PAYOFF se evalúa primero: mora + interés + capital + exceso cubre el saldo total
  const totalApplied = moraApplied.plus(interestApplied).plus(principalApplied).plus(excess);
  if (totalApplied.gte(new Decimal(outstandingBalance))) return 'PAYOFF';

  if (interestApplied.lt(new Decimal(interestDue))) return 'PARTIAL_INTEREST';

  if (principalApplied.lt(new Decimal(principalDue))) return 'INTEREST_ONLY';
  if (excess.gt(0)) return 'OVERPAYMENT';
  return 'FULL';
};

/**
 * Avanza una fecha al siguiente período según la frecuencia de pago.
 * Para DAILY se salta domingos (misma lógica que amortization.js).
 *
 * @param {string} lastDueDate - YYYY-MM-DD
 * @param {'DAILY'|'WEEKLY'|'BIWEEKLY'|'MONTHLY'} frequency
 * @param {string[]} [holidays]
 * @returns {string} YYYY-MM-DD
 */
export const nextPeriodDate = (lastDueDate, frequency, holidays = []) => {
  const holidaySet = new Set(holidays);
  let date = dayjs(lastDueDate);

  if (frequency === 'DAILY') {
    date = date.add(1, 'day');
    while (!isBusinessDay(date, holidaySet)) {
      date = date.add(1, 'day');
    }
  } else if (frequency === 'WEEKLY') {
    date = date.add(1, 'week');
  } else if (frequency === 'BIWEEKLY') {
    date = date.add(2, 'week');
  } else {
    date = date.add(1, 'month');
  }

  return date.format('YYYY-MM-DD');
};

/**
 * @typedef {object} RestructureParams
 * @property {string|number} remainingCapital         - Capital pendiente (después del exceso)
 * @property {string|number} remainingInterest        - Interés pendiente (fijo, ya calculado)
 * @property {string|number} originalInstallmentAmount - Monto original por cuota
 * @property {Array<{ installmentNumber: number, dueDate: string }>} pendingInstallments
 *   Cuotas pendientes que van a ser reemplazadas (en orden ascendente)
 * @property {'DAILY'|'WEEKLY'|'BIWEEKLY'|'MONTHLY'} frequency
 * @property {string[]} [holidays]
 */

/**
 * @typedef {object} RestructuredInstallment
 * @property {number} installmentNumber
 * @property {string} dueDate
 * @property {string} amountDue
 * @property {string} principalDue
 * @property {string} interestDue
 */

/**
 * Genera el nuevo cronograma de cuotas después de un abono anticipado a capital.
 *
 * Reglas:
 * - El interés restante es fijo (no se recalcula sobre el nuevo capital).
 * - El número de cuotas nuevas = min(ceil(total / originalInstallment), pendingCount).
 * - Las fechas se reutilizan de las cuotas existentes; si el nuevo count < pendingCount,
 *   las últimas fechas no se usan (las cuotas sobrantes quedan marcadas isRestructured=true).
 * - La última cuota absorbe el redondeo acumulado.
 *
 * @param {RestructureParams} params
 * @returns {RestructuredInstallment[]} Vacío si el préstamo quedó liquidado.
 */
export const buildRestructuredSchedule = ({
  remainingCapital,
  remainingInterest,
  originalInstallmentAmount,
  pendingInstallments,
  // frequency y holidays reservados para futura extensión (fechas dinámicas)
  // eslint-disable-next-line no-unused-vars
  frequency,
  // eslint-disable-next-line no-unused-vars
  holidays = [],
}) => {
  const capital = new Decimal(remainingCapital);
  const interest = new Decimal(remainingInterest);
  const totalRemaining = capital.plus(interest);
  const installAmt = new Decimal(originalInstallmentAmount);

  if (totalRemaining.lte(0)) return [];

  const maxCount = pendingInstallments.length;
  const rawCount = Math.ceil(totalRemaining.div(installAmt).toNumber());
  const newCount = Math.min(rawCount, maxCount);

  const capitalPerInstall = capital.div(newCount).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const interestPerInstall = interest.div(newCount).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

  const newInstallments = [];
  let accCapital = new Decimal(0);
  let accInterest = new Decimal(0);

  for (let i = 0; i < newCount; i += 1) {
    const isLast = i === newCount - 1;

    const principalDue = isLast ? capital.minus(accCapital) : capitalPerInstall;
    const interestDue = isLast ? interest.minus(accInterest) : interestPerInstall;

    accCapital = accCapital.plus(principalDue);
    accInterest = accInterest.plus(interestDue);

    newInstallments.push({
      installmentNumber: pendingInstallments[i].installmentNumber,
      dueDate: pendingInstallments[i].dueDate,
      amountDue: principalDue.plus(interestDue).toFixed(2),
      principalDue: principalDue.toFixed(2),
      interestDue: interestDue.toFixed(2),
    });
  }

  return newInstallments;
};
