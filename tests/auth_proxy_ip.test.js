/**
 * AUTH_MODE=proxy: rechazo por IP de ORIGEN.
 *
 * Confiar en una cabecera solo es seguro si nadie puede llegar al puerto sin
 * pasar por el portal, así que el modo proxy comprueba además desde dónde llega
 * la petición. Aquí la lista de permitidas es la red de pods de K3s y NADA MÁS,
 * así que las peticiones del arnés (que salen de 127.0.0.1) tienen que rechazarse
 * aunque traigan una cabecera de identidad perfectamente formada.
 *
 * Va en su propio fichero porque auth.js lee la configuración al importarse: una
 * lista de permitidas distinta exige otro proceso. El runner de node:test da un
 * proceso por fichero.
 */
process.env.AUTH_MODE                 = 'proxy';
process.env.AUTH_PROXY_IPS_PERMITIDAS = '10.42.0.0/16';
delete process.env.AUTH_PROXY_HEADER;
delete process.env.AUTH_PORTAL_URL;
delete process.env.AUTH_LOGOUT_URL;

const CABECERA = 'remote-user';

const test = require('node:test');
const assert = require('node:assert/strict');

const { ctx, crearTicket } = require('./ayuda_api.js');
const auth = require('../src/services/auth.js');
const redes = require('../src/services/redes.js');

const pedirCrudo = (metodo, ruta, { headers = {}, cuerpo } = {}) => {
    const opciones = { method: metodo, headers: { ...headers }, redirect: 'manual' };
    if (cuerpo !== undefined) {
        opciones.headers['Content-Type'] = 'application/json';
        opciones.body = JSON.stringify(cuerpo);
    }
    return fetch(ctx.base + ruta, opciones);
};

const conIdentidad = () => ({ [CABECERA]: 'isaac' });

// =============================================================================
// LA CABECERA NO VALE SI VIENE DE DONDE NO DEBE
// =============================================================================

test('cabecera válida desde una IP no admitida: 403, no 401', async () => {
    crearTicket({ tipo_documento: 'COMPRA' });

    const res = await pedirCrudo('GET', '/api/tickets', { headers: conIdentidad() });

    // 403 y no 401 a propósito: no es que falte identidad, es que la petición no
    // viene de donde tiene que venir. Mandar a esta gente al portal no arreglaría
    // nada, volvería con el mismo origen.
    assert.equal(res.status, 403);
    const datos = await res.json();
    assert.equal(datos.autenticado, false);
    assert.equal(datos.origen_no_admitido, true);
    assert.match(datos.error, /origen no admitido/i);
    // Ni rastro de los tiquets.
    assert.equal(Array.isArray(datos), false);
});

test('el 403 no revela qué redes están admitidas', async () => {
    const datos = await pedirCrudo('GET', '/api/tickets', { headers: conIdentidad() })
        .then(r => r.json());

    const texto = JSON.stringify(datos);
    assert.doesNotMatch(texto, /10\.42/, 'la lista de permitidas no se publica');
    // La IP que sí se devuelve es la de quien pregunta, que ya la conoce: sirve
    // para diagnosticar un 403 propio sin filtrar nada.
    assert.match(String(datos.origen || ''), /127\.0\.0\.1/);
});

test('/uploads desde una IP no admitida: 403 y sin la imagen', async () => {
    const { archivo } = crearTicket({});
    const res = await pedirCrudo('GET', `/uploads/${archivo}`, { headers: conIdentidad() });

    assert.equal(res.status, 403);
    assert.doesNotMatch(await res.text(), /no-es-una-imagen-de-verdad/);
});

test('/api/auth/estado desde una IP no admitida también se rechaza', async () => {
    const res = await pedirCrudo('GET', '/api/auth/estado', { headers: conIdentidad() });

    assert.equal(res.status, 403);
    assert.equal((await res.json()).origen_no_admitido, true);
});

test('sin cabecera y desde una IP no admitida: manda el origen', async () => {
    // El orden importa: primero de dónde viene, después quién dice ser. Al revés,
    // una cabecera inyectada desde fuera llegaría a mirarse.
    const res = await pedirCrudo('GET', '/api/tickets');
    assert.equal(res.status, 403);
});

test('/ping sigue público desde cualquier origen', async () => {
    // Las sondas de Kubernetes las lanza el kubelet desde la IP del NODO, que no
    // está en la red de pods. Si el healthcheck comprobara el origen, el pod se
    // reiniciaría en bucle.
    const res = await pedirCrudo('GET', '/ping');
    assert.equal(res.status, 200);
    assert.match((await res.json()).message, /Pong/);
});

test('identidadDe() respeta el origen: sin red admitida no hay nadie', () => {
    const peticionFalsa = (ip) => ({
        headers: { [CABECERA]: 'isaac' },
        socket: { remoteAddress: ip },
        originalUrl: '/api/tickets'
    });

    assert.equal(auth.identidadDe(peticionFalsa('127.0.0.1')), null);
    assert.equal(auth.identidadDe(peticionFalsa('10.43.0.1')), null);
    assert.equal(auth.identidadDe(peticionFalsa('10.42.0.7')).usuario, 'isaac');
    // Así llega una conexión IPv4 a un socket IPv6: tiene que valer igual.
    assert.equal(auth.identidadDe(peticionFalsa('::ffff:10.42.0.7')).usuario, 'isaac');
});

