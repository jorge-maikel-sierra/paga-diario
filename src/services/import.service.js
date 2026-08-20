import { Readable } from 'node:stream';
import ExcelJS from 'exceljs';
import Decimal from 'decimal.js';
import dayjs from 'dayjs';
import prisma from '../config/prisma.js';
import { getIO } from '../config/socket.js';
import { generateFixedDailySchedule } from '../engine/amortization.js';
import { splitPayment, classifyPayment } from '../engine/payment-split.js';

/**
 * @typedef {object} ImportContext
 * @property {Map<string,string>} routesByName - nombre de ruta (lowercase) -> id
 * @property {Map<string,string>} usersByEmail - email (lowercase) -> id de usuario activo
 * @property {string|null} defaultCollectorId - primer cobrador activo, fallback si no se especifica
 * @property {Set<string>} seenClientIds - external_client_id ya vistos (BD + filas previas del archivo)
 * @property {Set<string>} seenLoanIds - external_loan_id ya vistos (BD + filas previas del archivo)
 * @property {Set<string>} seenPaymentKeys - claves de pago ya vistas (BD + filas previas del archivo)
 */

// ============================================
// PARSEO DE CELDAS Y HOJAS
// ============================================

/**
 * Parsea diferentes tipos de valores de fecha.
 *
 * @param {*} value - Valor a parsear
 * @returns {string|null} - Fecha en formato YYYY-MM-DD o null
 */
const parseDateValue = (value) => {
  if (!value) return null;

  let date;
  if (value instanceof Date) {
    date = dayjs(value);
  } else if (typeof value === 'number') {
    // Excel date serial
    date = dayjs(new Date((value - 25569) * 86400 * 1000));
  } else {
    date = dayjs(value);
  }

  return date.isValid() ? date.format('YYYY-MM-DD') : null;
};

/**
 * Extrae headers normalizados de una fila.
 *
 * @param {ExcelJS.Row} row - Fila de headers
 * @returns {Array<string>}
 */
const extractHeaders = (row) => {
  const headers = [];
  row.eachCell((cell) => {
    const value = cell.value ? String(cell.value).trim().toLowerCase().replace(/\s+/g, '_') : '';
    headers.push(value);
  });
  return headers;
};

/**
 * Normaliza el valor de una celda de ExcelJS a un tipo primitivo seguro para JSON.
 *
 * @param {*} cellValue - Valor crudo de la celda
 * @returns {string|number|boolean|null}
 */
const normalizeCellValue = (cellValue) => {
  if (cellValue === null || cellValue === undefined) return null;

  if (typeof cellValue === 'object' && Array.isArray(cellValue.richText)) {
    return cellValue.richText.map((chunk) => chunk.text || '').join('');
  }

  if (typeof cellValue === 'object' && 'result' in cellValue) {
    return normalizeCellValue(cellValue.result);
  }

  if (cellValue instanceof Date) return cellValue;
  if (typeof cellValue === 'boolean') return cellValue;
  if (typeof cellValue === 'number') return cellValue;

  return String(cellValue);
};

/**
 * Extrae datos de una fila usando headers.
 *
 * @param {ExcelJS.Row} row - Fila de datos
 * @param {Array<string>} headers - Headers normalizados
 * @returns {object}
 */
const extractRowData = (row, headers) => {
  const data = {};
  row.eachCell((cell, colNumber) => {
    const header = headers[colNumber - 1];
    if (header) {
      data[header] = normalizeCellValue(cell.value);
    }
  });
  return data;
};

/** Firmas de columnas para detectar el tipo de hoja de un CSV (una sola hoja, sin nombre). */
const SHEET_SIGNATURES = [
  { type: 'client', requires: ['external_client_id', 'nombres', 'apellidos'] },
  { type: 'loan', requires: ['external_loan_id', 'external_client_id', 'principal'] },
  { type: 'payment', requires: ['external_loan_id', 'monto', 'fecha_pago'] },
];

/**
 * Detecta el tipo de hoja (client/loan/payment) a partir de sus headers.
 * Usado solo para CSV, que no tiene nombres de hoja.
 *
 * @param {Array<string>} headers
 * @returns {string|null}
 */
const detectSheetType = (headers) => {
  const set = new Set(headers);
  const match = SHEET_SIGNATURES.find(({ requires }) => requires.every((h) => set.has(h)));
  return match ? match.type : null;
};

/**
 * Carga un archivo de importación (xlsx/xls/csv) y devuelve las hojas ya
 * identificadas por tipo. CSV solo puede traer un tipo por archivo (no
 * tiene concepto de hojas nombradas) — se detecta por firma de columnas.
 *
 * @param {Buffer} fileBuffer
 * @param {string} extension - '.xlsx' | '.xls' | '.csv'
 * @returns {Promise<{clientSheet: ExcelJS.Worksheet|null, loanSheet: ExcelJS.Worksheet|null, paymentSheet: ExcelJS.Worksheet|null}>}
 */
