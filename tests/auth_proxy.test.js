/**
 * AUTH_MODE=proxy: el MODO PRINCIPAL. La identidad la valida el portal (Authelia)
 * y llega en una cabecera HTTP.
 *
 * Lo que se comprueba aquí, más allá de que funcione, es que el PUNTO DE CONTROL
 * sea el mismo que en modo local: las mismas rutas protegidas, las mismas
 * públicas, el mismo 401. Lo único que cambia es de dónde sale la identidad.
 *
 * Este fichero NO fija AUTH_PROXY_HEADER a propósito: así se prueba el nombre por
 * defecto, 'Remote-User', que es el de Authelia. El rechazo por IP de origen va en
 * auth_proxy_ip.test.js, que necesita una lista de permitidas distinta y por tanto
 * otro proceso.
 */
const CABECERA        = 'remote-user';      // el valor por defecto, sin configurar
const CABECERA_EMAIL  = 'remote-email';
const CABECERA_NOMBRE = 'remote-name';

const PORTAL = 'https://auth.ejemplo.tld';
const SALIR  = 'https://auth.ejemplo.tld/logout';

process.env.AUTH_MODE                 = 'proxy';
process.env.AUTH_PROXY_IPS_PERMITIDAS = '127.0.0.1,::1';
process.env.AUTH_PORTAL_URL           = PORTAL;
process.env.AUTH_LOGOUT_URL           = SALIR;
delete process.env.AUTH_PROXY_HEADER;
delete process.env.AUTH_PASSWORD_HASH;
delete process.env.SESSION_SECRET;

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { ctx, crearTicket, UPLOADS_DIR } = require('./ayuda_api.js');
const auth = require('../src/services/auth.js');

const pedirCrudo = (metodo, ruta, { headers = {}, cuerpo } = {}) => {
    const opciones = { method: metodo, headers: { ...headers }, redirect: 'manual' };
    if (cuerpo !== undefined) {
        opciones.headers['Content-Type'] = 'application/json';
        opciones.body = JSON.stringify(cuerpo);
    }
    return fetch(ctx.base + ruta, opciones);
};

const conIdentidad = (usuario = 'ana') => ({ [CABECERA]: usuario });

// =============================================================================
// CABECERA AUSENTE
// =============================================================================

test('cabecera ausente: la API devuelve 401, sin login propio y apuntando al portal', async () => {
    crearTicket({});
    const res = await pedirCrudo('GET', '/api/tickets');

    assert.equal(res.status, 401);
    const datos = await res.json();
    assert.equal(datos.autenticado, false);
    assert.equal(datos.modo, 'proxy');
    // El frontend usa estos dos para no enseñar un formulario que no serviría de
    // nada y para saber a dónde mandar a quien no tiene identidad.
    assert.equal(datos.login_disponible, false);
    assert.equal(datos.portal_url, PORTAL);
    assert.match(datos.error, /no ha inyectado la cabecera/);
});

test('cabecera ausente: /uploads tampoco sirve la imagen, redirige al portal', async () => {
    const { archivo } = crearTicket({});
    assert.ok(fs.existsSync(path.join(UPLOADS_DIR, archivo)));

    const res = await pedirCrudo('GET', `/uploads/${archivo}`);

    assert.notEqual(res.status, 200);
    assert.equal(res.status, 302);
    // En modo proxy no hay login que ofrecer: se manda al portal, que es quien
    // puede autenticar.
    assert.equal(res.headers.get('location'), PORTAL);
    assert.doesNotMatch(await res.text(), /no-es-una-imagen-de-verdad/);
});

test('cabecera ausente: /ping sigue público, igual que en modo local', async () => {
    // Es el healthcheck de Kubernetes: si exigiera identidad, el pod se
    // reiniciaría en bucle.
    const res = await pedirCrudo('GET', '/ping');
    assert.equal(res.status, 200);
});

test('cabecera vacía o con solo espacios no es una identidad', async () => {
    for (const valor of ['', '   ', '\t']) {
        const res = await pedirCrudo('GET', '/api/tickets', { headers: { [CABECERA]: valor } });
        assert.equal(res.status, 401, `"${valor}" no debería valer como usuario`);
    }
});

test('una cabecera absurdamente larga se rechaza', async () => {
    const res = await pedirCrudo('GET', '/api/tickets', { headers: { [CABECERA]: 'a'.repeat(300) } });
    assert.equal(res.status, 401);
});

test('otra cabecera parecida no vale: solo la del usuario', async () => {
    // remote-email y remote-name SÍ se leen, pero como datos para mostrar, no
    // como identidad: sin remote-user no hay nadie autenticado.
    for (const otra of ['x-forwarded-user', 'x-user', CABECERA_EMAIL, CABECERA_NOMBRE, 'remote-users']) {
        const res = await pedirCrudo('GET', '/api/tickets', { headers: { [otra]: 'intruso' } });
        assert.equal(res.status, 401, `${otra} no debería valer como identidad`);
    }
});

// =============================================================================
// CABECERA PRESENTE
// =============================================================================

test('cabecera presente: acceso a la API y la identidad se propaga', async () => {
    crearTicket({ tipo_documento: 'COMPRA' });

    const res = await pedirCrudo('GET', '/api/tickets', { headers: conIdentidad() });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).tiquets.length, 1);

    const estado = await pedirCrudo('GET', '/api/auth/estado', { headers: conIdentidad() })
        .then(r => r.json());
    assert.equal(estado.autenticado, true);
    assert.equal(estado.usuario, 'ana');
    assert.equal(estado.modo, 'proxy');
    assert.equal(estado.login_disponible, false);
});

