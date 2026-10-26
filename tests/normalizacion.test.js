/**
 * Pruebas de la capa de validación/normalización.
 * Se ejecutan con el runner de Node (sin dependencias): `npm test`.
 *
 * El módulo bajo prueba es puro a propósito: no abre SQLite ni construye el
 * cliente de Gemini, así que estas pruebas no tocan la base ni la API.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
    validarDatosExtraidos,
    validarLoteExtraido,
    validarRecuadro,
    validarTexto,
    validarDetalles,
    validarItems,
    normalizarClaveDetalle,
    normalizarDatos,
    parsearCentimos,
    canonizarFecha,
    construirClaveTiquet,
    calcularEstado,
    ajustarAusenciasConfirmadas,
    sinImporteAutomatico,
    LIMITES_TEXTO,
    MAX_PARES_DETALLES,
    MAX_TIQUETS_POR_FOTO
} = require('../src/services/normalizacion.js');

// --- LOS DOS VALORES CORRUPTOS REALES ---------------------------------------
// Tal cual se guardaron en la base. Son el motivo de que exista esta capa.
const CORRUPTO_1 =
    'TARJETA ****6158 Quentin/anon format: TARJETA ****6158 -> TARJETA ****6158';

const CORRUPTO_2 =
    "TARJETA ****6158 Quentin/6158 -> TARJETA ****6158 (wait, let me fix string " +
    "formatting carefully..., instructions say 'Only generate a valid JSON'...)";

// Variante en MAYÚSCULAS, que es como acabó realmente en la columna (el
// normalizador aplicaba upperCase antes de guardar).
const CORRUPTO_2_MAYUS =
    "TARJETA ****6158 QUENTIN/6158 -> TARJETA ****6158 (WAIT, LET ME FIX STRING " +
    "FORMATTING CAREFULLY TO BE VALID JSON WITHOUT ANY MARKDOWN IF POSSIBLE, WAIT: " +
    "INSTRUCTIONS SAY 'ONLY GENERATE A VALID, PARSEABLE JSON... DO NOT INCLUDE ANY " +
    "EXTRA TEXT OUTSIDE OF THE JSON STRING' SO NO BACKTICKS!).";

/** Datos mínimos válidos, para partir de una base sana en cada caso. */
function datosBase(extra = {}) {
    return {
        tipo_documento: 'COMPRA',
        categoria: 'ALIMENTACION',
        nombre_establecimiento: 'MERCADONA',
        fecha_compra: '2026-01-10 13:25:12',
        total_centimos: 3949,
        moneda: 'EUR',
        metodo_pago: 'TARJETA ****6158',
        items: [],
        detalles: [],
        ...extra
    };
}

// =============================================================================
// PUNTO 2 — los dos valores corruptos reales se descartan
// =============================================================================

test('metodo_pago corrupto nº1 (flechas + "format:") se descarta y queda a null', () => {
    const { datos, descartados, camposNulos, afectaEstado } =
        validarDatosExtraidos(datosBase({ metodo_pago: CORRUPTO_1 }));

    assert.equal(datos.metodo_pago, null);
    assert.ok(camposNulos.has('metodo_pago'));

    const d = descartados.find(x => x.campo === 'metodo_pago');
    assert.ok(d, 'el descarte tiene que aparecer en el log');
    assert.match(d.motivo, /longitud|razonamiento/);

    // metodo_pago es secundario: no puede marcar la fila como incompleta.
    assert.equal(afectaEstado, false);
});

test('metodo_pago corrupto nº2 ("wait", "let me", "instructions say") se descarta', () => {
    const { datos, descartados, afectaEstado } =
        validarDatosExtraidos(datosBase({ metodo_pago: CORRUPTO_2 }));

    assert.equal(datos.metodo_pago, null);
    assert.ok(descartados.some(x => x.campo === 'metodo_pago'));
    assert.equal(afectaEstado, false);
});

test('la variante en MAYÚSCULAS del corrupto nº2 también se descarta', () => {
    const { datos } = validarDatosExtraidos(datosBase({ metodo_pago: CORRUPTO_2_MAYUS }));
    assert.equal(datos.metodo_pago, null);
});

test('un metodo_pago corrupto NO se convierte en DESCONOCIDO al normalizar', () => {
    const { datos, camposNulos } =
        validarDatosExtraidos(datosBase({ metodo_pago: CORRUPTO_1 }));
    const norm = normalizarDatos(datos, camposNulos);

    // 'DESCONOCIDO' significa "el documento no lo dice". Aquí el documento
    // probablemente sí lo decía: lo que falló fue la lectura. Debe quedar NULL.
    assert.equal(norm.metodo_pago, null);
});

