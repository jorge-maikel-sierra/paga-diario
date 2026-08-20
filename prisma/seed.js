import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';
import Decimal from 'decimal.js';
import dayjs from 'dayjs';

const prisma = new PrismaClient();
const SALT_ROUNDS = 10;

// Las contraseñas por defecto del seed se leen desde variables de entorno para
// evitar credentials hardcodeadas en el repositorio. Los valores de fallback
// solo son aceptables en entornos de desarrollo local — en CI/staging configura
// SEED_ADMIN_PASSWORD y SEED_COLLECTOR_PASSWORD con valores distintos.
const SEED_ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? 'Admin123!';
const SEED_COLLECTOR_PASSWORD = process.env.SEED_COLLECTOR_PASSWORD ?? 'Cobrador123!';

/**
 * Genera el hash de una contraseña.
 * @param {string} password
 * @returns {Promise<string>}
 */
const hashPassword = (password) => bcrypt.hash(password, SALT_ROUNDS);

/**
 * Genera el cronograma de cuotas para un préstamo FIXED diario.
 * @param {object} params
 * @param {string} params.loanId
 * @param {Decimal} params.totalAmount
 * @param {Decimal} params.principalAmount
 * @param {number} params.numberOfPayments
 * @param {string} params.startDate - YYYY-MM-DD
 * @returns {Array}
 */
const buildSchedule = ({ loanId, totalAmount, principalAmount, numberOfPayments, startDate }) => {
  const installment = new Decimal(totalAmount).dividedBy(numberOfPayments).toDecimalPlaces(2);
  const principalPer = new Decimal(principalAmount).dividedBy(numberOfPayments).toDecimalPlaces(2);
  const interestPer = installment.minus(principalPer);

  const schedule = [];
  for (let i = 1; i <= numberOfPayments; i += 1) {
    schedule.push({
      loanId,
      installmentNumber: i,
      dueDate: dayjs(startDate).add(i, 'day').toDate(),
      amountDue: installment.toNumber(),
      principalDue: principalPer.toNumber(),
      interestDue: interestPer.toNumber(),
      amountPaid: 0,
      isPaid: false,
    });
  }

  return schedule;
};

