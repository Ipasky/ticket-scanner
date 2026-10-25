/**
 * Arnés compartido por las pruebas de API (tests/api_*.test.js).
 *
 * Hace tres cosas, y el orden importa:
 *   1. Apunta TICKETS_DB_PATH y TICKETS_UPLOADS_DIR a una carpeta temporal, para
 *      no mirar ni tocar database/tickets.db ni uploads/ del proyecto.
 *   2. Mete un doble de ai_service en require.cache ANTES de que nadie cargue la
 *      app, para que el controlador reciba ese y no llame a Gemini.
 *   3. Registra los hooks before/after/beforeEach del fichero que lo requiera.
 *
 * El runner de Node ejecuta cada fichero de prueba en su propio proceso, así que
 * cada uno tiene su base temporal y su doble, sin interferencias.
 */
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

// --- 1. AISLAMIENTO ---------------------------------------------------------

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-scanner-test-'));
process.env.TICKETS_DB_PATH     = path.join(TMP, 'tickets.db');
process.env.TICKETS_UPLOADS_DIR = path.join(TMP, 'uploads');
fs.mkdirSync(process.env.TICKETS_UPLOADS_DIR, { recursive: true });

// Autenticación. Estas pruebas van de tiquets, no de sesiones, así que usan el
// modo más barato de satisfacer: proxy con una cabecera fija, que `pedir` y
// `subirFoto` añaden a cada petición. Así no hay que arrastrar cookies por todas
// las pruebas y, sobre todo, se comprueba de paso que la protección NO estorba
// cuando la identidad está presente.
// Lo específico de autenticación se prueba en auth_local.test.js y
// auth_proxy.test.js, cada uno en su proceso y con su propio AUTH_MODE.
// Un fichero de prueba puede fijar AUTH_MODE antes de requerir esta ayuda si le
// hace falta otro modo.
if (!process.env.AUTH_MODE) {
    process.env.AUTH_MODE                  = 'proxy';
    process.env.AUTH_PROXY_HEADER          = 'x-usuario-prueba';
    // Obligatoria en modo proxy y aplicada de verdad: las pruebas hablan con el
    // servidor por 127.0.0.1, así que es lo que hay que admitir. El servidor
    // escucha en un socket IPv6, de modo que la conexión llega como
    // '::ffff:127.0.0.1' y la comparación la desmapea; se pone también '::1' por
    // si algún día el arnés se conecta por IPv6.
    process.env.AUTH_PROXY_IPS_PERMITIDAS  = '127.0.0.1,::1';
}
const CABECERA_IDENTIDAD = { 'x-usuario-prueba': 'usuario-de-prueba' };

// --- 2. DOBLE DE LA IA ------------------------------------------------------

/** Igual que el ErrorIA real: el controlador mira .tipo/.status/.mensaje. */
class ErrorIAFalso extends Error {
    constructor({ tipo, status, mensaje, causa }) {
        super(mensaje);
        this.name    = 'ErrorIA';
        this.tipo    = tipo;
        this.status  = status ?? null;
        this.mensaje = mensaje;
        this.causa   = causa ?? null;
    }
}

// Cada prueba decide qué contesta la IA poniendo IA.responder.
//
// `responder` devuelve lo que devolvía la API: el ARRAY de tiquets. El doble lo
// envuelve en { tiquets, modelo } como hace el servicio de verdad desde que hay
// cascada de modelos, para que las pruebas que no van de modelos no tengan que
// enterarse. Una prueba que sí vaya de modelos cambia IA.modelo y lee
// IA.ultimasOpciones para comprobar qué modo le llegó.
const IA = {
    llamadas: 0,
    modelo: 'gemini-de-prueba',
    ultimasOpciones: null,
    // El tipo MIME con el que se llamó: lo que distingue una foto de un PDF, que
    // Gemini lee de forma nativa y por tanto se le manda tal cual.
    ultimoMime: null,
    responder: async () => { throw new Error('La prueba no ha configurado IA.responder'); }
};

