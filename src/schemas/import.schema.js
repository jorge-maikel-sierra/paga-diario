import { z } from 'zod';

/**
 * Schema para validar archivo de importación
 * POST /admin/imports/upload
 *
 * @type {z.ZodObject}
 */
export const uploadFileSchema = z.object({
  body: z.object({}), // El archivo viene en req.file, no en req.body
  file: z
    .object({
      originalname: z.string().min(1, 'Nombre de archivo requerido'),
      mimetype: z.string().refine(
        (mime) =>
          [
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'application/vnd.ms-excel',
            'text/csv',
            'application/csv',
            'text/plain',
            'application/octet-stream', // fallback genérico de macOS/Windows
          ].includes(mime),
        { message: 'Solo se permiten archivos Excel (.xlsx, .xls) o CSV (.csv)' },
      ),
      size: z.number().max(10 * 1024 * 1024, 'El archivo no puede superar 10MB'),
      buffer: z.instanceof(Buffer, { message: 'Buffer del archivo requerido' }),
    })
    .optional(), // Opcional porque multer puede rechazarlo antes
});

/**
 * Schema para confirmar importación
 * POST /admin/imports/confirm
 *
 * @type {z.ZodObject}
 */
export const confirmImportSchema = z.object({
  body: z.object({
    confirmedAt: z.string().datetime().optional(),
    notes: z.string().trim().max(500, 'Las notas no pueden superar 500 caracteres').optional(),
  }),
});

/**
 * Schema para descargar plantilla
 * GET /admin/imports/download-template
 *
 * @type {z.ZodObject}
 */
export const downloadTemplateSchema = z.object({
  query: z.object({
    type: z
      .enum(['complete', 'clients', 'loans', 'payments'], {
        errorMap: () => ({
          message: 'Tipo debe ser: complete, clients, loans o payments',
        }),
      })
      .default('complete'),
  }),
});

/**
 * Schema para validar datos de cliente en importación
 * Usado internamente por import.service.js
 *
 * @type {z.ZodObject}
 */
export const importClientSchema = z.object({
  externalClientId: z.string().trim().min(1, 'ID externo de cliente es obligatorio'),
  firstName: z.string().trim().min(1, 'Nombres son obligatorios'),
  lastName: z.string().trim().min(1, 'Apellidos son obligatorios'),
  documentType: z.enum(['CC', 'NIT', 'PEP'], {
    errorMap: () => ({
      message: 'Tipo de documento debe ser CC, NIT o PEP',
    }),
  }),
  documentNumber: z.string().trim().min(1, 'Número de documento es obligatorio'),
  phone: z.string().trim().optional().nullable(),
  address: z.string().trim().optional().nullable(),
  routeName: z.string().trim().optional().nullable(),
  isActive: z.boolean().default(true),
});

/**
 * Schema para validar datos de préstamo en importación
 * Usado internamente por import.service.js
 *
 * @type {z.ZodObject}
 */
export const importLoanSchema = z.object({
  externalLoanId: z.string().trim().min(1, 'ID externo de préstamo es obligatorio'),
  externalClientId: z.string().trim().min(1, 'ID externo de cliente es obligatorio'),
  principalAmount: z.number().positive('El monto principal debe ser mayor a 0'),
  monthlyRate: z
    .number()
    .min(0, 'Tasa mensual no puede ser negativa')
    .max(1, 'Tasa mensual no puede superar 100%'),
  termMonths: z.number().int().positive('El plazo en meses debe ser mayor a 0'),
  disbursementDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha debe estar en formato YYYY-MM-DD'),
  frequency: z
    .enum(['DAILY', 'WEEKLY', 'BIWEEKLY', 'MONTHLY'], {
      errorMap: () => ({ message: 'Frecuencia debe ser DAILY, WEEKLY, BIWEEKLY o MONTHLY' }),
    })
    .default('DAILY'),
  collectorEmail: z.string().email('Email de cobrador inválido').optional().nullable(),
  status: z
    .enum(['ACTIVE', 'COMPLETED', 'DEFAULTED', 'CANCELLED'], {
      errorMap: () => ({ message: 'Estado debe ser ACTIVE, COMPLETED, DEFAULTED o CANCELLED' }),
    })
    .default('ACTIVE'),
  notes: z
    .string()
    .trim()
    .max(500, 'Las notas no pueden superar 500 caracteres')
    .optional()
    .nullable(),
});

/**
 * Schema para validar datos de pago en importación
 * Usado internamente por import.service.js
 *
 * @type {z.ZodObject}
 */
export const importPaymentSchema = z.object({
  externalLoanId: z.string().trim().min(1, 'ID externo de préstamo es obligatorio'),
  amount: z.number().positive('El monto debe ser mayor a 0'),
  paymentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha debe estar en formato YYYY-MM-DD'),
  method: z
    .enum(['CASH', 'TRANSFER', 'CHECK', 'MOBILE_PAYMENT'], {
      errorMap: () => ({ message: 'Método debe ser CASH, TRANSFER, CHECK o MOBILE_PAYMENT' }),
    })
    .default('CASH'),
  collectorEmail: z.string().email('Email de cobrador inválido').optional().nullable(),
  notes: z
    .string()
    .trim()
    .max(500, 'Las notas no pueden superar 500 caracteres')
    .optional()
    .nullable(),
});

/**
 * Schema para validar resultados de preview de importación
 * Usado internamente para validar la estructura del preview
 *
 * @type {z.ZodObject}
 */
export const importPreviewSchema = z.object({
  fileName: z.string().min(1, 'Nombre de archivo requerido'),
  clients: z.array(
    z.object({
      rowNumber: z.number().int().positive(),
      isValid: z.boolean(),
      errors: z.array(z.string()),
      data: importClientSchema.optional().nullable(),
    }),
  ),
  loans: z.array(
    z.object({
      rowNumber: z.number().int().positive(),
      isValid: z.boolean(),
      errors: z.array(z.string()),
      data: importLoanSchema.optional().nullable(),
    }),
  ),
  payments: z.array(
    z.object({
      rowNumber: z.number().int().positive(),
      isValid: z.boolean(),
      errors: z.array(z.string()),
      data: importPaymentSchema.optional().nullable(),
    }),
  ),
  summary: z.object({
    clients: z.object({
      total: z.number().int().min(0),
      valid: z.number().int().min(0),
      invalid: z.number().int().min(0),
    }),
    loans: z.object({
      total: z.number().int().min(0),
      valid: z.number().int().min(0),
      invalid: z.number().int().min(0),
    }),
    payments: z.object({
      total: z.number().int().min(0),
      valid: z.number().int().min(0),
      invalid: z.number().int().min(0),
    }),
  }),
});

/**
 * Schema para validar resultados de importación ejecutada
 * Usado internamente para validar la respuesta de executeImport
 *
 * @type {z.ZodObject}
 */
export const importResultsSchema = z.object({
  clients: z.object({
    created: z.number().int().min(0),
    updated: z.number().int().min(0),
    errors: z.array(
      z.object({
        row: z.number().int().positive(),
        error: z.string(),
      }),
    ),
  }),
  loans: z.object({
    created: z.number().int().min(0),
    errors: z.array(
      z.object({
        row: z.number().int().positive(),
        error: z.string(),
      }),
    ),
  }),
  payments: z.object({
    created: z.number().int().min(0),
    errors: z.array(
      z.object({
        row: z.number().int().positive(),
        error: z.string(),
      }),
    ),
  }),
  duration: z.number().min(0, 'Duración debe ser mayor o igual a 0'),
});
