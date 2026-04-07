/*
  Warnings:

  - You are about to drop the `session` table. If the table is not empty, all the data it contains will be lost.
  - A unique constraint covering the columns `[organization_id,external_client_id]` on the table `clients` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[organization_id,external_loan_id]` on the table `loans` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "payment_schedules_is_restructured_idx";

-- AlterTable
ALTER TABLE "clients" ADD COLUMN     "external_client_id" VARCHAR(100);

-- AlterTable
ALTER TABLE "loans" ADD COLUMN     "external_loan_id" VARCHAR(100);

-- DropTable
DROP TABLE "session";

-- CreateIndex
CREATE INDEX "clients_external_client_id_idx" ON "clients"("external_client_id");

-- CreateIndex
CREATE UNIQUE INDEX "clients_organization_id_external_client_id_key" ON "clients"("organization_id", "external_client_id");

-- CreateIndex
CREATE INDEX "loans_external_loan_id_idx" ON "loans"("external_loan_id");

-- CreateIndex
CREATE UNIQUE INDEX "loans_organization_id_external_loan_id_key" ON "loans"("organization_id", "external_loan_id");
