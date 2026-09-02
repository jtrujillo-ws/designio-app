---
title: "ADR-0009 — Revisores AI basados en arquetipos, con límites metodológicos estrictos"
type: decision-record
author: "Whitespace — producto"
date: 2026-09-01
version: "1.0"
status: approved
language: es
audience: mixed
tags: [adr, ai, arquetipos, usuarios-sinteticos, metodologia]
summary: "Los antes llamados 'usuarios sintéticos' se redefinen como revisores AI basados en arquetipos: lentes de revisión adversarial etiquetadas como simulación, que no producen evidencia, no computan para gates y no sustituyen investigación con personas reales."
---

# ADR-0009 — Revisores AI basados en arquetipos

| Campo | Valor |
|---|---|
| Estado | **Aceptada** (v0.2; reencuadra los "usuarios sintéticos" de v0.1) |
| Fecha | 2026-09-01 |
| Decisores | Fundador / producto Whitespace (revisión adversarial sep-2026) |
| Fuente | Prediseño v0.2 §4.2, §7 (etapa 4), §21, changelog punto 8 |

## Contexto

La v0.1 hablaba de "usuarios sintéticos", un framing peligroso: sugiere que la simulación AI puede sustituir investigación con personas, produce "porcentajes de mercado" sin base y contamina la cadena de evidencia — exactamente el tipo de afirmación que la sección de honestidad (§21) prohíbe vender. A la vez, usar los arquetipos del reto como lente de revisión adversarial tiene valor real: cuestiona supuestos, detecta exclusiones y genera preguntas para tests reales.

## Decisión

Los arquetipos del reto pueden actuar como **revisores AI**: lentes de revisión transversales que cuestionan supuestos desde las características del arquetipo, identifican fricciones/exclusiones/contradicciones/riesgos, comparan el efecto de una decisión entre arquetipos, proponen preguntas y escenarios para tests con personas reales y ejecutan revisión adversarial de journeys, conceptos, blueprints o releases.

**Límites obligatorios (no negociables):**

| Límite | Enforcement |
|---|---|
| Siempre etiquetados como **simulación AI** | Etiqueta persistente en el objeto y en toda UI que lo muestre |
| No producen evidencia primaria | Sus salidas no son instancias de `Evidencia`; no pueden citarse como respaldo de insights |
| No computan para aprobar G4 ni G5 | Excluidos del checklist de suficiencia de esos gates |
| Sin simulaciones masivas ni porcentajes sintéticos | No existe la operación "simular N usuarios"; sin agregados presentados como hallazgo de mercado |
| Derivación trazable | Sus afirmaciones derivan del arquetipo y de evidencia real citada; extrapolaciones marcadas como hipótesis |

## Alternativas consideradas

| Alternativa | Por qué se descarta |
|---|---|
| "Usuarios sintéticos" como evidencia (v0.1) | Contamina la cadena de evidencia; vende validación falsa; prohibido por §21 |
| Eliminar toda simulación por arquetipo | Pierde una revisión adversarial barata y útil que origina preguntas de test reales (ejemplo §19.3) |
| Paneles sintéticos cuantitativos con disclaimers | El disclaimer no sobrevive al deck del sponsor; el riesgo reputacional supera el valor |

## Consecuencias

- **Positivas**: valor AI real (pre-mortem por arquetipo, detección de exclusión) sin contaminar evidencia; genera mejores tests con personas reales.
- **Negativas**: hay que explicar la distinción simulación/evidencia a boutique y cliente (la etiqueta y el portal ayudan); menor "wow" comercial que prometer usuarios sintéticos — deliberado.
- **Ejemplo canónico**: en §19.3, el revisor del "desconfiado digital" señala riesgo de exclusión → origina una pregunta del test real con 8 usuarios; nada del revisor computa para G4.

## Referencias

- Prediseño v0.2: §4.1, §4.2, §7, §19.3, §21.
- `docs/05-specs/SPEC-08-capacidades-ai.md`; `docs/03-invariantes/invariantes.md`.
