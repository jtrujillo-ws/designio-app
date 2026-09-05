import { useState } from 'react';
import type { CSSProperties, FormEvent, ReactNode } from 'react';
import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Checkbox } from '@/components/ui/Checkbox';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Tag } from '@/components/ui/Tag';
import { Textarea } from '@/components/ui/Textarea';
import { Wordmark } from '@/components/ui/Wordmark';
import { formatearCosteUsd } from '@/lib/ai/ai.degradacion';
import {
  aceptarPropuestaAI,
  generarPropuestasAI,
  propuestasDelWorkspace,
  rechazarPropuestaAI,
  registrarConsentimientoAI,
} from '@/lib/ai/ai.functions';
import {
  CAPACIDADES_ACTIVAS,
  CAPACIDADES,
  type CapacidadActiva,
  type PanelPropuestas,
  type ConsentimientoDeItem,
  type EstadoAncla,
  type ContenidoAsistenteGate,
  type ContenidoCriterio,
  type ContenidoEntradaKpi,
  type ContenidoExtraccion,
  type ContenidoInsight,
  type ContenidoRemediacionJourney,
  type ContenidoPropuesta,
  type Destino,
  type PropuestaEnPanel,
} from '@/lib/ai/ai.schemas';
import { ROLES_CURADORES } from '@/lib/evidencia/evidencia.schemas';

/**
 * Panel de propuestas AI (SPEC-08): lo que la AI propuso, con qué citas y con qué
 * lineage, esperando que una persona acepte, corrija o rechace. Ningún objeto del dominio
 * existe hasta esa decisión (I4/SYS-19).
 *
 * La pantalla se pinta IGUAL con la AI apagada (SYS-21): la bandera dice por qué, los
 * botones de generar se desactivan y todo lo demás —revisar lo ya propuesto, y los
 * caminos manuales de la bandeja y del método— sigue disponible.
 */
export const Route = createFileRoute('/_autenticada/propuestas')({
  // `q` filtra las anclas que el formulario de generación puede ofrecer. Vive en la URL y
  // no en un estado local porque es lo que decide QUÉ pide el loader: sin viajar al
  // servidor, buscar solo filtraría las 50 que ya bajaron, que es justo lo que no sirve
  // cuando el problema es que hay más anclas elegibles que sitio en la lista.
  validateSearch: (search: Record<string, unknown>): { q?: string } => {
    const q = typeof search.q === 'string' ? search.q.trim().slice(0, 100) : '';
    return q ? { q } : {};
  },
  loaderDeps: ({ search }) => ({ ws: search.ws, q: search.q ?? '' }),
  loader: ({ context, deps }) => {
    const workspaceId = context.membresiaActiva?.workspaceId;
    return workspaceId
      ? propuestasDelWorkspace({ data: { workspaceId, busqueda: deps.q } })
      : null;
  },
  component: PantallaPropuestas,
});

const etiqueta: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontWeight: 500,
  fontSize: 11,
  letterSpacing: '.08em',
  textTransform: 'uppercase',
  color: 'var(--text-muted)',
};

const campo: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6 };

const COLOR_ESTADO: Record<PropuestaEnPanel['estado'], string> = {
  propuesta: 'var(--warn)',
  aceptada: 'var(--accent)',
  corregida: 'var(--accent)',
  rechazada: 'var(--text-faint)',
};

/** Por qué una propuesta pendiente dejó de poder aceptarse. Cada motivo dice además cuál
 * es la salida, que no es la misma: un item curado a mano ya tiene su evidencia, un
 * consentimiento retirado deja el material fuera de la AI (pero la bandeja sigue abierta) y
 * unos criterios congelados por el G0 esperan a la reapertura de su etapa. Congelados por un
 * registry FIRMADO es otro motivo y no una redacción del mismo: ahí no hay reapertura que
 * valga, así que ofrecer esa salida sería mandar al lead a un trámite que no desbloquea
 * nada. */
/**
 * Y cuáles de esos motivos dejan abierta la CORRECCIÓN.
 *
 * La pantalla trataba todo estado distinto de `disponible` como «esta propuesta ya solo se
 * rechaza», y eso era exacto mientras todos los motivos hablaran del ancla: si el item se curó,
 * si el reto se archivó o si el registry se firmó, corregir el texto no arregla nada — lo que
 * cambió está fuera de la propuesta.
 *
 * `nombre-ocupado` rompe esa equivalencia y por eso hace falta este registro. No es un motivo
 * del ancla: es una COLISIÓN DEL CONTENIDO con lo que hay en el registry, el servidor acepta la
 * corrección que la arregla, y el propio mensaje le dice a quien revisa que corrija el nombre.
 * Con el botón apagado, la pantalla decía una cosa y ofrecía la contraria.
 *
 * `Record<EstadoAncla, boolean>` y no una lista de excepciones: un estado nuevo tiene que
 * decidir a cuál de los dos grupos pertenece, que es justo lo que este caso demuestra que no se
 * puede heredar. «Aceptar tal cual» sigue apagado en los dos: eso lo gobierna `anclaDisponible`.
 */
const CORREGIR_SIGUE_ABIERTO: Record<EstadoAncla, boolean> = {
  // `disponible` no pasa por aquí —el botón ya está activo—, pero la entrada existe porque el
  // registro es exhaustivo y una respuesta es más clara que una ausencia.
  disponible: true,
  'item-curado': false,
  'consentimiento-revocado': false,
  'criterios-congelados': false,
  'registry-firmado': false,
  'registry-cerrado': false,
  // El criterio al que la entrada responde ya no está, y ese campo es TESTIMONIO: no se
  // corrige. Sin criterio al que apuntar, la única salida es rechazar.
  'criterio-ausente': false,
  // La única que SÍ: el nombre es del contenido, se corrige, y corregirlo es exactamente lo
  // que el mensaje pide.
  'nombre-ocupado': true,
  // El material se movió por debajo: corregir el texto de la propuesta no devuelve el
  // criterio a lo que el modelo leyó, así que la única salida es rechazar y pedir otro lote.
  'criterios-cambiados': false,
  // Y tampoco: lo que falta no es texto de la propuesta, es poder comparar su material.
  'material-no-comparable': false,
  'reto-no-admite': false,
  'gate-decidido': false,
  'checklist-avanzado': false,
  'reto-archivado': false,
  'evidencia-no-citable': false,
  'alcance-incompleto': false,
  'journey-cambiado': false,
  'ancla-ausente': false,
};

const MOTIVO_ANCLA: Record<EstadoAncla, string> = {
  disponible: '',
  'item-curado': 'El item ya se curó a mano: esta propuesta quedó obsoleta y solo puede rechazarse.',
  'consentimiento-revocado':
    'El consentimiento de ese material ya no autoriza el procesamiento externo: esta propuesta quedó obsoleta y solo puede rechazarse. El item sigue pudiendo curarse a mano en la bandeja.',
  'criterios-congelados':
    'El G0 del reto se aprobó y sus criterios quedaron congelados: esta propuesta quedó obsoleta y solo puede rechazarse. Reabrir la etapa 0 los descongela.',
  'registry-firmado':
    'El registry de medición de ese reto ya está firmado: sus criterios son el contrato acordado y la firma no se deshace (SYS-22). Esta propuesta quedó obsoleta y solo puede rechazarse.',
  'registry-cerrado':
    'El Metric Registry de ese reto ya no admite entradas: o se firmó —y firmarlo congela el contrato de medición (SYS-22)— o el trabajo de su reto se cerró. Esta propuesta quedó obsoleta y solo puede rechazarse.',
  'criterio-ausente':
    'El criterio de éxito al que responde esta entrada ya no está entre los del reto de su registry: sin la promesa que dice medir, el KPI no se puede aceptar. La propuesta solo puede rechazarse.',
  'nombre-ocupado':
    'Ya hay una entrada con ese nombre en el registry, y el nombre es su clave: corrígelo antes de aceptar, o rechaza la propuesta.',
  'reto-no-admite':
    'Ese reto ya no admite criterios nuevos: solo los admite mientras es candidato o está activo, y este ya avanzó a medición, cierre o archivo. La propuesta quedó obsoleta y solo puede rechazarse.',
  'gate-decidido':
    'Ese gate ya se decidió: este informe describe un estado que ya pasó. Puedes leerlo, pero lo que dice que falta ya no aplica.',
  'reto-archivado':
    'Ese reto está archivado: su trabajo se cerró y esta propuesta quedó obsoleta, así que solo puede rechazarse.',
  'evidencia-no-citable':
    'Alguna de las evidencias que este insight cita ya no se puede citar al cliente: su derecho de uso se retiró, caducó o el documento ya no está. Aceptarlo fallaría al escribir la cita (DR001), así que por ahora solo puede rechazarse. Si el derecho vuelve, la propuesta vuelve a poder aceptarse sin hacer nada.',
  'alcance-incompleto':
    'Ese reto tiene evidencia que estos insights no llegaron a ver: se enlazó después de generarlos, o no cabía en el material que se le mandó al modelo. Aceptarlos sellaría un análisis que no la miró, así que por ahora solo pueden rechazarse. Vuelve a pedirlos para que la tenga en cuenta.',
  'journey-cambiado':
    'El grafo de ese journey cambió desde que se generó el informe: alguna de las señales que remedia ya no está abierta, o el grafo que describe ya no es el que hay. Puedes leerlo, pero comprueba contra el journey antes de aplicar nada.',
  'checklist-avanzado':
    'Alguno de los requisitos que este informe señalaba ya se cerró: lo que dice que falta no describe el estado actual del gate. Vuelve a pedirlo si quieres uno al día.',
  'criterios-cambiados':
    'Los criterios de éxito de ese reto cambiaron desde que el modelo los leyó: esta entrada se escribió contra una definición, un objetivo o una ventana que ya no son los vigentes. Recházala y pide un lote nuevo.',
  'material-no-comparable':
    'Esta propuesta se generó con otra versión del prompt, así que no se puede comprobar si los criterios siguen siendo los que el modelo leyó. No es que hayan cambiado: es que no se sabe. Recházala y pide un lote nuevo.',
  'ancla-ausente': 'No se pudo comprobar el estado del objeto de origen: refresca la pantalla antes de decidir.',
};

const TEXTO_ESTADO: Record<PropuestaEnPanel['estado'], string> = {
  propuesta: 'pendiente de revisión humana',
  aceptada: 'aceptada tal cual',
  corregida: 'corregida y aceptada',
  rechazada: 'rechazada',
};

