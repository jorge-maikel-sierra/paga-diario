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
 * Schema para corregir una fila del lote sin resubir el archivo
 * PATCH /admin/imports/:batchId/rows/:rowId
 *
 * @type {z.ZodObject}
 */
export const updateBatchRowSchema = z.object({
  body: z.object({
    rawData: z.record(z.string(), z.any(), {
      errorMap: () => ({ message: 'rawData debe ser un objeto con las columnas de la fila' }),
    }),
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
