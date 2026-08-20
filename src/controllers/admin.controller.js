import bcrypt from 'bcryptjs';
import asyncHandler from '../utils/asyncHandler.js';
import * as apiResponse from '../utils/apiResponse.js';
import * as adminService from '../services/admin.service.js';
import prisma from '../config/prisma.js';
import * as loanService from '../services/loan.service.js';
import * as clientService from '../services/client.service.js';
import * as collectorService from '../services/collector.service.js';
import * as organizationService from '../services/organization.service.js';
import * as routeService from '../services/route.service.js';
import * as reportService from '../services/report.service.js';
import * as paymentService from '../services/payment.service.js';
import * as expenseService from '../services/expense.service.js';
import { enqueuePaymentReceipt } from '../services/notification.service.js';
import { createLoanSchema } from '../schemas/loan.schema.js';
import { updateOrganizationSchema } from '../schemas/organization.schema.js';

// ============================================
// AUTH
// ============================================

/**
 * GET /admin/login
 * Renderiza el formulario de inicio de sesión.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
const getLogin = (req, res) => {
  const { flashError, flashSucess } = req.session;
  delete req.session.flashError;
  delete req.session.flashSucess;

  return res.render('pages/login', {
    title: 'Iniciar Sesión',
    currentPath: '/admin/login',
    flashError,
    flashSucess,
    prefillEmail: typeof req.query?.email === 'string' ? req.query.email : '',
  });
};

/**
 * POST /admin/login
 * Valida credenciales, crea la sesión y redirige al dashboard.
 * Usa Prisma + bcrypt directamente para evitar dependencia de Passport
 * en el flujo de sesión del panel EJS.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
const postLogin = asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  const user = await prisma.user.findUnique({ where: { email } });

  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    req.session.flashError = 'Credenciales inválidas';
    return req.session.save(() => res.redirect('/admin/login'));
  }

  if (!user.isActive) {
    req.session.flashError = 'Cuenta desactivada. Contacte al administrador';
    return req.session.save(() => res.redirect('/admin/login'));
  }

  // ADMIN/SUPER_ADMIN acceden al panel completo; COLLECTOR solo al
  // registro de gastos (ver restricción de rutas en admin.routes.js)
  if (!['ADMIN', 'SUPER_ADMIN', 'COLLECTOR'].includes(user.role)) {
    req.session.flashError = 'Acceso denegado';
    return req.session.save(() => res.redirect('/admin/login'));
  }

  // Guardar datos del usuario en sesión sin exponer el hash de contraseña
  const { passwordHash: _omit, ...sessionUser } = user;
  req.session.user = sessionUser;

  const redirectTo = user.role === 'COLLECTOR' ? '/admin/expenses' : '/admin/dashboard';
  return req.session.save(() => res.redirect(redirectTo));
});

/**
 * DELETE /admin/logout
 * Cierra la sesión y redirige al login.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
const logout = asyncHandler((req, res, next) => {
  req.logout((err) => {
    if (err) return next(err);

    return req.session.destroy(() => {
      res.clearCookie('connect.sid');
      res.redirect('/admin/login');
    });
  });
});

// ============================================
// DASHBOARD
// ============================================

/**
 * GET /admin
 * Redirige la raíz del panel al dashboard principal.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
const redirectToDashboard = (req, res) =>
  res.redirect(req.user.role === 'COLLECTOR' ? '/admin/expenses' : '/admin/dashboard');

/**
 * GET /admin/dashboard
 * Consulta los KPIs de la organización y renderiza el dashboard.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
const getDashboard = asyncHandler(async (req, res) => {
  const kpis = await adminService.getDashboardKPIs(req.user.organizationId);

  return res.render('pages/dashboard', {
    title: 'Dashboard',
    user: req.user,
    kpis,
    currentPath: '/admin/dashboard',
  });
});

// ============================================
// PRÉSTAMOS
// ============================================

/**
 * GET /admin/loans
 * Lista los préstamos de la organización con filtros opcionales.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
const getLoans = asyncHandler(async (req, res) => {
  const { search, status } = req.query;
  const { flashSucess, flashError } = req.session;
  delete req.session.flashSucess;
  delete req.session.flashError;

  const loans = await loanService.findLoans(req.user.organizationId, { search, status });

  return res.render('pages/loans/index', {
    title: 'Préstamos',
    user: req.user,
    currentPath: '/admin/loans',
    loans,
    search: search ?? '',
    status: status ?? '',
    flashSucess,
    flashError,
  });
});

/**
 * GET /admin/loans/new
 * Muestra el formulario para crear un préstamo nuevo.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
const getNewLoan = asyncHandler(async (req, res) => {
  const { flashSucess, flashError, formData, validationErrors } = req.session;
  delete req.session.flashSucess;
  delete req.session.flashError;
  delete req.session.formData;
  delete req.session.validationErrors;

  const { clients, collectors, routes } = await loanService.getNewLoanFormData(
    req.user.organizationId,
  );

  return res.render('pages/loans/new', {
    title: 'Nuevo Préstamo',
    user: req.user,
    currentPath: '/admin/loans/new',
    clients,
    collectors,
    routes,
    flashSucess,
    flashError,
    // Restaurar valores del formulario previo si hay un error de validación
    formData: formData || null,
    // Pasar errores estructurados (si existen) para la vista EJS
    validationErrors: validationErrors || null,
  });
});

/**
 * POST /admin/loans
 * Procesa la creación de un préstamo nuevo y redirige al detalle.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
const createLoan = asyncHandler(async (req, res) => {
  const parsed = createLoanSchema.safeParse({
    clientId: req.body.clientId,
    collectorId: req.body.collectorId,
    principalAmount: +req.body.principalAmount,
    // El formulario envía porcentaje (ej. 10 = 10%/mes). Convertir a fracción (0.10)
    interestRate: +req.body.interestRate / 100,
    paymentFrequency: req.body.paymentFrequency,
    amortizationType: req.body.amortizationType,
    termMonths: Number.parseInt(req.body.termMonths, 10),
    disbursementDate: req.body.disbursementDate,
    notes: req.body.notes || undefined,
  });

  if (!parsed.success) {
    // Crear array estructurado de errores { field, message } para la vista
    const errors = parsed.error.errors.map((e) => ({
      field: e.path.join('.'),
      message: e.message,
    }));
    req.session.validationErrors = errors;
    // Guardar también un mensaje breve para flashError (compatibilidad)
    req.session.flashError = `Error de validación: ${errors.map((e) => `${e.field}: ${e.message}`).join(', ')}`;
    // Reinyectar valores previos en sesión para restaurarlos en el formulario
    req.session.formData = req.body;
    return res.redirect('/admin/loans/new');
  }

  const loan = await loanService.createLoan(req.user.organizationId, parsed.data);

  req.session.flashSucess = `Préstamo creado exitosamente: ${loan.id}`;
  return res.redirect(`/admin/loans/${loan.id}`);
});

/**
 * GET /admin/loans/:id
 * Muestra el detalle completo de un préstamo.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
const getLoan = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { flashSucess, flashError } = req.session;
  delete req.session.flashSucess;
  delete req.session.flashError;

  const loan = await loanService.findLoanById(id, req.user.organizationId);

  return res.render('pages/loans/detail', {
    title: `Préstamo — ${loan.client.firstName} ${loan.client.lastName}`,
    user: req.user,
    loan,
    currentPath: `/admin/loans/${id}`,
    flashSucess,
    flashError,
  });
});

/**
 * POST /admin/loans/preview
 * Genera una previsualización del cronograma de amortización sin persistir en BD.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
const previewLoan = asyncHandler(async (req, res) => {
  // amortizationType no se expone al usuario — siempre se usa interés simple (FIXED)
  const previewSchema = createLoanSchema.omit({
    clientId: true,
    collectorId: true,
    notes: true,
    amortizationType: true,
  });

  const parsed = previewSchema.safeParse({
    principalAmount: +req.body.principalAmount,
    // El formulario envía porcentaje (ej. 10 = 10%/mes). Convertir a fracción (0.10)
    interestRate: +req.body.interestRate / 100,
    paymentFrequency: req.body.paymentFrequency,
    termMonths: Number.parseInt(req.body.termMonths, 10),
    disbursementDate: req.body.disbursementDate,
  });

  if (!parsed.success) {
    const errors = parsed.error.errors.map((e) => ({
      field: e.path.join('.'),
      message: e.message,
    }));

    return apiResponse.error(res, 'Datos de previsualización inválidos', 422, errors);
  }

  // Delegar al service — el controller no llama al engine financiero directamente
  const result = loanService.previewAmortizationSchedule(parsed.data);

  return apiResponse.success(res, result);
});

// ============================================
// CLIENTES
// ============================================

/**
 * GET /admin/clients
 * Lista los clientes de la organización.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
const getClients = asyncHandler(async (req, res) => {
  const { search } = req.query;
  const { flashSucess, flashError } = req.session;
  delete req.session.flashSucess;
  delete req.session.flashError;

  const clients = await clientService.findClients(req.user.organizationId, { search });

  return res.render('pages/clients/index', {
    title: 'Clientes',
    user: req.user,
    currentPath: '/admin/clients',
    clients,
    search: search || '',
    flashSucess,
    flashError,
  });
});

/**
 * GET /admin/clients/:id
 * Muestra el perfil completo del cliente con sus préstamos e incidentes.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
const getClient = asyncHandler(async (req, res) => {
  const { flashSucess, flashError } = req.session;
  delete req.session.flashSucess;
  delete req.session.flashError;

  const { client, loans, incidents } = await clientService.findClientById(
    req.params.id,
    req.user.organizationId,
  );

  return res.render('pages/clients/detail', {
    title: `${client.firstName} ${client.lastName}`,
    user: req.user,
    currentPath: '/admin/clients',
    client,
    loans,
    incidents,
    flashSucess,
    flashError,
  });
});

/**
 * GET /admin/clients/new
 * Renderiza el formulario para crear un nuevo cliente.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
const getNewClient = asyncHandler(async (req, res) => {
  const { flashError } = req.session;
  delete req.session.flashError;

  const routes = await clientService.getClientFormRoutes(req.user.organizationId);

  return res.render('pages/clients/new', {
    title: 'Nuevo Cliente',
    user: req.user,
    currentPath: '/admin/clients/new',
    routes,
    flashError,
  });
});

/**
 * POST /admin/clients
 * Crea un nuevo cliente en la organización actual.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
const createClient = asyncHandler(async (req, res) => {
  try {
    await clientService.createClient(req.user.organizationId, req.body);
    req.session.flashSucess = 'Cliente creado correctamente';
    return res.redirect('/admin/clients');
  } catch (error) {
    if (error.isOperational) {
      req.session.flashError = error.message;
      return req.session.save(() => res.redirect('/admin/clients/new'));
    }
    throw error;
  }
});

/**
 * GET /admin/clients/:id/edit
 * Renderiza el formulario para editar un cliente existente.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
const getEditClient = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { flashError } = req.session;
  delete req.session.flashError;

  // findClientForEdit lanza 404 si el cliente no existe — no se necesita verificación manual
  const [client, routes] = await Promise.all([
    clientService.findClientForEdit(id, req.user.organizationId),
    clientService.getClientFormRoutes(req.user.organizationId),
  ]);

  return res.render('pages/clients/edit', {
    title: 'Editar Cliente',
    user: req.user,
    currentPath: '/admin/clients',
    client,
    routes,
    flashError,
    DOCUMENT_OPTIONS: clientService.DOCUMENT_OPTIONS,
  });
});

/**
 * PUT /admin/clients/:id
 * Actualiza un cliente existente de la organización.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
const updateClient = asyncHandler(async (req, res) => {
  const { id } = req.params;

  try {
    await clientService.updateClient(id, req.user.organizationId, req.body);
    req.session.flashSucess = 'Cliente actualizado correctamente';
    return res.redirect('/admin/clients');
  } catch (error) {
    if (error.isOperational) {
      req.session.flashError = error.message;
      return req.session.save(() => res.redirect(`/admin/clients/${id}/edit`));
    }
    throw error;
  }
});

/**
 * PATCH /admin/clients/:id/status
 * Alterna el estado de restricción de un cliente (activo ↔ restringido).
 * Se usa PATCH porque es una modificación parcial del recurso (solo el campo de estado).
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
const restrictClient = asyncHandler(async (req, res) => {
  const result = await clientService.toggleClientStatus(req.params.id, req.user.organizationId);

  req.session.flashSucess = result.wasActive
    ? `Cliente ${result.firstName} ${result.lastName} restringido correctamente`
    : `Cliente ${result.firstName} ${result.lastName} reactivado correctamente`;

  return res.redirect(`/admin/clients/${result.id}`);
});

// ============================================
// COBRADORES
// ============================================

/**
 * GET /admin/collectors
 * Lista los cobradores de la organización con sus rutas y rendimiento del día.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
const getCollectors = asyncHandler(async (req, res) => {
  const { flashSucess, flashError } = req.session;
  delete req.session.flashSucess;
  delete req.session.flashError;

  const collectors = await collectorService.findCollectors(req.user.organizationId);

  return res.render('pages/collectors/index', {
    title: 'Cobradores',
    user: req.user,
    currentPath: '/admin/collectors',
    collectors,
    flashSucess,
    flashError,
  });
});

/**
 * GET /admin/collectors/new
 * Renderiza el formulario para crear un nuevo cobrador.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
const getNewCollector = asyncHandler(async (req, res) => {
  const { flashError } = req.session;
  delete req.session.flashError;

  return res.render('pages/collectors/new', {
    title: 'Nuevo Cobrador',
    user: req.user,
    currentPath: '/admin/collectors',
    flashError,
  });
});

/**
 * POST /admin/collectors
 * Crea un nuevo cobrador en la organización actual.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
const createCollector = asyncHandler(async (req, res) => {
  try {
    await collectorService.createCollector(req.user.organizationId, req.body);
    req.session.flashSucess = 'Cobrador creado correctamente';
    return res.redirect('/admin/collectors');
  } catch (error) {
    if (error.isOperational) {
      req.session.flashError = error.message;
      return req.session.save(() => res.redirect('/admin/collectors/new'));
    }
    throw error;
  }
});

/**
 * GET /admin/collectors/:id/edit
 * Renderiza el formulario para editar un cobrador existente.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
const getEditCollector = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { flashError } = req.session;
  delete req.session.flashError;

  // findCollectorById lanza 404 si el cobrador no existe — no se necesita verificación manual
  const collector = await collectorService.findCollectorById(id, req.user.organizationId);

  return res.render('pages/collectors/edit', {
    title: 'Editar Cobrador',
    user: req.user,
    currentPath: '/admin/collectors',
    collector,
    flashError,
  });
});

/**
 * PUT /admin/collectors/:id
 * Actualiza un cobrador existente de la organización.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
const updateCollector = asyncHandler(async (req, res) => {
  const { id } = req.params;

  try {
    await collectorService.updateCollector(id, req.user.organizationId, req.body);
    req.session.flashSucess = 'Cobrador actualizado correctamente';
    return res.redirect('/admin/collectors');
  } catch (error) {
    if (error.isOperational) {
      req.session.flashError = error.message;
      return req.session.save(() => res.redirect(`/admin/collectors/${id}/edit`));
    }
    throw error;
  }
});

/**
 * DELETE /admin/collectors/:id
 * Elimina un cobrador de la organización actual.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
const deleteCollector = asyncHandler(async (req, res) => {
  const { id } = req.params;

  try {
    await collectorService.deleteCollector(id, req.user.organizationId);
    req.session.flashSucess = 'Cobrador eliminado correctamente';
    return req.session.save(() => res.redirect('/admin/collectors'));
  } catch (error) {
    if (error.isOperational) {
      req.session.flashError = error.message;
      return req.session.save(() => res.redirect('/admin/collectors'));
    }
    throw error;
  }
});

// ============================================
// PAGOS
// ============================================

/**
 * GET /admin/payments
 * Lista los pagos recibidos con filtros y paginación.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
const getPayments = asyncHandler(async (req, res) => {
  const { dateFrom, dateTo, collectorId, paymentMethod, page: pageParam } = req.query;
  const { flashSucess, flashError } = req.session;
  delete req.session.flashSucess;
  delete req.session.flashError;

  const result = await reportService.findPayments(req.user.organizationId, {
    dateFrom,
    dateTo,
    collectorId,
    paymentMethod,
    page: Number.parseInt(pageParam, 10) || 1,
  });

  return res.render('pages/payments/index', {
    title: 'Pagos',
    user: req.user,
    currentPath: '/admin/payments',
    payments: result.payments,
    collectors: result.collectors,
    total: result.total,
    page: result.page,
    totalPages: result.totalPages,
    filters: {
      dateFrom: dateFrom || '',
      dateTo: dateTo || '',
      collectorId: collectorId || '',
      paymentMethod: paymentMethod || '',
    },
    flashSucess,
    flashError,
  });
});

/**
 * GET /admin/payments/new
 * Renderiza el formulario para registrar un nuevo pago.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
const getNewPayment = asyncHandler(async (req, res) => {
  const { flashError } = req.session;
  delete req.session.flashError;

  const { loans, collectors } = await loanService.getNewPaymentFormData(req.user.organizationId);

  return res.render('pages/payments/new', {
    title: 'Registrar Pago',
    user: req.user,
    currentPath: '/admin/payments/new',
    loans,
    collectors,
    flashError,
  });
});

/**
 * POST /admin/payments
 * Procesa el registro de un nuevo pago desde el panel administrativo.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
const createPayment = asyncHandler(async (req, res) => {
  const { loanId, amountPaid, paymentDate, collectorId, paymentMethod, notes } = req.body;

  if (!loanId || !amountPaid || !paymentDate || !collectorId) {
    req.session.flashError = 'Todos los campos requeridos deben estar completos';
    return res.redirect('/admin/payments/new');
  }

  const result = await paymentService.registerAdminPayment({
    loanId,
    amountPaid,
    paymentDate,
    collectorId,
    paymentMethod,
    notes,
  });

  // Delegar el encolado de notificaciones al service — el controller no instancia colas
  await enqueuePaymentReceipt({
    paymentId: result.payment.id,
    chatId: process.env.TELEGRAM_CHAT_ID,
    clientName: result.clientName,
    amount: result.payment.amount,
    moraAmount: result.payment.moraAmount,
    totalReceived: result.payment.totalReceived,
    outstandingBalance: result.loan.outstandingBalance,
    paidPayments: result.loan.paidPayments,
    totalInstallments: result.loan.numberOfPayments,
    collectorName: `${req.user.firstName} ${req.user.lastName}`,
    collectedAt: result.payment.collectedAt.toISOString(),
  });

  // Notificar en tiempo real — PAYOFF emite estado final para que los clientes
  // conectados actualicen barra de progreso y cronograma sin recargar la página
  const io = req.app.get('io');
  if (io) {
    io.emit('payment:created', {
      paymentId: result.payment.id,
      loanId: result.loan.id,
      amount: result.payment.amount,
      outstandingBalance: result.loan.outstandingBalance,
      paidPayments: result.loan.paidPayments,
      status: result.loan.status,
      paymentType: result.paymentType,
    });
  }

  const isPayoff = result.paymentType === 'PAYOFF';
  req.session.flashSucess = isPayoff
    ? `Liquidación registrada. Préstamo de ${result.clientName} completado al 100%.`
    : 'Pago registrado exitosamente';
  return res.redirect('/admin/payments');
});

// ============================================
// GASTOS OPERATIVOS (COBRADORES)
// ============================================

/**
 * GET /admin/expenses
 * Lista los gastos operativos. Un COLLECTOR solo ve los suyos;
 * ADMIN/SUPER_ADMIN ven todos y pueden filtrar por cobrador.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
const getExpenses = asyncHandler(async (req, res) => {
  const { dateFrom, dateTo, category, page: pageParam } = req.query;
  const { flashSucess, flashError } = req.session;
  delete req.session.flashSucess;
  delete req.session.flashError;

  const isCollector = req.user.role === 'COLLECTOR';
  // Un cobrador nunca puede ver los gastos de otro: se ignora cualquier
  // collectorId que venga por query string y se fuerza al propio usuario.
  const collectorId = isCollector ? req.user.id : req.query.collectorId;

  const result = await expenseService.findExpenses(req.user.organizationId, {
    collectorId: collectorId || undefined,
    category,
    dateFrom,
    dateTo,
    page: Number.parseInt(pageParam, 10) || 1,
  });

  return res.render('pages/expenses/index', {
    title: 'Gastos',
    user: req.user,
    currentPath: '/admin/expenses',
    isCollector,
    expenses: result.expenses,
    collectors: result.collectors,
    total: result.total,
    totalAmount: result.totalAmount,
    page: result.page,
    totalPages: result.totalPages,
    filters: {
      dateFrom: dateFrom || '',
      dateTo: dateTo || '',
      category: category || '',
      collectorId: collectorId || '',
    },
    flashSucess,
    flashError,
  });
});

/**
 * GET /admin/expenses/new
 * Renderiza el formulario para registrar un gasto.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
const getNewExpense = asyncHandler(async (req, res) => {
  const { flashError } = req.session;
  delete req.session.flashError;

  const isCollector = req.user.role === 'COLLECTOR';
  const collectors = isCollector
    ? []
    : await collectorService.findCollectors(req.user.organizationId);

  return res.render('pages/expenses/new', {
    title: 'Registrar Gasto',
    user: req.user,
    currentPath: '/admin/expenses/new',
    isCollector,
    collectors,
    flashError,
  });
});

/**
 * POST /admin/expenses
 * Registra un gasto operativo. Un COLLECTOR siempre registra a su propio
 * nombre; un ADMIN/SUPER_ADMIN debe indicar para qué cobrador es.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
const createExpense = asyncHandler(async (req, res) => {
  const { category, amount, description, expenseDate, collectorId } = req.body;
  const isCollector = req.user.role === 'COLLECTOR';

  if (!isCollector && !collectorId) {
    req.session.flashError = 'Debes seleccionar para qué cobrador es el gasto';
    return res.redirect('/admin/expenses/new');
  }

  await expenseService.createExpense(
    req.user.organizationId,
    isCollector ? req.user.id : collectorId,
    { category, amount, description, expenseDate },
  );

  req.session.flashSucess = 'Gasto registrado exitosamente';
  return res.redirect('/admin/expenses');
});

/**
 * DELETE /admin/expenses/:id
 * Elimina un gasto. Solo el propio cobrador que lo registró o un
 * ADMIN/SUPER_ADMIN de la organización pueden hacerlo.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
const deleteExpense = asyncHandler(async (req, res) => {
  await expenseService.deleteExpense(req.params.id, req.user.organizationId, {
    id: req.user.id,
    role: req.user.role,
  });

  req.session.flashSucess = 'Gasto eliminado';
  return res.redirect('/admin/expenses');
});

// ============================================
// RUTAS DE COBRO
// ============================================

/**
 * GET /admin/routes
 * Lista las rutas de cobro de la organización.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
const getRoutes = asyncHandler(async (req, res) => {
  const { flashSucess, flashError } = req.session;
  delete req.session.flashSucess;
  delete req.session.flashError;

  const routes = await routeService.findRoutes(req.user.organizationId);

  return res.render('pages/routes/index', {
    title: 'Rutas',
    user: req.user,
    currentPath: '/admin/routes',
    routes,
    flashSucess,
    flashError,
  });
});

/**
 * GET /admin/routes/:id
 * Detalle de una ruta: clientes asignados y mapa con sus ubicaciones.
 */
