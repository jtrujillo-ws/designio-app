# Designio

Plataforma B2B AI-native de service design para el contexto de una boutique: sistema de registro del método (etapas 0–7 con gates de suficiencia), grafo de dominio con trazabilidad completa **evidencia → insight → decisión → design version → release → effective state → outcome review**, y medición temporal de impacto con Metric Registry y post mortem.

- **Documento fuente**: [`docs/00-fuente/prediseno-producto-v0.2.md`](docs/00-fuente/prediseno-producto-v0.2.md)
- **Paquete de diseño** (DDD, ADRs, invariantes, journeys, specs, diseño técnico, mockups): [`docs/README.md`](docs/README.md)
- **Design system** ("El arco del loop"): [`.claude/skills/designio-design/`](.claude/skills/designio-design/README.md) — tokens en `src/styles/tokens/` (fuente de verdad en la app)

## Stack

Bun · TypeScript estricto · TanStack Start (SSR + server functions) · React 19 · Tailwind v4 + tokens propios · Zod · PostgreSQL con **RLS activo desde el día 1** (cliente `postgres`, sin ORM) · despliegue en Railway. Detalle completo en [`docs/06-diseno-tecnico/`](docs/06-diseno-tecnico/diseno-tecnico.md).

## Desarrollo local

```bash
bun install
cp .env.local.example .env.local            # y genera JWT_SECRET con: openssl rand -hex 32

# Base de datos (modo híbrido recomendado)
docker compose -f docker-compose.db.yml up -d
bun run db:migrate && bun run db:seed       # crea el rol de app (no privilegiado) + workspace demo

bun run dev                                 # http://localhost:5173
```

Validación local (lo mismo que corre el CI): `bun run typecheck && bun run lint && bun run test && bun run build && bun run check:bundle`.

La suite de autorización (`src/__tests__/authz/`) corre contra el Postgres real con las migraciones aplicadas y verifica el aislamiento RLS entre tenants; sin `DATABASE_URL`/`DATABASE_URL_APP` se omite **y lo dice** — un test omitido no es un check verde.

## Flujo de ramas

Promoción lineal `agents → dev → stg → main`; las features nacen en ramas `claude/<topic>-<short-id>` desde `agents` y entran por squash-merge. Cada push a rama de ambiente despliega ese ambiente (Railway: un environment por rama; runbook en `docs/06-diseno-tecnico/despliegue-railway.md`).
