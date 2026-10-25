/**
 * Pruebas de los endpoints de revisión: PUT /:id, DELETE /:id y
 * POST /:id/reintentar.
 *
 * El aislamiento (base y uploads temporales, doble de la IA) y los helpers viven
 * en tests/ayuda_api.js, que los comparte con api_upload.test.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    IA, ErrorIAFalso, db, UPLOADS_DIR,
    pedir, crearEstablecimiento, crearTicket, leerFila, contarEstablecimientos
} = require('./ayuda_api.js');

/** Cuerpo de PUT completo y válido, para ir variando campos sobre una base sana. */
function cuerpoEdicion(extra = {}) {
    return {
        tipo_documento: 'COMPRA',
        categoria: 'ALIMENTACION',
        establecimiento: { nombre: 'MERCADONA', direccion: 'CALLE MAYOR 12', ciudad: 'BARCELONA', codigo_postal: '08001' },
        fecha_compra: '2026-01-10 13:25:12',
        fecha_evento: null,
        total_centimos: 3949,
        moneda: 'EUR',
        metodo_pago: 'TARJETA ****6158',
        items: [],
        detalles: [],
        ...extra
    };
}

// =============================================================================
// PUT /api/tickets/:id
// =============================================================================

test('PUT: editar una fila incompleta hasta dejarla procesada', async () => {
    // Fila tal como la deja la extracción cuando no pudo leer el total: hay
    // datos, falta el importe, así que no hay clave de dedupe.
    const estId = crearEstablecimiento('MERCADONA');
    const { id } = crearTicket({
        tipo_documento: 'COMPRA',
        establecimiento_id: estId,
        fecha_compra: '2026-01-10 13:25:12',
        total_centimos: null,
        moneda: 'EUR',
        clave_tiquet: null,
        hora_conocida: 1,
        estado: 'incompleto'
    });

    const { status, datos } = await pedir('PUT', `/api/tickets/${id}`, cuerpoEdicion());

    assert.equal(status, 200);
    assert.equal(datos.resultado, 'actualizado');
    assert.equal(datos.estado_anterior, 'incompleto');
    assert.equal(datos.estado, 'procesado');

    const fila = leerFila(id);
    assert.equal(fila.estado, 'procesado');
    assert.equal(fila.total_centimos, 3949);
    // Con total y fecha ya hay clave de deduplicación donde antes no había.
    assert.equal(fila.clave_tiquet, `${estId}|2026-01-10 13:25:12|3949`);
    assert.equal(fila.hora_conocida, 1);
});

test('PUT: colisión de clave_tiquet al editar — no guarda y dice con quién choca', async () => {
    const estId = crearEstablecimiento('MERCADONA');

    // El tiquet que ya ocupa esa identidad semántica.
    const existente = crearTicket({
        establecimiento_id: estId,
        fecha_compra: '2026-01-10 13:25:12',
        total_centimos: 3949,
        clave_tiquet: `${estId}|2026-01-10 13:25:12|3949`,
        hora_conocida: 1,
        estado: 'procesado'
    });

    // Otro distinto que voy a editar hasta convertirlo, sin darme cuenta, en el
    // mismo tiquet.
    const aEditar = crearTicket({
        establecimiento_id: estId,
        fecha_compra: '2026-02-01 10:00:00',
        total_centimos: 1000,
        clave_tiquet: `${estId}|2026-02-01 10:00:00|1000`,
        hora_conocida: 1,
        estado: 'procesado'
    });

    const { status, datos } = await pedir('PUT', `/api/tickets/${aEditar.id}`, cuerpoEdicion());

    assert.equal(status, 409);
    assert.equal(datos.resultado, 'colision');
    assert.equal(datos.id_colision, existente.id);
    assert.match(datos.error, new RegExp(`id ${existente.id}`));

    // Y, sobre todo: no se ha guardado NADA de la edición.
    const fila = leerFila(aEditar.id);
    assert.equal(fila.total_centimos, 1000);
    assert.equal(fila.fecha_compra, '2026-02-01 10:00:00');
    assert.equal(fila.clave_tiquet, `${estId}|2026-02-01 10:00:00|1000`);
});

