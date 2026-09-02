---
title: "SPEC-08 — Capacidades AI por etapa"
type: product-spec
author: "Whitespace — producto"
date: 2026-09-01
version: "0.1"
status: draft
language: es
audience: engineering
tags: [spec, ai, propuestas, revisores, grounding, degradacion, presupuestos]
summary: "Especificación de la capa AI del MVP: el pipeline único PropuestaAI, las diez capacidades mínimas (C0–C7 por etapa, más el asistente transversal de gates y la extracción de importación), los revisores AI por arquetipo, el asistente de gates, las métricas de grounding y la degradación segura."
---

# SPEC-08 — Capacidades AI por etapa

## Propósito

Implementar la columna "Capacidad mínima MVP" de §7 bajo el patrón único de gobernanza (ADR-0012): contexto delimitado, propuestas estructuradas con citas, revisión humana, degradación segura.

## El pipeline único `PropuestaAI`

Toda capacidad de esta spec ejecuta el mismo ciclo:

1. **Scoping**: se computa el `AlcanceDeContexto` (RF-02.7) — subgrafo del reto + permisos del solicitante; nada fuera entra al prompt.
2. **Generación**: salida **estructurada** (tipada por capacidad) con citas a objetos/fragmentos del alcance y confianza; lineage registrado (modelo, prompt/config, versión).
3. **Revisión humana**: aceptar / corregir / rechazar, por elemento o lote pequeño; la propuesta original se conserva siempre (SYS-17).
4. **Materialización**: solo al aceptar se crean/modifican objetos del dominio, firmados por el humano que aceptó, con lineage adjunto (SYS-19).
5. **Medición**: cada propuesta alimenta las métricas de grounding y corrección (§9/§17).

## Alcance MVP: capacidades

| # | Capacidad (etapa) | Entrada | Salida estructurada |
|---|---|---|---|
| C0 | Borrador de reto (0) | Formulación inicial + memoria del workspace | Reencuadre + criterios de éxito medibles con ventana por criterio |
| C1 | Transcripción/diarización/codificación (1) | Audio/video/documentos de evidencia | Transcripción con hablantes, fragmentos codificados con citas exactas |
| C2 | Propuesta de insights (2) | Evidencia codificada del reto | Insights con afirmaciones + citas y contradicciones señaladas |
| C3 | Oportunidades HMW (3) | Insights validados + criterios del reto | HMW trazables a insights + priorización razonada |
| C4 | Revisores AI por arquetipo + diseño de tests (4) | Conceptos + arquetipos del reto | Hallazgos etiquetados **simulación** + preguntas/escenarios de test |
| C5 | Validación del grafo + render (5) | JourneyGraph/blueprint | Reporte de validación (RF-05.6) + Mermaid regenerado |
| C6 | Borrador Metric Registry + plan (6) | Criterios G0 + design version | Entradas KPI propuestas + descomposición en releases |
| C7 | Detección de desviaciones + borrador post mortem (7) | DV vs. constataciones; snapshots | Discrepancias propuestas; narrativa del outcome review sobre datos deterministas |
| CT | Asistente de gates (transversal) | Checklist + objetos del proyecto | "Qué falta para Gx" con huecos citados |
| CI | Extracción de importación (§12) | Ítems de la bandeja | Candidatos a objetos con mapeo y confianza |

Fuera del MVP: clustering avanzado, co-generación profunda de conceptos, prototipos rápidos, analogías desde biblioteca, specs por touchpoint automáticas, redacción de entregables/actas, memoria conversacional del workspace (visión §7 — se priorizan con datos de uso).

## Requisitos funcionales

| ID | Requisito |
|---|---|
| RF-08.1 | Las diez capacidades (C0–C7, CT, CI) operan exclusivamente vía el pipeline `PropuestaAI`; no existe escritura AI directa (SYS-19) |
| RF-08.2 | Revisores AI (C4): sesión por arquetipo con hallazgos derivados del arquetipo y evidencia citada; extrapolaciones marcadas como hipótesis; etiqueta "simulación AI" persistente e imposible de remover; sin modo "N usuarios" ni agregados porcentuales (SYS-20) |
| RF-08.3 | Las salidas de C4 no son seleccionables como evidencia en checklists de G4/G5; el tipo de objeto lo impide (SYS-20) |
| RF-08.4 | CT es informativo: reporta huecos citando objetos; carece de acción "aprobar" (SYS-18) |
| RF-08.5 | Presupuesto AI por workspace con límites configurables por Whitespace; al excederse, las capacidades se pausan con mensaje claro y todo flujo sigue disponible manualmente (SYS-21) |
| RF-08.6 | Degradación segura: caída del proveedor AI ⇒ los flujos manuales equivalentes están siempre presentes (crear insight a mano, llenar registry a mano, etc.); bandera de estado AI visible (SYS-21) |
| RF-08.7 | Evaluaciones de grounding: muestreo periódico de propuestas aceptadas — fidelidad de citas, afirmaciones no soportadas, tasa de corrección, contradicciones — con reporte por release del producto (§14) |
| RF-08.8 | Todo prompt que incluya material importado lo trata como datos no confiables (delimitación, sin ejecución de instrucciones embebidas) según SPEC-09 |
| RF-08.9 | Observabilidad AI: costo, latencia, tasa de error y tasa de aceptación por capacidad, por workspace |

## Criterios de aceptación (selección)

1. **Pipeline único** — Dada cualquier capacidad, cuando produce salida, entonces existe una `PropuestaAI` con lineage completo y estado, y ningún objeto de dominio nuevo hasta la aceptación humana.
2. **Simulación no contaminante (§19.3)** — Dado un hallazgo del revisor "desconfiado digital", cuando el equipo lo usa, entonces puede originar una pregunta de test, pero no puede citarse como evidencia ni contarse en G4.
3. **AI apagada** — Dado el flag "AI off", cuando se recorre el loop completo del piloto, entonces todas las operaciones de negocio son ejecutables manualmente (prueba de CI, SYS-21).
4. **Grounding medido** — Dada una corrida de evaluación sobre N propuestas, cuando termina, entonces el reporte incluye fidelidad de citas y afirmaciones no soportadas comparadas contra la corrida anterior (regresión, §14).

## Invariantes aplicables

SYS-17, SYS-18, SYS-19, SYS-20, SYS-21; SYS-02 (scoping).

## Dependencias y métricas

- Depende de: SPEC-02 (alcance), SPEC-09 (sanitización, proveedores). La consumen: todas.
- Métricas (§17): fidelidad de citas, afirmaciones no soportadas, corrección humana, contradicciones; costos/latencia/errores AI.

## Riesgos

| Riesgo | Mitigación |
|---|---|
| Grounding insuficiente erosiona toda la propuesta | Evals con regresión por release + corrección humana barata + métricas §17 |
| Sobre-dependencia de la AI en la boutique | La paridad manual es requisito estructural (RF-08.6), no plan B documental |
