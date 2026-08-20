import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// --- Mocks: stubs para cada handler del controller ---
const mockGetLogin = jest.fn((req, res) => res.status(200).end());
const mockPostLogin = jest.fn((req, res) => res.status(200).end());
const mockGetDashboard = jest.fn((req, res) => res.status(200).end());
const mockGetLoans = jest.fn((req, res) => res.status(200).end());
const mockGetNewLoan = jest.fn((req, res) => res.status(200).end());
const mockPreviewLoan = jest.fn((req, res) => res.status(200).end());
const mockCreateLoan = jest.fn((req, res) => res.status(200).end());
const mockGetLoan = jest.fn((req, res) => res.status(200).end());
const mockGetClients = jest.fn((req, res) => res.status(200).end());
const mockGetClient = jest.fn((req, res) => res.status(200).end());
const mockGetNewClient = jest.fn((req, res) => res.status(200).end());
const mockCreateClient = jest.fn((req, res) => res.status(200).end());
const mockGetEditClient = jest.fn((req, res) => res.status(200).end());
const mockUpdateClient = jest.fn((req, res) => res.status(200).end());
const mockRestrictClient = jest.fn((req, res) => res.status(200).end());
const mockGetCollectors = jest.fn((req, res) => res.status(200).end());
const mockGetNewCollector = jest.fn((req, res) => res.status(200).end());
const mockCreateCollector = jest.fn((req, res) => res.status(200).end());
const mockGetEditCollector = jest.fn((req, res) => res.status(200).end());
const mockUpdateCollector = jest.fn((req, res) => res.status(200).end());
const mockDeleteCollector = jest.fn((req, res) => res.status(200).end());
const mockGetPayments = jest.fn((req, res) => res.status(200).end());
const mockGetNewPayment = jest.fn((req, res) => res.status(200).end());
const mockCreatePayment = jest.fn((req, res) => res.status(200).end());
const mockGetRoutes = jest.fn((req, res) => res.status(200).end());
const mockGetNewRoute = jest.fn((req, res) => res.status(200).end());
const mockCreateRoute = jest.fn((req, res) => res.status(200).end());
const mockGetRouteDetail = jest.fn((req, res) => res.status(200).end());
const mockGetEditRoute = jest.fn((req, res) => res.status(200).end());
const mockUpdateRoute = jest.fn((req, res) => res.status(200).end());
const mockGetReports = jest.fn((req, res) => res.status(200).end());
const mockExportReport = jest.fn((req, res) => res.status(200).end());
const mockGetSettings = jest.fn((req, res) => res.status(200).end());
const mockSearchCustomers = jest.fn((req, res) => res.status(200).end());
const mockSearchCollectors = jest.fn((req, res) => res.status(200).end());
const mockSearchRoutes = jest.fn((req, res) => res.status(200).end());
const mockGetUsers = jest.fn((req, res) => res.status(200).end());
const mockGetNewUser = jest.fn((req, res) => res.status(200).end());
const mockCreateUser = jest.fn((req, res) => res.status(200).end());
const mockGetEditUser = jest.fn((req, res) => res.status(200).end());
const mockUpdateUser = jest.fn((req, res) => res.status(200).end());
const mockGetOrganizations = jest.fn((req, res) => res.status(200).end());
const mockGetNewOrganization = jest.fn((req, res) => res.status(200).end());
const mockCreateOrganization = jest.fn((req, res) => res.status(200).end());
const mockLogout = jest.fn((req, res) => res.status(200).end());

