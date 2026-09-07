import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { definirCriterio, editarCriterioDeReto } from '@/lib/metodo/metodo.functions';
import { reparosDelEsquema } from '@/lib/medicion/medicion.schemas';
import {
  CriterioSchema,
  faltaEnCriterio,
  motivoParaNoDefinirCriterios,
  type CriterioDeReto,
} from '@/lib/metodo/metodo.schemas';

const micro = {
  font: '600 10.5px var(--font-mono)',
  letterSpacing: '.08em',
  textTransform: 'uppercase' as const,
  color: 'var(--text-muted)',
};

/** Lo que el formulario tiene en la mano, ya con la forma que el esquema espera. */
type Campos = {
  workspaceId: string;
  retoId: string;
  kpi: string;
  definicion: string;
  lineaBaseValor: string | null;
  lineaBaseFecha: string | null;
  lineaBasePlan: string;
  objetivo: string;
  ventanaDias: number | null;
  fechaPostMortem: string | null;
};

/**
 * LOS CRITERIOS DE ÉXITO DEL RETO, Y CÓMO SE ESCRIBEN A MANO.
 *
 * `definirCriterio` y `editarCriterioDeReto` existían, se exportaban y escribían en
 * `criterio_exito` desde que se escribió la capa del método — y no los llamaba ningún
 * componente. Con la AI apagada no había forma de crear un criterio, y SYS-22 los exige para
 * aprobar G0: la pantalla del proyecto avisaba «Sin criterios definidos: G0 no podrá
 * aprobarse» sin ofrecer nada con lo que arreglarlo. Ésta es esa puerta.
 *
 * Lo que se ofrece es exactamente lo que la base acepta, y las dos condiciones se dicen en
 * vez de dejarlas descubrir por el rechazo del servidor: el rol —la política admite al lead
 * de boutique y a quien diseña— y el congelado del reto, que contesta la propia base.
 */
export function CriteriosDelReto({
  workspaceId,
  retoId,
  criterios,
  criteriosCongelados,
  rol,
  onCambio,
  onError,
}: {
  workspaceId: string;
  retoId: string;
  criterios: CriterioDeReto[];
  criteriosCongelados: boolean;
  rol: string;
  onCambio: () => Promise<void> | void;
  onError: (mensaje: string | null) => void;
}) {
  const [ocupado, setOcupado] = useState(false);
  const [creando, setCreando] = useState(false);
  const [editando, setEditando] = useState<string | null>(null);
  const impedimento = motivoParaNoDefinirCriterios({ rol, criteriosCongelados });

  async function accion(fn: () => Promise<{ ok: boolean; error?: string }>, fallo: string) {
    setOcupado(true);
    onError(null);
    try {
      const r = await fn();
      if (r.ok) {
        setCreando(false);
        setEditando(null);
        await onCambio();
      } else onError(r.error ?? fallo);
    } catch {
      onError(fallo);
    } finally {
      setOcupado(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={micro}>Criterios de éxito (ventana por criterio, SYS-22)</span>
      {criterios.length === 0 && (
        <span style={{ font: '400 12.5px var(--font-sans)', color: 'var(--warn)' }}>
          Sin criterios definidos: G0 no podrá aprobarse.
        </span>
      )}
      {criterios.map((c) => {
        const falta = faltaEnCriterio(c);
        return (
          <div key={c.id} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div
              style={{
                font: '400 12.5px/1.5 var(--font-sans)',
                color: 'var(--text-body)',
                display: 'flex',
                alignItems: 'baseline',
                gap: 8,
                flexWrap: 'wrap',
              }}
            >
              <span>
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
              </span>
              {impedimento === null && editando === null && !creando && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={ocupado}
                  onClick={() => setEditando(c.id)}
                >
                  Editar
                </Button>
              )}
            </div>
            {/* Lo que le falta se DICE aquí y no en G0: descubrir en la aprobación que un
                criterio no servía obliga a rehacer el camino entero. */}
            {falta.length > 0 && (
              <span style={{ font: '400 12px var(--font-sans)', color: 'var(--warn)' }}>
                Le falta para G0: {falta.join(' · ')}
              </span>
            )}
            {/* La definición ES lo que el sponsor certifica en G0: sin ella a la
                vista, aprobaría un KPI cuyo cálculo nunca leyó. */}
            {c.definicion && (
              <div style={{ font: '400 12px var(--font-sans)', color: 'var(--text-muted)' }}>
                {c.definicion}
              </div>
            )}
            {editando === c.id && (
              <FormularioCriterio
                workspaceId={workspaceId}
                retoId={retoId}
                criterio={c}
                ocupado={ocupado}
                onCancelar={() => setEditando(null)}
                onEnviar={(datos) =>
                  accion(
                    () =>
                      editarCriterioDeReto({
                        data: {
                          workspaceId: datos.workspaceId,
                          criterioId: c.id,
                          kpi: datos.kpi,
                          definicion: datos.definicion,
                          lineaBaseValor: datos.lineaBaseValor,
                          lineaBaseFecha: datos.lineaBaseFecha,
                          lineaBasePlan: datos.lineaBasePlan,
                          objetivo: datos.objetivo,
                          ventanaDias: datos.ventanaDias,
                          fechaPostMortem: datos.fechaPostMortem,
                        },
                      }),
                    'No se pudo guardar el criterio; intenta de nuevo',
                  )
                }
              />
            )}
          </div>
        );
      })}

      {impedimento !== null ? (
        // Sin puerta, el motivo. Un bloque que no ofrece nada y no explica por qué es un
        // callejón mudo, y aquí el callejón dura hasta que alguien reabre la etapa 0.
        <span style={{ font: '400 12px var(--font-sans)', color: 'var(--text-muted)' }}>
          {impedimento}
        </span>
      ) : (
        !creando &&
        editando === null && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Button size="sm" variant="secondary" disabled={ocupado} onClick={() => setCreando(true)}>
              Añadir criterio
            </Button>
          </div>
        )
      )}
      {creando && (
        <FormularioCriterio
          workspaceId={workspaceId}
          retoId={retoId}
          criterio={null}
          ocupado={ocupado}
          onCancelar={() => setCreando(false)}
          onEnviar={(datos) =>
            accion(
              () => definirCriterio({ data: datos }),
              'No se pudo definir el criterio; intenta de nuevo',
            )
          }
        />
      )}
    </div>
  );
}