test('un metodo_pago ausente sí se queda en DESCONOCIDO', () => {
    const { datos, camposNulos } = validarDatosExtraidos(datosBase({ metodo_pago: null }));
    const norm = normalizarDatos(datos, camposNulos);
    assert.equal(norm.metodo_pago, 'DESCONOCIDO');
});

test('una fila con metodo_pago descartado sigue siendo procesada', () => {
    const { datos, camposNulos, afectaEstado } =
        validarDatosExtraidos(datosBase({ metodo_pago: CORRUPTO_2 }));
    const norm = normalizarDatos(datos, camposNulos);

    const estado = calcularEstado({
        totalCentimos: norm.total_centimos,
        fechaCanonica: canonizarFecha(norm.fecha_compra),
        hayDescarteDeEstado: afectaEstado
    });
    assert.equal(estado, 'procesado');
});

test('los valores legítimos de metodo_pago pasan intactos', () => {
    for (const valido of ['EFECTIVO', 'TARJETA', 'TARJETA ****1234', 'BIZUM',
                          'TRANSFERENCIA', 'MIXTO', 'DESCONOCIDO']) {
        const { datos, descartados } =
            validarDatosExtraidos(datosBase({ metodo_pago: valido }));
        assert.equal(datos.metodo_pago, valido, `${valido} no debería descartarse`);
        assert.equal(descartados.length, 0);
    }
});

// --- Límites por campo ------------------------------------------------------

test('cada campo de texto tiene su propio límite de longitud', () => {
    assert.equal(LIMITES_TEXTO.metodo_pago, 40);
    assert.equal(LIMITES_TEXTO.nombre_establecimiento, 100);

    const largo = 'A'.repeat(41);
    assert.equal(validarTexto(largo, LIMITES_TEXTO.metodo_pago).ok, false);
    // El mismo texto cabe de sobra en un nombre de establecimiento.
    assert.equal(validarTexto(largo, LIMITES_TEXTO.nombre_establecimiento).ok, true);
});

test('nombre_establecimiento de 101 caracteres se descarta', () => {
    const { datos, descartados } = validarDatosExtraidos(
        datosBase({ nombre_establecimiento: 'B'.repeat(101) })
    );
    assert.equal(datos.nombre_establecimiento, null);
    assert.match(descartados[0].motivo, /longitud 101 > 100/);
});

// --- Marcadores de razonamiento --------------------------------------------

test('detecta los marcadores de razonamiento uno a uno', () => {
    const casos = [
        'TARJETA -> TARJETA',
        'TARJETA => TARJETA',
        'TARJETA → TARJETA',
        'wait, TARJETA',
        'TARJETA (let me check)',
        "let's use TARJETA",
        'instructions say TARJETA',
        'as an AI I cannot read it',
        'valid JSON',
        'format: TARJETA',
        'TARJETA...',
        'TARJETA "6158"',
        'TARJETA\n6158',
        '```TARJETA```'
    ];
    for (const caso of casos) {
        assert.equal(
            validarTexto(caso, 200).ok, false,
            `debería descartarse: ${JSON.stringify(caso)}`
        );
    }
});

test('no da falsos positivos con nombres reales que llevan apóstrofo', () => {
    for (const bueno of ["L'ILLA DIAGONAL", "O'DONNELL 34", 'CAN PISTRAUS',
                         'FORMATO GRANDE', 'BAR EL WAITER']) {
        assert.equal(validarTexto(bueno, 100).ok, true, `no debería descartarse: ${bueno}`);
    }
});

test('un campo ausente o vacío no cuenta como descarte', () => {
    const { descartados, camposNulos } = validarDatosExtraidos({
        tipo_documento: 'PARKING',
        nombre_establecimiento: 'SABA',
        fecha_compra: '2026-01-10',
        total_centimos: 500,
        moneda: 'EUR',
        metodo_pago: '   '
    });
    assert.equal(descartados.length, 0);
    assert.equal(camposNulos.size, 0);
});

// --- Campos que definen el estado ------------------------------------------

test('descartar fecha_compra deja la fila incompleta', () => {
    const { datos, camposNulos, afectaEstado } = validarDatosExtraidos(
        datosBase({ fecha_compra: '2026-01-10 -> wait, let me recheck the date' })
    );
    assert.equal(datos.fecha_compra, null);
    assert.equal(afectaEstado, true);

    const norm = normalizarDatos(datos, camposNulos);
    assert.equal(norm.fecha_compra, null);
    assert.equal(
        calcularEstado({
            totalCentimos: norm.total_centimos,
            fechaCanonica: canonizarFecha(norm.fecha_compra),
            hayDescarteDeEstado: afectaEstado
        }),
        'incompleto'
    );
});

