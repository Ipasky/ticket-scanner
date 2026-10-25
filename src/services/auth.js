/**
 * Autenticación con FUENTE DE IDENTIDAD CONMUTABLE.
 *
 * El resto de la aplicación no sabe de dónde sale la identidad: usa
 * `exigirIdentidad` como middleware y `identidadDe(req)` para saber quién es.
 * Debajo hay un adaptador por fuente, seleccionado con AUTH_MODE:
 *
 *   AUTH_MODE=proxy  MODO PRINCIPAL. La identidad la valida un portal (Authelia)
 *                    delante del servicio y llega en una cabecera HTTP. La
 *                    aplicación no gestiona contraseñas ni cierra sesión: eso es
 *                    del portal.
 *   AUTH_MODE=local  Sesión propia con contraseña y cookie firmada. SOLO para
 *                    desarrollo en el portátil, donde no hay portal delante.
 *
 * El middleware de protección es EL MISMO en los dos modos: cambia el adaptador,
 * no el punto de control. Es el mismo patrón que tiquets_plan.md describe para
 * AI_BACKEND: interfaz estable, un adaptador por fuente.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  POR QUÉ EL MODO PROXY COMPRUEBA ADEMÁS LA IP DE ORIGEN                  │
 * │                                                                          │
 * │  Una cabecera HTTP la puede escribir cualquiera. Confiar en ella solo es  │
 * │  seguro si NADIE puede llegar a este puerto sin pasar por el portal: con  │
 * │  el puerto accesible, un `curl -H "Remote-User: quien-sea"` entra como    │
 * │  quien quiera.                                                           │
 * │                                                                          │
 * │  Por eso AUTH_PROXY_IPS_PERMITIDAS es OBLIGATORIA en modo proxy y SÍ se   │
 * │  aplica: una petición que venga de fuera de esas redes se rechaza con 403 │
 * │  aunque traiga la cabecera. Es defensa en profundidad —el cortafuegos y   │
 * │  la NetworkPolicy ya deberían impedir que nadie más alcance el puerto—,   │
 * │  no la única defensa: el origen se toma del socket, que no se puede       │
 * │  falsificar desde fuera, pero quien ya esté DENTRO de la red de pods sí   │
 * │  podría inyectar la cabecera.                                            │
 * └──────────────────────────────────────────────────────────────────────────┘
 */
const crypto = require('crypto');
const { hashearPassword, verificarPassword, parsearHash } = require('./password.js');
const { parsearRedes, ipEnRedes } = require('./redes.js');

// --- CONSTANTES --------------------------------------------------------------

const MODO_LOCAL = 'local';
const MODO_PROXY = 'proxy';
const MODOS_VALIDOS = [MODO_LOCAL, MODO_PROXY];

// Nombres por defecto de las cabeceras: los de Authelia, que es el portal que va
// delante. Son configurables porque cada portal usa los suyos (oauth2-proxy pone
// X-Forwarded-User, Cloudflare Access Cf-Access-Authenticated-User-Email...).
const CABECERA_USUARIO_POR_DEFECTO = 'remote-user';
const CABECERA_EMAIL_POR_DEFECTO   = 'remote-email';
const CABECERA_NOMBRE_POR_DEFECTO  = 'remote-name';

const COOKIE_SESION = 'ts_sesion';

// 30 días, renovados al usarse. Solo afecta al modo local (el del portátil).
const DURACION_SESION_MS = 30 * 24 * 60 * 60 * 1000;

// La renovación no se hace en CADA petición: eso metería un Set-Cookie en cada
// imagen del historial. Basta con refrescar cuando la cookie lleva más de un día
// emitida, que da el mismo efecto de caducidad deslizante.
const RENOVAR_PASADO_MS = 24 * 60 * 60 * 1000;

// --- CONFIGURACIÓN Y ABORTO AL ARRANCAR -------------------------------------

/**
 * Aborta el arranque con un mensaje que explique qué falta y cómo se arregla.
 * Mismo criterio que el guard de user_version en config/db.js: es mejor no
 * arrancar que arrancar a medias. Aquí el riesgo es peor todavía —arrancar sin
 * protección— así que no hay ningún valor por defecto que pueda dejar la
 * aplicación abierta por accidente.
 */
