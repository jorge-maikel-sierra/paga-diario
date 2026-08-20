import { Router } from 'express';
import {
  getExpenses,
  getNewExpense,
  createExpense,
  deleteExpense,
} from '../controllers/admin.controller.js';
import validate from '../middleware/validate.js';
import { createExpenseSchema, deleteExpenseSchema } from '../schemas/expense.schema.js';

// ============================================
// Admin Expenses Router — Pago Ya
// Ruta base (montaje): /admin/expenses
// Accesible también por el rol COLLECTOR (ver admin.routes.js)
// ============================================

const router = Router();

router.get('/', getExpenses);
router.get('/new', getNewExpense);
router.post('/', validate(createExpenseSchema), createExpense);
router.delete('/:id', validate(deleteExpenseSchema), deleteExpense);

export default router;