function PantallaPropuestas() {
  const datos = Route.useLoaderData();
  const { membresiaActiva } = Route.useRouteContext();
  const navigate = useNavigate();
  const router = useRouter();
  const rol = membresiaActiva?.rol ?? '';
  const puedeRevisar = (ROLES_CURADORES as readonly string[]).includes(rol);
  // Los mensajes son estado local y se quedan en estado local: cambiar de workspace REMONTA
  // esta pantalla, así que no pueden sobrevivir al workspace del que hablaban.
  //
  // Aquí vivía una etiqueta de dueño por mensaje —`{ ws, texto }`, descartada al pintar si no
  // coincidía— defendiendo de que la ruta se reutilizara entre workspaces. No se reutiliza:
  // `_autenticada.tsx` renderiza `<Outlet key={membresiaActiva?.workspaceId} />` justamente
  // para que todo lo que cuelga de ahí se remonte y el `useState` vuelva a nacer, y su
  // docstring dice que ésa es la única razón de que ese componente exista. La etiqueta no
  // podía diferir nunca, y el comentario que la justificaba enseñaba lo contrario de cómo
  // está montado el router — que es peor que el estado de más: el siguiente que escriba una
  // pantalla se lo habría creído.
  const [error, errar] = useState<string | null>(null);
  const [aviso, avisar] = useState<string | null>(null);

  async function refrescar() {
    errar(null);
    await router.invalidate();
  }

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
            Propuestas AI
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
        {!datos && (
          <Card style={{ padding: 24 }}>
            <span style={{ font: '400 13.5px var(--font-sans)', color: 'var(--text-muted)' }}>
              Aún no perteneces a ningún workspace.
            </span>
          </Card>
        )}
        {datos && (
          <>
            <BanderaAI ai={datos.ai} />
            {puedeRevisar ? (
              <FormularioGeneracion
                workspaceId={datos.workspaceId}
                habilitada={datos.ai.disponible}
                candidatas={datos.candidatas}
                busqueda={datos.busqueda}
                onBuscar={(texto) =>
                  navigate({
                    to: '/propuestas',
                    search: (prev) => ({ ...prev, q: texto || undefined }),
                  })
                }
                onGenerado={async (n) => {
                  // Cero es un desenlace, no un fallo: hay capacidades cuya respuesta correcta
                  // puede ser «nada» —C2 tiene prohibido proponer lo que la evidencia no
                  // sostenga—, y la llamada se pagó igual. «0 propuestas en espera de revisión»
                  // es cierto y no dice nada; quien lo lee necesita saber que el modelo miró y
                  // no encontró, para no volver a pedirlo esperando otra cosa.
                  avisar(
                    n === 0
                      ? 'El modelo no encontró nada que proponer con ese material y no dejó ninguna propuesta. La llamada queda anotada en el libro de costos.'
                      : `${n} propuesta${n === 1 ? '' : 's'} en espera de revisión humana`,
                  );
                  await refrescar();
                }}
                onConsentimiento={async (r) => {
                  avisar(
                    r.autorizaExterno
                      ? `Consentimiento registrado (nº ${r.version}): ya puedes pedir la propuesta`
                      : `Consentimiento registrado (nº ${r.version}). No cubre el procesamiento externo, así que la generación sigue bloqueada; si la persona lo autoriza después, registra un consentimiento nuevo y ese pasará a ser el vigente.`,
                  );
                  await refrescar();
                }}
                onError={(e) => {
                  avisar(null);
                  errar(e);
                }}
              />
            ) : null}
            {puedeRevisar && datos.materialDePersonas.length > 0 && (
              <BitacoraConsentimientos
                workspaceId={datos.workspaceId}
                items={datos.materialDePersonas}
                hayMas={datos.hayMasMaterial}
                onRegistrado={async (r) => {
                  errar(null);
                  avisar(
                    r.autorizaExterno
                      ? `Consentimiento registrado (nº ${r.version}): ese material ya puede procesarse con el proveedor AI`
                      : `Consentimiento registrado (nº ${r.version}): ese material deja de poder procesarse con el proveedor AI. Las propuestas pendientes sobre él solo pueden rechazarse.`,
                  );
                  await refrescar();
                }}
                onError={(e) => {
                  avisar(null);
                  errar(e);
                }}
              />
            )}
            {!puedeRevisar && (
              <Card style={{ padding: 20 }}>
                <span style={{ font: '400 13px var(--font-sans)', color: 'var(--text-muted)' }}>
                  Las propuestas AI las piden y deciden lead-boutique o diseñador. Aquí puedes
                  ver qué se propuso, con qué citas y quién lo decidió.
                </span>
              </Card>
            )}
            {error && (
              <span role="alert" style={{ font: '500 13px var(--font-sans)', color: 'var(--danger)' }}>
                {error}
              </span>
            )}
            {aviso && !error && (
              <span style={{ font: '500 13px var(--font-sans)', color: 'var(--accent)' }}>{aviso}</span>
            )}

            <div style={{ ...etiqueta, paddingTop: 6 }}>
              {datos.pendientes.length === 0
                ? 'Sin propuestas pendientes de revisión'
                : `${datos.totalPendientes} pendientes de revisión humana, las más dudosas primero`}
            </div>
            {datos.hayMasPendientes && (
              <Aviso>
                Se muestran {datos.pendientes.length} de {datos.totalPendientes} pendientes, las de
                MENOR confianza declarada primero: tu revisión rinde más ahí. Las{' '}
                {datos.totalPendientes - datos.pendientes.length} que quedan detrás son las que el
                modelo dio por más fiables, y al final las que no declararon confianza —que no es
                lo mismo que declararla alta—. Siguen pendientes, no revisadas: decide estas y
                aparecerán.
              </Aviso>
            )}
            {datos.pendientes.map((p) => (
              <TarjetaPropuesta
                key={p.id}
                propuesta={p}
                workspaceId={datos.workspaceId}
                puedeRevisar={puedeRevisar}
                onCambio={refrescar}
                onError={errar}
              />
            ))}

            {datos.respaldo.aceptadas + datos.respaldo.corregidas + datos.respaldo.rechazadas >
              0 && <RespaldoHumano respaldo={datos.respaldo} />}

            {datos.decididas.length > 0 && (
              <>
                <div style={{ ...etiqueta, paddingTop: 14 }}>Decididas recientes</div>
                {/* El reparto aceptada/corregida que se lee AQUÍ es el insumo de la tasa de
                    corrección humana (SYS-17), así que aquí es donde toca decir hasta dónde
                    llega. Si el límite vive solo en el comentario de la migración, quien lea
                    la tasa dentro de seis meses la leerá como si fuera medida, y no lo es del
                    todo: la base garantiza que el reparto no se maquilla —lo decide ella
                    comparando contenido con original— y que cada propuesta cuelga de la
                    llamada que la pagó, pero no puede verificar que el contenido lo
                    devolviera un modelo, porque no participa en esa llamada. */}
                <Aviso>
                  El reparto entre «aceptada» y «corregida» es el insumo de la tasa de
                  corrección humana. La base impide maquillarlo —compara el contenido con el
                  original— y ata cada propuesta a la llamada que la pagó; lo que no puede
                  verificar es que ese contenido lo devolviera un modelo, porque no participa
                  en la llamada al proveedor: eso lo atestigua la aplicación.
                </Aviso>
                {datos.hayMasDecididas && (
                  <Aviso>
                    Solo las {datos.decididas.length} decisiones más recientes; el historial
                    completo vive en la auditoría del workspace.
                  </Aviso>
                )}
                {datos.decididas.map((p) => (
                  <TarjetaPropuesta
                    key={p.id}
                    propuesta={p}
                    workspaceId={datos.workspaceId}
                    puedeRevisar={false}
                    onCambio={refrescar}
                    onError={errar}
                  />
                ))}
              </>
            )}
          </>
        )}
      </main>
    </div>
  );
}

/** Un recorte de lista se DICE. Callarlo es lo que dejaba creer que no quedaba trabajo
 * pendiente cuando sí quedaba. */
function Aviso({ children }: { children: ReactNode }) {
  return (
    <span style={{ font: '400 12.5px/1.5 var(--font-sans)', color: 'var(--text-muted)' }}>
      {children}
    </span>
  );
}

/** SYS-21 en una línea: el estado de la capacidad AI es visible SIEMPRE, encendida o no,
 * y cuando está apagada dice por dónde sigue el trabajo a mano. */
function BanderaAI({
  ai,
}: {
  ai: {
    disponible: boolean;
    motivo: string;
    modelo: string;
    llamadasHoy: number;
    limiteDiario: number;
    proveedorResponde: boolean;
    advertencia: string;
  };
}) {
  return (
    <Card
      style={{
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        borderLeft: `3px solid ${ai.disponible && ai.proveedorResponde ? 'var(--accent)' : 'var(--warn)'}`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ font: '700 13px var(--font-sans)', color: 'var(--ink)' }}>
          {!ai.disponible
            ? 'Capacidad AI apagada'
            : ai.proveedorResponde
              ? 'Capacidad AI disponible'
              : 'Capacidad AI disponible · el proveedor no respondió'}
        </span>
        <Tag>{ai.modelo}</Tag>
        <span style={{ font: '500 11.5px var(--font-mono)', color: 'var(--text-muted)' }}>
          {ai.llamadasHoy}/{ai.limiteDiario} llamadas al proveedor hoy
        </span>
      </div>
      <span style={{ font: '400 12.5px/1.5 var(--font-sans)', color: 'var(--text-muted)' }}>
        {ai.disponible
          ? 'La AI propone y cita; el objeto real del dominio solo nace cuando una persona acepta.'
          : ai.motivo}
      </span>
      {ai.disponible && !ai.proveedorResponde && (
        <span style={{ font: '400 12.5px/1.5 var(--font-sans)', color: 'var(--warn)' }}>
          {ai.advertencia}
        </span>
      )}
      {!ai.disponible && (
        <span style={{ font: '400 12.5px/1.5 var(--font-sans)', color: 'var(--text-body)' }}>
          Caminos manuales equivalentes: curar la bandeja de importación a mano y definir los
          criterios del reto en la pantalla del proyecto. Ningún gate depende de la AI.
        </span>
      )}
    </Card>
  );
}

/**
 * El grounding que alguien SOSTIENE. Va deliberadamente por encima de las decididas y no
 * junto a las citas de cada propuesta, porque son dos cosas distintas y confundirlas es el
 * defecto que esta pantalla arrastraba: la presencia literal de una cita mide una SUBCADENA
 * —el fragmento está en el material— y no establece que sostenga la afirmación que
 * acompaña. Un modelo que copia una frase mientras alucina el resto saca 2/2 «presentes».
 *
 * Lo que sí es una medida que alguien sostiene es ésta: cuántas propuestas pasó una PERSONA
 * a objeto real del dominio, poniendo su nombre en la fila (SYS-19). El único verificador de
 * confianza del pipeline es quien materializa y firma; contar aquí es contar donde hay
 * alguien que responde por el número.
 */
function RespaldoHumano({
  respaldo,
}: {
  respaldo: { aceptadas: number; corregidas: number; rechazadas: number };
}) {
  const respaldadas = respaldo.aceptadas + respaldo.corregidas;
  const decididas = respaldadas + respaldo.rechazadas;
  return (
    <Card
      style={{
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        borderLeft: '3px solid var(--accent)',
      }}
    >
      <span style={{ font: '700 13px var(--font-sans)', color: 'var(--ink)' }}>
        Con respaldo humano · {respaldadas} de {decididas} decididas
      </span>
      <span style={{ font: '400 12.5px/1.5 var(--font-sans)', color: 'var(--text-muted)' }}>
        {respaldo.aceptadas} aceptadas tal cual y {respaldo.corregidas} aceptadas con
        corrección; {respaldo.rechazadas} rechazadas. Sobre todas las decididas del
        workspace, no solo las de esta página.
      </span>
      <span style={{ font: '400 12.5px/1.5 var(--font-sans)', color: 'var(--text-body)' }}>
        Ésta es la medida de grounding que alguien sostiene: cada una la firma la persona que
        la materializó. La presencia literal de las citas que se ve en cada propuesta es otra
        cosa —dice que el fragmento está en el material, no que sostenga lo que afirma—, así
        que no cuenta como verificación por sí sola.
      </span>
    </Card>
  );
}

