/**
 * Hash de contraseñas con scrypt.
 *
 * password.js está separado de auth.js precisamente para poder probarlo sin
 * montar ningún entorno: aquí no hay AUTH_MODE ni nada que configurar.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { hashearPassword, verificarPassword, parsearHash, SCRYPT } =
    require('../src/services/password.js');

test('el hash verifica su propia contraseña y rechaza cualquier otra', () => {
    const hash = hashearPassword('mi-contrasena-secreta');

    assert.equal(verificarPassword('mi-contrasena-secreta', hash), true);
    assert.equal(verificarPassword('mi-contrasena-secretA', hash), false);
    assert.equal(verificarPassword('mi-contrasena-secret', hash), false);
    assert.equal(verificarPassword('', hash), false);
    assert.equal(verificarPassword('otra cosa', hash), false);
});

test('dos hashes de la misma contraseña son distintos: hay sal aleatoria', () => {
    const a = hashearPassword('igual');
    const b = hashearPassword('igual');

    assert.notEqual(a, b, 'sin sal, dos usuarios con la misma clave tendrían el mismo hash');
    // Y los dos validan.
    assert.equal(verificarPassword('igual', a), true);
    assert.equal(verificarPassword('igual', b), true);
});

test('el formato lleva los parámetros dentro, para poder endurecerlos luego', () => {
    const hash = hashearPassword('x');
    const partes = hash.split('$');

    assert.equal(partes.length, 6);
    assert.equal(partes[0], 'scrypt');
    assert.equal(Number(partes[1]), SCRYPT.N);
    assert.equal(Number(partes[2]), SCRYPT.r);
    assert.equal(Number(partes[3]), SCRYPT.p);

    const parseado = parsearHash(hash);
    assert.equal(parseado.N, SCRYPT.N);
    assert.equal(parseado.keylen, SCRYPT.keylen);
    assert.equal(parseado.salt.length, 16);
});

test('un hash con parámetros distintos sigue validando: por eso viajan dentro', () => {
    // Simula un hash generado con parámetros más flojos de una versión anterior.
    const flojo = hashearPassword('historica', { N: 1024, r: 8, p: 1, keylen: 32 });
    assert.equal(verificarPassword('historica', flojo), true);
    assert.equal(verificarPassword('otra', flojo), false);
});

test('parsearHash rechaza cualquier cosa que no tenga la forma exacta', () => {
    for (const malo of [
        null, undefined, '', 'texto suelto',
        'scrypt$16384$8$1$soloCuatro',
        'scrypt$16384$8$1$sal$hash$sobra',
        'bcrypt$16384$8$1$c2FsdA==$aGFzaA==',
        'scrypt$0$8$1$c2FsdA==$aGFzaA==',         // N = 0
        'scrypt$-1$8$1$c2FsdA==$aGFzaA==',
        'scrypt$abc$8$1$c2FsdA==$aGFzaA==',
        'scrypt$16384$8$1$$aGFzaA==',             // sal vacía
        'scrypt$16384$8$1$c2FsdA==$'              // hash vacío
    ]) {
        assert.equal(parsearHash(malo), null, `debería rechazar: ${String(malo).slice(0, 30)}`);
    }
});

test('parsearHash pone tope a los parámetros: un N absurdo colgaría cada login', () => {
    assert.equal(parsearHash('scrypt$99999999$8$1$c2FsdA==$aGFzaA=='), null);
    assert.equal(parsearHash('scrypt$16384$9999$1$c2FsdA==$aGFzaA=='), null);
});

test('verificarPassword no lanza nunca con un hash roto: devuelve false', () => {
    // Es lo que protege el login de un .env mal pegado: 401, no un 500.
    for (const malo of [null, '', 'basura', 'scrypt$16384$8$1$x$y$z']) {
        assert.equal(verificarPassword('cualquiera', malo), false);
    }
});

test('acepta contraseñas con acentos, emoji y espacios', () => {
    for (const password of ['contraseña con ñ', 'añó 2026 €', '🔐 clave con emoji', '  espacios  ']) {
        const hash = hashearPassword(password);
        assert.equal(verificarPassword(password, hash), true, password);
        assert.equal(verificarPassword(password.trim(), hash), password.trim() === password);
    }
});
