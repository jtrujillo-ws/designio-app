---
title: "SPEC-09 — Seguridad, privacidad y confiabilidad AI"
type: product-spec
author: "Whitespace — producto"
date: 2026-09-01
version: "0.1"
status: draft
language: es
audience: engineering
tags: [spec, seguridad, privacidad, prompt-injection, auditoria, observabilidad, dod]
summary: "Especificación del baseline de seguridad del MVP como parte del Definition of Done: aislamiento entre tenants, ciclo de vida del dato, defensa frente a amenazas específicas de AI, confiabilidad AI verificada y auditoría/observabilidad completas."
---

# SPEC-09 — Seguridad, privacidad y confiabilidad AI

## Propósito

Implementar §14 y ADR-0013: los requisitos de seguridad y confiabilidad como parte del DoD del MVP, graduables en sofisticación según el piloto pero nunca pospuestos indefinidamente.

## Modelo de amenazas (mínimo)

| Amenaza | Vector | Control principal |
|---|---|---|
| Fuga entre tenants | Query sin filtro; contexto AI mal delimitado; export cruzado | Tenancy estructural (SYS-01/02) + tests de aislamiento en CI |
| Prompt injection | Material importado (PDFs, transcripciones, tableros) con instrucciones embebidas | Tratamiento como datos no confiables: delimitación estricta en prompts, sin herramientas de escritura directa desde contenido, curaduría humana (SYS-16) |
| Malware en archivos | Carga a la bandeja de importación | Escaneo + validación de formatos + almacenamiento aislado antes de procesar |
| Exfiltración vía AI | Proveedor entrena con datos del cliente | Condiciones contractuales de proveedores (no-training cuando aplique), registro de qué salió a qué proveedor (lineage) |
| Acciones no auditadas | Cambios/aprobaciones sin rastro | Auditoría append-only universal (RF-01.6) |
| Alucinación presentada al cliente | Propuestas AI sin grounding | Pipeline PropuestaAI + evals de grounding + revisión humana (SPEC-08) |
| Pérdida de datos del engagement | Fallo de infraestructura | Backups y continuidad técnica (responsabilidad Whitespace, ADR-0011) |

## Requisitos

### Aislamiento y acceso

| ID | Requisito |
|---|---|
| RF-09.1 | Aislamiento verificable entre tenants: identidad de workspace en todo objeto + política de acceso a nivel de fila/objeto; batería de tests de aislamiento ejecutada en CI |
| RF-09.2 | Permisos a nivel de objeto según la matriz de roles (SPEC-01); denegación por defecto |
| RF-09.3 | Clasificación de datos por sensibilidad (dimensión Derechos de la evidencia) con controles de acceso y de cita derivados |

### Ciclo de vida del dato

| ID | Requisito |
|---|---|
| RF-09.4 | Retención, exportación y borrado cubren también objetos derivados (insights, propuestas AI, índices/embeddings, renders) |
| RF-09.5 | Consentimiento de grabación y transcripción capturado antes de procesar evidencia de personas |
| RF-09.6 | Cifrado en tránsito y en reposo; gestión de secretos en un secret manager (nunca en código ni configuración plana) |

### Amenazas específicas AI

| ID | Requisito |
|---|---|
| RF-09.7 | Todo contenido importado o de origen externo se marca no-confiable y se procesa con prompts que lo delimitan como datos; las instrucciones embebidas en contenido no se ejecutan |
| RF-09.8 | Escaneo de malware y validación de formato en la bandeja antes de preview o procesamiento AI |
| RF-09.9 | Registro por proveedor AI de condiciones de uso de datos (incluida prohibición de entrenamiento cuando aplique) y del dato de qué workspace salió a qué proveedor |

### Confiabilidad AI

| ID | Requisito |
|---|---|
| RF-09.10 | Suite de evaluaciones de grounding y fidelidad de citas con línea base y regresión por release del producto (RF-08.7) |
| RF-09.11 | Degradación segura verificada: prueba "AI off" del loop completo en CI (SYS-21) |
| RF-09.12 | Presupuestos y límites AI por workspace con corte suave (pausa de capacidades, nunca de flujos de negocio) |

### Auditoría y operación

| ID | Requisito |
|---|---|
| RF-09.13 | Auditoría completa de accesos, aprobaciones, cambios y acciones AI, append-only, consultable y exportable |
| RF-09.14 | Observabilidad de costos, latencia, errores y calidad (métricas AI de RF-08.9 + salud de plataforma) |

## Definition of Done del MVP (checklist)

| Ítem | Verificación |
|---|---|
| Tests de aislamiento por tenant en verde | CI bloqueante |
| Prueba "AI off" del loop completo en verde | CI bloqueante |
| Evals de grounding con línea base publicada | Reporte por release |
| Escaneo/validación activos en la bandeja | Test de integración |
| Export/borrado completo verificado contra manifiesto | Prueba documentada (SYS-04) |
| Auditoría cubriendo el catálogo de acciones | Revisión de cobertura |
| Secretos en secret manager; cifrado verificado | Revisión de configuración |
| Condiciones de proveedores AI registradas | Documento operativo |

## Invariantes aplicables

SYS-01–SYS-04, SYS-16, SYS-17, SYS-21; sostiene a todas las demás specs.

## Dependencias y métricas

- Transversal a todas las specs; el diseño técnico (`docs/06-diseno-tecnico/`) fija los mecanismos concretos.
- Métricas (§17): grounding; además incidentes = 0 como condición del piloto.

## Riesgos

| Riesgo | Mitigación |
|---|---|
| El baseline se recorta "por velocidad" | Es DoD (ADR-0013): el checklist de arriba es bloqueante del MVP; graduable en sofisticación, no en existencia |
| Coste de evals continuo | Muestreo pequeño y estable > cobertura exhaustiva; la tasa de corrección humana ya es señal gratuita |
