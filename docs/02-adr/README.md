# Architecture Decision Records (ADRs)

Registro de decisiones de arquitectura y producto derivadas del prediseño v0.2 (`docs/00-fuente/prediseno-producto-v0.2.md`, §20 "Decisiones tomadas y abiertas"). Formato: contexto → decisión → alternativas consideradas → consecuencias, con referencias a las secciones fuente.

Convención: los ADRs son **inmutables una vez aceptados**; un cambio de decisión produce un ADR nuevo que marca el anterior como reemplazado (mismo patrón de sucesión que las design versions del propio producto).

## Índice de ADRs aceptados

| ADR | Título | Origen |
|---|---|---|
| [ADR-0001](ADR-0001-aplicacion-standalone-whitespace.md) | Aplicación standalone sobre capacidades AI-native de Whitespace | v0.1 |
| [ADR-0002](ADR-0002-comprador-organizacion-servicio-primero.md) | Comprador organización; "servicio con aplicación" primero | v0.1 |
| [ADR-0003](ADR-0003-arbol-navegacion-proyeccion-grafo.md) | Árbol de navegación como proyección sobre grafo n:m | v0.2 |
| [ADR-0004](ADR-0004-objetos-de-resultado.md) | Cuatro objetos de resultado (design version, release, effective state, outcome review) | v0.2 |
| [ADR-0005](ADR-0005-etapas-canonicas-flexibles-gates-suficiencia.md) | Etapas 0–7 canónicas y flexibles; gates de suficiencia | v0.1 + v0.2 |
| [ADR-0006](ADR-0006-journeys-grafos-tipados-mermaid.md) | Journeys como grafos tipados; Mermaid renderer; sin canvas libre | v0.2 |
| [ADR-0007](ADR-0007-medicion-temporal-metric-registry.md) | Medición temporal con Metric Registry; sin telemetría continua | v0.2 |
| [ADR-0008](ADR-0008-aislamiento-sin-cross-cliente.md) | Aislamiento estricto; sin cross-cliente; dos bibliotecas | v0.2 |
| [ADR-0009](ADR-0009-revisores-ai-arquetipos.md) | Revisores AI basados en arquetipos con límites metodológicos | v0.2 |
| [ADR-0010](ADR-0010-evidencia-por-dimensiones-grounding.md) | Evidencia por dimensiones + métricas de grounding | v0.2 |
| [ADR-0011](ADR-0011-propiedad-workspace-operador.md) | Cliente dueño del workspace; boutique operador; Whitespace proveedor | v0.2 |
| [ADR-0012](ADR-0012-ai-propone-humano-aprueba.md) | La AI propone y cita; el humano aprueba; degradación segura | v0.2 |
| [ADR-0013](ADR-0013-seguridad-dod-mvp.md) | Seguridad, privacidad y confiabilidad AI en el DoD del MVP | v0.2 |
| [ADR-0014](ADR-0014-alcance-mvp-loop-delgado.md) | Alcance del MVP: loop completo y delgado (1 cliente, 1 servicio, 1 reto) | v0.2 |

## Decisiones abiertas (ADRs pendientes)

Provienen de §20 del prediseño. Se convertirán en ADRs numerados cuando se decidan:

| Tema pendiente | Nota |
|---|---|
| Nombre del producto | Sin nombre en clave aún |
| Boutique propia o aliada | Define la marca del método y el canal |
| Cliente y reto piloto del MVP | Criterio sugerido: KPI medible y dueño del dato claro |
| Experimento de validación de la hipótesis de suscripción | Precio, contenido, momento de oferta |
| ADR "Stack del MVP" | **Resuelto en dirección (fundador, sep-2026): el scaffolding hereda los principios y parámetros del stack interno de Whitespace, fijados en `docs/06-diseno-tecnico/` (Stack fijado).** El ADR formal se emite al iniciar el scaffolding |
| Design system propio | **Definido (fundador, sep-2026): «El arco del loop»** — handoff v1 versionado en `.claude/skills/designio-design/`, tokens integrados como fuente de verdad en `src/styles/tokens/`. Pendiente menor: confirmar iconografía (Lucide propuesto) |
| Pricing (cifras de fee y suscripción) | El modelo de momentos (§15) está definido; las cifras no |
| Persistencia del grafo y topología de despliegue | Derivada del diseño técnico (`docs/06-diseno-tecnico/`) |