function FormularioGeneracion({
  workspaceId,
  habilitada,
  candidatas,
  busqueda,
  onBuscar,
  onGenerado,
  onConsentimiento,
  onError,
}: {
  workspaceId: string;
  habilitada: boolean;
  candidatas: PanelPropuestas['candidatas'];
  busqueda: string;
  onBuscar: (texto: string) => void;
  onGenerado: (generadas: number) => Promise<void>;
  onConsentimiento: (r: { version: number; autorizaExterno: boolean }) => Promise<void>;
  onError: (e: string | null) => void;
}) {
  const [capacidad, setCapacidad] = useState<CapacidadActiva>('CI');
  const [anclaId, setAnclaId] = useState('');
  const [texto, setTexto] = useState(busqueda);
  const [enviando, setEnviando] = useState(false);
  // La búsqueda vive en la URL (`?q=`), así que el back/forward del navegador la cambia sin
  // que nadie toque el input: sin esto, la caja seguía enseñando lo que se tecleó la última
  // vez mientras la lista ya era de otra búsqueda — dos verdades a la vez en la misma
  // pantalla.
  //
  // El ajuste va DURANTE el render y no en un efecto, que es lo que React prescribe para
  // «derivar estado cuando cambia una prop»: al ver el `setState` de su propio componente
  // durante el render, React descarta la salida y lo reejecuta ANTES de commitear y antes
  // de pintar los hijos. Con un efecto, el commit ocurre primero y el usuario ve un
  // fotograma con el input viejo sobre los resultados nuevos — exactamente el síntoma que
  // se quiere quitar, solo que más corto.
  const [busquedaVista, setBusquedaVista] = useState(busqueda);
  if (busquedaVista !== busqueda) {
    setBusquedaVista(busqueda);
    setTexto(busqueda);
  }
  /*
    El ancla la declara la capacidad, no la elige un ternario. Con dos capacidades
    `capacidad === 'CI' ? items : retos` funciona; con la tercera, el `else` la trata como C0
    en silencio — y ése es el modo de fallo de un ternario binario: no se equivoca, elige. */
  const ancla = CAPACIDADES[capacidad].ancla;
  /*
   * Las candidatas POR CAPACIDAD, que es de quien son.
   *
   * Aquí hubo primero `ancla.columna === 'item_id' ? items : retos` y después un
   * `Record<AnclaCapacidad['columna'], …>`. El Record arregló el ternario y dejó el error de
   * fondo: la elegibilidad no es de la COLUMNA. Dos capacidades pueden colgar del mismo reto
   * y no admitir los mismos —la cola de C0 excluye los de criterios congelados—, así que la
   * segunda recibía la lista de la primera y sus anclas válidas no salían en el selector, sin
   * que faltara ninguna entrada. Ahora el servidor las resuelve por capacidad y aquí solo se
   * leen.
   */
  const { lista: anclas, hayMas } = candidatas[capacidad];
  const elegida = anclas.find((a) => a.id === anclaId);
  // RF-09.5: si el material es de personas y el consentimiento vigente no cubre el
  // procesamiento externo, el paso que toca no es generar — es registrarlo. La pantalla lo
  // dice y lo ofrece aquí mismo en vez de dejar que el intento falle contra el servidor.
  const faltaConsentimiento = Boolean(elegida?.consentimientoPendiente);
  // Y un item importado solo con la referencia no tiene material que citar: la extracción
  // se apaga con su explicación, porque aquí no hay nada que arreglar (el contenido de un
  // item importado es inmutable) — el camino es la bandeja.
  const sinMaterial = Boolean(elegida?.sinMaterial);
  // El caso general de «se marca en vez de esconderse»: el ancla está en la lista y no se
  // puede generar, con su motivo. Lo redacta el servidor porque es él quien lo va a rechazar
  // si alguien lo fuerza igual, así que el texto es exactamente el mismo por los dos caminos.
  const bloqueo = elegida?.bloqueo ?? null;

  // El ancla elegida dejó de estar entre las opciones: pasa al BUSCAR algo que la excluye —la
  // búsqueda viaja al servidor y devuelve otra lista—, así que el id guardado sobrevive a la
  // lista a la que pertenecía y el `select` se ve en blanco.
  //
  // NO pasa al cambiar de workspace, aunque este comentario lo dijera: `_autenticada.tsx`
  // remonta el `Outlet` con `key={membresiaActiva?.workspaceId}` y este `useState` vuelve a
  // nacer vacío. Era la segunda redacción de la misma afirmación equivocada —la otra vivía
  // en los mensajes, arriba— y las dos prometían un modelo de router que no es el que hay.
  // La guarda se queda porque el caso de la búsqueda es real; lo que se va es el motivo
  // falso, que es lo que habría llevado a alguien a invalidar `anclaId` a mano.
  const anclaPerdida = anclaId !== '' && !elegida;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    // Se comprueba `elegida`, no `anclaId`: un id que ya no está entre las opciones es tan
    // inválido como no haber elegido nada, y aceptarlo mandaba al proveedor una petición por
    // un ancla que el curador no tiene delante —gastando su cuota— sin que nada en la
    // pantalla lo hubiera propuesto. Derivar la validez de la lista a la vista, en vez de
    // guardarla, es lo que hace que no haya que acordarse de invalidar el id.
    if (!elegida) {
      onError('Elige el objeto del que quieres una propuesta');
      return;
    }
    setEnviando(true);
    onError(null);
    try {
      const r = await generarPropuestasAI({ data: { workspaceId, capacidad, anclaId: elegida.id } });
      if (r.ok) {
        setAnclaId('');
        await onGenerado(r.generadas);
      } else {
        onError(r.error);
      }
    } catch {
      onError('No se pudo pedir la propuesta; intenta de nuevo');
    } finally {
      setEnviando(false);
    }
  }

  return (
    <Card style={{ padding: 24 }}>
      <form onSubmit={onSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <span style={{ font: '700 15px var(--font-sans)', color: 'var(--ink)' }}>
          Pedir una propuesta
        </span>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <label style={campo}>
            <span style={etiqueta}>Capacidad</span>
            <Select
              value={capacidad}
              onChange={(e) => {
                setCapacidad(e.target.value as CapacidadActiva);
                setAnclaId('');
              }}
            >
              {CAPACIDADES_ACTIVAS.map((c) => (
                <option key={c} value={c}>
                  {c} · {CAPACIDADES[c].etiqueta}
                </option>
              ))}
            </Select>
          </label>
          <label style={campo}>
            <span style={etiqueta}>
              {ancla.etiqueta}
            </span>
            {/* Buscar VIAJA al servidor (la búsqueda vive en la URL): filtrar en el cliente
                solo tocaría las anclas que ya bajaron, que es exactamente el conjunto del
                que un ancla puede haberse caído. */}
            <div style={{ display: 'flex', gap: 6 }}>
              <Input
                value={texto}
                maxLength={100}
                placeholder={ancla.buscar}
                onChange={(e) => setTexto(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    onBuscar(texto.trim());
                  }
                }}
              />
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => onBuscar(texto.trim())}
              >
                Buscar
              </Button>
              {busqueda && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setTexto('');
                    onBuscar('');
                  }}
                >
                  Limpiar
                </Button>
              )}
            </div>
            <Select value={anclaId} onChange={(e) => setAnclaId(e.target.value)}>
              <option value="">Elige el alcance…</option>
              {anclas.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.titulo}
                  {a.consentimientoPendiente ? ' · falta consentimiento' : ''}
                  {a.sinMaterial ? ' · sin material que citar' : ''}
                  {a.bloqueo ? ' · no se puede generar' : ''}
                </option>
              ))}
            </Select>
          </label>
        </div>
        {anclas.length === 0 && (
          <span style={{ font: '400 12.5px var(--font-sans)', color: 'var(--text-faint)' }}>
            {ancla.vacia}
          </span>
        )}
        {/* El recorte de la lista se dice: es la ÚNICA puerta a la generación, así que
            callarlo hacía creer que no había más anclas que ofrecer. Y se dice CON la
            salida: buscar por nombre alcanza cualquier ancla, caiga donde caiga el corte. */}
        {hayMas && (
          <Aviso>
            {ancla.hayMas(anclas.length)}
          </Aviso>
        )}
        {busqueda && anclas.length === 0 && (
          <Aviso>
            Ningún {ancla.enProsa} coincide
            con «{busqueda}». Vacía la búsqueda para volver a la cola completa.
          </Aviso>
        )}
        {anclaPerdida && (
          <Aviso>
            El objeto que habías elegido no está entre estas opciones
            {busqueda ? ` (la búsqueda «${busqueda}» lo deja fuera)` : ''}: vuelve a elegir uno
            de la lista antes de pedir la propuesta.
          </Aviso>
        )}
        {sinMaterial && (
          <span style={{ font: '400 12.5px/1.5 var(--font-sans)', color: 'var(--warn)' }}>
            «{elegida!.titulo}» se importó solo con la referencia al original: no hay texto que
            citar, y una extracción sobre pura ficha sería inventada. Cúralo a mano en la bandeja
            de importación, o vuelve a importarlo con el contenido pegado.
          </span>
        )}
        {bloqueo && (
          <span style={{ font: '400 12.5px/1.5 var(--font-sans)', color: 'var(--warn)' }}>
            {bloqueo}
          </span>
        )}
        {!faltaConsentimiento && (
          <div>
            <Button
              type="submit"
              disabled={
                enviando ||
                !habilitada ||
                anclas.length === 0 ||
                sinMaterial ||
                anclaPerdida ||
                bloqueo !== null
              }
            >
              {enviando ? 'Proponiendo…' : 'Proponer con AI'}
            </Button>
          </div>
        )}
        {!habilitada && (
          <span style={{ font: '400 12.5px var(--font-sans)', color: 'var(--text-faint)' }}>
            Generar está desactivado mientras la capacidad AI esté apagada; revisar y aceptar lo
            ya propuesto sigue funcionando.
          </span>
        )}
      </form>
      {faltaConsentimiento && (
        <FormularioConsentimiento
          // `key` por el item, y no un reset: lo que se redacta aquí es una AUTORIZACIÓN
          // (RF-09.5), así que el estado no puede sobrevivir al item al que pertenece. Sin
          // esto, React reutiliza el componente al cambiar de ancla y el «qué autorizó la
          // persona» y la casilla de procesamiento externo del item ANTERIOR se graban
          // contra el nuevo: un permiso que nadie dio, y que además puede dejar salir su
          // material personal hacia el proveedor. Con `key` no hay nada que acordarse de
          // resetear —el campo que se añada mañana ya nace protegido—, que es justo lo que
          // un `useEffect` de reset no garantiza.
          key={anclaId}
          workspaceId={workspaceId}
          itemId={anclaId}
          titulo={elegida!.titulo}
          onRegistrado={onConsentimiento}
          onError={onError}
        />
      )}
    </Card>
  );
}

/**
 * Bitácora de consentimientos del material de personas: qué autoriza HOY cada item y la
 * puerta para registrar un hecho nuevo — incluida la revocación.
 *
 * Existe porque colgar el formulario del selector de generación lo hacía inalcanzable justo
 * cuando hace falta: un item con permiso vigente no «necesita» nada, así que el formulario
 * no aparecía, y uno con propuesta pendiente ni siquiera se lista como ancla. El servicio y
 * la bitácora admiten registros posteriores desde el primer día; sin esta lista, RF-09.4 no
 * tenía por dónde entrar en el producto.
 */