function abortar(titulo, detalle) {
    console.error(`
╔══════════════════════════════════════════════════════════════════════════╗
║  CONFIGURACIÓN DE AUTENTICACIÓN INCOMPLETA                               ║
╚══════════════════════════════════════════════════════════════════════════╝

  ${titulo}

${detalle}

  El servidor NO arranca: hacerlo significaría servir los tiquets sin
  protección. Revisa el .env (tienes la plantilla en .env.example).
`);
    process.exit(1);
}

const esVerdadero = (valor) =>
    ['1', 'true', 'si', 'sí', 'yes', 'on'].includes(String(valor || '').trim().toLowerCase());

/**
 * Las URL del portal acaban en `location.replace()` y en un `href` del frontend.
 * Una URL con esquema raro ahí sería un agujero propio, así que solo se admiten
 * http(s) y rutas absolutas del mismo sitio. Un valor mal escrito aborta: es un
 * error de configuración, y descubrirlo al pulsar "salir" cuesta más.
 */
function urlDePortal(valor, nombreVariable) {
    const limpio = String(valor || '').trim();
    if (limpio === '') return null;

    const admitida = limpio.startsWith('https://') ||
                     limpio.startsWith('http://') ||
                     (limpio.startsWith('/') && !limpio.startsWith('//'));
    if (!admitida) {
        abortar(`${nombreVariable} no es una URL admitida.`,
`  Tiene que empezar por "https://", "http://" o "/" (ruta del propio sitio).
  Lo que haya ahí acaba en un redirect y en un enlace del frontend: admitir
  cualquier esquema sería abrir un agujero en casa.

      ${nombreVariable}=https://auth.midominio.tld`);
    }
    return limpio;
}

/** Lee y valida la configuración del modo activo. Aborta si falta algo. */
function leerConfiguracion(entorno = process.env) {
    const modo = String(entorno.AUTH_MODE || '').trim().toLowerCase();

    if (!modo) {
        abortar('Falta AUTH_MODE.',
`  AUTH_MODE dice de dónde sale la identidad de quien usa la aplicación:

      AUTH_MODE=proxy   la identidad la pone el portal en una cabecera (producción)
      AUTH_MODE=local   la aplicación gestiona su propio login (solo desarrollo)

  No hay valor por defecto a propósito: cualquiera de los dos que se eligiera
  por ti sería una decisión de seguridad tomada a tus espaldas.`);
    }

    if (!MODOS_VALIDOS.includes(modo)) {
        abortar(`AUTH_MODE="${modo}" no es un modo válido.`,
`  Los únicos valores admitidos son "${MODO_PROXY}" y "${MODO_LOCAL}".`);
    }

    const comun = {
        modo,
        // Nombre del usuario único del modo local. No se escribe en el login (no
        // hay campo de usuario): es la etiqueta que queda en la sesión.
        usuario: (entorno.AUTH_USUARIO || 'admin').trim()
    };

    if (modo === MODO_PROXY) return { ...comun, ...configuracionProxy(entorno) };
    return { ...comun, ...configuracionLocal(entorno) };
}

