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
import { reabrirEtapa } from '@/lib/metodo/gobernanza.servicio';
import { abrirMedicion } from '@/lib/medicion/medicion.servicio';
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
    // La decisión cuelga del gate: sin esta línea la limpieza muere en la FK.
    await admin`delete from decision_insight where workspace_id = ${ws}`;
    await admin`delete from decision where workspace_id = ${ws}`;
    await admin`delete from gate_instancia where workspace_id = ${ws}`;
    await admin`delete from etapa_instancia where workspace_id = ${ws}`;
    await admin`delete from reapertura_insight where workspace_id = ${ws}`;
    await admin`delete from reapertura_etapa where workspace_id = ${ws}`;
    await admin`delete from proyecto where workspace_id = ${ws}`;
    // El registry cuelga del reto: sin esta línea la limpieza muere en el `delete from reto`.
    await admin`delete from metric_registry where workspace_id = ${ws}`;
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
    ).rejects.toThrow(/su G3 está aprobado sin la etapa 3 reabierta/);
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

    // Ni tampoco un UPDATE que no mueve nada. La pantalla lo produce sola —se edita la
    // prioridad, se deshace la edición y se guarda—, y por SQL basta con reasignar lo que ya
    // está. Anotarlo daba una fila idéntica a la anterior: ruido indistinguible de una
    // repriorización de verdad.
    await conUsuario(leadId, (tx) => tx`update oportunidad
      set prioridad = 1, prioridad_razon = 'Nace priorizada'
      where id = ${oportunidadId} and workspace_id = ${ws}`);
    const inmoviles = await admin`select 1 from evento_dominio
      where workspace_id = ${ws} and tipo = 'OportunidadRepriorizada'
        and payload->>'oportunidadId' = ${oportunidadId}`;
    expect(inmoviles.length, 'un update que repite los mismos valores se apuntó').toBe(0);

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

    // Y el atajo EN DOS PASOS, que es por donde se colaba el primer arreglo: bajar a
    // 'pendiente' y subir desde ahí no toca la transición vigilada ni una sola vez. Por eso
    // la puerta se mide sobre SALIR de 'completada' y no sobre entrar en 'en-curso'.
    await expect(
      conUsuario(leadId, (tx) => tx`update etapa_instancia set estado = 'pendiente'
        where proyecto_id = ${proyectoR} and workspace_id = ${ws} and numero = 3`),
    ).rejects.toThrow(/una etapa completada no vuelve a pendiente/);
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

    // Y el rodeo POR EL OTRO LADO, que es el que quedaba: vigilar solo la salida deja
    // entrar en 'completada' a mano. Reabierta la etapa por la puerta, el lead añade una
    // oportunidad sin traza y vuelve a cerrar por SQL — y así el gate quedaba firmado
    // sobre un portafolio que la base misma declara en falta.
    const [huerfana] = await conUsuario(leadId, (tx) => tx`insert into oportunidad
      (workspace_id, reto_id, pregunta, prioridad, prioridad_razon, creado_por)
      values (${ws}, ${retoR}, '¿Cómo podríamos saltarnos la traza?', 1, 'Sin apoyo',
              ${leadId}) returning id`);
    expect(huerfana!.id).toBeTruthy();
    await expect(
      conUsuario(leadId, (tx) => tx`update etapa_instancia set estado = 'completada'
        where proyecto_id = ${proyectoR} and workspace_id = ${ws} and numero = 3`),
    ).rejects.toThrow(/una etapa se cierra al firmar su gate/);
    const [sigueAbierta] = await admin`select estado from etapa_instancia
      where proyecto_id = ${proyectoR} and workspace_id = ${ws} and numero = 3`;
    expect(sigueAbierta!.estado as string).toBe('en-curso');
  });

  /**
   * Y un REGISTRO de reapertura no es una reapertura hasta que arrastra sus efectos.
   *
   * La puerta de arriba convirtió `reapertura_etapa` en una fila que MANDA: mientras exista con
   * la hora de esta transacción, la etapa sale de 'completada' y con ella se abren todas las
   * ventanas del ciclo. Y lo que exigía era que la fila EXISTIERA, que no es lo mismo que que la
   * reapertura haya ocurrido. Medido, con un lead escribiendo registro y etapa en la misma
   * transacción por la superficie concedida: `decision=vigente`, `eventos=0`, `etapa=en-curso` y
   * la ventana del portafolio abierta. El registro era la coartada, no el acto.
   *
   * Se mide por las dos mitades y por el camino de verdad: el atajo se rechaza, y `reabrirEtapa`
   * —que sí propaga— sigue funcionando y deja su evento, que ahora lo emite la BASE.
   */
  it('una reapertura sin sus efectos no pasa, y la de verdad deja su rastro', async () => {
    const admin = sqlAdmin();
    const [srv] = await admin`insert into servicio (workspace_id, nombre, estado, creado_por)
      values (${ws}, 'Servicio de los efectos', 'activo', ${leadId}) returning id`;
    const [r] = await admin`insert into reto
      (workspace_id, servicio_ancla_id, codigo, titulo, descripcion, estado, metrica_objetivo,
       creado_por)
      values (${ws}, ${srv!.id as string}, 'R-EFE', 'Reto de los efectos', 'Descripción',
              'activo', 'Ninguna', ${leadId}) returning id`;
    const retoE = r!.id as string;
    const [p] = await admin`insert into proyecto
      (workspace_id, reto_id, codigo, titulo, estado, perfil, creado_por)
      values (${ws}, ${retoE}, 'P-EFE', 'Proyecto', 'activo', 'rapido', ${leadId}) returning id`;
    const proyectoE = p!.id as string;
    await admin`insert into etapa_instancia (workspace_id, proyecto_id, numero, nombre, estado)
      values (${ws}, ${proyectoE}, 3, 'Conceptualización', 'completada')`;
    const [g] = await admin`insert into gate_instancia
      (workspace_id, proyecto_id, numero, rol_aprobador)
      values (${ws}, ${proyectoE}, 3, 'sponsor') returning id`;
    // Una decisión VIGENTE de ese gate: es la que `reabrirEtapa` pone «en-revisión», y la que
    // el atajo dejaba en pie mientras abría la ventana.
    const [d] = await admin`insert into decision
      (workspace_id, proyecto_id, gate_id, tipo, titulo, fundamento, estado, decidido_por)
      values (${ws}, ${proyectoE}, ${g!.id as string}, 'diseno', 'Se elige el flujo corto',
              'Porque la evidencia lo apoya', 'vigente', ${leadId}) returning id`;
    const decisionE = d!.id as string;

    // El atajo: registro y etapa, sin propagar nada.
    await expect(
      conUsuario(leadId, async (tx) => {
        await tx`insert into reapertura_etapa
          (workspace_id, proyecto_id, etapa_numero, motivo, alcance, decisiones_marcadas,
           reabierto_por)
          values (${ws}, ${proyectoE}, 3, 'Motivo cualquiera', 'etapa-completa', 0, ${leadId})`;
        await tx`update etapa_instancia set estado = 'en-curso'
          where proyecto_id = ${proyectoE} and workspace_id = ${ws} and numero = 3`;
      }),
    ).rejects.toThrow(/deja decisiones aguas abajo en pie/);
    const [quieta] = await admin`select estado from etapa_instancia
      where proyecto_id = ${proyectoE} and workspace_id = ${ws} and numero = 3`;
    expect(quieta!.estado as string).toBe('completada');

    // Y las otras tres formas de escribir un registro que no es una reapertura. Las tres
    // pasaban la primera versión de este guard, que comprobaba los efectos de al lado y no
    // los suyos.
    const registroCon = (
      campos: { alcance?: string; marcadas?: number; abrirEtapa?: boolean } = {},
    ) =>
      conUsuario(leadId, async (tx) => {
        await tx`insert into reapertura_etapa
          (workspace_id, proyecto_id, etapa_numero, motivo, alcance, decisiones_marcadas,
           reabierto_por)
          values (${ws}, ${proyectoE}, 3, 'Motivo cualquiera',
                  ${campos.alcance ?? 'etapa-completa'}, ${campos.marcadas ?? 1}, ${leadId})`;
        // La propagación, que es la que el guard exigía desde el principio.
        await tx`update decision set estado = 'en-revision' where id = ${decisionE}`;
        if (campos.abrirEtapa !== false) {
          await tx`update etapa_instancia set estado = 'en-curso'
            where proyecto_id = ${proyectoE} and workspace_id = ${ws} and numero = 3`;
        }
      });

    // 1. El ALCANCE DECLARADO que no declara nada: la primera rama del predicado es falsa y el
    //    `exists` está vacío, así que toda decisión quedaba fuera y la comprobación pasaba en
    //    vacío. Una reapertura que no acota nada abriendo con menos requisitos que la completa.
    await expect(registroCon({ alcance: 'declarado' })).rejects.toThrow(
      /no declara ningún insight/,
    );
    // 2. El registro SIN abrir la etapa: propagación hecha, etapa 'completada', y un
    //    `EtapaReabierta` en el archivo de algo que no ocurrió.
    await expect(registroCon({ abrirEtapa: false })).rejects.toThrow(/no abre nada/);
    // 3. Y el NÚMERO inventado. Lo dejé a medias a propósito —el evento contaba y la columna
    //    era del llamante— y estaba mal: `SeccionGobernanza` pinta la columna, así que la
    //    pantalla y el archivo podían decir dos números distintos de la misma reapertura.
    await expect(registroCon({ marcadas: 7 })).rejects.toThrow(/dice haber marcado 7/);

    // Y la reapertura DE VERDAD, por su servicio: propaga, abre y deja su evento.
    const { decisionesMarcadas } = await reabrirEtapa(leadId, {
      workspaceId: ws,
      proyectoId: proyectoE,
      etapaNumero: 3,
      motivo: 'Llegó evidencia que cambia el portafolio',
      insightIds: [],
    });
    expect(decisionesMarcadas).toBe(1);
    const [tras] = await admin`select estado from decision where id = ${decisionE}`;
    expect(tras!.estado as string).toBe('en-revision');
    const [abierta] = await admin`select estado from etapa_instancia
      where proyecto_id = ${proyectoE} and workspace_id = ${ws} and numero = 3`;
    expect(abierta!.estado as string).toBe('en-curso');
    // El evento lo emite ahora la BASE, no el servicio: UNO, con el número CONTADO —no el
    // que declara la columna— y con el actor del mismo snapshot que escribió la fila.
    const eventos = await admin`select payload, actor_id, actor_rol from evento_dominio
      where workspace_id = ${ws} and tipo = 'EtapaReabierta'
        and payload->>'proyectoId' = ${proyectoE}`;
    expect(eventos.length, 'dos escritores del mismo evento, o ninguno').toBe(1);
    expect((eventos[0]!.payload as Record<string, unknown>).decisionesMarcadas).toBe(1);
    expect((eventos[0]!.payload as Record<string, unknown>).alcance).toBe('etapa-completa');
    expect(eventos[0]!.actor_id).toBe(leadId);
    expect(eventos[0]!.actor_rol).toBe('lead-boutique');
  });

  /**
   * Y una decisión que YA estaba en revisión no se cuenta otra vez.
   *
   * El conteo del guard dice «las decisiones del alcance que ESTA transacción movió», y lo
   * pregunta por `xmin`. Pero Postgres reescribe la tupla también cuando el UPDATE no cambia
   * nada: `update decision set estado = 'en-revision'` sobre una que ya estaba así le pone el
   * `xmin` de esta transacción igual, así que entraba en la cuenta. Medido: una reapertura
   * declaraba dos decisiones marcadas habiendo movido una, y el `EtapaReabierta` lo archivaba
   * — trabajo que no ocurrió, en el número que la pantalla enseña.
   *
   * Y por el otro lado también molestaba: el rechazo por alcance mira las decisiones con el
   * `xmin` de la transacción, así que un roce sin efecto sobre una decisión de FUERA del
   * alcance tumbaba una reapertura legítima.
   *
   * Se cierra en la escritura y no en el conteo: un UPDATE que deja la fila idéntica no se
   * escribe. Es la misma forma que ya tienen `oportunidad_auditoria` —que no apunta una
   * repriorización que no movió nada— y la rama de `entrada_kpi`, y aquí es además lo único
   * que arregla los dos lados a la vez. `is not distinct from` sobre la fila ENTERA, no sobre
   * `estado`: así no puede tapar un cambio de verdad en ninguna otra columna.
   */
  it('rozar una decisión que ya estaba en revisión no la vuelve a contar', async () => {
    const admin = sqlAdmin();
    const [srv] = await admin`insert into servicio (workspace_id, nombre, estado, creado_por)
      values (${ws}, 'Servicio del roce', 'activo', ${leadId}) returning id`;
    const [r] = await admin`insert into reto
      (workspace_id, servicio_ancla_id, codigo, titulo, descripcion, estado, metrica_objetivo,
       creado_por)
      values (${ws}, ${srv!.id as string}, 'R-ROCE', 'Reto del roce', 'Descripción', 'activo',
              'Ninguna', ${leadId}) returning id`;
    const [p] = await admin`insert into proyecto
      (workspace_id, reto_id, codigo, titulo, estado, perfil, creado_por)
      values (${ws}, ${r!.id as string}, 'P-ROCE', 'Proyecto', 'activo', 'rapido', ${leadId})
      returning id`;
    const proyectoR = p!.id as string;
    await admin`insert into etapa_instancia (workspace_id, proyecto_id, numero, nombre, estado)
      values (${ws}, ${proyectoR}, 3, 'Conceptualización', 'completada')`;
    const [g] = await admin`insert into gate_instancia
      (workspace_id, proyecto_id, numero, rol_aprobador)
      values (${ws}, ${proyectoR}, 3, 'sponsor') returning id`;
    const decisionEn = async (titulo: string, estado: string) => {
      const [d] = await admin`insert into decision
        (workspace_id, proyecto_id, gate_id, tipo, titulo, fundamento, estado, decidido_por)
        values (${ws}, ${proyectoR}, ${g!.id as string}, 'diseno', ${titulo}, 'Fundamento',
                ${estado}, ${leadId}) returning id`;
      return d!.id as string;
    };
    // Una que YA venía en revisión —de una reapertura anterior— y otra viva.
    const vieja = await decisionEn('Se revisó ya en su día', 'en-revision');
    const nueva = await decisionEn('Se elige el flujo corto', 'vigente');

    const reabrirDeclarando = (marcadas: number) =>
      conUsuario(leadId, async (tx) => {
        await tx`insert into reapertura_etapa
          (workspace_id, proyecto_id, etapa_numero, motivo, alcance, decisiones_marcadas,
           reabierto_por)
          values (${ws}, ${proyectoR}, 3, 'Llegó evidencia nueva', 'etapa-completa',
                  ${marcadas}, ${leadId})`;
        // Las DOS, como hace el SQL directo que no mira estados: la vieja es el roce.
        await tx`update decision set estado = 'en-revision'
          where id in (${vieja}, ${nueva}) and workspace_id = ${ws}`;
        await tx`update etapa_instancia set estado = 'en-curso'
          where proyecto_id = ${proyectoR} and workspace_id = ${ws} and numero = 3`;
      });

    // Declarar DOS es lo que contaba la base: la vieja no se movió, solo se rozó.
    await expect(reabrirDeclarando(2)).rejects.toThrow(/dice haber marcado 2/);
    // Y declarar UNA —lo que de verdad ocurrió— pasa.
    await reabrirDeclarando(1);
    const [evento] = await admin`select payload from evento_dominio
      where workspace_id = ${ws} and tipo = 'EtapaReabierta'
        and payload->>'proyectoId' = ${proyectoR}`;
    expect(
      (evento!.payload as Record<string, unknown>).decisionesMarcadas,
      'el archivo declara trabajo que no ocurrió',
    ).toBe(1);
    // Y el roce no dejó rastro: la vieja sigue siendo la misma versión de fila que era.
    const [sigue] = await admin`select estado from decision where id = ${vieja}`;
    expect(sigue!.estado as string).toBe('en-revision');
  });

  /**
   * Y una reapertura reabre algo que estaba CERRADO: el estado final no es la transición.
   *
   * El guard comprobaba que la etapa quedara `en-curso`, que es el efecto, y no que hubiera
   * SALIDO de 'completada', que es el acto. Con la puerta de gobernanza —que lista todas las
   * etapas— eso se alcanzaba sin SQL directo: eligiendo una etapa que ya estaba en curso, o una
   * que nunca se cerró, el registro pasaba, las decisiones de aguas abajo se movían a
   * «en-revisión» y el archivo recibía un `EtapaReabierta` de algo que no ocurrió.
   *
   * Se cierra por los dos lados, cada uno donde está su información:
   *   · el guard de la reapertura exige que la etapa la haya ESCRITO esta transacción —si ya
   *     estaba en curso y nadie la toca, no hay reapertura que registrar—;
   *   · y la puerta de la etapa, que sí ve el estado anterior, rechaza entrar en 'en-curso'
   *     desde algo que no era 'completada' cuando hay un registro de esta transacción.
   */
  it('una reapertura solo reabre lo que estaba cerrado', async () => {
    const admin = sqlAdmin();
    const [srv] = await admin`insert into servicio (workspace_id, nombre, estado, creado_por)
      values (${ws}, 'Servicio de la transición', 'activo', ${leadId}) returning id`;
    const [r] = await admin`insert into reto
      (workspace_id, servicio_ancla_id, codigo, titulo, descripcion, estado, metrica_objetivo,
       creado_por)
      values (${ws}, ${srv!.id as string}, 'R-TRA', 'Reto de la transición', 'Descripción',
              'activo', 'Ninguna', ${leadId}) returning id`;
    const [p] = await admin`insert into proyecto
      (workspace_id, reto_id, codigo, titulo, estado, perfil, creado_por)
      values (${ws}, ${r!.id as string}, 'P-TRA', 'Proyecto', 'activo', 'rapido', ${leadId})
      returning id`;
    const proyectoT = p!.id as string;
    // La etapa 4 nace PENDIENTE —nunca se cerró— y la 3 en curso, ya reabierta antes.
    await admin`insert into etapa_instancia (workspace_id, proyecto_id, numero, nombre, estado)
      values (${ws}, ${proyectoT}, 3, 'Conceptualización', 'en-curso'),
             (${ws}, ${proyectoT}, 4, 'Exploración de soluciones', 'pendiente')`;

    const registrar = (etapa: number) =>
      conUsuario(leadId, async (tx) => {
        await tx`insert into reapertura_etapa
          (workspace_id, proyecto_id, etapa_numero, motivo, alcance, decisiones_marcadas,
           reabierto_por)
          values (${ws}, ${proyectoT}, ${etapa}, 'Motivo', 'etapa-completa', 0, ${leadId})`;
        await tx`update etapa_instancia set estado = 'en-curso'
          where proyecto_id = ${proyectoT} and workspace_id = ${ws} and numero = ${etapa}`;
      });

    // La que YA estaba en curso: no hay nada que reabrir. La puerta de la etapa lo ve porque
    // el update sí ocurre —de 'en-curso' a 'en-curso'— y ella mira de dónde viene.
    await expect(registrar(3)).rejects.toThrow(/no estaba cerrada/i);
    // Y el mismo caso SIN tocar la etapa, que es el que solo ve el guard de la reapertura: sin
    // update no hay puerta que se dispare, y lo único que queda por preguntar es si esta
    // transacción escribió la etapa.
    await expect(
      conUsuario(leadId, (tx) => tx`insert into reapertura_etapa
        (workspace_id, proyecto_id, etapa_numero, motivo, alcance, decisiones_marcadas,
         reabierto_por)
        values (${ws}, ${proyectoT}, 3, 'Motivo', 'etapa-completa', 0, ${leadId})`),
    ).rejects.toThrow(/no salió de completada en esta transacción/);
    // Y la que nunca se cerró: empezar una etapa no es reabrirla.
    await expect(registrar(4)).rejects.toThrow(/no estaba cerrada/i);
    const eventos = await admin`select 1 from evento_dominio
      where workspace_id = ${ws} and tipo = 'EtapaReabierta'
        and payload->>'proyectoId' = ${proyectoT}`;
    expect(eventos.length, 'el archivo recibió una reapertura que no ocurrió').toBe(0);

    // Y una etapa que sí estaba cerrada se reabre igual: no se tapia el camino bueno.
    await admin`update etapa_instancia set estado = 'completada'
      where proyecto_id = ${proyectoT} and workspace_id = ${ws} and numero = 4`;
    await registrar(4);
    const [abierta] = await admin`select estado from etapa_instancia
      where proyecto_id = ${proyectoT} and workspace_id = ${ws} and numero = 4`;
    expect(abierta!.estado as string).toBe('en-curso');
  });

  /**
   * Y el ALCANCE de una reapertura no crece después de ocurrida.
   *
   * Todo lo que comprueba la reapertura —el alcance, la propagación, el número, el evento— vive
   * en un constraint trigger que corre al INSERTAR la fila. Después de ese commit, el mismo
   * lead podía añadirle un `reapertura_insight` por la superficie concedida: el guard de autor
   * lo permitía —es su reapertura— y ninguna de las comprobaciones volvía a correr. Con eso una
   * reapertura de etapa completa adquiría insights declarados —justo lo que la ronda anterior
   * cerró en el nacimiento— y una declarada ensanchaba su alcance sin marcar las decisiones que
   * el alcance nuevo alcanza. La fila y el evento, que es inmutable, dejaban de decir lo mismo.
   *
   * La regla es que el alcance NACE con su reapertura: `reapertura_insight` solo se escribe en
   * la transacción que escribió su fila padre. No es una restricción nueva sobre el producto
   * —`reabrirEtapa` los escribe juntos en una sentencia—, es la que ya se cumplía sin estar
   * dicha.
   */
  it('el alcance declarado nace con su reapertura y no crece después', async () => {
    const admin = sqlAdmin();
    const [srv] = await admin`insert into servicio (workspace_id, nombre, estado, creado_por)
      values (${ws}, 'Servicio del alcance tardío', 'activo', ${leadId}) returning id`;
    const [r] = await admin`insert into reto
      (workspace_id, servicio_ancla_id, codigo, titulo, descripcion, estado, metrica_objetivo,
       creado_por)
      values (${ws}, ${srv!.id as string}, 'R-TAR', 'Reto del alcance tardío', 'Descripción',
              'activo', 'Ninguna', ${leadId}) returning id`;
    const [p] = await admin`insert into proyecto
      (workspace_id, reto_id, codigo, titulo, estado, perfil, creado_por)
      values (${ws}, ${r!.id as string}, 'P-TAR', 'Proyecto', 'activo', 'rapido', ${leadId})
      returning id`;
    const proyectoT = p!.id as string;
    await admin`insert into etapa_instancia (workspace_id, proyecto_id, numero, nombre, estado)
      values (${ws}, ${proyectoT}, 3, 'Conceptualización', 'completada')`;

    // Una reapertura LEGÍTIMA y completa, sin nada declarado: la de verdad, por su puerta.
    const { decisionesMarcadas } = await reabrirEtapa(leadId, {
      workspaceId: ws,
      proyectoId: proyectoT,
      etapaNumero: 3,
      motivo: 'Llegó evidencia que cambia el concepto',
      insightIds: [],
    });
    expect(decisionesMarcadas).toBe(0);
    const [fila] = await admin`select id, alcance from reapertura_etapa
      where proyecto_id = ${proyectoT} and workspace_id = ${ws}`;
    expect(fila!.alcance as string).toBe('etapa-completa');

    // Y DESPUÉS, en otra transacción, se le cuelga un insight declarado.
    await expect(
      conUsuario(leadId, (tx) => tx`insert into reapertura_insight
        (workspace_id, reapertura_id, insight_id)
        values (${ws}, ${fila!.id as string}, ${insightValidado})`),
    ).rejects.toThrow(/se declara al reabrir/i);
    const declarados = await admin`select 1 from reapertura_insight
      where reapertura_id = ${fila!.id as string}`;
    expect(declarados.length, 'el alcance creció después del evento que lo archivó').toBe(0);
  });

  /**
   * Y la pregunta se compara NORMALIZADA, o el duplicado entra con un espacio.
   *
   * `unique (reto_id, pregunta)` sobre el texto crudo distingue «¿Cómo podríamos avisar?» de
   * « ¿Cómo podríamos avisar? », y las dos pasan el CHECK de no-vacío. El servicio recorta, y
   * por eso desde la pantalla no se nota; la superficie SQL concedida es la que esta migración
   * protege en todo lo demás, y por ahí entraban las dos. Un portafolio con la misma HMW dos
   * veces reparte el mismo voto dos veces, que es justo lo que el único existe para impedir.
   *
   * `titulo_normalizado` y no `btrim`: es la función que este esquema ya usa para lo mismo en
   * `elemento_cambio`, y colapsa además los espacios de dentro, el caso y los acentos.
   */
  it('la misma pregunta con otros espacios no entra dos veces', async () => {
    const proponer = (pregunta: string) =>
      conUsuario(leadId, (tx) => tx`insert into oportunidad
        (workspace_id, reto_id, pregunta, prioridad, prioridad_razon, creado_por)
        values (${ws}, ${retoId}, ${pregunta}, 1, 'Razón', ${leadId})`);
    await proponer('¿Cómo podríamos avisar del corte?');
    await expect(proponer('  ¿Cómo   podríamos avisar del corte?  ')).rejects.toThrow(
      /duplicate key|unique/i,
    );
    // Y una pregunta DISTINTA sigue entrando: el normalizador no puede colapsarlo todo.
    await proponer('¿Cómo podríamos avisar del corte por SMS?');
  });

  /**
   * Y «no vacío» tiene que decirlo de TODOS los blancos, no solo del espacio.
   *
   * `btrim(x)` con un solo argumento recorta ESPACIOS y nada más: un tabulador, un salto de
   * línea o un espacio duro pasan el CHECK enteros. Con eso entraba una HMW cuya pregunta es
   * un tabulador —y G3 la certifica igual, porque SYS-15 habla de su traza, no de su texto— y
   * se descartaba una oportunidad con una razón que no dice nada, que es justo lo que exigir
   * la razón venía a impedir. Los dos esquemas Zod lo prohíben con `.trim().min(1)`, que sí
   * conoce todos los blancos; la superficie SQL concedida no.
   *
   * Se comprueba con `titulo_normalizado`, que es la misma función con la que este esquema
   * decide si dos preguntas son la misma: si normalizada queda vacía, es que no había texto.
   * Tener dos ideas distintas de «vacío» en la misma columna es cómo se separan.
   */
  it('un texto de solo blancos no pasa por escrito: ni la pregunta ni la razón del descarte', async () => {
    const admin = sqlAdmin();
    const BLANCOS = ['\t', '\n', '\u00a0'];
    for (const blanco of BLANCOS) {
      await expect(
        conUsuario(leadId, (tx) => tx`insert into oportunidad
          (workspace_id, reto_id, pregunta, prioridad, prioridad_razon, creado_por)
          values (${ws}, ${retoId}, ${blanco}, 1, 'Razón', ${leadId})`),
      ).rejects.toThrow();
    }
    // Y la razón del descarte, por la otra puerta: la de UPDATE.
    const [o] = await conUsuario(leadId, (tx) => tx`insert into oportunidad
      (workspace_id, reto_id, pregunta, prioridad, prioridad_razon, creado_por)
      values (${ws}, ${retoId}, '¿Cómo podríamos descartar con un tabulador?', 1, 'Razón',
              ${leadId}) returning id`);
    for (const blanco of BLANCOS) {
      await expect(
        conUsuario(leadId, (tx) => tx`update oportunidad
          set estado = 'descartada', veredicto_razon = ${blanco}
          where id = ${o!.id as string} and workspace_id = ${ws}`),
      ).rejects.toThrow();
    }
    // Y el TECHO de los tres textos, que es la otra mitad de «lo que la API puede crear».
    //
    // Lo dejé fuera una ronda con el argumento de que este esquema no acota por longitud
    // ningún otro texto libre, y era falso: lo hacen `comentario.cuerpo`,
    // `consentimiento_item.alcance`, `acuerdo_disposicion.base`, `llamada_ai.motivo` y
    // `archivo_importado.nombre`. Y lo que entra por aquí no se queda en la fila: la pregunta
    // y las razones se copian al evento de dominio —append-only— y viajan enteras en cada
    // carga del portafolio.
    await expect(
      conUsuario(leadId, (tx) => tx`insert into oportunidad
        (workspace_id, reto_id, pregunta, prioridad, prioridad_razon, creado_por)
        values (${ws}, ${retoId}, ${'¿' + 'x'.repeat(500)}, 1, 'Razón', ${leadId})`),
    ).rejects.toThrow();
    await expect(
      conUsuario(leadId, (tx) => tx`insert into oportunidad
        (workspace_id, reto_id, pregunta, prioridad, prioridad_razon, creado_por)
        values (${ws}, ${retoId}, '¿Cómo podríamos razonar de más?', 1, ${'x'.repeat(2001)},
                ${leadId})`),
    ).rejects.toThrow();
    // Y justo en el techo entran: un límite que no admite su borde está mal escrito.
    await conUsuario(leadId, (tx) => tx`insert into oportunidad
      (workspace_id, reto_id, pregunta, prioridad, prioridad_razon, creado_por)
      values (${ws}, ${retoId}, ${'x'.repeat(500)}, 1, ${'y'.repeat(2000)}, ${leadId})`);

    // Y una razón DE VERDAD descarta, que es la mitad sin la cual tapiar la puerta pasaría
    // igual.
    await conUsuario(leadId, (tx) => tx`update oportunidad
      set estado = 'descartada', veredicto_razon = 'Se solapa con la HMW del flujo corto'
      where id = ${o!.id as string} and workspace_id = ${ws}`);
    const [tras] = await admin`select estado from oportunidad where id = ${o!.id as string}`;
    expect(tras!.estado as string).toBe('descartada');
  });

  /**
   * Y UNA transición de etapa es UNA reapertura.
   *
   * El guard exige que la etapa la haya escrito esta transacción, y eso lo cumple igual de bien
   * una fila que dos: dos registros de la misma etapa en la misma transacción se apoyaban en el
   * MISMO update, pasaban los dos y emitían cada uno su `EtapaReabierta`. El archivo es
   * append-only, así que quedaban dos reaperturas —con motivos y alcances distintos, si quien
   * escribe quiere— de un solo acto, y ninguna forma de saber después cuál ocurrió.
   *
   * La regla que faltaba es de cardinalidad y va donde ya se cuenta lo demás: un registro por
   * transición. No un único sobre (proyecto, etapa), que prohibiría reabrir la misma etapa dos
   * veces en su vida — hoy no hay ceremonia de recierre, pero eso es un hueco del método, no
   * una regla que convenga congelar en un índice.
   */
  it('una transición de etapa deja UNA reapertura, no dos', async () => {
    const admin = sqlAdmin();
    const [srv] = await admin`insert into servicio (workspace_id, nombre, estado, creado_por)
      values (${ws}, 'Servicio del doble registro', 'activo', ${leadId}) returning id`;
    const [r] = await admin`insert into reto
      (workspace_id, servicio_ancla_id, codigo, titulo, descripcion, estado, metrica_objetivo,
       creado_por)
      values (${ws}, ${srv!.id as string}, 'R-DOS', 'Reto del doble registro', 'Descripción',
              'activo', 'Ninguna', ${leadId}) returning id`;
    const [p] = await admin`insert into proyecto
      (workspace_id, reto_id, codigo, titulo, estado, perfil, creado_por)
      values (${ws}, ${r!.id as string}, 'P-DOS', 'Proyecto', 'activo', 'rapido', ${leadId})
      returning id`;
    const proyectoD = p!.id as string;
    await admin`insert into etapa_instancia (workspace_id, proyecto_id, numero, nombre, estado)
      values (${ws}, ${proyectoD}, 3, 'Conceptualización', 'completada')`;

    await expect(
      conUsuario(leadId, async (tx) => {
        for (const motivo of ['Primera razón', 'Segunda razón']) {
          await tx`insert into reapertura_etapa
            (workspace_id, proyecto_id, etapa_numero, motivo, alcance, decisiones_marcadas,
             reabierto_por)
            values (${ws}, ${proyectoD}, 3, ${motivo}, 'etapa-completa', 0, ${leadId})`;
        }
        await tx`update etapa_instancia set estado = 'en-curso'
          where proyecto_id = ${proyectoD} and workspace_id = ${ws} and numero = 3`;
      }),
    ).rejects.toThrow(/una sola reapertura|dos registros/i);
    const eventos = await admin`select 1 from evento_dominio
      where workspace_id = ${ws} and tipo = 'EtapaReabierta'
        and payload->>'proyectoId' = ${proyectoD}`;
    expect(eventos.length, 'dos reaperturas archivadas de un solo acto').toBe(0);

    // Y una sola sigue pasando: lo que se prohíbe es el par, no la reapertura.
    await reabrirEtapa(leadId, {
      workspaceId: ws,
      proyectoId: proyectoD,
      etapaNumero: 3,
      motivo: 'La razón de verdad',
      insightIds: [],
    });
    const unico = await admin`select 1 from evento_dominio
      where workspace_id = ${ws} and tipo = 'EtapaReabierta'
        and payload->>'proyectoId' = ${proyectoD}`;
    expect(unico.length).toBe(1);
  });

  /**
   * Y el portafolio se REVALIDA en el instante en que se congela para medir.
   *
   * G3 certifica el portafolio y la ventana se cierra con él, pero una reapertura legítima de
   * la etapa 3 la vuelve a abrir —para eso existe— y ahí caben oportunidades nuevas. Lo que no
   * había era nada que volviera a mirar el portafolio antes de congelarlo del otro lado: el
   * proyecto sigue su método hasta G7, `abrirMedicion` mueve el reto a 'en-medicion' y a partir
   * de ese momento `reto_admite_portafolio` es falso otra vez. Medido: una HMW viva sin traza
   * entraba por la ventana reabierta y quedaba congelada dentro, con G3 firmado diciendo lo
   * contrario y sin ninguna puerta por la que arreglarla — y `outcome_review_completar_guard`
   * cierra el reto en ese estado.
   *
   * Se revalida SYS-15 y solo SYS-15, que es lo que la reapertura pudo cambiar: el conjunto de
   * oportunidades vivas. El eje TIEMPO del razonamiento —que G3 sí mira— no se vuelve a
   * preguntar aquí a propósito: un derecho revocado entre G3 y la medición no desmiente la
   * traza de la HMW, y exigirlo convertiría cada revocación en un reto que no puede medir.
   *
   * Se mide por las dos mitades: con la HMW huérfana no se abre, y arreglada —trazándola— sí.
   */
  it('abrir la medición vuelve a comprobar el portafolio que va a congelar', async () => {
    const admin = sqlAdmin();
    const [srv] = await admin`insert into servicio (workspace_id, nombre, estado, creado_por)
      values (${ws}, 'Servicio de la congelación', 'activo', ${leadId}) returning id`;
    const [r] = await admin`insert into reto
      (workspace_id, servicio_ancla_id, codigo, titulo, descripcion, estado, metrica_objetivo,
       creado_por)
      values (${ws}, ${srv!.id as string}, 'R-CON', 'Reto de la congelación', 'Descripción',
              'activo', 'Ninguna', ${leadId}) returning id`;
    const retoC = r!.id as string;
    const [p] = await admin`insert into proyecto
      (workspace_id, reto_id, codigo, titulo, estado, perfil, creado_por)
      values (${ws}, ${retoC}, 'P-CON', 'Proyecto', 'activo', 'rapido', ${leadId}) returning id`;
    const proyectoC = p!.id as string;

    // El estado «listo para medir» se monta con la mano de la base y con las réplicas
    // desactivadas: lo que esta prueba mide es la puerta de `abrirMedicion`, no el camino de
    // ocho gates que lleva hasta ella —que tienen sus propias pruebas—.
    await admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`insert into etapa_instancia (workspace_id, proyecto_id, numero, nombre, estado)
        values (${ws}, ${proyectoC}, 3, 'Conceptualización', 'completada')`;
      await tx`insert into gate_instancia
        (workspace_id, proyecto_id, numero, rol_aprobador, estado, aprobado_por, aprobado_en)
        values (${ws}, ${proyectoC}, 3, 'sponsor', 'aprobado', ${leadId}, now()),
               (${ws}, ${proyectoC}, 7, 'lead-boutique', 'aprobado', ${leadId}, now())`;
      await tx`insert into metric_registry
        (workspace_id, reto_id, estado, firmado_por, firmado_en, creado_por)
        values (${ws}, ${retoC}, 'firmado', ${leadId}, now(), ${leadId})`;
      await tx`update proyecto set estado = 'en-implementacion' where id = ${proyectoC}`;
    });

    // La reapertura legítima, por su puerta: es la que vuelve a abrir la ventana.
    await reabrirEtapa(leadId, {
      workspaceId: ws,
      proyectoId: proyectoC,
      etapaNumero: 3,
      motivo: 'Llegó evidencia que cambia el portafolio',
      insightIds: [],
    });
    // Y por esa ventana entra una HMW sin traza, que es legal mientras nadie la apruebe: SYS-15
    // se exige al aprobarla y en G3, no al proponerla.
    const [huerfana] = await conUsuario(leadId, (tx) => tx`insert into oportunidad
      (workspace_id, reto_id, pregunta, prioridad, prioridad_razon, creado_por)
      values (${ws}, ${retoC}, '¿Cómo podríamos medir sin apoyo?', 1, 'Sin apoyo', ${leadId})
      returning id`);

    await expect(abrirMedicion(leadId, { workspaceId: ws, retoId: retoC })).rejects.toThrow(
      /no traza a ningún insight/,
    );
    const [quieto] = await admin`select estado from reto where id = ${retoC}`;
    expect(quieto!.estado as string, 'el reto congeló un portafolio en falta').toBe('activo');

    // Y arreglado se abre, que es la otra mitad: sin ella, tapiar la transición entera pasaría
    // igual. La ventana sigue abierta —la etapa 3 está reabierta—, así que se puede trazar.
    await enlazarInsight(leadId, {
      workspaceId: ws,
      oportunidadId: huerfana!.id as string,
      insightId: insightValidado,
    });
    await abrirMedicion(leadId, { workspaceId: ws, retoId: retoC });
    const [midiendo] = await admin`select estado from reto where id = ${retoC}`;
    expect(midiendo!.estado as string).toBe('en-medicion');
  });

  /**
   * Y la PRIORIDAD vive dentro de su rango, y eso lo dice la base.
   *
   * `CrearOportunidadSchema` y `PriorizarOportunidadSchema` acotan a 0..1000, y los dos
   * controles de la pantalla también. Pero la superficie SQL concedida al rol de aplicación
   * incluye `prioridad`, así que por ahí entraba un negativo o un número arbitrariamente
   * grande: un estado que la API no puede producir, en la columna con la que se ORDENA el
   * portafolio —`oportunidad_reto_idx` es (workspace, reto, prioridad desc, creado_en)—, o
   * sea una HMW que se pone la primera o la última de todas sin pasar por la priorización.
   *
   * Va en un CHECK y no en la política por lo mismo que el vocabulario del estado: es una
   * propiedad del VALOR, no de quién escribe ni de cuándo.
   */
  it('la prioridad no sale de su rango, tampoco por SQL directo', async () => {
    const admin = sqlAdmin();
    const proponerCon = (prioridad: number) =>
      conUsuario(leadId, (tx) => tx`insert into oportunidad
        (workspace_id, reto_id, pregunta, prioridad, prioridad_razon, creado_por)
        values (${ws}, ${retoId}, ${`¿Cómo podríamos ordenar con ${prioridad}?`}, ${prioridad},
                'Razón', ${leadId})`);

    await expect(proponerCon(-1)).rejects.toThrow(/prioridad/i);
    await expect(proponerCon(1001)).rejects.toThrow(/prioridad/i);
    // Los dos EXTREMOS sí entran: un rango que no admite sus bordes está mal escrito, y sin
    // esta mitad un CHECK que rechazara todo pasaría igual.
    await proponerCon(0);
    await proponerCon(1000);

    // Y tampoco se sale repriorizando, que es la otra puerta: `prioridad` está en el grant de
    // UPDATE y la política no mira su valor.
    const [o] = await admin`select id from oportunidad
      where reto_id = ${retoId} and prioridad = 1000`;
    await expect(
      conUsuario(leadId, (tx) => tx`update oportunidad set prioridad = 5000
        where id = ${o!.id as string} and workspace_id = ${ws}`),
    ).rejects.toThrow(/prioridad/i);
  });

  /**
   * Y el ALCANCE de una reapertura acota en las dos direcciones.
   *
   * El guard de arriba miraba en una sola: que no quedara nada del alcance sin marcar. Por el
   * otro lado no miraba nada, y el conteo se hacía con `xmin` a secas —«lo que esta transacción
   * movió aguas abajo»—, que no es lo mismo que «lo de esta reapertura». Los dos agujeros que
   * eso deja, medidos contra la base:
   *
   *   · Declarando UN insight se movían a «en-revisión» TODAS las decisiones de aguas abajo. Las
   *     que sobran salen de lo vigente sin que nadie las cuestionara, y el evento las presenta
   *     como consecuencia de una reapertura que no las nombra.
   *   · Y con dos reaperturas legítimas en la misma transacción, cada una veía también lo de la
   *     otra: el número honesto —lo que cada una marcó— se RECHAZABA, y el que la base exigía
   *     era el inflado. La columna que la pantalla pinta pedía mentir para pasar.
   *
   * Las tres formas de abajo aíslan cada mitad: la primera solo la arregla el rechazo por
   * alcance, y las dos de la transacción doble solo el conteo acotado.
   */
  it('una reapertura marca lo de su alcance, y con otra al lado cada una cuenta lo suyo', async () => {
    const admin = sqlAdmin();
    const [srv] = await admin`insert into servicio (workspace_id, nombre, estado, creado_por)
      values (${ws}, 'Servicio del alcance', 'activo', ${leadId}) returning id`;
    const [r] = await admin`insert into reto
      (workspace_id, servicio_ancla_id, codigo, titulo, descripcion, estado, metrica_objetivo,
       creado_por)
      values (${ws}, ${srv!.id as string}, 'R-ALC', 'Reto del alcance', 'Descripción',
              'activo', 'Ninguna', ${leadId}) returning id`;
    const [p] = await admin`insert into proyecto
      (workspace_id, reto_id, codigo, titulo, estado, perfil, creado_por)
      values (${ws}, ${r!.id as string}, 'P-ALC', 'Proyecto', 'activo', 'rapido', ${leadId})
      returning id`;
    const proyectoA = p!.id as string;

    // Dos etapas cerradas con su gate, y dos insights: el alcance de cada reapertura.
    for (const [numero, nombre, rol] of [
      [3, 'Conceptualización', 'sponsor'],
      [4, 'Exploración de soluciones', 'lead-boutique'],
    ] as const) {
      await admin`insert into etapa_instancia (workspace_id, proyecto_id, numero, nombre, estado)
        values (${ws}, ${proyectoA}, ${numero}, ${nombre}, 'completada')`;
      await admin`insert into gate_instancia (workspace_id, proyecto_id, numero, rol_aprobador)
        values (${ws}, ${proyectoA}, ${numero}, ${rol})`;
    }
    const insightDe = async (titulo: string) => {
      const [i] = await admin`insert into insight (workspace_id, titulo, resumen, creado_por)
        values (${ws}, ${titulo}, 'Resumen', ${leadId}) returning id`;
      return i!.id as string;
    };
    const insightA = await insightDe('Insight del alcance A');
    const insightB = await insightDe('Insight del alcance B');
    const decisionDe = async (etapa: number, titulo: string, insightId: string) => {
      const [g] = await admin`select id from gate_instancia
        where proyecto_id = ${proyectoA} and workspace_id = ${ws} and numero = ${etapa}`;
      const [d] = await admin`insert into decision
        (workspace_id, proyecto_id, gate_id, tipo, titulo, fundamento, estado, decidido_por)
        values (${ws}, ${proyectoA}, ${g!.id as string}, 'diseno', ${titulo}, 'Fundamento',
                'vigente', ${leadId}) returning id`;
      const id = d!.id as string;
      await admin`insert into decision_insight (workspace_id, decision_id, insight_id)
        values (${ws}, ${id}, ${insightId})`;
      return id;
    };
    const deA = await decisionDe(3, 'Se elige el flujo corto', insightA);
    const deB = await decisionDe(4, 'Se descarta la pasarela propia', insightB);
    // La ajena: aguas abajo de la etapa 3 y FUERA del alcance de las dos reaperturas —cuelga
    // de B, y la que declara B es la de la etapa 4, que no la alcanza—. Es la que sobraba.
    const ajena = await decisionDe(3, 'Se acuerda el tono de los avisos', insightB);

    const reabrirPor = (
      filas: { etapa: number; insight: string; marcadas: number; alcance?: string }[],
      decisiones: string[],
    ) =>
      conUsuario(leadId, async (tx) => {
        for (const f of filas) {
          const [re] = await tx`insert into reapertura_etapa
            (workspace_id, proyecto_id, etapa_numero, motivo, alcance, decisiones_marcadas,
             reabierto_por)
            values (${ws}, ${proyectoA}, ${f.etapa}, ${`Motivo de la ${f.etapa}`},
                    ${f.alcance ?? 'declarado'}, ${f.marcadas}, ${leadId}) returning id`;
          await tx`insert into reapertura_insight (workspace_id, reapertura_id, insight_id)
            values (${ws}, ${re!.id as string}, ${f.insight})`;
        }
        await tx`update decision set estado = 'en-revision'
          where id in ${tx(decisiones)} and workspace_id = ${ws}`;
        await tx`update etapa_instancia set estado = 'en-curso'
          where proyecto_id = ${proyectoA} and workspace_id = ${ws}
            and numero in ${tx(filas.map((f) => f.etapa))}`;
      });

    // 1. Un insight declarado y TODO lo de aguas abajo marcado. El número que declara es el
    //    honesto —una— y aun así sobra una decisión: `ajena` sale de lo vigente sin que esta
    //    reapertura la nombre. Es el caso que solo el rechazo por alcance ve.
    await expect(
      reabrirPor([{ etapa: 3, insight: insightA, marcadas: 1 }], [deA, ajena]),
    ).rejects.toThrow(/su alcance no cubre/);

    // 2. Dos reaperturas, y la primera declara lo que movió la TRANSACCIÓN entera. Contra la
    //    base era el único número que pasaba; ahora es el que no cuadra.
    await expect(
      reabrirPor(
        [
          { etapa: 3, insight: insightA, marcadas: 2 },
          { etapa: 4, insight: insightB, marcadas: 1 },
        ],
        [deA, deB],
      ),
    ).rejects.toThrow(/dice haber marcado 2/);

    // 3. Y la forma que se CONTRADICE a sí misma: `etapa-completa` con insights declarados.
    //    La comprobación del alcance vacío miraba en una sola dirección —«declarado» sin
    //    declarar nada— y por la otra dejaba pasar una fila que dice las dos cosas: que se
    //    reabre la etapa entera, y que el alcance son estos insights. El registro es lo que la
    //    pantalla pinta y lo que el evento archiva, así que quien lo lea después no puede
    //    saber qué se reabrió. Aquí la reapertura es de verdad —marca las tres decisiones de
    //    aguas abajo y declara el número correcto—: lo único malo es lo que DICE de sí misma.
    await expect(
      reabrirPor(
        [{ etapa: 3, insight: insightA, marcadas: 3, alcance: 'etapa-completa' }],
        [deA, deB, ajena],
      ),
    ).rejects.toThrow(/reabre la etapa entera y a la vez declara/);

    // 4. Y las dos honestas, cada una con lo suyo: la mitad buena de las dos correcciones.
    await reabrirPor(
      [
        { etapa: 3, insight: insightA, marcadas: 1 },
        { etapa: 4, insight: insightB, marcadas: 1 },
      ],
      [deA, deB],
    );
    const [quieta] = await admin`select estado from decision where id = ${ajena}`;
    expect(quieta!.estado as string, 'la de fuera del alcance no se movió').toBe('vigente');
    const eventos = await admin`select payload from evento_dominio
      where workspace_id = ${ws} and tipo = 'EtapaReabierta'
        and payload->>'proyectoId' = ${proyectoA}
      order by payload->>'etapa'`;
    expect(eventos.map((e) => (e.payload as Record<string, unknown>).etapa)).toEqual([3, 4]);
    expect(
      eventos.map((e) => (e.payload as Record<string, unknown>).decisionesMarcadas),
      'cada reapertura responde por lo suyo, no por lo de la transacción',
    ).toEqual([1, 1]);
  });

  /**
   * Y la ventana se cierra cuando el RETO deja de admitir trabajo de método.
   *
   * Escrita solo con la puerta de G3, medía una etapa y daba por hecho el resto del método. Eso
   * dejó de ser cierto en este mismo PR: desde que una etapa reabierta no se puede cerrar a
   * mano, la reapertura de la 3 la deja `en-curso` para siempre —no hay ceremonia de recierre— y
   * el reto sigue avanzando por su lado. `outcome_review_completar_guard` cierra el reto y el
   * proyecto sin tocar sus etapas, así que la ventana quedaba abierta DESPUÉS del cierre: medido,
   * con los dos en 'cerrado' un lead insertaba una oportunidad y la repriorizaba. Un portafolio
   * que crece bajo un reto terminado es lo que SYS-08 dice que no existe.
   *
   * Se mide por las dos mitades, como toda puerta de esta suite: el reto que sigue vivo abre, y
   * el que ya terminó —o el que se archivó sin llegar a empezar— cierra.
   */
  it('la ventana del portafolio se cierra cuando el reto ya no admite trabajo de método', async () => {
    const admin = sqlAdmin();
    const [srv] = await admin`insert into servicio (workspace_id, nombre, estado, creado_por)
      values (${ws}, 'Servicio del ciclo', 'activo', ${leadId}) returning id`;
    const servicioId = srv!.id as string;

    const retoEn = async (codigo: string, estado: string) => {
      const [r] = await admin`insert into reto
        (workspace_id, servicio_ancla_id, codigo, titulo, descripcion, estado, metrica_objetivo,
         creado_por)
        values (${ws}, ${servicioId}, ${codigo}, 'Reto del ciclo', 'Descripción', ${estado},
                'Ninguna', ${leadId}) returning id`;
      return r!.id as string;
    };
    /**
     * La ventana según la BASE, y —en la misma llamada— la que la pantalla va a pintar.
     *
     * `portafolioDelWorkspace` trae `admitePortafolio` porque la pantalla no lo puede deducir:
     * sin él ofrecía «Nueva HMW», el enlace de insights, la repriorización y el veredicto sobre
     * un portafolio congelado, y cada intento rebotaba contra la política. Un formulario que se
     * rellena y no se puede guardar es peor que no ofrecerlo.
     *
     * Se comprueba aquí, dentro del helper, para que la afirmación se haga en TODAS las ramas
     * que esta sonda ya recorre —abierta, archivada, reabierta y cerrada— en vez de en una
     * elegida a mano: lo que hay que sostener es que las dos lecturas no se separan nunca, y
     * eso solo se mide comparándolas en cada estado.
     */
    const ventana = async (retoDestino: string) => {
      const [f] = await admin`select reto_admite_portafolio(${retoDestino}, ${ws}) as v`;
      const enLaPantalla = (await portafolioDelWorkspace(leadId, ws)).find(
        (r) => r.retoId === retoDestino,
      );
      expect(
        enLaPantalla!.admitePortafolio,
        'la pantalla y la política dicen cosas distintas sobre la misma ventana',
      ).toBe(f!.v as boolean);
      return f!.v as boolean;
    };
    const proponer = (retoDestino: string) =>
      conUsuario(leadId, (tx) => tx`insert into oportunidad
        (workspace_id, reto_id, pregunta, prioridad, prioridad_razon, creado_por)
        values (${ws}, ${retoDestino}, '¿Cómo podríamos medir el ciclo?', 1, 'Razón', ${leadId})`);

    // 1. Vivo: la ventana abre, que es la mitad que no se puede tapiar.
    const vivo = await retoEn('R-VIVO', 'activo');
    expect(await ventana(vivo)).toBe(true);
    await proponer(vivo);

    // 2. ARCHIVADO, que es el camino más barato a un reto sin trabajo —'candidato' →
    //    'archivado', sin gates de por medio— y estaba entero fuera: sin proyecto, la puerta de
    //    G3 pasa en vacío y la ventana decía que sí.
    const archivado = await retoEn('R-ARCH', 'candidato');
    await conUsuario(leadId, (tx) => tx`update reto set estado = 'archivado'
      where id = ${archivado} and workspace_id = ${ws}`);
    expect(await ventana(archivado), 'un reto archivado seguía admitiendo portafolio').toBe(false);
    await expect(proponer(archivado)).rejects.toThrow(/ya no admite trabajo de método/);

    // 3. Y el caso que lo motivó: el reto CERRADO con su etapa 3 reabierta.
    const cerrado = await retoEn('R-CERR', 'activo');
    const [pr] = await admin`insert into proyecto
      (workspace_id, reto_id, codigo, titulo, estado, perfil, creado_por)
      values (${ws}, ${cerrado}, 'P-CERR', 'Proyecto', 'activo', 'rapido', ${leadId}) returning id`;
    const proyectoC = pr!.id as string;
    // La etapa nace 'pendiente': aprobar el gate CIERRA su etapa homóloga —es efecto
    // inseparable de la transición— y ponerla ya en curso aquí sería fijar a mano lo que la
    // aprobación deshace.
    await admin`insert into etapa_instancia (workspace_id, proyecto_id, numero, nombre, estado)
      values (${ws}, ${proyectoC}, 3, 'Conceptualización', 'pendiente')`;
    const [gC] = await admin`insert into gate_instancia
      (workspace_id, proyecto_id, numero, rol_aprobador)
      values (${ws}, ${proyectoC}, 3, 'sponsor') returning id`;
    await admin`insert into checklist_item
      (workspace_id, gate_id, orden, texto, estado, insight_id)
      values (${ws}, ${gC!.id as string}, 0, 'Portafolio razonado', 'cumplido', ${insightValidado})`;
    await admin`update gate_instancia set estado = 'aprobado', aprobado_por = ${leadId},
      aprobado_en = now() where id = ${gC!.id as string}`;
    // Y la reapertura POR LA PUERTA: registro y etapa en la misma transacción.
    await conUsuario(leadId, async (tx) => {
      await tx`insert into reapertura_etapa
        (workspace_id, proyecto_id, etapa_numero, motivo, alcance, decisiones_marcadas,
         reabierto_por)
        values (${ws}, ${proyectoC}, 3, 'Llegó evidencia que cambia el portafolio',
                'etapa-completa', 0, ${leadId})`;
      await tx`update etapa_instancia set estado = 'en-curso'
        where proyecto_id = ${proyectoC} and workspace_id = ${ws} and numero = 3`;
    });
    // Con G3 firmado y la etapa 3 reabierta la ventana sigue abierta: es la excepción I1.
    expect(await ventana(cerrado)).toBe(true);

    // El cierre se monta con los triggers en silencio y dentro de UNA transacción: lo que esta
    // sonda afirma es la VENTANA, no el camino hasta el cierre. Que ese camino existe se lee en
    // los guards —la orden de los gates mira `gate_instancia.estado` y nunca `etapa_instancia`,
    // así que G4..G7 se firman con la 3 abierta, y el cierre del outcome review no toca las
    // etapas—; montarlo entero aquí pediría ocho gates, una design version con elementos y un
    // registry firmado para afirmar algo que no es de este módulo.
    await admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update reto set estado = 'cerrado', veredicto = 'logrado' where id = ${cerrado}`;
      await tx`update proyecto set estado = 'cerrado' where id = ${proyectoC}`;
    });
    expect(await ventana(cerrado), 'la ventana seguía abierta con el reto cerrado').toBe(false);
    await expect(proponer(cerrado)).rejects.toThrow(/ya no admite trabajo de método/);
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
    ).toMatch(/su G3 está aprobado sin la etapa 3 reabierta/);
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
