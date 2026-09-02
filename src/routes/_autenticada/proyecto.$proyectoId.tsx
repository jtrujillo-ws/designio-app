import { useState } from 'react';
import type { CSSProperties } from 'react';
import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router';
import { PanelDeHilos } from '@/components/portal/PanelDeHilos';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Select } from '@/components/ui/Select';
import { Tag } from '@/components/ui/Tag';
import { Wordmark } from '@/components/ui/Wordmark';
import { ETIQUETA_ROL } from '@/lib/auth/auth.schemas';
import { evidenciasDelWorkspace } from '@/lib/evidencia/evidencia.functions';
import { ROLES_CURADORES } from '@/lib/evidencia/evidencia.schemas';
import {
  aprobarGateDeProyecto,
  marcarItemDeChecklist,
  proyectoDelMetodo,
} from '@/lib/metodo/metodo.functions';
import { ETIQUETA_PERFIL } from '@/lib/metodo/metodo.plantillas';
import { CLASES_OBJETO_CITABLE, ETIQUETA_CLASE_OBJETO } from '@/lib/metodo/metodo.schemas';
import type {
  ClaseObjetoCitable,
  CriterioDeReto,
  GateDeProyecto,
  ItemDeGate,
  ProyectoMetodo,
} from '@/lib/metodo/metodo.schemas';
import { insightsParaCitar } from '@/lib/insight/insight.functions';
import { gobernanzaDelProyecto } from '@/lib/metodo/gobernanza.functions';
import { SeccionGobernanza } from '@/components/metodo/SeccionGobernanza';
import { hilosDelPortal } from '@/lib/portal/portal.functions';
// El portal ya usa «ObjetoCitable» para OTRA cosa: a qué se ancla un hilo. Aquí se
// necesita qué puede CUMPLIR un ítem del checklist, que no es la misma lista ni la
// misma forma, así que se importa con su nombre y el de aquí se llama distinto.
import type { HiloDeObjeto, ObjetoCitable as AnclaDeHilo } from '@/lib/portal/portal.schemas';

/** Lo que un ítem del checklist puede citar: evidencia curada, insight validado o
 * decisión vigente (RF-04.5). Un insight propuesto no cuenta — la suficiencia se
 * apoya en lo que alguien ya sostuvo con citas. */
export type ObjetoCitable = {
  clase: ClaseObjetoCitable;
  id: string;
  titulo: string;
  /** Solo la evidencia lleva derechos de uso (SPEC-03): un insight o una decisión son
   * razonamiento propio del workspace. `citable: false` deshabilita la opción con su
   * motivo a la vista; el bloqueo real lo impone el guard de la base. */
  citable?: boolean;
  motivoBloqueo?: string | null;
};

/**
 * Pantalla del método (SPEC-04): las 8 etapas canónicas con su gate, checklist de
 * suficiencia y aprobación por rol. El estado que gobierna es el de los gates.
 */
