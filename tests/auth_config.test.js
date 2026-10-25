/**
 * Aborto al arrancar cuando falta configuración de autenticación.
 *
 * Esto se prueba en procesos HIJOS y no aquí dentro: el fallo es un
 * `process.exit(1)` al cargar el módulo, y llamarlo en el proceso de la prueba
 * mataría el runner. Lanzar un hijo también es más fiel a lo que pasa de verdad:
 * lo que se comprueba es que `node src/app.js` no arranque.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { hashearPassword } = require('../src/services/password.js');
const RAIZ = path.join(__dirname, '..');

const HASH_BUENO = hashearPassword('una-contrasena-cualquiera');
const SECRETO_BUENO = 'x'.repeat(48);
const REDES_BUENAS = '10.42.0.0/16';

/**
 * Carga src/services/auth.js en un proceso nuevo con el entorno dado.
 *
 * El entorno se construye desde cero (no se hereda el del proceso de pruebas ni
 * el .env del proyecto) salvo lo imprescindible para que Node arranque. Así una
 * variable que exista en el .env real no puede enmascarar un fallo.
 *
 * `codigo` permite pedirle algo más que cargarse: se usa para imprimir el resumen
 * de arranque y comprobar qué dice.
 */
function cargarAuthCon(variables, codigo = "require('./src/services/auth.js'); console.log('ARRANCADO');") {
    const entorno = {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,     // Windows lo necesita
        // dotenv leería el .env del proyecto y colaría variables reales; con esto
        // se le dice que cargue un fichero que no existe.
        DOTENV_CONFIG_PATH: path.join(RAIZ, '.env.inexistente-para-pruebas'),
        ...variables
    };

    return spawnSync(process.execPath, ['-e', codigo], { cwd: RAIZ, env: entorno, encoding: 'utf8' });
}

/** Lanza un hijo que imprime el resumen de arranque y devuelve su salida. */
function resumenCon(variables) {
    const r = cargarAuthCon(
        variables,
        "console.log(require('./src/services/auth.js').resumenDeArranque());"
    );
    assert.equal(r.status, 0, (r.stdout || '') + (r.stderr || ''));
    return r.stdout;
}

/** Comprueba que abortó, con el código 1 y explicando qué falta. */
function assertAborta(resultado, patronDelMotivo) {
    const salida = (resultado.stdout || '') + (resultado.stderr || '');
    assert.equal(resultado.status, 1, `esperaba código 1, salió ${resultado.status}.\n${salida}`);
    assert.doesNotMatch(salida, /ARRANCADO/, 'no debería haber llegado a cargar');
    assert.match(salida, /CONFIGURACIÓN DE AUTENTICACIÓN INCOMPLETA/);
    assert.match(salida, patronDelMotivo);
}

/** Comprueba que arrancó. */
function assertArranca(resultado) {
    assert.equal(resultado.status, 0, (resultado.stdout || '') + (resultado.stderr || ''));
    assert.match(resultado.stdout, /ARRANCADO/);
}

// =============================================================================
// FALTA AUTH_MODE
// =============================================================================

test('sin AUTH_MODE aborta: no hay modo por defecto a propósito', () => {
    assertAborta(cargarAuthCon({}), /Falta AUTH_MODE/);
});

test('con un AUTH_MODE inventado aborta diciendo cuáles valen', () => {
    const r = cargarAuthCon({ AUTH_MODE: 'ldap' });
    assertAborta(r, /no es un modo válido/);
    assert.match(r.stderr + r.stdout, /"proxy" y "local"/);
});

// =============================================================================
// MODO PROXY (el principal)
// =============================================================================

test('proxy sin AUTH_PROXY_IPS_PERMITIDAS aborta: es la defensa en profundidad', () => {
    // Sin lista de orígenes, bastaría llegar al puerto con una cabecera inventada.
    // No hay valor por defecto aunque el de este clúster se sepa: una lista que la
    // aplicación se inventa es una lista en la que nadie ha pensado.
    const r = cargarAuthCon({ AUTH_MODE: 'proxy' });
    assertAborta(r, /Falta AUTH_PROXY_IPS_PERMITIDAS/);
    assert.match(r.stderr + r.stdout, /10\.42\.0\.0\/16/, 'dice qué poner para K3s');
});