const getRouteDetail = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const route = await routeService.findRouteWithClients(id, req.user.organizationId);

  return res.render('pages/routes/detail', {
    title: route.name,
    user: req.user,
    currentPath: '/admin/routes',
    route,
  });
});

/**
 * GET /admin/routes/new
 * Renderiza el formulario para crear una nueva ruta de cobro.
 */
const getNewRoute = asyncHandler(async (req, res) => {
  const { flashError } = req.session;
  delete req.session.flashError;

  // Obtenemos cobradores para asignar la ruta opcionalmente
  const collectors = await collectorService.findCollectors(req.user.organizationId);

  return res.render('pages/routes/new', {
    title: 'Nueva Ruta',
    user: req.user,
    currentPath: '/admin/routes/new',
    collectors,
    flashError,
  });
});

/**
 * POST /admin/routes
 * Crea una nueva ruta en la organización.
 */
const createRoute = asyncHandler(async (req, res) => {
  try {
    const { name, description, collectorId } = req.body;

    if (!name || String(name).trim() === '') {
      req.session.flashError = 'El nombre de la ruta es requerido';
      return req.session.save(() => res.redirect('/admin/routes/new'));
    }

    const payload = {
      name: String(name).trim(),
      description: description ? String(description).trim() : null,
      collectorId: collectorId || null,
      // checkbox returns 'on' when checked; normalizar a boolean
      isActive:
        req.body.isActive === 'on' || req.body.isActive === 'true' || req.body.isActive === true,
    };

    await routeService.createRoute(req.user.organizationId, payload);
    req.session.flashSucess = 'Ruta creada correctamente';
    return res.redirect('/admin/routes');
  } catch (error) {
    if (error.isOperational) {
      req.session.flashError = error.message;
      return req.session.save(() => res.redirect('/admin/routes/new'));
    }
    throw error;
  }
});

