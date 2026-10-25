/**
 * Hash y verificación de contraseñas con scrypt.
 *
 * Está separado de auth.js a propósito: auth.js valida su configuración al
 * cargarse y ABORTA el proceso si falta algo, y el script `npm run hash-password`
 * tiene que poder generar un hash precisamente cuando todavía no hay
 * configuración. Aparte, así las primitivas se prueban sin montar ningún entorno.
 *
 * Se usa scrypt del módulo `crypto` de Node y NO bcrypt ni argon2: esos son
 * módulos nativos y habría que compilarlos para arm64 al construir la imagen de
 * la Raspberry. scrypt viene dentro de Node, sin compilar nada.
 */
const crypto = require('crypto');

// Parámetros por defecto. Viajan DENTRO del hash generado, así que se pueden
// endurecer más adelante sin invalidar los hashes ya existentes.
// N=16384, r=8 → 128 * N * r = 16 MiB, que cabe en el maxmem por defecto de Node
// (32 MiB) sin tener que pasar opciones extra.
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function derivar(password, salt, params) {
    return crypto.scryptSync(
        Buffer.from(String(password), 'utf8'),
        salt,
        params.keylen,
        { N: params.N, r: params.r, p: params.p }
    );
}

/**
 * Genera la línea que va en AUTH_PASSWORD_HASH.
 * Formato: scrypt$N$r$p$saltB64$hashB64
 */
function hashearPassword(password, params = SCRYPT) {
    const salt = crypto.randomBytes(16);
    const clave = derivar(password, salt, params);
    return [
        'scrypt', params.N, params.r, params.p,
        salt.toString('base64'), clave.toString('base64')
    ].join('$');
}

/** Descompone la línea almacenada. Devuelve null si no tiene la forma esperada. */
function parsearHash(almacenado) {
    const partes = String(almacenado || '').split('$');
    if (partes.length !== 6 || partes[0] !== 'scrypt') return null;

    const [, N, r, p, saltB64, hashB64] = partes;
    const params = { N: Number(N), r: Number(r), p: Number(p) };
    if (![params.N, params.r, params.p].every(n => Number.isInteger(n) && n > 0)) return null;
    // Tope de sensatez: un N absurdo en el .env colgaría el proceso o lo mataría
    // por memoria en cada login.
    if (params.N > 1048576 || params.r > 64 || params.p > 16) return null;

    let salt, esperado;
    try {
        salt = Buffer.from(saltB64, 'base64');
        esperado = Buffer.from(hashB64, 'base64');
    } catch (_) {
        return null;
    }
    if (salt.length === 0 || esperado.length === 0) return null;

    return { ...params, keylen: esperado.length, salt, esperado };
}

/**
 * Comprueba la contraseña en TIEMPO CONSTANTE.
 *
 * timingSafeEqual exige longitudes iguales y lanza si no lo son, de ahí la
 * comprobación previa; la longitud del hash es fija y pública, así que compararla
 * antes no filtra nada.
 */
function verificarPassword(password, almacenado) {
    const partes = parsearHash(almacenado);
    if (!partes) return false;

    const calculado = derivar(password, partes.salt, partes);
    if (calculado.length !== partes.esperado.length) return false;
    return crypto.timingSafeEqual(calculado, partes.esperado);
}

module.exports = { hashearPassword, verificarPassword, parsearHash, SCRYPT };
