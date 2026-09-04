import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { createFileRoute, useNavigate, useSearch } from '@tanstack/react-router';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Wordmark } from '@/components/ui/Wordmark';
import {
  ejecutarDisposicionFn,
  misConstanciasFn,
  panelDisposicionFn,
  registrarAcuerdoFn,
} from '@/lib/disposicion/disposicion.functions';
import { hoyCalendario } from '@/lib/fecha-calendario';
import { elWorkspacePedidoNoEsElActivo, wsDeBusqueda } from '@/lib/auth/workspace-activo';
import {
  CONFIRMACION_BORRADO,
  cargaCanonicaConstancia,
  elWorkspaceSeFueConLaEjecucion,
  laConstanciaSigueSiendoDeEsteAcuerdo,
  ROLES_DISPOSICION,
  type ConstanciaDisposicion,
  type ModalidadDisposicion,
  type PanelDisposicion,
} from '@/lib/disposicion/disposicion.schemas';

/**
 * Disposición acordada del workspace (SPEC-01, RF-01.9 + RF-09.4).
 *
 * Dos actos separados a propósito: REGISTRAR lo acordado y EJECUTARLO. Que sean dos pantallas
 * distintas del mismo sitio es lo que hace que un borrado irreversible no pueda ser un clic —
 * entre los dos hay un acuerdo escrito, una retención pactada y una exportación entregada.
 *
 * Lo que esta pantalla NO hace es decidir. El motivo por el que una disposición no se puede
 * ejecutar lo da la misma función de la base que usa el guard, así que el botón no se ofrece
 * cuando la base lo va a rechazar y —lo que importa más— no se esconde cuando sí correspondía.
 * Un espejo escrito aquí se quedaría corto en cuanto alguien tocara aquella.
 */
export const Route = createFileRoute('/_autenticada/disposicion')({
  component: PantallaDisposicion,
});

const etiqueta: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontWeight: 500,
  fontSize: 11,
  letterSpacing: '.08em',
  textTransform: 'uppercase',
  color: 'var(--text-muted)',
};

const parrafo: CSSProperties = {
  font: '400 13.5px/1.6 var(--font-sans)',
  color: 'var(--text-body)',
  margin: 0,
};

/**
 * El instante, en UTC y con forma fija.
 *
 * `toLocaleString()` no vale aquí por dos razones que se suman. La primera es de corrección:
 * esta aplicación renderiza en el servidor, así que ese texto se calcula una vez con el locale
 * y el huso del proceso y otra con los del navegador — y cuando difieren, React encuentra dos
 * árboles distintos al hidratar. La segunda es de sentido: esto es la fecha que acredita que
 * el archivo se entregó ANTES de disponer, y una fecha que cambia según quién mire no acredita
 * nada. Se pinta el instante en UTC, dicho, que es el mismo para las dos partes del contrato
 * aunque estén en husos distintos.
 */
