-- CreateEnum
CREATE TYPE "ImportBatchStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED');

-- CreateEnum
CREATE TYPE "ImportRowStatus" AS ENUM ('VALID', 'INVALID', 'IMPORTED', 'SKIPPED', 'FAILED');

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "external_payment_id" VARCHAR(100);

-- CreateTable
CREATE TABLE "import_batches" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "file_name" VARCHAR(255) NOT NULL,
    "status" "ImportBatchStatus" NOT NULL DEFAULT 'PENDING',
    "total_rows" INTEGER NOT NULL DEFAULT 0,
    "processed_rows" INTEGER NOT NULL DEFAULT 0,
    "success_rows" INTEGER NOT NULL DEFAULT 0,
    "error_rows" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_rows" (
    "id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "sheet_type" VARCHAR(20) NOT NULL,
    "row_number" INTEGER NOT NULL,
    "status" "ImportRowStatus" NOT NULL,
    "raw_data" JSONB NOT NULL,
    "parsed_data" JSONB,
    "errors" JSONB,
    "warnings" JSONB,
    "entity_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "import_rows_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "import_batches_organization_id_created_at_idx" ON "import_batches"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "import_rows_batch_id_sheet_type_status_idx" ON "import_rows"("batch_id", "sheet_type", "status");

-- CreateIndex
CREATE UNIQUE INDEX "payments_loan_id_external_payment_id_key" ON "payments"("loan_id", "external_payment_id");

-- AddForeignKey
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "import_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

