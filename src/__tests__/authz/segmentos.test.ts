import { afterAll, beforeAll, expect, it } from 'vitest';
import { cerrarPools, conUsuario, sql, sqlAdmin } from '@/lib/db';
import { ErrorAutorizacion } from '@/lib/auth/auth.servicio';
import { listarSegmentos, segmentosParaUsuario } from '@/lib/segmento/segmento.queries';
import { crearSegmento, editarSegmento, ErrorSegmento } from '@/lib/segmento/segmento.servicio';
import { describeAuthz, enVuelo, sigueEsperando } from './helpers';

/**
 * RF-01.7 — los segmentos se listan con su cobertura (arquetipos por estado, con el
 * proyecto de su reto, y evidencias que los citan) respetando RLS (SYS-01/02); la capa 2
 * excluye a la cuenta desactivada; un miembro de A no ve ni escribe en B; solo el lead o el
 * admin del cliente crean y editan —la autoridad son las políticas `segmento_insert` /
 * `segmento_update`, y el servicio solo pone el mensaje—; nadie del rol de aplicación borra
 * ni mueve un segmento de workspace; el nombre no se repite en el workspace; dos ediciones
 * concurrentes dejan la auditoría encadenada; y cada escritura deja su evento con el rol que
 * la autorizó.
 */