jest.unstable_mockModule('../../src/controllers/admin.controller.js', () => ({
  getLogin: mockGetLogin,
  postLogin: mockPostLogin,
  getDashboard: mockGetDashboard,
  getLoans: mockGetLoans,
  getNewLoan: mockGetNewLoan,
  previewLoan: mockPreviewLoan,
  createLoan: mockCreateLoan,
  getLoan: mockGetLoan,
  getClients: mockGetClients,
  getClient: mockGetClient,
  getNewClient: mockGetNewClient,
  createClient: mockCreateClient,
  getEditClient: mockGetEditClient,
  updateClient: mockUpdateClient,
  restrictClient: mockRestrictClient,
  getCollectors: mockGetCollectors,
  getNewCollector: mockGetNewCollector,
  createCollector: mockCreateCollector,
  getEditCollector: mockGetEditCollector,
  updateCollector: mockUpdateCollector,
  deleteCollector: mockDeleteCollector,
  getPayments: mockGetPayments,
  getNewPayment: mockGetNewPayment,
  createPayment: mockCreatePayment,
  getRoutes: mockGetRoutes,
  getNewRoute: mockGetNewRoute,
  createRoute: mockCreateRoute,
  getRouteDetail: mockGetRouteDetail,
  getEditRoute: mockGetEditRoute,
  updateRoute: mockUpdateRoute,
  getReports: mockGetReports,
  getSettings: mockGetSettings,
  searchCustomers: mockSearchCustomers,
  searchCollectors: mockSearchCollectors,
  searchRoutes: mockSearchRoutes,
  getUsers: mockGetUsers,
  getNewUser: mockGetNewUser,
  createUser: mockCreateUser,
  getEditUser: mockGetEditUser,
  updateUser: mockUpdateUser,
  getOrganizations: mockGetOrganizations,
  getNewOrganization: mockGetNewOrganization,
  createOrganization: mockCreateOrganization,
  getEditOrganization: jest.fn((req, res) => res.status(200).end()),
  updateOrganization: jest.fn((req, res) => res.status(200).end()),
  getLoanNextInstallment: jest.fn((req, res) => res.status(200).end()),
  logout: mockLogout,
  redirectToDashboard: jest.fn((req, res) => res.redirect('/admin/dashboard')),
}));

jest.unstable_mockModule('../../src/controllers/report.controller.js', () => ({
  exportReport: mockExportReport,
}));

// Mock auth middleware: simula autenticación basada en req.session.user
const mockVerifySession = jest.fn((req, res, next) => {
  if (!req.session?.user) {
    return res.redirect('/admin/login');
  }
  req.user = req.session.user;
  return next();
});

jest.unstable_mockModule('../../src/middleware/auth.js', () => ({
  verifySession: mockVerifySession,
  verifyToken: jest.fn(),
}));

// Mock authorize: permite roles válidos
const mockAuthorize = jest.fn((...roles) => (req, res, next) => {
  if (!req.user) {
    return res
      .status(401)
      .json({ data: null, meta: null, error: { message: 'No autenticado', code: 'UNAUTHORIZED' } });
  }
  if (!roles.includes(req.user.role)) {
    return res.status(403).json({
      data: null,
      meta: null,
      error: { message: 'No autorizado', code: 'FORBIDDEN' },
    });
  }
  return next();
});

jest.unstable_mockModule('../../src/middleware/authorize.js', () => ({
  default: mockAuthorize,
}));

// Mock validate: bypass de validación de schemas en tests de rutas
jest.unstable_mockModule('../../src/middleware/validate.js', () => ({
  default: () => (req, res, next) => next(),
}));

// Importar express y el router DESPUÉS de mockear
const express = (await import('express')).default;
const adminRoutes = (await import('../../src/routes/admin.routes.js')).default;

// Importar supertest para pruebas HTTP
const request = (await import('supertest')).default;

// --- App de prueba ---
const createApp = () => {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Simular middleware de sesión
  app.use((req, _res, next) => {
    req.session = req.headers['x-test-session'] ? JSON.parse(req.headers['x-test-session']) : {};
    next();
  });

  app.use('/admin', adminRoutes);
  return app;
};

const adminSession = JSON.stringify({
  user: {
    id: 'user-001',
    role: 'ADMIN',
    organizationId: 'org-001',
    firstName: 'Admin',
    lastName: 'Test',
    email: 'admin@test.com',
  },
});

