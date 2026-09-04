import { afterAll, beforeAll, expect, it } from 'vitest';
/* Solo para los TIPOS del censo de abajo: el valor llega por `import()` dinámico, que no
 * sirve como espacio de nombres de tipos. Se borra al compilar. */
import type * as TS from 'typescript';
import { createHash } from 'node:crypto';
import { cerrarPools, conUsuario, sqlAdmin } from '@/lib/db';
import { exportarWorkspace } from '@/lib/exportacion/exportacion.servicio';
import {
  RegistrarAcuerdoSchema,
  cargaCanonicaConstancia,
  jsonbTexto,
} from '@/lib/disposicion/disposicion.schemas';
import {
  ErrorDisposicion,
  ejecutarDisposicion,
  misConstancias,
  panelDisposicion,
  registrarAcuerdo,
  selloRecomputado,
} from '@/lib/disposicion/disposicion.servicio';
import { describeAuthz, enVuelo, sigueEsperando } from './helpers';

/**
 * SPEC-01 RF-01.9 — la disposición acordada: archivo o borrado posterior a la exportación,
 * según el acuerdo, con constancia verificable. Y RF-09.4: alcanza también a los derivados.
 *
 * Lo que se comprueba aquí, y que ninguna otra suite puede comprobar por su cuenta:
 *
 *  · que el conjunto de tablas que el borrado alcanza se DERIVA del catálogo y no de una
 *    lista, así que una tabla nueva entra sola;
 *  · que el sello se puede recomputar FUERA de la base — que es lo único que le queda al
 *    cliente cuando ya no es miembro de nada;
 *  · que la congelación tiene efecto observable, o «archivo» sería una etiqueta.
 */
