import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { Button } from '@/components/ui/Button';
import { Tabs } from '@/components/ui/Tabs';
import { Wordmark } from '@/components/ui/Wordmark';
import type { JourneyN } from '@/components/ui/JourneyBadge';
import { ETIQUETA_ROL, ROLES_QUE_INVITAN } from '@/lib/auth/auth.schemas';
import { cerrarSesion } from '@/lib/auth/auth.functions';
import type {
  ArbolWorkspace,
  ProyectoArbol,
  RetoArbol,
  ServicioArbol,
} from '@/lib/arbol/arbol.schemas';
import {
  JOURNEYS_DEL_LOOP,
  destinoDeJourney,
  journeyDelLoop,
  type JourneyLoop,
} from '@/lib/loop/loop-data';
import {
  JOURNEYS,
  loopDeProyecto,
  marcaDeReto,
  proyectoActualDe,
  proyectoActualDelReto,
  type EstadoDelLoop,
  type EstadoJourney,
} from '@/lib/loop/loop-estado';
import type { GatesDeProyecto, ResumenDelLoop } from '@/lib/loop/loop.schemas';
import { etiquetaDeDestino, type Destino } from '@/lib/destinos';
import { EnlaceA, navegarA } from '@/components/ui/EnlaceA';
import { Buscador } from '@/components/loop/Buscador';
import { NuevoServicio } from '@/components/loop/NuevoServicio';
import { ROLES_ALTA_SERVICIO } from '@/lib/arbol/arbol.schemas';
import { ROLES_AUDITORIA } from '@/lib/portal/portal.schemas';
import { ROLES_DISPOSICION } from '@/lib/disposicion/disposicion.schemas';
import { ROLES_CURADORES } from '@/lib/evidencia/evidencia.schemas';

/**
 * Pantalla Loop J1–J7 — dirección 3a del handoff «Loop · impacto visual»: lateral en negro
 * violeta que navega el árbol cliente → servicios → retos, y el loop narrado solo en el
 * contenido (cabecera de arco, spotlight del journey en curso, «Te toca a ti», los siete
 * recorridos).
 *
 * Regla de propiedad del chrome: el lateral posee marca, cliente y usuario; la topbar no
 * repite ninguno de los tres, y la ruta se imprime solo en el main.
 */

/** Lo que la pantalla necesita del usuario autenticado (lo publica el guard de /_autenticada). */
export type MembresiaLoop = { workspaceId: string; workspaceNombre: string; rol: string };
export type UsuarioLoop = {
  id: string;
  nombre: string;
  membresias: MembresiaLoop[];
};

const TAB_LOOP = 'Loop J1–J7';

/** Blanco de la tinta inversa, a las opacidades que fija el sistema sobre `--brand-ink`. */
const claro = (a: number) => `rgba(247,247,249,${a})`;

/**
 * Las vistas del servicio, cada una con la pantalla real a la que lleva. La referencia hifi
 * traía además «Servicio» y «Reto R-01»: no existen como pantalla, y una pestaña que no abre
 * nada es justo la queja que trajo este cambio, así que no se pintan hasta que existan. La
 * pestaña del proyecto solo aparece cuando el servicio tiene uno, y con su código real.
 */
function vistasDelServicio(
  proyecto: ProyectoArbol | null,
): { etiqueta: string; destino: Destino | null }[] {
  return [
    { etiqueta: TAB_LOOP, destino: null },
    ...(proyecto
      ? [
          {
            etiqueta: `Proyecto ${proyecto.codigo}`,
            destino: destinoDeJourney('proyecto', proyecto.id),
          },
        ]
      : []),
    { etiqueta: 'Journey / Blueprint', destino: { to: '/journeys' } },
    { etiqueta: 'Portal · Aprobación G5', destino: { to: '/design-versions' } },
    { etiqueta: 'Importación', destino: { to: '/importacion' } },
  ];
}

const mono: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontWeight: 500,
  fontSize: 11,
  letterSpacing: '.08em',
  textTransform: 'uppercase',
};

/** Etiqueta de sección del main: mono 10.5px, tracking .1em, `--text-faint`. */
const etiquetaSeccion: CSSProperties = {
  ...mono,
  fontSize: 10.5,
  letterSpacing: '.1em',
  color: 'var(--text-faint)',
};

export function LoopScreen({
  usuario,
  membresiaActiva,
  arbol,
  resumen,
}: {
  usuario: UsuarioLoop;
  membresiaActiva: MembresiaLoop | undefined;
  arbol: ArbolWorkspace | null;
  resumen: ResumenDelLoop | null;
}) {
  const navigate = useNavigate();
  const membresia = membresiaActiva ?? usuario.membresias[0];
  // El servicio del que habla la pantalla lo dice la proyección: el pedido en la ruta si es
  // de este workspace, y si no el primero. Con el árbol delante y sin resumen, el primero.
  const servicio =
    arbol?.servicios.find((s) => s.id === resumen?.servicioId) ?? arbol?.servicios[0] ?? null;
  // El proyecto «actual» del servicio: el del reto activo o en medición (proyectoActualDe),
  // que es lo que abren la pestaña de proyecto y las tarjetas de los journeys del método, y
  // el que da su estado al loop. La proyección elige con la misma regla.
  const proyecto = servicio ? proyectoActual(servicio) : null;
  const proyectos = new Map<string, GatesDeProyecto>(
    (resumen?.proyectos ?? []).map((p) => [p.proyectoId, p]),
  );
  const hayEvidencia = resumen?.hayEvidencia ?? false;
  const arranque = { hayEvidencia, hayServicio: servicio !== null };
  const loop = loopDeProyecto(proyecto ? (proyectos.get(proyecto.id) ?? null) : null, arranque);
  const vistas = vistasDelServicio(proyecto);

  // Un tramo de la barra del arco ancla a la tarjeta de su journey y la resalta 1,2 s.
  const [destacado, setDestacado] = useState<JourneyN | null>(null);
  const temporizador = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (temporizador.current) clearTimeout(temporizador.current);
    },
    [],
  );
  function irAJourney(j: JourneyN) {
    document
      .getElementById(idDeTarjeta(j))
      ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    setDestacado(j);
    if (temporizador.current) clearTimeout(temporizador.current);
    temporizador.current = setTimeout(() => setDestacado(null), 1200);
  }

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-app)' }}>
      <Topbar workspaceId={membresia?.workspaceId ?? null} rol={membresia?.rol ?? ''} />
      <div className="loop-cuerpo" style={{ display: 'flex', minHeight: 820 }}>
        <Lateral
          usuario={usuario}
          membresia={membresia}
          arbol={arbol}
          resumen={resumen}
          servicioActual={servicio}
          proyectos={proyectos}
          hayEvidencia={hayEvidencia}
        />
        <main
          style={{
            flex: 1,
            minWidth: 0,
            padding: '24px 30px 34px',
            display: 'flex',
            flexDirection: 'column',
            gap: 22,
          }}
        >
          <div style={{ ...mono, color: 'var(--text-muted)' }}>
            {arbol?.workspaceNombre ?? membresia?.workspaceNombre ?? '—'} / Servicios /{' '}
            <span style={{ color: 'var(--ink)' }}>{servicio?.nombre ?? 'Sin servicios aún'}</span>
          </div>
          <Tabs
            items={vistas.map((v) => v.etiqueta)}
            value={TAB_LOOP}
            label="Vistas del servicio"
            onChange={(etiqueta) => {
              const destino = vistas.find((v) => v.etiqueta === etiqueta)?.destino;
              if (destino) void navegarA(navigate, destino);
            }}
          />
          <CabeceraDeArco
            loop={loop}
            servicio={servicio}
            proyecto={proyecto}
            resumen={resumen}
            onTramo={irAJourney}
          />
          <div style={{ display: 'grid', gridTemplateColumns: '1.6fr 1fr', gap: 16 }}>
            <Spotlight
              loop={loop}
              proyecto={proyecto}
              resumen={resumen}
              hayServicio={servicio !== null}
            />
            <TeTocaATi
              loop={loop}
              servicio={servicio}
              resumen={resumen}
              proyecto={proyecto}
              rol={membresia?.rol ?? ''}
            />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <span style={etiquetaSeccion}>Los siete recorridos</span>
            <div className="loop-recorridos">
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(7, minmax(0, 1fr))',
                  gap: 10,
                }}
              >
                {JOURNEYS_DEL_LOOP.map((jl) => (
                  <JourneyCard
                    key={jl.j}
                    jl={jl}
                    estado={loop.journeys[jl.j]}
                    proyecto={proyecto}
                    destacada={destacado === jl.j}
                    motivoJ7={porQueJ7Cerrado(loop)}
                  />
                ))}
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

