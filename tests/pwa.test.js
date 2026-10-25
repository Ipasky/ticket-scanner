/**
 * PWA: manifiesto, iconos y —sobre todo— que el service worker NO guarde datos.
 *
 * La regla que manda: nada de /api/* ni de /uploads/* puede acabar en la caché
 * del navegador. Son importes, establecimientos, matrículas y fotos de papeles.
 * Una prueba que lo fije vale más que el comentario que lo pide, porque el día
 * que alguien añada una estrategia de caché "para que vaya más rápido" esto es
 * lo que se va a poner rojo.
 *
 * sw.js se carga en un contexto `vm` con un service worker de pega, igual que
 * historial.test.js hace con el frontend: las declaraciones `function` del
 * script quedan en el contexto y se pueden llamar desde aquí.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PUBLIC = path.join(__dirname, '..', 'src', 'public');
const ORIGEN = 'https://tiquets.ejemplo.tld';

// --- CARGA DEL SERVICE WORKER EN UN CONTEXTO DE PEGA ------------------------

/** Caché de pega: un Map por nombre, con la interfaz que usa sw.js. */
function cachesDePega() {
    const almacen = new Map();     // nombre -> Map(url -> respuesta)
    const puestas = [];            // registro de todo lo que se ha guardado

    const abrir = (nombre) => {
        if (!almacen.has(nombre)) almacen.set(nombre, new Map());
        const mapa = almacen.get(nombre);
        return {
            add: async (peticion) => { mapa.set(String(peticion.url || peticion), { url: String(peticion.url || peticion) }); },
            put: async (peticion, respuesta) => {
                const url = String(peticion.url || peticion);
                puestas.push(url);
                mapa.set(url, respuesta);
            },
            keys: async () => [...mapa.keys()].map(url => ({ url })),
            delete: async (peticion) => mapa.delete(String(peticion.url || peticion))
        };
    };

    return {
        puestas,
        almacen,
        api: {
            open: async (nombre) => abrir(nombre),
            keys: async () => [...almacen.keys()],
            delete: async (nombre) => almacen.delete(nombre),
            match: async (peticion) => {
                const url = String(peticion.url || peticion);
                for (const mapa of almacen.values()) {
                    // Las rutas del armazón se guardan tal cual ('/app.js') y las
                    // peticiones llegan absolutas: se prueban las dos formas.
                    if (mapa.has(url)) return mapa.get(url);
                    const relativa = url.startsWith(ORIGEN) ? url.slice(ORIGEN.length) : null;
                    if (relativa && mapa.has(relativa)) return mapa.get(relativa);
                }
                return undefined;
            }
        }
    };
}

/** Carga sw.js y devuelve el contexto con sus funciones y sus manejadores. */
function cargarServiceWorker({ fetchDePega } = {}) {
    const manejadores = {};
    const cache = cachesDePega();
    const llamadasFetch = [];

    const fetchPorDefecto = async (peticion) => ({
        ok: true, status: 200, type: 'basic', redirected: false,
        url: String(peticion.url || peticion),
        clone() { return { ...this, clone: this.clone }; }
    });

    const contexto = {
        self: {
            addEventListener: (nombre, fn) => { manejadores[nombre] = fn; },
            skipWaiting: async () => {},
            clients: { claim: async () => {} },
            location: { origin: ORIGEN }
        },
        caches: cache.api,
        fetch: async (peticion) => {
            llamadasFetch.push(String(peticion.url || peticion));
            return (fetchDePega || fetchPorDefecto)(peticion);
        },
        Request: class { constructor(url, opciones) { this.url = url; Object.assign(this, opciones); } },
        URL, Promise, console, Boolean, String, Object
    };

    vm.createContext(contexto);
    vm.runInContext(fs.readFileSync(path.join(PUBLIC, 'sw.js'), 'utf8'), contexto, { filename: 'sw.js' });

    return { contexto, manejadores, cache, llamadasFetch };
}

/**
 * Lee una constante del service worker.
 *
 * Las declaraciones `function` de un script sí quedan como propiedades del
 * contexto, pero las `const` viven en el ámbito léxico global y no se ven desde
 * fuera: hay que evaluarlas dentro. Por eso ARMAZON o CACHE_ARMAZON se leen así
 * y esSoloRed se puede llamar directamente.
 */
const leer = (contexto, nombre) => vm.runInContext(nombre, contexto);

