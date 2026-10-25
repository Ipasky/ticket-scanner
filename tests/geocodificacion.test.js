/**
 * Geocodificación con Nominatim SIMULADO.
 *
 * Aquí no se toca la red. No es solo por velocidad: la política de uso de
 * Nominatim prohíbe exactamente lo que haría una batería de pruebas —ráfagas de
 * peticiones automáticas— y provocar un 429 de verdad para comprobar que se
 * maneja bien significaría abusar del servicio que se intenta respetar.
 *
 * `crearGeocodificador` admite la petición y la espera inyectadas, así que se
 * comprueba lo que importa: que se respeta el segundo entre peticiones, que se
 * manda el User-Agent, que lo que ya está resuelto no se vuelve a preguntar y
 * que un corte de red no condena a un establecimiento a no tener coordenadas
 * nunca.
 *
 * La base es temporal: se apunta TICKETS_DB_PATH antes de cargar nada.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-scanner-geo-'));
process.env.TICKETS_DB_PATH = path.join(TMP, 'geo.db');

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/config/db.js');
const {
    crearGeocodificador, consultaDe, consultasEscalonadas, calleSinNumero,
    parsearCoordenadas, leerConfiguracion, codigoPostalEnConflicto,
    PRECISIONES_FINAS, ESPERA_MS
} = require('../src/services/geocodificacion.js');

const CONFIG = {
    userAgent: 'ticket-scanner-pruebas/1.0 (nadie@ejemplo.tld)',
    url: 'https://nominatim.ejemplo.tld/search',
    email: '',
    pais: '',
    activa: true
};

test.beforeEach(() => {
    db.exec('DELETE FROM tickets; DELETE FROM establecimientos;');
});

test.after(() => {
    db.close();
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

/** Crea un establecimiento y devuelve su id. */
function crearEstablecimiento(campos = {}) {
    const fila = {
        nombre: 'MERCADONA',
        direccion: 'Carrer de Sants 100',
        ciudad: 'Barcelona',
        codigo_postal: '08014',
        ...campos
    };
    return Number(db.prepare(`
        INSERT INTO establecimientos (nombre, direccion, ciudad, codigo_postal)
        VALUES (@nombre, @direccion, @ciudad, @codigo_postal)
    `).run(fila).lastInsertRowid);
}

const leerEst = (id) => db.prepare('SELECT * FROM establecimientos WHERE id = ?').get(id);

/** Respuesta de Nominatim con un resultado. */
const unResultado = (lat = '41.3755', lon = '2.1370') => ({
    ok: true, status: 200, json: async () => [{ lat, lon }]
});

/**
 * Geocodificador con un Nominatim de pega. `guion` es una función que recibe la
 * URL y devuelve la respuesta (o lanza). Registra las llamadas y las esperas.
 */
function conNominatim(guion, config = {}) {
    const llamadas = [];
    const esperas = [];
    let reloj = 0;

    const geo = crearGeocodificador({
        config: { ...CONFIG, ...config },
        hacerPeticion: async (url, opciones) => {
            llamadas.push({ url, opciones });
            return guion(url, llamadas.length);
        },
        // El tiempo se simula: así se comprueba el ritmo sin esperar de verdad.
        dormir: async (ms) => { esperas.push(ms); reloj += ms; },
        ahora: () => reloj
    });

    return { geo, llamadas, esperas };
}

// =============================================================================
// EL CAMINO BUENO
// =============================================================================

test('un establecimiento con dirección se geocodifica y queda "ok"', async () => {
    const id = crearEstablecimiento();
    const { geo, llamadas } = conNominatim(() => unResultado('41.3755', '2.1370'));

    const resultado = await geo.procesarUno(id);

    assert.equal(resultado.resultado, 'ok');
    const fila = leerEst(id);
    assert.equal(fila.latitud, 41.3755);
    assert.equal(fila.longitud, 2.1370);
    assert.equal(fila.geo_estado, 'ok');
    assert.equal(fila.geo_mensaje, null);
    assert.ok(fila.geo_intentado_at, 'queda constancia de cuándo se preguntó');
    assert.equal(llamadas.length, 1);
});

test('la petición lleva el User-Agent identificativo y los parámetros correctos', async () => {
    // Sin User-Agent, Nominatim bloquea: es la primera regla de su política.
    const id = crearEstablecimiento();
    const { geo, llamadas } = conNominatim(() => unResultado());

    await geo.procesarUno(id);

    const { url, opciones } = llamadas[0];
    assert.equal(opciones.headers['User-Agent'], CONFIG.userAgent);

    const parametros = new URL(url).searchParams;
    assert.equal(parametros.get('format'), 'jsonv2');
    assert.equal(parametros.get('limit'), '1');
    assert.match(parametros.get('q'), /Carrer de Sants 100/);
    assert.match(parametros.get('q'), /Barcelona/);
});

