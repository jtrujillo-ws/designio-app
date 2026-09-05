# Handoff: Sistema de diseño Designio — "El arco del loop"

## Overview
Sistema de diseño propio de Designio, plataforma B2B de service design (loop del método J1–J7, de importación a post mortem). Fija tokens (color, tipografía, espaciado), primitivas UI y una pantalla de referencia (Loop J1–J7) sobre el ejemplo Banco Andino del prediseño v0.2. Repo relacionado: jtrujillo-ws/designio-app.

## About the Design Files
Los archivos de este paquete son **referencias de diseño en HTML/JSX** — prototipos que muestran apariencia e intención, no código de producción para copiar tal cual. La tarea es **recrear estos diseños en el entorno del codebase destino** (el stack fijado en el paquete de diseño MVP) usando sus patrones y librerías; si aún no existe entorno, elegir el framework apropiado e implementar allí. Los `.jsx` de `components/core/` son referencias de API y estilo, no componentes empaquetados.

## Fidelity
**High-fidelity (hifi)** en fundamentos y pantalla Loop: colores, tipografía, espaciado y estados son finales — recrear pixel-perfect. El resto de pantallas del MVP aún no está diseñado en este sistema.

## Idea central
La firma cromática es **el arco del loop**: 7 hues oklch (L 0.58, C 0.11–0.14) de petróleo (J1, 190°) a frambuesa (J7, 340°), un color por journey. El gradiente firma `--grad-arco` une J1→J7 y significa "el loop completo". Reglas: el gradiente nunca es fondo de página/sección; usos permitidos: marca, chip "en curso", borde de tarjeta activa, CTA "arco". Deliberadamente distinto del lenguaje genérico (d.school / SaaS violeta-teal): arco parcial de 150°, chroma contenido, semántica funcional.

## Design Tokens
Fuente de verdad: `tokens/*.css` (importados desde `styles.css`). Resumen:

Neutros: bg-app #f6f6f4 · surface #ffffff · surface-sunken #efefec · border #e5e5e1 · border-strong #d2d2cc · ink #1d1e24 · text-body #3a3b44 · text-muted #6b6d7a · text-faint #a2a4b1 · text-inverse #f7f7f9.

Arco J1–J7 (oklch): j1 0.58/0.11/190 · j2 0.58/0.11/215 · j3 0.58/0.11/240 · j4 0.58/0.12/265 · j5 0.58/0.12/290 · j6 0.58/0.13/315 · j7 0.58/0.14/340. Variantes -soft (L 0.95, C 0.025–0.04) y -deep (L 0.4). Gradiente: linear-gradient(120deg, j1, j7).

Acento (interacción/focus/links): oklch(0.5 0.12 265) + accent-soft oklch(0.95 0.03 265).

Marca (negro violeta, hue J5–J6 con croma mínima): brand-ink oklch(0.22 0.045 305) · brand-ink-lift oklch(0.28 0.055 305). Es la tinta del wordmark, del lateral oscuro del workspace (dirección 3a de la pantalla Loop) y de los botones primarios; sobre ella el texto va en #fff (activo) o rgba(247,247,249,.68/.55/.45) (inactivo/secundario/etiquetas).

Semánticos: ok oklch(0.55 0.11 150) · warn oklch(0.6 0.12 70) · danger oklch(0.55 0.17 25), cada uno con -soft (L 0.94–0.95).

Tipografía: Figtree (Google Fonts; display 800 30px/1.12, h2 700 22px/1.2, h3 700 16.5px/1.3, body 400 14px/1.5, small 12.5px) + IBM Plex Mono (datos/códigos 13px; micro-labels 11px 500 uppercase tracking .08em). Sin serif.

Espaciado: escala 4px (4/8/12/16/24/32/48). Radios: 8 (controles), 12–14 (tarjetas), 16, pill. Sombras: sm 0 1px 4px rgba(29,30,36,.06) · md 0 4px 16px rgba(29,30,36,.10) · arco 0 4px 16px oklch(0.5 0.12 265 / .16).

## Screens / Views