const seed = async () => {
  // --- Limpiar datos existentes (orden por FK) ---
  await prisma.gpsLocation.deleteMany();
  await prisma.incident.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.paymentSchedule.deleteMany();
  await prisma.loan.deleteMany();
  await prisma.client.deleteMany();
  await prisma.route.deleteMany();
  await prisma.user.deleteMany();
  await prisma.organization.deleteMany();

  // ============================================
  // 1. ORGANIZACIÓN
  // ============================================
  const org = await prisma.organization.create({
    data: {
      name: 'Prestamos El Paisa',
      nit: '900123456-1',
      phone: '3101234567',
      email: 'admin@elpaisa.com',
      address: 'Cra 45 #32-10, Medellín, Antioquia',
      isActive: true,
    },
  });
  // ============================================
  // 2. USUARIOS
  // ============================================
  const defaultPassword = await hashPassword(SEED_ADMIN_PASSWORD);
  const collectorPassword = await hashPassword(SEED_COLLECTOR_PASSWORD);

  const _superAdmin = await prisma.user.create({
    data: {
      organizationId: org.id,
      role: 'SUPER_ADMIN',
      firstName: 'Jorge',
      lastName: 'Sierra',
      email: 'jorge@elpaisa.com',
      phone: '3001112233',
      passwordHash: defaultPassword,
      isActive: true,
    },
  });

  const _admin = await prisma.user.create({
    data: {
      organizationId: org.id,
      role: 'ADMIN',
      firstName: 'María',
      lastName: 'Gómez',
      email: 'maria@elpaisa.com',
      phone: '3004445566',
      passwordHash: defaultPassword,
      isActive: true,
    },
  });

  const collector1 = await prisma.user.create({
    data: {
      organizationId: org.id,
      role: 'COLLECTOR',
      firstName: 'Carlos',
      lastName: 'López',
      email: 'carlos@elpaisa.com',
      phone: '3007778899',
      passwordHash: collectorPassword,
      isActive: true,
    },
  });

  const collector2 = await prisma.user.create({
    data: {
      organizationId: org.id,
      role: 'COLLECTOR',
      firstName: 'Andrés',
      lastName: 'Martínez',
      email: 'andres@elpaisa.com',
      phone: '3012345678',
      passwordHash: collectorPassword,
      isActive: true,
    },
  });

  // ============================================
  // 3. RUTAS
  // ============================================
  const route1 = await prisma.route.create({
    data: {
      organizationId: org.id,
      collectorId: collector1.id,
      name: 'Ruta Centro',
      description: 'Centro de Medellín, La Candelaria y alrededores',
      isActive: true,
    },
  });

  const route2 = await prisma.route.create({
    data: {
      organizationId: org.id,
      collectorId: collector2.id,
      name: 'Ruta Envigado',
      description: 'Envigado y Sabaneta zona comercial',
      isActive: true,
    },
  });

  // ============================================
  // 4. CLIENTES
  // ============================================
  const clientsData = [
    {
      routeId: route1.id,
      firstName: 'Ana',
      lastName: 'García',
      documentNumber: '1017234567',
      phone: '3201112233',
      address: 'Cra 52 #48-20, Medellín',
      businessName: 'Tienda Doña Ana',
      businessAddress: 'Cra 52 #48-20 Local 1',
      latitude: 6.2442,
      longitude: -75.5812,
    },
    {
      routeId: route1.id,
      firstName: 'Pedro',
      lastName: 'Ramírez',
      documentNumber: '71789012',
      phone: '3114445566',
      address: 'Cll 50 #43-15, Medellín',
      businessName: 'Miscelánea El Progreso',
      businessAddress: 'Cll 50 #43-15',
      latitude: 6.2518,
      longitude: -75.5636,
    },
    {
      routeId: route1.id,
      firstName: 'Luz',
      lastName: 'Hernández',
      documentNumber: '43567890',
      phone: '3157778899',
      address: 'Cra 46 #52-30, Medellín',
      businessName: 'Papelería La Estrella',
      latitude: 6.2490,
      longitude: -75.5720,
    },
    {
      routeId: route2.id,
      firstName: 'Ricardo',
      lastName: 'Ospina',
      documentNumber: '98765432',
      phone: '3009876543',
      address: 'Cll 37S #27-10, Envigado',
      businessName: 'Ferretería El Maestro',
      businessAddress: 'Cll 37S #27-10',
      latitude: 6.1710,
      longitude: -75.5823,
    },
    {
      routeId: route2.id,
      firstName: 'Sandra',
      lastName: 'Muñoz',
      documentNumber: '1035678901',
      phone: '3126543210',
      address: 'Cra 43A #75S-20, Sabaneta',
      businessName: 'Restaurante Sabor Paisa',
      latitude: 6.1517,
      longitude: -75.6165,
    },
  ];

  const clients = [];
  for (const data of clientsData) {
    const client = await prisma.client.create({
      data: { organizationId: org.id, documentType: 'CC', ...data },
    });
    clients.push(client);
  }

  // ============================================
  // 5. PRÉSTAMOS + CRONOGRAMA
  // ============================================
  const loansConfig = [
    {
      client: clients[0],
      collector: collector1,
      principal: 500000,
      rate: 0.20,
      payments: 30,
      startDaysAgo: 10,
      paidInstallments: 8,
    },
    {
      client: clients[1],
      collector: collector1,
      principal: 300000,
      rate: 0.20,
      payments: 20,
      startDaysAgo: 5,
      paidInstallments: 4,
    },
    {
      client: clients[2],
      collector: collector1,
      principal: 200000,
      rate: 0.15,
      payments: 15,
      startDaysAgo: 3,
      paidInstallments: 2,
    },
    {
      client: clients[3],
      collector: collector2,
      principal: 1000000,
      rate: 0.20,
      payments: 30,
      startDaysAgo: 15,
      paidInstallments: 12,
    },
    {
      client: clients[4],
      collector: collector2,
      principal: 400000,
      rate: 0.18,
      payments: 24,
      startDaysAgo: 7,
      paidInstallments: 5,
    },
  ];

  for (const cfg of loansConfig) {
    const principal = new Decimal(cfg.principal);
    const total = principal.times(new Decimal(1).plus(cfg.rate));
    const installment = total.dividedBy(cfg.payments).toDecimalPlaces(2);
    const paidAmount = installment.times(cfg.paidInstallments);
    const outstanding = total.minus(paidAmount);
    const startDate = dayjs().subtract(cfg.startDaysAgo, 'day').format('YYYY-MM-DD');
    const endDate = dayjs(startDate).add(cfg.payments, 'day').format('YYYY-MM-DD');

    const loan = await prisma.loan.create({
      data: {
        organizationId: org.id,
        clientId: cfg.client.id,
        collectorId: cfg.collector.id,
        status: 'ACTIVE',
        amortizationType: 'FIXED',
        paymentFrequency: 'DAILY',
        principalAmount: principal.toNumber(),
        interestRate: cfg.rate,
        totalAmount: total.toNumber(),
        installmentAmount: installment.toNumber(),
        totalPaid: paidAmount.toNumber(),
        outstandingBalance: outstanding.toNumber(),
        moraAmount: 0,
        numberOfPayments: cfg.payments,
        paidPayments: cfg.paidInstallments,
        disbursementDate: new Date(startDate),
        expectedEndDate: new Date(endDate),
      },
    });

    // Cronograma
    const schedule = buildSchedule({
      loanId: loan.id,
      totalAmount: total,
      principalAmount: principal,
      numberOfPayments: cfg.payments,
      startDate,
    });

    // Marcar cuotas pagadas
    for (let i = 0; i < cfg.paidInstallments; i += 1) {
      schedule[i].isPaid = true;
      schedule[i].amountPaid = schedule[i].amountDue;
      schedule[i].paidAt = dayjs(schedule[i].dueDate).toDate();
    }

    await prisma.paymentSchedule.createMany({ data: schedule });

    // Registrar pagos para cuotas pagadas
    const paidSchedules = await prisma.paymentSchedule.findMany({
      where: { loanId: loan.id, isPaid: true },
      orderBy: { installmentNumber: 'asc' },
    });

    for (const ps of paidSchedules) {
      await prisma.payment.create({
        data: {
          loanId: loan.id,
          paymentScheduleId: ps.id,
          collectorId: cfg.collector.id,
          amount: ps.amountDue,
          moraAmount: 0,
          totalReceived: ps.amountDue,
          paymentMethod: 'CASH',
          collectedAt: ps.paidAt || new Date(),
          telegramSent: false,
        },
      });
    }
  }

  // ============================================
  // RESUMEN
  // ============================================
  // Solo mostrar credenciales fuera de producción para evitar leaks en logs de CI/CD
};

seed()
  .catch((err) => {
    console.error('❌ Error en seed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
