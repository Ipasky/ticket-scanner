'use strict';

/**
 * El banco: conexión con Enable Banking (solo lectura) y descarga de movimientos.
 *
 * Va en su PROPIA base de datos (database/banco.db), separada de la de tiquets,
 * como se decidió en el plan (3.9): los datos bancarios tienen otro nivel de
 * sensibilidad y no se mezclan en el mismo fichero.
 *
 * Cómo funciona Enable Banking:
 *   1. Cada petición lleva un JWT firmado (RS256) con la clave privada que se
 *      descargó al registrar la aplicación. Esa clave nunca sale del servidor.
 *   2. Para leer las cuentas hace falta una SESIÓN: POST /auth devuelve una URL
 *      del banco; allí autorizo; el banco vuelve a /banco/vuelta con un `code`;
 *      POST /sessions lo cambia por la sesión y la lista de cuentas.
 *   3. Con la sesión, GET /accounts/{uid}/transactions da los movimientos.
 *
 * Límites que pone PSD2 (no Enable Banking): sin el usuario delante, el banco
 * solo está obligado a responder ~4 veces al día por cuenta. Por eso la
 * descarga automática va cada 6 horas; la manual (botón "Sincronizar") manda la
 * IP y el navegador del usuario, que es lo que marca "el usuario está delante".
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const analisis = require('./banco_analisis');
const { categoriaPorRegla } = require('./reglas_categoria');

const API = 'https://api.enablebanking.com';
const CADA_MS = 6 * 3600 * 1000;
const TIMEOUT_MS = 30_000;
// Primera descarga: 89 días, lo que todos los bancos dan por PSD2. Lo anterior,
// con el extracto en fichero.
const DIAS_PRIMERA_VEZ = 89;
// Las siguientes: desde el último movimiento, con margen (un cargo puede
// asentarse con fecha de unos días antes).
const DIAS_SOLAPE = 7;

function leerConfiguracion(entorno = process.env) {
    // Se admite también el nombre del fichero tal cual ("xxxx.pem"): el id es lo
    // de antes de la extensión, y con ".pem" Enable Banking no lo reconoce.
    const appId = path.basename(String(entorno.ENABLEBANKING_APP_ID || '').trim().replace(/^["']|["']$/g, ''))
        .replace(/\.pem$/i, '');
    const ruta = String(entorno.ENABLEBANKING_KEY_PATH || '').trim();
    const rutaClave = ruta ? path.resolve(__dirname, '../..', ruta) : '';
    return {
        appId, rutaClave,
        // La dirección pública va en el .env: el repositorio no la conoce.
        redirectUrl: String(entorno.BANCO_REDIRECT_URL || '').trim() ||
                     'http://localhost:3000/banco/vuelta',
        nombreBanco: String(entorno.BANCO_ASPSP || 'Santander').trim(),
        pais: String(entorno.BANCO_PAIS || 'ES').trim().toUpperCase(),
        activa: Boolean(appId && rutaClave && fs.existsSync(rutaClave))
    };
}

// --- BASE DE DATOS ---------------------------------------------------------------

/** Dónde vive la base del banco: junto a la de tiquets (también en las pruebas). */
function rutaBaseBanco() {
    if (process.env.BANCO_DB_PATH) return path.resolve(process.env.BANCO_DB_PATH);
    if (process.env.TICKETS_DB_PATH) return path.join(path.dirname(path.resolve(process.env.TICKETS_DB_PATH)), 'banco.db');
    return path.join(__dirname, '../../database/banco.db');
}