function configuracionProxy(entorno) {
    const cabecera = (nombre, porDefecto) =>
        (String(entorno[nombre] || '').trim() || porDefecto).toLowerCase();

    // La lista de redes de origen es OBLIGATORIA. No tiene valor por defecto
    // aunque el de este clúster se sepa (10.42.0.0/16): una lista de control de
    // acceso que la aplicación se inventa es una lista en la que nadie ha
    // pensado, y el día que el servicio se mueva a otra red el fallo sería
    // silencioso en el peor sentido (seguiría dejando pasar a la red vieja).
    const crudo = String(entorno.AUTH_PROXY_IPS_PERMITIDAS || '').trim();
    if (!crudo) {
        abortar('Falta AUTH_PROXY_IPS_PERMITIDAS y AUTH_MODE=proxy.',
`  En modo proxy la identidad llega en una cabecera, y una cabecera la escribe
  cualquiera. Esta lista dice desde qué IPs/redes se acepta: lo que venga de
  otro sitio se rechaza con 403 aunque traiga la cabecera.

  Para el clúster K3s, la red de pods:

      AUTH_PROXY_IPS_PERMITIDAS=10.42.0.0/16

  Para desarrollo contra un proxy en la misma máquina:

      AUTH_PROXY_IPS_PERMITIDAS=127.0.0.1,::1`);
    }

    const { redes, invalidas } = parsearRedes(crudo);
    if (invalidas.length > 0) {
        abortar('AUTH_PROXY_IPS_PERMITIDAS tiene entradas que no se entienden.',
`  No se ha podido interpretar: ${invalidas.join(', ')}

  Se admiten IPs sueltas y redes en notación CIDR, separadas por comas:

      AUTH_PROXY_IPS_PERMITIDAS=10.42.0.0/16,127.0.0.1,::1

  Se aborta en vez de ignorar la entrada mala: en una lista de control de
  acceso, saltarse lo que no se entiende acaba dejando pasar de más o cerrando
  de más, y en los dos casos sin avisar.`);
    }
    if (redes.length === 0) {
        abortar('AUTH_PROXY_IPS_PERMITIDAS se queda sin ninguna red válida.',
`  Tal y como está, no se aceptaría ninguna petición de ningún origen.`);
    }

    return {
        cabecera:       cabecera('AUTH_PROXY_HEADER',        CABECERA_USUARIO_POR_DEFECTO),
        cabeceraEmail:  cabecera('AUTH_PROXY_HEADER_EMAIL',  CABECERA_EMAIL_POR_DEFECTO),
        cabeceraNombre: cabecera('AUTH_PROXY_HEADER_NOMBRE', CABECERA_NOMBRE_POR_DEFECTO),
        redes,
        // A dónde mandar a quien llegue sin identidad, y a dónde apunta el enlace
        // de "salir". Las dos son del portal; la aplicación no cierra sesión.
        // Opcionales: sin ellas se cae en /sin-identidad.html, que explica qué
        // pasa. No abortan porque no son una decisión de seguridad, solo de
        // comodidad, y bloquear el arranque por una URL cosmética sería excesivo.
        portalUrl: urlDePortal(entorno.AUTH_PORTAL_URL, 'AUTH_PORTAL_URL'),
        logoutUrl: urlDePortal(entorno.AUTH_LOGOUT_URL, 'AUTH_LOGOUT_URL')
    };
}

function configuracionLocal(entorno) {
    const hash = String(entorno.AUTH_PASSWORD_HASH || '').trim();
    if (!hash) {
        abortar('Falta AUTH_PASSWORD_HASH y AUTH_MODE=local.',
`  En el .env va el HASH de la contraseña, nunca la contraseña. Genéralo con:

      npm run hash-password

  y pega la línea que imprime en AUTH_PASSWORD_HASH.`);
    }
    if (!parsearHash(hash)) {
        abortar('AUTH_PASSWORD_HASH no tiene el formato esperado.',
`  Debe ser la línea completa que imprime "npm run hash-password", con esta
  forma:

      scrypt$<N>$<r>$<p>$<salt en base64>$<hash en base64>

  Si la has recortado o le falta algún trozo, vuelve a generarla.`);
    }

    const secreto = String(entorno.SESSION_SECRET || '');
    if (!secreto) {
        abortar('Falta SESSION_SECRET y AUTH_MODE=local.',
`  Es el secreto con el que se firma la cookie de sesión. Sin él, cualquiera
  podría fabricarse una cookie válida. Genera uno con:

      node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`);
    }
    if (secreto.length < 32) {
        abortar(`SESSION_SECRET es demasiado corto (${secreto.length} caracteres).`,
`  Mínimo 32 caracteres. Un secreto corto se puede adivinar a fuerza bruta, y
  con él se falsifica cualquier sesión. Genera uno así:

      node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`);
    }

    return {
        hash,
        secreto,
        // secure: true hace que el navegador solo mande la cookie por HTTPS. El
        // modo local es el del portátil, donde se entra por HTTP en localhost,
        // así que no puede estar activado por defecto: la sesión no funcionaría y
        // el síntoma (login que "no hace nada") es de los que cuestan una tarde.
        cookieSecure: esVerdadero(entorno.AUTH_COOKIE_SECURE)
    };
}

