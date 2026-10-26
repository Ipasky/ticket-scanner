/**
 * Service worker: solo para que la aplicación sea instalable y su armazón abra
 * rápido. NO es una aplicación offline.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  REGLA QUE MANDA SOBRE TODAS LAS DEMÁS                                   │
 * │                                                                          │
 * │  NUNCA se guarda en caché nada de /api/* ni de /uploads/*.               │
 * │                                                                          │
 * │  Son datos personales —y acabarán siendo financieros—: importes,         │
 * │  establecimientos, matrículas y las fotos de los papeles. La caché de un │
 * │  service worker vive en el almacenamiento del navegador, sobrevive al    │
 * │  cierre de sesión y se queda en el disco del móvil. Una copia ahí es una │
 * │  copia que nadie ha pedido y que nadie va a borrar.                      │
 * │                                                                          │
 * │  Para esas rutas ni siquiera se llama a respondWith(): la petición sale  │
 * │  EXACTAMENTE como si no hubiera service worker. Así los 401, los 302 al  │
 * │  portal, las cookies y las peticiones por rango de las imágenes se       │
 * │  comportan igual que siempre, que es justo lo que se quiere: el service  │
 * │  worker no tiene nada que opinar sobre la sesión.                        │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * Lo que sí se cachea es el ARMAZÓN: el HTML, el JS de la página y los iconos.
 * Ahí no hay ni un dato; todo lo que se ve llega después por /api.
 */

// Subir la versión invalida la caché entera en el siguiente arranque. Es la
// única forma fiable de desplegar un cambio de armazón sin que alguien se quede
// con la página vieja.
const VERSION = 'v4';
const CACHE_ARMAZON = `ticket-scanner-armazon-${VERSION}`;

// El armazón. Ni una ruta de datos: si alguna se colara aquí, se precargaría en
// la instalación y acabaría en el disco sin pasar por ninguna comprobación.
const ARMAZON = [
    '/',
    '/index.html',
    '/login.html',
    '/sin-identidad.html',
    '/app.js',
    '/i18n.js',
    '/pwa.js',
    '/manifest.webmanifest',
    '/icono.svg',
    '/iconos/icono-192.png',
    '/iconos/icono-512.png'
];

// Todo lo que empiece por uno de estos prefijos es SOLO RED, sin excepción.
//   /api/      respuestas con los datos de los tiquets
//   /uploads/  las fotos de los papeles
//   /ping      healthcheck: cachearlo sería mentirle a Kubernetes
const PREFIJOS_SOLO_RED = ['/api/', '/uploads/', '/ping'];

/**
 * ¿Esta ruta es de las que no se tocan?
 *
 * Se compara sobre el PATHNAME ya normalizado por URL, no sobre el texto crudo
 * de la petición: así "/api/../api/tickets" o "//api/tickets" no se cuelan por
 * una comparación de cadenas ingenua.
 */
function esSoloRed(ruta) {
    const limpia = String(ruta || '');
    return PREFIJOS_SOLO_RED.some(p => limpia === p || limpia.startsWith(p));
}

/**
 * ¿Se puede guardar esta respuesta?
 *
 * Solo un 200 completo, del propio origen y sin redirecciones por el camino:
 *   · un 206 (rango) guardado se devolvería luego como si fuera el archivo entero
 *   · una respuesta opaca (otro origen, como el CDN de Tailwind) no se puede
 *     inspeccionar: no se sabe ni si fue un error
 *   · una redirigida guardada rompería el siguiente arranque, porque devolver
 *     una respuesta con redirected=true a una navegación lanza un TypeError
 */
function sePuedeGuardar(respuesta) {
    return Boolean(respuesta) &&
           respuesta.ok &&
           respuesta.status === 200 &&
           respuesta.type === 'basic' &&
           !respuesta.redirected;
}

// --- INSTALACIÓN -------------------------------------------------------------

self.addEventListener('install', (evento) => {
    evento.waitUntil((async () => {
        const cache = await caches.open(CACHE_ARMAZON);

        // Uno a uno y tolerando fallos: cache.addAll() es atómico, así que un
        // solo 404 (un icono que se renombró, por ejemplo) dejaría la aplicación
        // sin instalar entera. Vale más un armazón incompleto que ninguno.
        await Promise.allSettled(ARMAZON.map(ruta => cache.add(new Request(ruta, { cache: 'reload' }))));

        // Activar sin esperar a que se cierren las pestañas abiertas: no hay
        // estado compartido entre versiones que pueda romperse.
        await self.skipWaiting();
    })());
});

// --- ACTIVACIÓN --------------------------------------------------------------

self.addEventListener('activate', (evento) => {
    evento.waitUntil((async () => {
        const nombres = await caches.keys();

        await Promise.all(nombres.map(async (nombre) => {
            // Las cachés de versiones anteriores se tiran enteras.
            if (nombre !== CACHE_ARMAZON) return caches.delete(nombre);

            // Y en la nuestra, barrido de seguridad: si alguna versión futura
            // metiera por error una respuesta de datos, aquí se borra en la
            // siguiente activación en vez de quedarse en el disco para siempre.
            const cache = await caches.open(nombre);
            const guardadas = await cache.keys();
            await Promise.all(guardadas.map((peticion) => {
                const { pathname } = new URL(peticion.url);
                if (esSoloRed(pathname)) return cache.delete(peticion);
                return Promise.resolve();
            }));
        }));

        await self.clients.claim();
    })());
});

// --- PETICIONES --------------------------------------------------------------

/**
 * Red primero, caché de respaldo.
 *
 * Y no al revés: con caché primero, un despliegue nuevo no llegaría hasta que
 * caducara algo, y el armazón viejo hablaría con una API nueva. La caché aquí es
 * una red de seguridad para cuando no hay cobertura, no la fuente de la verdad.
 */
async function redPrimero(peticion) {
    try {
        const respuesta = await fetch(peticion);

        if (sePuedeGuardar(respuesta)) {
            const copia = respuesta.clone();
            // Sin await: que guardar no retrase la respuesta a la página.
            caches.open(CACHE_ARMAZON)
                .then(cache => cache.put(peticion, copia))
                .catch(() => { /* quedarse sin caché no es motivo para fallar */ });
        }
        return respuesta;

    } catch (error) {
        const guardada = await caches.match(peticion);
        if (guardada) return guardada;

        // Una navegación sin red y sin copia de esa página concreta: se sirve el
        // armazón, que al arrancar pedirá /api y enseñará su propio error.
        if (peticion.mode === 'navigate') {
            const inicio = await caches.match('/index.html');
            if (inicio) return inicio;
        }
        throw error;
    }
}

self.addEventListener('fetch', (evento) => {
    const peticion = evento.request;

    // 1. Solo GET. Un POST de subida o un DELETE no se cachean jamás, y
    //    envolverlos no aportaría nada.
    if (peticion.method !== 'GET') return;

    let url;
    try {
        url = new URL(peticion.url);
    } catch (_) {
        return;   // si no se puede ni parsear, que se encargue el navegador
    }

    // 2. Otro origen (el CDN de Tailwind): no se toca. Una respuesta de otro
    //    dominio es opaca y guardarla a ciegas es justo lo que no se quiere.
    if (url.origin !== self.location.origin) return;

    // 3. Datos personales: SOLO RED. Sin respondWith, la petición sale como si
    //    este archivo no existiera.
    if (esSoloRed(url.pathname)) return;

    // 4. El armazón.
    evento.respondWith(redPrimero(peticion));
});
