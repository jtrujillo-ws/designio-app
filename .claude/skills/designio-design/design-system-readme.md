# Designio — Sistema de diseño

Sistema de diseño propio de **Designio**, plataforma B2B de service design (loop del método J1–J7: importación → post mortem). Derivado de la exploración 2b (Aurora) cruzada con 1c (cromático por etapas), corrigiendo el riesgo de lenguaje genérico (d.school / SaaS violeta-teal).

Fuentes: paquete de diseño MVP v0.2 (uploads/paquetedisenomvpv0.2.md, repo jtrujillo-ws/designio-app), mockup preliminar, exploraciones en "Exploraciones Design System.dc.html".

## Idea central: el arco del loop

La firma cromática no es decorativa: es **el método hecho color**. Una rampa de 7 hues en oklch — L 0.58, chroma 0.11–0.14, hue 190°→340° (petróleo → frambuesa) — asigna un color a cada journey J1–J7. El gradiente firma (`--grad-arco`) une los extremos J1→J7: donde aparece, significa "el loop completo". Diferencias deliberadas vs. d.school/genérico: arco parcial de 150° (no rueda completa), chroma contenido (editorial, no candy), y semántica funcional (el color orienta posición en el método).

## CONTENT FUNDAMENTALS

- Idioma: español; términos del lenguaje ubicuo en inglés se conservan verbatim (design version, release, effective state, outcome review, Metric Registry) — invariante I1: el vocabulario canónico NO se renombra.
- Tono: profesional directo, frases cortas, sin exclamaciones ni emoji. Sentence case en todo (títulos, botones, labels); solo los códigos van en mayúscula (J1–J7, G0–G7, R-01, P-01).
- Voz: segunda persona implícita, imperativos sobrios ("Ver pantalla", "Aprobar gate"). Datos y metadatos en mono ("Etapas 3–4 · G3 G4"), separados con "·".
- Estados canónicos: hecho, en curso, próximo, candidato, en medición.

## VISUAL FOUNDATIONS

- **Color**: base fría casi neutra (--bg-app #f6f6f4, superficies blancas); tinta --ink #1d1e24. El color cromático se RESERVA: arco J1–J7 para posición en el método, semánticos (ok/warn/danger) para estado, --accent (centro del arco, 265°) para interacción. Nunca más de un hue del arco dominando una vista salvo en el loop mismo.
- **Gradiente**: solo --grad-arco (J1→J7). Usos permitidos: marca, avatar, chip "en curso", borde de la tarjeta activa, CTA primario "arco". Nunca como fondo de página o de secciones grandes.
- **Tipografía**: Figtree (display 800 / cuerpo 400–600) + IBM Plex Mono para datos, códigos y micro-labels uppercase (tracking .08em). Sin serif.
- **Espaciado**: escala 4px (--sp-1..7). Radios: 8/12/16 + pill. Esquinas 12px en tarjetas, 8px en controles.
- **Sombras**: sutiles (--shadow-sm en tarjetas, --shadow-md en overlays); --shadow-arco solo para el elemento activo del loop.
- **Bordes**: 1px --border; el estado activo usa borde gradiente (técnica padding-box/border-box).
- **Hover**: fondo un paso más oscuro (surface-sunken) o borde-strong; press: sin shrink, solo color. Animación: fades/ease-out 150ms, nada de bounces.
- **Tarjetas**: blancas, borde 1px, radio 12–14px, shadow-sm; la variante journey lleva border-top 3-4px del hue correspondiente. Futuro/pendiente: borde dashed, contenido atenuado.
- **Layout**: topbar fija + sidebar de navegación (árbol Cliente→Servicios→Retos→Proyectos); densidad media; tablas con cabecera micro-mono.
- Sin transparencias/blur salvo overlays; sin texturas ni ilustración por ahora (pendiente de definir).

## ICONOGRAFÍA

Sin set propio en las fuentes. **Sustitución flagged**: usar [Lucide](https://lucide.dev) vía CDN (stroke 1.75, tamaño 16/20) — coherente con el trazo de Figtree. Sin emoji. Unicode permitido solo para "·" separador y "●" indicador de cliente activo. Los iconos del mockup original (emoji) se reemplazan por Lucide.

## Sin logo

Las fuentes no incluyen logotipo. La marca se compone en tipografía: "designio" en Figtree 800, con la "d" o el punto final opcionalmente en --grad-arco (clip de texto). No inventar isotipo.

## Índice

- `styles.css` — entrada global (@imports)
- `tokens/` — colors.css, typography.css, spacing.css, fonts.css
- `guidelines/` — specimen cards de fundamentos
- `components/core/` — Button, Chip, JourneyBadge, Card, Input, Select, Checkbox, Switch, Tabs, Tag (+ .d.ts, .prompt.md, card)
- `ui_kits/designio/` — pantalla Loop J1–J7 en el sistema
- `SKILL.md` — uso como Agent Skill

### Intentional additions
- JourneyBadge y Chip (estados canónicos): primitivas propias del dominio del loop, no existen en fuente previa porque el design system es nuevo.
