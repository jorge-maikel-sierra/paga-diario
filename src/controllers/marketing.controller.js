import Decimal from 'decimal.js';
import prisma from '../config/prisma.js';
import asyncHandler from '../utils/asyncHandler.js';

/**
 * GET /
 * Landing page pública de venta. Muestra estadísticas reales de la
 * organización de demostración (datos ficticios de seed, no de clientes
 * reales) para dar prueba social honesta: "así se ve funcionando", en vez
 * de cifras de adopción inventadas.
 */
const getLanding = asyncHandler(async (req, res) => {
  const [loanAggregates, totalClients, totalRoutes, totalPayments] = await Promise.all([
    prisma.loan.aggregate({
      _sum: { principalAmount: true, totalPaid: true },
      _count: true,
    }),
    prisma.client.count(),
    prisma.route.count(),
    prisma.payment.count(),
  ]);

  const stats = {
    totalDisbursed: new Decimal(loanAggregates._sum.principalAmount || 0).toFixed(0),
    totalCollected: new Decimal(loanAggregates._sum.totalPaid || 0).toFixed(0),
    totalLoans: loanAggregates._count,
    totalClients,
    totalRoutes,
    totalPayments,
  };

  return res.render('pages/landing', {
    title: 'Cobra tu cartera diaria sin perder ni una cuota',
    stats,
  });
});

export { getLanding };
