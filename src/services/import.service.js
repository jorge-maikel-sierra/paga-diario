import ExcelJS from 'exceljs';
import Decimal from 'decimal.js';
import dayjs from 'dayjs';
import prisma from '../config/prisma.js';

/**
 * @typedef {object} ImportPreview
 * @property {Array} clients - Resultados de validación de clientes
 * @property {Array} loans - Resultados de validación de préstamos
 * @property {Array} payments - Resultados de validación de pagos
 * @property {object} summary - Resumen de la importación
 * @property {string} fileName - Nombre del archivo
 */

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
 * ExcelJS puede retornar objetos RichText, fórmulas o fechas — los convertimos aquí
 * para evitar errores de serialización al guardar el preview en la sesión.
 *
 * @param {*} cellValue - Valor crudo de la celda
 * @returns {string|number|boolean|null}
 */
const normalizeCellValue = (cellValue) => {
  if (cellValue === null || cellValue === undefined) return null;

  // Objeto RichText de ExcelJS: { richText: [{ text: '...' }] }
  if (typeof cellValue === 'object' && Array.isArray(cellValue.richText)) {
    return cellValue.richText.map((chunk) => chunk.text || '').join('');
  }

  // Resultado de fórmula: { formula: '...', result: valor }
  if (typeof cellValue === 'object' && 'result' in cellValue) {
    return normalizeCellValue(cellValue.result);
  }

  // Fecha nativa de JS (ExcelJS la convierte cuando el formato es fecha)
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

/**
 * Valida datos de cliente.
 *
 * @param {object} rowData - Datos de la fila
 * @param {Array} errors - Array para acumular errores
 * @returns {object|null}
 */
const validateClientData = (rowData, errors) => {
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

  if (errors.length > 0) return null;

  return {
    externalClientId: String(rowData.external_client_id).trim(),
    firstName: String(rowData.nombres).trim(),
    lastName: String(rowData.apellidos).trim(),
    documentType,
    documentNumber: String(rowData.numero_documento).trim(),
    phone: rowData.telefono ? String(rowData.telefono).trim() : null,
    address: rowData.direccion ? String(rowData.direccion).trim() : null,
    routeName: rowData.ruta ? String(rowData.ruta).trim() : null,
    isActive: rowData.activo !== false,
  };
};

/**
 * Valida datos de préstamo.
 *
 * @param {object} rowData - Datos de la fila
 * @param {Array} errors - Array para acumular errores
 * @returns {object|null}
 */
const validateLoanData = (rowData, errors) => {
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
  if (typeof monthlyRate !== 'number' || monthlyRate < 0 || monthlyRate > 1) {
    errors.push('tasa_mensual debe ser un decimal entre 0 y 1');
  }

  const disbursementDate = parseDateValue(rowData.fecha_desembolso);
  if (!disbursementDate) {
    errors.push('fecha_desembolso debe ser una fecha válida');
  }

  if (errors.length > 0) return null;

  return {
    externalLoanId: String(rowData.external_loan_id).trim(),
    externalClientId: String(rowData.external_client_id).trim(),
    principalAmount: principal,
    monthlyRate,
    termMonths: Number(rowData.plazo_meses) || 1,
    disbursementDate,
    frequency: String(rowData.frecuencia || 'DAILY').toUpperCase(),
    collectorEmail: rowData.cobrador ? String(rowData.cobrador).trim() : null,
    status: String(rowData.estado || 'ACTIVE').toUpperCase(),
    notes: rowData.notas ? String(rowData.notas).trim() : null,
  };
};

/**
 * Valida datos de pago.
 *
 * @param {object} rowData - Datos de la fila
 * @param {Array} errors - Array para acumular errores
 * @returns {object|null}
 */
const validatePaymentData = (rowData, errors) => {
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

  if (errors.length > 0) return null;

  return {
    externalLoanId: String(rowData.external_loan_id).trim(),
    amount,
    paymentDate,
    method: String(rowData.metodo || 'CASH').toUpperCase(),
    collectorEmail: rowData.cobrador ? String(rowData.cobrador).trim() : null,
    notes: rowData.notas ? String(rowData.notas).trim() : null,
  };
};

/**
 * Valida una fila según su tipo.
 *
 * @param {object} rowData - Datos de la fila
 * @param {string} type - Tipo de validación
 * @param {number} rowNumber - Número de fila
 * @returns {object}
 */
const validateRow = (rowData, type, rowNumber) => {
  const errors = [];
  let data = null;

  try {
    switch (type) {
      case 'client':
        data = validateClientData(rowData, errors);
        break;
      case 'loan':
        data = validateLoanData(rowData, errors);
        break;
      case 'payment':
        data = validatePaymentData(rowData, errors);
        break;
      default:
        errors.push('Tipo de validación desconocido');
    }
  } catch (error) {
    errors.push(error.message);
  }

  return {
    rowNumber,
    isValid: errors.length === 0,
    errors,
    data,
  };
};

/**
 * Parsea una hoja de Excel genérica.
 *
 * @param {ExcelJS.Worksheet} sheet - Hoja de Excel
 * @param {string} type - Tipo de hoja (client, loan, payment)
 * @returns {Array}
 */
const parseSheet = (sheet, type) => {
  const results = [];
  let headers = [];

  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) {
      headers = extractHeaders(row);
      return;
    }

    const rowData = extractRowData(row, headers);
    const validation = validateRow(rowData, type, rowNumber);
    results.push(validation);
  });

  return results;
};

