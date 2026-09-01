---
title: "ADR-0003 — Árbol de navegación como proyección sobre un grafo de dominio n:m"
type: decision-record
author: "Whitespace — producto"
date: 2026-09-01
version: "1.0"
status: approved
language: es
audience: engineering
tags: [adr, arquitectura, grafo, navegacion, read-model]
summary: "La navegación Cliente → Servicios → Retos → Proyectos es una proyección de lectura simple; el modelo de datos subyacente es un grafo con relaciones n:m. El servicio ancla es ayuda de navegación, no restricción estructural."
---

# ADR-0003 — Árbol de navegación como proyección sobre un grafo de dominio n:m

| Campo | Valor |
|---|---|
| Estado | **Aceptada** (v0.2) |
| Fecha | 2026-09-01 |
| Decisores | Fundador / producto Whitespace (revisión adversarial sep-2026) |
| Fuente | Prediseño v0.2 §2 |

## Contexto

Insight de origen del fundador: *"la jerarquía permite al cliente navegar por todos sus proyectos, cosa que no puede hacer fácilmente un agente o un chat de IA"*. A la vez, la realidad del dominio no es jerárquica: un reto puede afectar varios servicios; una decisión, métrica o capacidad puede relacionarse con más de un servicio; la trazabilidad y el scoping de agentes AI necesitan relaciones ricas. En v0.1 el "servicio ancla" operaba como restricción; la revisión adversarial detectó que forzar jerarquía en el modelo de datos rompe casos reales y bloquea la consultabilidad.

## Decisión

1. Mantener **dos estructuras separadas**: un árbol de navegación fijo y predecible (Cliente → Servicios → Retos → Proyectos) para humanos, y un **grafo de dominio con relaciones n:m** como modelo de datos real.
2. El árbol es una **proyección de lectura** (read model) derivada del grafo; no impone restricciones de escritura.
3. El **servicio ancla** de un reto se conserva como atributo de navegación y responsabilidad principal, nunca como limitación de qué servicios puede afectar el reto.
4. El grafo sostiene tres funciones: trazabilidad (cadena §3.2), consultabilidad ("qué pasos del journey dependen del sistema X") y **scoping de agentes AI** (contexto delimitado por nodos, relaciones y permisos).

## Alternativas consideradas

| Alternativa | Por qué se descarta |
|---|---|
| Jerarquía estricta como modelo de datos | Un reto multi-servicio o una métrica compartida no caben; fuerza duplicación y rompe trazabilidad |
| Grafo también como experiencia de navegación | Ilegible para el sponsor; el valor del árbol es precisamente su predictibilidad (insight de origen) |
| Carpetas configurables por cliente | Rompe comparabilidad y doctrina (I1, I6); cada workspace se volvería un taxón distinto |

## Consecuencias

- **Positivas**: los casos n:m reales caben sin hacks; los agentes AI operan con scoping explícito; "mover" un reto en el árbol es cambiar un atributo (servicio ancla), no re-parentar datos.
- **Negativas**: hay que construir y mantener la proyección (sincronía eventual árbol ↔ grafo); dos vocabularios internos (nodo/arista vs. niveles) que la UI debe ocultar.
- **Reglas derivadas**: toda feature nueva respeta árbol simple + grafo n:m (invariante I6); el backlog de retos por servicio es otra proyección del mismo grafo.

## Referencias

- Prediseño v0.2: §0.4, §2.1, §2.2, §6 (I6).
- `docs/01-ddd/domain-model.md` — "Árbol como proyección de lectura"; `docs/05-specs/SPEC-02-arbol-grafo-dominio.md`.
