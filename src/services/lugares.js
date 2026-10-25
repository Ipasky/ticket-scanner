'use strict';

/**
 * Establecimientos verificados con Google Places.
 *
 * Por cada establecimiento nuevo se busca en Google "nombre + dirección +
 * ciudad". Con lo que vuelve:
 *
 *   · un candidato claro (el nombre casa y está donde dice el tiquet)
 *       -> 'verificado': nombre, dirección y punto exactos de Google, y su
 *          place_id. Si otro establecimiento ya tenía ese place_id, son el
 *          mismo sitio y se unen solos.
 *   · varios plausibles, o uno dudoso -> 'por_confirmar': se guardan los
 *          candidatos y se elige en la ficha del establecimiento.
 *   · nada -> 'sin_resultados': se queda con la geocodificación de Nominatim.
 *
 * Igual que la geocodificación: en segundo plano, nunca durante una subida, y
 * sin clave (GOOGLE_PLACES_API_KEY) no hace nada.
 *
 * Coste: Text Search Pro tiene 5.000 consultas gratis al mes; aquí se hace una
 * (dos como mucho) por establecimiento nuevo. El refresco de coordenadas (las
 * condiciones de Google no dejan guardarlas más de 30 días) usa Place Details
 * Essentials, con 10.000 gratis.
 */

const db = require('../config/db');
const geo = require('./geocodificacion');
const establecimientos = require('./establecimientos');
const { upperCase } = require('./normalizacion');

const { sinAcentos, cpNormal } = establecimientos;

const URL_BUSCAR = 'https://places.googleapis.com/v1/places:searchText';
const URL_DETALLE = 'https://places.googleapis.com/v1/places/';
const CAMPOS_BUSQUEDA = [
    'places.id', 'places.displayName', 'places.formattedAddress', 'places.location',
    'places.addressComponents', 'places.primaryTypeDisplayName', 'places.googleMapsUri',
    'places.businessStatus'
].join(',');
const ESPERA_MS = 200;
const TIMEOUT_MS = 10_000;
const MAX_CANDIDATOS = 5;
const DIAS_REFRESCO = 30;
const CADA_MS = 6 * 3600 * 1000;

function leerConfiguracion(entorno = process.env) {
    const clave = String(entorno.GOOGLE_PLACES_API_KEY || '').trim();
    return { clave, activa: clave.length > 0 };
}

// --- STATEMENTS ----------------------------------------------------------------

