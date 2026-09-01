---
title: "SPEC-01 — Workspace, roles y portal"
type: product-spec
author: "Whitespace — producto"
date: 2026-09-01
version: "0.1"
status: draft
language: es
audience: engineering
tags: [spec, workspace, roles, portal, tenancy, auditoria]
summary: "Especificación del workspace propiedad del cliente, la matriz de roles y permisos, el portal de comentarios y aprobaciones, la auditoría y el ciclo de vida comercial (continuidad o exportación)."
---

# SPEC-01 — Workspace, roles y portal

## Propósito

Materializar el modelo de propiedad y operación (§13, ADR-0011): la organización cliente es dueña del workspace y sus datos; la boutique opera; el portal convierte cada gate en un momento de co-creación auditado.

## Alcance MVP

| Incluido | Fuera del MVP |
|---|---|
| Un workspace por cliente; creación por Whitespace | Self-service de creación de workspaces |
| Matriz de roles fija (§13.2) con permisos a nivel de objeto | Roles personalizados por cliente |
| Portal: comentarios y aprobaciones de gate dentro del workspace | Notificaciones multicanal avanzadas (solo email básico en MVP) |
| Auditoría append-only de accesos, aprobaciones, cambios y acciones AI | SSO corporativo (evaluable según piloto) |
| Exportación completa del workspace y borrado acordado | Multi-boutique (§13.1) |
| Segmentos transversales del cliente | — |

## Objetos del dominio

`Workspace`, `Miembro`, `Rol`, `Segmento`, `RegistroAuditoría`, `Aprobación` (consumida por SPEC-04). Ver CTX-01 en `docs/01-ddd/domain-model.md`.

## Requisitos funcionales

| ID | Requisito |
|---|---|
| RF-01.1 | Crear un workspace a nombre de una organización cliente, con la organización como propietaria y la boutique como operadora autorizada (roles distintos, nunca sinónimos) |
| RF-01.2 | Invitar miembros con exactamente un rol de la matriz: sponsor, stakeholder, admin-cliente, lead-boutique, diseñador; el rol `agente-AI` existe solo para actores de plataforma |
| RF-01.3 | Aplicar permisos a nivel de objeto: un stakeholder ve su reto/servicio; el sponsor ve el workspace; la boutique opera todo el workspace durante el engagement |
| RF-01.4 | El admin del cliente gestiona los accesos de su organización sin intervención de la boutique |
| RF-01.5 | Portal: todo objeto presentable (reto, gate, design version, post mortem) admite comentarios con hilo, y las aprobaciones de gate se ejecutan dentro con identidad, rol y timestamp |
| RF-01.6 | Toda acción de escritura, aprobación y acción AI genera un registro de auditoría append-only consultable por el admin del cliente y la boutique |
| RF-01.7 | Definir segmentos transversales del cliente (nombre, definición, estado) referenciables desde arquetipos, evidencia y métricas |
| RF-01.8 | Exportación completa del workspace (objetos, derivados, evidencia con sus archivos, auditoría) en formatos abiertos; ejecución registrada |
| RF-01.9 | Borrado o archivo posterior a la exportación según el acuerdo, con constancia verificable |
| RF-01.10 | El acceso del cliente no expira automáticamente al cerrar el proyecto: sigue el ciclo comercial (engagement + ventana de medición; después, suscripción o exportación) |

## Criterios de aceptación (selección)

1. **Aprobación auditada** — Dado un gate presentado, cuando el sponsor lo aprueba en el portal, entonces queda registro de quién, con qué rol, cuándo y sobre qué versión del checklist; el mismo intento por un rol sin permiso se rechaza (SYS-12, SYS-18).
2. **Aislamiento** — Dado un usuario de un workspace A, cuando consulta cualquier recurso de un workspace B, entonces recibe "no existe" (sin filtración de existencia) y el intento queda auditado (SYS-01, SYS-02).
3. **Exportación digna** — Dado un workspace con un reto cerrado, cuando el admin ejecuta la exportación, entonces el paquete contiene el 100% del catálogo de objetos del workspace (verificado contra manifiesto) incluida la auditoría (SYS-04).

## Invariantes aplicables

SYS-01, SYS-02, SYS-04, SYS-12 (lado permisos), SYS-18.

## Dependencias y métricas

- Depende de: — (base de todo). La consumen todas las demás specs.
- Métricas (§17): adopción del portal (% de aprobaciones y comentarios dentro de la plataforma; alarma: aprobaciones por correo/PDF); % de clientes que ejecutan exportación.

## Riesgos

| Riesgo | Mitigación |
|---|---|
| El sponsor aprueba fuera del portal (correo) | El acta del gate vive en el portal; el lead registra la aprobación con evidencia adjunta y el hecho cuenta en la métrica de adopción como aprobación externa |
| Permisos a nivel de objeto complejizan el MVP | Matriz fija + alcance por reto/servicio; sin roles personalizados |
