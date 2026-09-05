import { afterAll, beforeAll, expect, it } from 'vitest';
import { conUsuario, sqlAdmin } from '@/lib/db';
import {
  crearOportunidad,
  decidirOportunidad,
  desenlazarInsight,
  enlazarInsight,
  ErrorOportunidad,
  portafolioDelWorkspace,
  priorizarOportunidad,
} from '@/lib/servicio/oportunidad.servicio';
import { describeAuthz } from './helpers';

/**
 * CTX-04 / SYS-15 — la oportunidad (HMW) se traza a insights, y eso lo dice la BASE.
 *
 * La etapa 3 era la única del método sin su objeto: G3 se aprobaba sin nada que mirar
 * porque no había nada que mirar, y «una oportunidad referencia ≥1 insight» vivía solo en
 * un documento. Estas pruebas cubren las cuatro puertas: quién propone, qué se puede
 * enlazar, qué exige aprobar, y qué exige G3.
 */
describeAuthz('oportunidades HMW: el portafolio de la etapa 3', () => {
  const marca = `opo-${crypto.randomUUID().slice(0, 8)}`;
  let ws = '';
  let leadId = '';
  let disenadorId = '';
  let stakeId = '';
  let retoId = '';
  let insightValidado = '';
  let insightPropuesto = '';
  let evidenciaId = '';

  beforeAll(async () => {
    const admin = sqlAdmin();
    const [w] = await admin`insert into workspace (nombre) values (${marca}) returning id`;
    ws = w!.id as string;

    for (const [alias, rol] of [
      ['lead', 'lead-boutique'],
      ['dis', 'disenador'],
      ['stake', 'stakeholder'],
    ] as const) {
      const [u] = await admin`insert into usuario (email, nombre, estado)
        values (${`${marca}-${alias}@test.demo`}, ${alias}, 'activo') returning id`;
      const id = u!.id as string;
      if (alias === 'lead') leadId = id;
      else if (alias === 'dis') disenadorId = id;
      else stakeId = id;
      await admin`insert into miembro (workspace_id, usuario_id, nombre, email, rol)
        values (${ws}, ${id}, ${alias}, ${`${marca}-${alias}@test.demo`}, ${rol})`;
    }

    const [srv] = await admin`insert into servicio (workspace_id, nombre, estado, creado_por)
      values (${ws}, 'Servicio de prueba', 'activo', ${leadId}) returning id`;
    const [r] = await admin`insert into reto
      (workspace_id, servicio_ancla_id, codigo, titulo, descripcion, estado, metrica_objetivo, creado_por)
      values (${ws}, ${srv!.id as string}, 'R-01', 'Reto de prueba', 'Descripción',
              'activo', 'Ninguna', ${leadId}) returning id`;
    retoId = r!.id as string;

    const [fuente] = await admin`insert into fuente (workspace_id, tipo, titulo, creado_por)
      values (${ws}, 'nota', 'Fuente', ${leadId}) returning id`;
    const [ev] = await admin`insert into evidencia
      (workspace_id, fuente_id, titulo, dimensiones, creado_por)
      values (${ws}, ${fuente!.id as string}, 'Entrevistas', '{}'::jsonb, ${leadId}) returning id`;
    evidenciaId = ev!.id as string;
    await admin`insert into derecho_uso
      (workspace_id, evidencia_id, estado, ambito, base, decidido_por, decidido_en, creado_por)
      values (${ws}, ${evidenciaId}, 'concedido', 'cliente', 'Contrato de prueba',
              ${leadId}, now(), ${leadId})`;

    // Un insight VALIDADO con su afirmación citada, y otro que se queda en 'propuesto'.
    // La diferencia entre los dos es el objeto de la mitad de estas pruebas.
    const crearInsightCitado = async (titulo: string, validar: boolean) => {
      const [i] = await admin`insert into insight (workspace_id, titulo, resumen, creado_por)
        values (${ws}, ${titulo}, 'Resumen', ${leadId}) returning id`;
      const id = i!.id as string;
      const [a] = await admin`insert into afirmacion
        (workspace_id, insight_id, orden, texto, es_hipotesis)
        values (${ws}, ${id}, 0, 'La verificación pide documentos que no están a mano', false)
        returning id`;
      await admin`insert into cita
        (workspace_id, afirmacion_id, evidencia_id, fragmento, localizacion, creado_por)
        values (${ws}, ${a!.id as string}, ${evidenciaId}, 'no los tengo aquí', 'min 4:20', ${leadId})`;
      if (validar) {
        await admin`update insight set estado = 'validado', validado_por = ${leadId},
          validado_en = now() where id = ${id}`;
      }
      return id;
    };
    insightValidado = await crearInsightCitado('La verificación excluye en el móvil', true);
    insightPropuesto = await crearInsightCitado('Todavía sin validar', false);
  });

  afterAll(async () => {
    const admin = sqlAdmin();
    if (!ws) return;
    await admin`delete from evento_dominio where workspace_id = ${ws}`;
    await admin`delete from oportunidad_insight where workspace_id = ${ws}`;
    await admin`delete from oportunidad where workspace_id = ${ws}`;
    await admin`delete from checklist_item where workspace_id = ${ws}`;
    await admin`delete from gate_instancia where workspace_id = ${ws}`;
    await admin`delete from etapa_instancia where workspace_id = ${ws}`;
    await admin`delete from reapertura_insight where workspace_id = ${ws}`;
    await admin`delete from reapertura_etapa where workspace_id = ${ws}`;
    await admin`delete from proyecto where workspace_id = ${ws}`;
    await admin`delete from cita where workspace_id = ${ws}`;
    await admin`delete from afirmacion where workspace_id = ${ws}`;
    await admin`delete from insight where workspace_id = ${ws}`;
    await admin`delete from derecho_uso where workspace_id = ${ws}`;
    await admin`delete from evidencia where workspace_id = ${ws}`;
    await admin`delete from fuente where workspace_id = ${ws}`;
    await admin`delete from reto where workspace_id = ${ws}`;
    await admin`delete from servicio where workspace_id = ${ws}`;
    await admin`delete from miembro where workspace_id = ${ws}`;
    await admin`delete from workspace where id = ${ws}`;
  });

  it('el diseñador propone una HMW y nace por decidir, firmada y sin veredicto', async () => {
    const { oportunidadId } = await crearOportunidad(disenadorId, {
      workspaceId: ws,
      retoId,
      pregunta: '¿Cómo podríamos verificar sin pedir documentos en el móvil?',
      prioridad: 10,
      prioridadRazon: 'Toca el criterio de tiempo a cuenta activa',
    });
    const admin = sqlAdmin();
    const [o] = await admin`select estado, creado_por, decidido_por, decidido_en, prioridad
      from oportunidad where id = ${oportunidadId}`;
    expect(o!.estado).toBe('propuesta');
    expect(o!.creado_por).toBe(disenadorId);
    expect(o!.decidido_por).toBeNull();
    expect(o!.decidido_en).toBeNull();
    expect(o!.prioridad).toBe(10);

    // Y deja el evento que CTX-04 declara.
    const [e] = await admin`select payload from evento_dominio
      where workspace_id = ${ws} and tipo = 'OportunidadPropuesta'
        and payload->>'oportunidadId' = ${oportunidadId}`;
    expect((e!.payload as { retoId: string }).retoId).toBe(retoId);
  });

  it('un stakeholder no propone oportunidades', async () => {
    await expect(
      crearOportunidad(stakeId, { workspaceId: ws, retoId, pregunta: 'HMW del stakeholder', prioridad: 0, prioridadRazon: '' }),
    ).rejects.toThrow(ErrorOportunidad);
  });

  it('la misma pregunta dos veces en el mismo reto no entra: priorizar un duplicado reparte el mismo voto dos veces', async () => {
    const pregunta = '¿Cómo podríamos avisar antes del corte?';
    await crearOportunidad(leadId, { workspaceId: ws, retoId, pregunta, prioridad: 0, prioridadRazon: '' });
    await expect(
      crearOportunidad(leadId, { workspaceId: ws, retoId, pregunta, prioridad: 0, prioridadRazon: '' }),
    ).rejects.toThrow(/ya tiene una oportunidad con esa misma pregunta/);
  });

  /**
   * La regla que 20260902260000 tuvo que añadir a `decision_insight` después de comprobar
   * sobre una base viva que un insight `propuesto` atravesaba entero el guard del gate.
   * Aquí nace ya puesta, y en la POLÍTICA: el escritor que hay que cerrar es el rol de
   * aplicación escribiendo SQL directo, no el servicio.
   */
  it('la traza se hace de insights validados: uno propuesto no se enlaza', async () => {
    const { oportunidadId } = await crearOportunidad(leadId, {
      workspaceId: ws, retoId, pregunta: 'HMW de la traza', prioridad: 0, prioridadRazon: '',
    });
    await expect(
      enlazarInsight(leadId, { workspaceId: ws, oportunidadId, insightId: insightPropuesto }),
    ).rejects.toThrow(/validado/);
    // …y por SQL directo tampoco, que es lo que de verdad se está afirmando.
    await expect(
      conUsuario(leadId, (tx) => tx`insert into oportunidad_insight
        (oportunidad_id, insight_id, workspace_id)
        values (${oportunidadId}, ${insightPropuesto}, ${ws})`),
    ).rejects.toThrow(/row-level security/);
    // El validado sí.
    await enlazarInsight(leadId, { workspaceId: ws, oportunidadId, insightId: insightValidado });
    const admin = sqlAdmin();
    const filas = await admin`select 1 from oportunidad_insight
      where oportunidad_id = ${oportunidadId}`;
    expect(filas.length).toBe(1);
  });

  it('aprobar sin traza es lo que SYS-15 prohíbe, y lo dice el guard', async () => {
    const { oportunidadId } = await crearOportunidad(leadId, {
      workspaceId: ws, retoId, pregunta: 'HMW sin insights', prioridad: 0, prioridadRazon: '',
    });
    await expect(
      decidirOportunidad(leadId, { workspaceId: ws, oportunidadId, estado: 'aprobada', veredictoRazon: '' }),
    ).rejects.toThrow(/no traza a ningún insight/);
    // Descartarla sí se puede sin traza: lo que se tira no sostiene nada. Con razón, eso sí.
    await decidirOportunidad(leadId, {
      workspaceId: ws, oportunidadId, estado: 'descartada', veredictoRazon: 'Ya resuelta por otra vía',
    });
    const admin = sqlAdmin();
    const [o] = await admin`select estado, decidido_por, decidido_en from oportunidad where id = ${oportunidadId}`;
    expect(o!.estado).toBe('descartada');
    // La firma la pone la BASE, no quien llama.
    expect(o!.decidido_por).toBe(leadId);
    expect(o!.decidido_en).not.toBeNull();
  });

  it('el veredicto es irreversible por esta superficie: ni se repisa ni se reprioriza después', async () => {
    const { oportunidadId } = await crearOportunidad(leadId, {
      workspaceId: ws, retoId, pregunta: 'HMW ya decidida', prioridad: 0, prioridadRazon: '',
    });
    await enlazarInsight(leadId, { workspaceId: ws, oportunidadId, insightId: insightValidado });
    await decidirOportunidad(leadId, { workspaceId: ws, oportunidadId, estado: 'aprobada', veredictoRazon: '' });

    await expect(
      decidirOportunidad(leadId, { workspaceId: ws, oportunidadId, estado: 'descartada', veredictoRazon: 'Me arrepentí' }),
    ).rejects.toThrow(/ya se decidió/);
    await expect(
      priorizarOportunidad(leadId, { workspaceId: ws, oportunidadId, prioridad: 99, prioridadRazon: '' }),
    ).rejects.toThrow(/ya se decidió/);
    // Y la traza tampoco se toca después: cambiarla sería reescribir en qué se apoyó una
    // aprobación que ya está firmada.
    await expect(
      desenlazarInsight(leadId, { workspaceId: ws, oportunidadId, insightId: insightValidado }),
    ).rejects.toThrow(/ya se decidió/);
  });

  /**
   * EJE TIEMPO: entre enlazar y aprobar caben semanas, y en ese hueco se revocan derechos.
   * `oportunidad_veredicto_guard` vuelve a preguntar por el protocolo compartido
   * (`razonamiento_usable_guard`), que es el mismo que miran G2 y G5 — no una comprobación
   * propia que nacería divergiendo.
   */
  it('una HMW cuyo insight perdió los derechos ya no se aprueba', async () => {
    const admin = sqlAdmin();
    const { oportunidadId } = await crearOportunidad(leadId, {
      workspaceId: ws, retoId, pregunta: 'HMW con derechos revocados', prioridad: 0, prioridadRazon: '',
    });
    await enlazarInsight(leadId, { workspaceId: ws, oportunidadId, insightId: insightValidado });
    await admin`update derecho_uso set estado = 'denegado', ambito = 'interno',
      base = 'El participante retiró el permiso', decidido_por = ${leadId}, decidido_en = now()
      where evidencia_id = ${evidenciaId} and workspace_id = ${ws}`;
    try {
      await expect(
        decidirOportunidad(leadId, { workspaceId: ws, oportunidadId, estado: 'aprobada', veredictoRazon: '' }),
      ).rejects.toThrow(/derechos vigentes/);
    } finally {
      await admin`update derecho_uso set estado = 'concedido', ambito = 'cliente',
        base = 'Contrato de prueba', decidido_por = ${leadId}, decidido_en = now()
        where evidencia_id = ${evidenciaId} and workspace_id = ${ws}`;
    }
  });

  it('el portafolio se lee agrupado por reto, con su traza dentro y ordenado por prioridad', async () => {
    const retos = await portafolioDelWorkspace(leadId, ws);
    const mio = retos.find((r) => r.retoId === retoId);
    expect(mio!.codigo).toBe('R-01');
    expect(mio!.oportunidades.length).toBeGreaterThan(0);
    const prioridades = mio!.oportunidades.map((o) => o.prioridad);
    expect([...prioridades].sort((a, b) => b - a)).toEqual(prioridades);
    const conTraza = mio!.oportunidades.find((o) => o.insights.length > 0);
    expect(conTraza!.insights[0]!.titulo).toBe('La verificación excluye en el móvil');
    // Un reto SIN oportunidades sale igualmente, con la lista vacía: la pantalla tiene que
    // poder decir «este reto no tiene portafolio todavía», que es información.
    expect(retos.every((r) => Array.isArray(r.oportunidades))).toBe(true);
  });

  /**
   * G3. Se monta un proyecto con UN SOLO gate, el 3: la comprobación de «los gates
   * anteriores deben aprobarse primero» recorre `numero < new.numero`, así que sin gates
   * anteriores pasa vacía y se llega a la rama que se quiere medir. Es el mismo truco que
   * usa la suite del método para alcanzar ramas del guard sin montar las ocho etapas.
   */
  it('G3 exige SYS-15 sobre el portafolio, y es vacuamente cierto sin oportunidades', async () => {
    const admin = sqlAdmin();
    const [srv2] = await admin`insert into servicio (workspace_id, nombre, estado, creado_por)
      values (${ws}, 'Servicio G3', 'activo', ${leadId}) returning id`;
    const [r2] = await admin`insert into reto
      (workspace_id, servicio_ancla_id, codigo, titulo, descripcion, estado, metrica_objetivo, creado_por)
      values (${ws}, ${srv2!.id as string}, 'R-G3', 'Reto de G3', 'Descripción', 'activo',
              'Ninguna', ${leadId}) returning id`;
    const retoG3 = r2!.id as string;
    const [p] = await admin`insert into proyecto
      (workspace_id, reto_id, codigo, titulo, estado, perfil, creado_por)
      values (${ws}, ${retoG3}, 'P-G3', 'Proyecto de G3', 'activo', 'rapido', ${leadId})
      returning id`;
    const [g] = await admin`insert into gate_instancia
      (workspace_id, proyecto_id, numero, rol_aprobador)
      values (${ws}, ${p!.id as string}, 3, 'sponsor') returning id`;
    const gateId = g!.id as string;
    // Un ítem `cumplido` exige referenciar exactamente UN objeto (evidencia, insight o
    // decisión): un ítem cumplido que no cita nada es un visto bueno sin sostén, y el
    // esquema no lo admite.
    await admin`insert into checklist_item
      (workspace_id, gate_id, orden, texto, estado, insight_id)
      values (${ws}, ${gateId}, 0, 'El portafolio está razonado', 'cumplido', ${insightValidado})`;

    const aprobar = () => admin`update gate_instancia
      set estado = 'aprobado', aprobado_por = ${leadId}, aprobado_en = now()
      where id = ${gateId}`;
    const volverAPendiente = () => admin`update gate_instancia
      set estado = 'pendiente', aprobado_por = null, aprobado_en = null where id = ${gateId}`;

    // 1. SIN portafolio, G3 pasa. Es deliberado: SYS-15 es una regla sobre las
    //    oportunidades, no una regla que las exija — y exigirlas aquí dejaría sin poder
    //    firmar G3 a todo proyecto anterior a esta tabla. «Portafolio aprobado» es
    //    expectativa del método y va en el checklist de la etapa.
    await aprobar();
    const [g1] = await admin`select estado from gate_instancia where id = ${gateId}`;
    expect(g1!.estado).toBe('aprobado');
    await volverAPendiente();

    // 2. Una PROPUESTA sin traza ya lo bloquea: no hace falta que esté aprobada. Si solo
    //    contaran las aprobadas, bastaría con no decidir una HMW sin apoyo para colarla.
    const sinTraza = await crearOportunidad(leadId, {
      workspaceId: ws, retoId: retoG3, pregunta: 'HMW sin apoyo', prioridad: 0, prioridadRazon: '',
    });
    await expect(aprobar()).rejects.toThrow(/no traza a ningún insight \(SYS-15\)/);

    // 3. Descartarla la saca del conjunto: lo que se tiró no sostiene nada.
    await decidirOportunidad(leadId, {
      workspaceId: ws, oportunidadId: sinTraza.oportunidadId, estado: 'descartada',
      veredictoRazon: 'Fuera del alcance del reto',
    });
    await aprobar();
    await volverAPendiente();

    // 4. Con una aprobada y trazada, G3 sigue pasando…
    const aprobada = await crearOportunidad(leadId, {
      workspaceId: ws, retoId: retoG3, pregunta: 'HMW aprobada de G3', prioridad: 5, prioridadRazon: '',
    });
    await enlazarInsight(leadId, {
      workspaceId: ws, oportunidadId: aprobada.oportunidadId, insightId: insightValidado,
    });
    await decidirOportunidad(leadId, {
      workspaceId: ws, oportunidadId: aprobada.oportunidadId, estado: 'aprobada', veredictoRazon: '',
    });
    await aprobar();
    await volverAPendiente();

    // 5. …y deja de pasar si le quitan el enlace por debajo. Ese borrado va como owner a
    //    propósito: es el escritor que NO pasa por la política del enlace, y por eso el
    //    guard del gate vuelve a mirar lo que el guard de la fila ya miró al aprobar.
    await admin`delete from oportunidad_insight
      where oportunidad_id = ${aprobada.oportunidadId} and workspace_id = ${ws}`;
    await expect(aprobar()).rejects.toThrow(/no traza a ningún insight \(SYS-15\)/);
  });

  /**
   * EJE TIEMPO en el gate, que es distinto del eje tiempo de la fila: al aprobar la
   * oportunidad los derechos estaban vivos, y entre aquel momento y la firma de G3 —con el
   * sponsor delante— pueden revocarse. Sin esta rama, G3 certifica «dónde jugamos» sobre una
   * HMW cuyo único apoyo ya no se puede enseñar al cliente.
   */
  it('G3 no se firma si el razonamiento del portafolio dejó de sostenerse', async () => {
    const admin = sqlAdmin();
    const [srv3] = await admin`insert into servicio (workspace_id, nombre, estado, creado_por)
      values (${ws}, 'Servicio G3 tiempo', 'activo', ${leadId}) returning id`;
    const [r3] = await admin`insert into reto
      (workspace_id, servicio_ancla_id, codigo, titulo, descripcion, estado, metrica_objetivo, creado_por)
      values (${ws}, ${srv3!.id as string}, 'R-G3T', 'Reto de G3 en el tiempo', 'Descripción',
              'activo', 'Ninguna', ${leadId}) returning id`;
    const retoT = r3!.id as string;
    const [p] = await admin`insert into proyecto
      (workspace_id, reto_id, codigo, titulo, estado, perfil, creado_por)
      values (${ws}, ${retoT}, 'P-G3T', 'Proyecto de G3 en el tiempo', 'activo', 'rapido', ${leadId})
      returning id`;
    const [g] = await admin`insert into gate_instancia
      (workspace_id, proyecto_id, numero, rol_aprobador)
      values (${ws}, ${p!.id as string}, 3, 'sponsor') returning id`;
    const gateId = g!.id as string;
    // El ítem del checklist cita la EVIDENCIA y no el insight: si citara el insight, el
    // protocolo lo alcanzaría por el ítem y no sabríamos si lo que rechaza es el portafolio.
    await admin`insert into checklist_item
      (workspace_id, gate_id, orden, texto, estado, evidencia_id)
      values (${ws}, ${gateId}, 0, 'Hay evidencia del reto', 'cumplido', ${evidenciaId})`;

    const o = await crearOportunidad(leadId, {
      workspaceId: ws, retoId: retoT, pregunta: 'HMW del eje tiempo', prioridad: 0, prioridadRazon: '',
    });
    await enlazarInsight(leadId, { workspaceId: ws, oportunidadId: o.oportunidadId, insightId: insightValidado });
    await decidirOportunidad(leadId, {
      workspaceId: ws, oportunidadId: o.oportunidadId, estado: 'aprobada', veredictoRazon: '',
    });

    await admin`update derecho_uso set estado = 'denegado', ambito = 'interno',
      base = 'El participante retiró el permiso', decidido_por = ${leadId}, decidido_en = now()
      where evidencia_id = ${evidenciaId} and workspace_id = ${ws}`;
    try {
      await expect(
        admin`update gate_instancia set estado = 'aprobado', aprobado_por = ${leadId},
          aprobado_en = now() where id = ${gateId}`,
      ).rejects.toThrow(/derechos vigentes/);
    } finally {
      await admin`update derecho_uso set estado = 'concedido', ambito = 'cliente',
        base = 'Contrato de prueba', decidido_por = ${leadId}, decidido_en = now()
        where evidencia_id = ${evidenciaId} and workspace_id = ${ws}`;
    }
  });

  /**
   * Lo que G3 certificó no se cambia por debajo. La ventana estaba solo en el INSERT.
   *
   * Nació escrita únicamente en `oportunidad_insert`, y ahí dejaba abierto justo lo que más
   * importa: con G3 aprobado se podía BORRAR el último enlace de una oportunidad viva y dejar
   * el gate firmado incumpliendo SYS-15, sin que nadie reabriera nada. El guard del gate no lo
   * desmiente porque solo corre al aprobar.
   *
   * Ahora la ventana la miran las CUATRO políticas del portafolio, y por eso está escrita una
   * sola vez (`reto_admite_portafolio`): cuatro copias de la misma condición es cómo empezó
   * esto — con una.
   */
  it('con G3 aprobado, el portafolio no se toca: ni se añade, ni se enlaza, ni se desenlaza', async () => {
    const admin = sqlAdmin();
    const [srv] = await admin`insert into servicio (workspace_id, nombre, estado, creado_por)
      values (${ws}, 'Servicio ventana', 'activo', ${leadId}) returning id`;
    const [r] = await admin`insert into reto
      (workspace_id, servicio_ancla_id, codigo, titulo, descripcion, estado, metrica_objetivo, creado_por)
      values (${ws}, ${srv!.id as string}, 'R-VEN', 'Reto de la ventana', 'Descripción',
              'activo', 'Ninguna', ${leadId}) returning id`;
    const retoV = r!.id as string;
    const [p] = await admin`insert into proyecto
      (workspace_id, reto_id, codigo, titulo, estado, perfil, creado_por)
      values (${ws}, ${retoV}, 'P-VEN', 'Proyecto de la ventana', 'activo', 'rapido', ${leadId})
      returning id`;
    const proyectoV = p!.id as string;
    const [g] = await admin`insert into gate_instancia
      (workspace_id, proyecto_id, numero, rol_aprobador)
      values (${ws}, ${proyectoV}, 3, 'sponsor') returning id`;
    const gateV = g!.id as string;
    await admin`insert into checklist_item
      (workspace_id, gate_id, orden, texto, estado, insight_id)
      values (${ws}, ${gateV}, 0, 'El portafolio está razonado', 'cumplido', ${insightValidado})`;
    // La etapa 3 instanciada y COMPLETADA: reabrirla («en-curso») es lo que vuelve a abrir la ventana.
    await admin`insert into etapa_instancia (workspace_id, proyecto_id, numero, nombre, estado)
      values (${ws}, ${proyectoV}, 3, 'Conceptualización', 'completada')`;

    // Antes de firmar: una viva y trazada, y otra que se quedará por decidir.
    const viva = await crearOportunidad(leadId, {
      workspaceId: ws, retoId: retoV, pregunta: 'HMW de la ventana', prioridad: 0, prioridadRazon: '',
    });
    await enlazarInsight(leadId, {
      workspaceId: ws, oportunidadId: viva.oportunidadId, insightId: insightValidado,
    });
    await admin`update gate_instancia set estado = 'aprobado', aprobado_por = ${leadId},
      aprobado_en = now() where id = ${gateV}`;

    // Y a partir de aquí, nada. El desenlace es el caso serio: dejaría G3 firmado sobre una
    // oportunidad viva sin traza.
    await expect(
      desenlazarInsight(leadId, {
        workspaceId: ws, oportunidadId: viva.oportunidadId, insightId: insightValidado,
      }),
    ).rejects.toThrow(ErrorOportunidad);
    await expect(
      crearOportunidad(leadId, {
        workspaceId: ws, retoId: retoV, pregunta: 'HMW tardía', prioridad: 0, prioridadRazon: '',
      }),
      // El mensaje lo pone ahora el guard y no la política: un trigger BEFORE corre antes
      // del WITH CHECK, así que llega primero — y dice mejor qué pasa y cuál es la salida.
    ).rejects.toThrow(/su portafolio no se toca sin reabrir la etapa 3/);
    await expect(
      priorizarOportunidad(leadId, {
        workspaceId: ws, oportunidadId: viva.oportunidadId, prioridad: 9, prioridadRazon: '',
      }),
    ).rejects.toThrow(ErrorOportunidad);
    await expect(
      decidirOportunidad(leadId, {
        workspaceId: ws, oportunidadId: viva.oportunidadId, estado: 'aprobada', veredictoRazon: '',
      }),
    ).rejects.toThrow(ErrorOportunidad);
    // El enlace sigue donde estaba: la afirmación del gate se mantiene.
    const enlaces = await admin`select 1 from oportunidad_insight
      where oportunidad_id = ${viva.oportunidadId}`;
    expect(enlaces.length).toBe(1);

    // Y REABRIR la etapa 3 vuelve a abrir la ventana, que es la salida que I1 prevé.
    await admin`update etapa_instancia set estado = 'en-curso'
      where proyecto_id = ${proyectoV} and numero = 3`;
    await priorizarOportunidad(leadId, {
      workspaceId: ws, oportunidadId: viva.oportunidadId, prioridad: 9, prioridadRazon: 'Reabierta',
    });
    const [tras] = await admin`select prioridad from oportunidad where id = ${viva.oportunidadId}`;
    expect(tras!.prioridad).toBe(9);
  });

  /**
   * La razón de un veredicto no se reescribe sin veredicto — y por eso el archivo puede contar.
   *
   * `oportunidad_auditoria` clasifica por descarte: si el UPDATE no cambió el estado, se
   * repriorizó. El grant, sin embargo, deja tocar `veredicto_razon`, y la política solo exige
   * que la fila siga en 'propuesta'. Así que un `update … set veredicto_razon = …` entraba y
   * quedaba apuntado como `OportunidadRepriorizada`: el archivo describía una acción que no
   * ocurrió, y contar repriorizaciones daba un número inventado.
   *
   * La salida no es un tipo de evento nuevo, es que no ocurra: esa razón explica una decisión, y
   * cambiarla sin decidir nada reescribe el archivo. Cerrada la rendija, el `else` de la
   * auditoría es verdad por construcción.
   */
  it('la razón del veredicto no se toca sin veredicto, y el archivo no inventa repriorizaciones', async () => {
    const admin = sqlAdmin();
    const { oportunidadId } = await crearOportunidad(leadId, {
      workspaceId: ws,
      retoId,
      pregunta: '¿Cómo podríamos no reescribir el archivo?',
      prioridad: 1,
      prioridadRazon: 'Nace priorizada',
    });

    await expect(
      conUsuario(leadId, (tx) => tx`update oportunidad
        set veredicto_razon = 'esto no lo decidió nadie'
        where id = ${oportunidadId} and workspace_id = ${ws}`),
    ).rejects.toThrow(/no se reescribe sin veredicto/);

    // Ni la fila ni el archivo se movieron.
    const [sinTocar] = await admin`select veredicto_razon from oportunidad
      where id = ${oportunidadId}`;
    expect(sinTocar!.veredicto_razon).toBe('');
    const repriorizaciones = await admin`select 1 from evento_dominio
      where workspace_id = ${ws} and tipo = 'OportunidadRepriorizada'
        and payload->>'oportunidadId' = ${oportunidadId}`;
    expect(repriorizaciones.length, 'se apuntó una repriorización que no ocurrió').toBe(0);

    // Y repriorizar de verdad sí deja su rastro, que es la otra mitad.
    await priorizarOportunidad(leadId, {
      workspaceId: ws,
      oportunidadId,
      prioridad: 7,
      prioridadRazon: 'Toca el criterio de tiempo',
    });
    const tras = await admin`select 1 from evento_dominio
      where workspace_id = ${ws} and tipo = 'OportunidadRepriorizada'
        and payload->>'oportunidadId' = ${oportunidadId}`;
    expect(tras.length).toBe(1);
  });

  /**
   * Y esa reapertura tiene que ser DE VERDAD: el 'en-curso' no se pone a mano.
   *
   * La ventana del portafolio se abre cuando la etapa 3 está `en-curso`, y esa lectura la hacen
   * también las ventanas de insight/decisión, de medición y de la capa AI. Pero `grant update
   * (estado) on etapa_instancia` y la política `etapa_update` dejan que el propio lead ponga la
   * etapa en curso por SQL, sin registrar nada: el congelado lo abría, sin dejar rastro,
   * exactamente el rol al que congela — y volver a cerrarla después deja G3 firmado sin que su
   * guard vuelva a correr.
   *
   * Se mide por las dos mitades, que es lo que distingue cerrar la puerta de tapiarla: el
   * atajo se rechaza, y la reapertura registrada sigue abriendo la ventana.
   */
  it('la etapa cerrada no se pone en curso a mano, y la reapertura registrada sí la abre', async () => {
    const admin = sqlAdmin();
    const [srv] = await admin`insert into servicio (workspace_id, nombre, estado, creado_por)
      values (${ws}, 'Servicio reapertura', 'activo', ${leadId}) returning id`;
    const [r] = await admin`insert into reto
      (workspace_id, servicio_ancla_id, codigo, titulo, descripcion, estado, metrica_objetivo, creado_por)
      values (${ws}, ${srv!.id as string}, 'R-REA', 'Reto de la reapertura', 'Descripción',
              'activo', 'Ninguna', ${leadId}) returning id`;
    const retoR = r!.id as string;
    const [p] = await admin`insert into proyecto
      (workspace_id, reto_id, codigo, titulo, estado, perfil, creado_por)
      values (${ws}, ${retoR}, 'P-REA', 'Proyecto de la reapertura', 'activo', 'rapido',
              ${leadId}) returning id`;
    const proyectoR = p!.id as string;
    await admin`insert into etapa_instancia (workspace_id, proyecto_id, numero, nombre, estado)
      values (${ws}, ${proyectoR}, 3, 'Conceptualización', 'completada')`;

    // El atajo: el mismo lead, por SQL, sin registrar nada.
    await expect(
      conUsuario(leadId, (tx) => tx`update etapa_instancia set estado = 'en-curso'
        where proyecto_id = ${proyectoR} and workspace_id = ${ws} and numero = 3`),
    ).rejects.toThrow(/solo se reabre por la puerta/);
    const [sinTocar] = await admin`select estado from etapa_instancia
      where proyecto_id = ${proyectoR} and workspace_id = ${ws} and numero = 3`;
    expect(sinTocar!.estado as string).toBe('completada');

    // Y la puerta: el registro y la etapa, en la misma transacción. No se tapia el camino
    // bueno — si esto se pusiera rojo, el arreglo habría dejado el método sin reaperturas.
    await conUsuario(leadId, async (tx) => {
      await tx`insert into reapertura_etapa
        (workspace_id, proyecto_id, etapa_numero, motivo, alcance, decisiones_marcadas,
         reabierto_por)
        values (${ws}, ${proyectoR}, 3, 'Llegó evidencia que cambia el portafolio',
                'etapa-completa', 0, ${leadId})`;
      await tx`update etapa_instancia set estado = 'en-curso'
        where proyecto_id = ${proyectoR} and workspace_id = ${ws} and numero = 3`;
    });
    const [abierta] = await admin`select estado from etapa_instancia
      where proyecto_id = ${proyectoR} and workspace_id = ${ws} and numero = 3`;
    expect(abierta!.estado as string).toBe('en-curso');
  });

  /**
   * Y la CLAVE del candado tiene que ser la misma que la de la aprobación del gate.
   *
   * La primera versión de este módulo tomaba un candado por oportunidad. Con esa clave, borrar
   * un enlace y firmar G3 no se ven: cada uno bloquea lo suyo, tocan filas distintas, las dos
   * comprobaciones pasan sobre fotos que ya no valen y las dos commitean. Queda G3 firmado
   * sobre una oportunidad viva sin traza, sin que ninguna regla fallara.
   *
   * La sonda usa el candado directamente, sin pasar por el servicio: lo que se afirma es que
   * la ESCRITURA queda serializada contra `designio:reto:` —la clave del guard del gate— venga
   * de donde venga, y eso es una propiedad del trigger, no del servicio.
   */
  it('tocar el portafolio espera al candado del reto, que es el de la aprobación del gate', async () => {
    const admin = sqlAdmin();
    const [srv] = await admin`insert into servicio (workspace_id, nombre, estado, creado_por)
      values (${ws}, 'Servicio candado', 'activo', ${leadId}) returning id`;
    const [r] = await admin`insert into reto
      (workspace_id, servicio_ancla_id, codigo, titulo, descripcion, estado, metrica_objetivo, creado_por)
      values (${ws}, ${srv!.id as string}, 'R-CAN', 'Reto del candado', 'Descripción',
              'activo', 'Ninguna', ${leadId}) returning id`;
    const retoC = r!.id as string;
    const o = await crearOportunidad(leadId, {
      workspaceId: ws, retoId: retoC, pregunta: 'HMW del candado', prioridad: 0, prioridadRazon: '',
    });

    let soltar: () => void = () => {};
    const enVuelo = new Promise<void>((r2) => {
      soltar = r2;
    });
    // Quien firma G3 toma esta clave antes de mirar el portafolio.
    const comoElGate = admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(
        hashtextextended('designio:reto:' || ${retoC}::text, 42))`;
      await enVuelo;
    });
    await new Promise((r2) => setTimeout(r2, 150));

    const enlace = enlazarInsight(leadId, {
      workspaceId: ws, oportunidadId: o.oportunidadId, insightId: insightValidado,
    });
    const veredicto = enlace.then(
      () => 'enlazó',
      (e: Error) => `rechazó: ${e.message}`,
    );
    // Con el candado bien puesto, el enlace NO puede haber terminado: está esperando.
    await new Promise((r2) => setTimeout(r2, 1500));
    const termino = await Promise.race([
      veredicto.then(() => true),
      new Promise<boolean>((r2) => setTimeout(() => r2(false), 50)),
    ]);
    expect(termino, 'el enlace no esperó al candado que toma la aprobación del gate').toBe(false);

    soltar();
    await comoElGate;
    expect(await veredicto).toBe('enlazó');
  }, 20000);

  /**
   * Esperar el candado no basta: hay que VOLVER A PREGUNTAR con él en la mano.
   *
   * Cuando el trigger corre, la fila ya está calificada — la política de RLS se evaluó con la
   * instantánea del inicio de la sentencia, antes de que existiera este candado, y Postgres no
   * la vuelve a evaluar porque un trigger BEFORE se haya quedado esperando. Así, un DELETE que
   * califica su fila mientras G3 se está aprobando, espera, y borra DESPUÉS de que la
   * aprobación commitee: el gate se queda certificando un portafolio que ya perdió su traza,
   * sin que ninguna de las dos reglas fallara.
   *
   * Es la misma forma que el candado del reto de la ronda anterior —serializar sin releer solo
   * mueve la foto un poco más tarde— y por eso la sonda va por SQL DIRECTO: no comprueba que
   * el servicio se porte bien, comprueba que el suelo aguanta a quien no pasa por él.
   */
  it('un borrado que esperó al candado se encuentra el G3 ya aprobado y no pasa', async () => {
    const admin = sqlAdmin();
    const [srv] = await admin`insert into servicio (workspace_id, nombre, estado, creado_por)
      values (${ws}, 'Servicio relectura', 'activo', ${leadId}) returning id`;
    const [r] = await admin`insert into reto
      (workspace_id, servicio_ancla_id, codigo, titulo, descripcion, estado, metrica_objetivo, creado_por)
      values (${ws}, ${srv!.id as string}, 'R-REL', 'Reto de la relectura', 'Descripción',
              'activo', 'Ninguna', ${leadId}) returning id`;
    const retoR = r!.id as string;
    const [p] = await admin`insert into proyecto
      (workspace_id, reto_id, codigo, titulo, estado, perfil, creado_por)
      values (${ws}, ${retoR}, 'P-REL', 'Proyecto de la relectura', 'activo', 'rapido', ${leadId})
      returning id`;
    const proyectoR = p!.id as string;
    const [g] = await admin`insert into gate_instancia
      (workspace_id, proyecto_id, numero, rol_aprobador)
      values (${ws}, ${proyectoR}, 3, 'sponsor') returning id`;
    const gateR = g!.id as string;
    await admin`insert into checklist_item
      (workspace_id, gate_id, orden, texto, estado, insight_id)
      values (${ws}, ${gateR}, 0, 'El portafolio está razonado', 'cumplido', ${insightValidado})`;
    await admin`insert into etapa_instancia (workspace_id, proyecto_id, numero, nombre, estado)
      values (${ws}, ${proyectoR}, 3, 'Conceptualización', 'completada')`;

    const o = await crearOportunidad(leadId, {
      workspaceId: ws, retoId: retoR, pregunta: 'HMW de la relectura', prioridad: 0, prioridadRazon: '',
    });
    await enlazarInsight(leadId, {
      workspaceId: ws, oportunidadId: o.oportunidadId, insightId: insightValidado,
    });

    // La aprobación de G3 toma el candado del reto y se queda abierta.
    let soltar: () => void = () => {};
    const enVuelo = new Promise<void>((r2) => {
      soltar = r2;
    });
    const aprobacion = admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(
        hashtextextended('designio:reto:' || ${retoR}::text, 42))`;
      await tx`update gate_instancia set estado = 'aprobado', aprobado_por = ${leadId},
        aprobado_en = now() where id = ${gateR}`;
      await enVuelo;
    });
    await new Promise((r2) => setTimeout(r2, 150));

    // El borrado entra AHORA, cuando la ventana todavía está abierta para su instantánea: su
    // política pasa. Y se queda esperando en el candado del trigger.
    const borrado = conUsuario(leadId, (tx) => tx`
      delete from oportunidad_insight
      where oportunidad_id = ${o.oportunidadId} and insight_id = ${insightValidado}
        and workspace_id = ${ws}`);
    const veredicto = borrado.then(
      () => 'borró',
      (e: Error) => `rechazó: ${e.message}`,
    );

    await new Promise((r2) => setTimeout(r2, 1500));
    soltar();
    await aprobacion;

    expect(
      await veredicto,
      'el borrado se coló detrás de una aprobación de G3 que ya había commiteado',
    ).toMatch(/no se toca sin reabrir la etapa 3/);
    // Y la traza que el gate certificó sigue ahí.
    const enlaces = await admin`select 1 from oportunidad_insight
      where oportunidad_id = ${o.oportunidadId}`;
    expect(enlaces.length).toBe(1);
  }, 20000);

  /**
   * El predicado no es un oráculo del ciclo de vida ajeno.
   *
   * `reto_admite_portafolio` es SECURITY DEFINER —no pasa por RLS— y está concedida al rol de
   * aplicación, así que sin anti-oráculo cualquiera con un par de uuids ajenos podía
   * preguntarle si aquel reto tiene su G3 aprobado y su etapa cerrada. Lo que se filtra no es
   * una fila: es la RESPUESTA, que distingue dos estados del método de otro cliente.
   *
   * La sonda monta DOS retos ajenos cuya respuesta verdadera es distinta —uno con G3 aprobado
   * y etapa completada, otro sin gate ninguno— y comprueba que para quien no es miembro los
   * dos contestan lo mismo. Si contestaran distinto, la función seguiría siendo un oráculo
   * aunque devolviera «false» en algún caso.
   */
  it('el predicado del portafolio no distingue estados de un workspace ajeno', async () => {
    const admin = sqlAdmin();
    const [wb] = await admin`insert into workspace (nombre) values (${marca + '-ajeno'}) returning id`;
    const wsAjeno = wb!.id as string;
    try {
      const [srv] = await admin`insert into servicio (workspace_id, nombre, estado, creado_por)
        values (${wsAjeno}, 'Servicio ajeno', 'activo', ${leadId}) returning id`;
      const retoAjeno = async (codigo: string, conG3: boolean) => {
        const [r] = await admin`insert into reto
          (workspace_id, servicio_ancla_id, codigo, titulo, descripcion, estado, metrica_objetivo, creado_por)
          values (${wsAjeno}, ${srv!.id as string}, ${codigo}, 'Reto ajeno', 'Descripción',
                  'activo', 'Ninguna', ${leadId}) returning id`;
        const id = r!.id as string;
        if (conG3) {
          const [p] = await admin`insert into proyecto
            (workspace_id, reto_id, codigo, titulo, estado, perfil, creado_por)
            values (${wsAjeno}, ${id}, ${'P-' + codigo}, 'Proyecto ajeno', 'activo', 'rapido',
                    ${leadId}) returning id`;
          await admin`insert into gate_instancia
            (workspace_id, proyecto_id, numero, rol_aprobador, estado, aprobado_por, aprobado_en)
            values (${wsAjeno}, ${p!.id as string}, 3, 'sponsor', 'aprobado', ${leadId}, now())`;
          await admin`insert into etapa_instancia (workspace_id, proyecto_id, numero, nombre, estado)
            values (${wsAjeno}, ${p!.id as string}, 3, 'Conceptualización', 'completada')`;
        }
        return id;
      };
      // La respuesta VERDADERA de estos dos es distinta: cerrado el primero, abierto el segundo.
      const cerrado = await retoAjeno('R-AJ1', true);
      const abierto = await retoAjeno('R-AJ2', false);
      const [comoOwner1] = await admin`select reto_admite_portafolio(${cerrado}, ${wsAjeno}) as v`;
      const [comoOwner2] = await admin`select reto_admite_portafolio(${abierto}, ${wsAjeno}) as v`;
      expect([comoOwner1!.v, comoOwner2!.v], 'el montaje no crea dos estados distintos')
        .toEqual([false, true]);

      // Y para quien no es miembro de ese workspace, las dos contestan lo mismo.
      const preguntar = (reto: string) =>
        conUsuario(leadId, async (tx) => {
          const [f] = await tx`select reto_admite_portafolio(${reto}, ${wsAjeno}) as v`;
          return f!.v as boolean;
        });
      expect([await preguntar(cerrado), await preguntar(abierto)]).toEqual([false, false]);
    } finally {
      await admin`delete from etapa_instancia where workspace_id = ${wsAjeno}`;
      await admin`delete from gate_instancia where workspace_id = ${wsAjeno}`;
      await admin`delete from proyecto where workspace_id = ${wsAjeno}`;
      await admin`delete from reto where workspace_id = ${wsAjeno}`;
      await admin`delete from servicio where workspace_id = ${wsAjeno}`;
      await admin`delete from workspace where id = ${wsAjeno}`;
    }
  });

  /**
   * Y la relectura tenía que mirar TAMBIÉN el estado de la oportunidad, no solo la ventana.
   *
   * La ronda anterior enseñó que esperar el candado no es volver a preguntar. La primera
   * versión de la relectura volvía a preguntar solo por G3 — y el estado de la oportunidad,
   * que es la OTRA condición de la política del enlace, se quedaba con la instantánea del
   * inicio de la sentencia. Así: el borrado califica con la oportunidad todavía `propuesta`,
   * espera detrás de una APROBACIÓN de esa misma oportunidad (que toma el mismo candado del
   * reto), y al soltarse la ventana de G3 sigue abierta —G3 no tiene nada que ver aquí— así
   * que pasa. Queda una oportunidad aprobada sin traza, que es lo mismo que SYS-15 prohíbe,
   * alcanzado por otra puerta.
   *
   * Arreglar una condición y dejar la hermana con la foto vieja es el mismo error una capa más
   * adentro: si hay que releer, se relee todo lo que la política miró.
   */
  it('un borrado que esperó al candado se encuentra la oportunidad ya aprobada y no pasa', async () => {
    const admin = sqlAdmin();
    const [srv] = await admin`insert into servicio (workspace_id, nombre, estado, creado_por)
      values (${ws}, 'Servicio relectura 2', 'activo', ${leadId}) returning id`;
    const [r] = await admin`insert into reto
      (workspace_id, servicio_ancla_id, codigo, titulo, descripcion, estado, metrica_objetivo, creado_por)
      values (${ws}, ${srv!.id as string}, 'R-REL2', 'Reto de la relectura 2', 'Descripción',
              'activo', 'Ninguna', ${leadId}) returning id`;
    const retoR = r!.id as string;
    const o = await crearOportunidad(leadId, {
      workspaceId: ws, retoId: retoR, pregunta: 'HMW de la relectura 2', prioridad: 0, prioridadRazon: '',
    });
    await enlazarInsight(leadId, {
      workspaceId: ws, oportunidadId: o.oportunidadId, insightId: insightValidado,
    });

    // La APROBACIÓN de la oportunidad toma el candado del reto (por su trigger) y se queda
    // abierta. Aquí G3 no entra en nada: la condición que cambia es el estado de la fila.
    let soltar: () => void = () => {};
    const enVuelo = new Promise<void>((r2) => {
      soltar = r2;
    });
    const aprobacion = conUsuario(leadId, async (tx) => {
      await tx`update oportunidad
        set estado = 'aprobada', veredicto_razon = ''
        where id = ${o.oportunidadId} and workspace_id = ${ws}`;
      await enVuelo;
    });
    await new Promise((r2) => setTimeout(r2, 300));

    // El borrado califica AHORA, con la oportunidad todavía `propuesta` para su instantánea.
    const borrado = conUsuario(leadId, (tx) => tx`
      delete from oportunidad_insight
      where oportunidad_id = ${o.oportunidadId} and insight_id = ${insightValidado}
        and workspace_id = ${ws}`);
    const veredicto = borrado.then(
      () => 'borró',
      (e: Error) => `rechazó: ${e.message}`,
    );

    await new Promise((r2) => setTimeout(r2, 1500));
    soltar();
    await aprobacion;

    expect(
      await veredicto,
      'el borrado se coló detrás de una aprobación que ya había commiteado',
    ).toMatch(/ya se decidió|no se toca/);
    const enlaces = await admin`select 1 from oportunidad_insight
      where oportunidad_id = ${o.oportunidadId}`;
    expect(enlaces.length, 'la oportunidad aprobada se quedó sin traza').toBe(1);
  }, 20000);

  /**
   * RF-01.6: toda escritura del portafolio deja rastro, venga de donde venga.
   *
   * Nació cumpliéndolo a medias: el SERVICIO escribía el evento al crear y al decidir, y no
   * al enlazar, al desenlazar ni al repriorizar — y ninguno de los cuatro dejaba rastro si la
   * escritura entraba por la superficie SQL concedida, que es justo la que hay que auditar.
   *
   * El rastro lo escribe ahora un trigger y el servicio ya no, para que haya UN solo escritor:
   * dos dejarían dos filas por una acción hecha desde la app y una por la misma acción hecha
   * por SQL, y entonces el archivo no permite contar nada.
   *
   * La sonda hace las cinco escrituras POR SQL DIRECTO —sin pasar por el servicio— y cuenta
   * los eventos. Es la mitad que el servicio no podía cubrir ni cubriendo el resto.
   */
  it('toda escritura del portafolio deja su evento, también por SQL directo', async () => {
    const admin = sqlAdmin();
    const [srv] = await admin`insert into servicio (workspace_id, nombre, estado, creado_por)
      values (${ws}, 'Servicio auditoría', 'activo', ${leadId}) returning id`;
    const [r] = await admin`insert into reto
      (workspace_id, servicio_ancla_id, codigo, titulo, descripcion, estado, metrica_objetivo, creado_por)
      values (${ws}, ${srv!.id as string}, 'R-AUD', 'Reto de auditoría', 'Descripción',
              'activo', 'Ninguna', ${leadId}) returning id`;
    const retoA = r!.id as string;

    const tiposDe = async (): Promise<string[]> => {
      const filas = await admin`select tipo, payload from evento_dominio
        where workspace_id = ${ws} and payload->>'retoId' = ${retoA}
        order by creado_en, id`;
      return filas.map((f) => f.tipo as string);
    };

    // Las CINCO escrituras, todas por la superficie concedida.
    const [o] = await conUsuario(leadId, (tx) => tx`
      insert into oportunidad (workspace_id, reto_id, pregunta, prioridad, prioridad_razon, creado_por)
      values (${ws}, ${retoA}, 'HMW auditada', 3, 'Porque sí', ${leadId})
      returning id`);
    const oportunidadId = o!.id as string;
    await conUsuario(leadId, (tx) => tx`
      insert into oportunidad_insight (oportunidad_id, insight_id, workspace_id)
      values (${oportunidadId}, ${insightValidado}, ${ws})`);
    await conUsuario(leadId, (tx) => tx`
      update oportunidad set prioridad = 7, prioridad_razon = 'Cambió el criterio'
      where id = ${oportunidadId} and workspace_id = ${ws}`);
    await conUsuario(leadId, (tx) => tx`
      delete from oportunidad_insight
      where oportunidad_id = ${oportunidadId} and insight_id = ${insightValidado}
        and workspace_id = ${ws}`);
    // Se vuelve a enlazar para poder aprobar: SYS-15 lo exige, y de paso el rastro lleva
    // las dos trazas.
    await conUsuario(leadId, (tx) => tx`
      insert into oportunidad_insight (oportunidad_id, insight_id, workspace_id)
      values (${oportunidadId}, ${insightValidado}, ${ws})`);
    await conUsuario(leadId, (tx) => tx`
      update oportunidad set estado = 'aprobada', veredicto_razon = ''
      where id = ${oportunidadId} and workspace_id = ${ws}`);

    expect(await tiposDe()).toEqual([
      'OportunidadPropuesta',
      'OportunidadTrazada',
      'OportunidadRepriorizada',
      'OportunidadDestrazada',
      'OportunidadTrazada',
      'OportunidadDecidida',
    ]);

    // Y el rastro se entiende SOLO: el evento del enlace nombra el reto y la pregunta, no
    // solo ids que obliguen a ir a buscar la fila.
    const [trazado] = await admin`select payload from evento_dominio
      where workspace_id = ${ws} and tipo = 'OportunidadTrazada'
        and payload->>'oportunidadId' = ${oportunidadId}
      order by creado_en limit 1`;
    expect((trazado!.payload as { pregunta: string; insightId: string })).toMatchObject({
      pregunta: 'HMW auditada',
      insightId: insightValidado,
    });

    // Un solo escritor: el servicio no duplica lo que el trigger ya anotó.
    const porServicio = await crearOportunidad(leadId, {
      workspaceId: ws, retoId: retoA, pregunta: 'HMW por el servicio', prioridad: 0, prioridadRazon: '',
    });
    const [n] = await admin`select count(*)::int as n from evento_dominio
      where workspace_id = ${ws} and tipo = 'OportunidadPropuesta'
        and payload->>'oportunidadId' = ${porServicio.oportunidadId}`;
    expect(n!.n, 'la misma acción dejó dos filas de auditoría').toBe(1);
  });
});