test('descartar el total (negativo o absurdo) deja la fila incompleta', () => {
    for (const malo of [-500, 999_999_999_999]) {
        const { datos, afectaEstado, descartados } =
            validarDatosExtraidos(datosBase({ total_centimos: malo }));
        assert.equal(datos.total_centimos, null);
        assert.equal(afectaEstado, true);
        assert.ok(descartados.some(d => d.campo === 'total_centimos'));
    }
});

test('el log de descartes registra campo, motivo y valor recibido', () => {
    const { descartados } = validarDatosExtraidos(datosBase({ metodo_pago: CORRUPTO_1 }));
    const d = descartados[0];
    assert.equal(d.campo, 'metodo_pago');
    assert.equal(typeof d.motivo, 'string');
    assert.ok(d.valor.startsWith('TARJETA ****6158 Quentin'));
});

// =============================================================================
// PUNTO 4 — "sin importe" (null) frente a "importe cero" (0)
// =============================================================================

test('parsearCentimos: 0 y null no se confunden', () => {
    // Importe cero explícito.
    assert.equal(parsearCentimos(0), 0);
    assert.equal(parsearCentimos('0'), 0);
    assert.equal(parsearCentimos(' 0 '), 0);

    // Sin importe.
    assert.equal(parsearCentimos(null), null);
    assert.equal(parsearCentimos(undefined), null);
    assert.equal(parsearCentimos(''), null);
    assert.equal(parsearCentimos('   '), null);
    assert.equal(parsearCentimos('gratis'), null);
    assert.equal(parsearCentimos(NaN), null);
    assert.equal(parsearCentimos(false), null);
});

test('un total de 0 legítimo sobrevive a la validación y a la normalización', () => {
    const { datos, descartados, afectaEstado } =
        validarDatosExtraidos(datosBase({ total_centimos: 0 }));
    assert.equal(datos.total_centimos, 0);
    assert.equal(descartados.length, 0);
    assert.equal(afectaEstado, false);

    const norm = normalizarDatos(datos, new Set());
    assert.equal(norm.total_centimos, 0);
});

test('entrada de parking sin importe: total null, fila PROCESADA, sin clave', () => {
    const entradaParking = datosBase({
        tipo_documento: 'PARKING',
        nombre_establecimiento: 'SABA PARKING',
        total_centimos: null,          // no hay importe impreso: se paga a la salida
        metodo_pago: null,
        detalles: [
            { clave: 'matricula', valor: '9180KGJ' },
            { clave: 'carril_entrada', valor: '002' }
        ]
    });

    const { datos, camposNulos, afectaEstado } = validarDatosExtraidos(entradaParking);
    const norm = normalizarDatos(datos, camposNulos);
    const fechaCanonica = canonizarFecha(norm.fecha_compra);

    assert.equal(norm.total_centimos, null);
    // CRITERIO ACTUAL: no imprimir importe no es un defecto del documento. La
    // entrada de un parking se paga a la salida y nunca va a tener total; antes
    // se quedaba en ámbar para siempre, que era justo lo que vaciaba de
    // significado al ámbar.
    assert.equal(
        calcularEstado({ totalCentimos: norm.total_centimos, fechaCanonica, hayDescarteDeEstado: afectaEstado }),
        'procesado'
    );
    // Y queda marcada como "sin importe" sola, sin que nadie confirme nada: el
    // modelo no devolvió total y no se descartó ninguno por corrupto.
    assert.equal(sinImporteAutomatico(norm.total_centimos, camposNulos), true);
    // Sin importe no hay clave de dedupe: no se puede afirmar que dos
    // documentos sin importe sean el mismo.
    assert.equal(construirClaveTiquet(7, fechaCanonica, 1, norm.total_centimos), null);
});

test('entrada gratuita con importe 0 impreso: procesado y CON clave', () => {
    const entradaGratis = datosBase({
        tipo_documento: 'ENTRADA MUSEO',
        nombre_establecimiento: 'MUSEU DE MONTSERRAT',
        total_centimos: 0
    });

    const { datos, camposNulos, afectaEstado } = validarDatosExtraidos(entradaGratis);
    const norm = normalizarDatos(datos, camposNulos);
    const fechaCanonica = canonizarFecha(norm.fecha_compra);

    assert.equal(norm.total_centimos, 0);
    assert.equal(
        calcularEstado({ totalCentimos: norm.total_centimos, fechaCanonica, hayDescarteDeEstado: afectaEstado }),
        'procesado'
    );
    assert.equal(
        construirClaveTiquet(7, fechaCanonica, 1, norm.total_centimos),
        '7|2026-01-10 13:25:12|0'
    );
});