/**
 * GET /admin/routes/:id/edit
 * Renderiza el formulario para editar una ruta.
 */
const getEditRoute = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { flashError } = req.session;
  delete req.session.flashError;

  const [route, collectors] = await Promise.all([
    routeService.findRouteById(id, req.user.organizationId),
    collectorService.findCollectors(req.user.organizationId),
  ]);

  return res.render('pages/routes/edit', {
    title: 'Editar Ruta',
    user: req.user,
    currentPath: '/admin/routes',
    route,
    collectors,
    flashError,
  });
});

/**
 * PUT /admin/routes/:id
 * Actualiza una ruta existente.
 */
const updateRoute = asyncHandler(async (req, res) => {
  const { id } = req.params;

  try {
    const { name, description, collectorId } = req.body;

    if (!name || String(name).trim() === '') {
      req.session.flashError = 'El nombre de la ruta es requerido';
      return req.session.save(() => res.redirect(`/admin/routes/${id}/edit`));
    }

    const payload = {
      name: String(name).trim(),
      description: description ? String(description).trim() : null,
      collectorId: collectorId || null,
      isActive:
        req.body.isActive === 'on' || req.body.isActive === 'true' || req.body.isActive === true,
    };

    await routeService.updateRoute(id, req.user.organizationId, payload);
    req.session.flashSucess = 'Ruta actualizada correctamente';
    return res.redirect('/admin/routes');
  } catch (error) {
    if (error.isOperational) {
      req.session.flashError = error.message;
      return req.session.save(() => res.redirect(`/admin/routes/${id}/edit`));
    }
    throw error;
  }
});

