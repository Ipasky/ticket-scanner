/**
 * GET /api/tickets: búsqueda, filtros, orden y paginación.
 *
 * Todo se resuelve en SQL, así que lo que se comprueba aquí es que cada filtro
 * filtra lo que dice y —tan importante como eso— que un filtro mal escrito da un
 * 400 en vez de ignorarse en silencio: una lista que parece correcta y no lo es
 * es peor que un error.
 *
 * El aislamiento (base y uploads temporales, doble de la IA) vive en
 * tests/ayuda_api.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { db, pedir, crearTicket, crearEstablecimiento } = require('./ayuda_api.js');

/** Pide el listado con una query y devuelve el cuerpo. */
async function listar(query = '') {
    const { status, datos } = await pedir('GET', `/api/tickets${query ? '?' + query : ''}`);
    assert.equal(status, 200, `la query "${query}" debería valer: ${JSON.stringify(datos)}`);
    return datos;
}

const ids = (datos) => datos.tiquets.map(t => t.id);

/** crearTicket devuelve {id, ruta_imagen, archivo}; aquí solo interesa el id. */
const idDe = (fila) => fila.id;

/** Un histórico pequeño pero variado, suficiente para todos los filtros. */
function sembrar() {
    const mercadona = crearEstablecimiento('MERCADONA', { ciudad: 'Barcelona' });
    const saba      = crearEstablecimiento('SABA PARKING', { ciudad: 'Barcelona' });
    const renfe     = crearEstablecimiento('RENFE', { ciudad: 'Madrid' });

    const compra = idDe(crearTicket({
        establecimiento_id: mercadona,
        tipo_documento: 'COMPRA', categoria: 'ALIMENTACION',
        fecha_compra: '2026-01-10 13:25:12', total_centimos: 3949,
        items: JSON.stringify([{ producto: 'LECHE ENTERA', cantidad: 2 }]),
        estado: 'procesado'
    }));

    const parking = idDe(crearTicket({
        establecimiento_id: saba,
        tipo_documento: 'PARKING', categoria: 'TRANSPORTE',
        fecha_compra: '2026-02-14 09:00:00', total_centimos: null,
        sin_importe: 1, estado: 'procesado'
    }));

    const billete = idDe(crearTicket({
        establecimiento_id: renfe,
        tipo_documento: 'BILLETE TREN', categoria: 'TRANSPORTE',
        fecha_compra: '2026-03-01 18:40:00', total_centimos: 12500,
        estado: 'procesado'
    }));

    const sinFecha = idDe(crearTicket({
        establecimiento_id: mercadona,
        tipo_documento: 'COMPRA', categoria: 'ALIMENTACION',
        fecha_compra: null, total_centimos: 500,
        estado: 'incompleto'
    }));

    return { mercadona, saba, renfe, compra, parking, billete, sinFecha };
}

// =============================================================================
// FORMA DE LA RESPUESTA
// =============================================================================

test('el listado devuelve los tiquets y con qué se han pedido', async () => {
    sembrar();
    const datos = await listar();

    assert.ok(Array.isArray(datos.tiquets));
    assert.equal(datos.total, 4);
    assert.equal(datos.tiquets.length, 4);
    assert.equal(datos.offset, 0);
    assert.equal(datos.hay_mas, false);
    assert.equal(datos.orden, 'fecha');
    assert.equal(datos.dir, 'desc');

    // Los campos que el historial necesita para agrupar por foto siguen ahí.
    for (const t of datos.tiquets) {
        assert.ok('hash_imagen' in t);
        assert.ok('indice_en_foto' in t);
        assert.ok('total_en_foto' in t);
        // Y el JSON ya viene desplegado, como siempre.
        assert.ok(Array.isArray(t.items));
        assert.equal(typeof t.detalles, 'object');
    }
});

test('se devuelve el establecimiento, con sus coordenadas si las tiene', async () => {
    const { mercadona } = sembrar();
    db.prepare('UPDATE establecimientos SET latitud = ?, longitud = ? WHERE id = ?')
      .run(41.3755, 2.137, mercadona);

    const datos = await listar('q=MERCADONA');
    const uno = datos.tiquets.find(t => t.establecimiento_id === mercadona);

    assert.equal(uno.establecimiento_nombre, 'MERCADONA');
    assert.equal(uno.establecimiento_latitud, 41.3755);
    assert.equal(uno.establecimiento_longitud, 2.137);
});

