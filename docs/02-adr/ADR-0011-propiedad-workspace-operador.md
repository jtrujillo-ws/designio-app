---
title: "ADR-0011 — Propiedad del workspace: cliente dueño, boutique operador autorizado, Whitespace proveedor tecnológico"
type: decision-record
author: "Whitespace — producto"
date: 2026-09-01
version: "1.0"
status: approved
language: es
audience: mixed
tags: [adr, propiedad, datos, roles, ciclo-comercial]
summary: "La organización cliente es dueña del workspace y de sus datos (incluidos derivados); la boutique opera durante el engagement y la ventana de medición; Whitespace provee la plataforma. La continuidad post-engagement es suscripción (hipótesis) o exportación digna."
---

# ADR-0011 — Propiedad del workspace y roles económicos

| Campo | Valor |
|---|---|
| Estado | **Aceptada** (v0.2) |
| Fecha | 2026-09-01 |
| Decisores | Fundador / producto Whitespace (revisión adversarial sep-2026) |
| Fuente | Prediseño v0.2 §13, §6 (I6), §21, changelog punto 1 |

## Contexto

En v0.1 la propiedad era ambigua, con la boutique implícitamente "dueña del conocimiento". Eso es insostenible: el material contiene datos de usuarios y operaciones del cliente; el comprador es la organización (ADR-0002); y la sección de honestidad (§21) prohíbe afirmar que la boutique es dueña del workspace. Había que fijar quién es dueño, quién opera y quién provee — y qué pasa al terminar el engagement.

## Decisión

1. Roles económicos fijos:

| Rol | Quién | Implicación |
|---|---|---|
| Propietario | Organización cliente | Dueña del workspace y de sus datos, **incluidos los objetos derivados** |
| Operador autorizado | Boutique | Opera el workspace durante el engagement y el periodo de medición |
| Proveedor tecnológico | Whitespace | Plataforma, seguridad y continuidad técnica |

2. El acceso a la plataforma está **incluido en el fee del engagement** durante el proyecto y la ventana de medición.
3. Tras el post mortem, el cliente decide: **suscripción** de continuidad (hipótesis comercial por validar) o **exportación, entrega, retención temporal y borrado/archivo** según lo acordado — la "exportación digna" es requisito de producto, no cortesía.
4. El portal es del workspace del cliente: aprobaciones y comentarios ocurren dentro y quedan auditados (§13.2).
5. La edición del producto para múltiples boutiques externas queda **fuera del MVP**.

## Alternativas consideradas

| Alternativa | Por qué se descarta |
|---|---|
| Boutique dueña del workspace/conocimiento | Prohibido por §21; mata la venta a organizaciones serias; contamina derechos de uso de evidencia |
| Propiedad de Whitespace con licencias | Igual problema agravado; incompatible con aislamiento y exportación |
| Propiedad compartida caso a caso | Ambigüedad contractual permanente; imposible de implementar como permisos |

## Consecuencias

- **Positivas**: la promesa de propiedad habilita ingesta de material sensible (evidencia con derechos claros); la exportación digna reduce el trauma de no renovar (riesgo §18) y sostiene la confianza de largo plazo.
- **Negativas**: la boutique renuncia a reutilizar material de clientes (coherente con ADR-0008); hay que construir exportación completa (incluidos derivados) en el MVP (§14 — ciclo de vida del dato).
- **Métricas asociadas**: % de clientes que contratan suscripción tras post mortem; % que ejecutan exportación (§17 — continuidad).

## Referencias

- Prediseño v0.2: §0.2, §13.1, §13.2, §14, §15, §17, §21.
- ADR-0002, ADR-0008; `docs/05-specs/SPEC-01-workspace-roles-portal.md`.