// ============================================
// REPORTES
// ============================================

/**
 * GET /admin/reports
 * Muestra la página de reportes con preview de cartera del día.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
const getReports = asyncHandler(async (req, res) => {
  const { dateFrom, dateTo, routeId } = req.query;
  const { flashSucess, flashError } = req.session;
  delete req.session.flashSucess;
  delete req.session.flashError;

  const { portfolio, routes } = await reportService.getPortfolioReport(req.user.organizationId, {
    dateFrom,
    dateTo,
    routeId,
  });

  return res.render('pages/reports/index', {
    title: 'Reportes',
    user: req.user,
    currentPath: '/admin/reports',
    portfolio,
    routes,
    filters: {
      dateFrom: dateFrom || '',
      dateTo: dateTo || '',
      routeId: routeId || '',
    },
    flashSucess,
    flashError,
  });
});

// ============================================
// CONFIGURACIÓN
// ============================================

/**
 * GET /admin/settings
 * Muestra la página de configuración de la organización.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
const getSettings = asyncHandler(async (req, res) =>
  res.render('pages/settings', {
    title: 'Configuración',
    user: req.user,
    currentPath: '/admin/settings',
  }),
);

/**
 * GET /admin/api/customers/search?q=...
 * API para typeahead de clientes.
 */