test('PUT: la colisión deshace también los cambios del establecimiento', async () => {
    // Para calcular la clave hace falta el id del establecimiento, así que el
    // upsert ocurre ANTES de detectar la colisión. Si no se deshiciera, un 409
    // dejaría un establecimiento nuevo creado pese a decir "no se ha guardado
    // nada". Aquí se comprueba que la transacción lo revierte.
    const estId = crearEstablecimiento('MERCADONA', { direccion: 'Calle Vieja 1' });

    crearTicket({
        establecimiento_id: estId,
        fecha_compra: '2026-01-10 13:25:12',
        total_centimos: 3949,
        clave_tiquet: `${estId}|2026-01-10 13:25:12|3949`,
        hora_conocida: 1
    });
    const aEditar = crearTicket({
        establecimiento_id: estId,
        fecha_compra: '2026-02-01 10:00:00',
        total_centimos: 1000,
        clave_tiquet: `${estId}|2026-02-01 10:00:00|1000`,
        hora_conocida: 1
    });

    // Misma fecha e importe que el existente, pero cambiando la dirección: la
    // dirección tampoco debe quedar tocada.
    const { status } = await pedir('PUT', `/api/tickets/${aEditar.id}`, cuerpoEdicion({
        establecimiento: { nombre: 'MERCADONA', direccion: 'CALLE NUEVA 99', ciudad: 'BARCELONA', codigo_postal: '08001' }
    }));

    assert.equal(status, 409);
    assert.equal(contarEstablecimientos(), 1, 'no se ha creado ningún establecimiento');
    assert.equal(
        db.prepare('SELECT direccion FROM establecimientos WHERE id = ?').get(estId).direccion,
        'Calle Vieja 1',
        'la dirección no se ha reescrito'
    );
});

test('PUT: canoniza la fecha igual que la extracción', async () => {
    const { id } = crearTicket({ estado: 'incompleto' });

    // Formato ISO con T, milisegundos y zona: se guarda canonizado.
    await pedir('PUT', `/api/tickets/${id}`, cuerpoEdicion({
        fecha_compra: '2026-03-05T18:05:09.123+01:00'
    }));

    assert.equal(leerFila(id).fecha_compra, '2026-03-05 18:05:09');
});

test('PUT: una fecha sin hora deja hora_conocida a 0 y no inventa 00:00:00', async () => {
    const { id } = crearTicket({ estado: 'incompleto' });

    await pedir('PUT', `/api/tickets/${id}`, cuerpoEdicion({ fecha_compra: '2026-03-05' }));

    const fila = leerFila(id);
    assert.equal(fila.fecha_compra, '2026-03-05');
    assert.equal(fila.hora_conocida, 0);
    // La clave usa solo la parte de día cuando la hora no se conoce.
    assert.ok(fila.clave_tiquet.endsWith('|2026-03-05|3949'));
});

test('PUT: normaliza las claves de detalles y deja el valor tal cual', async () => {
    const { id } = crearTicket({ estado: 'incompleto' });

    await pedir('PUT', `/api/tickets/${id}`, cuerpoEdicion({
        detalles: [
            { clave: 'Matrícula del vehículo', valor: '9180KGJ' },
            { clave: 'Hora-Entrada', valor: '17:27' }
        ]
    }));

    assert.deepEqual(JSON.parse(leerFila(id).detalles), {
        matricula_del_vehiculo: '9180KGJ',
        hora_entrada: '17:27'
    });
});

test('PUT: rechaza con 422 lo que la validación no acepta, sin guardar nada', async () => {
    const { id } = crearTicket({ estado: 'incompleto', metodo_pago: 'EFECTIVO' });

    const { status, datos } = await pedir('PUT', `/api/tickets/${id}`, cuerpoEdicion({
        metodo_pago: 'TARJETA ****6158 -> wait, let me check the format'
    }));

    assert.equal(status, 422);
    assert.equal(datos.resultado, 'rechazado');
    assert.ok(datos.descartados.some(d => d.campo === 'metodo_pago'));

    // A diferencia de la extracción, aquí no se descarta en silencio: la fila
    // sigue intacta hasta que yo lo arregle.
    const fila = leerFila(id);
    assert.equal(fila.metodo_pago, 'EFECTIVO');
    assert.equal(fila.estado, 'incompleto');
});

