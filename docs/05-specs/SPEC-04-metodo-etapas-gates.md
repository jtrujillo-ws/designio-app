---
title: "SPEC-04 — Método: retos, proyectos, etapas y gates"
type: product-spec
author: "Whitespace — producto"
date: 2026-09-01
version: "0.1"
status: draft
language: es
audience: engineering
tags: [spec, metodo, retos, proyectos, gates, perfiles, arquetipos]
summary: "Especificación del método ejecutable: retos con criterios y ventanas, proyectos con perfiles, etapas 0–7 canónicas y flexibles, gates de suficiencia G0–G7 con checklists y aprobación humana, reaperturas trazadas, no-aplicabilidades y arquetipos del reto."
---

# SPEC-04 — Método: retos, proyectos, etapas y gates

## Propósito

Implementar el "método como código" (§5, ADR-0005): las etapas 0–7 canónicas en vocabulario y resultados, flexibles en ejecución, con gates que evalúan suficiencia y se aprueban por humanos en el portal.

## Alcance MVP

| Incluido | Fuera del MVP |
|---|---|
| Reto: formulación, criterios de éxito con ventana por criterio, arquetipos, estados | Gestión de portafolio multi-reto avanzada |
| Proyecto con perfil (rápido/estándar/profundo) y etapas 0–7 | Plantillas de proyecto configurables por cliente (I1 lo veta) |
| Gates G0–G7 con checklist de suficiencia por perfil | Checklists editables por workspace |
| Aprobación humana en el portal; N/A justificada y aprobada | — |
| Reaperturas trazadas con marcado aguas abajo | Motor de dependencias automático completo (marcado asistido en MVP) |
| Paralelismo: actividades de varias etapas abiertas a la vez | — |
| Backlog de retos por servicio | — |
| Asistente de gate AI: "qué falta para este gate" | Auto-aprobación de cualquier tipo (I4 lo veta) |

## Objetos del dominio

`Reto`, `CriterioDeÉxito`, `Arquetipo`, `Proyecto`, `EtapaInstancia`, `GateInstancia`, `ChecklistSuficiencia`, `NoAplicabilidad`, `Decisión`, `Reapertura`, `Aprobación`. Ver CTX-03.

## Requisitos funcionales

| ID | Requisito |
|---|---|
| RF-04.1 | Crear reto (candidato) sobre un servicio ancla, con servicios afectados adicionales; formulación, stakeholders y origen (post mortem, hallazgo, petición) |
| RF-04.2 | Definir criterios de éxito: KPI, definición, línea base (valor y fecha, o plan para obtenerla), objetivo, **ventana de medición propia** y fecha prevista de post mortem |
| RF-04.3 | Activar el reto abre un proyecto con perfil elegido; el perfil gradúa actividades y umbrales de los checklists, nunca el vocabulario ni los resultados canónicos |
| RF-04.4 | Las 8 etapas existen siempre con sus resultados canónicos (§5.2); las actividades pueden ejecutarse en paralelo; el estado de etapa es informativo, el estado que gobierna es el de los gates |
| RF-04.5 | Cada gate Gx tiene un checklist de suficiencia (según perfil) cuyos ítems referencian objetos reales (evidencias, insights, decisiones, resultados de test, documentos), no casillas sueltas |
| RF-04.6 | Un ítem de checklist admite tres estados: cumplido (con objeto enlazado), pendiente, o N/A (justificación + aprobación de rol autorizado); no existe cuarto estado |
| RF-04.7 | Aprobar un gate exige checklist sin pendientes y aprobación del rol definido (G0/G3/G5/G6: sponsor; G1/G2/G4/G7: lead, con validación de stakeholders donde aplica §13.2), ejecutada en el portal |
| RF-04.8 | El asistente de gate (AI) evalúa el checklist contra los objetos y reporta "qué falta", citando los huecos; es informativo y no puede aprobar (SYS-18) |
| RF-04.9 | Reabrir una etapa registra motivo y cambios, y marca para revisión las decisiones aguas abajo afectadas; el historial previo permanece intacto |
| RF-04.10 | Decisiones: registrar decisiones aprobadas (incluidas pasa/muere de conceptos) con enlaces a los insights/evidencia que las sostienen y al gate en que se tomaron |
| RF-04.11 | Arquetipos del reto: definición, mapeo n:m a segmentos, evidencia enlazada obligatoria para pasar G2; los arquetipos históricos del cliente se ofrecen como hipótesis a confirmar o refutar |
| RF-04.12 | Estados del reto (candidato → activo → en medición → cerrado con veredicto / archivado) y del proyecto (activo → en implementación → en medición → cerrado inmutable) según §3.3 |

## Criterios de aceptación (selección)

1. **G0 completo** — Dado un reto con dos criterios, cuando uno carece de ventana, entonces G0 no puede aprobarse y el asistente lo señala (SYS-22).
2. **Suficiencia, no artefactos** — Dado un concepto que avanza sin evidencia de test enlazada ni N/A aprobada, cuando el lead intenta aprobar G4, entonces el sistema lo bloquea listando el ítem incumplido (SYS-13); las salidas de revisores AI presentes no cuentan (SYS-20).
3. **Reapertura trazada** — Dada la etapa 2 reabierta tras nuevos hallazgos, cuando se confirma la reapertura, entonces las decisiones de etapas 3–5 que citan los insights modificados quedan marcadas "en revisión" y el evento queda auditado (SYS-10).
4. **Perfil sin dilución** — Dado un proyecto de perfil rápido, cuando se consulta cualquier etapa, entonces los nombres y resultados canónicos son idénticos a los de un perfil profundo; solo difieren actividades y umbrales (SYS-09).

## Invariantes aplicables

SYS-08, SYS-09, SYS-10, SYS-11, SYS-12, SYS-13, SYS-18, SYS-22.

## Dependencias y métricas

- Depende de: SPEC-01 (roles/portal), SPEC-03 (objetos citables), SPEC-08 (asistente de gate). La consumen: SPEC-06 (G5–G7), SPEC-07 (G0/G6).
- Métricas (§17): % de decisiones aprobadas con cadena completa; excepciones al vocabulario canónico (debe ser cero); tiempo de arranque (etapas 0–2) del reto N vs. N−1.

## Riesgos

| Riesgo | Mitigación |
|---|---|
| Checklists genéricos que nadie llena con criterio | El contenido metodológico de los checklists por perfil lo versiona la boutique en la biblioteca general (CTX-07) y se refina tras el piloto |
| Burocracia percibida | El asistente de gate reduce el costo de saber qué falta; el perfil rápido gradúa el volumen, nunca la promesa |
