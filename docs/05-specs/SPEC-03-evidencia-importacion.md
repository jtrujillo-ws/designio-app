---
title: "SPEC-03 — Evidencia, importación y curaduría"
type: product-spec
author: "Whitespace — producto"
date: 2026-09-01
version: "0.1"
status: draft
language: es
audience: engineering
tags: [spec, evidencia, importacion, curaduria, dimensiones, insights]
summary: "Especificación del modelo de evidencia por cinco dimensiones, la ingesta multimodal, la bandeja de importación con extracción propuesta por AI y curaduría humana obligatoria, y los insights con citas verificables."
---

# SPEC-03 — Evidencia, importación y curaduría

## Propósito

Implementar el modelo de evidencia por dimensiones (§9, ADR-0010) y el flujo de importación (§12): resolver el arranque en frío y capturar el trabajo externo como evidencia, con la curaduría humana como gate estructural (SYS-16).

## Alcance MVP

| Incluido | Fuera del MVP |
|---|---|
| Ingesta multimodal: documentos, presentaciones, hojas de cálculo, fotos, audio, video, exports/enlaces de Miro-Figma | Reconstrucción editable de tableros; sincronización bidireccional |
| Bandeja de importación con extracción propuesta (AI) y confianza | Importación semántica perfecta de nodos/componentes |
| Curaduría humana: aprobar / ajustar / rechazar; estado actual vs. histórico | Preservación exhaustiva del layout original |
| Cinco dimensiones de evidencia + citas con localización exacta | — |
| Transcripción y diarización de audio/video con citas exactas | — |
| Insights con afirmaciones, citas y contradicciones | Clustering avanzado (post-MVP; §7 visión) |
| Preview + OCR/lectura visual básica de artefactos | — |

## Objetos del dominio

`Fuente`, `Evidencia` (con VOs Proveniencia, Método, Calidad, Derechos, Lineage), `Cita`, `Insight`, `ItemImportacion`. Ver CTX-02.

## Requisitos funcionales

| ID | Requisito |
|---|---|
| RF-03.1 | Bandeja de importación por workspace: carga de archivos y enlaces con registro de origen, autor, fecha, permisos y contexto |
| RF-03.2 | Todo material importado se trata como **contenido no confiable**: escaneo de malware, validación de formato y sanitización previa a cualquier procesamiento AI (SYS de SPEC-09) |
| RF-03.3 | Extracción propuesta: la AI detecta candidatos a objetos (servicios, journeys, blueprints, personas → arquetipos históricos, insights, KPIs, segmentos) con mapeo al grafo y nivel de confianza por candidato |
| RF-03.4 | Curaduría: ningún candidato entra al grafo sin acción humana explícita; el curador decide además qué describe el estado actual y qué queda como histórico |
| RF-03.5 | Todo objeto importado queda con dimensiones de evidencia completas y citas que enlazan al documento original |
| RF-03.6 | Registrar evidencia nativa (entrevistas, observaciones, datasets) con las cinco dimensiones; el consentimiento de grabación/transcripción se captura como parte de Derechos |
| RF-03.7 | Transcripción y diarización de audio/video; los fragmentos citables conservan localización exacta (offset temporal o página/párrafo) |
| RF-03.8 | Codificación asistida: etiquetar fragmentos por segmento y tema, manteniendo el enlace fragmento → fuente |
| RF-03.9 | Insight: afirmaciones + ≥1 cita por afirmación soportada; contradicciones entre evidencias se registran y se muestran, nunca se ocultan |
| RF-03.10 | Los derechos de una evidencia restringen su uso: citar evidencia sin derechos válidos para el contexto (p. ej. entregable al cliente) se bloquea con explicación |

## Criterios de aceptación (selección)

1. **Curaduría obligatoria** — Dada una extracción propuesta con confianza alta, cuando nadie la aprueba, entonces ningún objeto existe en el grafo; la propuesta permanece en la bandeja (SYS-16).
2. **Cita verificable** — Dado un insight con una cita, cuando el usuario la abre, entonces llega al fragmento exacto (posición en documento o timestamp en audio) del original importado (I3).
3. **Derechos bloqueantes** — Dada una entrevista sin consentimiento registrado, cuando un diseñador intenta citarla en un artefacto del portal, entonces la operación se bloquea indicando la dimensión faltante (SYS-14).
4. **Ejemplo §19.1** — Dado el estudio CX (PDF) y el funnel (hoja de cálculo) del banco, cuando se curan, entonces el servicio queda con estado actual descrito, línea base 62% y evidencia con proveniencia documental, método derivado y derechos acordados.

## Invariantes aplicables

SYS-14, SYS-15, SYS-16, SYS-17 (conservación de la propuesta original).

## Dependencias y métricas

- Depende de: SPEC-01 (permisos), SPEC-08 (extracción como PropuestaAI), SPEC-09 (sanitización).
- Métricas (§17): fidelidad de citas; tasa de afirmaciones no soportadas; tasa de corrección humana; contradicciones detectadas.

## Riesgos

| Riesgo | Mitigación |
|---|---|
| Prompt injection en material importado | RF-03.2 + tratamiento del contenido como datos en todo prompt (SPEC-09) |
| Fatiga de curaduría con material masivo | Priorización por confianza; curar es aceptar/ajustar en lote pequeño; el MVP importa lo del piloto, no archivos históricos completos |