/** Un evento de fetch de pega: registra si el service worker lo ha interceptado. */
function eventoDePega(ruta, { method = 'GET', mode = 'no-cors' } = {}) {
    const url = ruta.startsWith('http') ? ruta : ORIGEN + ruta;
    const evento = {
        request: { url, method, mode },
        interceptado: false,
        respuesta: null,
        respondWith(promesa) { this.interceptado = true; this.respuesta = promesa; },
        waitUntil(promesa) { return promesa; }
    };
    return evento;
}

// =============================================================================
// LO QUE NUNCA SE CACHEA
// =============================================================================

test('esSoloRed: los datos y las fotos quedan fuera de la caché', () => {
    const { contexto } = cargarServiceWorker();

    for (const ruta of [
        '/api/tickets', '/api/tickets/7', '/api/auth/estado', '/api/ia/config',
        '/uploads/1759-foto.jpg', '/uploads/reemplazadas/vieja.jpg', '/ping'
    ]) {
        assert.equal(contexto.esSoloRed(ruta), true, `${ruta} tiene que ser solo red`);
    }
});

test('esSoloRed: el armazón sí se puede cachear', () => {
    const { contexto } = cargarServiceWorker();

    for (const ruta of [
        '/', '/index.html', '/login.html', '/sin-identidad.html', '/app.js',
        '/pwa.js', '/sw.js', '/manifest.webmanifest', '/icono.svg', '/iconos/icono-192.png'
    ]) {
        assert.equal(contexto.esSoloRed(ruta), false, `${ruta} es armazón`);
    }
});

test('el service worker NI SIQUIERA intercepta las peticiones de datos', () => {
    // No es que las deje pasar: es que no llama a respondWith(). La petición sale
    // como si este archivo no existiera, que es la única forma de garantizar que
    // no toca ni la sesión, ni las cookies, ni los códigos de respuesta.
    const { manejadores, llamadasFetch } = cargarServiceWorker();

    for (const ruta of ['/api/tickets', '/uploads/foto.jpg', '/ping']) {
        const evento = eventoDePega(ruta);
        manejadores.fetch(evento);
        assert.equal(evento.interceptado, false, `${ruta} no debería interceptarse`);
    }
    assert.deepEqual(llamadasFetch, [], 'ni se hace una petición propia');
});

test('el armazón sí se intercepta', () => {
    const { manejadores } = cargarServiceWorker();

    for (const ruta of ['/', '/index.html', '/app.js', '/iconos/icono-192.png']) {
        const evento = eventoDePega(ruta);
        manejadores.fetch(evento);
        assert.equal(evento.interceptado, true, `${ruta} es armazón y se sirve con caché de respaldo`);
    }
});

test('lo que no es GET nunca se toca', () => {
    const { manejadores } = cargarServiceWorker();

    for (const [metodo, ruta] of [
        ['POST', '/api/tickets/upload'], ['PUT', '/api/tickets/1'],
        ['DELETE', '/api/tickets/1'], ['POST', '/']
    ]) {
        const evento = eventoDePega(ruta, { method: metodo });
        manejadores.fetch(evento);
        assert.equal(evento.interceptado, false, `${metodo} ${ruta}`);
    }
});

test('las peticiones a otro origen (el CDN de Tailwind) no se tocan', () => {
    const { manejadores } = cargarServiceWorker();

    const evento = eventoDePega('https://cdn.tailwindcss.com/3.4.0');
    manejadores.fetch(evento);

    // Una respuesta de otro dominio es opaca: no se puede ni saber si fue un
    // error, así que guardarla a ciegas no tiene sentido.
    assert.equal(evento.interceptado, false);
});

test('la lista del armazón no contiene ninguna ruta de datos', () => {
    // La precarga de la instalación no pasa por el filtro de esSoloRed: si una
    // ruta de datos se colara en esta lista, se guardaría en el disco sin que
    // nadie la mirase.
    const { contexto } = cargarServiceWorker();
    const armazon = leer(contexto, 'ARMAZON');

    assert.ok(armazon.length > 0);
    for (const ruta of armazon) {
        assert.equal(contexto.esSoloRed(ruta), false, `${ruta} no puede estar en el armazón`);
    }
});

