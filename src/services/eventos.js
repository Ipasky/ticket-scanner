'use strict';

/**
 * Avisos en tiempo real a todas las pestañas abiertas (Server-Sent Events).
 *
 * Dos cosas:
 *   · ESCANEOS EN CURSO: al empezar una subida o un reintento se apunta aquí y
 *     se avisa; al terminar, se avisa con los ids que han salido. Así el PC ve
 *     lo que se escanea desde el móvil, y una pestaña recargada a media subida
 *     sigue sabiendo que hay algo analizándose (el servidor no deja de trabajar
 *     porque la pestaña se cierre).
 *   · CAMBIOS: cualquier escritura que salga bien (editar, borrar, unir...) se
 *     avisa para que las demás pestañas recarguen lo que enseñan.
 *
 * Cada pestaña manda una cabecera X-Cliente con su id: los avisos llevan ese
 * origen y la pestaña que hizo el cambio no se repinta dos veces.
 */

const crypto = require('crypto');

const clientes = new Set();
const escaneos = new Map();
// Un escaneo que no termina nunca (el proceso murió a medias, un fallo raro)
// no puede quedarse anunciado para siempre.
const CADUCIDAD_MS = 15 * 60 * 1000;

function emitir(tipo, datos) {
    const linea = `event: ${tipo}\ndata: ${JSON.stringify(datos)}\n\n`;
    for (const res of clientes) {
        try { res.write(linea); } catch (_) { clientes.delete(res); }
    }
}

function escaneosActivos() {
    const ahora = Date.now();
    for (const [id, e] of escaneos) if (ahora - e.inicio > CADUCIDAD_MS) escaneos.delete(id);
    return [...escaneos.values()];
}

/** GET /api/eventos: la conexión que queda abierta. */
function suscribir(req, res) {
    res.set({
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        // Que ningún proxy (Traefik, nginx) se guarde los avisos en un búfer.
        'X-Accel-Buffering': 'no'
    });
    res.flushHeaders();
    res.write('retry: 3000\n\n');
    res.write(`event: hola\ndata: ${JSON.stringify({ escaneos: escaneosActivos() })}\n\n`);
    clientes.add(res);

    // Un comentario cada 25 s: mantiene viva la conexión a través de proxies
    // que cortan lo que lleva un rato callado.
    const latido = setInterval(() => {
        try { res.write(': latido\n\n'); } catch (_) { /* se limpia al cerrar */ }
    }, 25_000);
    req.on('close', () => {
        clearInterval(latido);
        clientes.delete(res);
    });
}

const ES_ESCANEO = (req) => req.method === 'POST' &&
    (req.path === '/upload' || /^\/\d+\/reintentar$/.test(req.path));

/**
 * Middleware para /api/tickets. Se engancha al FINAL de la respuesta (res.end)
 * y no a los eventos del socket: si la pestaña se cierra a media subida, el
 * socket se cierra al momento, pero el análisis sigue y es su final lo que hay
 * que avisar.
 */
function registrarCambios(req, res, next) {
    if (req.method === 'GET' || req.method === 'HEAD') return next();

    const origen = String(req.get('x-cliente') || '').slice(0, 64) || null;
    let escaneo = null;
    if (ES_ESCANEO(req)) {
        escaneo = {
            id: crypto.randomUUID(),
            tipo: req.path === '/upload' ? 'subida' : 'reintento',
            inicio: Date.now(),
            origen
        };
        escaneos.set(escaneo.id, escaneo);
        emitir('escaneo-inicio', escaneo);
    }

    let cuerpo = null;
    const json = res.json.bind(res);
    res.json = (datos) => { cuerpo = datos; return json(datos); };

    let avisado = false;
    const end = res.end.bind(res);
    res.end = (...args) => {
        if (!avisado) {
            avisado = true;
            const ok = res.statusCode < 400;
            if (escaneo) {
                escaneos.delete(escaneo.id);
                const ids = (cuerpo && Array.isArray(cuerpo.ids)) ? cuerpo.ids
                          : (cuerpo && Number.isInteger(cuerpo.id)) ? [cuerpo.id] : [];
                emitir('escaneo-fin', {
                    id: escaneo.id, tipo: escaneo.tipo, origen, ok, ids,
                    resultado: cuerpo && cuerpo.resultado,
                    mensaje: cuerpo && (cuerpo.mensaje || cuerpo.error)
                });
            }
            // Buscar en Google no cambia nada.
            if (ok && !req.path.startsWith('/lugares/')) emitir('cambio', { metodo: req.method, ruta: req.originalUrl, origen });
        }
        return end(...args);
    };
    next();
}

module.exports = { suscribir, registrarCambios, emitir, escaneosActivos };
