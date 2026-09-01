---
title: "ADR-0013 — Seguridad, privacidad y confiabilidad AI como parte del Definition of Done del MVP"
type: decision-record
author: "Whitespace — producto"
date: 2026-09-01
version: "1.0"
status: approved
language: es
audience: engineering
tags: [adr, seguridad, privacidad, confiabilidad-ai, dod]
summary: "Los requisitos de aislamiento, ciclo de vida del dato, amenazas AI, confiabilidad AI y auditoría no son backlog pospuesto: forman parte del Definition of Done del MVP, con sofisticación graduable según el piloto."
---

# ADR-0013 — Seguridad y confiabilidad AI en el DoD del MVP

| Campo | Valor |
|---|---|
| Estado | **Aceptada** (v0.2; nueva sección respecto de v0.1) |
| Fecha | 2026-09-01 |
| Decisores | Fundador / producto Whitespace (revisión adversarial sep-2026) |
| Fuente | Prediseño v0.2 §14, §16, changelog punto 10 |

## Contexto

El producto ingiere material sensible del cliente (entrevistas grabadas, datos de operación, documentos internos), lo procesa con AI de proveedores externos y lo expone a múltiples roles incluido el propio cliente. La v0.1 no trataba seguridad como requisito de primera clase. La revisión adversarial identificó tres amenazas específicas que no admiten "lo hacemos después": fuga entre tenants, prompt injection vía material importado y afirmaciones AI sin grounding presentadas al cliente. Un solo incidente en el piloto destruye la tesis completa (la confianza es el producto).

## Decisión

Los siguientes requisitos son parte del **Definition of Done del MVP** (graduables en sofisticación según el piloto; no posponibles como trabajo indefinido):

| Ámbito | Requisitos mínimos |
|---|---|
| Aislamiento y acceso | Aislamiento verificable entre tenants; permisos a nivel de objeto; clasificación de datos y controles por sensibilidad |
| Ciclo de vida del dato | Retención, exportación y borrado (incluidos objetos derivados); consentimiento de grabación y transcripción; cifrado en tránsito y reposo; gestión segura de secretos |
| Amenazas específicas AI | Material importado tratado como no confiable: protección contra prompt injection, escaneo de malware, validación de formatos; condiciones de uso de datos de proveedores AI (prohibición de entrenamiento cuando aplique) |
| Confiabilidad AI | Evaluaciones de grounding, fidelidad de citas y regresión; degradación segura; presupuestos y límites AI por workspace |
| Auditoría y operación | Auditoría completa de accesos, aprobaciones, cambios y acciones AI; observabilidad de costos, latencia, errores y calidad |

## Alternativas consideradas

| Alternativa | Por qué se descarta |
|---|---|
| Seguridad como backlog post-MVP | Un incidente en el piloto es fatal; retrofitting de aislamiento y auditoría es mucho más caro que diseñarlos |
| Certificación formal (ISO/SOC2) antes del piloto | Desproporcionado para MVP de un piloto; lo exigible es el baseline verificable, no el sello |
| Solo controles de infraestructura (sin evals AI) | Las amenazas nuevas son AI-específicas (injection, grounding); infra sola no las cubre |

## Consecuencias

- **Positivas**: la promesa de propiedad y aislamiento (ADR-0008/0011) es demostrable; el material importado — vector principal de injection (§12) — nace gobernado; las evals de grounding dan la métrica de salud central (§17).
- **Negativas**: el MVP carga con trabajo no-funcional significativo; hay que presupuestarlo como parte del loop delgado (ADR-0014), no como extra.
- **Enforcement**: checklist de DoD por release del producto; las métricas de grounding y auditoría se revisan como métricas de salud (§17).

## Referencias

- Prediseño v0.2: §9, §12, §14, §16, §17, §18.
- `docs/05-specs/SPEC-09-seguridad-confiabilidad.md`; `docs/06-diseno-tecnico/diseno-tecnico.md`.
