import type { CSSProperties, ReactNode } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EnlaceA } from '@/components/ui/EnlaceA';
import { Tag } from '@/components/ui/Tag';
import { Wordmark } from '@/components/ui/Wordmark';
import { ETIQUETA_ROL } from '@/lib/auth/auth.schemas';
import { etiquetaDeDestino, type Destino } from '@/lib/destinos';
import { aprobacionesPendientes } from '@/lib/aprobaciones/aprobaciones.functions';
import {
  ACTO_DE_CLASE,
  ETIQUETA_CLASE_PENDIENTE,
  clasesDelRol,
  contarPendientes,
  destinoDeDerecho,
  destinoDeDesignVersion,
  destinoDeGate,
  destinoDeInsight,
  etiquetaDePendientes,
  motivoSinPreambulo,
  type ClasePendiente,
  type PendientesDelRol,
} from '@/lib/aprobaciones/aprobaciones.schemas';

/**
 * Aprobaciones pendientes: todo lo que el rol de quien mira puede aprobar o decidir AHORA
 * en el workspace, agrupado por clase y con cada fila enlazando a la pantalla donde se
 * decide. No decide nada aquí a propósito: aprobar un gate, conceder derechos, validar un
 * insight o congelar una design version tienen cada uno su pantalla, con el contexto que
 * esa decisión necesita delante. Esta es la bandeja que dice cuánto espera y dónde.
 *
 * Una clase que el rol no decide no se enseña (un sponsor no valida insights); una que sí
 * decide y está vacía lo dice, para que «no hay nada» no se confunda con «no te toca».
 */
export const Route = createFileRoute('/_autenticada/aprobaciones')({
  loaderDeps: ({ search }) => ({ ws: search.ws }),
  loader: ({ context }) => {
    const workspaceId = context.membresiaActiva?.workspaceId;
    return workspaceId ? aprobacionesPendientes({ data: { workspaceId } }) : null;
  },
  component: PantallaAprobaciones,
});

const etiqueta: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontWeight: 500,
  fontSize: 11,
  letterSpacing: '.08em',
  textTransform: 'uppercase',
  color: 'var(--text-muted)',
};

const apunte: CSSProperties = {
  font: '400 12.5px var(--font-sans)',
  color: 'var(--text-muted)',
};

function PantallaAprobaciones() {
  const datos = Route.useLoaderData();
  const { membresiaActiva } = Route.useRouteContext();
  const navigate = useNavigate();
  const rol = membresiaActiva?.rol ?? '';
  const clases = clasesDelRol(rol);
  const conteo = datos ? contarPendientes(datos) : null;

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
            Aprobaciones pendientes
          </span>
        </div>
        <Button variant="ghost" size="sm" onClick={() => navigate({ to: '/app' })}>
          ← Volver al loop
        </Button>
      </div>

      <main
        style={{
          maxWidth: 860,
          margin: '0 auto',
          padding: '28px 24px 60px',
          display: 'flex',
          flexDirection: 'column',
          gap: 20,
        }}
      >
        {!membresiaActiva && (
          <Card style={{ padding: 24 }}>
            <span style={{ font: '400 13.5px var(--font-sans)', color: 'var(--text-muted)' }}>
              Aún no perteneces a ningún workspace.
            </span>
          </Card>
        )}
        {/* El loader devuelve null solo cuando la sesión ya no vale (cuenta desactivada con
            el JWT aún vigente): no es un fallo de lectura, es que no hay con qué leer. */}
        {membresiaActiva && !datos && (
          <Card style={{ padding: 24 }}>
            <span style={{ font: '400 13.5px var(--font-sans)', color: 'var(--text-muted)' }}>
              Tu sesión ya no tiene acceso a este workspace; vuelve a entrar.
            </span>
          </Card>
        )}
        {membresiaActiva && datos && conteo && (
          <>
            <Cabecera rol={rol} clases={clases} total={conteo.total} porClase={conteo.porClase} />
            {clases.length === 0 && (
              <Card style={{ padding: 24 }}>
                <span style={{ font: '400 13.5px var(--font-sans)', color: 'var(--text-muted)' }}>
                  Tu rol ({ETIQUETA_ROL[rol] ?? rol}) no aprueba ni decide nada en este workspace:
                  los gates los aprueban el sponsor y el lead, los derechos el lead y el admin del
                  cliente, y los insights y design versions la boutique.
                </span>
              </Card>
            )}
            {clases.map((clase) => (
              <Clase
                key={clase}
                clase={clase}
                cuantos={conteo.porClase[clase]}
                filas={filasDeClase(clase, datos)}
              />
            ))}
          </>
        )}
      </main>
    </div>
  );
}

