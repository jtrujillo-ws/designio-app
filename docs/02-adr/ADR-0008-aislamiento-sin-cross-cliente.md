---
title: "ADR-0008 — Aislamiento estricto entre clientes; sin corpus, benchmarks ni aprendizaje cross-cliente; dos bibliotecas"
type: decision-record
author: "Whitespace — producto"
date: 2026-09-01
version: "1.0"
status: approved
language: es
audience: mixed
tags: [adr, aislamiento, tenancy, bibliotecas, moat, privacidad]
summary: "Nada viaja entre workspaces de clientes: se elimina del MVP y de la tesis de moat todo lo cross-cliente. Existen dos bibliotecas con contenidos estrictamente separados: la del cliente (su memoria) y la general (solo conocimiento metodológico autorizado)."
---

# ADR-0008 — Aislamiento estricto; sin cross-cliente; dos bibliotecas

| Campo | Valor |
|---|---|
| Estado | **Aceptada** (v0.2; retira el corpus cross-cliente de la tesis v0.1) |
| Fecha | 2026-09-01 |
| Decisores | Fundador / producto Whitespace (revisión adversarial sep-2026) |
| Fuente | Prediseño v0.2 §11, §6 (I6), §1.2, changelog punto 3 |

## Contexto

La v0.1 incluía en la tesis de moat un corpus agregado: promoción de objetos de clientes a una biblioteca transversal, benchmarks derivados y aprendizaje cross-cliente con anonimización. La revisión adversarial lo retiró: es incompatible con la propiedad del cliente sobre sus datos (ADR-0011), introduce riesgo legal y de confianza desproporcionado (consentimientos, anonimización real de material cualitativo es frágil), y el valor demostrable a corto plazo está en otra parte: la memoria privada por cliente y el método.

## Decisión

1. **Aislamiento verificable entre workspaces**: ningún dato, objeto, embedding, prompt-context ni aprendizaje cruza de un workspace de cliente a otro. `workspaceId` es parte de la identidad de todo objeto.
2. **Dos bibliotecas con contenidos estrictamente separados**:

| Biblioteca | Contenido | Regla |
|---|---|---|
| Del cliente | Memoria del workspace: servicios, proyectos, investigaciones, decisiones, design versions, releases, resultados, aprendizajes | Aislada de los demás clientes; propiedad del cliente; es una proyección del workspace, no un almacén aparte |
| General de service design | Métodos y guías de la boutique, plantillas propias, taxonomías generales, contenido público o licenciado | Sin contenido derivado de proyectos de clientes; solo referencias salientes hacia los workspaces |

3. El único aprendizaje agregado permitido es la **mejora explícita del método propio de la boutique**, versionada en la biblioteca general **sin datos de clientes**.
4. La semilla de un reto nuevo es **intra-cliente**: la historia del propio workspace (§3.4), nunca datos de terceros.

## Alternativas consideradas

| Alternativa | Por qué se descarta |
|---|---|
| Corpus cross-cliente anonimizado (v0.1) | Anonimización frágil en cualitativo; rompe la promesa de propiedad; riesgo legal/reputacional; moat especulativo |
| Benchmarks agregados opt-in | Pospuesto: exigiría gobernanza de consentimiento y masa crítica que el MVP no tiene; reevaluable post-t2 con consentimiento explícito |
| Fine-tuning/embeddings compartidos entre clientes | Vía técnica del mismo problema; vetado por I6 |

## Consecuencias

- **Positivas**: promesa de propiedad y confidencialidad limpia y verificable (§14); simplifica seguridad del MVP; elimina una clase entera de fugas AI.
- **Negativas**: se renuncia (por ahora) a efectos de red de datos como moat; la defensibilidad descansa en método, trazabilidad, memoria por cliente, marca y servicio (§1.2 — honestidad sobre el moat).
- **Enforcement**: "intentos de mezcla cross-cliente bloqueados" es métrica de doctrina (§17); un deal que exige mezclar datos no es cliente de esta plataforma (I6).

## Referencias

- Prediseño v0.2: §1.2, §6 (I6), §11, §14, §17, §21.
- `docs/03-invariantes/invariantes.md` (I6 y derivadas SYS); ADR-0011.
