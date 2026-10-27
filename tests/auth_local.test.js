/**
 * AUTH_MODE=local: la aplicación gestiona su propio login.
 *
 * El modo se fija ANTES de requerir el arnés, porque auth.js valida su
 * configuración al cargarse. Cada fichero de prueba es un proceso aparte, así que
 * este y auth_proxy.test.js pueden usar modos distintos sin estorbarse.
 */
const crypto = require('node:crypto');

// La contraseña de las pruebas y su hash, generado con las primitivas de verdad.
const { hashearPassword } = require('../src/services/password.js');
const PASSWORD = 'contrasena-de-prueba-larga';

process.env.AUTH_MODE           = 'local';
process.env.AUTH_USUARIO        = 'ana';
process.env.AUTH_PASSWORD_HASH  = hashearPassword(PASSWORD);
process.env.SESSION_SECRET      = crypto.randomBytes(48).toString('base64url');
process.env.AUTH_COOKIE_SECURE  = '';
delete process.env.AUTH_PROXY_HEADER;

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { ctx, crearTicket, UPLOADS_DIR } = require('./ayuda_api.js');
const auth = require('../src/services/auth.js');

// --- HELPERS ----------------------------------------------------------------

const url = (ruta) => ctx.base + ruta;

/** Petición cruda, con control total de las cabeceras. */
const pedirCrudo = (metodo, ruta, { cookie, cuerpo, headers = {} } = {}) => {
    const opciones = { method: metodo, headers: { ...headers }, redirect: 'manual' };
    if (cookie) opciones.headers.cookie = cookie;
    if (cuerpo !== undefined) {
        opciones.headers['Content-Type'] = 'application/json';
        opciones.body = JSON.stringify(cuerpo);
    }
    return fetch(url(ruta), opciones);
};

/** Saca el valor de la cookie de sesión de las cabeceras Set-Cookie. */
function cookieDeSesion(res) {
    const puestas = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    const nuestra = puestas.find(c => c.startsWith(`${auth.COOKIE_SESION}=`));
    if (!nuestra) return null;
    return nuestra.split(';')[0];   // "ts_sesion=xxx"
}

/** Entra y devuelve la cookie lista para reenviar. */
async function entrar(password = PASSWORD) {
    const res = await pedirCrudo('POST', '/api/auth/login', { cuerpo: { password } });
    return { res, cookie: cookieDeSesion(res) };
}

// =============================================================================
// ACCESO SIN SESIÓN, POR TIPO DE RUTA
// =============================================================================

test('sin sesión: /ping sigue siendo público (healthcheck de Kubernetes)', async () => {
    const res = await pedirCrudo('GET', '/ping');
    assert.equal(res.status, 200);
    const datos = await res.json();
    assert.match(datos.message, /Pong/);
});

test('sin sesión: la API de tiquets devuelve 401 y no datos', async () => {
    crearTicket({ tipo_documento: 'COMPRA' });

    for (const [metodo, ruta] of [
        ['GET', '/api/tickets'],
        ['GET', '/api/tickets/1'],
        ['PUT', '/api/tickets/1'],
        ['DELETE', '/api/tickets/1'],
        ['POST', '/api/tickets/1/reintentar'],
        ['POST', '/api/tickets/upload']
    ]) {
        const res = await pedirCrudo(metodo, ruta, metodo === 'PUT' ? { cuerpo: {} } : {});
        assert.equal(res.status, 401, `${metodo} ${ruta} debería ser 401`);
        const datos = await res.json();
        assert.equal(datos.autenticado, false);
        assert.equal(datos.login_disponible, true);
        // Y sobre todo: ni rastro de los tiquets.
        assert.equal(datos.items, undefined);
        assert.equal(Array.isArray(datos), false);
    }
});

test('sin sesión: /uploads NO sirve la imagen — era el agujero', async () => {
    // Antes esto era un express.static abierto: con la URL de la foto se veía el
    // tiquet entero (importe, establecimiento, matrícula) sin pasar por nada.
    const { archivo } = crearTicket({});
    assert.ok(fs.existsSync(path.join(UPLOADS_DIR, archivo)), 'la imagen existe en el disco');

    const res = await pedirCrudo('GET', `/uploads/${archivo}`);

    assert.notEqual(res.status, 200);
    assert.equal(res.status, 302, 'una imagen pedida a pelo se redirige al login');
    assert.equal(res.headers.get('location'), '/login.html');

    const cuerpo = await res.text();
    assert.doesNotMatch(cuerpo, /no-es-una-imagen-de-verdad/, 'no se filtra el contenido');
});

test('sin sesión: /uploads con Accept JSON devuelve 401 en lugar de redirigir', async () => {
    const { archivo } = crearTicket({});
    const res = await pedirCrudo('GET', `/uploads/${archivo}`, {
        headers: { accept: 'application/json' }
    });
    assert.equal(res.status, 401);
});