const config = leerConfiguracion();

/** Resumen para el log de arranque. No imprime ningún secreto. */
function resumenDeArranque() {
    const lineas = [`🔐 Autenticación en modo '${config.modo}'.`];

    if (config.modo === MODO_PROXY) {
        lineas.push(
            `   Identidad leída de la cabecera '${config.cabecera}' (y '${config.cabeceraEmail}',`,
            `   '${config.cabeceraNombre}' si llegan).`,
            `   Origen admitido: ${config.redes.map(r => r.texto).join(', ')}.`,
            `   Lo que venga de otra IP se rechaza con 403 aunque traiga la cabecera.`,
            `   ⚠️  Esto solo es seguro si NADIE puede llegar a este puerto sin pasar`,
            `      por el portal: una cabecera la puede escribir cualquiera.`,
            config.portalUrl
                ? `   Portal: ${config.portalUrl}`
                : `   Sin AUTH_PORTAL_URL: quien llegue sin identidad verá /sin-identidad.html.`
        );
    } else {
        lineas.push(
            `   ⚠️  Modo de DESARROLLO: la aplicación gestiona su propia contraseña.`,
            `      En producción va detrás del portal, con AUTH_MODE=proxy.`,
            `   Usuario único: '${config.usuario}'. Sesión de 30 días, renovada al usarse.`,
            `   Cookie secure=${config.cookieSecure}` +
            (config.cookieSecure ? '' : ' (correcto si entras por HTTP en localhost).')
        );
    }
    return lineas.join('\n');
}

// --- COOKIE DE SESIÓN FIRMADA (solo modo local) -----------------------------
// Sin almacén de sesiones en servidor: para un usuario, una cookie firmada con
// HMAC basta y sobra. Lo que se gana es que reiniciar el proceso no cierra la
// sesión, y lo que se pierde es poder revocarla desde el servidor; para revocar
// todas, se cambia SESSION_SECRET.

const b64url = (buf) => Buffer.from(buf).toString('base64url');

function firmar(texto) {
    return crypto.createHmac('sha256', config.secreto).update(texto).digest();
}

/** Crea el valor de la cookie: <payload en base64url>.<firma en base64url>. */
function crearValorSesion(usuario, ahora = Date.now()) {
    const payload = b64url(JSON.stringify({
        u: usuario,
        iat: ahora,
        exp: ahora + DURACION_SESION_MS
    }));
    return `${payload}.${b64url(firmar(payload))}`;
}

/**
 * Verifica y decodifica el valor de la cookie. Devuelve null ante cualquier
 * problema: firma que no cuadra, JSON roto, caducada o manipulada. Nunca lanza,
 * porque esto lo alimenta una cabecera que escribe quien quiera.
 */
