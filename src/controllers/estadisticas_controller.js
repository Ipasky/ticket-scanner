/**
 * Estadísticas para el panel de finanzas.
 *
 * Todo se calcula en SQL. Mandarle el histórico entero al navegador para que
 * sume allí funciona con cien filas y deja de funcionar justo cuando la
 * aplicación empieza a servir para algo; además obligaría a reimplementar en
 * JavaScript las reglas que ya están aquí (qué fila cuenta, qué vale un importe
 * ausente, qué pasa con las monedas) y las dos copias acabarían discrepando.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  TRES REGLAS QUE SE REPITEN EN TODOS LOS ENDPOINTS                       │
 * │                                                                          │
 * │  1. MONEDAS: no se suman entre sí NUNCA. Todo se agrupa por moneda y la  │
 * │     respuesta lleva siempre `monedas` y `varias_monedas` para que la     │
 * │     interfaz pueda avisar en vez de enseñar un total que miente.         │
 * │                                                                          │
 * │  2. UN IMPORTE AUSENTE VALE 0 AL SUMAR, pero la fila sigue contando como │
 * │     tiquet. El 0 se aplica aquí (COALESCE), no en la base: en la columna │
 * │     se conserva NULL para distinguir "no tiene importe" de "importe cero │
 * │     impreso".                                                            │
 * │                                                                          │
 * │  3. SOLO CUENTAN LAS FILAS LEÍDAS: 'procesado' e 'incompleto'. Una fila  │
 * │     'pendiente' o 'error' no es un gasto de cero euros, es una foto que  │
 * │     nadie ha leído todavía; meterla en las medias las hundiría. Esas     │
 * │     salen aparte, en /control.                                           │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * FECHAS: se agrega por `fecha_compra`, que es la fecha IMPRESA en el papel y se
 * guarda como texto local ('YYYY-MM-DD HH:MM:SS'), no en UTC. Por eso agrupar
 * por sus diez primeros caracteres ya es agrupar en hora de Europe/Madrid: no
 * hay ninguna conversión que hacer, y hacerla sería el error. Lo que sí se
 * calcula en Madrid es QUÉ DÍA ES HOY, para saber dónde empieza "este mes".
 */
const db = require('../config/db');

// --- GASTOS: los tiquets y, junto a ellos, lo que solo está en el banco -----------
//
// Las estadísticas no leen la tabla tickets a secas sino esta unión: los tiquets
// más los cargos del banco que NO tienen tiquet (los que sí, ya cuentan como su
// tiquet), sin los marcados "no cuenta como gasto" y solo de las cuentas que se
// leen. Los Bizum enviados y las transferencias enviadas cuentan; lo que entra,
// no. Las filas del banco llevan id NEGATIVO (-id del movimiento) para que la
// interfaz sepa abrirlas como movimiento y no como tiquet.
//
// La base del banco es otro fichero: se adjunta (ATTACH) a esta conexión. Si no
// se puede, las estadísticas siguen con los tiquets solos.
const COLUMNAS_GASTO = `id, fecha_compra, hora_conocida, total_centimos, total_eur_centimos, moneda,
    categoria, tipo_documento, estado, establecimiento_id, compartido_entre, mi_parte_centimos,
    sin_fecha, sin_importe`;
let GASTOS = `(SELECT ${COLUMNAS_GASTO}, NULL AS nombre_banco, 'tiquet' AS origen FROM tickets)`;
try {
    const banco = require('../services/banco');
    const ruta = banco.rutaBaseBanco();
    banco.abrirBase(ruta).close();      // que existan las tablas aunque nunca se haya conectado
    if (!db.prepare(`SELECT 1 FROM pragma_database_list WHERE name = 'banco'`).get()) {
        db.exec(`ATTACH DATABASE '${ruta.replace(/'/g, "''")}' AS banco`);
    }
    GASTOS = `(
        SELECT ${COLUMNAS_GASTO}, NULL AS nombre_banco, 'tiquet' AS origen FROM tickets
        UNION ALL
        SELECT -m.id, m.fecha, 0, -m.importe_centimos, NULL, m.moneda,
               COALESCE(m.categoria, 'OTROS'),
               CASE m.clase WHEN 'bizum_enviado' THEN 'BIZUM'
                            WHEN 'transferencia_enviada' THEN 'TRANSFERENCIA' ELSE 'BANCO' END,
               'procesado', COALESCE(m.est_propio, k.establecimiento_id), m.compartido_entre, m.mi_parte_centimos, 0, 0,
               COALESCE(eo.nombre, k.nombre, m.comercio, m.persona, m.concepto), 'banco'
        FROM banco.movimientos m JOIN banco.cuentas c ON c.uid = m.cuenta_uid
        -- El comercio unificado: su establecimiento (mapa, "dónde gastas") y su nombre.
        LEFT JOIN banco.comercios k ON k.clave = ${banco.CLAVE_COMERCIO('m')}
        -- El puesto a mano en ese pago manda sobre el del comercio.
        LEFT JOIN establecimientos eo ON eo.id = m.est_propio
        WHERE c.leer = 1 AND m.importe_centimos < 0 AND m.tiquet_id IS NULL
          AND COALESCE(m.excluir, 0) = 0 AND COALESCE(m.clase, '') <> 'devolucion'
    )`;
} catch (err) {
    console.warn('📊 Las estadísticas no pueden leer el banco; siguen solo con los tiquets:', err.message);
}
const { PRECISIONES_FINAS } = require('../services/geocodificacion.js');

