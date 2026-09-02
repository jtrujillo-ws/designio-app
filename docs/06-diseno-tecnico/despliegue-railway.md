---
title: "Runbook — Despliegue de Designio en Railway"
type: guide
author: "Whitespace — producto"
date: 2026-09-02
version: "1.0"
status: active
language: es
audience: engineering
tags: [railway, despliegue, runbook, postgres, environments]
summary: "Guía operativa para desplegar Designio en Railway: servicio Docker + PostgreSQL gestionado, environments dev/stg/production sobre las ramas dev/stg/main, variables y secrets (incluido el patrón de dos conexiones con RLS), healthcheck, seed y verificación post-deploy."
---

# Runbook — Despliegue de Designio en Railway

Railway es la **elección operativa de hosting del MVP** (fundador, sep-2026). El repo ya está preparado: `railway.json` (builder Dockerfile + healthcheck `/healthz`), `Dockerfile` con `NODE_ENV=production`, entrypoint que aplica migraciones al arrancar y `serve.ts` que respeta el `PORT` inyectado.

## 1. Estructura del proyecto en Railway

| Pieza | Configuración |
|---|---|
| Proyecto | `designio` |
| Environments | `dev`, `stg`, `production` — **uno por rama** del flujo (`dev`, `stg`, `main`); la rama `agents` no despliega (es integración) |
| Servicio `app` | Desde el repo GitHub `jtrujillo-ws/designio-app`, builder **Dockerfile** (lo fija `railway.json`); cada environment observa su rama |
| Servicio `Postgres` | Plugin de PostgreSQL de Railway, uno por environment |

Pasos: crear el proyecto → añadir el plugin PostgreSQL → añadir el servicio desde GitHub → en cada environment, apuntar el servicio `app` a su rama (Settings → Source → Branch) → definir las variables de abajo → deploy.

## 2. Variables del servicio `app` (por environment)

El patrón de datos usa **dos conexiones** (diseño técnico · Multi-tenancy): la admin (migraciones/seed, superusuario del plugin) y la de aplicación (rol `designio_app`, no privilegiado, RLS activo). El rol lo crea el bootstrap de las migraciones con `APP_DB_PASSWORD`.

| Variable | Valor | Nota |
|---|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | Conexión admin del plugin. Preferir la URL **privada** (`postgres.railway.internal`) si el plugin expone ambas — verificar los nombres en la pestaña Variables del plugin, han cambiado entre versiones |
| `APP_DB_PASSWORD` | secret generado (`openssl rand -hex 24`), distinto por environment | **Obligatoria**: con `NODE_ENV=production` y sin ella, las migraciones abortan a propósito |
| `DATABASE_URL_APP` | `postgresql://designio_app:${{APP_DB_PASSWORD}}@${{Postgres.PGHOST}}:${{Postgres.PGPORT}}/${{Postgres.PGDATABASE}}` | Se compone con referencias; si la referencia a la variable propia no resuelve en tu plan, usar una *shared variable* del environment (`${{shared.APP_DB_PASSWORD}}`) para ambas |
| `JWT_SECRET` | secret generado (`openssl rand -hex 32`), distinto por environment | Sesiones y tokens de capacidad (cuando llegue auth) |
| `SEED_ON_START` | `true` solo en `dev` | Crea el workspace demo Banco Andino; en `stg`/`production` va `false` |
| `ANTHROPIC_API_KEY` | secret | Solo cuando llegue la capa AI (PR del pipeline PropuestaAI) |
| `CRON_SECRET` | secret generado | Solo cuando lleguen los hooks de jobs |

`PORT` **no se configura**: Railway lo inyecta y `serve.ts` lo respeta.

## 3. Healthcheck y despliegue

- `railway.json` fija `healthcheckPath: /healthz` (timeout 120 s): el rollout solo promociona si el contenedor responde — y como el entrypoint corre las migraciones antes de arrancar el server, **un fallo de migración bloquea el deploy** en vez de dejar la app a medias.
- `/healthz` además **verifica la conexión de APLICACIÓN** (`DATABASE_URL_APP`) antes de reportar sano — y no solo que autentique: comprueba que el rol conectado sea `designio_app` **sin privilegios de bypass de RLS** (`rolsuper`/`rolbypassrls`) y que la URL apunte a la **base migrada** (toca la tabla `workspace`; los roles son cluster-wide, así que la identidad sola no descarta una base equivocada de la misma instancia). Referencia sin resolver, password incorrecta, URL admin por error o base errónea → **503** y el rollout se bloquea, en vez de promocionar un contenedor que fallaría en cada request — o peor, que serviría tráfico saltándose el aislamiento de tenants. Una vez verificada queda verde (readiness de rollout, no liveness). `APP_DB_PASSWORD`, por su parte, es obligatoria en producción **en cada arranque** (las migraciones abortan sin ella, exista o no ya el rol).
- Restart policy: `ON_FAILURE` con 3 reintentos.
- Deploy = push a la rama del environment (flujo `agents → dev → stg → main`: el squash-merge a `agents` no despliega; promocionar es avanzar `dev`/`stg`/`main` a ese commit).

## 4. pgvector

La migración `00-init.sql` intenta `create extension vector` de forma **tolerante**: si la imagen del plugin no la trae, avisa y continúa (la búsqueda semántica llegará en un PR posterior). Si el plugin estándar no incluye pgvector, desplegar la plantilla de Postgres con pgvector de Railway y apuntar las variables a ese servicio.

## 5. Verificación post-deploy (cada environment)

```bash
# 1. Salud
curl -s https://<dominio>/healthz            # → ok

# 2. La raíz manda al guard de sesión: sin cookie termina en el login server-renderizado
#    (la pantalla Loop vive tras /app y requiere sesión desde el PR de auth)
curl -sL https://<dominio>/ | grep -c "Entra a tu workspace"   # → 1

# 3. Logs del deploy: migraciones aplicadas y (solo dev) seed
#    "migraciones al día (N en total, ...)" · "designio escuchando en :PORT"

# 4. RLS operativo: conectarse con DATABASE_URL_APP y verificar cero filas sin contexto
psql "$DATABASE_URL_APP" -tAc "select count(*) from workspace"   # → 0
```

## 6. Qué NO cubre Railway todavía (follow-ups conocidos)

| Tema | Plan |
|---|---|
| Object storage para evidencia binaria | Bucket S3-compatible (R2/S3) cuando llegue SPEC-03; en local, filesystem |
| Cron/backstop de jobs | Un **servicio cron aparte** cuyo start command invoca el hook `x-cron-secret` (p. ej. `curl -fsS`) y termina — el cron de Railway ejecuta el comando del servicio programado y requiere que el proceso finalice; no hace llamadas HTTP por sí mismo. Llega con el scheduler (SPEC-07) |
| Dominios | Asignar dominio propio por environment cuando el piloto lo pida (mientras, el subdominio `*.up.railway.app`) |
| Backups | Verificar la política de backups del plugin Postgres del plan contratado y documentar la prueba de restauración (DoD §14) |
