/**
 * Geocodificación de establecimientos con Nominatim (OpenStreetMap).
 *
 * Rellena `latitud`/`longitud` para el mapa del panel de finanzas. Tres reglas
 * gobiernan todo lo que hay aquí, y las tres vienen de la política de uso de
 * Nominatim —que es un servicio gratuito mantenido por voluntarios, no una API
 * de pago con un SLA—:
 *
 *   1. **Como máximo una petición por segundo.** La cola es estrictamente
 *      serie y mide el tiempo desde la última petición, no desde el último
 *      arranque: dos tandas seguidas no pueden solaparse.
 *   2. **User-Agent identificativo propio.** Va en NOMINATIM_USER_AGENT y SIN
 *      ÉL LA GEOCODIFICACIÓN NO SE ACTIVA. Mandar peticiones sin identificarse
 *      es la forma más rápida de que bloqueen la IP, y además está prohibido.
 *   3. **Caché permanente.** Cada establecimiento se pregunta UNA vez. El
 *      resultado vive en la propia tabla (`geo_estado`), así que no hay caché
 *      que caduque ni que se pierda al reiniciar.
 *
 * Y una regla del proyecto: **nunca bloquea una subida**. Todo pasa en segundo
 * plano, después de responder; si la red falla, si Nominatim está caído o si
 * devuelve basura, no se rompe nada: el establecimiento se queda sin
 * coordenadas y el mapa simplemente no lo pinta.
 */
const db = require('../config/db');

// Nominatim pide espaciar las peticiones un segundo. Se usa algo más por si el
// reloj y el suyo no están de acuerdo: pasarse de listo aquí sale caro.
const ESPERA_MS = 1100;

// Si una petición se queda colgada, suelta. Sin esto, un Nominatim que acepta la
// conexión y no contesta dejaría la cola parada para siempre.
const TIMEOUT_MS = 10_000;

const URL_POR_DEFECTO = 'https://nominatim.openstreetmap.org/search';

// Cuántos establecimientos se miran de una vez al vaciar la cola pendiente.
const TANDA = 500;

// --- CONFIGURACIÓN -----------------------------------------------------------

function leerConfiguracion(entorno = process.env) {
    const userAgent = String(entorno.NOMINATIM_USER_AGENT || '').trim();
    return {
        userAgent,
        url:   String(entorno.NOMINATIM_URL || '').trim() || URL_POR_DEFECTO,
        // Opcional: Nominatim recomienda un correo de contacto para poder avisar
        // antes de bloquear a nadie.
        email: String(entorno.NOMINATIM_EMAIL || '').trim(),
        // Opcional: acota las búsquedas a un país. Sin esto, una calle sin ciudad
        // puede resolverse en cualquier parte del mundo.
        pais:  String(entorno.GEO_PAIS || '').trim(),
        // La geocodificación se activa SOLA en cuanto hay User-Agent. Sin él
        // queda desactivada, que es lo correcto: es mejor no tener coordenadas
        // que mandar peticiones anónimas a un servicio que las prohíbe.
        activa: userAgent.length > 0
    };
}

/** Resumen para el log de arranque. No imprime secretos (aquí no hay ninguno). */
function resumenDeArranque(config = leerConfiguracion()) {
    if (!config.activa) {
        return '🗺️  Geocodificación DESACTIVADA: falta NOMINATIM_USER_AGENT.\n' +
               '   Nominatim exige identificarse; sin eso no se le pregunta nada y\n' +
               '   el mapa del panel se queda sin puntos.';
    }
    const pendientes = contarPendientes();
    return `🗺️  Geocodificación activa contra ${config.url} (1 petición/segundo).\n` +
           `   ${pendientes} establecimiento(s) por geocodificar.`;
}

// --- STATEMENTS --------------------------------------------------------------

const STMT_ESTABLECIMIENTO = db.prepare(`
    SELECT id, nombre, direccion, ciudad, codigo_postal, pais, lugar_inferido,
           latitud, longitud, geo_estado, geo_precision
    FROM establecimientos WHERE id = ?
`);

const STMT_PENDIENTES = db.prepare(`
    SELECT id FROM establecimientos WHERE geo_estado = 'pendiente' ORDER BY id ASC LIMIT ?
`);

// Lo que el script repasa además de lo pendiente: los que fallaron o no tenían
// datos suficientes ANTES de que la búsqueda fuera escalonada. Con las etapas
// nuevas, un "Miami Platja" que antes no se encontraba ahora cae por código
// postal. Los que tienen coordenadas puestas a mano quedan fuera siempre.
const STMT_REPASABLES = db.prepare(`
    SELECT id FROM establecimientos
     WHERE geo_estado IN ('pendiente', 'fallido', 'sin_datos')
       AND COALESCE(geo_precision, '') NOT IN ('manual', 'online')
     ORDER BY id ASC LIMIT ?
`);

