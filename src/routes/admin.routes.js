import { Router } from 'express';
import { verifySession } from '../middleware/auth.js';
import authorize from '../middleware/authorize.js';
import {
  getLogin,
  postLogin,
  redirectToDashboard,
  getDashboard,
  getRoutes,
  getNewRoute,
  createRoute,
  getRouteDetail,
  getEditRoute,
  updateRoute,
  getSettings,
  logout,
} from '../controllers/admin.controller.js';

import loansRouter from './admin.loans.routes.js';
import clientsRouter from './admin.clients.routes.js';
import collectorsRouter from './admin.collectors.routes.js';
import paymentsRouter from './admin.payments.routes.js';
import reportsRouter from './admin.reports.routes.js';
import usersRouter from './admin.users.routes.js';
import organizationsRouter from './admin.organizations.routes.js';
import adminApiRouter from './admin.api.routes.js';
import importsRouter from './admin.imports.routes.js';
import expensesRouter from './admin.expenses.routes.js';

// ============================================
// Admin Router — Pago Ya
// Ruta base (montaje): /admin
//
// Este router es el orquestador del panel administrativo.
// Cada recurso tiene su propio sub-router en routes/admin.*.routes.js
// ============================================

const router = Router();

// ============================================
// RUTAS PÚBLICAS (sin verifySession)
// ============================================

router.get('/login', getLogin);
router.post('/login', postLogin);

// ============================================
// RUTAS PROTEGIDAS (requieren sesión iniciada)
// A partir de acá todo usuario autenticado (incluido COLLECTOR) pasa,
// pero cada recurso decide su propio gate de rol más abajo.
// ============================================

router.use(verifySession);

// --- Raíz: redirige según rol (COLLECTOR -> gastos, resto -> dashboard) ---
router.get('/', redirectToDashboard);

// --- Gastos operativos: único recurso accesible también para COLLECTOR ---
router.use('/expenses', authorize('SUPER_ADMIN', 'ADMIN', 'COLLECTOR'), expensesRouter);

// --- Logout: cualquier usuario autenticado puede cerrar su sesión ---
router.post('/logout', logout);

// ============================================
// A partir de aquí, solo ADMIN o SUPER_ADMIN
// ============================================
router.use(authorize('SUPER_ADMIN', 'ADMIN'));

router.get('/dashboard', getDashboard);

// --- Recursos del panel (cada uno con su Router propio) ---
router.use('/loans', loansRouter);
router.use('/clients', clientsRouter);
router.use('/collectors', collectorsRouter);
router.use('/payments', paymentsRouter);
router.use('/reports', reportsRouter);
router.use('/imports', importsRouter);

// --- APIs internas del panel (typeahead, etc.) ---
router.use('/api', adminApiRouter);

// --- Rutas de cobro (sin sub-recursos propios) ---
router.get('/routes', getRoutes);
router.get('/routes/new', getNewRoute);
router.post('/routes', createRoute);
router.get('/routes/:id/edit', getEditRoute);
router.put('/routes/:id', updateRoute);
router.get('/routes/:id', getRouteDetail);

// --- Configuración ---
router.get('/settings', getSettings);

// --- Recursos exclusivos SUPER_ADMIN ---
router.use('/users', usersRouter);
router.use('/organizations', organizationsRouter);

export default router;