test('construirClaveTiquet: 0 genera clave, null y undefined no', () => {
    assert.equal(construirClaveTiquet(1, '2026-01-10', 0, 0), '1|2026-01-10|0');
    assert.equal(construirClaveTiquet(1, '2026-01-10', 0, null), null);
    assert.equal(construirClaveTiquet(1, '2026-01-10', 0, undefined), null);
    // Sin fecha tampoco hay clave, ni con un total perfectamente válido.
    assert.equal(construirClaveTiquet(1, null, 0, 1234), null);
});

test('calcularEstado: el importe ya no decide; la fecha sí', () => {
    // Con importe o sin él, la fila está procesada.
    assert.equal(calcularEstado({ totalCentimos: 0,    fechaCanonica: '2026-01-10' }), 'procesado');
    assert.equal(calcularEstado({ totalCentimos: 1234, fechaCanonica: '2026-01-10' }), 'procesado');
    assert.equal(calcularEstado({ totalCentimos: null, fechaCanonica: '2026-01-10' }), 'procesado');

    // La fecha sigue mandando: sin ella el tiquet no se puede situar en ninguna
    // gráfica ni deduplicar.
    assert.equal(calcularEstado({ totalCentimos: 0,    fechaCanonica: null }), 'incompleto');
    assert.equal(calcularEstado({ totalCentimos: null, fechaCanonica: null }), 'incompleto');
    assert.equal(calcularEstado({ totalCentimos: 0, fechaCanonica: null, sinFecha: true }), 'procesado');

    // Un descarte de un campo de estado sigue dejándola incompleta: que el
    // modelo devolviera basura donde iba el total no significa que el papel no
    // lleve importe, significa que no se ha sabido leer.
    assert.equal(
        calcularEstado({ totalCentimos: 0, fechaCanonica: '2026-01-10', hayDescarteDeEstado: true }),
        'incompleto'
    );
});

// =============================================================================
// PUNTO 5 — validación de los pares de detalles
// =============================================================================

test('un par de detalles con razonamiento del modelo se descarta entero', () => {
    const { detalles, descartados } = validarDetalles([
        { clave: 'matricula', valor: '9180KGJ' },
        { clave: 'hora_salida', valor: '17:27 -> wait, let me re-read the ticket' }
    ]);

    assert.deepEqual(detalles, { matricula: '9180KGJ' });
    assert.equal(descartados.length, 1);
    assert.equal(descartados[0].campo, 'detalles[1].valor');
});

test('si la clave es la corrupta, el par entero cae', () => {
    const { detalles, descartados } = validarDetalles([
        { clave: 'metodo -> format: metodo', valor: 'TARJETA' }
    ]);
    assert.deepEqual(detalles, {});
    assert.equal(descartados[0].campo, 'detalles[0].clave');
});

test('límites de longitud distintos para clave y valor', () => {
    const { detalles, descartados } = validarDetalles([
        { clave: 'k'.repeat(41), valor: 'ok' },              // clave demasiado larga
        { clave: 'observaciones', valor: 'v'.repeat(201) },   // valor demasiado largo
        { clave: 'matricula', valor: '9180KGJ' }             // bien
    ]);
    assert.deepEqual(detalles, { matricula: '9180KGJ' });
    assert.equal(descartados.length, 2);
    assert.match(descartados[0].motivo, /longitud 41 > 40/);
    assert.match(descartados[1].motivo, /longitud 201 > 200/);
});

test('tope de pares por documento', () => {
    const muchos = Array.from({ length: MAX_PARES_DETALLES + 5 }, (_, i) => ({
        clave: `campo_${i}`, valor: String(i)
    }));
    const { detalles, descartados } = validarDetalles(muchos);

    assert.equal(Object.keys(detalles).length, MAX_PARES_DETALLES);
    assert.ok(descartados.some(d => d.campo === 'detalles' && /5 pares ignorados/.test(d.valor)));
});

