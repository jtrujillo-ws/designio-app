import type { CSSProperties, ReactNode } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Chip } from '@/components/ui/Chip';
import { EnlaceA } from '@/components/ui/EnlaceA';
import { Tag } from '@/components/ui/Tag';
import { Wordmark } from '@/components/ui/Wordmark';
import { COLOR_VEREDICTO, ETIQUETA_VEREDICTO } from '@/lib/medicion/medicion.schemas';
import { memoriaDelWorkspace } from '@/lib/memoria/memoria.functions';
import {
  agruparArquetiposPorSegmento,
  destinoDeLaDecision,
  destinoDelArquetipo,
  destinoDelInsight,
  destinoDelRetoCerrado,
  memoriaVacia,
  notaDeRecorte,
  resumenDeArquetipos,
  type ArquetipoEnMemoria,
  type GrupoDeSegmento,
} from '@/lib/memoria/memoria.schemas';
import {
  COLOR_ARQUETIPO,
  ETIQUETA_ESTADO_ARQUETIPO,
  ETIQUETA_TIPO_DECISION,
} from '@/lib/metodo/gobernanza.schemas';

/**
 * Biblioteca del cliente (CTX-01, §4.1 y §11 del prediseño): la memoria del workspace
 * activo, de solo lectura. Es una PROYECCIÓN sobre lo que el workspace ya sabe, no un
 * almacén aparte: conserva los arquetipos históricos por segmento como hipótesis a
 * confirmar o refutar en retos nuevos, y junto a ellos los insights validados, las
 * decisiones vigentes y los retos cerrados con su veredicto — que es lo que pre-puebla la
 * etapa 0 del siguiente reto. Todo se lee de sus módulos dueños; nada se edita aquí.
 */
export const Route = createFileRoute('/_autenticada/biblioteca')({
  loaderDeps: ({ search }) => ({ ws: search.ws }),
  loader: ({ context }) => {
    const workspaceId = context.membresiaActiva?.workspaceId;
    return workspaceId ? memoriaDelWorkspace({ data: { workspaceId } }) : null;
  },
  component: PantallaBiblioteca,
});

const micro: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontWeight: 500,
  fontSize: 11,
  letterSpacing: '.08em',
  textTransform: 'uppercase',
  color: 'var(--text-muted)',
};

const titulo: CSSProperties = { font: '700 14px var(--font-sans)', color: 'var(--ink)' };
const cuerpo: CSSProperties = {
  font: '400 13px/1.6 var(--font-sans)',
  color: 'var(--text-body)',
  margin: 0,
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
};
const pie: CSSProperties = { font: '400 12px var(--font-sans)', color: 'var(--text-faint)' };
const enlace: CSSProperties = {
  font: '600 12.5px var(--font-sans)',
  color: 'var(--accent)',
  textDecoration: 'none',
};
const separador: CSSProperties = { borderTop: '1px solid var(--border)', paddingTop: 12 };