test('se pregunta por la DIRECCIÓN, no por el nombre del establecimiento', () => {
    // "MERCADONA" a secas devuelve un Mercadona cualquiera de España, y un punto
    // en el mapa que no es donde estuve es peor que ningún punto.
    const consulta = consultaDe({
        nombre: 'MERCADONA', direccion: 'Carrer de Sants 100',
        ciudad: 'Barcelona', codigo_postal: '08014'
    });
    assert.doesNotMatch(consulta, /MERCADONA/);
    assert.equal(consulta, 'Carrer de Sants 100, 08014, Barcelona');
});

test('GEO_PAIS acota la búsqueda cuando está configurado', () => {
    const consulta = consultaDe({ direccion: 'Calle Mayor 1', ciudad: 'Madrid' }, 'España');
    assert.equal(consulta, 'Calle Mayor 1, Madrid, España');
});

// =============================================================================
// LA CACHÉ: UNA VEZ POR ESTABLECIMIENTO
// =============================================================================

test('lo que ya está resuelto NO se vuelve a preguntar', async () => {
    // Es la tercera regla de la política de Nominatim y la razón de que el
    // estado viva en la tabla: la caché no caduca ni se pierde al reiniciar.
    const id = crearEstablecimiento();
    const primero = conNominatim(() => unResultado());
    await primero.geo.procesarUno(id);
    assert.equal(primero.llamadas.length, 1);

    const segundo = conNominatim(() => { throw new Error('no debería preguntarse otra vez'); });
    const resultado = await segundo.geo.procesarUno(id);

    assert.equal(resultado.resultado, 'ya_resuelto');
    assert.equal(segundo.llamadas.length, 0);
});

test('un fallido tampoco se reintenta en bucle', async () => {
    const id = crearEstablecimiento({ direccion: 'Calle Que No Existe 999' });
    const primero = conNominatim(() => ({ ok: true, status: 200, json: async () => [] }));
    await primero.geo.procesarUno(id);
    assert.equal(leerEst(id).geo_estado, 'fallido');

    const segundo = conNominatim(() => { throw new Error('no debería preguntarse otra vez'); });
    assert.equal((await segundo.geo.procesarUno(id)).resultado, 'ya_resuelto');
    assert.equal(segundo.llamadas.length, 0);
});

test('editar la dirección vuelve a ponerlo pendiente y borra las coordenadas viejas', async () => {
    const id = crearEstablecimiento();
    const { geo } = conNominatim(() => unResultado());
    await geo.procesarUno(id);
    assert.equal(leerEst(id).geo_estado, 'ok');

    db.prepare('UPDATE establecimientos SET direccion = ? WHERE id = ?')
      .run('Avinguda Diagonal 500', id);
    geo.marcarParaRegeocodificar(id);

    const fila = leerEst(id);
    assert.equal(fila.geo_estado, 'pendiente');
    // Las coordenadas viejas apuntan a la dirección anterior: dejarlas puestas
    // pondría el punto del mapa en otro sitio, que es peor que no pintarlo.
    assert.equal(fila.latitud, null);
    assert.equal(fila.longitud, null);
});

// =============================================================================
// EL RITMO: UNA PETICIÓN POR SEGUNDO
// =============================================================================

test('entre dos peticiones se espera al menos un segundo', async () => {
    const a = crearEstablecimiento({ nombre: 'UNO', direccion: 'Calle A 1' });
    const b = crearEstablecimiento({ nombre: 'DOS', direccion: 'Calle B 2' });
    const { geo, esperas, llamadas } = conNominatim(() => unResultado());

    await geo.geocodificarPendientes();

    assert.equal(llamadas.length, 2);
    assert.equal(esperas.length, 1, 'se espera entre la primera y la segunda, no antes de la primera');
    assert.ok(esperas[0] >= 1000, `esperó ${esperas[0]} ms, y la política pide 1000`);
    assert.equal(ESPERA_MS >= 1000, true);
    assert.equal(leerEst(a).geo_estado, 'ok');
    assert.equal(leerEst(b).geo_estado, 'ok');
});

// =============================================================================
// CUANDO NO SE PUEDE PREGUNTAR
// =============================================================================

test('sin resultados: queda "fallido" con el motivo', async () => {
    const id = crearEstablecimiento({ direccion: 'Calle Inventada 404' });
    const { geo } = conNominatim(() => ({ ok: true, status: 200, json: async () => [] }));

    assert.equal((await geo.procesarUno(id)).resultado, 'fallido');
    const fila = leerEst(id);
    assert.equal(fila.geo_estado, 'fallido');
    assert.match(fila.geo_mensaje, /sin resultados/);
    assert.equal(fila.latitud, null);
});

test('la red falla: se queda PENDIENTE, no fallido', async () => {
    // Un corte de red no dice nada sobre la dirección. Marcarlo 'fallido' sería
    // condenarlo a no tener coordenadas nunca por algo que no es suyo.
    const id = crearEstablecimiento();
    const { geo } = conNominatim(() => { throw new Error('getaddrinfo ENOTFOUND'); });

    const resultado = await geo.procesarUno(id);

    assert.equal(resultado.resultado, 'temporal');
    const fila = leerEst(id);
    assert.equal(fila.geo_estado, 'pendiente');
    assert.match(fila.geo_mensaje, /ENOTFOUND/);
});