test('PUT: total vacío (null) deja la fila sin clave pero PROCESADA; un 0 sí da clave', async () => {
    const sinImporte = crearTicket({ estado: 'procesado' });
    await pedir('PUT', `/api/tickets/${sinImporte.id}`, cuerpoEdicion({ total_centimos: null }));
    const filaSin = leerFila(sinImporte.id);
    // No se guarda un 0: NULL y 0 siguen siendo cosas distintas en la columna.
    assert.equal(filaSin.total_centimos, null);
    // Pero un importe ausente ya no deja la fila incompleta.
    assert.equal(filaSin.estado, 'procesado');
    assert.equal(filaSin.sin_importe, 1, 'queda marcada sola');
    // Sin importe no hay clave: no se puede afirmar que dos documentos sin
    // importe sean el mismo.
    assert.equal(filaSin.clave_tiquet, null);

    const importeCero = crearTicket({ estado: 'incompleto' });
    await pedir('PUT', `/api/tickets/${importeCero.id}`, cuerpoEdicion({ total_centimos: 0 }));
    const filaCero = leerFila(importeCero.id);
    assert.equal(filaCero.total_centimos, 0);
    assert.equal(filaCero.estado, 'procesado');
    assert.ok(filaCero.clave_tiquet.endsWith('|0'));
});

test('PUT: cambiar el nombre del establecimiento reasigna y limpia el huérfano', async () => {
    const viejoId = crearEstablecimiento('MERCADONA');
    const { id } = crearTicket({ establecimiento_id: viejoId, estado: 'incompleto' });

    await pedir('PUT', `/api/tickets/${id}`, cuerpoEdicion({
        establecimiento: { nombre: 'CONDIS', direccion: 'CALLE NUEVA 3', ciudad: 'BARCELONA', codigo_postal: '08002' }
    }));

    const fila = leerFila(id);
    assert.notEqual(fila.establecimiento_id, viejoId);

    const nuevo = db.prepare('SELECT * FROM establecimientos WHERE id = ?').get(fila.establecimiento_id);
    assert.equal(nuevo.nombre, 'CONDIS');
    // La edición manual SÍ sobrescribe la dirección (upsertEstablecimiento no lo
    // hace, pero ese cuidado es para protegerse del modelo, no de mí).
    assert.equal(nuevo.direccion, 'Calle Nueva 3');

    // MERCADONA se ha quedado sin tiquets y desaparece.
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM establecimientos WHERE id = ?').get(viejoId).n, 0);
});

test('PUT: 404 si el id no existe, 400 si no es un número', async () => {
    assert.equal((await pedir('PUT', '/api/tickets/999999', cuerpoEdicion())).status, 404);
    assert.equal((await pedir('PUT', '/api/tickets/abc', cuerpoEdicion())).status, 400);
});

// =============================================================================
// DELETE /api/tickets/:id
// =============================================================================

test('DELETE: borra la fila, la imagen del disco y el establecimiento huérfano', async () => {
    const estId = crearEstablecimiento('SABA PARKING');
    const { id, archivo } = crearTicket({ establecimiento_id: estId, estado: 'procesado' });
    const enDisco = path.join(UPLOADS_DIR, archivo);
    assert.ok(fs.existsSync(enDisco), 'la imagen tiene que existir antes de borrar');

    const { status, datos } = await pedir('DELETE', `/api/tickets/${id}`);

    assert.equal(status, 200);
    assert.equal(datos.resultado, 'borrado');
    assert.equal(datos.imagen_borrada, true);
    assert.equal(datos.establecimiento_borrado, estId);

    assert.equal(leerFila(id), undefined);
    assert.equal(fs.existsSync(enDisco), false, 'la foto tiene que haber desaparecido');
    assert.equal(contarEstablecimientos(), 0);
});

test('DELETE: un establecimiento con otros tiquets NO se borra', async () => {
    const estId = crearEstablecimiento('MERCADONA');
    const a = crearTicket({ establecimiento_id: estId });
    const b = crearTicket({ establecimiento_id: estId });

    const { datos } = await pedir('DELETE', `/api/tickets/${a.id}`);

    assert.equal(datos.establecimiento_borrado, null);
    assert.equal(contarEstablecimientos(), 1);
    assert.ok(leerFila(b.id), 'el otro tiquet sigue ahí');
});

test('DELETE: la fila se borra aunque la foto ya no esté en el disco', async () => {
    const { id, archivo } = crearTicket({});
    fs.unlinkSync(path.join(UPLOADS_DIR, archivo));   // la foto desaparece por su cuenta

    const { status, datos } = await pedir('DELETE', `/api/tickets/${id}`);

    assert.equal(status, 200);
    assert.equal(datos.imagen_borrada, false);
    assert.equal(leerFila(id), undefined);
});