const ES_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const Route = createFileRoute('/_autenticada/proyecto/$proyectoId')({
  loaderDeps: ({ search }) => ({ ws: search.ws }),
  loader: async ({ context, params }) => {
    const workspaceId = context.membresiaActiva?.workspaceId;
    // Un id no-uuid en la URL (enlace editado/truncado) es "no existe", no un crash
    // del validador de la server function contra el error boundary por defecto.
    if (!workspaceId || !ES_UUID.test(params.proyectoId)) return null;
    const [proyecto, lista, gobernanza, insights] = await Promise.all([
      proyectoDelMetodo({ data: { workspaceId, proyectoId: params.proyectoId } }),
      evidenciasDelWorkspace({ data: { workspaceId } }),
      gobernanzaDelProyecto({ data: { workspaceId, proyectoId: params.proyectoId } }),
      // Proyección mínima a propósito: esta pantalla solo cita insights, no los muestra.
      // La ficha completa (afirmaciones, citas, contradicciones) vive en /insights.
      insightsParaCitar({ data: { workspaceId } }),
    ]);
    if (!proyecto) return null;
    // Los hilos del portal cuelgan del proyecto y de sus gates, y los ids de los gates
    // solo se conocen tras cargar el método: es una segunda ida deliberada, no una
    // carrera — y una sola para los nueve objetos de la pantalla.
    const portal = await hilosDelPortal({
      data: {
        workspaceId,
        objetos: [
          { tipo: 'proyecto', id: proyecto.id },
          ...proyecto.gates.map((g) => ({ tipo: 'gate_instancia' as const, id: g.id })),
        ],
      },
    });
    // La lista de objetos citables se arma aquí, no en la base: cada fuente ya tiene su
    // propia proyección con RLS aplicada y su propio corte (las evidencias vienen
    // recortadas a las 200 más recientes, con aviso).
    const citables: ObjetoCitable[] = [
      ...(lista?.evidencias ?? []).map((e) => ({
        clase: 'evidencia' as const,
        id: e.id,
        titulo: e.titulo,
        citable: e.citable,
        motivoBloqueo: e.motivoBloqueo,
      })),
      ...insights.insights.map((i) => ({
        clase: 'insight' as const,
        id: i.id,
        titulo: i.titulo,
      })),
      ...(gobernanza?.decisiones ?? [])
        .filter((d) => d.estado === 'vigente')
        .map((d) => ({ clase: 'decision' as const, id: d.id, titulo: d.titulo })),
    ];
    return {
      workspaceId,
      proyecto,
      citables,
      hayMasEvidencias: lista?.hayMas ?? false,
      hayMasInsights: insights.hayMas,
      gobernanza: gobernanza ?? {
        decisiones: [],
        arquetipos: [],
        reaperturas: [],
        segmentosDisponibles: [],
      },
      insightsValidados: insights.insights,
      hilos: portal?.hilos ?? [],
      hayMasHilos: portal?.hayMas ?? false,
    };
  },
  component: PantallaProyecto,
});

const micro: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontWeight: 500,
  fontSize: 11,
  letterSpacing: '.08em',
  textTransform: 'uppercase',
  color: 'var(--text-muted)',
};

const COLOR_ITEM: Record<ItemDeGate['estado'], string> = {
  pendiente: 'var(--warn)',
  cumplido: 'var(--accent)',
  na: 'var(--text-faint)',
};

/** Los hilos llegan en UNA consulta para toda la pantalla; cada tarjeta se queda con los
 * suyos (RF-01.5: el hilo pertenece al objeto, no a la pantalla). */
function hilosDe(hilos: HiloDeObjeto[], tipo: AnclaDeHilo, id: string): HiloDeObjeto[] {
  return hilos.filter((h) => h.objetoTipo === tipo && h.objetoId === id);
}

/** Espejo cliente del predicado SYS-22 de aprobarGate — solo informa la etiqueta de
 * G0; la exigencia real vive en el servidor y en la política. */
function criteriosCompletos(criterios: CriterioDeReto[]): boolean {
  return (
    criterios.length > 0 &&
    criterios.every(
      (c) =>
        c.kpi.trim() !== '' &&
        c.definicion.trim() !== '' &&
        c.objetivo.trim() !== '' &&
        c.ventanaDias !== null &&
        (((c.lineaBaseValor ?? '').trim() !== '' && c.lineaBaseFecha !== null) ||
          c.lineaBasePlan.trim() !== ''),
    )
  );
}

