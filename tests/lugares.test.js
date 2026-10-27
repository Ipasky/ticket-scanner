/**
 * Google Places SIMULADO: qué se verifica solo, qué se pregunta, y que al
 * coincidir el place_id dos establecimientos se unen sin perder tiquets.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-scanner-lugares-'));
process.env.TICKETS_DB_PATH = path.join(TMP, 'lugares.db');

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/config/db.js');
const { crearLugares, decidir, nombreCoincide } = require('../src/services/lugares.js');
const { buscarExistente } = require('../src/services/establecimientos.js');

const sitio = (id, nombre, direccion, cp, ciudad, lat = 41.72, lon = 1.82) => ({
    id, displayName: { text: nombre }, formattedAddress: `${direccion}, ${cp} ${ciudad}, Barcelona, España`,
    location: { latitude: lat, longitude: lon },
    addressComponents: [
        { longText: cp, types: ['postal_code'] },
        { longText: ciudad, types: ['locality'] },
        { longText: 'España', types: ['country'] }
    ]
});

function servicio(respuestas) {
    const pedidas = [];
    const lugares = crearLugares({
        config: { clave: 'x', activa: true },
        dormir: async () => {},
        hacerPeticion: async (url, op) => {
            pedidas.push(JSON.parse(op.body || '{}').textQuery);
            const places = respuestas.shift() || [];
            return { ok: true, status: 200, json: async () => ({ places }) };
        }
    });
    return { lugares, pedidas };
}

const crearEst = (nombre, extra = {}) => Number(db.prepare(
    `INSERT INTO establecimientos (nombre, direccion, ciudad, codigo_postal, lugar_inferido)
     VALUES (@nombre, @direccion, @ciudad, @codigo_postal, @lugar_inferido)`
).run({ nombre, direccion: null, ciudad: null, codigo_postal: null, lugar_inferido: null, ...extra }).lastInsertRowid);
const crearTicket = (est, fecha, total) => db.prepare(
    `INSERT INTO tickets (establecimiento_id, fecha_compra, total_centimos, clave_tiquet, hora_conocida, estado)
     VALUES (?, ?, ?, ?, 1, 'procesado')`
).run(est, fecha, total, `${est}|${fecha}|${total}`);
const est = (id) => db.prepare('SELECT * FROM establecimientos WHERE id = ?').get(id);

test('el nombre casa con la razón social y con variantes', () => {
    assert.ok(nombreCoincide('ABACUS SCCL', 'Abacus Terrassa'));
    assert.ok(nombreCoincide('MERCADONA', 'Mercadona'));
    assert.ok(!nombreCoincide('MERCADONA', 'Lidl'));
});

test('un candidato claro se verifica: nombre, dirección y punto de Google', async () => {
    const id = crearEst('ABACUS SCCL', { ciudad: 'Terrassa' });
    const { lugares } = servicio([[sitio('p-abacus', 'Abacus Terrassa', 'Carrer Major, 33', '08221', 'Terrassa')]]);
    const r = await lugares.procesarUno(id);
    assert.equal(r.resultado, 'verificado');
    const e = est(id);
    assert.equal(e.place_id, 'p-abacus');
    assert.equal(e.nombre, 'ABACUS TERRASSA');
    assert.equal(e.direccion, 'Carrer Major, 33');
    assert.equal(e.codigo_postal, '08221');
    assert.equal(e.geo_precision, 'google');
    // El nombre del tiquet queda como alias: el siguiente va directo.
    assert.equal(buscarExistente('ABACUS SCCL', { ciudad: 'Terrassa' }).id, id);
});

test('varios plausibles sin forma de elegir: por confirmar, y elegir a mano verifica', async () => {
    const id = crearEst('PARKING SABA', { ciudad: 'Barcelona' });
    const { lugares } = servicio([[
        sitio('p-saba1', 'Parking Saba Sants', 'Carrer de Sants, 1', '08014', 'Barcelona'),
        sitio('p-saba2', 'Parking Saba Diagonal', 'Avinguda Diagonal, 2', '08019', 'Barcelona')
    ]]);
    assert.equal((await lugares.procesarUno(id)).resultado, 'por_confirmar');
    assert.equal(JSON.parse(est(id).google_candidatos).length, 2);
    assert.equal(lugares.elegir(id, 'p-saba2'), id);
    assert.equal(est(id).place_id, 'p-saba2');
    assert.equal(est(id).google_estado, 'verificado');
});

test('mismo place_id que otro: se unen sin perder tiquets, y choque de clave sin borrar', async () => {
    const a = crearEst('BAR PEPE', { ciudad: 'Terrassa' });
    const { lugares: l1 } = servicio([[sitio('p-pepe', 'Bar Pepe', 'Carrer Major, 5', '08221', 'Terrassa')]]);
    await l1.procesarUno(a);
    const b = crearEst('BAR PEPE SL', { ciudad: 'Terrassa', direccion: 'Carrer Major 5' });
    crearTicket(a, '2026-03-01 10:00:00', 500);
    crearTicket(b, '2026-03-01 10:00:00', 500);   // el mismo tiquet, duplicado
    crearTicket(b, '2026-03-02 10:00:00', 700);
    const { lugares: l2 } = servicio([[sitio('p-pepe', 'Bar Pepe', 'Carrer Major, 5', '08221', 'Terrassa')]]);
    const r = await l2.procesarUno(b);
    assert.equal(r.resultado, 'unido');
    assert.equal(est(b), undefined);
    const n = db.prepare('SELECT COUNT(*) AS n FROM tickets WHERE establecimiento_id = ?').get(a).n;
    assert.equal(n, 3, 'ningún tiquet se pierde');
});

test('coordenadas a mano: nunca se verifica solo', () => {
    const d = decidir({ nombre: 'X', ciudad: 'Terrassa', geo_precision: 'manual' },
        [{ nombre: 'X', direccion_completa: 'Terrassa', cerrado: false }]);
    assert.equal(d.accion, 'confirmar');
});

test('mismo nombre en otra ciudad es otro establecimiento', () => {
    const m1 = crearEst('MERCADONA', { ciudad: 'Terrassa' });
    assert.equal(buscarExistente('MERCADONA', { ciudad: 'Terrassa' }).id, m1);
    assert.equal(buscarExistente('MERCADONA', { ciudad: 'Girona' }), null);
    assert.equal(buscarExistente('MERCADONA', {}).id, m1);
});