const ZONA = 'Europe/Madrid';

// Filas que cuentan como gasto: las que alguien ha leído.
const CONTABLES = `t.estado IN ('procesado', 'incompleto')`;

// Moneda efectiva. Una fila con datos y sin moneda solo puede venir de una foto
// sin tiquets reconocibles (importe NULL, suma 0): tratarla como EUR la mete en
// el grupo mayoritario sin alterar ningún total.
//
// Las compras en otra moneda cuentan como EUR en cuanto services/divisas.js las
// ha convertido (total_eur_centimos). Mientras no, siguen en su moneda y se
// agregan aparte, como antes. Las que no tienen importe no hay nada que
// convertir: van con EUR.
const MONEDA = `CASE WHEN t.total_eur_centimos IS NOT NULL OR t.total_centimos IS NULL THEN 'EUR'
                     ELSE COALESCE(NULLIF(UPPER(TRIM(t.moneda)), ''), 'EUR') END`;

// El importe que se suma. El que falta vale 0; el 0 impreso también vale 0, y
// son cosas distintas que se cuentan por separado con sin_importe.
//
// En un tiquet COMPARTIDO solo cuenta mi parte: la que escribí, o el total
// entre los que éramos. Se aplica como fracción para que valga igual sobre el
// importe ya convertido a euros.
const FRACCION_MIA = `(CASE
        WHEN t.mi_parte_centimos IS NOT NULL AND t.total_centimos > 0
            THEN MIN(1.0, t.mi_parte_centimos * 1.0 / t.total_centimos)
        WHEN t.compartido_entre > 1 THEN 1.0 / t.compartido_entre
        ELSE 1.0 END)`;
const IMPORTE = `CAST(ROUND(COALESCE(t.total_eur_centimos, t.total_centimos, 0) * ${FRACCION_MIA}) AS INTEGER)`;

// --- FECHAS EN HORA DE MADRID ------------------------------------------------

// 'sv-SE' da 'YYYY-MM-DD', que es el formato con el que se comparan las fechas
// guardadas. Intl hace el trabajo de los cambios de hora de marzo y octubre.
const FORMATO_DIA = new Intl.DateTimeFormat('sv-SE', {
    timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit'
});

/** Hoy en Madrid, 'YYYY-MM-DD'. A las 00:30 del 1 de enero esto importa. */
function hoyEnMadrid(ahora = new Date()) {
    return FORMATO_DIA.format(ahora);
}

const ultimoDiaDelMes = (anio, mes) => new Date(Date.UTC(anio, mes, 0)).getUTCDate();
const dosDigitos = (n) => String(n).padStart(2, '0');

/**
 * El periodo que contiene a `dia` y el inmediatamente anterior, para comparar.
 * Se hace con aritmética de texto y no con Date: sumar y restar meses con Date
 * es donde aparecen los 31 de marzo que se convierten en 1 de mayo.
 */
function periodoY_anterior(dia, periodo) {
    const anio = Number(dia.slice(0, 4));
    const mes  = Number(dia.slice(5, 7));

    if (periodo === 'anio') {
        return {
            actual:   { desde: `${anio}-01-01`,     hasta: `${anio}-12-31`,     etiqueta: String(anio) },
            anterior: { desde: `${anio - 1}-01-01`, hasta: `${anio - 1}-12-31`, etiqueta: String(anio - 1) }
        };
    }

    const anteriorMes  = mes === 1 ? 12 : mes - 1;
    const anteriorAnio = mes === 1 ? anio - 1 : anio;

    const rango = (a, m) => ({
        desde: `${a}-${dosDigitos(m)}-01`,
        hasta: `${a}-${dosDigitos(m)}-${dosDigitos(ultimoDiaDelMes(a, m))}`,
        etiqueta: `${a}-${dosDigitos(m)}`
    });

    return { actual: rango(anio, mes), anterior: rango(anteriorAnio, anteriorMes) };
}

// --- VALIDACIÓN DE LA QUERY --------------------------------------------------

function fechaDeQuery(valor, nombre) {
    if (valor === undefined || valor === '') return { valor: null };
    const texto = String(valor).trim().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(texto)) {
        return { error: `${nombre} tiene que ser una fecha YYYY-MM-DD ("${valor}" no lo es).` };
    }
    return { valor: texto };
}

/**
 * Rango de fechas opcional. Sin `desde` ni `hasta` se mira el histórico entero:
 * es lo que quiere ver quien abre el panel por primera vez.
 */
function rangoDeQuery(query) {
    const desde = fechaDeQuery(query.desde, 'desde');
    if (desde.error) return { error: desde.error };
    const hasta = fechaDeQuery(query.hasta, 'hasta');
    if (hasta.error) return { error: hasta.error };

    if (desde.valor && hasta.valor && desde.valor > hasta.valor) {
        return { error: `El rango está del revés: desde (${desde.valor}) es posterior a hasta (${hasta.valor}).` };
    }

    const condiciones = [];
    const params = {};
    if (desde.valor) { condiciones.push(`substr(t.fecha_compra, 1, 10) >= @desde`); params.desde = desde.valor; }
    if (hasta.valor) { condiciones.push(`substr(t.fecha_compra, 1, 10) <= @hasta`); params.hasta = hasta.valor; }

    return {
        desde: desde.valor,
        hasta: hasta.valor,
        where: condiciones.length ? ` AND ${condiciones.join(' AND ')}` : '',
        params
    };
}

