import { z } from 'zod';

const EXPENSE_CATEGORIES = ['FUEL', 'VEHICLE_REPAIR', 'FOOD', 'OTHER'];

/**
 * Schema de validación para registrar un gasto operativo.
 * POST /admin/expenses
 *
 * @type {z.ZodObject}
 */
const createExpenseSchema = z.object({
  body: z.object({
    category: z.enum(EXPENSE_CATEGORIES, {
      required_error: 'La categoría es obligatoria',
      invalid_type_error: 'Categoría no válida',
    }),

    amount: z.coerce
      .number({ required_error: 'El monto es obligatorio' })
      .positive('El monto debe ser mayor a 0')
      .max(99999999.99, 'El monto es demasiado alto'),

    description: z
      .string()
      .max(500, 'La descripción no puede superar 500 caracteres')
      .trim()
      .optional()
      .or(z.literal('')),

    expenseDate: z
      .string({ required_error: 'La fecha es obligatoria' })
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'La fecha debe tener el formato YYYY-MM-DD'),

    collectorId: z.string().uuid('El cobrador debe ser un ID válido').optional(),
  }),
});

/**
 * Schema de validación para eliminar un gasto.
 * DELETE /admin/expenses/:id
 */
const deleteExpenseSchema = z.object({
  params: z.object({
    id: z.string().uuid('El ID del gasto debe ser un UUID válido'),
  }),
});

export { createExpenseSchema, deleteExpenseSchema, EXPENSE_CATEGORIES };