test('DELETE: 404 si el id no existe', async () => {
    const { status, datos } = await pedir('DELETE', '/api/tickets/999999');
    assert.equal(status, 404);
    assert.match(datos.error, /No existe/);
});

// =============================================================================
// POST /api/tickets/:id/reintentar
// =============================================================================

/** Lo que devolvería la IA en una lectura buena. */
const LECTURA_OK = {
    tipo_documento: 'PARKING',
    categoria: 'TRANSPORTE',
    nombre_establecimiento: 'SABA PARKING',
    direccion: 'AVINGUDA DIAGONAL 3',
    ciudad: 'BARCELONA',
    codigo_postal: '08019',
    fecha_compra: '2026-01-10 17:27:00',
    total_centimos: 250,
    moneda: 'EUR',
    metodo_pago: 'TARJETA ****6158',
    items: [],
    detalles: [{ clave: 'Matrícula', valor: '9180KGJ' }]
};

test('POST reintentar: una fila ya procesada necesita forzar', async () => {
    const { id } = crearTicket({
        tipo_documento: 'COMPRA',
        total_centimos: 1234,
        fecha_compra: '2026-01-10',
        estado: 'procesado'
    });

    const { status, datos } = await pedir('POST', `/api/tickets/${id}/reintentar`);

    assert.equal(status, 409);
    assert.equal(datos.resultado, 'no_reintentable');
    assert.match(datos.error, /'procesado'/);
    assert.match(datos.error, /forzar/);
    // No se ha llamado a la IA: releer algo por descuido es gastar cuota.
    assert.equal(IA.llamadas, 0);
});

test('POST reintentar con forzar: relee una fila procesada y sustituye los datos', async () => {
    // Para releer tiquets antiguos con un prompt nuevo (el lugar deducido) o
    // para comparar modelos. Lo que se pierde son las correcciones manuales, y
    // por eso hay que pedirlo a propósito.
    const { id } = crearTicket({
        tipo_documento: 'COMPRA', categoria: 'ALIMENTACION',
        total_centimos: 1234, fecha_compra: '2026-01-10',
        estado: 'procesado', modelo_usado: 'gemini-viejo'
    });

    IA.modelo = 'gemini-nuevo';
    IA.responder = async () => [{
        indice_en_foto: 0,
        tipo_documento: 'PARKING', categoria: 'TRANSPORTE',
        nombre_establecimiento: 'PATRONAT DE LA MUNTANYA DE MONTSERRAT',
        lugar_inferido: 'MONTSERRAT',
        fecha_compra: '2026-01-10 11:30:00',
        total_centimos: 540, moneda: 'EUR', items: [], detalles: []
    }];

    const { status, datos } = await pedir('POST', `/api/tickets/${id}/reintentar`, { forzar: true });

    assert.equal(status, 200);
    assert.equal(IA.llamadas, 1);

    const fila = leerFila(id);
    assert.equal(fila.tipo_documento, 'PARKING');
    assert.equal(fila.total_centimos, 540);
    // El modelo del análisis NUEVO, que es lo que permite comparar.
    assert.equal(fila.modelo_usado, 'gemini-nuevo');
    assert.equal(datos.modelo_usado, 'gemini-nuevo');

    // Y el lugar deducido llega al establecimiento, que es para lo que sirve
    // releer lo antiguo.
    const est = db.prepare('SELECT lugar_inferido FROM establecimientos WHERE id = ?')
                  .get(fila.establecimiento_id);
    assert.equal(est.lugar_inferido, 'Montserrat');
});

test('POST reintentar: tampoco sobre una fila incompleta (eso se edita, no se reintenta)', async () => {
    const { id } = crearTicket({ estado: 'incompleto' });
    const { status, datos } = await pedir('POST', `/api/tickets/${id}/reintentar`);
    assert.equal(status, 409);
    assert.equal(datos.resultado, 'no_reintentable');
    assert.equal(IA.llamadas, 0);
});