/**
 * Genera resumen de una hoja.
 *
 * @param {Array} results - Resultados de validación
 * @returns {object}
 */
const getSheetSummary = (results) => ({
  total: results.length,
  valid: results.filter((r) => r.isValid).length,
  invalid: results.filter((r) => !r.isValid).length,
});

/**
 * Parsea un archivo Excel de importación y genera un preview de validación.
 *
 * Estructura esperada:
 * - Hoja 'clientes': external_client_id, nombres, apellidos, tipo_documento,
 *   numero_documento, telefono, direccion, ruta, activo
 * - Hoja 'prestamos': external_loan_id, external_client_id, principal,
 *   tasa_mensual, plazo_meses, fecha_desembolso, frecuencia, cobrador, estado
 * - Hoja 'pagos': external_loan_id, monto, fecha_pago, metodo, cobrador, notas
 *
 * @param {Buffer} fileBuffer - Buffer del archivo Excel
 * @param {string} fileName - Nombre del archivo
 * @returns {Promise<ImportPreview>}
 */
export const parseImportFile = async (fileBuffer, fileName) => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(fileBuffer);

  const clientSheet = workbook.getWorksheet('clientes');
  const loanSheet = workbook.getWorksheet('prestamos');
  const paymentSheet = workbook.getWorksheet('pagos');

  if (!clientSheet && !loanSheet && !paymentSheet) {
    throw new Error(
      'El archivo debe contener al menos una hoja válida: clientes, prestamos o pagos',
    );
  }

  const results = {
    clients: clientSheet ? parseSheet(clientSheet, 'client') : [],
    loans: loanSheet ? parseSheet(loanSheet, 'loan') : [],
    payments: paymentSheet ? parseSheet(paymentSheet, 'payment') : [],
    fileName,
  };

  results.summary = {
    clients: getSheetSummary(results.clients),
    loans: getSheetSummary(results.loans),
    payments: getSheetSummary(results.payments),
  };

  return results;
};

/**
 * Procesa la importación de un cliente.
 */
const processClientImport = async (tx, organizationId, clientData) => {
  const { externalClientId, routeName, ...fields } = clientData;

  // Buscar ruta si se especificó
  let routeId = null;
  if (routeName) {
    const route = await tx.route.findFirst({
      where: { organizationId, name: routeName, isActive: true },
      select: { id: true },
    });
    routeId = route?.id || null;
  }

  // Crear o actualizar cliente
  await tx.client.upsert({
    where: {
      organizationId_externalClientId: {
        organizationId,
        externalClientId,
      },
    },
    create: {
      ...fields,
      organizationId,
      externalClientId,
      routeId,
    },
    update: {
      ...fields,
      routeId,
    },
  });
};

/**
 * Procesa la importación de un préstamo.
 */
const processLoanImport = async (tx, organizationId, loanData) => {
  const { externalLoanId, externalClientId, collectorEmail, ...fields } = loanData;

  // Buscar cliente
  const client = await tx.client.findFirst({
    where: { organizationId, externalClientId },
    select: { id: true },
  });

  if (!client) {
    throw new Error(`Cliente con ID "${externalClientId}" no encontrado`);
  }

  // Buscar cobrador por email (cualquier rol activo). Si el email no existe en la org
  // se hace fallback al primer COLLECTOR activo — permite importar archivos con emails
  // de ejemplo sin bloquear toda la fila.
  let collectorId;
  if (collectorEmail) {
    const collector = await tx.user.findFirst({
      where: { organizationId, email: collectorEmail, isActive: true },
      select: { id: true },
    });
    collectorId = collector?.id ?? null;
  }

  if (!collectorId) {
    const defaultCollector = await tx.user.findFirst({
      where: { organizationId, role: 'COLLECTOR', isActive: true },
      select: { id: true },
    });
    if (!defaultCollector) {
      throw new Error('No hay cobradores activos en esta organización');
    }
    collectorId = defaultCollector.id;
  }

  const principal = new Decimal(fields.principalAmount);
  const rate = new Decimal(fields.monthlyRate);
  const totalWithInterest = principal.times(rate.times(fields.termMonths).plus(1));

  // Crear préstamo básico (sin cronograma completo por simplicidad)
  await tx.loan.create({
    data: {
      organizationId,
      clientId: client.id,
      collectorId,
      externalLoanId,
      principalAmount: principal,
      interestRate: rate,
      totalAmount: totalWithInterest,
      installmentAmount: totalWithInterest.dividedBy(fields.termMonths),
      outstandingBalance: totalWithInterest,
      numberOfPayments: fields.termMonths,
      paymentFrequency: fields.frequency,
      disbursementDate: new Date(fields.disbursementDate),
      expectedEndDate: dayjs(fields.disbursementDate).add(fields.termMonths, 'month').toDate(),
      status: fields.status,
      notes: fields.notes,
    },
  });
};

