---
title: "ADR-0005 — Etapas 0–7 canónicas en vocabulario y resultados, flexibles en ejecución; gates de suficiencia"
type: decision-record
author: "Whitespace — producto"
date: 2026-09-01
version: "1.0"
status: approved
language: es
audience: mixed
tags: [adr, metodo, etapas, gates, flexibilidad]
summary: "Las etapas 0–7 fijan vocabulario y resultados canónicos pero permiten iteración, reapertura trazada, paralelismo, perfiles y no-aplicabilidad justificada; los gates evalúan suficiencia de evidencia, riesgos y decisiones, no presencia de artefactos."
---

# ADR-0005 — Etapas canónicas y flexibles; gates de suficiencia

| Campo | Valor |
|---|---|
| Estado | **Aceptada** (canonicidad en v0.1; flexibilidad de ejecución en v0.2) |
| Fecha | 2026-09-01 |
| Decisores | Fundador / producto Whitespace (revisión adversarial sep-2026) |
| Fuente | Prediseño v0.2 §5, §6 (I1, I2) |

## Contexto

Un método rígido en cascada no sobrevive a proyectos reales (iteración, hallazgos tardíos, trabajo en paralelo, actividades que no aplican). Un método totalmente libre destruye la comparabilidad entre proyectos y la doctrina que constituye una capa del moat ("método como código", §1.2). Además, en v0.1 los gates verificaban presencia de artefactos, lo que incentiva teatro documental: producir el entregable sin la evidencia que lo sostiene.

## Decisión

1. **Canónico**: el vocabulario de las etapas 0–7 y sus resultados (objetos producidos) no se renombran ni cambian por cliente, deal o proyecto. Modelos externos (IDEO, Double Diamond) son crosswalk de presentación.
2. **Flexible**: las etapas se pueden iterar y reabrir (con registro de qué cambió y marcado de decisiones aguas abajo afectadas), ejecutar en paralelo, graduar por **perfil** (rápido / estándar / profundo) y declarar criterios o actividades **no aplicables** con justificación y aprobación auditada.
3. **Gates de suficiencia**: G0–G7 ordenan **decisiones**, no encadenan el trabajo; evalúan suficiencia de evidencia, riesgos y decisiones según el perfil, y los aprueban humanos con el rol correcto en el portal.
4. **La validación es gate, no etapa** (I2): prototipado y test son actividades obligatorias (según perfil) de las etapas 4 y 5; sus gates exigen la evidencia de test o la no-aplicabilidad aprobada.

## Alternativas consideradas

| Alternativa | Por qué se descarta |
|---|---|
| Cascada estricta 0→7 | Irreal; bloquea paralelismo y descubrimiento tardío; genera cumplimiento ficticio |
| Método libre por proyecto | Destruye comparabilidad de objetos y resultados; erosiona doctrina (I1) y datos de mejora del método |
| Etapas renombrables por cliente | Auto-dilución explícitamente vetada (I6): "un deal que exige renombrar etapas no es un cliente de esta plataforma" |
| Gates por presencia de artefactos (v0.1) | Incentiva el artefacto sin evidencia; la suficiencia es lo que un chat no garantiza (§1.2) |

## Consecuencias

- **Positivas**: comparabilidad vive en objetos y resultados; los proyectos reales caben sin excepciones; el enforcement se concentra en el momento de decidir.
- **Negativas**: los checklists de suficiencia por gate y perfil hay que definirlos y mantenerlos (biblioteca general, CTX-07); la reapertura trazada exige tooling de impacto aguas abajo.
- **Reglas derivadas**: reabrir una etapa nunca borra historia; los revisores AI no computan para G4/G5 (ADR-0009); el gate auto-verificado AI es asistente ("qué falta"), nunca aprobador (I4).

## Referencias

- Prediseño v0.2: §5.1, §5.2, §6 (I1, I2), §7 (gates auto-verificados).
- `docs/05-specs/SPEC-04-metodo-etapas-gates.md`; `docs/03-invariantes/invariantes.md`.
