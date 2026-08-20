import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import ExcelJS from 'exceljs';

const mockImportBatchCreate = jest.fn();
const mockRouteFindMany = jest.fn();
const mockUserFindMany = jest.fn();
const mockClientFindMany = jest.fn();
const mockLoanFindMany = jest.fn();

jest.unstable_mockModule('../../src/config/prisma.js', () => ({
  default: {
    route: { findMany: mockRouteFindMany },
    user: { findMany: mockUserFindMany },
    client: { findMany: mockClientFindMany },
    loan: { findMany: mockLoanFindMany },
    importBatch: { create: mockImportBatchCreate },
  },
}));

const { createImportBatch } = await import('../../src/services/import.service.js');

/** Construye un buffer .xlsx en memoria con las hojas indicadas. */
const buildXlsxBuffer = async (sheets) => {
  const workbook = new ExcelJS.Workbook();
  Object.entries(sheets).forEach(([name, rows]) => {
    const sheet = workbook.addWorksheet(name);
    rows.forEach((row) => sheet.addRow(row));
  });
  return workbook.xlsx.writeBuffer();
};

const CLIENT_HEADERS = [
  'external_client_id', 'nombres', 'apellidos', 'tipo_documento', 'numero_documento', 'telefono', 'direccion', 'ruta', 'activo',
];
const LOAN_HEADERS = [
  'external_loan_id', 'external_client_id', 'principal', 'tasa_mensual', 'plazo_meses', 'fecha_desembolso', 'frecuencia', 'cobrador', 'estado', 'notas',
];

beforeEach(() => {
  jest.clearAllMocks();
  mockRouteFindMany.mockResolvedValue([]);
  mockUserFindMany.mockResolvedValue([{ id: 'collector-1', email: 'cobrador@empresa.com', role: 'COLLECTOR' }]);
  mockClientFindMany.mockResolvedValue([]);
  mockLoanFindMany.mockResolvedValue([]);
  mockImportBatchCreate.mockResolvedValue({ id: 'batch-1' });
});

describe('import.service — createImportBatch', () => {
  it('parsea un CSV real (no solo xlsx) detectando el tipo de hoja por sus columnas', async () => {
    const csv = [
      CLIENT_HEADERS.join(','),
      'CLI001,Juan,Perez,CC,12345678,3001234567,Calle 1,,true',
    ].join('\n');

    const result = await createImportBatch({
      organizationId: 'org-1',
      userId: 'user-1',
      fileBuffer: Buffer.from(csv, 'utf-8'),
      fileName: 'clientes.csv',
      extension: '.csv',
    });

    expect(result.summary.total).toBe(1);
    expect(result.summary.valid).toBe(1);

    const createdRows = mockImportBatchCreate.mock.calls[0][0].data.rows.create;
    expect(createdRows).toHaveLength(1);
    expect(createdRows[0].sheetType).toBe('client');
    expect(createdRows[0].status).toBe('VALID');
  });

  it('marca un préstamo con external_loan_id ya existente como duplicado (warning, no error bloqueante)', async () => {
    mockLoanFindMany.mockResolvedValue([{ externalLoanId: 'LOAN001' }]);

    const buffer = await buildXlsxBuffer({
      prestamos: [
        LOAN_HEADERS,
        ['LOAN001', 'CLI001', 500000, 0.03, 12, '2026-04-06', 'DAILY', '', 'ACTIVE', ''],
      ],
    });

    const result = await createImportBatch({
      organizationId: 'org-1',
      userId: 'user-1',
      fileBuffer: buffer,
      fileName: 'prestamos.xlsx',
      extension: '.xlsx',
    });

    expect(result.summary.valid).toBe(1); // sigue siendo válido, no bloquea
    const row = mockImportBatchCreate.mock.calls[0][0].data.rows.create[0];
    expect(row.status).toBe('VALID');
    expect(row.warnings.join(' ')).toMatch(/ya existe/i);
  });

  it('agrega un warning (no pierde el dato en silencio) cuando la ruta de un cliente no existe', async () => {
    mockRouteFindMany.mockResolvedValue([{ id: 'route-1', name: 'Ruta Centro' }]);

    const buffer = await buildXlsxBuffer({
      clientes: [
        CLIENT_HEADERS,
        ['CLI001', 'Juan', 'Perez', 'CC', '12345678', '', '', 'Ruta Que No Existe', true],
      ],
    });

    const result = await createImportBatch({
      organizationId: 'org-1',
      userId: 'user-1',
      fileBuffer: buffer,
      fileName: 'clientes.xlsx',
      extension: '.xlsx',
    });

    expect(result.summary.valid).toBe(1);
    const row = mockImportBatchCreate.mock.calls[0][0].data.rows.create[0];
    expect(row.parsedData.routeId).toBeNull();
    expect(row.warnings.join(' ')).toMatch(/no encontrada/i);
  });

  it('marca error bloqueante cuando el email de cobrador no existe (no hace fallback silencioso)', async () => {
    const buffer = await buildXlsxBuffer({
      prestamos: [
        LOAN_HEADERS,
        ['LOAN001', 'CLI001', 500000, 0.03, 12, '2026-04-06', 'DAILY', 'no-existe@empresa.com', 'ACTIVE', ''],
      ],
    });

    const result = await createImportBatch({
      organizationId: 'org-1',
      userId: 'user-1',
      fileBuffer: buffer,
      fileName: 'prestamos.xlsx',
      extension: '.xlsx',
    });

    expect(result.summary.invalid).toBe(1);
    const row = mockImportBatchCreate.mock.calls[0][0].data.rows.create[0];
    expect(row.status).toBe('INVALID');
    expect(row.errors.join(' ')).toMatch(/cobrador.*no encontrado/i);
  });
});