test('un par descartado NUNCA marca la fila como incompleta', () => {
    const { datos, descartados, afectaEstado, camposNulos } = validarDatosExtraidos(
        datosBase({
            detalles: [
                { clave: 'matricula', valor: '9180KGJ' },
                { clave: 'nota', valor: 'wait, let me reconsider this field...' }
            ]
        })
    );

    assert.ok(descartados.some(d => d.campo.startsWith('detalles[')));
    assert.equal(afectaEstado, false);
    assert.deepEqual(datos.detalles, { matricula: '9180KGJ' });

    const norm = normalizarDatos(datos, camposNulos);
    assert.equal(
        calcularEstado({
            totalCentimos: norm.total_centimos,
            fechaCanonica: canonizarFecha(norm.fecha_compra),
            hayDescarteDeEstado: afectaEstado
        }),
        'procesado'
    );
});

test('detalles que no es un array se registra y no revienta', () => {
    const { detalles, descartados } = validarDetalles({ matricula: '9180KGJ' });
    assert.deepEqual(detalles, {});
    assert.equal(descartados[0].campo, 'detalles');
});

test('items: una línea con producto contaminado se descarta, las demás siguen', () => {
    const { items, descartados } = validarItems([
        { producto: 'PLATANO', cantidad: 1, precio_centimos: 149 },
        { producto: 'LECHE -> wait, is it milk?', cantidad: 1, precio_centimos: 99 }
    ]);
    assert.equal(items.length, 1);
    assert.equal(items[0].producto, 'PLATANO');
    assert.equal(descartados[0].campo, 'items[1].producto');
});

// =============================================================================
// PUNTO 6 — normalización de las claves de detalles
// =============================================================================

test('normalizarClaveDetalle: acentos, espacios, guiones y signos', () => {
    assert.equal(normalizarClaveDetalle('Matrícula del vehículo'), 'matricula_del_vehiculo');
    assert.equal(normalizarClaveDetalle('Hora-Entrada'), 'hora_entrada');
    assert.equal(normalizarClaveDetalle('  Hora   Salida  '), 'hora_salida');
    assert.equal(normalizarClaveDetalle('Año'), 'ano');
    assert.equal(normalizarClaveDetalle('Nº Factura'), 'n_factura');
    assert.equal(normalizarClaveDetalle('Duració (minuts)'), 'duracio_minuts');
    assert.equal(normalizarClaveDetalle('NIF/CIF'), 'nif_cif');
    assert.equal(normalizarClaveDetalle('base.imponible'), 'base_imponible');
    assert.equal(normalizarClaveDetalle('IVA %'), 'iva');
    // Ya normalizada: idempotente.
    assert.equal(normalizarClaveDetalle('matricula_del_vehiculo'), 'matricula_del_vehiculo');
});

test('el valor NO se normaliza', () => {
    const { detalles } = validarDetalles([
        { clave: 'Matrícula del vehículo', valor: '9180KGJ' },
        { clave: 'Promoció', valor: '2x1 Museu de Montserrat' }
    ]);
    assert.deepEqual(detalles, {
        matricula_del_vehiculo: '9180KGJ',
        promocio: '2x1 Museu de Montserrat'
    });
});

test('una clave que se queda vacía al normalizar descarta el par', () => {
    const { detalles, descartados } = validarDetalles([{ clave: '€€€', valor: '10' }]);
    assert.deepEqual(detalles, {});
    assert.match(descartados[0].motivo, /vacía al normalizarla/);
});

test('dos claves que normalizan igual: se guarda la primera y se registra la colisión', () => {
    const { detalles, descartados } = validarDetalles([
        { clave: 'Hora Entrada', valor: '17:27' },
        { clave: 'hora-entrada', valor: '18:00' }
    ]);
    assert.deepEqual(detalles, { hora_entrada: '17:27' });
    assert.match(descartados[0].motivo, /colisión/);
});

test('un valor numérico en detalles se convierte a texto sin perderse', () => {
    const { detalles } = validarDetalles([{ clave: 'litros', valor: 38.72 }]);
    assert.deepEqual(detalles, { litros: '38.72' });
});

// =============================================================================
// Regresión: la fecha se sigue canonizando como antes
// =============================================================================

test('canonizarFecha mantiene su contrato', () => {
    assert.equal(canonizarFecha('2026-01-14'), '2026-01-14');
    assert.equal(canonizarFecha('2026-01-14T18:05:09'), '2026-01-14 18:05:09');
    assert.equal(canonizarFecha('2026-01-14T18:05'), '2026-01-14 18:05:00');
    assert.equal(canonizarFecha('2026-01-14T18:05:09.123Z'), '2026-01-14 18:05:09');
    assert.equal(canonizarFecha('2026-01-14T18:05:09+01:00'), '2026-01-14 18:05:09');
    assert.equal(canonizarFecha('  2026-01-14  '), '2026-01-14');
    assert.equal(canonizarFecha('14/01/2026'), null);
    assert.equal(canonizarFecha(null), null);
});