test('POST reintentar: una fila pendiente se reprocesa y queda procesada', async () => {
    const { id } = crearTicket({ estado: 'pendiente' });
    IA.responder = async () => LECTURA_OK;

    const { status, datos } = await pedir('POST', `/api/tickets/${id}/reintentar`);

    assert.equal(status, 200);
    assert.equal(datos.resultado, 'reintentado');
    assert.equal(datos.estado_anterior, 'pendiente');
    assert.equal(datos.estado, 'procesado');
    assert.equal(IA.llamadas, 1);

    const fila = leerFila(id);
    assert.equal(fila.estado, 'procesado');
    assert.equal(fila.total_centimos, 250);
    assert.equal(fila.fecha_compra, '2026-01-10 17:27:00');
    assert.equal(fila.hora_conocida, 1);
    assert.ok(fila.clave_tiquet.endsWith('|2026-01-10 17:27:00|250'));
    // El establecimiento se ha creado y la clave de detalle se ha normalizado,
    // igual que en una subida normal.
    assert.equal(
        db.prepare('SELECT nombre FROM establecimientos WHERE id = ?').get(fila.establecimiento_id).nombre,
        'SABA PARKING'
    );
    assert.deepEqual(JSON.parse(fila.detalles), { matricula: '9180KGJ' });
});

test('POST reintentar: un fallo transitorio conserva la imagen y devuelve el motivo real', async () => {
    const { id, archivo } = crearTicket({ estado: 'pendiente' });
    IA.responder = async () => {
        throw new ErrorIAFalso({
            tipo: 'transitorio', status: 503,
            mensaje: 'El modelo de Gemini está saturado ahora mismo.'
        });
    };

    const { status, datos } = await pedir('POST', `/api/tickets/${id}/reintentar`);

    assert.equal(status, 503);
    assert.equal(datos.resultado, 'fallo');
    assert.equal(datos.tipo, 'transitorio');
    assert.equal(datos.status_api, 503);
    assert.match(datos.error, /saturado/);
    assert.equal(datos.estado, 'pendiente');

    assert.equal(leerFila(id).estado, 'pendiente');
    assert.ok(fs.existsSync(path.join(UPLOADS_DIR, archivo)), 'la foto no se toca en un fallo');
});

test('POST reintentar: un fallo permanente deja la fila en error y NO borra la foto', async () => {
    // En una subida un fallo permanente borra el archivo, porque no hay fila que
    // lo referencie. En un reintento sí la hay: borrarlo dejaría el tiquet roto.
    const { id, archivo } = crearTicket({ estado: 'pendiente' });
    IA.responder = async () => {
        throw new ErrorIAFalso({ tipo: 'permanente', status: null, mensaje: 'Fallo irrecuperable.' });
    };

    const { status, datos } = await pedir('POST', `/api/tickets/${id}/reintentar`);

    assert.equal(status, 500);
    assert.equal(datos.estado, 'error');
    assert.equal(leerFila(id).estado, 'error');
    assert.ok(fs.existsSync(path.join(UPLOADS_DIR, archivo)));
});

test('POST reintentar: si la lectura choca con otro tiquet, guarda los datos con aviso y sin clave', async () => {
    const estId = crearEstablecimiento('SABA PARKING');
    const existente = crearTicket({
        establecimiento_id: estId,
        fecha_compra: '2026-01-10 17:27:00',
        total_centimos: 250,
        clave_tiquet: `${estId}|2026-01-10 17:27:00|250`,
        hora_conocida: 1,
        estado: 'procesado'
    });
    const { id } = crearTicket({ estado: 'pendiente' });

    IA.responder = async () => LECTURA_OK;   // misma identidad que `existente`

    const { status, datos } = await pedir('POST', `/api/tickets/${id}/reintentar`);

    assert.equal(status, 200);
    assert.equal(datos.resultado, 'reintentado_con_aviso');
    assert.equal(datos.id_colision, existente.id);

    const fila = leerFila(id);
    // Los datos se conservan (la llamada a la API ya está pagada)...
    assert.equal(fila.total_centimos, 250);
    // ...pero sin clave, para no violar el índice único, y marcada para revisar.
    assert.equal(fila.clave_tiquet, null);
    assert.equal(fila.estado, 'incompleto');
});

test('POST reintentar: 409 claro si la imagen ya no está en el disco', async () => {
    const { id, archivo } = crearTicket({ estado: 'pendiente' });
    fs.unlinkSync(path.join(UPLOADS_DIR, archivo));

    const { status, datos } = await pedir('POST', `/api/tickets/${id}/reintentar`);

    assert.equal(status, 409);
    assert.equal(datos.resultado, 'sin_imagen');
    assert.match(datos.error, /no está en el disco/);
    assert.equal(IA.llamadas, 0);
});

test('POST reintentar: 404 si el id no existe', async () => {
    const { status } = await pedir('POST', '/api/tickets/999999/reintentar');
    assert.equal(status, 404);
});