function PantallaProyecto() {
  const datos = Route.useLoaderData();
  const { membresiaActiva } = Route.useRouteContext();
  const navigate = useNavigate();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const rol = membresiaActiva?.rol ?? '';

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-app)' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '14px 28px',
          background: 'var(--surface)',
          borderBottom: '1px solid var(--border)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <Wordmark />
          <span style={{ font: '600 13px var(--font-sans)', color: 'var(--text-body)' }}>
            {datos ? `${datos.proyecto.codigo} · Método y gates` : 'Proyecto'}
          </span>
        </div>
        <Button variant="ghost" size="sm" onClick={() => navigate({ to: '/app' })}>
          ← Volver al loop
        </Button>
      </div>

      <main style={{ maxWidth: 900, margin: '0 auto', padding: '28px 24px 60px', display: 'flex', flexDirection: 'column', gap: 18 }}>
        {!datos && (
          <Card style={{ padding: 24 }}>
            <span style={{ font: '400 13.5px var(--font-sans)', color: 'var(--text-muted)' }}>
              El proyecto no existe en tu workspace.
            </span>
          </Card>
        )}
        {datos && (
          <>
            <EncabezadoProyecto
              proyecto={datos.proyecto}
              workspaceId={datos.workspaceId}
              hilos={hilosDe(datos.hilos, 'proyecto', datos.proyecto.id)}
              rol={rol}
              onCambio={() => router.invalidate()}
            />
            {error && (
              <span role="alert" style={{ font: '500 13px var(--font-sans)', color: 'var(--danger)' }}>
                {error}
              </span>
            )}
            {/* La consulta del portal está acotada: decirlo es preferible a mostrar una
                conversación incompleta como si fuera toda. */}
            {datos.hayMasHilos && (
              <span style={{ font: '400 12.5px var(--font-sans)', color: 'var(--text-faint)' }}>
                Esta vista muestra los hilos más recientes del proyecto y sus gates; hay más
                en el portal.
              </span>
            )}
            {datos.proyecto.etapas.map((etapa) => {
              const gate = datos.proyecto.gates.find((g) => g.numero === etapa.numero);
              return (
                <EtapaConGate
                  key={etapa.id}
                  workspaceId={datos.workspaceId}
                  hilos={gate ? hilosDe(datos.hilos, 'gate_instancia', gate.id) : []}
                  nombreEtapa={`${etapa.numero} · ${etapa.nombre}`}
                  estadoEtapa={etapa.estado}
                  gate={gate}
                  citables={datos.citables}
                  hayMasEvidencias={datos.hayMasEvidencias}
                  hayMasInsights={datos.hayMasInsights}
                  rol={rol}
                  criteriosListosG0={criteriosCompletos(datos.proyecto.reto.criterios)}
                  anterioresAprobados={datos.proyecto.gates
                    .filter((g2) => g2.numero < etapa.numero)
                    .every((g2) => g2.estado === 'aprobado')}
                  onCambio={() => router.invalidate()}
                  onError={setError}
                />
              );
            })}
            <SeccionGobernanza
              workspaceId={datos.workspaceId}
              proyecto={datos.proyecto}
              gobernanza={datos.gobernanza}
              insightsValidados={datos.insightsValidados}
              hayMasInsights={datos.hayMasInsights}
              evidencias={datos.citables.filter((o) => o.clase === 'evidencia')}
              hayMasEvidencias={datos.hayMasEvidencias}
              rol={rol}
              onCambio={() => router.invalidate()}
              onError={setError}
            />
          </>
        )}
      </main>
    </div>
  );
}

function EncabezadoProyecto({
  proyecto,
  workspaceId,
  hilos,
  rol,
  onCambio,
}: {
  proyecto: ProyectoMetodo;
  workspaceId: string;
  hilos: HiloDeObjeto[];
  rol: string;
  onCambio: () => Promise<void>;
}) {
  const gatesAprobados = proyecto.gates.filter((g) => g.estado === 'aprobado').length;
  return (
    <Card style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ font: '800 20px var(--font-sans)', color: 'var(--ink)' }}>
          {proyecto.codigo} {proyecto.titulo}
        </span>
        <Tag>Perfil {ETIQUETA_PERFIL[proyecto.perfil]}</Tag>
        <Tag>{proyecto.estado}</Tag>
        <span style={{ font: '600 12px var(--font-mono)', color: 'var(--accent)' }}>
          {gatesAprobados}/8 gates
        </span>
      </div>
      <span style={{ font: '400 13px var(--font-sans)', color: 'var(--text-muted)' }}>
        Reto {proyecto.reto.codigo} · {proyecto.reto.titulo}
      </span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={micro}>Criterios de éxito (ventana por criterio, SYS-22)</span>
        {proyecto.reto.criterios.length === 0 && (
          <span style={{ font: '400 12.5px var(--font-sans)', color: 'var(--warn)' }}>
            Sin criterios definidos: G0 no podrá aprobarse.
          </span>
        )}
        {proyecto.reto.criterios.map((c) => (
          <div key={c.id} style={{ font: '400 12.5px/1.5 var(--font-sans)', color: 'var(--text-body)' }}>
            <strong>{c.kpi}</strong>
            {c.objetivo ? ` → ${c.objetivo}` : ''}
            {' · '}
            {c.lineaBaseValor
              ? `base ${c.lineaBaseValor}${c.lineaBaseFecha ? ` (${c.lineaBaseFecha})` : ''}`
              : c.lineaBasePlan
                ? 'base con plan'
                : 'sin línea base'}
            {' · '}
            {c.ventanaDias ? `ventana ${c.ventanaDias} días` : 'SIN VENTANA'}
            {/* La definición ES lo que el sponsor certifica en G0: sin ella a la
                vista, aprobaría un KPI cuyo cálculo nunca leyó. */}
            {c.definicion && (
              <div style={{ font: '400 12px var(--font-sans)', color: 'var(--text-muted)' }}>
                {c.definicion}
              </div>
            )}
          </div>
        ))}
      </div>
      <PanelDeHilos
        workspaceId={workspaceId}
        objeto={{ tipo: 'proyecto', id: proyecto.id }}
        hilos={hilos}
        rol={rol}
        onCambio={onCambio}
      />
    </Card>
  );
}

