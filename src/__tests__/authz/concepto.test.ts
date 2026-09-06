import { afterAll, beforeAll, expect, it } from 'vitest';
import { conUsuario, sqlAdmin } from '@/lib/db';
import { registrarDecision } from '@/lib/metodo/gobernanza.servicio';
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
  let disenadorId = '';
  let stakeId = '';
  let retoId = '';
  let evidenciaId = '';
  let evidenciaSinDerechos = '';
  /**
   * Una tercera, SOLO para el ítem del checklist de los gates de prueba.
   *
   * Compartir una con la prueba del concepto hacía que retirarle los derechos disparara
   * también la regla general del checklist —«un ítem cumplido ya no tiene respaldo»—, con el
   * mismo código DR001. El caso de los derechos pasaba con la rama de G4 neutralizada: medía
   * la regla vieja creyendo medir la nueva.
   */
  let evidenciaDelChecklist = '';

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
    evidenciaDelChecklist = await nuevaEvidencia('Material del ítem del checklist', true);
  });

  afterAll(async () => {
    const admin = sqlAdmin();
    if (!ws) return;
    await admin`delete from evento_dominio where workspace_id = ${ws}`;
    await admin`delete from concepto_evidencia where workspace_id = ${ws}`;
    await admin`delete from decision_insight where workspace_id = ${ws}`;
    await admin`delete from decision where workspace_id = ${ws}`;
    await admin`delete from insight where workspace_id = ${ws}`;
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
      values (${ws}, ${g!.id as string}, 0, 'Hay conceptos probados', 'cumplido',
              ${evidenciaDelChecklist})`;
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
      conUsuario(leadId, (tx) => tx`update concepto set estado = 'muere'
        where id = ${muere} and workspace_id = ${ws}`),
    ).rejects.toThrow(/check constraint/);
    await conUsuario(leadId, (tx) => tx`update concepto
      set estado = 'muere', veredicto_razon = 'No resuelve el problema de fondo'
      where id = ${muere} and workspace_id = ${ws}`);

    // Y el que pasa NO necesita razón: su sostén es la prueba, no la prosa — pero sí el
    // umbral y su lectura, que es la primera mitad de SYS-13.
    const pasa = await nuevoConcepto('El que avanza');
    await conUsuario(leadId, (tx) => tx`update concepto
      set estado = 'pasa', umbral_test = '6 de 8 completan sin ayuda', test_lectura = '7 de 8', test_alcanza_umbral = true
      where id = ${pasa} and workspace_id = ${ws}`);

    // El sello y el AUTOR los puso la base, no quien llamó: ninguno de los dos está en el
    // grant, así que no hay UPDATE que los retro-date ni que atribuya el veredicto a otro.
    const admin = sqlAdmin();
    const [sellado] = await admin`select decidido_en, decidido_por from concepto
      where id = ${pasa}`;
    expect(sellado!.decidido_en).not.toBeNull();
    expect(sellado!.decidido_por).toBe(leadId);

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
   * Las tres salidas se miden enteras —sin prueba no, con N/A sí, con la prueba enlazada
   * también—, y cada una en SU gate. Dos razones, y las dos son de la base: una aprobación es
   * inmutable, así que no se puede desaprobar el gate para reintentar; y la N/A se concede
   * ANTES del veredicto, así que no se le puede colgar después a un concepto que ya bloqueó.
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
      set estado = 'muere', veredicto_razon = 'No llegó a probarse'
      where id = ${muerto} and workspace_id = ${ws}`);

    const avanza = await nuevoConcepto('Avanza sin prueba', reto);
    await conUsuario(leadId, (tx) => tx`update concepto
      set estado = 'pasa', umbral_test = '6 de 8', test_lectura = '7 de 8', test_alcanza_umbral = true
      where id = ${avanza} and workspace_id = ${ws}`);
    await expect(aprobar()).rejects.toThrow(/SYS-13/);

    // Y lo mismo dice la BANDEJA, que es la mitad que faltaba: la regla vive en
    // `gate_faltas_para_aprobar` y no en el guard, así que las dos leen la misma redacción. Con
    // la regla escrita en el guard, la bandeja no veía NINGUNA falta y anunciaba G4 como
    // aprobable mientras la aprobación fallaba.
    const faltas = await conUsuario(leadId, (tx) =>
      tx`select * from gate_faltas_para_aprobar_visible(${gateId}::uuid, ${ws}::uuid)`);
    expect(faltas).toHaveLength(1);
    expect(String(faltas[0]!.motivo)).toMatch(/Avanza sin prueba/);
    await expect(aprobar()).rejects.toThrow(String(faltas[0]!.motivo));
  });

  /**
   * La segunda salida: la N/A aprobada, que se concede ANTES del veredicto.
   *
   * «O N/A aprobada» se dice de UN concepto, y se dice mientras todavía es candidato: una
   * excepción concedida a algo ya decidido no es una excepción, es una coartada.
   */
  it('G4 se aprueba con la N/A del test concedida antes del veredicto', async () => {
    const admin = sqlAdmin();
    const { reto, gateId } = await nuevoRetoConG4();
    const c = await nuevoConcepto('Avanza con N/A', reto);
    // El aprobador NO se pasa: lo sella el trigger con quien firma, que para eso no está en
    // el grant.
    await conUsuario(leadId, (tx) => tx`update concepto
      set test_na_justificacion = 'Concepto de proceso interno, sin usuario que testear'
      where id = ${c} and workspace_id = ${ws}`);
    await conUsuario(leadId, (tx) => tx`update concepto set estado = 'pasa'
      where id = ${c} and workspace_id = ${ws}`);

    await admin`update gate_instancia set estado = 'aprobado', aprobado_por = ${leadId}
      where id = ${gateId}`;
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
    // El umbral, ANTES de enlazar la prueba: después la fila ya no lo admite.
    await conUsuario(leadId, (tx) => tx`update concepto
      set umbral_test = '6 de 8 completan la verificación sin ayuda'
      where id = ${c} and workspace_id = ${ws}`);
    await conUsuario(leadId, (tx) => tx`insert into concepto_evidencia
      (workspace_id, concepto_id, evidencia_id) values (${ws}, ${c}, ${evidenciaId})`);
    await conUsuario(leadId, (tx) => tx`update concepto
      set estado = 'pasa', test_lectura = '7 de 8', test_alcanza_umbral = true
      where id = ${c} and workspace_id = ${ws}`);

    await admin`update gate_instancia set estado = 'aprobado', aprobado_por = ${leadId}
      where id = ${gateId}`;
    const [tras] = await admin`select estado from gate_instancia where id = ${gateId}`;
    expect(tras!.estado).toBe('aprobado');
  });

  /**
   * La autoría del veredicto la sella la base, y después NADIE la mueve.
   *
   * Medido antes de arreglarlo, con la superficie que había: un lead ponía `decidido_por` a
   * nombre del diseñador —el veredicto atribuido a quien no lo tomó— y un segundo UPDATE que
   * no tocaba `estado` esquivaba entera la rama de transición y retro-databa el sello a 2001.
   * Las dos puertas eran la misma: columnas de auditoría dentro del `grant update`.
   */
  it('el autor y el sello del veredicto no están en la superficie concedida', async () => {
    const admin = sqlAdmin();
    const c = await nuevoConcepto('Con autoría sellada');
    for (const asignacion of ['decidido_por', 'decidido_en'] as const) {
      await expect(
        conUsuario(leadId, (tx) => tx`update concepto
          set ${tx.unsafe(asignacion)} = ${asignacion === 'decidido_por' ? leadId : new Date(0)}
          where id = ${c} and workspace_id = ${ws}`),
      ).rejects.toThrow(/permission denied|denegado/i);
    }
    await conUsuario(leadId, (tx) => tx`update concepto
      set estado = 'pasa', umbral_test = '6 de 8', test_lectura = '6 de 8', test_alcanza_umbral = true
      where id = ${c} and workspace_id = ${ws}`);
    const [sellado] = await admin`select decidido_por, decidido_en from concepto where id = ${c}`;
    expect(sellado!.decidido_por).toBe(leadId);

    // Y un UPDATE POSTERIOR que no toca el estado tampoco los mueve.
    //
    // La segunda mitad se mide CONCEDIENDO la columna a propósito, y esto necesita decirse: sin
    // el grant, un UPDATE ni siquiera puede nombrarla, así que la reposición del trigger no la
    // ejerce nadie y neutralizarla no movía ninguna prueba — una defensa que nada comprueba es
    // una defensa que no se sabe si existe. Con el grant puesto, el ataque es el que se midió
    // antes de arreglarlo: un UPDATE que deja `estado` quieto esquiva la rama de transición y
    // retro-data el sello. Las dos capas son de verdad dos, y ésta es la de dentro.
    await admin`grant update (decidido_en, decidido_por) on concepto to designio_app`;
    try {
      await conUsuario(leadId, (tx) => tx`update concepto
        set descripcion = 'Otra descripción', decidido_en = ${new Date(0)},
            decidido_por = ${disenadorId}
        where id = ${c} and workspace_id = ${ws}`);
    } finally {
      await admin`revoke update (decidido_en, decidido_por) on concepto from designio_app`;
    }
    const [despues] = await admin`select decidido_por, decidido_en from concepto where id = ${c}`;
    expect(despues!.decidido_por).toBe(sellado!.decidido_por);
    expect(String(despues!.decidido_en)).toBe(String(sellado!.decidido_en));
    const [desc] = await admin`select descripcion from concepto where id = ${c}`;
    expect(desc!.descripcion).toBe('Otra descripción');
  });

  /**
   * La N/A de SYS-13 la firma quien aprueba G4, y la firma con su nombre.
   *
   * Es una EXCEPCIÓN a una regla del gate: concederla es decidir que ese concepto avanza sin
   * prueba. Con la política de update a secas —lead o diseñador— un diseñador escribía la
   * justificación Y ponía de aprobador a cualquier fila de `usuario`, incluida la de alguien
   * que no es miembro; G4 leía «justificación no vacía» y daba la N/A por aprobada.
   */
  it('la N/A del test la aprueba el rol que firma G4, y con su propio nombre', async () => {
    const admin = sqlAdmin();
    const { reto } = await nuevoRetoConG4();
    const c = await nuevoConcepto('Con N/A', reto);

    // El aprobador ni siquiera se puede nombrar: no está en el grant.
    await expect(
      conUsuario(leadId, (tx) => tx`update concepto
        set test_na_justificacion = 'No aplica', test_na_aprobado_por = ${stakeId}
        where id = ${c} and workspace_id = ${ws}`),
    ).rejects.toThrow(/permission denied|denegado/i);

    // Y el diseñador, que sí puede editar el concepto, no puede conceder la excepción.
    await expect(
      conUsuario(disenadorId, (tx) => tx`update concepto
        set test_na_justificacion = 'No aplica'
        where id = ${c} and workspace_id = ${ws}`),
    ).rejects.toThrow(/rol que firma G4/);

    await conUsuario(leadId, (tx) => tx`update concepto
      set test_na_justificacion = 'Concepto de proceso interno, sin usuario que testear'
      where id = ${c} and workspace_id = ${ws}`);
    const [firmada] = await admin`select test_na_aprobado_por from concepto where id = ${c}`;
    expect(firmada!.test_na_aprobado_por).toBe(leadId);
  });

  /**
   * El umbral se declara ANTES de ver el resultado, o no es un umbral.
   *
   * «Evidencia de test que alcance EL UMBRAL DEFINIDO» (SYS-13). Enlazar una evidencia no dice
   * nada de eso: una sesión enlazada puede haber salido 2 de 8. Lo que hace que el listón sea
   * un listón es que la fila deje de admitirlo en cuanto hay prueba que mirar — cerrar solo
   * los CAMBIOS habría dejado abierta justo la forma que importa, escribirlo con el resultado
   * delante, porque el valor viejo estaba vacío.
   */
  it('el umbral no se escribe con la prueba ya enlazada, y sin él nada avanza', async () => {
    const c = await nuevoConcepto('Se prueba contra un listón');
    await conUsuario(leadId, (tx) => tx`insert into concepto_evidencia
      (workspace_id, concepto_id, evidencia_id) values (${ws}, ${c}, ${evidenciaId})`);
    await expect(
      conUsuario(leadId, (tx) => tx`update concepto set umbral_test = '2 de 8 basta'
        where id = ${c} and workspace_id = ${ws}`),
    ).rejects.toThrow(/ya no se puede escribir/);

    // Sin umbral ni N/A no se avanza: lo para el CHECK de la fila, antes de llegar al gate.
    await expect(
      conUsuario(leadId, (tx) => tx`update concepto set estado = 'pasa'
        where id = ${c} and workspace_id = ${ws}`),
    ).rejects.toThrow(/check constraint/);

    // Y la salida honesta: desenlazar, declarar el listón, volver a enlazar.
    await conUsuario(leadId, (tx) => tx`delete from concepto_evidencia
      where concepto_id = ${c} and workspace_id = ${ws}`);
    await conUsuario(leadId, (tx) => tx`update concepto
      set umbral_test = '6 de 8 completan sin ayuda'
      where id = ${c} and workspace_id = ${ws}`);
    await conUsuario(leadId, (tx) => tx`insert into concepto_evidencia
      (workspace_id, concepto_id, evidencia_id) values (${ws}, ${c}, ${evidenciaId})`);
    await conUsuario(leadId, (tx) => tx`update concepto
      set estado = 'pasa', test_lectura = '7 de 8', test_alcanza_umbral = true
      where id = ${c} and workspace_id = ${ws}`);
  });

  /**
   * G4 aprobado CONGELA el portafolio de conceptos que certificó.
   *
   * Medido antes de arreglarlo: con G4 firmado y la etapa 4 completada, un diseñador creaba un
   * concepto nuevo y lo pasaba sin prueba ninguna, y el gate ya firmado seguía firmado. El
   * guard del gate no lo ve porque solo corre al aprobar. Es la misma ventana que la
   * oportunidad tiene para G3, con el mismo nombre y el mismo cuerpo una etapa más allá.
   */
  it('con G4 aprobado no nacen conceptos nuevos ni se retoca lo que certificó', async () => {
    const admin = sqlAdmin();
    const { reto, gateId } = await nuevoRetoConG4();
    const c = await nuevoConcepto('El que G4 miró', reto);
    await conUsuario(leadId, (tx) => tx`update concepto set umbral_test = '6 de 8'
      where id = ${c} and workspace_id = ${ws}`);
    await conUsuario(leadId, (tx) => tx`insert into concepto_evidencia
      (workspace_id, concepto_id, evidencia_id) values (${ws}, ${c}, ${evidenciaId})`);
    await conUsuario(leadId, (tx) => tx`update concepto
      set test_lectura = '7 de 8', test_alcanza_umbral = true, estado = 'pasa'
      where id = ${c} and workspace_id = ${ws}`);
    await admin`update gate_instancia set estado = 'aprobado', aprobado_por = ${leadId}
      where id = ${gateId}`;

    // Nace: lo para el guard del candado, que relee la ventana con la clave en la mano.
    await expect(nuevoConcepto('Colado tras el gate', reto)).rejects.toThrow(/etapa 4 .*cerrada/);

    // Y retocar el que sí miró no falla: la política lo filtra, así que el UPDATE no alcanza
    // ninguna fila. Se mide por la FILA y no por la excepción, que es lo que de verdad pasa.
    await conUsuario(leadId, (tx) => tx`update concepto set titulo = 'Renombrado'
      where id = ${c} and workspace_id = ${ws}`);
    const [sigue] = await admin`select titulo from concepto where id = ${c}`;
    expect(sigue!.titulo).toBe('El que G4 miró');
  });

  /**
   * El pasa/muere apunta al concepto que decide, y solo a uno de su reto (RF-04.10).
   *
   * La clave ajena compuesta ata las dos puntas al mismo workspace, y ahí se acaba lo que una
   * FK puede decir: dentro de un workspace quedaba abierto colgar el pasa/muere del gate del
   * proyecto A de un concepto del reto B.
   */
  it('la decisión pasa/muere enhebra su concepto, y no uno de otro reto', async () => {
    const admin = sqlAdmin();
    const { reto, gateId } = await nuevoRetoConG4();
    const propio = await nuevoConcepto('El decidido', reto);
    const ajeno = await nuevoConcepto('El de otro reto', retoId);
    const [insight] = await admin`insert into insight
      (workspace_id, titulo, resumen, estado, validado_por, validado_en, creado_por)
      values (${ws}, 'Insight', 'Resumen', 'validado', ${leadId}, now(), ${leadId})
      returning id`;

    const registrar = (conceptoId: string) =>
      registrarDecision(leadId, {
        workspaceId: ws,
        gateId,
        tipo: 'pasa-muere',
        titulo: 'Pasa el concepto probado',
        fundamento: 'La prueba alcanzó el umbral',
        insightIds: [insight!.id as string],
        conceptoId,
      });

    await expect(registrar(ajeno)).rejects.toThrow(/no es del reto de este proyecto/);
    const { decisionId } = await registrar(propio);
    const [fila] = await admin`select concepto_id from decision where id = ${decisionId}`;
    expect(fila!.concepto_id).toBe(propio);

    // Y el evento dice sobre QUÉ se decidió, no solo de qué clase era.
    const [ev] = await admin`select payload from evento_dominio
      where workspace_id = ${ws} and tipo = 'DecisionAprobada'
        and payload ->> 'decisionId' = ${decisionId}`;
    expect((ev!.payload as { conceptoId: string }).conceptoId).toBe(propio);
  });

  /**
   * «Alcance EL UMBRAL» no lo dice un par de cadenas llenas.
   *
   * Con solo el listón y la lectura, «6 de 8» junto a «2 de 8» pasaba: las dos cadenas
   * estaban escritas, y ahí se acababa la comprobación. Y la base no puede resolverlo
   * comparándolas —el umbral de un test cualitativo puede ser «ningún participante abandona en
   * el paso 3»—, así que lo que se exige es la AFIRMACIÓN de quien lo leyó, que es lo que
   * SYS-13 pide de verdad y lo que se puede auditar.
   */
  it('un test que no alcanza su umbral no hace avanzar al concepto', async () => {
    const c = await nuevoConcepto('Se queda corto');
    await conUsuario(leadId, (tx) => tx`update concepto set umbral_test = '6 de 8'
      where id = ${c} and workspace_id = ${ws}`);
    await conUsuario(leadId, (tx) => tx`insert into concepto_evidencia
      (workspace_id, concepto_id, evidencia_id) values (${ws}, ${c}, ${evidenciaId})`);

    // La lectura obliga a decir si alcanzó: no hay lectura sin afirmación.
    await expect(
      conUsuario(leadId, (tx) => tx`update concepto set test_lectura = '2 de 8'
        where id = ${c} and workspace_id = ${ws}`),
    ).rejects.toThrow(/check constraint/);

    // Y dicha que NO, el concepto no avanza: lo que le queda es morir con su razón, que es la
    // otra mitad de SYS-13.
    await conUsuario(leadId, (tx) => tx`update concepto
      set test_lectura = '2 de 8', test_alcanza_umbral = false
      where id = ${c} and workspace_id = ${ws}`);
    await expect(
      conUsuario(leadId, (tx) => tx`update concepto set estado = 'pasa'
        where id = ${c} and workspace_id = ${ws}`),
    ).rejects.toThrow(/check constraint/);
    await conUsuario(leadId, (tx) => tx`update concepto
      set estado = 'muere', veredicto_razon = 'El test se quedó en 2 de 8'
      where id = ${c} and workspace_id = ${ws}`);
  });

  /**
   * G4 mira los derechos VIVOS de la prueba, no los que había al enlazarla.
   *
   * Entre el enlace y la firma se revocan permisos y caducan contratos, y G4 se firma con el
   * cliente delante. Es el mismo eje tiempo que G2 tiene para los arquetipos confirmados, y no
   * hay razón para que la etapa 4 sea más laxa que la 2 sobre el mismo material.
   */
  it('G4 no se aprueba si la prueba del concepto perdió sus derechos', async () => {
    const admin = sqlAdmin();
    const { reto, gateId } = await nuevoRetoConG4();
    const c = await nuevoConcepto('Probado con material que caducó', reto);
    await conUsuario(leadId, (tx) => tx`update concepto set umbral_test = '6 de 8'
      where id = ${c} and workspace_id = ${ws}`);
    await conUsuario(leadId, (tx) => tx`insert into concepto_evidencia
      (workspace_id, concepto_id, evidencia_id) values (${ws}, ${c}, ${evidenciaId})`);
    await conUsuario(leadId, (tx) => tx`update concepto
      set estado = 'pasa', test_lectura = '7 de 8', test_alcanza_umbral = true
      where id = ${c} and workspace_id = ${ws}`);

    // Se revoca DESPUÉS del enlace, que es el caso entero.
    // Se retira como se retira de verdad: `denegado` es el estado del catálogo —no existe
    // 'revocado'— y «ámbito y vigencia solo significan algo si hay concesión», así que el
    // CHECK de la tabla obliga a devolver el ámbito a interno en el mismo movimiento.
    await admin`update derecho_uso set estado = 'denegado', ambito = 'interno', vence_en = null
      where evidencia_id = ${evidenciaId} and workspace_id = ${ws}`;
    const faltas = await conUsuario(leadId, (tx) =>
      tx`select * from gate_faltas_para_aprobar_visible(${gateId}::uuid, ${ws}::uuid)`);
    // El código NO basta: la regla general del checklist emite el mismo DR001, y con ella el
    // caso pasaba aun con la rama de G4 apagada. Se comprueba el motivo, que es de esta rama.
    expect(faltas.map((f) => String(f.motivo))).toContainEqual(
      expect.stringMatching(/la evidencia de test del concepto «Probado con material que caducó»/),
    );
    await expect(
      admin`update gate_instancia set estado = 'aprobado', aprobado_por = ${leadId}
        where id = ${gateId}`,
    ).rejects.toThrow(/derechos vigentes/);

    // Y devueltos, se aprueba: sin esta mitad, un guard que bloqueara siempre pasaría la otra.
    await admin`update derecho_uso set estado = 'concedido', ambito = 'cliente'
      where evidencia_id = ${evidenciaId} and workspace_id = ${ws}`;
    await admin`update gate_instancia set estado = 'aprobado', aprobado_por = ${leadId}
      where id = ${gateId}`;
    const [tras] = await admin`select estado from gate_instancia where id = ${gateId}`;
    expect(tras!.estado).toBe('aprobado');
  });

  /**
   * Lo que el veredicto AFIRMÓ no se reescribe después.
   *
   * El evento es inmutable y lleva la razón dentro: `ConceptoMuere` archiva `veredicto_razon`
   * tal como estaba al decidir. Editable después, el expediente y el archivo dicen cosas
   * distintas sin que nada lo delate. Con la lectura del test es peor: un resultado reescrito
   * tras la firma deja a G4 certificando una prueba que ya no existe.
   *
   * Se congela lo que se afirmó, no la fila: corregir una errata del título no contradice a
   * ningún evento.
   */
  it('tras el veredicto no se reescriben la razón ni el resultado del test', async () => {
    const admin = sqlAdmin();
    const c = await nuevoConcepto('Con su historia cerrada');
    await conUsuario(leadId, (tx) => tx`update concepto
      set estado = 'muere', veredicto_razon = 'No resuelve el problema de fondo'
      where id = ${c} and workspace_id = ${ws}`);
    for (const [columna, valor] of [
      ['veredicto_razon', 'Otra razón distinta'],
      ['umbral_test', '6 de 8'],
      ['test_lectura', '7 de 8'],
    ] as const) {
      await expect(
        conUsuario(leadId, (tx) => tx`update concepto
          set ${tx.unsafe(columna)} = ${valor}
          where id = ${c} and workspace_id = ${ws}`),
      ).rejects.toThrow(/ya se decidió/);
    }
    // Y el evento sigue diciendo lo mismo que la fila.
    const [ev] = await admin`select payload from evento_dominio
      where workspace_id = ${ws} and tipo = 'ConceptoMuere'
        and payload ->> 'conceptoId' = ${c}`;
    const [fila] = await admin`select veredicto_razon from concepto where id = ${c}`;
    expect((ev!.payload as { razon: string }).razon).toBe(fila!.veredicto_razon);

    // El nombre sí se corrige: no es lo que se decidió, es cómo se llama.
    await conUsuario(leadId, (tx) => tx`update concepto set titulo = 'Con su historia cerrada (bis)'
      where id = ${c} and workspace_id = ${ws}`);
  });

  /**
   * La N/A y una prueba registrada se excluyen, en los tres sentidos.
   *
   * Yo mismo lo había escrito en prosa —«no aplica» es mentira cuando el test se hizo y salió
   * corto— y no lo exigía nada: el `or` del CHECK acepta la N/A mire lo que mire la lectura,
   * así que un concepto con `test_alcanza_umbral = false` al que se le añadía una
   * justificación antes del veredicto pasaba, y G4 se saltaba con él la evidencia, los
   * derechos y el umbral de una vez.
   *
   * Tres puertas porque son tres escrituras distintas: la lectura sobre una N/A puesta, la N/A
   * sobre una prueba enlazada, y el enlace sobre una N/A aprobada.
   */
  it('la N/A del test y una prueba registrada no caben en el mismo concepto', async () => {
    const { reto } = await nuevoRetoConG4();

    // 1. Lectura sobre N/A puesta: lo para el CHECK de la fila.
    const conNa = await nuevoConcepto('Con N/A y sin test', reto);
    await conUsuario(leadId, (tx) => tx`update concepto
      set test_na_justificacion = 'Proceso interno, sin usuario que testear'
      where id = ${conNa} and workspace_id = ${ws}`);
    await expect(
      conUsuario(leadId, (tx) => tx`update concepto
        set test_lectura = '2 de 8', test_alcanza_umbral = false
        where id = ${conNa} and workspace_id = ${ws}`),
    ).rejects.toThrow(/check constraint/);

    // 2. Enlace sobre N/A aprobada.
    await expect(
      conUsuario(leadId, (tx) => tx`insert into concepto_evidencia
        (workspace_id, concepto_id, evidencia_id) values (${ws}, ${conNa}, ${evidenciaId})`),
    ).rejects.toThrow(/N\/A de test aprobada|row-level security|policy/i);

    // 3. N/A sobre prueba enlazada: el caso que de verdad se colaba.
    const conTest = await nuevoConcepto('Con test que se quedó corto', reto);
    await conUsuario(leadId, (tx) => tx`update concepto set umbral_test = '6 de 8'
      where id = ${conTest} and workspace_id = ${ws}`);
    await conUsuario(leadId, (tx) => tx`insert into concepto_evidencia
      (workspace_id, concepto_id, evidencia_id) values (${ws}, ${conTest}, ${evidenciaId})`);
    await conUsuario(leadId, (tx) => tx`update concepto
      set test_lectura = '2 de 8', test_alcanza_umbral = false
      where id = ${conTest} and workspace_id = ${ws}`);
    await expect(
      conUsuario(leadId, (tx) => tx`update concepto
        set test_na_justificacion = 'Mejor digamos que no aplicaba'
        where id = ${conTest} and workspace_id = ${ws}`),
    ).rejects.toThrow(/ya tiene prueba de test enlazada|check constraint/);
  });

  /**
   * Un tabulador no es una justificación.
   *
   * `btrim` de un argumento quita ESPACIOS y nada más, así que un tabulador pasaba por «texto
   * no vacío»: el trigger le sellaba aprobador, la fila lo daba por válido y las
   * comprobaciones de G4 se saltaban enteras la evidencia y el umbral. Es la misma lección que
   * ya pagó la razón de una reapertura, y la función que la cerró —`titulo_normalizado`— es la
   * que este esquema usa para «texto vacío».
   */
  it('una N/A en blanco con tabuladores no cuenta como aprobada', async () => {
    const admin = sqlAdmin();
    const { reto } = await nuevoRetoConG4();
    const c = await nuevoConcepto('Con N/A de mentira', reto);

    // Guardar el blanco no falla —es texto, y guardarlo no afirma nada— pero NO se firma: sin
    // justificación de verdad no hay a quién atribuirle la excepción. Con `btrim`, el trigger
    // le sellaba aprobador aquí mismo.
    await conUsuario(leadId, (tx) => tx`update concepto set test_na_justificacion = ${'\t\n  '}
      where id = ${c} and workspace_id = ${ws}`);
    const [sinFirma] = await admin`select test_na_aprobado_por from concepto where id = ${c}`;
    expect(sinFirma!.test_na_aprobado_por).toBeNull();

    // Y sobre todo: no abre la puerta. Con `btrim`, este UPDATE pasaba —el `or` de la N/A daba
    // por buena la cadena de tabuladores— y el concepto avanzaba sin prueba ninguna.
    await expect(
      conUsuario(leadId, (tx) => tx`update concepto set estado = 'pasa'
        where id = ${c} and workspace_id = ${ws}`),
    ).rejects.toThrow(/check constraint/);
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
