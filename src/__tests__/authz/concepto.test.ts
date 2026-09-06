import { afterAll, beforeAll, expect, it } from 'vitest';
import { conUsuario, sqlAdmin } from '@/lib/db';
import { describeAuthz } from './helpers';

/**
 * CTX-04 / SYS-13 — el concepto existe, y no avanza sin haberse probado.
 *
 * La etapa 4 era la única sin su objeto después de la 3: G4 aprobaba sin nada que mirar
 * porque no había nada que mirar, y «evidencia de test para cada concepto que avanza»
 * vivía solo en un documento. Estas pruebas cubren las cuatro puertas: quién propone, qué
 * se puede enlazar como prueba, qué exige el veredicto, y qué exige G4.
 */
describeAuthz('conceptos: la solución candidata de la etapa 4', () => {
  const marca = `con-${crypto.randomUUID().slice(0, 8)}`;
  let ws = '';
  let leadId = '';
  let stakeId = '';
  let retoId = '';
  let evidenciaId = '';
  let evidenciaSinDerechos = '';

  beforeAll(async () => {
    const admin = sqlAdmin();
    const [w] = await admin`insert into workspace (nombre) values (${marca}) returning id`;
    ws = w!.id as string;

    for (const [alias, rol] of [
      ['lead', 'lead-boutique'],
      ['stake', 'stakeholder'],
    ] as const) {
      const [u] = await admin`insert into usuario (email, nombre, estado)
        values (${`${marca}-${alias}@test.demo`}, ${alias}, 'activo') returning id`;
      const id = u!.id as string;
      if (alias === 'lead') leadId = id;
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

    // Dos evidencias que se diferencian SOLO en el derecho de uso: la de test tiene que ser
    // citable al cliente, y la otra existe para medir que el guard lo comprueba.
    const nuevaEvidencia = async (titulo: string, conDerechos: boolean) => {
      const [f] = await admin`insert into fuente (workspace_id, tipo, titulo, creado_por)
        values (${ws}, 'observacion', ${titulo}, ${leadId}) returning id`;
      const [e] = await admin`insert into evidencia
        (workspace_id, fuente_id, titulo, dimensiones, creado_por)
        values (${ws}, ${f!.id as string}, ${titulo}, '{}'::jsonb, ${leadId}) returning id`;
      const id = e!.id as string;
      await admin`insert into derecho_uso
        (workspace_id, evidencia_id, estado, ambito, base, decidido_por, decidido_en, creado_por)
        values (${ws}, ${id},
                ${conDerechos ? 'concedido' : 'pendiente'},
                ${conDerechos ? 'cliente' : 'interno'},
                ${conDerechos ? 'Contrato de prueba' : ''},
                ${conDerechos ? leadId : null}, ${conDerechos ? admin`now()` : null}, ${leadId})`;
      return id;
    };
    evidenciaId = await nuevaEvidencia('Sesión de test con 6 participantes', true);
    evidenciaSinDerechos = await nuevaEvidencia('Sesión sin derechos concedidos', false);
  });

  afterAll(async () => {
    const admin = sqlAdmin();
    if (!ws) return;
    await admin`delete from evento_dominio where workspace_id = ${ws}`;
    await admin`delete from concepto_evidencia where workspace_id = ${ws}`;
    await admin`delete from decision where workspace_id = ${ws}`;
    await admin`delete from concepto where workspace_id = ${ws}`;
    await admin`delete from checklist_item where workspace_id = ${ws}`;
    await admin`delete from gate_instancia where workspace_id = ${ws}`;
    await admin`delete from etapa_instancia where workspace_id = ${ws}`;
    await admin`delete from proyecto where workspace_id = ${ws}`;
    await admin`delete from derecho_uso where workspace_id = ${ws}`;
    await admin`delete from evidencia where workspace_id = ${ws}`;
    await admin`delete from fuente where workspace_id = ${ws}`;
    await admin`delete from reto where workspace_id = ${ws}`;
    await admin`delete from servicio where workspace_id = ${ws}`;
    await admin`delete from miembro where workspace_id = ${ws}`;
    await admin`delete from evento_dominio where workspace_id = ${ws}`;
    await admin`delete from workspace where id = ${ws}`;
  });

  /** Un concepto candidato, por la superficie concedida. */
  const nuevoConcepto = async (titulo: string, reto = retoId) => {
    const [c] = await conUsuario(leadId, (tx) => tx`insert into concepto
      (workspace_id, reto_id, titulo, descripcion, creado_por)
      values (${ws}, ${reto}, ${titulo}, 'Descripción del concepto', ${leadId})
      returning id`);
    return c!.id as string;
  };

  /**
   * Un reto con su proyecto y su G4 montados, PROPIO de cada caso.
   *
   * SYS-13 se cuenta por RETO, así que dos casos de gate sobre el mismo reto se cuentan los
   * conceptos el uno al otro: el primero que deje uno avanzando sin prueba bloquea al
   * siguiente por algo que no es lo suyo. Me pasó al escribirlo — el guard señaló, con nombre
   * y todo, un concepto de otra prueba.
   */
  let siguienteReto = 1;
  const nuevoRetoConG4 = async () => {
    const admin = sqlAdmin();
    const n = siguienteReto++;
    const [srv] = await admin`select id from servicio where workspace_id = ${ws} limit 1`;
    const [r] = await admin`insert into reto
      (workspace_id, servicio_ancla_id, codigo, titulo, descripcion, estado, metrica_objetivo, creado_por)
      values (${ws}, ${srv!.id as string}, ${`R-G4-${n}`}, ${`Reto de G4 ${n}`}, 'D',
              'activo', 'Ninguna', ${leadId}) returning id`;
    const reto = r!.id as string;
    const [p] = await admin`insert into proyecto
      (workspace_id, reto_id, codigo, titulo, estado, perfil, creado_por)
      values (${ws}, ${reto}, ${`P-G4-${n}`}, 'Proyecto', 'activo', 'rapido', ${leadId})
      returning id`;
    const proy = p!.id as string;
    const [g] = await admin`insert into gate_instancia
      (workspace_id, proyecto_id, numero, rol_aprobador)
      values (${ws}, ${proy}, 4, 'lead-boutique') returning id`;
    await admin`insert into etapa_instancia (workspace_id, proyecto_id, numero, nombre, estado)
      values (${ws}, ${proy}, 4, 'Exploración de soluciones', 'en-curso')`;
    // Un ítem cumplido: sin checklist el gate se para antes por otra razón, y el caso
    // mediría esa otra en vez de SYS-13.
    await admin`insert into checklist_item
      (workspace_id, gate_id, orden, texto, estado, evidencia_id)
      values (${ws}, ${g!.id as string}, 0, 'Hay conceptos probados', 'cumplido', ${evidenciaId})`;
    return { reto, gateId: g!.id as string };
  };

  /**
   * El veredicto es de SENTIDO ÚNICO, y la razón solo se le exige a quien muere.
   *
   * SYS-13 dice «los conceptos descartados registran razón», y solo ellos: el que pasa se
   * sostiene en su evidencia de test, que es otra cosa y se comprueba en G4. Y volver atrás
   * no es una corrección, es reescribir la historia — si el equipo cambia de idea, lo que hay
   * es un concepto nuevo, y así queda.
   */
  it('un concepto muere con razón, pasa sin ella, y ninguno de los dos revive', async () => {
    const muere = await nuevoConcepto('El que se descarta');
    // Sin razón no muere: lo para el CHECK, no el guard.
    await expect(
      conUsuario(leadId, (tx) => tx`update concepto
        set estado = 'muere', decidido_por = ${leadId}
        where id = ${muere} and workspace_id = ${ws}`),
    ).rejects.toThrow(/check constraint/);
    await conUsuario(leadId, (tx) => tx`update concepto
      set estado = 'muere', veredicto_razon = 'No resuelve el problema de fondo',
          decidido_por = ${leadId}
      where id = ${muere} and workspace_id = ${ws}`);

    // Y el que pasa NO necesita razón: su sostén es la prueba, no la prosa.
    const pasa = await nuevoConcepto('El que avanza');
    await conUsuario(leadId, (tx) => tx`update concepto
      set estado = 'pasa', decidido_por = ${leadId}
      where id = ${pasa} and workspace_id = ${ws}`);

    // La fecha la puso la BASE, no quien llamó: no hay grant que la retro ni la post-date.
    const admin = sqlAdmin();
    const [sellado] = await admin`select decidido_en from concepto where id = ${pasa}`;
    expect(sellado!.decidido_en).not.toBeNull();

    // Y ninguno de los dos vuelve atrás.
    for (const id of [muere, pasa]) {
      await expect(
        conUsuario(leadId, (tx) => tx`update concepto set estado = 'candidato'
          where id = ${id} and workspace_id = ${ws}`),
      ).rejects.toThrow(/ya se decidió/);
    }
  });

  /**
   * La evidencia de test pasa por el MISMO guard de derechos que las demás superficies.
   *
   * Enlazar como prueba de un concepto evidencia que no se puede citar al cliente sería
   * sostener un «pasa» en material que no se puede enseñar. Es el caso de
   * `arquetipo_evidencia` casi palabra por palabra, y por eso comparte guard en vez de tener
   * uno propio.
   */
  it('solo se enlaza como prueba la evidencia que se puede citar al cliente', async () => {
    const c = await nuevoConcepto('El que se prueba');
    await expect(
      conUsuario(leadId, (tx) => tx`insert into concepto_evidencia
        (workspace_id, concepto_id, evidencia_id)
        values (${ws}, ${c}, ${evidenciaSinDerechos})`),
    ).rejects.toThrow(/DR001|derecho/i);
    // Y la que sí: sin esta mitad, un guard que rechazara siempre pasaría la de arriba.
    await conUsuario(leadId, (tx) => tx`insert into concepto_evidencia
      (workspace_id, concepto_id, evidencia_id) values (${ws}, ${c}, ${evidenciaId})`);
    const admin = sqlAdmin();
    const [n] = await admin`select count(*)::int as n from concepto_evidencia
      where concepto_id = ${c}`;
    expect(n!.n).toBe(1);
  });

  /**
   * SYS-13 EN G4: lo que avanza, se probó — o lleva su N/A aprobada.
   *
   * Las tres salidas se miden en el mismo caso porque son la misma regla vista entera: sin
   * prueba no se aprueba, con prueba sí, y con N/A también. Sin la segunda y la tercera, un
   * guard que bloqueara G4 siempre pasaría la primera sin medir nada.
   *
   * Y el que MUERE no cuenta: exigirle prueba sería bloquear G4 por un concepto que nadie
   * propuso pasar, que es justo lo contrario de lo que dice «para cada concepto que avanza».
   */
  it('G4 no se aprueba con un concepto que avanza sin prueba ni N/A', async () => {
    const admin = sqlAdmin();
    const { reto, gateId } = await nuevoRetoConG4();
    const aprobar = () => admin`update gate_instancia
      set estado = 'aprobado', aprobado_por = ${leadId}
      where id = ${gateId}`;

    // Un concepto que MUERE no bloquea: no ha avanzado a ninguna parte.
    const muerto = await nuevoConcepto('Descartado, sin prueba', reto);
    await conUsuario(leadId, (tx) => tx`update concepto
      set estado = 'muere', veredicto_razon = 'No llegó a probarse', decidido_por = ${leadId}
      where id = ${muerto} and workspace_id = ${ws}`);

    const avanza = await nuevoConcepto('Avanza sin prueba', reto);
    await conUsuario(leadId, (tx) => tx`update concepto
      set estado = 'pasa', decidido_por = ${leadId}
      where id = ${avanza} and workspace_id = ${ws}`);
    await expect(aprobar()).rejects.toThrow(/SYS-13/);

    // Con la N/A aprobada, sí: es la salida que SYS-13 nombra, y se dice de UN concepto.
    await conUsuario(leadId, (tx) => tx`update concepto
      set test_na_justificacion = 'Concepto de proceso interno, sin usuario que testear',
          test_na_aprobado_por = ${leadId}
      where id = ${avanza} and workspace_id = ${ws}`);
    await aprobar();
    const [tras] = await admin`select estado from gate_instancia where id = ${gateId}`;
    expect(tras!.estado).toBe('aprobado');
  });

  /**
   * Y la otra salida: con la PRUEBA enlazada, sin N/A ninguna.
   *
   * Va en su propio gate porque una aprobación es inmutable —no se puede desaprobar para
   * volver a intentarlo— así que medir las dos salidas sobre el mismo gate era imposible.
   */
  it('G4 se aprueba cuando el concepto que avanza trae su evidencia de test', async () => {
    const admin = sqlAdmin();
    const { reto, gateId } = await nuevoRetoConG4();
    const c = await nuevoConcepto('Avanza con su prueba', reto);
    await conUsuario(leadId, (tx) => tx`insert into concepto_evidencia
      (workspace_id, concepto_id, evidencia_id) values (${ws}, ${c}, ${evidenciaId})`);
    await conUsuario(leadId, (tx) => tx`update concepto
      set estado = 'pasa', decidido_por = ${leadId}
      where id = ${c} and workspace_id = ${ws}`);

    await admin`update gate_instancia set estado = 'aprobado', aprobado_por = ${leadId}
      where id = ${gateId}`;
    const [tras] = await admin`select estado from gate_instancia where id = ${gateId}`;
    expect(tras!.estado).toBe('aprobado');
  });

  /** Quien no hace método no propone conceptos: es trabajo de diseño, no de lectura. */
  it('un stakeholder no puede crear conceptos', async () => {
    await expect(
      conUsuario(stakeId, (tx) => tx`insert into concepto
        (workspace_id, reto_id, titulo, descripcion, creado_por)
        values (${ws}, ${retoId}, 'Concepto del stakeholder', '', ${stakeId})`),
    ).rejects.toThrow(/row-level security|policy/i);
  });
});
