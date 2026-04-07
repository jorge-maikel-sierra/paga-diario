import { describe, it } from '@jest/globals';

describe.skip('Import Service', () => {
  // FIXME: Tests deshabilitados temporalmente
  // Requiere refactor para usar ExcelJS en lugar de xlsx
  // y exportar funciones de validación internas

  it.skip('placeholder test', () => {
    // Este test existe solo para evitar errores de Jest
    // cuando todo el describe está deshabilitado
  });
});
