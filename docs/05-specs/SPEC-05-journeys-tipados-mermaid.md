---
title: "SPEC-05 — Journeys como grafos tipados y render Mermaid"
type: product-spec
author: "Whitespace — producto"
date: 2026-09-01
version: "0.1"
status: draft
language: es
audience: engineering
tags: [spec, journey, blueprint, grafo-tipado, mermaid, validacion]
summary: "Especificación del objeto Journey/Blueprint como grafo tipado: taxonomía de nodos y aristas, edición estructurada, render Mermaid generado, vistas múltiples, validación automática y versionado ligado a design versions."
---

# SPEC-05 — Journeys como grafos tipados y render Mermaid

## Propósito

Implementar ADR-0006: el journey y el blueprint como grafo tipado cuya fuente de verdad es el modelo estructurado; Mermaid como renderer principal generado; sin canvas libre.

## Alcance MVP

| Incluido | Fuera del MVP |
|---|---|
| Grafo tipado con la taxonomía mínima (§10) | Canvas libre; edición por arrastre espacial |
| Edición por formularios estructurados, tablas y asistencia AI | Edición bidireccional del código Mermaid |
| Render Mermaid regenerado en cada cambio | Layouts personalizados persistentes |
| Vistas: Mermaid (flujo), tabla y blueprint por carriles (frontstage/backstage) | Timeline y vista por actor (post-MVP si Mermaid no alcanza) |
| Validación automática del grafo | — |
| As-is y to-be; snapshot congelado al aprobar la design version | Diff visual avanzado entre grafos (el diff de elementos vive en SPEC-06) |

## Taxonomía del grafo

| Elemento | Tipos mínimos |
|---|---|
| Nodos | Fase; Paso/Momento; Touchpoint; Canal; Actor; Arquetipo; Sistema/Capacidad; AcciónFrontstage; AcciónBackstage; Emoción; Fricción; Oportunidad; Decisión |
| Aristas | transición (paso→paso, con bifurcación/condición); pertenece-a (paso→fase); ocurre-en (paso→touchpoint/canal); participa (actor/arquetipo→paso); soporta (sistema→paso/acción backstage); evidencia-de (evidencia→nodo); mide (KPI/snapshot→nodo); afecta (elemento de design version/release→nodo); duele/siente (fricción/emoción→paso) |

Los touchpoints, canales, sistemas y actores referencian el **catálogo del servicio** (SPEC-02) para mantener identidades estables entre as-is y to-be.

## Requisitos funcionales

| ID | Requisito |
|---|---|
| RF-05.1 | Crear un journey (as-is o to-be) asociado a un servicio y opcionalmente a un reto/proyecto; el blueprint es el mismo grafo con vista por carriles |
| RF-05.2 | Edición estructurada: alta/edición de nodos y aristas por formularios y tabla; reordenar pasos y fases sin coordenadas libres |
| RF-05.3 | Render Mermaid generado desde el grafo: flujo por fases con bifurcaciones; regenerado en cada cambio; exportable (imagen y código) |
| RF-05.4 | Vista blueprint: carriles evidencia/frontstage/backstage/sistemas alineados por paso |
| RF-05.5 | Cada nodo expone su panel de trazabilidad: evidencias, decisiones, métricas, sistemas y releases enlazados (consultas de SPEC-02) |
| RF-05.6 | Validación automática con reporte accionable: pasos sin evidencia enlazada; transiciones rotas (pasos inalcanzables o sin salida no-final); huecos frontstage↔backstage (acción visible sin soporte); elementos sin responsable; nodos huérfanos de fase |
| RF-05.7 | La AI propone nodos y aristas concretos (journey as-is asistido, blueprint to-be) como `PropuestaAI`; la aceptación es por elemento o en lote pequeño revisado |
| RF-05.8 | Al aprobar una design version se congela un snapshot del grafo to-be asociado (inmutable); el grafo de trabajo continúa editable para el ciclo siguiente |
| RF-05.9 | Los artefactos de talleres (Miro/Figma, fotos) se enlazan como evidencia importada a nodos del grafo; su traducción a nodos pasa por curaduría (SPEC-03) |

## Criterios de aceptación (selección)

1. **Fuente de verdad** — Dado un journey renderizado, cuando se edita el código Mermaid exportado, entonces nada cambia en el sistema (el código es un artefacto derivado de solo lectura).
2. **Validación G5** — Dado un blueprint to-be con una acción frontstage sin soporte backstage/sistema, cuando se ejecuta la validación, entonces el hueco aparece en el reporte y el checklist de G5 lo referencia como pendiente de resolver o justificar.
3. **Trazabilidad por nodo** — Dado el paso "verificacion de identidad" (§19), cuando se abre su panel, entonces se ven I-07 (evidencia), el elemento de DV-1 que lo modifica, RL-1 que lo implementó y el KPI de abandono que lo mide.
4. **Render fiel** — Dado un grafo con una bifurcación condicionada, cuando se regenera el Mermaid, entonces la bifurcación y sus condiciones aparecen; ningún nodo del grafo falta en el render de su vista.

## Invariantes aplicables

SYS-05 (snapshot congelado con la DV), SYS-15 (evidencia enlazada), SYS-19 (propuestas AI).

## Dependencias y métricas

- Depende de: SPEC-02 (catálogo y consultas), SPEC-03 (evidencia), SPEC-08 (propuestas). La consume: SPEC-06 (diff de elementos referencia nodos).
- Métricas (§17): decisiones/pasos con cadena completa; señales de validación resueltas antes de G5.

## Riesgos

| Riesgo | Mitigación |
|---|---|
| Mermaid insuficiente para blueprints densos | La vista por carriles propia (RF-05.4) es visualización estructurada adicional prevista por ADR-0006; nunca canvas |
| Diseñadores extrañan el canvas | El trabajo divergente ocurre en talleres externos y entra como evidencia (RF-05.9); el grafo es el registro, no el taller |
