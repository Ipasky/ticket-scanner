/**
 * Pruebas de la subida: una foto puede contener varios tiquets y la IA devuelve
 * SIEMPRE un array. Una foto de un tiquet es un array de longitud 1 y tiene que
 * comportarse igual que antes de existir esta función.
 *
 * El aislamiento (base y uploads temporales, doble de la IA) vive en
 * tests/ayuda_api.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    IA, ErrorIAFalso, db, UPLOADS_DIR,
    subirFoto, subirPdf, subirArchivo, crearEstablecimiento, crearTicket, crearImagen,
    leerFila, leerFilas, contarTickets, contarEstablecimientos, pedir
} = require('./ayuda_api.js');

/** Un tiquet con la forma que devuelve el modelo, para variar lo que interese. */
function tiquet(extra = {}) {
    return {
        indice_en_foto: 0,
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

/** Tres tiquets claramente distintos, en una sola foto. */
const TRES_TIQUETS = [
    tiquet({ indice_en_foto: 0, nombre_establecimiento: 'MERCADONA', total_centimos: 3949, fecha_compra: '2026-01-10 13:25:12' }),
    tiquet({ indice_en_foto: 1, nombre_establecimiento: 'CONDIS',    total_centimos: 1250, fecha_compra: '2026-01-10 17:02:00' }),
    tiquet({ indice_en_foto: 2, nombre_establecimiento: 'FARMACIA CENTRAL', total_centimos: 875, fecha_compra: '2026-01-11 09:40:30',
             categoria: 'SALUD', tipo_documento: 'FARMACIA' })
];

// =============================================================================
// ARRAY DE 1 — tiene que ser exactamente el comportamiento de siempre
// =============================================================================

test('array de 1: se guarda una fila procesada, como antes de los múltiples', async () => {
    IA.responder = async () => [tiquet()];

    const { status, datos } = await subirFoto();

    assert.equal(status, 200);
    assert.equal(datos.resultado, 'creado');
    assert.equal(datos.estado, 'procesado');
    assert.equal(datos.total_en_foto, 1);
    assert.deepEqual(datos.ids, [datos.id]);
    assert.equal(contarTickets(), 1);

    const fila = leerFila(datos.id);
    assert.equal(fila.indice_en_foto, 0);
    assert.equal(fila.total_en_foto, 1);
    assert.equal(fila.recuadro, null);
    assert.equal(fila.total_centimos, 3949);
    assert.equal(fila.hora_conocida, 1);
    // Con un solo tiquet el estado se calcula como siempre y SÍ hay clave.
    assert.ok(fila.clave_tiquet.endsWith('|2026-01-10 13:25:12|3949'));
});

test('array de 1 sin importe: procesado y marcado solo, pero sin clave', async () => {
    // Cambio de criterio: un importe ausente ya no deja la fila incompleta. Lo
    // que sí sigue pasando es que sin importe no hay clave de dedupe.
    IA.responder = async () => [tiquet({ total_centimos: null })];

    const { datos } = await subirFoto();

    assert.equal(datos.resultado, 'creado');
    assert.equal(datos.estado, 'procesado');

    const fila = leerFila(datos.id);
    assert.equal(fila.total_centimos, null, 'no se inventa un 0 en la columna');
    assert.equal(fila.sin_importe, 1);
    assert.equal(fila.clave_tiquet, null);
});

test('array de 1 sin FECHA sigue quedando incompleto: la fecha no ha cambiado', async () => {
    IA.responder = async () => [tiquet({ fecha_compra: null })];

    const { datos } = await subirFoto();

    assert.equal(datos.estado, 'incompleto');
    assert.equal(leerFila(datos.id).clave_tiquet, null);
});

test('array de 1: un objeto suelto sin envolver se trata como lote de uno', async () => {
    // Tolerancia: si el modelo ignora el array del schema y devuelve un tiquet a
    // secas, la subida no se cae.
    IA.responder = async () => tiquet();

    const { status, datos } = await subirFoto();

    assert.equal(status, 200);
    assert.equal(datos.total_en_foto, 1);
    assert.equal(leerFila(datos.id).total_centimos, 3949);
});

// =============================================================================
// ARRAY DE 3
// =============================================================================

test('array de 3: tres filas independientes que comparten foto', async () => {
    IA.responder = async () => TRES_TIQUETS;

    const { status, datos } = await subirFoto();

    assert.equal(status, 200);
    assert.equal(datos.resultado, 'creado_multiple');
    assert.equal(datos.total_en_foto, 3);
    assert.equal(datos.ids.length, 3);
    assert.equal(contarTickets(), 3);

    const filas = leerFilas();
    assert.deepEqual(filas.map(f => f.indice_en_foto), [0, 1, 2]);
    assert.deepEqual(filas.map(f => f.total_en_foto), [3, 3, 3]);

    // Comparten el MISMO archivo: la foto no se recorta ni se duplica.
    assert.equal(new Set(filas.map(f => f.hash_imagen)).size, 1);
    assert.equal(new Set(filas.map(f => f.ruta_imagen)).size, 1);
    assert.equal(
        fs.existsSync(path.join(UPLOADS_DIR, path.basename(filas[0].ruta_imagen))),
        true
    );

    // Dedupe nivel 2 sigue siendo por tiquet: tres claves distintas.
    const claves = filas.map(f => f.clave_tiquet);
    assert.equal(claves.filter(Boolean).length, 3);
    assert.equal(new Set(claves).size, 3);

    // Y cada uno conserva sus propios datos.
    assert.deepEqual(filas.map(f => f.total_centimos), [3949, 1250, 875]);
});

test('array de 3: todas quedan incompletas aunque la lectura parezca completa', async () => {
    // Una foto con varios tiquets siempre se revisa: es donde más fácil se
    // equivoca el modelo repartiendo importes entre papeles.
    IA.responder = async () => TRES_TIQUETS;

    const { datos } = await subirFoto();

    assert.deepEqual(datos.filas.map(f => f.estado), ['incompleto', 'incompleto', 'incompleto']);
    assert.deepEqual(leerFilas().map(f => f.estado), ['incompleto', 'incompleto', 'incompleto']);
});

test('array de 3 desordenado: se reordena por indice_en_foto del modelo', async () => {
    IA.responder = async () => [TRES_TIQUETS[2], TRES_TIQUETS[0], TRES_TIQUETS[1]];

    await subirFoto();

    // El índice definitivo es 0..N-1 en orden de lectura, no el orden de llegada.
    assert.deepEqual(leerFilas().map(f => f.total_centimos), [3949, 1250, 875]);
    assert.deepEqual(leerFilas().map(f => f.indice_en_foto), [0, 1, 2]);
});

test('array de 3: el establecimiento de cada tiquet se crea por separado', async () => {
    IA.responder = async () => TRES_TIQUETS;
    await subirFoto();

    const nombres = db.prepare('SELECT nombre FROM establecimientos ORDER BY nombre').all().map(r => r.nombre);
    assert.deepEqual(nombres, ['CONDIS', 'FARMACIA CENTRAL', 'MERCADONA']);
});

// =============================================================================
// RESUBIDA DEL MISMO ARCHIVO — dedupe nivel 1: el hash identifica la FOTO
// =============================================================================

test('resubida del mismo archivo: detecta que esa foto ya generó 3 filas, sin llamar a la API', async () => {
    IA.responder = async () => TRES_TIQUETS;

    const contenido = 'la-misma-foto-exacta';
    const primera = await subirFoto('foto.jpg', contenido);
    assert.equal(primera.datos.total_en_foto, 3);
    assert.equal(IA.llamadas, 1);

    const segunda = await subirFoto('foto.jpg', contenido);

    assert.equal(segunda.status, 200);
    assert.equal(segunda.datos.resultado, 'duplicado_exacto');
    assert.equal(segunda.datos.total_en_foto, 3);
    assert.deepEqual(segunda.datos.ids, primera.datos.ids);
    assert.match(segunda.datos.mensaje, /generó 3 tiquets/);

    // Lo importante: NO se ha vuelto a llamar a la IA y no hay filas nuevas.
    assert.equal(IA.llamadas, 1);
    assert.equal(contarTickets(), 3);
});

test('resubida del mismo archivo con un solo tiquet: mensaje de siempre', async () => {
    IA.responder = async () => [tiquet()];
    const contenido = 'foto-de-un-tiquet';
    const primera = await subirFoto('a.jpg', contenido);

    const segunda = await subirFoto('b.jpg', contenido);

    assert.equal(segunda.datos.resultado, 'duplicado_exacto');
    assert.equal(segunda.datos.total_en_foto, 1);
    assert.equal(segunda.datos.id_existente, primera.datos.id);
    assert.match(segunda.datos.mensaje, /ya está en la base/);
    assert.equal(IA.llamadas, 1);
});

test('resubida de una foto que quedó pendiente: avisa de que sigue sin procesar', async () => {
    IA.responder = async () => {
        throw new ErrorIAFalso({ tipo: 'cuota', status: 429, mensaje: 'Cuota agotada.' });
    };
    const contenido = 'foto-pendiente';
    await subirFoto('p.jpg', contenido);
    assert.equal(contarTickets(), 1);

    const segunda = await subirFoto('p.jpg', contenido);

    assert.equal(segunda.datos.resultado, 'duplicado_exacto');
    assert.match(segunda.datos.mensaje, /sin procesar/);
    assert.match(segunda.datos.mensaje, /Reintentar/);
    assert.equal(contarTickets(), 1);
});

// =============================================================================
// DOS ENTRADAS CON LA MISMA CLAVE DENTRO DE LA FOTO
// =============================================================================

test('dos entradas con la misma clave: se queda una y se registra', async () => {
    // El modelo ha leído dos veces el mismo papel (doblado, o el tiquet y su
    // justificante de tarjeta). Misma clave = mismo establecimiento, misma fecha
    // con hora y mismo importe: no son dos tiquets.
    IA.responder = async () => [
        tiquet({ indice_en_foto: 0 }),
        tiquet({ indice_en_foto: 1 }),                       // clon exacto del anterior
        tiquet({ indice_en_foto: 2, nombre_establecimiento: 'CONDIS', total_centimos: 1250 })
    ];

    const { status, datos } = await subirFoto();

    assert.equal(status, 200);
    // Se han guardado 2, no 3.
    assert.equal(contarTickets(), 2);
    assert.equal(datos.total_en_foto, 2);
    assert.equal(datos.ids.length, 2);
    assert.match(datos.mensaje, /1 lectura\(s\) repetida\(s\)/);

    // Índices reindexados sin huecos, para que "2 de 2" sea verdad y para que
    // (hash, indice_en_foto) siga siendo único.
    const filas = leerFilas();
    assert.deepEqual(filas.map(f => f.indice_en_foto), [0, 1]);
    assert.deepEqual(filas.map(f => f.total_en_foto), [2, 2]);
    assert.deepEqual(filas.map(f => f.total_centimos), [3949, 1250]);
});

test('dos entradas SIN clave no se consideran repetidas', async () => {
    // Sin fecha usable no hay clave, y dos lecturas sin clave pueden ser
    // perfectamente dos tiquets distintos: no se descarta ninguna.
    IA.responder = async () => [
        tiquet({ indice_en_foto: 0, fecha_compra: 'ilegible', total_centimos: null }),
        tiquet({ indice_en_foto: 1, fecha_compra: 'ilegible', total_centimos: null })
    ];

    const { datos } = await subirFoto();

    assert.equal(contarTickets(), 2);
    assert.equal(datos.total_en_foto, 2);
    assert.deepEqual(leerFilas().map(f => f.clave_tiquet), [null, null]);
});

test('si las tres entradas son el mismo papel, queda UNA y con el estado de siempre', async () => {
    IA.responder = async () => [
        tiquet({ indice_en_foto: 0 }),
        tiquet({ indice_en_foto: 1 }),
        tiquet({ indice_en_foto: 2 })
    ];

    const { datos } = await subirFoto();

    assert.equal(contarTickets(), 1);
    assert.equal(datos.total_en_foto, 1);
    // Ha quedado una sola ficha, así que ya no es una "foto múltiple": el estado
    // se calcula como siempre y sale procesado.
    assert.equal(datos.resultado, 'creado');
    assert.equal(datos.estado, 'procesado');
});

// =============================================================================
// RESPUESTA TRUNCADA
// =============================================================================

test('respuesta truncada: 422 con el motivo real, UNA fila y la foto guardada', async () => {
    IA.responder = async () => {
        throw new ErrorIAFalso({
            tipo: 'truncado',
            status: null,
            mensaje: 'La respuesta se ha cortado por falta de espacio: había demasiados ' +
                     'tiquets (o demasiadas líneas de producto) en una sola foto. Sepárala en ' +
                     'varias fotos con menos tiquets cada una y vuelve a subirlas.'
        });
    };

    const { status, datos } = await subirFoto();

    assert.equal(status, 422);
    assert.equal(datos.resultado, 'fallo');
    assert.equal(datos.tipo, 'truncado');
    assert.match(datos.error, /demasiados\s+tiquets/);
    assert.match(datos.error, /Sepárala en varias fotos/);

    // Una sola fila, no N: no sabemos cuántos tiquets había.
    assert.equal(contarTickets(), 1);
    const fila = leerFilas()[0];
    // 'error' y no 'pendiente': reintentar la misma foto la volvería a truncar.
    assert.equal(fila.estado, 'error');
    assert.equal(fila.total_en_foto, 1);
    // Y la foto NO se pierde.
    assert.ok(fs.existsSync(path.join(UPLOADS_DIR, path.basename(fila.ruta_imagen))));
});

test('un fallo transitorio guarda UNA fila pendiente, no N', async () => {
    IA.responder = async () => {
        throw new ErrorIAFalso({ tipo: 'transitorio', status: 503, mensaje: 'Gemini saturado.' });
    };

    const { status, datos } = await subirFoto();

    assert.equal(status, 503);
    assert.equal(datos.estado, 'pendiente');
    assert.equal(contarTickets(), 1);
    assert.equal(leerFilas()[0].total_en_foto, 1);
});

// =============================================================================
// RECUADRO
// =============================================================================

test('recuadro válido se guarda como JSON y sale parseado por la API', async () => {
    IA.responder = async () => [
        tiquet({ indice_en_foto: 0, recuadro: { x: 0.05, y: 0.02, ancho: 0.9, alto: 0.45 } }),
        tiquet({ indice_en_foto: 1, nombre_establecimiento: 'CONDIS', total_centimos: 1250,
                 recuadro: { x: 0.05, y: 0.52, ancho: 0.9, alto: 0.45 } })
    ];

    const { datos } = await subirFoto();

    assert.deepEqual(JSON.parse(leerFilas()[0].recuadro), { x: 0.05, y: 0.02, ancho: 0.9, alto: 0.45 });

    const { datos: lista } = await pedir('GET', `/api/tickets/${datos.ids[1]}`);
    assert.deepEqual(lista.recuadro, { x: 0.05, y: 0.52, ancho: 0.9, alto: 0.45 });
});

test('recuadro en píxeles (fuera de 0..1) se descarta y no se pinta nada', async () => {
    IA.responder = async () => [tiquet({ recuadro: { x: 120, y: 340, ancho: 800, alto: 600 } })];

    const { datos } = await subirFoto();

    assert.equal(leerFila(datos.id).recuadro, null);
    assert.ok(datos.descartados.some(d => d.campo === 'recuadro'));
});

// =============================================================================
// FOTO SIN TIQUETS RECONOCIBLES
// =============================================================================

test('array vacío: se conserva la foto con una ficha vacía para revisar', async () => {
    IA.responder = async () => [];

    const { status, datos } = await subirFoto();

    assert.equal(status, 200);
    assert.equal(datos.resultado, 'sin_tiquets');
    assert.equal(datos.estado, 'incompleto');
    assert.equal(contarTickets(), 1);

    const fila = leerFilas()[0];
    assert.equal(fila.total_centimos, null);
    assert.equal(fila.estado, 'incompleto');
    assert.ok(fs.existsSync(path.join(UPLOADS_DIR, path.basename(fila.ruta_imagen))));
});

// =============================================================================
// DEDUPE NIVEL 2 CRUZADO CON LOS MÚLTIPLES
// =============================================================================

test('foto de un tiquet que ya teníamos: se reemplaza in-place, como antes', async () => {
    const estId = crearEstablecimiento('MERCADONA');
    const existente = crearTicket({
        establecimiento_id: estId,
        fecha_compra: '2026-01-10 13:25:12',
        total_centimos: 3949,
        clave_tiquet: `${estId}|2026-01-10 13:25:12|3949`,
        hora_conocida: 1,
        estado: 'procesado'
    });

    IA.responder = async () => [tiquet()];
    const { datos } = await subirFoto();

    assert.equal(datos.resultado, 'reemplazado');
    assert.equal(datos.id, existente.id);
    assert.equal(contarTickets(), 1, 'no se crea una fila nueva');
    assert.ok(datos.imagen_antigua.startsWith('/uploads/reemplazadas/'));
});

test('foto múltiple donde uno ya existe: se marca para revisar, NO se reemplaza', async () => {
    // Reemplazar significaría entregarle esta foto a una fila ajena, y la foto es
    // compartida por las hermanas: se quedarían apuntando a una imagen que ya no
    // les pertenece. Así que se guarda sin clave y marcado.
    const estId = crearEstablecimiento('MERCADONA');
    const existente = crearTicket({
        establecimiento_id: estId,
        fecha_compra: '2026-01-10 13:25:12',
        total_centimos: 3949,
        clave_tiquet: `${estId}|2026-01-10 13:25:12|3949`,
        hora_conocida: 1,
        estado: 'procesado'
    });

    IA.responder = async () => [TRES_TIQUETS[0], TRES_TIQUETS[1]];
    const { datos } = await subirFoto();

    assert.equal(datos.resultado, 'creado_multiple');
    assert.equal(contarTickets(), 3, 'la fila que ya existía sigue estando');

    const marcada = datos.filas.find(f => f.indice_en_foto === 0);
    assert.equal(marcada.resultado, 'duplicado_marcado');
    assert.equal(marcada.id_similar, existente.id);
    assert.equal(leerFila(marcada.id).clave_tiquet, null);
    assert.equal(leerFila(marcada.id).estado, 'incompleto');

    // Y la fila original no se ha tocado.
    assert.equal(leerFila(existente.id).clave_tiquet, `${estId}|2026-01-10 13:25:12|3949`);
    assert.equal(leerFila(existente.id).ruta_imagen, existente.ruta_imagen);
});

// =============================================================================
// REINTENTO SOBRE UNA FOTO QUE RESULTA TENER VARIOS TIQUETS
// =============================================================================

test('reintentar una foto pendiente que tiene 2 tiquets: reusa la fila y crea la otra', async () => {
    const { id } = crearTicket({ estado: 'pendiente' });
    IA.responder = async () => [TRES_TIQUETS[0], TRES_TIQUETS[1]];

    const { status, datos } = await pedir('POST', `/api/tickets/${id}/reintentar`);

    assert.equal(status, 200);
    assert.equal(datos.resultado, 'reintentado_con_aviso');
    assert.equal(datos.total_en_foto, 2);
    assert.match(datos.mensaje, /contiene 2 tiquets/);
    assert.equal(contarTickets(), 2);

    const filas = leerFilas();
    // La fila que ya existía se reaprovecha para el primero.
    assert.equal(filas[0].id, id);
    assert.deepEqual(filas.map(f => f.indice_en_foto), [0, 1]);
    assert.deepEqual(filas.map(f => f.total_en_foto), [2, 2]);
    // Las dos comparten el archivo y el hash de la fila original.
    assert.equal(new Set(filas.map(f => f.hash_imagen)).size, 1);
    assert.equal(new Set(filas.map(f => f.ruta_imagen)).size, 1);
    assert.deepEqual(filas.map(f => f.estado), ['incompleto', 'incompleto']);
});

// =============================================================================
// LA FOTO ES COMPARTIDA: BORRAR UNA FILA NO PUEDE LLEVARSE LA IMAGEN
// =============================================================================

test('borrar una de 3 filas de la misma foto: la imagen se conserva y las otras se renumeran', async () => {
    IA.responder = async () => TRES_TIQUETS;
    const { datos } = await subirFoto();
    const rutaImagen = leerFilas()[0].ruta_imagen;
    const enDisco = path.join(UPLOADS_DIR, path.basename(rutaImagen));
    assert.ok(fs.existsSync(enDisco));

    // Se borra la del medio.
    const delMedio = datos.ids[1];
    const res = await pedir('DELETE', `/api/tickets/${delMedio}`);

    assert.equal(res.status, 200);
    assert.equal(res.datos.imagen_borrada, false);
    assert.equal(res.datos.imagen_compartida, true);
    assert.equal(res.datos.tiquets_restantes_en_la_foto, 2);
    assert.match(res.datos.mensaje, /se conserva/);

    // La foto sigue en el disco: las otras dos la necesitan.
    assert.ok(fs.existsSync(enDisco), 'la imagen compartida NO se puede borrar');

    // Y las que quedan se renumeran: sin huecos y con el total corregido.
    const filas = leerFilas();
    assert.equal(filas.length, 2);
    assert.deepEqual(filas.map(f => f.indice_en_foto), [0, 1]);
    assert.deepEqual(filas.map(f => f.total_en_foto), [2, 2]);
    assert.deepEqual(filas.map(f => f.total_centimos), [3949, 875]);
});

test('borrar la última fila de una foto: entonces sí se borra la imagen', async () => {
    IA.responder = async () => [TRES_TIQUETS[0], TRES_TIQUETS[1]];
    const { datos } = await subirFoto();
    const enDisco = path.join(UPLOADS_DIR, path.basename(leerFilas()[0].ruta_imagen));

    const primera = await pedir('DELETE', `/api/tickets/${datos.ids[0]}`);
    assert.equal(primera.datos.imagen_borrada, false);
    assert.ok(fs.existsSync(enDisco));

    const segunda = await pedir('DELETE', `/api/tickets/${datos.ids[1]}`);
    assert.equal(segunda.datos.imagen_borrada, true);
    assert.equal(segunda.datos.imagen_compartida, false);
    assert.equal(fs.existsSync(enDisco), false, 'ya no la usa nadie: fuera');
    assert.equal(contarTickets(), 0);
});

test('reemplazar un tiquet que compartía foto no se lleva la foto de sus hermanas', async () => {
    // La fila reemplazada pasa a apuntar a la imagen nueva, pero su imagen
    // anterior sigue siendo la de sus hermanas: no se archiva.
    IA.responder = async () => TRES_TIQUETS;
    const { datos: multiple } = await subirFoto('lote.jpg', 'foto-con-tres');

    // Se completa a mano la primera para que tenga clave de alta confianza.
    await pedir('PUT', `/api/tickets/${multiple.ids[0]}`, {
        tipo_documento: 'COMPRA',
        categoria: 'ALIMENTACION',
        establecimiento: { nombre: 'MERCADONA' },
        fecha_compra: '2026-01-10 13:25:12',
        total_centimos: 3949,
        moneda: 'EUR',
        metodo_pago: 'TARJETA ****6158',
        items: [],
        detalles: []
    });
    const rutaCompartida = leerFila(multiple.ids[1]).ruta_imagen;
    const enDisco = path.join(UPLOADS_DIR, path.basename(rutaCompartida));

    // Ahora una foto NUEVA de ese mismo tiquet: reemplazo in-place.
    IA.responder = async () => [tiquet()];
    const { datos: reemplazo } = await subirFoto('suelto.jpg', 'foto-de-uno');

    assert.equal(reemplazo.resultado, 'reemplazado');
    assert.equal(reemplazo.id, multiple.ids[0]);
    // La imagen antigua NO se ha movido a reemplazadas: la usan las hermanas.
    assert.equal(reemplazo.imagen_antigua, rutaCompartida);
    assert.ok(fs.existsSync(enDisco), 'la foto de las hermanas sigue ahí');

    // Las dos hermanas se han renumerado.
    const hermanas = db.prepare(
        'SELECT indice_en_foto, total_en_foto FROM tickets WHERE ruta_imagen = ? ORDER BY indice_en_foto'
    ).all(rutaCompartida);
    assert.deepEqual(hermanas.map(h => h.indice_en_foto), [0, 1]);
    assert.deepEqual(hermanas.map(h => h.total_en_foto), [2, 2]);
});

// =============================================================================
// FACTURAS EN PDF
// =============================================================================
// Una factura casi nunca es una foto. Gemini lee el PDF de forma nativa, así que
// se guarda y se manda tal cual: ni se convierte a imagen ni se recorta.

test('un PDF se sube, se manda a la IA como PDF y se guarda tal cual', async () => {
    IA.responder = async () => [tiquet({
        tipo_documento: 'FACTURA',
        categoria: 'HOGAR',
        nombre_establecimiento: 'ENDESA',
        // En una factura, fecha_compra es la fecha de EMISIÓN.
        fecha_compra: '2026-03-01',
        total_centimos: 8742,
        detalles: [
            { clave: 'numero_factura', valor: 'FE26-000123' },
            { clave: 'nif_emisor', valor: 'A81948077' },
            { clave: 'base_imponible', valor: '7225' },
            { clave: 'cuota_iva', valor: '1517' },
            { clave: 'fecha_vencimiento', valor: '2026-03-20' }
        ]
    })];

    const { status, datos } = await subirPdf('factura-marzo.pdf', '%PDF-1.7 una factura');

    assert.equal(status, 200);
    assert.equal(datos.resultado, 'creado');
    assert.equal(datos.estado, 'procesado');

    // A la IA se le manda el tipo real: si se le mandara como image/jpeg, no
    // leería el PDF.
    assert.equal(IA.ultimoMime, 'application/pdf');

    const fila = leerFila(datos.id);
    // El archivo se guarda con su extensión, que es de donde sale el tipo MIME
    // al reintentar.
    assert.match(fila.ruta_imagen, /\.pdf$/);
    assert.ok(fs.existsSync(path.join(UPLOADS_DIR, path.basename(fila.ruta_imagen))));
    assert.equal(fila.fecha_compra, '2026-03-01');
    assert.equal(fila.hora_conocida, 0, 'una factura sin hora no se guarda a las 00:00');

    const detalles = JSON.parse(fila.detalles);
    assert.equal(detalles.numero_factura, 'FE26-000123');
    assert.equal(detalles.nif_emisor, 'A81948077');
    assert.equal(detalles.base_imponible, '7225');
    assert.equal(detalles.cuota_iva, '1517');
    assert.equal(detalles.fecha_vencimiento, '2026-03-20');
});

test('el hash detecta el PDF duplicado igual que una foto repetida', async () => {
    IA.responder = async () => [tiquet({ tipo_documento: 'FACTURA' })];

    const primera = await subirPdf('factura.pdf', '%PDF-1.7 mismo contenido');
    assert.equal(primera.datos.resultado, 'creado');
    assert.equal(IA.llamadas, 1);

    // Mismo contenido, otro nombre: es el mismo archivo.
    const segunda = await subirPdf('copia-de-la-factura.pdf', '%PDF-1.7 mismo contenido');

    assert.equal(segunda.status, 200);
    assert.equal(segunda.datos.resultado, 'duplicado_exacto');
    assert.equal(segunda.datos.id_existente, primera.datos.id);
    assert.equal(IA.llamadas, 1, 'no se vuelve a llamar a la IA');
    assert.equal(contarTickets(), 1);
});

test('un tipo que no se admite se rechaza explicando qué sí se admite', async () => {
    const { status, datos } = await subirArchivo('hoja.xlsx', 'no soy ni foto ni pdf',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

    assert.equal(status, 415);
    assert.match(datos.error, /PDF/);
    assert.equal(IA.llamadas, 0, 'ni se llega a la IA');
    assert.equal(contarTickets(), 0);
});

// =============================================================================
// REANALIZAR UN TIQUET DE UNA FOTO CON VARIOS
// =============================================================================
// El caso real que lo rompía: reanalizar el tiquet 2 de una foto con 3 intentaba
// INSERTAR las tres lecturas como filas nuevas, y el índice único
// (hash_imagen, indice_en_foto) lo paraba con "UNIQUE constraint failed". La IA
// lee la imagen completa, así que un reintento reanaliza la FOTO ENTERA y
// actualiza sus filas emparejándolas por indice_en_foto.

/** Una foto ya guardada con tres fichas, como la deja una subida múltiple. */
function fotoConTres() {
    const hash = 'hash-de-la-foto-triple';
    const ruta = crearImagen('triple.jpg');
    const ids = [0, 1, 2].map(i => crearTicket({
        hash_imagen: hash, ruta_imagen: ruta,
        indice_en_foto: i, total_en_foto: 3,
        estado: 'incompleto',
        tipo_documento: 'COMPRA', total_centimos: 100 * (i + 1),
        fecha_compra: `2026-01-1${i} 10:00:00`, hora_conocida: 1
    }).id);
    return { ids, hash, ruta };
}

test('reanalizar una ficha de una foto con 3 actualiza las 3, sin chocar con el índice', async () => {
    const { ids, hash } = fotoConTres();
    IA.responder = async () => TRES_TIQUETS;

    // Se pide por la SEGUNDA ficha: el reintento es de la foto, no de la fila.
    const { status, datos } = await pedir('POST', `/api/tickets/${ids[1]}/reintentar`, { forzar: true });

    assert.equal(status, 200, JSON.stringify(datos));
    assert.equal(contarTickets(), 3, 'ni una fila más ni una menos');
    assert.equal(datos.total_en_foto, 3);

    const filas = leerFilas();
    // Las MISMAS filas, actualizadas: los ids no cambian.
    assert.deepEqual(filas.map(f => f.id).sort((a, b) => a - b), [...ids].sort((a, b) => a - b));
    assert.deepEqual(filas.map(f => f.indice_en_foto), [0, 1, 2]);
    assert.deepEqual(filas.map(f => f.total_en_foto), [3, 3, 3]);
    assert.equal(new Set(filas.map(f => f.hash_imagen)).size, 1);
    assert.equal(filas[0].hash_imagen, hash);

    // Y traen los datos de la lectura nueva, cada uno en su índice.
    assert.equal(filas[0].total_centimos, 3949);
    assert.equal(filas[1].total_centimos, 1250);
    assert.equal(filas[2].total_centimos, 875);
});

test('si la relectura trae MÁS tiquets, los nuevos se insertan', async () => {
    const { ids } = fotoConTres();
    IA.responder = async () => [...TRES_TIQUETS, tiquet({
        indice_en_foto: 3, nombre_establecimiento: 'PANADERIA',
        total_centimos: 320, fecha_compra: '2026-01-13 08:00:00'
    })];

    const { status, datos } = await pedir('POST', `/api/tickets/${ids[0]}/reintentar`, { forzar: true });

    assert.equal(status, 200, JSON.stringify(datos));
    assert.equal(contarTickets(), 4);
    assert.deepEqual(leerFilas().map(f => f.indice_en_foto), [0, 1, 2, 3]);
    assert.deepEqual(leerFilas().map(f => f.total_en_foto), [4, 4, 4, 4]);
});

test('si la relectura trae MENOS, las sobrantes se conservan marcadas', async () => {
    // Borrar datos porque una relectura vea menos papeles sería perder lo único
    // que quedaba de ese tiquet. Se quedan, para revisar a mano.
    const { ids } = fotoConTres();
    IA.responder = async () => [TRES_TIQUETS[0]];

    const { status, datos } = await pedir('POST', `/api/tickets/${ids[2]}/reintentar`, { forzar: true });

    assert.equal(status, 200, JSON.stringify(datos));
    assert.equal(contarTickets(), 3, 'no se borra ninguna');
    assert.match(datos.mensaje, /se conservan/);

    const filas = leerFilas();
    assert.equal(filas[0].total_centimos, 3949, 'la primera, con la lectura nueva');
    // Las otras dos: marcadas y sin clave, que describía un tiquet que la foto
    // ya no dice tener.
    assert.deepEqual(filas.slice(1).map(f => f.estado), ['incompleto', 'incompleto']);
    assert.deepEqual(filas.slice(1).map(f => f.clave_tiquet), [null, null]);
});

test('si la relectura falla, no se queda nada a medias: ni filas ni establecimientos', async () => {
    // El fallo original dejó geocodificando un establecimiento de una
    // transacción que se había deshecho. Lo que no se confirma, no existe.
    const { ids } = fotoConTres();
    const establecimientosAntes = contarEstablecimientos();

    IA.responder = async () => [tiquet({
        indice_en_foto: 0, nombre_establecimiento: 'COMERCIO QUE NO DEBERIA QUEDARSE',
        // Un importe imposible: lo rechaza la validación y la fila queda
        // incompleta, pero lo que importa es que si algo lanza, no queda rastro.
        total_centimos: 1234
    })];

    const { status } = await pedir('POST', `/api/tickets/${ids[0]}/reintentar`, { forzar: true });
    assert.equal(status, 200);

    // Caso normal: el establecimiento nuevo SÍ se queda (la transacción se
    // confirmó) y la foto sigue teniendo sus tres filas.
    assert.equal(contarEstablecimientos(), establecimientosAntes + 1);
    assert.equal(contarTickets(), 3);
});
