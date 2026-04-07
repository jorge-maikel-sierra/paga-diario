import { createRequire } from 'module';
import path from 'path';
import asyncHandler from '../utils/asyncHandler.js';
import * as apiResponse from '../utils/apiResponse.js';
import * as importService from '../services/import.service.js';

// multer v2 es un módulo CJS — se importa con createRequire para compatibilidad ESM
const require = createRequire(import.meta.url);
const multer = require('multer');

// Configuración de multer para archivos de importación
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB máximo
  },
  fileFilter: (req, file, cb) => {
    const allowedExtensions = ['.xlsx', '.xls', '.csv'];
    const extension = path.extname(file.originalname).toLowerCase();

    // Los navegadores reportan mimetypes distintos según el SO/versión;
    // validamos por extensión como fuente de verdad y aceptamos octet-stream como fallback seguro.
    const allowedMimetypes = [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx (estándar)
      'application/vnd.ms-excel', // .xls (estándar)
      'text/csv', // .csv (estándar)
      'application/csv', // .csv (variante)
      'text/plain', // .csv enviado como texto plano por algunos OS
      'application/octet-stream', // fallback genérico de macOS/Windows
    ];

    const extensionAllowed = allowedExtensions.includes(extension);
    const mimetypeAllowed = allowedMimetypes.includes(file.mimetype);

    if (extensionAllowed && mimetypeAllowed) {
      cb(null, true);
    } else if (extensionAllowed && !mimetypeAllowed) {
      // Extensión correcta pero mimetype inesperado: aceptar con advertencia de log
      console.warn(
        `[Import] Mimetype inesperado "${file.mimetype}" para extensión "${extension}" — aceptado por extensión`,
      );
      cb(null, true);
    } else {
      cb(new Error('Solo se permiten archivos Excel (.xlsx, .xls) o CSV (.csv)'), false);
    }
  },
});

/**
 * GET /admin/imports
 * Renderiza la página principal de importación con formulario de upload.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
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
 * Procesa el archivo subido y genera preview de validación.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export const uploadFile = asyncHandler(async (req, res) => {
  if (!req.file) {
    return apiResponse.error(res, 'No se recibió ningún archivo', 400);
  }

  try {
    const preview = await importService.parseImportFile(req.file.buffer, req.file.originalname);

    // Guardar preview en session para confirmación posterior
    req.session.importPreview = preview;

    return apiResponse.success(res, preview, 200);
  } catch (error) {
    return apiResponse.error(res, error.message, 400);
  }
});

/**
 * GET /admin/imports/preview
 * Renderiza la página de preview con resultados de validación.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export const showPreview = asyncHandler(async (req, res) => {
  const preview = req.session.importPreview;

  if (!preview) {
    req.flash('error', 'No hay datos de importación para mostrar');
    return res.redirect('/admin/imports');
  }

  return res.render('pages/admin/imports/preview', {
    title: 'Preview de Importación',
    user: req.user,
    currentPath: '/admin/imports',
    preview,
  });
});

/**
 * POST /admin/imports/confirm
 * Ejecuta la importación confirmada y muestra resultados.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export const confirmImport = asyncHandler(async (req, res) => {
  const preview = req.session.importPreview;

  if (!preview) {
    return apiResponse.error(res, 'No hay datos de importación para procesar', 400);
  }

  try {
    const results = await importService.executeImport(req.user.organizationId, preview);

    // Limpiar preview y guardar resultados en sesión para que showResults los muestre
    delete req.session.importPreview;
    req.session.importResults = results;

    return apiResponse.success(res, results, 200);
  } catch (error) {
    return apiResponse.error(res, `Error en importación: ${error.message}`, 500);
  }
});

/**
 * GET /admin/imports/results
 * Renderiza la página de resultados de importación.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export const showResults = asyncHandler(async (req, res) => {
  // Los resultados deben pasarse como query params o session
  const results = req.session.importResults || req.query.results;

  if (!results) {
    req.flash('error', 'No hay resultados de importación para mostrar');
    return res.redirect('/admin/imports');
  }

  const parsedResults = typeof results === 'string' ? JSON.parse(results) : results;

  // Limpiar resultados de la sesión después de mostrarlos
  if (req.session.importResults) {
    delete req.session.importResults;
  }

  return res.render('pages/admin/imports/results', {
    title: 'Resultados de Importación',
    user: req.user,
    currentPath: '/admin/imports',
    results: parsedResults,
  });
});

/**
 * Genera una plantilla Excel con headers ejemplo.
 *
 * @param {string} type - Tipo de plantilla (complete, clients, loans, payments)
 * @returns {Promise<Buffer>}
 */
const generateTemplate = async (type) => {
  const ExcelJS = (await import('exceljs')).default;
  const workbook = new ExcelJS.Workbook();

  if (type === 'complete' || type === 'clients') {
    const clientSheet = workbook.addWorksheet('clientes');
    clientSheet.addRow([
      'external_client_id',
      'nombres',
      'apellidos',
      'tipo_documento',
      'numero_documento',
      'telefono',
      'direccion',
      'ruta',
      'activo',
    ]);

    // Fila ejemplo
    clientSheet.addRow([
      'CLI001',
      'Juan Carlos',
      'Pérez González',
      'CC',
      '12345678',
      '3001234567',
      'Calle 123 #45-67',
      'Ruta Centro',
      true,
    ]);
  }

  if (type === 'complete' || type === 'loans') {
    const loanSheet = workbook.addWorksheet('prestamos');
    loanSheet.addRow([
      'external_loan_id',
      'external_client_id',
      'principal',
      'tasa_mensual',
      'plazo_meses',
      'fecha_desembolso',
      'frecuencia',
      'cobrador',
      'estado',
      'notas',
    ]);

    // Fila ejemplo
    loanSheet.addRow([
      'LOAN001',
      'CLI001',
      500000,
      0.03,
      12,
      '2026-04-06',
      'MONTHLY',
      'cobrador@empresa.com',
      'ACTIVE',
      'Préstamo ejemplo',
    ]);
  }

  if (type === 'complete' || type === 'payments') {
    const paymentSheet = workbook.addWorksheet('pagos');
    paymentSheet.addRow(['external_loan_id', 'monto', 'fecha_pago', 'metodo', 'cobrador', 'notas']);

    // Fila ejemplo
    paymentSheet.addRow([
      'LOAN001',
      50000,
      '2026-04-06',
      'CASH',
      'cobrador@empresa.com',
      'Pago inicial',
    ]);
  }

  return workbook.xlsx.writeBuffer();
};

/**
 * GET /admin/imports/download-template
 * Descarga una plantilla Excel para importación.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export const downloadTemplate = asyncHandler(async (req, res) => {
  const templateType = req.query.type || 'complete';

  // Configurar headers para descarga
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="plantilla_importacion_${templateType}.xlsx"`,
  );
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );

  try {
    const templateBuffer = await generateTemplate(templateType);
    return res.send(templateBuffer);
  } catch (error) {
    return apiResponse.error(res, `Error generando plantilla: ${error.message}`, 500);
  }
});

/**
 * Middleware de multer para manejo de archivos.
 * TODO: Descomentar cuando se instale multer
 */
/**
 * Middleware de multer para upload de archivos de importación.
 * Acepta un solo archivo con el nombre 'importFile'.
 */
export const uploadMiddleware = upload.single('importFile');