test('un 429 de Nominatim para la cola entera y no quema a los que quedan', async () => {
    crearEstablecimiento({ nombre: 'UNO', direccion: 'Calle A 1' });
    crearEstablecimiento({ nombre: 'DOS', direccion: 'Calle B 2' });
    crearEstablecimiento({ nombre: 'TRES', direccion: 'Calle C 3' });

    const { geo, llamadas } = conNominatim(() => ({ ok: false, status: 429, json: async () => ({}) }));

    await geo.geocodificarPendientes();

    // Se para en el primero: insistir cuando te acaban de decir "demasiadas
    // peticiones" es exactamente lo que no hay que hacer.
    assert.equal(llamadas.length, 1);
    assert.equal(geo.pausado, true);

    const estados = db.prepare('SELECT geo_estado FROM establecimientos ORDER BY id').all();
    assert.deepEqual(estados.map(e => e.geo_estado), ['pendiente', 'pendiente', 'pendiente']);
});

test('un 500 también es temporal; un 400 es culpa de la consulta', async () => {
    const temporal = crearEstablecimiento({ nombre: 'UNO', direccion: 'Calle A 1' });
    const malo     = crearEstablecimiento({ nombre: 'DOS', direccion: 'Calle B 2' });

    const cincoCientos = conNominatim(() => ({ ok: false, status: 503, json: async () => ({}) }));
    await cincoCientos.geo.procesarUno(temporal);
    assert.equal(leerEst(temporal).geo_estado, 'pendiente');

    const cuatroCientos = conNominatim(() => ({ ok: false, status: 400, json: async () => ({}) }));
    await cuatroCientos.geo.procesarUno(malo);
    assert.equal(leerEst(malo).geo_estado, 'fallido');
});

test('una respuesta que no es JSON no revienta nada', async () => {
    const id = crearEstablecimiento();
    const { geo } = conNominatim(() => ({
        ok: true, status: 200, json: async () => { throw new Error('Unexpected token <'); }
    }));

    const resultado = await geo.procesarUno(id);
    assert.equal(resultado.resultado, 'temporal');
    assert.equal(leerEst(id).geo_estado, 'pendiente');
});

test('coordenadas imposibles se descartan: mejor sin punto que con uno falso', async () => {
    const id = crearEstablecimiento();
    const { geo } = conNominatim(() => ({
        ok: true, status: 200, json: async () => [{ lat: 'no-es-un-numero', lon: '2.1' }]
    }));

    assert.equal((await geo.procesarUno(id)).resultado, 'fallido');
    assert.equal(leerEst(id).latitud, null);

    const otro = crearEstablecimiento({ nombre: 'OTRO' });
    const fuera = conNominatim(() => ({ ok: true, status: 200, json: async () => [{ lat: '999', lon: '2.1' }] }));
    assert.equal((await fuera.geo.procesarUno(otro)).resultado, 'fallido');
});

test('sin NADA que preguntar no se molesta a Nominatim', async () => {
    // Desde que la búsqueda es escalonada, un código postal suelto SÍ es algo
    // que preguntar (la etapa de zona). 'sin_datos' se queda para los que no
    // tienen ni dirección, ni código postal, ni localidad.
    const id = crearEstablecimiento({ direccion: null, ciudad: null, codigo_postal: null });
    const { geo, llamadas } = conNominatim(() => unResultado());

    const resultado = await geo.procesarUno(id);

    assert.equal(resultado.resultado, 'sin_datos');
    assert.equal(llamadas.length, 0, 'ni se molesta a Nominatim');
    assert.equal(leerEst(id).geo_estado, 'sin_datos');
    assert.equal(consultaDe({ nombre: 'X' }), null);
});

test('solo con código postal se pregunta por la zona', async () => {
    const id = crearEstablecimiento({ direccion: null, ciudad: null, codigo_postal: '43892' });
    const { geo, llamadas } = conNominatim(() => unResultado());

    const resultado = await geo.procesarUno(id);

    assert.equal(resultado.resultado, 'ok');
    assert.equal(resultado.precision, 'zona');
    assert.equal(llamadas.length, 1);
    assert.equal(leerEst(id).geo_precision, 'zona');
});

// =============================================================================
// DESACTIVADA
// =============================================================================

test('sin NOMINATIM_USER_AGENT la geocodificación no se activa', () => {
    // Mandar peticiones anónimas está prohibido por la política de uso. Es mejor
    // no tener coordenadas que que te bloqueen la IP.
    assert.equal(leerConfiguracion({}).activa, false);
    assert.equal(leerConfiguracion({ NOMINATIM_USER_AGENT: '   ' }).activa, false);
    assert.equal(leerConfiguracion({ NOMINATIM_USER_AGENT: 'algo/1.0 (yo@ej.tld)' }).activa, true);
});

