/**
 * Uso de Gemini por modelo: cuántas peticiones lleva hoy cada uno, cuáles han
 * fallado por cuota (429) o por saturación (503) y, cuando Google lo dice, cuál
 * es su límite.
 *
 * La API de Gemini no tiene una forma de consultar el uso ni los límites: eso
 * solo se ve en AI Studio. Así que se cuenta aquí, petición a petición, y los
 * límites se aprenden de los propios 429: Google manda en el error la cuota
 * que se ha agotado (por minuto o por día) y su valor.
 *
 * Las cuotas diarias se renuevan a medianoche de la hora del Pacífico (las 9:00
 * en España en invierno, las 9:00 también en verano: los dos cambian de hora).
 * Se guarda en un JSON junto a la base de tiquets, para no perder el día al
 * reiniciar.
 */
const fs = require('fs');
const path = require('path');

const ZONA_GOOGLE = 'America/Los_Angeles';
const RUTA = path.join(path.dirname(process.env.TICKETS_DB_PATH
    ? path.resolve(process.env.TICKETS_DB_PATH)
    : path.join(__dirname, '../../database/tickets.db')), 'gemini_uso.json');

/** "2026-10-27" en la hora del Pacífico: el día de las cuotas de Google. */
const diaGoogle = (fecha = new Date()) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: ZONA_GOOGLE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(fecha);

/** Cuándo se renueva la cuota diaria: la próxima medianoche del Pacífico. */
function proximaRenovacion(ahora = new Date()) {
    // Desfase del Pacífico ahora mismo (en minutos), sin librerías.
    const enLA = new Date(ahora.toLocaleString('en-US', { timeZone: ZONA_GOOGLE }));
    const enUTC = new Date(ahora.toLocaleString('en-US', { timeZone: 'UTC' }));
    const desfase = (enUTC - enLA) / 60000;
    const [a, m, d] = diaGoogle(ahora).split('-').map(Number);
    return new Date(Date.UTC(a, m - 1, d + 1, 0, 0) + desfase * 60000);
}

let estado = { dia: diaGoogle(), modelos: {} };
try {
    const leido = JSON.parse(fs.readFileSync(RUTA, 'utf8'));
    if (leido && typeof leido === 'object' && leido.modelos) estado = leido;
} catch (_) { /* primera vez o fichero roto: se empieza de cero */ }

let guardado = null;
function guardar() {
    if (guardado) return;
    guardado = setTimeout(() => {
        guardado = null;
        try { fs.writeFileSync(RUTA, JSON.stringify(estado)); } catch (_) { /* sin disco: solo en memoria */ }
    }, 1500);
    if (guardado.unref) guardado.unref();
}

/** El registro de un modelo, con el día al día: al cambiar de día, contadores a cero. */
function registro(modelo) {
    const hoy = diaGoogle();
    if (estado.dia !== hoy) {
        estado.dia = hoy;
        for (const r of Object.values(estado.modelos)) {
            Object.assign(r, { peticiones: 0, ok: 0, cuota: 0, saturado: 0, otros: 0 });
            if (r.agotado_dia) r.agotado_dia = false;
        }
    }
    if (!estado.modelos[modelo]) {
        estado.modelos[modelo] = { peticiones: 0, ok: 0, cuota: 0, saturado: 0, otros: 0,
            limite_dia: null, limite_minuto: null, agotado_dia: false, agotado_hasta: null,
            ultimo_saturado_at: null, ultimo_error: null, ultima_peticion_at: null };
    }
    return estado.modelos[modelo];
}

// Peticiones del último minuto, solo en memoria (para el límite por minuto).
const recientes = new Map();
function contarMinuto(modelo) {
    const ahora = Date.now();
    const lista = (recientes.get(modelo) || []).filter(t => ahora - t < 60000);
    lista.push(ahora);
    recientes.set(modelo, lista);
}