test('el caso completo: fila real con metodo_pago corrupto queda usable', () => {
    // Reproduce la fila id=1 de la base tal como se guardó.
    const { datos, camposNulos, afectaEstado } = validarDatosExtraidos({
        tipo_documento: 'COMPRA',
        categoria: 'ALIMENTACION',
        nombre_establecimiento: 'MERCADONA',
        fecha_compra: '2026-01-10 13:25:12',
        total_centimos: 3949,
        moneda: 'EUR',
        metodo_pago: CORRUPTO_2_MAYUS,
        items: [],
        detalles: []
    });

    const norm = normalizarDatos(datos, camposNulos);
    const fechaCanonica = canonizarFecha(norm.fecha_compra);
    const estado = calcularEstado({
        totalCentimos: norm.total_centimos,
        fechaCanonica,
        hayDescarteDeEstado: afectaEstado
    });

    assert.equal(norm.metodo_pago, null);      // el campo corrupto, fuera
    assert.equal(norm.total_centimos, 3949);   // el resto del tiquet, intacto
    assert.equal(norm.tipo_documento, 'COMPRA');
    assert.equal(estado, 'procesado');         // metodo_pago es secundario
    assert.equal(
        construirClaveTiquet(1, fechaCanonica, 1, norm.total_centimos),
        '1|2026-01-10 13:25:12|3949'
    );
});

// =============================================================================
// LOTE: VARIOS TIQUETS EN UNA FOTO
// =============================================================================

test('validarLoteExtraido: un array de uno es el caso normal, no una excepción', () => {
    const { tiquets, descartados } = validarLoteExtraido([datosBase({ indice_en_foto: 0 })]);
    assert.equal(tiquets.length, 1);
    assert.equal(descartados.length, 0);
    assert.equal(tiquets[0].datos.total_centimos, 3949);
});

test('validarLoteExtraido: valida cada tiquet por separado', () => {
    const { tiquets } = validarLoteExtraido([
        datosBase({ indice_en_foto: 0 }),
        datosBase({ indice_en_foto: 1, metodo_pago: 'TARJETA -> wait, let me recheck' })
    ]);

    // El descarte del segundo no contamina al primero.
    assert.equal(tiquets[0].datos.metodo_pago, 'TARJETA ****6158');
    assert.equal(tiquets[0].descartados.length, 0);
    assert.equal(tiquets[1].datos.metodo_pago, null);
    assert.ok(tiquets[1].descartados.some(d => d.campo === 'metodo_pago'));
});

test('validarLoteExtraido: ordena por indice_en_foto y tolera el que falte', () => {
    const { tiquets } = validarLoteExtraido([
        datosBase({ indice_en_foto: 2, nombre_establecimiento: 'TERCERO' }),
        datosBase({ nombre_establecimiento: 'SIN INDICE' }),   // sin índice: usa su posición, 1
        datosBase({ indice_en_foto: 0, nombre_establecimiento: 'PRIMERO' })
    ]);
    assert.deepEqual(
        tiquets.map(t => t.datos.nombre_establecimiento),
        ['PRIMERO', 'SIN INDICE', 'TERCERO']
    );
});

test('validarLoteExtraido: si dos declaran el mismo índice, manda el orden de llegada', () => {
    const { tiquets } = validarLoteExtraido([
        datosBase({ indice_en_foto: 1, nombre_establecimiento: 'LLEGO ANTES' }),
        datosBase({ indice_en_foto: 1, nombre_establecimiento: 'LLEGO DESPUES' })
    ]);
    assert.deepEqual(
        tiquets.map(t => t.datos.nombre_establecimiento),
        ['LLEGO ANTES', 'LLEGO DESPUES']
    );
});

test('validarLoteExtraido: tope de tiquets por foto', () => {
    const muchos = Array.from({ length: MAX_TIQUETS_POR_FOTO + 3 }, (_, i) =>
        datosBase({ indice_en_foto: i }));

    const { tiquets, descartados } = validarLoteExtraido(muchos);

    assert.equal(tiquets.length, MAX_TIQUETS_POR_FOTO);
    assert.ok(descartados.some(d => d.campo === 'lote' && /3 ignorados/.test(d.valor)));
});