/** El total del rol y el reparto por clase: el mismo número que el contador del lateral. */
function Cabecera({
  rol,
  clases,
  total,
  porClase,
}: {
  rol: string;
  clases: ClasePendiente[];
  total: number;
  porClase: Record<ClasePendiente, number>;
}) {
  return (
    <Card style={{ padding: '18px 22px', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <span style={etiqueta}>Lo que decide tu rol · {ETIQUETA_ROL[rol] ?? rol}</span>
      <span
        style={{ font: '700 22px var(--font-sans)', color: 'var(--ink)', letterSpacing: '-.01em' }}
      >
        {total === 0 ? 'Nada pendiente de tu rol' : etiquetaDePendientes(total)}
      </span>
      {clases.length > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {clases.map((clase) => (
            <span
              key={clase}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '4px 10px',
                borderRadius: 'var(--r-pill)',
                background: porClase[clase] > 0 ? 'var(--warn-soft)' : 'var(--surface-sunken)',
                border: '1px solid var(--border)',
                font: '500 12px var(--font-sans)',
                color: porClase[clase] > 0 ? 'var(--text-body)' : 'var(--text-muted)',
              }}
            >
              <span
                style={{
                  font: '700 11px/16px var(--font-mono)',
                  minWidth: 16,
                  textAlign: 'center',
                  color: porClase[clase] > 0 ? '#fff' : 'var(--text-muted)',
                  background: porClase[clase] > 0 ? 'var(--warn)' : 'transparent',
                  borderRadius: 'var(--r-pill)',
                  padding: '0 5px',
                }}
              >
                {porClase[clase]}
              </span>
              {ETIQUETA_CLASE_PENDIENTE[clase]}
            </span>
          ))}
        </div>
      )}
    </Card>
  );
}

/**
 * Un grupo: su rótulo con lo DECIDIBLE, qué acto espera en él, y sus filas —o el aviso de
 * que no hay—. Puede haber filas y contar cero: un gate al que aún le falta algo se enseña
 * con su motivo, pero no es una decisión que se pueda tomar ahora.
 */
function Clase({
  clase,
  cuantos,
  filas,
}: {
  clase: ClasePendiente;
  cuantos: number;
  filas: ReactNode[];
}) {
  return (
    <section
      aria-label={ETIQUETA_CLASE_PENDIENTE[clase]}
      style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingTop: 6 }}>
        <span style={etiqueta}>
          {ETIQUETA_CLASE_PENDIENTE[clase]} · {cuantos}
          {filas.length > cuantos ? ` · ${filas.length - cuantos} en espera` : ''}
        </span>
        <span style={apunte}>{ACTO_DE_CLASE[clase]}</span>
      </div>
      {filas.length === 0 ? (
        <Card pending style={{ padding: '14px 20px' }}>
          <span style={{ font: '400 13px var(--font-sans)', color: 'var(--text-muted)' }}>
            Nada pendiente de tu rol
          </span>
        </Card>
      ) : (
        filas
      )}
    </section>
  );
}