const STMT_EST = db.prepare('SELECT * FROM establecimientos WHERE id = ?');
const STMT_PENDIENTES = db.prepare(
    `SELECT id FROM establecimientos WHERE google_estado = 'pendiente' ORDER BY id ASC LIMIT 500`
);
const STMT_OTRO_CON_PLACE = db.prepare(
    'SELECT id FROM establecimientos WHERE place_id = ? AND id <> ?'
);
const STMT_VERIFICAR = db.prepare(`
    UPDATE establecimientos SET
        nombre = @nombre, direccion = @direccion, ciudad = @ciudad,
        codigo_postal = @codigo_postal, pais = @pais,
        place_id = @place_id, google_estado = 'verificado',
        google_nombre = @google_nombre, google_direccion = @google_direccion,
        google_candidatos = NULL, google_actualizado_at = CURRENT_TIMESTAMP,
        latitud  = CASE WHEN geo_precision = 'manual' AND @forzar = 0 THEN latitud  ELSE @latitud  END,
        longitud = CASE WHEN geo_precision = 'manual' AND @forzar = 0 THEN longitud ELSE @longitud END,
        geo_estado    = CASE WHEN geo_precision = 'manual' AND @forzar = 0 THEN geo_estado ELSE 'ok' END,
        geo_mensaje   = CASE WHEN geo_precision = 'manual' AND @forzar = 0 THEN geo_mensaje ELSE NULL END,
        geo_precision = CASE WHEN geo_precision = 'manual' AND @forzar = 0 THEN 'manual' ELSE 'google' END
    WHERE id = @id
`);
const STMT_ESTADO = db.prepare(`
    UPDATE establecimientos SET google_estado = @estado, google_candidatos = @candidatos,
           google_actualizado_at = CURRENT_TIMESTAMP
    WHERE id = @id
`);
const STMT_GUARDAR_CANDIDATOS = db.prepare(`
    UPDATE establecimientos SET google_candidatos = @candidatos,
           google_estado = CASE WHEN google_estado = 'verificado' THEN google_estado ELSE @estado END
    WHERE id = @id
`);
const STMT_DESVINCULAR = db.prepare(`
    UPDATE establecimientos SET
        place_id = NULL, google_nombre = NULL, google_direccion = NULL,
        google_candidatos = NULL, google_estado = 'descartado',
        latitud  = CASE WHEN geo_precision = 'google' THEN NULL ELSE latitud END,
        longitud = CASE WHEN geo_precision = 'google' THEN NULL ELSE longitud END,
        geo_estado = CASE WHEN geo_precision = 'google' THEN 'pendiente' ELSE geo_estado END,
        geo_precision = CASE WHEN geo_precision = 'google' THEN NULL ELSE geo_precision END
    WHERE id = ?
`);
const STMT_MARCAR_PENDIENTE = db.prepare(`
    UPDATE establecimientos SET google_estado = 'pendiente', google_candidatos = NULL
    WHERE id = ? AND place_id IS NULL AND COALESCE(geo_precision, '') <> 'online'
`);
const STMT_A_REFRESCAR = db.prepare(`
    SELECT id, place_id FROM establecimientos
    WHERE place_id IS NOT NULL
      AND (google_actualizado_at IS NULL OR google_actualizado_at < datetime('now', ?))
    ORDER BY google_actualizado_at ASC LIMIT 50
`);
const STMT_REFRESCAR = db.prepare(`
    UPDATE establecimientos SET google_actualizado_at = CURRENT_TIMESTAMP,
        latitud  = CASE WHEN geo_precision = 'google' THEN @latitud  ELSE latitud  END,
        longitud = CASE WHEN geo_precision = 'google' THEN @longitud ELSE longitud END
    WHERE id = @id
`);
const STMT_PLACE_PERDIDO = db.prepare(`
    UPDATE establecimientos SET place_id = NULL, google_estado = 'pendiente' WHERE id = ?
`);
const STMT_CONTAR = db.prepare(`
    SELECT google_estado AS estado, COUNT(*) AS n FROM establecimientos GROUP BY google_estado
`);

// --- CANDIDATOS ----------------------------------------------------------------

/** La parte de la dirección antes del código postal o la ciudad. */
function calleDe(formateada, cp, ciudad) {
    const partes = String(formateada || '').split(',').map(p => p.trim()).filter(Boolean);
    const c = sinAcentos(ciudad);
    const i = partes.findIndex(p => (cp && p.includes(cp)) || (c && sinAcentos(p).includes(c)));
    return i > 0 ? partes.slice(0, i).join(', ') : '';
}

function candidatoDe(p) {
    const comp = (tipo) => {
        const c = (p.addressComponents || []).find(x => (x.types || []).includes(tipo));
        return c ? (c.longText || c.shortText || '') : '';
    };
    const ciudad = comp('locality') || comp('postal_town') ||
                   comp('administrative_area_level_3') || comp('administrative_area_level_2');
    const cp = comp('postal_code');
    const latitud = Number(p.location && p.location.latitude);
    const longitud = Number(p.location && p.location.longitude);
    return {
        place_id: p.id,
        nombre: (p.displayName && p.displayName.text) || '',
        direccion_completa: p.formattedAddress || '',
        direccion: calleDe(p.formattedAddress, cp, ciudad) ||
                   [comp('route'), comp('street_number')].filter(Boolean).join(', '),
        ciudad, codigo_postal: cp, pais: comp('country'),
        latitud: Number.isFinite(latitud) ? latitud : null,
        longitud: Number.isFinite(longitud) ? longitud : null,
        tipo: (p.primaryTypeDisplayName && p.primaryTypeDisplayName.text) || '',
        url: p.googleMapsUri || '',
        cerrado: p.businessStatus === 'CLOSED_PERMANENTLY'
    };
}

