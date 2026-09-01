---
title: "ADR-0012 — La AI propone y cita; el humano aprueba; el sistema degrada seguro"
type: decision-record
author: "Whitespace — producto"
date: 2026-09-01
version: "1.0"
status: approved
language: es
audience: engineering
tags: [adr, ai, human-in-the-loop, gobernanza, degradacion]
summary: "Toda capacidad AI opera con contexto delimitado sobre el grafo, produce propuestas estructuradas con citas, y pasa por revisión humana; ningún agente aprueba gates ni publica decisiones. Si la AI no está disponible, todo flujo se completa manualmente."
---

# ADR-0012 — AI propone, humano aprueba, degradación segura

| Campo | Valor |
|---|---|
| Estado | **Aceptada** (v0.2; formaliza el invariante I4) |
| Fecha | 2026-09-01 |
| Decisores | Fundador / producto Whitespace |
| Fuente | Prediseño v0.2 §6 (I4), §7, §13.2, §14 |

## Contexto

El producto es AI-native: hay capacidades AI en cada etapa (§7). Sin una regla arquitectónica clara, la AI acabaría escribiendo estado directamente (insights, decisiones, aprobaciones), lo que rompe tres cosas a la vez: la auditoría (¿quién decidió?), la confianza del cliente (accountability humana en gates) y la resiliencia (un proceso que requiere AI disponible para operar es frágil). La gobernanza de la AI es, además, la parte de la capa AI que sí es core (ADR-0001, clasificación de subdominios).

## Decisión

1. **Patrón único de escritura AI**: toda capacidad produce objetos `PropuestaAI` (contenido estructurado + citas + confianza + lineage + destino en el grafo). El estado del dominio solo cambia cuando un humano acepta, corrige o cura la propuesta. La AI nunca aprueba gates ni publica decisiones.
2. **Contexto delimitado**: los agentes operan con `AlcanceDeContexto` — nodos y relaciones explícitos del grafo del workspace, con los permisos del rol aplicables. Sin acceso cross-workspace (I6).
3. **Flexibilidad de proceso**: las capacidades funcionan aunque las etapas no vayan en orden estricto (ADR-0005).
4. **Degradación segura**: si la AI no está disponible (proveedor caído, presupuesto excedido), **todo flujo puede completarse manualmente**; la plataforma nunca bloquea un gate o una carga de datos por ausencia de AI.
5. **Gobierno operativo**: presupuestos y límites AI por workspace; auditoría de toda acción AI; la propuesta original se conserva aunque se corrija (insumo de la tasa de corrección humana, §9/§17).

## Alternativas consideradas

| Alternativa | Por qué se descarta |
|---|---|
| AI con escritura directa + undo | La auditoría pierde el "quién"; el error AI se propaga antes del undo; contamina la cadena de evidencia |
| Auto-aprobación de gates "de bajo riesgo" | La accountability del gate es el producto (§1.1); un gate auto-aprobado no es co-creación con el cliente |
| Bloquear flujos cuando la AI falla (AI-required) | Fragilidad operativa inaceptable en engagements con fechas; I4 exige lo contrario |

## Consecuencias

- **Positivas**: un único patrón que revisar en seguridad (§14); métricas de corrección humana gratis; el cliente ve siempre quién decidió; la plataforma funciona en modo manual completo.
- **Negativas**: fricción de revisión humana en tareas de bajo riesgo (mitigación: aceptación en lote con revisión muestral es evolución posible post-MVP, nunca para gates); coste de mantener paridad manual de cada flujo AI.
- **Enforcement**: el rol `agente-AI` carece del permiso "aprobar gate" y "publicar decisión" a nivel de modelo de permisos, no solo de UI.

## Referencias

- Prediseño v0.2: §6 (I4), §7 (encabezado), §13.2 (rol agentes AI), §14.
- `docs/01-ddd/domain-model.md` (CTX-08); `docs/05-specs/SPEC-08-capacidades-ai.md`.
