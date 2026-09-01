---
title: "ADR-0014 — Alcance del MVP: loop completo, delgado y confiable para un cliente, un servicio y un reto"
type: decision-record
author: "Whitespace — producto"
date: 2026-09-01
version: "1.0"
status: approved
language: es
audience: mixed
tags: [adr, mvp, alcance, priorizacion]
summary: "El MVP demuestra el loop completo (etapa 0 → post mortem) con capacidad mínima y útil de AI en cada etapa, para exactamente un cliente, un servicio y un reto. La suscripción post-engagement se trata como hipótesis con experimento explícito."
---

# ADR-0014 — Alcance del MVP: loop completo y delgado

| Campo | Valor |
|---|---|
| Estado | **Aceptada** (v0.2) |
| Fecha | 2026-09-01 |
| Decisores | Fundador / producto Whitespace (revisión adversarial sep-2026) |
| Fuente | Prediseño v0.2 §7, §15, §16, §20, changelog puntos 11–12 |

## Contexto

El prediseño describe una visión amplia (capacidades AI profundas por etapa, importadores sofisticados, múltiples vistas). El riesgo clásico es construir ancho antes que profundo: muchas features y ningún loop demostrado. La tesis del producto es precisamente el loop (promesa medible → diseño trazable → implementación constatada → veredicto); si el loop no cierra en un caso real, nada más importa. Además, la recurrencia (suscripción) no está demostrada: tratarla como hecho sesgaría todas las decisiones de alcance.

## Decisión

1. Objetivo del MVP: **demostrar un loop completo, delgado y confiable** para **un cliente piloto real, un servicio y un reto**, de etapa 0 a post mortem.
2. **Una capacidad AI mínima y útil por etapa** (columna "Capacidad mínima MVP" de §7); la profundización posterior se decide con datos de uso.
3. Alcance incluido/excluido según §16:

| Incluido | Fuera del MVP |
|---|---|
| Workspace propiedad del cliente; boutique operadora | Canvas libre propio |
| Servicio, reto, proyecto y criterios de éxito | Telemetría continua e integraciones operacionales |
| Ingesta multimodal y curaduría de evidencia | Corpus/benchmarks/aprendizaje cross-cliente |
| Grafo básico evidencia → insight → decisión | Múltiples boutiques |
| Journey como grafo tipado con render Mermaid | Importadores sofisticados / sync Miro-Figma |
| Una herramienta AI útil por etapa 0–7 | Automatización profunda de cada etapa |
| Revisores AI etiquetados; gates flexibles con aprobación humana | |
| Design version, release, effective state y diff | |
| Metric Registry manual/CSV; ventana y post mortem | |
| Portal de comentarios y aprobaciones | |
| Baseline de seguridad, auditoría, observabilidad y evals AI | |

4. La **suscripción post-engagement es hipótesis comercial por validar** con experimento explícito en los primeros pilotos (precio, contenido y momento de oferta: decisión abierta §20). Ninguna feature del MVP se justifica "para la recurrencia" mientras la hipótesis no valide.

## Alternativas consideradas

| Alternativa | Por qué se descarta |
|---|---|
| MVP ancho (todas las capacidades §7 en versión completa) | Sin loop demostrado no hay tesis; coste y tiempo desproporcionados |
| MVP de solo diseño (etapas 0–6, sin medición) | Es exactamente "herramienta de delivery" — el anti-objetivo (§18) |
| Piloto interno sin cliente real | t1 de la escalera del moat exige cliente operando (§1.2); el MVP exige piloto real (§18) |

## Consecuencias

- **Positivas**: criterio de corte inequívoco para todo backlog ("¿lo necesita el loop del piloto?"); las métricas de salud (§17) son medibles desde el primer reto.
- **Negativas**: el piloto verá aristas sin pulir (un solo cliente/reto las tolera; el perfil del reto piloto debe elegirse con KPI medible y dueño del dato claro — decisión abierta §20).
- **Dependencia**: cliente y reto piloto por definir; sin engagement real no hay t1 (riesgo canal §18).

## Referencias

- Prediseño v0.2: §1.2, §7, §15, §16, §17, §18, §20.
- Todos los `SPEC-*` marcan su alcance MVP contra este ADR.