function leerValorSesion(valor, ahora = Date.now()) {
    if (typeof valor !== 'string' || valor.length > 4096) return null;

    const corte = valor.lastIndexOf('.');
    if (corte <= 0) return null;

    const payload = valor.slice(0, corte);
    const firmaRecibida = Buffer.from(valor.slice(corte + 1), 'base64url');
    const firmaEsperada = firmar(payload);

    // Longitudes distintas ⇒ falsa, y timingSafeEqual lanzaría.
    if (firmaRecibida.length !== firmaEsperada.length) return null;
    if (!crypto.timingSafeEqual(firmaRecibida, firmaEsperada)) return null;

    let datos;
    try {
        datos = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch (_) {
        return null;
    }
    if (!datos || typeof datos.u !== 'string') return null;
    if (!Number.isFinite(datos.exp) || datos.exp <= ahora) return null;
    if (!Number.isFinite(datos.iat)) return null;

    return datos;
}

/** Parsea la cabecera Cookie a mano: no hace falta cookie-parser para una. */
function cookiesDe(req) {
    const cabecera = req.headers && req.headers.cookie;
    if (!cabecera) return {};
    const salida = {};
    for (const trozo of String(cabecera).split(';')) {
        const igual = trozo.indexOf('=');
        if (igual < 0) continue;
        const nombre = trozo.slice(0, igual).trim();
        if (!nombre) continue;
        try {
            salida[nombre] = decodeURIComponent(trozo.slice(igual + 1).trim());
        } catch (_) {
            salida[nombre] = trozo.slice(igual + 1).trim();
        }
    }
    return salida;
}

function ponerCookieSesion(res, usuario) {
    res.cookie(COOKIE_SESION, crearValorSesion(usuario), {
        httpOnly: true,          // fuera del alcance de cualquier JS de la página
        sameSite: 'strict',      // no se manda en peticiones que vengan de otro sitio
        secure: config.cookieSecure,
        maxAge: DURACION_SESION_MS,
        path: '/'
    });
}

function borrarCookieSesion(res) {
    res.clearCookie(COOKIE_SESION, {
        httpOnly: true,
        sameSite: 'strict',
        secure: config.cookieSecure,
        path: '/'
    });
}

// --- ORIGEN DE LA PETICIÓN --------------------------------------------------

/**
 * La IP del otro extremo de la conexión TCP.
 *
 * Se lee del SOCKET y NO de req.ip a propósito. req.ip respeta `trust proxy`, y
 * con esa opción activada devolvería lo que diga X-Forwarded-For —una cabecera,
 * o sea, algo que escribe quien llama—. Usar eso para una lista de permitidos
 * sería dejar que cada cual declare desde dónde llega. El socket no se puede
 * falsificar desde fuera.
 */
function direccionDeOrigen(req) {
    return (req.socket && req.socket.remoteAddress) || null;
}

/**
 * ¿Viene esta petición de un origen admitido? Devuelve null si sí, o el motivo
 * del rechazo. En modo local no se comprueba nada: no hay cabecera en la que
 * confiar, la identidad va firmada en la cookie.
 */
function comprobarOrigen(req) {
    if (config.modo !== MODO_PROXY) return null;

    const ip = direccionDeOrigen(req);
    if (!ip) return { ip: 'desconocida', motivo: 'no se ha podido determinar el origen de la conexión' };
    if (ipEnRedes(ip, config.redes)) return null;

    return { ip, motivo: 'el origen no está en AUTH_PROXY_IPS_PERMITIDAS' };
}

// --- ADAPTADORES (uno por fuente de identidad) ------------------------------
// Los dos exponen la misma forma. Añadir una tercera fuente (OIDC, mTLS...) es
// añadir una entrada aquí, no tocar las rutas.

/** Lee una cabecera y la devuelve limpia, o null si no sirve como dato. */
function cabeceraDeTexto(req, nombre, maximo = 256) {
    const valor = req.headers ? req.headers[nombre] : undefined;
    // Una cabecera repetida llega como array: eso no es un dato legítimo, es
    // alguien enredando o un portal mal configurado.
    if (typeof valor !== 'string') return null;
    const limpio = valor.trim();
    if (limpio === '' || limpio.length > maximo) return null;
    return limpio;
}

const adaptadores = {
    /** La identidad la pone el portal en una cabecera. MODO PRINCIPAL. */
    [MODO_PROXY]: {
        soportaLogin: false,
        descripcion: 'identidad inyectada por el portal en una cabecera',
        identificar(req) {
            const usuario = cabeceraDeTexto(req, config.cabecera);
            if (!usuario) return null;
            return {
                usuario,
                // Para poder mostrar quién está conectado. Si el portal no los
                // manda, no pasa nada: la identidad es el usuario.
                email:  cabeceraDeTexto(req, config.cabeceraEmail),
                nombre: cabeceraDeTexto(req, config.cabeceraNombre)
            };
        },
        refrescar() { /* la sesión es del portal, no nuestra */ }
    },

    /** La aplicación gestiona su propio login. Solo desarrollo. */
    [MODO_LOCAL]: {
        soportaLogin: true,
        descripcion: 'login propio con contraseña y cookie firmada',
        identificar(req) {
            const datos = leerValorSesion(cookiesDe(req)[COOKIE_SESION]);
            if (!datos) return null;
            return {
                usuario: datos.u,
                email: null,
                nombre: null,
                emitida: datos.iat,
                caduca: datos.exp
            };
        },
        /**
         * Caducidad deslizante: si la cookie lleva más de un día emitida, se
         * vuelve a emitir con 30 días nuevos. Así entrar a diario no obliga a
         * volver a escribir la contraseña nunca.
         */
        refrescar(req, res, identidad) {
            if (Date.now() - identidad.emitida < RENOVAR_PASADO_MS) return;
            ponerCookieSesion(res, identidad.usuario);
        }
    }
};

const adaptador = adaptadores[config.modo];

// --- INTERFAZ ÚNICA ---------------------------------------------------------

/** Quién es quien hace la petición, o null. Igual en los dos modos. */
function identidadDe(req) {
    if (comprobarOrigen(req)) return null;
    return adaptador.identificar(req);
}

/**
 * ¿Esta petición espera JSON? Las de /api y las que lo piden por Accept. Para el
 * resto (una imagen de /uploads abierta a mano, por ejemplo) es más útil un
 * redirect al portal que un JSON que nadie va a leer.
 */
function esperaJson(req) {
    // originalUrl y NO req.path: dentro de un middleware montado con
    // app.use('/api/tickets', ...) Express reescribe req.url relativo al punto de
    // montaje, así que req.path valdría '/' y una sesión caducada recibiría un 302
    // al portal. fetch() seguiría ese redirect y devolvería 200 con HTML, con lo que
    // el frontend nunca vería el 401 y se quedaría mostrando un error absurdo.
    if (String(req.originalUrl || req.url || '').startsWith('/api/')) return true;
    const accept = String((req.headers && req.headers.accept) || '');
    return accept.includes('application/json');
}

/** A dónde mandar a un navegador que llega sin identidad. */
function destinoSinIdentidad() {
    if (adaptador.soportaLogin) return '/login.html';
    return config.portalUrl || '/sin-identidad.html';
}

/**
 * 403: la petición no viene de donde tiene que venir. No es un problema de
 * credenciales, así que no se manda a nadie al portal: volvería con el mismo
 * resultado. Tampoco se dice cuáles son las redes admitidas; la IP que se
 * devuelve es la de quien pregunta, que ya la conoce.
 */
function rechazarOrigen(req, res, problema) {
    console.warn(
        `⛔ Petición rechazada por origen: ${problema.ip} → ${req.method} ${req.originalUrl || req.url}. ` +
        `Si esto se repite desde una IP tuya, revisa AUTH_PROXY_IPS_PERMITIDAS.`
    );

    const explicacion =
        'Esta aplicación solo acepta peticiones que lleguen a través del portal de ' +
        'autenticación. La tuya viene de un origen no admitido, así que la cabecera ' +
        'de identidad que traiga (si trae alguna) no se mira siquiera.';

    if (esperaJson(req)) {
        return res.status(403).json({
            error: explicacion,
            autenticado: false,
            origen_no_admitido: true,
            origen: problema.ip,
            modo: config.modo
        });
    }
    return res.status(403).type('text/plain; charset=utf-8').send(
        `403 — Origen no admitido (${problema.ip}).\n\n${explicacion}\n`
    );
}

function rechazarSinIdentidad(req, res) {
    const motivo = config.modo === MODO_PROXY
        ? `No hay identidad: el portal no ha inyectado la cabecera '${config.cabecera}'. ` +
          `Si estás llegando directo al puerto de la aplicación, saltándote el portal, esto es ` +
          `exactamente lo que tiene que pasar.`
        : 'No hay sesión. Entra con tu contraseña.';

    if (esperaJson(req)) {
        return res.status(401).json({
            error: motivo,
            autenticado: false,
            modo: config.modo,
            // El frontend usa estos dos para decidir si enseñar el formulario de
            // login o mandar al portal.
            login_disponible: adaptador.soportaLogin,
            portal_url: config.portalUrl || null
        });
    }
    return res.redirect(302, destinoSinIdentidad());
}

/**
 * EL middleware. Es el mismo objeto en los dos modos: lo único que cambia es el
 * adaptador que consulta. Si algún día hay que endurecer la protección, se hace
 * aquí una vez y vale para todo.
 *
 * El orden importa: primero de dónde viene la petición, después quién dice ser.
 * Al revés, una cabecera inyectada desde fuera llegaría a mirarse.
 */
function exigirIdentidad(req, res, next) {
    const problema = comprobarOrigen(req);
    if (problema) return rechazarOrigen(req, res, problema);

    const identidad = adaptador.identificar(req);
    if (!identidad) return rechazarSinIdentidad(req, res);

    req.identidad = identidad;
    adaptador.refrescar(req, res, identidad);
    next();
}

// --- HANDLERS DE SESIÓN -----------------------------------------------------

/** GET /api/auth/estado — público: el frontend necesita saber a qué atenerse. */
function estadoSesion(req, res) {
    const problema = comprobarOrigen(req);
    if (problema) return rechazarOrigen(req, res, problema);

    const identidad = adaptador.identificar(req);
    res.json({
        modo: config.modo,
        autenticado: Boolean(identidad),
        usuario: identidad ? identidad.usuario : null,
        email:   identidad ? (identidad.email || null) : null,
        nombre:  identidad ? (identidad.nombre || null) : null,
        login_disponible: adaptador.soportaLogin,
        // En modo proxy, a dónde se va el frontend ante un 401 y a dónde apunta
        // el enlace de salir. En modo local no hay portal: son null.
        portal_url: config.portalUrl || null,
        logout_url: config.logoutUrl || null
    });
}

/** POST /api/auth/login — solo en modo local. Público por necesidad. */
function iniciarSesion(req, res) {
    if (!adaptador.soportaLogin) {
        return res.status(404).json({
            error: `Esta aplicación está en modo '${config.modo}': no gestiona contraseñas. ` +
                   `La identidad la pone el portal de autenticación.`,
            modo: config.modo,
            portal_url: config.portalUrl || null
        });
    }

    const password = req.body && typeof req.body.password === 'string' ? req.body.password : '';

    // Se verifica SIEMPRE, incluso con la contraseña vacía: así el tiempo de
    // respuesta no dice nada sobre si el campo llegó o no.
    // No hay limitación de intentos ni registro de fallidos a propósito: este
    // modo es el del portátil. En producción no existe, y lo que haya que contar
    // o bloquear lo hace el portal, que es quien ve los intentos de verdad.
    if (!verificarPassword(password, config.hash)) {
        return res.status(401).json({ error: 'Contraseña incorrecta.' });
    }

    ponerCookieSesion(res, config.usuario);
    return res.json({ ok: true, usuario: config.usuario, modo: config.modo });
}

/**
 * POST /api/auth/logout — solo en modo local.
 *
 * En modo proxy NO existe: la sesión es del portal y cerrarla aquí sería mentir
 * (el portal seguiría inyectando la cabecera en la siguiente petición y se
 * volvería a entrar sin tocar nada). Se responde 404 y se devuelve la URL de
 * cierre del portal, que es donde hay que ir de verdad.
 */
function cerrarSesion(req, res) {
    if (!adaptador.soportaLogin) {
        return res.status(404).json({
            error: `Esta aplicación está en modo '${config.modo}': la sesión es del portal y ` +
                   `se cierra en el portal, no aquí.`,
            modo: config.modo,
            logout_url: config.logoutUrl || null
        });
    }

    borrarCookieSesion(res);
    return res.json({ ok: true, cerrada_aqui: true, modo: config.modo });
}

module.exports = {
    // interfaz única que usa el resto de la aplicación
    exigirIdentidad,
    identidadDe,
    estadoSesion,
    iniciarSesion,
    cerrarSesion,
    resumenDeArranque,
    soportaLogin: adaptador.soportaLogin,
    modo: config.modo,
    // utilidades expuestas para el script de hash y para las pruebas
    hashearPassword,
    verificarPassword,
    parsearHash,
    crearValorSesion,
    leerValorSesion,
    cookiesDe,
    comprobarOrigen,
    leerConfiguracion,
    COOKIE_SESION,
    DURACION_SESION_MS,
    RENOVAR_PASADO_MS,
    CABECERA_USUARIO_POR_DEFECTO,
    CABECERA_EMAIL_POR_DEFECTO,
    CABECERA_NOMBRE_POR_DEFECTO,
    MODO_LOCAL,
    MODO_PROXY
};