const STMT_CONTAR_PENDIENTES = db.prepare(
    `SELECT COUNT(*) AS n FROM establecimientos WHERE geo_estado = 'pendiente'`
);

// @mensaje es NULL en el caso normal; lleva texto cuando el punto se guarda con
// una reserva que hay que poder leer después (hoy: el código postal del
// resultado no coincide con el del tiquet).
const STMT_GUARDAR_OK = db.prepare(`
    UPDATE establecimientos
       SET latitud = @latitud, longitud = @longitud,
           geo_estado = 'ok', geo_precision = @precision,
           geo_intentado_at = CURRENT_TIMESTAMP, geo_mensaje = @mensaje
     WHERE id = @id AND COALESCE(geo_precision, '') NOT IN ('manual', 'google', 'online')
`);

// Coordenadas pegadas a mano. Precisión 'manual', que es la que la
// geocodificación automática no toca jamás: si me he molestado en copiarlas de
// un mapa, ninguna heurística tiene nada mejor que ofrecer.
const STMT_GUARDAR_MANUAL = db.prepare(`
    UPDATE establecimientos
       SET latitud = @latitud, longitud = @longitud,
           geo_estado = 'ok', geo_precision = 'manual',
           geo_intentado_at = CURRENT_TIMESTAMP, geo_mensaje = NULL
     WHERE id = @id
`);

// Borrar las manuales devuelve el establecimiento al circuito automático: es la
// única forma de deshacer sin tener que tocar la base a mano.
const STMT_LIMPIAR_MANUAL = db.prepare(`
    UPDATE establecimientos
       SET latitud = NULL, longitud = NULL,
           geo_estado = 'pendiente', geo_precision = NULL, geo_mensaje = NULL
     WHERE id = @id
`);

const STMT_GUARDAR_ESTADO = db.prepare(`
    UPDATE establecimientos
       SET geo_estado = @estado, geo_intentado_at = CURRENT_TIMESTAMP, geo_mensaje = @mensaje
     WHERE id = @id
`);

// Al corregir una dirección a mano, las coordenadas viejas apuntan a otro sitio:
// se borran a la vez que se vuelve a marcar para preguntar. Dejarlas puestas
// mientras tanto pondría el punto del mapa en la dirección anterior, que es peor
// que no pintarlo.
// Ojo al WHERE: unas coordenadas manuales NO se borran porque cambie la
// dirección. La dirección puede corregirse por mil motivos (una errata, el
// nombre en otro idioma) y ninguno es razón para tirar un punto que alguien
// colocó mirando un mapa.
const STMT_MARCAR_PENDIENTE = db.prepare(`
    UPDATE establecimientos
       SET geo_estado = 'pendiente', geo_mensaje = NULL,
           latitud = NULL, longitud = NULL, geo_precision = NULL
     WHERE id = ? AND COALESCE(geo_precision, '') NOT IN ('manual', 'google', 'online')
`);

const contarPendientes = () => STMT_CONTAR_PENDIENTES.get().n;

// Lo que el script repasaría: pendientes + los que fallaron antes de que la
// búsqueda fuera escalonada.
const STMT_CONTAR_REPASABLES = db.prepare(`
    SELECT COUNT(*) AS n FROM establecimientos
     WHERE geo_estado IN ('pendiente', 'fallido', 'sin_datos')
       AND COALESCE(geo_precision, '') NOT IN ('manual', 'online')
`);
const contarRepasables = () => STMT_CONTAR_REPASABLES.get().n;

// Los que se situaron con precisión FINA antes de que se comprobara el código
// postal del resultado: hay que volver a preguntarlos para saber si el punto que
// tienen es de donde dice el tiquet. Los manuales quedan fuera, como siempre.
// Dos cosas que hay que repasar con las reglas nuevas:
//   · los finos, para comprobar el código postal del resultado;
//   · los 'inferida', que se situaron antes de que el lugar deducido llevara
//     contexto geográfico y de que se prefiriera el resultado de la provincia
//     correcta. Ahí está el "Montserrat de Valencia" que hay que recolocar.
const FILTRO_REVISABLES_CP = `
     WHERE geo_estado = 'ok'
       AND (
             (geo_precision IN ('exacta', 'calle') AND COALESCE(TRIM(codigo_postal), '') <> '')
          OR geo_precision = 'inferida'
       )
`;
const STMT_REVISABLES_CP = db.prepare(
    `SELECT id FROM establecimientos ${FILTRO_REVISABLES_CP} ORDER BY id ASC LIMIT ?`
);
const STMT_CONTAR_REVISABLES_CP = db.prepare(
    `SELECT COUNT(*) AS n FROM establecimientos ${FILTRO_REVISABLES_CP}`
);
const contarRevisablesCp = () => STMT_CONTAR_REVISABLES_CP.get().n;