test('sin sesión: /api/auth/estado es público y dice que no hay sesión', async () => {
    const res = await pedirCrudo('GET', '/api/auth/estado');
    assert.equal(res.status, 200);
    const datos = await res.json();
    assert.equal(datos.modo, 'local');
    assert.equal(datos.autenticado, false);
    assert.equal(datos.login_disponible, true);
    assert.equal(datos.usuario, null);
});

// =============================================================================
// LOGIN
// =============================================================================

test('login correcto: cookie httpOnly, sameSite estricto y acceso a la API', async () => {
    const { res, cookie } = await entrar();

    assert.equal(res.status, 200);
    const datos = await res.json();
    assert.equal(datos.ok, true);
    assert.equal(datos.usuario, 'ana');

    assert.ok(cookie, 'tiene que venir una cookie de sesión');

    const cabecera = res.headers.getSetCookie().find(c => c.startsWith(auth.COOKIE_SESION));
    assert.match(cabecera, /HttpOnly/i, 'fuera del alcance del JS de la página');
    assert.match(cabecera, /SameSite=Strict/i);
    assert.match(cabecera, /Path=\//i);
    assert.match(cabecera, /Max-Age=\d+/i);
    // AUTH_COOKIE_SECURE está vacío: en desarrollo se entra por HTTP y con Secure
    // el navegador descartaría la cookie sin decir nada.
    assert.doesNotMatch(cabecera, /Secure/i);

    // Y con la cookie, la API responde.
    const lista = await pedirCrudo('GET', '/api/tickets', { cookie });
    assert.equal(lista.status, 200);
    // El listado devuelve { tiquets, total, ... } desde que hay paginación.
    assert.ok(Array.isArray((await lista.json()).tiquets));
});

test('con sesión: /uploads sí sirve la imagen, y como privada', async () => {
    const { archivo } = crearTicket({});
    const { cookie } = await entrar();

    const res = await pedirCrudo('GET', `/uploads/${archivo}`, { cookie });

    assert.equal(res.status, 200);
    assert.match(await res.text(), /no-es-una-imagen-de-verdad/);
    // Que ninguna caché intermedia las guarde como públicas.
    assert.match(res.headers.get('cache-control') || '', /private/);
});

test('login incorrecto: 401 y sin cookie', async () => {
    const res = await pedirCrudo('POST', '/api/auth/login', { cuerpo: { password: 'me-la-invento' } });

    assert.equal(res.status, 401);
    assert.equal(cookieDeSesion(res), null, 'no se entrega ninguna sesión');
    assert.match((await res.json()).error, /incorrecta/i);
});

test('login sin campo password: también falla, sin reventar', async () => {
    for (const cuerpo of [{}, { password: '' }, { password: null }, { password: 123 }]) {
        const res = await pedirCrudo('POST', '/api/auth/login', { cuerpo });
        assert.equal(res.status, 401);
    }
});

test('logout borra la cookie y la sesión deja de valer', async () => {
    const { cookie } = await entrar();
    assert.equal((await pedirCrudo('GET', '/api/tickets', { cookie })).status, 200);

    const salida = await pedirCrudo('POST', '/api/auth/logout', { cookie });
    assert.equal(salida.status, 200);
    const datos = await salida.json();
    assert.equal(datos.cerrada_aqui, true);

    // La cabecera de borrado vacía la cookie en el navegador.
    const borrado = salida.headers.getSetCookie().find(c => c.startsWith(auth.COOKIE_SESION));
    assert.ok(borrado, 'tiene que mandar un Set-Cookie de borrado');

    // Y una cookie vacía (lo que queda en el navegador) no vale.
    assert.equal((await pedirCrudo('GET', '/api/tickets', { cookie: `${auth.COOKIE_SESION}=` })).status, 401);
});

// =============================================================================
// COOKIE: MANIPULACIÓN Y CADUCIDAD
// =============================================================================

test('cookie manipulada: cualquier retoque la invalida', async () => {
    const { cookie } = await entrar();
    const valor = cookie.slice(auth.COOKIE_SESION.length + 1);
    const [payload, firma] = valor.split('.');

    // Payload cambiado manteniendo la firma original.
    const otroPayload = Buffer.from(
        JSON.stringify({ u: 'intruso', iat: Date.now(), exp: Date.now() + 1000000 })
    ).toString('base64url');

    const manipuladas = [
        `${otroPayload}.${firma}`,                 // otro usuario, firma vieja
        `${payload}.${firma.slice(0, -2)}XY`,      // firma retocada
        `${payload}.`,                             // sin firma
        payload,                                   // sin separador
        `${payload}.${Buffer.from('corta').toString('base64url')}`, // firma más corta
        'basura',
        `${Buffer.from('{no es json}').toString('base64url')}.${firma}`
    ];

    for (const falsa of manipuladas) {
        const res = await pedirCrudo('GET', '/api/tickets', { cookie: `${auth.COOKIE_SESION}=${falsa}` });
        assert.equal(res.status, 401, `debería rechazar: ${falsa.slice(0, 40)}`);
    }
});

test('cookie firmada con OTRO secreto no vale (cambiar SESSION_SECRET revoca todo)', async () => {
    // Es la única forma de revocar sesiones sin almacén en servidor, así que
    // conviene que funcione de verdad.
    const ajena = (() => {
        const payload = Buffer.from(JSON.stringify({
            u: 'ana', iat: Date.now(), exp: Date.now() + 1000000
        })).toString('base64url');
        const firma = crypto.createHmac('sha256', 'otro-secreto-completamente-distinto')
            .update(payload).digest().toString('base64url');
        return `${payload}.${firma}`;
    })();

    const res = await pedirCrudo('GET', '/api/tickets', { cookie: `${auth.COOKIE_SESION}=${ajena}` });
    assert.equal(res.status, 401);
});

test('expiración: una cookie caducada se rechaza aunque su firma sea buena', () => {
    // Se comprueba sobre las primitivas porque fabricar una cookie caducada por
    // HTTP exigiría esperar 30 días o manosear el reloj del proceso.
    const valorValido = auth.crearValorSesion('ana');
    assert.ok(auth.leerValorSesion(valorValido), 'recién emitida, válida');

    // Un instante después de su caducidad: la firma sigue siendo correcta y aun
    // así no vale.
    const dentroDe31Dias = Date.now() + auth.DURACION_SESION_MS + 1000;
    assert.equal(auth.leerValorSesion(valorValido, dentroDe31Dias), null);

    // Justo antes, todavía vale.
    const casiCaducada = Date.now() + auth.DURACION_SESION_MS - 5000;
    assert.ok(auth.leerValorSesion(valorValido, casiCaducada));
});

test('renovación al usarse: solo cuando la cookie ya tiene un día', async () => {
    const { cookie } = await entrar();

    // Recién emitida: no se renueva, para no meter un Set-Cookie en cada imagen
    // del historial.
    const reciente = await pedirCrudo('GET', '/api/tickets', { cookie });
    assert.equal(cookieDeSesion(reciente), null, 'no debería renovar una cookie recién emitida');

    // Con más de un día encima, sí. Se fabrica una con iat antiguo y firma buena.
    const vieja = auth.crearValorSesion('ana', Date.now() - auth.RENOVAR_PASADO_MS - 60000);
    const res = await pedirCrudo('GET', '/api/tickets', { cookie: `${auth.COOKIE_SESION}=${vieja}` });

    assert.equal(res.status, 200);
    const renovada = cookieDeSesion(res);
    assert.ok(renovada, 'una cookie de más de un día se renueva al usarse');

    // Y la renovada arranca de cero los 30 días.
    const datos = auth.leerValorSesion(renovada.slice(auth.COOKIE_SESION.length + 1));
    assert.ok(datos.exp - Date.now() > auth.DURACION_SESION_MS - 60000);
});

// =============================================================================
// EN MODO LOCAL, LA CABECERA DE PROXY NO SIRVE DE NADA
// =============================================================================

test('en modo local, inyectar una cabecera de identidad no abre nada', async () => {
    for (const cabecera of ['x-forwarded-user', 'remote-user', 'x-usuario-prueba']) {
        const res = await pedirCrudo('GET', '/api/tickets', { headers: { [cabecera]: 'intruso' } });
        assert.equal(res.status, 401, `${cabecera} no debería valer en modo local`);
    }
});

// =============================================================================
// NO HAY LIMITACIÓN DE INTENTOS, Y ES DELIBERADO
// =============================================================================

test('muchos fallos seguidos no bloquean nada: este modo es el del portátil', async () => {
    // Decisión explícita: el modo local solo existe en desarrollo. En producción
    // la aplicación va detrás del portal, y contar intentos o bloquear IPs lo hace
    // el portal, que es quien los ve de verdad. Meter aquí un contador en memoria
    // sería código que nunca corre donde importa.
    for (let i = 0; i < 12; i++) {
        const res = await pedirCrudo('POST', '/api/auth/login', { cuerpo: { password: 'no' } });
        await res.json();
        assert.equal(res.status, 401, 'siempre 401, nunca un 429');
    }

    // Y la contraseña buena sigue entrando: no hay bloqueo que levantar.
    const { res, cookie } = await entrar();
    assert.equal(res.status, 200);
    assert.ok(cookie);
});

// =============================================================================
// TODO /api/* ESTÁ CERRADO POR DEFECTO, TAMBIÉN AQUÍ
// =============================================================================

test('una ruta de /api que no existe también exige sesión', async () => {
    const sin = await pedirCrudo('GET', '/api/lo-que-sea');
    assert.equal(sin.status, 401);

    const { cookie } = await entrar();
    const con = await pedirCrudo('GET', '/api/lo-que-sea', { cookie });
    assert.equal(con.status, 404, 'con sesión sí se llega al 404 de siempre');
});