const loadWorkbookSheets = async (fileBuffer, extension) => {
  const workbook = new ExcelJS.Workbook();

  if (extension === '.csv') {
    const sheet = await workbook.csv.read(Readable.from(fileBuffer));
    const headerRow = sheet.getRow(1);
    const headers = extractHeaders(headerRow);
    const type = detectSheetType(headers);

    if (!type) {
      throw new Error(
        'No se pudo identificar el tipo de datos del CSV. Verifica que las columnas coincidan ' +
          'con la plantilla de clientes, préstamos o pagos.',
      );
    }

    return {
      clientSheet: type === 'client' ? sheet : null,
      loanSheet: type === 'loan' ? sheet : null,
      paymentSheet: type === 'payment' ? sheet : null,
    };
  }

  await workbook.xlsx.load(fileBuffer);
  return {
    clientSheet: workbook.getWorksheet('clientes'),
    loanSheet: workbook.getWorksheet('prestamos'),
    paymentSheet: workbook.getWorksheet('pagos'),
  };
};

// ============================================
// CONTEXTO DE VALIDACIÓN (evita N+1 queries por fila)
// ============================================

/**
 * Construye el contexto de validación: rutas y usuarios activos de la
 * organización, más los IDs externos ya existentes en BD — todo precargado
 * una sola vez para no golpear la base fila por fila.
 *
 * @param {string} organizationId
 * @returns {Promise<ImportContext>}
 */
const buildImportContext = async (organizationId) => {
  const [routes, users, existingClientIds, existingLoanIds] = await Promise.all([
    prisma.route.findMany({
      where: { organizationId, isActive: true },
      select: { id: true, name: true },
    }),
    prisma.user.findMany({
      where: { organizationId, isActive: true },
      select: { id: true, email: true, role: true },
    }),
    prisma.client.findMany({
      where: { organizationId, externalClientId: { not: null } },
      select: { externalClientId: true },
    }),
    prisma.loan.findMany({
      where: { organizationId, externalLoanId: { not: null } },
      select: { externalLoanId: true },
    }),
  ]);

  const collectors = users.filter((u) => u.role === 'COLLECTOR');

  return {
    routesByName: new Map(routes.map((r) => [r.name.trim().toLowerCase(), r.id])),
    usersByEmail: new Map(users.map((u) => [u.email.toLowerCase(), u.id])),
    defaultCollectorId: collectors[0]?.id ?? null,
    // Estos sets se usan tanto contra BD como para detectar duplicados
    // *dentro del mismo archivo* — se les hace .add() al validar cada fila.
    seenClientIds: new Set(existingClientIds.map((c) => c.externalClientId)),
    seenLoanIds: new Set(existingLoanIds.map((l) => l.externalLoanId)),
  };
};

// ============================================
// VALIDACIÓN POR FILA
// ============================================

/**
 * Valida datos de cliente.
 *
 * @param {object} rowData
 * @param {ImportContext} context
 * @returns {{data: object|null, errors: string[], warnings: string[]}}
 */
const validateClientData = (rowData, context) => {
  const errors = [];
  const warnings = [];

  const requiredFields = ['external_client_id', 'nombres', 'apellidos', 'numero_documento'];
  requiredFields.forEach((field) => {
    if (!rowData[field] || String(rowData[field]).trim() === '') {
      errors.push(`${field} es obligatorio`);
    }
  });

  const documentType = String(rowData.tipo_documento || 'CC').toUpperCase();
  if (!['CC', 'NIT', 'PEP'].includes(documentType)) {
    errors.push('tipo_documento debe ser CC, NIT o PEP');
  }

  if (errors.length > 0) return { data: null, errors, warnings };

  const externalClientId = String(rowData.external_client_id).trim();

  let routeId = null;
  const routeName = rowData.ruta ? String(rowData.ruta).trim() : null;
  if (routeName) {
    routeId = context.routesByName.get(routeName.toLowerCase()) ?? null;
    if (!routeId) {
      warnings.push(`Ruta "${routeName}" no encontrada — el cliente quedará sin ruta asignada`);
    }
  }

  const willUpdate = context.seenClientIds.has(externalClientId);
  context.seenClientIds.add(externalClientId);

  return {
    data: {
      externalClientId,
      firstName: String(rowData.nombres).trim(),
      lastName: String(rowData.apellidos).trim(),
      documentType,
      documentNumber: String(rowData.numero_documento).trim(),
      phone: rowData.telefono ? String(rowData.telefono).trim() : null,
      address: rowData.direccion ? String(rowData.direccion).trim() : null,
      routeId,
      isActive: rowData.activo !== false,
    },
    errors,
    warnings: willUpdate
      ? [...warnings, `Cliente "${externalClientId}" ya existe — se actualizará`]
      : warnings,
  };
};

/**
 * Valida datos de préstamo.
 *
 * @param {object} rowData
 * @param {ImportContext} context
 * @returns {{data: object|null, errors: string[], warnings: string[]}}
 */