// --- DECIDIR -------------------------------------------------------------------

const RUIDO = new Set([
    'sl', 'sa', 'slu', 'sau', 'sccl', 'scp', 'sociedad', 'limitada', 'anonima',
    'the', 'del', 'las', 'los', 'les', 'and', 'com', 'tienda', 'botiga'
]);
const VIAS = new Set([
    'carrer', 'calle', 'avinguda', 'avenida', 'avda', 'plaza', 'placa', 'passeig', 'paseo',
    'ronda', 'carretera', 'ctra', 'camino', 'cami', 'travessera', 'travesia', 'via', 'street',
    'road', 'rue', 'poligono', 'poligon', 'nave'
]);
const palabras = (s) => sinAcentos(s).replace(/[^a-z0-9ñç]+/g, ' ').split(' ')
    .filter(t => t.length >= 3 && !RUIDO.has(t));
const compacto = (s) => sinAcentos(s).replace(/[^a-z0-9]+/g, '');

function nombreCoincide(a, b) {
    const ca = compacto(a), cb = compacto(b);
    if (ca.length >= 3 && cb.includes(ca)) return true;
    if (cb.length >= 3 && ca.includes(cb)) return true;
    const ta = palabras(a), tb = palabras(b);
    if (!ta.length || !tb.length) return false;
    const comunes = ta.filter(t => tb.some(u =>
        u === t || (Math.min(t.length, u.length) >= 5 && (u.startsWith(t) || t.startsWith(u)))));
    return comunes.length > 0 && comunes.length / Math.min(ta.length, tb.length) >= 0.5;
}

function puntuar(est, c) {
    const donde = sinAcentos(c.direccion_completa);
    const calle = palabras(geo.calleSinNumero(est.direccion)).filter(t => !VIAS.has(t) && t.length >= 4);
    const numero = (String(est.direccion || '').match(/\d+/) || [''])[0];
    const lugar = sinAcentos(est.lugar_inferido).split(',').map(p => p.trim()).filter(p => p.length > 2);
    const s = {
        nombre: nombreCoincide(est.nombre, c.nombre),
        cp: Boolean(cpNormal(est.codigo_postal)) && cpNormal(est.codigo_postal) === cpNormal(c.codigo_postal),
        ciudad: Boolean(sinAcentos(est.ciudad)) && donde.includes(sinAcentos(est.ciudad)),
        lugar: lugar.some(p => donde.includes(p)),
        calle: calle.length > 0 && calle.some(t => donde.includes(t)),
        numero: Boolean(numero) && new RegExp(`(^|\\D)${numero}(\\D|$)`).test(c.direccion_completa)
    };
    s.enSitio = s.cp || s.ciudad || s.lugar || s.calle;
    return s;
}

/**
 * Qué hacer con lo que ha devuelto Google:
 *   { accion: 'verificar', candidato } | { accion: 'confirmar' } | { accion: 'nada' }
 * Conservador: verificar solo cuando no hay duda razonable. Lo dudoso se
 * pregunta, que es un clic; lo verificado mal es un dato equivocado que no se ve.
 */
function decidir(est, candidatos) {
    if (!candidatos.length) return { accion: 'nada' };
    // Coordenadas puestas a mano: siempre se pregunta antes de tocarlas.
    if (est.geo_precision === 'manual') return { accion: 'confirmar' };

    const abiertos = candidatos.filter(c => !c.cerrado).map(c => ({ c, s: puntuar(est, c) }));
    const buenos = abiertos.filter(x => x.s.nombre && x.s.enSitio);
    if (buenos.length === 1) return { accion: 'verificar', candidato: buenos[0].c };
    if (buenos.length > 1) {
        const numero = /\d/.test(String(est.direccion || ''));
        const finos = buenos.filter(x => x.s.calle && (x.s.numero || !numero));
        if (finos.length === 1) return { accion: 'verificar', candidato: finos[0].c };
        return { accion: 'confirmar' };
    }
    // El nombre no casa (el tiquet lleva la razón social) pero solo hay un
    // resultado y está exactamente en la dirección impresa.
    if (abiertos.length === 1) {
        const s = abiertos[0].s;
        if (s.calle && s.numero && (s.cp || s.ciudad)) return { accion: 'verificar', candidato: abiertos[0].c };
    }
    return { accion: 'confirmar' };
}