const STMT_CONTAR_DISCREPANTES = db.prepare(
    `SELECT COUNT(*) AS n FROM establecimientos WHERE geo_precision = 'discrepante'`
);
const contarDiscrepantes = () => STMT_CONTAR_DISCREPANTES.get().n;

// --- CONSULTA ESCALONADA -----------------------------------------------------
//
// Nominatim no encuentra direcciones que otros buscadores sí. El caso que lo
// motivó: "Baixada Playa Cristal 12, 43892, Miami Platja" —el nombre de la calle
// mezcla catalán y castellano y Miami Platja es un núcleo, no un municipio—. La
// dirección completa no existe para Nominatim, pero el código postal sí.
//
// Así que en vez de preguntar una vez y rendirse, se baja un escalón cada vez:
// de la puerta a la calle, de la calle al barrio, del barrio al pueblo. Se
// guarda CON QUÉ PRECISIÓN se consiguió, porque un punto en el centro del pueblo
// es perfectamente útil para ver dónde gasto, pero el mapa tiene que poder
// decir que es aproximado en vez de fingir que es la puerta del comercio.

// 'discrepante' no es una etapa de la escalera: es el resultado de una etapa
// fina cuyo punto NO cuadra con el código postal del tiquet. Ver
// `codigoPostalEnConflicto`.
const PRECISIONES = ['exacta', 'calle', 'zona', 'localidad', 'inferida', 'discrepante', 'manual', 'google'];

// Las que se consideran "en el sitio" frente a "por la zona". Lo usa la interfaz
// para pintar unos puntos sólidos y otros tenues. 'inferida' NO está: el lugar
// no estaba impreso en el papel, lo dedujo el modelo del contenido, y eso es
// exactamente una ubicación aproximada.
const PRECISIONES_FINAS = new Set(['exacta', 'calle', 'manual', 'google']);

const limpio = (valor) => String(valor == null ? '' : valor).trim();

// --- COHERENCIA CON EL CÓDIGO POSTAL DEL TIQUET ------------------------------
//
// Nominatim devuelve su propio código postal, y a veces no es el que pedimos:
// contesta con lo más parecido que encuentra. Caso real: un 28490 (Becerril de
// la Sierra) resuelto en Madrid capital, con código 280xx, y guardado como
// precisión 'exacta'. Un punto equivocado marcado como exacto es peor que no
// tener punto: el mapa lo pinta sólido y nada dice que no sea el sitio.
//
// Así que cuando los dos códigos postales están y no coinciden, el punto se
// guarda igual —es mejor que nada para ver por dónde cae— pero NO como fino.

/**
 * Un código postal comparable, o '' si no hay nada que comparar.
 *
 * Solo se normalizan los de cinco dígitos (y los de cuatro, que son uno de cinco
 * al que se le ha perdido el cero de delante: en España siempre son cinco). Con
 * cualquier otra forma se devuelve '' y la comprobación no se hace, que es lo
 * correcto: un formato que no se entiende no es una discrepancia.
 */
function normalizarCodigoPostal(valor) {
    const digitos = limpio(valor).match(/^\d{4,5}$/);
    if (!digitos) return '';
    return digitos[0].padStart(5, '0');
}

/**
 * ¿El código postal del resultado contradice al del tiquet?
 *
 * Si falta cualquiera de los dos, NO hay conflicto: no se puede desconfiar de
 * un dato que no existe.
 */
function codigoPostalEnConflicto(delTiquet, delResultado) {
    const a = normalizarCodigoPostal(delTiquet);
    const b = normalizarCodigoPostal(delResultado);
    if (!a || !b) return false;
    return a !== b;
}

/**
 * La calle sin el número del portal.
 *
 *   "Baixada Playa Cristal 12"      -> "Baixada Playa Cristal"
 *   "Carrer de Sants 100, 3r 2a"    -> "Carrer de Sants"
 *   "Avinguda Diagonal"             -> "Avinguda Diagonal" (no había número)
 *
 * Se corta en el primer número suelto: a partir de ahí viene el portal, el piso
 * y la puerta, que es justo lo que Nominatim no encuentra cuando el callejero no
 * lo tiene al detalle. Devuelve '' si no queda nombre de calle.
 */
function calleSinNumero(direccion) {
    const texto = limpio(direccion);
    if (!texto) return '';
    const recortada = texto.replace(/[\s,]+\d+\s*[^\s,]*(?:[\s,].*)?$/, '').trim();
    // Si lo que quedaba era solo un número ("12"), no hay calle que preguntar.
    return /[a-zá-úñç]/i.test(recortada) ? recortada : '';
}

// Cuántos resultados se piden cuando hay un contexto geográfico con el que
// elegir. Con uno solo no se puede preferir nada, y pedir veinte es tráfico
// regalado: con cinco se cubren los homónimos que importan.
const RESULTADOS_A_COMPARAR = 5;