test('desactivada, encolar no hace nada y no revienta', async () => {
    const id = crearEstablecimiento();
    const { geo, llamadas } = conNominatim(() => unResultado(), { activa: false, userAgent: '' });

    assert.equal(geo.encolar(id), false);
    const resultado = await geo.geocodificarPendientes();

    assert.equal(resultado.activa, false);
    assert.equal(llamadas.length, 0);
    assert.equal(leerEst(id).geo_estado, 'pendiente', 'se queda para cuando se configure');
});

// =============================================================================
// LA COLA EN SEGUNDO PLANO
// =============================================================================

test('encolar devuelve en el acto: la subida no espera a Nominatim', async () => {
    // Lo que garantiza que una foto no tarde un segundo más por cada
    // establecimiento nuevo.
    const id = crearEstablecimiento();
    let resueltoDespues = false;
    const { geo } = conNominatim(async () => { resueltoDespues = true; return unResultado(); });

    const antes = Date.now();
    geo.encolar(id);
    const despues = Date.now();

    assert.ok(despues - antes < 50, 'encolar tiene que volver inmediatamente');
    assert.equal(resueltoDespues, false, 'todavía no ha preguntado nada');

    // Y acaba haciéndose, en el siguiente turno del bucle de eventos.
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(leerEst(id).geo_estado, 'ok');
});

test('geocodificarPendientes recorre todo lo que haya pendiente', async () => {
    for (let i = 0; i < 4; i++) {
        crearEstablecimiento({ nombre: `SITIO ${i}`, direccion: `Calle ${i}` });
    }
    const { geo, llamadas } = conNominatim(() => unResultado());

    const resultado = await geo.geocodificarPendientes();

    assert.equal(resultado.encolados, 4);
    assert.equal(llamadas.length, 4);
    assert.equal(resultado.pendientes, 0);
});

// =============================================================================
// BÚSQUEDA ESCALONADA
// =============================================================================

test('las etapas van de la puerta al pueblo, sin repetir consultas', () => {
    const etapas = consultasEscalonadas({
        direccion: 'Baixada Playa Cristal 12',
        codigo_postal: '43892',
        ciudad: 'Miami Platja'
    }, 'España');

    assert.deepEqual(etapas.map(e => e.precision), ['exacta', 'calle', 'zona', 'localidad']);
    assert.equal(etapas[0].consulta, 'Baixada Playa Cristal 12, 43892, Miami Platja, España');
    assert.equal(etapas[1].consulta, 'Baixada Playa Cristal, 43892, Miami Platja, España');
    assert.equal(etapas[2].consulta, '43892, Miami Platja, España');
    assert.equal(etapas[3].consulta, 'Miami Platja, España');
});

test('una dirección sin número no gasta una petición repetida', () => {
    // Las etapas 1 y 2 serían la misma consulta.
    const etapas = consultasEscalonadas({ direccion: 'Avinguda Diagonal', ciudad: 'Barcelona' });
    assert.deepEqual(etapas.map(e => e.precision), ['exacta', 'localidad']);
});

test('calleSinNumero corta donde empieza el portal', () => {
    assert.equal(calleSinNumero('Baixada Playa Cristal 12'), 'Baixada Playa Cristal');
    assert.equal(calleSinNumero('Carrer de Sants 100, 3r 2a'), 'Carrer de Sants');
    assert.equal(calleSinNumero('Calle Mayor, 3'), 'Calle Mayor');
    assert.equal(calleSinNumero('Avinguda Diagonal'), 'Avinguda Diagonal', 'no había número');
    assert.equal(calleSinNumero('12'), '', 'un número suelto no es una calle');
    assert.equal(calleSinNumero(null), '');
});

test('el caso real: la dirección falla y el código postal lo salva', async () => {
    // "Baixada Playa Cristal 12, 43892, Miami Platja": el nombre mezcla catalán y
    // castellano y Miami Platja es un núcleo, no un municipio. Nominatim no tiene
    // la dirección, pero sí el código postal.
    const id = crearEstablecimiento({
        nombre: 'SUPER MIAMI', direccion: 'Baixada Playa Cristal 12',
        codigo_postal: '43892', ciudad: 'Miami Platja'
    });

    const { geo, llamadas } = conNominatim((url) => {
        const consulta = new URL(url).searchParams.get('q');
        // Solo responde la consulta del código postal.
        return consulta.startsWith('43892')
            ? unResultado('41.0123', '0.9876')
            : { ok: true, status: 200, json: async () => [] };
    });

    const resultado = await geo.procesarUno(id);

    assert.equal(resultado.resultado, 'ok');
    assert.equal(resultado.precision, 'zona');
    assert.equal(llamadas.length, 3, 'exacta, calle y zona; la localidad ya no hizo falta');

    const fila = leerEst(id);
    assert.equal(fila.latitud, 41.0123);
    assert.equal(fila.geo_precision, 'zona');
    assert.equal(fila.geo_estado, 'ok');
});

test('si responde la primera, no se baja ningún escalón', async () => {
    const id = crearEstablecimiento();
    const { geo, llamadas } = conNominatim(() => unResultado());

    const resultado = await geo.procesarUno(id);

    assert.equal(resultado.precision, 'exacta');
    assert.equal(llamadas.length, 1);
});