const searchCustomers = asyncHandler(async (req, res) => {
  const q = String(req.query.q || '').trim();
  const limit = Math.min(Number.parseInt(req.query.limit || '15', 10) || 15, 50);

  const results = await clientService.searchClients(req.user.organizationId, q, limit);

  return apiResponse.success(res, results);
});

/**
 * GET /admin/api/collectors/search?q=...
 */
const searchCollectors = asyncHandler(async (req, res) => {
  const q = String(req.query.q || '').trim();
  const limit = Math.min(Number.parseInt(req.query.limit || '15', 10) || 15, 50);

  const results = await collectorService.searchCollectors(req.user.organizationId, q, limit);
  return apiResponse.success(res, results);
});

/**
 * GET /admin/api/collection_routes/search?q=...
 */
const searchRoutes = asyncHandler(async (req, res) => {
  const q = String(req.query.q || '').trim();
  const limit = Math.min(Number.parseInt(req.query.limit || '15', 10) || 15, 50);

  const results = await routeService.searchRoutes(req.user.organizationId, q, limit);
  return apiResponse.success(res, results);
});

// ============================================
// USUARIOS
// ============================================

/**
 * GET /admin/users
 * Lista los usuarios del sistema (solo SUPER_ADMIN).
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
const getUsers = asyncHandler(async (req, res) => {
  const { search } = req.query;
  const { flashSucess, flashError } = req.session;
  delete req.session.flashSucess;
  delete req.session.flashError;

  const users = await organizationService.findOrgUsers(req.user.organizationId, { search });

  return res.render('pages/users/index', {
    title: 'Usuarios',
    user: req.user,
    currentPath: '/admin/users',
    users,
    search: search || '',
    flashSucess,
    flashError,
  });
});

/**
 * GET /admin/users/new
 * Renderiza el formulario para crear un nuevo usuario.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
const getNewUser = asyncHandler(async (req, res) => {
  const { flashError } = req.session;
  delete req.session.flashError;

  return res.render('pages/users/new', {
    title: 'Nuevo Usuario',
    user: req.user,
    currentPath: '/admin/users/new',
    flashError,
  });
});

/**
 * POST /admin/users
 * Crea un nuevo usuario en la organización actual.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
const createUser = asyncHandler(async (req, res) => {
  try {
    await organizationService.createOrgUser(req.user.organizationId, req.body);
    req.session.flashSucess = 'Usuario creado correctamente';
    return res.redirect('/admin/users');
  } catch (error) {
    if (error.isOperational) {
      req.session.flashError = error.message;
      return req.session.save(() => res.redirect('/admin/users/new'));
    }
    throw error;
  }
});

/**
 * GET /admin/users/:id/edit
 * Renderiza el formulario para editar un usuario existente.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
const getEditUser = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { flashError } = req.session;
  delete req.session.flashError;

  // findOrgUserById lanza 404 si el usuario no existe — no se necesita verificación manual
  const targetUser = await organizationService.findOrgUserById(id, req.user.organizationId);

  return res.render('pages/users/edit', {
    title: 'Editar Usuario',
    user: req.user,
    currentPath: '/admin/users',
    targetUser,
    flashError,
  });
});

/**
 * PUT /admin/users/:id
 * Actualiza un usuario existente de la organización.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
const updateUser = asyncHandler(async (req, res) => {
  const { id } = req.params;

  try {
    await organizationService.updateOrgUser(id, req.user.organizationId, req.body);
    req.session.flashSucess = 'Usuario actualizado correctamente';
    return res.redirect('/admin/users');
  } catch (error) {
    if (error.isOperational) {
      req.session.flashError = error.message;
      return req.session.save(() => res.redirect(`/admin/users/${id}/edit`));
    }
    throw error;
  }
});

// ============================================
// ORGANIZACIONES
// ============================================

/**
 * GET /admin/organizations
 * Lista las organizaciones del sistema (solo SUPER_ADMIN).
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
const getOrganizations = asyncHandler(async (req, res) => {
  const { search } = req.query;
  const { flashSucess, flashError } = req.session;
  delete req.session.flashSucess;
  delete req.session.flashError;

  const organizations = await organizationService.findOrganizations({ search });

  return res.render('pages/organizations/index', {
    title: 'Organizaciones',
    user: req.user,
    currentPath: '/admin/organizations',
    organizations,
    search: search || '',
    flashSucess,
    flashError,
  });
});

/**
 * GET /admin/organizations/new
 * Renderiza el formulario para crear una nueva organización (solo SUPER_ADMIN).
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
const getNewOrganization = asyncHandler(async (req, res) => {
  const { flashError } = req.session;
  delete req.session.flashError;

  return res.render('pages/organizations/new', {
    title: 'Nueva Organización',
    user: req.user,
    currentPath: '/admin/organizations/new',
    flashError,
  });
});

/**
 * POST /admin/organizations
 * Crea una nueva organización en el sistema (solo SUPER_ADMIN).
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
const createOrganization = asyncHandler(async (req, res) => {
  try {
    await organizationService.createOrganization(req.body);
    req.session.flashSucess = 'Organización creada correctamente';
    return res.redirect('/admin/organizations');
  } catch (error) {
    if (error.isOperational) {
      req.session.flashError = error.message;
      return req.session.save(() => res.redirect('/admin/organizations/new'));
    }
    throw error;
  }
});

/**
 * GET /admin/organizations/:id/edit
 * Renderiza el formulario de edición de una organización (solo SUPER_ADMIN).
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
const getEditOrganization = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { flashError } = req.session;
  delete req.session.flashError;

  // findOrganizationById lanza 404 si la organización no existe.
  // No se necesita verificación manual.
  const organization = await organizationService.findOrganizationById(id);

  return res.render('pages/organizations/edit', {
    title: 'Editar Organización',
    user: req.user,
    currentPath: '/admin/organizations',
    organization,
    flashError,
  });
});

/**
 * PUT /admin/organizations/:id
 * Actualiza los datos de una organización existente (solo SUPER_ADMIN).
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
const updateOrganization = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const data = updateOrganizationSchema.parse(req);

  try {
    await organizationService.updateOrganization(id, data.body);
    req.session.flashSucess = 'Organización actualizada correctamente';
    return res.redirect('/admin/organizations');
  } catch (error) {
    if (error.isOperational) {
      req.session.flashError = error.message;
      return req.session.save(() => res.redirect(`/admin/organizations/${id}/edit`));
    }
    throw error;
  }
});

/**
 * GET /admin/api/loans/:id/next-installment
 * Retorna la cuota pendiente más antigua de un préstamo junto con el saldo de mora.
 * Usado por el formulario de pago para calcular el desglose predictivo en el cliente.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
const getLoanNextInstallment = asyncHandler(async (req, res) => {
  const data = await loanService.getNextInstallment(req.params.id, req.user.organizationId);

  if (!data) {
    return apiResponse.error(res, 'Préstamo no encontrado', 404);
  }

  return apiResponse.success(res, data);
});

export {
  getLogin,
  postLogin,
  logout,
  redirectToDashboard,
  getDashboard,
  getLoans,
  getNewLoan,
  previewLoan,
  createLoan,
  getLoan,
  getClients,
  getClient,
  getNewClient,
  createClient,
  getEditClient,
  updateClient,
  restrictClient,
  getCollectors,
  getNewCollector,
  createCollector,
  getEditCollector,
  updateCollector,
  deleteCollector,
  getPayments,
  getNewPayment,
  createPayment,
  getExpenses,
  getNewExpense,
  createExpense,
  deleteExpense,
  getRoutes,
  getRouteDetail,
  getNewRoute,
  createRoute,
  getEditRoute,
  updateRoute,
  getReports,
  getSettings,
  searchCustomers,
  searchCollectors,
  searchRoutes,
  getUsers,
  getNewUser,
  createUser,
  getEditUser,
  updateUser,
  getOrganizations,
  getNewOrganization,
  createOrganization,
  getEditOrganization,
  updateOrganization,
  getLoanNextInstallment,
};