function instanteUTC(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

function PantallaDisposicion() {
  const { membresiaActiva, usuario } = Route.useRouteContext();
  const navigate = useNavigate();
  const workspaceId = membresiaActiva?.workspaceId;
  /*
   * QUÉ workspace se va a disponer, dicho en la pantalla y no solo sabido por ella.
   *
   * `membresiaActivaDe` cae a la primera membresía cuando el `ws` de la dirección no es
   * ninguna de las tuyas — y eso está bien para navegar: entrar por un enlace viejo no debería
   * dejarte en una pantalla vacía. Pero es SILENCIOSO, y aquí el silencio no vale: recargar
   * después de borrar el workspace que iba en la URL te deja en OTRO, con el mismo aspecto y
   * los mismos botones, y uno de esos botones destruye. Quien mire puede creer que sigue en el
   * anterior y acabar borrando el que no era.
   *
   * Así que el nombre acompaña a la cabecera y a cada acción, y la sustitución se dice cuando
   * ocurre. El predicado vive en el módulo del workspace activo, junto a la caída que avisa,
   * para poder comprobarlo sin montar React.
   */
  const nombreWs = membresiaActiva?.workspaceNombre ?? '';
  const wsPedido = wsDeBusqueda((useSearch({ strict: false }) as { ws?: unknown }).ws);
  const sustituido = elWorkspacePedidoNoEsElActivo(usuario.membresias, wsPedido);

  const [panel, setPanel] = useState<PanelDisposicion | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(true);
  const [modalidad, setModalidad] = useState<ModalidadDisposicion>('archivo');
  const [base, setBase] = useState('');
  // `hoyCalendario` y no `toISOString().slice(0, 10)`: aquél recorta en UTC, así que en husos
  // al oeste propone AYER y al este MAÑANA. En una retención eso desplaza un día el momento en
  // que la disposición se puede ejecutar, sin que nadie lo note.
  const [efectivoDesde, setEfectivoDesde] = useState(hoyCalendario());
  const [confirmacion, setConfirmacion] = useState('');
  const [trabajando, setTrabajando] = useState(false);
  const [constancia, setConstancia] = useState<ConstanciaDisposicion | null>(null);
  // Las constancias que esta persona conserva, en cualquier workspace y sin depender de
  // seguir siendo miembro. Es la única vía por la que se llega a la de un workspace BORRADO:
  // el workspace activo se resuelve desde las membresías, y tras un borrado no queda ninguna.
  const [mias, setMias] = useState<ConstanciaDisposicion[]>([]);

  const puedeAcordar = ROLES_DISPOSICION.includes(
    (membresiaActiva?.rol ?? '') as (typeof ROLES_DISPOSICION)[number],
  );

  /*
   * Si la lectura falla, el panel se VACÍA. Conservar el anterior dejaba la pantalla
   * ofreciendo acciones calculadas sobre una foto vieja —un `motivoNoEjecutable` en null de
   * hace un rato deja habilitado el botón de ejecutar— junto a un mensaje de error, que es
   * exactamente lo que esta pantalla existe para no hacer: no ofrecer lo que la base va a
   * rechazar. Sin estado es mejor que con estado equivocado cuando lo que se ofrece destruye
   * un workspace.
   */
  const recargar = useCallback(async () => {
    if (!workspaceId) {
      setPanel(null);
      setError(null);
      setCargando(false);
      return;
    }
    setCargando(true);
    try {
      const r = await panelDisposicionFn({ data: { workspaceId } });
      if (!r.ok) {
        setPanel(null);
        setError(r.error);
      } else {
        setPanel(r.panel);
        setError(null);
      }
    } catch {
      setPanel(null);
      setError('No se pudo leer el estado de la disposición');
    } finally {
      setCargando(false);
    }
  }, [workspaceId]);

  const recargarMias = useCallback(async () => {
    try {
      const r = await misConstanciasFn();
      if (r.ok) setMias(r.constancias);
    } catch {
      /* la lista es complementaria: si falla, la pantalla sigue sirviendo para lo demás */
    }
  }, []);

  useEffect(() => {
    void recargar();
    void recargarMias();
  }, [recargar, recargarMias]);

  /*
   * La palabra escrita vale para EL acuerdo que se tenía delante, así que si el vigente cambia
   * mientras la pantalla está abierta, se borra.
   *
   * El caso concreto: se teclea BORRAR mirando el acuerdo #1, la otra parte registra un #2, la
   * petición se rechaza por versión —eso sí lo para el servidor— y la recarga inmediata trae
   * el #2. Sin esto, la confirmación seguía escrita, el botón seguía habilitado, y el segundo
   * clic ejecutaba conforme a un acuerdo que nadie confirmó: otra base contractual y otra
   * retención, con la ceremonia hecha sobre otra cosa. Que el servidor compruebe la versión no
   * lo cubre —la segunda petición ya lleva la del #2—: lo que hay que invalidar es el ACTO
   * humano, y eso solo se puede hacer aquí.
   */
  const versionVigente = panel?.acuerdoVigente?.version;
  const versionAnterior = useRef(versionVigente);
  useEffect(() => {
    const antes = versionAnterior.current;
    versionAnterior.current = versionVigente;
    setConfirmacion('');
    // Y la constancia recién emitida, por lo mismo. La expresión que decide qué documento se
    // pinta prefiere SIEMPRE el estado local sobre `panel.constanciaVigente`, así que tras
    // ejecutar un archivo y registrar acto seguido el acuerdo que lo revierte, la pantalla
    // seguía enseñando la constancia del #1 junto al acuerdo #2 —aunque la consulta ya
    // devolviera null—. Arreglar la consulta no alcanzaba a esa precedencia.
    //
    // Pero solo entre acuerdos REALES: tras un borrado la versión no cambia, DESAPARECE —la
    // ejecución destruye la membresía y la recarga trae un panel vacío—, y soltar ahí borraba
    // de la pantalla el recibo recién emitido de la operación irreversible. El predicado vive
    // en el esquema para poder comprobarlo sin montar React.
    if (!laConstanciaSigueSiendoDeEsteAcuerdo(antes, versionVigente)) setConstancia(null);
  }, [versionVigente]);

  async function acordar() {
    if (!workspaceId) return;
    setTrabajando(true);
    setError(null);
    try {
      const r = await registrarAcuerdoFn({
        data: { workspaceId, modalidad, base, efectivoDesde },
      });
      if (!r.ok) setError(r.error);
      else {
        setBase('');
        await recargar();
      }
    } catch {
      setError('No se pudo registrar el acuerdo');
    } finally {
      setTrabajando(false);
    }
  }

  async function ejecutar() {
    if (!workspaceId || !panel?.acuerdoVigente) return;
    setTrabajando(true);
    setError(null);
    // La constancia anterior se descarta ANTES de pedir nada: dejar en pantalla el documento
    // de otra operación mientras ésta falla haría creer que acredita ésta, y una constancia
    // que no acredita lo que se está mirando es lo contrario de lo que existe para hacer.
    setConstancia(null);
    try {
      const r = await ejecutarDisposicionFn({
        data: {
          workspaceId,
          modalidadEsperada: panel.acuerdoVigente.modalidad,
          acuerdoVersionEsperada: panel.acuerdoVigente.version,
          // La confirmación escrita VIAJA. El `disabled` del botón no es una comprobación
          // —es una sugerencia que el navegador puede no seguir—, y sin esto cualquier
          // llamada al transporte ejecutaba el borrado sin que nadie hubiera escrito nada.
          confirmacion,
        },
      });
      if (r.ok) {
        setConstancia(r.constancia);
        setConfirmacion('');
      }
      await recargar();
      await recargarMias();
      /*
       * El rechazo se fija DESPUÉS de recargar, y el orden es el arreglo entero: `recargar()`
       * limpia el error cuando el panel vuelve bien —tiene que hacerlo, o un panel sano
       * arrastraría el error de antes— así que fijarlo primero lo borraba justo en el caso que
       * más importa. El del inventario cambiado es el ejemplo: esa comprobación solo corre al
       * ejecutar, así que el panel vuelve con `motivoNoEjecutable` en null, el botón queda
       * habilitado y quien mira no se entera de que tiene que volver a exportar.
       */
      if (!r.ok) setError(r.error);
    } catch {
      setError('No se pudo ejecutar la disposición');
    } finally {
      setTrabajando(false);
    }
  }

  const vigente = panel?.acuerdoVigente ?? null;
  const esBorrado = vigente?.modalidad === 'borrado';
  /*
   * Lo que se pinta se decide por el PANEL cargado, no por `workspaceId`.
   *
   * Y la diferencia entre los dos no es teórica: tras un borrado, la membresía se destruye en
   * la base pero el contexto de la ruta sigue trayendo el workspace de antes, así que
   * `workspaceId` seguía siendo cierto con el panel ya vacío. La pantalla enseñaba a la vez el
   * recibo de la operación irreversible, un error de acceso, y —calculados sobre una membresía
   * que ya no existe— un «No hay acuerdo registrado», el formulario de «Registrar un acuerdo»
   * y el texto del archivo. Tres cosas que se contradicen, en la única pantalla que le queda a
   * quien acaba de perder su workspace.
   */
  const modalidadRecien = constancia?.modalidad ?? null;
  const seFueConLaEjecucion = elWorkspaceSeFueConLaEjecucion(modalidadRecien, panel !== null);
  const puedeEjecutar =
    Boolean(vigente) &&
    panel?.motivoNoEjecutable === null &&
    (!esBorrado || confirmacion === CONFIRMACION_BORRADO);

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
            Disposición del workspace
          </span>
          {nombreWs !== '' && (
            <span style={{ font: '400 13px var(--font-sans)', color: 'var(--text-muted)' }}>
              · {nombreWs}
            </span>
          )}
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
          gap: 18,
        }}
      >
        {/* Sin membresía no hay nada que disponer, pero puede quedar mucho que conservar: es
            exactamente lo que le pasa a quien acaba de ver borrado su workspace. Decirle solo
            «no perteneces a ningún workspace» sería despedirlo de la única pantalla que
            todavía guarda su recibo. */}
        {!workspaceId && (
          <Card style={{ padding: 24 }}>
            <p style={parrafo}>
              {mias.length > 0
                ? 'Ya no perteneces a ningún workspace activo. Las constancias que conservas siguen aquí abajo: cada una se verifica por su cuenta con su sello.'
                : 'Aún no perteneces a ningún workspace.'}
            </p>
          </Card>
        )}

        {sustituido && (
          <Card style={{ padding: 18, borderColor: 'var(--danger)' }}>
            <p style={{ ...parrafo, color: 'var(--danger)' }}>
              La dirección pedía otro workspace y ése no es tuyo —o ha dejado de serlo—. Lo que
              ves aquí, y lo que se dispondría, es <strong>{nombreWs}</strong>. Compruébalo
              antes de acordar o ejecutar nada.
            </p>
          </Card>
        )}

        {seFueConLaEjecucion && (
          <Card style={{ padding: 24 }}>
            <p style={parrafo}>
              El borrado se ejecutó y el workspace ya no existe: con él desapareció tu
              membresía, así que esta pantalla no puede leer nada más de él. Tu constancia está
              aquí abajo, y se verifica por su cuenta con su sello.
            </p>
          </Card>
        )}

        {error && !seFueConLaEjecucion && (
          <Card style={{ padding: 18, borderColor: 'var(--danger)' }}>
            <p style={{ ...parrafo, color: 'var(--danger)' }}>{error}</p>
          </Card>
        )}

        {panel && !cargando && (
          <>
            <Card style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 12 }}>
              <span style={etiqueta}>Qué se acordó</span>
              {vigente ? (
                <>
                  <p style={parrafo}>
                    Acuerdo <strong>#{vigente.version}</strong>:{' '}
                    <strong>{vigente.modalidad === 'borrado' ? 'borrado' : 'archivo'}</strong>,
                    registrado por <strong>{vigente.acordadoRol}</strong> y efectivo desde el{' '}
                    <strong>{vigente.efectivoDesde}</strong>.
                  </p>
                  <p style={{ ...parrafo, color: 'var(--text-muted)' }}>
                    Base: «{vigente.base}»
                  </p>
                </>
              ) : (
                <p style={parrafo}>
                  No hay acuerdo registrado. El acuerdo se registra <strong>antes</strong> de
                  ejecutarlo, y es él quien dice si corresponde archivo o borrado.
                </p>
              )}
              <p style={{ ...parrafo, color: 'var(--text-muted)' }}>
                {panel?.ultimaExportacion
                  ? `Última exportación del archivo completo: ${instanteUTC(panel.ultimaExportacion)}`
                  : 'Todavía no se ha entregado el archivo completo del workspace.'}
              </p>
            </Card>

            {puedeAcordar && (
              <Card style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 12 }}>
                <span style={etiqueta}>Registrar un acuerdo · {nombreWs}</span>
                <p style={{ ...parrafo, color: 'var(--text-muted)' }}>
                  Cambiar de opinión es un registro <strong>nuevo</strong>, nunca una
                  corrección del anterior: la bitácora cuenta la historia entera y manda el
                  último.
                </p>
                <Select
                  value={modalidad}
                  onChange={(e) => setModalidad(e.target.value as ModalidadDisposicion)}
                >
                  <option value="archivo">Archivo — se conserva para consulta, sin escrituras</option>
                  <option value="borrado">Borrado — se destruye, y no tiene vuelta</option>
                </Select>
                <Input
                  placeholder="Referencia del acuerdo: cláusula, contrato o acta"
                  value={base}
                  maxLength={300}
                  onChange={(e) => setBase(e.target.value)}
                />
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ ...parrafo, color: 'var(--text-muted)' }}>Efectivo desde</span>
                  <Input
                    type="date"
                    value={efectivoDesde}
                    onChange={(e) => setEfectivoDesde(e.target.value)}
                  />
                </div>
                <p style={{ ...parrafo, color: 'var(--text-muted)' }}>
                  Antes de esa fecha la disposición no se ejecuta: es la retención acordada, y
                  es lo que impide que un borrado irreversible sea un clic.
                </p>
                <div>
                  <Button onClick={acordar} disabled={trabajando || base.trim().length === 0}>
                    Registrar acuerdo
                  </Button>
                </div>
              </Card>
            )}

            <Card style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 12 }}>
              <span style={etiqueta}>Ejecutar lo acordado</span>
              {panel?.motivoNoEjecutable ? (
                <p style={parrafo}>{panel.motivoNoEjecutable}</p>
              ) : (
                <>
                  <p style={parrafo}>
                    {esBorrado
                      ? `Se destruirá todo el contenido de «${nombreWs}», incluidos los objetos derivados —propuestas AI, insights, journeys, mediciones— y su auditoría. No tiene vuelta.`
                      : `«${nombreWs}» se conservará para consulta y dejará de admitir escrituras. Cambiar esa disposición exige registrar un acuerdo nuevo.`}
                  </p>
                  <p style={{ ...parrafo, color: 'var(--text-muted)' }}>
                    Recibirás una constancia sellada. Consérvala: tras un borrado dejas de ser
                    miembro y ya no podrás consultarla aquí, y su sello se comprueba sin esta
                    aplicación delante.
                  </p>
                  {esBorrado && (
                    <>
                      <p style={parrafo}>
                        Escribe <strong>{CONFIRMACION_BORRADO}</strong> para confirmar el
                        borrado de <strong>{nombreWs}</strong>.
                      </p>
                      <Input
                        value={confirmacion}
                        onChange={(e) => setConfirmacion(e.target.value)}
                        placeholder={CONFIRMACION_BORRADO}
                      />
                    </>
                  )}
                  <div>
                    <Button
                      variant={esBorrado ? 'danger' : 'primary'}
                      onClick={ejecutar}
                      disabled={trabajando || !puedeEjecutar}
                    >
                      {esBorrado ? 'Borrar el workspace' : 'Archivar el workspace'}
                    </Button>
                  </div>
                </>
              )}
            </Card>

          </>
        )}

        {/* El recibo va FUERA del bloque de arriba, y ésa es la otra mitad del arreglo: el
            momento en que más importa enseñarlo es justo aquel en el que el panel ya no se
            puede leer. */}
        {(constancia ?? panel?.constanciaVigente) && (
          <Constancia
            c={(constancia ?? panel!.constanciaVigente)!}
            reciente={Boolean(constancia)}
          />
        )}

        {mias.length > 0 && (
          <Card style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <span style={etiqueta}>Constancias que conservas</span>
            <p style={{ ...parrafo, color: 'var(--text-muted)' }}>
              De cualquier workspace del que seas —o hayas sido— parte. Tras un borrado dejas de
              ser miembro, así que ésta es la única vía por la que se llega a la suya.
            </p>
            {mias.map((c) => (
              <details key={c.id}>
                <summary style={{ ...parrafo, cursor: 'pointer' }}>
                  {c.modalidad === 'borrado' ? 'Borrado' : 'Archivo'} del workspace{' '}
                  <span style={{ fontFamily: 'var(--font-mono)' }}>
                    {c.workspaceId.slice(0, 8)}
                  </span>{' '}
                  <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>
                    · sello {c.sello.slice(0, 12)}…
                  </span>
                </summary>
                <div style={{ marginTop: 10 }}>
                  <Constancia c={c} reciente={false} />
                </div>
              </details>
            ))}
          </Card>
        )}
      </main>
    </div>
  );
}

