/**
 * Qué modelo leyó cada tiquet (columna modelo_usado) y selección manual del
 * modelo desde la web (parámetro modo_modelo).
 *
 * La cascada en sí se prueba en ai_cascada.test.js, con el servicio real. Aquí lo
 * que se comprueba es el PLUMBING: que el modo llega desde la petición hasta el
 * servicio, y que el modelo que respondió se guarda en la fila —en todas las
 * filas, si la foto traía varios tiquets—, porque esa columna existe para
 * comparar calidad entre modelos y un valor mal puesto la haría inútil.
 *
 * El aislamiento (base y uploads temporales, doble de la IA) vive en
 * tests/ayuda_api.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
    ctx, IA, ErrorIAFalso, CABECERA_IDENTIDAD, MODELOS_DE_PRUEBA,
    subirFoto, crearTicket, leerFila, leerFilas, pedir
} = require('./ayuda_api.js');

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

const DOS_TIQUETS = [
    tiquet({ indice_en_foto: 0, nombre_establecimiento: 'MERCADONA', total_centimos: 3949, fecha_compra: '2026-01-10 13:25:12' }),
    tiquet({ indice_en_foto: 1, nombre_establecimiento: 'CONDIS',    total_centimos: 1250, fecha_compra: '2026-01-10 17:02:00' })
];

/** Subida con campos extra en el multipart (el selector manda modo_modelo así). */
async function subirCon(campos = {}, contenido = `bytes-${Math.random()}`) {
    const formData = new FormData();
    formData.append('ticket', new Blob([contenido], { type: 'image/jpeg' }), 'foto.jpg');
    for (const [clave, valor] of Object.entries(campos)) formData.append(clave, valor);

    const res = await fetch(ctx.base + '/api/tickets/upload', {
        method: 'POST', body: formData, headers: { ...CABECERA_IDENTIDAD }
    });
    let datos = null;
    try { datos = await res.json(); } catch (_) {}
    return { status: res.status, datos };
}

// =============================================================================
// modelo_usado SE GUARDA
// =============================================================================

test('se guarda el modelo que leyó la foto', async () => {
    IA.modelo = 'gemini-2.5-pro-de-prueba';
    IA.responder = async () => [tiquet()];

    const { status, datos } = await subirFoto();

    assert.equal(status, 200);
    assert.equal(datos.modelo_usado, 'gemini-2.5-pro-de-prueba');
    assert.equal(leerFila(datos.id).modelo_usado, 'gemini-2.5-pro-de-prueba');
});

test('foto múltiple: el MISMO modelo en todas las filas', async () => {
    // Las N filas salen de UNA llamada: poner modelos distintos (o dejar alguna a
    // NULL) sería inventarse que las leyó gente distinta.
    IA.modelo = 'gemini-barato-de-prueba';
    IA.responder = async () => DOS_TIQUETS;

    const { datos } = await subirFoto();

    assert.equal(datos.resultado, 'creado_multiple');
    assert.equal(datos.total_en_foto, 2);

    const filas = leerFilas();
    assert.equal(filas.length, 2);
    assert.deepEqual(
        filas.map(f => f.modelo_usado),
        ['gemini-barato-de-prueba', 'gemini-barato-de-prueba']
    );
});

test('una foto sin tiquets reconocibles también anota el modelo', async () => {
    // Respondió y dijo que no había nada: es una lectura, y es justo la que
    // interesa comparar entre modelos.
    IA.modelo = 'gemini-cegato-de-prueba';
    IA.responder = async () => [];

    const { datos } = await subirFoto();

    assert.equal(datos.resultado, 'sin_tiquets');
    assert.equal(leerFila(datos.id).modelo_usado, 'gemini-cegato-de-prueba');
});

test('una fila guardada SIN extracción deja modelo_usado a NULL', async () => {
    // Ningún modelo llegó a leerla. Anotar el que se intentó convertiría
    // "lo leyó X" en "lo intentó X", y la comparación de calidad quedaría sucia.
    IA.responder = async () => {
        throw new ErrorIAFalso({ tipo: 'cuota', status: 429, mensaje: 'Cuota agotada.' });
    };

    const { status, datos } = await subirFoto();

    assert.equal(status, 429);
    assert.equal(datos.estado, 'pendiente');
    assert.equal(leerFila(datos.id).modelo_usado, null);
});

test('el reintento rellena modelo_usado de la fila que estaba pendiente', async () => {
    const { id } = crearTicket({ estado: 'pendiente', tipo_documento: null, total_centimos: null });
    assert.equal(leerFila(id).modelo_usado, null);

    IA.modelo = 'gemini-del-reintento';
    IA.responder = async () => [tiquet()];

    const { status, datos } = await pedir('POST', `/api/tickets/${id}/reintentar`);

    assert.equal(status, 200);
    assert.equal(datos.modelo_usado, 'gemini-del-reintento');
    assert.equal(leerFila(id).modelo_usado, 'gemini-del-reintento');
});

