-- Recrea la tabla "session" (requerida por connect-pg-simple) que la migración
-- 20260407203202_add_external_ids_to_clients_and_loans eliminó accidentalmente
-- al haberse generado con `prisma migrate diff` sin filtrar el DROP TABLE que
-- Prisma propone para tablas fuera de su schema. En bases ya existentes esto
-- pasó desapercibido porque la tabla se había recreado a mano; en una base
-- nueva, correr el historial completo de migraciones la deja inexistente.
CREATE TABLE IF NOT EXISTS "session" (
  "sid"    varchar       NOT NULL COLLATE "default",
  "sess"   json          NOT NULL,
  "expire" timestamp(6)  NOT NULL
);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'session_pkey'
  ) THEN
    ALTER TABLE "session"
      ADD CONSTRAINT "session_pkey"
      PRIMARY KEY ("sid") NOT DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");
