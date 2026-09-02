---
title: "SPEC-02 — Árbol de navegación y grafo de dominio"
type: product-spec
author: "Whitespace — producto"
date: 2026-09-01
version: "0.1"
status: draft
language: es
audience: engineering
tags: [spec, navegacion, grafo, arbol, consultas, scoping-ai]
summary: "Especificación de la doble estructura: árbol de navegación fijo (Cliente → Servicios → Retos → Proyectos) como proyección de lectura, y grafo de dominio con relaciones n:m tipadas como modelo real, incluida la consultabilidad y el scoping de agentes AI."
---

# SPEC-02 — Árbol de navegación y grafo de dominio

## Propósito

Implementar ADR-0003: navegación simple y predecible para humanos sobre un grafo n:m que sostiene trazabilidad, consulta y scoping de agentes (§2).

## Alcance MVP

| Incluido | Fuera del MVP |
|---|---|
| Árbol de 4 niveles fijo con estados visibles por nivel | Niveles o jerarquías configurables |
| Grafo con aristas tipadas y metadatos (autor, fecha, propuesta AI de origen) | Visualizador libre del grafo completo |
| Servicio ancla como atributo de navegación del reto | — |
| Consultas de trazabilidad predefinidas (lista cerrada, abajo) | Lenguaje de consulta libre para usuarios |
| `AlcanceDeContexto` para agentes AI | — |
| Backlog de retos por servicio como proyección | — |

## Objetos del dominio

Aristas tipadas entre, como mínimo (§2.2): servicios; retos; proyectos; evidencias y fuentes; afirmaciones e insights; arquetipos y segmentos; oportunidades; conceptos y decisiones; design versions; releases; effective states; métricas y snapshots; sistemas, canales, touchpoints y actores.

## Requisitos funcionales

| ID | Requisito |
|---|---|
| RF-02.1 | El árbol muestra siempre Cliente → Servicios → Retos → Proyectos con el contenido por nivel definido en §2.1 (incluido el seguimiento de impacto dentro del reto/proyecto, nunca como sección aparte) |
| RF-02.2 | El árbol es proyección: se regenera desde el grafo/eventos; ninguna operación de escritura pasa "por el árbol" |
| RF-02.3 | Un reto declara un servicio ancla (ubicación en el árbol y responsabilidad principal) y puede afectar n servicios adicionales sin restricción |
| RF-02.4 | Cambiar el servicio ancla reubica el reto en el árbol sin alterar ninguna otra relación |
| RF-02.5 | Toda arista registra tipo, autor, fecha y, si aplica, la `PropuestaAI` de origen |
| RF-02.6 | Consultas de trazabilidad predefinidas del MVP: (a) pasos del journey que dependen de un sistema; (b) pasos afectados por un release; (c) cadena completa de una decisión (hasta evidencia y hasta resultado); (d) objetos que citan una evidencia; (e) elementos de una design version y su estado de implementación; (f) retos que afectan un servicio |
| RF-02.7 | `AlcanceDeContexto`: dado un nodo raíz (p. ej. un reto) y un rol, el sistema computa el subgrafo accesible (nodos + relaciones + permisos) que se entrega como contexto a cualquier capacidad AI |
| RF-02.8 | El backlog de retos del servicio lista candidatos/activos/cerrados con su origen (post mortem, hallazgo de medición, petición del cliente) |

## Criterios de aceptación (selección)

1. **Reto multi-servicio** — Dado un reto que afecta los servicios A (ancla) y B, cuando se navega el servicio B, entonces el reto aparece en B como "afecta a este servicio" con enlace, y en A como propio; ninguna relación se duplica.
2. **Consulta de release** — Dado el release RL-1 que incluye 3 elementos ligados a pasos del journey, cuando se ejecuta la consulta (b), entonces se listan exactamente los pasos alcanzados vía elementos de la design version, con su effective state.
3. **Scoping AI** — Dado un agente con alcance en el reto R-01, cuando construye su contexto, entonces ningún nodo fuera del subgrafo computado (ni de otro workspace) está presente (SYS-02); el alcance queda registrado en el lineage de la propuesta.

## Invariantes aplicables

SYS-01, SYS-02, SYS-09 (el árbol no es configurable).

## Dependencias y métricas

- Depende de: SPEC-01 (tenancy/permisos). La consumen: SPEC-05 (journey es subgrafo), SPEC-06 (cadena), SPEC-08 (scoping).
- Métricas (§17): % de decisiones con cadena completa navegable (la consulta (c) debe resolverse sin huecos).

## Riesgos y notas técnicas

| Tema | Nota |
|---|---|
| Persistencia | Decisión abierta (ver `docs/06-diseno-tecnico/`): relacional con tabla de aristas tipadas es suficiente para el volumen del MVP; grafo nativo solo si las consultas (a)–(f) lo exigen en la práctica |
| Rendimiento de proyección | El árbol del MVP (1 cliente, 1 servicio, 1 reto) permite proyección síncrona; diseñar la interfaz de proyección para hacerla asíncrona después |
| Sistemas/canales/touchpoints/actores | Catálogo por servicio (entidades ligeras de CTX-04) para que las aristas del journey apunten a identidades estables |