// =============================================================================
// BÚSQUEDA DE TEXTO
// =============================================================================

test('q busca en establecimiento, categoría, tipo e items', async () => {
    const { compra, parking, billete } = sembrar();

    // establecimiento
    assert.deepEqual(ids(await listar('q=SABA')), [parking]);

    // categoría
    const porCategoria = ids(await listar('q=TRANSPORTE')).sort((a, b) => a - b);
    assert.deepEqual(porCategoria, [parking, billete].sort((a, b) => a - b));

    // tipo de documento
    assert.deepEqual(ids(await listar('q=BILLETE')), [billete]);

    // y dentro de los items, que son JSON guardado como texto
    assert.deepEqual(ids(await listar('q=LECHE')), [compra]);
});

test('q no distingue mayúsculas y no deja colar comodines de SQL', async () => {
    sembrar();

    assert.equal((await listar('q=mercadona')).total, 2, 'minúsculas valen igual');

    // Quien escribe "%" busca eso, no "cualquier cosa": si no se escapara, este
    // patrón devolvería el histórico entero.
    assert.equal((await listar('q=%')).total, 0);
    assert.equal((await listar('q=_')).total, 0);
});

test('q que no encuentra nada devuelve una lista vacía, no un error', async () => {
    sembrar();
    const datos = await listar('q=NOEXISTEESTO');
    assert.deepEqual(datos.tiquets, []);
    assert.equal(datos.total, 0);
});

// =============================================================================
// FILTROS
// =============================================================================

test('rango de fechas, con los dos extremos incluidos', async () => {
    const { compra, parking, billete } = sembrar();

    assert.deepEqual(ids(await listar('desde=2026-02-01&hasta=2026-03-31')).sort((a, b) => a - b),
                     [parking, billete].sort((a, b) => a - b));

    // El día exacto del tiquet entra, aunque tenga hora.
    assert.deepEqual(ids(await listar('desde=2026-01-10&hasta=2026-01-10')), [compra]);

    // Una fila sin fecha nunca entra en un rango de fechas.
    assert.equal((await listar('desde=1900-01-01&hasta=2100-01-01')).total, 3);
});

test('rango de importe en céntimos; lo que no tiene importe vale 0', async () => {
    const { compra, parking, billete } = sembrar();

    assert.deepEqual(ids(await listar('min=10000')), [billete]);
    assert.deepEqual(ids(await listar('min=3000&max=5000')), [compra]);

    // El parking no tiene importe: cuenta como 0, así que entra con max=0 y no
    // con min=1.
    assert.deepEqual(ids(await listar('max=0')), [parking]);
    assert.equal(ids(await listar('min=1')).includes(parking), false);
});

test('filtros exactos de categoría, tipo y estado', async () => {
    const { compra, sinFecha, parking, billete } = sembrar();

    assert.deepEqual(ids(await listar('categoria=ALIMENTACION')).sort((a, b) => a - b),
                     [compra, sinFecha].sort((a, b) => a - b));
    // Se admite en minúsculas: es un filtro de una interfaz, no un identificador.
    assert.equal((await listar('categoria=alimentacion')).total, 2);

    assert.deepEqual(ids(await listar('tipo=PARKING')), [parking]);
    assert.deepEqual(ids(await listar('estado=incompleto')), [sinFecha]);
    assert.equal((await listar('estado=procesado')).total, 3);
    assert.ok(billete);
});

test('sin_importe filtra en los dos sentidos', async () => {
    const { parking } = sembrar();

    assert.deepEqual(ids(await listar('sin_importe=1')), [parking]);
    assert.equal((await listar('sin_importe=0')).total, 3);
});