const validateLoanData = (rowData, context) => {
  const errors = [];
  const warnings = [];

  const requiredFields = ['external_loan_id', 'external_client_id', 'principal', 'tasa_mensual'];
  requiredFields.forEach((field) => {
    if (!rowData[field] || String(rowData[field]).trim() === '') {
      errors.push(`${field} es obligatorio`);
    }
  });

  const principal = Number(rowData.principal);
  if (!principal || principal <= 0) {
    errors.push('principal debe ser mayor a 0');
  }

  const monthlyRate = Number(rowData.tasa_mensual);
  if (typeof monthlyRate !== 'number' || Number.isNaN(monthlyRate) || monthlyRate < 0 || monthlyRate > 1) {
    errors.push('tasa_mensual debe ser un decimal entre 0 y 1');
  }

  const disbursementDate = parseDateValue(rowData.fecha_desembolso);
  if (!disbursementDate) {
    errors.push('fecha_desembolso debe ser una fecha válida');
  }

  // Resolver cobrador en validación (no en ejecución): un email que no
  // matchea a nadie es un error bloqueante, no un fallback silencioso.
  const collectorEmail = rowData.cobrador ? String(rowData.cobrador).trim() : null;
  let collectorId = null;
  if (collectorEmail) {
    collectorId = context.usersByEmail.get(collectorEmail.toLowerCase()) ?? null;
    if (!collectorId) {
      errors.push(`cobrador con email "${collectorEmail}" no encontrado en la organización`);
    }
  } else {
    collectorId = context.defaultCollectorId;
    if (!collectorId) {
      errors.push('no hay cobradores activos en la organización para asignar por defecto');
    }
  }

  if (errors.length > 0) return { data: null, errors, warnings };

  const externalLoanId = String(rowData.external_loan_id).trim();
  const externalClientId = String(rowData.external_client_id).trim();

  if (context.seenLoanIds.has(externalLoanId)) {
    warnings.push(`Préstamo "${externalLoanId}" ya existe — esta fila se omitirá al confirmar`);
  }
  context.seenLoanIds.add(externalLoanId);

  return {
    data: {
      externalLoanId,
      externalClientId,
      principalAmount: principal,
      monthlyRate,
      termMonths: Number(rowData.plazo_meses) || 1,
      disbursementDate,
      frequency: String(rowData.frecuencia || 'DAILY').toUpperCase(),
      collectorId,
      status: String(rowData.estado || 'ACTIVE').toUpperCase(),
      notes: rowData.notas ? String(rowData.notas).trim() : null,
    },
    errors,
    warnings,
  };
};

/**
 * Valida datos de pago.
 *
 * @param {object} rowData
 * @param {ImportContext} context
 * @returns {{data: object|null, errors: string[], warnings: string[]}}
 */
const validatePaymentData = (rowData, context) => {
  const errors = [];
  const warnings = [];

  if (!rowData.external_loan_id) {
    errors.push('external_loan_id es obligatorio');
  }

  const amount = Number(rowData.monto);
  if (!amount || amount <= 0) {
    errors.push('monto debe ser mayor a 0');
  }

  const paymentDate = parseDateValue(rowData.fecha_pago);
  if (!paymentDate) {
    errors.push('fecha_pago debe ser una fecha válida');
  }

  const collectorEmail = rowData.cobrador ? String(rowData.cobrador).trim() : null;
  let collectorId = null;
  if (collectorEmail) {
    collectorId = context.usersByEmail.get(collectorEmail.toLowerCase()) ?? null;
    if (!collectorId) {
      errors.push(`cobrador con email "${collectorEmail}" no encontrado en la organización`);
    }
  } else {
    collectorId = context.defaultCollectorId;
    if (!collectorId) {
      errors.push('no hay cobradores activos en la organización para asignar por defecto');
    }
  }

  if (errors.length > 0) return { data: null, errors, warnings };

  const externalLoanId = String(rowData.external_loan_id).trim();
  const externalPaymentId = rowData.external_payment_id
    ? String(rowData.external_payment_id).trim()
    : null;

  // Idempotencia: con ID externo explícito, clave exacta; sin él, heurística
  // por préstamo+monto+fecha (mismo criterio que un re-envío del mismo archivo).
  const dedupeKey = externalPaymentId
    ? `id:${externalLoanId}:${externalPaymentId}`
    : `heur:${externalLoanId}:${amount}:${paymentDate}`;

  if (context.seenPaymentKeys.has(dedupeKey)) {
    warnings.push('Pago posiblemente duplicado (mismo préstamo, monto y fecha) — se omitirá al confirmar');
  }
  context.seenPaymentKeys.add(dedupeKey);

  return {
    data: {
      externalLoanId,
      externalPaymentId,
      amount,
      paymentDate,
      method: String(rowData.metodo || 'CASH').toUpperCase(),
      collectorId,
      notes: rowData.notas ? String(rowData.notas).trim() : null,
    },
    errors,
    warnings,
  };
};

const VALIDATORS = {
  client: validateClientData,
  loan: validateLoanData,
  payment: validatePaymentData,
};

/**
 * Parsea una hoja y valida cada fila.
 *
 * @param {ExcelJS.Worksheet} sheet
 * @param {string} type - 'client' | 'loan' | 'payment'
 * @param {ImportContext} context
 * @returns {Array<{rowNumber: number, sheetType: string, isValid: boolean, errors: string[], warnings: string[], rawData: object, data: object|null}>}
 */