/** Las búsquedas a probar, de más a menos concreta. */
function consultasDe(est) {
    const zona = est.ciudad || est.lugar_inferido || '';
    const completa = [est.nombre, est.direccion, est.codigo_postal, zona, est.pais]
        .filter(Boolean).join(' ');
    const corta = [est.nombre, zona || est.codigo_postal].filter(Boolean).join(' ');
    return [...new Set([completa, corta])].filter(q => q.trim() && q !== est.nombre);
}

// --- EL SERVICIO -----------------------------------------------------------------

function crearLugares({
    config = leerConfiguracion(),
    hacerPeticion = fetch,
    dormir = (ms) => new Promise(r => setTimeout(r, ms))
} = {}) {
    const cola = new Set();
    let trabajando = false;
    let pausado = false;
    // Un 400/403 de Google es la clave o la facturación: no se arregla
    // insistiendo, así que se deja de preguntar hasta reiniciar.
    let averia = null;
    let iniciado = false;

    function errorTemporal(mensaje) {
        const e = new Error(mensaje);
        e.temporal = true;
        return e;
    }

    async function pedir(url, opciones) {
        await dormir(ESPERA_MS);
        let res;
        try {
            res = await hacerPeticion(url, { ...opciones, signal: AbortSignal.timeout(TIMEOUT_MS) });
        } catch (err) {
            throw errorTemporal(`sin conexión con Google (${err.message})`);
        }
        if (res.status === 429 || res.status >= 500) throw errorTemporal(`Google ha respondido ${res.status}`);
        if (res.status === 404) return null;
        if (!res.ok) {
            let detalle = '';
            try { detalle = ((await res.json()).error || {}).message || ''; } catch (_) { /* nada */ }
            averia = `Google Places ha respondido ${res.status}${detalle ? `: ${detalle}` : ''}`;
            console.warn(`📍 ${averia}. Se deja de preguntar hasta reiniciar (¿clave o facturación?).`);
            throw new Error(averia);
        }
        return res.json();
    }

    async function buscar(texto, est = {}) {
        const cuerpo = { textQuery: texto, languageCode: 'es', pageSize: MAX_CANDIDATOS };
        if (Number.isFinite(est.latitud) && Number.isFinite(est.longitud) && est.geo_precision !== 'discrepante') {
            cuerpo.locationBias = {
                circle: { center: { latitude: est.latitud, longitude: est.longitud }, radius: 20000 }
            };
        }
        const datos = await pedir(URL_BUSCAR, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Goog-Api-Key': config.clave,
                'X-Goog-FieldMask': CAMPOS_BUSQUEDA
            },
            body: JSON.stringify(cuerpo)
        });
        return ((datos && datos.places) || []).map(candidatoDe)
            .filter(c => c.place_id && c.latitud !== null && c.longitud !== null);
    }

    /**
     * Deja el establecimiento `id` apuntando al sitio `c` de Google. Si otro ya
     * lo tenía, se une a ese. Devuelve el id con el que queda.
     */
    function aplicar(id, c, { forzar = false } = {}) {
        return db.transaction(() => {
            const otro = STMT_OTRO_CON_PLACE.get(c.place_id, id);
            if (otro) {
                establecimientos.unir(otro.id, id);
                console.log(`📍 Establecimiento ${id} es el mismo sitio que ${otro.id}: unidos.`);
                return otro.id;
            }
            const antes = STMT_EST.get(id);
            STMT_VERIFICAR.run({
                id, forzar: forzar ? 1 : 0,
                nombre: (upperCase(c.nombre) || antes.nombre).slice(0, 100),
                direccion: c.direccion || antes.direccion,
                ciudad: c.ciudad || antes.ciudad,
                codigo_postal: c.codigo_postal || antes.codigo_postal,
                pais: c.pais || antes.pais,
                place_id: c.place_id, google_nombre: c.nombre, google_direccion: c.direccion_completa,
                latitud: c.latitud, longitud: c.longitud
            });
            establecimientos.apuntarAlias(id, antes.nombre);
            return id;
        })();
    }

    async function procesarUno(id, { forzar = false } = {}) {
        const est = STMT_EST.get(id);
        if (!est) return { id, resultado: 'inexistente' };
        if (est.google_estado !== 'pendiente' && !forzar) return { id, resultado: 'ya_resuelto' };

        try {
            let candidatos = [];
            for (const consulta of consultasDe(est)) {
                candidatos = await buscar(consulta, est);
                if (candidatos.length) break;
            }
            const decision = decidir(est, candidatos);
            if (decision.accion === 'verificar') {
                const final = aplicar(id, decision.candidato);
                console.log(`📍 ${est.nombre} → ${decision.candidato.nombre} (${decision.candidato.direccion_completa})`);
                return { id, resultado: final === id ? 'verificado' : 'unido', destino: final };
            }
            if (decision.accion === 'confirmar') {
                STMT_ESTADO.run({ id, estado: 'por_confirmar', candidatos: JSON.stringify(candidatos) });
                return { id, resultado: 'por_confirmar', candidatos: candidatos.length };
            }
            STMT_ESTADO.run({ id, estado: 'sin_resultados', candidatos: null });
            return { id, resultado: 'sin_resultados' };
        } catch (err) {
            if (err.temporal) pausado = true;
            return { id, resultado: 'error', mensaje: err.message };
        }
    }

    async function vaciarCola() {
        if (trabajando) return;
        trabajando = true;
        pausado = false;
        try {
            while (cola.size && !pausado && !averia) {
                const id = cola.values().next().value;
                cola.delete(id);
                await procesarUno(id);
            }
        } finally {
            trabajando = false;
            cola.clear();     // lo que quede sigue 'pendiente' en la base
        }
    }

    async function refrescar() {
        for (const f of STMT_A_REFRESCAR.all(`-${DIAS_REFRESCO} days`)) {
            if (averia) return;
            try {
                const p = await pedir(URL_DETALLE + encodeURIComponent(f.place_id), {
                    headers: { 'X-Goog-Api-Key': config.clave, 'X-Goog-FieldMask': 'id,location' }
                });
                if (!p) { STMT_PLACE_PERDIDO.run(f.id); cola.add(f.id); continue; }
                const lat = Number(p.location && p.location.latitude);
                const lon = Number(p.location && p.location.longitude);
                if (Number.isFinite(lat) && Number.isFinite(lon)) STMT_REFRESCAR.run({ id: f.id, latitud: lat, longitud: lon });
            } catch (_) {
                return;       // temporal o avería: ya se intentará en la próxima vuelta
            }
        }
    }

    async function ronda() {
        for (const f of STMT_PENDIENTES.all()) cola.add(f.id);
        await vaciarCola();
        await refrescar();
        await vaciarCola();
    }

    function exigirActiva() {
        if (!config.activa) {
            const e = new Error('Falta GOOGLE_PLACES_API_KEY: la búsqueda en Google está desactivada.');
            e.estado = 503;
            throw e;
        }
        if (averia) {
            const e = new Error(averia);
            e.estado = 502;
            throw e;
        }
    }

    // Lo último que se ha buscado desde el editor de tiquets, por place_id: al
    // guardar el tiquet llega solo el id y los datos salen de aquí (no del
    // navegador).
    const recientes = new Map();
    function recordar(candidatos) {
        for (const c of candidatos) {
            recientes.delete(c.place_id);
            recientes.set(c.place_id, { c, cuando: Date.now() });
        }
        while (recientes.size > 300) recientes.delete(recientes.keys().next().value);
    }

    return {
        config,
        decidir,

        /** Búsqueda libre desde el editor de tiquets (sin establecimiento aún). */
        async buscarLibre(texto, cerca = null) {
            exigirActiva();
            const candidatos = await buscar(String(texto || '').trim(), cerca || {});
            recordar(candidatos);
            return candidatos;
        },

        /**
         * El tiquet se guarda con un sitio elegido en el buscador: el
         * establecimiento pasa a ser ese sitio (o se une al que ya lo era).
         * Devuelve el id final, o null si el sitio no está entre lo buscado.
         */
        aplicarPlaceId(id, placeId) {
            const guardado = recientes.get(placeId);
            let c = guardado && Date.now() - guardado.cuando < 3600_000 ? guardado.c : null;
            if (!c) {
                const est = STMT_EST.get(id);
                try { c = JSON.parse((est && est.google_candidatos) || '[]').find(x => x.place_id === placeId); } catch (_) { c = null; }
            }
            if (!c) return null;
            return aplicar(id, c, { forzar: true });
        },
        procesarUno,
        get averia() { return averia; },

        /** Un establecimiento nuevo o con la dirección cambiada: a buscar, después. */
        encolar(id) {
            if (!config.activa || !iniciado || !Number.isInteger(id)) return false;
            cola.add(id);
            setImmediate(() => { vaciarCola().catch(() => {}); });
            return true;
        },

        /** La dirección ha cambiado y aún no estaba verificado: se vuelve a buscar. */
        marcarPendiente(id) {
            if (!Number.isInteger(id)) return false;
            STMT_MARCAR_PENDIENTE.run(id);
            return this.encolar(id);
        },

        /** Búsqueda pedida desde la ficha, con el texto que yo escriba. */
        async buscarAhora(id, texto) {
            exigirActiva();
            const est = STMT_EST.get(id);
            if (!est) return null;
            const consulta = String(texto || '').trim() || consultasDe(est)[0] || est.nombre;
            const candidatos = await buscar(consulta, texto ? {} : est);
            STMT_GUARDAR_CANDIDATOS.run({
                id, candidatos: JSON.stringify(candidatos),
                estado: candidatos.length ? 'por_confirmar' : est.google_estado
            });
            return candidatos;
        },

        /** Elegido a mano entre los candidatos guardados. Devuelve el id final. */
        elegir(id, placeId) {
            const est = STMT_EST.get(id);
            if (!est) return null;
            let candidatos = [];
            try { candidatos = JSON.parse(est.google_candidatos || '[]'); } catch (_) { /* nada */ }
            const c = candidatos.find(x => x.place_id === placeId);
            if (!c) return null;
            return aplicar(id, c, { forzar: true });
        },

        /** "No es ninguno": se queda con lo que dé Nominatim o con lo puesto a mano. */
        descartar(id) {
            const est = STMT_EST.get(id);
            if (!est) return false;
            STMT_DESVINCULAR.run(id);
            if (est.geo_precision === 'google') geo.encolar(id);
            return true;
        },

        resumen() {
            const cuenta = Object.fromEntries(STMT_CONTAR.all().map(f => [f.estado, f.n]));
            return { activa: config.activa, averia, ...cuenta };
        },

        arrancar({ retrasoMs = 8000 } = {}) {
            if (!config.activa) {
                console.log('📍 Google Places DESACTIVADO: falta GOOGLE_PLACES_API_KEY.');
                return false;
            }
            iniciado = true;
            console.log('📍 Google Places activo: verificando establecimientos en segundo plano.');
            const t = setTimeout(() => { ronda().catch(() => {}); }, retrasoMs);
            if (t.unref) t.unref();
            const i = setInterval(() => { if (!averia) ronda().catch(() => {}); }, CADA_MS);
            if (i.unref) i.unref();
            return true;
        }
    };
}

const lugares = crearLugares();

module.exports = {
    encolar: (id) => lugares.encolar(id),
    marcarPendiente: (id) => lugares.marcarPendiente(id),
    buscarAhora: (id, texto) => lugares.buscarAhora(id, texto),
    elegir: (id, placeId) => lugares.elegir(id, placeId),
    buscarLibre: (texto, cerca) => lugares.buscarLibre(texto, cerca),
    aplicarPlaceId: (id, placeId) => lugares.aplicarPlaceId(id, placeId),
    descartar: (id) => lugares.descartar(id),
    resumen: () => lugares.resumen(),
    arrancar: (opciones) => lugares.arrancar(opciones),
    // para las pruebas
    crearLugares, decidir, candidatoDe, nombreCoincide, consultasDe, leerConfiguracion
};
