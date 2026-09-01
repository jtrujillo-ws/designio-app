---
title: "Plataforma de service design — Prediseño de producto v0.2"
type: product-spec
author: "Whitespace — producto"
date: 2026-09-01
version: "0.2"
status: draft (revisado)
language: es
audience: mixed
tags: [service-design, prediseno, ontologia, grafo, trazabilidad, moat, ai-native, boutique, mvp]
summary: "Prediseño revisado de la plataforma AI-native de service design para el contexto de una boutique: tesis y moat, árbol de navegación sobre grafo de dominio, trazabilidad evidencia → decisión → design version → release → effective state → outcome review, etapas 0-7 canónicas y flexibles con gates de suficiencia, capacidades AI por etapa con alcance de MVP, Metric Registry y medición temporal de impacto, modelo de evidencia por dimensiones, journeys como grafos tipados con Mermaid, bibliotecas aisladas, seguridad y confiabilidad AI como requisitos, modelo de negocio y alcance del MVP."
---

## Changelog v0.2 (respecto de v0.1)

Esta versión integra la revisión adversarial consolidada (sep-2026). Cambios estructurales:

1. **Propiedad**: la organización cliente es dueña del workspace y de sus datos; la boutique actúa como operador autorizado; Whitespace es el proveedor tecnológico.
2. **Se elimina la operación continua**: el producto no es plataforma de telemetría ni de operación. La reemplaza una **medición temporal de impacto** con Metric Registry (carga manual o CSV), ventana definida por reto y por KPI desde la etapa 0 (hasta seis meses como referencia inicial) y **post mortem** con veredicto.
3. **Se elimina del MVP y de la tesis de moat todo lo cross-cliente**: promoción de objetos, benchmarks derivados de clientes, anonimización y aprendizaje automático entre clientes. La biblioteca general contiene solo conocimiento metodológico autorizado.
4. **Árbol de navegación y grafo de dominio separados**: el árbol (Cliente → Servicios → Retos → Proyectos) es una proyección simple; el modelo de datos es un grafo con relaciones n:m. El "servicio ancla" pasa a ser ayuda de navegación, no restricción estructural.
5. **Versionamiento reemplazado por cuatro objetos**: design version → release (parcial, múltiple) → effective state → outcome review. El proyecto no desaparece: cambia de estado y queda inmutable para auditoría.
6. **Etapas 0-7 canónicas pero flexibles**: iteración y reapertura trazables, paralelismo, perfiles rápido/estándar/profundo, no-aplicabilidad justificada; gates basados en suficiencia de evidencia, riesgos y decisiones.
7. **Journey como grafo tipado** con Mermaid como renderer principal generado desde objetos estructurados; sin canvas libre propio; Miro/Figma como evidencia importable básica.
8. Los antes llamados "usuarios sintéticos" pasan a ser **revisores AI basados en arquetipos**, con límites metodológicos estrictos: no producen evidencia ni cuentan para gates.
9. **Modelo de evidencia por dimensiones** (proveniencia, método, calidad, derechos, lineage) en lugar de tres grados; se añaden métricas de grounding.
10. **Nueva sección de seguridad, privacidad y confiabilidad AI** como requisitos del Definition of Done del MVP.
11. **Alcance del MVP definido**: loop completo, delgado y confiable para un cliente, un servicio y un reto, con una capacidad AI mínima y útil por etapa.
12. La suscripción posterior al post mortem queda como **hipótesis comercial por validar**, no como recurrencia demostrada.

## Tabla de contenido