function BitacoraConsentimientos({
  workspaceId,
  items,
  hayMas,
  onRegistrado,
  onError,
}: {
  workspaceId: string;
  items: ConsentimientoDeItem[];
  hayMas: boolean;
  onRegistrado: (r: { version: number; autorizaExterno: boolean }) => Promise<void>;
  onError: (e: string | null) => void;
}) {
  const [abierto, setAbierto] = useState<string | null>(null);
  const elegido = items.find((i) => i.id === abierto);

  return (
    <Card style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <span style={{ font: '700 15px var(--font-sans)', color: 'var(--ink)' }}>
        Consentimiento del material de personas
      </span>
      <span style={{ font: '400 12.5px/1.5 var(--font-sans)', color: 'var(--text-muted)' }}>
        Entrevistas y observaciones de la bandeja, con lo que autoriza su registro VIGENTE. Cada
        registro nuevo manda sobre los anteriores y ninguno se edita ni se borra (RF-09.4/09.5):
        así se recoge una autorización posterior y así se recoge una revocación. Los items ya
        curados se listan igual — cuando la evidencia existe, una revocación tiene más
        consecuencias, no menos.
      </span>
      {hayMas && (
        <Aviso>
          Hay más material de personas del que cabe aquí: se listan los {items.length} más
          antiguos. Busca por título para llegar a uno concreto.
        </Aviso>
      )}
      {items.map((i) => (
        <div
          key={i.id}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            flexWrap: 'wrap',
            padding: '8px 0',
            borderTop: '1px solid var(--border)',
          }}
        >
          <span style={{ font: '500 13px var(--font-sans)', color: 'var(--text-body)', flex: 1, minWidth: 200 }}>
            {i.titulo}
            {i.curado && (
              <span style={{ font: '400 11.5px var(--font-sans)', color: 'var(--text-faint)' }}>
                {' '}· ya curado
              </span>
            )}
          </span>
          <span
            style={{
              font: '600 11.5px var(--font-sans)',
              color: i.autorizaExterno ? 'var(--accent)' : 'var(--warn)',
            }}
          >
            {i.version === null
              ? 'sin consentimiento registrado'
              : i.autorizaExterno
                ? `autoriza el procesamiento externo · registro nº ${i.version}`
                : `NO autoriza el procesamiento externo · registro nº ${i.version}`}
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setAbierto(abierto === i.id ? null : i.id)}
          >
            {abierto === i.id ? 'Cancelar' : 'Registrar consentimiento'}
          </Button>
        </div>
      ))}
      {elegido && (
        <FormularioConsentimiento
          // Mismo motivo que en el selector de generación: aquí se salta de un item a otro
          // sin desmontar (el botón solo cambia `abierto`), así que sin `key` el borrador
          // del anterior se graba contra el siguiente.
          key={elegido.id}
          workspaceId={workspaceId}
          itemId={elegido.id}
          titulo={elegido.titulo}
          onRegistrado={async (r) => {
            setAbierto(null);
            await onRegistrado(r);
          }}
          onError={onError}
        />
      )}
    </Card>
  );
}

/**
 * Captura del consentimiento ANTES de procesar (RF-09.5). Aparece delante del botón de
 * generar —ese es el momento en que importa: hasta que no consta qué autorizó la persona, el
 * material no sale hacia ningún proveedor— y también en la bitácora de arriba, que es lo que
 * permite registrar un hecho posterior sobre un item que ya tiene permiso. Ningún registro se
 * edita ni se borra: lo que cambia el permiso es un registro NUEVO, y el vigente es el que
 * manda.
 *
 * Por eso el botón ya no exige marcar la casilla. Anotar «autorizó solo el uso interno» es
 * un hecho legítimo y útil —queda en la bitácora, con su autor y su fecha— y ya no condena
 * al item: cuando la persona autorice el procesamiento externo, ese consentimiento nuevo
 * pasa a ser el vigente y desbloquea la generación.
 */
function FormularioConsentimiento({
  workspaceId,
  itemId,
  titulo,
  onRegistrado,
  onError,
}: {
  workspaceId: string;
  itemId: string;
  titulo: string;
  onRegistrado: (r: { version: number; autorizaExterno: boolean }) => Promise<void>;
  onError: (e: string | null) => void;
}) {
  const [alcance, setAlcance] = useState('');
  const [procesamientoExterno, setProcesamientoExterno] = useState(false);
  const [enviando, setEnviando] = useState(false);

  return (
    <form
      style={{ ...CAJA_CORRECCION, marginTop: 14 }}
      onSubmit={async (e) => {
        e.preventDefault();
        setEnviando(true);
        onError(null);
        try {
          const r = await registrarConsentimientoAI({
            data: { workspaceId, itemId, alcance, procesamientoExterno },
          });
          if (r.ok) await onRegistrado({ version: r.version, autorizaExterno: r.autorizaExterno });
          else onError(r.error);
        } catch {
          onError('No se pudo registrar el consentimiento; intenta de nuevo');
        } finally {
          setEnviando(false);
        }
      }}
    >
      <span style={{ font: '700 13px var(--font-sans)', color: 'var(--ink)' }}>
        «{titulo}» es material de personas: registra el consentimiento antes de procesarlo
      </span>
      <span style={{ font: '400 12.5px/1.5 var(--font-sans)', color: 'var(--text-muted)' }}>
        Sin un consentimiento vigente que cubra el procesamiento externo, el material no sale
        hacia el proveedor AI (RF-09.5). El item sigue pudiendo curarse a mano en la bandeja,
        como siempre. Un registro posterior manda sobre los anteriores: si retira el permiso,
        detiene las generaciones que aún no hayan salido y ninguna propuesta podrá nacer de
        ese material — lo que ya viajó al proveedor no se puede des-enviar.
      </span>
      <label style={campo}>
        <span style={etiqueta}>Qué autorizó la persona</span>
        <Textarea
          required
          rows={2}
          maxLength={1000}
          value={alcance}
          onChange={(e) => setAlcance(e.target.value)}
          placeholder="Grabación y transcripción de la entrevista del 12/06, autorizadas por escrito"
        />
      </label>
      <label
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          font: '400 12.5px var(--font-sans)',
          color: 'var(--text-body)',
        }}
      >
        <Checkbox
          checked={procesamientoExterno}
          onChange={(e) => setProcesamientoExterno(e.target.checked)}
        />
        El consentimiento cubre el procesamiento por un proveedor externo
      </label>
      <div>
        <Button type="submit" size="sm" disabled={enviando}>
          {enviando ? 'Registrando…' : 'Registrar consentimiento'}
        </Button>
      </div>
      {!procesamientoExterno && (
        <span style={{ font: '400 12px/1.5 var(--font-sans)', color: 'var(--text-faint)' }}>
          Autorizar la grabación no es autorizar mandarla a un tercero: sin esa casilla, la AI
          sigue sin poder procesar este material. El registro se guarda igual —es un hecho de la
          investigación— y no cierra la puerta: si la persona lo autoriza más adelante, se
          registra un consentimiento nuevo y ese pasa a ser el vigente.
        </span>
      )}
    </form>
  );
}

/**
 * Cómo se PRESENTA y cómo se CORRIGE cada destino, exhaustivo por el tipo.
 *
 * La tarjeta decía `destino === 'evidencia' ? … : …` en tres sitios: el rótulo, la ficha y el
 * formulario de corrección. Los tres con el mismo modo de fallo: un destino nuevo se pintaba
 * como criterio de éxito, con campos que no son los suyos, y lo que el revisor escribiera en
 * ese formulario lo rechazaba después el esquema de su capacidad. Presentar mal una propuesta
 * es peor que no presentarla: el revisor decide sobre lo que ve.
 *
 * `Record<Destino, …>` hace que el compilador pida las tres piezas de cada destino nuevo. El
 * casting de `contenido` se queda dentro de cada entrada, que es donde el destino ya está
 * fijado y el CHECK de la tabla lo garantiza.
 */
/**
 * Cómo se PRESENTA cada capacidad: su rótulo y su ficha.
 *
 * Por CAPACIDAD y no por destino, y eso lo cobró la segunda capacidad informativa. Con CT
 * sola, indexar por `destino ?? 'informativa'` funcionaba porque solo había una entrada sin
 * destino; en cuanto llegó C5 —también sin destino, pero con un contenido completamente
 * distinto— las dos caían en la misma entrada y el informe de un journey se pintaba con la
 * ficha de un gate: campos que no son los suyos, y ninguno de los dos registros faltando una
 * entrada que el compilador echara de menos.
 *
 * Es exactamente el mismo error que el panel del servicio ya había cometido indexando por
 * COLUMNA de ancla lo que variaba por capacidad. Lo que se presenta es el CONTENIDO, y el
 * contenido lo declara la capacidad.
 */
const PRESENTACION_POR_CAPACIDAD: Record<
  CapacidadActiva,
  {
    rotulo: string;
    ficha: (contenido: ContenidoPropuesta, etiquetas: Record<string, string>) => ReactNode;
    /**
     * Qué se le dice a quien lee un informe que NO materializa nada, y por qué está aquí y no
     * escrito una vez junto al botón que falta.
     *
     * Estaba allí, y hablaba de «el gate» porque CT era la única capacidad informativa. Con la
     * segunda, un informe de journey se explicaba con las palabras de un gate y mandaba a
     * quien lo lee a buscar un rol que ahí no pinta nada. Es el mismo error que ya se corrigió
     * un piso más abajo —indexar por destino lo que varía por capacidad—, y su forma de fallar
     * es la misma: no falta ninguna entrada que el compilador eche de menos.
     *
     * `null` en las que sí materializan: ahí este texto no se pinta nunca.
     */
    sinAccion: string | null;
  }
> = {
  CI: {
    rotulo: 'Evidencia propuesta',
    ficha: (c) => <FichaExtraccion contenido={c as ContenidoExtraccion} />,
    sinAccion: null,
  },
  C0: {
    rotulo: 'Criterio de éxito propuesto',
    ficha: (c) => <FichaCriterio contenido={c as ContenidoCriterio} />,
    sinAccion: null,
  },
  CT: {
    rotulo: 'Informe de gate (no se aprueba desde aquí)',
    ficha: (c) => <FichaAsistenteGate contenido={c as ContenidoAsistenteGate} />,
    sinAccion:
      'Este informe no crea nada y no se aprueba: se lee y se descarta. Quien decide sobre ' +
      'el gate es la persona con el rol que le corresponde, desde el método.',
  },
  C2: {
    rotulo: 'Insight propuesto',
    ficha: (c, etiquetas) => (
      <FichaInsight contenido={c as ContenidoInsight} etiquetas={etiquetas} />
    ),
    // C2 SÍ materializa —nace un insight— así que no tiene nada que decir aquí.
    sinAccion: null,
  },
  C5: {
    rotulo: 'Remediación del grafo (no se aplica desde aquí)',
    ficha: (c, etiquetas) => (
      <FichaRemediacionJourney contenido={c as ContenidoRemediacionJourney} etiquetas={etiquetas} />
    ),
    sinAccion:
      'Este informe no cambia el grafo y no se aprueba: se lee y se descarta. Las ' +
      'remediaciones las aplica una persona editando el journey.',
  },
  C6: {
    rotulo: 'Entrada del Metric Registry propuesta',
    ficha: (c, etiquetas) => (
      <FichaEntradaKpi contenido={c as ContenidoEntradaKpi} etiquetas={etiquetas} />
    ),
    // C6 SÍ materializa —nace una entrada del registry— así que no tiene nada que decir aquí.
    sinAccion: null,
  },
};