test('entre etapas también se respeta el segundo', async () => {
    // Son peticiones a Nominatim como cualquier otra: el ritmo no se relaja
    // porque sean del mismo establecimiento.
    const id = crearEstablecimiento({ codigo_postal: '08014' });
    const { geo, esperas } = conNominatim(() => ({ ok: true, status: 200, json: async () => [] }));

    await geo.procesarUno(id);

    assert.ok(esperas.length >= 2, 'una espera entre cada par de etapas');
    assert.ok(esperas.every(ms => ms >= 1000));
});

test('agotadas todas las etapas, entonces sí es un fallido', async () => {
    const id = crearEstablecimiento({ codigo_postal: '08014' });
    const { geo } = conNominatim(() => ({ ok: true, status: 200, json: async () => [] }));

    assert.equal((await geo.procesarUno(id)).resultado, 'fallido');
    const fila = leerEst(id);
    assert.equal(fila.geo_estado, 'fallido');
    assert.match(fila.geo_mensaje, /ninguna etapa/);
});

test('un corte de red a media escalera NO quema al establecimiento', async () => {
    const id = crearEstablecimiento({ codigo_postal: '08014' });
    const { geo, llamadas } = conNominatim((url, n) => {
        if (n === 1) return { ok: true, status: 200, json: async () => [] };
        throw new Error('ECONNRESET');
    });

    const resultado = await geo.procesarUno(id);

    assert.equal(resultado.resultado, 'temporal');
    assert.equal(llamadas.length, 2, 'se corta en cuanto la red falla');
    assert.equal(leerEst(id).geo_estado, 'pendiente');
});

test('el script repasa los fallidos; la cola normal no', async () => {
    const id = crearEstablecimiento({ nombre: 'ANTIGUO FALLIDO' });
    const fallo = conNominatim(() => ({ ok: true, status: 200, json: async () => [] }));
    await fallo.geo.procesarUno(id);
    assert.equal(leerEst(id).geo_estado, 'fallido');

    // La cola de siempre lo deja en paz: no se reintenta en bucle.
    const normal = conNominatim(() => unResultado());
    await normal.geo.geocodificarPendientes();
    assert.equal(normal.llamadas.length, 0);

    // El script sí lo repasa, que es para lo que sirve cuando mejora la búsqueda.
    const repaso = conNominatim(() => unResultado('41.5', '2.5'));
    const resultado = await repaso.geo.geocodificarPendientes({ incluirFallidos: true });

    assert.equal(resultado.encolados, 1);
    assert.equal(leerEst(id).geo_estado, 'ok');
    assert.equal(leerEst(id).latitud, 41.5);
});

// =============================================================================
// COORDENADAS A MANO
// =============================================================================

test('parsearCoordenadas entiende lo que de verdad se pega', () => {
    const esperado = { latitud: 41.0123, longitud: 0.9876 };

    assert.deepEqual(parsearCoordenadas('41.0123, 0.9876'), esperado, 'como las copia Google Maps');
    assert.deepEqual(parsearCoordenadas('41.0123; 0.9876'), esperado, 'con punto y coma');
    assert.deepEqual(parsearCoordenadas('41.0123 0.9876'), esperado, 'con un espacio');
    assert.deepEqual(parsearCoordenadas('  41.0123 ,  0.9876 '), esperado, 'con espacios de más');
    // Coma decimal: lo que sale de un sistema en español.
    assert.deepEqual(parsearCoordenadas('41,0123, 0,9876'), esperado);
    // Negativas, que es media España al oeste de Greenwich.
    assert.deepEqual(parsearCoordenadas('40.4168, -3.7038'), { latitud: 40.4168, longitud: -3.7038 });
});

test('parsearCoordenadas rechaza lo que no es un punto', () => {
    for (const malo of [
        '', '   ', 'por ahí', '41.0123', '41.0123, 0.9876, 100',
        '91, 0', '-91, 0', '0, 181', '0, -181', '0, 0'
    ]) {
        assert.equal(parsearCoordenadas(malo), null, `"${malo}" no debería valer`);
    }
});

test('unas coordenadas a mano no las toca la geocodificación automática', async () => {
    const id = crearEstablecimiento();
    const { geo, llamadas } = conNominatim(() => unResultado('0.1', '0.2'));

    geo.fijarCoordenadasManuales(id, '41.0123, 0.9876');

    const fila = leerEst(id);
    assert.equal(fila.latitud, 41.0123);
    assert.equal(fila.geo_precision, 'manual');
    assert.equal(fila.geo_estado, 'ok');

    // Ni forzando, que es lo que hace el script.
    assert.equal((await geo.procesarUno(id, { forzar: true })).resultado, 'manual');
    assert.equal(llamadas.length, 0);
    assert.equal(leerEst(id).latitud, 41.0123);
});