test('proxy con una entrada mal escrita en la lista de IPs aborta', () => {
    // Se aborta en vez de ignorar la entrada mala: en una lista de control de
    // acceso, saltarse lo que no se entiende acaba abriendo o cerrando de más.
    for (const lista of ['10.42.0.0/48', 'no-es-una-ip', '10.42.0.0/16, 1.2.3.4/x',
                         '999.1.1.1', '10.42.0.0/16,::ffff:10.0.0.0/64']) {
        const r = cargarAuthCon({ AUTH_MODE: 'proxy', AUTH_PROXY_IPS_PERMITIDAS: lista });
        assertAborta(r, /no se entienden/);
    }
});

test('proxy sin AUTH_PROXY_HEADER arranca: el nombre por defecto es el de Authelia', () => {
    // A diferencia de la lista de IPs, aquí sí hay valor por defecto: Remote-User.
    // Equivocarse con el nombre de la cabecera no abre nada —si el portal manda
    // otra, no se autentica nadie—, así que el valor por defecto no es una
    // decisión de seguridad tomada a espaldas de nadie.
    assertArranca(cargarAuthCon({ AUTH_MODE: 'proxy', AUTH_PROXY_IPS_PERMITIDAS: REDES_BUENAS }));

    const resumen = resumenCon({ AUTH_MODE: 'proxy', AUTH_PROXY_IPS_PERMITIDAS: REDES_BUENAS });
    assert.match(resumen, /remote-user/);
    assert.match(resumen, /remote-email/);
    assert.match(resumen, /remote-name/);
    assert.match(resumen, /10\.42\.0\.0\/16/, 'imprime desde dónde acepta peticiones');
});

test('proxy con otro nombre de cabecera: se usa el configurado', () => {
    const resumen = resumenCon({
        AUTH_MODE: 'proxy',
        AUTH_PROXY_IPS_PERMITIDAS: REDES_BUENAS,
        AUTH_PROXY_HEADER: 'X-Forwarded-User',
        AUTH_PROXY_HEADER_EMAIL: 'X-Forwarded-Email'
    });
    assert.match(resumen, /x-forwarded-user/, 'se normaliza a minúsculas, como las cabeceras de Node');
    assert.match(resumen, /x-forwarded-email/);
    assert.doesNotMatch(resumen, /remote-user/);
});

test('proxy con todo en su sitio NO pide hash ni secreto de sesión', () => {
    // En modo proxy la aplicación no gestiona contraseñas: exigir esas dos
    // variables obligaría a inventarse valores que nadie usa.
    assertArranca(cargarAuthCon({ AUTH_MODE: 'proxy', AUTH_PROXY_IPS_PERMITIDAS: REDES_BUENAS }));
});

test('proxy con una URL de portal que no es http(s) aborta', () => {
    // Ese valor acaba en un redirect y en un href del frontend: admitir cualquier
    // esquema sería abrir un agujero en casa.
    for (const variable of ['AUTH_PORTAL_URL', 'AUTH_LOGOUT_URL']) {
        for (const url of ['javascript:alert(1)', 'data:text/html,hola', '//otro-sitio.tld']) {
            const r = cargarAuthCon({
                AUTH_MODE: 'proxy', AUTH_PROXY_IPS_PERMITIDAS: REDES_BUENAS, [variable]: url
            });
            assertAborta(r, /no es una URL admitida/);
        }
    }
});

test('proxy sin URL de portal arranca y avisa de a dónde irá la gente', () => {
    // Es opcional a propósito: no es una decisión de seguridad, y bloquear el
    // arranque por una URL cosmética sería excesivo. Pero conviene saberlo.
    const resumen = resumenCon({ AUTH_MODE: 'proxy', AUTH_PROXY_IPS_PERMITIDAS: REDES_BUENAS });
    assert.match(resumen, /sin-identidad\.html/);

    const conPortal = resumenCon({
        AUTH_MODE: 'proxy',
        AUTH_PROXY_IPS_PERMITIDAS: REDES_BUENAS,
        AUTH_PORTAL_URL: 'https://auth.ejemplo.tld'
    });
    assert.match(conPortal, /Portal: https:\/\/auth\.ejemplo\.tld/);
});

// =============================================================================
// MODO LOCAL
// =============================================================================

test('local sin AUTH_PASSWORD_HASH aborta y dice cómo generarlo', () => {
    const r = cargarAuthCon({ AUTH_MODE: 'local', SESSION_SECRET: SECRETO_BUENO });
    assertAborta(r, /Falta AUTH_PASSWORD_HASH/);
    assert.match(r.stderr + r.stdout, /npm run hash-password/);
});