/**
 * El documento. Se enseña con su carga canónica ENTERA y no solo con el sello, porque un
 * hash que nadie puede recomputar no acredita nada: con este texto y un `sha256sum` se
 * verifica la constancia sin esta base delante, que es exactamente para lo que existe.
 */
function Constancia({ c, reciente }: { c: ConstanciaDisposicion; reciente: boolean }) {
  const carga = cargaCanonicaConstancia(c);
  const tablas = Object.entries(c.conteos).sort(([a], [b]) => (a < b ? -1 : 1));
  /*
   * Qué salió hacia fuera se decide por el MAPA, no por el contador de ítems. Un workspace
   * que solo hizo llamadas de alcance de reto (C0) tiene `reto_id` e `item_id` nulo en cada
   * fila, así que `remediacionItems` vale 0 con `remediacion` lleno: gobernar la visibilidad
   * con el contador escondía el aviso entero justo en ese caso —el usuario no llegaba a
   * saber que había material en un proveedor al que pedir la retirada—. El contador sigue
   * siendo dato, y lo dice la frase; lo que ya no es, es la condición.
   */
  const modelos = Object.entries(c.remediacion).sort(([a], [b]) => (a < b ? -1 : 1));
  return (
    <Card style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <span style={etiqueta}>
        {reciente ? 'Constancia emitida' : 'Constancia de la disposición ejecutada'}
      </span>
      <p style={parrafo}>
        {c.modalidad === 'borrado' ? 'Borrado' : 'Archivo'} del acuerdo #{c.acuerdoVersion},
        ejecutado por {c.ejecutadoRol}.
      </p>
      {/*
        El acuerdo se enseña ENTERO y no solo por su número, porque entero es como viaja
        dentro del sello: es lo que acredita la primera de las dos firmas cuando ya no queda
        base que consultar. Sin esto, la pantalla enseñaría menos de lo que el documento dice.
      */}
      <div>
        <span style={etiqueta}>Acuerdo ejecutado</span>
        <p style={{ ...parrafo, color: 'var(--text-muted)' }}>
          «{c.acuerdoBase}» — registrado por {c.acuerdoRol}, ejecutable desde el{' '}
          {c.acuerdoEfectivoDesde}.
        </p>
      </div>
      <div>
        <span style={etiqueta}>Sello (sha256)</span>
        <p style={{ ...parrafo, fontFamily: 'var(--font-mono)', wordBreak: 'break-all' }}>
          {c.sello}
        </p>
      </div>
      <div>
        <span style={etiqueta}>
          {c.modalidad === 'borrado' ? 'Filas destruidas' : 'Filas conservadas'}
        </span>
        <p style={{ ...parrafo, color: 'var(--text-muted)' }}>
          {tablas.length === 0
            ? 'Ninguna.'
            : tablas.map(([t, n]) => `${t}: ${n}`).join(' · ')}
        </p>
      </div>
      {modelos.length > 0 && (
        <div>
          <span style={etiqueta}>Lo que ya salió y no alcanza este borrado</span>
          <p style={{ ...parrafo, color: 'var(--text-muted)' }}>
            {modelos.map(([m, n]) => `${m}: ${n}`).join(' · ')} — llamadas despachadas a un
            proveedor externo.{' '}
            {c.remediacionItems > 0
              ? `De ellas, ${c.remediacionItems} ítems de bandeja tuvieron material enviado y ${c.remediacionConConsentimiento} llamadas iban amparadas por un consentimiento —es decir, con material de personas—.`
              : 'Ninguna iba anclada a un ítem de la bandeja: son llamadas de alcance de reto, que no llevan material importado de personas.'}{' '}
            Los bytes enviados no se des-envían: eso se retira pidiéndoselo al proveedor, y
            esta es la lista con la que hacerlo.
          </p>
        </div>
      )}
      <details>
        <summary style={{ ...parrafo, cursor: 'pointer' }}>
          Cómo comprobar este sello por tu cuenta
        </summary>
        <p style={{ ...parrafo, color: 'var(--text-muted)', marginTop: 8 }}>
          El sello es el sha256 del texto de abajo, en UTF-8 y <strong>sin salto de línea
          final</strong>. Guárdalo tal cual y ejecuta <code>sha256sum constancia.txt</code>:
          tiene que dar el mismo valor. Si difiere, la copia que tienes no es la que se emitió —
          y ojo, un salto final que añada el editor ya la cambia, que es justo lo que este
          método detecta y lo que una sustitución de shell como <code>$(cat …)</code> se
          comería sin avisar.
        </p>
        <p style={{ ...parrafo, color: 'var(--text-muted)', marginTop: 8 }}>
          Conviene saber hasta dónde llega: es un hash <strong>sin clave</strong>, así que
          comprueba <strong>integridad</strong> —que tu copia coincida con el sello que
          recibiste— pero no <strong>autenticidad</strong>. No demuestra por sí solo que lo
          emitiéramos nosotros, y quien altere el documento entero puede recalcular también el
          sello. Anota el sello por separado y compáralo con éste.
        </p>
        <pre
          style={{
            font: '400 11.5px/1.5 var(--font-mono)',
            color: 'var(--text-body)',
            background: 'var(--bg-app)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            padding: 12,
            overflowX: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
          }}
        >
          {carga}
        </pre>
      </details>
      <p style={{ ...parrafo, color: 'var(--text-muted)' }}>{c.alcance}</p>
    </Card>
  );
}
