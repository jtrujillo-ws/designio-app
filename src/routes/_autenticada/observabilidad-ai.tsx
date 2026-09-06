import type { CSSProperties } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Tag } from '@/components/ui/Tag';
import { Wordmark } from '@/components/ui/Wordmark';
import { formatearCosteUsd } from '@/lib/ai/ai.degradacion';
import { observabilidadDelWorkspace } from '@/lib/ai/ai.functions';
import { ROLES_OBSERVABILIDAD_AI, type ObservabilidadDeCapacidad } from '@/lib/ai/ai.schemas';

/**
 * RF-08.9 — coste, latencia, tasa de error y tasa de aceptación por capacidad.
 *
 * §14 lo pone en la fila «Auditoría y operación», junto a la auditoría del workspace, y de ahí
 * sale su puerta de rol. Va en ruta propia y no dentro de la auditoría porque son dos lecturas
 * distintas —un flujo de eventos y un cuadro de métricas— y meterlas en una pantalla obligaba a
 * rehacer el loader de una pieza que ya funciona sin ninguna razón de producto.
 *
 * La puerta es de PANTALLA, y eso se dice aquí porque en la auditoría NO lo es: allí la
 * autoridad es la política RLS de `evento_dominio`, que a los demás roles les devuelve cero
 * filas. `llamada_ai` pide sólo membresía —el tope diario y el estado de la capacidad la leen
 * para todo el que abre el panel de propuestas—, así que aquí el suelo es más ancho que la
 * pantalla. Es el sentido seguro de la discrepancia, y cerrarlo por rol rompería lecturas ya
 * declaradas; queda como pregunta de producto en el cuerpo del PR.
 */
export const Route = createFileRoute('/_autenticada/observabilidad-ai')({
  loader: ({ context }) => {
    const workspaceId = context.membresiaActiva?.workspaceId;
    /*
     * Y no se pide si el rol no lo puede ver. No es una optimización: mandar al navegador un
     * cuadro de gasto que la pantalla luego no pinta es exactamente la avería de la ronda 47
     * de #48 —lo que no se puede mostrar tampoco tiene por qué viajar—, y aquí lo que viajaría
     * es la factura de la boutique.
     */
    const puedeVer = (ROLES_OBSERVABILIDAD_AI as readonly string[]).includes(
      context.membresiaActiva?.rol ?? '',
    );
    return workspaceId && puedeVer ? observabilidadDelWorkspace({ data: { workspaceId } }) : null;
  },
  component: PantallaObservabilidad,
});

const micro: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontWeight: 500,
  fontSize: 11,
  letterSpacing: '.08em',
  textTransform: 'uppercase',
  color: 'var(--text-muted)',
};

const celda: CSSProperties = {
  padding: '8px 10px',
  borderBottom: '1px solid var(--border)',
  font: '400 12.5px var(--font-sans)',
  color: 'var(--text-body)',
  textAlign: 'right',
  whiteSpace: 'nowrap',
};

/**
 * `null` se pinta con su palabra y no con un guion ni con un cero.
 *
 * Es la lección de la presencia literal, aplicada a una métrica: «sin datos» y «cero» dicen
 * cosas distintas, y un 0 % de error sobre cero llamadas es un verde que nadie se ha ganado.
 */
function Tasa({ valor }: { valor: number | null }) {
  if (valor === null) {
    return <span style={{ color: 'var(--text-faint)' }}>sin datos</span>;
  }
  return <>{(valor * 100).toFixed(0)}%</>;
}

function Ms({ valor }: { valor: number | null }) {
  if (valor === null) {
    return <span style={{ color: 'var(--text-faint)' }}>sin datos</span>;
  }
  return <>{valor.toLocaleString('es')} ms</>;
}