function idDeTarjeta(j: JourneyN): string {
  return `journey-j${j}`;
}

/**
 * Por qué J7 sigue cerrado, en las dos longitudes que la pantalla usa. Con un gate abierto
 * falta aprobar G7; con los ocho aprobados falta que la medición se abra y termine (que
 * cierre su última ventana de KPI): hasta entonces el outcome review no se puede abrir.
 */
function porQueJ7Cerrado(loop: EstadoDelLoop): { corto: string; largo: string } {
  if (loop.gateAbierto !== null) {
    return {
      corto: 'Se abre al aprobar G7',
      largo: `El post mortem se abre cuando G7 quede aprobado (hoy el gate abierto es G${loop.gateAbierto}): hasta entonces no hay veredicto que dictar`,
    };
  }
  return {
    corto: 'Se abre al terminar la medición',
    largo:
      'G7 está aprobado: el post mortem se abre cuando la medición esté abierta y cierre su última ventana de KPI',
  };
}

/** El proyecto actual de un servicio del árbol, con la regla compartida con la proyección. */
function proyectoActual(servicio: ServicioArbol): ProyectoArbol | null {
  return (
    proyectoActualDe(
      servicio.retos.flatMap((r) =>
        r.proyectos.map((p) => ({ retoEstado: r.estado, proyectoEstado: p.estado, p })),
      ),
    )?.p ?? null
  );
}

// ── Topbar ─────────────────────────────────────────────────────────────────────────────

/**
 * La barra superior ya no lleva marca, cliente ni usuario: los tres viven en el lateral.
 * Queda el buscador y la acción principal del workspace, invitar al cliente, que abre la
 * pantalla de personas donde de verdad se invita.
 */
function Topbar({ workspaceId, rol }: { workspaceId: string | null; rol: string }) {
  const navigate = useNavigate();
  // Invitar es del lead y del admin del cliente (RF-01.2): a los demás no se les ofrece un
  // botón principal cuyo formulario la base rechazaría al enviar.
  const puedeInvitar = (ROLES_QUE_INVITAN as readonly string[]).includes(rol);
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: 14,
        padding: '14px 28px',
        background: 'var(--surface)',
        borderBottom: '1px solid var(--border)',
      }}
    >
      <Buscador workspaceId={workspaceId} />
      {puedeInvitar && (
        <Button
          onClick={() => navigate({ to: '/personas' })}
          style={{
            background: 'var(--brand-ink)',
            color: '#fff',
            fontSize: 12.5,
            padding: '9px 16px',
            whiteSpace: 'nowrap',
          }}
        >
          Invitar al cliente
        </Button>
      )}
    </div>
  );
}

// ── Lateral ─────────────────────────────────────────────────────────────────────────────

function inicialesDe(nombre: string): string {
  const partes = nombre.trim().split(/\s+/);
  return (
    partes
      .slice(0, 2)
      .map((p) => (p[0] ?? '').toUpperCase())
      .join('') || '?'
  );
}

const etiquetaLateral: CSSProperties = {
  ...mono,
  fontSize: 10,
  letterSpacing: '.1em',
  color: claro(0.45),
  padding: '0 8px 8px',
};

const filaLateral: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '8px 10px',
  borderRadius: 9,
  minHeight: 32,
  boxSizing: 'border-box',
  textDecoration: 'none',
  color: claro(0.72),
  font: '500 13px var(--font-sans)',
  // Sin `background` en línea: el fondo base y el hover los pinta `.loop-fila` en la hoja
  // de estilos; un valor aquí anularía el hover. Los estados activos sí lo fijan en línea.
  border: 'none',
  width: '100%',
  textAlign: 'left',
  cursor: 'pointer',
};

const truncado: CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