function EtapaConGate({
  workspaceId,
  hilos,
  nombreEtapa,
  estadoEtapa,
  gate,
  citables,
  hayMasEvidencias,
  hayMasInsights,
  rol,
  criteriosListosG0,
  anterioresAprobados,
  onCambio,
  onError,
}: {
  workspaceId: string;
  /** Hilos del portal sobre ESTE gate: el momento de co-creación de RF-01.5. */
  hilos: HiloDeObjeto[];
  nombreEtapa: string;
  estadoEtapa: string;
  gate: GateDeProyecto | undefined;
  citables: ObjetoCitable[];
  hayMasEvidencias: boolean;
  hayMasInsights: boolean;
  rol: string;
  /** SYS-22 en la etiqueta: G0 no está «listo» sin criterios completos. */
  criteriosListosG0: boolean;
  /** Los gates ordenan el método: el N no está «listo» con anteriores pendientes. */
  anterioresAprobados: boolean;
  onCambio: () => Promise<void>;
  onError: (e: string | null) => void;
}) {
  const [aprobando, setAprobando] = useState(false);
  if (!gate) return null;
  const puedeAprobar = rol === gate.rolAprobador;
  const pendientes = gate.items.filter((i) => i.estado === 'pendiente').length;

  async function aprobar() {
    if (!gate) return;
    setAprobando(true);
    onError(null);
    try {
      const r = await aprobarGateDeProyecto({ data: { workspaceId, gateId: gate.id } });
      if (r.ok) await onCambio();
      else onError(r.error);
    } catch {
      onError('No se pudo aprobar el gate; intenta de nuevo');
    } finally {
      setAprobando(false);
    }
  }

  return (
    <Card style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ font: '700 14.5px var(--font-sans)', color: 'var(--ink)', flex: 1, minWidth: 220 }}>
          {nombreEtapa}
        </span>
        <span style={{ ...micro, fontSize: 10 }}>{estadoEtapa}</span>
        <Tag>
          G{gate.numero} · {ETIQUETA_ROL[gate.rolAprobador] ?? gate.rolAprobador}
        </Tag>
        {gate.estado === 'aprobado' ? (
          <span style={{ font: '600 12px var(--font-sans)', color: 'var(--accent)' }}>
            Aprobado{gate.aprobadoEn ? ` · ${gate.aprobadoEn.slice(0, 10)}` : ''}
          </span>
        ) : (
          <span style={{ font: '600 12px var(--font-sans)', color: 'var(--warn)' }}>
            {pendientes > 0
              ? `${pendientes} pendientes`
              : !anterioresAprobados
                ? 'Esperando los gates anteriores'
                : gate.numero === 0 && !criteriosListosG0
                  ? 'Faltan criterios completos (SYS-22)'
                  : 'Listo para aprobar'}
          </span>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {gate.items.map((item) => (
          <ItemChecklist
            key={item.id}
            workspaceId={workspaceId}
            item={item}
            citables={citables}
            hayMasEvidencias={hayMasEvidencias}
            hayMasInsights={hayMasInsights}
            editable={gate.estado === 'pendiente'}
            puedeCurar={(ROLES_CURADORES as readonly string[]).includes(rol)}
            puedeNa={rol === gate.rolAprobador}
            onCambio={onCambio}
            onError={onError}
          />
        ))}
      </div>

      {gate.estado === 'pendiente' && puedeAprobar && (
        <div>
          <Button size="sm" disabled={aprobando} onClick={() => void aprobar()}>
            {aprobando ? 'Aprobando…' : `Aprobar G${gate.numero}`}
          </Button>
        </div>
      )}
      {gate.estado === 'pendiente' && !puedeAprobar && (
        <span style={{ font: '400 12px var(--font-sans)', color: 'var(--text-faint)' }}>
          Aprueba {ETIQUETA_ROL[gate.rolAprobador] ?? gate.rolAprobador} en el portal.
        </span>
      )}

      {/* El gate es EL momento de co-creación (SPEC-01): el cliente discute aquí, no por
          correo — y un gate aprobado conserva su conversación (los hilos no se congelan
          con él: la decisión es inmutable, la conversación sobre ella sigue viva). */}
      <PanelDeHilos
        workspaceId={workspaceId}
        objeto={{ tipo: 'gate_instancia', id: gate.id }}
        hilos={hilos}
        rol={rol}
        onCambio={onCambio}
      />
    </Card>
  );
}

