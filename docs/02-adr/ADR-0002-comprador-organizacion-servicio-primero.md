---
title: "ADR-0002 — Comprador organización y modelo 'servicio con aplicación' primero"
type: decision-record
author: "Whitespace — producto"
date: 2026-09-01
version: "1.0"
status: approved
language: es
audience: mixed
tags: [adr, modelo-de-negocio, go-to-market, comprador]
summary: "El comprador es la organización cliente, no el diseñador individual, y el go-to-market es servicio con aplicación (engagements de la boutique con plataforma incluida), no SaaS self-serve."
---

# ADR-0002 — Comprador organización y modelo "servicio con aplicación" primero

| Campo | Valor |
|---|---|
| Estado | **Aceptada** (v0.1; ratificada en v0.2) |
| Fecha | 2026-09-01 |
| Decisores | Fundador / producto Whitespace |
| Fuente | Prediseño v0.2 §0.2, §15, §20 |

## Contexto

Un producto de service design puede venderse al diseñador individual (herramienta de productividad), al equipo de diseño (colaboración) o a la organización (sistema de registro del servicio). El análisis de cuadrantes (§15) descarta el SaaS standalone para diseñadores: TAM chico, usuario power capaz de resolver con Claude, e incumbentes regalando IA en el canvas. Además, la propuesta central — trazabilidad de decisiones hasta resultados y accountability — solo tiene valor para quien es dueño del servicio y de sus KPIs: la organización.

## Decisión

1. El **comprador es la organización cliente**; el workspace y sus datos son de su propiedad (ver ADR-0011).
2. El go-to-market es **servicio con aplicación primero**: la boutique vende engagements (etapas 0–7 + ventana de medición + post mortem) con la plataforma incluida en el fee; la plataforma no se vende self-serve en esta fase.
3. Los momentos de ingreso son: fee de entrada (importación/consolidación), fee de engagement (núcleo), suscripción de continuidad (**hipótesis por validar**, ADR-0014/§15) y fees de expansión (pipeline embebido de retos candidatos).
4. La graduación futura a "aplicación con servicio" se decidirá **solo con datos**: hipótesis de suscripción validada, adopción del portal, track record e inbound.

## Alternativas consideradas

| Alternativa | Por qué se descarta |
|---|---|
| SaaS self-serve para diseñadores | Peor cuadrante (§15); sin engagements que alimenten el sistema desde el día 1 |
| Venta enterprise directa de software (sin servicio) | Sin la boutique no hay método instalado ni doctrina; el moat se realiza vía el cliente (§1.2) |
| Marketplace multi-boutique desde el inicio | Complejidad de edición multi-tenant prematura; explícitamente fuera del MVP (§13.1, ADR-0014) |

## Consecuencias

- **Positivas**: cada engagement real alimenta memoria y método; el pipeline de retos candidatos genera expansión natural; pricing anclado a valor de servicio, no a seats.
- **Negativas**: dependencia del canal boutique (riesgo §18); crecimiento acotado por capacidad de delivery mientras no se valide la suscripción.
- **Métricas de validación**: % de clientes que contratan suscripción tras el post mortem; adopción del portal (§17).

## Referencias

- Prediseño v0.2: §0.2, §1.2 (escalera t0–t3), §13, §15, §17, §18.
- ADR-0011 (propiedad del workspace), ADR-0014 (alcance MVP).