test('validarLoteExtraido: un objeto suelto se trata como lote de uno y se registra', () => {
    const { tiquets, descartados } = validarLoteExtraido(datosBase());
    assert.equal(tiquets.length, 1);
    assert.ok(descartados.some(d => /objeto suelto/.test(d.motivo)));
});

test('validarLoteExtraido: lo que no es ni array ni objeto no revienta', () => {
    for (const basura of [null, undefined, 'texto', 42]) {
        const { tiquets, descartados } = validarLoteExtraido(basura);
        assert.equal(tiquets.length, 0);
        assert.equal(descartados[0].campo, 'lote');
    }
});

test('validarLoteExtraido: array vacío no es un error de formato, es una foto sin tiquets', () => {
    const { tiquets, descartados } = validarLoteExtraido([]);
    assert.equal(tiquets.length, 0);
    assert.equal(descartados.length, 0);
});

test('validarRecuadro: fracciones válidas pasan; píxeles y basura, no', () => {
    assert.deepEqual(
        validarRecuadro({ x: 0.05, y: 0.02, ancho: 0.9, alto: 0.45 }).valor,
        { x: 0.05, y: 0.02, ancho: 0.9, alto: 0.45 }
    );
    // Ausente es válido: el modelo no está obligado a estimarlo.
    assert.deepEqual(validarRecuadro(null), { ok: true, valor: null });
    assert.deepEqual(validarRecuadro(undefined), { ok: true, valor: null });

    // Píxeles en lugar de fracciones.
    assert.equal(validarRecuadro({ x: 120, y: 340, ancho: 800, alto: 600 }).ok, false);
    // Incompleto o no numérico.
    assert.equal(validarRecuadro({ x: 0.1, y: 0.1 }).ok, false);
    assert.equal(validarRecuadro({ x: 'izquierda', y: 0, ancho: 1, alto: 1 }).ok, false);
    // Área nula.
    assert.equal(validarRecuadro({ x: 0.1, y: 0.1, ancho: 0, alto: 0.5 }).ok, false);
});

test('validarRecuadro: un marco que se sale por el borde se recorta, no se descarta', () => {
    // Señala igual de bien la zona correcta, así que descartarlo sería peor.
    const r = validarRecuadro({ x: 0.8, y: 0.9, ancho: 0.5, alto: 0.4 });
    assert.equal(r.ok, true);
    assert.deepEqual(r.valor, { x: 0.8, y: 0.9, ancho: 0.2, alto: 0.1 });
});

// =============================================================================
// AUSENCIAS CONFIRMADAS: el hueco que ya se ha comprobado no es un pendiente
// =============================================================================

test('sinImporteAutomatico: ausencia sí, lectura fallida no', () => {
    // El modelo no devolvió total: el documento no lo lleva.
    assert.equal(sinImporteAutomatico(null, new Set()), true);
    assert.equal(sinImporteAutomatico(null, new Set(['metodo_pago'])), true);

    // El total venía y se descartó por corrupto: eso NO es una ausencia, es una
    // lectura que ha fallado. Marcarla "sin importe" convertiría un fallo
    // nuestro en un hecho sobre el papel.
    assert.equal(sinImporteAutomatico(null, new Set(['total_centimos'])), false);

    // Con importe, incluido el 0 impreso, no hay ausencia que marcar.
    assert.equal(sinImporteAutomatico(0, new Set()), false);
    assert.equal(sinImporteAutomatico(3949, new Set()), false);
});

test('calcularEstado: la confirmación es por campo, no global', () => {
    // Confirmar que no hay importe no tapa que además falte la fecha.
    assert.equal(
        calcularEstado({ totalCentimos: null, fechaCanonica: null, sinImporte: true }),
        'incompleto'
    );
    assert.equal(
        calcularEstado({ totalCentimos: null, fechaCanonica: null, sinImporte: true, sinFecha: true }),
        'procesado'
    );
    assert.equal(
        calcularEstado({ totalCentimos: 1234, fechaCanonica: null, sinFecha: true }),
        'procesado'
    );
});

test('calcularEstado: un descarte por contenido corrupto manda sobre las confirmaciones', () => {
    // Si el valor venía contaminado, no es una ausencia legítima: es una lectura
    // que hay que revisar, y ninguna casilla debería taparlo.
    assert.equal(
        calcularEstado({
            totalCentimos: null, fechaCanonica: null,
            sinImporte: true, sinFecha: true,
            hayDescarteDeEstado: true
        }),
        'incompleto'
    );
});

