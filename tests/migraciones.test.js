/**
 * Migraciones desde la versión 5: el cambio de criterio de "sin importe"
 * aplicado a lo ya guardado (5 → 6) y la precisión de la geocodificación
 * (6 → 7).
 *
 * Sin esto, el historial viejo seguiría en ámbar para siempre mientras el nuevo
 * no, y el mismo color significaría dos cosas distintas según la fecha de
 * subida. Lo que se comprueba es lo de siempre en una migración: que lo que
 * tiene que cambiar cambia, y —más importante— que lo que NO tiene que cambiar
 * se queda como estaba.
 *
 * Se fabrica a mano una base con el esquema de la versión 5 y se deja que
 * config/db.js la migre al cargarse. Escribir aquí el esquema viejo es parte de
 * la prueba: es lo que fija qué forma tenía la base antes.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-scanner-mig-'));
const RUTA = path.join(TMP, 'v5.db');

// --- LA BASE TAL Y COMO ERA EN LA VERSIÓN 5 ---------------------------------
// establecimientos SIN las columnas geo_*, y tickets con todo lo de entonces.
const ESQUEMA_V5 = `
    CREATE TABLE establecimientos (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        nombre          TEXT    NOT NULL UNIQUE,
        direccion       TEXT,
        ciudad          TEXT,
        codigo_postal   TEXT,
        latitud         REAL,
        longitud        REAL,
        created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE tickets (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        tipo_documento      TEXT,
        categoria           TEXT,
        establecimiento_id  INTEGER REFERENCES establecimientos(id),
        fecha_compra        TEXT,
        fecha_evento        TEXT,
        total_centimos      INTEGER,
        moneda              TEXT    DEFAULT 'EUR',
        metodo_pago         TEXT,
        items               TEXT,
        detalles            TEXT,
        ruta_imagen         TEXT,
        hash_imagen         TEXT,
        indice_en_foto      INTEGER DEFAULT 0,
        total_en_foto       INTEGER DEFAULT 1,
        recuadro            TEXT,
        clave_tiquet        TEXT,
        hora_conocida       INTEGER NOT NULL DEFAULT 0,
        sin_importe         INTEGER NOT NULL DEFAULT 0,
        sin_fecha           INTEGER NOT NULL DEFAULT 0,
        estado              TEXT    NOT NULL DEFAULT 'procesado',
        modelo_usado        TEXT,
        created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at          DATETIME DEFAULT CURRENT_TIMESTAMP
    );
`;

const FILAS = [
    // 1. Con importe y fecha: no se toca NADA de esta.
    { nota: 'con importe', total_centimos: 3949, fecha_compra: '2026-01-10 13:25:12',
      estado: 'procesado', sin_importe: 0, sin_fecha: 0, total_en_foto: 1 },

    // 2. El caso del cambio: sin importe, con fecha, en ámbar por eso mismo.
    { nota: 'sin importe con fecha', total_centimos: null, fecha_compra: '2026-01-11 09:00:00',
      estado: 'incompleto', sin_importe: 0, sin_fecha: 0, total_en_foto: 1 },

    // 3. Sin importe Y sin fecha: la fecha sigue mandando, se queda incompleta.
    { nota: 'sin importe ni fecha', total_centimos: null, fecha_compra: null,
      estado: 'incompleto', sin_importe: 0, sin_fecha: 0, total_en_foto: 1 },

    // 4. Sin importe, sin fecha pero con la ausencia de fecha confirmada a mano.
    { nota: 'sin fecha confirmada', total_centimos: null, fecha_compra: null,
      estado: 'incompleto', sin_importe: 0, sin_fecha: 1, total_en_foto: 1 },

    // 5. De una foto con varios tiquets: se revisa siempre, por diseño.
    { nota: 'foto multiple', total_centimos: null, fecha_compra: '2026-01-12 10:00:00',
      estado: 'incompleto', sin_importe: 0, sin_fecha: 0, total_en_foto: 3 },

    // 6. Ya estaba confirmada con la casilla vieja: tiene que seguir igual.
    { nota: 'ya confirmada', total_centimos: null, fecha_compra: '2026-01-13 10:00:00',
      estado: 'procesado', sin_importe: 1, sin_fecha: 0, total_en_foto: 1 },

    // 7. Sin leer: no es un documento sin importe, es una foto sin procesar.
    { nota: 'pendiente', total_centimos: null, fecha_compra: null,
      estado: 'pendiente', sin_importe: 0, sin_fecha: 0, total_en_foto: 1 },

    // 8. Igual, pero en error.
    { nota: 'error', total_centimos: null, fecha_compra: null,
      estado: 'error', sin_importe: 0, sin_fecha: 0, total_en_foto: 1 },

    // 9. Importe CERO impreso: tiene importe, así que no se toca.
    { nota: 'cero impreso', total_centimos: 0, fecha_compra: '2026-01-14 10:00:00',
      estado: 'procesado', sin_importe: 0, sin_fecha: 0, total_en_foto: 1 }
];

(function construirBaseV5() {
    const vieja = new Database(RUTA);
    vieja.exec(ESQUEMA_V5);
    vieja.prepare(`INSERT INTO establecimientos (nombre, direccion, ciudad) VALUES (?, ?, ?)`)
         .run('MERCADONA', 'Carrer de Sants 100', 'Barcelona');
    // Uno que ya tenía coordenadas puestas a mano.
    vieja.prepare(`INSERT INTO establecimientos (nombre, latitud, longitud) VALUES (?, ?, ?)`)
         .run('YA SITUADO', 41.0, 2.0);

    const insertar = vieja.prepare(`
        INSERT INTO tickets (
            tipo_documento, categoria, establecimiento_id, fecha_compra,
            total_centimos, moneda, items, detalles, ruta_imagen, hash_imagen,
            indice_en_foto, total_en_foto, hora_conocida, sin_importe, sin_fecha, estado
        ) VALUES (
            'COMPRA', 'ALIMENTACION', 1, @fecha_compra,
            @total_centimos, 'EUR', '[]', '{}', '/uploads/x.jpg', @hash,
            0, @total_en_foto, 0, @sin_importe, @sin_fecha, @estado
        )
    `);
    FILAS.forEach((f, i) => insertar.run({ ...f, hash: `hash-${i}` }));

    vieja.pragma('user_version = 5');
    vieja.close();
})();

process.env.TICKETS_DB_PATH = RUTA;

const test = require('node:test');
const assert = require('node:assert/strict');

// Al requerir esto se aplica la migración.
const db = require('../src/config/db.js');

const porNota = new Map(FILAS.map((f, i) => [f.nota, i + 1]));
const fila = (nota) => db.prepare('SELECT * FROM tickets WHERE id = ?').get(porNota.get(nota));

test.after(() => {
    db.close();
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

// =============================================================================
// LA MIGRACIÓN SE APLICA
// =============================================================================

test('la base queda en la última versión, encadenando todos los pasos', () => {
    // La versión concreta no se clava aquí a propósito: lo que importa es que una
    // base vieja acabe EXACTAMENTE donde dice el código, pasando por todos los
    // escalones. Clavar el número obliga a tocar esta prueba en cada migración
    // sin comprobar nada más.
    assert.equal(db.pragma('user_version', { simple: true }), db.SCHEMA_VERSION);
});

test('la columna del lugar deducido existe tras migrar', () => {
    // Es la migración 7 -> 8, y sin ella un establecimiento sin dirección no
    // tendría dónde guardar el lugar que se deduce del documento.
    const columnas = db.pragma('table_info(establecimientos)').map(c => c.name);
    assert.ok(columnas.includes('lugar_inferido'));
});

test('una fila CON importe no se toca', () => {
    // "sin tocar las que tienen importe" era la condición explícita.
    const f = fila('con importe');
    assert.equal(f.total_centimos, 3949);
    assert.equal(f.estado, 'procesado');
    assert.equal(f.sin_importe, 0);
});

test('un importe CERO impreso tampoco: 0 es un dato, no un hueco', () => {
    const f = fila('cero impreso');
    assert.equal(f.total_centimos, 0);
    assert.equal(f.sin_importe, 0);
    assert.equal(f.estado, 'procesado');
});

test('sin importe y con fecha: pasa a procesado y queda marcada', () => {
    const f = fila('sin importe con fecha');
    assert.equal(f.estado, 'procesado');
    assert.equal(f.sin_importe, 1);
    // Y NO se inventa un 0 en la columna: el 0 se aplica al sumar, no aquí.
    assert.equal(f.total_centimos, null);
});

test('sin fecha sigue siendo incompleta: la fecha no ha cambiado de criterio', () => {
    const f = fila('sin importe ni fecha');
    assert.equal(f.estado, 'incompleto');
    assert.equal(f.sin_importe, 1, 'marcada igual, aunque siga en ámbar por la fecha');
});

test('con la ausencia de fecha confirmada, sí pasa a procesado', () => {
    const f = fila('sin fecha confirmada');
    assert.equal(f.estado, 'procesado');
    assert.equal(f.sin_importe, 1);
    assert.equal(f.sin_fecha, 1, 'la confirmación de fecha se respeta');
});

test('una foto con varios tiquets se sigue revisando siempre', () => {
    // Es una decisión de diseño anterior: repartir importes entre varios papeles
    // en una sola imagen es donde más fácil se equivoca la IA.
    const f = fila('foto multiple');
    assert.equal(f.estado, 'incompleto');
    assert.equal(f.sin_importe, 1);
});

test('lo que ya estaba confirmado se queda como estaba', () => {
    const f = fila('ya confirmada');
    assert.equal(f.estado, 'procesado');
    assert.equal(f.sin_importe, 1);
});

test('las filas SIN LEER no se marcan: no son documentos sin importe', () => {
    // Marcarlas sería afirmar algo que nadie ha comprobado, y encima ensuciaría
    // el contador de "sin importe" del panel con fotos que nadie ha procesado.
    for (const nota of ['pendiente', 'error']) {
        const f = fila(nota);
        assert.equal(f.sin_importe, 0, nota);
        assert.equal(f.estado, nota, `${nota} sigue en su estado`);
    }
});

// =============================================================================
// GEOCODIFICACIÓN
// =============================================================================

test('los establecimientos nacen pendientes de geocodificar', () => {
    const est = db.prepare(`SELECT * FROM establecimientos WHERE nombre = 'MERCADONA'`).get();
    assert.equal(est.geo_estado, 'pendiente');
    assert.equal(est.latitud, null);
    assert.equal(est.geo_intentado_at, null);
});

test('el que ya tenía coordenadas se marca "ok" y no se vuelve a preguntar', () => {
    const est = db.prepare(`SELECT * FROM establecimientos WHERE nombre = 'YA SITUADO'`).get();
    assert.equal(est.geo_estado, 'ok');
    assert.equal(est.latitud, 41.0);
    // Y con la precisión que de verdad tenían: se consiguieron con la búsqueda
    // de una sola etapa, que era la dirección completa o nada.
    assert.equal(est.geo_precision, 'exacta');
});

test('los pendientes no estrenan precisión: todavía no se sabe', () => {
    const est = db.prepare(`SELECT * FROM establecimientos WHERE nombre = 'MERCADONA'`).get();
    assert.equal(est.geo_precision, null);
});

// =============================================================================
// Y LA BASE SIGUE SIENDO USABLE
// =============================================================================

test('los índices y el trigger se recrean después de migrar', () => {
    const indices = db.prepare(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'`
    ).all().map(i => i.name);

    assert.ok(indices.includes('idx_tickets_foto_indice'));
    assert.ok(indices.includes('idx_establecimientos_geo'), 'el índice de la cola de geocodificación');
    assert.ok(indices.includes('idx_tickets_establecimiento'), 'el de las estadísticas');

    const trigger = db.prepare(
        `SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'tickets_touch_updated_at'`
    ).get();
    assert.ok(trigger);
});

test('no se ha perdido ninguna fila por el camino', () => {
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tickets').get().n, FILAS.length);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM establecimientos').get().n, 2);
});
