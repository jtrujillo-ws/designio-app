# Paquete de diseño — Plataforma de service design (MVP)

Documentación de diseño derivada del prediseño de producto v0.2. Orden de lectura sugerido:

| # | Carpeta | Contenido | Estado |
|---|---|---|---|
| 0 | [`00-fuente/`](00-fuente/prediseno-producto-v0.2.md) | Prediseño de producto v0.2 (documento fuente, verbatim) | referencia |
| 1 | [`01-ddd/`](01-ddd/domain-model.md) | Modelo de dominio básico: lenguaje ubicuo, subdominios, 8 bounded contexts, agregados, eventos, máquinas de estado | borrador |
| 2 | [`02-adr/`](02-adr/README.md) | 14 ADRs aceptados + decisiones abiertas | borrador |
| 3 | [`03-invariantes/`](03-invariantes/invariantes.md) | Invariantes de producto I1–I6 y 24 invariantes de sistema verificables (SYS-*) | borrador |
| 4 | [`04-journeys/`](04-journeys/journeys-plataforma.md) | Journeys de la plataforma J1–J7 por rol, sobre el ejemplo Banco Andino | borrador |
| 5 | [`05-specs/`](05-specs/README.md) | 9 especificaciones funcionales del MVP con requisitos y criterios de aceptación | borrador |
| 6 | [`06-diseno-tecnico/`](06-diseno-tecnico/diseno-tecnico.md) | Diseño técnico (arquitectura, stack fijado, datos, AI, seguridad, pruebas, despliegue) | borrador — stack y design system definidos |
| 7 | [`07-mockups/`](07-mockups/README.md) | Mockup HTML autocontenido: loop del método J1–J7 + 6 superficies del MVP | borrador |
| 8 | [`../.claude/skills/designio-design/`](../.claude/skills/designio-design/README.md) | Design system «El arco del loop» (handoff v1: tokens, primitivas, guidelines, pantalla Loop hifi); tokens integrados en `src/styles/tokens/` | v1 |
| 9 | [`DESIGNIO-COMPLETE.md`](DESIGNIO-COMPLETE.md) | **Documento consolidado**: qué es Designio y qué incluye, pantalla por pantalla, con estado (construido / en vuelo / diseñado), referencia técnica, hoja de ruta y apéndices; derivado del código | current |

Reglas de coherencia del paquete:

1. El **vocabulario canónico** del prediseño (§ lenguaje ubicuo en `01-ddd`) es obligatorio en todos los documentos y en el código futuro (invariante I1).
2. Toda afirmación de diseño referencia su sección fuente del prediseño (`§n`) o su ADR; lo que no tiene fuente se marca como propuesta.
3. Los cambios de decisión no editan ADRs aceptados: crean ADRs nuevos (sucesión).
4. El alcance de cualquier feature se contrasta con ADR-0014 (loop delgado: 1 cliente, 1 servicio, 1 reto).