function Lateral({
  usuario,
  membresia,
  arbol,
  resumen,
  servicioActual,
  proyectos,
  hayEvidencia,
}: {
  usuario: UsuarioLoop;
  membresia: MembresiaLoop | undefined;
  arbol: ArbolWorkspace | null;
  resumen: ResumenDelLoop | null;
  /** El servicio seleccionado (estado de la ruta), ya resuelto por la pantalla. */
  servicioActual: ServicioArbol | null;
  proyectos: ReadonlyMap<string, GatesDeProyecto>;
  hayEvidencia: boolean;
}) {
  const navigate = useNavigate();
  const rol = membresia?.rol ?? '';
  const puedeCrearServicio = (ROLES_ALTA_SERVICIO as readonly string[]).includes(rol);
  // La bandeja la curan la boutique (RF-03.4): su contador es tarea solo para ellos.
  const esCurador = (ROLES_CURADORES as readonly string[]).includes(rol);
  const servicios = arbol?.servicios ?? [];
  // Seleccionar un servicio es navegar: queda en `?servicio=` y los loaders reaccionan.
  function seleccionar(id: string) {
    void navigate({ to: '/app', search: (prev) => ({ ...prev, servicio: id }) });
  }

  // Qué servicios están desplegados. El actual nace abierto; el resto se recuerda por
  // usuario y workspace en el navegador, que es donde vive una preferencia de lectura (la
  // clave lleva al usuario: dos cuentas en el mismo navegador no se pisan la suya). Se lee
  // en un efecto, no en el inicializador: el servidor no tiene localStorage y el primer
  // fotograma tiene que coincidir con el que él pintó.
  // La clave lleva el workspace de la MEMBRESÍA, que existe aunque el árbol no haya llegado:
  // con `arbol?.workspaceId` una carga fallida guardaba la preferencia bajo un workspace vacío.
  const claveExpansion = `designio.loop.expandidos.${usuario.id}.${membresia?.workspaceId ?? ''}`;
  const [expandidos, setExpandidos] = useState<Set<string>>(
    () => new Set(servicioActual ? [servicioActual.id] : []),
  );
  useEffect(() => {
    try {
      const guardado = window.localStorage.getItem(claveExpansion);
      if (guardado) {
        const ids = JSON.parse(guardado) as unknown;
        if (Array.isArray(ids)) {
          setExtra(new Set(ids.filter((x): x is string => typeof x === 'string')));
        }
      }
    } catch {
      // Sin almacenamiento (modo privado, política del navegador): se queda el estado inicial.
    }
  }, [claveExpansion]);
  // Lo recordado se aplica ENCIMA del estado inicial, nunca lo sustituye: un servicio actual
  // recién elegido no se cierra porque una visita anterior lo tuviera cerrado.
  const [extra, setExtra] = useState<Set<string>>(new Set());
  const estaAbierto = (id: string) => expandidos.has(id) || extra.has(id);
  function fijar(siguiente: Set<string>) {
    setExpandidos(siguiente);
    setExtra(new Set());
    try {
      window.localStorage.setItem(claveExpansion, JSON.stringify([...siguiente]));
    } catch {
      // Igual que arriba: recordar es una comodidad, no un contrato.
    }
  }
  function alternar(id: string) {
    const siguiente = new Set([...expandidos, ...extra]);
    if (estaAbierto(id)) siguiente.delete(id);
    else siguiente.add(id);
    fijar(siguiente);
  }
  /** Desplegar sin alternar: lo que hace un servicio recién creado. */
  function abrir(id: string) {
    fijar(new Set([...expandidos, ...extra, id]));
  }

  async function salir() {
    await cerrarSesion();
    await navigate({ to: '/login' });
  }

  function cambiarWorkspace(ws: string) {
    // `ws` viaja pegado a la navegación (retainSearchParams): basta con fijarlo aquí
    // y los loaders de la pantalla actual reaccionan (loaderDeps sobre ws).
    void navigate({ to: '.', search: (prev) => ({ ...prev, ws }) });
  }

  const nombreCliente = arbol?.workspaceNombre ?? membresia?.workspaceNombre ?? 'Sin workspace';
  // El lateral cuenta las aprobaciones que le tocan a QUIEN MIRA: una que espera al sponsor
  // no es una tarea del lead, aunque «Te toca a ti» la nombre para que sepa a quién espera.
  const aprobaciones = (resumen?.aprobaciones ?? []).filter((a) => a.esMia);
  const primeraAprobacion = aprobaciones[0];
  const esBoutique = (ROLES_CURADORES as readonly string[]).includes(rol);

  return (
    <aside
      className="loop-aside"
      style={{
        width: 290,
        flex: 'none',
        background: 'var(--brand-ink)',
        borderRight: '1px solid var(--brand-ink-lift)',
        padding: '20px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        boxSizing: 'border-box',
      }}
    >
      {/* 1. Marca — el lateral es su único dueño en la pantalla. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 8px 16px',
        }}
      >
        <Link to="/app" aria-label="designio · loop del método" style={{ textDecoration: 'none' }}>
          <span className="loop-ancho">
            <Wordmark color="#fff" />
          </span>
          <span className="loop-estrecho">
            <Wordmark color="#fff" corto />
          </span>
        </Link>
        <span
          className="loop-ancho"
          title="⌘K (Ctrl+K) enfoca el buscador"
          style={{ font: '400 13px var(--font-sans)', color: claro(0.5) }}
        >
          ⌘K
        </span>
      </div>

      {/* 2. Organización cliente — el único conmutador de cliente de la pantalla. */}
      <div
        className="loop-conmutador"
        style={{
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: 10,
          borderRadius: 11,
          background: claro(0.09),
          marginBottom: 16,
        }}
      >
        <span
          aria-hidden
          style={{
            width: 28,
            height: 28,
            borderRadius: 8,
            background: 'var(--grad-arco)',
            color: '#fff',
            font: '800 11px/28px var(--font-sans)',
            textAlign: 'center',
            flex: 'none',
          }}
        >
          {inicialesDe(nombreCliente)}
        </span>
        <div
          className="loop-ancho"
          style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}
        >
          <span style={{ font: '700 13px var(--font-sans)', color: '#fff', ...truncado }}>
            {nombreCliente}
          </span>
          <span style={{ font: '400 11px var(--font-sans)', color: claro(0.55), ...truncado }}>
            {servicioActual?.nombre ?? 'Sin servicios aún'}
          </span>
        </div>
        {usuario.membresias.length > 1 ? (
          <>
            <span
              className="loop-ancho"
              aria-hidden
              style={{ font: '400 12px var(--font-sans)', color: claro(0.5) }}
            >
              ▾
            </span>
            {/* El selector nativo cubre la tarjeta entera: la tarjeta ES el conmutador. */}
            <select
              aria-label="Cliente activo"
              value={membresia?.workspaceId ?? ''}
              onChange={(e) => cambiarWorkspace(e.target.value)}
              style={{
                position: 'absolute',
                inset: 0,
                width: '100%',
                height: '100%',
                opacity: 0,
                cursor: 'pointer',
              }}
            >
              {usuario.membresias.map((m) => (
                <option key={m.workspaceId} value={m.workspaceId}>
                  {m.workspaceNombre}
                </option>
              ))}
            </select>
          </>
        ) : null}
      </div>

      {/* 3. Servicios y retos — la función principal del lateral. */}
      <span className="loop-ancho" style={etiquetaLateral}>
        Servicios y retos
      </span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, paddingBottom: 4 }}>
        {servicios.length === 0 && (
          <span
            className="loop-ancho"
            style={{ font: '400 12.5px var(--font-sans)', color: claro(0.45), padding: '6px 10px' }}
          >
            Sin servicios aún
          </span>
        )}
        {servicios.map((s) => {
          const actual = s.id === servicioActual?.id;
          const abiertoAhora = estaAbierto(s.id);
          return (
            <ServicioDelArbol
              key={s.id}
              servicio={s}
              actual={actual}
              abierto={abiertoAhora}
              // Colapsado: se despliega Y se selecciona (handoff). Desplegado y actual: se
              // colapsa. Desplegado y no actual: se selecciona sin tocar la expansión.
              onPulsar={() => {
                if (!abiertoAhora) {
                  alternar(s.id);
                  if (!actual) seleccionar(s.id);
                } else if (actual) {
                  alternar(s.id);
                } else {
                  seleccionar(s.id);
                }
              }}
              proyectos={proyectos}
              hayEvidencia={hayEvidencia}
            />
          );
        })}
        {/* Solo para quien puede dar de alta (lead y admin del cliente): a los demás no se
            les ofrece una fila que la base rechazaría. Al crear, el servicio nuevo pasa a ser
            el seleccionado (la ruta cambia y los loaders recargan el árbol) y nace desplegado. */}
        {puedeCrearServicio && membresia && (
          <NuevoServicio
            workspaceId={membresia.workspaceId}
            onCreado={(servicioId) => {
              abrir(servicioId);
              seleccionar(servicioId);
            }}
          />
        )}
      </div>

      {/* 4. Workspace — destinos reales, con los pendientes que existen. */}
      <span className="loop-ancho" style={{ ...etiquetaLateral, padding: '12px 8px 8px' }}>
        Workspace
      </span>
      <DestinoDelWorkspace to="/importacion" etiqueta="Bandeja de importación" abrev="IMP">
        {esCurador && resumen && resumen.importacionPendientes > 0 && (
          <Contador color="var(--accent)" titulo={`${resumen.importacionPendientes} sin curar`}>
            {resumen.importacionPendientes}
          </Contador>
        )}
      </DestinoDelWorkspace>
      {primeraAprobacion && (
        // No hay pantalla de aprobaciones: la fila abre el proyecto del gate que espera.
        <Link
          className="loop-fila"
          to="/proyecto/$proyectoId"
          params={{ proyectoId: primeraAprobacion.proyectoId }}
          title={`Abrir ${primeraAprobacion.proyectoCodigo} · gate G${primeraAprobacion.numero} espera tu aprobación`}
          aria-label="Aprobaciones"
          style={filaLateral}
        >
          <span className="loop-ancho" style={{ flex: 1, ...truncado }}>
            Aprobaciones
          </span>
          <Abreviatura>APR</Abreviatura>
          <Contador
            color="var(--warn)"
            titulo={`${aprobaciones.length} gate(s) esperando tu aprobación`}
          >
            {aprobaciones.length}
          </Contador>
        </Link>
      )}
      <DestinoDelWorkspace to="/evidencia" etiqueta="Evidencia y derechos de uso" abrev="EVI" />
      <DestinoDelWorkspace to="/insights" etiqueta="Insights y citas" abrev="INS" />
      <DestinoDelWorkspace to="/biblioteca" etiqueta="Biblioteca del cliente" abrev="BIB" />
      <DestinoDelWorkspace to="/journeys" etiqueta="Journeys y blueprints" abrev="JOU" />
      <DestinoDelWorkspace to="/design-versions" etiqueta="Versions y releases" abrev="DVR" />
      <DestinoDelWorkspace to="/propuestas" etiqueta="Propuestas AI" abrev="AI" />
      <DestinoDelWorkspace to="/personas" etiqueta="Personas y permisos" abrev="PER" />
      <DestinoDelWorkspace to="/exportacion" etiqueta="Exportación del workspace" abrev="EXP" />
      {/* Esta puerta NO se condiciona al rol: detrás están las constancias que cada quien
          conserva, y ésas no dependen de ninguna membresía. El rótulo nombra lo que cada
          quien encuentra (ver la historia completa en el commit que la abrió). */}
      <DestinoDelWorkspace
        to="/disposicion"
        etiqueta={
          (ROLES_DISPOSICION as readonly string[]).includes(rol)
            ? 'Disposición del workspace'
            : 'Constancias que conservas'
        }
        abrev="DIS"
      />
      {/* La auditoría es de quienes rinden cuentas (RF-01.6): el enlace no aparece para
          los demás roles y, si lo teclean, la RLS de evento_dominio no les da filas. */}
      {(ROLES_AUDITORIA as readonly string[]).includes(rol) && (
        <DestinoDelWorkspace to="/auditoria" etiqueta="Auditoría" abrev="AUD" />
      )}

      {/* 5. Pie de usuario. */}
      <div
        style={{
          marginTop: 'auto',
          display: 'flex',
          alignItems: 'center',
          gap: 9,
          padding: '12px 8px 0',
          borderTop: `1px solid ${claro(0.14)}`,
        }}
      >
        <span
          aria-hidden
          style={{
            width: 30,
            height: 30,
            borderRadius: '50%',
            background: 'var(--grad-arco)',
            color: '#fff',
            font: '700 11px/30px var(--font-sans)',
            textAlign: 'center',
            flex: 'none',
          }}
        >
          {inicialesDe(usuario.nombre)}
        </span>
        <div
          className="loop-ancho"
          style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}
        >
          <span style={{ font: '600 12.5px var(--font-sans)', color: '#fff', ...truncado }}>
            {usuario.nombre}
          </span>
          <span style={{ font: '400 11px var(--font-sans)', color: claro(0.55), ...truncado }}>
            {membresia
              ? `${ETIQUETA_ROL[membresia.rol] ?? membresia.rol} · ${esBoutique ? 'autorizada' : 'propietaria'}`
              : 'Sin workspace'}
          </span>
        </div>
        <button
          type="button"
          className="loop-ancho loop-fila"
          onClick={salir}
          style={{
            ...filaLateral,
            width: 'auto',
            padding: '6px 8px',
            font: '600 11.5px var(--font-sans)',
            color: claro(0.68),
          }}
        >
          Salir
        </button>
      </div>
      {/* En el riel estrecho el pie no cabe entero: queda el avatar y, debajo, salir. */}
      <button
        type="button"
        className="loop-estrecho loop-fila"
        onClick={salir}
        title="Salir"
        aria-label="Salir"
        style={{
          ...filaLateral,
          // Sin `display` en línea: lo gobierna la clase (oculto en ancho, visible en el riel).
          display: undefined,
          justifyContent: 'center',
          marginTop: 6,
          padding: '6px 8px',
          font: '600 11.5px var(--font-sans)',
          color: claro(0.68),
        }}
      >
        Salir
      </button>
    </aside>
  );
}

