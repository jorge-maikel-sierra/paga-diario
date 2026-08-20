# Paga Diario

Plataforma SaaS para la gestión de carteras de préstamos con cobro diario (el modelo
conocido en Colombia como "gota a gota"). Reemplaza el cuaderno y el Excel: los
cobradores registran pagos y gastos desde el celular, la mora se calcula sola y el
dueño del negocio ve todo desde un panel que se actualiza en vivo.

Construida sobre el marco de tasa de usura colombiano (Ley 510/99) y pensada para
operar en pesos colombianos (COP).

## Demo en vivo

- **Landing**: https://paga-diario.fly.dev
- **Panel admin**: https://paga-diario.fly.dev/admin/login
- **Cuenta demo pública**: `demo@pagadiario.com` / `Demo2026!`

## Stack

- **Backend**: Node.js (ESM) + Express
- **Vistas**: EJS + Tailwind CSS
- **Base de datos**: PostgreSQL 16 + Prisma ORM
- **Colas / tiempo real**: BullMQ (Redis) + Socket.io
- **Autenticación**: sesiones (`express-session` + `connect-pg-simple`) para el panel
  admin; JWT para la API REST
- **Tests**: Jest + Supertest
- **Deploy**: Docker + Fly.io

## Módulos principales

| Módulo | Descripción |
|---|---|
| Préstamos | Alta, cronograma de cuotas, amortización fija o saldo decreciente |
| Pagos | Registro de recaudo, split automático mora → interés → capital |
| Cobradores | Rutas de cobro, mapa en vivo, GPS |
| Gastos | Registro de gastos operativos (combustible, reparaciones, comida) por cobrador |
| Importación | Carga masiva desde Excel/CSV con validación fila a fila y corrección en línea |
| Reportes | KPIs de cartera, mora acumulada, recaudo por período |
| Notificaciones | Recibos de pago por Telegram |

## Requisitos

- Node.js ≥ 20
- PostgreSQL 16 (con PostGIS si se usan las funciones de geolocalización)
- Redis (opcional — sin Redis, la app funciona en modo "plan gratuito" con los
  workers de background desactivados)

## Setup local

```bash
npm install
```

Configurar las variables de entorno en `.env` (ver tabla abajo), luego:

```bash
npm run db:migrate     # aplica las migraciones de Prisma
npm run db:seed        # datos de ejemplo (organización, usuarios, clientes, préstamos)
npm run dev             # levanta el servidor con recarga automática
```

### Variables de entorno

| Variable | Obligatoria | Descripción |
|---|---|---|
| `DATABASE_URL` | Sí | Cadena de conexión a PostgreSQL |
| `JWT_SECRET` / `JWT_REFRESH_SECRET` | Sí | Mínimo 32 caracteres cada una |
| `SESSION_SECRET` | Sí | Mínimo 32 caracteres |
| `REDIS_URL` | No | Si no está definida, los workers de BullMQ quedan desactivados |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | No | Notificaciones de recibos por Telegram |
| `SEED_ADMIN_PASSWORD` / `SEED_COLLECTOR_PASSWORD` | No | Sobrescriben las contraseñas por defecto del seed |
| `USURY_RATE_ANNUAL` / `DEFAULT_MORA_RATE_ANNUAL` | No | Tasas regulatorias (Colombia, Ley 510/99) |
| `CORS_ORIGIN` | No | Default: `http://localhost:3000` |

## Scripts

```bash
npm run dev              # servidor con nodemon
npm test                 # suite completa de Jest
npm run lint              # ESLint
npm run format             # Prettier
npm run db:studio          # Prisma Studio
npm run db:migrate:prod    # aplica migraciones en producción (usado por el release_command de Fly.io)
```

## Estructura

```
src/
  config/       # env, Prisma client, Passport, Redis, Socket.io
  controllers/  # handlers de rutas (panel admin monolítico + API REST)
  engine/       # motor de cálculo de mora e intereses
  jobs/         # workers de BullMQ (mora diaria, PDFs, importaciones)
  middleware/   # auth de sesión, JWT, RBAC, validación
  routes/       # routers Express (uno por recurso bajo /admin)
  schemas/      # validación Zod
  services/     # lógica de negocio, acceso a datos vía Prisma
prisma/
  schema.prisma
  migrations/
  seed.js
views/          # EJS del panel admin y la landing
```

## Roles

- `SUPER_ADMIN` / `ADMIN`: panel completo (préstamos, clientes, cobradores, pagos,
  reportes, importación, configuración)
- `COLLECTOR`: acceso restringido a `/admin/expenses` para registrar sus propios
  gastos de ruta

## Deploy

La app corre en Fly.io (`fly.toml`). El `release_command` aplica las migraciones de
Prisma antes de cada release:

```bash
fly deploy
```

## Licencia

Privado — todos los derechos reservados.