test('los filtros se combinan entre sí', async () => {
    const { billete } = sembrar();

    const datos = await listar('categoria=TRANSPORTE&min=1&desde=2026-01-01');
    assert.deepEqual(ids(datos), [billete]);
    // Y la respuesta dice con qué se ha filtrado, para que la interfaz pueda
    // pintar las chapas de los filtros activos sin recordarlos ella.
    assert.equal(datos.filtros.categoria, 'TRANSPORTE');
    assert.equal(datos.filtros.min, 1);
    assert.equal(datos.filtros.desde, '2026-01-01');
});

// =============================================================================
// ORDEN
// =============================================================================

test('orden por fecha del tiquet (el de por defecto), importe y subida', async () => {
    const { compra, parking, billete, sinFecha } = sembrar();

    // Por defecto: fecha del tiquet, de la más reciente a la más antigua.
    assert.deepEqual(ids(await listar()), [billete, parking, compra, sinFecha]);

    // Y en los DOS sentidos la fila sin fecha va al final: no es la más antigua,
    // es la que no se sabe cuándo es. SQLite la pondría la primera al ordenar
    // ascendente si no se dijera lo contrario.
    assert.deepEqual(ids(await listar('orden=fecha&dir=asc')),
                     [compra, parking, billete, sinFecha]);

    // Por importe: el que no tiene vale 0 y se va al final.
    assert.deepEqual(ids(await listar('orden=importe')), [billete, compra, sinFecha, parking]);
    assert.deepEqual(ids(await listar('orden=importe&dir=asc'))[0], parking);
});

test('las filas de la misma foto se quedan juntas y en orden de lectura', async () => {
    // El historial ya no agrupa por foto, pero el editor sí ofrece saltar de una
    // hermana a otra: el orden dentro de la foto es el de lectura del modelo,
    // aunque las hermanas tengan fechas distintas.
    const est = crearEstablecimiento('BAR');
    const hash = 'hash-compartido';
    const segunda = idDe(crearTicket({
        establecimiento_id: est, archivo: 'foto-compartida.jpg', hash_imagen: hash,
        indice_en_foto: 1, total_en_foto: 2,
        fecha_compra: '2026-05-01 10:00:00', total_centimos: 200
    }));
    const primera = idDe(crearTicket({
        establecimiento_id: est, archivo: 'foto-compartida.jpg', hash_imagen: hash,
        indice_en_foto: 0, total_en_foto: 2,
        fecha_compra: '2026-05-01 10:00:00', total_centimos: 100
    }));

    const datos = await listar('orden=subida');
    const posiciones = ids(datos);

    assert.equal(posiciones.indexOf(primera) + 1, posiciones.indexOf(segunda),
                 'la hermana de índice 1 va justo detrás de la de índice 0');
});

test('hash trae las fichas de UNA foto, que es lo que pide el editor', async () => {
    // El editor ofrece saltar a las demás fichas de la misma foto. No puede
    // buscarlas en lo que haya cargado el historial: pagina y ordena como quiera
    // quien mira, y tres hermanas pueden estar en tres páginas distintas.
    sembrar();
    const est = crearEstablecimiento('BAR');
    const hash = 'hash-de-tres';
    const creadas = [0, 1, 2].map(i => idDe(crearTicket({
        establecimiento_id: est, archivo: 'tres.jpg', hash_imagen: hash,
        indice_en_foto: i, total_en_foto: 3,
        fecha_compra: '2026-05-01 10:00:00', total_centimos: 100 * (i + 1)
    })));

    const datos = await listar(`hash=${hash}&orden=subida&dir=asc`);

    assert.deepEqual(ids(datos), creadas, 'las tres, en orden de lectura');
    assert.equal(datos.total, 3);
    assert.equal(datos.filtros.hash, hash);
});

test('un hash que no existe devuelve una lista vacía, no un error', async () => {
    sembrar();
    const datos = await listar('hash=no-es-el-hash-de-nadie');

    assert.deepEqual(ids(datos), []);
    assert.equal(datos.total, 0);
});

// =============================================================================
// PAGINACIÓN
// =============================================================================