const sinAcentos = (texto) => limpio(texto).toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '');

/**
 * ¿Este resultado de Nominatim cae donde dice el lugar deducido?
 *
 * El lugar viene con su contexto ("Montserrat, Barcelona, Catalunya"), así que
 * se compara cada parte contra la jerarquía administrativa del resultado. Basta
 * con que coincida una —provincia o comunidad suelen bastar— porque el nombre
 * del sitio ya lo ha buscado Nominatim; lo que se comprueba aquí es que no esté
 * a 300 km.
 */
function resultadoEnContexto(resultado, contexto) {
    const partes = sinAcentos(contexto).split(',').map(p => p.trim()).filter(p => p.length > 2);
    if (partes.length === 0) return true;

    const direccion = (resultado && resultado.address) || {};
    const donde = sinAcentos([
        direccion.state, direccion.province, direccion.county, direccion.region,
        direccion.city, direccion.town, direccion.village, direccion.municipality,
        resultado && resultado.display_name
    ].filter(Boolean).join(' | '));

    return partes.some(parte => donde.includes(parte));
}

/**
 * Las consultas a probar, de más precisa a menos, sin repetidas.
 *
 * Devuelve [] si no hay absolutamente nada que preguntar. Ojo: ahora un
 * establecimiento con solo código postal, o solo localidad, SÍ tiene algo que
 * preguntar —la etapa de zona o la de localidad—, así que 'sin_datos' se queda
 * para los que no tienen ni eso.
 */
function consultasEscalonadas(establecimiento, pais = '') {
    const direccion = limpio(establecimiento.direccion);
    const cp        = limpio(establecimiento.codigo_postal);
    const ciudad    = limpio(establecimiento.ciudad);
    const calle     = calleSinNumero(direccion);
    const lugar     = limpio(establecimiento.lugar_inferido);
    const nombre    = limpio(establecimiento.nombre);

    const unir = (...partes) => [...partes, pais].filter(Boolean).join(', ');

    const etapas = [];
    //  1. la dirección completa
    if (direccion) etapas.push({ precision: 'exacta', consulta: unir(direccion, cp, ciudad) });
    //  2. la calle sin número, con el código postal (o la localidad, si no hay)
    if (calle && (cp || ciudad)) etapas.push({ precision: 'calle', consulta: unir(calle, cp, ciudad) });
    //  3. código postal + localidad
    if (cp) etapas.push({ precision: 'zona', consulta: unir(cp, ciudad) });
    //  4. solo la localidad
    if (ciudad) etapas.push({ precision: 'localidad', consulta: unir(ciudad) });

    //  5. el lugar DEDUCIDO del contenido, y solo cuando no hay nada impreso que
    //     preguntar. Un tiquet del "Patronat de la Muntanya de Montserrat" no
    //     lleva calle ni población, pero el lugar es evidente; sin esta etapa se
    //     queda sin ubicar para siempre.
    //
    //     El orden importa, y lo enseñó un error real: "Montserrat" a secas puso
    //     el parking de la montaña de Barcelona en Montserrat (Valencia). Así que
    //     primero el NOMBRE COMPLETO del establecimiento, que no es ambiguo;
    //     luego el nombre junto al lugar; y el lugar solo como último recurso.
    //     Las tres llevan el lugar como CONTEXTO: entre varios resultados se
    //     prefiere el que caiga en esa provincia o comunidad, y el nombre a secas
    //     además lo EXIGE (un "Patronat..." en otra provincia no es el mío).
    if (lugar && !direccion && !ciudad) {
        if (nombre) {
            etapas.push({ precision: 'inferida', consulta: unir(nombre), contexto: lugar, exigirContexto: true });
            etapas.push({ precision: 'inferida', consulta: unir(nombre, lugar), contexto: lugar });
        }
        etapas.push({ precision: 'inferida', consulta: unir(lugar), contexto: lugar });
    }

    // Sin repetir: con una dirección sin número, las etapas 1 y 2 serían la
    // misma consulta y la segunda solo gastaría una petición.
    const vistas = new Set();
    return etapas.filter(e => {
        const clave = e.consulta.toLowerCase();
        if (vistas.has(clave)) return false;
        vistas.add(clave);
        return true;
    });
}

/**
 * La consulta más precisa, o null si no hay ninguna. Se conserva porque es la
 * forma corta de preguntar "¿hay algo que buscar aquí?".
 */
function consultaDe(establecimiento, pais = '') {
    const etapas = consultasEscalonadas(establecimiento, pais);
    return etapas.length ? etapas[0].consulta : null;
}

// --- COORDENADAS PEGADAS A MANO ----------------------------------------------