// Modelos de pega para el endpoint /api/ia/config. La cascada de verdad se prueba
// en ai_cascada.test.js, con el servicio real y un generador inyectado.
const MODELOS_DE_PRUEBA = ['gemini-bueno-de-prueba', 'gemini-barato-de-prueba'];

const rutaAiService = require.resolve('../src/services/ai_service.js');
const moduloFalso = new Module(rutaAiService, null);
moduloFalso.filename = rutaAiService;
moduloFalso.loaded = true;
moduloFalso.exports = {
    analizarTicket: async (buffer, mimeType, opciones = {}) => {
        IA.llamadas += 1;
        IA.ultimasOpciones = opciones;
        IA.ultimoMime = mimeType;
        const tiquets = await IA.responder(buffer, mimeType, opciones);
        return { tiquets, modelo: IA.modelo, intentos: [] };
    },
    ErrorIA: ErrorIAFalso,
    // app.js los necesita para el endpoint del selector y el controller para
    // validar modo_modelo. Tienen que valer lo mismo que en el módulo real.
    MODELOS: [...MODELOS_DE_PRUEBA],
    MODOS: ['automatico', 'mejor', 'rapido'],
    MODO_AUTOMATICO: 'automatico',
    MODO_MEJOR: 'mejor',
    MODO_RAPIDO: 'rapido',
    configuracionPublica: () => ({
        modelos: [...MODELOS_DE_PRUEBA],
        por_defecto: 'automatico',
        modos: [
            { valor: 'automatico', etiqueta: 'Automático', descripcion: 'x', modelos: [...MODELOS_DE_PRUEBA] },
            { valor: 'mejor',      etiqueta: `Mejor (${MODELOS_DE_PRUEBA[0]})`,  descripcion: 'x', modelos: [MODELOS_DE_PRUEBA[0]] },
            { valor: 'rapido',     etiqueta: `Rápido (${MODELOS_DE_PRUEBA[1]})`, descripcion: 'x', modelos: [MODELOS_DE_PRUEBA[1]] }
        ]
    })
};
require.cache[rutaAiService] = moduloFalso;

// --- APP Y BASE (ya con el doble instalado) ---------------------------------

const app = require('../src/app.js');
const db  = require('../src/config/db.js');
const { UPLOADS_DIR } = require('../src/config/rutas.js');

// `base` se rellena en el before; quien la use la lee de aquí en tiempo de llamada.
const ctx = { base: null };
let servidor;

// --- 3. HOOKS ---------------------------------------------------------------

test.before(async () => {
    servidor = app.listen(0);
    await new Promise(resolve => servidor.once('listening', resolve));
    ctx.base = `http://127.0.0.1:${servidor.address().port}`;
});

