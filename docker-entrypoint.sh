#!/bin/sh
# Migraciones de arranque (idempotentes vía ledger) y luego el servidor de producción.
set -e

bun db/migrate.ts
if [ "${SEED_ON_START:-false}" = "true" ]; then
  bun db/seed.ts
fi
exec bun serve.ts
