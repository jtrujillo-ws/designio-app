import { useCallback, useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
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
import {
  cargaCanonicaConstancia,
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

/** Lo que hay que teclear para ejecutar un borrado. No es teatro: es lo que convierte un
 * clic en un acto deliberado, y la única defensa que queda contra el error humano cuando
 * todas las demás —acuerdo, retención, exportación, doble firma— ya se han cumplido. */
const CONFIRMACION_BORRADO = 'BORRAR';

function PantallaDisposicion() {
  const { membresiaActiva } = Route.useRouteContext();
  const navigate = useNavigate();
  const workspaceId = membresiaActiva?.workspaceId;

  const [panel, setPanel] = useState<PanelDisposicion | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(true);
  const [modalidad, setModalidad] = useState<ModalidadDisposicion>('archivo');
  const [base, setBase] = useState('');
  const [efectivoDesde, setEfectivoDesde] = useState(new Date().toISOString().slice(0, 10));
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

  const recargar = useCallback(async () => {
    if (!workspaceId) {
      setCargando(false);
      return;
    }
    setCargando(true);
    try {
      const r = await panelDisposicionFn({ data: { workspaceId } });
      if (!r.ok) setError(r.error);
      else {
        setPanel(r.panel);
        setError(null);
      }
    } catch {
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
        data: { workspaceId, modalidadEsperada: panel.acuerdoVigente.modalidad },
      });
      if (!r.ok) setError(r.error);
      else {
        setConstancia(r.constancia);
        setConfirmacion('');
      }
      await recargar();
      await recargarMias();
    } catch {
      setError('No se pudo ejecutar la disposición');
    } finally {
      setTrabajando(false);
    }
  }

  const vigente = panel?.acuerdoVigente ?? null;
  const esBorrado = vigente?.modalidad === 'borrado';
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
        {!workspaceId && (
          <Card style={{ padding: 24 }}>
            <p style={parrafo}>Aún no perteneces a ningún workspace.</p>
          </Card>
        )}

        {error && (
          <Card style={{ padding: 18, borderColor: 'var(--danger)' }}>
            <p style={{ ...parrafo, color: 'var(--danger)' }}>{error}</p>
          </Card>
        )}

        {workspaceId && !cargando && (
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
                  ? `Última exportación del archivo completo: ${new Date(panel.ultimaExportacion).toLocaleString()}`
                  : 'Todavía no se ha entregado el archivo completo del workspace.'}
              </p>
            </Card>

            {puedeAcordar && (
              <Card style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 12 }}>
                <span style={etiqueta}>Registrar un acuerdo</span>
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
                      ? 'Se destruirá todo el contenido de este workspace, incluidos los objetos derivados —propuestas AI, insights, journeys, mediciones— y su auditoría. No tiene vuelta.'
                      : 'El workspace se conservará para consulta y dejará de admitir escrituras. Cambiar esa disposición exige registrar un acuerdo nuevo.'}
                  </p>
                  <p style={{ ...parrafo, color: 'var(--text-muted)' }}>
                    Recibirás una constancia sellada. Consérvala: tras un borrado dejas de ser
                    miembro y ya no podrás consultarla aquí, y su sello se comprueba sin esta
                    aplicación delante.
                  </p>
                  {esBorrado && (
                    <>
                      <p style={parrafo}>
                        Escribe <strong>{CONFIRMACION_BORRADO}</strong> para confirmar.
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

            {(constancia ?? panel?.constanciaVigente) && (
              <Constancia c={(constancia ?? panel!.constanciaVigente)!} reciente={Boolean(constancia)} />
            )}
          </>
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
  return (
    <Card style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <span style={etiqueta}>
        {reciente ? 'Constancia emitida' : 'Constancia de la disposición ejecutada'}
      </span>
      <p style={parrafo}>
        {c.modalidad === 'borrado' ? 'Borrado' : 'Archivo'} del acuerdo #{c.acuerdoVersion},
        ejecutado por {c.ejecutadoRol}.
      </p>
      <div>
        <span style={etiqueta}>Sello (sha256)</span>
        <p style={{ ...parrafo, fontFamily: 'var(--font-mono)', wordBreak: 'break-all' }}>
          {c.sello}
        </p>
      </div>
      <div>
        <span style={etiqueta}>
          {c.modalidad === 'borrado' ? 'Filas destruidas' : 'Filas conservadas y congeladas'}
        </span>
        <p style={{ ...parrafo, color: 'var(--text-muted)' }}>
          {tablas.length === 0
            ? 'Ninguna.'
            : tablas.map(([t, n]) => `${t}: ${n}`).join(' · ')}
        </p>
      </div>
      {c.remediacionItems > 0 && (
        <div>
          <span style={etiqueta}>Lo que ya salió y no alcanza este borrado</span>
          <p style={{ ...parrafo, color: 'var(--text-muted)' }}>
            {c.remediacionItems} ítems tuvieron material despachado a un proveedor externo, de
            ellos {c.remediacionConConsentimiento} llamadas amparadas por un consentimiento
            —es decir, con material de personas—. Los bytes enviados no se des-envían: eso se
            retira pidiéndoselo al proveedor, y esta es la lista con la que hacerlo.
          </p>
        </div>
      )}
      <details>
        <summary style={{ ...parrafo, cursor: 'pointer' }}>
          Cómo comprobar este sello por tu cuenta
        </summary>
        <p style={{ ...parrafo, color: 'var(--text-muted)', marginTop: 8 }}>
          El sello es el sha256 del texto de abajo, en UTF-8 y sin salto final. Guárdalo y
          ejecuta <code>printf &apos;%s&apos; &quot;$(cat constancia.txt)&quot; | sha256sum</code>:
          tiene que dar el mismo valor. Si difiere, la copia que tienes no es la que se emitió.
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