test.after(async () => {
    await new Promise(resolve => servidor.close(resolve));
    db.close();
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

test.beforeEach(() => {
    db.exec('DELETE FROM tickets; DELETE FROM establecimientos;');
    IA.llamadas = 0;
    IA.modelo = 'gemini-de-prueba';
    IA.ultimasOpciones = null;
    IA.ultimoMime = null;
    IA.responder = async () => { throw new Error('La prueba no ha configurado IA.responder'); };
});

// --- HELPERS ----------------------------------------------------------------

/** Petición JSON contra la app de pruebas. */
const pedir = async (metodo, ruta, cuerpo, { autenticado = true } = {}) => {
    const opciones = { method: metodo, headers: { ...(autenticado ? CABECERA_IDENTIDAD : {}) } };
    if (cuerpo !== undefined) {
        opciones.headers['Content-Type'] = 'application/json';
        opciones.body = JSON.stringify(cuerpo);
    }
    const res = await fetch(ctx.base + ruta, opciones);
    let datos = null;
    try { datos = await res.json(); } catch (_) {}
    return { status: res.status, datos };
};

/**
 * Sube un archivo por el endpoint real, con multer y todo. El contenido es texto,
 * no una imagen ni un PDF de verdad: nadie los decodifica porque la IA está
 * doblada, y lo que importa es que dos subidas con el MISMO contenido den el
 * mismo SHA-256.
 */
const subirArchivo = async (nombre, contenido, tipo) => {
    const formData = new FormData();
    formData.append('ticket', new Blob([contenido], { type: tipo }), nombre);
    const res = await fetch(ctx.base + '/api/tickets/upload', {
        method: 'POST', body: formData, headers: { ...CABECERA_IDENTIDAD }
    });
    let datos = null;
    try { datos = await res.json(); } catch (_) {}
    return { status: res.status, datos };
};

const subirFoto = (nombre = 'foto.jpg', contenido = `bytes-${Math.random()}`) =>
    subirArchivo(nombre, contenido, 'image/jpeg');

/** Lo mismo con un PDF: las facturas llegan así y se mandan a la IA tal cual. */
const subirPdf = (nombre = 'factura.pdf', contenido = `%PDF-1.7 ${Math.random()}`) =>
    subirArchivo(nombre, contenido, 'application/pdf');

/** Crea el archivo de imagen en la carpeta temporal y devuelve su URL. */
function crearImagen(nombre) {
    fs.writeFileSync(path.join(UPLOADS_DIR, nombre), 'no-es-una-imagen-de-verdad');
    return `/uploads/${nombre}`;
}

function crearEstablecimiento(nombre, extra = {}) {
    return db.prepare(`
        INSERT INTO establecimientos (nombre, direccion, ciudad, codigo_postal)
        VALUES (?, ?, ?, ?)
    `).run(nombre, extra.direccion ?? null, extra.ciudad ?? null, extra.codigo_postal ?? null)
      .lastInsertRowid;
}

/** Inserta una fila de tiquet directamente, para partir del estado que quiera. */
function crearTicket(campos = {}) {
    const nombreArchivo = campos.archivo || `t-${Math.random().toString(36).slice(2)}.jpg`;
    const fila = {
        tipo_documento:     null,
        categoria:          null,
        establecimiento_id: null,
        fecha_compra:       null,
        fecha_evento:       null,
        total_centimos:     null,
        moneda:             null,
        metodo_pago:        null,
        items:              '[]',
        detalles:           '{}',
        ruta_imagen:        crearImagen(nombreArchivo),
        hash_imagen:        `hash-${nombreArchivo}`,
        indice_en_foto:     0,
        total_en_foto:      1,
        recuadro:           null,
        clave_tiquet:       null,
        hora_conocida:      0,
        sin_importe:        0,
        sin_fecha:          0,
        estado:             'procesado',
        ...campos
    };
    delete fila.archivo;

    const info = db.prepare(`
        INSERT INTO tickets (
            tipo_documento, categoria, establecimiento_id, fecha_compra, fecha_evento,
            total_centimos, moneda, metodo_pago, items, detalles,
            ruta_imagen, hash_imagen, indice_en_foto, total_en_foto, recuadro,
            clave_tiquet, hora_conocida, sin_importe, sin_fecha, estado
        ) VALUES (
            @tipo_documento, @categoria, @establecimiento_id, @fecha_compra, @fecha_evento,
            @total_centimos, @moneda, @metodo_pago, @items, @detalles,
            @ruta_imagen, @hash_imagen, @indice_en_foto, @total_en_foto, @recuadro,
            @clave_tiquet, @hora_conocida, @sin_importe, @sin_fecha, @estado
        )
    `).run(fila);

    return { id: Number(info.lastInsertRowid), ruta_imagen: fila.ruta_imagen, archivo: nombreArchivo };
}

const leerFila = (id) => db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);
const leerFilas = () => db.prepare('SELECT * FROM tickets ORDER BY indice_en_foto ASC, id ASC').all();
const contarEstablecimientos = () => db.prepare('SELECT COUNT(*) AS n FROM establecimientos').get().n;
const contarTickets = () => db.prepare('SELECT COUNT(*) AS n FROM tickets').get().n;

module.exports = {
    ctx,
    CABECERA_IDENTIDAD,
    IA,
    MODELOS_DE_PRUEBA,
    ErrorIAFalso,
    db,
    UPLOADS_DIR,
    pedir,
    subirArchivo,
    subirFoto,
    subirPdf,
    crearImagen,
    crearEstablecimiento,
    crearTicket,
    leerFila,
    leerFilas,
    contarEstablecimientos,
    contarTickets
};