/** Lo que dice el error 429 sobre la cuota: cuál, su valor y cuánto esperar. */
function leerCuota(error) {
    const texto = [error && error.message, error && JSON.stringify(error.error || error.details || '')].join(' ');
    const id = (/"quotaId"\s*:\s*"([^"]+)"/.exec(texto) || [])[1] || '';
    const valor = Number((/"quotaValue"\s*:\s*"?(\d+)/.exec(texto) || [])[1]) || null;
    const espera = Number((/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(texto) || [])[1]) || null;
    const porDia = /PerDay/i.test(id), porMinuto = /PerMinute/i.test(id);
    return { id, valor, espera, porDia, porMinuto };
}

function antes(modelo) {
    const r = registro(modelo);
    r.peticiones += 1;
    r.ultima_peticion_at = new Date().toISOString();
    contarMinuto(modelo);
    guardar();
}
function bien(modelo) {
    const r = registro(modelo);
    r.ok += 1;
    // Si ha respondido, ya no está agotado por minuto.
    if (r.agotado_hasta && new Date(r.agotado_hasta) < new Date()) r.agotado_hasta = null;
    guardar();
}
function mal(modelo, error) {
    const r = registro(modelo);
    const status = Number(error && (error.status || error.code)) ||
        Number((/\b(4\d{2}|5\d{2})\b/.exec(String(error && error.message || '')) || [])[1]) || null;
    const ahora = new Date();
    if (status === 429) {
        r.cuota += 1;
        const c = leerCuota(error);
        if (c.porDia) {
            if (c.valor) r.limite_dia = c.valor;
            r.agotado_dia = true;
            r.agotado_hasta = proximaRenovacion(ahora).toISOString();
        } else {
            if (c.porMinuto && c.valor) r.limite_minuto = c.valor;
            r.agotado_hasta = new Date(ahora.getTime() + (c.espera || 60) * 1000).toISOString();
        }
        r.ultimo_error = { tipo: 'cuota', at: ahora.toISOString(), cuota: c.id || null };
    } else if (status === 503 || status === 500) {
        r.saturado += 1;
        r.ultimo_saturado_at = ahora.toISOString();
        r.ultimo_error = { tipo: 'saturado', at: ahora.toISOString() };
    } else {
        r.otros += 1;
        r.ultimo_error = { tipo: 'otro', at: ahora.toISOString(), status };
    }
    guardar();
}

/** Para la pantalla: los modelos configurados, en orden, con su uso de hoy. */
function resumen(modelos) {
    const ahora = new Date();
    return {
        dia: diaGoogle(ahora),
        renueva_at: proximaRenovacion(ahora).toISOString(),
        modelos: modelos.map(modelo => {
            const r = registro(modelo);
            const agotado = r.agotado_hasta && new Date(r.agotado_hasta) > ahora;
            const saturadoReciente = r.ultimo_saturado_at && ahora - new Date(r.ultimo_saturado_at) < 15 * 60000;
            return {
                modelo,
                peticiones: r.peticiones, ok: r.ok, cuota: r.cuota, saturado: r.saturado,
                ultimo_minuto: (recientes.get(modelo) || []).filter(t => ahora - t < 60000).length,
                limite_dia: r.limite_dia, limite_minuto: r.limite_minuto,
                estado: agotado ? (r.agotado_dia ? 'agotado_dia' : 'agotado_minuto')
                    : saturadoReciente ? 'saturado' : r.peticiones ? 'ok' : 'sin_uso',
                agotado_hasta: agotado ? r.agotado_hasta : null,
                ultimo_saturado_at: r.ultimo_saturado_at,
                ultima_peticion_at: r.ultima_peticion_at
            };
        })
    };
}

/**
 * Engancha el contador al cliente de Gemini: toda petición pasa por aquí, sea
 * de un tiquet o del banco, sin tocar cada sitio que llama.
 */
function vigilar(ai) {
    const original = ai.models.generateContent.bind(ai.models);
    ai.models.generateContent = async (params) => {
        const modelo = params && params.model;
        antes(modelo);
        try {
            const r = await original(params);
            bien(modelo);
            return r;
        } catch (err) {
            mal(modelo, err);
            throw err;
        }
    };
}

module.exports = { vigilar, resumen, leerCuota, proximaRenovacion, diaGoogle, _antes: antes, _bien: bien, _mal: mal };
