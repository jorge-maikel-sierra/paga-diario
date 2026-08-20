import { createRequire } from 'module';
import path from 'path';
import { Queue } from 'bullmq';
import asyncHandler from '../utils/asyncHandler.js';
import * as apiResponse from '../utils/apiResponse.js';
import * as importService from '../services/import.service.js';
import prisma from '../config/prisma.js';
import redisClient from '../config/redis.js';

// multer v2 es un módulo CJS — se importa con createRequire para compatibilidad ESM
const require = createRequire(import.meta.url);
const multer = require('multer');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB máximo
  fileFilter: (req, file, cb) => {
    const allowedExtensions = ['.xlsx', '.xls', '.csv'];
    const extension = path.extname(file.originalname).toLowerCase();

    const allowedMimetypes = [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
      'text/csv',
      'application/csv',
      'text/plain',
      'application/octet-stream',
    ];

    const extensionAllowed = allowedExtensions.includes(extension);
    const mimetypeAllowed = allowedMimetypes.includes(file.mimetype);

    if (extensionAllowed && mimetypeAllowed) {
      cb(null, true);
    } else if (extensionAllowed && !mimetypeAllowed) {
      console.warn(
        `[Import] Mimetype inesperado "${file.mimetype}" para extensión "${extension}" — aceptado por extensión`,
      );
      cb(null, true);
    } else {
      cb(new Error('Solo se permiten archivos Excel (.xlsx, .xls) o CSV (.csv)'), false);
    }
  },
});

/** Trae un batch verificando que pertenezca a la organización del usuario. */
const findOwnedBatch = async (batchId, organizationId) => {
  const batch = await prisma.importBatch.findFirst({ where: { id: batchId, organizationId } });
  if (!batch) {
    const err = new Error('Lote de importación no encontrado');
    err.statusCode = 404;
    err.isOperational = true;
    throw err;
  }
  return batch;
};

/**
 * GET /admin/imports
 * Renderiza la página principal de importación con formulario de upload.
 */
export const showImportPage = asyncHandler(async (req, res) => {
  res.render('pages/admin/imports/upload', {
    title: 'Importar Datos',
    user: req.user,
    currentPath: '/admin/imports',
  });
});

/**
 * POST /admin/imports/upload
 * Parsea el archivo y crea el lote de importación (persistido en BD).
 */
export const uploadFile = asyncHandler(async (req, res) => {
  if (!req.file) {
    return apiResponse.error(res, 'No se recibió ningún archivo', 400);
  }

  const extension = path.extname(req.file.originalname).toLowerCase();

  try {
    const { batchId, summary } = await importService.createImportBatch({
      organizationId: req.user.organizationId,
      userId: req.user.id,
      fileBuffer: req.file.buffer,
      fileName: req.file.originalname,
      extension,
    });

    return apiResponse.success(res, { batchId, summary }, 201);
  } catch (error) {
    return apiResponse.error(res, error.message, 400);
  }
});

/**
 * GET /admin/imports/:batchId
 * Página única de detalle del lote — preview, progreso en vivo o resultados
 * finales, según el status del batch.
 */
export const showBatch = asyncHandler(async (req, res) => {
  const { flashSucess, flashError } = req.session;
  delete req.session.flashSucess;
  delete req.session.flashError;

  const batch = await findOwnedBatch(req.params.batchId, req.user.organizationId);

  const rowsBySheet = await prisma.importRow.groupBy({
    by: ['sheetType', 'status'],
    where: { batchId: batch.id },
    _count: true,
  });

  const summary = { client: {}, loan: {}, payment: {} };
  rowsBySheet.forEach((r) => {
    summary[r.sheetType][r.status] = r._count;
  });

  return res.render('pages/admin/imports/batch', {
    title: 'Importación de Datos',
    user: req.user,
    currentPath: '/admin/imports',
    batch,
    summary,
    flashSucess,
    flashError,
  });
});

/**
 * GET /admin/imports/:batchId/rows?sheet=client&status=invalid&page=1
 * Paginación real de filas del lote (reemplaza el .slice(0,50) del preview
 * en sesión).
 */
