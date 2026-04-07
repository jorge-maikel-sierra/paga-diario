/**
 * Crea un middleware Express que valida req.body, req.query y req.params
 * contra un esquema de Zod. Si la validación falla, el ZodError se
 * propaga a next() para ser capturado por el errorHandler global (422).
 *
 * @param {import('zod').ZodObject} schema - Esquema Zod con claves opcionales: body, query, params
 * @returns {import('express').RequestHandler}
 *
 * @example
 * // Validar solo body:
 * validate(z.object({ body: registerPaymentSchema }))
 *
 * // Validar body + params:
 * validate(z.object({
 *   params: z.object({ id: z.string().uuid() }),
 *   body: updateLoanSchema,
 * }))
 */
const validate = (schema) => async (req, _res, next) => {
  try {
    const parsed = await schema.parseAsync({
      body: req.body,
      query: req.query,
      params: req.params,
      // Incluimos req.file para que los schemas de upload puedan validar metadatos del archivo
      ...(req.file !== undefined && { file: req.file }),
    });

    req.body = parsed.body ?? req.body;
    req.query = parsed.query ?? req.query;
    req.params = parsed.params ?? req.params;

    return next();
  } catch (err) {
    return next(err);
  }
};

export default validate;