function Contador({
  color,
  titulo,
  children,
}: {
  color: string;
  titulo: string;
  children: ReactNode;
}) {
  return (
    <span
      title={titulo}
      style={{
        minWidth: 18,
        height: 18,
        borderRadius: 'var(--r-pill)',
        background: color,
        color: '#fff',
        font: '700 10px/18px var(--font-mono)',
        textAlign: 'center',
        padding: '0 5px',
        boxSizing: 'border-box',
        flex: 'none',
      }}
    >
      {children}
    </span>
  );
}

type RutaSinParametros =
  | '/importacion'
  | '/evidencia'
  | '/insights'
  | '/biblioteca'
  | '/journeys'
  | '/design-versions'
  | '/propuestas'
  | '/personas'
  | '/exportacion'
  | '/disposicion'
  | '/auditoria';

/**
 * Un destino del workspace. En el riel estrecho (<1200px) el texto no cabe y la fila no puede
 * quedarse en blanco: lleva una etiqueta mono de tres letras, que es lo que el design system
 * usa en su riel (dirección 2a) mientras no haya set de iconos en el codebase.
 */
function DestinoDelWorkspace({
  to,
  etiqueta,
  abrev,
  children,
}: {
  to: RutaSinParametros;
  etiqueta: string;
  abrev: string;
  children?: ReactNode;
}) {
  return (
    <Link className="loop-fila" to={to} title={etiqueta} aria-label={etiqueta} style={filaLateral}>
      <span className="loop-ancho" style={{ flex: 1, ...truncado }}>
        {etiqueta}
      </span>
      <Abreviatura>{abrev}</Abreviatura>
      {children}
    </Link>
  );
}

/** La etiqueta de tres letras del riel estrecho: solo se ve por debajo de 1200px. */
function Abreviatura({ children }: { children: ReactNode }) {
  return (
    <span
      className="loop-estrecho"
      aria-hidden
      style={{ font: '600 10px var(--font-mono)', letterSpacing: '.06em', color: claro(0.72) }}
    >
      {children}
    </span>
  );
}

/**
 * Un servicio del árbol: su fila alterna expandir/colapsar y, abierta, enseña sus retos con
 * el color del journey donde está cada uno. El chip de journey de la fila del servicio es
 * solo indicador (el destino del loop es esta misma pantalla).
 */