export const listBatchRows = asyncHandler(async (req, res) => {
  const batch = await findOwnedBatch(req.params.batchId, req.user.organizationId);

  const { sheet, status } = req.query;
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = 25;

  const where = {
    batchId: batch.id,
    ...(sheet && { sheetType: sheet }),
    ...(status && { status: status.toUpperCase() }),
  };

  const [rows, total] = await Promise.all([
    prisma.importRow.findMany({
      where,
      orderBy: { rowNumber: 'asc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.importRow.count({ where }),
  ]);

  return apiResponse.success(res, rows, 200, { page, pageSize, total, totalPages: Math.ceil(total / pageSize) });
});

/**
 * PATCH /admin/imports/:batchId/rows/:rowId
 * Corrige y revalida una fila puntual sin resubir el archivo.
 */
export const updateBatchRow = asyncHandler(async (req, res) => {
  await findOwnedBatch(req.params.batchId, req.user.organizationId);

  const row = await prisma.importRow.findFirst({
    where: { id: req.params.rowId, batchId: req.params.batchId },
  });
  if (!row) {
    return apiResponse.error(res, 'Fila no encontrada', 404);
  }

  const updated = await importService.retryRow(row.id, req.body.rawData);
  return apiResponse.success(res, updated, 200);
});

/**
 * POST /admin/imports/:batchId/confirm
 * Ejecuta el lote — en segundo plano (BullMQ) si Redis está disponible,
 * o de forma síncrona en el request si la organización corre sin Redis.
 */
export const confirmImport = asyncHandler(async (req, res) => {
  const batch = await findOwnedBatch(req.params.batchId, req.user.organizationId);

  if (batch.status !== 'PENDING') {
    return apiResponse.error(res, 'Este lote ya fue procesado', 400);
  }

  if (redisClient) {
    const queue = new Queue('import-processing', { connection: redisClient });
    await queue.add('run-batch', { batchId: batch.id });
    await queue.close();
    return apiResponse.success(res, { batchId: batch.id, queued: true }, 202);
  }

  const result = await importService.runImportBatch(batch.id);
  return apiResponse.success(res, { batchId: batch.id, queued: false, batch: result }, 200);
});

/**
 * GET /admin/imports/:batchId/errors.xlsx
 * Descarga un reporte Excel con solo las filas fallidas/inválidas del lote.
 */
export const downloadErrorReport = asyncHandler(async (req, res) => {
  const batch = await findOwnedBatch(req.params.batchId, req.user.organizationId);

  const buffer = await importService.generateErrorReportBuffer(batch.id);

  res.setHeader('Content-Disposition', `attachment; filename="errores_${batch.fileName}.xlsx"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  return res.send(buffer);
});

/**
 * GET /admin/imports/history
 * Historial paginado de lotes de importación de la organización.
 */
export const showHistory = asyncHandler(async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = 20;

  const [batches, total] = await Promise.all([
    prisma.importBatch.findMany({
      where: { organizationId: req.user.organizationId },
      include: { user: { select: { firstName: true, lastName: true } } },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.importBatch.count({ where: { organizationId: req.user.organizationId } }),
  ]);

  return res.render('pages/admin/imports/history', {
    title: 'Historial de Importaciones',
    user: req.user,
    currentPath: '/admin/imports',
    batches,
    page,
    totalPages: Math.ceil(total / pageSize),
  });
});

/**
 * GET /admin/imports/download-template
 * Descarga una plantilla Excel para importación (con instrucciones y
 * validación de datos).
 */
export const downloadTemplate = asyncHandler(async (req, res) => {
  const templateType = req.query.type || 'complete';

  res.setHeader('Content-Disposition', `attachment; filename="plantilla_importacion_${templateType}.xlsx"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

  try {
    const templateBuffer = await importService.generateTemplate(templateType);
    return res.send(templateBuffer);
  } catch (error) {
    return apiResponse.error(res, `Error generando plantilla: ${error.message}`, 500);
  }
});

/**
 * Middleware de multer para upload de archivos de importación.
 * Acepta un solo archivo con el nombre 'importFile'.
 */
export const uploadMiddleware = upload.single('importFile');