const enteroDeQuery = (valor, porDefecto, maximo) => {
    const n = Number(String(valor ?? '').trim());
    if (!Number.isInteger(n) || n < 1) return porDefecto;
    return Math.min(n, maximo);
};

const SIES = new Set(['1', 'true', 'si', 'sí', 'horas', 'tiquets']);
const NOES = new Set(['0', 'false', 'no', '']);

/** Una bandera de la query. Un valor que no es ni sí ni no se explica, no se ignora. */
function banderaDeQuery(valor, nombre) {
    if (valor === undefined) return { valor: false };
    const texto = String(valor).trim().toLowerCase();
    if (SIES.has(texto)) return { valor: true };
    if (NOES.has(texto)) return { valor: false };
    return { error: `${nombre} tiene que ser 1 o 0 ("${valor}" no lo es).` };
}

// --- AYUDAS DE SALIDA --------------------------------------------------------

/**
 * Añade a cualquier respuesta la lista de monedas que aparecen en ella.
 *
 * La interfaz enseñará EUR y avisará si hay otras; para eso necesita saberlo sin
 * recorrer la respuesta entera buscando monedas raras.
 */
function conMonedas(cuerpo, filas) {
    const monedas = [...new Set(filas.map(f => f.moneda))].sort();
    return {
        ...cuerpo,
        monedas,
        varias_monedas: monedas.length > 1,
        // Nunca hay un total global: sumar euros con libras es exactamente lo
        // que este campo evita que nadie haga por descuido.
        aviso_monedas: monedas.length > 1
            ? 'Hay tiquets en más de una moneda. Los totales van por moneda y NO se suman entre sí.'
            : null
    };
}

/** Media por tiquet CON importe. Dividir por los que no lo tienen la hundiría. */
function ticketMedio(totalCentimos, tiquetsConImporte) {
    if (!tiquetsConImporte) return null;
    return Math.round(totalCentimos / tiquetsConImporte);
}

const sentencias = new Map();
function prepararEnCache(sql) {
    if (!sentencias.has(sql)) sentencias.set(sql, db.prepare(sql));
    return sentencias.get(sql);
}

/** Las columnas que se repiten en casi todas las agregaciones. */
const AGREGADOS = `
        ${MONEDA}                                   AS moneda,
        SUM(${IMPORTE})                             AS total_centimos,
        COUNT(*)                                    AS tiquets,
        SUM(CASE WHEN t.total_centimos IS NULL THEN 1 ELSE 0 END) AS sin_importe,
        SUM(CASE WHEN t.total_centimos IS NOT NULL THEN 1 ELSE 0 END) AS con_importe`;

// =============================================================================
// GET /api/estadisticas/series
// =============================================================================

const GRANULARIDADES = {
    // Agrupar por los diez primeros caracteres de fecha_compra ya es agrupar por
    // día local: el texto guardado ES la hora de Madrid impresa en el papel.
    dia:    `substr(t.fecha_compra, 1, 10)`,
    // El lunes de esa semana, con el truco de SQLite: 'weekday 0' avanza al
    // domingo siguiente y seis días atrás caen en el lunes. Devolver el lunes y
    // no un número de semana evita toda la discusión sobre semanas ISO a caballo
    // entre dos años.
    semana: `date(substr(t.fecha_compra, 1, 10), 'weekday 0', '-6 days')`,
    mes:    `substr(t.fecha_compra, 1, 7)`,
    anio:   `substr(t.fecha_compra, 1, 4)`
};

// Cuántos tiquets como mucho lleva el detalle de un rango. La vista diaria pide
// un rango de un día, donde esto no se alcanza nunca; el tope está para que
// pedir el detalle de un año no se lleve el histórico entero por el cable.
const DETALLE_MAXIMO = 500;

/**
 * Los tiquets del rango, uno por uno, con su hora cuando se conoce.
 *
 * Quien manda es `hora_conocida`, NO lo que haya en el texto de la fecha: un
 * tiquet sin hora impresa se guarda como 'YYYY-MM-DD' a secas y meterlo en la
 * línea del tiempo a las 00:00 sería inventarse que se compró a medianoche. Esos
 * salen con `minutos: null` para que la interfaz los ponga aparte.
 */
function detalleDelRango(rango) {
    const filas = prepararEnCache(`
        SELECT
            -- En euros también las compras en otra moneda (ya convertidas), como
            -- en las sumas: si no, 2308 liras salían como 2308 euros.
            t.id, t.fecha_compra, t.hora_conocida, CASE WHEN t.total_centimos IS NULL THEN NULL ELSE ${IMPORTE} END AS total_centimos,
            t.total_centimos AS original_centimos, UPPER(t.moneda) AS moneda_original,
            ${MONEDA} AS moneda, t.categoria, t.tipo_documento, t.estado,
            COALESCE(e.nombre, t.nombre_banco) AS establecimiento, t.origen
        FROM ${GASTOS} t
        LEFT JOIN establecimientos e ON e.id = t.establecimiento_id
        WHERE ${CONTABLES}
          AND t.fecha_compra IS NOT NULL
          ${rango.where}
        ORDER BY (t.hora_conocida = 0) ASC, t.fecha_compra ASC, t.id ASC
        LIMIT ${DETALLE_MAXIMO + 1}
    `).all(rango.params);

    const truncado = filas.length > DETALLE_MAXIMO;

    return {
        limite: DETALLE_MAXIMO,
        truncado,
        tiquets: filas.slice(0, DETALLE_MAXIMO).map((f) => {
            const hora = f.hora_conocida === 1
                ? (String(f.fecha_compra).match(/^\d{4}-\d{2}-\d{2}[ T](\d{2}):(\d{2})/) || null)
                : null;
            return {
                id: f.id,
                dia: String(f.fecha_compra).slice(0, 10),
                fecha_compra: f.fecha_compra,
                hora_conocida: f.hora_conocida,
                hora: hora ? `${hora[1]}:${hora[2]}` : null,
                // Minutos desde las 00:00, que es lo que sitúa la marca en la
                // línea de 0 a 24 h sin que el navegador tenga que parsear nada.
                minutos: hora ? Number(hora[1]) * 60 + Number(hora[2]) : null,
                total_centimos: f.total_centimos,
                moneda: f.moneda,
                original_centimos: f.original_centimos,
                moneda_original: f.moneda_original,
                establecimiento: f.establecimiento,
                origen: f.origen,
                categoria: f.categoria,
                tipo_documento: f.tipo_documento,
                estado: f.estado
            };
        })
    };
}