/**
 * Procesa la importación de un pago.
 */
const processPaymentImport = async (tx, organizationId, paymentData) => {
  const { externalLoanId, collectorEmail, ...fields } = paymentData;

  // Buscar préstamo
  const loan = await tx.loan.findFirst({
    where: { organizationId, externalLoanId },
    select: { id: true },
  });

  if (!loan) {
    throw new Error(
      `Préstamo con ID externo "${externalLoanId}" no encontrado — ` +
        'verifica que el préstamo fue creado exitosamente en esta importación o que ya existe en el sistema',
    );
  }

  // Buscar cobrador por email (cualquier rol activo). Si el email no existe en la org
  // se hace fallback al primer COLLECTOR activo — permite importar archivos con emails
  // de ejemplo sin bloquear toda la fila.
  let collectorId;
  if (collectorEmail) {
    const collector = await tx.user.findFirst({
      where: { organizationId, email: collectorEmail, isActive: true },
      select: { id: true },
    });
    collectorId = collector?.id ?? null;
  }

  if (!collectorId) {
    const defaultCollector = await tx.user.findFirst({
      where: { organizationId, role: 'COLLECTOR', isActive: true },
      select: { id: true },
    });
    if (!defaultCollector) {
      throw new Error('No hay cobradores activos disponibles en esta organización');
    }
    collectorId = defaultCollector.id;
  }

  const amount = new Decimal(fields.amount);
  const principalPortion = amount.times(0.7);
  const interestPortion = amount.times(0.3);

  // Crear pago histórico
  await tx.payment.create({
    data: {
      loanId: loan.id,
      collectorId,
      amount,
      totalReceived: amount,
      paymentMethod: fields.method,
      notes: fields.notes,
      collectedAt: new Date(fields.paymentDate),
      // Distribución simplificada para pagos históricos
      principalApplied: principalPortion,
      interestApplied: interestPortion,
      paymentType: 'FULL',
    },
  });
};

/**
 * Ejecuta la importación confirmada usando array methods.
 *
 * @param {string} organizationId - UUID de la organización
 * @param {ImportPreview} importData - Datos validados
 * @returns {Promise<object>}
 */
export const executeImport = async (organizationId, importData) => {
  const results = {
    clients: { created: 0, updated: 0, errors: [] },
    loans: { created: 0, errors: [] },
    payments: { created: 0, errors: [] },
    duration: 0,
  };

  const startTime = Date.now();

  try {
    await prisma.$transaction(
      async (tx) => {
        // Los tres grupos se procesan en secuencia estricta: clientes → préstamos → pagos.
        // Préstamos dependen de clientes recién insertados, pagos dependen de préstamos
        // recién insertados — reduce garantiza ejecución serial sin Promise.all en paralelo.

        const validClients = importData.clients.filter((item) => item.isValid);
        await validClients.reduce(async (prev, item) => {
          await prev;
          try {
            await processClientImport(tx, organizationId, item.data);
            results.clients.created += 1;
          } catch (error) {
            results.clients.errors.push({ row: item.rowNumber, error: error.message });
          }
        }, Promise.resolve());

        const validLoans = importData.loans.filter((item) => item.isValid);
        await validLoans.reduce(async (prev, item) => {
          await prev;
          try {
            await processLoanImport(tx, organizationId, item.data);
            results.loans.created += 1;
          } catch (error) {
            results.loans.errors.push({ row: item.rowNumber, error: error.message });
          }
        }, Promise.resolve());

        const validPayments = importData.payments.filter((item) => item.isValid);
        await validPayments.reduce(async (prev, item) => {
          await prev;
          try {
            await processPaymentImport(tx, organizationId, item.data);
            results.payments.created += 1;
          } catch (error) {
            results.payments.errors.push({ row: item.rowNumber, error: error.message });
          }
        }, Promise.resolve());
      },
      { timeout: 60000 },
    );

    results.duration = Date.now() - startTime;
    return results;
  } catch (error) {
    throw new Error(`Error en la importación: ${error.message}`);
  }
};
