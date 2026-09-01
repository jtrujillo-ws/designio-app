---
title: "Invariantes de producto y de sistema"
type: architecture
author: "Whitespace — producto"
date: 2026-09-01
version: "0.1"
status: draft
language: es
audience: engineering
tags: [invariantes, gobernanza, enforcement, doctrina, anti-dilucion]
summary: "Formalización de los seis invariantes de producto del prediseño v0.2 (I1–I6) y su derivación en invariantes de sistema verificables (SYS-*), con punto de enforcement, señal de violación y verificación propuesta para cada uno."
---

## Tabla de contenido

- [Resumen ejecutivo](#resumen-ejecutivo)
- [Cómo leer este documento](#cómo-leer-este-documento)
  - [Niveles de invariante](#niveles-de-invariante)
  - [Puntos de enforcement](#puntos-de-enforcement)
- [Invariantes de producto I1–I6](#invariantes-de-producto-i1i6)
- [Invariantes de sistema derivadas](#invariantes-de-sistema-derivadas)
  - [Tenancy y aislamiento](#tenancy-y-aislamiento)
  - [Trazabilidad e inmutabilidad](#trazabilidad-e-inmutabilidad)
  - [Método y gates](#método-y-gates)
  - [Evidencia y grounding](#evidencia-y-grounding)
  - [Gobernanza AI](#gobernanza-ai)
  - [Medición](#medición)
- [Uso de las invariantes como criterio de revisión](#uso-de-las-invariantes-como-criterio-de-revisión)
- [Verificación y pruebas](#verificación-y-pruebas)
- [Próximos pasos](#próximos-pasos)

## Resumen ejecutivo

Las invariantes son las reglas que no se negocian: definen qué es este producto y qué lo destruiría (auto-dilución, §18 del prediseño). Este documento fija dos niveles. El nivel de **producto** (I1–I6, tomados literalmente de §6 del prediseño) expresa doctrina: se usa para revisar features y deals. El nivel de **sistema** (SYS-01 a SYS-24) traduce esa doctrina a reglas verificables en el software: cada una declara dónde se aplica (modelo de datos, transición de estado, permisos, validación o proceso), qué señal indica violación y cómo se verifica. La regla general de derivación: si una invariante de producto no tiene al menos una invariante de sistema que la haga cumplir, es un deseo, no una invariante.

## Cómo leer este documento

### Niveles de invariante

| Nivel | Prefijo | Audiencia | Cambia con |
|---|---|---|---|
| Producto (doctrina) | I1–I6 | Producto, boutique, comercial | Nueva versión del prediseño (decisión de fundador) |
| Sistema (verificable) | SYS-* | Ingeniería | ADR que modifique el mecanismo, sin relajar el nivel de producto |

### Puntos de enforcement

| Código | Punto | Significado |
|---|---|---|
| MOD | Modelo de datos | La estructura hace imposible el estado inválido (mejor opción) |
| TRX | Transición de estado | La máquina de estados rechaza la transición |
| PERM | Permisos | El rol carece de la capacidad |
| VAL | Validación | Regla evaluada al guardar/aprobar (bloqueante o advertencia según se indique) |
| PROC | Proceso/operación | Se cumple por procedimiento + auditoría (última opción; requiere métrica) |

## Invariantes de producto I1–I6

Enunciados canónicos según §6 del prediseño, con su consecuencia y las invariantes de sistema que los materializan:

| # | Invariante (canónica) | Consecuencia | SYS derivadas |
|---|---|---|---|
| I1 | **Canónico el vocabulario y los resultados; flexible la ejecución.** Las etapas 0–7 no se renombran ni cambian sus resultados; la ejecución itera, paraleliza y gradúa por perfil, con reaperturas trazadas | La comparabilidad vive en objetos y resultados, no en el orden secuencial; modelos externos son crosswalk de presentación | SYS-09, SYS-10, SYS-11 |
| I2 | **La validación es gate, no etapa** | Prototipado y test viven en las etapas 4 y 5; el enforcement está en la suficiencia exigida al decidir | SYS-12, SYS-13 |
| I3 | **Cadena de evidencia navegable con dimensiones y grounding medido** | Todo objeto generado registra proveniencia, método, calidad, derechos y lineage; la cita no equivale a grounding: se mide | SYS-14, SYS-15, SYS-16, SYS-17 |
| I4 | **La AI propone y cita; el humano aprueba; el sistema degrada seguro** | Ningún agente aprueba gates ni publica decisiones; sin AI disponible, todo flujo se completa manualmente | SYS-18, SYS-19, SYS-20, SYS-21 |
| I5 | **La medición es temporal y acotada** | Ventana por reto y por KPI desde la etapa 0; snapshots manuales o CSV; post mortem obligatorio; sin causalidad automática | SYS-22, SYS-23, SYS-24 |
| I6 | **Aislamiento entre clientes y anti-dilución** | Nada viaja entre workspaces; toda feature respeta árbol simple, grafo n:m y vocabulario canónico; un deal que exige romperlo no es cliente de esta plataforma | SYS-01, SYS-02, SYS-03, SYS-04 |

## Invariantes de sistema derivadas

### Tenancy y aislamiento

| ID | Regla | Enforcement | Señal de violación | Verificación |
|---|---|---|---|---|
| SYS-01 | Todo objeto del dominio pertenece a exactamente un workspace; `workspaceId` es parte de su identidad | MOD | Objeto sin workspace o consulta sin filtro de workspace | RLS activo (rol no privilegiado; una query sin contexto devuelve cero filas) + test estructural de identidad |
| SYS-02 | Ninguna consulta, proyección, embedding, contexto AI ni exportación combina datos de más de un workspace de cliente | MOD + PERM | Resultado con IDs de dos workspaces | Test de aislamiento por tenant en CI; intento de mezcla bloqueado se registra (métrica de doctrina §17) |
| SYS-03 | La biblioteca general no contiene referencias entrantes desde workspaces de clientes ni contenido derivado de ellos | MOD + PROC | Objeto de biblioteca general con lineage hacia un workspace | Validación de origen al publicar contenido metodológico |
| SYS-04 | La exportación de un workspace incluye todos sus objetos, derivados y auditoría; el borrado posterior es completo según lo acordado | PROC + VAL | Export incompleto; residuos tras borrado | Checklist de export contra el catálogo de objetos; prueba de borrado |

### Trazabilidad e inmutabilidad

| ID | Regla | Enforcement | Señal de violación | Verificación |
|---|---|---|---|---|
| SYS-05 | Una design version aprobada es inmutable; todo cambio crea una nueva versión y marca la anterior como superada | TRX | Mutación sobre DV en estado aprobada | Test de máquina de estados |
| SYS-06 | Un release referencia exactamente una design version aprobada y declara explícitamente qué elementos incluye | MOD + VAL | Release sin DV aprobada o sin lista de elementos | Validación al crear/desplegar |
| SYS-07 | Toda desviación del effective state registra el elemento afectado y una razón no vacía | VAL | Desviación sin razón | Validación al constatar |
| SYS-08 | Proyectos y retos cerrados son inmutables (consulta y auditoría); el trabajo posterior es un reto nuevo | TRX | Escritura sobre objeto cerrado | Test de máquina de estados |

### Método y gates

| ID | Regla | Enforcement | Señal de violación | Verificación |
|---|---|---|---|---|
| SYS-09 | Los identificadores de etapas (0–7), gates (G0–G7) y resultados canónicos no son configurables por workspace, deal ni proyecto | MOD | Cualquier tabla/config de renombrado | Revisión de features nuevas (no existe la superficie); excepciones concedidas = métrica de doctrina §17 |
| SYS-10 | Reabrir una etapa registra qué cambió y marca para revisión las decisiones aguas abajo afectadas; nunca borra historia | TRX + VAL | Reapertura sin registro o con historia reescrita | Test: reapertura genera evento `EtapaReabierta` + marcas |
| SYS-11 | Una no-aplicabilidad requiere justificación y aprobación humana, y queda auditada | VAL + PERM | Criterio omitido sin N/A aprobada | El checklist del gate distingue "cumplido" de "N/A aprobada"; sin tercera opción |
| SYS-12 | Un gate solo pasa cuando su checklist de suficiencia (según perfil) está cumplido o cubierto por N/A aprobadas, y lo aprueba un humano con el rol requerido en el portal | TRX + PERM | Gate aprobado con checklist incompleto o por rol incorrecto | Test por gate; auditoría de aprobaciones |
| SYS-13 | G4 exige evidencia de test que alcance el umbral definido para cada concepto que avanza (o N/A aprobada); los conceptos descartados registran razón | VAL | Concepto avanzado sin evidencia de test ni N/A | Validación del checklist G4 |

### Evidencia y grounding

| ID | Regla | Enforcement | Señal de violación | Verificación |
|---|---|---|---|---|
| SYS-14 | Toda evidencia registra las cinco dimensiones (proveniencia, método, calidad, derechos, lineage); los derechos restringen su uso aguas abajo | MOD + VAL | Evidencia sin dimensiones; cita de evidencia sin derechos para el contexto | Validación al registrar y al citar |
| SYS-15 | Un insight validado referencia ≥1 cita con localización exacta; un arquetipo sin evidencia enlazada no pasa G2; una oportunidad referencia ≥1 insight (G3) | VAL | Objeto validado sin sus referencias mínimas | Validaciones bloqueantes en G2/G3 |
| SYS-16 | Nada entra al grafo desde la bandeja de importación sin curaduría humana aprobada | TRX | Objeto del grafo con origen "importación" sin aprobación | Test del flujo de importación |
| SYS-17 | El grounding se mide de forma continua: fidelidad de citas, afirmaciones no soportadas, corrección humana, contradicciones; la propuesta AI original se conserva aunque se corrija | PROC + MOD | Métricas sin datos; propuesta original perdida | Evals periódicas (§14); test de conservación |

### Gobernanza AI

| ID | Regla | Enforcement | Señal de violación | Verificación |
|---|---|---|---|---|
| SYS-18 | El rol agente-AI carece de las capacidades "aprobar gate" y "publicar decisión" a nivel de permisos | PERM | Aprobación con actor AI | Test de permisos; auditoría |
| SYS-19 | Toda escritura originada por AI pasa por `PropuestaAI` y aceptación humana; toda salida AI registra lineage (modelo, prompt/config, versión) | MOD | Objeto con autor AI sin propuesta/lineage | Test estructural del pipeline AI |
| SYS-20 | Las salidas de revisores AI quedan etiquetadas como simulación, no son evidencia y no computan en los checklists de G4/G5; no existen simulaciones masivas ni porcentajes sintéticos | MOD + VAL | Salida de revisor citada como evidencia o contada en suficiencia | Validación de tipo en checklists; revisión de UI |
| SYS-21 | Con AI no disponible (fallo o presupuesto excedido), todo flujo se completa manualmente; los límites AI por workspace se aplican | PROC + VAL | Flujo bloqueado por ausencia de AI | Prueba de degradación (feature flag "AI off") en CI |

### Medición

| ID | Regla | Enforcement | Señal de violación | Verificación |
|---|---|---|---|---|
| SYS-22 | Cada criterio de éxito define su ventana de medición en la etapa 0 (G0 no pasa sin ventanas ni línea base o plan para obtenerla); el Metric Registry con dueño del dato y frecuencia se firma en G6 | VAL | Criterio sin ventana; registry sin dueño | Checklists G0/G6 |
| SYS-23 | Los snapshots entran solo por formulario, CSV o enlace a dashboard externo, y son append-only con fecha y origen | MOD | Cualquier integración de ingesta continua; snapshot editado | Revisión de superficie de API; test append-only |
| SYS-24 | El outcome review no registra afirmaciones causales salvo diseño experimental suficiente: su estructura distingue contribución/asociación y factores externos; el veredicto es uno de los cuatro valores canónicos | MOD + VAL | Texto causal sin diseño experimental marcado; veredicto fuera de catálogo | Estructura del objeto + revisión del post mortem |

## Uso de las invariantes como criterio de revisión

Tres puertas donde estas invariantes se aplican como checklist explícito (§18: la auto-dilución es riesgo nombrado):

| Puerta | Pregunta | Regla de decisión |
|---|---|---|
| Revisión de feature | ¿La feature respeta árbol simple, grafo n:m, vocabulario canónico y el patrón PropuestaAI? | Si exige romper una SYS: se rediseña o se rechaza; nunca se concede excepción silenciosa |
| Revisión de deal | ¿El deal exige renombrar etapas, mezclar datos de clientes o aflojar evidencia? | "No es un cliente de esta plataforma" (I6); la excepción concedida sin revisión es señal de alarma (§17) |
| Definition of Done | ¿El release del producto mantiene las verificaciones SYS en verde? | Los tests de invariantes son bloqueantes en CI (donde existan) |

## Verificación y pruebas

Estrategia mínima para el MVP, en orden de preferencia (coherente con la columna Enforcement):

1. **Imposibilidad estructural (MOD)**: preferida siempre — p. ej. `workspaceId` en la identidad, tipos cerrados de veredicto, checklist que distingue N/A.
2. **Tests de máquina de estados (TRX)**: DV/release/proyecto/reto; reapertura; curaduría.
3. **Tests de permisos (PERM)**: matriz rol × capacidad, incluido el rol agente-AI.
4. **Validaciones bloqueantes (VAL)**: en gates y registros; las advertencias no bloqueantes se reservan para calidad, nunca para invariantes.
5. **Evals y auditoría (PROC)**: grounding, export/borrado, degradación AI — con métrica de salud asociada (§17) porque el proceso sin métrica se degrada.

## Próximos pasos

1. Mapear cada SYS-* a su spec (`docs/05-specs/`) y marcar las que el MVP implementa como test automatizado vs. procedimiento — dueño: ingeniería.
2. Definir los checklists de suficiencia por gate y perfil (contenido metodológico, CTX-07) — dueño: boutique.
3. Incorporar la batería "AI off" (SYS-21) y los tests de aislamiento (SYS-02) al CI desde el primer scaffolding — dueño: ingeniería.
4. Revisar este catálogo tras el primer piloto: toda excepción solicitada en la práctica se documenta y se decide (ADR) en lugar de concederse ad hoc — dueño: producto.