exports.series = (req, res) => {
    const granularidad = String(req.query.granularidad || 'mes').trim().toLowerCase();
    if (!GRANULARIDADES[granularidad]) {
        return res.status(400).json({
            error: `granularidad="${granularidad}" no es válida. Valores admitidos: ` +
                   `${Object.keys(GRANULARIDADES).join(', ')}.`
        });
    }

    const rango = rangoDeQuery(req.query);
    if (rango.error) return res.status(400).json({ error: rango.error });

    // La vista diaria no dibuja barras: pone una marca por tiquet en la hora a la
    // que se compró, así que necesita las filas y no los agregados.
    const detalle = banderaDeQuery(req.query.detalle, 'detalle');
    if (detalle.error) return res.status(400).json({ error: detalle.error });

    const filas = prepararEnCache(`
        SELECT
            ${GRANULARIDADES[granularidad]} AS periodo,
            ${AGREGADOS}
        FROM ${GASTOS} t
        WHERE ${CONTABLES}
          AND t.fecha_compra IS NOT NULL
          ${rango.where}
        GROUP BY periodo, ${MONEDA}
        ORDER BY periodo ASC, moneda ASC
    `).all(rango.params);

    // Una serie por moneda: así la gráfica pinta una línea por moneda y no hay
    // forma de dibujar una suma imposible.
    const porMoneda = new Map();
    for (const f of filas) {
        if (!porMoneda.has(f.moneda)) porMoneda.set(f.moneda, []);
        porMoneda.get(f.moneda).push({
            periodo: f.periodo,
            total_centimos: f.total_centimos,
            tiquets: f.tiquets,
            sin_importe: f.sin_importe,
            ticket_medio_centimos: ticketMedio(f.total_centimos, f.con_importe)
        });
    }

    res.json(conMonedas({
        granularidad,
        desde: rango.desde,
        hasta: rango.hasta,
        series: [...porMoneda.entries()].map(([moneda, puntos]) => ({ moneda, puntos })),
        ...(detalle.valor ? { detalle: detalleDelRango(rango) } : {})
    }, filas));
};

// =============================================================================
// GET /api/estadisticas/escala
// =============================================================================
// Qué es "un día caro" PARA MÍ. El calendario, la semana, el año y el mapa
// pintan el gasto en verde, naranja o rojo, y los umbrales no pueden ser
// cantidades fijas: 40 € es un día normal para quien hace la compra semanal y
// una barbaridad para quien solo guarda tiquets de parking.
//
// Así que la escala son PERCENTILES de mis propios días (y meses) con gasto:
//   · por debajo del percentil 40  → verde (día tranquilo)
//   · entre el 40 y el 80          → naranja (lo normal)
//   · por encima del 80            → rojo (de los caros)
//
// La agregación es SQL, con las mismas reglas que todo lo demás (solo filas
// leídas, importe ausente = 0, nada de mezclar monedas). Lo único que se hace
// aquí es elegir el elemento que toca de la lista ya ordenada, que es
// exactamente lo que es un percentil.

const PERCENTIL_BAJO = 0.40;
const PERCENTIL_ALTO = 0.80;

// Ventanas de referencia. Un año de días y dos de meses: suficiente para que la
// escala sea estable y corta para que siga describiendo cómo gasto AHORA.
const DIAS_DE_REFERENCIA = 365;
const MESES_DE_REFERENCIA = 24;

/** El valor en el percentil `p` de una lista YA ORDENADA. */
function percentil(ordenados, p) {
    if (ordenados.length === 0) return null;
    const indice = Math.min(ordenados.length - 1, Math.floor(ordenados.length * p));
    return ordenados[indice];
}

const SQL_TOTALES_POR = (expresion) => `
    SELECT ${expresion} AS periodo, SUM(${IMPORTE}) AS total_centimos
    FROM ${GASTOS} t
    WHERE ${CONTABLES}
      AND t.fecha_compra IS NOT NULL
      AND ${MONEDA} = @moneda
      AND substr(t.fecha_compra, 1, 10) >= @desde
    GROUP BY periodo
    HAVING total_centimos > 0
    ORDER BY total_centimos ASC
`;

/** La moneda con más filas: la que mandará en los colores del panel. */
const STMT_MONEDA_PRINCIPAL = () => prepararEnCache(`
    SELECT ${MONEDA} AS moneda, COUNT(*) AS n
    FROM ${GASTOS} t
    WHERE ${CONTABLES}
    GROUP BY ${MONEDA}
    ORDER BY (moneda = 'EUR') DESC, n DESC
    LIMIT 1
`);

