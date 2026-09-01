---
title: "ADR-0007 — Medición temporal de impacto con Metric Registry; sin telemetría continua"
type: decision-record
author: "Whitespace — producto"
date: 2026-09-01
version: "1.0"
status: approved
language: es
audience: mixed
tags: [adr, medicion, metric-registry, post-mortem, alcance]
summary: "Se elimina la operación continua del producto: el impacto se mide con un Metric Registry de carga manual o CSV, ventana por reto y por KPI definida en la etapa 0, y post mortem con veredicto. Sin integraciones operacionales ni causalidad automática."
---

# ADR-0007 — Medición temporal con Metric Registry; sin telemetría continua

| Campo | Valor |
|---|---|
| Estado | **Aceptada** (v0.2; reemplaza la "operación continua" de v0.1) |
| Fecha | 2026-09-01 |
| Decisores | Fundador / producto Whitespace (revisión adversarial sep-2026) |
| Fuente | Prediseño v0.2 §8, §6 (I5), changelog punto 2 |

## Contexto

La v0.1 apuntaba a una plataforma con telemetría y operación continua del servicio. La revisión adversarial la desmontó: exige integraciones con sistemas operacionales del cliente (tickets, NPS, eventos transaccionales), compite con tooling de observabilidad/CX existente, dispara el alcance del MVP y convierte a la boutique en operador permanente sin contrato para ello. Pero sin ninguna medición, el loop no cierra y la promesa de accountability ("decisión → resultado") queda vacía.

## Decisión

1. El producto acompaña **una medición temporal y acotada del impacto**, no la operación del servicio.
2. **Metric Registry por reto** con campos mínimos (§8.1): KPI, criterio de éxito, propietario del dato (persona del cliente), fuente, dimensiones/cortes, línea base con fecha, frecuencia, snapshots, enlace a dashboard externo y ventana + fecha de post mortem.
3. **Ventana por criterio de éxito definida desde la etapa 0**, con hasta seis meses como referencia inicial ajustable por ciclo del resultado.
4. Ingesta **solo manual, por formulario, CSV o enlace a dashboard externo**. Sin integraciones operacionales en el MVP; sin ingesta continua de tickets, NPS, quejas o eventos.
5. La lectura compara **baseline, snapshots posteriores a cada release y resultado final**; al cerrar la ventana se ejecuta el **post mortem** (outcome review) con veredicto: logrado / parcialmente logrado / no logrado / no concluyente.
6. **Sin causalidad automática**: salvo diseño experimental suficiente se habla de contribución, asociación y evidencia disponible, registrando factores externos conocidos.

## Alternativas consideradas

| Alternativa | Por qué se descarta |
|---|---|
| Telemetría/operación continua (v0.1) | Alcance y coste desproporcionados; compite fuera del whitespace (§1.3); rol de operador permanente sin modelo comercial |
| Sin medición (cerrar en la entrega del diseño) | Rompe la tesis central: trazabilidad hasta resultados; el producto queda como herramienta de delivery (riesgo §18) |
| Integraciones de solo-lectura con analítica del cliente | Deseable a futuro; en MVP añade superficie de seguridad e ingeniería que la carga manual/CSV evita; el enlace a dashboard externo cubre el caso |

## Consecuencias

- **Positivas**: loop demostrable con esfuerzo mínimo del cliente; el veredicto "no concluyente" existe y es honesto; el alcance del MVP se mantiene delgado.
- **Negativas / riesgos**: si el cliente no aporta snapshots, el post mortem sale "no concluyente" (mitigación §18: dueño del dato y frecuencia comprometidos en G6, recordatorios, y monitoreo como métrica de salud §17).
- **Reglas derivadas**: el Metric Registry se puebla y firma en G6; el seguimiento de impacto se muestra dentro del reto/proyecto, no como plataforma aparte (§2.1).

## Referencias

- Prediseño v0.2: §0.6, §3.4, §8, §6 (I5), §17, §18.
- `docs/05-specs/SPEC-07-metric-registry-postmortem.md`.