function ItemChecklist({
  workspaceId,
  item,
  citables,
  hayMasEvidencias,
  hayMasInsights,
  editable,
  puedeCurar,
  puedeNa,
  onCambio,
  onError,
}: {
  workspaceId: string;
  item: ItemDeGate;
  citables: ObjetoCitable[];
  hayMasEvidencias: boolean;
  hayMasInsights: boolean;
  editable: boolean;
  /** Cumplido/pendiente: curadores (lead/diseñador). N/A —y revertirlo— : el rol aprobador del gate. */
  puedeCurar: boolean;
  puedeNa: boolean;
  onCambio: () => Promise<void>;
  onError: (e: string | null) => void;
}) {
  const [enlazando, setEnlazando] = useState(false);
  // Un solo control para los tres tipos: el value viaja como «clase:id» y se parte al
  // enviar. Evita un segundo selector de clase que el usuario tendría que sincronizar.
  const [objetoSel, setObjetoSel] = useState('');
  const [naJustificacion, setNaJustificacion] = useState('');
  const [marcandoNa, setMarcandoNa] = useState(false);
  const [ocupado, setOcupado] = useState(false);

  async function marcar(accion: Parameters<typeof marcarItemDeChecklist>[0]['data']['accion']) {
    setOcupado(true);
    onError(null);
    try {
      const r = await marcarItemDeChecklist({ data: { workspaceId, itemId: item.id, accion } });
      if (r.ok) {
        setEnlazando(false);
        setMarcandoNa(false);
        setNaJustificacion('');
        await onCambio();
      } else {
        onError(r.error);
      }
    } catch {
      onError('No se pudo marcar el ítem; intenta de nuevo');
    } finally {
      setOcupado(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 10px', background: 'var(--surface-sunken)', borderRadius: 'var(--r-sm)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ font: '400 13px var(--font-sans)', color: 'var(--text-body)', flex: 1, minWidth: 200 }}>
          {item.texto}
        </span>
        <span style={{ font: '600 11.5px var(--font-sans)', color: COLOR_ITEM[item.estado] }}>
          {item.estado === 'cumplido'
            ? `cumplido · ${item.objetoClase ? ETIQUETA_CLASE_OBJETO[item.objetoClase] : 'objeto'}: ${item.objetoTitulo ?? '—'}`
            : item.estado === 'na'
              ? 'N/A aprobado'
              : 'pendiente'}
        </span>
      </div>
      {item.estado === 'na' && item.naJustificacion && (
        <span style={{ font: '400 12px var(--font-sans)', color: 'var(--text-faint)' }}>
          {item.naJustificacion}
        </span>
      )}
      {editable && item.estado === 'pendiente' && !enlazando && !marcandoNa && (puedeCurar || puedeNa) && (
        <div style={{ display: 'flex', gap: 8 }}>
          {puedeCurar && (
            <Button size="sm" variant="secondary" disabled={ocupado} onClick={() => setEnlazando(true)}>
              Enlazar objeto
            </Button>
          )}
          {puedeNa && (
            <Button size="sm" variant="ghost" disabled={ocupado} onClick={() => setMarcandoNa(true)}>
              Marcar N/A
            </Button>
          )}
        </div>
      )}
      {editable && item.estado !== 'pendiente' && (item.estado === 'na' ? puedeNa : puedeCurar) && (
        <div>
          <Button size="sm" variant="ghost" disabled={ocupado} onClick={() => void marcar({ tipo: 'pendiente' })}>
            Volver a pendiente
          </Button>
        </div>
      )}
      {editable && enlazando && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <Select value={objetoSel} onChange={(e) => setObjetoSel(e.target.value)} style={{ minWidth: 300 }}>
            <option value="">Elige el objeto que lo cumple…</option>
            {CLASES_OBJETO_CITABLE.map((clase) => {
              const delGrupo = citables.filter((o) => o.clase === clase);
              if (delGrupo.length === 0) return null;
              return (
                <optgroup key={clase} label={ETIQUETA_CLASE_OBJETO[clase]}>
                  {/* Los derechos restringen el uso aguas abajo (RF-03.10, SYS-14): lo
                      que no puede citarse se muestra deshabilitado y CON el motivo,
                      nunca oculto — que falte una dimensión es información de curaduría,
                      no ruido. El bloqueo REAL lo impone la base; esto lo hace legible. */}
                  {delGrupo.map((o) => (
                    <option
                      key={`${o.clase}:${o.id}`}
                      value={`${o.clase}:${o.id}`}
                      disabled={o.citable === false}
                    >
                      {o.citable === false
                        ? `${o.titulo} — sin derechos: ${
                            o.motivoBloqueo ?? 'faltan derechos de uso para el ámbito cliente'
                          }`
                        : o.titulo}
                    </option>
                  ))}
                </optgroup>
              );
            })}
            {hayMasEvidencias && (
              <option value="" disabled>
                … hay más evidencias (solo se listan las 200 más recientes)
              </option>
            )}
            {hayMasInsights && (
              <option value="" disabled>
                … hay más insights validados (solo se listan los 200 más recientes)
              </option>
            )}
          </Select>
          <Button
            size="sm"
            disabled={ocupado || objetoSel === ''}
            onClick={() => {
              // El valor viene del DOM: se resuelve contra la MISMA lista con la que se
              // pintó el picker en vez de partirlo y castearlo. Así un valor manipulado
              // —o rancio, porque la lista se recarga en cada invalidate— da un mensaje
              // que se entiende y no un error de constraint desde la base.
              const elegido = citables.find((o) => `${o.clase}:${o.id}` === objetoSel);
              if (!elegido) {
                setObjetoSel('');
                onError('Ese objeto ya no está en la lista: vuelve a elegirlo');
                return;
              }
              void marcar({
                tipo: 'cumplido',
                objetoClase: elegido.clase,
                objetoId: elegido.id,
              });
            }}
          >
            Cumplido
          </Button>
          <Button size="sm" variant="ghost" disabled={ocupado} onClick={() => setEnlazando(false)}>
            Cancelar
          </Button>
        </div>
      )}
      {editable && marcandoNa && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            value={naJustificacion}
            onChange={(e) => setNaJustificacion(e.target.value)}
            placeholder="Justificación del N/A (la aprueba el rol del gate)"
            maxLength={2000}
            style={{
              flex: 1,
              minWidth: 260,
              font: '400 13px var(--font-sans)',
              padding: '7px 10px',
              borderRadius: 'var(--r-sm)',
              border: '1px solid var(--border)',
              background: 'var(--surface)',
              color: 'var(--ink)',
            }}
          />
          <Button
            size="sm"
            disabled={ocupado || naJustificacion.trim() === ''}
            onClick={() => void marcar({ tipo: 'na', justificacion: naJustificacion.trim() })}
          >
            Confirmar N/A
          </Button>
          <Button size="sm" variant="ghost" disabled={ocupado} onClick={() => setMarcandoNa(false)}>
            Cancelar
          </Button>
        </div>
      )}
    </div>
  );
}
