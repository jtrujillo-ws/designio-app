---
title: "ADR-0004 — Cuatro objetos de resultado: design version, release, effective state y outcome review"
type: decision-record
author: "Whitespace — producto"
date: 2026-09-01
version: "1.0"
status: approved
language: es
audience: engineering
tags: [adr, trazabilidad, versionamiento, ciclo-de-vida]
summary: "El versionamiento monolítico de proyecto se reemplaza por cuatro objetos encadenados que separan lo aprobado, lo desplegado, lo constatado y lo evaluado, con inmutabilidad tras aprobación."
---

# ADR-0004 — Cuatro objetos de resultado

| Campo | Valor |
|---|---|
| Estado | **Aceptada** (v0.2) |
| Fecha | 2026-09-01 |
| Decisores | Fundador / producto Whitespace (revisión adversarial sep-2026) |
| Fuente | Prediseño v0.2 §3 |

## Contexto

En v0.1 existía un "versionamiento" genérico del proyecto. La revisión adversarial mostró que un solo objeto mezcla cuatro hechos distintos que en la realidad divergen: lo que se **aprobó** diseñar, lo que efectivamente se **desplegó** (a menudo parcial y en varios momentos), lo que **quedó funcionando** (con desviaciones respecto de lo aprobado) y el **resultado observado** al cierre de la ventana. Sin esa separación, el diff de primera clase (§3.2) no puede responder "qué quedó diferente a lo diseñado y por qué", y la promesa de accountability se rompe.

## Decisión

Modelar el resultado con **cuatro objetos diferenciados y encadenados**:

| Objeto | Hecho que captura | Regla clave |
|---|---|---|
| **Design version** | Lo que se decidió construir o cambiar (aprobada en G5/G6) | Inmutable al aprobarse; cambios ⇒ nueva versión (borrador → aprobada → superada) |
| **Release** | Subconjunto de la design version efectivamente implementado y desplegado | Parcialidad explícita; múltiples releases por design version (planificado → desplegado → verificado) |
| **Effective state** | Lo que realmente quedó funcionando, con desviaciones y su razón | Verdad operativa del servicio; historia append-only |
| **Outcome review** | Evaluación de resultados en la ventana definida (post mortem) | Cierra el reto con veredicto: logrado / parcialmente logrado / no logrado / no concluyente |

El proyecto no desaparece con el cierre: **cambia de estado y queda inmutable** para consulta y auditoría (activo → en implementación → en medición → cerrado).

## Alternativas consideradas

| Alternativa | Por qué se descarta |
|---|---|
| Versionamiento único del proyecto (v0.1) | Mezcla aprobación, despliegue, constatación y evaluación; imposibilita el diff de primera clase |
| Solo design version + release (sin effective state) | Las desviaciones reales quedarían sin registro; "lo aprobado" pasaría por "lo vigente" — deshonesto con el cliente |
| Ligar el resultado al proyecto en lugar del reto | El reto es la promesa medible (§3.4); un reto puede tener varios proyectos y la medición pertenece a la promesa |

## Consecuencias

- **Positivas**: cada pregunta del diff tiene un objeto dueño; el switching cost real ("por qué el servicio es como es") vive en datos estructurados; la parcialidad de implementación deja de ser invisible.
- **Negativas**: más objetos y estados que explicar a la boutique y al cliente (mitigación: el árbol y el portal los presentan en contexto, §2.1); coste de conciliación DV ↔ releases ↔ effective state (asistida por AI, §7 etapa 7).
- **Invariantes derivadas**: inmutabilidad tras aprobación; desviación siempre con razón; release siempre referencia una DV aprobada.

## Referencias

- Prediseño v0.2: §3.1–§3.4, §5 (G5–G7), §19 (ejemplo DV-1/RL-1/ES-1).
- `docs/01-ddd/domain-model.md` — máquinas de estado; `docs/05-specs/SPEC-06-trazabilidad-resultado.md`.