test('cambiar la dirección tampoco borra unas coordenadas a mano', async () => {
    // La dirección se corrige por mil motivos —una errata, el nombre en otro
    // idioma— y ninguno es razón para tirar un punto puesto mirando un mapa.
    const id = crearEstablecimiento();
    const { geo } = conNominatim(() => unResultado());
    geo.fijarCoordenadasManuales(id, '41.0123, 0.9876');

    geo.marcarParaRegeocodificar(id);

    const fila = leerEst(id);
    assert.equal(fila.latitud, 41.0123);
    assert.equal(fila.geo_estado, 'ok');
    assert.equal(fila.geo_precision, 'manual');
});

test('vaciar el campo devuelve el establecimiento al circuito automático', async () => {
    const id = crearEstablecimiento();
    const { geo } = conNominatim(() => unResultado('41.3755', '2.1370'));
    geo.fijarCoordenadasManuales(id, '41.0123, 0.9876');

    geo.limpiarCoordenadasManuales(id);

    const tras = leerEst(id);
    assert.equal(tras.geo_estado, 'pendiente');
    assert.equal(tras.geo_precision, null);
    assert.equal(tras.latitud, null);

    // Y ahora sí se geocodifica.
    await geo.geocodificarPendientes();
    assert.equal(leerEst(id).geo_precision, 'exacta');
});

test('el script no repasa los que están puestos a mano', async () => {
    const aMano = crearEstablecimiento({ nombre: 'A MANO' });
    const { geo } = conNominatim(() => unResultado());
    geo.fijarCoordenadasManuales(aMano, '41.0123, 0.9876');

    const repaso = conNominatim(() => unResultado('0.1', '0.2'));
    const resultado = await repaso.geo.geocodificarPendientes({ incluirFallidos: true });

    assert.equal(resultado.encolados, 0);
    assert.equal(leerEst(aMano).latitud, 41.0123);
});

test('unas coordenadas que no se entienden no escriben nada', () => {
    const id = crearEstablecimiento();
    const { geo } = conNominatim(() => unResultado());

    assert.equal(geo.fijarCoordenadasManuales(id, 'por ahí cerca'), null);
    assert.equal(leerEst(id).latitud, null);
    assert.equal(leerEst(id).geo_precision, null);
});

// =============================================================================
// COHERENCIA CON EL CÓDIGO POSTAL DEL TIQUET
// =============================================================================
// Nominatim contesta con lo más parecido que encuentra, y lo más parecido a una
// dirección de Becerril de la Sierra (28490) puede ser una calle del centro de
// Madrid (280xx). Guardarlo como 'exacta' es el peor resultado posible: el mapa
// lo pinta sólido y nada dice que no sea el sitio.

/** Respuesta de Nominatim con el código postal DEL RESULTADO. */
const unResultadoConCp = (cp, lat = '40.4168', lon = '-3.7038') => ({
    ok: true, status: 200, json: async () => [{ lat, lon, address: { postcode: cp } }]
});

test('el caso real: con el CP distinto se baja a la etapa del código postal', async () => {
    // Un 28490 (Becerril de la Sierra) que Nominatim resuelve en el centro de
    // Madrid. Ese punto NO se acepta como exacto ni se da por bueno: se sigue
    // bajando la escalera, y la etapa del código postal —que pregunta por el CP
    // del papel— cae en el pueblo correcto.
    const id = crearEstablecimiento({
        nombre: 'PAPELERIA LA SIERRA',
        direccion: 'Calle Real 4',
        codigo_postal: '28490',
        ciudad: 'Becerril de la Sierra'
    });

    const { geo, llamadas } = conNominatim((url) => {
        const consulta = new URL(url).searchParams.get('q');
        // La etapa de zona pregunta empezando por el código postal.
        return consulta.startsWith('28490')
            ? unResultadoConCp('28490', '40.7161', '-3.9908')
            : unResultadoConCp('28015', '40.4168', '-3.7038');
    });

    const resultado = await geo.procesarUno(id);

    assert.equal(resultado.resultado, 'ok');
    assert.equal(resultado.precision, 'zona');
    assert.equal(llamadas.length, 3, 'exacta y calle descartadas por el CP; responde zona');

    const fila = leerEst(id);
    assert.equal(fila.latitud, 40.7161, 'el punto es el del pueblo, no el de la capital');
    assert.equal(fila.geo_precision, 'zona');
    assert.equal(fila.geo_estado, 'ok');
});