describeAuthz('disposición acordada: archivo, borrado y constancia verificable', () => {
  const marca = `disp-${crypto.randomUUID().slice(0, 8)}`;
  let leadId = '';
  let adminId = '';
  /** Los workspaces creados, para poder recogerlos al final. Se anotan por ID y no por
   * nombre: el borrado sustituye el nombre por la lápida, así que buscarlos por la marca
   * dejaría atrás justamente los que este suite existe para probar. */
  const creados: string[] = [];

  /** Un workspace nuevo y poblado por cada caso: éstos se destruyen. */
  async function nuevoWorkspace(nombre: string): Promise<string> {
    const admin = sqlAdmin();
    const [w] = await admin`insert into workspace (nombre) values (${marca + ' ' + nombre})
      returning id`;
    const ws = w!.id as string;
    creados.push(ws);
    for (const [id, rol] of [
      [leadId, 'lead-boutique'],
      [adminId, 'admin-cliente'],
    ] as const) {
      await admin`insert into miembro (workspace_id, usuario_id, nombre, email, rol)
        values (${ws}, ${id}, 'x', ${`${marca}-${rol}@test.demo`}, ${rol})`;
    }
    await admin`insert into segmento (workspace_id, nombre, definicion)
      values (${ws}, 'segmento', 'de prueba')`;
    await admin`insert into servicio (workspace_id, nombre, creado_por)
      values (${ws}, 'Servicio', ${leadId})`;
    return ws;
  }

  /*
   * Una fecha del PASADO, fija, para todo acuerdo cuya retención no es lo que se está
   * probando. Con `new Date().toISOString().slice(0, 10)` el suite dependía del reloj: si la
   * fecha se calcula a las 23:59:59 y `current_date` se evalúa un instante después, la
   * retención queda en el futuro y el caso falla por el cambio de día y no por su regla. La
   * fecha relativa se reserva para el caso que SÍ cubre la retención, donde es el dato.
   */
  const EFECTIVO_PASADO = '2020-01-01';

  /** El acuerdo lo registra una parte y lo ejecuta la OTRA: es la doble firma del borrado. */
  async function acordarYExportar(
    ws: string,
    modalidad: 'archivo' | 'borrado',
    quien = adminId,
  ): Promise<void> {
    await registrarAcuerdo(quien, {
      workspaceId: ws,
      modalidad,
      base: 'Cláusula 9.3 del contrato marco',
      efectivoDesde: EFECTIVO_PASADO,
    });
    // «Posterior a la exportación» (RF-01.9) y posterior AL ACUERDO: el archivo se entrega
    // antes de disponer, y tiene que reflejar lo que se acordó disponer.
    await exportarWorkspace(leadId, { workspaceId: ws, ambito: 'archivo' });
  }

  beforeAll(async () => {
    const admin = sqlAdmin();
    for (const [alias, destino] of [
      ['lead', 'lead'],
      ['admin', 'admin'],
    ] as const) {
      const [u] = await admin`insert into usuario (email, nombre, estado)
        values (${`${marca}-${alias}@test.demo`}, ${alias}, 'activo') returning id`;
      if (destino === 'lead') leadId = u!.id as string;
      else adminId = u!.id as string;
    }
  });

  afterAll(async () => {
    const admin = sqlAdmin();
    // Recoger lo que este suite dejó es más trabajo de lo normal, y el motivo es el propio
    // slice: un workspace dispuesto queda CONGELADO, así que un `delete` corriente sobre él lo
    // rechaza el guard. Se apagan los triggers de dominio para la limpieza —la conexión admin
    // es superusuaria, igual que la que usa el vaciado— y se barre el conjunto DERIVADO del
    // catálogo, no una lista: si mañana nace una tabla con `workspace_id`, esta limpieza la
    // alcanza sola, como el borrado que prueba.
    await admin.begin(async (tx) => {
      await tx`select set_config('session_replication_role', 'replica', true)`;
      const tablas = (await tx`select tabla from tablas_del_workspace()`).map(
        (f) => f.tabla as string,
      );
      for (const ws of creados) {
        for (const tabla of tablas) {
          await tx.unsafe(`delete from "${tabla}" where workspace_id = $1`, [ws]);
        }
        await tx.unsafe(`delete from workspace where id = $1`, [ws]);
      }
    });
    await admin`delete from usuario where email like ${marca + '-%@test.demo'}`;
    await cerrarPools();
  });

  it('el conjunto que el borrado alcanza se DERIVA del catálogo, no de una lista', async () => {
    // RF-09.4 dice que el borrado alcanza también a los objetos derivados. Eso no puede
    // depender de que alguien se acuerde de añadir la tabla nueva de su slice a una lista, así
    // que la base lo deriva de su propio catálogo. Aquí se repite la derivación por fuera y se
    // exige que coincida: si algún día alguien sustituye la función por una enumeración, este
    // test lo detiene.
    const admin = sqlAdmin();
    const declaradas = (await admin`select tabla from tablas_del_workspace()`).map(
      (f) => f.tabla as string,
    );
    const reales = (
      await admin`select c.relname::text as t
        from pg_class c join pg_attribute a on a.attrelid = c.oid
        where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
          and a.attname = 'workspace_id' and not a.attisdropped and a.attnum > 0
        order by 1`
    ).map((f) => f.t as string);
    expect(declaradas.sort()).toEqual(reales.sort());
    // Y lo alcanzado es todo MENOS las dos tablas de la propia disposición: si el borrado se
    // llevara su constancia, no habría constancia del borrado.
    const alcanzadas = (await admin`select tabla from tablas_alcanzadas_por_borrado()`).map(
      (f) => f.tabla as string,
    );
    expect(alcanzadas).not.toContain('constancia_disposicion');
    expect(alcanzadas).not.toContain('acuerdo_disposicion');
    expect(alcanzadas).toContain('evento_dominio');
    expect(new Set(alcanzadas)).toEqual(
      new Set(reales.filter((t) => !t.endsWith('_disposicion'))),
    );
  });

  it('el guard de congelación es el PRIMER trigger de fila en cada tabla que cubre', async () => {
    // Postgres dispara los triggers de fila en orden de NOMBRE, y este tiene que tomar el
    // candado del workspace antes de que otro guard tome los suyos: si otro llegara primero,
    // un escritor podría esperar el candado del workspace reteniendo una fila que la
    // disposición necesita borrar. El prefijo `a_` lo pone delante, y esto lo convierte de
    // convención frágil en invariante comprobado.
    const admin = sqlAdmin();
    const tardios = await admin`
      select t.tabla, (select min(g.tgname) from pg_trigger g
        where g.tgrelid = t.tabla::regclass and not g.tgisinternal and g.tgtype & 1 = 1) as primero
      from tablas_congelables() t`;
    const malos = tardios.filter((f) => f.primero !== 'a_congelacion_por_disposicion');
    expect(malos.map((f) => f.tabla)).toEqual([]);
    // Y la derivación coincide con lo INSTALADO: ni una tabla congelable sin su trigger, ni un
    // trigger sobre una tabla que la derivación ya no incluye.
    const [n] = await admin`select count(*)::int as n from pg_trigger
      where tgname = 'a_congelacion_por_disposicion' and not tgisinternal`;
    const [c] = await admin`select count(*)::int as n from tablas_congelables()`;
    expect(n!.n).toBe(c!.n);
    expect(c!.n).toBeGreaterThan(40);
  });

  it('un borrado acordado vacía el workspace, deja lápida y una constancia verificable', async () => {
    const admin = sqlAdmin();
    const ws = await nuevoWorkspace('borrado');
    await acordarYExportar(ws, 'borrado', adminId);

    // La ejecuta la OTRA parte: el acuerdo lo registró admin-cliente.
    const constancia = await ejecutarDisposicion(leadId, {
      workspaceId: ws,
      modalidadEsperada: 'borrado',
      acuerdoVersionEsperada: 1,
      confirmacion: 'BORRAR',
    });

    // ── La constancia se verifica FUERA de la base ──
    // Es lo único que le queda al cliente: tras el borrado no hay `miembro`, así que RLS le
    // niega hasta la lápida. Se recomputa el sha256 sobre la carga canónica construida por la
    // app —no por Postgres— y tiene que dar el mismo sello que calculó la columna generada.
    expect(constancia.sello).toMatch(/^[0-9a-f]{64}$/);
    const recomputado = createHash('sha256')
      .update(cargaCanonicaConstancia(constancia), 'utf8')
      .digest('hex');
    expect(recomputado).toBe(constancia.sello);
    expect(constancia.modalidad).toBe('borrado');
    expect(constancia.ejecutadoRol).toBe('lead-boutique');
    // Los instantes viajan como TEXTO con los seis decimales de Postgres: reconstruirlos desde
    // un `Date` perdería los microsegundos y el sello dejaría de verificar.
    expect(constancia.ejecutadoEpoch).toMatch(/^\d+\.\d{6}$/);

    // ── Y acredita las DOS voluntades, no solo la de quien ejecutó ──
    // Un `acuerdoVersion = 1` no dice nada con el papel en la mano: hay que poder leer QUÉ se
    // pactó, desde cuándo era ejecutable y quién puso la PRIMERA firma. Es la mitad de la
    // garantía del borrado —quien registra y quien ejecuta son partes distintas—, y sin ella
    // la constancia solo acreditaría a quien apretó el botón.
    expect(constancia.acuerdoBase).toBe('Cláusula 9.3 del contrato marco');
    expect(constancia.acuerdoEfectivoDesde).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(constancia.acuerdoRol).toBe('admin-cliente');
    expect(constancia.acuerdoPor).toBe(adminId);
    expect(constancia.ejecutadoPor).toBe(leadId);
    expect(constancia.acuerdoPor).not.toBe(constancia.ejecutadoPor);
    // Y están DENTRO del texto que se hashea, que es lo único que importa fuera de la base.
    const carga = cargaCanonicaConstancia(constancia);
    for (const campo of [
      constancia.acuerdoBase,
      constancia.acuerdoEfectivoDesde,
      constancia.acuerdoPor,
      constancia.acuerdoRol,
    ]) {
      expect(carga).toContain(campo);
    }
    // Un campo por renglón: sin esa invariante, una referencia contractual con un salto de
    // línea dibujaría dentro del recibo campos que nadie pactó.
    expect(carga.split('\n').length).toBe(18);

    // ── Y el workspace está vacío de verdad ──
    const restantes: string[] = [];
    for (const f of await admin`select tabla from tablas_alcanzadas_por_borrado()`) {
      const tabla = f.tabla as string;
      const [n] = await admin.unsafe(
        `select count(*)::int as n from "${tabla}" where workspace_id = $1`,
        [ws],
      );
      // `evento_dominio` conserva UNO: el WorkspaceDispuesto que se emite DESPUÉS de vaciar.
      const esperado = tabla === 'evento_dominio' ? 1 : 0;
      if ((n!.n as number) !== esperado) restantes.push(`${tabla}=${n!.n}`);
    }
    expect(restantes).toEqual([]);
    const [ev] = await admin`select tipo from evento_dominio where workspace_id = ${ws}`;
    expect(ev!.tipo).toBe('WorkspaceDispuesto');

    // La lápida: la fila sobrevive porque de ella cuelga la constancia, pero el nombre no,
    // porque el nombre de la organización es dato del cliente.
    const [w] = await admin`select nombre from workspace where id = ${ws}`;
    expect(w!.nombre).toBe('Workspace borrado por acuerdo');
    expect(w!.nombre).not.toContain(marca);

    // El inventario no se escribió a mano: nombra tablas que la derivación incluye.
    expect(Object.keys(constancia.conteos).length).toBeGreaterThan(3);
    expect(constancia.conteos.segmento).toBe(1);
    expect(constancia.conteos.miembro).toBe(2);
  });

  it('un workspace archivado no se convierte en un permiso perpetuo: la baja SIEMPRE puede', async () => {
    /*
     * La congelación exceptúa el DELETE en `miembro` a propósito, y el motivo está escrito en
     * la migración: un workspace archivado durante años no puede quedarse sin forma de quitarle
     * la entrada a quien se fue de la organización cliente. Congelar la salida convertiría el
     * archivo en un permiso perpetuo.
     *
     * Pero la excepción sola no basta, y este caso es el que lo comprueba: si ese miembro es
     * PROPIETARIO de una entrada de KPI, la clave foránea compuesta lo retiene, y
     * `entrada_kpi` sí está congelada para UPDATE, así que tampoco se puede soltar la
     * referencia antes. Sin las dos mitades, la baja es imposible y el acceso queda.
     */
    const admin = sqlAdmin();
    const ws = await nuevoWorkspace('permiso-perpetuo');
    const [m] = await admin`select id from miembro
      where workspace_id = ${ws} and usuario_id = ${adminId}`;
    const [srv] = await admin`select id from servicio where workspace_id = ${ws}`;
    const [reto] = await admin`insert into reto
      (workspace_id, servicio_ancla_id, codigo, titulo, creado_por)
      values (${ws}, ${srv!.id}, 'R-99', 'Reto', ${leadId}) returning id`;
    const [cri] = await admin`insert into criterio_exito
      (workspace_id, reto_id, kpi, ventana_dias, creado_por)
      values (${ws}, ${reto!.id}, 'KPI', 30, ${leadId}) returning id`;
    const [reg] = await admin`insert into metric_registry (workspace_id, reto_id, estado, creado_por)
      values (${ws}, ${reto!.id}, 'borrador', ${leadId}) returning id`;
    const [mLead] = await admin`select id from miembro
      where workspace_id = ${ws} and usuario_id = ${leadId}`;
    for (const [nom, dueno] of [
      ['KPI del que se va', m!.id],
      ['KPI del que se queda', mLead!.id],
    ] as const) {
      await admin`insert into entrada_kpi (workspace_id, registry_id, criterio_id, nombre,
          definicion, fuente, dimensiones, propietario_miembro_id, frecuencia, dashboard_url,
          creado_por)
        values (${ws}, ${reg!.id}, ${cri!.id}, ${nom}, 'def', 'fuente', 'dim', ${dueno},
          'mensual', 'https://x', ${leadId})`;
    }

    await acordarYExportar(ws, 'archivo', leadId);
    await ejecutarDisposicion(leadId, {
      workspaceId: ws,
      modalidadEsperada: 'archivo',
      acuerdoVersionEsperada: 1,
      confirmacion: '',
    });

    // La baja tiene que poder. Es la afirmación entera de la excepción declarada.
    await admin`delete from miembro where id = ${m!.id}`;
    const [quedan] = await admin`select count(*)::int as n from miembro where id = ${m!.id}`;
    expect(quedan!.n).toBe(0);
    // Y la entrada de KPI sigue ahí, sin dueño: el archivo se conserva, el acceso no.
    const [ek] = await admin`select propietario_miembro_id, workspace_id from entrada_kpi
      where workspace_id = ${ws} and nombre = 'KPI del que se va'`;
    expect(ek!.propietario_miembro_id).toBeNull();
    // El `set null` va con LISTA DE COLUMNAS: sin ella nula también `workspace_id` —medido— y
    // la fila se saldría del workspace cuyo archivo la conserva.
    expect(ek!.workspace_id).toBe(ws);

    /*
     * Y la CLASE, no el caso: hoy `entrada_kpi` es la única tabla que apunta a `miembro`, pero
     * la excepción de la baja se rompe con que alguien añada mañana otra clave foránea que
     * retenga. Se exige que NINGUNA bloquee el borrado —`a` es NO ACTION y `r` es RESTRICT—,
     * así que la próxima nace con su acción referencial decidida o sale por aquí.
     */
    /*
     * Y la excepción está ATADA a la baja, no a la FORMA del update. La SEGUNDA entrada sigue
     * teniendo dueño —el lead, que no se ha ido— y ponerla a NULL es escribir en contenido
     * archivado: la congelación tiene que negarlo. Sin esta mitad, cualquiera con permiso de
     * edición podía tocar un workspace archivado mientras el update tuviera esa pinta.
     *
     * Va con el dueño VIVO a propósito, y no reaprovechando la primera entrada: después de la
     * baja aquélla ya está a NULL, así que el caso no se podría montar y la comprobación se
     * saltaría en silencio. Me pasó al escribirla.
     */
    await expect(
      admin`update entrada_kpi set propietario_miembro_id = null
        where workspace_id = ${ws} and propietario_miembro_id is not null`,
    ).rejects.toMatchObject({ code: 'DS001' });
    const [conDueno] = await admin`select count(*)::int as n from entrada_kpi
      where workspace_id = ${ws} and propietario_miembro_id is not null`;
    expect(conDueno!.n).toBe(1);

    const retienen = await admin`
      select c.conrelid::regclass::text as tabla, pg_get_constraintdef(c.oid) as fk
      from pg_constraint c
      where c.contype = 'f' and c.confrelid = 'miembro'::regclass
        and c.confdeltype in ('a', 'r')
      order by 1`;
    expect(retienen.map((f) => f.tabla as string)).toEqual([]);
  });

  it('un archivo no destruye nada, y aun así congela: la modalidad no es una etiqueta', async () => {
    const admin = sqlAdmin();
    const ws = await nuevoWorkspace('archivo');
    await acordarYExportar(ws, 'archivo', leadId);

    // El archivo NO exige doble firma: es reversible y no destruye nada, así que pedir dos
    // partes sería trámite sin riesgo detrás. Lo ejecuta quien lo acordó.
    const constancia = await ejecutarDisposicion(leadId, {
      workspaceId: ws,
      modalidadEsperada: 'archivo',
      acuerdoVersionEsperada: 1,
      confirmacion: '',
    });
    expect(constancia.modalidad).toBe('archivo');
    expect(selloRecomputado(constancia)).toBe(constancia.sello);

    // Nada destruido, y el recibo cuenta lo CONSERVADO —comparable tabla a tabla con el
    // manifiesto de la exportación, que es lo que hace comprobable a RF-09.4.
    const [seg] = await admin`select count(*)::int as n from segmento where workspace_id = ${ws}`;
    expect(seg!.n).toBe(1);
    expect(constancia.conteos.segmento).toBe(1);
    const [w] = await admin`select nombre from workspace where id = ${ws}`;
    expect(w!.nombre).toContain(marca);

    // Y congela: si `archivo` no impidiera nada, el acuerdo dejaría de ser dato.
    await expect(
      admin`insert into segmento (workspace_id, nombre, definicion)
        values (${ws}, 'nuevo', 'no debería entrar')`,
    ).rejects.toMatchObject({ code: 'DS001' });
  });

  it('el mismo acuerdo no se ejecuta dos veces, y la pantalla lo dice antes de ofrecerlo', async () => {
    const ws = await nuevoWorkspace('doble');
    await acordarYExportar(ws, 'archivo', leadId);
    await ejecutarDisposicion(leadId, { workspaceId: ws, modalidadEsperada: 'archivo', acuerdoVersionEsperada: 1, confirmacion: '' });

    // El motivo lo da la MISMA función que usa el guard: la pantalla no puede ofrecer algo
    // que la base va a rechazar, ni esconder algo que sí correspondía.
    const panel = await panelDisposicion(leadId, ws);
    expect(panel.motivoNoEjecutable).toMatch(/ya se ejecutó/i);
    expect(panel.constanciaVigente).not.toBeNull();
    await expect(
      ejecutarDisposicion(leadId, { workspaceId: ws, modalidadEsperada: 'archivo', acuerdoVersionEsperada: 1, confirmacion: '' }),
    ).rejects.toThrow(ErrorDisposicion);
  });

  it('un borrado exige las DOS partes: quien lo acordó no lo ejecuta', async () => {
    // «Acordado» con una sola voluntad no es un acuerdo, y es la clase de afirmación sin atar
    // que el resto del esquema no acepta. Roles distintos implica personas distintas.
    const ws = await nuevoWorkspace('una-firma');
    await acordarYExportar(ws, 'borrado', adminId);

    const panel = await panelDisposicion(adminId, ws);
    expect(panel.motivoNoEjecutable).toMatch(/las dos partes/i);
    await expect(
      ejecutarDisposicion(adminId, { workspaceId: ws, modalidadEsperada: 'borrado', acuerdoVersionEsperada: 1, confirmacion: 'BORRAR' }),
    ).rejects.toThrow(/las dos partes/i);

    // Y para la otra parte sí está disponible.
    expect((await panelDisposicion(leadId, ws)).motivoNoEjecutable).toBeNull();
  });

  it('sin exportación previa no hay disposición, y una anterior al acuerdo no vale', async () => {
    const ws = await nuevoWorkspace('sin-export');
    await registrarAcuerdo(adminId, {
      workspaceId: ws,
      modalidad: 'borrado',
      base: 'Acta de cierre',
      efectivoDesde: EFECTIVO_PASADO,
    });
    expect((await panelDisposicion(leadId, ws)).motivoNoEjecutable).toMatch(/exportación previa/i);

    // Exportar DESPUÉS del acuerdo sí desbloquea: un archivo entregado antes de pactar la
    // disposición no refleja lo que se acordó disponer.
    await exportarWorkspace(leadId, { workspaceId: ws, ambito: 'archivo' });
    expect((await panelDisposicion(leadId, ws)).motivoNoEjecutable).toBeNull();
  });

  it('la retención acordada se respeta: antes de la fecha no se ejecuta', async () => {
    const ws = await nuevoWorkspace('retencion');
    const manana = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    await registrarAcuerdo(adminId, {
      workspaceId: ws,
      modalidad: 'borrado',
      base: 'Retención de 30 días',
      efectivoDesde: manana,
    });
    await exportarWorkspace(leadId, { workspaceId: ws, ambito: 'archivo' });
    expect((await panelDisposicion(leadId, ws)).motivoNoEjecutable).toMatch(/retención/i);
  });

  it('la modalidad que se ejecuta es la que se vio: un acuerdo nuevo por medio la detiene', async () => {
    // Un borrado irreversible no se dispara desde una pantalla que decía «archivo». La
    // comprobación va bajo el MISMO candado que toma la ejecución, así que no hay hueco entre
    // mirar y ejecutar.
    const ws = await nuevoWorkspace('cambiada');
    await acordarYExportar(ws, 'archivo', leadId);
    // Alguien registra otro acuerdo mientras la pantalla seguía mostrando el anterior.
    await registrarAcuerdo(adminId, {
      workspaceId: ws,
      modalidad: 'borrado',
      base: 'Rectificación: se acuerda borrar',
      efectivoDesde: EFECTIVO_PASADO,
    });
    // Y se vuelve a exportar, que es lo que deja a la BASE conforme con el acuerdo nuevo. Sin
    // este paso el caso se detendría igual pero por otro motivo —«la exportación es anterior
    // al acuerdo vigente»— y no probaría nada de esta comprobación: pasaría en verde con ella
    // retirada. Aquí lo único que separa a este workspace de ser destruido es que la modalidad
    // que se vio no es la que se ejecutaría.
    await exportarWorkspace(leadId, { workspaceId: ws, ambito: 'archivo' });
    expect((await panelDisposicion(leadId, ws)).motivoNoEjecutable).toBeNull();

    await expect(
      ejecutarDisposicion(leadId, { workspaceId: ws, modalidadEsperada: 'archivo', acuerdoVersionEsperada: 1, confirmacion: '' }),
    ).rejects.toThrow(/mientras mirabas/i);
    // Y el workspace sigue entero: no se ejecutó ninguna de las dos.
    const [seg] = await sqlAdmin()`select count(*)::int as n from segmento
      where workspace_id = ${ws}`;
    expect(seg!.n).toBe(1);
    // Confirmándolo: con el acuerdo correcto —modalidad Y versión— sí se ejecuta, y destruye.
    await ejecutarDisposicion(leadId, {
      workspaceId: ws,
      modalidadEsperada: 'borrado',
      acuerdoVersionEsperada: 2,
      confirmacion: 'BORRAR',
    });
    const [tras] = await sqlAdmin()`select count(*)::int as n from segmento
      where workspace_id = ${ws}`;
    expect(tras!.n).toBe(0);
  });
  it('lo que se destruye es lo que se entregó: una escritura posterior al archivo detiene la disposición', async () => {
    // La exportación previa es la condición de RF-01.9, y hasta ahora se comprobaba que
    // EXISTIERA y que hubiera VISTO el acuerdo. Faltaba la mitad que la vuelve una garantía:
    // que siga siendo CIERTA cuando se ejecuta. Entre exportar y disponer el workspace no
    // está congelado —la congelación arranca con la constancia, y la constancia nace al
    // ejecutar—, así que se sigue trabajando en él con toda normalidad; y lo escrito en esa
    // ventana no viajó en el archivo y un borrado se lo lleva por delante.
    const admin = sqlAdmin();
    const ws = await nuevoWorkspace('deriva');

    // Una exportación ANTERIOR a cualquier acuerdo no anota inventario, y no es un descuido:
    // no puede sostener ninguna disposición —la comprobación exige que el archivo haya VISTO
    // el acuerdo que se ejecuta, y un nulo no es igual a ninguna versión—, así que leer el
    // workspace entero para ella sería pagar por una prueba que no se puede usar.
    await exportarWorkspace(leadId, { workspaceId: ws, ambito: 'archivo' });
    const ultimoRegistro = async () =>
      (
        await admin`select inventario from exportacion_registro
          where workspace_id = ${ws} order by completado_en desc limit 1`
      )[0]!.inventario;
    expect(await ultimoRegistro()).toBeNull();

    await acordarYExportar(ws, 'borrado', adminId);
    expect(await ultimoRegistro()).not.toBeNull();

    /*
     * Y el inventario viaja EXACTO dentro del propio archivo, que es lo que permite cotejar la
     * prueba sin la base. La huella es una suma de hashes de 64 bits y no cabe en el entero
     * seguro de JavaScript: como número, `JSON.parse` la redondearía al desempaquetar el
     * volcado y el archivo diría llevar un inventario que no es el que quedó registrado. Por
     * eso viaja como texto, y por eso se comprueba contra el `->>` de Postgres, que no pasa
     * por ningún número.
     */
    const paquete = await exportarWorkspace(leadId, { workspaceId: ws, ambito: 'archivo' });
    const enArchivo = paquete.datos.exportacion_registro!.map((f) => f.inventario).filter(
      (i): i is Record<string, { n: number; h: string }> => i !== null,
    );
    expect(enArchivo.length).toBeGreaterThan(0);
    for (const inv of enArchivo) {
      // Un texto no se puede haber redondeado. La igualdad de abajo compara además contra el
      // texto que devuelve Postgres, sin número por medio en ninguno de los dos lados.
      for (const valor of Object.values(inv)) expect(typeof valor.h).toBe('string');
    }
    const huellas = await admin`select e.k as tabla, e.v ->> 'h' as h
      from exportacion_registro xp, lateral jsonb_each(xp.inventario) e(k, v)
      where xp.workspace_id = ${ws} and xp.inventario is not null`;
    expect(huellas.length).toBeGreaterThan(0);
    for (const f of huellas) {
      const cual = enArchivo.find((i) => (f.tabla as string) in i)!;
      expect(cual[f.tabla as string]!.h).toBe(f.h as string);
    }

    const ejecutar = () =>
      ejecutarDisposicion(leadId, {
        workspaceId: ws,
        modalidadEsperada: 'borrado',
        acuerdoVersionEsperada: 1,
        confirmacion: 'BORRAR',
      });

    // ── Primero lo que un CONTEO no ve ──
    // Se edita una fila que sí viajó en el archivo. Hay las mismas filas que había, así que un
    // inventario que solo contase daría el visto bueno — y el archivo se habría quedado con la
    // versión anterior, que es una pérdida tan real como la fila que falta.
    await admin`update segmento set definicion = 'reescrita después del archivo'
      where workspace_id = ${ws}`;
    await expect(ejecutar()).rejects.toThrow(
      /cambió desde la exportación.*«segmento»: las mismas filas, con el contenido cambiado/is,
    );

    // ── Y después lo que sí ve ──
    await admin`insert into segmento (workspace_id, nombre, definicion)
      values (${ws}, 'nacido despues del archivo', 'no viajó en la exportación')`;
    await expect(ejecutar()).rejects.toThrow(
      /«segmento»: 1 filas al exportar, 2 ahora/i,
    );

    // Y no se destruyó nada: la disposición se aborta entera, no a medias.
    const [seg] = await admin`select count(*)::int as n from segmento where workspace_id = ${ws}`;
    expect(seg!.n).toBe(2);

    // El remedio es el mismo que ya tenían los otros dos motivos: volver a exportar. Y
    // entonces sí se ejecuta — que es lo que separa una comprobación de un cerrojo.
    await exportarWorkspace(leadId, { workspaceId: ws, ambito: 'archivo' });
    const constancia = await ejecutar();
    expect(constancia.modalidad).toBe('borrado');
    const [tras] = await admin`select count(*)::int as n from segmento where workspace_id = ${ws}`;
    expect(tras!.n).toBe(0);
  });

  it('el inventario que ata el archivo a la base no lo mueve la sesión que lo lee', async () => {
    // La comparación del inventario solo vale si las dos lecturas —la de exportar y la de
    // ejecutar— hablan el mismo idioma. La huella se calcula sobre `fila::text`, y ese texto lo
    // mueve la SESIÓN: un `timestamptz` cambia con `TimeZone`, una `date` con `DateStyle`, un
    // `bytea` con `bytea_output`. Sin fijarlos, exportar desde una sesión y ejecutar desde otra
    // darían huellas distintas sobre datos idénticos y la disposición se bloquearía sola: una
    // garantía que se cae cuando cambia la configuración del cliente no es una garantía.
    const admin = sqlAdmin();
    const ws = await nuevoWorkspace('rendicion');
    // Que haya algo de cada tipo sensible: sin filas con fecha, el caso pasaría en verde con la
    // fijación retirada y no probaría nada.
    const [item] = await admin`insert into item_importacion
      (workspace_id, titulo, contenido, tipo_fuente, creado_por)
      values (${ws}, 'nota', 'texto', 'nota', ${leadId}) returning id`;
    await admin`insert into archivo_importado
      (workspace_id, item_id, nombre, tipo_mime, contenido, creado_por)
      values (${ws}, ${item!.id}, 'x.txt', 'text/plain', ${Buffer.from('hola')}, ${leadId})`;
    const leerCon = (guc: Record<string, string>) =>
      admin.begin(async (tx) => {
        for (const [k, v] of Object.entries(guc)) {
          await tx.unsafe(`set local ${k} = '${v}'`);
        }
        const [f] = await tx`select inventario_del_workspace(${ws})::text as i`;
        return f!.i as string;
      });

    const utc = await leerCon({ timezone: 'UTC', datestyle: 'ISO, YMD', bytea_output: 'hex' });
    const tokio = await leerCon({
      timezone: 'Asia/Tokyo',
      datestyle: 'SQL, DMY',
      bytea_output: 'escape',
    });
    // Y que el inventario NO esté vacío, o la igualdad de arriba sería la de dos nadas.
    expect(JSON.parse(utc)).toHaveProperty('archivo_importado');
    expect(tokio).toBe(utc);
  });

  it('el acuerdo es append-only: la versión y el rol los pone la base, no quien escribe', async () => {
    const ws = await nuevoWorkspace('bitacora');
    const uno = await registrarAcuerdo(adminId, {
      workspaceId: ws,
      modalidad: 'archivo',
      base: 'Primer acuerdo',
      efectivoDesde: EFECTIVO_PASADO,
    });
    expect(uno.version).toBe(1);
    expect(uno.acordadoRol).toBe('admin-cliente');

    const dos = await registrarAcuerdo(leadId, {
      workspaceId: ws,
      modalidad: 'borrado',
      base: 'Se rectifica: borrado',
      efectivoDesde: EFECTIVO_PASADO,
    });
    expect(dos.version).toBe(2);
    expect(dos.acordadoRol).toBe('lead-boutique');
    // Manda el vigente, y cambiar de opinión dejó las dos filas en pie.
    expect((await panelDisposicion(leadId, ws)).acuerdoVigente?.modalidad).toBe('borrado');
    const [n] = await sqlAdmin()`select count(*)::int as n from acuerdo_disposicion
      where workspace_id = ${ws}`;
    expect(n!.n).toBe(2);

    // Ni la versión ni el rol están en el grant: con ellos dentro, un acuerdo podría nacer con
    // versión alta y volverse «vigente» sin serlo — la reescritura por la puerta de atrás.
    await expect(
      conUsuario(adminId, (tx) => tx`insert into acuerdo_disposicion
        (workspace_id, modalidad, base, efectivo_desde, acordado_por, version)
        values (${ws}, 'archivo', 'colado', current_date, ${adminId}, 99)`),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('dos partes registrando a la vez no chocan: la bitácora se serializa, no revienta', async () => {
    // La versión la asigna el guard como `max(version) + 1`, y hay `unique (workspace_id,
    // version)` debajo. Bajo READ COMMITTED dos registros concurrentes leen el mismo máximo,
    // calculan la misma posición y uno se estrella contra el único — con un 23505 que no dice
    // nada útil a quien lo recibe.
    //
    // El índice único es el SUELO, no el mecanismo: la migración lo dice al declararlo («el
    // servicio las serializa con el candado del workspace; esto es lo que pasa si alguien
    // llega por otro camino»). Serializar es trabajo de esta capa, y aquí se comprueba que lo
    // hace: dos acuerdos a la vez salen los dos, con posiciones distintas y en orden.
    //
    // Van CINCO a la vez y no dos: con dos, la colisión depende de cómo se solapen las dos
    // transacciones y el caso pasa en verde la mayoría de las veces —medido: falla una de cada
    // tres—. Un test que solo delata el fallo a veces no es un test, es un aviso ocasional.
    const ws = await nuevoWorkspace('concurrentes');
    const hoy = EFECTIVO_PASADO;
    const partes = [adminId, leadId, adminId, leadId, adminId];
    const acuerdos = await Promise.all(
      partes.map((quien, i) =>
        registrarAcuerdo(quien, {
          workspaceId: ws,
          modalidad: i % 2 === 0 ? 'archivo' : 'borrado',
          base: `Acuerdo simultáneo ${i}`,
          efectivoDesde: hoy,
        }),
      ),
    );
    // Los cinco salen, con posiciones distintas y consecutivas: la bitácora no pierde ninguno
    // ni deja huecos, que es lo que la hace legible como historia.
    expect(acuerdos.map((a) => a.version).sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5]);
    const [n] = await sqlAdmin()`select count(*)::int as n from acuerdo_disposicion
      where workspace_id = ${ws}`;
    expect(n!.n).toBe(5);
  });

  it('de un workspace congelado no se puede SACAR una fila moviéndola a otro', async () => {
    // La congelación mira el workspace de la fila, y en un UPDATE hay DOS: de dónde sale y a
    // dónde va. Mirando solo el destino, un miembro de los dos podía mover una fila desde un
    // workspace archivado a uno vivo — el guard comprobaba el activo, lo daba por bueno, y la
    // promesa «se conserva para consulta y no admite escrituras» se rompía por extracción en
    // vez de por escritura. `segmento` es la superficie exacta: su grant de UPDATE incluye
    // `workspace_id` y su política es solo de membresía.
    const admin = sqlAdmin();
    const congelado = await nuevoWorkspace('origen-congelado');
    const vivo = await nuevoWorkspace('destino-vivo');
    const [seg] = await admin`select id from segmento where workspace_id = ${congelado}`;

    await acordarYExportar(congelado, 'archivo', leadId);
    await ejecutarDisposicion(leadId, { workspaceId: congelado, modalidadEsperada: 'archivo', acuerdoVersionEsperada: 1, confirmacion: '' });

    // Quien lo intenta es miembro de los dos, así que la RLS no lo detiene: lo único que puede
    // detenerlo es el guard, mirando también de dónde SALE la fila.
    await expect(
      conUsuario(leadId, (tx) => tx`update segmento set workspace_id = ${vivo}
        where id = ${seg!.id as string}`),
    ).rejects.toMatchObject({ code: 'DS001' });

    // Y sigue donde estaba.
    const [donde] = await admin`select workspace_id from segmento where id = ${seg!.id as string}`;
    expect(donde!.workspace_id).toBe(congelado);
  });

  it('tras el borrado, la constancia le queda a LAS DOS partes que firmaron', async () => {
    // La doble firma reparte los papeles: en un borrado, una parte registra y la OTRA ejecuta.
    // Y el caso más común es el que peor salía — el cliente pacta el borrado, la boutique lo
    // ejecuta— porque la respuesta inmediata con el documento llega a quien ejecuta, y en
    // cuanto el borrado destruye las membresías el firmante se queda sin nada. Justamente la
    // parte que más necesita el recibo.
    const ws = await nuevoWorkspace('dos-partes');
    await acordarYExportar(ws, 'borrado', adminId);
    const entregada = await ejecutarDisposicion(leadId, {
      workspaceId: ws,
      modalidadEsperada: 'borrado',
      acuerdoVersionEsperada: 1,
      confirmacion: 'BORRAR',
    });

    // Ya no queda membresía para nadie: es la situación real después de un borrado.
    const [m] = await sqlAdmin()`select count(*)::int as n from miembro where workspace_id = ${ws}`;
    expect(m!.n).toBe(0);

    // Quien ejecutó la sigue viendo…
    expect((await panelDisposicion(leadId, ws)).constanciaVigente?.sello).toBe(entregada.sello);
    // …y quien la FIRMÓ también, con el mismo sello y el mismo acuerdo detrás.
    const delFirmante = await panelDisposicion(adminId, ws);
    expect(delFirmante.constanciaVigente?.sello).toBe(entregada.sello);
    expect(delFirmante.acuerdoVigente?.modalidad).toBe('borrado');

    // Y a nadie más: firmar una disposición no abre una ventana a workspaces ajenos.
    const admin = sqlAdmin();
    const [ajeno] = await admin`insert into usuario (email, nombre, estado)
      values (${`${marca}-ajeno@test.demo`}, 'ajeno', 'activo') returning id`;
    const filas = await conUsuario(ajeno!.id as string, (tx) => tx`select 1 as x
      from constancia_disposicion where workspace_id = ${ws}`);
    expect(filas.length).toBe(0);
  });

  it('registrar un acuerdo espera si hay una disposición ejecutándose', async () => {
    // El caso destructivo del mismo candado, y el que no cubre el de los cinco registros a la
    // vez: si la ejecución ya leyó «archivo» y comprobó la modalidad esperada, un `borrado`
    // que commitea entre esa lectura y la del guard haría que `ejecutar_disposicion` releyera
    // el acuerdo NUEVO —cada sentencia abre instantánea propia bajo READ COMMITTED— y borrara
    // el workspace pese a que lo comprobado fue un archivo. Con el registro tomando el mismo
    // candado exclusivo, no puede colarse ahí: espera a que la ejecución termine.
    const ws = await nuevoWorkspace('registro-espera');
    await acordarYExportar(ws, 'archivo', leadId);

    // Una ejecución EN VUELO: tiene el candado tomado y no ha commiteado.
    const enCurso = await enVuelo(async (tx) => {
      await tx`select set_config('app.user_id', ${leadId}, true)`;
      await tx`select pg_advisory_xact_lock(
        hashtextextended('designio:workspace:' || ${ws}::text, 42))`;
    });
    try {
      // Por SQL DIRECTO y no por el servicio: el grant de insert permite rodear la capa, así
      // que si el candado viviera solo allí este camino se colaría igual. Lo toma el guard,
      // que es por donde pasa todo insert.
      const registro = conUsuario(adminId, (tx) => tx`insert into acuerdo_disposicion
        (workspace_id, modalidad, base, efectivo_desde, acordado_por)
        values (${ws}, 'borrado', 'Intento de colarse a media ejecución', current_date,
                ${adminId})
        returning version`);
      expect(await sigueEsperando(registro)).toBe(true);
      await enCurso.cerrar();
      // Y cuando la de delante suelta, entra: esperar no es fallar.
      expect(Number((await registro)[0]!.version)).toBe(2);
    } finally {
      await enCurso.cerrar().catch(() => {});
    }
  });

  it('un evento de exportación escrito a mano NO desbloquea la disposición', async () => {
    // La exportación previa que RF-01.9 exige tiene que ser una PRUEBA, no una afirmación. Con
    // la condición apoyada en `evento_dominio`, cualquier miembro podía escribírsela: la app
    // tiene grant de INSERT sobre `tipo` y `payload` y la política solo pide membresía. Con eso
    // se simulaba una entrega que nunca ocurrió y se desbloqueaba el archivo — y, con la
    // segunda firma, el borrado irreversible. El esquema ya declaraba falsificable ese dato en
    // otra migración; aquí se deja de aceptar como prueba.
    const ws = await nuevoWorkspace('exportacion-falsa');
    await registrarAcuerdo(adminId, {
      workspaceId: ws,
      modalidad: 'borrado',
      base: 'Acuerdo con exportación simulada',
      efectivoDesde: EFECTIVO_PASADO,
    });

    // El evento, escrito por el ROL DE APLICACIÓN: exactamente lo que un miembro puede hacer.
    await conUsuario(leadId, (tx) => tx`insert into evento_dominio
      (workspace_id, tipo, payload, actor_id, actor_rol)
      values (${ws}, 'WorkspaceExportado', ${tx.json({ ambito: 'archivo' })}::jsonb,
              ${leadId}, 'lead-boutique')`);

    // Sigue bloqueada, y lo dice por el motivo correcto.
    expect((await panelDisposicion(leadId, ws)).motivoNoEjecutable).toMatch(/exportación previa/i);
    await expect(
      ejecutarDisposicion(leadId, { workspaceId: ws, modalidadEsperada: 'borrado', acuerdoVersionEsperada: 1, confirmacion: 'BORRAR' }),
    ).rejects.toThrow(/exportación previa/i);

    // Y la aplicación tampoco puede escribir el registro que sí cuenta.
    await expect(
      conUsuario(leadId, (tx) => tx`insert into exportacion_registro
        (workspace_id, ambito, ejecutado_por, ejecutado_rol)
        values (${ws}, 'archivo', ${leadId}, 'lead-boutique')`),
    ).rejects.toMatchObject({ code: '42501' });

    // ── Y tampoco combinando el evento a mano con la confirmación ──
    // Esta era la vuelta que quedaba abierta. `confirmar_exportacion` comprobaba que ESTA
    // transacción hubiera pasado por `registrar_exportacion`… mirando el `evento_dominio` que
    // aquélla escribe, o sea el dato que esta misma migración declara falsificable. Con el
    // evento escrito a mano y la confirmación llamada a continuación, el `xmin` casaba y nacía
    // el registro que desbloquea la disposición sin haber exportado nada: el agujero que la
    // tabla venía a cerrar, una vuelta más abajo. Ahora la fila la escribe la función que
    // AUTORIZA y la confirmación solo la completa.
    await expect(
      conUsuario(leadId, async (tx) => {
        await tx`insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
          values (${ws}, 'WorkspaceExportado', ${tx.json({ ambito: 'archivo' })}::jsonb,
                  ${leadId}, 'lead-boutique')`;
        await tx`select confirmar_exportacion(${ws}, 'archivo')`;
      }),
    ).rejects.toMatchObject({ code: 'DS004' });
    expect((await panelDisposicion(leadId, ws)).motivoNoEjecutable).toMatch(/exportación previa/i);

    // ── Ni una exportación autorizada y ABANDONADA ──
    // La fila nace incompleta a propósito: lo que RF-01.9 pide es que la entrega haya
    // terminado antes, no que se autorizara. Llamada suelta a la función que autoriza, sin la
    // que cierra: queda la fila sin completar y la disposición sigue bloqueada.
    await conUsuario(leadId, (tx) => tx`select registrar_exportacion(${ws}, 'archivo')`);
    const [pendiente] = await sqlAdmin()`select count(*)::int as n from exportacion_registro
      where workspace_id = ${ws} and completado_en is null`;
    expect(pendiente!.n).toBe(1);
    expect((await panelDisposicion(leadId, ws)).motivoNoEjecutable).toMatch(/exportación previa/i);

    // Exportando de verdad —por la función que autoriza y sella— sí se desbloquea.
    await exportarWorkspace(leadId, { workspaceId: ws, ambito: 'archivo' });
    expect((await panelDisposicion(leadId, ws)).motivoNoEjecutable).toBeNull();
    // Y lo que la desbloquea es una fila COMPLETA, no la que quedó a medias.
    const [completas] = await sqlAdmin()`select count(*)::int as n from exportacion_registro
      where workspace_id = ${ws} and completado_en is not null`;
    expect(completas!.n).toBe(1);
  });

  it('la lápida no conserva el cupo pactado: es condición del contrato que se borró', async () => {
    // `workspace` dejó de ser `(id, nombre, creado_en)` cuando nació el cupo de llamadas AI, y
    // la exportación lo trata como dato propio del workspace. Si la lápida lo conservara,
    // sobreviviría al borrado una condición pactada con una organización cuyos datos se acaban
    // de destruir — y no figura entre las ausencias que la constancia declara.
    const admin = sqlAdmin();
    const ws = await nuevoWorkspace('lapida-cupo');
    await admin`update workspace set limite_llamadas_ai_dia = 40 where id = ${ws}`;
    await acordarYExportar(ws, 'borrado', adminId);
    await ejecutarDisposicion(leadId, { workspaceId: ws, modalidadEsperada: 'borrado', acuerdoVersionEsperada: 1, confirmacion: 'BORRAR' });

    const [w] = await admin`select nombre, limite_llamadas_ai_dia from workspace
      where id = ${ws}`;
    expect(w!.nombre).toBe('Workspace borrado por acuerdo');
    expect(w!.limite_llamadas_ai_dia).toBeNull();
  });

  it('la RLS de la constancia no se apoya en NINGUNA función que salte la RLS', async () => {
    // Hubo una: `firmo_esta_disposicion`, SECURITY DEFINER, que existía solo para cortar la
    // recursión entre las dos políticas —la del acuerdo mira la constancia, y la de la
    // constancia miraba el acuerdo—. Copiar el firmante DENTRO de la constancia disolvió el
    // ciclo por su causa, así que la función sobra; y una función que salta la RLS que sobra
    // se borra, no se conserva por si acaso. Esto comprueba que no vuelve.
    const admin = sqlAdmin();
    const [f] = await admin`select count(*)::int as n from pg_proc
      where proname = 'firmo_esta_disposicion'`;
    expect(f!.n).toBe(0);


    // Y el ayudante que la sustituyó no repite su forma. `cuenta_activa` nació tomando el
    // usuario como parámetro y con grant para el rol de aplicación: el mismo oráculo con otro
    // nombre —siendo SECURITY DEFINER salta la RLS de `usuario`, así que con el sujeto en la
    // firma se preguntaba por uuids ajenos—. Sin parámetro y sin grant, lo único preguntable
    // es sobre uno mismo, y ni eso desde fuera.
    const [ca] = await admin`select pg_get_function_arguments(oid) as args,
        has_function_privilege('designio_app', oid, 'execute') as la_puede_llamar
      from pg_proc where proname = 'cuenta_activa'`;
    expect(ca!.args).toBe('');
    expect(ca!.la_puede_llamar).toBe(false);

    // Y, más al fondo: la política de la constancia no invoca NINGUNA función SECURITY
    // DEFINER que no sea la que ya sostiene el resto de la casa. Derivado del catálogo, no
    // de una lista escrita aquí: si mañana alguien mete un ayudante nuevo en el predicado,
    // este test lo nombra en vez de dejarlo pasar.
    const [pol] = await admin`select pg_get_expr(polqual, polrelid) as expr from pg_policy
      where polname = 'constancia_select'`;
    const expr = pol!.expr as string;
    const definers = await admin`select proname from pg_proc
      where prosecdef and pronamespace = 'public'::regnamespace`;
    const invocadas = definers
      .map((d) => d.proname as string)
      .filter((n) => new RegExp(`\\b${n}\\b`).test(expr));
    expect(invocadas).toEqual(['is_workspace_member']);
  });

  it('un archivo SÍ se revierte registrando un acuerdo nuevo, que es lo que la modalidad promete', async () => {
    /*
     * `disposicion_vigente` devolvía la ÚLTIMA constancia sin mirar si su acuerdo seguía
     * siendo el vigente, así que tras archivar, registrar otro acuerdo dejaba la constancia
     * vieja gobernando: los guards seguían rechazando toda escritura con DS001 —y con un
     * mensaje que mandaba a registrar un acuerdo nuevo, que es exactamente lo que la persona
     * acababa de hacer—. Ejecutar el acuerdo nuevo solo añadía otra constancia congelada: la
     * única salida real era borrar. La promesa de la primera página de la migración —que un
     * archivo es reversible— no se cumplía.
     */
    const admin = sqlAdmin();
    const ws = await nuevoWorkspace('archivo-reversible');
    await acordarYExportar(ws, 'archivo', leadId);
    await ejecutarDisposicion(leadId, {
      workspaceId: ws,
      modalidadEsperada: 'archivo',
      acuerdoVersionEsperada: 1,
      confirmacion: '',
    });

    // Congelado: la escritura se rechaza y el mensaje dice qué hacer.
    await expect(
      conUsuario(leadId, (tx) => tx`insert into segmento (workspace_id, nombre, definicion)
        values (${ws}, 'nuevo', 'x')`),
    ).rejects.toMatchObject({ code: 'DS001' });

    // Mientras rige, el panel la enseña.
    const antes = await panelDisposicion(leadId, ws);
    expect(antes.constanciaVigente?.acuerdoVersion).toBe(1);

    // Se hace exactamente lo que el mensaje indica.
    await registrarAcuerdo(leadId, {
      workspaceId: ws,
      modalidad: 'archivo',
      base: 'Acuerdo 2: se reanuda el trabajo',
      efectivoDesde: EFECTIVO_PASADO,
    });

    // Y el panel deja de enseñarla, porque ya no rige. Aquí había un `order by
    // acuerdo_version desc limit 1` escrito a mano —la definición VIEJA de «vigente»— que
    // seguía devolviendo la constancia del #1 junto al acuerdo #2 que acababa de
    // descongelarlo: la pantalla decía «archivado» sobre un workspace que ya no lo estaba.
    const despues = await panelDisposicion(leadId, ws);
    expect(despues.constanciaVigente).toBeNull();
    expect(despues.acuerdoVigente?.version).toBe(2);

    // Y el workspace vuelve a admitir escrituras: eso es «reversible».
    await conUsuario(leadId, (tx) => tx`insert into segmento (workspace_id, nombre, definicion)
      values (${ws}, ${marca + ' descongelado'}, 'x')`);
    const [seg] = await admin`select count(*)::int as n from segmento where workspace_id = ${ws}`;
    expect(seg!.n).toBe(2);
  });

  it('un BORRADO no se revierte registrando papel encima', async () => {
    // El otro lado de la misma moneda, y por eso la pregunta se parte en dos: atar la
    // congelación al acuerdo vigente a secas dejaría levantar la de un borrado registrando un
    // acuerdo nuevo, y entonces se podría repoblar un workspace cuya constancia certifica que
    // quedó vacío — el recibo pasaría a mentir.
    const admin = sqlAdmin();
    const ws = await nuevoWorkspace('borrado-irreversible');
    await acordarYExportar(ws, 'borrado', adminId);
    await ejecutarDisposicion(leadId, {
      workspaceId: ws,
      modalidadEsperada: 'borrado',
      acuerdoVersionEsperada: 1,
      confirmacion: 'BORRAR',
    });

    // La membresía se destruyó con todo lo demás, así que el acuerdo nuevo solo se puede
    // colar por la puerta de admin. Se cuela: la tabla del acuerdo no está congelada.
    await admin`insert into acuerdo_disposicion
      (workspace_id, version, modalidad, base, acordado_rol, efectivo_desde, acordado_por)
      values (${ws}, 2, 'archivo', 'Intento de resucitar', 'lead-boutique',
              current_date, ${leadId})`;

    // Y aun así el guard sigue cerrado. Se comprueba por la conexión de admin porque es la
    // única que llega hasta él: al rol de aplicación le responde antes la RLS —sin membresía,
    // el workspace no existe para él— y ese es el anti-oráculo funcionando, no un hueco.
    await expect(
      admin`insert into segmento (workspace_id, nombre, definicion)
        values (${ws}, 'resucitado', 'x')`,
    ).rejects.toMatchObject({ code: 'DS001' });
    // Ni devolviéndole la membresía a alguien: `miembro` también está congelada.
    await expect(
      admin`insert into miembro (workspace_id, usuario_id, nombre, email, rol)
        values (${ws}, ${leadId}, 'x', ${marca + '-resucita@test.demo'}, 'lead-boutique')`,
    ).rejects.toMatchObject({ code: 'DS001' });
    const [seg] = await admin`select count(*)::int as n from segmento where workspace_id = ${ws}`;
    expect(seg!.n).toBe(0);
  });

  it('el alcance sellado no declara más de lo que la disposición hizo', async () => {
    /*
     * El texto del alcance viaja DENTRO del sello, así que si sobredeclara, sobredeclara con
     * un hash al lado. La primera versión decía «cubre TODA fila» y enumeraba dos ausencias,
     * cuando sobreviven cinco cosas —el acuerdo, la constancia, la lápida del workspace y el
     * evento que la propia disposición escribe, además de las cuentas y el material externo—:
     * acreditaba una eliminación más amplia que la ejecutada.
     *
     * No se comprueba contra una copia del texto —eso solo detectaría erratas— sino contra el
     * CATÁLOGO: toda tabla que el borrado deja en pie tiene que estar NOMBRADA en el alcance
     * del borrado, y toda tabla que un archivo conserva pero no congela, en el del archivo.
     * Así, el día que alguien añada una exclusión, este test le exige decirlo en el recibo.
     */
    const admin = sqlAdmin();

    const sobreviven = await admin`select tabla from tablas_del_workspace()
      except select tabla from tablas_alcanzadas_por_borrado()`;
    expect(sobreviven.length).toBeGreaterThan(0);

    const wsB = await nuevoWorkspace('alcance-borrado');
    await acordarYExportar(wsB, 'borrado', adminId);
    const cb = await ejecutarDisposicion(leadId, {
      workspaceId: wsB,
      modalidadEsperada: 'borrado',
      acuerdoVersionEsperada: 1,
      confirmacion: 'BORRAR',
    });
    for (const f of sobreviven) expect(cb.alcance).toContain(f.tabla as string);
    // Y nombra lo que sobrevive SIN ser una tabla del conjunto: la fila del propio workspace.
    expect(cb.alcance).toContain('cupo de llamadas AI anulado');

    /*
     * Las supervivientes se NOMBRAN en el alcance y NO figuran en los conteos —lo que el
     * borrado no alcanza no se cuenta—. Las dos mitades importan: una versión del texto
     * afirmaba que aparecían «con esos nombres en los conteos», que es falso y viajaba dentro
     * del sello. La prosa de un documento no se puede comprobar entera desde un test, pero sí
     * el HECHO que describe, y es lo que se fija aquí: las claves del inventario son
     * exactamente el conjunto que el borrado alcanza, ni una más.
     */
    for (const f of sobreviven) expect(cb.conteos[f.tabla as string]).toBeUndefined();
    const alcanzadas = (await admin`select tabla from tablas_alcanzadas_por_borrado()`).map(
      (f) => f.tabla as string,
    );
    for (const tabla of Object.keys(cb.conteos)) expect(alcanzadas).toContain(tabla);

    const noCongeladas = await admin`select tabla from tablas_alcanzadas_por_borrado()
      except select tabla from tablas_congelables()`;
    expect(noCongeladas.length).toBeGreaterThan(0);

    const wsA = await nuevoWorkspace('alcance-archivo');
    await acordarYExportar(wsA, 'archivo', leadId);
    const ca = await ejecutarDisposicion(leadId, {
      workspaceId: wsA,
      modalidadEsperada: 'archivo',
      acuerdoVersionEsperada: 1,
      confirmacion: '',
    });
    for (const f of noCongeladas) expect(ca.alcance).toContain(f.tabla as string);
    // Lo mismo por el lado del archivo: el acuerdo y la constancia se nombran y no se cuentan.
    for (const f of sobreviven) expect(ca.conteos[f.tabla as string]).toBeUndefined();

    // Los dos textos son DISTINTOS: un archivo no destruye nada y congela un conjunto más
    // pequeño que el que cuenta, así que un texto único no puede ser exacto para los dos.
    expect(ca.alcance).not.toBe(cb.alcance);
    expect(cb.alcance).toContain('se destruyó');
    expect(ca.alcance).toContain('NO se destruyó');
    // Y los dos siguen siendo UNA línea: la carga sellada es un campo por renglón.
    expect(cb.alcance).not.toContain('\n');
    expect(ca.alcance).not.toContain('\n');
  });

  it('la constancia de un workspace borrado se alcanza SIN membresía, por su propia lista', async () => {
    // Conservar el derecho en la RLS no sirve de nada si no hay por dónde ejercerlo. El resto
    // de la aplicación resuelve el workspace activo a partir de las MEMBRESÍAS, y el borrado
    // las destruye: por ahí no se llega nunca a la constancia de un workspace borrado, ni
    // siquiera con su id en la URL. Sería la misma promesa inejercitable que la política vino a
    // arreglar, una capa más arriba.
    //
    // Por eso la lista no recibe workspace: se pide «lo que conservo» y filtra la RLS.
    const ws = await nuevoWorkspace('sin-membresia');
    await acordarYExportar(ws, 'borrado', adminId);
    const emitida = await ejecutarDisposicion(leadId, {
      workspaceId: ws,
      modalidadEsperada: 'borrado',
      acuerdoVersionEsperada: 1,
      confirmacion: 'BORRAR',
    });

    const [m] = await sqlAdmin()`select count(*)::int as n from miembro where workspace_id = ${ws}`;
    expect(m!.n).toBe(0);

    // Las dos partes la alcanzan por esta vía, sin saber a qué workspace pertenecían.
    for (const quien of [leadId, adminId]) {
      const lista = await misConstancias(quien);
      const suya = lista.find((c) => c.id === emitida.id);
      expect(suya?.sello).toBe(emitida.sello);
      // Y llega entera: se puede volver a verificar fuera de la base desde la lista.
      expect(selloRecomputado(suya!)).toBe(suya!.sello);
      // Y lo identifica por su workspace, que es lo único que queda: la RLS de `workspace` le
      // niega hasta la lápida a quien ya no es miembro, así que un nombre vendría vacío.
      expect(suya!.workspaceId).toBe(ws);
    }

    // Y a un tercero no le aparece.
    const [ajeno] = await sqlAdmin()`insert into usuario (email, nombre, estado)
      values (${`${marca}-ajeno2@test.demo`}, 'ajeno2', 'activo') returning id`;
    const deOtro = await misConstancias(ajeno!.id as string);
    expect(deOtro.find((c) => c.id === emitida.id)).toBeUndefined();
  });

  it('dos borrados seguidos: coincidir en la modalidad no basta, tiene que ser el MISMO acuerdo', async () => {
    // El caso que la comprobación de modalidad sola no atrapa. Si la pantalla muestra el
    // borrado #1 y la otra parte registra y exporta un #2 que también es borrado, la etiqueta
    // coincide — y se destruiría el workspace conforme a una base contractual y una retención
    // que quien ejecuta nunca vio. Lo que hay que confirmar es el acuerdo, no su etiqueta.
    const ws = await nuevoWorkspace('dos-borrados');
    const hoy = EFECTIVO_PASADO;
    await registrarAcuerdo(adminId, {
      workspaceId: ws,
      modalidad: 'borrado',
      base: 'Cláusula 9.3: borrado al cierre',
      efectivoDesde: hoy,
    });
    await exportarWorkspace(leadId, { workspaceId: ws, ambito: 'archivo' });
    // La pantalla de quien va a ejecutar muestra el #1. Mientras tanto, la otra parte pacta
    // otro borrado con OTRA base y vuelve a exportar, así que la base queda conforme.
    await registrarAcuerdo(adminId, {
      workspaceId: ws,
      modalidad: 'borrado',
      base: 'Anexo 2: borrado inmediato, sin retención',
      efectivoDesde: hoy,
    });
    await exportarWorkspace(leadId, { workspaceId: ws, ambito: 'archivo' });
    expect((await panelDisposicion(leadId, ws)).motivoNoEjecutable).toBeNull();

    await expect(
      ejecutarDisposicion(leadId, {
        workspaceId: ws,
        modalidadEsperada: 'borrado',
        acuerdoVersionEsperada: 1,
        confirmacion: 'BORRAR',
      }),
    ).rejects.toThrow(/no viste/i);
    // Y sigue entero: la coincidencia de etiqueta no lo destruyó.
    const [seg] = await sqlAdmin()`select count(*)::int as n from segmento
      where workspace_id = ${ws}`;
    expect(seg!.n).toBe(1);
  });

  it('la carga canónica reproduce jsonb::text de Postgres, clave a clave', async () => {
    // El sello se calcula sobre `conteos::text` y `remediacion::text`, así que la app tiene que
    // imprimir jsonb EXACTAMENTE como Postgres o la constancia no verifica en manos de nadie.
    // Las reglas se miden contra la base en vez de suponerse: el orden es por longitud EN
    // BYTES y luego byte a byte, que no es el alfabético de JavaScript.
    const admin = sqlAdmin();
    const casos: Record<string, unknown>[] = [
      {},
      { evidencia: 3, item_importacion: 12, propuesta_ai: 1 },
      { bb: 1, a: 2, ccc: 3, ab: 4, 'ñ': 5, A: 6, 'ó': 7 },
      { 'con espacio': 1, 'a"b': 2, 'a\\b': 3 },
    ];
    for (const caso of casos) {
      const [f] = await admin`select ${admin.json(caso as never)}::jsonb::text as t`;
      expect(jsonbTexto(caso)).toBe(f!.t as string);
    }
    // Y un decimal se rechaza en vez de arriesgar un hash distinto: en jsonb un número
    // conserva la forma con que se escribió, y eso no se deriva de un number.
    expect(() => jsonbTexto({ x: 1.5 })).toThrow(/enteros/i);
  });

  it('una referencia de acuerdo con salto de línea no entra: la carga es un campo por renglón', async () => {
    /*
     * `texto_importado_limpio` prohíbe los controles pero deja pasar LF y CR a propósito
     * —está pensado para material importado, que es multilínea—. Aquí eso sería una puerta:
     * la `base` se COPIA dentro de la carga canónica de la constancia, que es un campo por
     * renglón, así que un salto de línea dejaría el documento sellado ambiguo y permitiría
     * dibujar dentro del recibo campos que nadie pactó —una fecha efectiva distinta, otro
     * firmante— sin tocar el sello, porque los bytes serían los mismos.
     */
    const ws = await nuevoWorkspace('base-multilinea');
    // Y no solo con LF/CR: U+2028 y U+2029 SON separadores de línea Unicode, no son
    // controles C0 ni C1 —así que `texto_importado_limpio` los deja pasar— y un `<pre>` los
    // pinta como un salto. Con ellos dentro, la referencia dibujaba en pantalla lo que
    // parecían campos de más mientras el sello seguía verificando sobre los mismos bytes.
    for (const salto of ['\n', '\r', '\u2028', '\u2029']) {
      const inyectado = `Cláusula 1${salto}2030-01-01${salto}${leadId}${salto}lead-boutique`;
      await expect(
        registrarAcuerdo(adminId, {
          workspaceId: ws,
          modalidad: 'archivo',
          base: inyectado,
          efectivoDesde: EFECTIVO_PASADO,
        }),
      ).rejects.toThrow();
      await expect(
        conUsuario(adminId, (tx) => tx`insert into acuerdo_disposicion
          (workspace_id, modalidad, base, efectivo_desde, acordado_por)
          values (${ws}, 'archivo', ${inyectado}, current_date, ${adminId})`),
      ).rejects.toMatchObject({ code: '23514' });
    }
    const inyectado = `Cláusula 1\n2030-01-01\n${leadId}\nlead-boutique`;
    // Ni por SQL crudo con el grant de la aplicación: el CHECK está en la base, no solo en
    // el esquema de entrada.
    await expect(
      conUsuario(adminId, (tx) => tx`insert into acuerdo_disposicion
        (workspace_id, modalidad, base, efectivo_desde, acordado_por)
        values (${ws}, 'archivo', ${inyectado}, current_date, ${adminId})`),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('una exportación que no VIO el acuerdo no lo acredita, aunque su reloj diga que sí', async () => {
    /*
     * El caso que la comparación de relojes no atrapaba, construido con precisión porque es la
     * única forma de que el test discrimine: la transacción que registra el acuerdo fija
     * `acordado_en` con `clock_timestamp()` en su guard y NO commitea todavía; la exportación
     * arranca en ese hueco, así que su `creado_en` es POSTERIOR a `acordado_en` —el reloj dice
     * que todo está en orden— y su instantánea REPEATABLE READ no contiene ni la fila del
     * acuerdo ni el `DisposicionAcordada` que el mismo guard escribe. Al archivo entregado le
     * faltan las dos cosas, y tras un borrado esa auditoría no queda en ninguna otra parte.
     *
     * Un hecho de visibilidad no se infiere de un reloj: se anota. `confirmar_exportacion`
     * apunta qué acuerdo vio, bajo la instantánea de la exportación, y la disposición exige
     * que sea el que ejecuta.
     */
    const ws = await nuevoWorkspace('exportacion-ciega');
    const hoy = EFECTIVO_PASADO;

    let guardPasado!: () => void;
    const acuerdoEscrito = new Promise<void>((r) => {
      guardPasado = r;
    });
    let commitea!: () => void;
    const puedeCommitear = new Promise<void>((r) => {
      commitea = r;
    });

    // El acuerdo se escribe —su guard fija `acordado_en`— y la transacción se queda abierta.
    const registro = conUsuario(adminId, async (tx) => {
      await tx`insert into acuerdo_disposicion
        (workspace_id, modalidad, base, efectivo_desde, acordado_por)
        values (${ws}, 'borrado', 'Acuerdo aún sin commitear', ${hoy}::date, ${adminId})`;
      guardPasado();
      await puedeCommitear;
    });

    await acuerdoEscrito;
    // La exportación arranca AHORA: después de `acordado_en`, antes del commit.
    await exportarWorkspace(leadId, { workspaceId: ws, ambito: 'archivo' });
    commitea();
    await registro;

    const [reg] = await sqlAdmin()`select r.creado_en > a.acordado_en as reloj_dice_que_si,
        r.completado_en is not null as completa, r.acuerdo_version_visto
      from exportacion_registro r, acuerdo_disposicion a
      where r.workspace_id = ${ws} and a.workspace_id = ${ws}`;
    // El reloj dice que sí y la fila está completa: con la comparación de relojes, pasaba.
    expect(reg!.reloj_dice_que_si).toBe(true);
    expect(reg!.completa).toBe(true);
    // Pero no vio el acuerdo, y por tanto tampoco su evento de auditoría.
    expect(reg!.acuerdo_version_visto).toBeNull();

    expect((await panelDisposicion(leadId, ws)).motivoNoEjecutable).toMatch(/no llegó a VER/);
    await expect(
      ejecutarDisposicion(leadId, {
        workspaceId: ws,
        modalidadEsperada: 'borrado',
        acuerdoVersionEsperada: 1,
        confirmacion: 'BORRAR',
      }),
    ).rejects.toThrow(/no llegó a VER/);
    const [seg] = await sqlAdmin()`select count(*)::int as n from segmento
      where workspace_id = ${ws}`;
    expect(seg!.n).toBe(1);

    // Exportando de nuevo —ahora sí, viendo el acuerdo— se desbloquea, y el registro lo dice.
    await exportarWorkspace(leadId, { workspaceId: ws, ambito: 'archivo' });
    const [vista] = await sqlAdmin()`select max(acuerdo_version_visto) as v
      from exportacion_registro where workspace_id = ${ws}`;
    expect(Number(vista!.v)).toBe(1);
    expect((await panelDisposicion(leadId, ws)).motivoNoEjecutable).toBeNull();
  });

  it('un acuerdo NUEVO invalida la exportación que solo vio el anterior', async () => {
    // El corolario del hecho anotado: no basta con que la exportación sea posterior a ALGÚN
    // acuerdo, tiene que haber visto EL que se ejecuta. Con dos acuerdos seguidos y una sola
    // exportación entre medias, la etiqueta y el reloj coincidían y la versión vista no.
    const ws = await nuevoWorkspace('acuerdo-nuevo-invalida');
    await acordarYExportar(ws, 'archivo', adminId);
    expect((await panelDisposicion(leadId, ws)).motivoNoEjecutable).toBeNull();

    await registrarAcuerdo(leadId, {
      workspaceId: ws,
      modalidad: 'archivo',
      base: 'Acuerdo 2, sin exportar después',
      efectivoDesde: EFECTIVO_PASADO,
    });
    expect((await panelDisposicion(leadId, ws)).motivoNoEjecutable).toMatch(/no llegó a VER/);

    await exportarWorkspace(leadId, { workspaceId: ws, ambito: 'archivo' });
    expect((await panelDisposicion(leadId, ws)).motivoNoEjecutable).toBeNull();
  });

  it('desactivar la cuenta DURANTE la espera del candado tumba el registro que ya la había pasado', async () => {
    /*
     * El lado del candado importa, y aquí lo tenía mal. La comprobación de cuenta activa iba
     * ANTES de tomar el candado, así que una inserción que se queda esperando a otra
     * disposición la pasaba con la cuenta viva y registraba el acuerdo aunque la desactivaran
     * durante la espera. Y ese acuerdo no es poca cosa: revierte un archivo, o aporta la
     * primera de las dos firmas de un borrado.
     *
     * El caso de «cuenta ya inactiva» no cubría esto, porque allí la comprobación falla en
     * cualquier posición. Lo que discrimina es la espera en medio.
     */
    const admin = sqlAdmin();
    const ws = await nuevoWorkspace('desactivada-en-la-espera');

    const enCurso = await enVuelo(async (tx) => {
      await tx`select set_config('app.user_id', ${leadId}, true)`;
      await tx`select pg_advisory_xact_lock(
        hashtextextended('designio:workspace:' || ${ws}::text, 42))`;
    });
    try {
      const registro = conUsuario(adminId, (tx) => tx`insert into acuerdo_disposicion
        (workspace_id, modalidad, base, efectivo_desde, acordado_por)
        values (${ws}, 'borrado', 'Colado con la cuenta apagándose', ${EFECTIVO_PASADO}::date,
                ${adminId})`);
      // Está esperando el candado, ya con la cuenta viva comprobada si la puerta fuera previa.
      expect(await sigueEsperando(registro)).toBe(true);
      await admin`update usuario set estado = 'inactivo' where id = ${adminId}`;
      await enCurso.cerrar();
      await expect(registro).rejects.toMatchObject({ code: '42501' });
    } finally {
      await enCurso.cerrar().catch(() => {});
      await admin`update usuario set estado = 'activo' where id = ${adminId}`;
    }

    const [n] = await admin`select count(*)::int as n from acuerdo_disposicion
      where workspace_id = ${ws}`;
    expect(n!.n).toBe(0);
  });

  it('quien ejecutó conserva la lectura de SU acuerdo, no una ventana a los futuros', async () => {
    /*
     * La política conserva la lectura del acuerdo a quien ejecutó su disposición —conservar el
     * derecho es el punto de este slice—, pero el `exists` no estaba atado a la VERSIÓN: era
     * verdadero para toda fila del workspace. Y una constancia conserva el uuid de quien
     * ejecutó aunque su membresía desaparezca, así que un exmiembro seguía leyendo la base
     * contractual, la fecha y el firmante de acuerdos pactados cuando él ya no estaba.
     */
    const admin = sqlAdmin();
    const ws = await nuevoWorkspace('lectura-atada');
    await acordarYExportar(ws, 'archivo', adminId);
    await ejecutarDisposicion(leadId, {
      workspaceId: ws,
      modalidadEsperada: 'archivo',
      acuerdoVersionEsperada: 1,
      confirmacion: '',
    });

    // El ejecutor deja de ser miembro, y el cliente pacta un acuerdo nuevo sin él.
    await admin`delete from miembro where workspace_id = ${ws} and usuario_id = ${leadId}`;
    await registrarAcuerdo(adminId, {
      workspaceId: ws,
      modalidad: 'archivo',
      base: 'Cláusula que el exmiembro no debería leer',
      efectivoDesde: EFECTIVO_PASADO,
    });

    const suyos = await conUsuario(leadId, (tx) => tx`select version, base
      from acuerdo_disposicion where workspace_id = ${ws} order by version`);
    // Ve el que ejecutó…
    expect(suyos.map((f) => Number(f.version))).toEqual([1]);
    // …y NO el posterior, ni su base contractual.
    expect(suyos.map((f) => f.base as string).join(' ')).not.toContain('no debería leer');

    // El cliente, que sigue dentro, ve los dos.
    const delCliente = await conUsuario(adminId, (tx) => tx`select version
      from acuerdo_disposicion where workspace_id = ${ws} order by version`);
    expect(delCliente.map((f) => Number(f.version))).toEqual([1, 2]);
  });

  it('cambiar de rol no convierte a una persona en las DOS partes de un borrado', async () => {
    /*
     * La doble firma se comprobaba solo por el ROL, con este argumento escrito en la
     * migración: «roles distintos implica personas distintas, porque una persona tiene
     * exactamente una membresía por workspace». Es cierto en un instante y falso EN EL TIEMPO:
     * la unicidad impide dos roles a la vez, no cambiar de rol entre un acto y el otro. El
     * acuerdo congela `acordado_rol` al firmarse, así que quien registró el borrado como
     * admin-cliente y pasó después a lead-boutique aparecía como «la otra parte» y aportaba él
     * solo las dos firmas de una operación irreversible.
     */
    const admin = sqlAdmin();
    const ws = await nuevoWorkspace('rol-cambiante');

    // El acuerdo lo registra `adminId` con rol admin-cliente…
    await acordarYExportar(ws, 'borrado', adminId);
    const [ac] = await admin`select acordado_rol, acordado_por from acuerdo_disposicion
      where workspace_id = ${ws}`;
    expect(ac!.acordado_rol).toBe('admin-cliente');
    expect(ac!.acordado_por).toBe(adminId);

    // …y después su membresía pasa a lead-boutique. El acuerdo conserva el rol de entonces.
    await admin`update miembro set rol = 'lead-boutique'
      where workspace_id = ${ws} and usuario_id = ${adminId}`;
    await admin`delete from miembro where workspace_id = ${ws} and usuario_id = ${leadId}`;

    // Su rol ya NO coincide con el del acuerdo, así que la comprobación vieja lo dejaba pasar.
    const [rolAhora] = await conUsuario(adminId, (tx) =>
      tx`select workspace_role(app_user_id(), ${ws}) as rol`);
    expect(rolAhora!.rol).toBe('lead-boutique');
    expect(rolAhora!.rol).not.toBe(ac!.acordado_rol);

    // Y aun así no puede: la identidad no cambia con el rol.
    expect((await panelDisposicion(adminId, ws)).motivoNoEjecutable).toMatch(/registraste tú/i);
    await expect(
      ejecutarDisposicion(adminId, {
        workspaceId: ws,
        modalidadEsperada: 'borrado',
        acuerdoVersionEsperada: 1,
        confirmacion: 'BORRAR',
      }),
    ).rejects.toThrow(/registraste tú/i);
    await expect(
      conUsuario(adminId, (tx) => tx`select ejecutar_disposicion(${ws}, 1)`),
    ).rejects.toMatchObject({ code: 'DS002' });

    const [seg] = await admin`select count(*)::int as n from segmento where workspace_id = ${ws}`;
    expect(seg!.n).toBe(1);
  });

  it('una cuenta desactivada no dispone, ni por SQL crudo con su membresía viva', async () => {
    /*
     * `is_workspace_member` y `workspace_role` miran `miembro` y nada más, así que una cuenta
     * puesta en `inactivo` que conserve su fila de membresía pasaba TODAS las puertas SQL.
     * Con el grant que el rol de aplicación tiene sobre estas funciones, eso alcanzaba para
     * registrar el acuerdo, autorizar y confirmar la exportación y ejecutar el borrado por SQL
     * crudo, saltándose `exigirCuentaActiva`, que solo vive en el servicio. Cuarta aparición
     * del mismo patrón: una promesa sostenida donde el grant permite rodearla.
     */
    const admin = sqlAdmin();
    const ws = await nuevoWorkspace('cuenta-inactiva');
    await acordarYExportar(ws, 'borrado', adminId);

    await admin`update usuario set estado = 'inactivo' where id = ${leadId}`;
    try {
      // Por el servicio: ya lo paraba `exigirCuentaActiva`.
      await expect(
        ejecutarDisposicion(leadId, {
          workspaceId: ws,
          modalidadEsperada: 'borrado',
          acuerdoVersionEsperada: 1,
          confirmacion: 'BORRAR',
        }),
      ).rejects.toThrow();

      // Y por SQL crudo, que es la puerta que estaba abierta: las tres.
      await expect(
        conUsuario(leadId, (tx) => tx`select ejecutar_disposicion(${ws}, 1)`),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        conUsuario(leadId, (tx) => tx`select registrar_exportacion(${ws}, 'archivo')`),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        conUsuario(leadId, (tx) => tx`insert into acuerdo_disposicion
          (workspace_id, modalidad, base, efectivo_desde, acordado_por)
          values (${ws}, 'archivo', 'Acuerdo de una cuenta apagada', current_date, ${leadId})`),
      ).rejects.toMatchObject({ code: '42501' });

      // Y el panel lo explica en vez de callarse.
      expect((await panelDisposicion(adminId, ws)).motivoNoEjecutable).toBeTruthy();
    } finally {
      await admin`update usuario set estado = 'activo' where id = ${leadId}`;
    }

    // El workspace sigue entero.
    const [seg] = await admin`select count(*)::int as n from segmento where workspace_id = ${ws}`;
    expect(seg!.n).toBe(1);
  });

  it('un borrado sin la palabra escrita no se ejecuta: el `disabled` del botón no es una comprobación', async () => {
    /*
     * `CONFIRMACION_BORRADO` se comprobaba SOLO en el estado `disabled` del botón, y no viajaba
     * al servidor. Un atributo del DOM no es una comprobación: cualquier llamada al transporte
     * —una pestaña vieja, un cliente mal cableado, un script— ejecutaba el borrado sin que
     * nadie hubiera escrito nada, saltándose la que la propia pantalla declara como última
     * defensa contra el error humano.
     */
    const ws = await nuevoWorkspace('sin-la-palabra');
    await acordarYExportar(ws, 'borrado', adminId);

    for (const intento of ['', 'borrar', 'BORRA', 'SÍ']) {
      await expect(
        ejecutarDisposicion(leadId, {
          workspaceId: ws,
          modalidadEsperada: 'borrado',
          acuerdoVersionEsperada: 1,
          confirmacion: intento,
        }),
      ).rejects.toThrow(/BORRAR/);
    }
    const [seg] = await sqlAdmin()`select count(*)::int as n from segmento
      where workspace_id = ${ws}`;
    expect(seg!.n).toBe(1);

    // Con la palabra, sí.
    const c = await ejecutarDisposicion(leadId, {
      workspaceId: ws,
      modalidadEsperada: 'borrado',
      acuerdoVersionEsperada: 1,
      confirmacion: 'BORRAR',
    });
    expect(c.modalidad).toBe('borrado');
  });

  it('un ARCHIVO no pide la palabra: la ceremonia va donde está el riesgo', async () => {
    // Pedirla para algo reversible sería trámite sin riesgo detrás, y la ceremonia que se pide
    // de más es la que se teclea sin leer.
    const ws = await nuevoWorkspace('archivo-sin-palabra');
    await acordarYExportar(ws, 'archivo', leadId);
    const c = await ejecutarDisposicion(leadId, {
      workspaceId: ws,
      modalidadEsperada: 'archivo',
      acuerdoVersionEsperada: 1,
      confirmacion: '',
    });
    expect(c.modalidad).toBe('archivo');
  });

  it('la versión confirmada la exige la FUNCIÓN, no solo el servicio', async () => {
    /*
     * `ejecutar_disposicion` está concedida a `designio_app`, así que la comparación del
     * servicio la rodea cualquiera con SQL crudo y el rol adecuado. Si la otra parte registra
     * y exporta un acuerdo nuevo entre que la pantalla se pintó y la llamada llega, la función
     * elegía el ÚLTIMO —el que quien ejecuta nunca vio— y lo ejecutaba: otra base contractual,
     * otra retención, y en el peor caso un borrado. Es el mismo defecto que ya se cobró el
     * candado del registro, una promesa sostenida en el servicio que el grant permite rodear.
     */
    const ws = await nuevoWorkspace('version-en-la-funcion');
    await acordarYExportar(ws, 'archivo', adminId);
    // La otra parte cambia de idea: acuerdo #2, y ahora es un BORRADO.
    await registrarAcuerdo(leadId, {
      workspaceId: ws,
      modalidad: 'borrado',
      base: 'Acuerdo 2: mejor borrar',
      efectivoDesde: EFECTIVO_PASADO,
    });
    await exportarWorkspace(leadId, { workspaceId: ws, ambito: 'archivo' });

    // Por SQL crudo, confirmando el #1 que sí se vio: la base lo rechaza.
    await expect(
      conUsuario(adminId, (tx) => tx`select ejecutar_disposicion(${ws}, 1)`),
    ).rejects.toMatchObject({ code: 'DS002' });

    // Y la firma de un solo argumento —la que no obliga a confirmar nada— ya no existe.
    await expect(
      conUsuario(adminId, (tx) => tx`select ejecutar_disposicion(${ws})`),
    ).rejects.toMatchObject({ code: '42883' });

    // Ni pasando NULL, que es la puerta que deja abierta un `<>`: en SQL el resultado sería
    // NULL, plpgsql no lo toma por verdadero, el `if` no dispara y la función seguiría
    // ejecutando el acuerdo vigente. La garantía entera eludida pasando nada.
    await expect(
      conUsuario(adminId, (tx) => tx`select ejecutar_disposicion(${ws}, null)`),
    ).rejects.toMatchObject({ code: 'DS002' });

    // El workspace sigue entero: no se ejecutó ni el acuerdo viejo ni el nuevo.
    const [seg] = await sqlAdmin()`select count(*)::int as n from segmento
      where workspace_id = ${ws}`;
    expect(seg!.n).toBe(1);
  });

  it('bajo REPEATABLE READ la disposición se niega a decidir: esperar sin releer es esperar para nada', async () => {
    /*
     * El peor caso que ha dado este PR, reproducido antes de arreglarlo: con el acuerdo
     * vigente ya sustituido por un «archivo», una transacción REPEATABLE READ cuya instantánea
     * es anterior ejecutaba el «borrado» viejo y DESTRUÍA el workspace.
     *
     * El candado hace esperar, pero fuera de READ COMMITTED esperar no sirve de nada: la
     * sentencia siguiente no abre instantánea nueva, así que se relee la misma foto que había
     * antes de esperar. Y la derivación del aislamiento (20260902330000) no lo atrapa por dos
     * caminos distintos —el borrado apaga los triggers con `session_replication_role =
     * replica`, y el archivo solo escribe en tablas que la derivación excluye—, así que la
     * exigencia tiene que ser explícita y anterior a la primera lectura.
     */
    const ws = await nuevoWorkspace('repeatable-read');
    await acordarYExportar(ws, 'borrado', adminId);

    let instantaneaFijada!: () => void;
    const fijada = new Promise<void>((r) => {
      instantaneaFijada = r;
    });
    let sigue!: () => void;
    const cambioHecho = new Promise<void>((r) => {
      sigue = r;
    });

    const ejecucion = conUsuario(
      leadId,
      async (tx) => {
        // Una lectura cualquiera fija la instantánea de la transacción.
        await tx`select count(*) from segmento where workspace_id = ${ws}`;
        instantaneaFijada();
        await cambioHecho;
        return tx`select ejecutar_disposicion(${ws}, 1)`;
      },
      { aislamiento: 'repeatable read' },
    );

    await fijada;
    // Las dos partes cambian de idea DESPUÉS de esa instantánea: mejor archivar.
    await registrarAcuerdo(leadId, {
      workspaceId: ws,
      modalidad: 'archivo',
      base: 'Acuerdo 2: mejor archivar',
      efectivoDesde: EFECTIVO_PASADO,
    });
    await exportarWorkspace(leadId, { workspaceId: ws, ambito: 'archivo' });
    sigue();

    await expect(ejecucion).rejects.toMatchObject({ code: 'IS001' });
    // Y el workspace sigue en pie: el borrado que la foto vieja autorizaba no ocurrió.
    const [seg] = await sqlAdmin()`select count(*)::int as n from segmento
      where workspace_id = ${ws}`;
    expect(seg!.n).toBe(1);
    const [ac] = await sqlAdmin()`select modalidad from acuerdo_disposicion
      where workspace_id = ${ws} order by version desc limit 1`;
    expect(ac!.modalidad).toBe('archivo');
  });

  it('la constancia se sella con el instante REAL de ejecutarla, no con el inicio de su transacción', async () => {
    /*
     * `ejecutado_en` valía `now()`, que es el inicio de la TRANSACCIÓN. Bajo READ COMMITTED
     * —que esta disposición exige— cada sentencia abre instantánea nueva, así que una
     * transacción que arranca mientras una exportación válida está en vuelo ve su
     * confirmación posterior y ejecuta correctamente… sellando un `ejecutado_en` ANTERIOR a
     * su propio `exportado_en`. El documento se contradecía a sí mismo: certificaba haberse
     * ejecutado antes de la exportación que declara previa.
     */
    const ws = await nuevoWorkspace('instante-real');
    await registrarAcuerdo(adminId, {
      workspaceId: ws,
      modalidad: 'borrado',
      base: 'Acuerdo con exportación en vuelo',
      efectivoDesde: EFECTIVO_PASADO,
    });

    let abierta!: () => void;
    const arrancada = new Promise<void>((r) => {
      abierta = r;
    });
    let exportado!: () => void;
    const yaExportado = new Promise<void>((r) => {
      exportado = r;
    });

    // La transacción de la disposición ABRE aquí: su `now()` queda fijado antes de que la
    // exportación exista.
    const disposicion = conUsuario(leadId, async (tx) => {
      await tx`select 1`;
      abierta();
      await yaExportado;
      const [r] = await tx`select ejecutar_disposicion(${ws}, 1) as c`;
      return r!.c as Record<string, unknown>;
    });

    await arrancada;
    await exportarWorkspace(leadId, { workspaceId: ws, ambito: 'archivo' });
    exportado();
    const c = await disposicion;

    // Ejecutó —la instantánea nueva de READ COMMITTED sí ve la exportación— y el sello no se
    // contradice: el instante de ejecutar es POSTERIOR al de exportar.
    const [f] = await sqlAdmin()`select ejecutado_en > exportado_en as coherente,
        ejecutado_en > (select acordado_en from acuerdo_disposicion
                        where workspace_id = ${ws}) as tras_el_acuerdo
      from constancia_disposicion where id = ${c.id as string}`;
    expect(f!.coherente).toBe(true);
    expect(f!.tras_el_acuerdo).toBe(true);

    // Y el EVENTO va con el sello, no con el inicio de la transacción. No lo escribe esta
    // migración —`evento_dominio.creado_en` toma su default, que `20260902090000` fijó en
    // `clock_timestamp()`—, y precisamente por eso se ancla aquí: es una garantía de la que
    // este slice depende y que vive en otro fichero, así que un cambio allí la rompería en
    // silencio. Lo que se rompería es la cronología del panel de auditoría, que ordena por
    // `creado_en`: el evento quedaría fechado antes de la ejecución que lo produjo y antes
    // de la exportación que la habilitó — una historia causalmente falsa.
    const [ev] = await sqlAdmin()`select e.creado_en >= c.ejecutado_en as tras_ejecutar,
        e.creado_en > c.exportado_en as tras_exportar
      from evento_dominio e, constancia_disposicion c
      where c.id = ${c.id as string} and e.workspace_id = ${ws}
        and e.tipo = 'WorkspaceDispuesto'`;
    expect(ev!.tras_ejecutar).toBe(true);
    expect(ev!.tras_exportar).toBe(true);
  });

  it('la ventana declarada existe, y es exactamente lo que el alcance dice que es', async () => {
    /*
     * Este caso NO comprueba un candado: comprueba una AUSENCIA de candado, declarada dentro
     * del sello. `evento_dominio` y `exportacion_registro` quedan fuera de la congelación —un
     * archivo tiene que poder seguir auditándose y re-exportándose—, así que una escritura que
     * pasó su comprobación de política antes del vaciado puede commitear después. Y el rol de
     * aplicación tiene INSERT directo sobre el libro, así que la vía no es solo una
     * exportación en vuelo: un miembro con SQL crudo puede elegir el `payload`.
     *
     * Se prueba para que la ventana esté MEDIDA y no supuesta, y para fijar su tamaño: deja
     * una fila y nada más. Ni devuelve acceso a lo destruido, ni desmiente los conteos, ni la
     * puede leer después quien la escribió. Si algún día se cierra —moviendo el registro de la
     * exportación a su propia transacción, o quitando el INSERT directo—, este caso lo dice.
     */
    const admin = sqlAdmin();
    const ws = await nuevoWorkspace('ventana-declarada');
    await acordarYExportar(ws, 'borrado', adminId);

    let escrito!: () => void;
    const eventoEscrito = new Promise<void>((r) => {
      escrito = r;
    });
    let commitea!: () => void;
    const puedeCommitear = new Promise<void>((r) => {
      commitea = r;
    });

    // Un miembro escribe en el libro con el payload que quiere —DOS veces, porque el tamaño
    // de la ventana no es «una fila»: una transacción puede escribir varias, y una exportación
    // en vuelo confirma su evento y su registro— y se queda sin commitear.
    const enVuelo = conUsuario(leadId, async (tx) => {
      for (const n of [1, 2]) {
        await tx`insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
          values (${ws}, 'AuthzTest', ${tx.json({ colado: `texto elegido ${n}` })}::jsonb,
                  ${leadId}, 'lead-boutique')`;
      }
      escrito();
      await puedeCommitear;
    });
    await eventoEscrito;

    // El borrado corre sin verla, y sus conteos son verdad sobre lo que SÍ vio.
    const c = await ejecutarDisposicion(leadId, {
      workspaceId: ws,
      modalidadEsperada: 'borrado',
      acuerdoVersionEsperada: 1,
      confirmacion: 'BORRAR',
    });
    commitea();
    await enVuelo;

    // Lo que queda: el evento de la disposición y los DOS que se colaron.
    const filas = await admin`select tipo from evento_dominio where workspace_id = ${ws}
      order by tipo`;
    expect(filas.map((f) => f.tipo)).toEqual(['AuthzTest', 'AuthzTest', 'WorkspaceDispuesto']);

    // Y el tamaño de la ventana: una fila suelta y nada más. No devuelve acceso a lo
    // destruido —el resto del workspace sigue vacío— ni permite leerla, porque la RLS del
    // libro pide rol de miembro y el borrado destruyó la membresía.
    const [seg] = await admin`select count(*)::int as n from segmento where workspace_id = ${ws}`;
    expect(seg!.n).toBe(0);
    const suyas = await conUsuario(leadId, (tx) => tx`select id from evento_dominio
      where workspace_id = ${ws}`);
    expect(suyas.length).toBe(0);

    // Y el alcance sellado la declara con su tamaño REAL —«varias», no «una»—, en vez de que
    // el recibo prometa de más. Una versión anterior de este texto decía «una fila suelta», y
    // era falso por dos vías: una exportación en vuelo confirma su evento Y su registro, y una
    // transacción puede escribir varios eventos, que es lo que este caso provoca.
    expect(c.alcance).toContain('escribiendo en el libro de auditoría');
    expect(c.alcance).toContain('VARIAS filas');
    expect(c.alcance).not.toContain('una fila suelta');
  });

  it('los conteos de un archivo cuadran tabla a tabla con lo que queda, y la única diferencia está declarada', async () => {
    /*
     * El recibo de un archivo dice cuántas filas quedan CONSERVADAS, y la disposición escribe
     * su propio `WorkspaceDispuesto` DESPUÉS de contarlas: `evento_dominio` acaba con una fila
     * más de la que el sello declara. Es una diferencia de exactamente uno y no se puede
     * quitar —el payload del evento lleva el id y el sello de la constancia, así que no puede
     * emitirse antes de que exista—, pero sí se puede DECIR, y el alcance sellado la dice.
     *
     * Esto lo comprueba derivado del catálogo, no contra una copia: si mañana la disposición
     * escribiera un segundo evento, o escribiera en otra tabla, el cotejo dejaría de cuadrar y
     * este test lo dice en vez de dejar que la constancia se quede corta en silencio.
     */
    const admin = sqlAdmin();
    const ws = await nuevoWorkspace('conteos-archivo');
    await acordarYExportar(ws, 'archivo', leadId);
    const c = await ejecutarDisposicion(leadId, {
      workspaceId: ws,
      modalidadEsperada: 'archivo',
      acuerdoVersionEsperada: 1,
      confirmacion: '',
    });

    const desajustes: string[] = [];
    for (const f of await admin`select tabla from tablas_alcanzadas_por_borrado()`) {
      const tabla = f.tabla as string;
      const [n] = await admin.unsafe(
        `select count(*)::int as n from "${tabla}" where workspace_id = $1`,
        [ws],
      );
      const vivas = n!.n as number;
      const declaradas = c.conteos[tabla] ?? 0;
      const esperado = tabla === 'evento_dominio' ? declaradas + 1 : declaradas;
      if (vivas !== esperado) desajustes.push(`${tabla}: vivas ${vivas} ≠ ${esperado}`);
    }
    expect(desajustes).toEqual([]);
    // Y la diferencia está DECLARADA dentro del sello, no solo aquí — junto con la otra que
    // el recuento no puede incluir: una exportación de este workspace que estuviera EN VUELO
    // confirma su evento y su registro después de contar, y el alcance lo dice.
    expect(c.alcance).toContain('escribe su evento de auditoría');
    expect(c.alcance).toContain('escribiendo en el libro de auditoría');
    // Y la excepción de la baja de miembros, que la congelación deja fuera a propósito.
    expect(c.alcance).toContain('la BAJA');
  });

  it('un workspace con solo llamadas C0 declara su remediación aunque no toque ningún ítem', async () => {
    /*
     * La invariante en la que se apoya la pantalla, comprobada aquí para que no se caiga en
     * silencio. La base IMPONE que una llamada C0 lleve `reto_id` y no `item_id`
     * —`(capacidad = 'C0') = (reto_id is not null)`—, así que un workspace que solo hizo C0
     * produce `remediacion` LLENO con `remediacionItems = 0`. Gobernar el aviso de material
     * despachado con el contador de ítems lo escondía entero justo en ese caso: el usuario
     * no llegaba a saber que había material en un proveedor al que pedir la retirada.
     */
    const admin = sqlAdmin();
    const ws = await nuevoWorkspace('solo-c0');
    const [sv] = await admin`select id from servicio where workspace_id = ${ws}`;
    const [reto] = await admin`insert into reto
      (workspace_id, servicio_ancla_id, codigo, titulo, creado_por)
      values (${ws}, ${sv!.id}, 'R-1', 'Reto', ${leadId}) returning id`;
    for (const modelo of ['modelo-a', 'modelo-a', 'modelo-b']) {
      await admin`insert into llamada_ai
        (workspace_id, capacidad, reto_id, modelo, origen_key, resultado, creado_por)
        values (${ws}, 'C0', ${reto!.id}, ${modelo}, 'entorno', 'despachada', ${leadId})`;
    }

    await acordarYExportar(ws, 'borrado', adminId);
    const c = await ejecutarDisposicion(leadId, {
      workspaceId: ws,
      modalidadEsperada: 'borrado',
      acuerdoVersionEsperada: 1,
      confirmacion: 'BORRAR',
    });

    expect(c.remediacion).toEqual({ 'modelo-a': 2, 'modelo-b': 1 });
    expect(c.remediacionItems).toBe(0);
    expect(c.remediacionConConsentimiento).toBe(0);
    // Y el sello sigue verificando con un `remediacion` no vacío y un contador en cero.
    expect(selloRecomputado(c)).toBe(c.sello);
  });
  it('ninguna proyección de solo lectura queda leyendo de varios momentos', async () => {
    /*
     * El censo de la clase, en vez del cuarto arreglo suelto. Tres rondas seguidas
     * encontraron la misma forma —el panel de disposición, la auditoría, el panel de
     * propuestas— y las tres son la misma causa: una proyección de SOLO LECTURA con varias
     * sentencias, que este slice puede cruzar borrando el workspace a mitad. Antes de este PR
     * nada borraba datos de un workspace, así que la carrera no existía en ninguna.
     *
     * Se lee con el PARSER de TypeScript y no con expresiones regulares, y eso no es
     * elegancia: la versión con regex tenía tres formas de dar verde sin mirar, las tres
     * señaladas en revisión. Una función exportada como `const f = async () => …` no casaba
     * con `^export function`; el recuento de sentencias solo veía las `tx` LÉXICAS del cuerpo,
     * así que delegar una consulta a un ayudante bajaba el contador a una; y la comprobación
     * del aislamiento aceptaba la palabra en cualquier sitio, incluido un comentario SQL
     * dentro de una plantilla —y `ai.servicio.ts` tiene uno que dice «el aislamiento por
     * inquilino», en el mismo fichero que una de las proyecciones corregidas—.
     *
     * Con el AST las tres se cierran de raíz: la declaración se reconoce por su forma, las
     * sentencias se cuentan siguiendo también a los ayudantes locales que reciben `tx`, y el
     * aislamiento se lee del TERCER ARGUMENTO real de la llamada a `conUsuario`.
     */
    const ts = (await import('typescript')).default;
    const { readdir, readFile } = await import('node:fs/promises');
    const raiz = new URL('../../lib/', import.meta.url).pathname;
    const ficheros: string[] = [];
    const recorrer = async (dir: string) => {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const ruta = `${dir}${e.name}`;
        if (e.isDirectory()) await recorrer(`${ruta}/`);
        else if (e.name.endsWith('.ts')) ficheros.push(ruta);
      }
    };
    await recorrer(raiz);
    expect(ficheros.length).toBeGreaterThan(20);

    /** Las que quedan fuera se declaran AQUÍ con su motivo, o no quedan fuera. */
    const DECLARADAS: Record<string, string> = {
      'disposicion/disposicion.servicio.ts:ejecutarDisposicion':
        'ESCRIBE: invoca `ejecutar_disposicion`, que toma el candado del workspace y relee. La doctrina de aislamiento del esquema le exige READ COMMITTED, y la función lo comprueba y se niega bajo REPEATABLE READ.',
    };
    /*
     * `exportarWorkspace` estuvo aquí y se ha ido, y el motivo es el hallazgo: ya fija
     * `{ aislamiento: 'repeatable read' }` —por SYS-04, el archivo tiene que ser una foto—,
     * así que el censo no la nombraba y la excepción no se consumía nunca. Una excepción
     * inerte no es inofensiva: el día que alguien le quitara el aislamiento, el censo sí la
     * nombraría y este filtro la callaría, dejando en verde justo la regresión que existe
     * para detectar. Por eso abajo se exige que TODA excepción declarada se consuma.
     */

    /*
     * El censo va como FUNCIÓN y no como bucle sobre el disco, y eso no es orden: es que sin
     * ello solo puede mirar los ficheros REALES, y los ficheros reales están limpios. Un
     * hueco del censo —una forma de exportar que no reconoce, por ejemplo— no lo enrojece
     * nada, y solo se encuentra razonando. Fabricando fuentes se prueba el censo a sí mismo,
     * que es lo que el censo del calendario ya hacía con sus sondas.
     */
    /** Las fuentes del repositorio por ruta, para poder seguir a un ayudante IMPORTADO. */
    const fuentesDelRepo = new Map<string, string>();
    const analizadas = new Map<string, TS.SourceFile>();
    const parsear = (ruta: string, texto: string) => {
      const ya = analizadas.get(ruta);
      if (ya) return ya;
      const f = ts.createSourceFile(ruta, texto, ts.ScriptTarget.Latest, true);
      analizadas.set(ruta, f);
      return f;
    };

    const censar = (ruta: string, texto: string): string[] => {
      const nombradas: string[] = [];
      const fuente = parsear(ruta, texto);

      /**
       * Cuántas sentencias corren en ESTA transacción bajo el nodo. Tres formas, y la tercera
       * es la que importa:
       *
       *  · `tx\`select …\`` — la plantilla etiquetada;
       *  · `tx.unsafe(…)` — la única llamada sobre `tx` que ejecuta algo. `tx.json(…)` NO
       *    cuenta: serializa un valor y no es una sentencia. Contarla marcó `hilosDeObjetos`
       *    por el motivo equivocado, aunque resultara culpable por otro;
       *  · **cualquier llamada cuyo PRIMER argumento sea `tx`** —`exigirCuentaActiva(tx, …)`—,
       *    porque ese ayudante ejecuta sus consultas dentro de esta misma transacción. Es lo
       *    que sustituye a seguir ayudantes por nombre: aquello solo veía los del propio
       *    módulo, y `exigirCuentaActiva` se IMPORTA en casi todos, así que una proyección
       *    nueva en cualquier fichero salvo `auth.servicio.ts` se contaba de menos.
       */
      /**
       * Las funciones de un módulo por nombre. Va aparte porque hace falta también para los
       * módulos AJENOS: sin poder mirar dentro de un ayudante importado, su recuento se
       * quedaba en una sentencia, que es el TECHO optimista y no el suelo.
       */
      const tablaDe = (f: TS.SourceFile) => {
        const t = new Map<string, TS.Node>();
        for (const st of f.statements) {
          if (ts.isFunctionDeclaration(st) && st.name) t.set(st.name.text, st);
          if (ts.isVariableStatement(st)) {
            for (const d of st.declarationList.declarations) {
              if (!ts.isIdentifier(d.name) || !d.initializer) continue;
              const v = desenvolver(d.initializer);
              if (ts.isArrowFunction(v) || ts.isFunctionExpression(v)) t.set(d.name.text, v);
            }
          }
        }
        return t;
      };
      /** El nombre que abre transacción. Una vez, porque lo preguntan tres sitios. */
      const ABRE = 'conUsuario';
      /**
       * A qué nombre apunta un inicializador cuando es un ALIAS. Un identificador
       * —`const abrir = conUsuario;`— apunta a su texto. Y un ACCESO A PROPIEDAD
       * —`const abrir = db.conUsuario;`, que es como queda con un `import * as`—, al nombre de
       * la propiedad: la llamada directa `db.conUsuario(…)` ya se reconocía, pero no que se
       * GUARDE primero y se llame después, y por ahí se iba la proyección entera —de la lista
       * que busca y del cierre por alcance, que preguntan lo mismo—.
       *
       * La propiedad se exige LITERAL, que es la misma regla que `esApertura` aplica a la
       * llamada por propiedad. Resolverla en cadena mapearía también `const x = otra.cosa` a la
       * `cosa` local de este módulo, y este mapa no solo decide qué abre transacción: también
       * resuelve CUERPOS.
       *
       * En una función y no en dos: `aliasDe` y el recorrido del módulo hacen la misma
       * pregunta, y un criterio repetido aprende en un sitio y se queda viejo en el otro.
       */
      const nombreAliasado = (init: TS.Expression) => {
        const v = desenvolver(init);
        if (ts.isIdentifier(v)) return v.text;
        if (ts.isPropertyAccessExpression(v) && v.name.text === ABRE) return v.name.text;
        return undefined;
      };
      /**
       * Y los alias que llegan por DESESTRUCTURACIÓN: `const { conUsuario } = db;` y
       * `const { conUsuario: abrir } = db;`, que es la tercera forma de guardarse la apertura
       * —después del identificador y del acceso a propiedad— y la única cuyo inicializador no
       * dice nada: el nombre está en el PATRÓN, no en el valor. Sin leerlo, `abrir(...)` no
       * abría transacción para el censo y la proyección se caía de la búsqueda y del cierre a
       * la vez, igual que con las otras dos.
       *
       * Solo cuando la propiedad es la que abre, por lo mismo que en el acceso: este mapa
       * resuelve además CUERPOS, y mapear cualquier desestructuración a su nombre de origen
       * haría que `const { cosa } = otra` se analizara como la `cosa` local del módulo.
       */
      const aliasDesestructurados = (d: TS.VariableDeclaration): [string, string][] => {
        if (!ts.isObjectBindingPattern(d.name)) return [];
        const pares: [string, string][] = [];
        for (const el of d.name.elements) {
          if (!ts.isIdentifier(el.name)) continue;
          const origen =
            el.propertyName && ts.isIdentifier(el.propertyName)
              ? el.propertyName.text
              : el.name.text;
          if (origen === ABRE) pares.push([el.name.text, origen]);
        }
        return pares;
      };
      /**
       * Y los ALIAS de un módulo —`const abrir = conUsuario;`—, que también hacen falta para
       * los AJENOS: el predicado de «esto abre una transacción» se resuelve contra ellos, y
       * cerrado sobre los del módulo que LLAMA no reconoce el alias del que se analiza.
       */
      const aliasDe = (f: TS.SourceFile) => {
        const m = new Map<string, string>();
        for (const st of f.statements) {
          /*
           * Renombrar al IMPORTAR es tan alias como declararlo: con
           * `import { conUsuario as conActor }`, `conActor` abre una transacción igual. Y
           * escapaba de las DOS listas a la vez —la que busca y el cierre por alcance—,
           * porque las dos preguntan por el mismo predicado: el cierre no puede echar de
           * menos lo que tampoco supo reconocer.
           */
          if (ts.isImportDeclaration(st) && st.importClause) {
            const enlaces = st.importClause.namedBindings;
            if (enlaces && ts.isNamedImports(enlaces)) {
              for (const el of enlaces.elements) {
                if (el.propertyName) m.set(el.name.text, el.propertyName.text);
              }
            }
          }
          if (!ts.isVariableStatement(st)) continue;
          for (const d of st.declarationList.declarations) {
            for (const [local, origen] of aliasDesestructurados(d)) m.set(local, origen);
            if (!ts.isIdentifier(d.name) || !d.initializer) continue;
            const apunta = nombreAliasado(d.initializer);
            if (apunta !== undefined) m.set(d.name.text, apunta);
          }
        }
        return m;
      };
      /**
       * Y de dónde viene un nombre IMPORTADO: se busca su `import`, se resuelve la ruta
       * relativa —con `.ts` y con `/index.ts`— y se mira la tabla de ESE módulo. Si el
       * ayudante llama a su vez a otro que tampoco se resuelve, el desconocimiento se propaga
       * y la transacción falla cerrado, que es lo correcto.
       */
      const resolverImportado = (nombre: string) => {
        for (const st of fuente.statements) {
          if (!ts.isImportDeclaration(st) || !st.importClause) continue;
          const enlaces = st.importClause.namedBindings;
          if (!enlaces || !ts.isNamedImports(enlaces)) continue;
          const el = enlaces.elements.find((e) => e.name.text === nombre);
          if (!el) continue;
          const local = (el.propertyName ?? el.name).text;
          const espec = st.moduleSpecifier;
          if (!ts.isStringLiteral(espec)) return undefined;
          /*
           * Dos formas de nombrar el módulo, y la que se usa aquí es la del ALIAS: en este
           * repositorio los ayudantes compartidos se importan como `@/lib/auth/auth.servicio`.
           * Las claves del mapa son relativas a `src/lib/`, así que el alias es un recorte.
           * La relativa va también, que es lo que se escribirá el día que alguien mueva algo.
           */
          let raizMod: string;
          if (espec.text.startsWith('@/lib/')) raizMod = espec.text.slice('@/lib/'.length);
          else if (espec.text.startsWith('.')) {
            const base = ruta.split('/').slice(0, -1);
            for (const trozo of espec.text.split('/')) {
              if (trozo === '.') continue;
              else if (trozo === '..') base.pop();
              else base.push(trozo);
            }
            raizMod = base.join('/');
          } else return undefined;
          for (const cand of [`${raizMod}.ts`, `${raizMod}/index.ts`]) {
            const texto2 = fuentesDelRepo.get(cand);
            if (texto2 === undefined) continue;
            const ajeno = parsear(cand, texto2);
            const tabla = tablaDe(ajeno);
            const nodo = tabla.get(local);
            if (nodo) return { nodo, tabla, alias: aliasDe(ajeno) };
          }
          return undefined;
        }
        return undefined;
      };

      /** Ayudantes ya en la pila, para no caer en un ciclo si dos se llaman entre sí. */
      const enCurso = new Set<TS.Node>();
      /**
       * El nombre del primer parámetro de una función: el identificador con el que SU cuerpo
       * llama a la transacción. Se sigue el símbolo y no el texto `tx`, porque
       * `conUsuario(actorId, async (db) => …)` es el mismo código con otro nombre y con la
       * cadena fija no se contaba ni una de sus consultas: renombrar el parámetro dejaba el
       * censo en verde sin cambiar nada de la semántica.
       */
      const primerParametro = (fn: TS.Node): string | undefined => {
        if (
          !ts.isArrowFunction(fn) &&
          !ts.isFunctionExpression(fn) &&
          !ts.isFunctionDeclaration(fn)
        ) {
          return undefined;
        }
        const p0 = fn.parameters[0];
        return p0 && ts.isIdentifier(p0.name) ? p0.name.text : undefined;
      };
    const ESCRITURA = /insert\s+into|update\s+\w+(\s+\w+)?\s+set|delete\s+from/i;
    /*
     * El SQL que de verdad se EJECUTA: sin comentarios y con los literales vaciados.
     *
     * Al revés que el barrido del otro censo, aquí el contenido del literal SÍ se tira, y a
     * propósito: allí hay patrones que LEEN el literal —`date_trunc('day', …)`— y vaciarlo
     * rompía tres a la vez; aquí solo se busca una palabra clave de sintaxis, que dentro de
     * un literal es un dato. `where nombre = 'insert into t'` no escribe nada.
     *
     * Los bloques ANIDAN, que es como los cuenta Postgres.
     *
     * LÍMITE DECLARADO: una interpolación cuyo valor en tiempo de ejecución sea una sentencia
     * de escritura no se puede ver desde el texto. Queda dicho aquí en vez de descubrirse.
     */
    const sqlEjecutable = (texto: string): string => {
      let fuera = '';
      let i = 0;
      while (i < texto.length) {
        const c = texto[i]!;
        const d = texto[i + 1];
        if (c === '-' && d === '-') {
          const fin = texto.indexOf('\n', i);
          i = fin === -1 ? texto.length : fin;
          fuera += ' ';
          continue;
        }
        if (c === '/' && d === '*') {
          let hondura = 1;
          i += 2;
          while (i < texto.length && hondura > 0) {
            if (texto[i] === '/' && texto[i + 1] === '*') {
              hondura++;
              i += 2;
            } else if (texto[i] === '*' && texto[i + 1] === '/') {
              hondura--;
              i += 2;
            } else i++;
          }
          fuera += ' ';
          continue;
        }
        /*
         * El entrecomillado POR DÓLAR es la tercera forma de escribir un dato, y el barrido
         * solo conocía las comillas simples: `select $$insert into temporal$$ as texto` daba
         * la transacción por ESCRITORA y con eso la EXIME de fijar el aislamiento.
         *
         * Y una excepción que me acabo de ganar en el otro censo: `` `$${n}` `` es un dólar
         * LITERAL seguido de una interpolación, no una etiqueta. Aquí la dirección del error
         * sería la benigna —vaciar de más deja la transacción en «no escribe» y la NOMBRA, o
         * sea ruido visible—, pero no hay razón para pagarlo pudiendo distinguirlo.
         */
        if (c === '$' && d === '$' && texto[i + 2] === '{') {
          fuera += c;
          i++;
          continue;
        }
        if (c === '$') {
          const m = /^\$([A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/.exec(texto.slice(i));
          if (m) {
            const etiqueta = m[0];
            const cierra = texto.indexOf(etiqueta, i + etiqueta.length);
            i = cierra === -1 ? texto.length : cierra + etiqueta.length;
            fuera += ' ';
            continue;
          }
        }
        /*
         * Un identificador entre COMILLAS DOBLES es un nombre, no un dato — pero tampoco es
         * una sentencia. `select 1 as "insert into t"` daba la transacción por escritora.
         * Se vacía igual: lo que se busca aquí es sintaxis, y un nombre no la aporta. (Con
         * un nombre entrecomillado, `update "t" set` ya no lo detectaba nadie: la `"` no es
         * carácter de palabra, así que esto no quita nada que hoy funcione.)
         */
        if (c === '"') {
          i++;
          while (i < texto.length) {
            if (texto[i] === '"' && texto[i + 1] === '"') i += 2;
            else if (texto[i] === '"') {
              i++;
              break;
            } else i++;
          }
          fuera += ' "" ';
          continue;
        }
        if (c === "'") {
          /*
           * La cadena con prefijo `E` escapa con BARRA y no duplicando la comilla, así que
           * `E'a\' insert into t --'` terminaba el literal en la barra y dejaba la escritura
           * FUERA: la transacción salía exenta. Las demás formas con prefijo —`U&'…'`,
           * `B'…'`, `X'…'`— escapan duplicando como la normal, y las dos últimas ni siquiera
           * admiten letras suficientes para formar una palabra clave.
           */
          const prefijoE =
            (texto[i - 1] === 'E' || texto[i - 1] === 'e') &&
            !/[A-Za-z0-9_]/.test(texto[i - 2] ?? ' ');
          i++;
          while (i < texto.length) {
            if (prefijoE && texto[i] === '\\') i += 2;
            else if (texto[i] === "'" && texto[i + 1] === "'") i += 2;
            else if (texto[i] === "'") {
              i++;
              break;
            } else i++;
          }
          fuera += " '' ";
          continue;
        }
        fuera += c;
        i++;
      }
      return fuera;
    };

      const analizar = (
        nodo: TS.Node,
        tx: string,
        tabla: Map<string, TS.Node> = porNombre,
        aliasMod: Map<string, string> = alias,
      ): { sentencias: number; escribe: boolean; desconocido: boolean } => {
        let sentencias = 0;
        let escribe = false;
        let desconocido = false;
        /*
         * Los nombres que APUNTAN a esta transacción, no uno solo. El símbolo sale del
         * parámetro del callback, pero dentro se puede guardar en otro —`const tx = db;`, que
         * es un refactor sin consecuencias— y entonces las plantillas etiquetadas con él no
         * las contaba nadie: la proyección quedaba en cero sentencias, la apertura sí constaba
         * como alcanzada, y una multiconsulta sin aislamiento dejaba el censo en verde. El
         * mismo modo de fallo que el parámetro renombrado, una capa más adentro.
         *
         * Se va llenando durante el recorrido, que es en PREORDEN: la declaración se visita
         * antes que los usos, porque está antes en el cuerpo.
         */
        const simbolosTx = new Set([tx]);
        /*
         * Solo cuentan las sentencias cuyo RESULTADO llega a la respuesta. Una cuyo valor se
         * descarta —`await exigirCuentaActiva(tx, actorId);`, una sentencia de expresión a
         * secas— es una PUERTA: o pasa o lanza, y no aporta ningún campo. No puede hacer
         * incoherente lo que se devuelve, que es lo que este censo protege.
         *
         * La distinción no es cosmética: contando las puertas salían diecisiete proyecciones,
         * casi todas con una sola lectura de datos detrás de su comprobación de cuenta. Habría
         * sido ensanchar el PR a ocho slices por una incoherencia que nadie puede observar.
         */
        const contar = (n: TS.Node) => {
          let p: TS.Node | undefined = n.parent;
          while (p && (ts.isAwaitExpression(p) || ts.isParenthesizedExpression(p))) {
            p = p.parent;
          }
          if (p && ts.isExpressionStatement(p)) return; // puerta: su valor se tira
          sentencias++;
        };
        const visitar = (n: TS.Node) => {
          if (
            ts.isVariableDeclaration(n) &&
            ts.isIdentifier(n.name) &&
            n.initializer &&
            (() => {
              const v = desenvolver(n.initializer!);
              return ts.isIdentifier(v) && simbolosTx.has(v.text);
            })()
          ) {
            simbolosTx.add(n.name.text);
          }
          if (
            ts.isTaggedTemplateExpression(n) &&
            ts.isIdentifier(n.tag) &&
            simbolosTx.has(n.tag.text)
          ) {
            contar(n);
          }
          /*
           * Un `conUsuario` ANIDADO abre su propia transacción: sus sentencias no son de
           * ésta. Se corta aquí y se analiza por separado, como una proyección más.
           *
           * Y el corte usa el MISMO predicado que localiza las transacciones. Antes exigía el
           * identificador desnudo, así que una anidada abierta por alias o por propiedad no
           * cortaba: si los dos callbacks llamaban `tx` a su transacción, las consultas de la
           * interior se atribuían a la exterior y —peor— un `insert` de la interior ponía
           * `escribe` y EXIMÍA a la exterior. Lo abrí yo al ampliar `esApertura` en un sitio y
           * no en el otro: dos recorridos que discrepan es la forma en que esto falla callado,
           * y lo escribí como riesgo una vuelta antes de cometerlo.
           */
          if (ts.isCallExpression(n) && esApertura(n, aliasMod)) return;
          if (ts.isCallExpression(n)) {
            const f = n.expression;
            const esUnsafe =
              ts.isPropertyAccessExpression(f) &&
              ts.isIdentifier(f.expression) &&
              simbolosTx.has(f.expression.text) &&
              f.name.text === 'unsafe';
            const primeroEsTx =
              n.arguments.length > 0 &&
              ts.isIdentifier(n.arguments[0]!) &&
              simbolosTx.has((n.arguments[0] as TS.Identifier).text);
            if (esUnsafe) {
              contar(n);
              for (const a of n.arguments) {
                /*
                 * El VALOR de la cadena, no su texto fuente: las comillas son de TypeScript y
                 * `sqlEjecutable` las leería como literal o identificador de SQL y vaciaría el
                 * contenido — que es justo el SQL que hay que mirar. Lo descubrí porque la
                 * sonda de una escritora por `unsafe` seguía saliendo nombrada.
                 */
                const crudo = ts.isStringLiteralLike(a) ? a.text : a.getText();
                if (ESCRITURA.test(sqlEjecutable(crudo))) escribe = true;
              }
            }
            else if (primeroEsTx) {
              /*
               * Un ayudante que recibe `tx` ejecuta SUS consultas en esta transacción, así que
               * cuenta lo que ejecuta él, no uno. Contando uno, una proyección que delegara
               * todas sus lecturas —`return cargarPanel(tx, …)`— salía con una sola sentencia
               * y se escapaba. Se expande si es del módulo.
               *
               * Y si viene de OTRO módulo, no hay cuerpo que mirar. Aquí decía que contar una
               * era «el suelo conservador» y era falso al revés: la regla nombra a partir de
               * DOS sentencias, así que contar una es el techo OPTIMISTA — un ayudante
               * importado con tres lecturas dejaba la proyección en una y fuera del censo.
               * Ahora el recuento queda DESCONOCIDO, que falla cerrado.
               */
              const destino = ts.isIdentifier(f) ? tabla.get(f.text) : undefined;
              // El ayudante llama a la transacción como quiera: se lee de SU declaración.
              const txDelAyudante = destino ? primerParametro(destino) : undefined;
              if (destino && txDelAyudante && !enCurso.has(destino)) {
                enCurso.add(destino);
                const sub = analizar(destino, txDelAyudante, tabla, aliasMod);
                enCurso.delete(destino);
                escribe ||= sub.escribe;
                desconocido ||= sub.desconocido;
                // Las del ayudante heredan el destino del valor de ESTA llamada: si aquí se
                // descarta, son una puerta entera y no cuentan.
                for (let i = 0; i < sub.sentencias; i++) contar(n);
              } else {
                // Y si no es del módulo, se busca en el que lo EXPORTA antes de darse por
                // vencido. Solo cuando tampoco ahí hay cuerpo queda desconocido.
                const fuera = ts.isIdentifier(f) ? resolverImportado(f.text) : undefined;
                const txAjeno = fuera ? primerParametro(fuera.nodo) : undefined;
                if (fuera && txAjeno && !enCurso.has(fuera.nodo)) {
                  enCurso.add(fuera.nodo);
                  const sub = analizar(fuera.nodo, txAjeno, fuera.tabla, fuera.alias);
                  enCurso.delete(fuera.nodo);
                  escribe ||= sub.escribe;
                  desconocido ||= sub.desconocido;
                  for (let i = 0; i < sub.sentencias; i++) contar(n);
                } else {
                  desconocido = true;
                  contar(n);
                }
              }
            }
          }
          /*
           * El SQL, para saber si ESCRIBE — y lo que decide es lo que SE EJECUTA, no lo que
           * está escrito. `select 1 -- insert into t` no escribe nada, y darlo por escritor
           * EXIME la transacción de fijar el aislamiento: el hueco va en esa dirección.
           *
           * Por eso NO vale cualquier plantilla: solo las que de verdad van a la base. Una
           * plantilla suelta —un mensaje de error que mencione `insert into ${'${tabla}'}`— no la
           * ejecuta nadie, y bastaba para eximir la transacción. Ahora tiene que estar
           * ETIQUETADA con la transacción.
           *
           * Y al mirarlo apareció el fallo contrario: `tx.unsafe("insert into …")` recibe una
           * CADENA, no una plantilla, así que no se veía y una escritora de verdad salía
           * nombrada. Las dos direcciones del mismo error de sitio.
           */
          if (
            ts.isTaggedTemplateExpression(n) &&
            ts.isIdentifier(n.tag) &&
            simbolosTx.has(n.tag.text) &&
            ESCRITURA.test(sqlEjecutable(n.template.getText()))
          ) {
            escribe = true;
          }
          ts.forEachChild(n, visitar);
        };
        ts.forEachChild(nodo, visitar);
        return { sentencias, escribe, desconocido };
      };

      /**
       * Todas las funciones del módulo por nombre, exportadas o no. Se siembra con la MISMA
       * tabla que se usa para los módulos ajenos, para que las dos no puedan divergir; el
       * recorrido de abajo añade además lo que solo tiene sentido en el módulo propio.
       */
      const porNombre = new Map<string, TS.Node>();
      /**
       * Y los nombres que SALEN del módulo, por cualquiera de las cuatro puertas. Antes esto
       * miraba solo el modificador `export` de la declaración, y una proyección declarada
       * aparte y exportada después —`const p = …; export { p };`— quedaba fuera del censo por
       * completo: `porNombre` la tenía, pero el recorrido no la visitaba.
       *
       * Se recogen como NOMBRES y se resuelven al final contra `porNombre`, para no depender
       * del orden: la cláusula de exportación puede ir antes que la declaración.
       */
      const exportadas = new Set<string>();
      /**
       * Los ALIAS: `const panel = leerPanel;`. El nombre exportado no tiene cuerpo propio, y
       * sin esto ni el alias ni la original entraban en el censo — la proyección entera
       * desaparecía.
       */
      const alias = new Map<string, string>();
      /**
       * Las llamadas a `conUsuario` que el censo ha llegado a ANALIZAR.
       *
       * Enumerar las formas de exportar era perseguir el caso: van cuatro puertas cerradas
       * —el modificador, la cláusula, el callback por nombre, el alias— y probando salieron
       * dos más, un objeto (`export const api = { panel: leerPanel }`) y una
       * desestructuración. La lista no se acaba.
       *
       * Así que la pregunta se invierte, igual que con las unidades del otro censo: en vez de
       * enumerar por dónde puede salir una proyección, se exige que **toda** transacción del
       * fichero haya sido mirada por alguien. La que no, se nombra. Cierra la clase entera,
       * incluidas las formas que nadie ha inventado todavía.
       */
      const alcanzadas = new Set<TS.CallExpression>();
      /**
       * Y QUÉ CUENTA COMO ABRIR UNA TRANSACCIÓN, en un solo sitio, para que el recorrido que
       * las RECOGE y el que las ANALIZA no puedan discrepar: el cierre por alcance compara
       * nodos por identidad, así que una forma que solo uno de los dos reconociera quedaría
       * fuera de las DOS listas y nadie la echaría de menos.
       *
       * Cubre el nombre desnudo, un alias suyo —`const abrir = conUsuario;`, siguiendo la
       * cadena—, la llamada por PROPIEDAD, `db.conUsuario(…)`, que es como queda con un
       * `import * as`, y la propiedad GUARDADA y llamada después, `const abrir = db.conUsuario`,
       * que entra por el mismo mapa de alias. Las encontré probando, después de escribir que
       * eran el hueco que le quedaba al cierre.
       */
      const abreTransaccion = (nombre: string, mapa: Map<string, string> = alias) => {
        const vistos = new Set<string>();
        let actual: string | undefined = nombre;
        while (actual !== undefined && !vistos.has(actual)) {
          if (actual === ABRE) return true;
          vistos.add(actual);
          actual = mapa.get(actual);
        }
        return false;
      };
      const esApertura = (n: TS.CallExpression, mapa: Map<string, string> = alias) =>
        (ts.isIdentifier(n.expression) && abreTransaccion(n.expression.text, mapa)) ||
        (ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === ABRE);
      /**
       * Lo que envuelve a un valor sin cambiarlo: `(f) satisfies T`, `f as T`, `(f)`, `f!`.
       * Sin desenvolver, `export const p = (async (…) => conUsuario(…)) satisfies Proyeccion`
       * tiene un `SatisfiesExpression` por inicializador, no una flecha, y la rama de abajo lo
       * descartaba: TypeScript perfectamente válido que se caía del censo entero.
       */
      const desenvolver = (n: TS.Expression): TS.Expression => {
        let e = n;
        for (;;) {
          if (
            ts.isParenthesizedExpression(e) ||
            ts.isAsExpression(e) ||
            ts.isSatisfiesExpression(e) ||
            ts.isNonNullExpression(e) ||
            ts.isTypeAssertionExpression(e)
          ) {
            e = e.expression;
            continue;
          }
          return e;
        }
      };
      const llevaExport = (n: TS.Node) =>
        ts.canHaveModifiers(n) &&
        (ts.getModifiers(n) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      // La tabla se siembra AQUÍ y no en la declaración: `tablaDe` usa `desenvolver`, que se
      // define más abajo, y llamarla antes muere en la zona muerta temporal.
      for (const [k, v] of tablaDe(fuente)) porNombre.set(k, v);
      // Y los ALIAS por la misma vía, para que la versión local y la que se usa con los
      // módulos ajenos no puedan divergir. Hoy dan lo mismo; el motivo de unificarlas es que
      // esta forma —un criterio repetido que aprende en un sitio y envejece en el otro— ya ha
      // producido cuatro hallazgos hoy entre los dos censos, dos de ellos huecos.
      for (const [k, v] of aliasDe(fuente)) alias.set(k, v);
      for (const st of fuente.statements) {
        if (ts.isFunctionDeclaration(st)) {
          /*
           * `export default async function (…) {}` llega como `FunctionDeclaration` SIN
           * nombre, y el `&& st.name` de antes la descartaba entera. Va bajo el nombre
           * sintético `default`, el mismo que usa la flecha exportada por defecto: `default`
           * es palabra reservada, así que no puede chocar con ninguna función del módulo.
           */
          const nombre = st.name?.text ?? (llevaExport(st) ? 'default' : undefined);
          if (nombre) {
            porNombre.set(nombre, st);
            if (llevaExport(st)) exportadas.add(nombre);
          }
        }
        // `const f = async (…) => …` y `const f = async function (…) {…}`, exportadas o no.
        if (ts.isVariableStatement(st)) {
          for (const d of st.declarationList.declarations) {
            // La desestructuración no se exporta como proyección —es la apertura guardada con
            // otro nombre, no una función con cuerpo—, así que entra en el mapa y no en la
            // lista de exportadas.
            for (const [local, origen] of aliasDesestructurados(d)) alias.set(local, origen);
            if (!ts.isIdentifier(d.name) || !d.initializer) continue;
            const valor = desenvolver(d.initializer);
            if (ts.isArrowFunction(valor) || ts.isFunctionExpression(valor)) {
              porNombre.set(d.name.text, valor);
              if (llevaExport(st)) exportadas.add(d.name.text);
              continue;
            }
            /*
             * Y si el valor es un IDENTIFICADOR, es un alias de otra cosa del módulo. Antes
             * aquí había un `continue` y por ahí se iba la proyección ENTERA: el alias no
             * tenía cuerpo, así que no entraba; y la original no llevaba `export`, así que
             * tampoco. Ninguno de los dos censos la veía.
             */
            const apunta = nombreAliasado(d.initializer);
            if (apunta !== undefined) {
              alias.set(d.name.text, apunta);
              if (llevaExport(st)) exportadas.add(d.name.text);
            }
          }
        }
        /*
         * `export { p }` y `export { interna as publica }`. El símbolo que hay que buscar es
         * el LOCAL, o sea `propertyName` cuando lo hay y `name` cuando no: con `name` a secas,
         * la renombrada no encuentra ningún cuerpo y se escapa igual que antes.
         *
         * `export { x } from './otro'` se salta a propósito: ahí no hay cuerpo en ESTE
         * fichero, y el censo lo verá en el suyo, donde sí está declarado.
         */
        if (
          ts.isExportDeclaration(st) &&
          !st.moduleSpecifier &&
          st.exportClause &&
          ts.isNamedExports(st.exportClause)
        ) {
          for (const el of st.exportClause.elements) exportadas.add((el.propertyName ?? el.name).text);
        }
        // `export default p`, y `export default async (…) => …` sin nombre por el que buscar.
        if (ts.isExportAssignment(st) && !st.isExportEquals) {
          const valor = desenvolver(st.expression);
          if (ts.isIdentifier(valor)) exportadas.add(valor.text);
          else if (ts.isArrowFunction(valor) || ts.isFunctionExpression(valor)) {
            porNombre.set('default', valor);
            exportadas.add('default');
          }
        }
      }

      /**
       * El cuerpo de un nombre, siguiendo la CADENA de alias —`const b = a; const c = b;`— con
       * los vistos apuntados: un ciclo dejaría el bucle colgado, y aunque hoy TypeScript no
       * deja escribir uno, la guarda no depende de eso.
       */
      const cuerpoDe = (inicial: string) => {
        const vistos = new Set<string>();
        let actual: string | undefined = inicial;
        while (actual !== undefined && !vistos.has(actual)) {
          vistos.add(actual);
          const cuerpo = porNombre.get(actual);
          if (cuerpo) return cuerpo;
          actual = alias.get(actual);
        }
        return undefined;
      };

      for (const nombre of exportadas) {
        const nodo = cuerpoDe(nombre);
        if (!nodo) continue;
        /*
         * TODAS las llamadas a `conUsuario` de esta función, no la primera. Cada una abre su
         * PROPIA transacción, y la escritura y el aislamiento son suyos, no de la función:
         * `abrirOutcomeReview` escribe en la primera y abre una SEGUNDA de solo lectura en el
         * `catch` —cuatro consultas cuyo resultado forma el mensaje—, y con un indicador
         * global el `insert into` de la primera dejaba a la segunda fuera del censo.
         */
        /*
         * Los ENVOLTORIOS locales de `conUsuario`: un ayudante que recibe el callback y se lo
         * reenvía —`conUsuarioTraduciendoElCommit(actorId, fn)` hace
         * `return await conUsuario(actorId, fn)` para traducir un error del commit—. Llamar a
         * uno abre una transacción igual, y su callback es el argumento que reenvía.
         *
         * Sin esto, seguir a los ayudantes llevaba al `conUsuario(actorId, fn)` de dentro,
         * donde `fn` es un PARÁMETRO y no hay función que mirar: las cuatro operaciones que lo
         * usan salían como «callback sin resolver». El envoltorio no es un caso raro, es un
         * patrón normal, y quien lo escribe no está escondiendo nada.
         */
        const envoltorios = new Map<string, { arg: number; nodo: TS.CallExpression }>();
        for (const [nom, fn] of porNombre) {
          if (
            !ts.isFunctionDeclaration(fn) &&
            !ts.isArrowFunction(fn) &&
            !ts.isFunctionExpression(fn)
          ) {
            continue;
          }
          const params = fn.parameters.map((pp) =>
            ts.isIdentifier(pp.name) ? pp.name.text : undefined,
          );
          let reenvia: number | undefined;
          let nodoInterior: TS.CallExpression | undefined;
          const mirar = (x: TS.Node) => {
            if (ts.isCallExpression(x) && esApertura(x)) {
              const a1 = x.arguments[1];
              if (a1 && ts.isIdentifier(a1)) {
                const k = params.indexOf(a1.text);
                if (k >= 0) {
                  reenvia = k;
                  nodoInterior = x;
                }
              }
            }
            ts.forEachChild(x, mirar);
          };
          ts.forEachChild(fn, mirar);
          if (reenvia !== undefined && nodoInterior) envoltorios.set(nom, { arg: reenvia, nodo: nodoInterior });
        }

        /** Cada transacción, con la posición del argumento que lleva su callback. */
        const llamadas: { nodo: TS.CallExpression; arg: number; abre: TS.CallExpression }[] = [];
        /*
         * Y se sigue a los AYUDANTES locales. Si la exportada delega —`return
         * cargarPanel(actorId)`— y es el ayudante quien abre la transacción, mirar solo el
         * nodo de la exportada encuentra CERO transacciones y la deja fuera del censo entera.
         * Es un refactor válido que producía un verde silencioso, y `porNombre` ya tenía el
         * ayudante: solo faltaba recorrerlo.
         *
         * Con protección de ciclos, que dos ayudantes pueden llamarse entre sí.
         */
        const vistos = new Set<TS.Node>([nodo]);
        const buscar = (n: TS.Node) => {
          if (ts.isCallExpression(n) && esApertura(n)) {
            llamadas.push({ nodo: n, arg: 1, abre: n });
          } else if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
            const envuelve = envoltorios.get(n.expression.text);
            if (envuelve !== undefined)
              llamadas.push({ nodo: n, arg: envuelve.arg, abre: envuelve.nodo });
            else {
              const destino = porNombre.get(n.expression.text);
              if (destino && !vistos.has(destino)) {
                vistos.add(destino);
                ts.forEachChild(destino, buscar);
              }
            }
          }
          ts.forEachChild(n, buscar);
        };
        ts.forEachChild(nodo, buscar);

        /**
         * La función que hace de callback, venga como venga: escrita ahí, envuelta en
         * `satisfies`/`as`/paréntesis, o pasada por NOMBRE —`conUsuario(actorId, leerPanel)`—.
         */
        const resolverFuncion = (n: TS.Expression): TS.Node | undefined => {
          const v = desenvolver(n);
          if (ts.isArrowFunction(v) || ts.isFunctionExpression(v)) return v;
          if (ts.isIdentifier(v)) return porNombre.get(v.text);
          return undefined;
        };

        llamadas.forEach(({ nodo: llamada, arg, abre }, i) => {
          alcanzadas.add(abre);
          const clave =
            llamadas.length > 1 ? `${ruta}:${nombre}#${i + 1}` : `${ruta}:${nombre}`;
          /*
           * El AISLAMIENTO se lee ANTES de intentar resolver el callback, y el orden importa:
           * `conUsuario(actorId, callbackImportado, { aislamiento: 'repeatable read' })` es
           * coherente —el tercer argumento garantiza una sola instantánea, lea lo que lea el
           * callback— y fallar cerrado sobre ella era un FALSO POSITIVO. Como toda entrada sin
           * declarar rompe el caso, sacar un callback correcto a otro módulo bastaba para
           * dejar el suite en rojo.
           *
           * Fallar cerrado está bien cuando no se sabe si hay problema; no cuando ya consta
           * que no lo hay.
           *
           * Las opciones van justo detrás del callback, sea cual sea su posición: en
           * `conUsuario` es la tercera, y en un envoltorio que no las reenvía no hay ninguna
           * — y entonces esa proyección NO puede fijar el aislamiento, que es la respuesta
           * correcta y no un descuido del censo.
           */
          const opciones = llamada.arguments[arg + 1];
          /*
           * El valor EFECTIVO, recorriendo las propiedades EN ORDEN, no un `some` que se
           * conforma con encontrar el literal en cualquier sitio.
           *
           * `{ aislamiento: 'repeatable read', ...opciones }` con
           * `opciones = { aislamiento: undefined }` es TypeScript válido —comprobado, compila
           * en modo estricto— y el spread SOBRESCRIBE: `conUsuario` recibe `undefined` y abre
           * en READ COMMITTED. Con el `some`, el censo veía el literal, daba la transacción
           * por declarada y la saltaba. La proyección volvía a mezclar instantáneas y aquí no
           * se enteraba nadie.
           *
           * Un spread posterior deja el valor DESCONOCIDO, no fijado: no se puede resolver
           * qué trae, así que no puede sostener una garantía. Uno ANTERIOR no estorba, porque
           * la asignación explícita que venga después gana.
           */
          type Aislamiento = 'fijado' | 'sin fijar' | 'desconocido';
          const nombreDe = (prop: TS.ObjectLiteralElementLike): string | undefined => {
            if (!prop.name) return undefined;
            if (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) return prop.name.text;
            // Un nombre COMPUTADO se resuelve solo si es un literal de cadena: `['aislamiento']`
            // es la misma clave escrita de otra forma, y ahí consta lo que dice.
            if (ts.isComputedPropertyName(prop.name) && ts.isStringLiteralLike(prop.name.expression))
              return prop.name.expression.text;
            return undefined;
          };
          let efectivo: Aislamiento = 'sin fijar';
          if (opciones && ts.isObjectLiteralExpression(opciones)) {
            for (const prop of opciones.properties) {
              /*
               * Un nombre que NO se resuelve invalida igual que un spread, y por el mismo
               * motivo: `{ aislamiento: 'repeatable read', ['aisla' + 'miento']: undefined }`
               * es TypeScript válido y deja la clave en `undefined`, o sea READ COMMITTED.
               * Mirando solo identificadores y cadenas, esa segunda propiedad no existía y la
               * transacción se daba por declarada.
               *
               * Es la MISMA lección por cuarta vez en este censo: preguntar si algo APARECE no
               * es preguntar qué VALE. Aquí la forma que faltaba era que la clave se escribiera
               * de una manera que el censo no sabía leer.
               */
              if (ts.isSpreadAssignment(prop)) {
                efectivo = 'desconocido';
                continue;
              }
              const nombre = nombreDe(prop);
              if (nombre === undefined) {
                efectivo = 'desconocido';
              } else if (nombre === 'aislamiento') {
                efectivo =
                  ts.isPropertyAssignment(prop) &&
                  ts.isStringLiteral(prop.initializer) &&
                  prop.initializer.text === 'repeatable read'
                    ? 'fijado'
                    : 'desconocido';
              }
            }
          }
          const fijaAislamiento = efectivo === 'fijado';
          if (fijaAislamiento) return;

          const bruto = llamada.arguments[arg];
          const callback = bruto ? resolverFuncion(bruto) : undefined;
          const tx = callback ? primerParametro(callback) : undefined;
          if (!callback || !tx) {
            /*
             * FALLA CERRADO. Antes esto era un `return` silencioso, y por ahí se colaba una
             * transacción entera: bastaba pasar el callback por nombre para que
             * `primerParametro` recibiera un `Identifier`, devolviera `undefined` y el censo
             * la descartara sin mirarla. Un guardián que se calla cuando no entiende algo es
             * peor que uno que no existe, porque parece que cubre.
             *
             * Si no se puede resolver, se NOMBRA. Que quien lo lea decida: o lo hace
             * resoluble, o lo declara con su motivo.
             */
            nombradas.push(`${clave} (callback sin resolver)`);
            return;
          }

          const { sentencias, escribe, desconocido } = analizar(callback, tx);

          // Con varias transacciones en la misma función, la clave dice CUÁL. El aislamiento
          // ya se comprobó arriba: si estuviera fijado, no se llegaría hasta aquí — y dejarlo
          // en esta condición sería una comprobación que no puede ser falsa, o sea ruido que
          // el día de mañana hace creer que aquí se decide algo.
          /*
           * Y un recuento DESCONOCIDO cuenta como varias: si no se sabe cuántas consultas
           * ejecuta el ayudante importado, no se puede afirmar que sea una sola, y una
           * afirmación que no se puede sostener no exime de nada.
           */
          if ((sentencias >= 2 || desconocido) && !escribe) {
            nombradas.push(desconocido && sentencias < 2 ? `${clave} (ayudante sin resolver)` : clave);
          }
        });
      }
      /*
       * Y el CIERRE: toda llamada a `conUsuario` del fichero tiene que haber sido analizada.
       * Una que no lo fue es una proyección que salió del módulo por una puerta que el censo
       * no conoce, y el silencio es exactamente su forma de fallar.
       */
      const todas: TS.CallExpression[] = [];
      const recogerLlamadas = (n: TS.Node) => {
        if (ts.isCallExpression(n) && esApertura(n)) todas.push(n);
        ts.forEachChild(n, recogerLlamadas);
      };
      ts.forEachChild(fuente, recogerLlamadas);
      todas.forEach((c, i) => {
        if (!alcanzadas.has(c)) nombradas.push(`${ruta}:conUsuario#${i + 1} (sin alcanzar)`);
      });

      return nombradas;
    };

    /*
     * Primero el censo contra SÍ MISMO. Cada sonda es una proyección de solo lectura con dos
     * sentencias y sin aislamiento —o sea, culpable— que se exporta de una forma distinta. Si
     * el censo no reconoce esa forma, la sonda no sale y aquí se ve.
     *
     * Las tres últimas son el hallazgo: `exportadas` se llenaba solo con el modificador
     * `export` de la propia declaración, así que una proyección declarada aparte y exportada
     * después quedaba fuera del censo ENTERA. `porNombre` sí la tenía —por eso el ayudante se
     * podía expandir— pero nadie la recorría. Comprobado: de las cuatro, el censo anterior
     * solo veía `visible`.
     *
     * Y las seguras, que son la otra mitad: una que fija el aislamiento, una que escribe y una
     * de una sola sentencia. Un censo que nombra lo correcto se acaba desactivando.
     */
    const cuerpo = (nombre: string) => `const ${nombre} = async (actorId: string) =>
      conUsuario(actorId, async (tx) => {
        const [a] = await tx\`select 1 as x\`;
        const [b] = await tx\`select 2 as y\`;
        return { a, b };
      });`;
    const FUENTE_SONDA = `
      import { leerDosAjenas, leerUnaAjena, ajenoQueAnidaYEscribe, ajenoQueAnidaPorAlias } from '@/lib/sonda/ayudante';
      import { conUsuario as conActor } from '@/lib/db';
      import { leerDeModuloAusente } from '@/lib/sonda/no-existe';
      ${cuerpo('sondaModificador').replace('const sondaModificador', 'export const sondaModificador')}
      ${cuerpo('sondaClausula')}
      export { sondaClausula };
      ${cuerpo('sondaInterna')}
      export { sondaInterna as sondaRenombrada };
      ${cuerpo('sondaDefecto')}
      export default sondaDefecto;
      export const sondaOkAislada = async (actorId: string) =>
        conUsuario(actorId, async (tx) => {
          const [a] = await tx\`select 1 as x\`;
          const [b] = await tx\`select 2 as y\`;
          return { a, b };
        }, { aislamiento: 'repeatable read' });
      const sondaOkEscribe = async (actorId: string) =>
        conUsuario(actorId, async (tx) => {
          const [a] = await tx\`insert into t (x) values (1) returning x\`;
          const [b] = await tx\`select 2 as y\`;
          return { a, b };
        });
      export { sondaOkEscribe };
      const sondaOkUna = async (actorId: string) =>
        conUsuario(actorId, async (tx) => {
          const [a] = await tx\`select 1 as x\`;
          return { a };
        });
      export { sondaOkUna };
      // La exportada DELEGA y es el ayudante quien abre la transacción. Mirando solo el nodo
      // de la exportada salen cero transacciones y se escapa entera.
      const abridorLocal = async (actorId: string) =>
        conUsuario(actorId, async (tx) => {
          const [a] = await tx\`select 1 as x\`;
          const [b] = await tx\`select 2 as y\`;
          return { a, b };
        });
      export const sondaDelega = async (actorId: string) => abridorLocal(actorId);
      // El callback pasado por NOMBRE. Antes devolvía \`undefined\` y se descartaba en silencio.
      const leerPanel = async (tx: TransactionSql) => {
        const [a] = await tx\`select 1 as x\`;
        const [b] = await tx\`select 2 as y\`;
        return { a, b };
      };
      export const sondaPorNombre = async (actorId: string) => conUsuario(actorId, leerPanel);
      // Un ENVOLTORIO local que reenvía el callback: llamarlo abre transacción igual.
      const envolver = async (actorId: string, fn: (tx: TransactionSql) => Promise<unknown>) =>
        conUsuario(actorId, fn);
      export const sondaEnvuelta = async (actorId: string) =>
        envolver(actorId, async (tx) => {
          const [a] = await tx\`select 1 as x\`;
          const [b] = await tx\`select 2 as y\`;
          return { a, b };
        });
      // Un callback que NO se puede resolver: viene de otro módulo y aquí no hay cuerpo que
      // mirar. Tiene que salir NOMBRADO, no descartado en silencio — es la mitad que hace que
      // el censo falle cerrado, y sin esta sonda esa rama no la ejercitaba nada.
      export const sondaImportada = async (actorId: string) =>
        conUsuario(actorId, leerDeOtroModulo);
      // Y el MISMO callback irresoluble, pero con el aislamiento fijado: el tercer argumento
      // garantiza una sola instantánea lea lo que lea, así que NO puede salir nombrada.
      // Fallar cerrado vale cuando no se sabe si hay problema, no cuando consta que no lo hay.
      export const sondaOkImportadaAislada = async (actorId: string) =>
        conUsuario(actorId, leerDeOtroModulo, { aislamiento: 'repeatable read' });
      // El SPREAD que sobrescribe: el literal está, pero lo que llega a \`conUsuario\` es lo que
      // traiga el spread. Un \`some\` veía la palabra y daba la transacción por declarada.
      export const sondaSpread = async (actorId: string, opciones: { aislamiento?: 'repeatable read' }) =>
        conUsuario(
          actorId,
          async (tx) => {
            const [a] = await tx\`select 1 as x\`;
            const [b] = await tx\`select 2 as y\`;
            return { a, b };
          },
          { aislamiento: 'repeatable read', ...opciones },
        );
      // Y la forma que SÍ vale: el spread va ANTES, así que la asignación explícita gana.
      export const sondaOkSpreadAntes = async (actorId: string, opciones: { aislamiento?: 'repeatable read' }) =>
        conUsuario(
          actorId,
          async (tx) => {
            const [a] = await tx\`select 1 as x\`;
            const [b] = await tx\`select 2 as y\`;
            return { a, b };
          },
          { ...opciones, aislamiento: 'repeatable read' },
        );
      // Un nombre COMPUTADO detrás del literal. \`['aisla' + 'miento']\` es la misma clave y
      // la deja en \`undefined\`, pero mirando solo identificadores y cadenas no se ve: el
      // censo daba la transacción por declarada y la saltaba entera.
      export const sondaComputada = async (actorId: string) =>
        conUsuario(
          actorId,
          async (tx) => {
            const [a] = await tx\`select 1 as x\`;
            const [b] = await tx\`select 2 as y\`;
            return { a, b };
          },
          { aislamiento: 'repeatable read', ['aisla' + 'miento']: undefined },
        );
      // Y la computada que SÍ se resuelve: un literal de cadena es la misma clave escrita de
      // otra forma, y fallar cerrado no vale cuando consta lo que dice.
      export const sondaOkComputadaLiteral = async (actorId: string) =>
        conUsuario(
          actorId,
          async (tx) => {
            const [a] = await tx\`select 1 as x\`;
            const [b] = await tx\`select 2 as y\`;
            return { a, b };
          },
          { ['aislamiento']: 'repeatable read' },
        );
      // Una proyección de SOLO LECTURA con la palabra de escritura dentro de un COMENTARIO.
      // Postgres solo ejecuta el select; el censo la daba por escritora y la eximía.
      export const sondaComentarioEscritura = async (actorId: string) =>
        conUsuario(actorId, async (tx) => {
          const [a] = await tx\`select 1 as x -- insert into temporal\`;
          const [b] = await tx\`select 2 as y\`;
          return { a, b };
        });
      // Y dentro de un literal POR DÓLAR, que es la tercera forma de escribir un dato.
      export const sondaDolarEscritura = async (actorId: string) =>
        conUsuario(actorId, async (tx) => {
          const [a] = await tx\`select $$insert into temporal$$ as texto\`;
          const [b] = await tx\`select 2 as y\`;
          return { a, b };
        });
      // Y una que SÍ escribe, con la escritura DETRÁS de un dólar seguido de interpolación:
      // \`$\${n}\` es un dólar literal más una interpolación, no un entrecomillado por dólar.
      // Tomarlo por literal vaciaría hasta el final y la haría parecer de solo lectura.
      const sondaOkDolarInterpolado = async (actorId: string, n: number) =>
        conUsuario(actorId, async (tx) => {
          const [a] = await tx\`with a as (select $\${n}) insert into t select * from a returning x\`;
          const [b] = await tx\`select 2 as y\`;
          return { a, b };
        });
      export { sondaOkDolarInterpolado };
      // La exportada es un ALIAS de una función local: el inicializador es un Identifier, no
      // una flecha, así que ni el alias ni la original entraban en el censo.
      const leerPanelAliasado = async (actorId: string) =>
        conUsuario(actorId, async (tx) => {
          const [a] = await tx\`select 1 as x\`;
          const [b] = await tx\`select 2 as y\`;
          return { a, b };
        });
      export const sondaAlias = leerPanelAliasado;
      // Y el alias de un alias, que es lo que exige resolver en CADENA y no un salto.
      const aliasIntermedio = leerPanelAliasado;
      export const sondaAliasDoble = aliasIntermedio;
      // Dos formas de exportar que el censo NO conoce, y que el cierre por alcance caza sin
      // saber nada de ellas: dentro de un objeto y por desestructuración. Salen nombradas por
      // su posición, no por su nombre, que es lo único que se puede decir de algo que no se
      // supo leer.
      const leerPanelObjeto = async (actorId: string) =>
        conUsuario(actorId, async (tx) => {
          const [a] = await tx\`select 1 as x\`;
          const [b] = await tx\`select 2 as y\`;
          return { a, b };
        });
      export const apiSonda = { panel: leerPanelObjeto };
      const leerPanelDes = async (actorId: string) =>
        conUsuario(actorId, async (tx) => {
          const [a] = await tx\`select 1 as x\`;
          const [b] = await tx\`select 2 as y\`;
          return { a, b };
        });
      export const { sondaDesestructurada } = { sondaDesestructurada: leerPanelDes };
      // Un ayudante de OTRO módulo que ejecuta DOS consultas. Contando uno —el techo
      // optimista— esta proyección salía con una sentencia y se escapaba entera.
      export const sondaAyudanteAjeno = async (actorId: string) =>
        conUsuario(actorId, async (tx) => leerDosAjenas(tx));
      // Y el mismo camino con UNA sola: fallar cerrado sobre ella sería un falso positivo.
      export const sondaOkAyudanteAjeno = async (actorId: string) =>
        conUsuario(actorId, async (tx) => leerUnaAjena(tx));
      // Y uno cuyo módulo no se puede leer: ahí SÍ falla cerrado, con el motivo en el nombre.
      export const sondaAyudanteIlegible = async (actorId: string) =>
        conUsuario(actorId, async (tx) => leerDeModuloAusente(tx));
      // Una plantilla NORMAL —un mensaje de error— que menciona una escritura. No la ejecuta
      // nadie, así que no puede eximir a la transacción de fijar el aislamiento.
      export const sondaMensajeEscritura = async (actorId: string, tabla: string) =>
        conUsuario(actorId, async (tx) => {
          const [a] = await tx\`select 1 as x\`;
          const [b] = await tx\`select 2 as y\`;
          if (!a) throw new Error(\`No se pudo hacer insert into \${tabla}\`);
          return { a, b };
        });
      // Y la escritura por \`unsafe\`, que SÍ se ejecuta y sí exime.
      const sondaOkUnsafe = async (actorId: string) =>
        conUsuario(actorId, async (tx) => {
          const [a] = await tx.unsafe("insert into t (x) values (1) returning x");
          const [b] = await tx\`select 2 as y\`;
          return { a, b };
        });
      export { sondaOkUnsafe };
      // Y la misma anidada, pero abierta por un ALIAS declarado en el modulo AJENO. El
      // predicado tiene que viajar con la tabla: cerrado sobre los alias del modulo que
      // llama, no reconoce el alias del que se analiza y no corta.
      export const sondaAjenoQueAnidaPorAlias = async (actorId: string) =>
        conUsuario(actorId, async (tx) => {
          const [a] = await tx\`select 1 as x\`;
          const c = await ajenoQueAnidaPorAlias(tx);
          return { a, c };
        });
      // El alias de IMPORTACION: renombrar al importar es tan alias como declararlo con const,
      // y ademas escapaba de las DOS listas —la que busca y el cierre por alcance— porque las
      // dos usan el mismo predicado.
      export const sondaAliasImportado = async (actorId: string) =>
        conActor(actorId, async (tx) => {
          const [a] = await tx\`select 1 as x\`;
          const [b] = await tx\`select 2 as y\`;
          return { a, b };
        });
      // Cruzar modulo Y anidar a la vez, la combinacion que no tenia sonda. El ayudante ajeno
      // abre SU transaccion y escribe en ella, y su callback llama tx a la suya igual que el de
      // fuera: por eso no se pueden distinguir por el nombre de la etiqueta y el CORTE es lo
      // unico que las separa.
      //
      // El valor del ayudante se USA a proposito: una sentencia cuyo valor se tira es una
      // puerta y no cuenta. Escrita sin usarlo, la sonda pasaba en verde sin probar nada.
      export const sondaAjenoQueAnida = async (actorId: string) =>
        conUsuario(actorId, async (tx) => {
          const [a] = await tx\`select 1 as x\`;
          const c = await ajenoQueAnidaYEscribe(tx);
          return { a, c };
        });
      // Una transacción ANIDADA abierta por una forma que no es el nombre desnudo. Sus
      // consultas no son de la exterior, y su escritura no puede eximir a la exterior.
      export const sondaAnidadaPorPropiedad = async (actorId: string) =>
        conUsuario(actorId, async (tx) => {
          const [a] = await tx\`select 1 as x\`;
          const [b] = await tx\`select 2 as y\`;
          await db.conUsuario(actorId, async (tx) => tx\`insert into t (x) values (1)\`);
          return { a, b };
        });
      // La llamada por PROPIEDAD, que es como queda conUsuario con un import de espacio.
      export const sondaPropiedad = async (actorId: string) =>
        db.conUsuario(actorId, async (tx) => {
          const [a] = await tx\`select 1 as x\`;
          const [b] = await tx\`select 2 as y\`;
          return { a, b };
        });
      // Y la propia función guardada en otro nombre.
      const abrir = conUsuario;
      export const sondaIndirecta = async (actorId: string) =>
        abrir(actorId, async (tx) => {
          const [a] = await tx\`select 1 as x\`;
          const [b] = await tx\`select 2 as y\`;
          return { a, b };
        });
      // Y guardada desde el ESPACIO DE NOMBRES. La llamada directa \`db.conUsuario(…)\` ya se
      // reconocía; guardarla primero y llamarla después, no — y las dos listas preguntan lo
      // mismo, así que la proyección se caía del censo y del cierre a la vez.
      const abrirProp = db.conUsuario;
      export const sondaIndirectaPorPropiedad = async (actorId: string) =>
        abrirProp(actorId, async (tx) => {
          const [a] = await tx\`select 1 as x\`;
          const [b] = await tx\`select 2 as y\`;
          return { a, b };
        });
      // Y por DESESTRUCTURACIÓN, la tercera forma de guardarse la apertura: aquí el nombre
      // está en el patrón y el inicializador no dice nada.
      const { conUsuario: abrirDes } = db;
      export const sondaIndirectaPorDesestructuracion = async (actorId: string) =>
        abrirDes(actorId, async (tx) => {
          const [a] = await tx\`select 1 as x\`;
          const [b] = await tx\`select 2 as y\`;
          return { a, b };
        });
      // Y el símbolo de la TRANSACCIÓN guardado en otro nombre dentro del callback, que es un
      // refactor sin consecuencias y dejaba el recuento en cero.
      export const sondaTxAliasada = async (actorId: string) =>
        conUsuario(actorId, async (db) => {
          const tx = db;
          const [a] = await tx\`select 1 as x\`;
          const [b] = await tx\`select 2 as y\`;
          return { a, b };
        });
      // Y la misma indirección para una ESCRITORA, que es la dirección contraria: sin seguir
      // el alias, su \`insert\` no se veía y salía nombrada siendo correcta.
      const sondaOkTxAliasadaEscribe = async (actorId: string) =>
        conUsuario(actorId, async (db) => {
          const tx = db;
          const [a] = await tx\`insert into t (x) values (1) returning x\`;
          const [b] = await tx\`select 2 as y\`;
          return { a, b };
        });
      export { sondaOkTxAliasadaEscribe };
      // Un identificador ENTRE COMILLAS DOBLES: en SQL es un NOMBRE, no un dato, pero tampoco
      // es una sentencia de escritura.
      export const sondaIdentificador = async (actorId: string) =>
        conUsuario(actorId, async (tx) => {
          const [a] = await tx\`select 1 as "insert into temporal"\`;
          const [b] = await tx\`select 2 as y\`;
          return { a, b };
        });
      // Y la cadena con prefijo E, que escapa con BARRA y no duplicando la comilla.
      export const sondaCadenaE = async (actorId: string) =>
        conUsuario(actorId, async (tx) => {
          const [a] = await tx\`select E'a\\' insert into temporal --' as x\`;
          const [b] = await tx\`select 2 as y\`;
          return { a, b };
        });
      // Y lo mismo dentro de un LITERAL, que tampoco se ejecuta.
      export const sondaLiteralEscritura = async (actorId: string) =>
        conUsuario(actorId, async (tx) => {
          const [a] = await tx\`select 1 as x where nombre = 'insert into temporal'\`;
          const [b] = await tx\`select 2 as y\`;
          return { a, b };
        });
      // La transacción no se llama siempre \`tx\`: el símbolo sale del parámetro del
      // callback. Con la cadena fija, renombrarlo no contaba NI UNA consulta.
      export const sondaRenombrada2 = async (actorId: string) =>
        conUsuario(actorId, async (db) => {
          const [a] = await db\`select 1 as x\`;
          const [b] = await db\`select 2 as y\`;
          return { a, b };
        });
      // Un valor envuelto sigue siendo una función: \`satisfies\`, \`as\` y los paréntesis no
      // cambian nada y la descartaban entera.
      export const sondaSatisfies = (async (actorId: string) =>
        conUsuario(actorId, async (tx) => {
          const [a] = await tx\`select 1 as x\`;
          const [b] = await tx\`select 2 as y\`;
          return { a, b };
        })) satisfies (actorId: string) => Promise<unknown>;
      // DOS transacciones en la misma función: la primera escribe, la segunda solo lee. Con
      // un indicador global, el \`insert\` de la primera tapaba a la segunda.
      export const sondaDosTx = async (actorId: string) => {
        try {
          return await conUsuario(actorId, async (tx) => {
            const [a] = await tx\`insert into t (x) values (1) returning x\`;
            const [b] = await tx\`select 2 as y\`;
            return { a, b };
          });
        } catch {
          return conUsuario(actorId, async (tx) => {
            const [a] = await tx\`select 3 as x\`;
            const [b] = await tx\`select 4 as y\`;
            return { a, b };
          });
        }
      };
    `;
    /*
     * La `default` ANÓNIMA va en su propia fuente: solo cabe un `export default` por módulo.
     * Llega como `FunctionDeclaration` sin nombre —comprobado con el parser— y el censo la
     * descartaba antes de mirarla siquiera.
     */
    const FUENTE_SONDA_ANONIMA = `
      export default async function (actorId: string) {
        return conUsuario(actorId, async (tx) => {
          const [a] = await tx\`select 1 as x\`;
          const [b] = await tx\`select 2 as y\`;
          return { a, b };
        });
      }
    `;
    /*
     * Un módulo AJENO fabricado, para que el seguimiento entre módulos tenga qué seguir. Sin
     * él las dos sondas del ayudante ajeno saldrían nombradas por desconocimiento y no se
     * distinguiría resolverlo de fallar cerrado, que son las dos mitades que hay que probar.
     */
    fuentesDelRepo.set(
      'sonda/ayudante.ts',
      `export const leerDosAjenas = async (tx: TransactionSql) => {
         const [a] = await tx\`select 1 as x\`;
         const [b] = await tx\`select 2 as y\`;
         return { a, b };
       };
       export const leerUnaAjena = async (tx: TransactionSql) => {
         const [a] = await tx\`select 1 as x\`;
         return a;
       };
       const abrirAjeno = conUsuario;
       export const ajenoQueAnidaPorAlias = async (tx: TransactionSql) => {
         const [a] = await tx\`select 1 as x\`;
         await abrirAjeno('otro', async (tx) => tx\`insert into t (x) values (1)\`);
         return a;
       };
       export const ajenoQueAnidaYEscribe = async (tx: TransactionSql) => {
         const [a] = await tx\`select 1 as x\`;
         await conUsuario('otro', async (tx) => tx\`insert into t (x) values (1)\`);
         return a;
       };`,
    );

    expect(censar('anon.ts', FUENTE_SONDA_ANONIMA)).toEqual(['anon.ts:default']);

    expect(censar('sonda.ts', FUENTE_SONDA).sort()).toEqual(
      [
        'sonda.ts:sondaModificador',
        'sonda.ts:sondaClausula',
        // `export { interna as publica }`: lo que hay que buscar es el símbolo LOCAL, que es
        // `propertyName` y no `name`. Buscando `name` no se encuentra ningún cuerpo.
        'sonda.ts:sondaInterna',
        'sonda.ts:sondaDefecto',
        'sonda.ts:sondaRenombrada2',
        'sonda.ts:sondaSatisfies',
        // La SEGUNDA de las dos transacciones: la primera escribe y queda fuera, como debe.
        // El sufijo dice cuál, que con varias en la misma función hace falta.
        'sonda.ts:sondaDosTx#2',
        'sonda.ts:sondaDelega',
        'sonda.ts:sondaPorNombre',
        'sonda.ts:sondaEnvuelta',
        'sonda.ts:sondaImportada (callback sin resolver)',
        'sonda.ts:sondaSpread',
        'sonda.ts:sondaComputada',
        'sonda.ts:sondaComentarioEscritura',
        'sonda.ts:sondaLiteralEscritura',
        'sonda.ts:sondaDolarEscritura',
        'sonda.ts:sondaIdentificador',
        'sonda.ts:sondaCadenaE',
        'sonda.ts:sondaAlias',
        'sonda.ts:sondaAliasDoble',
        'sonda.ts:sondaPropiedad',
        'sonda.ts:sondaIndirecta',
        'sonda.ts:sondaIndirectaPorPropiedad',
        'sonda.ts:sondaIndirectaPorDesestructuracion',
        'sonda.ts:sondaTxAliasada',
        'sonda.ts:sondaAyudanteAjeno',
        'sonda.ts:sondaMensajeEscritura',
        'sonda.ts:sondaAjenoQueAnida',
        'sonda.ts:sondaAjenoQueAnidaPorAlias',
        'sonda.ts:sondaAliasImportado',
        // Con el corte puesto, la anidada cuenta como transacción PROPIA: por eso la exterior
        // lleva sufijo. La interior escribe y no sale, que es lo correcto.
        'sonda.ts:sondaAnidadaPorPropiedad#1',
        'sonda.ts:sondaAyudanteIlegible (ayudante sin resolver)',
        // Las dos que el censo no sabe leer: las caza el cierre por ALCANCE, no la lista de
        // puertas. Se nombran por posición porque de algo ilegible no se puede decir más.
        'sonda.ts:conUsuario#21 (sin alcanzar)',
        'sonda.ts:conUsuario#22 (sin alcanzar)',
      ].sort(),
    );

    // Y ahora las reales.
    const nombradasReales: string[] = [];
    // Todas las fuentes ANTES de censar ninguna: seguir a un ayudante importado exige tener
    // el módulo que lo exporta, y el orden del recorrido no lo garantiza.
    for (const f of ficheros) fuentesDelRepo.set(f.slice(raiz.length), await readFile(f, 'utf8'));
    for (const f of ficheros) {
      nombradasReales.push(...censar(f.slice(raiz.length), fuentesDelRepo.get(f.slice(raiz.length))!));
    }
    expect(nombradasReales.filter((c) => !(c in DECLARADAS)).sort()).toEqual([]);
    /*
     * Y ninguna excepción de más. Una entrada que el censo NO nombra no está exceptuando
     * nada: está esperando en silencio a callar el día que la proyección deje de cumplir.
     * Comprobado que esta comprobación comprueba: `ejecutarDisposicion` sí se consume —el
     * censo la nombra al vaciar la lista—, y `exportarWorkspace` no se consumía, que es por
     * lo que ya no está.
     */
    expect(Object.keys(DECLARADAS).filter((c) => !nombradasReales.includes(c)).sort()).toEqual(
      [],
    );
  });

  it('el panel se lee de UNA instantánea: sus campos no vienen de dos momentos', async () => {
    /*
     * El panel son cuatro lecturas —cuenta, acuerdo, constancia y motivo—. Bajo READ
     * COMMITTED cada sentencia toma su propia instantánea, así que un acuerdo registrado por
     * otra persona a mitad de camino partía la pantalla en dos: el acuerdo #1 arriba, y el
     * motivo y la constancia del #2 debajo.
     *
     * Lo que produce no es un borrado indebido —la versión esperada viaja y la función la
     * rechaza, así que falla cerrado— sino un recibo enseñado junto al acuerdo que no le
     * corresponde y un botón gobernado por un motivo que no es el del acuerdo que se mira.
     * Para la pantalla desde la que alguien decide un borrado irreversible, eso es el fallo:
     * lo que ve delante no describe ningún estado que haya existido.
     *
     * SOBRE LO QUE ESTE CASO CUBRE Y LO QUE NO, que conviene decirlo en vez de sugerir más:
     * la carrera no se puede fabricar contra `panelDisposicion` desde fuera. Lo intenté con un
     * `lock table` sobre `constancia_disposicion` —la tabla que leen sus sentencias tercera y
     * cuarta— para pararlo a medio camino, y no sirve: registrar el acuerdo que provoca la
     * carrera TAMBIÉN lee esa tabla (el guard de congelación pregunta por `workspace_borrado`),
     * así que el escritor se bloquea con él y no hay interleaving. Medido con
     * `pg_stat_activity`: las dos sesiones esperando en `Lock/relation`.
     *
     * Así que se comprueban las dos mitades por separado, y juntas cubren la afirmación:
     *  · que el aislamiento es lo que hace coherentes ESAS lecturas, con las mismas sentencias
     *    del panel y un commit real por medio, a los dos niveles;
     *  · y que el panel pide ese aislamiento, leído de su propio código.
     */
    const ws = await nuevoWorkspace('instantanea');
    await registrarAcuerdo(adminId, {
      workspaceId: ws,
      modalidad: 'archivo',
      base: 'Acuerdo primero',
      efectivoDesde: EFECTIVO_PASADO,
    });

    /** Las dos lecturas del panel que pueden discrepar, con un commit ajeno en medio. */
    async function leerConAcuerdoNuevoEnMedio(aislamiento?: 'repeatable read') {
      return conUsuario(
        leadId,
        async (tx) => {
          const [antes] = await tx`select version from acuerdo_disposicion
            where workspace_id = ${ws} order by version desc limit 1`;
          // Otra parte registra un acuerdo y lo CONFIRMA mientras esta transacción vive.
          await registrarAcuerdo(leadId, {
            workspaceId: ws,
            modalidad: 'borrado',
            base: `Acuerdo ${(antes!.version as number) + 1}`,
            efectivoDesde: EFECTIVO_PASADO,
          });
          const [despues] = await tx`select version from acuerdo_disposicion
            where workspace_id = ${ws} order by version desc limit 1`;
          return { antes: antes!.version as number, despues: despues!.version as number };
        },
        aislamiento ? { aislamiento } : undefined,
      );
    }

    // READ COMMITTED: la segunda lectura ve un acuerdo que la primera no veía. Es exactamente
    // la grieta por la que el panel enseñaba dos momentos a la vez.
    const rc = await leerConAcuerdoNuevoEnMedio();
    expect(rc.despues).toBe(rc.antes + 1);

    // REPEATABLE READ: la instantánea queda fija en la primera sentencia, así que las dos
    // lecturas describen el mismo momento aunque el acuerdo nuevo ya esté confirmado.
    const rr = await leerConAcuerdoNuevoEnMedio('repeatable read');
    expect(rr.despues).toBe(rr.antes);

    // Que el panel y la auditoría PIDAN esa instantánea lo comprueba el censo de la clase,
    // arriba: al quitarles la opción salen nombradas. Aquí había dos lecturas del código
    // fuente que hacían lo mismo peor —atadas a un nombre de función y a un `indexOf`—, y con
    // el censo cubriendo las siete proyecciones sobran.
  });

  it('la retención se mide con un calendario FIJO, y no con el huso que elige quien llama', async () => {
    /*
     * `current_date` no es una fecha: es una fecha EN EL HUSO DE LA SESIÓN, y el huso lo pone
     * quien llama con `SET LOCAL TIME ZONE`. La puerta de la retención está dentro del
     * `GRANT EXECUTE` a `designio_app`, y `SECURITY DEFINER` presta los privilegios del
     * dueño pero NO le devuelve los parámetros de sesión al valor del servidor: solo lo que
     * la función fija en su propio `SET` (aquí, `search_path`) queda a salvo. Así que la
     * espera pactada —lo único que separa un borrado irreversible de un clic— se medía
     * contra un calendario que el que ejecuta elige.
     *
     * El caso se construye sin depender de la hora a la que corra: el mundo abarca a la vez
     * dos fechas del calendario —de UTC-12 a UTC+14 hay 26 horas—, así que la fecha del huso
     * más adelantado SIEMPRE es un día mayor que la del más atrasado. Se pacta la retención
     * en la fecha del huso adelantado, y entonces, sin fijar el calendario, la misma fila da
     * dos veredictos opuestos: para el huso atrasado la espera no ha vencido, y para el
     * adelantado sí — y con ella se destruye el workspace un día antes.
     */
    const ws = await nuevoWorkspace('husos');
    const [{ temprana, tardia }] = await conUsuario(leadId, async (tx) => {
      await tx.unsafe(`set local time zone 'Etc/GMT+12'`);
      const [a] = await tx`select current_date as d`;
      await tx.unsafe(`set local time zone 'Pacific/Kiritimati'`);
      const [b] = await tx`select current_date as d`;
      return [{ temprana: a!.d as Date, tardia: b!.d as Date }];
    });
    const fecha = (d: Date) => d.toISOString().slice(0, 10);
    // El supuesto sobre el que se apoya el caso, comprobado y no asumido.
    expect(fecha(tardia) > fecha(temprana)).toBe(true);

    await registrarAcuerdo(adminId, {
      workspaceId: ws,
      modalidad: 'borrado',
      base: 'Retención hasta el día pactado',
      efectivoDesde: fecha(tardia),
    });
    await exportarWorkspace(leadId, { workspaceId: ws, ambito: 'archivo' });

    // La misma pregunta, la misma fila, desde los dos extremos del calendario mundial.
    const veredictos: Record<string, string | null> = {};
    for (const huso of ['Etc/GMT+12', 'UTC', 'Pacific/Kiritimati']) {
      veredictos[huso] = await conUsuario(leadId, async (tx) => {
        await tx.unsafe(`set local time zone '${huso}'`);
        const [f] = await tx`select disposicion_motivo_no_ejecutable(${ws}) as motivo`;
        return f!.motivo as string | null;
      });
    }
    expect(veredictos['Etc/GMT+12']).toBe(veredictos['Pacific/Kiritimati']);
    expect(veredictos['UTC']).toBe(veredictos['Pacific/Kiritimati']);

    // Y lo que de verdad importa: el ACTO. Que el panel coincida no serviría de nada si la
    // ejecución siguiera midiendo con el huso de quien la pide, así que se intenta el
    // borrado desde el huso más adelantado y se exige que haga lo mismo que dice UTC.
    /*
     * El `try` va FUERA de `conUsuario`, y esto costó un fallo real: `sql.begin()` de
     * postgres.js RELANZA el error de la consulta aunque el callback lo capture —comprobado
     * con `select 1/0`: capturado dentro, y aun así escapa—, porque la transacción queda
     * abortada y el driver lo propaga al cerrar. Con el `try` dentro, la rama de rechazo de
     * este caso no podía pasar NUNCA.
     */
    const ejecutarDesde = (workspace: string, huso: string) =>
      conUsuario(leadId, async (tx) => {
        await tx.unsafe(`set local time zone '${huso}'`);
        await tx`select ejecutar_disposicion(${workspace}, 1)`;
        return null as string | null;
      }).catch((e) => (e as Error).message);
    const desdeElHusoAdelantado = await ejecutarDesde(ws, 'Pacific/Kiritimati');
    if (veredictos['UTC'] === null) {
      expect(desdeElHusoAdelantado).toBeNull();
    } else {
      expect(desdeElHusoAdelantado).toMatch(/retención/i);
      // El workspace sigue en pie: la espera pactada no se saltó cambiando de huso.
      const [quedan] = await sqlAdmin()`select count(*)::int as n from segmento
        where workspace_id = ${ws}`;
      expect(quedan!.n).toBe(1);
    }

    /*
     * Y la mitad que faltaba, que es el motivo de que un fallo real viviera aquí meses sin
     * que nada lo dijera: CUÁL de las dos ramas de arriba corre DEPENDE DE LA HORA.
     *
     * El huso más adelantado (UTC+14) solo va un día por delante de UTC a partir de las 10:00
     * UTC; antes de esa hora ningún huso del mundo tiene una fecha mayor que la de UTC —el
     * este se acaba en +14—. Así que antes de las 10:00 este caso ejercitaba la rama de
     * ÉXITO y después la de RECHAZO, y la de rechazo estaba rota: nunca corrió en CI.
     *
     * La afirmación de arriba sigue siendo la correcta —el acto tiene que coincidir con lo
     * que dice UTC, sea lo que sea—, pero la cobertura no puede depender de a qué hora se
     * lance el suite. Así que el rechazo se ejercita también con una fecha que NINGÚN huso
     * ha alcanzado: un día más allá del más adelantado. Ahí el veredicto es «falta» a todas
     * horas y en todos los husos, y el borrado tiene que negarse siempre.
     */
    const masAllaDeTodos = new Date(tardia);
    masAllaDeTodos.setUTCDate(masAllaDeTodos.getUTCDate() + 1);
    const ws2 = await nuevoWorkspace('husos-futuro');
    await registrarAcuerdo(adminId, {
      workspaceId: ws2,
      modalidad: 'borrado',
      base: 'Retención que no ha vencido en ningún huso',
      efectivoDesde: fecha(masAllaDeTodos),
    });
    await exportarWorkspace(leadId, { workspaceId: ws2, ambito: 'archivo' });
    expect(await ejecutarDesde(ws2, 'Pacific/Kiritimati')).toMatch(/retención/i);
    const [quedanFuturo] = await sqlAdmin()`select count(*)::int as n from segmento
      where workspace_id = ${ws2}`;
    expect(quedanFuturo!.n).toBe(1);
  });

  it('el límite de la referencia contractual acota lo que se GUARDA, no su versión recortada', async () => {
    /*
     * `length(btrim(base)) between 1 and 300` medía el valor recortado y dejaba pasar el
     * entero: `'x' || repeat(' ', 100000)` mide 1 y pesa cien mil (medido). `designio_app`
     * tiene INSERT por columna sobre `base`, así que el camino crudo no pasa por el `.trim()`
     * del esquema Zod.
     *
     * Y ese valor sin techo no se quedaba quieto: el guard lo COPIA al evento de dominio, y
     * `ejecutar_disposicion` lo copia otra vez a `constancia_disposicion.acuerdo_base`, que
     * entra en la carga canónica que se SELLA y viaja en la exportación. Un recibo que una
     * persona tiene que poder leer cuando ya no es miembro de nada no puede pesar lo que
     * quiera quien firmó el acuerdo.
     *
     * Se comprueban las dos mitades de la corrección por separado, porque se sostienen solas:
     * el guard NORMALIZA lo que entra, y el `CHECK` ACOTA lo que queda escrito por cualquier
     * otro camino —el guard es `before insert`, así que un `update` no lo cruza.
     */
    const ws = await nuevoWorkspace('base-larga');
    const cola = ' '.repeat(100_000);
    const ref = 'Cláusula 4.2 del MSA 2026-114';

    // (1) Por el camino que el hallazgo señala —SQL crudo con el rol de la aplicación, que
    // tiene INSERT por columna sobre `base` y no pasa por el `.trim()` del esquema— lo que
    // se guarda es la referencia normalizada: la cola no llega a la fila.
    await conUsuario(adminId, async (tx) => {
      await tx`insert into acuerdo_disposicion
        (workspace_id, modalidad, base, efectivo_desde, acordado_por)
        values (${ws}, 'archivo', ${ref + cola}, ${EFECTIVO_PASADO}, ${adminId})`;
    });
    const [g] = await sqlAdmin()`select base from acuerdo_disposicion
      where workspace_id = ${ws}`;
    expect(g!.base).toBe(ref);

    // Y el evento que el guard emitió repite EXACTAMENTE lo guardado, no lo que se envió:
    // es la copia que sobrevive al borrado, así que el techo tiene que alcanzarla.
    const [ev] = await sqlAdmin()`select payload->>'base' as base from evento_dominio
      where workspace_id = ${ws} and tipo = 'DisposicionAcordada'`;
    expect(ev!.base).toBe(ref);

    // (2) Y donde el guard NO normaliza —se retira ante quien no es miembro, que es el
    // camino de administración— el techo lo pone la columna, que ahora mide lo almacenado.
    await expect(
      sqlAdmin()`insert into acuerdo_disposicion
        (workspace_id, modalidad, base, efectivo_desde, acordado_por, version, acordado_rol)
        values (${ws}, 'archivo', ${ref + cola}, ${EFECTIVO_PASADO}, ${adminId}, 2,
                'admin-cliente')`,
    ).rejects.toThrow(/base_check/i);

    // Y el techo no puede haberse comido la otra mitad de lo que el `btrim` daba: una
    // referencia EN BLANCO mide cinco y está «entre 1 y 300», así que acotar solo la longitud
    // del valor almacenado la habría dejado entrar por este mismo camino.
    //
    // «En blanco» no es solo el espacio, y NO se comprueba con una lista escrita a mano: la
    // lista escrita a mano es cómo se perdió U+2007. Se DERIVA el conjunto que
    // `String.prototype.trim()` recorta —recorriendo el rango Unicode entero desde
    // JavaScript— y se exige que la base recorte exactamente ése, ni uno más ni uno menos.
    //
    // Medido: son 25 puntos de código (el WhiteSpace + LineTerminator de ECMAScript), y
    // `[[:space:]]` de Postgres cubre 21. Los cuatro que deja fuera son los «no separables»
    // —U+00A0, U+2007, U+202F y U+FEFF—, y yo había añadido tres a mano. Con la equivalencia
    // derivada, el cuarto no se pierde y una versión futura del lenguaje tampoco.
    const recortaJS: number[] = [];
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue; // sustitutos: no son caracteres
      if (String.fromCodePoint(cp).trim() === '') recortaJS.push(cp);
    }
    expect(recortaJS.length).toBeGreaterThan(20);
    const [base] = await sqlAdmin()`
      select coalesce(array_agg(i order by i), '{}') as cps
      from generate_series(1, 1114111) i
      where i not between 55296 and 57343 and texto_recortado(chr(i)) = ''`;
    expect(base!.cps).toEqual(recortaJS);

    // Y ninguno de ellos entra como referencia: miden más de cero y no dicen nada.
    for (const cp of recortaJS) {
      const blanco = String.fromCodePoint(cp).repeat(3);
      // Los saltos de línea los para el otro CHECK, con su propio motivo; el resto, éste.
      await expect(
        sqlAdmin()`insert into acuerdo_disposicion
          (workspace_id, modalidad, base, efectivo_desde, acordado_por, version, acordado_rol)
          values (${ws}, 'archivo', ${blanco}, ${EFECTIVO_PASADO}, ${adminId}, 2,
                  'admin-cliente')`,
        `una referencia hecha solo de U+${cp.toString(16).toUpperCase().padStart(4, '0')} entró como si dijera algo`,
      ).rejects.toThrow(/base_check/i);
    }

    // Y el guard los recorta igual que el esquema, por el camino de la aplicación: lo que se
    // guarda es lo mismo se llame desde donde se llame.
    const [ok] = await conUsuario(adminId, async (tx) => {
      return tx`insert into acuerdo_disposicion
        (workspace_id, modalidad, base, efectivo_desde, acordado_por)
        values (${ws}, 'archivo', ${'\u00a0\t Cláusula 9.1 \ufeff'}, ${EFECTIVO_PASADO},
                ${adminId})
        returning base`;
    });
    expect(ok!.base).toBe('Cláusula 9.1');

    // Y las dos capas cuentan el tope en la MISMA unidad. `length()` de Postgres cuenta
    // puntos de código y el `.length` de JavaScript cuenta unidades UTF-16, así que un
    // carácter astral vale uno para la base y dos para el esquema: 151 emoji medían 151 y
    // 302 (medido), el CHECK los aceptaba y Zod los rechazaba, y por SQL crudo entraba una
    // referencia contractual que la ruta normal no podía registrar.
    const astral = '😀';
    expect([...astral].length).toBe(1);
    expect(astral.length).toBe(2);
    const [medida] = await sqlAdmin()`select length(${astral.repeat(151)}) as n`;
    expect(medida!.n).toBe([...astral.repeat(151)].length);
    // El esquema rechaza lo que la base rechaza, contando igual: 301 puntos de código.
    expect(RegistrarAcuerdoSchema.safeParse({
      workspaceId: ws, modalidad: 'archivo', base: astral.repeat(301),
      efectivoDesde: EFECTIVO_PASADO,
    }).success).toBe(false);
    // Y acepta lo que la base acepta: 300 puntos de código, aunque sean 600 unidades UTF-16.
    const trescientos = astral.repeat(300);
    expect(RegistrarAcuerdoSchema.safeParse({
      workspaceId: ws, modalidad: 'archivo', base: trescientos,
      efectivoDesde: EFECTIVO_PASADO,
    }).success).toBe(true);
    await conUsuario(adminId, async (tx) => {
      await tx`insert into acuerdo_disposicion
        (workspace_id, modalidad, base, efectivo_desde, acordado_por)
        values (${ws}, 'archivo', ${trescientos}, ${EFECTIVO_PASADO}, ${adminId})`;
    });
  });
});