function abrirBase(ruta = rutaBaseBanco()) {
    const db = new Database(ruta);
    db.pragma('journal_mode = WAL');
    db.exec(`
        CREATE TABLE IF NOT EXISTS sesiones (
            id          TEXT PRIMARY KEY,           -- session_id de Enable Banking
            banco       TEXT,
            valida_hasta TEXT,                      -- ISO; hasta cuándo dura el permiso
            creada_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
            activa      INTEGER NOT NULL DEFAULT 1
        );
        CREATE TABLE IF NOT EXISTS cuentas (
            uid         TEXT PRIMARY KEY,           -- uid de la cuenta en Enable Banking
            sesion_id   TEXT,
            iban        TEXT,
            nombre      TEXT,
            moneda      TEXT,
            -- Solo se leen las cuentas marcadas. Nacen sin marcar: se elige a mano.
            leer        INTEGER NOT NULL DEFAULT 0,
            ultima_sincronizacion DATETIME,
            ultimo_error TEXT
        );
        -- Un movimiento por apunte del banco. El importe con signo: negativo es
        -- un cargo (un gasto), positivo un abono.
        CREATE TABLE IF NOT EXISTS movimientos (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            cuenta_uid      TEXT NOT NULL,
            clave           TEXT NOT NULL UNIQUE,   -- para no guardar dos veces el mismo
            fecha           TEXT NOT NULL,          -- de la operación (o de asiento si no hay)
            fecha_valor     TEXT,
            importe_centimos INTEGER NOT NULL,
            moneda          TEXT NOT NULL DEFAULT 'EUR',
            concepto        TEXT,
            contraparte     TEXT,
            tipo            TEXT,
            codigo_comercio TEXT,                   -- MCC, si el banco lo da
            crudo           TEXT,                   -- el JSON tal cual, por si hace falta
            tiquet_id       INTEGER,                -- el tiquet con el que casa (fase 2)
            categoria       TEXT,
            creado_at       DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_mov_fecha  ON movimientos(fecha);
        CREATE INDEX IF NOT EXISTS idx_mov_cuenta ON movimientos(cuenta_uid);
    `);
    // Lo que se saca del concepto (banco_analisis.js). Columnas añadidas después
    // de crear la tabla: se ponen si faltan.
    const columnas = new Set(db.pragma('table_info(movimientos)').map(c => c.name));
    for (const [col, tipo] of [['clase', 'TEXT'], ['comercio', 'TEXT'], ['poblacion', 'TEXT'],
                               ['persona', 'TEXT'], ['nota', 'TEXT'], ['enlace', 'TEXT'],
                               // 1 = no cuenta como gasto (traspaso entre mis cuentas, inversión…)
                               ['excluir', 'INTEGER NOT NULL DEFAULT 0'],
                               // de dónde salió la categoría: regla, tiquet, comercio, ia, manual
                               ['categoria_origen', 'TEXT'],
                               // Pago compartido, igual que en los tiquets: entre cuántos y mi parte.
                               ['compartido_entre', 'INTEGER'], ['mi_parte_centimos', 'INTEGER'],
                               // 'api' (Enable Banking) o 'fichero' (extracto importado); y, si el
                               // mismo apunte llegó por las dos vías, la clave del gemelo descartado.
                               ['origen', 'TEXT'], ['pareja_clave', 'TEXT'],
                               // 'manual' = el tipo lo he puesto yo: el lector de conceptos no lo toca.
                               ['clase_origen', 'TEXT'],
                               // Establecimiento puesto a mano solo en este pago: manda sobre
                               // el de su comercio. NULL = el del comercio.
                               ['est_propio', 'INTEGER']]) {
        if (!columnas.has(col)) db.exec(`ALTER TABLE movimientos ADD COLUMN ${col} ${tipo}`);
    }
    // Lo aprendido por comercio: la siguiente compra en el mismo sitio sale ya
    // con su categoría. Lo puesto a mano manda sobre todo lo demás.
    db.exec(`CREATE TABLE IF NOT EXISTS categorias_comercio (
        clave TEXT PRIMARY KEY, categoria TEXT NOT NULL, origen TEXT NOT NULL,
        actualizado_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    // A qué establecimiento (de la base de tiquets) pertenece cada comercio tal
    // como lo escribe el banco. Clave: comercio|población en mayúsculas (ver
    // CLAVE_COMERCIO). origen: manual, tiquet (de un pago enlazado), ia.
    // nombre = el que dio Gemini o yo; el que se enseña es el del establecimiento.
    db.exec(`CREATE TABLE IF NOT EXISTS comercios (
        clave TEXT PRIMARY KEY, comercio TEXT, poblacion TEXT,
        nombre TEXT, establecimiento_id INTEGER, tipo TEXT, origen TEXT,
        estado TEXT NOT NULL DEFAULT 'pendiente',
        actualizado_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    // Lo que digo yo de las suscripciones: confirmar una detectada (y corregir su
    // nombre, importe, ritmo o fecha), descartarla ("bonÀrea es gasolina") o
    // añadir una que no se detecta. clave = la del comercio (claveComercio) o
    // 'manual:…' para las que no salen de ningún movimiento.
    // Estado de las descargas que tiene que sobrevivir a un reinicio: hasta
    // cuándo están en pausa, cuántas automáticas van hoy, el último intento.
    db.exec(`CREATE TABLE IF NOT EXISTS estado_sync (clave TEXT PRIMARY KEY, valor TEXT)`);
    db.exec(`CREATE TABLE IF NOT EXISTS suscripciones (
        clave TEXT PRIMARY KEY, estado TEXT NOT NULL, nombre TEXT, importe_centimos INTEGER,
        ritmo TEXT, proximo TEXT, creado_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    fusionarHuellas(db);
    return db;
}

/**
 * Los repetidos que ya entraron así (uno por huella y el mismo luego con
 * referencia): se queda el primero, con lo que se le hubiera puesto al otro
 * (tiquet, establecimiento, compartido) si él no lo tenía, y la clave buena.
 */
function fusionarHuellas(db) {
    const huellas = db.prepare(`SELECT id, cuenta_uid, clave FROM movimientos WHERE clave LIKE '%|h|%'`).all();
    if (!huellas.length) return 0;
    const porClave = new Map(huellas.map(h => [h.clave, h]));
    const conId = db.prepare(`SELECT id, cuenta_uid, clave, crudo FROM movimientos
        WHERE clave NOT LIKE '%|h|%' AND crudo IS NOT NULL AND COALESCE(origen, 'api') = 'api'`).all();
    let n = 0;
    db.transaction(() => {
        for (const m of conId) {
            const viejo = porClave.get(huellaDeCrudo(m.crudo, m.cuenta_uid));
            if (!viejo) continue;
            porClave.delete(viejo.clave);
            const nuevo = db.prepare('SELECT * FROM movimientos WHERE id = ?').get(m.id);
            db.prepare('DELETE FROM movimientos WHERE id = ?').run(m.id);
            db.prepare(`UPDATE movimientos SET clave = @clave, crudo = @crudo,
                    tiquet_id = COALESCE(tiquet_id, @tiquet_id), enlace = COALESCE(enlace, @enlace),
                    est_propio = COALESCE(est_propio, @est_propio),
                    compartido_entre = COALESCE(compartido_entre, @compartido_entre),
                    mi_parte_centimos = COALESCE(mi_parte_centimos, @mi_parte_centimos)
                WHERE id = @id`).run({ ...nuevo, id: viejo.id });
            n += 1;
        }
    })();
    if (n) console.log(`🏦 Unidos ${n} movimientos repetidos del banco (llegaron primero sin referencia).`);
    return n;
}

/** La clave de comercios para un movimiento con alias `a` (en SQL). */
const CLAVE_COMERCIO = (a = 'm') =>
    `UPPER(TRIM(${a}.comercio)) || '|' || UPPER(TRIM(COALESCE(${a}.poblacion, '')))`;
// Los movimientos que son una compra en un comercio.
const CLASES_COMERCIO = `('tarjeta', 'recibo', 'devolucion')`;
// El establecimiento de un movimiento: el puesto a mano en ESE pago (est_propio)
// o, si no, el de su comercio (todos los pagos con el mismo nombre en el banco).
const EST_MOV = 'COALESCE(m.est_propio, k.establecimiento_id)';
const enTitulo = (s) => String(s || '').toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (_, a, b) => a + b.toUpperCase()).trim() || null;

// Categorías que salen solas del tipo de movimiento, sin mirar el comercio.
const CATEGORIA_POR_CLASE = {
    bizum_enviado: 'BIZUM', bizum_recibido: 'BIZUM',
    transferencia_enviada: 'TRANSFERENCIA', transferencia_recibida: 'INGRESOS',
    comision: 'COMISIONES'
};

// --- JWT --------------------------------------------------------------------------

const b64url = (buf) => Buffer.from(buf).toString('base64')
    .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

function crearJwt(appId, clavePem, ahora = Math.floor(Date.now() / 1000)) {
    const cabecera = b64url(JSON.stringify({ typ: 'JWT', alg: 'RS256', kid: appId }));
    const cuerpo = b64url(JSON.stringify({
        iss: 'enablebanking.com', aud: 'api.enablebanking.com', iat: ahora, exp: ahora + 3600
    }));
    const firma = crypto.sign('RSA-SHA256', Buffer.from(`${cabecera}.${cuerpo}`), clavePem);
    return `${cabecera}.${cuerpo}.${b64url(firma)}`;
}

// --- MOVIMIENTOS ------------------------------------------------------------------

/** Importe "12.34" + indicador -> céntimos con signo (negativo = cargo). */
function aCentimos(cantidad, indicador) {
    const n = Math.round(Number(String(cantidad).replace(',', '.')) * 100);
    if (!Number.isFinite(n)) return null;
    return String(indicador).toUpperCase() === 'DBIT' ? -Math.abs(n) : Math.abs(n);
}

/** Un movimiento de Enable Banking a una fila. null si no se entiende. */
/** La clave de un apunte que llega sin id del banco: fecha, importe y concepto. */
function huellaApunte(t, cuentaUid) {
    const importe = t && t.transaction_amount;
    const centimos = importe ? aCentimos(importe.amount, t.credit_debit_indicator) : null;
    const fecha = t && (t.transaction_date || t.booking_date || t.value_date);
    const concepto = [].concat(t.remittance_information || []).filter(Boolean).join(' ').trim() ||
                     (t.note || '').trim() || null;
    return `${cuentaUid}|h|` + crypto.createHash('sha1')
        .update([fecha, t.booking_date, centimos, concepto].join('|')).digest('hex');
}
/** La huella del apunte guardado en `crudo` (null si no se puede leer). */
function huellaDeCrudo(crudo, cuentaUid) {
    try { const t = JSON.parse(crudo); return t ? huellaApunte(t, cuentaUid) : null; } catch (_) { return null; }
}

function normalizarMovimiento(t, cuentaUid) {
    const importe = t && t.transaction_amount;
    const centimos = importe ? aCentimos(importe.amount, t.credit_debit_indicator) : null;
    const fecha = t && (t.transaction_date || t.booking_date || t.value_date);
    if (centimos === null || !fecha) return null;

    const concepto = [].concat(t.remittance_information || []).filter(Boolean).join(' ').trim() ||
                     (t.note || '').trim() || null;
    const contraparte = centimos < 0
        ? (t.creditor && t.creditor.name) || null
        : (t.debtor && t.debtor.name) || null;
    // Lo que identifica un apunte: el id del banco si lo da; si no, su huella.
    const id = t.transaction_id || t.entry_reference;
    const clave = id ? `${cuentaUid}|${id}` : huellaApunte(t, cuentaUid);

    return {
        cuenta_uid: cuentaUid, clave,
        fecha: String(fecha).slice(0, 10),
        fecha_valor: t.value_date ? String(t.value_date).slice(0, 10) : null,
        importe_centimos: centimos,
        moneda: (importe.currency || 'EUR').toUpperCase(),
        concepto, contraparte,
        tipo: (t.bank_transaction_code && (t.bank_transaction_code.description || t.bank_transaction_code.code)) || null,
        codigo_comercio: t.merchant_category_code || null,
        crudo: JSON.stringify(t)
    };
}

// --- EL MISMO APUNTE POR DOS VÍAS -------------------------------------------------
// Un movimiento puede llegar por la API y por un extracto importado. Las claves
// no coinciden (la API trae su id; el fichero, no), así que se reconocen por
// importe exacto, fecha (±3 días: la API puede dar la de asiento) y concepto sin
// números ni signos (la API y el Excel enmascaran la tarjeta distinto). Cada
// apunte se empareja una sola vez: dos cafés iguales el mismo día siguen siendo
// dos.

const normConcepto = (c) => String(c || '').toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Z ]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 28);

function insertarSinDuplicar(d, fila, origen) {
    if (d.prepare('SELECT 1 FROM movimientos WHERE clave = ? OR pareja_clave = ?').get(fila.clave, fila.clave)) return 'repetido';
    // El banco a veces da un apunte primero sin referencia (se guardó por su
    // huella) y, en otra sincronización, el mismo con referencia. Es el mismo:
    // se le pone la clave buena en vez de meterlo otra vez.
    if (!fila.clave.includes('|h|') && fila.crudo) {
        const huella = huellaDeCrudo(fila.crudo, fila.cuenta_uid);
        const viejo = huella && d.prepare('SELECT id FROM movimientos WHERE clave = ?').get(huella);
        if (viejo) {
            d.prepare('UPDATE movimientos SET clave = ?, crudo = ? WHERE id = ?').run(fila.clave, fila.crudo, viejo.id);
            return 'repetido';
        }
    }
    const f = new Date(`${fila.fecha}T12:00:00Z`).getTime();
    const desde = new Date(f - 3 * 86400e3).toISOString().slice(0, 10);
    const hasta = new Date(f + 3 * 86400e3).toISOString().slice(0, 10);
    const contrario = origen === 'api' ? 'fichero' : 'api';
    const norm = normConcepto(fila.concepto);
    const gemelo = d.prepare(`
        SELECT id, fecha, concepto FROM movimientos
        WHERE cuenta_uid = ? AND importe_centimos = ? AND fecha BETWEEN ? AND ?
          AND pareja_clave IS NULL AND COALESCE(origen, 'api') = ?`)
        .all(fila.cuenta_uid, fila.importe_centimos, desde, hasta, contrario)
        .filter(m => normConcepto(m.concepto) === norm)
        .sort((a, b) => Math.abs(new Date(a.fecha) - f) - Math.abs(new Date(b.fecha) - f))[0];
    if (gemelo) {
        d.prepare('UPDATE movimientos SET pareja_clave = ? WHERE id = ?').run(fila.clave, gemelo.id);
        return 'emparejado';
    }
    d.prepare(`INSERT INTO movimientos
        (cuenta_uid, clave, fecha, fecha_valor, importe_centimos, moneda, concepto, contraparte, tipo, codigo_comercio, crudo, origen)
        VALUES (@cuenta_uid, @clave, @fecha, @fecha_valor, @importe_centimos, @moneda, @concepto, @contraparte, @tipo, @codigo_comercio, @crudo, @origen)`)
        .run({ contraparte: null, tipo: null, codigo_comercio: null, fecha_valor: null, moneda: 'EUR', ...fila, origen });
    return 'nuevo';
}

/** Enmascara un IBAN para enseñarlo: ES12 **** **** 1234. */
const ibanCorto = (iban) => iban ? `${iban.slice(0, 4)} •••• ${iban.slice(-4)}` : null;

// --- EL SERVICIO ----------------------------------------------------------------------

/** Los tiquets de la base de tiquets entre dos fechas, para cruzarlos. */
function tiquetsDe(ticketsDb) {
    let stmt = null;
    return (desde, hasta) => {
        stmt ||= ticketsDb.prepare(`
            SELECT t.id, substr(t.fecha_compra, 1, 10) AS dia, t.total_centimos, t.total_eur_centimos,
                   e.nombre, e.google_nombre,
                   (SELECT group_concat(a.nombre, '|') FROM establecimiento_alias a WHERE a.establecimiento_id = e.id) AS alias
            FROM tickets t LEFT JOIN establecimientos e ON e.id = t.establecimiento_id
            WHERE t.total_centimos IS NOT NULL AND t.estado IN ('procesado', 'incompleto')
              AND substr(t.fecha_compra, 1, 10) BETWEEN ? AND ?`);
        return stmt.all(desde, hasta).map(t => ({ ...t, alias: t.alias ? t.alias.split('|') : [] }));
    };
}

function crearBanco({ config = leerConfiguracion(), db = null, ticketsDb = null, hacerPeticion = fetch, avisar = () => {} } = {}) {
    const baseTiquets = () => (ticketsDb ||= require('../config/db'));
    let base = db;
    const conectar = () => (base ||= abrirBase());
    let clavePem = null;
    const estadosPendientes = new Map();     // state -> creado (anti-CSRF del retorno)
    let sincronizando = false;
    let ultimoError = null;

    function exigir() {
        if (!config.activa) {
            const e = new Error('El banco no está configurado: faltan ENABLEBANKING_APP_ID o la clave (ENABLEBANKING_KEY_PATH).');
            e.estado = 503;
            throw e;
        }
        clavePem ||= fs.readFileSync(config.rutaClave, 'utf8');
    }

    async function api(metodo, ruta, { cuerpo, consulta, usuario } = {}) {
        exigir();
        const url = new URL(API + ruta);
        for (const [k, v] of Object.entries(consulta || {})) if (v != null) url.searchParams.set(k, v);
        const cabeceras = {
            Authorization: `Bearer ${crearJwt(config.appId, clavePem)}`,
            Accept: 'application/json'
        };
        if (cuerpo) cabeceras['Content-Type'] = 'application/json';
        // "El usuario está delante": el banco no lo cuenta en el límite diario.
        if (usuario && usuario.ip) cabeceras['Psu-Ip-Address'] = usuario.ip;
        if (usuario && usuario.agente) cabeceras['Psu-User-Agent'] = usuario.agente;

        const res = await hacerPeticion(url, {
            method: metodo, headers: cabeceras,
            body: cuerpo ? JSON.stringify(cuerpo) : undefined,
            signal: AbortSignal.timeout(TIMEOUT_MS)
        });
        const texto = await res.text();
        let datos = null;
        try { datos = texto ? JSON.parse(texto) : null; } catch (_) { datos = { texto }; }
        if (!res.ok) {
            const detalle = (datos && (datos.message || datos.detail || datos.error)) || texto.slice(0, 200);
            const e = new Error(`Enable Banking ha respondido ${res.status}: ${detalle}`);
            e.estado = res.status;
            throw e;
        }
        return datos;
    }

    const sesionActiva = () => conectar().prepare(
        `SELECT * FROM sesiones WHERE activa = 1 ORDER BY creada_at DESC LIMIT 1`).get();

    /** Paso 1: la URL del banco a la que mandar al usuario para autorizar. */
    async function iniciarConexion() {
        const { aspsps = [] } = await api('GET', '/aspsps', { consulta: { country: config.pais } });
        const buscado = config.nombreBanco.toLowerCase();
        const banco = aspsps.find(a => String(a.name).toLowerCase() === buscado) ||
                      aspsps.find(a => String(a.name).toLowerCase().includes(buscado));
        if (!banco) throw Object.assign(new Error(`No encuentro "${config.nombreBanco}" entre los bancos de ${config.pais}.`), { estado: 404 });

        // El máximo que admite ese banco (PSD2: hasta 180 días).
        const segundos = Math.min(Number(banco.maximum_consent_validity) || 90 * 86400, 180 * 86400);
        const validaHasta = new Date(Date.now() + segundos * 1000 - 3600 * 1000).toISOString();
        const state = crypto.randomUUID();
        estadosPendientes.set(state, Date.now());

        const r = await api('POST', '/auth', { cuerpo: {
            access: { valid_until: validaHasta },
            aspsp: { name: banco.name, country: banco.country || config.pais },
            state, redirect_url: config.redirectUrl, psu_type: 'personal'
        } });
        return { url: r.url, valida_hasta: validaHasta, banco: banco.name };
    }

    /** Paso 2: el banco ha vuelto con `code`. Se cambia por la sesión. */
    async function completarConexion(code, state) {
        const creado = estadosPendientes.get(state);
        if (!creado || Date.now() - creado > 30 * 60 * 1000) {
            throw Object.assign(new Error('Esta autorización no la ha pedido esta aplicación o ha caducado. Vuelve a conectar.'), { estado: 400 });
        }
        estadosPendientes.delete(state);
        const s = await api('POST', '/sessions', { cuerpo: { code } });
        const d = conectar();
        d.transaction(() => {
            d.prepare('UPDATE sesiones SET activa = 0').run();
            d.prepare(`INSERT OR REPLACE INTO sesiones (id, banco, valida_hasta, activa) VALUES (?, ?, ?, 1)`)
             .run(s.session_id, (s.aspsp && s.aspsp.name) || config.nombreBanco, (s.access && s.access.valid_until) || null);
            for (const c of s.accounts || []) {
                const iban = (c.account_id && c.account_id.iban) || null;
                // Al renovar, una cuenta conocida conserva si se lee o no.
                const previa = d.prepare('SELECT leer FROM cuentas WHERE iban IS ? OR uid = ?').get(iban, c.uid);
                d.prepare(`INSERT OR REPLACE INTO cuentas (uid, sesion_id, iban, nombre, moneda, leer)
                           VALUES (@uid, @sesion, @iban, @nombre, @moneda, @leer)`).run({
                    uid: c.uid, sesion: s.session_id, iban,
                    nombre: c.name || c.product || c.details || null,
                    moneda: c.currency || 'EUR', leer: previa ? previa.leer : 0
                });
                // Las filas viejas de esa misma cuenta (otro uid por la sesión anterior).
                if (iban) {
                    const viejas = d.prepare('SELECT uid FROM cuentas WHERE iban = ? AND uid <> ?').all(iban, c.uid);
                    for (const v of viejas) {
                        d.prepare('UPDATE movimientos SET cuenta_uid = ? WHERE cuenta_uid = ?').run(c.uid, v.uid);
                        d.prepare('DELETE FROM cuentas WHERE uid = ?').run(v.uid);
                    }
                }
            }
        })();
        console.log(`🏦 Banco conectado: ${(s.accounts || []).length} cuenta(s), válido hasta ${(s.access && s.access.valid_until) || '?'}.`);
        return estado();
    }

    function marcarCuenta(uid, leer) {
        const r = conectar().prepare('UPDATE cuentas SET leer = ? WHERE uid = ?').run(leer ? 1 : 0, uid);
        return r.changes > 0;
    }

    // El banco limita las consultas sin el usuario delante (unas 4 al día por
    // permiso). Si contesta 429, las automáticas se paran hasta mañana; la
    // manual (con el usuario delante) se sigue intentando.
    // Persistido en estado_sync: un reinicio no puede olvidar que el banco dijo
    // "basta por hoy" (y volver a gastar el cupo).
    const MAX_AUTO_DIA = 4;
    const leerSync = (k) => { try { return (conectar().prepare('SELECT valor FROM estado_sync WHERE clave = ?').get(k) || {}).valor ?? null; } catch (_) { return null; } };
    const ponerSync = (k, v) => { try { conectar().prepare('INSERT OR REPLACE INTO estado_sync (clave, valor) VALUES (?, ?)').run(k, v == null ? null : String(v)); } catch (_) { /* nada */ } };
    const diaMadrid = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' });
    const pausaAuto = () => Number(leerSync('pausa_auto_hasta') || 0);
    const pausaManual = () => Number(leerSync('pausa_manual_hasta') || 0);
    const autoHoy = () => (leerSync('auto_dia') === diaMadrid() ? Number(leerSync('auto_n') || 0) : 0);

    /** Descarga lo nuevo de las cuentas marcadas. Nunca lanza. */
    async function sincronizar({ usuario = null } = {}) {
        if (sincronizando) return { resultado: 'en_curso' };
        if (!usuario && Date.now() < pausaAuto()) return { resultado: 'limite' };
        if (usuario && Date.now() < pausaManual()) {
            return { resultado: 'limite_manual', hasta: new Date(pausaManual()).toISOString() };
        }
        const sesion = config.activa && sesionActiva();
        if (!sesion) return { resultado: 'sin_conexion' };
        if (sesion.valida_hasta && new Date(sesion.valida_hasta) < new Date()) return { resultado: 'caducada' };

        sincronizando = true;
        const d = conectar();
        let nuevos = 0;
        const errores = [];
        const tipo = usuario ? 'manual' : 'auto';
        if (!usuario) { ponerSync('auto_dia', diaMadrid()); ponerSync('auto_n', autoHoy() + 1); }
        try {
            for (const cuenta of d.prepare('SELECT * FROM cuentas WHERE leer = 1 AND sesion_id = ?').all(sesion.id)) {
                const ultimo = d.prepare('SELECT MAX(fecha) AS f FROM movimientos WHERE cuenta_uid = ?').get(cuenta.uid).f;
                const desde = new Date(ultimo ? new Date(ultimo).getTime() - DIAS_SOLAPE * 86400e3
                                              : Date.now() - DIAS_PRIMERA_VEZ * 86400e3).toISOString().slice(0, 10);
                try {
                    let continuar = null, vueltas = 0;
                    do {
                        const r = await api('GET', `/accounts/${encodeURIComponent(cuenta.uid)}/transactions`, {
                            consulta: { date_from: desde, transaction_status: 'BOOK', continuation_key: continuar },
                            usuario
                        });
                        d.transaction(() => {
                            for (const t of r.transactions || []) {
                                const fila = normalizarMovimiento(t, cuenta.uid);
                                if (fila && insertarSinDuplicar(d, fila, 'api') === 'nuevo') nuevos += 1;
                            }
                        })();
                        continuar = r.continuation_key || null;
                    } while (continuar && ++vueltas < 50);
                    d.prepare('UPDATE cuentas SET ultima_sincronizacion = CURRENT_TIMESTAMP, ultimo_error = NULL WHERE uid = ?').run(cuenta.uid);
                } catch (err) {
                    if (err.estado === 429) {
                        // Las automáticas, hasta mañana; las manuales, una hora.
                        const manana = new Date();
                        manana.setHours(24, 30, 0, 0);
                        ponerSync('pausa_auto_hasta', manana.getTime());
                        if (usuario) ponerSync('pausa_manual_hasta', Date.now() + 3600e3);
                        err.message = usuario
                            ? 'El banco no deja consultar más ahora mismo; prueba dentro de una hora. Los movimientos ya descargados siguen ahí.'
                            : 'El banco ha llegado a su límite de consultas automáticas de hoy; se reintentará mañana. ' +
                              'Los movimientos ya descargados siguen ahí.';
                    }
                    errores.push(err.message);
                    d.prepare('UPDATE cuentas SET ultimo_error = ? WHERE uid = ?').run(err.message.slice(0, 300), cuenta.uid);
                    ultimoError = err.message;
                    console.warn(`🏦 No se han podido leer los movimientos de ${ibanCorto(cuenta.iban)}: ${err.message}`);
                }
            }
            const enlazados = analizar();
            clasificarConIA().catch(() => {});
            resolverComercios().catch(() => {});
            if (nuevos || enlazados) {
                console.log(`🏦 ${nuevos} movimiento(s) nuevo(s) del banco; ${enlazados} enlazado(s) con su tiquet.`);
            }
            const resultado = errores.length ? 'error' : 'ok';
            ponerSync('ultimo_intento', JSON.stringify({ cuando: new Date().toISOString(), tipo, resultado, nuevos }));
            if (!usuario) ponerSync('ultimo_auto', Date.now());
            // Siempre: la ventana del banco enseña cuándo fue la última y la próxima.
            avisar({ nuevos, sync: true });
            return errores.length ? { resultado, nuevos, mensaje: errores[0] } : { resultado, nuevos };
        } finally {
            sincronizando = false;
        }
    }

    /** Lo que se enseña de las descargas: cuándo, cuál toca, y si hay límite. */
    function estadoSync() {
        const ultima = config.activa ? conectar().prepare(
            'SELECT MAX(ultima_sincronizacion) AS f FROM cuentas WHERE leer = 1').get().f : null;
        const ultimaMs = ultima ? Date.parse(`${ultima.replace(' ', 'T')}Z`) : null;
        let intento = null;
        try { intento = JSON.parse(leerSync('ultimo_intento') || 'null'); } catch (_) { intento = null; }
        return {
            ultima: ultimaMs ? new Date(ultimaMs).toISOString() : null,
            proxima_auto: new Date(proximaAuto()).toISOString(),
            pausa_auto_hasta: Date.now() < pausaAuto() ? new Date(pausaAuto()).toISOString() : null,
            pausa_manual_hasta: Date.now() < pausaManual() ? new Date(pausaManual()).toISOString() : null,
            auto_hoy: autoHoy(), auto_max: MAX_AUTO_DIA, cada_horas: CADA_MS / 3600e3,
            ultimo_intento: intento
        };
    }

    /**
     * Cuándo toca la siguiente automática: 6 h después de la última buena, no
     * antes de 1 h desde el último intento (si falló, sin martillear), y nunca
     * durante la pausa del banco.
     */
    function proximaAuto() {
        const ultima = config.activa ? conectar().prepare(
            'SELECT MAX(ultima_sincronizacion) AS f FROM cuentas WHERE leer = 1').get().f : null;
        const ultimaMs = ultima ? Date.parse(`${ultima.replace(' ', 'T')}Z`) : 0;
        const intento = Number(leerSync('ultimo_auto') || 0);
        return Math.max(ultimaMs + CADA_MS, intento + 3600e3, pausaAuto(), Date.now());
    }

    function estado() {
        const d = config.activa ? conectar() : null;
        const sesion = d && sesionActiva();
        const cuentas = d ? d.prepare('SELECT * FROM cuentas ORDER BY leer DESC, iban').all() : [];
        return {
            configurado: config.activa,
            conectado: Boolean(sesion),
            banco: sesion ? sesion.banco : null,
            valida_hasta: sesion ? sesion.valida_hasta : null,
            caducada: Boolean(sesion && sesion.valida_hasta && new Date(sesion.valida_hasta) < new Date()),
            sincronizando,
            ultimo_error: ultimoError,
            sync: config.activa ? estadoSync() : null,
            cuentas: cuentas.map(c => ({
                uid: c.uid, iban: ibanCorto(c.iban), nombre: c.nombre, moneda: c.moneda,
                leer: Boolean(c.leer), vigente: Boolean(sesion && c.sesion_id === sesion.id),
                ultima_sincronizacion: c.ultima_sincronizacion, ultimo_error: c.ultimo_error,
                movimientos: d.prepare('SELECT COUNT(*) AS n FROM movimientos WHERE cuenta_uid = ?').get(c.uid).n
            }))
        };
    }

    /** Entiende los conceptos nuevos y cruza con los tiquets. Devuelve los enlazados. */
    function analizar() {
        const d = conectar();
        // También los 'otro': si el lector de conceptos aprende una forma nueva,
        // los que no entendía antes se vuelven a leer.
        const sinLeer = d.prepare(`SELECT id, concepto FROM movimientos
            WHERE (clase IS NULL OR clase = 'otro') AND COALESCE(clase_origen, '') <> 'manual'`).all();
        const guardar = d.prepare(`UPDATE movimientos SET clase = @clase, comercio = @comercio,
            poblacion = @poblacion, persona = @persona, nota = @nota WHERE id = @id`);
        d.transaction(() => {
            for (const m of sinLeer) guardar.run({ id: m.id, ...analisis.parsearConcepto(m.concepto) });
        })();
        let enlazados = 0;
        try {
            enlazados = analisis.cruzar(d, tiquetsDe(baseTiquets()));
            enlazados += cruzarSinImporte();
        } catch (err) {
            console.warn('🏦 No se ha podido cruzar con los tiquets:', err.message);
        }
        categorizar();
        return enlazados;
    }

    /**
     * Tiquets SIN importe (el papel no lo dice o no se leyó) con su cargo del
     * banco: el mismo sitio y el cargo el mismo día o hasta 3 días después.
     * Solo si es inequívoco en los dos sentidos: ese tiquet tiene un único cargo
     * posible y ese cargo un único tiquet posible. El tiquet se queda con el
     * importe del banco (si no, el gasto contaría 0 € al ocultarse el cargo).
     */
    function cruzarSinImporte() {
        const d = conectar();
        const T = baseTiquets();
        const tiquets = T.prepare(`
            SELECT t.id, substr(t.fecha_compra, 1, 10) AS dia, t.establecimiento_id, e.nombre, e.google_nombre,
                   (SELECT group_concat(a.nombre, '|') FROM establecimiento_alias a WHERE a.establecimiento_id = e.id) AS alias
            FROM tickets t LEFT JOIN establecimientos e ON e.id = t.establecimiento_id
            WHERE (t.total_centimos IS NULL OR t.total_centimos = 0)
              AND t.estado IN ('procesado', 'incompleto') AND t.fecha_compra IS NOT NULL`).all();
        if (!tiquets.length) return 0;
        const ocupados = new Set(d.prepare('SELECT tiquet_id FROM movimientos WHERE tiquet_id IS NOT NULL').all().map(f => f.tiquet_id));
        const movs = d.prepare(`
            SELECT m.id, m.fecha, m.importe_centimos, m.comercio, ${EST_MOV} AS establecimiento_id
            FROM movimientos m LEFT JOIN comercios k ON k.clave = ${CLAVE_COMERCIO()}
            WHERE m.tiquet_id IS NULL AND COALESCE(m.enlace, '') <> 'descartado'
              AND m.clase = 'tarjeta' AND m.importe_centimos < 0`).all();
        const masDias = (dia, n) => new Date(Date.parse(`${dia}T12:00:00Z`) + n * 86400e3).toISOString().slice(0, 10);

        const porTiquet = new Map(), porMov = new Map();
        for (const t of tiquets) {
            if (ocupados.has(t.id)) continue;
            const nombres = [t.nombre, t.google_nombre, ...(t.alias ? t.alias.split('|') : [])].filter(Boolean);
            const hasta = masDias(t.dia, 3);
            const cands = movs.filter(m => m.fecha >= t.dia && m.fecha <= hasta && (
                (m.establecimiento_id && m.establecimiento_id === t.establecimiento_id) ||
                nombres.some(n => analisis.nombreCoincide(m.comercio || '', n))));
            porTiquet.set(t.id, cands);
            for (const m of cands) porMov.set(m.id, (porMov.get(m.id) || 0) + 1);
        }
        const enlazar = d.prepare(`UPDATE movimientos SET tiquet_id = ?, enlace = 'auto' WHERE id = ? AND tiquet_id IS NULL`);
        const ponerImporte = T.prepare(`UPDATE tickets SET total_centimos = ?, sin_importe = 0, moneda = COALESCE(moneda, 'EUR')
            WHERE id = ? AND (total_centimos IS NULL OR total_centimos = 0)`);
        let n = 0;
        for (const [tid, cands] of porTiquet) {
            if (cands.length !== 1 || porMov.get(cands[0].id) !== 1) continue;
            if (!enlazar.run(tid, cands[0].id).changes) continue;
            ponerImporte.run(-cands[0].importe_centimos, tid);
            n += 1;
        }
        if (n) console.log(`🏦 ${n} tiquet(s) sin importe enlazados con su cargo del banco (se quedan con su importe).`);
        return n;
    }

    // --- Categorías ---------------------------------------------------------------
    // Por orden: lo puesto a mano; la regla del tipo (Bizum, transferencia…); la
    // categoría del tiquet enlazado; lo aprendido de ese comercio; y lo que
    // falte, Gemini (en segundo plano, ver clasificarConIA).

    const claveDe = (m) => analisis.claveComercio(m.comercio || '');

    function aprender(clave, categoria, origen) {
        if (!clave || !categoria) return;
        const d = conectar();
        const previo = d.prepare('SELECT origen FROM categorias_comercio WHERE clave = ?').get(clave);
        if (previo && previo.origen === 'manual' && origen !== 'manual') return;
        d.prepare(`INSERT OR REPLACE INTO categorias_comercio (clave, categoria, origen, actualizado_at)
                   VALUES (?, ?, ?, CURRENT_TIMESTAMP)`).run(clave, categoria, origen);
    }

    function categorizar() {
        const d = conectar();
        const poner = d.prepare('UPDATE movimientos SET categoria = ?, categoria_origen = ? WHERE id = ?');
        const pendientes = d.prepare(`SELECT id, clase, comercio, concepto, importe_centimos, tiquet_id, categoria_origen FROM movimientos
                                      WHERE COALESCE(categoria_origen, '') NOT IN ('manual')`).all();
        const delTiquet = (id) => {
            try { return (baseTiquets().prepare('SELECT categoria FROM tickets WHERE id = ?').get(id) || {}).categoria || null; }
            catch (_) { return null; }
        };
        const aprendido = d.prepare('SELECT categoria FROM categorias_comercio WHERE clave = ?');
        d.transaction(() => {
            for (const m of pendientes) {
                let cat = null, origen = null;
                if (CATEGORIA_POR_CLASE[m.clase]) { cat = CATEGORIA_POR_CLASE[m.clase]; origen = 'regla'; }
                // Reglas fijas (gasolina de bonÀrea: importe en euros justos).
                else if (m.importe_centimos < 0 &&
                         (cat = categoriaPorRegla(`${m.comercio || ''} ${m.concepto || ''}`, m.importe_centimos))) origen = 'regla';
                else if (m.tiquet_id && (cat = delTiquet(m.tiquet_id))) {
                    origen = 'tiquet';
                    aprender(claveDe(m), cat, 'tiquet');
                } else {
                    const a = claveDe(m) && aprendido.get(claveDe(m));
                    if (a) { cat = a.categoria; origen = 'comercio'; }
                }
                if (cat) poner.run(cat, origen, m.id);
            }
        })();
    }

    let clasificando = false;
    /** Lo que ni las reglas ni lo aprendido saben: a Gemini, por lotes. */
    async function clasificarConIA() {
        if (clasificando || !config.activa) return 0;
        clasificando = true;
        try {
            const d = conectar();
            const sinCategoria = d.prepare(`SELECT DISTINCT comercio, poblacion FROM movimientos
                WHERE categoria IS NULL AND comercio IS NOT NULL AND clase IN ('tarjeta', 'recibo', 'devolucion')`).all();
            const vistos = new Set();
            const lista = sinCategoria.filter(c => {
                const k = analisis.claveComercio(c.comercio);
                if (!k || vistos.has(k)) return false;
                vistos.add(k);
                return true;
            });
            const { clasificarComercios } = require('./ai_service');
            let n = 0;
            for (let i = 0; i < lista.length; i += 60) {
                const lote = lista.slice(i, i + 60);
                const r = await clasificarComercios(lote);
                for (const x of r) {
                    const c = lote[x.i];
                    if (c) { aprender(analisis.claveComercio(c.comercio), x.categoria, 'ia'); n += 1; }
                }
            }
            if (n) { categorizar(); console.log(`🏦 ${n} comercio(s) del banco clasificados con Gemini.`); }
            return n;
        } catch (err) {
            console.warn('🏦 No se han podido clasificar los comercios del banco:', err.message);
            return 0;
        } finally {
            clasificando = false;
        }
    }

    /** Categoría puesta a mano: se aprende y se aplica a ese comercio entero. */
    function ponerCategoria(movimientoId, categoria) {
        const d = conectar();
        const m = d.prepare('SELECT * FROM movimientos WHERE id = ?').get(movimientoId);
        if (!m) return false;
        const cat = String(categoria || '').trim().toUpperCase().slice(0, 30) || null;
        d.prepare(`UPDATE movimientos SET categoria = ?, categoria_origen = ? WHERE id = ?`)
            .run(cat, cat ? 'manual' : null, movimientoId);
        const clave = claveDe(m);
        if (cat && clave && !CATEGORIA_POR_CLASE[m.clase]) {
            aprender(clave, cat, 'manual');
            const otros = d.prepare(`SELECT id, comercio FROM movimientos WHERE id <> ? AND comercio IS NOT NULL
                                     AND COALESCE(categoria_origen, '') <> 'manual'`).all(movimientoId);
            const poner = d.prepare(`UPDATE movimientos SET categoria = ?, categoria_origen = 'comercio' WHERE id = ?`);
            for (const o of otros) if (claveDe(o) === clave) poner.run(cat, o.id);
        }
        return true;
    }

    /** Enlazar a mano un movimiento con un tiquet (o decir que no tiene: null). */
    function enlazar(movimientoId, tiquetId) {
        const d = conectar();
        if (tiquetId) d.prepare('UPDATE movimientos SET tiquet_id = NULL, enlace = NULL WHERE tiquet_id = ? AND id <> ?').run(tiquetId, movimientoId);
        const r = d.prepare(`UPDATE movimientos SET tiquet_id = ?, enlace = ? WHERE id = ?`)
            .run(tiquetId || null, tiquetId ? 'manual' : 'descartado', movimientoId);
        if (tiquetId) { try { comerciosDeTiquets(); } catch (_) { /* se hará en la próxima vuelta */ } }
        return r.changes > 0;
    }

    // --- Comercios → establecimientos ------------------------------------------
    // Cada comercio del banco (tal como lo escribe) apunta a un establecimiento
    // de la base de tiquets. Por orden: lo puesto a mano; el del tiquet de un
    // pago enlazado; y lo que falte, Gemini (nombre de verdad + tipo) y, si es
    // nuevo y tiene sitio, Google Places lo verifica y lo une con el de los
    // tiquets si es el mismo (mismo place_id).

    const establecimientosSrv = () => require('./establecimientos');

    /** Que exista una fila por cada comercio que aparece en los movimientos. */
    function apuntarComercios() {
        conectar().prepare(`
            INSERT OR IGNORE INTO comercios (clave, comercio, poblacion)
            SELECT ${CLAVE_COMERCIO()}, MAX(m.comercio), MAX(m.poblacion) FROM movimientos m
            WHERE m.comercio IS NOT NULL AND TRIM(m.comercio) <> '' AND m.clase IN ${CLASES_COMERCIO}
            GROUP BY 1`).run();
    }

    /** Los establecimientos (id → fila) de la base de tiquets. */
    function establecimientosPorId(ids = null) {
        const filas = baseTiquets().prepare(`SELECT id, nombre, direccion, ciudad, codigo_postal, pais,
            latitud, longitud, geo_precision, place_id, google_estado, google_nombre, google_direccion FROM establecimientos`).all();
        const mapa = new Map(filas.map(e => [e.id, e]));
        return ids ? new Map([...ids].filter(i => mapa.has(i)).map(i => [i, mapa.get(i)])) : mapa;
    }

    /** Lo aprendido de los pagos enlazados con su tiquet: ese comercio es ese sitio. */
    function comerciosDeTiquets() {
        const d = conectar();
        apuntarComercios();
        const filas = d.prepare(`SELECT ${CLAVE_COMERCIO()} AS clave, m.tiquet_id FROM movimientos m
            WHERE m.tiquet_id IS NOT NULL AND m.comercio IS NOT NULL AND m.clase IN ${CLASES_COMERCIO}`).all();
        if (!filas.length) return 0;
        const delTiquet = baseTiquets().prepare(`SELECT e.id, e.nombre FROM tickets t
            JOIN establecimientos e ON e.id = t.establecimiento_id WHERE t.id = ?`);
        const votos = new Map();          // clave -> Map(estId -> { n, nombre })
        for (const f of filas) {
            const e = delTiquet.get(f.tiquet_id);
            if (!e) continue;
            if (!votos.has(f.clave)) votos.set(f.clave, new Map());
            const v = votos.get(f.clave);
            v.set(e.id, { n: ((v.get(e.id) || {}).n || 0) + 1, nombre: e.nombre });
        }
        const actual = d.prepare('SELECT * FROM comercios WHERE clave = ?');
        const poner = d.prepare(`UPDATE comercios SET establecimiento_id = @id, nombre = @nombre, origen = 'tiquet',
            estado = 'resuelto', actualizado_at = CURRENT_TIMESTAMP WHERE clave = @clave`);
        const contarTiquets = baseTiquets().prepare('SELECT COUNT(*) AS n FROM tickets WHERE establecimiento_id = ?');
        let n = 0;
        for (const [clave, v] of votos) {
            const [id, { nombre }] = [...v].sort((a, b) => b[1].n - a[1].n)[0];
            const c = actual.get(clave);
            if (!c || c.origen === 'manual' || (c.origen === 'tiquet' && c.establecimiento_id === id)) continue;
            const antes = c.establecimiento_id;
            poner.run({ clave, id, nombre });
            n += 1;
            // Si Gemini había creado un establecimiento solo para este comercio, se
            // une al bueno (el del tiquet) en vez de quedarse huérfano.
            if (antes && antes !== id && contarTiquets.get(antes).n === 0 &&
                !d.prepare('SELECT 1 FROM comercios WHERE establecimiento_id = ?').get(antes)) {
                try { establecimientosSrv().unir(id, antes); } catch (_) { /* nada */ }
            }
        }
        return n;
    }

    /** Ids que ya no existen (establecimiento borrado): a resolver de nuevo. */
    function revisarEnlacesRotos() {
        const d = conectar();
        const existentes = establecimientosPorId();
        const marcar = d.prepare(`UPDATE comercios SET establecimiento_id = NULL,
            estado = CASE WHEN origen = 'manual' THEN estado ELSE 'pendiente' END,
            origen = CASE WHEN origen = 'manual' THEN origen ELSE NULL END WHERE clave = ?`);
        for (const c of d.prepare('SELECT clave, establecimiento_id, origen, nombre, tipo, poblacion FROM comercios WHERE establecimiento_id IS NOT NULL').all()) {
            if (existentes.has(c.establecimiento_id)) continue;
            marcar.run(c.clave);
            if (c.origen === 'manual' && c.nombre) asignar(c, c.nombre, c.tipo || 'local', 'manual');
        }
        // Los puestos a mano en un solo pago: si su establecimiento ya no está, vuelve al del comercio.
        const quitar = d.prepare('UPDATE movimientos SET est_propio = NULL WHERE id = ?');
        for (const f of d.prepare('SELECT id, est_propio FROM movimientos WHERE est_propio IS NOT NULL').all()) {
            if (!existentes.has(f.est_propio)) quitar.run(f.id);
        }
    }

    /** Pone el comercio `c` en el establecimiento llamado `nombre` (lo crea si hace falta). */
    function asignar(c, nombre, tipo, origen) {
        const limpio = String(nombre || '').trim().toUpperCase().slice(0, 100);
        if (!limpio) return null;
        const online = tipo === 'online';
        const srv = establecimientosSrv();
        const r = srv.asegurar(limpio, { ciudad: enTitulo(c.poblacion), online });
        conectar().prepare(`UPDATE comercios SET nombre = ?, tipo = ?, establecimiento_id = ?, origen = ?,
            estado = 'resuelto', actualizado_at = CURRENT_TIMESTAMP WHERE clave = ?`)
            .run(limpio, tipo, r.id, origen, c.clave);
        if (r.nuevo && !online) { try { require('./lugares').encolar(r.id); } catch (_) { /* en la próxima ronda */ } }
        return r.id;
    }

    let identificando = false;
    /** Los comercios sin establecimiento: a Gemini, por lotes. */
    async function identificarConIA() {
        if (identificando) return 0;
        identificando = true;
        try {
            const d = conectar();
            const pendientes = d.prepare(`SELECT * FROM comercios WHERE estado = 'pendiente' ORDER BY clave LIMIT 1000`).all();
            if (!pendientes.length) return 0;
            // Mis establecimientos, de los más usados a los menos: Gemini usa ese
            // nombre exacto si es el mismo comercio.
            const conocidos = baseTiquets().prepare(`SELECT e.nombre FROM establecimientos e
                LEFT JOIN tickets t ON t.establecimiento_id = e.id
                GROUP BY e.nombre ORDER BY COUNT(t.id) DESC LIMIT 400`).all().map(x => x.nombre);
            const { identificarComercios } = require('./ai_service');
            let n = 0;
            for (let i = 0; i < pendientes.length; i += 60) {
                const lote = pendientes.slice(i, i + 60);
                const r = await identificarComercios(lote, conocidos);
                db_transaccion(() => {
                    for (const x of r) {
                        const c = lote[x.i];
                        // Puede haberse resuelto mientras tanto (a mano o por un tiquet).
                        const ahora = c && d.prepare('SELECT estado FROM comercios WHERE clave = ?').get(c.clave);
                        if (!ahora || ahora.estado !== 'pendiente') continue;
                        if (asignar(c, x.nombre, x.tipo, 'ia')) n += 1;
                    }
                });
            }
            if (n) {
                console.log(`🏦 ${n} comercio(s) del banco identificados con Gemini.`);
                avisar({ comercios: n });
            }
            return n;
        } finally {
            identificando = false;
        }
    }
    // asignar() escribe en las dos bases: sin transacción común, una a una.
    const db_transaccion = (fn) => fn();

    let resolviendo = false;
    /** Todo el proceso: filas nuevas, enlaces rotos, lo de los tiquets y Gemini. */
    async function resolverComercios() {
        if (resolviendo || !config.activa) return;
        resolviendo = true;
        try {
            apuntarComercios();
            revisarEnlacesRotos();
            comerciosDeTiquets();
            await identificarConIA();
        } catch (err) {
            console.warn('🏦 No se han podido identificar los comercios del banco:', err.message);
        } finally {
            resolviendo = false;
        }
    }

    /**
     * Establecimiento puesto a mano para el comercio de un movimiento (vale para
     * todos los movimientos de ese comercio). { id } uno existente; { nombre }
     * por nombre (se crea si no existe); ninguno = volver a lo automático.
     */
    /**
     * Cambia el establecimiento de un pago. Por defecto SOLO de ese pago
     * (est_propio). Con `todos`, el de su comercio: todos los pagos con el mismo
     * nombre en el banco (y este vuelve a seguir al comercio).
     */
    function ponerEstablecimiento(movimientoId, { id = null, nombre = null, place_id = null, todos = false } = {}) {
        if (todos) {
            ponerEstablecimientoComercio(movimientoId, { id, nombre, place_id });
            conectar().prepare('UPDATE movimientos SET est_propio = NULL WHERE id = ?').run(movimientoId);
            return true;
        }
        const d = conectar();
        apuntarComercios();
        const fila = d.prepare('SELECT id FROM movimientos m WHERE m.id = ? AND m.comercio IS NOT NULL').get(movimientoId);
        if (!fila) { const e = new Error('Este movimiento no es una compra en un comercio.'); e.estado = 400; throw e; }
        let estId = null;
        if (id) {
            if (!establecimientosPorId().get(Number(id))) { const err = new Error('Ese establecimiento no existe.'); err.estado = 404; throw err; }
            estId = Number(id);
        } else if (place_id || String(nombre || '').trim()) {
            const limpio = String(nombre || '').trim().toUpperCase().slice(0, 100);
            if (!limpio) { const err = new Error('Falta el nombre del establecimiento.'); err.estado = 400; throw err; }
            const r = establecimientosSrv().asegurar(limpio, {});
            estId = r.id;
            if (place_id) {
                const final = require('./lugares').aplicarPlaceId(r.id, String(place_id));
                if (!final) { const err = new Error('Ese sitio de Google ya no está en memoria: vuelve a buscarlo.'); err.estado = 400; throw err; }
                estId = final;
            } else if (r.nuevo) {
                try { require('./lugares').encolar(r.id); } catch (_) { /* en la próxima ronda */ }
            }
        }
        // Vacío (o el mismo que su comercio) = vuelve a seguir al comercio.
        const k = d.prepare(`SELECT k.establecimiento_id FROM movimientos m LEFT JOIN comercios k ON k.clave = ${CLAVE_COMERCIO()} WHERE m.id = ?`).get(movimientoId);
        if (k && k.establecimiento_id === estId) estId = null;
        d.prepare('UPDATE movimientos SET est_propio = ? WHERE id = ?').run(estId, movimientoId);
        return true;
    }

    /** El establecimiento de un comercio entero: todos sus pagos. */
    function ponerEstablecimientoComercio(movimientoId, { id = null, nombre = null, place_id = null } = {}) {
        const d = conectar();
        apuntarComercios();
        const fila = d.prepare(`SELECT ${CLAVE_COMERCIO()} AS clave FROM movimientos m WHERE m.id = ? AND m.comercio IS NOT NULL`).get(movimientoId);
        if (!fila) { const e = new Error('Este movimiento no es una compra en un comercio.'); e.estado = 400; throw e; }
        const c = d.prepare('SELECT * FROM comercios WHERE clave = ?').get(fila.clave);
        if (id) {
            const e = establecimientosPorId().get(Number(id));
            if (!e) { const err = new Error('Ese establecimiento no existe.'); err.estado = 404; throw err; }
            d.prepare(`UPDATE comercios SET establecimiento_id = ?, nombre = ?, origen = 'manual', estado = 'resuelto',
                actualizado_at = CURRENT_TIMESTAMP WHERE clave = ?`).run(e.id, e.nombre, c.clave);
        } else if (place_id) {
            // Un sitio de Google elegido en el buscador: su establecimiento (el que
            // ya lo tenga, o uno nuevo verificado con él).
            const lugares = require('./lugares');
            const nuevoId = asignar(c, nombre || c.comercio, 'local', 'manual');
            const final = nuevoId ? lugares.aplicarPlaceId(nuevoId, String(place_id)) : null;
            if (!final) { const err = new Error('Ese sitio de Google ya no está en memoria: vuelve a buscarlo.'); err.estado = 400; throw err; }
            const e = establecimientosPorId().get(final);
            d.prepare(`UPDATE comercios SET establecimiento_id = ?, nombre = ?, origen = 'manual', estado = 'resuelto',
                actualizado_at = CURRENT_TIMESTAMP WHERE clave = ?`).run(final, e ? e.nombre : nombre, c.clave);
        } else if (String(nombre || '').trim()) {
            asignar(c, nombre, c.tipo === 'online' ? 'online' : (c.tipo || 'local'), 'manual');
        } else {
            d.prepare(`UPDATE comercios SET establecimiento_id = NULL, nombre = NULL, origen = NULL, estado = 'pendiente'
                WHERE clave = ?`).run(c.clave);
            resolverComercios().catch(() => {});
        }
        return true;
    }

    /**
     * Los cargos del banco de un establecimiento: los de sus comercios y los
     * enlazados con alguno de sus tiquets. Para saber "qué sitio es este".
     */
    function movimientosDeEstablecimiento(estId, tiquetIds = [], limite = 10) {
        if (!config.activa) return { total: 0, movimientos: [] };
        const ids = tiquetIds.filter(Number.isInteger);
        const cond = `(${EST_MOV} = @est${ids.length ? ` OR m.tiquet_id IN (${ids.join(',')})` : ''})`;
        const d = conectar();
        const desde = `FROM movimientos m JOIN cuentas c ON c.uid = m.cuenta_uid
            LEFT JOIN comercios k ON k.clave = ${CLAVE_COMERCIO()} WHERE c.leer = 1 AND ${cond}`;
        return {
            total: d.prepare(`SELECT COUNT(*) AS n ${desde}`).get({ est: estId }).n,
            movimientos: d.prepare(`SELECT m.id, m.fecha, m.importe_centimos, m.moneda, m.concepto, m.comercio,
                    m.poblacion, m.clase, m.tiquet_id ${desde} ORDER BY m.fecha DESC, m.id DESC LIMIT ${Number(limite) || 10}`)
                .all({ est: estId })
        };
    }

    /**
     * Cuántos cargos del banco tiene cada establecimiento: por su comercio o,
     * si no, por el tiquet con el que está enlazado. `tiquetEst`: tiquet -> establecimiento.
     */
    function cargosPorEstablecimiento(tiquetEst = new Map()) {
        const cuenta = new Map();
        if (!config.activa) return cuenta;
        const filas = conectar().prepare(`SELECT ${EST_MOV} AS est, m.tiquet_id
            FROM movimientos m JOIN cuentas c ON c.uid = m.cuenta_uid
            LEFT JOIN comercios k ON k.clave = ${CLAVE_COMERCIO()}
            WHERE c.leer = 1 AND m.importe_centimos < 0`).all();
        for (const f of filas) {
            const est = f.est || (f.tiquet_id ? tiquetEst.get(f.tiquet_id) : null);
            if (est) cuenta.set(est, (cuenta.get(est) || 0) + 1);
        }
        return cuenta;
    }

    /**
     * El pago del banco de un tiquet: el movimiento enlazado o, si no hay, los
     * cargos con tarjeta de esos días (de 1 antes a 5 después), del importe más
     * parecido al menos.
     */
    function pagoDeTiquet(tiquetId) {
        if (!config.activa) return { activo: false };
        const d = conectar();
        const enlazado = d.prepare('SELECT id FROM movimientos WHERE tiquet_id = ?').get(tiquetId);
        if (enlazado) return { activo: true, movimiento: movimiento(enlazado.id), candidatos: [] };
        const t = baseTiquets().prepare(`SELECT substr(fecha_compra, 1, 10) AS dia,
            COALESCE(total_eur_centimos, total_centimos) AS total FROM tickets WHERE id = ?`).get(tiquetId);
        if (!t || !t.dia) return { activo: true, movimiento: null, candidatos: [] };
        const masDias = (n) => new Date(Date.parse(`${t.dia}T12:00:00Z`) + n * 86400e3).toISOString().slice(0, 10);
        let ests = new Map();
        try { ests = establecimientosPorId(); } catch (_) { /* nada */ }
        const candidatos = d.prepare(`
            SELECT m.id, m.fecha, m.importe_centimos, m.moneda, m.comercio, m.poblacion, m.concepto,
                   k.nombre AS nombre_comercio, ${EST_MOV} AS establecimiento_id
            FROM movimientos m JOIN cuentas c ON c.uid = m.cuenta_uid
            LEFT JOIN comercios k ON k.clave = ${CLAVE_COMERCIO()}
            WHERE c.leer = 1 AND m.tiquet_id IS NULL AND m.importe_centimos < 0 AND m.clase = 'tarjeta'
              AND m.fecha BETWEEN ? AND ?`).all(masDias(-1), masDias(5))
            .map(m => ({ ...m, nombre: ((ests.get(m.establecimiento_id) || {}).nombre) || m.nombre_comercio || m.comercio,
                         diferencia: t.total != null ? Math.abs(-m.importe_centimos - t.total) : null }))
            .sort((a, b) => (a.diferencia ?? 1e12) - (b.diferencia ?? 1e12)).slice(0, 6);
        return { activo: true, movimiento: null, candidatos };
    }

    /** Al unir dos establecimientos, los comercios del que se va pasan al que se queda. */
    function establecimientoUnido(destino, origen) {
        if (!config.activa) return;
        conectar().prepare('UPDATE comercios SET establecimiento_id = ? WHERE establecimiento_id = ?').run(destino, origen);
        conectar().prepare('UPDATE movimientos SET est_propio = ? WHERE est_propio = ?').run(destino, origen);
    }
    /** Si algún comercio del banco apunta a este establecimiento (para no borrarlo). */
    function usaEstablecimiento(id) {
        if (!config.activa) return false;
        return Boolean(conectar().prepare('SELECT 1 FROM comercios WHERE establecimiento_id = ? LIMIT 1').get(id) ||
            conectar().prepare('SELECT 1 FROM movimientos WHERE est_propio = ? LIMIT 1').get(id));
    }

    /** Tiquets que podrían ser de este movimiento, del más probable al menos. */
    function candidatos(movimientoId) {
        const m = conectar().prepare('SELECT * FROM movimientos WHERE id = ?').get(movimientoId);
        if (!m) return null;
        const f = new Date(`${m.fecha}T12:00:00Z`);
        const desde = new Date(f.getTime() - 10 * 86400e3).toISOString().slice(0, 10);
        const hasta = new Date(f.getTime() + 3 * 86400e3).toISOString().slice(0, 10);
        const importe = Math.abs(m.importe_centimos);
        return tiquetsDe(baseTiquets())(desde, hasta)
            .map(t => ({ id: t.id, dia: t.dia, nombre: t.nombre, total_centimos: t.total_centimos,
                         diferencia: Math.abs((t.total_eur_centimos || t.total_centimos) - importe) }))
            .sort((a, b) => a.diferencia - b.diferencia).slice(0, 12);
    }

    /**
     * Extracto importado (filas ya leídas del Excel en el navegador). Va a la
     * cuenta cuyo IBAN viene en el fichero; lo que ya estaba —por la API o por
     * una importación anterior— no se duplica.
     */
    function importar({ iban, filas }) {
        const d = conectar();
        const limpio = String(iban || '').replace(/\s+/g, '').toUpperCase();
        const cuenta = d.prepare(`SELECT uid FROM cuentas WHERE REPLACE(UPPER(iban), ' ', '') = ?`).get(limpio);
        if (!cuenta) throw Object.assign(new Error('El IBAN del extracto no es el de ninguna cuenta conectada.'), { estado: 400 });
        const cuenta_uid = cuenta.uid;
        const r = { nuevos: 0, repetidos: 0, emparejados: 0, descartados: 0 };
        const vistos = new Map();
        d.transaction(() => {
            for (const f of filas || []) {
                const fecha = String(f.fecha || '').slice(0, 10);
                const importe = Math.round(Number(f.importe) * 100);
                if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || !Number.isFinite(importe) || importe === 0) { r.descartados += 1; continue; }
                const saldo = Number.isFinite(Number(f.saldo)) ? Math.round(Number(f.saldo) * 100) : null;
                // Huella del apunte: con el saldo de después es única y estable entre importaciones.
                const base = `${cuenta_uid}|f|${fecha}|${importe}|${saldo ?? ''}`;
                const n = (vistos.get(base) || 0) + 1;
                vistos.set(base, n);
                const fila = {
                    cuenta_uid, clave: n > 1 ? `${base}|${n}` : base, fecha,
                    fecha_valor: /^\d{4}-\d{2}-\d{2}$/.test(String(f.fecha_valor || '')) ? f.fecha_valor : null,
                    importe_centimos: importe, concepto: String(f.concepto || '').trim() || null,
                    crudo: JSON.stringify(f)
                };
                const res = insertarSinDuplicar(d, fila, 'fichero');
                if (res === 'nuevo') r.nuevos += 1;
                else if (res === 'emparejado') r.emparejados += 1;
                else r.repetidos += 1;
            }
        })();
        analizar();
        clasificarConIA().catch(() => {});
        console.log(`🏦 Extracto importado: ${r.nuevos} nuevos, ${r.emparejados} ya estaban por la API, ${r.repetidos} repetidos.`);
        return r;
    }

    // Los tipos que se pueden poner a mano, según el sentido del movimiento.
    const CLASES_CARGO = ['tarjeta', 'bizum_enviado', 'transferencia_enviada', 'recibo', 'comision', 'otro'];
    const CLASES_ABONO = ['bizum_recibido', 'transferencia_recibida', 'devolucion', 'otro'];

    /**
     * Cambiar a mano el tipo (una transferencia que en realidad es un Bizum). Si
     * la categoría salía del tipo, se recalcula; todo lo demás (historial,
     * cifras, panel de Bizum) lee el tipo al momento.
     */
    function cambiarClase(movimientoId, clase) {
        const d = conectar();
        const m = d.prepare('SELECT importe_centimos, categoria_origen, concepto FROM movimientos WHERE id = ?').get(movimientoId);
        if (!m) return false;
        const validas = m.importe_centimos < 0 ? CLASES_CARGO : CLASES_ABONO;
        if (!validas.includes(clase)) throw Object.assign(new Error('Ese tipo no vale para este movimiento.'), { estado: 400 });
        // Persona y comercio, si al cambiar de tipo hacen falta y el concepto los trae.
        const leido = analisis.parsearConcepto(m.concepto);
        let persona = leido.persona;
        if (!persona && clase.startsWith('bizum')) {
            const p = String(m.concepto || '').match(/(?:\bDE|\bA)\s+([^,]+?)(?:,|\s+CONCEPTO|$)/i);
            persona = p ? p[1].trim() : null;
        }
        d.prepare(`UPDATE movimientos SET clase = ?, clase_origen = 'manual',
                   persona = COALESCE(persona, ?),
                   categoria = CASE WHEN COALESCE(categoria_origen, '') IN ('manual', 'tiquet') THEN categoria ELSE NULL END,
                   categoria_origen = CASE WHEN COALESCE(categoria_origen, '') IN ('manual', 'tiquet') THEN categoria_origen ELSE NULL END,
                   tiquet_id = CASE WHEN ? = 'tarjeta' THEN tiquet_id ELSE NULL END
                   WHERE id = ?`).run(clase, persona, clase, movimientoId);
        categorizar();
        return true;
    }

    /** Pago compartido: entre cuántos (null = no) y, si no fue a partes iguales, mi parte. */
    function marcarCompartido(movimientoId, entre, parte) {
        const n = Number(entre);
        // 1 = revisado y pagado solo por mí (no vuelve a preguntarse); null = sin mirar.
        const e = Number.isInteger(n) && n >= 1 && n <= 100 ? n : null;
        const p = e > 1 && parte !== null && parte !== undefined && parte !== '' ? Math.abs(Math.round(Number(parte))) : null;
        return conectar().prepare('UPDATE movimientos SET compartido_entre = ?, mi_parte_centimos = ? WHERE id = ?')
            .run(e, Number.isFinite(p) ? p : null, movimientoId).changes > 0;
    }

    /** Que un movimiento cuente o no como gasto. */
    function marcarExcluir(movimientoId, excluir) {
        return conectar().prepare('UPDATE movimientos SET excluir = ? WHERE id = ?')
            .run(excluir ? 1 : 0, movimientoId).changes > 0;
    }

    function movimiento(id) {
        const m = conectar().prepare(`SELECT m.*, c.iban, c.nombre AS cuenta_nombre,
                k.nombre AS nombre_comercio, ${EST_MOV} AS establecimiento_id, k.tipo AS comercio_tipo, k.origen AS comercio_origen,
                k.estado AS comercio_estado
            FROM movimientos m JOIN cuentas c ON c.uid = m.cuenta_uid
            LEFT JOIN comercios k ON k.clave = ${CLAVE_COMERCIO()} WHERE m.id = ?`).get(id);
        if (!m) return null;
        delete m.crudo;
        let est = null;
        try { est = m.establecimiento_id ? establecimientosPorId([m.establecimiento_id]).get(m.establecimiento_id) || null : null; }
        catch (_) { est = null; }
        // Cuántos pagos comparten comercio con este: a cuántos afectaría cambiarlo para todos.
        let pagosComercio = 0, estComercio = null;
        if (m.comercio) {
            const k = conectar().prepare(`SELECT COUNT(*) AS n, MAX(k.establecimiento_id) AS est FROM movimientos m
                LEFT JOIN comercios k ON k.clave = ${CLAVE_COMERCIO()}
                WHERE ${CLAVE_COMERCIO()} = (SELECT ${CLAVE_COMERCIO()} FROM movimientos m WHERE m.id = ?)`).get(id);
            pagosComercio = k ? k.n : 0;
            estComercio = k ? k.est : null;
        }
        return { ...m, iban: ibanCorto(m.iban), nombre: (est && est.nombre) || m.nombre_comercio || null, establecimiento: est,
                 pagos_comercio: pagosComercio, est_comercio: estComercio };
    }

    /** Bizum e ingresos de un periodo: lo que no es gasto se cuenta aquí aparte. */
    function resumen({ desde = null, hasta = null } = {}) {
        if (!config.activa) return null;
        const cond = ['c.leer = 1'], params = {};
        if (desde) { cond.push('m.fecha >= @desde'); params.desde = desde; }
        if (hasta) { cond.push('m.fecha <= @hasta'); params.hasta = hasta; }
        return conectar().prepare(`
            SELECT
                COALESCE(SUM(CASE WHEN m.clase = 'bizum_enviado'  THEN -m.importe_centimos END), 0) AS bizum_enviado,
                COALESCE(SUM(CASE WHEN m.clase = 'bizum_enviado'  THEN 1 END), 0)                    AS bizum_enviados,
                COALESCE(SUM(CASE WHEN m.clase = 'bizum_recibido' THEN m.importe_centimos END), 0)  AS bizum_recibido,
                COALESCE(SUM(CASE WHEN m.clase = 'bizum_recibido' THEN 1 END), 0)                    AS bizum_recibidos,
                COALESCE(SUM(CASE WHEN m.importe_centimos > 0 AND m.clase NOT IN ('bizum_recibido', 'devolucion')
                                  THEN m.importe_centimos END), 0)                                    AS ingresos
            FROM movimientos m JOIN cuentas c ON c.uid = m.cuenta_uid
            WHERE ${cond.join(' AND ')}`).get(params);
    }

    function enlaces() {
        if (!config.activa) return [];
        return conectar().prepare('SELECT tiquet_id, id FROM movimientos WHERE tiquet_id IS NOT NULL').all();
    }

    // --- Suscripciones ------------------------------------------------------------
    // Las detectadas por el ritmo de los cargos, con lo que yo haya dicho encima:
    // confirmada (con mis correcciones), descartada, o añadida a mano.

    const MESES_RITMO = { mensual: 1, trimestral: 3, anual: 12 };
    const hoyIso = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' });
    /** `fecha` + n meses, con el día ajustado al último del mes si no existe. */
    function sumarMeses(fecha, n) {
        const [a, m, d] = fecha.split('-').map(Number);
        const ultimoDia = new Date(Date.UTC(a, m - 1 + n + 1, 0)).getUTCDate();
        return new Date(Date.UTC(a, m - 1 + n, Math.min(d, ultimoDia))).toISOString().slice(0, 10);
    }
    /** La primera fecha del ritmo que cae hoy o después. */
    function avanzar(fecha, ritmo, hoy = hoyIso()) {
        const paso = MESES_RITMO[ritmo] || 1;
        let f = fecha, n = 0;
        while (f < hoy && n++ < 600) f = sumarMeses(fecha, paso * n);
        return f;
    }
    const mensualDe = (importe, ritmo) => Math.round(importe / (MESES_RITMO[ritmo] || 1));

    function suscripciones() {
        const d = conectar();
        const hoy = hoyIso();
        let movs = [];
        if (config.activa) {
            analizar();
            movs = d.prepare(`
                SELECT m.id, m.fecha, m.importe_centimos, m.clase, m.comercio,
                       k.nombre AS nombre_comercio, ${EST_MOV} AS establecimiento_id
                FROM movimientos m JOIN cuentas c ON c.uid = m.cuenta_uid
                LEFT JOIN comercios k ON k.clave = ${CLAVE_COMERCIO()}
                WHERE c.leer = 1`).all();
            let ests = new Map();
            try { ests = establecimientosPorId(); } catch (_) { /* sin base de tiquets */ }
            for (const m of movs) m.nombre = ((ests.get(m.establecimiento_id) || {}).nombre) || m.nombre_comercio || null;
        }
        const detectadas = config.activa ? analisis.detectarSuscripciones(movs) : [];
        const ajustes = new Map(d.prepare('SELECT * FROM suscripciones').all().map(a => [a.clave, a]));

        const resultado = [];
        for (const s of detectadas) {
            const clave = analisis.claveComercio(s.comercio);
            const a = ajustes.get(clave);
            ajustes.delete(clave);
            const x = { ...s, clave, origen: 'detectada', estado: a ? a.estado : 'detectada' };
            if (a && a.estado === 'confirmada') {
                if (a.nombre) x.nombre = a.nombre;
                if (a.importe_centimos) x.importe_centimos = x.importe_medio_centimos = a.importe_centimos;
                if (a.ritmo && a.ritmo !== x.ritmo) { x.ritmo = a.ritmo; x.proximo = sumarMeses(x.ultimo, MESES_RITMO[a.ritmo]); }
                if (a.proximo) x.proximo = a.proximo;
                x.proximo = avanzar(x.proximo, x.ritmo, hoy);
                x.activa = true;      // la he confirmado: cuenta aunque parezca de baja
                x.mensual_centimos = mensualDe(x.importe_medio_centimos, x.ritmo);
            }
            if (a && a.estado === 'descartada') x.activa = false;
            resultado.push(x);
        }
        // Las añadidas a mano (o de un comercio que no llega a detectarse).
        for (const a of ajustes.values()) {
            if (a.estado !== 'confirmada') continue;
            const ritmo = MESES_RITMO[a.ritmo] ? a.ritmo : 'mensual';
            const cargos = a.clave.startsWith('manual:') ? []
                : movs.filter(m => m.importe_centimos < 0 && m.comercio && analisis.claveComercio(m.comercio) === a.clave)
                      .sort((x, y) => x.fecha.localeCompare(y.fecha));
            const ultimo = cargos.length ? cargos[cargos.length - 1] : null;
            const importe = a.importe_centimos || (ultimo ? -ultimo.importe_centimos : 0);
            const base = a.proximo || (ultimo ? sumarMeses(ultimo.fecha, MESES_RITMO[ritmo]) : hoy);
            resultado.push({
                clave: a.clave, origen: 'manual', estado: 'confirmada',
                comercio: a.nombre || (ultimo && (ultimo.nombre || ultimo.comercio)) || 'Suscripción',
                nombre: a.nombre || (ultimo && (ultimo.nombre || ultimo.comercio)) || 'Suscripción',
                ritmo, importe_centimos: importe, importe_medio_centimos: importe, subida: false,
                cargos: cargos.length, ultimo: ultimo ? ultimo.fecha : '',
                proximo: avanzar(base, ritmo, hoy), activa: true, mensual_centimos: mensualDe(importe, ritmo)
            });
        }
        // La previsión usa `comercio`: que lleve el nombre bonito.
        for (const x of resultado) x.comercio = x.nombre || x.comercio;
        return resultado.sort((a, b) => (b.activa - a.activa) || String(a.proximo).localeCompare(String(b.proximo)));
    }

    function exigirRitmo(ritmo) {
        if (ritmo != null && !MESES_RITMO[ritmo]) { const e = new Error('Ritmo no válido (mensual, trimestral o anual).'); e.estado = 400; throw e; }
    }
    const limpioFecha = (f) => (f && /^\d{4}-\d{2}-\d{2}$/.test(f) ? f : null);

    /** Confirmar (con correcciones) o descartar una; estado null = volver a lo detectado. */
    function ponerSuscripcion(clave, { estado = 'confirmada', nombre = null, importe_centimos = null, ritmo = null, proximo = null } = {}) {
        const d = conectar();
        if (estado === null) { d.prepare('DELETE FROM suscripciones WHERE clave = ?').run(clave); return true; }
        if (!['confirmada', 'descartada'].includes(estado)) { const e = new Error('Estado no válido.'); e.estado = 400; throw e; }
        exigirRitmo(ritmo);
        const importe = importe_centimos == null || importe_centimos === '' ? null : Math.abs(Math.round(Number(importe_centimos)));
        d.prepare(`INSERT INTO suscripciones (clave, estado, nombre, importe_centimos, ritmo, proximo)
                   VALUES (@clave, @estado, @nombre, @importe, @ritmo, @proximo)
                   ON CONFLICT(clave) DO UPDATE SET estado = excluded.estado, nombre = excluded.nombre,
                     importe_centimos = excluded.importe_centimos, ritmo = excluded.ritmo, proximo = excluded.proximo`)
            .run({ clave: String(clave).slice(0, 120), estado, nombre: String(nombre || '').trim().slice(0, 80) || null,
                   importe: Number.isFinite(importe) && importe > 0 ? importe : null, ritmo, proximo: limpioFecha(proximo) });
        return true;
    }

    /** Una nueva, desde un movimiento (su comercio) o escrita a mano. Devuelve su clave. */
    function crearSuscripcion({ movimiento_id = null, nombre = null, importe_centimos = null, ritmo = 'mensual', proximo = null } = {}) {
        exigirRitmo(ritmo);
        let clave = null;
        if (movimiento_id) {
            const m = conectar().prepare('SELECT comercio, importe_centimos, fecha FROM movimientos WHERE id = ?').get(movimiento_id);
            if (!m || !m.comercio) { const e = new Error('Ese movimiento no es un pago en un comercio.'); e.estado = 400; throw e; }
            clave = analisis.claveComercio(m.comercio);
            if (importe_centimos == null) importe_centimos = -m.importe_centimos;
            if (!proximo) proximo = sumarMeses(m.fecha, MESES_RITMO[ritmo] || 1);
        }
        if (!clave) {
            if (!String(nombre || '').trim()) { const e = new Error('Ponle un nombre.'); e.estado = 400; throw e; }
            clave = `manual:${crypto.randomUUID()}`;
        }
        ponerSuscripcion(clave, { estado: 'confirmada', nombre, importe_centimos, ritmo, proximo });
        return clave;
    }

    function listarMovimientos({ limite = 100, desde = null, hasta = null, filtro = null } = {}) {
        if (!config.activa) return [];
        analizar();
        const cond = ['c.leer = 1'], params = {};
        if (filtro === 'sin_tiquet') cond.push(`m.clase = 'tarjeta' AND m.importe_centimos < 0 AND m.tiquet_id IS NULL AND COALESCE(m.enlace, '') <> 'descartado'`);
        else if (filtro === 'con_tiquet') cond.push('m.tiquet_id IS NOT NULL');
        else if (filtro === 'bizum') cond.push(`m.clase LIKE 'bizum%'`);
        else if (filtro === 'ingresos') cond.push('m.importe_centimos > 0');
        // Para el historial unificado: lo que NO está ya representado por su tiquet.
        else if (filtro === 'historial') cond.push('m.tiquet_id IS NULL');
        if (desde) { cond.push('m.fecha >= @desde'); params.desde = desde; }
        if (hasta) { cond.push('m.fecha <= @hasta'); params.hasta = hasta; }
        const filas = conectar().prepare(`
            SELECT m.id, m.fecha, m.importe_centimos, m.moneda, m.concepto, m.contraparte, m.tipo,
                   m.tiquet_id, m.enlace, m.categoria, m.clase, m.comercio, m.poblacion, m.persona, m.nota,
                   m.excluir, m.compartido_entre, m.mi_parte_centimos, c.iban,
                   k.nombre AS nombre_comercio, ${EST_MOV} AS establecimiento_id
            FROM movimientos m JOIN cuentas c ON c.uid = m.cuenta_uid
            LEFT JOIN comercios k ON k.clave = ${CLAVE_COMERCIO()}
            WHERE ${cond.join(' AND ')}
            ORDER BY m.fecha DESC, m.id DESC LIMIT ${Math.min(Math.max(Number(limite) || 100, 1), 10000)}
        `).all(params);
        // El nombre que se enseña: el del establecimiento (que Google puede haber
        // corregido); si no, el que dio Gemini o yo. El del banco sigue en comercio.
        let ests = new Map();
        try { ests = establecimientosPorId(); } catch (_) { /* sin base de tiquets */ }
        return filas.map(m => ({
            ...m, iban: ibanCorto(m.iban),
            nombre: ((ests.get(m.establecimiento_id) || {}).nombre) || m.nombre_comercio || null
        }));
    }

    function arrancar({ retrasoMs = 20_000 } = {}) {
        if (!config.activa) {
            console.log('🏦 Banco DESACTIVADO: falta ENABLEBANKING_APP_ID o la clave.');
            return false;
        }
        console.log('🏦 Banco configurado: descarga de movimientos cada 6 horas.');
        setTimeout(() => { analizar(); clasificarConIA().catch(() => {}); resolverComercios().catch(() => {}); }, retrasoMs).unref?.();
        // Un reloj que mira cada 10 min si toca (ver proximaAuto). Así un
        // servidor que estuvo parado, o un portátil que se durmió, se pone al día
        // solo en cuanto vuelve, y reiniciar varias veces no gasta el cupo.
        const mirar = () => {
            try {
                if (!sincronizando && Date.now() >= proximaAuto() && autoHoy() < MAX_AUTO_DIA) {
                    sincronizar().catch(() => {});
                }
            } catch (_) { /* sin base todavía */ }
        };
        setTimeout(mirar, retrasoMs).unref?.();
        const i = setInterval(mirar, 10 * 60 * 1000);
        if (i.unref) i.unref();
        return true;
    }

    return { config, iniciarConexion, completarConexion, marcarCuenta, sincronizar, estado, listarMovimientos,
             analizar, enlazar, candidatos, enlaces, suscripciones, ponerSuscripcion, crearSuscripcion, marcarExcluir, movimiento,
             ponerCategoria, clasificarConIA, resumen, marcarCompartido, importar, cambiarClase, arrancar,
             resolverComercios, ponerEstablecimiento, establecimientoUnido, usaEstablecimiento, movimientosDeEstablecimiento, cargosPorEstablecimiento, pagoDeTiquet };
}

let unico = null;
const banco = () => {
    if (unico) return unico;
    unico = crearBanco({
        avisar: (datos) => { try { require('./eventos').emitir('cambio', { ruta: '/banco', origen: null, ...datos }); } catch (_) {} }
    });
    // Las uniones de establecimientos (a mano o por Google) se reflejan aquí.
    try { require('./establecimientos').cuandoSeUnan((d, o) => unico.establecimientoUnido(d, o)); } catch (_) { /* sin base de tiquets */ }
    return unico;
};

module.exports = {
    banco,
    // para las pruebas
    crearBanco, abrirBase, rutaBaseBanco, CLAVE_COMERCIO, crearJwt, insertarSinDuplicar, normConcepto, normalizarMovimiento, aCentimos, leerConfiguracion
};