// =============================================================================
// GET /api/tickets/:id
// =============================================================================

test('GET /:id devuelve la fila con items y detalles ya parseados', async () => {
    const estId = crearEstablecimiento('MERCADONA', { ciudad: 'Barcelona' });
    const { id } = crearTicket({
        establecimiento_id: estId,
        items: JSON.stringify([{ producto: 'PLATANO', cantidad: 1, precio_centimos: 149 }]),
        detalles: JSON.stringify({ matricula: '9180KGJ' })
    });

    const { status, datos } = await pedir('GET', `/api/tickets/${id}`);

    assert.equal(status, 200);
    assert.equal(datos.establecimiento_nombre, 'MERCADONA');
    assert.equal(datos.items[0].producto, 'PLATANO');
    assert.deepEqual(datos.detalles, { matricula: '9180KGJ' });
});

test('GET /:id devuelve 404 si no existe', async () => {
    assert.equal((await pedir('GET', '/api/tickets/999999')).status, 404);
});

// =============================================================================
// AUSENCIAS CONFIRMADAS A MANO (sin_importe / sin_fecha)
// =============================================================================
// El caso real: la ENTRADA de un parking se paga a la salida, así que el papel no
// lleva importe. Antes esas filas se quedaban en 'incompleto' para siempre y, con
// un tercio de la lista en ámbar permanente, el ámbar dejaba de avisar de nada.

test('confirmar que no hay importe: la fila pasa a procesada con el total a NULL', async () => {
    const { id } = crearTicket({
        tipo_documento: 'PARKING',
        fecha_compra: '2026-01-10 17:27:00',
        total_centimos: null,
        hora_conocida: 1,
        estado: 'incompleto'
    });

    const { status, datos } = await pedir('PUT', `/api/tickets/${id}`, cuerpoEdicion({
        tipo_documento: 'PARKING',
        establecimiento: { nombre: 'SABA PARKING' },
        fecha_compra: '2026-01-10 17:27:00',
        total_centimos: null,
        sin_importe: true
    }));

    assert.equal(status, 200);
    assert.equal(datos.estado, 'procesado');

    const fila = leerFila(id);
    assert.equal(fila.estado, 'procesado');
    // Lo importante: NO se ha inventado un 0.
    assert.equal(fila.total_centimos, null);
    assert.equal(fila.sin_importe, 1);
    assert.equal(fila.sin_fecha, 0);
    // Y sigue sin clave: sin importe no hay con qué comparar duplicados.
    assert.equal(fila.clave_tiquet, null);
});

test('confirmar que no hay fecha: procesada, fecha a NULL y sin clave', async () => {
    const { id } = crearTicket({ estado: 'incompleto' });

    const { datos } = await pedir('PUT', `/api/tickets/${id}`, cuerpoEdicion({
        tipo_documento: 'BILLETE TREN',
        establecimiento: { nombre: 'RENFE' },
        fecha_compra: null,
        total_centimos: 1250,
        sin_fecha: true
    }));

    assert.equal(datos.estado, 'procesado');
    const fila = leerFila(id);
    assert.equal(fila.fecha_compra, null);
    assert.equal(fila.sin_fecha, 1);
    assert.equal(fila.hora_conocida, 0);
    assert.equal(fila.clave_tiquet, null, 'sin fecha tampoco hay clave');
});

test('confirmar las dos ausencias a la vez también deja la fila procesada', async () => {
    const { id } = crearTicket({ estado: 'incompleto' });

    const { datos } = await pedir('PUT', `/api/tickets/${id}`, cuerpoEdicion({
        fecha_compra: null,
        total_centimos: null,
        sin_importe: true,
        sin_fecha: true
    }));

    assert.equal(datos.estado, 'procesado');
    const fila = leerFila(id);
    assert.equal(fila.sin_importe, 1);
    assert.equal(fila.sin_fecha, 1);
    assert.equal(fila.total_centimos, null);
    assert.equal(fila.fecha_compra, null);
});

test('si hay importe, manda el importe: la bandera se limpia', async () => {
    // Marcar "no imprime importe" y escribir 39,49 son afirmaciones
    // contradictorias. Haber escrito el importe es la prueba de que el papel lo
    // lleva, así que la bandera no se guarda. El invariante no se puede romper ni
    // con un curl a mano.
    const { id } = crearTicket({ estado: 'incompleto' });

    const { datos } = await pedir('PUT', `/api/tickets/${id}`, cuerpoEdicion({
        total_centimos: 3949,
        sin_importe: true
    }));

    assert.equal(datos.estado, 'procesado');
    const fila = leerFila(id);
    assert.equal(fila.total_centimos, 3949);
    assert.equal(fila.sin_importe, 0);
    // Y con importe y fecha SÍ hay clave.
    assert.ok(fila.clave_tiquet.endsWith('|3949'));
});