/**
 * Lo que se pinta cuando la propuesta viene de una capacidad que esta versión de la pantalla
 * NO conoce.
 *
 * No es defensa por si acaso: `propuesta.capacidad` es `CapacidadAI` —las diez de SPEC-08— y
 * el registro solo cubre las ACTIVAS, así que la indexación puede devolver `undefined` de
 * verdad. Pasa en cuanto el catálogo va por delante de la pantalla: una fila escrita por una
 * versión más nueva del servidor, o una capacidad que vuelve a apagarse dejando sus propuestas
 * pendientes. Sin esto, leer `presentacion.rotulo` tiraba la tarjeta entera y con ella el
 * panel — y lo que se pierde no es una tarjeta bonita, es la única acción que esa fila admite:
 * poder descartarla.
 *
 * Así que se degrada a lo que siempre es cierto: se nombra la capacidad, se dice que esta
 * pantalla no sabe presentarla, y queda «Rechazar» — que para un informe es «leído y
 * descartado» y es lo que cierra la fila.
 */
const PRESENTACION_DESCONOCIDA = (capacidad: string) => ({
  rotulo: `Propuesta de la capacidad ${capacidad}`,
  ficha: () => (
    <span style={{ font: '400 12.5px/1.6 var(--font-sans)', color: 'var(--text-muted)' }}>
      Esta pantalla no sabe presentar el contenido de esta capacidad. Puedes descartarla; para
      leerla, actualiza la aplicación.
    </span>
  ),
  sinAccion: null as string | null,
});

/**
 * Y lo que solo tiene sentido si la propuesta MATERIALIZA algo, por DESTINO — que es quien
 * decide qué objeto nace. `null` cuando no materializa nada.
 *
 * Se consulta como `destino === null ? null : MATERIALIZACION[destino]`, y ese `null` apaga
 * los dos botones de aceptación. No hay bandera `aceptable` aparte: sin materialización no
 * hay formulario que pintar ni bloqueo que calcular, así que la ausencia ES la decisión — y
 * una bandera habría sido la lección de la costura otra vez, un valor declarado que alguien
 * tiene que acordarse de consultar en dos sitios.
 *
 * Que una capacidad no materialice es su contrato, no una falta: RF-08.4 dice que CT «reporta
 * huecos citando objetos; carece de acción aprobar», y C5 no edita el grafo porque quien lo
 * edita es una persona.
 */
const MATERIALIZACION: Record<
  Destino,
  {
      /**
       * Lo que impide materializar ESTA propuesta por lo que dice su contenido, y no por su
       * ancla: `null` si nada. Se declara por destino porque cada uno tiene los suyos, y
       * porque escrito como `destino === 'evidencia' && …` un destino nuevo no habría tenido
       * ninguno — la pantalla habría ofrecido «Aceptar tal cual» sobre algo que la base
       * rechaza, que es exactamente lo que este aviso existe para evitar.
       *
       * Devuelve el TEXTO y no un booleano: el aviso tiene que decir qué falta y por dónde se
       * arregla; un botón apagado sin explicación manda a adivinar.
       */
      bloqueoPropio: (contenido: ContenidoPropuesta) => string | null;
    formulario: (props: {
      inicial: ContenidoPropuesta;
      ocupado: boolean;
      onEnviar: (c: ContenidoPropuesta) => Promise<void>;
      onCancelar: () => void;
    }) => ReactNode;
  }
> = {
  evidencia: {
    /*
     * `evidencia.fecha_recoleccion` es NOT NULL: una extracción sin fecha del material no se
     * materializa. Y no es un defecto de la propuesta —al modelo se le permite decir que el
     * material no la trae, para eso existe el par fecha/motivo—: ponerla es trabajo del humano
     * al corregir. Así que el botón no se ofrece, y el camino que SÍ existe queda dicho con
     * esas palabras en vez de deducido de un botón apagado.
     */
    bloqueoPropio: (c) => {
      const e = c as ContenidoExtraccion;
      if (e.fecha !== null) return null;
      const porque = e.fechaSinDatoMotivo ? ` (${e.fechaSinDatoMotivo})` : '';
      return `Esta propuesta no trae fecha del material${porque}: féchala en «Corregir y aceptar» para poder materializarla.`;
    },
    formulario: ({ inicial, ocupado, onEnviar, onCancelar }) => (
      <FormularioExtraccion
        inicial={inicial as ContenidoExtraccion}
        ocupado={ocupado}
        onEnviar={onEnviar}
        onCancelar={onCancelar}
      />
    ),
  },
  insight: {
    // Un insight tampoco: su esquema ya exige lo que las tablas piden —al menos una
    // afirmación, y cada una con al menos una cita— y el resto lo sujetan las FK de `cita` y
    // `contradiccion` contra la evidencia del reto.
    bloqueoPropio: () => null,
    formulario: ({ inicial, ocupado, onEnviar, onCancelar }) => (
      <FormularioInsight
        inicial={inicial as ContenidoInsight}
        ocupado={ocupado}
        onEnviar={onEnviar}
        onCancelar={onCancelar}
      />
    ),
  },
  'criterio-exito': {
    // Un criterio no tiene ninguna precondición de contenido: su esquema ya exige todo lo
    // que la tabla pide, y la línea base la pone un humano DESPUÉS, editando el criterio
    // (§21).
    bloqueoPropio: () => null,
    formulario: ({ inicial, ocupado, onEnviar, onCancelar }) => (
      <FormularioCriterio
        inicial={inicial as ContenidoCriterio}
        ocupado={ocupado}
        onEnviar={onEnviar}
        onCancelar={onCancelar}
      />
    ),
  },
  'entrada-kpi': {
    // Una entrada tampoco: su esquema exige los seis campos que la tabla necesita para nacer,
    // y los que quedan vacíos —el dueño del dato, la línea base, la ventana, el dashboard— los
    // pone una persona DESPUÉS editando la entrada, que es exactamente el mismo reparto que
    // el criterio y por la misma razón: son compromisos, no redacción.
    bloqueoPropio: () => null,
    formulario: ({ inicial, ocupado, onEnviar, onCancelar }) => (
      <FormularioEntradaKpi
        inicial={inicial as ContenidoEntradaKpi}
        ocupado={ocupado}
        onEnviar={onEnviar}
        onCancelar={onCancelar}
      />
    ),
  },
};