test('se leen también el correo y el nombre, para poder mostrar quién está conectado', async () => {
    const estado = await pedirCrudo('GET', '/api/auth/estado', {
        headers: {
            ...conIdentidad('ana'),
            [CABECERA_EMAIL]:  'ana@ejemplo.tld',
            [CABECERA_NOMBRE]: 'Ana García'
        }
    }).then(r => r.json());

    assert.equal(estado.usuario, 'ana');
    assert.equal(estado.email, 'ana@ejemplo.tld');
    assert.equal(estado.nombre, 'Ana García');
});

test('si el portal no manda correo ni nombre, la identidad sigue valiendo', async () => {
    const estado = await pedirCrudo('GET', '/api/auth/estado', { headers: conIdentidad() })
        .then(r => r.json());

    assert.equal(estado.autenticado, true);
    assert.equal(estado.email, null);
    assert.equal(estado.nombre, null);
});

test('cabecera presente: /uploads sirve la imagen', async () => {
    const { archivo } = crearTicket({});
    const res = await pedirCrudo('GET', `/uploads/${archivo}`, { headers: conIdentidad() });

    assert.equal(res.status, 200);
    assert.match(await res.text(), /no-es-una-imagen-de-verdad/);
});

test('en modo proxy NO se emite ninguna cookie de sesión', async () => {
    // La sesión es del portal. Emitir una nuestra sería otra fuente de identidad
    // por la puerta de atrás.
    const res = await pedirCrudo('GET', '/api/tickets', { headers: conIdentidad() });
    const puestas = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    assert.deepEqual(Array.from(puestas), []);
});

// =============================================================================
// TODO /api/* ESTÁ CERRADO POR DEFECTO
// =============================================================================

test('una ruta de /api que no existe también exige identidad', async () => {
    // El guard se monta sobre /api entero, no sobre cada router: una ruta nueva
    // nace protegida. Sin identidad ni siquiera se llega a saber si existe.
    const sin = await pedirCrudo('GET', '/api/lo-que-sea');
    assert.equal(sin.status, 401);

    const con = await pedirCrudo('GET', '/api/lo-que-sea', { headers: conIdentidad() });
    assert.equal(con.status, 404, 'con identidad sí se llega al 404 de siempre');
});

// =============================================================================
// AQUÍ NO HAY CONTRASEÑAS NI CIERRE DE SESIÓN PROPIO
// =============================================================================

test('POST /api/auth/login responde 404 explicando que aquí no hay contraseñas', async () => {
    const res = await pedirCrudo('POST', '/api/auth/login', { cuerpo: { password: 'lo-que-sea' } });

    assert.equal(res.status, 404);
    const datos = await res.json();
    assert.match(datos.error, /no gestiona contraseñas/);
    assert.equal(datos.modo, 'proxy');

    const puestas = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    assert.deepEqual(Array.from(puestas), [], 'y desde luego no entrega sesión');
});

test('POST /api/auth/logout responde 404 y da la URL de cierre del portal', async () => {
    // No se implementa cierre de sesión propio: la sesión es del portal y
    // "cerrarla" aquí sería mentir, porque la siguiente petición volvería a traer
    // la cabecera. Lo único honesto es el enlace al portal.
    const res = await pedirCrudo('POST', '/api/auth/logout', { headers: conIdentidad() });

    assert.equal(res.status, 404);
    const datos = await res.json();
    assert.match(datos.error, /se cierra en el portal/);
    assert.equal(datos.logout_url, SALIR);

    const puestas = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    assert.deepEqual(Array.from(puestas), [], 'no hay cookie que borrar');
});

test('el estado publica las URL del portal para que el frontend las use', async () => {
    const estado = await pedirCrudo('GET', '/api/auth/estado', { headers: conIdentidad() })
        .then(r => r.json());

    assert.equal(estado.portal_url, PORTAL);
    assert.equal(estado.logout_url, SALIR);
});

test('una cookie de sesión fabricada a mano no abre nada en modo proxy', async () => {
    // En modo proxy el adaptador no mira cookies. Aunque alguien tuviera una
    // cookie de un despliegue en modo local, aquí no vale.
    const res = await pedirCrudo('GET', '/api/tickets', {
        headers: { cookie: `${auth.COOKIE_SESION}=lo.que.sea` }
    });
    assert.equal(res.status, 401);
});

// =============================================================================
// LA INTERFAZ ES LA MISMA EN LOS DOS MODOS
// =============================================================================

test('el módulo expone la misma interfaz, sea cual sea el modo', () => {
    // Si esto cambiase, el resto de la aplicación tendría que saber en qué modo
    // está, que es exactamente lo que este diseño evita.
    for (const nombre of ['exigirIdentidad', 'identidadDe', 'estadoSesion',
                          'iniciarSesion', 'cerrarSesion', 'resumenDeArranque']) {
        assert.equal(typeof auth[nombre], 'function', `falta ${nombre}`);
    }
    assert.equal(auth.modo, 'proxy');
    assert.equal(auth.soportaLogin, false);
});

test('el resumen de arranque advierte de lo que hay que saber del modo proxy', () => {
    const resumen = auth.resumenDeArranque();
    assert.match(resumen, /modo 'proxy'/);
    assert.match(resumen, new RegExp(CABECERA));
    // Las redes admitidas se imprimen: sin eso, diagnosticar un 403 es a ciegas.
    assert.match(resumen, /127\.0\.0\.1/);
    // La advertencia tiene que estar donde se lee, no solo en la documentación.
    assert.match(resumen, /NADIE puede llegar a este puerto/);
});
