import { Router } from 'express';
import validate from '../middleware/validate.js';
import {
  showImportPage,
  uploadFile,
  showBatch,
  listBatchRows,
  updateBatchRow,
  confirmImport,
  downloadErrorReport,
  showHistory,
  downloadTemplate,
  uploadMiddleware,
} from '../controllers/import.controller.js';
import { uploadFileSchema, updateBatchRowSchema, downloadTemplateSchema } from '../schemas/import.schema.js';

// ============================================
// Admin Imports Router — Paga Diario
// Ruta base (montaje): /admin/imports
// ============================================

const router = Router();

// GET /admin/imports
router.get('/', showImportPage);

// GET /admin/imports/history — debe ir antes de /:batchId para no colisionar
router.get('/history', showHistory);

// GET /admin/imports/download-template
router.get('/download-template', validate(downloadTemplateSchema), downloadTemplate);

// POST /admin/imports/upload
router.post('/upload', uploadMiddleware, validate(uploadFileSchema), uploadFile);

// GET /admin/imports/:batchId — página de detalle (preview/progreso/resultados)
router.get('/:batchId', showBatch);

// GET /admin/imports/:batchId/rows — paginación de filas
router.get('/:batchId/rows', listBatchRows);

// PATCH /admin/imports/:batchId/rows/:rowId — corregir una fila sin resubir
router.patch('/:batchId/rows/:rowId', validate(updateBatchRowSchema), updateBatchRow);

// POST /admin/imports/:batchId/confirm — ejecuta el lote
router.post('/:batchId/confirm', confirmImport);

// GET /admin/imports/:batchId/errors.xlsx — reporte de errores descargable
router.get('/:batchId/errors.xlsx', downloadErrorReport);

export default router;