function TarjetaPropuesta({
  propuesta,
  workspaceId,
  puedeRevisar,
  onCambio,
  onError,
}: {
  propuesta: PropuestaEnPanel;
  workspaceId: string;
  puedeRevisar: boolean;
  onCambio: () => Promise<void>;
  onError: (e: string | null) => void;
}) {
  const [corrigiendo, setCorrigiendo] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const conocida = PRESENTACION_POR_CAPACIDAD[propuesta.capacidad as CapacidadActiva];
  const presentacion = conocida ?? PRESENTACION_DESCONOCIDA(propuesta.capacidad);
  /*
   * Y sin presentación NO hay materialización, aunque el destino sí se conozca.
   *
   * Las dos cosas envejecen por separado: una capacidad nueva puede materializar un destino
   * que este cliente ya conocía —evidencia, criterio— mientras su contenido tiene una forma
   * que no sabe pintar. Consultando solo el destino, la tarjeta decía «no sé presentar esto,
   * puedes descartarla» y ofrecía al lado «Aceptar» y «Corregir»: aceptar a ciegas lo que
   * acaba de declararse ilegible, y un formulario que castea el contenido a la forma de SU
   * destino, que no tiene por qué ser la de esta capacidad.
   *
   * Se derivan del MISMO hallazgo para que no puedan discrepar. Rechazar sigue disponible,
   * que es la salida que el propio texto de la ficha ofrece.
   */
  const materializacion =
    conocida !== undefined && propuesta.destino !== null ? MATERIALIZACION[propuesta.destino] : null;
  const anclaDisponible = propuesta.anclaEstado === 'disponible';
  // La otra precondición que la base impone SIEMPRE y que no es del ancla, sino del contenido.
  // Va aparte de `anclaDisponible` porque no caduca con el tiempo —nació así— y su salida es
  // distinta: no es rechazar, es corregir. Y la declara el DESTINO, no un ternario.
  const bloqueoPropio = materializacion?.bloqueoPropio(propuesta.contenido) ?? null;
  const citasPresentes = propuesta.citas.filter((c) => c.presenteLiteral === true).length;
  // `null` es NO COMPROBABLE, y no cabe en el recuento de arriba: el material que el panel
  // recompone ya no es el que vio el modelo, así que ni «aparece» ni «no aparece» son verdad.
  const citasSinComprobar = propuesta.citas.filter((c) => c.presenteLiteral === null).length;

  async function decidir(correccion?: ContenidoPropuesta) {
    setOcupado(true);
    onError(null);
    try {
      const r = await aceptarPropuestaAI({
        data: { workspaceId, propuestaId: propuesta.id, correccion },
      });
      if (r.ok) {
        setCorrigiendo(false);
        await onCambio();
      } else onError(r.error);
    } catch {
      onError('No se pudo aceptar la propuesta; intenta de nuevo');
    } finally {
      setOcupado(false);
    }
  }

  async function rechazar() {
    setOcupado(true);
    onError(null);
    try {
      const r = await rechazarPropuestaAI({ data: { workspaceId, propuestaId: propuesta.id } });
      if (r.ok) await onCambio();
      else onError(r.error);
    } catch {
      onError('No se pudo rechazar la propuesta; intenta de nuevo');
    } finally {
      setOcupado(false);
    }
  }

  return (
    <Card style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <Tag>{propuesta.capacidad}</Tag>
        <span
          style={{
            font: '700 14px var(--font-sans)',
            color: 'var(--ink)',
            flex: 1,
            minWidth: 200,
          }}
        >
          {presentacion.rotulo}
        </span>
        {propuesta.esSimulacion && <Tag mono={false}>simulación AI</Tag>}
        <span style={{ font: '600 11.5px var(--font-sans)', color: COLOR_ESTADO[propuesta.estado] }}>
          {TEXTO_ESTADO[propuesta.estado]}
        </span>
      </div>
      <span style={{ font: '400 12px var(--font-sans)', color: 'var(--text-muted)' }}>
        Alcance: {propuesta.anclaTitulo}
      </span>

      {presentacion.ficha(propuesta.contenido, propuesta.etiquetas)}

      {propuesta.citas.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {/* PRESENCIA LITERAL, no «verificadas»: el control es una subcadena, y una cita
              puede estar palabra por palabra en el material sin sostener la afirmación que
              acompaña. El nombre haría aquí el trabajo que el código no hace, y quien lea
              «verificadas» dejaría de mirar justo lo que hay que mirar. Lo que sí sostiene
              la propuesta es la persona que la acepta (SYS-19), y eso se cuenta abajo, en
              las decididas. */}
          <span style={etiqueta}>
            {citasSinComprobar === propuesta.citas.length && propuesta.citas.length > 0
              ? `Citas · ${propuesta.citas.length}, sin comprobar: el material cambió desde que se generó`
              : `Citas · ${citasPresentes}/${propuesta.citas.length} presentes literalmente en el material`}
          </span>
          {/* El índice vale como identidad AQUÍ, y conviene decir por qué en vez de dejar
              que cada lector lo deduzca: las citas de una propuesta no cambian nunca. Se
              leen de `contenidoOriginal`, corregirlas lo rechaza el servicio y lo vuelve a
              rechazar el guard de la base, y la tarjeta va keyeada por `p.id`, así que una
              instancia siempre pinta las mismas citas en el mismo orden. No hay reordenado
              del que protegerse; una key compuesta sugeriría que sí lo hay. */}
          {propuesta.citas.map((c, i) => (
            <div
              key={i}
              style={{
                font: '400 12px/1.5 var(--font-mono)',
                color:
                  c.presenteLiteral === null
                    ? 'var(--text-muted)'
                    : c.presenteLiteral
                      ? 'var(--text-body)'
                      : 'var(--danger)',
                overflowWrap: 'anywhere',
              }}
            >
              {c.presenteLiteral === false ? '⚠ ' : '· '}«{c.fragmento}» — {c.localizacion}
              {c.presenteLiteral === false && ' (no aparece literal en el material)'}
              {c.presenteLiteral === null && ' (no se puede comprobar: el material cambió)'}
            </div>
          ))}
        </div>
      )}

      {propuesta.contenidoOriginal && (
        <details>
          <summary style={{ ...etiqueta, cursor: 'pointer' }}>
            Propuesta original (antes de la corrección humana)
          </summary>
          <pre
            style={{
              font: '400 11.5px/1.5 var(--font-mono)',
              color: 'var(--text-muted)',
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
              margin: '6px 0 0',
            }}
          >
            {JSON.stringify(propuesta.contenidoOriginal, null, 2)}
          </pre>
        </details>
      )}

      <span style={{ font: '400 11px var(--font-mono)', color: 'var(--text-faint)' }}>
        lineage: {propuesta.modelo} · prompt {propuesta.promptVersion} · key {propuesta.origenKey}
        {propuesta.latenciaMs !== null ? ` · ${propuesta.latenciaMs} ms` : ''}
        {/* Coste MEDIDO de la llamada que la produjo, no estimado. Sin dato se dice, no
            se rellena con un cero que parecería gratis. */}
        {propuesta.costoUsd !== null
          ? ` · ${formatearCosteUsd(propuesta.costoUsd)}`
          : ' · coste sin registrar'}{' '}
        · {propuesta.alcanceResumen}
      </span>

      {propuesta.estado === 'propuesta' && !puedeRevisar && (
        <span style={{ font: '400 12px var(--font-sans)', color: 'var(--text-faint)' }}>
          La decisión la toma la boutique (lead o diseñador).
        </span>
      )}
      {/* El ancla dejó de admitir la materialización, y cada motivo tiene su salida: el
          item se curó a mano, la persona retiró el consentimiento (RF-09.4/09.5), el G0 del
          reto congeló los criterios (SYS-22) o el reto avanzó en su ciclo de vida y ya no
          admite criterios nuevos (RF-04.12). En los cuatro casos la propuesta quedó obsoleta
          y aceptarla solo produciría un rechazo de la base — pero RECHAZAR sigue habilitado
          abajo, porque es justamente la salida que cierra la fila. */}
      {propuesta.estado === 'propuesta' && puedeRevisar && !anclaDisponible && (
        <span style={{ font: '500 12.5px/1.5 var(--font-sans)', color: 'var(--warn)' }}>
          {MOTIVO_ANCLA[propuesta.anclaEstado]}
        </span>
      )}
      {/* Y lo que impide materializarla por su CONTENIDO, que cada destino declara en
          `PRESENTACION.bloqueoPropio` (el porqué de cada uno está allí). Lo que la base
          rechaza, la pantalla no lo enseña; y el camino que SÍ existe queda dicho con
          palabras, no deducido de un botón apagado. */}
      {propuesta.estado === 'propuesta' && puedeRevisar && anclaDisponible && bloqueoPropio && (
        <span style={{ font: '500 12.5px/1.5 var(--font-sans)', color: 'var(--warn)' }}>
          {bloqueoPropio}
        </span>
      )}
      {/* Una propuesta que no materializa nada se DICE, en vez de dejar dos botones ausentes
          que parezcan un permiso que falta: quien la lee tiene que saber que no le falta un
          rol, es que ahí no hay nada que aprobar (RF-08.4) y lo hace una persona desde el
          método (SYS-18). CON LAS PALABRAS DE SU CAPACIDAD, que las de un gate no describen un
          journey. */}
      {propuesta.estado === 'propuesta' && puedeRevisar && materializacion === null &&
        presentacion.sinAccion && (
          <span style={{ font: '500 12.5px/1.5 var(--font-sans)', color: 'var(--text-muted)' }}>
            {presentacion.sinAccion}
          </span>
        )}
      {propuesta.estado === 'propuesta' && puedeRevisar && !corrigiendo && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {/* Los dos botones de aceptación los pinta la MATERIALIZACIÓN, no una bandera:
              sin objeto que crear no hay nada que aceptar ni que corregir. «Rechazar» se
              queda siempre — para un informe es «leído y descartado», que es la única
              decisión que su ciclo admite y la que cierra la fila. */}
          {materializacion !== null && (
            <>
              <Button
                size="sm"
                disabled={ocupado || !anclaDisponible || bloqueoPropio !== null}
                onClick={() => void decidir()}
              >
                Aceptar tal cual
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={
                  ocupado || (!anclaDisponible && !CORREGIR_SIGUE_ABIERTO[propuesta.anclaEstado])
                }
                onClick={() => setCorrigiendo(true)}
              >
                Corregir y aceptar
              </Button>
            </>
          )}
          <Button size="sm" variant="ghost" disabled={ocupado} onClick={() => void rechazar()}>
            {materializacion === null ? 'Marcar como leído' : 'Rechazar'}
          </Button>
        </div>
      )}
      {propuesta.estado === 'propuesta' &&
        puedeRevisar &&
        corrigiendo &&
        materializacion?.formulario({
          inicial: propuesta.contenido,
          ocupado,
          onEnviar: decidir,
          onCancelar: () => setCorrigiendo(false),
        })}
    </Card>
  );
}

/**
 * El insight propuesto: su resumen, sus afirmaciones y las citas de cada una.
 *
 * Las citas se pintan CON su fragmento, que es lo que hace revisable un insight: quien
 * aprueba tiene que poder leer de dónde sale cada afirmación sin salir de la tarjeta. Y las
 * hipótesis se marcan, porque una extrapolación bien escrita suena igual que una observación
 * (RF-08.2) — esconder esa distinción es exactamente lo que la marca existe para impedir.
 *
 * Las contradicciones se pintan aparte y con su nombre: un insight que solo enseña lo que lo
 * confirma no sirve para decidir (I4).
 */
function FichaInsight({
  contenido,
  etiquetas,
}: {
  contenido: ContenidoInsight;
  etiquetas: Record<string, string>;
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: 12,
        background: 'var(--surface-sunken)',
        borderRadius: 'var(--r-sm)',
      }}
    >
      <Dato rotulo="Insight" valor={contenido.titulo} />
      {contenido.resumen && <Dato rotulo="Resumen" valor={contenido.resumen} />}
      {contenido.afirmaciones.map((a, i) => (
        <div
          key={String(i)}
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
            paddingTop: 8,
            borderTop: '1px solid var(--border-faint)',
          }}
        >
          <Dato
            rotulo={a.esHipotesis ? `Hipótesis ${i + 1}` : `Afirmación ${i + 1}`}
            valor={a.texto}
          />
          {a.citas.map((c, j) => (
            <Dato
              key={String(j)}
              rotulo="Cita"
              valor={`«${c.fragmento}» · ${c.localizacion} · ${
                etiquetas[c.evidenciaId] ?? `evidencia ${c.evidenciaId} (ya no está)`
              }`}
            />
          ))}
        </div>
      ))}
      {contenido.contradicciones.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, paddingTop: 8, borderTop: '1px solid var(--border-faint)' }}>
          {contenido.contradicciones.map((c, i) => (
            <Dato
              key={String(i)}
              rotulo={`Contradicción ${i + 1}`}
              valor={`${c.descripcion} · ${
                etiquetas[c.evidenciaId] ?? `evidencia ${c.evidenciaId} (ya no está)`
              }`}
            />
          ))}
        </div>
      )}
      <Dato rotulo="Confianza de la propuesta" valor={contenido.confianzaPropuesta} />
    </div>
  );
}

/**
 * Corregir un insight: su título, su resumen y el texto y la marca de hipótesis de cada
 * afirmación. Las CITAS no se editan y por eso se pintan como lo que son —el rastro de lo que
 * el modelo dijo haber leído— en vez de esconderse: quien corrige tiene que verlas para
 * decidir si la afirmación se sostiene, y si no se sostiene lo que toca es rechazar, no
 * reescribir la cita.
 *
 * Tampoco se editan las contradicciones ni la confianza declarada, por lo mismo.
 */
function FormularioInsight({
  inicial,
  ocupado,
  onEnviar,
  onCancelar,
}: {
  inicial: ContenidoInsight;
  ocupado: boolean;
  onEnviar: (c: ContenidoInsight) => Promise<void>;
  onCancelar: () => void;
}) {
  const [titulo, setTitulo] = useState(inicial.titulo);
  const [resumen, setResumen] = useState(inicial.resumen);
  const [afirmaciones, setAfirmaciones] = useState(inicial.afirmaciones);

  const cambiar = (i: number, cambio: Partial<ContenidoInsight['afirmaciones'][number]>) =>
    setAfirmaciones((previas) => previas.map((a, j) => (j === i ? { ...a, ...cambio } : a)));

  return (
    <form
      style={CAJA_CORRECCION}
      onSubmit={(e) => {
        e.preventDefault();
        void onEnviar({
          titulo,
          resumen,
          afirmaciones,
          // Lo que el modelo afirmó —sus contradicciones y su confianza— no lo reescribe quien
          // corrige, igual que sus citas.
          contradicciones: inicial.contradicciones,
          confianzaPropuesta: inicial.confianzaPropuesta,
        });
      }}
    >
      <span style={{ font: '700 13px var(--font-sans)', color: 'var(--ink)' }}>
        Corregir antes de aceptar (la propuesta original se conserva)
      </span>
      <label style={campo}>
        <span style={etiqueta}>Insight</span>
        <Input required maxLength={300} value={titulo} onChange={(e) => setTitulo(e.target.value)} />
      </label>
      <label style={campo}>
        <span style={etiqueta}>Resumen</span>
        <Textarea maxLength={2000} rows={2} value={resumen} onChange={(e) => setResumen(e.target.value)} />
      </label>
      {afirmaciones.map((a, i) => (
        <div key={String(i)} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label style={campo}>
            <span style={etiqueta}>Afirmación {i + 1}</span>
            <Textarea
              required
              maxLength={1000}
              rows={2}
              value={a.texto}
              onChange={(e) => cambiar(i, { texto: e.target.value })}
            />
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Checkbox
              checked={a.esHipotesis}
              onChange={(e) => cambiar(i, { esHipotesis: e.target.checked })}
            />
            <span style={etiqueta}>Es una hipótesis (extrapola más allá de la evidencia)</span>
          </label>
          {a.citas.map((c, j) => (
            <span
              key={String(j)}
              style={{ font: '400 12px/1.5 var(--font-sans)', color: 'var(--text-faint)' }}
            >
              Cita (no editable): «{c.fragmento}» · {c.localizacion}
            </span>
          ))}
        </div>
      ))}
      {/*
        Las CONTRADICCIONES y la CONFIANZA, a la vista y sin editar.

        El comentario de arriba decía que no se corrigen, y era verdad — pero el formulario no
        las enseñaba, así que quien corregía decidía entre aceptar y rechazar sin ver la
        evidencia que va EN CONTRA de lo que está a punto de aceptar. Decir «esto no se toca»
        y a la vez ocultarlo son dos cosas distintas: la primera protege la señal, la segunda
        se la quita a quien tiene que usarla. Se pintan igual que las citas.
      */}
      {inicial.contradicciones.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={etiqueta}>Contradicciones señaladas (no editables)</span>
          {inicial.contradicciones.map((c, i) => (
            <span
              key={String(i)}
              style={{ font: '400 12px/1.5 var(--font-sans)', color: 'var(--warn)' }}
            >
              «{c.descripcion}» · evidencia {c.evidenciaId}
            </span>
          ))}
        </div>
      )}
      <span style={{ font: '400 12px/1.5 var(--font-sans)', color: 'var(--text-faint)' }}>
        Confianza declarada por el modelo (no editable): {inicial.confianzaPropuesta}
      </span>
      <div style={{ display: 'flex', gap: 10 }}>
        <Button size="sm" type="submit" disabled={ocupado}>
          Corregir y aceptar
        </Button>
        <Button size="sm" variant="ghost" type="button" disabled={ocupado} onClick={onCancelar}>
          Cancelar
        </Button>
      </div>
    </form>
  );
}