test('lo mismo con la fecha: si hay fecha, sin_fecha no se guarda', async () => {
    const { id } = crearTicket({ estado: 'incompleto' });

    await pedir('PUT', `/api/tickets/${id}`, cuerpoEdicion({
        fecha_compra: '2026-03-05',
        sin_fecha: true
    }));

    const fila = leerFila(id);
    assert.equal(fila.fecha_compra, '2026-03-05');
    assert.equal(fila.sin_fecha, 0);
});

test('un total ausente marca sin_importe solo, sin que nadie confirme nada', async () => {
    const { id } = crearTicket({ estado: 'procesado' });

    const { datos } = await pedir('PUT', `/api/tickets/${id}`, cuerpoEdicion({
        total_centimos: null
        // sin_importe ni se manda: la bandera es derivada, no una casilla.
    }));

    assert.equal(datos.estado, 'procesado');
    assert.equal(leerFila(id).sin_importe, 1);
});

test('desmarcar la casilla ya no cambia nada: manda el importe, no la casilla', async () => {
    // Antes la casilla decidía el estado de la fila, así que desmarcarla la
    // devolvía a ámbar. Ahora sin_importe es un hecho que se lee en
    // total_centimos: mientras no haya importe, la bandera sigue puesta.
    const { id } = crearTicket({
        total_centimos: null,
        sin_importe: 1,
        fecha_compra: '2026-01-10',
        estado: 'procesado'
    });

    const { datos } = await pedir('PUT', `/api/tickets/${id}`, cuerpoEdicion({
        fecha_compra: '2026-01-10',
        total_centimos: null,
        sin_importe: false
    }));

    assert.equal(datos.estado, 'procesado');
    assert.equal(leerFila(id).sin_importe, 1);
});

test('escribir un importe limpia la marca: el invariante de siempre', async () => {
    const { id } = crearTicket({
        total_centimos: null, sin_importe: 1, fecha_compra: '2026-01-10', estado: 'procesado'
    });

    await pedir('PUT', `/api/tickets/${id}`, cuerpoEdicion({
        fecha_compra: '2026-01-10',
        total_centimos: 1250
    }));

    const fila = leerFila(id);
    assert.equal(fila.total_centimos, 1250);
    assert.equal(fila.sin_importe, 0);
    assert.equal(fila.estado, 'procesado');
});

test('un reintento recalcula las banderas: no arrastra una confirmación vieja', async () => {
    // sin_fecha solo lo puede afirmar una persona, así que una extracción nueva
    // lo devuelve a 0. sin_importe, en cambio, se recalcula del dato: la lectura
    // nueva tampoco trae total, así que se queda a 1.
    const { id } = crearTicket({ estado: 'pendiente', sin_importe: 0, sin_fecha: 1 });
    IA.responder = async () => ({
        tipo_documento: 'PARKING',
        nombre_establecimiento: 'SABA PARKING',
        fecha_compra: '2026-01-10 17:27:00',
        total_centimos: null,
        moneda: 'EUR',
        items: [],
        detalles: []
    });

    await pedir('POST', `/api/tickets/${id}/reintentar`);

    const fila = leerFila(id);
    assert.equal(fila.sin_importe, 1, 'la lectura nueva tampoco trae importe');
    assert.equal(fila.sin_fecha, 0, 'la confirmación de fecha NO se hereda');
    // Con fecha y sin importe, la fila está completa con el criterio actual.
    assert.equal(fila.estado, 'procesado');
});

// =============================================================================
// COORDENADAS A MANO DESDE EL EDITOR
// =============================================================================

/** El establecimiento al que apunta un tiquet, tal y como está en la base. */
const establecimientoDe = (id) => db.prepare(`
    SELECT e.* FROM establecimientos e
    JOIN tickets t ON t.establecimiento_id = e.id
    WHERE t.id = ?
`).get(id);