test('calcularEstado: un 0 impreso sigue siendo un dato, no una ausencia', () => {
    assert.equal(calcularEstado({ totalCentimos: 0, fechaCanonica: '2026-01-10' }), 'procesado');
    // Y no necesita ninguna confirmación para estarlo.
    assert.equal(
        calcularEstado({ totalCentimos: 0, fechaCanonica: '2026-01-10', sinImporte: false }),
        'procesado'
    );
});

test('ajustarAusenciasConfirmadas: sin_importe es derivada, sin_fecha se confirma', () => {
    // sin_importe ya no es una casilla: si no hay importe, la fila está sin
    // importe, lo marque alguien o no.
    assert.deepEqual(
        ajustarAusenciasConfirmadas({ totalCentimos: null, fechaCanonica: null, sinImporte: false, sinFecha: true }),
        { sinImporte: true, sinFecha: true }
    );
    assert.deepEqual(
        ajustarAusenciasConfirmadas({ totalCentimos: null, fechaCanonica: null }),
        { sinImporte: true, sinFecha: false }
    );

    // Escribir un importe la limpia sola: ese es el invariante de siempre
    // ("sin_importe = 1 implica total_centimos IS NULL"), ahora en los dos
    // sentidos.
    assert.deepEqual(
        ajustarAusenciasConfirmadas({ totalCentimos: 3949, fechaCanonica: '2026-01-10', sinImporte: true, sinFecha: true }),
        { sinImporte: false, sinFecha: false }
    );
    // Un 0 es un valor impreso, así que tampoco es una ausencia.
    assert.deepEqual(
        ajustarAusenciasConfirmadas({ totalCentimos: 0, fechaCanonica: null, sinImporte: true, sinFecha: false }),
        { sinImporte: false, sinFecha: false }
    );

    // sin_fecha SÍ sigue necesitando que alguien lo afirme: ahí la bandera
    // cambia el estado de la fila.
    assert.deepEqual(
        ajustarAusenciasConfirmadas({ totalCentimos: 10, fechaCanonica: null, sinFecha: false }),
        { sinImporte: false, sinFecha: false }
    );
});

test('una ausencia confirmada NO genera clave de duplicados', () => {
    // Confirmar no rellena el hueco: sigue sin haber importe con el que comparar.
    assert.equal(construirClaveTiquet(1, '2026-01-10 17:27:00', 1, null), null);
});

// =============================================================================
// EL LUGAR DEDUCIDO ES UN NOMBRE, NUNCA COORDENADAS
// =============================================================================

test('lugar_inferido admite un nombre de lugar', () => {
    const { datos } = validarDatosExtraidos({
        nombre_establecimiento: 'PATRONAT DE LA MUNTANYA DE MONTSERRAT',
        lugar_inferido: 'MONTSERRAT'
    });
    assert.equal(datos.lugar_inferido, 'MONTSERRAT');
});

test('unas coordenadas en lugar_inferido se descartan', () => {
    // Entrarían como texto en la consulta de geocodificación y acabarían
    // poniendo el punto en cualquier parte. Las coordenadas de verdad se pegan a
    // mano en su campo, con precisión 'manual'.
    for (const falso of ['41.5931, 1.8378', '41,5931; 1,8378', '-3.7038 40.4168']) {
        const { datos, descartados } = validarDatosExtraidos({
            nombre_establecimiento: 'X', lugar_inferido: falso
        });
        assert.equal(datos.lugar_inferido, null, falso);
        assert.ok(descartados.some(d => d.campo === 'lugar_inferido'), falso);
    }
});

test('efectivo: si la IA coge el cambio o lo entregado como total, el total es entregado - cambio', () => {
    const { corregirTotalEfectivo, validarDatosExtraidos } = require('../src/services/normalizacion.js');
    // Mercadona: TOTAL 11,10 · LLIURAMENT EFECTIU 50,00 · DEVOLUCIÓ 38,90
    assert.equal(corregirTotalEfectivo(3890, 5000, 3890), 1110);
    assert.equal(corregirTotalEfectivo(5000, 5000, 3890), 1110);
    assert.equal(corregirTotalEfectivo(1110, 5000, 3890), null, 'ya estaba bien');
    assert.equal(corregirTotalEfectivo(3890, null, 3890), null, 'sin entregado no se adivina');
    assert.equal(corregirTotalEfectivo(null, 5000, 3890), null, 'sin total no se inventa');
    const r = validarDatosExtraidos({ total_centimos: 3890, efectivo_entregado_centimos: 5000, cambio_centimos: 3890 });
    assert.equal(r.datos.total_centimos, 1110);
});
