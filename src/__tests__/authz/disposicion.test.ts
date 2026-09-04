import { afterAll, beforeAll, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { cerrarPools, conUsuario, sqlAdmin } from '@/lib/db';
import { exportarWorkspace } from '@/lib/exportacion/exportacion.servicio';
import { cargaCanonicaConstancia, jsonbTexto } from '@/lib/disposicion/disposicion.schemas';
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

    // Un miembro escribe en el libro con el payload que quiere, y se queda sin commitear.
    const enVuelo = conUsuario(leadId, async (tx) => {
      await tx`insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
        values (${ws}, 'AuthzTest', ${tx.json({ colado: 'texto elegido' })}::jsonb,
                ${leadId}, 'lead-boutique')`;
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

    // Lo que queda: el evento de la disposición y el que se coló. Ni uno más.
    const filas = await admin`select tipo from evento_dominio where workspace_id = ${ws}
      order by tipo`;
    expect(filas.map((f) => f.tipo)).toEqual(['AuthzTest', 'WorkspaceDispuesto']);

    // Y el tamaño de la ventana: una fila suelta y nada más. No devuelve acceso a lo
    // destruido —el resto del workspace sigue vacío— ni permite leerla, porque la RLS del
    // libro pide rol de miembro y el borrado destruyó la membresía.
    const [seg] = await admin`select count(*)::int as n from segmento where workspace_id = ${ws}`;
    expect(seg!.n).toBe(0);
    const suyas = await conUsuario(leadId, (tx) => tx`select id from evento_dominio
      where workspace_id = ${ws}`);
    expect(suyas.length).toBe(0);

    // Y el alcance sellado la declara, en vez de que el recibo prometa de más.
    expect(c.alcance).toContain('escribiendo en el libro de auditoría');
    expect(c.alcance).toContain('ventana declarada');
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
});