exports.escala = (req, res) => {
    const hoy = hoyEnMadrid();
    const fila = STMT_MONEDA_PRINCIPAL().get();
    const moneda = (fila && fila.moneda) || 'EUR';

    const atras = (dias) => {
        const d = new Date(`${hoy}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() - dias);
        return d.toISOString().slice(0, 10);
    };

    const dias = prepararEnCache(SQL_TOTALES_POR(GRANULARIDADES.dia))
        .all({ moneda, desde: atras(DIAS_DE_REFERENCIA) })
        .map(f => f.total_centimos);

    const meses = prepararEnCache(SQL_TOTALES_POR(GRANULARIDADES.mes))
        .all({ moneda, desde: atras(MESES_DE_REFERENCIA * 31) })
        .map(f => f.total_centimos);

    const tramos = (ordenados) => ({
        // Cuántos periodos sostienen la escala. Con muy pocos, la interfaz puede
        // decidir no pintar colores: tres días no son un hábito de gasto.
        muestras: ordenados.length,
        bajo: percentil(ordenados, PERCENTIL_BAJO),
        alto: percentil(ordenados, PERCENTIL_ALTO),
        mediana: percentil(ordenados, 0.5),
        maximo: ordenados.length ? ordenados[ordenados.length - 1] : null
    });

    res.json({
        moneda,
        percentil_bajo: PERCENTIL_BAJO,
        percentil_alto: PERCENTIL_ALTO,
        dia: tramos(dias),
        mes: tramos(meses)
    });
};

// =============================================================================
// GET /api/estadisticas/resumen
// =============================================================================

exports.resumen = (req, res) => {
    const periodo = String(req.query.periodo || 'mes').trim().toLowerCase();
    if (periodo !== 'mes' && periodo !== 'anio') {
        return res.status(400).json({
            error: `periodo="${periodo}" no es válido. Solo mes o anio.`
        });
    }

    const referencia = fechaDeQuery(req.query.referencia, 'referencia');
    if (referencia.error) return res.status(400).json({ error: referencia.error });

    // El día de referencia es HOY EN MADRID, no en UTC: a las 00:30 del día 1,
    // en UTC todavía es el mes pasado y el panel enseñaría el periodo anterior
    // como si fuera el actual.
    const dia = referencia.valor || hoyEnMadrid();
    const { actual, anterior } = periodoY_anterior(dia, periodo);

    const consulta = prepararEnCache(`
        SELECT ${AGREGADOS},
               -- Tiquets de verdad, sin los pagos del banco (que también suman gasto).
               SUM(CASE WHEN t.origen = 'tiquet' THEN 1 ELSE 0 END) AS solo_tiquets
        FROM ${GASTOS} t
        WHERE ${CONTABLES}
          AND t.fecha_compra IS NOT NULL
          AND substr(t.fecha_compra, 1, 10) >= @desde
          AND substr(t.fecha_compra, 1, 10) <= @hasta
        GROUP BY ${MONEDA}
        ORDER BY moneda ASC
    `);

    const comoBloque = (rango) => {
        const filas = consulta.all({ desde: rango.desde, hasta: rango.hasta });
        return {
            ...rango,
            por_moneda: filas.map(f => ({
                moneda: f.moneda,
                total_centimos: f.total_centimos,
                tiquets: f.tiquets,
                solo_tiquets: f.solo_tiquets,
                del_banco: f.tiquets - f.solo_tiquets,
                tiquets_con_importe: f.con_importe,
                sin_importe: f.sin_importe,
                ticket_medio_centimos: ticketMedio(f.total_centimos, f.con_importe)
            })),
            filas
        };
    };

    const bloqueActual   = comoBloque(actual);
    const bloqueAnterior = comoBloque(anterior);

    // La variación se calcula POR MONEDA, incluyendo las que solo aparecen en uno
    // de los dos periodos (ahí el otro vale 0).
    const monedas = [...new Set([
        ...bloqueActual.por_moneda.map(m => m.moneda),
        ...bloqueAnterior.por_moneda.map(m => m.moneda)
    ])].sort();

    const variacion = monedas.map((moneda) => {
        const ahora = bloqueActual.por_moneda.find(m => m.moneda === moneda);
        const antes = bloqueAnterior.por_moneda.find(m => m.moneda === moneda);
        const totalAhora = ahora ? ahora.total_centimos : 0;
        const totalAntes = antes ? antes.total_centimos : 0;

        return {
            moneda,
            actual_centimos: totalAhora,
            anterior_centimos: totalAntes,
            diferencia_centimos: totalAhora - totalAntes,
            // Sin gasto anterior no hay porcentaje que calcular: "ha subido un
            // infinito por ciento" no es información. Se devuelve null y la
            // interfaz enseña la diferencia absoluta.
            porcentaje: totalAntes === 0
                ? null
                : Math.round(((totalAhora - totalAntes) / totalAntes) * 1000) / 10
        };
    });

    res.json(conMonedas({
        periodo,
        referencia: dia,
        actual: { desde: actual.desde, hasta: actual.hasta, etiqueta: actual.etiqueta, por_moneda: bloqueActual.por_moneda },
        anterior: { desde: anterior.desde, hasta: anterior.hasta, etiqueta: anterior.etiqueta, por_moneda: bloqueAnterior.por_moneda },
        variacion
    }, [...bloqueActual.filas, ...bloqueAnterior.filas]));
};

// =============================================================================
// GET /api/estadisticas/categorias
// =============================================================================

exports.categorias = (req, res) => {
    const rango = rangoDeQuery(req.query);
    if (rango.error) return res.status(400).json({ error: rango.error });

    const filas = prepararEnCache(`
        SELECT
            COALESCE(t.categoria, '(sin categoría)') AS categoria,
            ${AGREGADOS}
        FROM ${GASTOS} t
        WHERE ${CONTABLES}
          ${rango.where}
        GROUP BY categoria, ${MONEDA}
        ORDER BY total_centimos DESC, categoria ASC
    `).all(rango.params);

    // El porcentaje es DENTRO de su moneda: sobre el total de otra no
    // significaría nada.
    const totalPorMoneda = new Map();
    for (const f of filas) {
        totalPorMoneda.set(f.moneda, (totalPorMoneda.get(f.moneda) || 0) + f.total_centimos);
    }

    res.json(conMonedas({
        desde: rango.desde,
        hasta: rango.hasta,
        categorias: filas.map(f => ({
            categoria: f.categoria,
            moneda: f.moneda,
            total_centimos: f.total_centimos,
            tiquets: f.tiquets,
            sin_importe: f.sin_importe,
            ticket_medio_centimos: ticketMedio(f.total_centimos, f.con_importe),
            porcentaje_de_su_moneda: totalPorMoneda.get(f.moneda)
                ? Math.round((f.total_centimos / totalPorMoneda.get(f.moneda)) * 1000) / 10
                : 0
        }))
    }, filas));
};

// =============================================================================
// GET /api/estadisticas/establecimientos
// =============================================================================

exports.establecimientos = (req, res) => {
    const rango = rangoDeQuery(req.query);
    if (rango.error) return res.status(400).json({ error: rango.error });

    const orden = String(req.query.orden || 'gasto').trim().toLowerCase();
    if (orden !== 'gasto' && orden !== 'visitas') {
        return res.status(400).json({ error: `orden="${orden}" no es válido. Solo gasto o visitas.` });
    }
    const limite = enteroDeQuery(req.query.limit, 20, 200);

    const filas = prepararEnCache(`
        SELECT
            e.id   AS establecimiento_id,
            -- Lo que solo está en el banco sale con el nombre del comercio que
            -- da el banco. Bizum y transferencias no son un "sitio": fuera.
            COALESCE(e.nombre, t.nombre_banco) AS nombre,
            e.ciudad,
            e.latitud,
            e.longitud,
            ${AGREGADOS},
            MAX(t.fecha_compra) AS ultima_visita
        FROM ${GASTOS} t
        LEFT JOIN establecimientos e ON e.id = t.establecimiento_id
        WHERE ${CONTABLES}
          AND (e.id IS NOT NULL OR (t.origen = 'banco' AND t.tipo_documento = 'BANCO'))
          ${rango.where}
        GROUP BY COALESCE('e' || e.id, 'b' || LOWER(t.nombre_banco)), ${MONEDA}
        ORDER BY ${orden === 'gasto' ? 'total_centimos' : 'tiquets'} DESC,
                 nombre ASC
        LIMIT @limite
    `).all({ ...rango.params, limite });

    res.json(conMonedas({
        desde: rango.desde,
        hasta: rango.hasta,
        orden,
        limit: limite,
        establecimientos: filas.map(f => ({
            establecimiento_id: f.establecimiento_id,
            nombre: f.nombre,
            ciudad: f.ciudad,
            latitud: f.latitud,
            longitud: f.longitud,
            moneda: f.moneda,
            total_centimos: f.total_centimos,
            visitas: f.tiquets,
            sin_importe: f.sin_importe,
            ticket_medio_centimos: ticketMedio(f.total_centimos, f.con_importe),
            ultima_visita: f.ultima_visita
        }))
    }, filas));
};

// =============================================================================
// GET /api/estadisticas/mapa
// =============================================================================

const ULTIMOS_POR_ESTABLECIMIENTO = 5;

exports.mapa = (req, res) => {
    const rango = rangoDeQuery(req.query);
    if (rango.error) return res.status(400).json({ error: rango.error });

    // Solo lo que se puede pintar. Lo que falta por geocodificar sale en
    // /control, para que el panel pueda decir "hay 12 sitios sin situar" en vez
    // de enseñar un mapa incompleto sin explicación.
    const filas = prepararEnCache(`
        SELECT
            e.id AS establecimiento_id, e.nombre, e.direccion, e.ciudad,
            e.latitud, e.longitud, e.geo_precision, e.place_id,
            ${AGREGADOS},
            MAX(t.fecha_compra) AS ultima_visita
        FROM ${GASTOS} t
        JOIN establecimientos e ON e.id = t.establecimiento_id
        WHERE ${CONTABLES}
          AND e.latitud IS NOT NULL AND e.longitud IS NOT NULL
          ${rango.where}
        GROUP BY e.id, ${MONEDA}
        ORDER BY e.nombre ASC
    `).all(rango.params);

    // Los últimos tiquets de cada sitio, en una sola consulta con ROW_NUMBER en
    // vez de una por establecimiento.
    const ultimos = prepararEnCache(`
        SELECT establecimiento_id, id, fecha_compra, total_centimos, moneda, tipo_documento, estado
        FROM (
            SELECT
                t.establecimiento_id, t.id, t.fecha_compra, CASE WHEN t.total_centimos IS NULL THEN NULL ELSE ${IMPORTE} END AS total_centimos,
                ${MONEDA} AS moneda, t.tipo_documento, t.estado,
                ROW_NUMBER() OVER (
                    PARTITION BY t.establecimiento_id
                    ORDER BY t.fecha_compra DESC, t.id DESC
                ) AS n
            FROM ${GASTOS} t
            JOIN establecimientos e ON e.id = t.establecimiento_id
            WHERE ${CONTABLES}
              AND e.latitud IS NOT NULL AND e.longitud IS NOT NULL
              ${rango.where}
        )
        WHERE n <= ${ULTIMOS_POR_ESTABLECIMIENTO}
        ORDER BY establecimiento_id ASC, n ASC
    `).all(rango.params);

    const porEstablecimiento = new Map();
    for (const f of filas) {
        if (!porEstablecimiento.has(f.establecimiento_id)) {
            porEstablecimiento.set(f.establecimiento_id, {
                establecimiento_id: f.establecimiento_id,
                nombre: f.nombre,
                direccion: f.direccion,
                ciudad: f.ciudad,
                latitud: f.latitud,
                longitud: f.longitud,
                // Con cuánta precisión está situado: 'exacta'/'calle'/'manual'
                // son el sitio; 'zona'/'localidad' son una aproximación y el
                // mapa tiene que pintarlas distinto en vez de fingir que es la
                // puerta del comercio.
                precision: f.geo_precision || null,
                place_id: f.place_id || null,
                aproximada: !PRECISIONES_FINAS.has(f.geo_precision),
                visitas: 0,
                ultima_visita: null,
                por_moneda: [],
                ultimos_tiquets: []
            });
        }
        const punto = porEstablecimiento.get(f.establecimiento_id);
        punto.visitas += f.tiquets;
        if (!punto.ultima_visita || (f.ultima_visita && f.ultima_visita > punto.ultima_visita)) {
            punto.ultima_visita = f.ultima_visita;
        }
        punto.por_moneda.push({
            moneda: f.moneda,
            total_centimos: f.total_centimos,
            tiquets: f.tiquets,
            sin_importe: f.sin_importe
        });
    }

    for (const t of ultimos) {
        const punto = porEstablecimiento.get(t.establecimiento_id);
        if (!punto) continue;
        punto.ultimos_tiquets.push({
            id: t.id,
            fecha_compra: t.fecha_compra,
            total_centimos: t.total_centimos,
            moneda: t.moneda,
            tipo_documento: t.tipo_documento,
            estado: t.estado
        });
    }

    res.json(conMonedas({
        desde: rango.desde,
        hasta: rango.hasta,
        puntos: [...porEstablecimiento.values()]
    }, filas));
};

// =============================================================================
// GET /api/estadisticas/control
// =============================================================================

exports.control = (req, res) => {
    const rango = rangoDeQuery(req.query);
    if (rango.error) return res.status(400).json({ error: rango.error });

    // Los contadores de "hay que mirar esto". Van todos juntos porque el panel
    // los enseña juntos: son la lista de pendientes del usuario.
    const fila = prepararEnCache(`
        SELECT
            COUNT(*)                                                   AS tiquets,
            SUM(CASE WHEN t.sin_importe = 1 THEN 1 ELSE 0 END)         AS sin_importe,
            SUM(CASE WHEN t.sin_fecha = 1 THEN 1 ELSE 0 END)           AS sin_fecha,
            SUM(CASE WHEN t.estado = 'incompleto' THEN 1 ELSE 0 END)   AS incompletos,
            SUM(CASE WHEN t.estado = 'pendiente'  THEN 1 ELSE 0 END)   AS pendientes,
            SUM(CASE WHEN t.estado = 'error'      THEN 1 ELSE 0 END)   AS con_error,
            SUM(CASE WHEN t.fecha_compra IS NULL AND t.sin_fecha = 0 THEN 1 ELSE 0 END) AS sin_fecha_ni_confirmar,
            -- Tiquets que no se pueden pintar en el mapa. Se cuenta en TIQUETS,
            -- no en establecimientos, porque el panel enseña este número junto a
            -- los otros dos contadores y al pulsarlo filtra el historial: tiene
            -- que coincidir con lo que sale de esa lista.
            SUM(CASE WHEN (e.latitud IS NULL OR e.longitud IS NULL) AND COALESCE(e.geo_precision, '') <> 'online' THEN 1 ELSE 0 END) AS sin_ubicar,
            -- Tiquets situados en un punto del que ya se sabe que NO cuadra: el
            -- código postal que devolvió Nominatim no es el del papel. Se cuentan
            -- en tiquets por lo mismo que sin_ubicar: al pulsarlo filtra la lista.
            SUM(CASE WHEN e.geo_precision = 'discrepante' THEN 1 ELSE 0 END) AS dudosos
        FROM tickets t
        LEFT JOIN establecimientos e ON e.id = t.establecimiento_id
        WHERE 1 = 1 ${rango.where}
    `).get(rango.params);

    // Los contadores de arriba incluyen a propósito las filas sin leer: son
    // justamente las que hay que vigilar. El gasto, no.
    const geo = db.prepare(`
        SELECT
            COUNT(*)                                                  AS establecimientos,
            SUM(CASE WHEN geo_estado = 'ok'        THEN 1 ELSE 0 END) AS geo_ok,
            SUM(CASE WHEN geo_estado = 'pendiente' THEN 1 ELSE 0 END) AS geo_pendientes,
            SUM(CASE WHEN geo_estado = 'fallido'   THEN 1 ELSE 0 END) AS geo_fallidos,
            SUM(CASE WHEN geo_estado = 'sin_datos' THEN 1 ELSE 0 END) AS geo_sin_datos,
            SUM(CASE WHEN (latitud IS NULL OR longitud IS NULL) AND COALESCE(geo_precision, '') <> 'online' THEN 1 ELSE 0 END) AS sin_ubicar,
            SUM(CASE WHEN geo_precision = 'manual' THEN 1 ELSE 0 END) AS a_mano
        FROM establecimientos
    `).get();

    res.json({
        desde: rango.desde,
        hasta: rango.hasta,
        tiquets: fila.tiquets,
        sin_importe: fila.sin_importe,
        sin_fecha_confirmada: fila.sin_fecha,
        sin_fecha_ni_confirmar: fila.sin_fecha_ni_confirmar,
        incompletos: fila.incompletos,
        pendientes: fila.pendientes,
        con_error: fila.con_error,
        sin_ubicar: fila.sin_ubicar,
        dudosos: fila.dudosos,
        establecimientos: geo
    });
};

// Expuesto para las pruebas: la aritmética de periodos es donde se esconden los
// errores de "31 de marzo + 1 mes".
// =============================================================================
// GET /api/estadisticas/prevision
// =============================================================================
//
// Dónde acabará el mes: lo gastado hasta hoy + los pagos periódicos que aún no
// han pasado este mes + el gasto variable de un día normal por los días que
// quedan. El "día normal" sale de los últimos 90 días, quitando los pagos
// periódicos (que ya van aparte).

exports.prevision = (req, res) => {
    const hoy = hoyEnMadrid();
    const [a, m, d] = hoy.split('-').map(Number);
    const inicioMes = `${hoy.slice(0, 7)}-01`;
    const diasMes = new Date(Date.UTC(a, m, 0)).getUTCDate();
    const diasQuedan = diasMes - d;
    const hace90 = new Date(Date.UTC(a, m - 1, d) - 90 * 86400e3).toISOString().slice(0, 10);

    const suma = (desde, hasta) => prepararEnCache(`
        SELECT COALESCE(SUM(${IMPORTE}), 0) AS total FROM ${GASTOS} t
        WHERE ${CONTABLES} AND t.fecha_compra IS NOT NULL AND ${MONEDA} = 'EUR'
          AND substr(t.fecha_compra, 1, 10) >= @desde AND substr(t.fecha_compra, 1, 10) <= @hasta
    `).get({ desde, hasta }).total;

    const gastado = suma(inicioMes, hoy);
    let suscripciones = [];
    try { suscripciones = require('../services/banco').banco().suscripciones() || []; } catch (_) { suscripciones = []; }
    const activas = suscripciones.filter(s => s.activa);
    const finMes = `${hoy.slice(0, 7)}-${String(diasMes).padStart(2, '0')}`;
    // Las que tocan entre mañana y fin de mes y no se han cobrado ya este mes.
    const pendientes = activas.filter(s => s.proximo > hoy && s.proximo <= finMes && s.ultimo < inicioMes);
    const fijoPendiente = pendientes.reduce((t, s) => t + s.importe_medio_centimos, 0);
    const fijoMensual = activas.reduce((t, s) => t + s.mensual_centimos, 0);

    const total90 = suma(hace90, hoy);
    const variableDiario = Math.max(0, Math.round(total90 / 90 - fijoMensual / 30.4));

    res.json({
        hoy, dias_mes: diasMes, dias_quedan: diasQuedan,
        gastado_centimos: gastado,
        fijo_pendiente_centimos: fijoPendiente,
        variable_diario_centimos: variableDiario,
        prevision_centimos: gastado + fijoPendiente + variableDiario * diasQuedan,
        pendientes: pendientes.map(s => ({ comercio: s.comercio, importe_centimos: s.importe_medio_centimos, fecha: s.proximo })),
        fijo_mensual_centimos: fijoMensual
    });
};

// =============================================================================
// GET /api/estadisticas/comensales
// =============================================================================
//
// Restaurantes de 25 € o más en los que no se ha dicho cuántos éramos
// (compartido_entre NULL; 1 = "solo yo", ya revisado). Tiquets y cargos del
// banco sin tiquet; un cargo con tiquet se reparte en su tiquet.
const UMBRAL_COMENSALES = 2500;
exports.comensales = (req, res) => {
    const filas = prepararEnCache(`
        SELECT t.id, t.origen, substr(t.fecha_compra, 1, 10) AS fecha,
               COALESCE(t.total_eur_centimos, t.total_centimos) AS total_centimos,
               COALESCE(t.nombre_banco, e.nombre) AS nombre
        FROM ${GASTOS} t
        LEFT JOIN establecimientos e ON e.id = t.establecimiento_id
        WHERE ${CONTABLES} AND t.categoria = 'RESTAURACION' AND t.compartido_entre IS NULL
          AND COALESCE(t.total_eur_centimos, t.total_centimos) >= ${UMBRAL_COMENSALES}
        ORDER BY t.fecha_compra DESC
        LIMIT 300
    `).all();
    res.json({ umbral_centimos: UMBRAL_COMENSALES, pendientes: filas });
};

exports._internos = { periodoY_anterior, hoyEnMadrid, ticketMedio };