test('limit y offset, con el total de resultados que hay detrás', async () => {
    sembrar();

    const primera = await listar('limit=2&offset=0&orden=fecha&dir=asc');
    assert.equal(primera.tiquets.length, 2);
    assert.equal(primera.total, 4, 'el total es el de la consulta, no el de la página');
    assert.equal(primera.hay_mas, true);

    const segunda = await listar('limit=2&offset=2&orden=fecha&dir=asc');
    assert.equal(segunda.tiquets.length, 2);
    assert.equal(segunda.hay_mas, false);

    // Y entre las dos páginas están todas, sin repetir ninguna.
    const todas = [...ids(primera), ...ids(segunda)];
    assert.equal(new Set(todas).size, 4);
});

test('el total respeta los filtros', async () => {
    sembrar();
    const datos = await listar('categoria=TRANSPORTE&limit=1');
    assert.equal(datos.total, 2);
    assert.equal(datos.tiquets.length, 1);
    assert.equal(datos.hay_mas, true);
});

test('un offset más allá del final devuelve una página vacía, no un error', async () => {
    sembrar();
    const datos = await listar('offset=100');
    assert.deepEqual(datos.tiquets, []);
    assert.equal(datos.total, 4);
    assert.equal(datos.hay_mas, false);
});

test('un limit disparatado se recorta en silencio', async () => {
    sembrar();
    const datos = await listar('limit=999999');
    assert.ok(datos.limit <= 500, `el tope es 500 y ha devuelto ${datos.limit}`);
});

// =============================================================================
// LO QUE NO SE ENTIENDE NO SE IGNORA
// =============================================================================

test('un filtro mal escrito da 400 en vez de devolver una lista equivocada', async () => {
    sembrar();

    for (const query of [
        'desde=ayer', 'hasta=2026-13', 'min=mucho', 'max=-', 'limit=cero',
        'offset=-5', 'orden=precio', 'dir=arriba', 'sin_importe=quizas'
    ]) {
        const { status, datos } = await pedir('GET', `/api/tickets?${query}`);
        assert.equal(status, 400, `"${query}" debería ser un 400`);
        assert.ok(datos.error, 'y explicar qué pasa');
    }
});

test('los parámetros vacíos se ignoran: son los de un formulario sin rellenar', async () => {
    sembrar();
    const datos = await listar('q=&categoria=&desde=&min=&estado=');
    assert.equal(datos.total, 4);
    assert.deepEqual(datos.filtros, {});
});

// =============================================================================
// SIN UBICAR: LO QUE NO SALE EN EL MAPA
// =============================================================================

test('sin_ubicar filtra los tiquets que el mapa no puede pintar', async () => {
    // Es lo que hace la línea de control del panel al pulsarla.
    const { mercadona, compra, sinFecha } = sembrar();
    db.prepare('UPDATE establecimientos SET latitud = ?, longitud = ? WHERE id = ?')
      .run(41.3755, 2.137, mercadona);

    const sinUbicar = await listar('sin_ubicar=1');
    // Los dos de MERCADONA ya están situados; el resto no.
    assert.equal(sinUbicar.total, 2);
    assert.equal(ids(sinUbicar).includes(compra), false);
    assert.equal(ids(sinUbicar).includes(sinFecha), false);

    const ubicados = await listar('sin_ubicar=0');
    assert.deepEqual(ids(ubicados).sort((a, b) => a - b), [compra, sinFecha].sort((a, b) => a - b));
});

test('un tiquet sin establecimiento tampoco se puede ubicar', async () => {
    sembrar();
    const huerfano = idDe(crearTicket({ establecimiento_id: null, total_centimos: 100 }));

    assert.ok(ids(await listar('sin_ubicar=1')).includes(huerfano));
});

test('el listado dice con qué precisión está situado cada establecimiento', async () => {
    const { mercadona } = sembrar();
    db.prepare(`UPDATE establecimientos SET latitud=?, longitud=?, geo_precision='zona' WHERE id=?`)
      .run(41.0, 0.9, mercadona);

    const datos = await listar('q=MERCADONA');
    assert.equal(datos.tiquets[0].establecimiento_precision, 'zona');
});

test('sin_ubicar mal escrito es un 400', async () => {
    const { status } = await pedir('GET', '/api/tickets?sin_ubicar=quizas');
    assert.equal(status, 400);
});