/**
 * Entiende unas coordenadas copiadas de un mapa.
 *
 * Se admite lo que de verdad sale del portapapeles:
 *   "41.0123, 0.9876"     como las copia Google Maps
 *   "41.0123; 0.9876"     con punto y coma
 *   "41.0123 0.9876"      con un espacio
 *   "41,0123, 0,9876"     con coma decimal, que es lo que pasa en un sistema
 *                         en español y lo que haría fallar a un parseo ingenuo
 *
 * Devuelve { latitud, longitud } o null. Validar el rango importa: una longitud
 * de 200 no es un punto, y un par invertido (longitud donde va la latitud)
 * colocaría el comercio en medio del mar sin que nadie se enterase hasta mirar
 * el mapa.
 */
function parsearCoordenadas(texto) {
    const limpiado = limpio(texto);
    if (!limpiado) return null;

    // Todos los números que haya, con punto o coma decimal.
    const numeros = limpiado.match(/-?\d+(?:[.,]\d+)?/g) || [];

    let latitud, longitud;
    if (numeros.length === 2) {
        [latitud, longitud] = numeros.map(n => Number(n.replace(',', '.')));
    } else if (numeros.length === 4) {
        // Coma decimal: "41,0123, 0,9876" se parte en cuatro trozos.
        latitud  = Number(`${numeros[0]}.${numeros[1]}`);
        longitud = Number(`${numeros[2]}.${numeros[3]}`);
    } else {
        return null;
    }

    if (!Number.isFinite(latitud) || !Number.isFinite(longitud)) return null;
    if (Math.abs(latitud) > 90 || Math.abs(longitud) > 180) return null;
    // 0,0 es un punto real en el golfo de Guinea, pero en este contexto es
    // siempre un campo a medio rellenar.
    if (latitud === 0 && longitud === 0) return null;

    return { latitud, longitud };
}

/** Una coordenada que de verdad lo sea. Nominatim las manda como texto. */
function aCoordenada(valor, tope) {
    const n = Number(valor);
    if (!Number.isFinite(n) || Math.abs(n) > tope) return null;
    return n;
}

// --- EL GEOCODIFICADOR -------------------------------------------------------

/**
 * Fábrica. Existe para poder inyectar la petición HTTP y la espera desde las
 * pruebas: comprobar el respeto del segundo entre peticiones, la cabecera de
 * identificación o qué pasa cuando Nominatim devuelve un 429 llamando al
 * servicio de verdad sería, además de lento, exactamente el abuso que la
 * política prohíbe.
 */
