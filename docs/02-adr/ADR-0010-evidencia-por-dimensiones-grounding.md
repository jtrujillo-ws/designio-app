---
title: "ADR-0010 — Modelo de evidencia por dimensiones y métricas de grounding"
type: decision-record
author: "Whitespace — producto"
date: 2026-09-01
version: "1.0"
status: approved
language: es
audience: engineering
tags: [adr, evidencia, grounding, calidad, lineage]
summary: "La evidencia se clasifica por cinco dimensiones independientes (proveniencia, método, calidad, derechos, lineage) en lugar de tres grados de un solo eje, y el grounding se mide: fidelidad de citas, afirmaciones no soportadas, corrección humana y contradicciones."
---

# ADR-0010 — Evidencia por dimensiones y grounding medido

| Campo | Valor |
|---|---|
| Estado | **Aceptada** (v0.2; reemplaza los "tres grados" de v0.1) |
| Fecha | 2026-09-01 |
| Decisores | Fundador / producto Whitespace (revisión adversarial sep-2026) |
| Fuente | Prediseño v0.2 §9, §6 (I3), changelog punto 9 |

## Contexto

La v0.1 clasificaba evidencia en tres grados sobre un solo eje. Es insuficiente: una entrevista reciente puede tener gran proveniencia y método débil; un dato importado puede ser sólido pero carecer de derechos de uso; una transcripción AI puede ser fiel pero necesitar lineage para auditar transformaciones. Un solo eje obliga a promediar cosas incomparables y esconde el riesgo dominante. Además, "tiene cita" venía funcionando como sinónimo de "está fundamentado", lo cual la revisión señaló como falacia: la cita puede no decir lo que el objeto afirma.

## Decisión

1. Cada evidencia u objeto derivado registra **cinco dimensiones independientes**:

| Eje | Dimensiones registradas |
|---|---|
| Proveniencia | Tipo de fuente; fecha y vigencia; fragmento exacto o localización precisa |
| Método | Método de recolección; directa o derivada; segmento, muestra y contexto |
| Calidad | Confianza estimada; evidencia que corrobora; evidencia que contradice |
| Derechos | Consentimiento y derechos de uso; clasificación de confidencialidad y alcance de acceso |
| Lineage | Transformaciones AI aplicadas; versión de modelo, prompt o configuración |

2. **La presencia de cita no equivale a grounding.** Se miden de forma continua: fidelidad de citas (la cita dice lo que el objeto afirma), tasa de afirmaciones no soportadas, tasa de corrección humana sobre propuestas AI y contradicciones detectadas. Estas métricas alimentan las evaluaciones AI (§14) y las métricas de salud (§17).

## Alternativas consideradas

| Alternativa | Por qué se descarta |
|---|---|
| Tres grados en un eje (v0.1) | Promedia dimensiones incomparables; oculta el riesgo dominante (p. ej. derechos) |
| Score numérico compuesto | Falsa precisión; invita a umbralizar sin entender qué dimensión falla |
| Sin medición de grounding (confiar en la cita) | La falacia detectada: cita ≠ respaldo; erosiona la confianza en toda la propuesta AI (riesgo §18) |

## Consecuencias

- **Positivas**: los gates de suficiencia pueden exigir dimensiones específicas (p. ej. derechos para citar en entregables); el riesgo por eje es visible; la corrección humana barata se convierte en señal medible de calidad AI.
- **Negativas**: más campos que capturar (mitigación: la AI propone dimensiones en la importación y curaduría §12; defaults por tipo de fuente).
- **Reglas derivadas**: derechos viajan con la evidencia y restringen su uso aguas abajo; lineage obligatorio en todo objeto tocado por AI; las contradicciones no se ocultan — se registran y se muestran (G2 exige contradicciones resueltas o explícitas).

## Referencias

- Prediseño v0.2: §6 (I3), §9, §14, §17.
- `docs/05-specs/SPEC-03-evidencia-importacion.md`; `docs/05-specs/SPEC-08-capacidades-ai.md`.