function PantallaBiblioteca() {
  const datos = Route.useLoaderData();
  const { membresiaActiva } = Route.useRouteContext();
  const navigate = useNavigate();

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
            Biblioteca del cliente
          </span>
        </div>
        <Button variant="ghost" size="sm" onClick={() => navigate({ to: '/app' })}>
          ← Volver al loop
        </Button>
      </div>

      <main
        style={{
          maxWidth: 900,
          margin: '0 auto',
          padding: '28px 24px 60px',
          display: 'flex',
          flexDirection: 'column',
          gap: 18,
        }}
      >
        {!membresiaActiva && (
          <Card style={{ padding: 24 }}>
            <span style={{ font: '400 13.5px var(--font-sans)', color: 'var(--text-muted)' }}>
              Aún no perteneces a ningún workspace.
            </span>
          </Card>
        )}
        {membresiaActiva && !datos && (
          <Card style={{ padding: 24 }}>
            <span style={{ font: '400 13.5px var(--font-sans)', color: 'var(--text-muted)' }}>
              Tu sesión ya no tiene acceso a este workspace; vuelve a entrar.
            </span>
          </Card>
        )}
        {datos && (
          <>
            <Card style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <span style={{ font: '700 15px var(--font-sans)', color: 'var(--ink)' }}>
                Lo que {datos.workspaceNombre} ya sabe
              </span>
              <span style={{ font: '400 13px/1.6 var(--font-sans)', color: 'var(--text-muted)' }}>
                La biblioteca no es un almacén aparte: es la memoria del workspace leída de una vez.
                Los arquetipos de retos anteriores se conservan por segmento como hipótesis a
                confirmar o refutar en el siguiente reto; los insights validados, las decisiones
                vigentes y los veredictos de los retos cerrados son lo que pre-puebla su etapa 0.
                Nada se edita aquí — cada pieza se abre en la pantalla donde nació.
              </span>
              {memoriaVacia(datos) && (
                <span
                  role="status"
                  style={{ font: '500 12.5px var(--font-sans)', color: 'var(--warn)' }}
                >
                  Todavía no hay memoria: este workspace no ha validado insights ni cerrado ningún
                  reto.
                </span>
              )}
            </Card>

            <SeccionArquetipos
              grupos={agruparArquetiposPorSegmento(datos.segmentos, datos.arquetipos)}
              arquetipos={datos.arquetipos}
              total={datos.totales.arquetipos}
            />

            <Seccion
              titulo="Insights validados"
              cabecera={`${datos.totales.insights} ${datos.totales.insights === 1 ? 'insight validado' : 'insights validados'}`}
              recorte={notaDeRecorte(
                datos.insights.length,
                datos.totales.insights,
                'Insights y citas',
              )}
              vacio="Todavía no hay insights validados: un insight propuesto no es memoria hasta que alguien lo valida con sus citas."
              items={datos.insights}
              render={(i) => (
                <>
                  <span style={titulo}>{i.titulo}</span>
                  {i.resumen && <p style={cuerpo}>{i.resumen}</p>}
                  <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={pie}>Validado el {i.validadoEn}</span>
                    <EnlaceA destino={destinoDelInsight(i)} style={enlace}>
                      Ver en Insights y citas →
                    </EnlaceA>
                  </div>
                </>
              )}
            />

            <Seccion
              titulo="Decisiones vigentes"
              cabecera={`${datos.totales.decisiones} ${datos.totales.decisiones === 1 ? 'decisión vigente' : 'decisiones vigentes'}`}
              recorte={notaDeRecorte(
                datos.decisiones.length,
                datos.totales.decisiones,
                'el proyecto de cada decisión',
              )}
              vacio="Todavía no hay decisiones vigentes. Las que estén en revisión por una reapertura no se listan: hasta que se revaliden son una pregunta, no memoria."
              items={datos.decisiones}
              render={(d) => (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <Tag>G{d.gateNumero}</Tag>
                    <span style={micro}>{ETIQUETA_TIPO_DECISION[d.tipo]}</span>
                    <span style={{ ...titulo, flex: 1, minWidth: 200 }}>{d.titulo}</span>
                  </div>
                  {d.fundamento && <p style={cuerpo}>{d.fundamento}</p>}
                  <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={pie}>Decidida el {d.decididoEn}</span>
                    <EnlaceA destino={destinoDeLaDecision(d)} style={enlace}>
                      Abrir proyecto {d.proyecto.codigo} →
                    </EnlaceA>
                  </div>
                </>
              )}
            />

            <Seccion
              titulo="Retos cerrados y su veredicto"
              cabecera={`${datos.totales.retosCerrados} ${datos.totales.retosCerrados === 1 ? 'reto cerrado' : 'retos cerrados'}`}
              recorte={notaDeRecorte(
                datos.retosCerrados.length,
                datos.totales.retosCerrados,
                'el árbol del loop',
              )}
              vacio="Todavía no hay retos cerrados: el veredicto lo dicta el outcome review al final de la ventana de medición."
              items={datos.retosCerrados}
              render={(r) => (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <Tag>{r.codigo}</Tag>
                    <span style={{ ...titulo, flex: 1, minWidth: 200 }}>{r.titulo}</span>
                    {r.estado === 'archivado' && <Tag mono={false}>archivado</Tag>}
                    {r.veredicto ? (
                      // El color es el del proyecto (COLOR_VEREDICTO): «no logrado» no sale en verde.
                      <span
                        style={{
                          font: '700 12.5px var(--font-sans)',
                          color: COLOR_VEREDICTO[r.veredicto],
                        }}
                      >
                        {ETIQUETA_VEREDICTO[r.veredicto]}
                      </span>
                    ) : (
                      // Cerrado antes de que existiera el post mortem: no se le inventa veredicto.
                      <span
                        style={{ font: '600 11.5px var(--font-sans)', color: 'var(--text-faint)' }}
                      >
                        sin veredicto registrado
                      </span>
                    )}
                  </div>
                  {r.contribucion && (
                    <p style={cuerpo}>
                      <strong>Contribución:</strong> {r.contribucion}
                    </p>
                  )}
                  {r.aprendizajes && (
                    <p style={cuerpo}>
                      <strong>Aprendizajes:</strong> {r.aprendizajes}
                    </p>
                  )}
                  <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                    {r.cerradoEn && (
                      <span style={pie}>Outcome review completado el {r.cerradoEn}</span>
                    )}
                    <EnlaceAlProyecto
                      destino={destinoDelRetoCerrado(r)}
                      codigo={r.proyecto?.codigo}
                    />
                  </div>
                </>
              )}
            />

            <Seccion
              titulo="Retos candidatos nacidos del post mortem"
              cabecera={`${datos.totales.retosCandidatos} ${datos.totales.retosCandidatos === 1 ? 'reto candidato' : 'retos candidatos'}`}
              recorte={notaDeRecorte(
                datos.retosCandidatos.length,
                datos.totales.retosCandidatos,
                'el árbol del loop',
              )}
              vacio="Ningún post mortem ha dejado retos candidatos todavía."
              items={datos.retosCandidatos}
              render={(r) => (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <Tag>{r.codigo}</Tag>
                    <span style={{ ...titulo, flex: 1, minWidth: 200 }}>{r.titulo}</span>
                    <Chip estado="candidato" />
                  </div>
                  {r.descripcion && <p style={cuerpo}>{r.descripcion}</p>}
                  {r.metricaObjetivo && (
                    <span style={pie}>Métrica objetivo: {r.metricaObjetivo}</span>
                  )}
                </>
              )}
            />
          </>
        )}
      </main>
    </div>
  );
}

