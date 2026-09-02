---
title: "SPEC-06 — Trazabilidad y objetos de resultado"
type: product-spec
author: "Whitespace — producto"
date: 2026-09-01
version: "0.1"
status: draft
language: es
audience: engineering
tags: [spec, trazabilidad, design-version, release, effective-state, diff, conciliacion]
summary: "Especificación de la cadena de trazabilidad y de los cuatro objetos de resultado: design version con elementos de cambio y diff, releases parciales, effective state con desviaciones y la conciliación de la etapa 7."
---

# SPEC-06 — Trazabilidad y objetos de resultado

## Propósito

Implementar ADR-0004 y §3: la cadena evidencia → insight → decisión → design version → release → effective state → resultados → outcome review como estructura navegable, con el diff de primera clase.

## Alcance MVP

| Incluido | Fuera del MVP |
|---|---|
| Design version con elementos de cambio tipados y diff contra effective state vigente | Diff visual lado a lado de grafos completos |
| Releases parciales múltiples con estados | Integración con herramientas de delivery (Jira, etc.) |
| Effective state con desviaciones (elemento + razón) | — |
| Conciliación asistida DV ↔ releases ↔ effective state | — |
| Navegación de la cadena completa en ambos sentidos | — |

## Objetos del dominio

`DesignVersion`, `ElementoDeCambio`, `Release`, `EffectiveState`, `Desviación`, `Conciliación`. Ver CTX-04/CTX-05 y las máquinas de estado en `docs/01-ddd/domain-model.md`.

## Requisitos funcionales

| ID | Requisito |
|---|---|
| RF-06.1 | Crear design version en borrador desde el trabajo de etapa 5: lista de **elementos de cambio** tipados (touchpoint modificado, proceso backstage nuevo, canal, política, sistema…), cada uno referenciando nodos del grafo (SPEC-05) y las decisiones/insights que lo motivan |
| RF-06.2 | Diff generado contra el effective state vigente del servicio: qué se agrega, modifica o retira, explicado por elemento; el diff es derivado (se calcula), no un documento manual |
| RF-06.3 | Aprobar la design version (G5/G6) la congela (inmutable) y congela el snapshot del grafo to-be; toda modificación posterior crea una nueva versión y marca la anterior como superada |
| RF-06.4 | Plan de releases (G6): cada elemento de la design version queda asignado a exactamente un release con dueño y fecha; un release lista explícitamente sus elementos (parcialidad explícita) |
| RF-06.5 | Registrar despliegue de un release (planificado → desplegado) con fecha real; los elementos no incluidos permanecen visibles como pendientes |
| RF-06.6 | Constatar effective state (release → verificado): por cada elemento desplegado, constatación de cómo quedó; toda diferencia respecto de lo aprobado se registra como desviación con razón obligatoria |
| RF-06.7 | Conciliación (G7): tablero elemento por elemento — aprobado / incluido en release / desplegado / constatado / desviado — que debe quedar completo (sin elementos en estado desconocido) para aprobar G7 |
| RF-06.8 | Detección AI de desviaciones: propuesta de discrepancias entre DV y lo constatado, a confirmar por el lead (capacidad mínima etapa 7) |
| RF-06.9 | Navegación bidireccional de la cadena: desde una evidencia hasta los releases que la "usaron" (vía insight → decisión → DV → release) y desde un resultado hacia atrás hasta las citas |
| RF-06.10 | El effective state vigente del servicio (lo que muestra el nivel Servicio del árbol) se deriva de la última constatación verificada |

## Criterios de aceptación (selección)

1. **Inmutabilidad** — Dada DV-1 aprobada, cuando se intenta editar un elemento, entonces la operación se rechaza ofreciendo crear DV-2 (SYS-05).
2. **Parcialidad explícita (§19.5)** — Dado que RL-1 incluye 3 de los 4 elementos de DV-1, cuando se consulta DV-1, entonces el cuarto elemento aparece como pendiente asignado a RL-2 con su razón ("dependencia del área de riesgo").
3. **Desviación con razón** — Dada la constatación de "verificación diferida" con un paso adicional exigido por cumplimiento, cuando se guarda sin razón, entonces se rechaza; con razón, ES-1 la muestra ligada al elemento (SYS-07).
4. **G7 completo** — Dado un elemento sin estado de constatación, cuando el lead intenta aprobar G7, entonces el sistema lo bloquea mostrando el tablero de conciliación (RF-06.7).
5. **Cadena navegable** — Dada la pregunta "qué pasos del journey afectó RL-1" (§19.7), cuando se consulta, entonces la respuesta enumera los pasos vía elementos incluidos en RL-1, con su effective state.

## Invariantes aplicables

SYS-05, SYS-06, SYS-07, SYS-08.

## Dependencias y métricas

- Depende de: SPEC-04 (gates y decisiones), SPEC-05 (nodos y snapshot). La consume: SPEC-07 (anclaje temporal de snapshots por release).
- Métricas (§17): % de elementos de design version conciliados en releases y effective state (alarma: decisiones que pasan gates sin cadena).

## Riesgos

| Riesgo | Mitigación |
|---|---|
| La constatación del effective state se percibe como burocracia | Es el momento donde la boutique demuestra honestidad operativa (desviaciones sin maquillaje); la detección AI reduce el esfuerzo a confirmar/ajustar |
| Elementos de cambio mal granulados (demasiado gruesos/finos) | Guía metodológica en la biblioteca general; el tablero de conciliación hace visible la granularidad inadecuada temprano |