test('local con un AUTH_PASSWORD_HASH mal formado aborta', () => {
    for (const hash of ['no-es-un-hash', 'scrypt$1$2$3', 'bcrypt$1$2$3$4$5',
                        HASH_BUENO.slice(0, 20), 'scrypt$0$8$1$c2FsdA==$aGFzaA==']) {
        assertAborta(
            cargarAuthCon({ AUTH_MODE: 'local', AUTH_PASSWORD_HASH: hash, SESSION_SECRET: SECRETO_BUENO }),
            /no tiene el formato esperado/
        );
    }
});

test('local sin SESSION_SECRET aborta: sin él se falsifica cualquier sesión', () => {
    const r = cargarAuthCon({ AUTH_MODE: 'local', AUTH_PASSWORD_HASH: HASH_BUENO });
    assertAborta(r, /Falta SESSION_SECRET/);
    assert.match(r.stderr + r.stdout, /randomBytes/);
});

test('local con un SESSION_SECRET corto aborta diciendo el mínimo', () => {
    const r = cargarAuthCon({
        AUTH_MODE: 'local', AUTH_PASSWORD_HASH: HASH_BUENO, SESSION_SECRET: 'corto'
    });
    assertAborta(r, /demasiado corto/);
    assert.match(r.stderr + r.stdout, /Mínimo 32/);
});

test('local con todo en su sitio arranca, y NO pide lista de IPs', () => {
    // La lista de orígenes es del modo proxy: en local la identidad va firmada en
    // la cookie, no hay cabecera en la que confiar.
    const r = cargarAuthCon({
        AUTH_MODE: 'local', AUTH_PASSWORD_HASH: HASH_BUENO, SESSION_SECRET: SECRETO_BUENO
    });
    assertArranca(r);
});

test('el resumen del modo local avisa de que es de desarrollo', () => {
    const resumen = resumenCon({
        AUTH_MODE: 'local', AUTH_PASSWORD_HASH: HASH_BUENO, SESSION_SECRET: SECRETO_BUENO
    });
    assert.match(resumen, /modo 'local'/);
    assert.match(resumen, /DESARROLLO/);
});

// =============================================================================
// LA APLICACIÓN ENTERA TAMPOCO ARRANCA
// =============================================================================

test('`node src/app.js` sin configuración de auth no llega a escuchar', () => {
    // La comprobación importante: el aborto ocurre ANTES de abrir el puerto, así
    // que no hay ninguna ventana en la que la aplicación sirva sin protección.
    const r = spawnSync(process.execPath, ['src/app.js'], {
        cwd: RAIZ,
        encoding: 'utf8',
        timeout: 15000,
        env: {
            PATH: process.env.PATH,
            SystemRoot: process.env.SystemRoot,
            DOTENV_CONFIG_PATH: path.join(RAIZ, '.env.inexistente-para-pruebas'),
            PORT: '0',
            TICKETS_DB_PATH: path.join(require('node:os').tmpdir(), `auth-abort-${Date.now()}.db`),
            AUTH_MODE: ''   // vacío = como si no estuviera
        }
    });

    const salida = (r.stdout || '') + (r.stderr || '');
    assert.equal(r.status, 1, salida);
    assert.match(salida, /CONFIGURACIÓN DE AUTENTICACIÓN INCOMPLETA/);
    assert.doesNotMatch(salida, /Servidor arrancado/, 'nunca debe llegar a escuchar');
});

test('`node src/app.js` en modo proxy sin lista de IPs tampoco llega a escuchar', () => {
    // El caso realista del despliegue: el modo está bien, falta la variable que
    // hace que la cabecera sea de fiar.
    const r = spawnSync(process.execPath, ['src/app.js'], {
        cwd: RAIZ,
        encoding: 'utf8',
        timeout: 15000,
        env: {
            PATH: process.env.PATH,
            SystemRoot: process.env.SystemRoot,
            DOTENV_CONFIG_PATH: path.join(RAIZ, '.env.inexistente-para-pruebas'),
            PORT: '0',
            TICKETS_DB_PATH: path.join(require('node:os').tmpdir(), `auth-abort-ips-${Date.now()}.db`),
            AUTH_MODE: 'proxy'
        }
    });

    const salida = (r.stdout || '') + (r.stderr || '');
    assert.equal(r.status, 1, salida);
    assert.match(salida, /Falta AUTH_PROXY_IPS_PERMITIDAS/);
    assert.doesNotMatch(salida, /Servidor arrancado/);
});