/**
 * Una sección de la memoria: cabecera con conteo, y o bien la lista o bien la frase que
 * dice que está vacía. Que una sección vacía lo DIGA es parte del contrato: una biblioteca
 * que omite la sección deja al lector sin saber si no hay nada o si no se buscó.
 */
function Seccion<T extends { id: string }>({
  titulo: rotulo,
  cabecera,
  recorte,
  vacio,
  items,
  render,
}: {
  titulo: string;
  cabecera: string;
  /** La nota de recorte (ver notaDeRecorte), o null si la lista es entera. */
  recorte: string | null;
  vacio: string;
  items: T[];
  render: (item: T) => ReactNode;
}) {
  return (
    <section aria-label={rotulo} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <span style={{ font: '700 15px var(--font-sans)', color: 'var(--ink)' }}>{rotulo}</span>
        <span style={micro}>{cabecera}</span>
      </div>
      {recorte && <NotaDeRecorte>{recorte}</NotaDeRecorte>}
      {items.length === 0 ? (
        <Card pending style={{ padding: 18 }}>
          <span style={{ font: '400 13px/1.55 var(--font-sans)', color: 'var(--text-muted)' }}>
            {vacio}
          </span>
        </Card>
      ) : (
        items.map((item) => (
          <Card
            key={item.id}
            style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 8 }}
          >
            {render(item)}
          </Card>
        ))
      )}
    </section>
  );
}

