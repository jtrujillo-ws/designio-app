# Mockups del MVP

`mockup-mvp.html` es un mockup **estático y autocontenido** (sin dependencias externas: abrir el archivo en cualquier navegador) del MVP, poblado con los datos del ejemplo trabajado del prediseño (§19, Banco Andino), de modo que cada pantalla ilustra objetos reales del modelo. La pantalla de entrada es el **loop del método (J1–J7)** y cada pantalla lleva una etiqueta morada `J#` que indica a qué journey de `docs/04-journeys/` pertenece:

| Pantalla | Qué muestra | Specs que ilustra |
|---|---|---|
| **Loop J1–J7** (entrada) | El recorrido completo del engagement: las siete tarjetas J1–J7 con etapas, gates, rol decisivo y estado en el ejemplo, el cierre del loop (J7 → J2 vía retos candidatos) y el mapa journey → pantalla | `docs/04-journeys/` completo |
| Servicio | Estado vigente (effective state con desviación), KPIs, historia DV/RL y backlog de retos | SPEC-02, SPEC-06 |
| Reto R-01 | Criterios de éxito con ventanas y dueños, arquetipos, Metric Registry con serie de snapshots anclada al release y objetivo | SPEC-04, SPEC-07 |
| Proyecto P-01 | Stepper de etapas 0–7 + PM con estado de gates, asistente de gate ("qué falta", incluye N/A aprobada) y decisiones con su evidencia | SPEC-04 |
| Journey / Blueprint | Grafo tipado renderizado por carriles (fases, frontstage, backstage, sistemas), nodo seleccionado con panel de trazabilidad completo | SPEC-05, SPEC-02 |
| Portal · G5 | La aprobación del sponsor: diff de la design version, suficiencia verificada, conversación y acción humana de aprobar | SPEC-01, SPEC-06 |
| Importación | Bandeja con ítems escaneados y curaduría de candidatos propuestos por AI con confianza, contradicción señalada y dimensiones de evidencia | SPEC-03, SPEC-08 |

Notas de intención:

- El árbol lateral reproduce la navegación canónica Cliente → Servicio → Retos → Proyectos (ADR-0003); el seguimiento de impacto vive dentro del reto, no como módulo aparte (ADR-0007).
- Toda salida AI visible lleva etiqueta (asistente / simulación / propuesta) y ningún control de aprobación es AI (ADR-0009, ADR-0012).
- Los tokens visuales (colores, tipografía del sistema) son **placeholder de referencia**: el scaffolding los sustituirá por el design system propio de la plataforma, por definir, orientado a una herramienta de diseño (ver `docs/06-diseno-tecnico/`).
- Es un mockup de comunicación, no un prototipo funcional: la única interacción es el cambio de pantalla.