function Fila({ c }: { c: ObservabilidadDeCapacidad }) {
  return (
    <tr>
      <td style={{ ...celda, textAlign: 'left' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Tag>{c.capacidad}</Tag>
          <span style={{ color: 'var(--text-muted)' }}>{c.etiqueta}</span>
        </div>
      </td>
      <td style={celda}>{c.llamadasCerradas}</td>
      <td style={celda}>
        <Tasa valor={c.tasaError} />
      </td>
      <td style={celda}>
        {formatearCosteUsd(c.costoUsd)}
        {/* Cuántas líneas cerradas no tienen tarifa registrada. Sin este número nadie puede
            saber si el total de al lado es el total, y «no se sabe» no es «salió gratis». */}
        {c.llamadasSinTarifa > 0 && (
          <div style={{ font: '400 11px var(--font-sans)', color: 'var(--warn)' }}>
            {c.llamadasSinTarifa} sin tarifa
          </div>
        )}
      </td>
      <td style={celda}>
        <Ms valor={c.latenciaP50Ms} />
      </td>
      <td style={celda}>
        <Ms valor={c.latenciaP95Ms} />
      </td>
      <td style={celda}>
        <Tasa valor={c.tasaAceptacion} />
      </td>
      <td style={celda}>
        <Tasa valor={c.tasaCorreccion} />
      </td>
    </tr>
  );
}

function PantallaObservabilidad() {
  const datos = Route.useLoaderData();
  const { membresiaActiva } = Route.useRouteContext();
  const navigate = useNavigate();
  /*
   * Sin membresía activa NO hay rol, y eso no es «tu rol no alcanza»: es que no hay workspace
   * elegido. Con `rol = ''` las dos situaciones caían en el mismo mensaje y la pantalla
   * mandaba a pedir un permiso a quien lo que le falta es elegir dónde mirar. Lo dijo una
   * revisión; se separan, que es lo que ya hace el resto de la aplicación.
   */
  const sinWorkspace = membresiaActiva === undefined;
  const puedeVer =
    !sinWorkspace && (ROLES_OBSERVABILIDAD_AI as readonly string[]).includes(membresiaActiva.rol);

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
            Operación de la capa AI
          </span>
        </div>
        <Button variant="ghost" size="sm" onClick={() => navigate({ to: '/app' })}>
          ← Volver al loop
        </Button>
      </div>

      <main
        style={{
          maxWidth: 1000,
          margin: '0 auto',
          padding: '28px 24px 60px',
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
        }}
      >
        {!puedeVer || !datos ? (
          <Card style={{ padding: 20 }}>
            <span style={{ font: '400 13px/1.6 var(--font-sans)', color: 'var(--text-muted)' }}>
              {sinWorkspace
                ? 'Elige un workspace para ver la operación de su capa AI.'
                : puedeVer
                  ? 'Todavía no hay nada que leer de la capa AI en este workspace.'
                  : 'La operación de la capa AI la consultan quienes llevan el workspace. Tu rol no incluye esta lectura.'}
            </span>
          </Card>
        ) : (
          <>
            <Card style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={micro}>Lo que va pagado en este workspace</span>
              <span style={{ font: '700 20px var(--font-sans)', color: 'var(--ink)' }}>
                {formatearCosteUsd(datos.total.costoUsd)}
              </span>
              <span style={{ font: '400 12.5px/1.6 var(--font-sans)', color: 'var(--text-muted)' }}>
                {datos.total.llamadasCerradas} llamadas atendidas
                {datos.total.llamadasEnVuelo > 0 &&
                  ` · ${datos.total.llamadasEnVuelo} en vuelo, que todavía no son ni acierto ni fallo`}
                {/* Y las huérfanas aparte, porque no son ninguna de las otras dos: su cierre
                    se perdió, así que pueden haberse pagado y no tienen desenlace. */}
                {datos.total.llamadasHuerfanas > 0 &&
                  ` · ${datos.total.llamadasHuerfanas} sin cierre, que pueden haberse pagado y no tienen desenlace`}
                {datos.total.llamadasSinTarifa > 0 &&
                  ` · ${datos.total.llamadasSinTarifa} sin tarifa registrada, así que el total es un mínimo`}
                {' · '}
                {datos.total.propuestas} propuestas nacidas de ellas
              </span>
            </Card>

            <Card style={{ padding: 0, overflowX: 'auto' }}>
              <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 820 }}>
                <thead>
                  <tr>
                    {[
                      ['Capacidad', 'left'],
                      ['Llamadas', 'right'],
                      ['Error', 'right'],
                      ['Coste', 'right'],
                      ['Latencia p50', 'right'],
                      ['p95', 'right'],
                      ['Aceptación', 'right'],
                      ['Corrección', 'right'],
                    ].map(([texto, alineado]) => (
                      <th
                        key={texto}
                        // `scope` no es adorno: con scroll horizontal, un lector de pantalla
                        // no puede asociar una celda con su columna sin él.
                        scope="col"
                        style={{
                          ...micro,
                          padding: '10px',
                          textAlign: alineado as 'left' | 'right',
                          borderBottom: '1px solid var(--border)',
                        }}
                      >
                        {texto}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {datos.capacidades.map((c) => (
                    <Fila key={c.capacidad} c={c} />
                  ))}
                </tbody>
              </table>
            </Card>

            {/* Lo que estos números NO dicen, escrito donde se leen. Un cuadro de métricas sin
                esta nota invita a leer «aceptación» como calidad, y la aceptación mide que una
                persona dijo que sí — que es SYS-19 funcionando, no que la propuesta fuera
                buena. La fidelidad de las citas es otra medición (RF-08.7) y no está aquí. */}
            <span style={{ font: '400 12px/1.7 var(--font-sans)', color: 'var(--text-muted)' }}>
              «Aceptación» es cuántas propuestas decididas terminaron materializándose, y
              «corrección» cuántas de ésas hubo que editar antes. Ninguna de las dos mide si lo que
              la AI dijo estaba sostenido: eso lo mide el grounding, que es otra lectura.
            </span>
          </>
        )}
      </main>
    </div>
  );
}