test('un reintento que destapa varios tiquets pone el modelo en todas las filas', async () => {
    const { id } = crearTicket({ estado: 'pendiente', tipo_documento: null, total_centimos: null });

    IA.modelo = 'gemini-del-reintento-multiple';
    IA.responder = async () => DOS_TIQUETS;

    await pedir('POST', `/api/tickets/${id}/reintentar`);

    const filas = leerFilas();
    assert.equal(filas.length, 2, 'se reaprovecha la fila y se crea una hermana');
    assert.ok(filas.every(f => f.modelo_usado === 'gemini-del-reintento-multiple'));
});

test('editar a mano NO cambia el modelo: sigue siendo cierto quién lo leyó', async () => {
    IA.modelo = 'gemini-que-lo-leyo';
    IA.responder = async () => [tiquet()];
    const { datos } = await subirFoto();

    const { status } = await pedir('PUT', `/api/tickets/${datos.id}`, {
        tipo_documento: 'COMPRA',
        nombre_establecimiento: 'MERCADONA CORREGIDO',
        fecha_compra: '2026-01-10 13:25:12',
        total_centimos: 4000,
        moneda: 'EUR',
        items: [],
        detalles: []
    });

    assert.equal(status, 200);
    assert.equal(leerFila(datos.id).modelo_usado, 'gemini-que-lo-leyo');
});

// =============================================================================
// SELECCIÓN MANUAL: EL MODO LLEGA AL SERVICIO
// =============================================================================

test('sin modo_modelo se pide el automático: la cascada completa', async () => {
    IA.responder = async () => [tiquet()];

    await subirFoto();

    assert.equal(IA.ultimasOpciones.modo, 'automatico');
});

test('el modo del selector llega al servicio en la subida', async () => {
    IA.responder = async () => [tiquet()];

    for (const modo of ['automatico', 'mejor', 'rapido']) {
        const { status } = await subirCon({ modo_modelo: modo }, `bytes-${modo}`);
        assert.equal(status, 200, `modo ${modo}`);
        assert.equal(IA.ultimasOpciones.modo, modo);
    }
});

test('el modo también llega en el reintento', async () => {
    const { id } = crearTicket({ estado: 'error', tipo_documento: null, total_centimos: null });
    IA.responder = async () => [tiquet()];

    const { status } = await pedir('POST', `/api/tickets/${id}/reintentar`, { modo_modelo: 'mejor' });

    assert.equal(status, 200);
    assert.equal(IA.ultimasOpciones.modo, 'mejor');
});

test('un modo inventado se rechaza con 400 y sin gastar una llamada a la API', async () => {
    // Tragarse el error y usar el automático le daría silenciosamente el modelo
    // barato a quien pidió el bueno con una errata.
    IA.responder = async () => [tiquet()];

    const { status, datos } = await subirCon({ modo_modelo: 'mejorr' });

    assert.equal(status, 400);
    assert.match(datos.error, /no es válido/);
    assert.match(datos.error, /automatico/);
    assert.equal(IA.llamadas, 0, 'no se llama a la IA con un parámetro que no se entiende');
});

test('un modo inventado en el reintento también es 400', async () => {
    const { id } = crearTicket({ estado: 'pendiente', tipo_documento: null, total_centimos: null });
    IA.responder = async () => [tiquet()];

    const { status } = await pedir('POST', `/api/tickets/${id}/reintentar`, { modo_modelo: 'el-mejor-de-todos' });

    assert.equal(status, 400);
    assert.equal(IA.llamadas, 0);
    assert.equal(leerFila(id).estado, 'pendiente', 'la fila se queda como estaba');
});

test('el modo se admite en mayúsculas y con espacios: es un desplegable, no un secreto', async () => {
    IA.responder = async () => [tiquet()];

    const { status } = await subirCon({ modo_modelo: '  MEJOR  ' });

    assert.equal(status, 200);
    assert.equal(IA.ultimasOpciones.modo, 'mejor');
});

// =============================================================================
// CONFIGURACIÓN PARA EL SELECTOR
// =============================================================================

test('/api/ia/config publica los modelos y los tres modos', async () => {
    const { status, datos } = await pedir('GET', '/api/ia/config');

    assert.equal(status, 200);
    assert.deepEqual(datos.modelos, MODELOS_DE_PRUEBA);
    assert.equal(datos.por_defecto, 'automatico');
    assert.deepEqual(datos.modos.map(m => m.valor), ['automatico', 'mejor', 'rapido']);
    // Las etiquetas vienen del servidor: el HTML no las lleva clavadas.
    assert.ok(datos.modos.every(m => typeof m.etiqueta === 'string' && m.etiqueta.length > 0));
});

test('/api/ia/config exige identidad, como todo /api', async () => {
    const res = await fetch(ctx.base + '/api/ia/config');
    assert.equal(res.status, 401);
});

test('la configuración no publica ninguna clave', async () => {
    const { datos } = await pedir('GET', '/api/ia/config');
    const texto = JSON.stringify(datos).toLowerCase();
    assert.doesNotMatch(texto, /api_key|apikey|secret/);
});