test('un 401 de la API no pasa por el service worker en absoluto', () => {
    // El requisito: si la sesión caduca, la redirección al portal tiene que
    // funcionar igual. Como no se intercepta, el 401 (y el 302 que vendría
    // después) llegan al navegador intactos.
    const { manejadores, llamadasFetch } = cargarServiceWorker({
        fetchDePega: async () => { throw new Error('el service worker no debería pedir esto'); }
    });

    const evento = eventoDePega('/api/tickets', { mode: 'cors' });
    manejadores.fetch(evento);

    assert.equal(evento.interceptado, false);
    assert.deepEqual(llamadasFetch, []);
});

test('una navegación que acaba en redirección no se guarda', () => {
    // Guardar una respuesta con redirected=true rompe el arranque siguiente:
    // devolverla a una navegación lanza un TypeError. Y además sería guardar la
    // página del portal bajo la URL de la aplicación.
    const { contexto } = cargarServiceWorker();

    assert.equal(contexto.sePuedeGuardar({ ok: true, status: 200, type: 'basic', redirected: true }), false);
    assert.equal(contexto.sePuedeGuardar({ ok: true, status: 200, type: 'opaque', redirected: false }), false);
    assert.equal(contexto.sePuedeGuardar({ ok: false, status: 401, type: 'basic', redirected: false }), false);
    assert.equal(contexto.sePuedeGuardar({ ok: true, status: 206, type: 'basic', redirected: false }), false);
    assert.equal(contexto.sePuedeGuardar(null), false);
    assert.equal(contexto.sePuedeGuardar({ ok: true, status: 200, type: 'basic', redirected: false }), true);
});

// =============================================================================
// ESTRATEGIA DEL ARMAZÓN
// =============================================================================

test('red primero: se devuelve lo de la red y se guarda una copia', async () => {
    const { contexto, cache, llamadasFetch } = cargarServiceWorker();

    const respuesta = await contexto.redPrimero({ url: ORIGEN + '/app.js', mode: 'no-cors' });

    assert.equal(respuesta.status, 200);
    assert.deepEqual(llamadasFetch, [ORIGEN + '/app.js']);
    // El guardado va sin await dentro del service worker: se le da un turno.
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(cache.puestas, [ORIGEN + '/app.js']);
});

test('sin red: se sirve la copia guardada', async () => {
    const { contexto, cache } = cargarServiceWorker({
        fetchDePega: async () => { throw new Error('sin cobertura'); }
    });

    const almacen = await cache.api.open(leer(contexto, 'CACHE_ARMAZON'));
    await almacen.put({ url: ORIGEN + '/app.js' }, { status: 200, cuerpo: 'guardado' });

    const respuesta = await contexto.redPrimero({ url: ORIGEN + '/app.js', mode: 'no-cors' });
    assert.equal(respuesta.cuerpo, 'guardado');
});

test('sin red y sin copia: una navegación cae en el index guardado', async () => {
    const { contexto, cache } = cargarServiceWorker({
        fetchDePega: async () => { throw new Error('sin cobertura'); }
    });

    const almacen = await cache.api.open(leer(contexto, 'CACHE_ARMAZON'));
    await almacen.put({ url: '/index.html' }, { status: 200, cuerpo: 'armazón' });

    const respuesta = await contexto.redPrimero({ url: ORIGEN + '/otra-pagina', mode: 'navigate' });
    assert.equal(respuesta.cuerpo, 'armazón');
});

test('una respuesta de error NO sustituye a la copia buena', async () => {
    const { contexto, cache } = cargarServiceWorker({
        fetchDePega: async () => ({ ok: false, status: 500, type: 'basic', redirected: false, clone() { return this; } })
    });

    const respuesta = await contexto.redPrimero({ url: ORIGEN + '/app.js', mode: 'no-cors' });

    assert.equal(respuesta.status, 500, 'el error se devuelve tal cual');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(cache.puestas, [], 'pero no se guarda');
});

// =============================================================================
// ACTIVACIÓN: BARRIDO DE SEGURIDAD
// =============================================================================