function FormularioCriterio({
  workspaceId,
  retoId,
  criterio,
  ocupado,
  onCancelar,
  onEnviar,
}: {
  workspaceId: string;
  retoId: string;
  criterio: CriterioDeReto | null;
  ocupado: boolean;
  onCancelar: () => void;
  onEnviar: (datos: Campos) => Promise<void>;
}) {
  const [datos, setDatos] = useState<Campos>({
    workspaceId,
    retoId,
    kpi: criterio?.kpi ?? '',
    definicion: criterio?.definicion ?? '',
    lineaBaseValor: criterio?.lineaBaseValor ?? null,
    lineaBaseFecha: criterio?.lineaBaseFecha ?? null,
    lineaBasePlan: criterio?.lineaBasePlan ?? '',
    objetivo: criterio?.objetivo ?? '',
    ventanaDias: criterio?.ventanaDias ?? null,
    fechaPostMortem: criterio?.fechaPostMortem ?? null,
  });
  /** Campos de texto: el vacío es cadena vacía. */
  const texto = (k: 'kpi' | 'definicion' | 'lineaBasePlan' | 'objetivo') => (v: string) =>
    setDatos((d) => ({ ...d, [k]: v }));
  /** Y los opcionales: el vacío es AUSENTE, no una cadena en blanco — SYS-22 distingue
   * «sin línea base» de «línea base vacía», y el esquema del servidor hace lo mismo. */
  const opcional = (k: 'lineaBaseValor' | 'lineaBaseFecha' | 'fechaPostMortem') => (v: string) =>
    setDatos((d) => ({ ...d, [k]: v === '' ? null : v }));
  // El botón lo decide el ESQUEMA sobre lo que se va a enviar, no una lista de condiciones
  // copiada a mano: es el mismo `CriterioSchema` que valida el servidor.
  const reparos = reparosDelEsquema(CriterioSchema, datos);
  // Y lo que le faltará para G0 se dice mientras se escribe, no al aprobar. No apaga el
  // botón: un criterio incompleto se guarda a propósito —es un borrador que se completa
  // luego—, y lo que no puede es pasar por completo sin que nadie lo haya dicho.
  const faltaParaG0 = faltaEnCriterio({
    id: '',
    kpi: datos.kpi,
    definicion: datos.definicion,
    lineaBaseValor: datos.lineaBaseValor,
    lineaBaseFecha: datos.lineaBaseFecha,
    lineaBasePlan: datos.lineaBasePlan,
    objetivo: datos.objetivo,
    ventanaDias: datos.ventanaDias,
    fechaPostMortem: datos.fechaPostMortem,
  });

  return (
    /*
     * Un `form` y no un `div`: terminar un campo de una línea y pulsar Enter tiene que
     * enviar, que es lo que espera quien escribe con el teclado y lo que hacen los demás
     * editores de esta casa. Dentro de los `textarea` Enter sigue metiendo un salto de línea.
     */
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (reparos.length === 0) void onEnviar(datos);
      }}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: 12,
        border: '1px solid var(--border-strong)',
        borderRadius: 'var(--r-sm)',
      }}
    >
      <span style={micro}>{criterio ? 'Editar criterio' : 'Nuevo criterio de éxito'}</span>
      <Input
        placeholder="KPI (obligatorio)"
        value={datos.kpi}
        disabled={ocupado}
        onChange={(e) => texto('kpi')(e.target.value)}
      />
      <Textarea
        placeholder="Definición: cómo se calcula exactamente este KPI"
        rows={3}
        value={datos.definicion}
        disabled={ocupado}
        onChange={(e) => texto('definicion')(e.target.value)}
      />
      <Input
        placeholder="Objetivo (a dónde tiene que llegar)"
        value={datos.objetivo}
        disabled={ocupado}
        onChange={(e) => texto('objetivo')(e.target.value)}
      />
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Input
          placeholder="Línea base: valor"
          value={datos.lineaBaseValor ?? ''}
          disabled={ocupado}
          onChange={(e) => opcional('lineaBaseValor')(e.target.value)}
        />
        <Input
          type="date"
          aria-label="Fecha de la línea base"
          value={datos.lineaBaseFecha ?? ''}
          disabled={ocupado}
          onChange={(e) => opcional('lineaBaseFecha')(e.target.value)}
        />
      </div>
      <Textarea
        placeholder="…o el plan para registrar la línea base, si todavía no hay valor"
        rows={2}
        value={datos.lineaBasePlan}
        disabled={ocupado}
        onChange={(e) => texto('lineaBasePlan')(e.target.value)}
      />
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Input
          type="number"
          min={1}
          placeholder="Ventana de medición (días)"
          value={datos.ventanaDias ?? ''}
          disabled={ocupado}
          onChange={(e) =>
            setDatos((d) => ({
              ...d,
              // El vacío es AUSENTE. `Number('')` es 0, y un 0 aquí es una ventana de cero
              // días que el esquema rechaza con un mensaje que no explica nada.
              ventanaDias: e.target.value === '' ? null : Number(e.target.value),
            }))
          }
        />
        <Input
          type="date"
          aria-label="Fecha del post mortem"
          value={datos.fechaPostMortem ?? ''}
          disabled={ocupado}
          onChange={(e) => opcional('fechaPostMortem')(e.target.value)}
        />
      </div>
      {faltaParaG0.length > 0 && (
        <span style={{ font: '400 12px var(--font-sans)', color: 'var(--warn)' }}>
          Así guardado, a G0 le faltará: {faltaParaG0.join(' · ')}
        </span>
      )}
      {reparos.length > 0 && (
        <span style={{ font: '400 12px var(--font-sans)', color: 'var(--danger)' }}>
          {reparos.join(' · ')}
        </span>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        <Button size="sm" type="submit" disabled={ocupado || reparos.length > 0}>
          {criterio ? 'Guardar' : 'Definir criterio'}
        </Button>
        <Button size="sm" variant="ghost" disabled={ocupado} onClick={onCancelar}>
          Cancelar
        </Button>
      </div>
    </form>
  );
}