describe('admin.routes', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = createApp();
  });

  describe('public routes (no session required)', () => {
    it('GET /admin/login does not invoke verifySession', async () => {
      await request(app).get('/admin/login').expect(200);

      expect(mockGetLogin).toHaveBeenCalled();
      expect(mockVerifySession).not.toHaveBeenCalled();
    });

    it('POST /admin/login does not invoke verifySession', async () => {
      await request(app)
        .post('/admin/login')
        .send({ email: 'a@b.com', password: '123456' })
        .expect(200);

      expect(mockPostLogin).toHaveBeenCalled();
      expect(mockVerifySession).not.toHaveBeenCalled();
    });
  });

  describe('protected routes (session required)', () => {
    it('GET /admin/dashboard redirects to login without session', async () => {
      const res = await request(app).get('/admin/dashboard');

      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/admin/login');
    });

    it('GET /admin/dashboard calls handler with valid session', async () => {
      await request(app).get('/admin/dashboard').set('x-test-session', adminSession).expect(200);

      expect(mockGetDashboard).toHaveBeenCalled();
    });

    it('GET /admin/ redirects to /admin/dashboard', async () => {
      const res = await request(app).get('/admin/').set('x-test-session', adminSession);

      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/admin/dashboard');
    });
  });

  describe('loan routes', () => {
    it('GET /admin/loans calls getLoans', async () => {
      await request(app).get('/admin/loans').set('x-test-session', adminSession).expect(200);

      expect(mockGetLoans).toHaveBeenCalled();
    });

    it('GET /admin/loans/new calls getNewLoan', async () => {
      await request(app).get('/admin/loans/new').set('x-test-session', adminSession).expect(200);

      expect(mockGetNewLoan).toHaveBeenCalled();
    });

    it('POST /admin/loans calls createLoan', async () => {
      await request(app)
        .post('/admin/loans')
        .set('x-test-session', adminSession)
        .send({ clientId: 'c-001', principal: 100000 })
        .expect(200);

      expect(mockCreateLoan).toHaveBeenCalled();
    });

    it('GET /admin/loans/:id calls getLoan', async () => {
      await request(app)
        .get('/admin/loans/loan-123')
        .set('x-test-session', adminSession)
        .expect(200);

      expect(mockGetLoan).toHaveBeenCalled();
    });
  });

  describe('client routes', () => {
    it('GET /admin/clients calls getClients', async () => {
      await request(app).get('/admin/clients').set('x-test-session', adminSession).expect(200);

      expect(mockGetClients).toHaveBeenCalled();
    });

    it('GET /admin/clients/:id calls getClient', async () => {
      await request(app)
        .get('/admin/clients/client-456')
        .set('x-test-session', adminSession)
        .expect(200);

      expect(mockGetClient).toHaveBeenCalled();
    });

    it('PATCH /admin/clients/:id/status calls restrictClient', async () => {
      await request(app)
        .patch('/admin/clients/client-456/status')
        .set('x-test-session', adminSession)
        .expect(200);

      expect(mockRestrictClient).toHaveBeenCalled();
    });
  });

  describe('collector routes', () => {
    it('GET /admin/collectors calls getCollectors', async () => {
      await request(app).get('/admin/collectors').set('x-test-session', adminSession).expect(200);

      expect(mockGetCollectors).toHaveBeenCalled();
    });

    it('GET /admin/collectors/new calls getNewCollector', async () => {
      await request(app)
        .get('/admin/collectors/new')
        .set('x-test-session', adminSession)
        .expect(200);

      expect(mockGetNewCollector).toHaveBeenCalled();
    });

    it('POST /admin/collectors calls createCollector', async () => {
      await request(app)
        .post('/admin/collectors')
        .set('x-test-session', adminSession)
        .send({ firstName: 'Test' })
        .expect(200);

      expect(mockCreateCollector).toHaveBeenCalled();
    });

    it('GET /admin/collectors/:id/edit calls getEditCollector', async () => {
      await request(app)
        .get('/admin/collectors/abc/edit')
        .set('x-test-session', adminSession)
        .expect(200);

      expect(mockGetEditCollector).toHaveBeenCalled();
    });

    it('PUT /admin/collectors/:id calls updateCollector', async () => {
      await request(app)
        .put('/admin/collectors/abc')
        .set('x-test-session', adminSession)
        .send({ firstName: 'Edit' })
        .expect(200);

      expect(mockUpdateCollector).toHaveBeenCalled();
    });

    it('DELETE /admin/collectors/:id calls deleteCollector', async () => {
      await request(app)
        .delete('/admin/collectors/abc')
        .set('x-test-session', adminSession)
        .expect(200);

      expect(mockDeleteCollector).toHaveBeenCalled();
    });
  });

  describe('route routes', () => {
    it('GET /admin/routes calls getRoutes', async () => {
      await request(app).get('/admin/routes').set('x-test-session', adminSession).expect(200);

      expect(mockGetRoutes).toHaveBeenCalled();
    });

    it('GET /admin/routes/new calls getNewRoute', async () => {
      await request(app).get('/admin/routes/new').set('x-test-session', adminSession).expect(200);

      expect(mockGetNewRoute).toHaveBeenCalled();
    });

    it('POST /admin/routes calls createRoute', async () => {
      await request(app)
        .post('/admin/routes')
        .set('x-test-session', adminSession)
        .send({ name: 'Route' })
        .expect(200);

      expect(mockCreateRoute).toHaveBeenCalled();
    });

    it('GET /admin/routes/:id/edit calls getEditRoute', async () => {
      await request(app)
        .get('/admin/routes/xyz/edit')
        .set('x-test-session', adminSession)
        .expect(200);

      expect(mockGetEditRoute).toHaveBeenCalled();
    });

    it('PUT /admin/routes/:id calls updateRoute', async () => {
      await request(app)
        .put('/admin/routes/xyz')
        .set('x-test-session', adminSession)
        .send({ name: 'Route edit' })
        .expect(200);

      expect(mockUpdateRoute).toHaveBeenCalled();
    });

    it('GET /admin/routes/:id calls getRouteDetail', async () => {
      await request(app).get('/admin/routes/xyz').set('x-test-session', adminSession).expect(200);

      expect(mockGetRouteDetail).toHaveBeenCalled();
    });
  });

  describe('payment routes', () => {
    it('GET /admin/payments calls getPayments', async () => {
      await request(app).get('/admin/payments').set('x-test-session', adminSession).expect(200);

      expect(mockGetPayments).toHaveBeenCalled();
    });
  });

  describe('report routes', () => {
    it('GET /admin/reports calls getReports', async () => {
      await request(app).get('/admin/reports').set('x-test-session', adminSession).expect(200);

      expect(mockGetReports).toHaveBeenCalled();
    });

    it('GET /admin/reports/export?format=csv calls exportReport', async () => {
      await request(app)
        .get('/admin/reports/export?format=csv')
        .set('x-test-session', adminSession)
        .expect(200);

      expect(mockExportReport).toHaveBeenCalled();
    });
  });

  describe('settings routes', () => {
    it('GET /admin/settings calls getSettings', async () => {
      await request(app).get('/admin/settings').set('x-test-session', adminSession).expect(200);

      expect(mockGetSettings).toHaveBeenCalled();
    });
  });

  describe('SUPER_ADMIN only routes', () => {
    const superSession = JSON.stringify({
      user: {
        id: 'user-003',
        role: 'SUPER_ADMIN',
        organizationId: 'org-001',
        firstName: 'Super',
        lastName: 'Admin',
      },
    });

    it('GET /admin/users calls getUsers for SUPER_ADMIN', async () => {
      await request(app).get('/admin/users').set('x-test-session', superSession).expect(200);

      expect(mockGetUsers).toHaveBeenCalled();
    });

    it('GET /admin/organizations calls getOrganizations for SUPER_ADMIN', async () => {
      await request(app)
        .get('/admin/organizations')
        .set('x-test-session', superSession)
        .expect(200);

      expect(mockGetOrganizations).toHaveBeenCalled();
    });

    it('returns 403 for ADMIN role on /admin/users', async () => {
      const res = await request(app).get('/admin/users').set('x-test-session', adminSession);

      expect(res.status).toBe(403);
    });

    it('returns 403 for ADMIN role on /admin/organizations', async () => {
      const res = await request(app)
        .get('/admin/organizations')
        .set('x-test-session', adminSession);

      expect(res.status).toBe(403);
    });
  });

  describe('RBAC enforcement', () => {
    it('returns 403 for COLLECTOR role on protected routes', async () => {
      const collectorSession = JSON.stringify({
        user: {
          id: 'user-002',
          role: 'COLLECTOR',
          organizationId: 'org-001',
          firstName: 'Cobrador',
          lastName: 'Test',
        },
      });

      const res = await request(app)
        .get('/admin/dashboard')
        .set('x-test-session', collectorSession);

      expect(res.status).toBe(403);
    });

    it('allows SUPER_ADMIN role on protected routes', async () => {
      const superSession = JSON.stringify({
        user: {
          id: 'user-003',
          role: 'SUPER_ADMIN',
          organizationId: 'org-001',
          firstName: 'Super',
          lastName: 'Admin',
        },
      });

      await request(app).get('/admin/dashboard').set('x-test-session', superSession).expect(200);

      expect(mockGetDashboard).toHaveBeenCalled();
    });
  });
});
