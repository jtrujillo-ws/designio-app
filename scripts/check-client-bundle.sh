#!/usr/bin/env bash
# Check "Client bundle": ningún módulo server-only puede alcanzar el bundle del navegador.
# (Defensa 3 de 3 del split server/client; inspecciona el build real, no el grafo de dev.)
set -euo pipefail

DIR="${1:-dist/client}"
if [ ! -d "$DIR" ]; then
  echo "✗ No existe $DIR — corre 'bun run build' primero" >&2
  exit 1
fi

BAD=0
for needle in "Módulo server-only cargado" "DATABASE_URL_APP" "app.user_id"; do
  if grep -rq -- "$needle" "$DIR"; then
    echo "✗ Marcador server-only en el bundle del cliente: \"$needle\"" >&2
    grep -rl -- "$needle" "$DIR" >&2 || true
    BAD=1
  fi
done

if [ "$BAD" = 0 ]; then
  echo "✓ Client bundle limpio (sin módulos server-only)"
fi
exit "$BAD"