function Dato({ rotulo, valor }: { rotulo: string; valor: string }) {
  return (
    <div style={{ display: 'flex', gap: 8, font: '400 12.5px/1.6 var(--font-sans)' }}>
      <span style={{ color: 'var(--text-faint)', minWidth: 120 }}>{rotulo}</span>
      <span style={{ color: 'var(--text-body)', flex: 1, overflowWrap: 'anywhere' }}>{valor}</span>
    </div>
  );
}

function FichaExtraccion({ contenido }: { contenido: ContenidoExtraccion }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        padding: 12,
        background: 'var(--surface-sunken)',
        borderRadius: 'var(--r-sm)',
      }}
    >
      <Dato rotulo="Título" valor={contenido.titulo} />
      {contenido.resumen && <Dato rotulo="Resumen" valor={contenido.resumen} />}
      <Dato rotulo="Recolección" valor={contenido.recoleccion} />
      {/* La fecha o consta con su sitio, o falta con su motivo. Enseñar la ausencia con su
          razón —en vez de un hueco— es lo que distingue «el material no la trae» de «se
          olvidó»: la primera pide corregir antes de aceptar, la segunda no existe. */}
      {contenido.fecha !== null ? (
        <Dato
          rotulo="Fecha del material"
          valor={`${contenido.fecha}${contenido.fechaLocalizacion ? ` · leída en ${contenido.fechaLocalizacion}` : ''}`}
        />
      ) : (
        <Dato
          rotulo="Fecha del material"
          valor={`sin fecha en el material${contenido.fechaSinDatoMotivo ? `: ${contenido.fechaSinDatoMotivo}` : ''} — hay que fecharla al corregir para poder aceptarla`}
        />
      )}
      <Dato rotulo="Confianza de la propuesta" valor={contenido.confianzaPropuesta} />
      <Dato
        rotulo="Dimensiones"
        valor={`confianza ${contenido.confianza} · ${contenido.derivada ? 'derivada' : 'primaria'} · confidencialidad ${contenido.confidencialidad}${contenido.esEstadoActual ? ' · describe el estado actual' : ''}`}
      />
      <Dato
        rotulo="Consentimiento"
        valor="el que se registró sobre el item ANTES de procesarlo (RF-09.5); la AI no lo propone ni lo infiere"
      />
    </div>
  );
}

function FichaCriterio({ contenido }: { contenido: ContenidoCriterio }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        padding: 12,
        background: 'var(--surface-sunken)',
        borderRadius: 'var(--r-sm)',
      }}
    >
      <Dato rotulo="KPI" valor={contenido.kpi} />
      <Dato rotulo="Definición" valor={contenido.definicion} />
      <Dato rotulo="Objetivo" valor={contenido.objetivo} />
      <Dato rotulo="Ventana" valor={`${contenido.ventanaDias} días`} />
      <Dato rotulo="Plan de línea base" valor={contenido.lineaBasePlan} />
      {contenido.razonamiento && <Dato rotulo="Razonamiento" valor={contenido.razonamiento} />}
      <Dato rotulo="Confianza de la propuesta" valor={contenido.confianzaPropuesta} />
    </div>
  );
}

/**
 * El informe de un gate: su resumen y sus huecos.
 *
 * NO se pinta el `checklistItemId`. Un uuid en pantalla no le dice nada a quien lee, y el
 * campo no está ahí para eso: está para que el servicio pueda comprobar que cada hueco
 * señala un requisito que EXISTE en este gate —lo rechaza si no— y para que una pantalla
 * futura pueda enlazar al requisito. Lo que el revisor necesita leer es qué falta y cómo se
 * cierra, y eso lo dicen las dos frases.
 *
 * La lista vacía se dice con palabras y no se omite: un informe sin huecos y un informe que
 * no se pintó se ven igual, y son cosas muy distintas.
 */
function FichaAsistenteGate({ contenido }: { contenido: ContenidoAsistenteGate }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: 12,
        background: 'var(--surface-sunken)',
        borderRadius: 'var(--r-sm)',
      }}
    >
      <Dato rotulo="Resumen" valor={contenido.resumen} />
      {contenido.huecos.length === 0 ? (
        <Dato rotulo="Huecos" valor="Ninguno: el asistente no encontró nada pendiente." />
      ) : (
        contenido.huecos.map((h, i) => (
          <div
            key={h.checklistItemId + String(i)}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
              paddingTop: 8,
              borderTop: '1px solid var(--border-faint)',
            }}
          >
            <Dato rotulo={`Falta ${i + 1}`} valor={h.queFalta} />
            <Dato rotulo="Cómo cerrarlo" valor={h.comoCerrarlo} />
          </div>
        ))
      )}
      <Dato rotulo="Confianza del diagnóstico" valor={contenido.confianzaPropuesta} />
    </div>
  );
}

/**
 * La remediación de un journey: su resumen y qué hacer con cada señal.
 *
 * Se pinta el CÓDIGO de la señal y no el id del nodo, por lo mismo que en la ficha del gate:
 * el uuid no le dice nada a quien lee, y el par `(nodoId, código)` está ahí para que el
 * servicio pueda comprobar que la señal existe de verdad. Lo que el revisor necesita es qué
 * señal es y qué hacer con ella.
 *
 * La lista vacía se dice con palabras: un informe sin remediaciones y un informe que no se
 * pintó se ven igual, y son cosas muy distintas.
 */
function FichaRemediacionJourney({
  contenido,
  etiquetas,
}: {
  contenido: ContenidoRemediacionJourney;
  etiquetas: Record<string, string>;
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: 12,
        background: 'var(--surface-sunken)',
        borderRadius: 'var(--r-sm)',
      }}
    >
      <Dato rotulo="Resumen" valor={contenido.resumen} />
      {contenido.remediaciones.length === 0 ? (
        <Dato rotulo="Remediaciones" valor="Ninguna: el asistente no propuso nada que cerrar." />
      ) : (
        contenido.remediaciones.map((r, i) => (
          <div
            key={r.nodoId + r.codigo + String(i)}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
              paddingTop: 8,
              borderTop: '1px solid var(--border-faint)',
            }}
          >
            {/*
              El NODO por delante del código, porque es lo que distingue una tarjeta de otra:
              un journey trae media docena de `paso-sin-evidencia` sin despeinarse, y con solo
              el código las remediaciones son indistinguibles — `comoCerrarlo` no está obligado
              a repetir a cuál aplica. Si el nodo ya no está en el grafo se enseña su id: eso
              también es información, y de la que hay que ver (el informe habla de algo que se
              borró).
            */}
            <Dato
              rotulo={`Señal ${i + 1} · ${r.codigo}`}
              valor={etiquetas[r.nodoId] ?? `nodo ${r.nodoId} (ya no está en el grafo)`}
            />
            <Dato rotulo="Cómo cerrarla" valor={r.comoCerrarlo} />
          </div>
        ))
      )}
      <Dato rotulo="Confianza de la propuesta" valor={contenido.confianzaPropuesta} />
    </div>
  );
}

const CAJA_CORRECCION: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  padding: 16,
  background: 'var(--surface-sunken)',
  borderRadius: 'var(--r-sm)',
};

function FormularioExtraccion({
  inicial,
  ocupado,
  onEnviar,
  onCancelar,
}: {
  inicial: ContenidoExtraccion;
  ocupado: boolean;
  onEnviar: (c: ContenidoExtraccion) => Promise<void>;
  onCancelar: () => void;
}) {
  const [titulo, setTitulo] = useState(inicial.titulo);
  const [resumen, setResumen] = useState(inicial.resumen);
  const [recoleccion, setRecoleccion] = useState(inicial.recoleccion);
  const [fecha, setFecha] = useState(inicial.fecha ?? '');
  const [fechaLocalizacion, setFechaLocalizacion] = useState(inicial.fechaLocalizacion);
  const [confianza, setConfianza] = useState(inicial.confianza);
  const [confidencialidad, setConfidencialidad] = useState(inicial.confidencialidad);
  const [derivada, setDerivada] = useState(inicial.derivada);
  const [esEstadoActual, setEsEstadoActual] = useState(inicial.esEstadoActual);

  return (
    <form
      style={CAJA_CORRECCION}
      onSubmit={(e) => {
        e.preventDefault();
        void onEnviar({
          titulo,
          resumen,
          recoleccion,
          // La fecha es lo único de aquí que puede NACER vacío, porque el modelo tiene
          // permitido decir que el material no la trae. Al ponerla, su motivo de ausencia
          // deja de tener sentido y se va; al quitarla, vuelve el que dio el modelo.
          fecha: fecha === '' ? null : fecha,
          fechaLocalizacion: fecha === '' ? '' : fechaLocalizacion,
          fechaSinDatoMotivo: fecha === '' ? inicial.fechaSinDatoMotivo : '',
          confianza,
          confidencialidad,
          derivada,
          esEstadoActual,
          // Ni las citas ni la confianza declarada se editan: las primeras son el rastro
          // verificable de lo que el modelo dijo haber leído —corregirlas borraría la señal
          // de grounding— y la segunda es lo que el modelo afirmó sobre su propia propuesta,
          // que es el dato con el que se ordena la revisión. Reescribir cualquiera de las dos
          // sería maquillar la medida con la mano que se está midiendo.
          confianzaPropuesta: inicial.confianzaPropuesta,
          citas: inicial.citas,
        });
      }}
    >
      <span style={{ font: '700 13px var(--font-sans)', color: 'var(--ink)' }}>
        Corregir antes de aceptar (la propuesta original se conserva)
      </span>
      <label style={campo}>
        <span style={etiqueta}>Título</span>
        <Input required maxLength={300} value={titulo} onChange={(e) => setTitulo(e.target.value)} />
      </label>
      <label style={campo}>
        <span style={etiqueta}>Resumen</span>
        <Textarea rows={2} maxLength={2000} value={resumen} onChange={(e) => setResumen(e.target.value)} />
      </label>
      <label style={campo}>
        <span style={etiqueta}>Método de recolección</span>
        <Input
          required
          maxLength={300}
          value={recoleccion}
          onChange={(e) => setRecoleccion(e.target.value)}
        />
      </label>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
        <label style={campo}>
          <span style={etiqueta}>Fecha del material</span>
          {/* Obligatoria AQUÍ aunque la propuesta pueda nacer sin ella: este formulario es el
              camino de la ACEPTACIÓN, y aceptar exige fecha siempre. Dejarla opcional
              permitía enviar una corrección que `materializarEvidencia` rechaza a
              continuación — el mismo defecto que el botón «Aceptar tal cual» de arriba, un
              control más allá. */}
          <Input type="date" required value={fecha} onChange={(e) => setFecha(e.target.value)} />
        </label>
        <label style={campo}>
          <span style={etiqueta}>Dónde se lee la fecha</span>
          {/* Obligatoria SOLO si hay fecha, por lo mismo que las citas llevan localización:
              una fecha sin sitio en el material es indistinguible de una inventada. */}
          <Input
            required={fecha !== ''}
            maxLength={200}
            placeholder={fecha === '' ? 'sin fecha que situar' : 'p. ej. cabecera del acta'}
            value={fechaLocalizacion}
            onChange={(e) => setFechaLocalizacion(e.target.value)}
          />
        </label>
        <label style={campo}>
          <span style={etiqueta}>Confianza</span>
          <Select value={confianza} onChange={(e) => setConfianza(e.target.value as typeof confianza)}>
            <option value="alta">Alta</option>
            <option value="media">Media</option>
            <option value="baja">Baja</option>
          </Select>
        </label>
        <label style={campo}>
          <span style={etiqueta}>Confidencialidad</span>
          <Select
            value={confidencialidad}
            onChange={(e) => setConfidencialidad(e.target.value as typeof confidencialidad)}
          >
            <option value="interna">Interna</option>
            <option value="cliente">Cliente</option>
            <option value="restringida">Restringida</option>
          </Select>
        </label>
      </div>
      <div
        style={{
          display: 'flex',
          gap: 20,
          flexWrap: 'wrap',
          font: '400 12.5px var(--font-sans)',
          color: 'var(--text-body)',
        }}
      >
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Checkbox checked={derivada} onChange={(e) => setDerivada(e.target.checked)} />
          Evidencia derivada (no primaria)
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Checkbox checked={esEstadoActual} onChange={(e) => setEsEstadoActual(e.target.checked)} />
          Describe el estado ACTUAL del servicio
        </label>
      </div>
      <div style={{ display: 'flex', gap: 10 }}>
        <Button type="submit" size="sm" disabled={ocupado}>
          {ocupado ? 'Aceptando…' : 'Aceptar con estas correcciones'}
        </Button>
        <Button size="sm" variant="ghost" disabled={ocupado} onClick={onCancelar}>
          Cancelar
        </Button>
      </div>
    </form>
  );
}