function crearGeocodificador({
    config = leerConfiguracion(),
    hacerPeticion = fetch,
    dormir = (ms) => new Promise(r => setTimeout(r, ms)),
    ahora = () => Date.now()
} = {}) {

    const cola = new Set();      // ids por preguntar, sin repetidos
    let trabajando = false;
    // null y no 0: "todavía no se ha preguntado nada" tiene que distinguirse de
    // "se preguntó en el instante 0", que con un reloj inyectado es un instante
    // como cualquier otro.
    let ultimaPeticion = null;
    // Cuando Nominatim dice "ahora no" (429, 503, o la red cae), se para la cola
    // entera hasta la próxima tanda. Seguir insistiendo es justo lo que no hay
    // que hacer, y además los que quedan NO se marcan como fallidos: el problema
    // no es suyo.
    let pausado = false;
    // El script repasa fallidos y sin_datos; la cola normal, no.
    let forzarEnCola = false;

    /** Espera lo que falte para que haya pasado un segundo desde la anterior. */
    async function respetarElRitmo() {
        if (ultimaPeticion !== null) {
            const transcurrido = ahora() - ultimaPeticion;
            if (transcurrido < ESPERA_MS) await dormir(ESPERA_MS - transcurrido);
        }
        ultimaPeticion = ahora();
    }

    function urlDeConsulta(consulta, varios) {
        const url = new URL(config.url);
        url.searchParams.set('q', consulta);
        url.searchParams.set('format', 'jsonv2');
        // Un solo resultado salvo que haya un contexto geográfico con el que
        // elegir: entonces hacen falta varios para poder preferir el que cae
        // donde toca.
        url.searchParams.set('limit', varios ? String(RESULTADOS_A_COMPARAR) : '1');
        // addressdetails=1 para que venga el código postal DEL RESULTADO, que es
        // con lo que se comprueba que el punto sea de donde decimos que es.
        url.searchParams.set('addressdetails', '1');
        if (config.email) url.searchParams.set('email', config.email);
        return url.toString();
    }

    /**
     * Una consulta. Devuelve { lat, lon } | null (no encontrado), o lanza con
     * `.temporal = true` si el problema no es de esta dirección sino del momento.
     *
     * `contexto` es el lugar deducido ("Montserrat, Barcelona, Catalunya"): entre
     * varios resultados se prefiere el que caiga ahí. Con `exigirContexto`, un
     * resultado que no case se descarta en vez de aceptarse, que es lo que evita
     * poner el parking de la montaña de Barcelona en Montserrat (Valencia).
     */
    async function preguntar(consulta, { contexto = '', exigirContexto = false } = {}) {
        await respetarElRitmo();

        let respuesta;
        try {
            respuesta = await hacerPeticion(urlDeConsulta(consulta, Boolean(contexto)), {
                headers: {
                    // Obligatorio por la política de uso: quien recibe esto tiene
                    // que poder saber quién pregunta y a quién escribir.
                    'User-Agent': config.userAgent,
                    'Accept': 'application/json',
                    'Accept-Language': 'es'
                },
                signal: AbortSignal.timeout(TIMEOUT_MS)
            });
        } catch (error) {
            // Sin red, DNS caído, timeout: nada de esto dice nada sobre la
            // dirección.
            const err = new Error(`no se ha podido preguntar: ${error.message}`);
            err.temporal = true;
            throw err;
        }

        if (respuesta.status === 429 || respuesta.status === 403 || respuesta.status >= 500) {
            const err = new Error(`Nominatim ha respondido ${respuesta.status}`);
            err.temporal = true;
            throw err;
        }
        if (!respuesta.ok) {
            throw new Error(`Nominatim ha respondido ${respuesta.status}`);
        }

        let datos;
        try {
            datos = await respuesta.json();
        } catch (_) {
            // Un HTML de error en vez de JSON es señal de que algo pasa en su
            // lado, no en la dirección.
            const err = new Error('respuesta que no es JSON');
            err.temporal = true;
            throw err;
        }

        if (!Array.isArray(datos) || datos.length === 0) return null;

        // Con contexto, el primero que caiga en esa provincia o comunidad; si
        // ninguno cae y el contexto es obligatorio, se abandona esta etapa.
        let elegido = datos[0];
        if (contexto) {
            const encaja = datos.find(r => resultadoEnContexto(r, contexto));
            if (encaja) elegido = encaja;
            else if (exigirContexto) return null;
        }

        const latitud  = aCoordenada(elegido.lat, 90);
        const longitud = aCoordenada(elegido.lon, 180);
        if (latitud === null || longitud === null) return null;

        // El código postal que dice Nominatim, si lo dice. No siempre viene.
        const direccion = elegido.address || {};
        return { latitud, longitud, codigoPostal: limpio(direccion.postcode) };
    }

    /**
     * Geocodifica UN establecimiento bajando por las etapas hasta que una
     * responda. Nunca lanza.
     *
     * `forzar` salta la caché: lo usa el script para repasar los que fallaron
     * antes de que la búsqueda fuera escalonada.
     */
    async function procesarUno(id, { forzar = false } = {}) {
        const est = STMT_ESTABLECIMIENTO.get(id);
        if (!est) return { id, resultado: 'inexistente' };

        // Lo puesto a mano no se toca NUNCA, ni forzando: si alguien se molestó
        // en copiar unas coordenadas de un mapa, ninguna heurística tiene nada
        // mejor que ofrecer.
        if (est.geo_precision === 'manual') return { id, resultado: 'manual' };
        // Ni lo que ha situado Google Places, que sabe dónde está el comercio.
        if (est.geo_precision === 'google') return { id, resultado: 'google' };

        // La caché: lo que ya se sabe no se vuelve a preguntar. Esto es lo que
        // garantiza "una vez por establecimiento" aunque alguien encole dos veces.
        if (est.geo_estado !== 'pendiente' && !forzar) return { id, resultado: 'ya_resuelto' };

        // El país del establecimiento manda sobre el de por defecto.
        const etapas = consultasEscalonadas(est, est.pais || config.pais);
        if (etapas.length === 0) {
            STMT_GUARDAR_ESTADO.run({
                id, estado: 'sin_datos',
                mensaje: 'sin dirección, código postal, localidad ni lugar deducible'
            });
            return { id, resultado: 'sin_datos' };
        }

        const probadas = [];
        // Un punto de una etapa fina que NO cuadra con el código postal del
        // tiquet. No se acepta: se sigue bajando la escalera, porque la etapa del
        // código postal pregunta explícitamente por el CP del papel y suele caer
        // en el pueblo correcto. Se guarda aquí por si no responde ninguna otra:
        // un punto dudoso y marcado como tal es mejor que ningún punto.
        let dudoso = null;

        for (const etapa of etapas) {
            try {
                const punto = await preguntar(etapa.consulta, {
                    contexto: etapa.contexto || '',
                    exigirContexto: Boolean(etapa.exigirContexto)
                });

                if (!punto) {
                    probadas.push(`${etapa.precision}: sin resultados`);
                    continue;   // se baja un escalón
                }

                // Una etapa fina solo cuenta como fina si el punto cae donde dice
                // el tiquet. Las etapas de zona y localidad ya son aproximadas y
                // preguntan por el código postal o el municipio: ahí no hay nada
                // mejor a lo que bajar.
                if (PRECISIONES_FINAS.has(etapa.precision) &&
                    codigoPostalEnConflicto(est.codigo_postal, punto.codigoPostal)) {

                    const motivo = `el código postal del resultado (${punto.codigoPostal}) no coincide ` +
                                   `con el del tiquet (${limpio(est.codigo_postal)})`;
                    probadas.push(`${etapa.precision}: ${motivo}`);
                    console.warn(
                        `🗺️  ${est.nombre}: ${motivo} en la etapa '${etapa.precision}'. ` +
                        `Se baja a la etapa del código postal en vez de dar ese punto por exacto.`
                    );
                    if (!dudoso) dudoso = { punto, etapa, motivo };
                    continue;
                }

                STMT_GUARDAR_OK.run({
                    id, latitud: punto.latitud, longitud: punto.longitud,
                    precision: etapa.precision, mensaje: null
                });

                if (etapa.precision !== 'exacta') {
                    console.log(
                        `🗺️  ${est.nombre}: ${punto.latitud}, ${punto.longitud} ` +
                        `(precisión ${etapa.precision}; la dirección exacta no se encontró)`
                    );
                } else {
                    console.log(`🗺️  ${est.nombre}: ${punto.latitud}, ${punto.longitud}`);
                }
                return { id, resultado: 'ok', precision: etapa.precision, mensaje: null, ...punto };

            } catch (error) {
                if (error.temporal) {
                    // Se queda 'pendiente' a propósito: volverá a intentarse en la
                    // próxima tanda. Marcarlo 'fallido' por un corte de red sería
                    // condenarlo a no tener coordenadas nunca. Y se corta aquí: si
                    // la red está caída, las etapas siguientes fallarían igual.
                    STMT_GUARDAR_ESTADO.run({ id, estado: 'pendiente', mensaje: error.message });
                    pausado = true;
                    console.warn(
                        `🗺️  Geocodificación en pausa: ${error.message}. ` +
                        `Los pendientes se quedan como están y se reintentan más tarde.`
                    );
                    return { id, resultado: 'temporal', mensaje: error.message };
                }

                // Un error de la consulta (un 400) tampoco invalida las etapas
                // siguientes, que son consultas distintas.
                probadas.push(`${etapa.precision}: ${error.message}`);
            }
        }

        // Ninguna etapa ha dado un punto coherente. Si al menos una dio uno que no
        // cuadraba con el código postal, se guarda ESE: marcado 'discrepante' y
        // con los dos códigos escritos, que es lo que permite decidir luego si
        // vale o hay que pegar las coordenadas a mano.
        if (dudoso) {
            STMT_GUARDAR_OK.run({
                id, latitud: dudoso.punto.latitud, longitud: dudoso.punto.longitud,
                precision: 'discrepante', mensaje: dudoso.motivo
            });
            console.warn(
                `🗺️  ${est.nombre}: ${dudoso.punto.latitud}, ${dudoso.punto.longitud} ` +
                `(ubicación DUDOSA, única que ha respondido: ${dudoso.motivo})`
            );
            return {
                id, resultado: 'ok', precision: 'discrepante',
                mensaje: dudoso.motivo, ...dudoso.punto
            };
        }

        // Ninguna etapa ha dado nada: esto sí es un fallido de verdad.
        const mensaje = `sin resultados en ninguna etapa (${probadas.join('; ')})`;

        // Salvo que el establecimiento YA estuviera situado y esto sea un repaso
        // (el del código postal, por ejemplo): el punto que había sigue siendo lo
        // mejor que hay, y degradarlo a 'fallido' porque hoy Nominatim no
        // contesta sería perder información por nada.
        if (est.latitud !== null && est.longitud !== null) {
            STMT_GUARDAR_ESTADO.run({ id, estado: 'ok', mensaje: `repaso sin resultado: ${mensaje}` });
            console.warn(`🗺️  "${est.nombre}": el repaso no ha encontrado nada; se queda el punto anterior.`);
            return { id, resultado: 'sin_cambios', mensaje };
        }

        STMT_GUARDAR_ESTADO.run({ id, estado: 'fallido', mensaje });
        console.warn(`🗺️  Sin coordenadas para "${est.nombre}": se probaron ${etapas.length} etapa(s).`);
        return { id, resultado: 'fallido', mensaje };
    }

    /** Encola unos ids, los procesa de uno en uno y cuenta lo que queda. */
    async function procesarTanda(ids, { forzar = false } = {}) {
        if (!config.activa) return { encolados: 0, activa: false };

        pausado = false;
        forzarEnCola = forzar;
        for (const id of ids) cola.add(id);
        try {
            await vaciarCola();
        } finally {
            forzarEnCola = false;
        }
        return { encolados: ids.length, activa: true, pendientes: contarPendientes() };
    }

    /** Vacía la cola, de uno en uno. Nunca lanza. */
    async function vaciarCola() {
        trabajando = true;
        try {
            while (cola.size > 0 && !pausado) {
                const id = cola.values().next().value;
                cola.delete(id);
                await procesarUno(id, { forzar: forzarEnCola });
            }
        } finally {
            trabajando = false;
            cola.clear();   // si se ha pausado, lo que quede sigue 'pendiente' en la base
        }
    }

    return {
        config,

        /**
         * Apunta un establecimiento para geocodificar MÁS TARDE y devuelve
         * inmediatamente. Esto es lo que llama el controlador: la subida de un
         * tiquet no espera ni un milisegundo por Nominatim.
         */
        encolar(id) {
            if (!config.activa || !Number.isInteger(id)) return false;
            cola.add(id);
            if (!trabajando) {
                // setImmediate y no await: quien sube un tiquet ya ha recibido su
                // respuesta cuando esto empieza a trabajar.
                setImmediate(() => { vaciarCola().catch(() => {}); });
            }
            return true;
        },

        /** La dirección ha cambiado: lo que hubiera ya no vale. */
        marcarParaRegeocodificar(id) {
            if (!Number.isInteger(id)) return false;
            STMT_MARCAR_PENDIENTE.run(id);
            return this.encolar(id);
        },

        /**
         * Mete en la cola todo lo que esté pendiente. Lo usan el script
         * (`npm run geocodificar`) y el arranque del servidor.
         */
        async geocodificarPendientes({ limite = TANDA, incluirFallidos = false } = {}) {
            const sentencia = incluirFallidos ? STMT_REPASABLES : STMT_PENDIENTES;
            return procesarTanda(sentencia.all(limite).map(f => f.id), { forzar: incluirFallidos });
        },

        /**
         * Vuelve a preguntar por los que ya están situados con precisión fina,
         * para comprobar el código postal del resultado. Lo usa el script: los
         * geocodificados antes de que existiera esa comprobación pueden tener un
         * punto equivocado marcado como exacto.
         */
        async revisarCodigosPostales({ limite = TANDA } = {}) {
            return procesarTanda(STMT_REVISABLES_CP.all(limite).map(f => f.id), { forzar: true });
        },

        /**
         * Coordenadas pegadas a mano. Devuelve el punto guardado, o null si el
         * texto no se entiende (quien llama responde con un 422: en una edición
         * manual nada se descarta en silencio).
         */
        fijarCoordenadasManuales(id, texto) {
            const punto = parsearCoordenadas(texto);
            if (!punto || !Number.isInteger(id)) return null;
            STMT_GUARDAR_MANUAL.run({ id, latitud: punto.latitud, longitud: punto.longitud });
            return punto;
        },

        /** Borrar las manuales devuelve el establecimiento al circuito automático. */
        limpiarCoordenadasManuales(id) {
            if (!Number.isInteger(id)) return false;
            STMT_LIMPIAR_MANUAL.run({ id });
            return this.encolar(id);
        },

        /** Para el arranque del servidor: no se espera, y no rompe nada si falla. */
        arrancarEnSegundoPlano({ retrasoMs = 5000 } = {}) {
            if (!config.activa) return false;
            const temporizador = setTimeout(() => {
                this.geocodificarPendientes().catch((error) => {
                    console.warn('🗺️  La geocodificación de fondo ha fallado:', error.message);
                });
            }, retrasoMs);
            // Que un temporizador de fondo no mantenga vivo el proceso.
            if (typeof temporizador.unref === 'function') temporizador.unref();
            return true;
        },

        // Para las pruebas y el script.
        procesarUno,
        get pausado() { return pausado; },
        get enCola() { return cola.size; }
    };
}

const geocodificador = crearGeocodificador();

module.exports = {
    // interfaz que usa el resto de la aplicación
    encolar: (id) => geocodificador.encolar(id),
    marcarParaRegeocodificar: (id) => geocodificador.marcarParaRegeocodificar(id),
    fijarCoordenadasManuales: (id, texto) => geocodificador.fijarCoordenadasManuales(id, texto),
    limpiarCoordenadasManuales: (id) => geocodificador.limpiarCoordenadasManuales(id),
    geocodificarPendientes: (opciones) => geocodificador.geocodificarPendientes(opciones),
    revisarCodigosPostales: (opciones) => geocodificador.revisarCodigosPostales(opciones),
    arrancarEnSegundoPlano: (opciones) => geocodificador.arrancarEnSegundoPlano(opciones),
    resumenDeArranque,
    contarPendientes,
    contarRepasables,
    contarRevisablesCp,
    contarDiscrepantes,
    // expuestos para las pruebas
    crearGeocodificador,
    leerConfiguracion,
    codigoPostalEnConflicto,
    consultaDe,
    consultasEscalonadas,
    calleSinNumero,
    parsearCoordenadas,
    PRECISIONES,
    PRECISIONES_FINAS,
    ESPERA_MS
};