describeAuthz('segmentos (cobertura + aislamiento + quién edita)', () => {
  const marca = `seg-${crypto.randomUUID().slice(0, 8)}`;
  let wsA = '';
  let wsB = '';
  let lead = '';
  let adminCliente = '';
  let disenador = '';
  let segIndependientes = '';
  let segPymes = '';
  let proyectoA = '';

  async function usuario(nombre: string, ws: string, rol: string): Promise<string> {
    const admin = sqlAdmin();
    const email = `${marca}-${nombre}@a.test`;
    const [u] = await admin`insert into usuario (email, nombre, estado)
      values (${email}, ${nombre}, 'activo') returning id`;
    await admin`insert into miembro (workspace_id, usuario_id, nombre, email, rol)
      values (${ws}, ${u!.id as string}, ${nombre}, ${email}, ${rol})`;
    return u!.id as string;
  }

  beforeAll(async () => {
    const admin = sqlAdmin();
    const [a] = await admin`insert into workspace (nombre) values (${marca + '-A'}) returning id`;
    const [b] = await admin`insert into workspace (nombre) values (${marca + '-B'}) returning id`;
    wsA = a!.id as string;
    wsB = b!.id as string;
    lead = await usuario('Lead', wsA, 'lead-boutique');
    adminCliente = await usuario('Admin cliente', wsA, 'admin-cliente');
    disenador = await usuario('Diseñador', wsA, 'disenador');

    const [s1] = await admin`insert into segmento (workspace_id, nombre, definicion)
      values (${wsA}, ${marca + ' independientes'}, 'Trabajadores por cuenta propia') returning id`;
    segIndependientes = s1!.id as string;
    const [s2] = await admin`insert into segmento (workspace_id, nombre, definicion)
      values (${wsA}, ${marca + ' pymes'}, '') returning id`;
    segPymes = s2!.id as string;
    await admin`insert into segmento (workspace_id, nombre) values (${wsB}, ${marca + ' ajeno'})`;

    // Un reto con proyecto y dos arquetipos mapeados a «independientes» (uno confirmado, uno
    // hipótesis), y otro reto SIN proyecto con un arquetipo refutado en el mismo segmento.
    const [svc] = await admin`insert into servicio (workspace_id, nombre, creado_por)
      values (${wsA}, ${marca + ' Servicio'}, ${lead}) returning id`;
    const [r1] = await admin`insert into reto
      (workspace_id, servicio_ancla_id, codigo, titulo, creado_por)
      values (${wsA}, ${svc!.id as string}, 'R-S1', 'Reto con proyecto', ${lead}) returning id`;
    const [p] = await admin`insert into proyecto (workspace_id, reto_id, codigo, titulo, creado_por)
      values (${wsA}, ${r1!.id as string}, 'P-S1', 'Proyecto de prueba', ${lead}) returning id`;
    proyectoA = p!.id as string;
    const [r2] = await admin`insert into reto
      (workspace_id, servicio_ancla_id, codigo, titulo, creado_por)
      values (${wsA}, ${svc!.id as string}, 'R-S2', 'Reto sin proyecto', ${lead}) returning id`;

    const arquetipos: [string, string, string, string][] = [
      [r1!.id as string, 'Autónomo digital', 'confirmado', 'Tres entrevistas encajan'],
      [r1!.id as string, 'Autónomo de sucursal', 'hipotesis', ''],
      [r2!.id as string, 'Autónomo informal', 'refutado', 'Ninguna entrevista encaja'],
    ];
    for (const [retoId, nombre, estado, razon] of arquetipos) {
      const [arq] = await admin`insert into arquetipo
        (workspace_id, reto_id, nombre, definicion, estado, veredicto_razon, creado_por)
        values (${wsA}, ${retoId}, ${nombre}, '', ${estado}, ${razon}, ${lead}) returning id`;
      await admin`insert into arquetipo_segmento (arquetipo_id, segmento_id, workspace_id)
        values (${arq!.id as string}, ${segIndependientes}, ${wsA})`;
    }

    // Dos evidencias citan «independientes»; ninguna cita «pymes».
    const [fuente] = await admin`insert into fuente (workspace_id, tipo, titulo, creado_por)
      values (${wsA}, 'nota', 'Fuente segmentos', ${lead}) returning id`;
    for (const titulo of ['Entrevista 1', 'Entrevista 2']) {
      const [ev] = await admin`insert into evidencia
        (workspace_id, fuente_id, titulo, dimensiones, creado_por)
        values (${wsA}, ${fuente!.id as string}, ${titulo}, '{}'::jsonb, ${lead}) returning id`;
      await admin`insert into evidencia_segmento (evidencia_id, segmento_id, workspace_id)
        values (${ev!.id as string}, ${segIndependientes}, ${wsA})`;
    }
  });

  afterAll(async () => {
    // Si beforeAll falló a medias, limpiar solo lo que sí existe: un id vacío en el
    // IN lanzaría 22P02 y taparía el error real del setup.
    const admin = sqlAdmin();
    const wss = [wsA, wsB].filter((id) => id !== '');
    if (wss.length > 0) {
      await admin`delete from evento_dominio where workspace_id in ${admin(wss)}`;
      await admin`delete from arquetipo_segmento where workspace_id in ${admin(wss)}`;
      await admin`delete from evidencia_segmento where workspace_id in ${admin(wss)}`;
      await admin`delete from arquetipo where workspace_id in ${admin(wss)}`;
      await admin`delete from derecho_uso where workspace_id in ${admin(wss)}`;
      await admin`delete from evidencia where workspace_id in ${admin(wss)}`;
      await admin`delete from fuente where workspace_id in ${admin(wss)}`;
      await admin`delete from proyecto where workspace_id in ${admin(wss)}`;
      await admin`delete from reto where workspace_id in ${admin(wss)}`;
      await admin`delete from servicio where workspace_id in ${admin(wss)}`;
      await admin`delete from segmento where workspace_id in ${admin(wss)}`;
      await admin`delete from miembro where workspace_id in ${admin(wss)}`;
      await admin`delete from workspace where id in ${admin(wss)}`;
    }
    const usuarios = [lead, adminCliente, disenador].filter((id) => id !== '');
    if (usuarios.length > 0) await admin`delete from usuario where id in ${admin(usuarios)}`;
    await cerrarPools();
  });

  it('lista cada segmento con sus arquetipos por estado, el proyecto del reto y las evidencias', async () => {
    const segmentos = await conUsuario(disenador, (tx) => listarSegmentos(tx, wsA));
    expect(segmentos.map((s) => s.id)).toEqual([segIndependientes, segPymes]);

    const ind = segmentos[0]!;
    expect(ind.definicion).toBe('Trabajadores por cuenta propia');
    expect(ind.evidencias).toBe(2);
    expect(ind.arquetipos.map((a) => [a.retoCodigo, a.nombre, a.estado])).toEqual([
      ['R-S1', 'Autónomo de sucursal', 'hipotesis'],
      ['R-S1', 'Autónomo digital', 'confirmado'],
      ['R-S2', 'Autónomo informal', 'refutado'],
    ]);
    // Los del reto con proyecto enlazan a él; el del reto sin proyecto, a ninguna parte.
    expect(ind.arquetipos[0]!.proyectoId).toBe(proyectoA);
    expect(ind.arquetipos[0]!.proyectoCodigo).toBe('P-S1');
    expect(ind.arquetipos[2]!.proyectoId).toBeNull();

    const pymes = segmentos[1]!;
    expect(pymes.arquetipos).toEqual([]);
    expect(pymes.evidencias).toBe(0);
  });

  it('segmentosParaUsuario aplica la capa 2: cuenta activa lee, desactivada con sesión viva no', async () => {
    const segmentos = await segmentosParaUsuario(disenador, wsA);
    expect(segmentos).toHaveLength(2);

    const admin = sqlAdmin();
    await admin`update usuario set estado = 'inactivo' where id = ${disenador}`;
    try {
      await expect(segmentosParaUsuario(disenador, wsA)).rejects.toThrow(ErrorAutorizacion);
    } finally {
      await admin`update usuario set estado = 'activo' where id = ${disenador}`;
    }
  });

  it('sin contexto de usuario, los segmentos son invisibles (cero filas)', async () => {
    const filas = await sql()`select id from segmento where workspace_id in (${wsA}, ${wsB})`;
    expect(filas.length).toBe(0);
  });

  it('un miembro de A no ve los segmentos de B, ni preguntando directo, ni crea en B', async () => {
    const segmentosB = await segmentosParaUsuario(lead, wsB);
    expect(segmentosB).toEqual([]);
    const filas = await conUsuario(
      lead,
      (tx) => tx`select id from segmento where workspace_id = ${wsB}`,
    );
    expect(filas.length).toBe(0);
    await expect(
      crearSegmento(lead, { workspaceId: wsB, nombre: `${marca} intruso`, definicion: '' }),
    ).rejects.toThrow(ErrorSegmento);
    const [enB] =
      await sqlAdmin()`select count(*)::int as n from segmento where workspace_id = ${wsB}`;
    expect(enB!.n).toBe(1);
  });

  it('el lead define un segmento y queda su evento con el rol que lo autorizó', async () => {
    const { segmentoId } = await crearSegmento(lead, {
      workspaceId: wsA,
      nombre: `${marca} empleados corporativos`,
      definicion: 'Empleados con cuenta nómina por convenio',
    });
    const segmentos = await segmentosParaUsuario(lead, wsA);
    const nuevo = segmentos.find((s) => s.id === segmentoId);
    expect(nuevo?.definicion).toBe('Empleados con cuenta nómina por convenio');
    expect(nuevo?.arquetipos).toEqual([]);
    expect(nuevo?.evidencias).toBe(0);

    const eventos = await sqlAdmin()`select actor_id, actor_rol, payload from evento_dominio
      where workspace_id = ${wsA} and tipo = 'SegmentoDefinido'`;
    expect(eventos).toHaveLength(1);
    expect(eventos[0]!.actor_id).toBe(lead);
    expect(eventos[0]!.actor_rol).toBe('lead-boutique');
    expect(eventos[0]!.payload).toEqual({
      segmentoId,
      nombre: `${marca} empleados corporativos`,
    });
  });

  it('el admin del cliente edita nombre y definición, y el evento recuerda el nombre anterior', async () => {
    await editarSegmento(adminCliente, {
      workspaceId: wsA,
      segmentoId: segPymes,
      nombre: `${marca} pymes y microempresas`,
      definicion: 'Pequeñas y medianas empresas, incluidas las unipersonales',
    });
    const [fila] = await sqlAdmin()`select nombre, definicion from segmento where id = ${segPymes}`;
    expect(fila!.nombre).toBe(`${marca} pymes y microempresas`);
    expect(fila!.definicion).toBe('Pequeñas y medianas empresas, incluidas las unipersonales');

    const eventos = await sqlAdmin()`select actor_rol, payload from evento_dominio
      where workspace_id = ${wsA} and tipo = 'SegmentoEditado'`;
    expect(eventos).toHaveLength(1);
    expect(eventos[0]!.actor_rol).toBe('admin-cliente');
    expect(eventos[0]!.payload).toEqual({
      segmentoId: segPymes,
      nombre: `${marca} pymes y microempresas`,
      nombreAnterior: `${marca} pymes`,
    });
  });

  it('el nombre no se repite en el workspace, ni cambiando mayúsculas, ni al editar', async () => {
    await expect(
      crearSegmento(lead, { workspaceId: wsA, nombre: `${marca} INDEPENDIENTES`, definicion: '' }),
    ).rejects.toThrow(ErrorSegmento);
    await expect(
      editarSegmento(lead, {
        workspaceId: wsA,
        segmentoId: segPymes,
        nombre: `${marca} independientes`,
        definicion: '',
      }),
    ).rejects.toThrow(ErrorSegmento);
    // Conservar el propio nombre al editar NO es repetirlo.
    await editarSegmento(lead, {
      workspaceId: wsA,
      segmentoId: segIndependientes,
      nombre: `${marca} independientes`,
      definicion: 'Trabajadores por cuenta propia, con o sin RUT',
    });
    const [fila] =
      await sqlAdmin()`select definicion from segmento where id = ${segIndependientes}`;
    expect(fila!.definicion).toBe('Trabajadores por cuenta propia, con o sin RUT');
  });

  it('dos altas simultáneas del mismo nombre dejan UN segmento: el candado serializa la comprobación', async () => {
    const nombre = `${marca} sector público`;
    const resultados = await Promise.allSettled([
      crearSegmento(lead, { workspaceId: wsA, nombre, definicion: '' }),
      crearSegmento(adminCliente, {
        workspaceId: wsA,
        nombre: nombre.toUpperCase(),
        definicion: '',
      }),
      crearSegmento(lead, { workspaceId: wsA, nombre, definicion: 'otra vez' }),
    ]);
    expect(resultados.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of resultados.filter((r): r is PromiseRejectedResult => r.status === 'rejected')) {
      expect(r.reason).toBeInstanceOf(ErrorSegmento);
    }
    const filas = await sqlAdmin()`select id from segmento
      where workspace_id = ${wsA} and lower(nombre) = lower(${nombre})`;
    expect(filas).toHaveLength(1);
  });

  it('el diseñador lee, pero no crea ni edita: el servicio lo dice claro y la política lo impide', async () => {
    const [n0] =
      await sqlAdmin()`select count(*)::int as n from segmento where workspace_id = ${wsA}`;
    await expect(
      crearSegmento(disenador, {
        workspaceId: wsA,
        nombre: `${marca} del diseñador`,
        definicion: '',
      }),
    ).rejects.toThrow(/lead de la boutique o el admin del cliente/);
    await expect(
      editarSegmento(disenador, {
        workspaceId: wsA,
        segmentoId: segPymes,
        nombre: `${marca} alterado`,
        definicion: '',
      }),
    ).rejects.toThrow(ErrorSegmento);
    // El servicio corta ANTES de tocar nada: ni fila ni evento.
    const [n1] =
      await sqlAdmin()`select count(*)::int as n from segmento where workspace_id = ${wsA}`;
    expect(n1!.n).toBe(n0!.n);
    const [fila] = await sqlAdmin()`select nombre from segmento where id = ${segPymes}`;
    expect(fila!.nombre).not.toBe(`${marca} alterado`);
    const eventos = await sqlAdmin()`select 1 from evento_dominio
      where workspace_id = ${wsA} and actor_id = ${disenador}`;
    expect(eventos).toHaveLength(0);
  });

  it('y por SQL directo bajo su contexto RLS tampoco: la autoridad es la política, no el TypeScript', async () => {
    // Insert: la política `segmento_insert` lo rechaza (42501, «policy»).
    await expect(
      conUsuario(
        disenador,
        (tx) =>
          tx`insert into segmento (workspace_id, nombre) values (${wsA}, ${marca + ' por SQL'})`,
      ),
    ).rejects.toThrow(/policy|permiso/i);
    // Update: el USING de `segmento_update` no le enseña filas que actualizar (0 filas, sin
    // filtrar existencia).
    const upd = await conUsuario(
      disenador,
      (tx) =>
        tx`update segmento set nombre = ${marca + ' alterado por SQL'} where id = ${segPymes}`,
    );
    expect(upd.count).toBe(0);
    // Delete: nadie del rol de aplicación tiene DELETE, ni siquiera el lead.
    for (const quien of [disenador, lead]) {
      await expect(
        conUsuario(quien, (tx) => tx`delete from segmento where id = ${segPymes}`),
      ).rejects.toThrow(/permission denied|permiso/i);
    }
    // Y el lead, que sí edita, no puede MOVER un segmento a otro workspace ni fecharlo:
    // `workspace_id` y `creado_en` no están en el grant de UPDATE.
    await expect(
      conUsuario(
        lead,
        (tx) => tx`update segmento set workspace_id = ${wsB} where id = ${segPymes}`,
      ),
    ).rejects.toThrow(/permission denied|permiso/i);
    await expect(
      conUsuario(
        lead,
        (tx) => tx`update segmento set creado_en = '2020-01-01' where id = ${segPymes}`,
      ),
    ).rejects.toThrow(/permission denied|permiso/i);
    const [fila] =
      await sqlAdmin()`select nombre, workspace_id from segmento where id = ${segPymes}`;
    expect(fila!.nombre).not.toBe(`${marca} alterado por SQL`);
    expect(fila!.workspace_id).toBe(wsA);
  });

  it('dos ediciones concurrentes del mismo segmento dejan la auditoría encadenada: old => n1 | n1 => n2', async () => {
    // La primera edición está EN VUELO (tiene la fila bloqueada, aún sin confirmar) cuando
    // llega la segunda. Sin `for update` en la lectura del nombre anterior, la segunda leería
    // el nombre viejo y lo registraría como «anterior» de un cambio que en realidad partió
    // de n1: la cadena quedaría old => n1 | old => n2.
    const [antes] = await sqlAdmin()`select nombre from segmento where id = ${segPymes}`;
    const old = antes!.nombre as string;
    const n1 = `${marca} pymes (primera edición)`;
    const n2 = `${marca} pymes (segunda edición)`;

    const primera = await enVuelo(async (tx) => {
      await tx`update segmento set nombre = ${n1} where id = ${segPymes}`;
    });
    const segunda = editarSegmento(lead, {
      workspaceId: wsA,
      segmentoId: segPymes,
      nombre: n2,
      definicion: 'tras la primera',
    });
    expect(await sigueEsperando(segunda)).toBe(true);

    await primera.cerrar();
    await segunda;

    const [fila] = await sqlAdmin()`select nombre from segmento where id = ${segPymes}`;
    expect(fila!.nombre).toBe(n2);
    const eventos = await sqlAdmin()`select payload from evento_dominio
      where workspace_id = ${wsA} and tipo = 'SegmentoEditado' and payload->>'nombre' = ${n2}`;
    expect(eventos).toHaveLength(1);
    expect(eventos[0]!.payload).toEqual({ segmentoId: segPymes, nombre: n2, nombreAnterior: n1 });
    expect((eventos[0]!.payload as { nombreAnterior: string }).nombreAnterior).not.toBe(old);
  });

  it('editar un segmento que no existe en el workspace falla con mensaje, sin evento', async () => {
    await expect(
      editarSegmento(lead, {
        workspaceId: wsA,
        segmentoId: '00000000-0000-4000-8000-000000000000',
        nombre: `${marca} fantasma`,
        definicion: '',
      }),
    ).rejects.toThrow(/no existe/);
  });

  it('aplica la capa 2 en la escritura: cuenta desactivada con sesión viva no crea', async () => {
    const admin = sqlAdmin();
    await admin`update usuario set estado = 'inactivo' where id = ${lead}`;
    try {
      await expect(
        crearSegmento(lead, { workspaceId: wsA, nombre: `${marca} inactivo`, definicion: '' }),
      ).rejects.toThrow(ErrorAutorizacion);
    } finally {
      await admin`update usuario set estado = 'activo' where id = ${lead}`;
    }
  });
});