const parseSheet = (sheet, type, context) => {
  const results = [];
  let headers = [];
  const validate = VALIDATORS[type];

  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) {
      headers = extractHeaders(row);
      return;
    }

    const rawData = extractRowData(row, headers);
    let outcome;
    try {
      outcome = validate(rawData, context);
    } catch (error) {
      outcome = { data: null, errors: [error.message], warnings: [] };
    }

    results.push({
      rowNumber,
      sheetType: type,
      isValid: outcome.errors.length === 0,
      errors: outcome.errors,
      warnings: outcome.warnings,
      rawData,
      data: outcome.data,
    });
  });

  return results;
};

// ============================================
// CREACIÓN DEL LOTE (reemplaza el preview en sesión)
// ============================================

/**
 * Parsea un archivo de importación y persiste el resultado como un
 * ImportBatch con sus ImportRow — reemplaza el preview basado en sesión.
 *
 * @param {object} params
 * @param {string} params.organizationId
 * @param {string} params.userId
 * @param {Buffer} params.fileBuffer
 * @param {string} params.fileName
 * @param {string} params.extension - '.xlsx' | '.xls' | '.csv'
 * @returns {Promise<{batchId: string, summary: object}>}
 */
export const createImportBatch = async ({ organizationId, userId, fileBuffer, fileName, extension }) => {
  const { clientSheet, loanSheet, paymentSheet } = await loadWorkbookSheets(fileBuffer, extension);

  if (!clientSheet && !loanSheet && !paymentSheet) {
    throw new Error(
      'El archivo debe contener al menos una hoja válida: clientes, prestamos o pagos',
    );
  }

  const context = await buildImportContext(organizationId);
  context.seenPaymentKeys = new Set(); // se llena solo con lo visto en este archivo (no hay forma barata de precargar todas las claves heurísticas de BD)

  const rows = [
    ...(clientSheet ? parseSheet(clientSheet, 'client', context) : []),
    ...(loanSheet ? parseSheet(loanSheet, 'loan', context) : []),
    ...(paymentSheet ? parseSheet(paymentSheet, 'payment', context) : []),
  ];

  const batch = await prisma.importBatch.create({
    data: {
      organizationId,
      userId,
      fileName,
      totalRows: rows.length,
      status: 'PENDING',
      rows: {
        create: rows.map((r) => ({
          sheetType: r.sheetType,
          rowNumber: r.rowNumber,
          status: r.isValid ? 'VALID' : 'INVALID',
          rawData: r.rawData,
          parsedData: r.data,
          errors: r.errors,
          warnings: r.warnings,
        })),
      },
    },
    select: { id: true },
  });

  const summary = {
    total: rows.length,
    valid: rows.filter((r) => r.isValid).length,
    invalid: rows.filter((r) => !r.isValid).length,
    warnings: rows.filter((r) => r.warnings.length > 0).length,
  };

  return { batchId: batch.id, summary };
};

// ============================================
// EJECUCIÓN — una fila, una transacción
// ============================================

/**
 * Crea o actualiza un cliente.
 *
 * @param {import('@prisma/client').Prisma.TransactionClient} tx
 * @param {string} organizationId
 * @param {object} data - Salida de validateClientData
 * @returns {Promise<{entityId: string, skipped: boolean}>}
 */
const processClientImport = async (tx, organizationId, data) => {
  const { externalClientId, ...fields } = data;

  const client = await tx.client.upsert({
    where: { organizationId_externalClientId: { organizationId, externalClientId } },
    create: { ...fields, organizationId, externalClientId },
    update: { ...fields },
    select: { id: true },
  });

  return { entityId: client.id, skipped: false };
};

/**
 * Crea un préstamo nuevo con su cronograma completo. Si el external_loan_id
 * ya existe, NO actualiza (podría corromper pagos ya aplicados) — se omite.
 *
 * @param {import('@prisma/client').Prisma.TransactionClient} tx
 * @param {string} organizationId
 * @param {object} data - Salida de validateLoanData
 * @returns {Promise<{entityId: string|null, skipped: boolean, reason?: string}>}
 */