function FichaEntradaKpi({
  contenido,
  etiquetas,
}: {
  contenido: ContenidoEntradaKpi;
  etiquetas: Record<string, string>;
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: 12,
        background: 'var(--surface-sunken)',
        borderRadius: 'var(--r-sm)',
      }}
    >
      <Dato rotulo="KPI" valor={contenido.nombre} />
      <Dato
        rotulo="Responde al criterio"
        // El KPI del criterio, no su uuid: quien revisa tiene que poder decir si este
        // indicador mide ESA promesa, y para eso hay que leer la promesa.
        valor={
          etiquetas[contenido.criterioId] ??
          `criterio ${contenido.criterioId} (ya no está)`
        }
      />
      <Dato rotulo="Definición del cálculo" valor={contenido.definicion} />
      <Dato rotulo="Fuente del dato" valor={contenido.fuente} />
      {contenido.dimensiones && <Dato rotulo="Dimensiones" valor={contenido.dimensiones} />}
      <Dato rotulo="Frecuencia" valor={contenido.frecuencia} />
      {contenido.citas.map((c, i) => (
        <Dato key={String(i)} rotulo="Cita" valor={`«${c.fragmento}» · ${c.localizacion}`} />
      ))}
      <span style={{ font: '400 12px var(--font-sans)', color: 'var(--text-faint)' }}>
        La entrada nace sin dueño del dato, sin línea base y sin fecha de inicio: eso lo acuerda
        una persona del cliente y se completa en el registry antes de firmarlo.
      </span>
    </div>
  );
}

function FormularioEntradaKpi({
  inicial,
  ocupado,
  onEnviar,
  onCancelar,
}: {
  inicial: ContenidoEntradaKpi;
  ocupado: boolean;
  onEnviar: (c: ContenidoEntradaKpi) => Promise<void>;
  onCancelar: () => void;
}) {
  const [nombre, setNombre] = useState(inicial.nombre);
  const [definicion, setDefinicion] = useState(inicial.definicion);
  const [fuente, setFuente] = useState(inicial.fuente);
  const [dimensiones, setDimensiones] = useState(inicial.dimensiones);
  const [frecuencia, setFrecuencia] = useState(inicial.frecuencia);

  return (
    <form
      style={CAJA_CORRECCION}
      onSubmit={(e) => {
        e.preventDefault();
        void onEnviar({
          criterioId: inicial.criterioId,
          nombre,
          definicion,
          fuente,
          dimensiones,
          frecuencia,
          // Mismo criterio que en CI y en C0: lo que el modelo afirmó —sus citas y su
          // confianza— no lo reescribe quien corrige.
          confianzaPropuesta: inicial.confianzaPropuesta,
          citas: inicial.citas,
        });
      }}
    >
      <span style={{ font: '700 13px var(--font-sans)', color: 'var(--ink)' }}>
        Corregir antes de aceptar (la propuesta original se conserva)
      </span>
      <label style={campo}>
        <span style={etiqueta}>Nombre del KPI</span>
        <Input required maxLength={200} value={nombre} onChange={(e) => setNombre(e.target.value)} />
      </label>
      <label style={campo}>
        <span style={etiqueta}>Definición del cálculo</span>
        <Textarea
          required
          rows={2}
          maxLength={2000}
          value={definicion}
          onChange={(e) => setDefinicion(e.target.value)}
        />
      </label>
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12 }}>
        <label style={campo}>
          <span style={etiqueta}>Fuente del dato</span>
          <Input required maxLength={500} value={fuente} onChange={(e) => setFuente(e.target.value)} />
        </label>
        <label style={campo}>
          <span style={etiqueta}>Frecuencia</span>
          <select
            required
            value={frecuencia}
            onChange={(e) => setFrecuencia(e.target.value as ContenidoEntradaKpi['frecuencia'])}
            style={{ font: '400 13px var(--font-sans)', padding: '6px 8px' }}
          >
            <option value="semanal">semanal</option>
            <option value="mensual">mensual</option>
            <option value="trimestral">trimestral</option>
            <option value="unica">única</option>
          </select>
        </label>
      </div>
      <label style={campo}>
        <span style={etiqueta}>Dimensiones (opcional)</span>
        <Input
          maxLength={500}
          value={dimensiones}
          onChange={(e) => setDimensiones(e.target.value)}
        />
      </label>
      <span style={{ font: '400 12px var(--font-sans)', color: 'var(--text-faint)' }}>
        El criterio al que responde no se cambia aquí: si es el equivocado, rechaza la propuesta
        —o acéptala y reapúntala editando la entrada, que es el camino que el registry tiene
        mientras sea borrador.
      </span>
      <div style={{ display: 'flex', gap: 8 }}>
        <Button type="submit" size="sm" disabled={ocupado}>
          Aceptar corregida
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={ocupado} onClick={onCancelar}>
          Cancelar
        </Button>
      </div>
    </form>
  );
}

function FormularioCriterio({
  inicial,
  ocupado,
  onEnviar,
  onCancelar,
}: {
  inicial: ContenidoCriterio;
  ocupado: boolean;
  onEnviar: (c: ContenidoCriterio) => Promise<void>;
  onCancelar: () => void;
}) {
  const [kpi, setKpi] = useState(inicial.kpi);
  const [definicion, setDefinicion] = useState(inicial.definicion);
  const [objetivo, setObjetivo] = useState(inicial.objetivo);
  const [ventanaDias, setVentanaDias] = useState(String(inicial.ventanaDias));
  const [lineaBasePlan, setLineaBasePlan] = useState(inicial.lineaBasePlan);

  return (
    <form
      style={CAJA_CORRECCION}
      onSubmit={(e) => {
        e.preventDefault();
        void onEnviar({
          kpi,
          definicion,
          objetivo,
          // `Number` y no `parseInt`: `parseInt('2.5')` devuelve 2 en SILENCIO, así que
          // quien escribiera dos días y medio guardaba dos sin que nadie se lo dijera — y
          // en una ventana de medición ese día decide qué snapshots entran. `Number` deja
          // pasar el 2.5 hasta el esquema, que es quien tiene que rechazarlo (`.int()`), y
          // convierte el vacío en 0 y la basura en NaN, que `.positive()` también rechaza.
          // El `step` del input es una ayuda al usuario; el contrato lo sostiene Zod.
          ventanaDias: Number(ventanaDias),
          lineaBasePlan,
          razonamiento: inicial.razonamiento,
          // Mismo criterio que en CI: lo que el modelo afirmó —sus citas y su confianza— no
          // lo reescribe quien corrige.
          confianzaPropuesta: inicial.confianzaPropuesta,
          citas: inicial.citas,
        });
      }}
    >
      <span style={{ font: '700 13px var(--font-sans)', color: 'var(--ink)' }}>
        Corregir antes de aceptar (la propuesta original se conserva)
      </span>
      <label style={campo}>
        <span style={etiqueta}>KPI</span>
        <Input required maxLength={200} value={kpi} onChange={(e) => setKpi(e.target.value)} />
      </label>
      <label style={campo}>
        <span style={etiqueta}>Definición del cálculo</span>
        <Textarea
          required
          rows={2}
          maxLength={2000}
          value={definicion}
          onChange={(e) => setDefinicion(e.target.value)}
        />
      </label>
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12 }}>
        <label style={campo}>
          <span style={etiqueta}>Objetivo</span>
          <Input required maxLength={200} value={objetivo} onChange={(e) => setObjetivo(e.target.value)} />
        </label>
        <label style={campo}>
          <span style={etiqueta}>Ventana (días)</span>
          <Input
            required
            type="number"
            step={1}
            min={1}
            max={3650}
            value={ventanaDias}
            onChange={(e) => setVentanaDias(e.target.value)}
          />
        </label>
      </div>
      <label style={campo}>
        <span style={etiqueta}>Plan para obtener la línea base</span>
        <Textarea
          required
          rows={2}
          maxLength={1000}
          value={lineaBasePlan}
          onChange={(e) => setLineaBasePlan(e.target.value)}
        />
      </label>
      <span style={{ font: '400 12px var(--font-sans)', color: 'var(--text-faint)' }}>
        El valor y la fecha de la línea base los registra una persona editando el criterio: la AI
        no inventa mediciones.
      </span>
      <div style={{ display: 'flex', gap: 10 }}>
        <Button type="submit" size="sm" disabled={ocupado}>
          {ocupado ? 'Aceptando…' : 'Aceptar con estas correcciones'}
        </Button>
        <Button size="sm" variant="ghost" disabled={ocupado} onClick={onCancelar}>
          Cancelar
        </Button>
      </div>
    </form>
  );
}
