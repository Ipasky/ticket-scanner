'use strict';

/**
 * Identidad de los establecimientos: a cuál va un tiquet y cómo se unen dos.
 *
 * El nombre ya no basta para saber qué sitio es: hay un Mercadona en cada
 * pueblo. Un tiquet va al establecimiento que se llame así (o tenga ese nombre
 * como alias) Y esté en el mismo sitio; si no hay ninguno, se crea otro, y
 * Google Places acaba decidiendo si en realidad era el mismo (mismo place_id).
 */

const db = require('../config/db');

const sinAcentos = (s) => String(s ?? '').toLowerCase().normalize('NFD')
    .replace(/[̀-ͯ]/g, '').trim();

const cpNormal = (v) => {
    const m = String(v ?? '').trim().match(/^\d{4,5}$/);
    return m ? m[0].padStart(5, '0') : '';
};

const STMT_CANDIDATOS = db.prepare(`
    SELECT e.id, e.nombre, e.direccion, e.ciudad, e.codigo_postal, e.lugar_inferido, e.place_id,
           (SELECT COUNT(*) FROM tickets t WHERE t.establecimiento_id = e.id) AS n
    FROM establecimientos e
    WHERE e.nombre = @nombre
       OR e.id IN (SELECT establecimiento_id FROM establecimiento_alias WHERE nombre = @nombre)
    ORDER BY n DESC, e.id ASC
`);

/**
 * El establecimiento existente al que va un tiquet con este nombre y esta
 * ubicación, o null si hay que crear uno.
 *
 *   · Sin ningún dato de ubicación en el tiquet: el más usado con ese nombre.
 *   · Con datos: el que coincide en código postal, ciudad o lugar deducido; si
 *     ninguno coincide, uno que todavía no sabe dónde está (se completa).
 *   · Si todos están en otra parte, es otro sitio: null.
 */
function buscarExistente(nombre, datos = {}) {
    const candidatos = STMT_CANDIDATOS.all({ nombre });
    if (candidatos.length === 0) return null;

    const cp = cpNormal(datos.codigo_postal);
    const ciudad = sinAcentos(datos.ciudad);
    const lugar = sinAcentos(datos.lugar_inferido);
    if (!cp && !ciudad && !lugar && !String(datos.direccion ?? '').trim()) return candidatos[0];

    const coincide = (c) =>
        (cp && cpNormal(c.codigo_postal) === cp) ||
        (ciudad && sinAcentos(c.ciudad) === ciudad) ||
        (lugar && (sinAcentos(c.lugar_inferido) === lugar || sinAcentos(c.ciudad) === lugar));
    const sinUbicacion = (c) =>
        !c.place_id && !c.codigo_postal && !c.ciudad && !c.direccion && !c.lugar_inferido;

    return candidatos.find(coincide) || candidatos.find(sinUbicacion) || null;
}

// --- UNIR ----------------------------------------------------------------------

const STMT_EST = db.prepare('SELECT * FROM establecimientos WHERE id = ?');
const STMT_TICKETS_DE = db.prepare('SELECT id, clave_tiquet FROM tickets WHERE establecimiento_id = ?');
const STMT_MOVER = db.prepare(
    'UPDATE tickets SET establecimiento_id = @destino, clave_tiquet = @clave WHERE id = @id'
);
const STMT_COMPLETAR = db.prepare(`
    UPDATE establecimientos SET
        direccion      = COALESCE(direccion, @direccion),
        ciudad         = COALESCE(ciudad, @ciudad),
        codigo_postal  = COALESCE(codigo_postal, @codigo_postal),
        pais           = COALESCE(pais, @pais),
        lugar_inferido = COALESCE(lugar_inferido, @lugar_inferido)
    WHERE id = @id
`);
const STMT_COPIAR_UBICACION = db.prepare(`
    UPDATE establecimientos SET latitud = @latitud, longitud = @longitud,
           geo_estado = @geo_estado, geo_precision = @geo_precision
    WHERE id = @id AND latitud IS NULL
`);
// Si el que se va estaba verificado en Google y el que se queda no, se queda
// con la verificación (y su punto, que es mejor que cualquier otro salvo uno
// puesto a mano).
const STMT_COPIAR_GOOGLE = db.prepare(`
    UPDATE establecimientos SET
        place_id = @place_id, google_estado = @google_estado, google_nombre = @google_nombre,
        google_direccion = @google_direccion, google_candidatos = NULL,
        google_actualizado_at = @google_actualizado_at,
        latitud  = CASE WHEN geo_precision = 'manual' THEN latitud  ELSE @latitud  END,
        longitud = CASE WHEN geo_precision = 'manual' THEN longitud ELSE @longitud END,
        geo_estado = CASE WHEN geo_precision = 'manual' THEN geo_estado ELSE 'ok' END,
        geo_precision = CASE WHEN geo_precision = 'manual' THEN 'manual' ELSE 'google' END
    WHERE id = @id AND place_id IS NULL
`);
const STMT_MOVER_ALIAS = db.prepare(`
    INSERT OR IGNORE INTO establecimiento_alias (nombre, establecimiento_id)
    SELECT nombre, @destino FROM establecimiento_alias WHERE establecimiento_id = @origen
`);
const STMT_ALIAS = db.prepare(
    'INSERT OR IGNORE INTO establecimiento_alias (nombre, establecimiento_id) VALUES (?, ?)'
);
const STMT_QUITAR_ALIAS_PROPIO = db.prepare(
    'DELETE FROM establecimiento_alias WHERE establecimiento_id = ? AND nombre = ?'
);
const STMT_BORRAR = db.prepare('DELETE FROM establecimientos WHERE id = ?');

