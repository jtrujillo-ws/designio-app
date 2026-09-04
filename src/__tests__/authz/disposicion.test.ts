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
      efectivoDesde: new Date().toISOString().slice(0, 10),
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
    await ejecutarDisposicion(leadId, { workspaceId: ws, modalidadEsperada: 'archivo' });

    // El motivo lo da la MISMA función que usa el guard: la pantalla no puede ofrecer algo
    // que la base va a rechazar, ni esconder algo que sí correspondía.
    const panel = await panelDisposicion(leadId, ws);
    expect(panel.motivoNoEjecutable).toMatch(/ya se ejecutó/i);
    expect(panel.constanciaVigente).not.toBeNull();
    await expect(
      ejecutarDisposicion(leadId, { workspaceId: ws, modalidadEsperada: 'archivo' }),
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
      ejecutarDisposicion(adminId, { workspaceId: ws, modalidadEsperada: 'borrado' }),
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
      efectivoDesde: new Date().toISOString().slice(0, 10),
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
      efectivoDesde: new Date().toISOString().slice(0, 10),
    });
    // Y se vuelve a exportar, que es lo que deja a la BASE conforme con el acuerdo nuevo. Sin
    // este paso el caso se detendría igual pero por otro motivo —«la exportación es anterior
    // al acuerdo vigente»— y no probaría nada de esta comprobación: pasaría en verde con ella
    // retirada. Aquí lo único que separa a este workspace de ser destruido es que la modalidad
    // que se vio no es la que se ejecutaría.
    await exportarWorkspace(leadId, { workspaceId: ws, ambito: 'archivo' });
    expect((await panelDisposicion(leadId, ws)).motivoNoEjecutable).toBeNull();

    await expect(
      ejecutarDisposicion(leadId, { workspaceId: ws, modalidadEsperada: 'archivo' }),
    ).rejects.toThrow(/mientras mirabas/i);
    // Y el workspace sigue entero: no se ejecutó ninguna de las dos.
    const [seg] = await sqlAdmin()`select count(*)::int as n from segmento
      where workspace_id = ${ws}`;
    expect(seg!.n).toBe(1);
    // Confirmándolo: con la modalidad correcta sí se ejecuta, y entonces sí destruye.
    await ejecutarDisposicion(leadId, { workspaceId: ws, modalidadEsperada: 'borrado' });
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
      efectivoDesde: new Date().toISOString().slice(0, 10),
    });
    expect(uno.version).toBe(1);
    expect(uno.acordadoRol).toBe('admin-cliente');

    const dos = await registrarAcuerdo(leadId, {
      workspaceId: ws,
      modalidad: 'borrado',
      base: 'Se rectifica: borrado',
      efectivoDesde: new Date().toISOString().slice(0, 10),
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
    const hoy = new Date().toISOString().slice(0, 10);
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
    await ejecutarDisposicion(leadId, { workspaceId: congelado, modalidadEsperada: 'archivo' });

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
      efectivoDesde: new Date().toISOString().slice(0, 10),
    });

    // El evento, escrito por el ROL DE APLICACIÓN: exactamente lo que un miembro puede hacer.
    await conUsuario(leadId, (tx) => tx`insert into evento_dominio
      (workspace_id, tipo, payload, actor_id, actor_rol)
      values (${ws}, 'WorkspaceExportado', ${tx.json({ ambito: 'archivo' })}::jsonb,
              ${leadId}, 'lead-boutique')`);

    // Sigue bloqueada, y lo dice por el motivo correcto.
    expect((await panelDisposicion(leadId, ws)).motivoNoEjecutable).toMatch(/exportación previa/i);
    await expect(
      ejecutarDisposicion(leadId, { workspaceId: ws, modalidadEsperada: 'borrado' }),
    ).rejects.toThrow(/exportación previa/i);

    // Y la aplicación tampoco puede escribir el registro que sí cuenta.
    await expect(
      conUsuario(leadId, (tx) => tx`insert into exportacion_registro
        (workspace_id, ambito, ejecutado_por, ejecutado_rol)
        values (${ws}, 'archivo', ${leadId}, 'lead-boutique')`),
    ).rejects.toMatchObject({ code: '42501' });

    // Exportando de verdad —por la función que autoriza y sella— sí se desbloquea.
    await exportarWorkspace(leadId, { workspaceId: ws, ambito: 'archivo' });
    expect((await panelDisposicion(leadId, ws)).motivoNoEjecutable).toBeNull();
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
    await ejecutarDisposicion(leadId, { workspaceId: ws, modalidadEsperada: 'borrado' });

    const [w] = await admin`select nombre, limite_llamadas_ai_dia from workspace
      where id = ${ws}`;
    expect(w!.nombre).toBe('Workspace borrado por acuerdo');
    expect(w!.limite_llamadas_ai_dia).toBeNull();
  });

  it('el ayudante de la RLS no responde por terceros: no hay oráculo entre inquilinos', async () => {
    // `firmo_esta_disposicion` es SECURITY DEFINER, así que salta la RLS por diseño — es lo que
    // corta la recursión entre las dos políticas. Con el firmante como PARÁMETRO, cualquiera
    // con el grant podía preguntar «¿firmó esta persona ese acuerdo de ese workspace?» sobre
    // uuids ajenos y recibir la respuesta por encima de la RLS: existencia y autoría de
    // acuerdos de otro inquilino. Derivando el usuario de `app_user_id()` dentro, lo único
    // preguntable es sobre uno mismo.
    const ws = await nuevoWorkspace('sin-oraculo');
    await registrarAcuerdo(adminId, {
      workspaceId: ws,
      modalidad: 'archivo',
      base: 'Acuerdo del cliente',
      efectivoDesde: new Date().toISOString().slice(0, 10),
    });

    // La firma de tres argumentos ya no existe: no se puede preguntar por un tercero.
    await expect(
      conUsuario(leadId, (tx) => tx`select firmo_esta_disposicion(${ws}, 1, ${adminId})`),
    ).rejects.toMatchObject({ code: '42883' });

    // Y la de dos responde por QUIEN PREGUNTA, no por quien se nombre.
    const [comoFirmante] = await conUsuario(adminId, (tx) =>
      tx`select firmo_esta_disposicion(${ws}, 1) as si`);
    expect(comoFirmante!.si).toBe(true);
    const [comoOtro] = await conUsuario(leadId, (tx) =>
      tx`select firmo_esta_disposicion(${ws}, 1) as si`);
    expect(comoOtro!.si).toBe(false);
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
});
