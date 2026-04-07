import { Router } from 'express';
import validate from '../middleware/validate.js';
import {
  showImportPage,
  uploadFile,
  showPreview,
  confirmImport,
  showResults,
  downloadTemplate,
  uploadMiddleware,
} from '../controllers/import.controller.js';
import {
  uploadFileSchema,
  confirmImportSchema,
  downloadTemplateSchema,
} from '../schemas/import.schema.js';

// ============================================
// Admin Imports Router — Pago Ya
// Ruta base (montaje): /admin/imports
// ============================================

const router = Router();

// GET /admin/imports
// Página principal de importación con formulario de upload
router.get('/', showImportPage);

// POST /admin/imports/upload
// Procesar archivo subido y generar preview
router.post('/upload', uploadMiddleware, validate(uploadFileSchema), uploadFile);

// GET /admin/imports/preview
// Mostrar preview de validación de datos
router.get('/preview', showPreview);

// POST /admin/imports/confirm
// Confirmar y ejecutar importación
router.post('/confirm', validate(confirmImportSchema), confirmImport);

// GET /admin/imports/results
// Mostrar resultados de importación ejecutada
router.get('/results', showResults);

// GET /admin/imports/download-template
// Descargar plantilla Excel para importación
router.get('/download-template', validate(downloadTemplateSchema), downloadTemplate);

export default router;
