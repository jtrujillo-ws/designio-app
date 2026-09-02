# Especificaciones funcionales del MVP

Nueve especificaciones que cubren el alcance del MVP (ADR-0014, prediseño §16): un loop completo, delgado y confiable para un cliente, un servicio y un reto. Cada spec declara propósito, alcance MVP (incluido/fuera), objetos del dominio implicados, requisitos funcionales numerados (`RF-xx.y`), criterios de aceptación, invariantes de sistema aplicables (`SYS-*`, ver `docs/03-invariantes/invariantes.md`), dependencias y métricas de salud relacionadas (§17).

| Spec | Ámbito | Cubre del prediseño |
|---|---|---|
| [SPEC-01](SPEC-01-workspace-roles-portal.md) | Workspace, roles y portal | §13 |
| [SPEC-02](SPEC-02-arbol-grafo-dominio.md) | Árbol de navegación y grafo de dominio | §2 |
| [SPEC-03](SPEC-03-evidencia-importacion.md) | Evidencia, importación y curaduría | §9, §12 |
| [SPEC-04](SPEC-04-metodo-etapas-gates.md) | Método: retos, proyectos, etapas y gates | §5 |
| [SPEC-05](SPEC-05-journeys-tipados-mermaid.md) | Journeys como grafos tipados y render Mermaid | §10 |
| [SPEC-06](SPEC-06-trazabilidad-resultado.md) | Trazabilidad y objetos de resultado | §3 |
| [SPEC-07](SPEC-07-metric-registry-postmortem.md) | Metric Registry, medición y post mortem | §8 |
| [SPEC-08](SPEC-08-capacidades-ai.md) | Capacidades AI por etapa | §4.2, §7 |
| [SPEC-09](SPEC-09-seguridad-confiabilidad.md) | Seguridad, privacidad y confiabilidad AI | §14 |

Regla de corte transversal: si un requisito no lo necesita el loop del piloto (un cliente, un servicio, un reto), no es MVP — se anota en "Fuera del MVP" de su spec. La numeración `RF-<spec>.<n>` es estable para referencia cruzada desde issues y PRs.
