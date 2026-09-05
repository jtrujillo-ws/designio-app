#!/usr/bin/env bash
# Check "Client bundle": ningún módulo server-only puede alcanzar el bundle del navegador.
# (Defensa 3 de 3 del split server/client; inspecciona el build real, no el grafo de dev.)
set -euo pipefail

DIR="${1:-dist/client}"
if [ ! -d "$DIR" ]; then
  echo "✗ No existe $DIR — corre 'bun run build' primero" >&2
  exit 1
fi

# Los marcadores. Los tres primeros son módulos server-only cargándose donde no deben. El
# cuarto es otra cosa y por eso lleva su nota: los VALIDADORES de contenido AI son código
# muerto en el navegador —desde que la frontera de la corrección es `unknown`, la única
# validación de contenido ocurre en el servidor— y llegaban allí solo por estar colgados de
# `CAPACIDADES`, que sí importa la pantalla. No rompen nada; pesan. Una revisión señaló que
# este guardián no lo veía, y tenía razón: solo miraba marcadores de server-only.
#
# El marcador es un CENTINELA puesto a propósito en `ai.contenido.ts`, no un texto prestado.
# Con el nombre de un campo no valía por dos lados: `fechaSinDatoMotivo` también está en el
# formulario de corrección —que sí vive en el navegador y tiene que seguir estando—, así que
# daba falso positivo; y un mensaje de validación cualquiera deja de guardar el día que alguien
# lo reescribe. Éste existe solo para esto.
BAD=0
for needle in "Módulo server-only cargado" "DATABASE_URL_APP" "app.user_id" "designio:contenido-ai-solo-servidor"; do
  if grep -rq -- "$needle" "$DIR"; then
    echo "✗ Marcador que no debe estar en el bundle del cliente: \"$needle\"" >&2
    grep -rl -- "$needle" "$DIR" >&2 || true
    BAD=1
  fi
done

if [ "$BAD" = 0 ]; then
  echo "✓ Client bundle limpio (sin módulos server-only)"
fi
exit "$BAD"
