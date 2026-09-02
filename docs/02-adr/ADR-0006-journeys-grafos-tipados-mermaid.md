---
title: "ADR-0006 — Journeys y blueprints como grafos tipados; Mermaid como renderer principal; sin canvas libre"
type: decision-record
author: "Whitespace — producto"
date: 2026-09-01
version: "1.0"
status: approved
language: es
audience: engineering
tags: [adr, journeys, grafo-tipado, mermaid, canvas]
summary: "El journey se modela como grafo tipado cuya fuente de verdad es el modelo estructurado; Mermaid se genera desde el grafo como vista principal; no se construye un editor de canvas libre. Miro/Figma entran solo como evidencia importada."
---

# ADR-0006 — Journeys como grafos tipados con Mermaid; sin canvas libre

| Campo | Valor |
|---|---|
| Estado | **Aceptada** (v0.2) |
| Fecha | 2026-09-01 |
| Decisores | Fundador / producto Whitespace (revisión adversarial sep-2026) |
| Fuente | Prediseño v0.2 §10, §12, §18 |

## Contexto

Los journeys y blueprints son el artefacto visible del service design, y la tentación natural es construir un canvas. Pero competir en canvas contra Miro/Mural es el riesgo "construir un Miro peor" (fatal en adopción, §18), y una composición espacial de elementos sueltos no da trazabilidad, consultabilidad, diff ni validación automática — todo lo que constituye el moat. Además, la AI trabaja de forma confiable sobre nodos y relaciones concretas, no interpretando coordenadas.

## Decisión

1. El journey (y el blueprint) es un **grafo tipado**: fases; pasos; transiciones, bifurcaciones y dependencias; actores y arquetipos; canales y touchpoints; acciones frontstage/backstage; sistemas de soporte; emociones, fricciones, oportunidades y decisiones; y evidencias, métricas y releases enlazados a cada nodo.
2. **La fuente de verdad es el modelo estructurado** (nodos, relaciones, atributos) con evidencia, permisos, estados, versiones, métricas y auditoría.
3. **Mermaid es el renderer principal, generado desde el grafo.** En el MVP la edición ocurre por formularios estructurados, tablas y asistencia AI; el sistema regenera la vista. La edición bidireccional del código Mermaid queda fuera del MVP.
4. **No se construye canvas libre propio.** Vistas adicionales (tabla, timeline, por actor, blueprint por carriles) se añaden como visualizaciones estructuradas si Mermaid no basta.
5. Los artefactos libres de talleres (Miro/Figma, fotos) entran como **evidencia importada** con curaduría humana para su traducción al grafo (§12).

## Alternativas consideradas

| Alternativa | Por qué se descarta |
|---|---|
| Canvas libre propio | "Miro peor"; años de inversión en un editor genérico sin diferencial; sin estructura para AI ni diff |
| Integración profunda de edición con Miro/Figma | Dependencia de APIs de terceros para la primitiva central; sincronización bidireccional explícitamente fuera del MVP (§12.2) |
| Editor de nodos visual propio (tipo whiteboard estructurado) | Complejidad de producto alta para el MVP; puede evaluarse post-MVP como vista adicional, no como fuente de verdad |
| Solo texto/tablas sin render visual | El render es esencial para talleres y sponsor; Mermaid da el 80% con coste marginal |

## Consecuencias

- **Positivas**: trazabilidad por nodo; consultas sobre el grafo; diff sobre objetos, no imágenes; validación automática (pasos sin evidencia, transiciones rotas, huecos frontstage/backstage, elementos sin responsable); trabajo AI confiable; menor superficie de producto.
- **Negativas / pérdida deliberada**: se renuncia a la libertad visual absoluta; los layouts de Mermaid tienen límites estéticos; talleres seguirán ocurriendo en herramientas externas (mitigado con importación como evidencia).
- **Riesgo residual**: rechazo de diseñadores acostumbrados al canvas — mitigación: la boutique opera la herramienta (ADR-0002) y el valor se demuestra en gates y trazabilidad, no en el dibujo.

## Referencias

- Prediseño v0.2: §10, §12, §16, §18.
- `docs/05-specs/SPEC-05-journeys-tipados-mermaid.md`; `docs/07-mockups/` (pantalla Journey).
