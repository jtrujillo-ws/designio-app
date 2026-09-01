---
title: "ADR-0001 — Aplicación standalone sobre capacidades AI-native de Whitespace"
type: decision-record
author: "Whitespace — producto"
date: 2026-09-01
version: "1.0"
status: approved
language: es
audience: mixed
tags: [adr, plataforma, whitespace, build-vs-buy]
summary: "La plataforma se construye como aplicación completa e independiente, apoyada en las capacidades AI-native del stack Whitespace, en lugar de un plugin sobre herramientas existentes o un agente conversacional."
---

# ADR-0001 — Aplicación standalone sobre capacidades AI-native de Whitespace

| Campo | Valor |
|---|---|
| Estado | **Aceptada** (v0.1 del prediseño; ratificada en v0.2) |
| Fecha | 2026-09-01 |
| Decisores | Fundador / producto Whitespace |
| Fuente | Prediseño v0.2 §20 ("Aplicación completa standalone construida con las capacidades AI-native de Whitespace") |

## Contexto

El miedo fundacional del proyecto es "esto se hace solo con Claude". El análisis (§1.1) concluye que ese miedo es válido únicamente en la capa de generación de artefactos, que está comoditizada. Lo que un chat no da es: estado, estructura, gobernanza multiusuario, trazabilidad hasta resultados y memoria privada gobernada por cliente. Se necesitaba decidir la forma del producto: ¿app completa, plugin sobre Miro/Notion, GPT/agente conversacional empaquetado, o toolkit interno de la boutique?

## Decisión

Construir una **aplicación completa y standalone**, propietaria, apoyada en las capacidades AI-native ya existentes del stack interno de Whitespace (patrones probados en casa: aislamiento multi-workspace y quality gates con evidencia), que implementa el sistema de registro del método (grafo de dominio, gates, trazabilidad, medición).

## Alternativas consideradas

| Alternativa | Por qué se descarta |
|---|---|
| Plugin/tablero sobre Miro-Mural-Notion | Hereda el canvas libre como primitiva (anti-§10); sin control del modelo de datos ni de la trazabilidad; "un Miro peor" es riesgo fatal (§18) |
| Agente conversacional (GPT empaquetado / proyecto de Claude) | Reproduce exactamente la capa comoditizada; no es multiplayer, no gobierna estado ni gates; sin moat (§1.1) |
| Toolkit interno no productizado (plantillas + scripts) | No genera memoria estructurada por cliente ni switching cost; no escala a t2 (método instalable, §1.2) |
| SaaS self-serve para diseñadores individuales | Peor cuadrante: TAM chico, usuario capaz de DIY, incumbentes regalando IA (§15); contradice ADR-0002 |

## Consecuencias

- **Positivas**: control total del modelo de dominio y la cadena de trazabilidad; posibilidad de imponer los invariantes I1–I6 por diseño; reuso de patrones arquitectónicos ya operados por Whitespace.
- **Negativas / costos**: coste de construir y operar producto completo (identidad, permisos, auditoría, portal); responsabilidad de seguridad y confiabilidad AI propia (§14).
- **Riesgos aceptados**: dependencia del canal boutique para engagements reales (mitigación en §18); el alcance se contiene con el MVP delgado (ADR-0014).

## Decisión relacionada

El **reuso técnico** quedó resuelto en dirección (fundador, sep-2026): el scaffolding hereda los principios y parámetros del stack interno de Whitespace, fijados en `docs/06-diseno-tecnico/` (ADR formal "Stack del MVP" al iniciar el scaffolding). El **design system será propio**, orientado a una herramienta de diseño, y lo define el fundador antes del scaffolding de UI.

## Referencias

- Prediseño v0.2: §0, §1, §15, §18, §20.
- `docs/01-ddd/domain-model.md` — subdominios y clasificación estratégica.