test('comprobarOrigen explica el motivo y dice qué IP ha visto', () => {
    const problema = auth.comprobarOrigen({ headers: {}, socket: { remoteAddress: '192.168.1.5' } });
    assert.equal(problema.ip, '192.168.1.5');
    assert.match(problema.motivo, /AUTH_PROXY_IPS_PERMITIDAS/);

    assert.equal(auth.comprobarOrigen({ headers: {}, socket: { remoteAddress: '10.42.9.9' } }), null);
    // Sin socket no se puede saber de dónde viene: se rechaza, no se asume.
    assert.ok(auth.comprobarOrigen({ headers: {}, socket: {} }));
});

// =============================================================================
// EL EMPAREJADOR DE REDES, A SOLAS
// =============================================================================
// Es lógica pura en src/services/redes.js: se prueba sin montar nada, que es lo
// que permite cubrir los casos raros sin levantar un servidor por cada uno.

test('CIDR: pertenencia, límites y familias', () => {
    const { redes: lista, invalidas } = redes.parsearRedes('10.42.0.0/16, 127.0.0.1, ::1, 2001:db8::/32');
    assert.deepEqual(invalidas, []);

    const dentro = (ip) => redes.ipEnRedes(ip, lista);

    assert.ok(dentro('10.42.0.1'));
    assert.ok(dentro('10.42.255.254'));
    assert.ok(!dentro('10.43.0.1'), 'justo fuera del /16');
    assert.ok(!dentro('10.41.255.255'), 'justo fuera por abajo');

    // IPv4-mapeada: la forma en la que llega una conexión IPv4 a un socket IPv6.
    assert.ok(dentro('::ffff:10.42.0.7'));
    assert.ok(dentro('[::ffff:10.42.0.7]'), 'con corchetes, como en algunos logs');

    // Una dirección suelta en la lista es un /32 (o /128): solo ella.
    assert.ok(dentro('127.0.0.1'));
    assert.ok(!dentro('127.0.0.2'));

    // IPv6 y IPv4 no se mezclan: ::1 y 127.0.0.1 son direcciones distintas y
    // ninguna está "dentro" de la red de la otra.
    assert.ok(dentro('::1'));
    assert.ok(dentro('2001:db8::5'));
    assert.ok(!dentro('2001:db9::5'));
});

test('CIDR: el prefijo se aplica al bit, no al byte', () => {
    const { redes: lista } = redes.parsearRedes('10.42.0.0/15');
    assert.ok(redes.ipEnRedes('10.43.255.255', lista), 'un /15 abarca dos /16');
    assert.ok(!redes.ipEnRedes('10.44.0.1', lista));
    assert.ok(!redes.ipEnRedes('10.41.255.255', lista));
});

test('CIDR: una lista vacía no admite a nadie', () => {
    assert.equal(redes.ipEnRedes('10.42.0.1', []), false);
    assert.deepEqual(redes.parsearRedes('').redes, []);
    assert.deepEqual(redes.parsearRedes('  ,  ,').redes, []);
});

test('CIDR: lo que no se entiende se devuelve como inválido, no se ignora', () => {
    const { redes: lista, invalidas } = redes.parsearRedes(
        '10.42.0.0/16, 10.0.0.0/33, 10.0.0.0/48, no-es-una-ip, 1.2.3.4/x, 999.1.1.1, ' +
        '010.0.0.1, 1.2.3, fe80::/129, ::ffff:10.0.0.0/64'
    );

    assert.equal(lista.length, 1, 'solo la buena sobrevive');
    assert.equal(invalidas.length, 9);
    // Los ceros a la izquierda se rechazan: '010' podría leerse como octal y
    // adivinar la intención en una lista de control de acceso no es opción.
    assert.ok(invalidas.includes('010.0.0.1'));
});

test('CIDR: una red mapeada lleva el prefijo contado sobre 128 bits', () => {
    // ::ffff:10.42.0.0/112 es el mismo /16 de siempre: los 96 primeros bits son
    // el prefijo mapeado. Si no se restaran, la máscara saldría disparatada.
    const red = redes.parsearRed('::ffff:10.42.0.0/112');
    assert.equal(red.prefijo, 16);
    assert.equal(red.bytes.length, 4);
    assert.ok(redes.ipEnRedes('10.42.1.1', [red]));
    assert.ok(!redes.ipEnRedes('10.43.1.1', [red]));
});

test('CIDR: formas de IPv6 que hay que entender (y una que no)', () => {
    assert.ok(redes.aBytes('::'), 'todo ceros');
    assert.ok(redes.aBytes('fe80::1%eth0'), 'con índice de zona');
    assert.ok(redes.aBytes('2001:0db8:0000:0000:0000:0000:0000:0001'), 'sin comprimir');
    assert.equal(redes.aBytes('2001:db8::1::2'), null, 'dos veces "::"');
    assert.equal(redes.aBytes('2001:db8:::1'), null);
    assert.equal(redes.aBytes('12345::1'), null, 'grupo de más de 4 dígitos');
    assert.equal(redes.aBytes('2001:db8:0:0:0:0:0:0:1'), null, 'nueve grupos');

    // La forma "compatible" (::a.b.c.d) NO se traduce a IPv4: si se tradujera,
    // ::1 pasaría a ser 0.0.0.1, que es otra dirección.
    assert.equal(redes.aBytes('::1').length, 16);
    assert.equal(redes.aBytes('::ffff:10.0.0.1').length, 4);
});