/** Los arquetipos van agrupados por segmento (§4.1): una tarjeta por segmento, no una por arquetipo. */
function SeccionArquetipos({
  grupos,
  arquetipos,
  total,
}: {
  grupos: GrupoDeSegmento[];
  arquetipos: ArquetipoEnMemoria[];
  /** Cuántos hay en el workspace; `arquetipos` trae como mucho el tope. */
  total: number;
}) {
  // El desglose por estado es de los que se ENSEÑAN: los que el tope dejó fuera no se
  // pueden contar por estado sin traerlos, y la nota de recorte ya dice que faltan.
  const resumen = resumenDeArquetipos(arquetipos);
  const cabecera =
    total === 0
      ? '0 arquetipos'
      : `${total} ${total === 1 ? 'arquetipo' : 'arquetipos'} · ${resumen.confirmado} ${resumen.confirmado === 1 ? 'confirmado' : 'confirmados'} · ${resumen.hipotesis} hipótesis · ${resumen.refutado} ${resumen.refutado === 1 ? 'refutado' : 'refutados'}`;
  const recorte = notaDeRecorte(arquetipos.length, total, 'el proyecto de cada reto');
  return (
    <section
      aria-label="Arquetipos por segmento"
      style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <span style={{ font: '700 15px var(--font-sans)', color: 'var(--ink)' }}>
          Arquetipos por segmento
        </span>
        <span style={micro}>{cabecera}</span>
      </div>
      {recorte && <NotaDeRecorte>{recorte}</NotaDeRecorte>}
      {grupos.length === 0 && (
        <Card pending style={{ padding: 18 }}>
          <span style={{ font: '400 13px/1.55 var(--font-sans)', color: 'var(--text-muted)' }}>
            Este workspace no tiene segmentos ni arquetipos todavía: los primeros nacen en la etapa
            2 de un reto, desde su evidencia.
          </span>
        </Card>
      )}
      {grupos.map((g) => (
        <Card
          key={g.segmento?.id ?? 'sin-segmento'}
          pending={g.arquetipos.length === 0}
          style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={titulo}>{g.segmento ? g.segmento.nombre : 'Sin segmento declarado'}</span>
            {g.segmento?.definicion && (
              <span style={{ font: '400 12.5px/1.5 var(--font-sans)', color: 'var(--text-muted)' }}>
                {g.segmento.definicion}
              </span>
            )}
          </div>
          {g.arquetipos.length === 0 ? (
            <span style={{ font: '400 13px/1.55 var(--font-sans)', color: 'var(--text-muted)' }}>
              Sin arquetipos en este segmento todavía.
            </span>
          ) : (
            g.arquetipos.map((a) => (
              <div
                key={a.id}
                style={{ ...separador, display: 'flex', flexDirection: 'column', gap: 6 }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <span
                    style={{
                      font: '600 13.5px var(--font-sans)',
                      color: 'var(--ink)',
                      flex: 1,
                      minWidth: 160,
                    }}
                  >
                    {a.nombre}
                  </span>
                  <span
                    style={{
                      font: '600 11.5px var(--font-sans)',
                      color: COLOR_ARQUETIPO[a.estado],
                    }}
                  >
                    {ETIQUETA_ESTADO_ARQUETIPO[a.estado]}
                  </span>
                </div>
                {a.definicion && <p style={cuerpo}>{a.definicion}</p>}
                {a.veredictoRazon && (
                  <span
                    style={{ font: '400 12.5px/1.5 var(--font-sans)', color: 'var(--text-muted)' }}
                  >
                    Veredicto: {a.veredictoRazon}
                  </span>
                )}
                <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={pie}>
                    Nació en el reto <Tag>{a.reto.codigo}</Tag> {a.reto.titulo}
                  </span>
                  <EnlaceAlProyecto destino={destinoDelArquetipo(a)} codigo={a.proyecto?.codigo} />
                </div>
              </div>
            ))
          )}
        </Card>
      ))}
    </section>
  );
}

/** La sección recortó por el tope: se dice antes de la lista, no al final donde nadie llega. */
function NotaDeRecorte({ children }: { children: ReactNode }) {
  return (
    <span role="status" style={{ font: '500 12.5px/1.5 var(--font-sans)', color: 'var(--warn)' }}>
      {children}
    </span>
  );
}

/** El enlace al proyecto, o la razón de que no lo haya: un reto sin proyecto no tiene pantalla. */
function EnlaceAlProyecto({
  destino,
  codigo,
}: {
  destino: ReturnType<typeof destinoDelArquetipo>;
  codigo: string | undefined;
}) {
  if (!destino) return <span style={pie}>Su reto no tiene proyecto todavía.</span>;
  return (
    <EnlaceA destino={destino} style={enlace}>
      Abrir proyecto {codigo} →
    </EnlaceA>
  );
}
