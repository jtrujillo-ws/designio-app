---
title: "SPEC-07 — Metric Registry, medición temporal y post mortem"
type: product-spec
author: "Whitespace — producto"
date: 2026-09-01
version: "0.1"
status: draft
language: es
audience: engineering
tags: [spec, metric-registry, snapshots, ventana, post-mortem, veredicto]
summary: "Especificación de la medición temporal de impacto: Metric Registry por reto con carga manual o CSV, ventanas por criterio, lectura contra baseline y releases, recordatorios al dueño del dato y outcome review con veredicto sin causalidad automática."
---

# SPEC-07 — Metric Registry, medición temporal y post mortem

## Propósito

Implementar ADR-0007 y §8: el loop cierra con una medición acotada y honesta — baseline, snapshots, veredicto — sin convertir el producto en plataforma de operación.

## Alcance MVP

| Incluido | Fuera del MVP |
|---|---|
| Metric Registry por reto con los campos de §8.1 | Integraciones operacionales (tickets, NPS, eventos) |
| Carga por formulario y CSV; enlace a dashboard externo | Ingesta continua o programada desde sistemas |
| Ventana por criterio; recordatorios por frecuencia comprometida | Alertas en tiempo real |
| Lectura: baseline vs. snapshots (anclados a releases) vs. resultado final | Modelos estadísticos de atribución |
| Outcome review con veredicto y retos candidatos | Benchmarks entre clientes (ADR-0008 lo veta) |
| Borrador AI del post mortem sobre snapshots deterministas | — |

## Objetos del dominio

`MetricRegistry`, `EntradaKPI`, `Snapshot`, `OutcomeReview`, `Veredicto`. Ver CTX-06.

## Requisitos funcionales

| ID | Requisito |
|---|---|
| RF-07.1 | Metric Registry 1:1 con el reto; cada entrada KPI registra: nombre y definición, criterio de éxito al que responde, propietario del dato (persona del cliente), fuente, dimensiones/cortes, línea base (valor y fecha), frecuencia esperada, enlace a dashboard externo opcional, ventana y fecha prevista de post mortem |
| RF-07.2 | El borrador del registry lo propone la AI en etapa 6 desde los criterios de G0; se acuerda y firma en G6 (SYS-22) |
| RF-07.3 | Snapshots por formulario o carga CSV (plantilla por KPI con validación de formato y fechas); cada snapshot registra valor, fecha y origen; append-only (SYS-23) |
| RF-07.4 | Recordatorios al propietario del dato según la frecuencia comprometida; el estado "snapshot esperado / recibido / vencido" es visible en el seguimiento de impacto del reto |
| RF-07.5 | Lectura por criterio: baseline, serie de snapshots con marcas de fecha de cada release desplegado, objetivo, y días restantes de ventana |
| RF-07.6 | El seguimiento de impacto vive dentro del reto/proyecto (nivel 3 del árbol); no existe módulo de "operación" separado (RF-02.1) |
| RF-07.7 | Al cerrar la ventana del último criterio, el sistema habilita el outcome review; la AI genera un borrador narrativo estrictamente sobre los datos del registry (sin inventar métricas) |
| RF-07.8 | El outcome review estructura: resultado por criterio (baseline vs. final), contribución del rediseño y factores externos conocidos, hipótesis abiertas, aprendizajes, y **veredicto** del catálogo cerrado: logrado / parcialmente logrado / no logrado / no concluyente (SYS-24) |
| RF-07.9 | El outcome review distingue tipográfica y estructuralmente contribución/asociación de causalidad; solo un flag explícito "diseño experimental suficiente" (con justificación) habilita lenguaje causal |
| RF-07.10 | Completar el outcome review cierra el reto con veredicto, pasa el proyecto a cerrado inmutable y permite crear retos candidatos pre-poblados (aprendizajes + memoria del workspace) |

## Criterios de aceptación (selección)

1. **CSV validado** — Dado un CSV con una fila sin fecha, cuando se carga, entonces se rechaza esa fila con mensaje accionable y se aceptan las válidas; nada se sobreescribe (SYS-23).
2. **Lectura anclada a releases (§19.6)** — Dados snapshots 55/49/46/44 y RL-1 desplegado antes del primero, cuando se abre la lectura, entonces la serie muestra la marca de RL-1, el baseline 62 y el objetivo 40.
3. **Veredicto honesto** — Dado un criterio sin snapshots suficientes al cierre de la ventana, cuando se redacta el outcome review, entonces "no concluyente" está disponible y el motivo (datos faltantes) queda registrado; el caso alimenta la métrica de salud de loop cerrado (§17).
4. **Sin causalidad automática** — Dado el borrador AI del post mortem, cuando se genera, entonces no contiene afirmaciones causales (lenguaje de contribución/asociación) salvo flag experimental activo (SYS-24).

## Invariantes aplicables

SYS-22, SYS-23, SYS-24; SYS-08 (cierre inmutable).

## Dependencias y métricas

- Depende de: SPEC-04 (criterios G0, estados), SPEC-06 (fechas de release), SPEC-08 (borradores AI).
- Métricas (§17): % de retos que llegan a veredicto con datos del registry (alarma: cierres "no concluyente" por falta de snapshots).

## Riesgos

| Riesgo | Mitigación |
|---|---|
| El cliente no aporta snapshots | Dueño y frecuencia comprometidos en G6; recordatorios RF-07.4; veredicto honesto; métrica de salud monitoreada (§18) |
| Presión por "demostrar éxito" en el post mortem | Estructura del outcome review con factores externos e hipótesis; el veredicto parcial existe (ejemplo §19.6: 44% vs. 40% = parcialmente logrado) |