test('si NINGUNA etapa cuadra, se guarda el punto dudoso marcado como tal', async () => {
    // Último recurso: un punto dudoso y señalado es mejor que ningún punto, pero
    // nunca se hace pasar por exacto.
    const id = crearEstablecimiento({
        nombre: 'PAPELERIA LA SIERRA',
        direccion: 'Calle Real 4',
        codigo_postal: '28490',
        ciudad: 'Becerril de la Sierra'
    });

    // Todas las etapas devuelven el mismo punto de la capital, con su CP.
    const { geo } = conNominatim((url) => {
        const consulta = new URL(url).searchParams.get('q');
        return consulta.startsWith('Calle Real') || consulta.startsWith('Calle')
            ? unResultadoConCp('28015')
            : { ok: true, status: 200, json: async () => [] };
    });

    const resultado = await geo.procesarUno(id);

    assert.equal(resultado.resultado, 'ok');
    assert.equal(resultado.precision, 'discrepante');
    assert.equal(PRECISIONES_FINAS.has(resultado.precision), false,
                 'el mapa lo pintará como aproximado');

    const fila = leerEst(id);
    assert.equal(fila.latitud, 40.4168);
    assert.equal(fila.geo_precision, 'discrepante');
    // Con LOS DOS VALORES, que es lo que permite entenderlo después sin volver a
    // preguntar.
    assert.match(fila.geo_mensaje, /28015/);
    assert.match(fila.geo_mensaje, /28490/);
});

test('si el código postal cuadra, sigue siendo exacta y sin mensaje', async () => {
    const id = crearEstablecimiento({ codigo_postal: '08014' });
    const { geo } = conNominatim(() => unResultadoConCp('08014', '41.3755', '2.1370'));

    const resultado = await geo.procesarUno(id);

    assert.equal(resultado.precision, 'exacta');
    assert.equal(leerEst(id).geo_precision, 'exacta');
    assert.equal(leerEst(id).geo_mensaje, null);
});

test('un cero de delante perdido no es una discrepancia', () => {
    // "8014" es "08014" al que se le ha caído el cero: en España son cinco
    // dígitos siempre. Y un formato que no se entiende tampoco es discrepancia:
    // no se puede desconfiar de un dato que no se sabe leer.
    assert.equal(codigoPostalEnConflicto('8014', '08014'), false);
    assert.equal(codigoPostalEnConflicto('08014', '08015'), true);
    assert.equal(codigoPostalEnConflicto('', '08015'), false);
    assert.equal(codigoPostalEnConflicto('08014', ''), false);
    assert.equal(codigoPostalEnConflicto('08014', '1000-001'), false);
});

test('sin código postal en el resultado no se degrada nada', async () => {
    // Nominatim no siempre devuelve código postal; faltar no es contradecir.
    const id = crearEstablecimiento({ codigo_postal: '08014' });
    const { geo } = conNominatim(() => unResultado('41.3755', '2.1370'));

    assert.equal((await geo.procesarUno(id)).precision, 'exacta');
});

test('el repaso que no encuentra nada deja el punto que ya había', async () => {
    // La revisión del código postal vuelve a preguntar por establecimientos que
    // YA están situados. Si ese día Nominatim no contesta, degradarlos a
    // 'fallido' y dejarlos sin explicación sería perder información por nada.
    const id = crearEstablecimiento({ codigo_postal: '08014' });
    const primero = conNominatim(() => unResultadoConCp('08014', '41.3755', '2.1370'));
    await primero.geo.procesarUno(id);

    const repaso = conNominatim(() => ({ ok: true, status: 200, json: async () => [] }));
    const resultado = await repaso.geo.procesarUno(id, { forzar: true });

    assert.equal(resultado.resultado, 'sin_cambios');
    const fila = leerEst(id);
    assert.equal(fila.latitud, 41.3755);
    assert.equal(fila.geo_estado, 'ok');
    assert.equal(fila.geo_precision, 'exacta');
});

// =============================================================================
// EL LUGAR DEDUCIDO DEL DOCUMENTO
// =============================================================================
// Hay documentos que no imprimen dirección y cuyo lugar es evidente: un tiquet
// de parking del "Patronat de la Muntanya de Montserrat". Sin esta etapa se
// quedaban sin ubicar para siempre.

/** Un resultado con su jerarquía administrativa, que es con la que se compara. */
const unResultadoEn = (lat, lon, provincia, comunidad = '') => ({
    ok: true, status: 200,
    json: async () => [{
        lat, lon,
        address: { state: comunidad, province: provincia },
        display_name: `Sitio, ${provincia}, ${comunidad}`
    }]
});

test('el caso real: sin dirección ni localidad, se busca por el lugar deducido', async () => {
    const id = crearEstablecimiento({
        nombre: 'PATRONAT DE LA MUNTANYA DE MONTSERRAT',
        direccion: null, ciudad: null, codigo_postal: null
    });
    db.prepare('UPDATE establecimientos SET lugar_inferido = ? WHERE id = ?')
      .run('Montserrat, Barcelona, Catalunya', id);

    // El nombre completo del establecimiento es lo primero que se prueba, y no
    // es ambiguo: responde en Barcelona.
    const { geo, llamadas } = conNominatim(() => unResultadoEn('41.5931', '1.8378', 'Barcelona', 'Catalunya'));

    const resultado = await geo.procesarUno(id);

    assert.equal(resultado.resultado, 'ok');
    assert.equal(resultado.precision, 'inferida');
    assert.equal(llamadas.length, 1, 'con el nombre completo basta');
    assert.match(new URL(llamadas[0].url).searchParams.get('q'), /PATRONAT/);

    const fila = leerEst(id);
    assert.equal(fila.latitud, 41.5931);
    assert.equal(fila.geo_precision, 'inferida');
    // Y el mapa lo pinta como aproximado: el lugar no estaba impreso.
    assert.equal(PRECISIONES_FINAS.has('inferida'), false);
});