test('PUT con coordenadas pegadas: se guardan con precisión manual', async () => {
    const { id } = crearTicket({ estado: 'procesado' });

    const { status } = await pedir('PUT', `/api/tickets/${id}`, cuerpoEdicion({
        establecimiento: {
            nombre: 'MERCADONA', direccion: 'CALLE MAYOR 12',
            ciudad: 'BARCELONA', codigo_postal: '08001',
            coordenadas: '41.0123, 0.9876'
        }
    }));

    assert.equal(status, 200);
    const est = establecimientoDe(id);
    assert.equal(est.latitud, 41.0123);
    assert.equal(est.longitud, 0.9876);
    assert.equal(est.geo_precision, 'manual');
    assert.equal(est.geo_estado, 'ok');
});

test('PUT con coordenadas en formato español también vale', async () => {
    const { id } = crearTicket({ estado: 'procesado' });

    await pedir('PUT', `/api/tickets/${id}`, cuerpoEdicion({
        establecimiento: { nombre: 'MERCADONA', coordenadas: '41,0123; 0,9876' }
    }));

    assert.equal(establecimientoDe(id).latitud, 41.0123);
});

test('unas coordenadas que no se entienden rechazan la edición entera', async () => {
    // En una edición manual nada se descarta en silencio: un punto mal pegado
    // colocaría el comercio en medio del mar sin que nadie se enterase.
    const { id } = crearTicket({ estado: 'procesado', total_centimos: 1000 });

    const { status, datos } = await pedir('PUT', `/api/tickets/${id}`, cuerpoEdicion({
        total_centimos: 2000,
        establecimiento: { nombre: 'MERCADONA', coordenadas: '41.0123' }
    }));

    assert.equal(status, 422);
    assert.match(datos.error, /coordenadas/i);
    assert.equal(datos.descartados[0].campo, 'coordenadas');
    // Y no se ha guardado nada del resto de la edición.
    assert.equal(leerFila(id).total_centimos, 1000);
});

test('una longitud fuera de rango también se rechaza', async () => {
    const { id } = crearTicket({ estado: 'procesado' });
    const { status } = await pedir('PUT', `/api/tickets/${id}`, cuerpoEdicion({
        establecimiento: { nombre: 'MERCADONA', coordenadas: '41.0123, 999' }
    }));
    assert.equal(status, 422);
});

test('cambiar la dirección no borra unas coordenadas puestas a mano', async () => {
    const { id } = crearTicket({ estado: 'procesado' });
    await pedir('PUT', `/api/tickets/${id}`, cuerpoEdicion({
        establecimiento: { nombre: 'MERCADONA', direccion: 'CALLE MAYOR 12', coordenadas: '41.0123, 0.9876' }
    }));

    // Otra edición, con la dirección cambiada y SIN tocar las coordenadas.
    await pedir('PUT', `/api/tickets/${id}`, cuerpoEdicion({
        establecimiento: { nombre: 'MERCADONA', direccion: 'AVENIDA DIAGONAL 500' }
    }));

    const est = establecimientoDe(id);
    assert.equal(est.direccion, 'Avenida Diagonal 500', 'la dirección sí cambia');
    assert.equal(est.latitud, 41.0123, 'el punto se queda');
    assert.equal(est.geo_precision, 'manual');
    assert.equal(est.geo_estado, 'ok');
});

test('vaciar el campo devuelve el establecimiento a la geocodificación automática', async () => {
    const { id } = crearTicket({ estado: 'procesado' });
    await pedir('PUT', `/api/tickets/${id}`, cuerpoEdicion({
        establecimiento: { nombre: 'MERCADONA', coordenadas: '41.0123, 0.9876' }
    }));

    await pedir('PUT', `/api/tickets/${id}`, cuerpoEdicion({
        establecimiento: { nombre: 'MERCADONA', coordenadas: '' }
    }));

    const est = establecimientoDe(id);
    assert.equal(est.latitud, null);
    assert.equal(est.geo_precision, null);
    assert.equal(est.geo_estado, 'pendiente');
});

test('no mandar el campo no toca las coordenadas', async () => {
    const { id } = crearTicket({ estado: 'procesado' });
    await pedir('PUT', `/api/tickets/${id}`, cuerpoEdicion({
        establecimiento: { nombre: 'MERCADONA', coordenadas: '41.0123, 0.9876' }
    }));

    // cuerpoEdicion() normal: no lleva el campo coordenadas.
    await pedir('PUT', `/api/tickets/${id}`, cuerpoEdicion());

    assert.equal(establecimientoDe(id).latitud, 41.0123);
});