/** Apunta `nombre` como otro nombre de `id` (si no es ya el suyo). */
function apuntarAlias(id, nombre) {
    const est = STMT_EST.get(id);
    if (!est || !nombre || nombre === est.nombre) return;
    STMT_ALIAS.run(nombre, id);
}

/**
 * Mueve los tiquets de `origen` a `destino` y borra `origen`. Lo que le falte a
 * `destino` se completa con lo de `origen`, y el nombre de `origen` queda como
 * alias de `destino`. Devuelve { movidos, clavesQuitadas } o null si alguno no
 * existe.
 */
function unir(destino, origen) {
    const queda = STMT_EST.get(destino);
    const sale = STMT_EST.get(origen);
    if (!queda || !sale || destino === origen) return null;

    let movidos = 0, clavesQuitadas = 0;
    db.transaction(() => {
        for (const t of STMT_TICKETS_DE.all(origen)) {
            // La clave de duplicados empieza por el id del establecimiento: se
            // reescribe con el nuevo. Si choca con un tiquet idéntico del que se
            // queda, es que estaba duplicado: se guarda sin clave, sin perderlo.
            const clave = t.clave_tiquet
                ? `${destino}${t.clave_tiquet.slice(t.clave_tiquet.indexOf('|'))}`
                : null;
            try {
                STMT_MOVER.run({ id: t.id, destino, clave });
            } catch (err) {
                if (!String(err.code || '').startsWith('SQLITE_CONSTRAINT')) throw err;
                STMT_MOVER.run({ id: t.id, destino, clave: null });
                clavesQuitadas += 1;
            }
            movidos += 1;
        }
        STMT_COMPLETAR.run({ ...sale, id: destino });
        if (sale.latitud !== null && !sale.place_id) STMT_COPIAR_UBICACION.run({ ...sale, id: destino });
        STMT_MOVER_ALIAS.run({ destino, origen });
        STMT_BORRAR.run(origen);       // antes de copiar place_id: es único
        if (sale.place_id) STMT_COPIAR_GOOGLE.run({ ...sale, id: destino });
        if (sale.nombre !== queda.nombre) STMT_ALIAS.run(sale.nombre, destino);
        STMT_QUITAR_ALIAS_PROPIO.run(destino, STMT_EST.get(destino).nombre);
    })();

    for (const fn of alUnir) {
        try { fn(destino, origen); } catch (err) { console.warn('Aviso de unión fallido:', err.message); }
    }
    return { movidos, clavesQuitadas };
}

// Quien guarde ids de establecimiento fuera de esta base (el banco) se entera
// de las uniones para apuntar al que se queda.
const alUnir = [];
function cuandoSeUnan(fn) { if (!alUnir.includes(fn)) alUnir.push(fn); }

const STMT_CREAR = db.prepare(`
    INSERT INTO establecimientos (nombre, ciudad, google_estado, geo_estado, geo_precision)
    VALUES (@nombre, @ciudad, @google_estado, @geo_estado, @geo_precision)
`);

/**
 * El establecimiento para un comercio del banco: el que ya exista con ese
 * nombre en esa ciudad, o uno nuevo. Las tiendas online no tienen sitio: no se
 * buscan en Google ni en el mapa. Devuelve { id, nuevo }.
 */
function asegurar(nombre, { ciudad = null, online = false } = {}) {
    const existente = buscarExistente(nombre, online ? {} : { ciudad });
    if (existente) return { id: existente.id, nuevo: false };
    const id = Number(STMT_CREAR.run({
        nombre, ciudad: online ? null : ciudad,
        google_estado: online ? 'descartado' : 'pendiente',
        geo_estado: online ? 'sin_datos' : 'pendiente',
        geo_precision: online ? 'online' : null
    }).lastInsertRowid);
    return { id, nuevo: true };
}

/**
 * Tienda online / sin ubicación (geo_precision = 'online'): sin dirección ni
 * punto, y ni Nominatim ni Google lo vuelven a buscar. Con `online` false
 * vuelve al circuito automático.
 */
const STMT_ONLINE = db.prepare(`
    UPDATE establecimientos SET
        direccion = NULL, ciudad = NULL, codigo_postal = NULL, lugar_inferido = NULL,
        latitud = NULL, longitud = NULL, geo_estado = 'sin_datos', geo_precision = 'online', geo_mensaje = NULL,
        place_id = NULL, google_estado = 'descartado', google_nombre = NULL, google_direccion = NULL, google_candidatos = NULL
    WHERE id = ?
`);
const STMT_NO_ONLINE = db.prepare(`
    UPDATE establecimientos SET geo_estado = 'pendiente', geo_precision = NULL, google_estado = 'pendiente'
    WHERE id = ? AND geo_precision = 'online'
`);
function marcarOnline(id, online) {
    return (online ? STMT_ONLINE : STMT_NO_ONLINE).run(id).changes > 0;
}

module.exports = { buscarExistente, unir, apuntarAlias, sinAcentos, cpNormal, asegurar, cuandoSeUnan, marcarOnline };