test('el otro caso real: un homónimo en otra provincia NO se acepta', async () => {
    // "Montserrat" resolvía en Montserrat (Valencia) y el parking de la montaña
    // de Barcelona acababa a 300 km. Con el contexto del lugar deducido, un
    // resultado que no cae en esa provincia se descarta y se sigue bajando.
    const id = crearEstablecimiento({
        nombre: 'PATRONAT DE LA MUNTANYA DE MONTSERRAT',
        direccion: null, ciudad: null, codigo_postal: null
    });
    db.prepare('UPDATE establecimientos SET lugar_inferido = ? WHERE id = ?')
      .run('Montserrat, Barcelona, Catalunya', id);

    const { geo, llamadas } = conNominatim((url) => {
        const consulta = new URL(url).searchParams.get('q');
        // El nombre a secas devuelve el homónimo valenciano; la consulta con el
        // lugar, el bueno.
        return consulta.includes('Barcelona')
            ? unResultadoEn('41.5931', '1.8378', 'Barcelona', 'Catalunya')
            : unResultadoEn('39.3600', '-0.6000', 'Valencia', 'Comunitat Valenciana');
    });

    const resultado = await geo.procesarUno(id);

    assert.equal(resultado.precision, 'inferida');
    assert.equal(llamadas.length, 2, 'descarta el de Valencia y prueba con el lugar');
    assert.equal(leerEst(id).latitud, 41.5931, 'el punto es el de Barcelona');
});

test('entre varios resultados se prefiere el de la provincia del lugar', async () => {
    const id = crearEstablecimiento({
        nombre: 'BAR DEL MIRADOR', direccion: null, ciudad: null, codigo_postal: null
    });
    db.prepare('UPDATE establecimientos SET lugar_inferido = ? WHERE id = ?')
      .run('Montserrat, Barcelona, Catalunya', id);

    const { geo, llamadas } = conNominatim(() => ({
        ok: true, status: 200,
        json: async () => [
            { lat: '39.3600', lon: '-0.6000', address: { province: 'Valencia' }, display_name: 'Bar, Valencia' },
            { lat: '41.5931', lon: '1.8378', address: { province: 'Barcelona' }, display_name: 'Bar, Barcelona' }
        ]
    }));

    await geo.procesarUno(id);

    // Y se piden varios resultados: con uno no habría nada que preferir.
    assert.equal(new URL(llamadas[0].url).searchParams.get('limit'), '5');
    assert.equal(leerEst(id).latitud, 41.5931);
});

test('si ni el nombre ni el nombre con el lugar dan nada, se prueba el lugar solo', async () => {
    const id = crearEstablecimiento({
        nombre: 'BAR DEL MIRADOR', direccion: null, ciudad: null, codigo_postal: null
    });
    db.prepare('UPDATE establecimientos SET lugar_inferido = ? WHERE id = ?')
      .run('Montserrat, Barcelona, Catalunya', id);

    const { geo, llamadas } = conNominatim((url) => {
        const consulta = new URL(url).searchParams.get('q');
        // Solo responde la consulta del lugar a secas.
        return consulta.startsWith('Montserrat')
            ? unResultadoEn('41.5931', '1.8378', 'Barcelona', 'Catalunya')
            : { ok: true, status: 200, json: async () => [] };
    });

    assert.equal((await geo.procesarUno(id)).precision, 'inferida');
    assert.equal(llamadas.length, 3, 'nombre, nombre+lugar y por fin el lugar');
});

test('lo IMPRESO manda: con dirección o localidad no se usa el lugar deducido', async () => {
    // El lugar deducido es el último recurso, no un atajo: si el papel trae
    // dirección, es la dirección la que vale.
    const { consultasEscalonadas } = require('../src/services/geocodificacion.js');

    const conDireccion = consultasEscalonadas({
        nombre: 'X', direccion: 'Carrer Gran 1', ciudad: null,
        codigo_postal: null, lugar_inferido: 'Montserrat'
    });
    assert.equal(conDireccion.some(e => e.precision === 'inferida'), false);

    const conCiudad = consultasEscalonadas({
        nombre: 'X', direccion: null, ciudad: 'Barcelona',
        codigo_postal: null, lugar_inferido: 'Montserrat'
    });
    assert.equal(conCiudad.some(e => e.precision === 'inferida'), false);
});

test('sin dirección NI lugar deducido, sigue siendo sin_datos', async () => {
    const id = crearEstablecimiento({ direccion: null, ciudad: null, codigo_postal: null });
    const { geo, llamadas } = conNominatim(() => unResultado());

    assert.equal((await geo.procesarUno(id)).resultado, 'sin_datos');
    assert.equal(llamadas.length, 0, 'no se molesta a Nominatim sin nada que preguntar');
});
