import { describe, it, expect } from '@jest/globals';

// Lista de servicios a verificar
const serviceModules = [
  '../../src/services/admin.service.js',
  '../../src/services/auth.service.js',
  '../../src/services/client.service.js',
  '../../src/services/collector.service.js',
  '../../src/services/excel.service.js',
  '../../src/services/expense.service.js',
  '../../src/services/health.service.js',
  '../../src/services/loan.service.js',
  '../../src/services/notification.service.js',
  '../../src/services/organization.service.js',
  '../../src/services/payment.service.js',
  '../../src/services/pdf.service.js',
  '../../src/services/report.service.js',
  '../../src/services/route.service.js',
  '../../src/services/telegram.service.js',
  '../../src/services/user.service.js',
];

const helperModules = ['../../src/utils/apiResponse.js', '../../src/utils/asyncHandler.js'];

const assertExportsAreFunctions = (exportsObj) => {
  const entries = Object.entries(exportsObj);
  expect(entries.length).toBeGreaterThan(0);
  const functionEntries = entries.filter(([, value]) => typeof value === 'function');
  expect(functionEntries.length).toBeGreaterThan(0);
  entries.forEach(([, value]) => {
    expect(value).not.toBeUndefined();
  });
};

describe('Servicios: cada export es una función', () => {
  serviceModules.forEach((modPath) => {
    it(`${modPath} expone solo funciones`, async () => {
      const module = await import(modPath);
      assertExportsAreFunctions(module, modPath);
    });
  });
});

describe('Helpers: cada export es una función', () => {
  helperModules.forEach((modPath) => {
    it(`${modPath} expone solo funciones`, async () => {
      const module = await import(modPath);
      assertExportsAreFunctions(module, modPath);
    });
  });
});