### Loop J1–J7 (`ui_kits/designio/index.html`)
- **Purpose**: pantalla principal del workspace; los 7 journeys del método con su estado.
- **Layout**: topbar 1 fila (padding 14 28, surface, border-bottom 1px border) · sidebar 250px (árbol Cliente→Servicios→Retos→Proyectos + sección Workspace) · main flex:1 padding 28 32.
- **Topbar**: marca "designio." (Figtree 800 21px, punto en grad-arco vía background-clip:text) · selector de cliente pill (border-strong, "● Banco Andino ▾") · buscador 280px (bg-app, radio 8) · avatar 32px circular en grad-arco + "Lucía P. · Lead boutique" (12.5px muted).
- **Sidebar**: labels de sección en micro-mono uppercase faint; ítem activo con fondo accent-soft (reto) o surface-sunken (workspace); indentación 12px por nivel; badges numéricos mono 11px (accent / warn); nota legal al fondo 11.5px faint.
- **Main**: breadcrumb micro-mono uppercase · tabs (activo: 700, ink, border-bottom 2px accent; inactivo: 500 muted) · título display 30px + pill "vista de recorrido" (accent sobre accent-soft) · descripción 14px muted max-width 760px · barra de progreso 6px pill en grad-arco · grid de 7 tarjetas: `overflow-x:auto` contenedor, grid repeat(7, minmax(158px,1fr)) gap 12, min-width 1178px · callout de cierre del loop (tarjeta surface, 13.5px, links en accent).
- **Tarjeta journey**: header flex space-between con JourneyBadge (mono 600 12px, blanco sobre var(--jN), radio 6) + Chip de estado; título 700 14.5px/1.25 ink; meta mono 11.5px/1.5 muted; rol 600 12px con margin-top:auto. Variantes: normal (border-top 4px var(--jN), shadow-sm) · activa/en curso (borde gradiente 2px técnica padding-box/border-box + shadow-arco) · pendiente (bg-app, dashed border-strong, opacity .55).

## Componentes (`components/core/`)
Button (primary tinta / arco gradiente / secondary outline / ghost / danger; sm 6-12px, md 9-16px, radio 8, peso 700, disabled opacity .45) · Chip de estados canónicos (hecho ok-soft, en curso grad-arco blanco, próximo sunken, candidato warn-soft, en medición accent-soft; 700 11px pill 4-10px) · JourneyBadge (j 1–7, solid o soft) · Card (j / active / pending) · Input, Select (border-strong, radio 8, 8-12px) · Checkbox (accent-color) · Switch (36×20, on = grad-arco, thumb 16px) · Tabs (underline 2px accent) · Tag (códigos en mono, sunken). API exacta en los `.d.ts`; uso en los `.prompt.md`.

## Interactions & Behavior
- Hover: fondo un paso más oscuro (surface-sunken) o border-strong; press: solo color, sin shrink. Transiciones fade/ease-out 150ms; sin bounces.
- Focus: borde/anillo en --accent.
- Links: color accent, hover opacity .8.
- Grid del loop: scroll horizontal bajo ~1240px de viewport (no wrap: el arco se lee en secuencia).
- Estados canónicos (I1, no renombrar): hecho, en curso, próximo, candidato, en medición.

## State Management
La pantalla de referencia es estática. Estado esperado en producción: cliente/workspace activo, journey seleccionado, estado por journey (derivado de gates G0–G7), contadores de bandeja/aprobaciones. Vocabulario canónico del dominio en el paquete MVP v0.2 (invariante I1).

## Content rules
Español, sentence case, sin emoji ni exclamaciones. Términos del lenguaje ubicuo en inglés se conservan (design version, release, effective state, outcome review, Metric Registry). Datos/meta en Plex Mono con separador "·". Códigos en mayúscula: J1–J7, G0–G7, R-01, P-01.

## Assets
- Fuentes: Figtree + IBM Plex Mono vía Google Fonts (`tokens/fonts.css`).
- **Sin logo**: marca tipográfica solamente (no inventar isotipo).
- Iconos: sin set propio; sustitución propuesta Lucide (stroke 1.75, 16/20px) — pendiente de confirmación.

## Files
- `styles.css` + `tokens/` — tokens (fuente de verdad)
- `guidelines/` — specimen cards de fundamentos
- `components/core/` — primitivas (.jsx referencia + .d.ts API + .prompt.md uso)
- `ui_kits/designio/index.html` — pantalla Loop J1–J7
- `readme.md` — guía completa del sistema