const processLoanImport = async (tx, organizationId, data) => {
  const { externalLoanId, externalClientId, collectorId, ...fields } = data;

  const existing = await tx.loan.findFirst({
    where: { organizationId, externalLoanId },
    select: { id: true },
  });
  if (existing) {
    return { entityId: existing.id, skipped: true, reason: 'Ya existe (external_loan_id duplicado)' };
  }

  const client = await tx.client.findFirst({
    where: { organizationId, externalClientId },
    select: { id: true },
  });
  if (!client) {
    throw new Error(`Cliente con ID "${externalClientId}" no encontrado`);
  }

  const amortization = generateFixedDailySchedule({
    principal: fields.principalAmount,
    monthlyRate: fields.monthlyRate,
    termMonths: fields.termMonths,
    startDate: fields.disbursementDate,
    frequency: fields.frequency,
  });

  const loan = await tx.loan.create({
    data: {
      organizationId,
      clientId: client.id,
      collectorId,
      externalLoanId,
      status: fields.status,
      amortizationType: 'FIXED',
      paymentFrequency: fields.frequency,
      principalAmount: new Decimal(fields.principalAmount).toFixed(2),
      interestRate: new Decimal(fields.monthlyRate).toFixed(4),
      totalAmount: amortization.totalAmount,
      installmentAmount: amortization.installmentAmount,
      outstandingBalance: amortization.totalAmount,
      totalPaid: '0.00',
      interestPaid: '0.00',
      moraAmount: '0.00',
      numberOfPayments: amortization.numberOfPayments,
      paidPayments: 0,
      disbursementDate: new Date(fields.disbursementDate),
      expectedEndDate: new Date(amortization.expectedEndDate),
      notes: fields.notes,
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

  return { entityId: loan.id, skipped: false };
};

/**
 * Aplica un pago histórico sobre la cuota pendiente más antigua.
 *
 * @param {import('@prisma/client').Prisma.TransactionClient} tx
 * @param {string} organizationId
 * @param {object} data - Salida de validatePaymentData
 * @returns {Promise<{entityId: string|null, skipped: boolean, reason?: string}>}
 */
const processPaymentImport = async (tx, organizationId, data) => {
  const { externalLoanId, externalPaymentId, collectorId, ...fields } = data;

  const loan = await tx.loan.findFirst({
    where: { organizationId, externalLoanId },
    select: {
      id: true,
      outstandingBalance: true,
      totalPaid: true,
      interestPaid: true,
      moraAmount: true,
    },
  });

  if (!loan) {
    throw new Error(
      `Préstamo con ID externo "${externalLoanId}" no encontrado — ` +
        'verifica que el préstamo fue creado exitosamente en esta importación o que ya existe en el sistema',
    );
  }

  const collectedAt = new Date(fields.paymentDate);
  const amount = new Decimal(fields.amount);

  // Idempotencia: con ID externo, chequeo exacto; sin él, heurística por
  // préstamo+monto+fecha del mismo día.
  const existing = externalPaymentId
    ? await tx.payment.findFirst({ where: { loanId: loan.id, externalPaymentId }, select: { id: true } })
    : await tx.payment.findFirst({
        where: {
          loanId: loan.id,
          amount: amount.toFixed(2),
          collectedAt: {
            gte: dayjs(collectedAt).startOf('day').toDate(),
            lt: dayjs(collectedAt).endOf('day').toDate(),
          },
        },
        select: { id: true },
      });

  if (existing) {
    return { entityId: existing.id, skipped: true, reason: 'Pago posiblemente duplicado' };
  }

  const schedule = await tx.paymentSchedule.findFirst({
    where: { loanId: loan.id, isPaid: false, isRestructured: false },
    orderBy: { dueDate: 'asc' },
  });

  let paymentScheduleId = null;
  let split;
  let paymentType;

  if (schedule) {
    split = splitPayment(amount.toFixed(2), loan.moraAmount, schedule.interestDue, schedule.principalDue);
    paymentType = classifyPayment(split, schedule.interestDue, schedule.principalDue, loan.outstandingBalance);
    paymentScheduleId = schedule.id;

    await tx.paymentSchedule.update({
      where: { id: schedule.id },
      data: {
        amountPaid: new Decimal(schedule.amountPaid).plus(amount).toFixed(2),
        ...(paymentType !== 'PARTIAL_INTEREST' && { isPaid: true, paidAt: collectedAt }),
      },
    });
  } else {
    // Sin cuota pendiente: distribución proporcional fija para pagos importados sin
    // cronograma asociado (no hay forma de saber la composición real capital/interés).
    const interestRate = new Decimal(loan.outstandingBalance).gt(0) ? new Decimal('0.30') : new Decimal('0');
    const interestPortion = amount.times(interestRate).toDecimalPlaces(2);
    split = {
      moraApplied: '0.00',
      interestApplied: interestPortion.toFixed(2),
      principalApplied: amount.minus(interestPortion).toFixed(2),
      excess: '0.00',
    };
    paymentType = 'FULL';
  }

  const payment = await tx.payment.create({
    data: {
      loanId: loan.id,
      paymentScheduleId,
      collectorId,
      externalPaymentId,
      amount: amount.toFixed(2),
      totalReceived: amount.toFixed(2),
      principalApplied: split.principalApplied,
      interestApplied: split.interestApplied,
      moraAmount: split.moraApplied,
      paymentMethod: fields.method || 'CASH',
      paymentType,
      notes: fields.notes,
      collectedAt,
    },
  });

  const newTotalPaid = new Decimal(loan.totalPaid).plus(split.principalApplied).plus(split.interestApplied);
  const newOutstanding = Decimal.max(
    new Decimal(loan.outstandingBalance).minus(split.principalApplied).minus(split.interestApplied),
    0,
  );
  const newInterestPaid = new Decimal(loan.interestPaid).plus(split.interestApplied);
  const newMora = Decimal.max(new Decimal(loan.moraAmount).minus(split.moraApplied ?? 0), 0);
  const isCompleted = paymentType === 'PAYOFF' || newOutstanding.eq(0);

  await tx.loan.update({
    where: { id: loan.id },
    data: {
      totalPaid: newTotalPaid.toFixed(2),
      outstandingBalance: newOutstanding.toFixed(2),
      interestPaid: newInterestPaid.toFixed(2),
      moraAmount: newMora.toFixed(2),
      paidPayments: { increment: 1 },
      ...(isCompleted && { status: 'COMPLETED', actualEndDate: collectedAt }),
    },
  });

  return { entityId: payment.id, skipped: false };
};

const PROCESSORS = {
  client: processClientImport,
  loan: processLoanImport,
  payment: processPaymentImport,
};

/**
 * Procesa UNA fila en su propia transacción — un error de esta fila
 * (ej. constraint de BD) nunca afecta a las demás, a diferencia del
 * enfoque anterior de una sola transacción para todo el lote.
 *
 * @param {object} row - ImportRow de Prisma
 * @param {string} organizationId
 * @returns {Promise<void>}
 */
const processImportRow = async (row, organizationId) => {
  const processor = PROCESSORS[row.sheetType];

  try {
    const result = await prisma.$transaction(
      (tx) => processor(tx, organizationId, row.parsedData),
      { timeout: 20000 },
    );

    await prisma.importRow.update({
      where: { id: row.id },
      data: {
        status: result.skipped ? 'SKIPPED' : 'IMPORTED',
        entityId: result.entityId,
        warnings: result.skipped ? [result.reason] : row.warnings,
      },
    });
  } catch (error) {
    await prisma.importRow.update({
      where: { id: row.id },
      data: { status: 'FAILED', errors: [error.message] },
    });
  }
};

/**
 * Ejecuta un lote de importación: procesa cada fila VALID en su propia
 * transacción, en orden clientes → préstamos → pagos (los préstamos
 * dependen de clientes recién creados, los pagos de préstamos recién
 * creados). Emite progreso en vivo por Socket.io si está disponible.
 *
 * @param {string} batchId
 * @returns {Promise<object>} Resumen final del lote
 */
export const runImportBatch = async (batchId) => {
  const batch = await prisma.importBatch.findUniqueOrThrow({ where: { id: batchId } });
  const io = getIO();

  await prisma.importBatch.update({
    where: { id: batchId },
    data: { status: 'PROCESSING', startedAt: new Date() },
  });

  const emitProgress = async () => {
    const current = await prisma.importBatch.findUnique({
      where: { id: batchId },
      select: { totalRows: true, processedRows: true, successRows: true, errorRows: true },
    });
    io?.emit('import:progress', { batchId, ...current });
  };

  for (const sheetType of ['client', 'loan', 'payment']) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await prisma.importRow.findMany({
      where: { batchId, sheetType, status: 'VALID' },
      orderBy: { rowNumber: 'asc' },
    });

    for (const row of rows) {
      // eslint-disable-next-line no-await-in-loop
      await processImportRow(row, batch.organizationId);
      // eslint-disable-next-line no-await-in-loop
      const updated = await prisma.importRow.findUnique({ where: { id: row.id }, select: { status: true } });
      // eslint-disable-next-line no-await-in-loop
      await prisma.importBatch.update({
        where: { id: batchId },
        data: {
          processedRows: { increment: 1 },
          ...(updated.status === 'IMPORTED' || updated.status === 'SKIPPED'
            ? { successRows: { increment: 1 } }
            : { errorRows: { increment: 1 } }),
        },
      });
      // eslint-disable-next-line no-await-in-loop
      await emitProgress();
    }
  }

  const finalCounts = await prisma.importRow.groupBy({
    by: ['status'],
    where: { batchId },
    _count: true,
  });
  const failedOrInvalid = finalCounts
    .filter((c) => c.status === 'FAILED' || c.status === 'INVALID')
    .reduce((sum, c) => sum + c._count, 0);

  const finalStatus = failedOrInvalid > 0 ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED';

  await prisma.importBatch.update({
    where: { id: batchId },
    data: { status: finalStatus, completedAt: new Date() },
  });

  io?.emit('import:completed', { batchId, status: finalStatus });

  return prisma.importBatch.findUnique({ where: { id: batchId } });
};

// ============================================
// CORRECCIÓN DE FILA SIN RESUBIR EL ARCHIVO
// ============================================

/**
 * Revalida una fila con datos corregidos por el usuario, sin necesidad de
 * resubir el archivo completo.
 *
 * @param {string} rowId
 * @param {object} editedRawData - rawData editado (mismas keys que la fila original)
 * @returns {Promise<object>} La fila actualizada
 */
export const retryRow = async (rowId, editedRawData) => {
  const row = await prisma.importRow.findUniqueOrThrow({
    where: { id: rowId },
    include: { batch: { select: { organizationId: true } } },
  });

  const context = await buildImportContext(row.batch.organizationId);
  context.seenPaymentKeys = new Set();
  // Al corregir una fila puntual no queremos que su propio external_id
  // previo se marque como "duplicado de sí mismo" — se remueve del set
  // antes de validar si esta fila ya había sido contabilizada.
  if (row.sheetType === 'loan' && row.parsedData?.externalLoanId) {
    context.seenLoanIds.delete(row.parsedData.externalLoanId);
  }
  if (row.sheetType === 'client' && row.parsedData?.externalClientId) {
    context.seenClientIds.delete(row.parsedData.externalClientId);
  }

  const validate = VALIDATORS[row.sheetType];
  const outcome = validate(editedRawData, context);

  return prisma.importRow.update({
    where: { id: rowId },
    data: {
      rawData: editedRawData,
      parsedData: outcome.data,
      status: outcome.errors.length === 0 ? 'VALID' : 'INVALID',
      errors: outcome.errors,
      warnings: outcome.warnings,
    },
  });
};

// ============================================
// REPORTE DE ERRORES DESCARGABLE
// ============================================

const SHEET_LABELS = { client: 'clientes', loan: 'prestamos', payment: 'pagos' };

/**
 * Genera un Excel con solo las filas fallidas/inválidas de un lote, en el
 * mismo formato de columnas que el archivo de entrada, más una columna de
 * errores — pensado para corregir y resubir.
 *
 * @param {string} batchId
 * @returns {Promise<Buffer>}
 */
export const generateErrorReportBuffer = async (batchId) => {
  const rows = await prisma.importRow.findMany({
    where: { batchId, status: { in: ['INVALID', 'FAILED'] } },
    orderBy: [{ sheetType: 'asc' }, { rowNumber: 'asc' }],
  });

  const workbook = new ExcelJS.Workbook();

  for (const type of ['client', 'loan', 'payment']) {
    const typeRows = rows.filter((r) => r.sheetType === type);
    if (typeRows.length === 0) continue;

    const sheet = workbook.addWorksheet(SHEET_LABELS[type]);
    const columns = Object.keys(typeRows[0].rawData);
    sheet.addRow([...columns, 'fila_original', 'errores']);
    sheet.getRow(1).font = { bold: true };

    typeRows.forEach((row) => {
      const values = columns.map((c) => row.rawData[c] ?? '');
      const errors = Array.isArray(row.errors) ? row.errors.join('; ') : '';
      sheet.addRow([...values, row.rowNumber, errors]);
    });

    sheet.columns.forEach((col) => { col.width = 22; });
  }

  if (workbook.worksheets.length === 0) {
    workbook.addWorksheet('sin_errores').addRow(['Este lote no tiene filas con errores']);
  }

  return workbook.xlsx.writeBuffer();
};

// ============================================
// PLANTILLAS DE IMPORTACIÓN
// ============================================

const ENUM_VALIDATIONS = {
  tipo_documento: ['CC', 'NIT', 'PEP'],
  estado: ['ACTIVE', 'COMPLETED', 'DEFAULTED', 'CANCELLED'],
  frecuencia: ['DAILY', 'WEEKLY', 'BIWEEKLY', 'MONTHLY'],
  metodo: ['CASH', 'TRANSFER', 'CHECK', 'MOBILE_PAYMENT'],
  activo: ['TRUE', 'FALSE'],
};

/**
 * Aplica estilo de header, ancho de columnas y dropdowns de validación de
 * datos (Excel nativo) a las columnas con valores enumerados conocidos.
 *
 * @param {ExcelJS.Worksheet} sheet
 * @param {Array<string>} columns
 */
const styleTemplateSheet = (sheet, columns) => {
  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0A1628' } };

  columns.forEach((col, index) => {
    sheet.getColumn(index + 1).width = 20;
    const options = ENUM_VALIDATIONS[col];
    if (!options) return;

    const colLetter = sheet.getColumn(index + 1).letter;
    // eslint-disable-next-line no-plusplus
    for (let r = 2; r <= 500; r++) {
      sheet.getCell(`${colLetter}${r}`).dataValidation = {
        type: 'list',
        allowBlank: true,
        formulae: [`"${options.join(',')}"`],
        showErrorMessage: true,
        errorTitle: 'Valor inválido',
        error: `Debe ser uno de: ${options.join(', ')}`,
      };
    }
  });
};

const addInstructionsSheet = (workbook, sections) => {
  const sheet = workbook.addWorksheet('instrucciones');
  sheet.getColumn(1).width = 22;
  sheet.getColumn(2).width = 14;
  sheet.getColumn(3).width = 55;

  sheet.addRow(['Cómo llenar esta plantilla']).font = { bold: true, size: 14 };
  sheet.addRow([]);

  sections.forEach(({ title, columns }) => {
    const titleRow = sheet.addRow([title]);
    titleRow.font = { bold: true, size: 12 };
    const headerRow = sheet.addRow(['Columna', 'Obligatorio', 'Descripción']);
    headerRow.font = { bold: true };
    columns.forEach(([name, required, description]) => {
      sheet.addRow([name, required ? 'Sí' : 'No', description]);
    });
    sheet.addRow([]);
  });
};

/**
 * Genera una plantilla Excel con hoja de instrucciones, headers con estilo,
 * dropdowns de validación de datos y varias filas de ejemplo.
 *
 * @param {string} type - 'complete' | 'clients' | 'loans' | 'payments'
 * @returns {Promise<Buffer>}
 */
const TEMPLATE_SHEETS = {
  clients: {
    sheetName: 'clientes',
    instructionTitle: 'Hoja "clientes"',
    columns: ['external_client_id', 'nombres', 'apellidos', 'tipo_documento', 'numero_documento', 'telefono', 'direccion', 'ruta', 'activo'],
    columnDocs: [
      ['external_client_id', true, 'ID único del cliente en tu sistema actual (para referenciarlo desde préstamos)'],
      ['nombres', true, 'Nombres del cliente'],
      ['apellidos', true, 'Apellidos del cliente'],
      ['tipo_documento', false, 'CC, NIT o PEP — por defecto CC'],
      ['numero_documento', true, 'Número de documento'],
      ['telefono', false, 'Teléfono de contacto'],
      ['direccion', false, 'Dirección física'],
      ['ruta', false, 'Nombre exacto de una ruta ya creada en el sistema (opcional)'],
      ['activo', false, 'TRUE o FALSE — por defecto TRUE'],
    ],
    exampleRows: [
      ['CLI001', 'Juan Carlos', 'Pérez González', 'CC', '12345678', '3001234567', 'Calle 123 #45-67', 'Ruta Centro', true],
      ['CLI002', 'María Fernanda', 'Gómez Ruiz', 'CC', '87654321', '3009876543', 'Cra 45 #12-30', '', true],
    ],
  },
  loans: {
    sheetName: 'prestamos',
    instructionTitle: 'Hoja "prestamos"',
    columns: ['external_loan_id', 'external_client_id', 'principal', 'tasa_mensual', 'plazo_meses', 'fecha_desembolso', 'frecuencia', 'cobrador', 'estado', 'notas'],
    columnDocs: [
      ['external_loan_id', true, 'ID único del préstamo en tu sistema actual'],
      ['external_client_id', true, 'Debe coincidir con un external_client_id de la hoja "clientes"'],
      ['principal', true, 'Monto prestado (número, sin símbolos)'],
      ['tasa_mensual', true, 'Tasa de interés mensual como decimal (0.03 = 3%)'],
      ['plazo_meses', false, 'Duración del préstamo en meses — por defecto 1'],
      ['fecha_desembolso', true, 'Formato AAAA-MM-DD'],
      ['frecuencia', false, 'DAILY, WEEKLY, BIWEEKLY o MONTHLY — por defecto DAILY'],
      ['cobrador', false, 'Email de un cobrador activo — si se omite, se asigna uno por defecto'],
      ['estado', false, 'ACTIVE, COMPLETED, DEFAULTED o CANCELLED — por defecto ACTIVE'],
      ['notas', false, 'Notas internas'],
    ],
    exampleRows: [
      ['LOAN001', 'CLI001', 500000, 0.03, 12, '2026-04-06', 'MONTHLY', 'cobrador@empresa.com', 'ACTIVE', 'Préstamo ejemplo mensual'],
      ['LOAN002', 'CLI002', 300000, 0.2, 1, '2026-04-06', 'DAILY', '', 'ACTIVE', 'Préstamo ejemplo diario'],
    ],
  },
  payments: {
    sheetName: 'pagos',
    instructionTitle: 'Hoja "pagos"',
    columns: ['external_loan_id', 'external_payment_id', 'monto', 'fecha_pago', 'metodo', 'cobrador', 'notas'],
    columnDocs: [
      ['external_loan_id', true, 'Debe coincidir con un external_loan_id de la hoja "prestamos" (o uno ya existente en el sistema)'],
      ['external_payment_id', false, 'ID único del pago en tu sistema — recomendado para evitar duplicados al re-importar'],
      ['monto', true, 'Monto pagado (número, sin símbolos)'],
      ['fecha_pago', true, 'Formato AAAA-MM-DD'],
      ['metodo', false, 'CASH, TRANSFER, CHECK o MOBILE_PAYMENT — por defecto CASH'],
      ['cobrador', false, 'Email de un cobrador activo — si se omite, se asigna uno por defecto'],
      ['notas', false, 'Notas internas'],
    ],
    exampleRows: [
      ['LOAN001', 'PAY001', 50000, '2026-04-07', 'CASH', 'cobrador@empresa.com', 'Pago inicial'],
      ['LOAN002', 'PAY002', 18000, '2026-04-07', 'TRANSFER', '', 'Pago vía transferencia'],
    ],
  },
};

/**
 * Genera una plantilla Excel con hoja de instrucciones, headers con estilo,
 * dropdowns de validación de datos y varias filas de ejemplo.
 *
 * @param {string} type - 'complete' | 'clients' | 'loans' | 'payments'
 * @returns {Promise<Buffer>}
 */
export const generateTemplate = async (type) => {
  const keys = type === 'complete' ? ['clients', 'loans', 'payments'] : [type];
  const sections = keys
    .filter((k) => TEMPLATE_SHEETS[k])
    .map((k) => ({ title: TEMPLATE_SHEETS[k].instructionTitle, columns: TEMPLATE_SHEETS[k].columnDocs }));

  const workbook = new ExcelJS.Workbook();

  // La hoja de instrucciones se agrega primero para que quede como la
  // primera pestaña visible (ExcelJS no permite reordenar `worksheets`
  // después de creadas, así que el orden de creación es el orden final).
  addInstructionsSheet(workbook, sections);

  keys.forEach((key) => {
    const def = TEMPLATE_SHEETS[key];
    if (!def) return;

    const sheet = workbook.addWorksheet(def.sheetName);
    sheet.addRow(def.columns);
    def.exampleRows.forEach((row) => sheet.addRow(row));
    styleTemplateSheet(sheet, def.columns);
  });

  return workbook.xlsx.writeBuffer();
};