function ServicioDelArbol({
  servicio,
  actual,
  abierto,
  onPulsar,
  proyectos,
  hayEvidencia,
}: {
  servicio: ServicioArbol;
  actual: boolean;
  abierto: boolean;
  onPulsar: () => void;
  proyectos: ReadonlyMap<string, GatesDeProyecto>;
  hayEvidencia: boolean;
}) {
  const proyectoActualDelServicio = proyectoActual(servicio);
  const loop = proyectoActualDelServicio
    ? loopDeProyecto(proyectos.get(proyectoActualDelServicio.id) ?? null, {
        hayEvidencia,
        hayServicio: true,
      })
    : null;
  const nRetos = servicio.retos.length;
  return (
    <div>
      <button
        type="button"
        className="loop-fila"
        aria-expanded={abierto}
        aria-current={actual ? 'true' : undefined}
        // En el riel el nombre visible se oculta y la abreviatura es decorativa: el nombre
        // accesible va explícito para que el botón no se quede mudo (o diga solo «J3»).
        aria-label={servicio.nombre}
        onClick={onPulsar}
        title={actual ? servicio.nombre : `${servicio.nombre} · seleccionar`}
        style={{
          ...filaLateral,
          padding: '9px 10px',
          background: actual ? claro(0.11) : undefined,
          color: actual ? '#fff' : claro(0.68),
          fontWeight: actual ? 700 : 500,
        }}
      >
        <span
          className="loop-caret"
          aria-hidden
          style={{
            font: '400 10px var(--font-mono)',
            color: claro(actual ? 0.5 : 0.4),
            flex: 'none',
          }}
        >
          {abierto ? '▾' : '▸'}
        </span>
        <span className="loop-ancho" style={{ flex: 1, ...truncado }}>
          {servicio.nombre}
        </span>
        <Abreviatura>{inicialesDe(servicio.nombre)}</Abreviatura>
        {loop?.enCurso ? (
          <span
            title={`Journey en curso: J${loop.enCurso}`}
            style={{
              font: '600 10px var(--font-mono)',
              color: '#fff',
              background: `var(--j${loop.enCurso})`,
              borderRadius: 4,
              padding: '2px 5px',
              flex: 'none',
            }}
          >
            J{loop.enCurso}
          </span>
        ) : !abierto ? (
          <span
            className="loop-ancho"
            style={{ font: '600 10.5px var(--font-mono)', color: claro(0.4), flex: 'none' }}
          >
            {nRetos === 0 ? 'sin retos' : nRetos === 1 ? '1 reto' : `${nRetos} retos`}
          </span>
        ) : null}
      </button>
      {abierto && (
        <div
          className="loop-ancho"
          style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 2 }}
        >
          {/* Lo que el servicio hace HOY (RF-06.10): es del SERVICIO, no de un reto. */}
          {servicio.estadoEfectivo && (
            <div
              title={`Estado efectivo vigente · ${servicio.estadoEfectivo.designVersionCodigo} · ${servicio.estadoEfectivo.constatadoEn}`}
              style={{
                display: 'flex',
                gap: 6,
                alignItems: 'baseline',
                padding: '2px 10px 6px 26px',
                font: '400 11px var(--font-sans)',
                color: claro(0.45),
              }}
            >
              <span
                style={{ font: '500 10.5px var(--font-mono)', color: claro(0.75), flexShrink: 0 }}
              >
                {servicio.estadoEfectivo.codigo}
              </span>
              <span style={truncado}>
                {servicio.estadoEfectivo.resumen !== ''
                  ? servicio.estadoEfectivo.resumen
                  : `constatado el ${servicio.estadoEfectivo.constatadoEn}`}
              </span>
            </div>
          )}
          {servicio.retos.length === 0 && (
            <span
              style={{
                font: '400 12.5px var(--font-sans)',
                color: claro(0.45),
                padding: '6px 10px 6px 26px',
              }}
            >
              Sin retos aún
            </span>
          )}
          {servicio.retos.map((reto) => (
            <RetoDelArbol
              key={reto.id}
              reto={reto}
              // El reto activo es el del proyecto actual —el que gobiernan cabecera, spotlight
              // y pestañas—, no el primero de la lista: pueden no ser el mismo.
              activo={actual && reto.proyectos.some((p) => p.id === proyectoActualDelServicio?.id)}
              marca={marcaDeReto(reto, proyectos, hayEvidencia)}
            />
          ))}
          {servicio.retosQueAfectan.map((reto) => (
            <div
              key={reto.id}
              title={`${reto.codigo} ${reto.titulo} · anclado en otro servicio, afecta a este`}
              style={{
                ...filaLateral,
                cursor: 'default',
                paddingLeft: 26,
                color: claro(0.45),
                font: '500 12.5px var(--font-sans)',
              }}
            >
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: '50%',
                  border: `1.5px solid ${claro(0.35)}`,
                  flex: 'none',
                }}
              />
              <span style={{ flex: 1, ...truncado }}>
                {reto.codigo} {reto.titulo}
              </span>
              <span
                style={{ font: '600 9.5px var(--font-mono)', color: claro(0.35), flex: 'none' }}
              >
                afecta
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Un reto: punto con el color del journey donde está, código y título, y a la derecha su
 * métrica objetivo (si la tiene) o el journey. Con proyecto es un enlace al proyecto, que
 * es la pantalla del reto hoy; sin proyecto no finge un enlace.
 */
function RetoDelArbol({
  reto,
  activo,
  marca,
}: {
  reto: RetoArbol;
  activo: boolean;
  marca: ReturnType<typeof marcaDeReto>;
}) {
  // La fila abre el proyecto ACTUAL del reto (el vivo antes que el pausado o cerrado), el
  // mismo del que sale su marca y, si es el reto actual, la cabecera.
  const proyecto = proyectoActualDelReto(reto);
  const atenuado = marca.punteado;
  const estilo: CSSProperties = {
    ...filaLateral,
    paddingLeft: 26,
    background: activo ? claro(0.07) : undefined,
    color: activo ? '#fff' : claro(atenuado ? 0.45 : 0.68),
    font: `${activo ? 600 : 500} 12.5px var(--font-sans)`,
    cursor: proyecto ? 'pointer' : 'default',
  };
  const contenido = (
    <>
      <span
        aria-hidden
        style={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          background: marca.punteado ? 'transparent' : `var(--j${marca.j})`,
          border: marca.punteado ? `1.5px dashed var(--j${marca.j})` : 'none',
          boxSizing: 'border-box',
          flex: 'none',
        }}
      />
      <span style={{ flex: 1, ...truncado }}>
        {reto.codigo} {reto.titulo}
      </span>
      <span
        style={{
          font: '600 10.5px var(--font-mono)',
          color: claro(activo ? 0.75 : atenuado ? 0.35 : 0.45),
          flex: 'none',
        }}
      >
        {reto.metricaObjetivo || marca.sufijo}
      </span>
    </>
  );
  const titulo = `${reto.codigo} ${reto.titulo} · ${
    marca.punteado ? 'candidato del post mortem, sin proyecto aún' : `en J${marca.j}`
  }`;
  if (!proyecto) {
    return (
      <div title={`${titulo}${marca.punteado ? '' : ' · sin proyecto aún'}`} style={estilo}>
        {contenido}
      </div>
    );
  }
  // El esquema no limita un reto a un proyecto. La fila del reto abre el primero (el que el
  // resto de la pantalla toma como actual); los demás no pueden quedarse sin entrada, así
  // que cuelgan debajo como subfilas, cada una con su propio enlace.
  const otros = reto.proyectos.filter((p) => p.id !== proyecto?.id);
  return (
    <>
      <Link
        className="loop-fila"
        to="/proyecto/$proyectoId"
        params={{ proyectoId: proyecto.id }}
        title={`${titulo} · abrir ${proyecto.codigo}`}
        style={estilo}
      >
        {contenido}
      </Link>
      {otros.map((p) => (
        <Link
          key={p.id}
          className="loop-fila"
          to="/proyecto/$proyectoId"
          params={{ proyectoId: p.id }}
          title={`${p.codigo} ${p.titulo} · otro proyecto de ${reto.codigo}`}
          style={{
            ...filaLateral,
            paddingLeft: 41,
            color: claro(0.55),
            font: '500 12px var(--font-sans)',
          }}
        >
          <span style={{ font: '500 10.5px var(--font-mono)', color: claro(0.5), flex: 'none' }}>
            {p.codigo}
          </span>
          <span style={{ flex: 1, ...truncado }}>{p.titulo}</span>
        </Link>
      ))}
    </>
  );
}

// ── Cabecera de arco ────────────────────────────────────────────────────────────────────

/** El bloque de firma: el único sitio donde el gradiente profundo es fondo. */
function CabeceraDeArco({
  loop,
  servicio,
  proyecto,
  resumen,
  onTramo,
}: {
  loop: EstadoDelLoop;
  servicio: ServicioArbol | null;
  proyecto: ProyectoArbol | null;
  resumen: ResumenDelLoop | null;
  onTramo: (j: JourneyN) => void;
}) {
  const reto = servicio?.retos.find((r) => r.proyectos.some((p) => p.id === proyecto?.id));
  const enCurso = loop.enCurso ? journeyDelLoop(loop.enCurso) : null;
  const bajada = !servicio
    ? 'De la importación al post mortem. Este workspace todavía no tiene servicios: el loop arranca cuando exista el primero y entre su material.'
    : !proyecto
      ? `De la importación al post mortem. ${servicio.nombre} aún no tiene un proyecto: el método empieza con un reto activado y su G0.`
      : loop.enCurso === null
        ? `De la importación al post mortem. ${reto?.codigo ?? 'El reto'} cerró el ciclo entero con veredicto; los candidatos del post mortem esperan en el backlog.`
        : `De la importación al post mortem. El arco marca la posición de cada journey; ${reto?.codigo ?? proyecto.codigo} va por ${enCurso?.titulo.toLowerCase()} y ${loop.gateAbierto === null ? 'los ocho gates ya están aprobados' : `su gate abierto es G${loop.gateAbierto}`}.`;
  const metrica = resumen?.metricas?.primaria ?? null;

  return (
    <div
      style={{
        position: 'relative',
        overflow: 'hidden',
        borderRadius: 20,
        background: 'var(--grad-arco-deep)',
        color: 'var(--text-inverse)',
        padding: '32px 34px 26px',
      }}
    >
      <div
        aria-hidden
        style={{
          position: 'absolute',
          inset: 0,
          background:
            'radial-gradient(120% 90% at 88% -20%, rgba(255,255,255,.22), transparent 60%)',
          pointerEvents: 'none',
        }}
      />
      <div
        className="loop-cabecera-fila"
        style={{
          position: 'relative',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          gap: 40,
        }}
      >
        <div
          style={{ maxWidth: 640, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12 }}
        >
          <span style={{ ...mono, letterSpacing: '.14em', color: claro(0.65) }}>
            Método · {loop.enCurso === null && proyecto ? 'loop cerrado' : 'loop activo'}
          </span>
          <h1
            style={{
              font: '800 46px/1.06 var(--font-sans)',
              letterSpacing: '-.015em',
              margin: 0,
              color: 'var(--text-inverse)',
            }}
          >
            El loop del método
            <br />
            journeys J1–J7
          </h1>
          <p
            style={{
              font: '400 14.5px/1.55 var(--font-sans)',
              color: claro(0.78),
              margin: 0,
              textWrap: 'pretty',
            }}
          >
            {bajada}
          </p>
        </div>
        <div
          className="loop-cifras"
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, auto)',
            gap: 34,
            paddingTop: 6,
            flex: 'none',
          }}
        >
          <Cifra etiqueta="Journeys cerrados" valor={String(loop.cerrados)} sufijo="/7" />
          <Cifra
            etiqueta="Gate abierto"
            valor={!proyecto || loop.gateAbierto === null ? '—' : `G${loop.gateAbierto}`}
            titulo={
              !proyecto
                ? 'Sin proyecto: no hay gates que abrir'
                : loop.gateAbierto === null
                  ? 'Los ocho gates están aprobados'
                  : undefined
            }
          />
          <Cifra
            etiqueta={metrica ? metrica.nombre : `Métrica${reto ? ` · ${reto.codigo}` : ''}`}
            valor={resumen === null ? '—' : (metrica?.actual ?? metrica?.lineaBase ?? '—')}
            sufijo={metrica ? ` → ${metrica.objetivo}` : undefined}
            titulo={
              resumen === null
                ? 'No se pudieron leer las métricas'
                : !metrica
                  ? 'Sin Metric Registry todavía: la cifra llega con el plan de medición (G6)'
                  : metrica.actual
                    ? `Último snapshot · línea base ${metrica.lineaBase ?? '—'} · objetivo ${metrica.objetivo}`
                    : `Sin snapshots aún: se enseña la línea base · objetivo ${metrica.objetivo}`
            }
          />
        </div>
      </div>
      <div
        style={{
          position: 'relative',
          marginTop: 30,
          display: 'grid',
          gridTemplateColumns: 'repeat(7, 1fr)',
          gap: 6,
        }}
        role="group"
        aria-label="Barra del arco"
      >
        {JOURNEYS.map((j) => {
          const estado = loop.journeys[j];
          const jl = journeyDelLoop(j);
          const enCursoAqui = estado === 'en curso';
          return (
            <button
              key={j}
              type="button"
              className="loop-tramo"
              data-estado={estado}
              onClick={() => onTramo(j)}
              title={`J${j} · ${jl.titulo} · ${estado}: ir a la tarjeta`}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 7,
                background: 'transparent',
                border: 'none',
                padding: 0,
                cursor: 'pointer',
                textAlign: 'left',
                color: 'inherit',
                borderRadius: 6,
              }}
            >
              <span
                aria-hidden
                style={{
                  display: 'block',
                  height: 8,
                  borderRadius: 'var(--r-pill)',
                  background: estado === 'próximo' ? claro(0.22) : `var(--j${j})`,
                  boxShadow: enCursoAqui ? '0 0 0 3px rgba(255,255,255,.35)' : undefined,
                }}
              />
              {/* Peso y color según `data-estado`, y el hover, viven en la hoja de estilos:
                  en línea anularían el hover. */}
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                J{j} · {enCursoAqui ? 'en curso' : jl.corto}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Cifra({
  etiqueta,
  valor,
  sufijo,
  titulo,
}: {
  etiqueta: string;
  valor: string;
  sufijo?: string;
  titulo?: string;
}) {
  return (
    <div title={titulo} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span
        style={{
          ...mono,
          fontSize: 10.5,
          letterSpacing: '.1em',
          color: claro(0.6),
          ...truncado,
          maxWidth: 220,
        }}
      >
        {etiqueta}
      </span>
      <span style={{ font: '800 38px/1 var(--font-sans)', whiteSpace: 'nowrap' }}>
        {valor}
        {sufijo && (
          <span style={{ font: '600 18px var(--font-sans)', color: claro(0.6) }}>{sufijo}</span>
        )}
      </span>
    </div>
  );
}

// ── Spotlight del journey en curso ──────────────────────────────────────────────────────

function Spotlight({
  loop,
  proyecto,
  resumen,
  hayServicio,
}: {
  loop: EstadoDelLoop;
  proyecto: ProyectoArbol | null;
  resumen: ResumenDelLoop | null;
  hayServicio: boolean;
}) {
  // Con el loop cerrado el spotlight enseña J7 hecho: el ciclo terminó y lo dice.
  const j: JourneyN = loop.enCurso ?? 7;
  const jl = journeyDelLoop(j);
  const estado = loop.journeys[j];
  const destino = destinoDeJourney(jl.pantalla, proyecto?.id ?? null);
  const release = resumen?.release ?? null;
  const metricas = resumen?.metricas ?? null;
  return (
    <section
      aria-label={`Journey ${estado}`}
      style={{
        border: '2px solid transparent',
        borderRadius: 16,
        padding: '22px 24px',
        background:
          'linear-gradient(var(--surface), var(--surface)) padding-box, var(--grad-arco) border-box',
        boxShadow: 'var(--shadow-arco)',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        minWidth: 0,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span
          style={{
            font: '600 12px var(--font-mono)',
            color: '#fff',
            background: `var(--j${j})`,
            borderRadius: 6,
            padding: '3px 8px',
          }}
        >
          J{j}
        </span>
        <span
          style={{
            font: '700 11px var(--font-sans)',
            color: estado === 'en curso' ? '#fff' : 'var(--ok)',
            background: estado === 'en curso' ? 'var(--grad-arco)' : 'var(--ok-soft)',
            borderRadius: 'var(--r-pill)',
            padding: '4px 11px',
          }}
        >
          {estado === 'en curso' ? 'En curso' : 'Hecho'}
        </span>
        <span style={{ ...mono, color: 'var(--text-faint)', marginLeft: 'auto' }}>
          {jl.meta}
          {proyecto ? ` · ${proyecto.codigo}` : ''}
        </span>
      </div>
      <h2 style={{ font: '800 24px/1.15 var(--font-sans)', color: 'var(--ink)', margin: 0 }}>
        {jl.titulo}
      </h2>
      <p
        style={{
          font: '400 13.5px/1.55 var(--font-sans)',
          color: 'var(--text-muted)',
          maxWidth: 520,
          margin: 0,
          textWrap: 'pretty',
        }}
      >
        {jl.descripcion}
      </p>
      <div
        style={{
          display: 'flex',
          gap: 26,
          marginTop: 4,
          paddingTop: 14,
          borderTop: '1px solid var(--border)',
          flexWrap: 'wrap',
          alignItems: 'center',
        }}
      >
        <Par etiqueta="Responsable" valor={jl.rol} />
        <Par
          etiqueta="Release"
          valor={
            release
              ? release.estado === 'planificado'
                ? `${release.codigo} · planificado`
                : `${release.codigo} · ${release.diasVivo ?? 0} ${release.diasVivo === 1 ? 'día vivo' : 'días vivos'}`
              : 'Sin release aún'
          }
          titulo={release ? `${release.titulo} · ${release.designVersionCodigo}` : undefined}
        />
        <Par
          etiqueta="Métricas listas"
          valor={
            metricas
              ? `${metricas.listas} de ${metricas.total}${metricas.registryFirmado ? '' : ' · registry sin firmar'}`
              : 'Sin registry aún'
          }
        />
        {destino ? (
          <EnlaceA
            destino={destino}
            aria-label={`Abrir journey J${j}: ${etiquetaDeDestino(destino, proyecto?.codigo)}`}
            style={{
              marginLeft: 'auto',
              font: '700 13px var(--font-sans)',
              color: '#fff',
              background: 'var(--brand-ink)',
              borderRadius: 'var(--r-sm)',
              padding: '10px 18px',
              textDecoration: 'none',
              whiteSpace: 'nowrap',
            }}
          >
            Abrir journey J{j}
          </EnlaceA>
        ) : (
          <span
            style={{
              marginLeft: 'auto',
              font: '600 12px var(--font-sans)',
              color: 'var(--text-faint)',
            }}
          >
            {hayServicio ? 'Sin proyecto aún en este servicio' : 'Sin servicio aún'}
          </span>
        )}
      </div>
    </section>
  );
}

function Par({ etiqueta, valor, titulo }: { etiqueta: string; valor: string; titulo?: string }) {
  return (
    <div title={titulo} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <span style={{ ...mono, fontSize: 10.5, color: 'var(--text-faint)' }}>{etiqueta}</span>
      <span style={{ font: '600 13px var(--font-sans)', color: 'var(--ink)' }}>{valor}</span>
    </div>
  );
}

// ── Te toca a ti ────────────────────────────────────────────────────────────────────────

type Pendiente = { color: string; texto: string; destino: Destino | null; titulo?: string };

/**
 * Lo que espera a alguien, con su origen: cada fila navega a donde se resuelve. Es la misma
 * respuesta que alimenta los contadores del lateral, no otra consulta.
 */
function TeTocaATi({
  loop,
  servicio,
  resumen,
  proyecto,
  rol,
}: {
  loop: EstadoDelLoop;
  servicio: ServicioArbol | null;
  resumen: ResumenDelLoop | null;
  proyecto: ProyectoArbol | null;
  rol: string;
}) {
  const filas: Pendiente[] = [];
  // La bandeja la curan la boutique (RF-03.4): para los demás roles no es una tarea.
  const esCurador = (ROLES_CURADORES as readonly string[]).includes(rol);
  if (resumen === null) {
    filas.push({
      color: 'var(--danger)',
      texto: 'No se pudieron leer los pendientes ni las métricas de este workspace',
      destino: null,
    });
  } else {
    // Las mías primero y en ámbar; las que esperan a otro rol también se nombran (el lead
    // necesita saber que G5 espera al sponsor), pero como aviso, no como tarea propia.
    const ordenadas = [...resumen.aprobaciones].sort((a, b) => Number(b.esMia) - Number(a.esMia));
    for (const a of ordenadas) {
      const rol = ETIQUETA_ROL[a.rolAprobador]?.toLowerCase() ?? a.rolAprobador;
      filas.push({
        color: a.esMia ? 'var(--warn)' : 'var(--text-faint)',
        texto: a.esMia
          ? `G${a.numero} de ${a.proyectoCodigo} tiene el checklist decidido: te toca revisarlo`
          : `G${a.numero} de ${a.proyectoCodigo} tiene el checklist decidido y espera al ${rol}`,
        destino: { to: '/proyecto/$proyectoId', params: { proyectoId: a.proyectoId } },
        // El checklist es la parte del gate que dejó de ser trabajo; lo demás que la
        // suficiencia exige (criterios de G0, registry de G6, decisiones en revisión…) lo
        // dice la pantalla del proyecto con la misma regla que la base aplica al aprobar.
        titulo: 'El proyecto dice qué más falta, si falta, antes de poder aprobar',
      });
    }
    if (esCurador && resumen.importacionPendientes > 0) {
      const n = resumen.importacionPendientes;
      filas.push({
        color: 'var(--accent)',
        texto: `${n} ${n === 1 ? 'item' : 'items'} en la bandeja de importación sin curar`,
        destino: { to: '/importacion' },
      });
    }
    // Solo las entregas que quien mira puede cargar (curador o propietario del dato), con el
    // reto en medición y según su cadencia: lo decide la proyección con la regla de la base.
    // Una fila por reto en medición con entregas que esperan a quien mira; cada una abre el
    // proyecto donde se cargan (el actual o no: dos retos pueden estar vivos a la vez).
    for (const e of resumen.entregas) {
      filas.push({
        color: 'var(--j7)',
        texto: `${e.cuantas} ${e.cuantas === 1 ? 'métrica tuya' : 'métricas tuyas'} de ${e.retoCodigo} ${e.cuantas === 1 ? 'espera' : 'esperan'} su snapshot`,
        destino: e.proyectoId
          ? { to: '/proyecto/$proyectoId', params: { proyectoId: e.proyectoId } }
          : null,
      });
    }
    if (loop.journeys[7] === 'próximo' && proyecto) {
      const motivo = porQueJ7Cerrado(loop);
      filas.push({
        color: 'var(--j7)',
        texto:
          loop.gateAbierto !== null
            ? `J7 se abre cuando G7 quede aprobado (hoy el gate abierto es G${loop.gateAbierto})`
            : 'J7 se abre cuando termine la medición (G7 ya está aprobado)',
        destino: null,
        titulo: `Informativa: ${motivo.largo}`,
      });
    }
  }
  const candidatos =
    servicio?.retos.filter((r) => r.estado === 'candidato' && r.origen === 'post-mortem') ?? [];

  return (
    <section
      aria-label="Te toca a ti"
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 16,
        padding: '20px 22px',
        boxShadow: 'var(--shadow-sm)',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        minWidth: 0,
      }}
    >
      <span style={etiquetaSeccion}>Te toca a ti</span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {filas.length === 0 && (
          <span style={{ font: '500 13px/1.45 var(--font-sans)', color: 'var(--text-muted)' }}>
            Nada espera por ti ahora mismo.
          </span>
        )}
        {filas.map((f) => (
          <FilaPendiente key={f.texto} fila={f} />
        ))}
      </div>
      <span
        style={{
          marginTop: 'auto',
          font: '400 12px/1.5 var(--font-sans)',
          color: 'var(--text-faint)',
        }}
      >
        {candidatos.length === 0 ? (
          'El post mortem pre-puebla la etapa 0 del siguiente reto; el backlog del servicio espera su primer candidato.'
        ) : (
          <>
            El post mortem pre-puebla la etapa 0 de{' '}
            {candidatos.map((r, i) => (
              <span key={r.id}>
                {i > 0 && (i === candidatos.length - 1 ? ' y ' : ', ')}
                <CodigoDeReto reto={r} />
              </span>
            ))}
            .
          </>
        )}
      </span>
    </section>
  );
}

function FilaPendiente({ fila }: { fila: Pendiente }) {
  const cuerpo = (
    <>
      <span
        aria-hidden
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: fila.color,
          marginTop: 6,
          flex: 'none',
        }}
      />
      <span style={{ font: '500 13px/1.45 var(--font-sans)', color: 'var(--text-body)' }}>
        {fila.texto}
      </span>
    </>
  );
  if (!fila.destino) {
    return (
      <div title={fila.titulo} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
        {cuerpo}
      </div>
    );
  }
  return (
    <EnlaceA
      destino={fila.destino}
      title={`Abrir ${etiquetaDeDestino(fila.destino)}`}
      style={{
        display: 'flex',
        gap: 10,
        alignItems: 'flex-start',
        textDecoration: 'none',
        color: 'inherit',
      }}
    >
      {cuerpo}
    </EnlaceA>
  );
}

/**
 * Un reto candidato no tiene pantalla propia todavía: si ya tiene proyecto se abre este; si
 * no, el código se muestra como texto y no como un enlace a un ancla que no existe.
 */
function CodigoDeReto({ reto }: { reto: RetoArbol }) {
  const proyecto = proyectoActualDelReto(reto);
  if (!proyecto) {
    return (
      <span
        title={`${reto.codigo} ${reto.titulo} · sin proyecto aún`}
        style={{ font: '500 12px var(--font-mono)', color: 'var(--ink)' }}
      >
        {reto.codigo}
      </span>
    );
  }
  return (
    <Link
      to="/proyecto/$proyectoId"
      params={{ proyectoId: proyecto.id }}
      title={`${reto.codigo} ${reto.titulo} · abrir ${proyecto.codigo}`}
    >
      {reto.codigo}
    </Link>
  );
}

// ── Los siete recorridos ────────────────────────────────────────────────────────────────

const ETIQUETA_ESTADO: Record<EstadoJourney, string> = {
  hecho: 'Hecho',
  'en curso': 'En curso',
  próximo: 'Próximo',
};

/**
 * La tarjeta de un journey es un enlace a la pantalla donde ese journey se trabaja. Cuando
 * no hay a dónde ir (journey del proyecto sin proyecto todavía) la tarjeta se queda sin
 * enlace y lo dice. J7 además se deshabilita mientras G7 siga cerrado: el post mortem no se
 * puede abrir, y el tooltip explica la condición.
 */
function JourneyCard({
  jl,
  estado,
  proyecto,
  destacada,
  motivoJ7,
}: {
  jl: JourneyLoop;
  estado: EstadoJourney;
  proyecto: ProyectoArbol | null;
  destacada: boolean;
  /** Por qué J7 sigue cerrado (gate o medición): la tarjeta lo dice con la misma regla. */
  motivoJ7: { corto: string; largo: string };
}) {
  const enCurso = estado === 'en curso';
  const pendiente = estado === 'próximo';
  // J7 «próximo» con proyecto está cerrado por G7 o por la medición abierta, y el motivo lo
  // dice; sin proyecto no está «cerrado» por nada: simplemente no hay proyecto, como en J2.
  const cerradoPorGate = jl.j === 7 && pendiente && proyecto !== null;
  const destino = cerradoPorGate ? null : destinoDeJourney(jl.pantalla, proyecto?.id ?? null);
  const j = jl.j;
  const tarjeta = (
    <div
      id={idDeTarjeta(j)}
      className="loop-tarjeta"
      data-enlace={destino ? 'true' : 'false'}
      style={{
        background: enCurso ? `var(--j${j}-soft)` : pendiente ? 'var(--bg-app)' : 'var(--surface)',
        border: pendiente
          ? '1px dashed var(--border-strong)'
          : `1px solid ${enCurso ? `var(--j${j})` : 'var(--border)'}`,
        borderLeft: pendiente ? undefined : `3px solid var(--j${j})`,
        borderRadius: 12,
        padding: '13px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        opacity: pendiente ? 0.6 : 1,
        height: '100%',
        boxSizing: 'border-box',
        minWidth: 0,
        boxShadow: destacada ? '0 0 0 3px var(--accent-soft), 0 0 0 5px var(--accent)' : undefined,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ font: '600 11px var(--font-mono)', color: `var(--j${j})` }}>J{j}</span>
        <span
          style={{
            font: '700 10px var(--font-sans)',
            color: enCurso ? `var(--j${j})` : pendiente ? 'var(--text-muted)' : 'var(--ok)',
          }}
        >
          {ETIQUETA_ESTADO[estado]}
        </span>
      </div>
      <span style={{ font: '700 13.5px/1.25 var(--font-sans)', color: 'var(--ink)' }}>
        {jl.titulo}
      </span>
      <span
        style={{
          font: '400 11px/1.45 var(--font-mono)',
          color: enCurso ? 'var(--text-muted)' : 'var(--text-faint)',
        }}
      >
        {jl.meta}
      </span>
      <span
        style={{
          marginTop: 'auto',
          font: '600 11px var(--font-sans)',
          color: destino ? 'var(--accent)' : 'var(--text-faint)',
        }}
      >
        {destino
          ? `Abrir ${etiquetaDeDestino(destino, proyecto?.codigo)} →`
          : cerradoPorGate
            ? motivoJ7.corto
            : 'Sin proyecto aún en este servicio'}
      </span>
    </div>
  );
  if (!destino) {
    return (
      <div
        title={
          cerradoPorGate ? motivoJ7.largo : `J${j} ${jl.titulo}: sin proyecto aún en este servicio`
        }
        style={{ minWidth: 0 }}
      >
        {tarjeta}
      </div>
    );
  }
  return (
    <EnlaceA
      destino={destino}
      aria-label={`J${j} ${jl.titulo}: abrir ${etiquetaDeDestino(destino, proyecto?.codigo)}`}
      style={{
        textDecoration: 'none',
        color: 'inherit',
        display: 'block',
        minWidth: 0,
        borderRadius: 12,
      }}
    >
      {tarjeta}
    </EnlaceA>
  );
}

// ── Estado de carga ─────────────────────────────────────────────────────────────────────

/**
 * Skeleton de la pantalla mientras cargan el árbol y el resumen: la cabecera de arco
 * mantiene su alto con las tres cifras como barras, las siete tarjetas son cajas hundidas y
 * el lateral ya está pintado en su color (es ruta: carga primero).
 */
export function LoopSkeleton() {
  const barra = (ancho: number | string, alto = 12): CSSProperties => ({
    width: ancho,
    height: alto,
    borderRadius: 'var(--r-pill)',
    background: 'rgba(247,247,249,.25)',
  });
  return (
    <div aria-busy style={{ minHeight: '100vh', background: 'var(--bg-app)' }}>
      <div
        style={{
          height: 57,
          background: 'var(--surface)',
          borderBottom: '1px solid var(--border)',
          boxSizing: 'border-box',
        }}
      />
      <div style={{ display: 'flex', minHeight: 820 }}>
        <aside
          className="loop-aside"
          style={{
            width: 290,
            flex: 'none',
            background: 'var(--brand-ink)',
            borderRight: '1px solid var(--brand-ink-lift)',
            padding: '20px 16px',
            boxSizing: 'border-box',
          }}
        >
          <span style={{ padding: '0 8px' }}>
            <Wordmark color="#fff" />
          </span>
        </aside>
        <main
          style={{
            flex: 1,
            minWidth: 0,
            padding: '24px 30px 34px',
            display: 'flex',
            flexDirection: 'column',
            gap: 22,
          }}
        >
          <div style={{ ...barra(260), background: 'var(--surface-sunken)' }} />
          <div
            style={{
              borderRadius: 20,
              background: 'var(--grad-arco-deep)',
              padding: '32px 34px 26px',
              display: 'flex',
              flexDirection: 'column',
              gap: 30,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 40 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div style={barra(120, 10)} />
                <div style={barra(420, 40)} />
                <div style={barra(360, 40)} />
                <div style={barra(520, 14)} />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, auto)', gap: 34 }}>
                {[0, 1, 2].map((i) => (
                  <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div style={barra(90, 9)} />
                    <div style={barra(70, 36)} />
                  </div>
                ))}
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 6 }}>
              {[...Array(7)].map((_, i) => (
                <div key={i} style={barra('100%', 8)} />
              ))}
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1.6fr 1fr', gap: 16 }}>
            <div style={{ height: 210, borderRadius: 16, background: 'var(--surface-sunken)' }} />
            <div style={{ height: 210, borderRadius: 16, background: 'var(--surface-sunken)' }} />
          </div>
          <div
            style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 10 }}
          >
            {[...Array(7)].map((_, i) => (
              <div
                key={i}
                style={{ height: 110, borderRadius: 12, background: 'var(--surface-sunken)' }}
              />
            ))}
          </div>
        </main>
      </div>
    </div>
  );
}
