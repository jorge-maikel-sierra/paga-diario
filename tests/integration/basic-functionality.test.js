import { describe, it, expect } from '@jest/globals';

describe('Integration Tests - Basic Functionality', () => {
  describe('Payment Split Engine', () => {
    it('las funciones del engine están disponibles', async () => {
      const { splitPayment, classifyPayment, applyEarlyPaymentForgiveness } = await import(
        '../../src/engine/payment-split.js'
      );

      expect(typeof splitPayment).toBe('function');
      expect(typeof classifyPayment).toBe('function');
      expect(typeof applyEarlyPaymentForgiveness).toBe('function');
    });

    it('splitPayment básico funciona', async () => {
      const { splitPayment } = await import('../../src/engine/payment-split.js');

      const result = splitPayment(100, 0, 50, 50);

      expect(result.moraApplied).toBe('0.00');
      expect(result.interestApplied).toBe('50.00');
      expect(result.principalApplied).toBe('50.00');
      expect(result.excess).toBe('0.00');
    });

    it('classifyPayment identifica tipos correctamente', async () => {
      const { classifyPayment } = await import('../../src/engine/payment-split.js');

      // classifyPayment espera un objeto split, no parámetros individuales
      const splitPartial = { interestApplied: '25.00', principalApplied: '0.00', excess: '0.00' };
      const splitInterestOnly = {
        interestApplied: '50.00',
        principalApplied: '0.00',
        excess: '0.00',
      };
      const splitFull = { interestApplied: '50.00', principalApplied: '50.00', excess: '0.00' };
      const splitOver = { interestApplied: '50.00', principalApplied: '50.00', excess: '50.00' };

      expect(classifyPayment(splitPartial, 50, 50, 1000)).toBe('PARTIAL_INTEREST');
      expect(classifyPayment(splitInterestOnly, 50, 50, 1000)).toBe('INTEREST_ONLY');
      expect(classifyPayment(splitFull, 50, 50, 1000)).toBe('FULL');
      expect(classifyPayment(splitOver, 50, 50, 1000)).toBe('OVERPAYMENT');
    });
  });

  describe('Import Service', () => {
    it('las funciones del servicio están disponibles', async () => {
      const { parseImportFile, executeImport } = await import(
        '../../src/services/import.service.js'
      );

      expect(typeof parseImportFile).toBe('function');
      expect(typeof executeImport).toBe('function');
    });
  });
  describe('Validation Schemas', () => {
    it('esquemas de importación están disponibles', async () => {
      const {
        uploadFileSchema,
        confirmImportSchema,
        downloadTemplateSchema,
        importClientSchema,
        importLoanSchema,
        importPaymentSchema,
      } = await import('../../src/schemas/import.schema.js');

      expect(uploadFileSchema).toBeDefined();
      expect(confirmImportSchema).toBeDefined();
      expect(downloadTemplateSchema).toBeDefined();
      expect(importClientSchema).toBeDefined();
      expect(importLoanSchema).toBeDefined();
      expect(importPaymentSchema).toBeDefined();
    });
  });

  describe('Controllers', () => {
    it('controlador de importación está disponible', async () => {
      const {
        showImportPage,
        uploadFile,
        showPreview,
        confirmImport,
        showResults,
        downloadTemplate,
        uploadMiddleware,
      } = await import('../../src/controllers/import.controller.js');

      expect(typeof showImportPage).toBe('function');
      expect(typeof uploadFile).toBe('function');
      expect(typeof showPreview).toBe('function');
      expect(typeof confirmImport).toBe('function');
      expect(typeof showResults).toBe('function');
      expect(typeof downloadTemplate).toBe('function');
      expect(uploadMiddleware).toBeDefined();
    });
  });

  describe('Payment Service Integration', () => {
    it('payment service incluye funciones principales', async () => {
      // Solo verificamos que las funciones existen sin ejecutarlas
      const paymentService = await import('../../src/services/payment.service.js');

      expect(typeof paymentService.processPayment).toBe('function');
      expect(typeof paymentService.registerAdminPayment).toBe('function');
      expect(typeof paymentService.registerPayment).toBe('function');
      expect(typeof paymentService.batchSync).toBe('function');
    });
  });

  describe('Routes Integration', () => {
    it('rutas de importación están disponibles', async () => {
      const router = await import('../../src/routes/admin.imports.routes.js');

      expect(router.default).toBeDefined();
      expect(typeof router.default).toBe('function'); // Router es una función
    });
  });
});