test('al activarse borra las cachés viejas y cualquier resto de datos', async () => {
    const { manejadores, cache, contexto } = cargarServiceWorker();

    // Una caché de una versión anterior.
    const vieja = await cache.api.open('ticket-scanner-armazon-v0');
    await vieja.put({ url: ORIGEN + '/app.js' }, { status: 200 });

    // Y, simulando un error de una versión futura, una respuesta de datos dentro
    // de la caché actual.
    const actual = await cache.api.open(leer(contexto, 'CACHE_ARMAZON'));
    await actual.put({ url: ORIGEN + '/app.js' }, { status: 200 });
    await actual.put({ url: ORIGEN + '/api/tickets' }, { status: 200, cuerpo: 'datos personales' });
    await actual.put({ url: ORIGEN + '/uploads/foto.jpg' }, { status: 200, cuerpo: 'una foto' });

    const evento = { waitUntil: (p) => p, esperar: null };
    manejadores.activate({ waitUntil(p) { evento.esperar = p; } });
    await evento.esperar;

    const nombreActual = leer(contexto, 'CACHE_ARMAZON');
    assert.deepEqual([...cache.almacen.keys()], [nombreActual], 'la vieja se borra entera');

    const quedan = [...cache.almacen.get(nombreActual).keys()];
    assert.deepEqual(quedan, [ORIGEN + '/app.js'], 'y de la actual se barren los datos');
    // El nombre de la caché lleva la versión: subirla es lo que invalida de golpe
    // el armazón viejo en el siguiente arranque.
    assert.match(nombreActual, /ticket-scanner-armazon-v\d+$/);
});

// =============================================================================
// MANIFIESTO E ICONOS
// =============================================================================

const manifiesto = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'manifest.webmanifest'), 'utf8'));

test('el manifiesto tiene lo que exige una PWA instalable', () => {
    assert.equal(manifiesto.display, 'standalone');
    assert.equal(manifiesto.start_url, '/');
    assert.equal(manifiesto.scope, '/');
    assert.ok(manifiesto.name && manifiesto.short_name);
    // Color de tema coherente con la interfaz: la superficie, no el acento.
    // La barra del navegador tiene que confundirse con la página, no competir.
    assert.equal(manifiesto.theme_color, '#f6f6f5');
    assert.equal(manifiesto.background_color, '#f6f6f5');
});

test('nombre e icono propios, distintos de los del panel del HPC', () => {
    // Las dos se instalan en la misma pantalla de inicio: si compartieran nombre
    // o icono no habría forma de distinguirlas.
    assert.match(manifiesto.short_name, /Tiquet/i);
    assert.doesNotMatch(JSON.stringify(manifiesto), /hpc/i);
});

test('los iconos declarados existen y miden lo que dicen medir', () => {
    // Un manifiesto que promete un 512×512 y entrega un 192 hace que el
    // navegador descarte el icono y la instalación se quede sin él.
    for (const icono of manifiesto.icons) {
        const archivo = path.join(PUBLIC, icono.src.replace(/^\//, ''));
        assert.ok(fs.existsSync(archivo), `falta ${icono.src} (genéralo con npm run iconos)`);

        const png = fs.readFileSync(archivo);
        assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${icono.src} no es un PNG`);

        const [ancho, alto] = icono.sizes.split('x').map(Number);
        assert.equal(png.readUInt32BE(16), ancho, `${icono.src}: ancho`);
        assert.equal(png.readUInt32BE(20), alto, `${icono.src}: alto`);
    }
});

test('hay un icono "maskable", que es el que Android recorta', () => {
    const recortable = manifiesto.icons.filter(i => String(i.purpose).includes('maskable'));
    assert.equal(recortable.length, 1);
    assert.equal(recortable[0].sizes, '512x512');
});

test('las tres páginas enlazan el manifiesto y registran el service worker', () => {
    // Se entra por index en producción y por login en desarrollo: la instalación
    // tiene que poder empezar desde donde se caiga.
    for (const pagina of ['index.html', 'login.html', 'sin-identidad.html']) {
        const html = fs.readFileSync(path.join(PUBLIC, pagina), 'utf8');
        assert.match(html, /rel="manifest" href="\/manifest\.webmanifest"/, pagina);
        assert.match(html, /name="theme-color"/, pagina);
        assert.match(html, /src="\/pwa\.js"/, pagina);
    }
});

test('el armazón declarado existe en el disco', () => {
    // Un 404 en la precarga no rompe la instalación (se toleran los fallos), pero
    // deja la aplicación sin esa pieza al abrirla sin red.
    const { contexto } = cargarServiceWorker();

    for (const ruta of leer(contexto, 'ARMAZON')) {
        if (ruta === '/') continue;   // es index.html servido por express.static
        assert.ok(
            fs.existsSync(path.join(PUBLIC, ruta.replace(/^\//, ''))),
            `el armazón declara ${ruta} y no está en src/public`
        );
    }
});