- [0. TL;DR](#0-tldr)
- [1. Tesis y moat](#1-tesis-y-moat)
- [2. Árbol de navegación y grafo de dominio](#2-árbol-de-navegación-y-grafo-de-dominio)
- [3. Trazabilidad y ciclo de vida](#3-trazabilidad-y-ciclo-de-vida)
- [4. Segmentos, arquetipos y revisores AI](#4-segmentos-arquetipos-y-revisores-ai)
- [5. Las etapas 0-7: canónicas, flexibles y asistidas](#5-las-etapas-0-7-canónicas-flexibles-y-asistidas)
- [6. Invariantes de producto](#6-invariantes-de-producto)
- [7. Capacidades AI por etapa](#7-capacidades-ai-por-etapa)
- [8. Metric Registry y medición de impacto](#8-metric-registry-y-medición-de-impacto)
- [9. Modelo de evidencia](#9-modelo-de-evidencia)
- [10. Journeys como grafos tipados](#10-journeys-como-grafos-tipados)
- [11. Bibliotecas](#11-bibliotecas)
- [12. Importación y artefactos externos](#12-importación-y-artefactos-externos)
- [13. Propiedad, workspace, portal y roles](#13-propiedad-workspace-portal-y-roles)
- [14. Seguridad, privacidad y confiabilidad AI](#14-seguridad-privacidad-y-confiabilidad-ai)
- [15. Posicionamiento y modelo de negocio](#15-posicionamiento-y-modelo-de-negocio)
- [16. Alcance del MVP](#16-alcance-del-mvp)
- [17. Métricas de salud del producto](#17-métricas-de-salud-del-producto)
- [18. Riesgos y mitigaciones](#18-riesgos-y-mitigaciones)
- [19. Ejemplo trabajado](#19-ejemplo-trabajado)
- [20. Decisiones tomadas y abiertas](#20-decisiones-tomadas-y-abiertas)
- [21. Honestidad: qué NO decir](#21-honestidad-qué-no-decir)
- [Referencias](#referencias)

## 0. TL;DR

1. **El miedo "esto se hace solo con Claude" es válido en una sola capa: la generación de artefactos.** Esa capa está comoditizada y no se cobra; se construye sobre ella. El producto vende lo que un chat no da: estado, estructura, gobernanza, trazabilidad hasta resultados y memoria privada por cliente.
2. **El comprador es la organización, no el diseñador individual.** La organización cliente es **dueña del workspace y de sus datos**; la boutique es el **operador autorizado** durante el engagement y la ventana de medición; Whitespace es el proveedor tecnológico.
3. **La primitiva del producto es el Servicio con trazabilidad hasta resultados**: evidencia → insight → decisión aprobada → design version → release → effective state → resultados → outcome review. Ninguna herramienta de la categoría mantiene esa cadena completa.
4. **Árbol simple sobre grafo rico.** El cliente navega Cliente → Servicios → Retos → Proyectos; debajo, el dominio es un grafo con relaciones n:m. Insight de origen (fundador): *"la jerarquía permite al cliente navegar por todos sus proyectos, cosa que no puede hacer fácilmente un agente o un chat de IA".* El árbol sirve a los humanos; el grafo, a la trazabilidad y a los agentes.
5. **Método ejecutable y flexible**: etapas 0-7 canónicas en vocabulario y resultados, iterables y paralelizables en ejecución, con gates de suficiencia (evidencia, riesgos y decisiones) aprobados por humanos en el portal.
6. **La medición de impacto es temporal y acotada**: Metric Registry con carga manual o CSV, ventana por reto y por KPI definida en la etapa 0 (hasta seis meses como referencia inicial) y post mortem con veredicto. El producto no es una plataforma de operación ni de telemetría continua.
7. **Invariante central**: cadena de evidencia navegable con dimensiones explícitas (proveniencia, método, calidad, derechos, lineage) y métricas de grounding. La cita se verifica, no se presume.
8. **MVP**: loop completo, delgado y confiable para un cliente, un servicio y un reto, con una capacidad AI mínima y útil por etapa. La suscripción posterior al post mortem es una hipótesis comercial por validar.

## 1. Tesis y moat

### 1.1 El reencuadre del miedo

La pregunta correcta no es "¿puede Claude generar un blueprint?" (sí), sino "¿dónde vive un engagement de meses con múltiples stakeholders, gates de aprobación, releases parciales y una medición de resultados que alguien tiene que poder auditar?". Un chat no es sistema de registro: no gobierna estado ni proceso, no es multiplayer con el cliente, no produce datos estructurados comparables y no sostiene la trazabilidad de una decisión hasta su resultado.

Regla práctica de backlog: **si una capacidad se replica con un prompt de 200 palabras en Claude, no es feature, es costo.** Se construye solo lo que exige estado, estructura, permisos, medición o memoria gobernada.

### 1.2 Capas de moat

| Capa | Qué es | Por qué Claude solo no la da | Cómo se acumula |
|---|---|---|---|
| Método como código | Etapas 0-7 con gates de suficiencia, criterios de aceptación y aprobaciones auditadas | Claude hace lo que le pidas; no garantiza que se decida con la evidencia suficiente | Doctrina instalada en boutique y cliente |
| Grafo de dominio y sistema de registro | Evidencia, insights, decisiones, journeys, blueprints y métricas como objetos enlazados n:m | Un chat produce prosa, no estado ni grafo | Cada proyecto enriquece el grafo del cliente; "se copia lo que se ve, no la fundación" |
| Trazabilidad decisión → release → resultado | Design version, release, effective state y outcome review encadenados a la evidencia | Claude no registra qué se implementó, qué quedó distinto y qué resultado tuvo | Switching cost real: la memoria de por qué el servicio es como es vive en el workspace |
| Memoria privada por cliente | El workspace acumula servicios, versiones, decisiones y resultados del cliente, aislado de terceros | El conocimiento del modelo es genérico; esta memoria es del cliente y gobernada | Cada reto arranca sobre la historia del propio cliente (semilla intra-cliente) |
| Counter-positioning + servicio | Miro/Mural venden canvas libre; TheyDo vende journey management enterprise self-serve; la boutique vende accountability con método ejecutable | Una herramienta genérica vende "hazlo tú" | Marca del método + distribución por engagements |

Honestidad sobre el moat: esta versión retira deliberadamente el corpus cross-cliente de la tesis (§11). La defensibilidad de largo plazo descansa en método, trazabilidad, memoria privada por cliente, marca y servicio; el único aprendizaje agregado permitido es la **mejora explícita del método propio de la boutique**, sin datos de clientes. La escalera de realización se mantiene: t0 uso interno → t1 clientes de la boutique operando → t2 método instalable → t3 memoria por cliente con switching cost demostrado. El moat se realiza vía el cliente, no en el código.

### 1.3 Categoría y whitespace

La categoría existe ("journey management"; TheyDo es la referencia más cercana, ya con agentes de IA). Lectura: valida que el valor está en gestión y conexión con resultados, no en dibujar journeys. Whitespace de esta plataforma: método completo (no solo journeys), trazabilidad decisión → release → resultado, service-led, LatAm/español. No competir en canvas ni en telemetría: integrar evidencia (§12) y medir impacto de forma acotada (§8).

## 2. Árbol de navegación y grafo de dominio

Son dos estructuras distintas y el producto las separa explícitamente.

### 2.1 El árbol de navegación

Simple, predecible y comprensible para el cliente:

**Cliente → Servicios → Retos → Proyectos**

| Nivel | Objeto | Qué ve el usuario ahí |
|---|---|---|
| 1 | **Cliente** (workspace) | Sus servicios, segmentos transversales, biblioteca del cliente, personas y permisos |
| 2 | **Servicio** | Estado vigente (effective state actual, journeys, KPIs), historia de design versions y releases, retos (backlog, activos, cerrados) |
| 3 | **Reto de diseño** | Formulación, criterios de éxito con ventanas, arquetipos del reto, sus proyectos, y el **seguimiento de impacto del reto** (Metric Registry, snapshots, post mortem) |
| 4 | **Proyecto** | Etapas, gates, artefactos, decisiones, releases y estado (activo, en implementación, en medición, cerrado) |

El seguimiento de impacto se muestra **dentro del reto o proyecto correspondiente**; no existe una "plataforma de operación" separada.

### 2.2 El grafo de dominio

El modelo de datos es un grafo con relaciones n:m entre, como mínimo: servicios; retos; proyectos; evidencias y fuentes; afirmaciones e insights; arquetipos y segmentos; oportunidades; conceptos y decisiones; design versions; releases; effective states; métricas y snapshots; y sistemas, canales, touchpoints y actores.

Reglas:

1. **El árbol es una proyección de navegación; no impone las restricciones del modelo de datos.** Un reto puede afectar varios servicios; una decisión, métrica o capacidad puede relacionarse con más de un servicio.
2. El **servicio ancla** se conserva como ayuda de navegación y responsabilidad principal de un reto, no como limitación estructural.
3. Doble función: el árbol sirve a la navegación humana; el grafo sostiene la trazabilidad, la consulta ("qué pasos del journey dependen del sistema X") y el **scoping de los agentes AI**, que operan sobre nodos y relaciones con contexto delimitado y permisos aplicables.
4. Pipeline embebido: el backlog de retos de cada servicio (alimentado por post mortems, hallazgos de medición y peticiones del cliente) es, para la boutique, la lista de siguientes proyectos proponibles.

## 3. Trazabilidad y ciclo de vida

### 3.1 Los cuatro objetos del resultado

| Objeto | Definición | Notas |
|---|---|---|
| **Design version** | Propuesta de diseño aprobada: lo que se decidió construir o cambiar | Aprobada en G5/G6; trazable a evidencia y decisiones |
| **Release** | Subconjunto de la design version efectivamente implementado y desplegado | Puede ser parcial; puede haber varios releases por design version |
| **Effective state** | Constatación de lo que realmente quedó funcionando tras el release, incluidas desviaciones frente a lo aprobado | Es la verdad operativa del servicio; las desviaciones se registran con razón |
| **Outcome review** | Evaluación de los resultados observados durante la ventana definida para el reto (el post mortem) | Cierra el reto con veredicto: logrado, parcialmente logrado, no logrado o no concluyente |

### 3.2 La cadena de trazabilidad

**evidencia → insight → decisión aprobada → design version → release → effective state → resultados → outcome review**

El diff de primera clase debe poder responder: qué se decidió y con qué evidencia; qué parte se implementó; qué quedó diferente a lo diseñado y por qué; qué resultados se observaron; y qué se aprendió y qué reto podría abrirse después.

### 3.3 Estados

| Objeto | Estados | Regla |
|---|---|---|
| Proyecto | activo → en implementación → en medición → cerrado | El proyecto nunca "deja de existir": cerrado queda disponible e inmutable para consulta y auditoría |
| Reto | candidato → activo (en diseño) → en medición → cerrado (logrado / parcialmente logrado / no logrado / no concluyente) → puede originar candidatos nuevos; archivado si se descarta | La ventana de medición y el post mortem se definen desde la etapa 0 |
| Design version | borrador → aprobada → superada | Inmutable una vez aprobada; los cambios generan una nueva |
| Release | planificado → desplegado → verificado (con effective state) | Parcialidad explícita: qué elementos de la design version incluye |

### 3.4 La simetría 0 → post mortem y el loop

Los criterios de éxito que el cliente aprueba en la etapa 0, cada uno con su ventana de medición, son exactamente lo que el outcome review evalúa: **el proyecto abre con una promesa medible y el reto cierra midiéndola.** El loop completo: post mortem y hallazgos de medición → retos candidatos en el backlog del servicio → un reto se activa y abre proyecto (etapa 0 pre-poblada con la memoria del propio cliente) → design version → releases → effective state → medición → post mortem. La semilla es **intra-cliente**: la historia del workspace, no datos de terceros.

## 4. Segmentos, arquetipos y revisores AI

### 4.1 Segmentos y arquetipos

| Objeto | Nivel | Qué es | Cómo se usa |
|---|---|---|---|
| **Segmento** | Cliente (transversal) | Clasificación estable de usuarios/clientes de la organización | Eje persistente: cobertura de research y lectura de métricas se planifican por segmento |
| **Arquetipo** | Reto de diseño | Perfil conductual/actitudinal emergente de la evidencia de ese reto | Guía decisiones de diseño dentro del reto; cita la evidencia que lo sostiene |

Reglas: todo arquetipo se mapea a uno o más segmentos (n:m); la biblioteca del cliente conserva los arquetipos históricos por segmento como hipótesis a confirmar o refutar en retos nuevos; un arquetipo sin evidencia enlazada no pasa el gate G2.

### 4.2 Revisores AI basados en arquetipos

Los arquetipos del reto pueden actuar como **lentes de revisión AI** transversales al proceso. Su función: cuestionar supuestos desde las características del arquetipo; identificar fricciones, exclusiones, contradicciones y riesgos potenciales; comparar cómo una decisión afectaría a distintos arquetipos; proponer preguntas y escenarios para tests con personas reales; y ejecutar revisión adversarial del journey, concepto, blueprint o release propuesto.

Límites obligatorios:

- Siempre etiquetados como **simulación AI**.
- No producen evidencia primaria; no sustituyen entrevistas, observación, prototipado ni tests reales.
- Sus resultados **no cuentan para aprobar los gates G4 o G5**.
- No se ejecutan simulaciones masivas de numerosos "usuarios" ni se presentan porcentajes sintéticos como hallazgos de mercado.
- Sus afirmaciones deben derivarse del arquetipo y de evidencia real citada; cuando extrapolen, se marcan como hipótesis.

## 5. Las etapas 0-7: canónicas, flexibles y asistidas

### 5.1 Principios de ejecución

Las etapas son **canónicas en vocabulario y resultados** y **flexibles en ejecución**:

- Se pueden **iterar y reabrir**; el sistema registra qué cambió y marca para revisión las decisiones aguas abajo afectadas.
- Actividades de distintas etapas pueden ejecutarse **en paralelo**: los gates ordenan decisiones, no encadenan el trabajo.
- Cada proyecto elige un **perfil**: rápido, estándar o profundo, que gradúa actividades y profundidad, nunca el vocabulario ni los resultados canónicos.
- Un criterio o actividad puede declararse **no aplicable**, con justificación y aprobación, y queda auditado.
- Los gates se basan en **suficiencia de evidencia, riesgos y decisiones**, no solo en la presencia de artefactos.

### 5.2 Etapas, resultados canónicos y gates

Prototipado y test no son etapa: son actividades obligatorias (según perfil) de las etapas 4 y 5, y sus gates exigen su evidencia o la justificación de no aplicabilidad.

| # | Etapa | Pregunta que cierra | Resultado canónico (objetos) | Gate de salida (suficiencia y decisiones) |
|---|---|---|---|---|
| 0 | Definición del objeto y del reto | ¿Sobre qué intervenimos y para qué? | Reto formalizado (servicio ancla y afectados), criterios de éxito con línea base y **ventana de medición por criterio**, stakeholders, plan y perfil del proyecto | **G0**: el sponsor aprueba reto, criterios y ventanas; línea base registrada o plan para obtenerla |
| 1 | Investigación | ¿Qué evidencia tenemos? | Fuentes, entrevistas, observaciones, datasets, codificación | **G1**: evidencia suficiente para decidir en la etapa 2 según el perfil; segmentos priorizados cubiertos o no-aplicabilidad justificada |
| 2 | Análisis y entendimiento | ¿Qué significa? | Insights con citas, arquetipos del reto, journeys as-is (grafo tipado) | **G2**: insights y arquetipos con evidencia enlazada; contradicciones resueltas o explícitas; as-is validado con el cliente |
| 3 | Conceptualización | ¿Dónde jugamos? | Oportunidades (HMW) trazables, principios de diseño, priorización | **G3**: portafolio de oportunidades aprobado; cada oportunidad trazable a ≥1 insight |
| 4 | Exploración de soluciones | ¿Qué podría funcionar? | Conceptos, prototipos, resultados de test, decisiones pasa/muere | **G4**: la evidencia de test de cada concepto que avanza alcanza el umbral definido (o su N/A está aprobado); lo descartado queda con razón. Los revisores AI no cuentan como evidencia |
| 5 | Detalle de solución | ¿Cómo funciona exactamente? | Blueprint to-be como grafo tipado, specs por touchpoint, **design version** con diff contra el effective state vigente | **G5**: design version completa y consistente (cobertura journey ↔ blueprint ↔ requisitos), piezas críticas validadas, aprobada por el cliente |
| 6 | Plan de implementación | ¿Quién hace qué y cuándo? | Roadmap de releases, RACI, riesgos, **Metric Registry** poblado (KPI, dueño del dato, fuente, ventana, frecuencia de snapshots) | **G6**: cada elemento de la design version asignado a un release con dueño y fecha; Metric Registry acordado; sign-off del cliente |
| 7 | Seguimiento de implementación | ¿Qué se implementó realmente? | Releases registrados, **effective state** con desviaciones explicadas, Metric Registry activo con baseline y snapshots llegando | **G7**: releases conciliados contra la design version; effective state constatado; medición operando. El proyecto y el reto pasan a "en medición" |
| PM | Post mortem (cierre) | ¿Qué resultado tuvo? | **Outcome review**: baseline vs. snapshots vs. resultado final, contribución y factores, aprendizajes, retos candidatos | El reto cierra con veredicto (logrado / parcial / no logrado / no concluyente); el proyecto pasa a cerrado e inmutable |

## 6. Invariantes de producto

| # | Invariante | Consecuencia |
|---|---|---|
| I1 | **Canónico el vocabulario y los resultados; flexible la ejecución.** Las etapas 0-7 no se renombran ni cambian sus resultados; la ejecución itera, paraleliza y gradúa por perfil, con reaperturas trazadas | La comparabilidad vive en objetos y resultados, no en el orden secuencial. Modelos externos (IDEO, Double Diamond) son crosswalk de presentación |
| I2 | **La validación es gate, no etapa** | Prototipado y test viven en 4 y 5; el enforcement está en la suficiencia exigida al decidir |
| I3 | **Cadena de evidencia navegable con dimensiones y grounding medido** | Todo objeto generado registra proveniencia, método, calidad, derechos y lineage (§9); la cita no equivale a grounding: se mide fidelidad, afirmaciones no soportadas, correcciones y contradicciones |
| I4 | **La AI propone y cita; el humano aprueba; el sistema degrada seguro** | Ningún agente aprueba gates ni publica decisiones; si la AI no está disponible, todo flujo puede completarse manualmente |
| I5 | **La medición es temporal y acotada** | Ventana por reto y por KPI definida en la etapa 0 (hasta seis meses como referencia inicial), snapshots manuales o CSV, post mortem obligatorio; sin causalidad automática: se habla de contribución y asociación salvo diseño experimental suficiente |
| I6 | **Aislamiento entre clientes y anti-dilución** | Nada viaja entre workspaces de clientes; toda feature nueva respeta el árbol simple, el grafo n:m y el vocabulario canónico. Un deal que exige renombrar etapas o mezclar datos de clientes no es un cliente de esta plataforma |

## 7. Capacidades AI por etapa

Toda capacidad hereda I3 e I4: opera sobre objetos y contexto delimitado del reto, propone resultados estructurados citando fuentes, permite revisión, corrección y rechazo humano, nunca aprueba gates, funciona aunque las etapas no vayan en orden estricto y degrada de forma segura si la AI no está disponible. **El MVP implementa la columna "Capacidad mínima MVP"; la profundización posterior se decide con datos de uso.**

| Ámbito | Capacidades AI (visión) | Capacidad mínima MVP |
|---|---|---|
| 0 Definición del objeto y reto | Semilla desde la memoria del cliente y la biblioteca general; reencuadre del reto; propuesta de criterios medibles con línea base y ventana; borrador del plan según perfil | Borrador de reto: reencuadre + criterios de éxito medibles con ventana por criterio |
| 1 Investigación | Planes de research y guías trazables; ingesta multimodal; codificación asistida; monitor de cobertura y saturación por segmento; Q&A con citas | Transcripción, diarización y codificación de evidencia con citas exactas |
| 2 Análisis y entendimiento | Clustering y propuesta de insights con citas; arquetipos desde evidencia con contraste histórico; journey as-is asistido; detección de contradicciones | Propuesta de insights citando fragmentos, con contradicciones señaladas |
| 3 Conceptualización | Oportunidades HMW trazables; priorización contra criterios del reto; analogías desde la biblioteca general; bandera de oportunidades sin soporte | Generación y priorización de oportunidades HMW trazables |
| 4 Exploración de soluciones | Co-generación de conceptos; crítica adversarial (pre-mortem, supuesto más riesgoso); diseño de tests; prototipos rápidos; revisores AI por arquetipo; síntesis pasa/muere | Revisión adversarial de conceptos con revisores AI por arquetipo (etiquetada como simulación) + borrador de diseño de tests |
| 5 Detalle de solución | Generación del blueprint to-be sobre el grafo; verificación de consistencia y cobertura; specs por touchpoint; diff explicado contra el effective state vigente | Validación automática del grafo (pasos sin evidencia, transiciones rotas, huecos frontstage/backstage) + render Mermaid |
| 6 Plan de implementación | Descomposición en releases con dependencias; RACI propuesto; riesgos con mitigaciones; borrador del Metric Registry | Borrador del Metric Registry (KPIs, dueños, fuentes, ventanas) y del plan de releases |
| 7 Seguimiento | Conciliación design version vs. releases vs. effective state; lectura de snapshots contra criterios; detección de desviaciones; borrador del outcome review | Detección de desviaciones (effective state vs. design version) + borrador narrativo del post mortem sobre snapshots deterministas |
| Transversales | Revisores AI por arquetipo (§4.2); gates auto-verificados (checklist de suficiencia evaluado contra los objetos, decide el humano); memoria del workspace (glosario, tono, decisiones); redacción de entregables y actas desde el grafo | Gates auto-verificados en modo asistente ("qué falta para este gate") |
| Importación (§12) | Extracción de objetos desde material heredado con mapeo propuesto y confianza; lectura básica de tableros Miro/Figma | Extracción propuesta desde documentos y audio con curaduría humana |

## 8. Metric Registry y medición de impacto

El producto acompaña el diseño, la implementación y una **medición temporal del impacto**. No es una plataforma de operación ni de telemetría continua.

### 8.1 Campos mínimos del Metric Registry

| Campo | Contenido |
|---|---|
| KPI | Nombre y definición |
| Criterio de éxito | Al que responde el KPI (definido en etapa 0) |
| Propietario del dato | Persona del cliente responsable de aportarlo |
| Fuente | Sistema o proceso de origen |
| Dimensiones | Segmentos o cortes relevantes |
| Línea base | Valor y fecha de la línea base |
| Frecuencia | Actualización esperada durante la ventana |
| Snapshots | Valores recibidos, con fecha y origen |
| Dashboard externo | Enlace, si existe |
| Ventana y post mortem | Ventana de medición del criterio y fecha prevista del post mortem |

### 8.2 Reglas de alcance

- La ventana se define **desde la etapa 0 y por cada criterio de éxito**; **hasta seis meses como referencia inicial**, ajustable según el ciclo del resultado y la disponibilidad del dato. No todos los resultados requieren ni justifican el mismo plazo.
- Los datos se reciben **manualmente, por formulario, archivo CSV o enlace a un dashboard externo**. Sin integraciones operacionales en el MVP; sin ingesta continua de tickets, NPS, quejas o eventos transaccionales.
- La lectura compara **baseline, snapshots posteriores a cada release y resultado final**.
- Al terminar la ventana se realiza el **post mortem** (outcome review) y el reto se declara logrado, parcialmente logrado, no logrado o no concluyente.
- **Sin causalidad automática**: salvo diseño experimental suficiente, el outcome review habla de contribución, asociación y evidencia disponible, y registra factores externos conocidos.

## 9. Modelo de evidencia

Cada evidencia u objeto derivado registra dimensiones independientes; no existe una clasificación de un solo eje.

| Eje | Dimensiones registradas |
|---|---|
| **Proveniencia** (de dónde viene) | Tipo de fuente; fecha y vigencia; fragmento exacto de respaldo o localización precisa dentro de la fuente |
| **Método** (cómo se obtuvo) | Método de recolección; directa o derivada; segmento, muestra y contexto |
| **Calidad** (qué tan confiable es) | Confianza o calidad estimada; evidencia que la corrobora; evidencia que la contradice |
| **Derechos** (para qué puede usarse) | Consentimiento y derechos de uso; clasificación de confidencialidad y alcance de acceso |
| **Lineage** (cómo fue transformada) | Transformaciones AI aplicadas; versión del modelo, prompt o configuración relevante |

**La presencia de una cita no equivale a grounding correcto.** El producto mide: fidelidad de citas (la cita dice lo que el objeto afirma), tasa de afirmaciones no soportadas, tasa de corrección humana sobre propuestas AI y contradicciones detectadas. Estas métricas alimentan las evaluaciones de §14 y las métricas de salud de §17.

## 10. Journeys como grafos tipados

No se construye un canvas libre propio. El journey (y el blueprint) se modela como **grafo tipado**, no como composición espacial de elementos sueltos.

El grafo de un journey contiene, como mínimo: fases; pasos o momentos; transiciones, bifurcaciones y dependencias; actores y arquetipos involucrados; canales y touchpoints; acciones frontstage y backstage; sistemas o capacidades que soportan cada paso; emociones, fricciones, oportunidades y decisiones; y evidencias, métricas y releases relacionados con cada nodo.

Reglas:

1. **La fuente de verdad es el modelo estructurado** de nodos, relaciones y atributos; allí viven evidencia, permisos, estados, versiones, métricas y auditoría.
2. **Mermaid es el renderer principal**, generado desde el grafo: secuencias, flujos, dependencias, bifurcaciones y agrupaciones por fase. En el MVP la edición ocurre por formularios estructurados, tablas y asistencia AI; el sistema regenera la vista. La edición bidireccional del código Mermaid no es necesaria inicialmente.
3. El mismo grafo se puede renderizar en **múltiples vistas**: Mermaid, tabla, timeline, vista por actor o blueprint por carriles. Si una vista avanzada no se representa bien en Mermaid, se añade otra visualización estructurada, no un canvas libre.

Qué aporta: trazabilidad (cada paso enlaza evidencia, decisiones, métricas, sistemas y releases), consultabilidad (todos los pasos afectados por un sistema, segmento, pain point o decisión), versionamiento y diff sobre objetos (no sobre imágenes ni posiciones), validación automática (pasos sin evidencia, transiciones rotas, huecos entre frontstage y backstage, elementos sin responsable), trabajo AI confiable (la AI propone y revisa nodos y relaciones concretas, sin interpretar coordenadas) y menor complejidad de producto (no se construye un editor gráfico genérico).

La pérdida deliberada es la libertad visual absoluta. Los artefactos libres creados en talleres se conservan como **evidencia importada**; la AI propone su traducción al grafo estructurado y una persona la aprueba.

## 11. Bibliotecas

Dos espacios con contenidos estrictamente separados:

| Biblioteca | Contenido | Regla |
|---|---|---|
| **Del cliente** | Exclusivamente la memoria del workspace: servicios, proyectos, investigaciones, decisiones, design versions, releases, resultados y aprendizajes del cliente | Aislada de todos los demás clientes; propiedad del cliente |
| **General de service design** | Solo conocimiento general: métodos y guías creados por la boutique, plantillas propias, taxonomías generales, contenido público o licenciado, patrones metodológicos que no provengan de proyectos de clientes | Habilitador metodológico; no es un corpus derivado de engagements |

Fuera del MVP y de la tesis de moat: promoción de objetos desde clientes hacia una biblioteca transversal, benchmarks derivados de clientes, aprendizaje automático cross-cliente y anonimización para reutilizar proyectos delicados. El valor acumulativo permitido está en la **memoria privada de cada cliente** y en la **mejora explícita del método propio de la boutique** (que se versiona en la biblioteca general sin datos de clientes).

## 12. Importación y artefactos externos

Propósito: resolver el arranque en frío del workspace con el material previo del cliente y de la boutique, y capturar como evidencia el trabajo hecho en herramientas externas.

### 12.1 Flujo de importación

| Paso | Qué pasa | Quién decide |
|---|---|---|
| 1. Carga | Documentos, presentaciones, hojas de cálculo, fotos, audios, videos, exports o enlaces de Miro/Figma llegan a la **bandeja de importación** del workspace | Usuario |
| 2. Extracción propuesta | La AI detecta candidatos a objetos (servicios, journeys, blueprints, personas → arquetipos históricos, insights, KPIs, segmentos) y propone su mapeo al grafo con nivel de confianza | AI propone |
| 3. Curaduría | Gate obligatorio: nada entra al grafo sin aprobación humana; se decide qué describe el estado actual del servicio y qué queda como histórico | Humano aprueba |
| 4. Registro | Todo objeto importado queda con sus dimensiones de evidencia (§9): proveniencia, método, derechos y lineage; las citas enlazan al documento original | Sistema |

### 12.2 Miro y Figma como evidencia (alcance básico)

Incluido: adjuntar el archivo, exportación, enlace o captura original; registrar origen, autor, fecha, permisos y contexto; generar preview; aplicar OCR o lectura visual AI básica; proponer objetos o hallazgos con citas al artefacto original; y exigir curaduría humana antes de incorporar objetos al grafo.

Fuera del MVP: reconstrucción editable completa del tablero, sincronización bidireccional, importación semántica perfecta de nodos y componentes, y preservación exhaustiva del layout original.

## 13. Propiedad, workspace, portal y roles

### 13.1 Propiedad y operación

| Rol económico | Quién | Qué implica |
|---|---|---|
| **Propietario** | La organización cliente | Es dueña del workspace y de sus datos, incluidos los objetos derivados |
| **Operador autorizado** | La boutique | Opera el workspace durante el engagement y el periodo de medición |
| **Proveedor tecnológico** | Plataforma Whitespace | Provee la plataforma, la seguridad y la continuidad técnica |

Reglas de ciclo comercial:

- El acceso a la plataforma está **incluido en el fee del engagement** durante el proyecto y la ventana de medición de impacto.
- Al terminar el post mortem, la organización decide si contrata una **suscripción** para conservar el workspace activo y seguir usando la memoria, las herramientas y futuros retos. Esta disposición a pagar es una **hipótesis comercial por validar**.
- Si el cliente no contrata la suscripción, aplica un proceso explícito de **exportación, entrega, retención temporal y posterior borrado o archivo** según lo acordado.
- La edición del producto para múltiples boutiques externas queda fuera del MVP.

### 13.2 Portal y roles

El workspace es también el portal del cliente: comentarios y aprobaciones de gate ocurren dentro, quedan auditados y convierten cada gate en un momento de co-creación.

| Rol | Ámbito | Responsabilidad en gates |
|---|---|---|
| Sponsor del cliente | Workspace | Aprueba G0, G3, G5 y G6; recibe el seguimiento de impacto y el post mortem |
| Stakeholders del cliente | Reto / servicio | Validan as-is (G2), participan en tests y talleres, comentan en el portal |
| Lead de la boutique | Workspace / proyecto | Presenta gates, responde por la calidad del método, opera el workspace |
| Diseñadores (boutique) | Proyecto | Producen artefactos con cadena de evidencia |
| Administrador del cliente | Workspace | Gestiona accesos de su organización; ejecuta la decisión de continuidad o exportación |
| Agentes AI | Nodo asignado del grafo | Proponen y citan; auto-verifican checklists; nunca aprueban |

## 14. Seguridad, privacidad y confiabilidad AI

Requisitos de producto, parte del **Definition of Done del MVP**. Pueden variar en sofisticación según el piloto, pero no quedan pospuestos como trabajo indefinido.

| Ámbito | Requisitos mínimos |
|---|---|
| Aislamiento y acceso | Aislamiento verificable entre tenants; permisos a nivel de objeto; clasificación de datos y controles por sensibilidad |
| Ciclo de vida del dato | Retención, exportación y borrado, incluidos objetos derivados; consentimiento de grabación y transcripción; cifrado en tránsito y en reposo; gestión segura de secretos y credenciales |
| Amenazas específicas AI | Protección contra prompt injection en archivos importados; escaneo de malware y validación de formatos; condiciones de uso de datos de los proveedores AI, incluida la prohibición de entrenamiento cuando aplique |
| Confiabilidad AI | Evaluaciones de grounding, fidelidad de citas y regresión; degradación segura cuando falle la AI; presupuestos y límites AI por workspace |
| Auditoría y operación | Auditoría completa de accesos, aprobaciones, cambios y acciones AI; observabilidad de costos, latencia, errores y calidad |

## 15. Posicionamiento y modelo de negocio

**Servicio con aplicación primero.** El SaaS standalone para diseñadores es el peor cuadrante (TAM chico, usuario power capaz de DIY con Claude, incumbentes regalando IA en el canvas). La boutique garantiza engagements reales alimentando el sistema desde el día 1.

| Momento | Oferta | Ingreso | Estado de la tesis |
|---|---|---|---|
| Entrada | Importación y consolidación de la memoria de diseño del cliente | Fee acotado | Propuesta |
| Engagement | Ejecución de un reto por las etapas 0-7 + ventana de medición + post mortem; plataforma incluida | Fee del engagement | Núcleo del modelo |
| Continuidad | El cliente conserva el workspace activo (memoria, herramientas, retos futuros) | Suscripción | **Hipótesis por validar** |
| Expansión | Retos candidatos del backlog → nuevos proyectos | Fee de engagement | Propuesta (pipeline embebido) |

Graduación futura a "aplicación con servicio" solo con datos: primero validar la hipótesis de suscripción y la adopción del portal; después, track record de proyectos de la propia boutique y demanda inbound.

## 16. Alcance del MVP

Objetivo: demostrar un **loop completo, delgado y confiable** para **un cliente, un servicio y un reto**, con capacidad mínima en todas las etapas.

| Incluido en el MVP | Fuera del MVP |
|---|---|
| Workspace propiedad del cliente con la boutique como operador | Canvas libre propio |
| Creación de servicio, reto, proyecto y criterios de éxito | Telemetría continua e integraciones con sistemas operacionales |
| Ingesta multimodal y curaduría de evidencia | Corpus, benchmarks o aprendizaje cross-cliente |
| Grafo básico evidencia → insight → decisión | Múltiples boutiques |
| Journey como grafo tipado, visualizado principalmente con Mermaid | Importadores sofisticados o sincronización con Miro/Figma |
| Una herramienta AI útil por cada etapa 0-7 (§7) | Automatización profunda de todas las actividades de cada etapa |
| Revisores AI basados en arquetipos, claramente etiquetados | |
| Gates flexibles con aprobación humana | |
| Design version, release, effective state y diff | |
| Metric Registry con carga manual o CSV | |
| Ventana de medición temporal y post mortem | |
| Portal para comentarios y aprobaciones del cliente | |
| Baseline de seguridad, auditoría, observabilidad y evaluaciones AI (§14) | |

## 17. Métricas de salud del producto

| Dimensión | Métrica | Señal de alarma |
|---|---|---|
| Grounding | Fidelidad de citas; tasa de afirmaciones no soportadas; tasa de corrección humana; contradicciones detectadas | Fidelidad que no mejora entre releases del producto |
| Trazabilidad | % de decisiones aprobadas con cadena completa hasta evidencia; % de elementos de design version conciliados en releases y effective state | Decisiones que pasan gates sin cadena |
| Loop cerrado | % de retos que llegan a veredicto en el post mortem con datos del Metric Registry | Retos que cierran "no concluyente" por falta de snapshots |
| Adopción del portal | % de aprobaciones de gate y comentarios del cliente dentro de la plataforma | Aprobaciones por correo/PDF |
| Valor | Horas de la boutique por etapa vs. su línea base; tiempo de arranque (etapas 0-2) del reto N vs. N-1 en el mismo cliente | Sin mejora tras varios retos en el mismo workspace |
| Continuidad (hipótesis) | % de clientes que contratan la suscripción tras el post mortem; % que ejecutan exportación | Todos exportan y nadie renueva |
| Doctrina | Excepciones al vocabulario canónico; intentos de mezcla cross-cliente bloqueados | Cualquier excepción concedida sin revisión |

## 18. Riesgos y mitigaciones

| Riesgo | Impacto | Mitigación |
|---|---|---|
| Commoditización de la capa de generación | Erosión del valor percibido de la asistencia | No cobrar la generación; anclar el valor en grafo, gates, trazabilidad y medición (regla de las 200 palabras) |
| Construir "un Miro peor" | Fatal en adopción | Sin canvas libre por diseño (§10); Miro/Figma como evidencia importable |
| El cliente no aporta snapshots durante la ventana | El post mortem sale "no concluyente" y el loop no se demuestra | Metric Registry con propietario del dato y frecuencia comprometidos en G6; recordatorios; el veredicto "no concluyente" existe y es honesto, pero se monitorea como métrica de salud |
| Grounding insuficiente (citas que no sostienen lo afirmado) | Pérdida de confianza en toda la propuesta AI | Métricas de grounding (§9) + evaluaciones y regresión (§14) + corrección humana barata |
| Prompt injection y contenido malicioso en material importado | Seguridad y de integridad del grafo | Tratamiento del material importado como no confiable: sanitización, escaneo, validación de formatos, curaduría humana (§12, §14) |
| Adopción post-engagement no validada | Sin recurrencia; el producto queda como herramienta de delivery | Tratar la suscripción como hipótesis con experimento explícito en los primeros pilotos (§20); diseñar la exportación digna para que no contratar no sea traumático |
| Auto-dilución (renombrar etapas, mezclar clientes, aflojar evidencia "por rapidez") | Destruye comparabilidad y confianza | Invariantes I1-I6 como criterio de revisión de features y de deals |
| Dependencia del canal boutique | Sin engagements no hay t1 | Decisión de gerencia explícita sobre el canal; el MVP exige un cliente piloto real |

## 19. Ejemplo trabajado

Cliente ficticio: **Banco Andino** (workspace propiedad del banco; la boutique opera). Segmentos transversales: empleados corporativos, pymes, independientes.

1. **Importación**: el banco aporta un estudio de CX de 2024 (PDF) y el funnel actual (hoja de cálculo). Se crea el servicio "Apertura de cuenta nómina digital" con su estado actual descrito y curado desde el material importado (dimensiones de evidencia registradas: proveniencia documental, método derivado, derechos acordados). Línea base: abandono del 62% en la verificación de identidad.
2. **Reto R-01** (candidato → activo): "Reducir el abandono de apertura digital del 62% al 40%". Criterios y ventanas definidos en la etapa 0: tasa de abandono (ventana de 6 meses, snapshots mensuales por CSV del área de analítica, propietario: gerente de canales), NPS del flujo (ventana de 3 meses, encuesta trimestral). G0 aprobado por el sponsor en el portal.
3. **Proyecto P-01, etapas 1-4** (perfil estándar): 12 entrevistas transcritas y codificadas; G1 verifica cobertura de los tres segmentos. Insight I-07: "la verificación pide documentos que el usuario no tiene a mano en el móvil" (cita 7 fragmentos). Arquetipos del reto: "el apurado de RR. HH." (→ empleados) y "el desconfiado digital" (→ independientes). Oportunidad HMW-02 trazable a I-07. Dos conceptos; los revisores AI por arquetipo señalan un riesgo de exclusión del "desconfiado digital" (etiquetado como simulación, origina una pregunta de test); test real con 8 usuarios, umbral 6/8: pasa "verificación diferida", muere "pre-carga por convenio" (razón registrada). Nada de los revisores AI cuenta para G4.
4. **Design version DV-1** (G5): journey y blueprint to-be como grafo tipado (render Mermaid), 4 cambios: 3 touchpoints modificados y 1 proceso backstage nuevo. Diff explicado contra el estado actual. **Plan (G6)**: dos releases; Metric Registry poblado y firmado.
5. **Implementación y seguimiento (etapa 7)**: el **release RL-1** despliega 3 de los 4 cambios (el proceso backstage se aplaza a RL-2 por dependencia del área de riesgo). El **effective state ES-1** constata además una desviación: la verificación diferida salió con un paso adicional exigido por cumplimiento; queda registrada con razón. G7: conciliación completa, snapshots llegando. Proyecto y reto pasan a "en medición".
6. **Medición y post mortem**: snapshots mensuales: 55%, 49%, 46%, 44%. Al cierre de la ventana, el **outcome review** declara el reto **parcialmente logrado** (44% vs. objetivo 40%): registra la contribución del rediseño, un factor externo simultáneo (campaña comercial) y la hipótesis de que el elemento aplazado (RL-2) explica parte del gap. Sin afirmación causal: contribución y asociación. Se crean dos retos candidatos: R-02 "completar el backstage aplazado" y R-03 "abandono del segmento pymes (55%)", ambos pre-poblados desde la memoria del workspace.
7. **Continuidad**: con el post mortem entregado, el banco decide si contrata la suscripción para mantener el workspace activo (y abordar R-02/R-03) o ejecuta la exportación pactada. El sponsor, mientras tanto, navegó todo por el árbol: servicio → reto → proyecto; y el grafo respondió preguntas como "qué pasos del journey afectó RL-1".

## 20. Decisiones tomadas y abiertas

| Decisión | Estado | Nota |
|---|---|---|
| Aplicación completa standalone construida con las capacidades AI-native de Whitespace | Tomada (v0.1) | |
| Comprador organización; servicio con aplicación primero | Tomada (v0.1) | |
| Etapas 0-7 canónicas en vocabulario y resultados | Tomada (v0.1) | |
| Segmentos transversales al cliente; arquetipos del reto (n:m a segmentos) | Tomada (v0.1) | |
| Cliente dueño del workspace y sus datos; boutique operador autorizado; Whitespace proveedor tecnológico | **Tomada (v0.2)** | §13 |
| Árbol de navegación simple separado del grafo de dominio n:m; servicio ancla como ayuda, no restricción | **Tomada (v0.2)** | §2 |
| Design version, release, effective state y outcome review como objetos diferenciados | **Tomada (v0.2)** | §3 |
| Etapas flexibles: iteración, paralelismo, perfiles, no-aplicabilidad justificada; gates de suficiencia | **Tomada (v0.2)** | §5 |
| Medición temporal con Metric Registry (manual/CSV), ventana por reto y KPI (hasta 6 meses de referencia), post mortem; sin telemetría continua | **Tomada (v0.2)** | §8 |
| Sin corpus, benchmarks, promoción ni aprendizaje cross-cliente (MVP y tesis de moat); biblioteca general solo con conocimiento autorizado | **Tomada (v0.2)** | §11 |
| Journey como grafo tipado; Mermaid renderer principal; sin canvas libre; Miro/Figma como evidencia básica | **Tomada (v0.2)** | §10, §12 |
| Revisores AI basados en arquetipos con límites metodológicos (no evidencia, no cuentan para G4/G5) | **Tomada (v0.2)** | §4.2 |
| Modelo de evidencia por dimensiones + métricas de grounding | **Tomada (v0.2)** | §9 |
| Seguridad, privacidad y confiabilidad AI en el Definition of Done del MVP | **Tomada (v0.2)** | §14 |
| MVP: un cliente, un servicio, un reto; una capacidad AI mínima por etapa | **Tomada (v0.2)** | §16 |
| Suscripción post-engagement como hipótesis por validar | **Tomada (v0.2)** | §15 |
| Multi-boutique fuera del MVP | **Tomada (v0.2)** | §13 |
| Nombre del producto | Abierta | Sin nombre en clave aún |
| Boutique propia o aliada | Abierta | Define la marca del método y el canal |
| Cliente y reto piloto del MVP | Abierta | Criterio sugerido: un reto con KPI medible y dueño del dato claro |
| Diseño del experimento de validación de la hipótesis de suscripción | Abierta | Qué precio, qué incluye, cuándo se ofrece |
| Reuso técnico del stack interno de Whitespace (aislamiento multi-workspace, quality gates) vs. greenfield | Abierta | Hay patrón arquitectónico probado en casa |
| Pricing (cifras de fee y suscripción) | Abierta | El modelo de momentos (§15) está definido; las cifras no |

## 21. Honestidad: qué NO decir

- **NO** vender la generación de artefactos como diferencial: es la capa comoditizada; el diferencial es grafo, gates, trazabilidad hasta resultados y memoria privada.
- **NO** afirmar que la plataforma aprende de los proyectos de otros clientes: no lo hace, por diseño. La biblioteca general contiene solo conocimiento metodológico autorizado.
- **NO** presentar los revisores AI basados en arquetipos como investigación o validación con usuarios: son simulación etiquetada, no producen evidencia y no aprueban gates.
- **NO** describir el producto como plataforma de operación o telemetría continua: la medición es temporal, con ventana y post mortem.
- **NO** afirmar causalidad sobre los KPIs sin diseño experimental suficiente: se habla de contribución, asociación y evidencia disponible.
- **NO** presentar la suscripción post-engagement como recurrencia demostrada: es una hipótesis por validar.
- **NO** afirmar que la boutique es dueña del conocimiento o del workspace del cliente: es operador autorizado; la propiedad es del cliente.

## Referencias

- Feedback de corrección v0.2 (revisión adversarial consolidada, sep-2026): fuente de las decisiones integradas en esta versión.
- Documento interno Whitespace (estrategia de moat y counter-positioning): marco de counter-positioning, escalera del moat, anti-dilución y métricas de salud.
- Documento interno Whitespace (estrategia de moat arquitectónico): aislamiento y gobierno por objeto; antecedente del patrón multi-workspace.
- Documento interno Whitespace (tesis de quality gates por tipo): antecedente de los gates con evidencia.
- Hamilton Helmer, *7 Powers*: counter-positioning, switching cost, efectos de aprendizaje.
- Categoría externa (verificado sep-2026, superficial): TheyDo (journey management con AI), Miro/Mural (canvas), Smaply/UXPressia (artifact tools). Pendiente un comparativo funcional formal como los realizados para otros productos internos.