function filasDeClase(clase: ClasePendiente, datos: PendientesDelRol): ReactNode[] {
  switch (clase) {
    case 'gate':
      return datos.gates.map((g) => (
        <Fila
          key={g.gateId}
          destino={destinoDeGate(g)}
          codigoDestino={g.proyectoCodigo}
          codigo={`G${g.numero}`}
          titulo={`Gate G${g.numero} de ${g.proyectoCodigo}`}
          detalle={
            g.falta.length === 0
              ? `Reto ${g.retoCodigo} · se puede aprobar ahora`
              : `Reto ${g.retoCodigo} · gate abierto, todavía no se puede aprobar`
          }
          // Los motivos son los de la BASE (`gate_faltas_para_aprobar`, la misma función
          // que invoca el guard al aprobar): lo que diga aquí es lo que rechazaría allí.
          aviso={
            g.falta.length > 0
              ? `Falta para poder aprobarlo: ${g.falta.map(motivoSinPreambulo).join(' · ')}`
              : null
          }
        />
      ));
    case 'derecho':
      return datos.derechos.map((d) => (
        <Fila
          key={d.evidenciaId}
          destino={destinoDeDerecho(d)}
          codigo="EVI"
          titulo={d.titulo}
          detalle={`Fuente: ${d.fuenteTitulo} · derechos sin decidir`}
        />
      ));
    case 'insight':
      return datos.insights.map((i) => (
        <Fila
          key={i.insightId}
          destino={destinoDeInsight(i)}
          codigo="INS"
          titulo={i.titulo}
          detalle={detalleDeInsight(i.afirmaciones, i.afirmacionesSinRespaldo)}
          // Validar va a fallar mientras una afirmación no-hipótesis no tenga una cita con
          // derechos vigentes, o no haya afirmaciones (el guard de validación): se avisa
          // aquí para que quien decide sepa que antes hay trabajo, no solo una firma.
          aviso={
            i.afirmaciones === 0
              ? 'Sin afirmaciones: no se puede validar todavía'
              : i.afirmacionesSinRespaldo > 0
                ? 'Falta respaldo: cita evidencia con derechos vigentes antes de validar'
                : null
          }
        />
      ));
    case 'design-version':
      return datos.designVersions.map((dv) => (
        <Fila
          key={dv.designVersionId}
          destino={destinoDeDesignVersion(dv)}
          codigoDestino={dv.codigo}
          codigo={dv.codigo}
          titulo={dv.titulo}
          detalle={`Proyecto ${dv.proyectoCodigo} · en borrador, aprobarla congela su snapshot`}
          aviso={
            !dv.journeyEnlazado
              ? 'Falta enlazar el journey to-be antes de aprobar'
              : !dv.conElementos
                ? 'Falta al menos un elemento de cambio antes de aprobar'
                : null
          }
        />
      ));
  }
}

function detalleDeInsight(afirmaciones: number, sinRespaldo: number): string {
  const base = `${afirmaciones} ${afirmaciones === 1 ? 'afirmación' : 'afirmaciones'}`;
  return sinRespaldo > 0 ? `${base} · ${sinRespaldo} sin respaldo usable` : base;
}

/**
 * Una decisión que espera: código, título, detalle y a dónde se va a decidirla. Toda la
 * fila es el enlace, y el pie nombra la pantalla destino para que se sepa antes del clic.
 */
function Fila({
  destino,
  codigoDestino,
  codigo,
  titulo,
  detalle,
  aviso = null,
}: {
  destino: Destino;
  /** El código con el que se nombra la pantalla destino (proyecto, design version). */
  codigoDestino?: string;
  codigo: string;
  titulo: string;
  detalle: string;
  /** Lo que la pantalla destino va a exigir antes de dejar decidir, si ya se sabe. */
  aviso?: string | null;
}) {
  return (
    <EnlaceA
      destino={destino}
      title={`Abrir ${etiquetaDeDestino(destino, codigoDestino)}`}
      style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}
    >
      <Card
        style={{
          padding: '14px 20px',
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          flexWrap: 'wrap',
        }}
      >
        <Tag>{codigo}</Tag>
        <div style={{ flex: 1, minWidth: 220, display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span style={{ font: '700 13.5px var(--font-sans)', color: 'var(--ink)' }}>{titulo}</span>
          <span style={apunte}>{detalle}</span>
          {aviso && (
            <span style={{ font: '500 12px var(--font-sans)', color: 'var(--warn)' }}>{aviso}</span>
          )}
        </div>
        <span
          style={{
            font: '500 12px var(--font-sans)',
            color: 'var(--accent)',
            whiteSpace: 'nowrap',
          }}
        >
          {etiquetaDeDestino(destino, codigoDestino)} →
        </span>
      </Card>
    </EnlaceA>
  );
}
