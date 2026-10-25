/**
 * Comparación de una IP contra una lista de IPs/redes en notación CIDR.
 *
 * Está aquí y no dentro de auth.js por la misma razón que password.js: es lógica
 * PURA —no toca disco, ni red, ni variables de entorno— y auth.js aborta el
 * proceso al importarse si falta configuración. Así el emparejador se prueba
 * solo, sin montar ningún entorno, que es la convención del proyecto para la
 * lógica sin dependencias.
 *
 * Lo usa el modo proxy para rechazar peticiones que no vengan de la red del
 * portal, aunque traigan la cabecera de identidad.
 *
 * Dos detalles que no son evidentes y que importan:
 *
 *   1. Cuando el proceso escucha en un socket IPv6, una conexión IPv4 llega con
 *      la dirección en forma IPv4-mapeada: `::ffff:10.42.0.7`. Si no se
 *      normalizara, un `10.42.0.0/16` en la lista no casaría nunca y la
 *      aplicación se quedaría sin dejar entrar a nadie. Pasa en Kubernetes a
 *      diario.
 *   2. `::1` y `127.0.0.1` son direcciones DISTINTAS, de familias distintas. Si
 *      se quiere permitir localhost hay que poner las dos en la lista; no se
 *      traduce la una en la otra a propósito, porque sería inventarse permisos.
 */

/** Un octeto IPv4 válido: 0-255 y sin ceros a la izquierda (serían octales). */
function octeto(texto) {
    if (!/^(0|[1-9]\d{0,2})$/.test(texto)) return -1;
    const n = Number(texto);
    return n <= 255 ? n : -1;
}

/** `10.42.0.7` → Buffer de 4 bytes, o null. */
function ipv4ABytes(texto) {
    const trozos = String(texto).split('.');
    if (trozos.length !== 4) return null;

    const bytes = Buffer.alloc(4);
    for (let i = 0; i < 4; i++) {
        const valor = octeto(trozos[i]);
        if (valor < 0) return null;
        bytes[i] = valor;
    }
    return bytes;
}

/** `fe80::1`, `::ffff:10.42.0.7` → Buffer de 16 bytes, o null. */
function ipv6ABytes(texto) {
    // El índice de zona (`fe80::1%eth0`) identifica una interfaz local y no forma
    // parte de la dirección.
    const valor = String(texto).split('%')[0];

    const partes = valor.split('::');
    if (partes.length > 2) return null;          // "::" solo puede aparecer una vez

    const trocear = (trozo) => (trozo === '' ? [] : trozo.split(':'));
    const grupos = [];

    // El último grupo puede venir en decimal con puntos (`::ffff:10.42.0.7`): esa
    // notación ocupa dos grupos de 16 bits.
    const anadir = (lista) => {
        for (let i = 0; i < lista.length; i++) {
            const trozo = lista[i];
            const esUltimo = i === lista.length - 1;

            if (esUltimo && trozo.includes('.')) {
                const cuatro = ipv4ABytes(trozo);
                if (!cuatro) return false;
                grupos.push((cuatro[0] << 8) | cuatro[1], (cuatro[2] << 8) | cuatro[3]);
                continue;
            }
            if (!/^[0-9a-fA-F]{1,4}$/.test(trozo)) return false;
            grupos.push(parseInt(trozo, 16));
        }
        return true;
    };

    if (!anadir(trocear(partes[0]))) return null;
    const cuantosAIzquierda = grupos.length;
    if (partes.length === 2 && !anadir(trocear(partes[1]))) return null;

    if (partes.length === 2) {
        // "::" rellena con ceros al menos un grupo.
        const relleno = 8 - grupos.length;
        if (relleno < 1) return null;
        grupos.splice(cuantosAIzquierda, 0, ...new Array(relleno).fill(0));
    } else if (grupos.length !== 8) {
        return null;
    }

    const bytes = Buffer.alloc(16);
    for (let i = 0; i < 8; i++) {
        bytes[i * 2]     = (grupos[i] >> 8) & 0xff;
        bytes[i * 2 + 1] = grupos[i] & 0xff;
    }
    return bytes;
}

/** `::ffff:a.b.c.d` → los 4 bytes de a.b.c.d. El resto se devuelve tal cual. */
function desmapear(bytes) {
    if (bytes.length !== 16) return bytes;
    for (let i = 0; i < 10; i++) if (bytes[i] !== 0) return bytes;
    // Solo la forma mapeada (::ffff:…). La forma "compatible" (::a.b.c.d) no se
    // traduce: con ella, `::1` se convertiría en 0.0.0.1, que es otra dirección.
    if (bytes[10] !== 0xff || bytes[11] !== 0xff) return bytes;
    return Buffer.from(bytes.subarray(12, 16));
}

/**
 * Texto de una IP → sus bytes (4 en IPv4, 16 en IPv6), o null si no es una
 * dirección. Las IPv4-mapeadas se devuelven ya como IPv4, que es la forma en la
 * que se escriben en la lista de permitidas.
 */
function aBytes(texto) {
    const limpio = String(texto == null ? '' : texto).trim();
    if (limpio === '') return null;

    // Forma `[::1]`, que es como aparecen en algunos logs y cabeceras.
    const sinCorchetes = limpio.startsWith('[') && limpio.endsWith(']')
        ? limpio.slice(1, -1)
        : limpio;

    if (!sinCorchetes.includes(':')) return ipv4ABytes(sinCorchetes);

    const seis = ipv6ABytes(sinCorchetes);
    return seis ? desmapear(seis) : null;
}

/**
 * `10.42.0.0/16` o `10.42.0.5` → { bytes, prefijo, texto }, o null si no se
 * entiende. Sin barra, la entrada es una dirección suelta: prefijo completo.
 */
function parsearRed(texto) {
    const limpio = String(texto == null ? '' : texto).trim();
    if (limpio === '') return null;

    const barra = limpio.indexOf('/');
    if (barra < 0) {
        const bytes = aBytes(limpio);
        return bytes ? { bytes, prefijo: bytes.length * 8, texto: limpio } : null;
    }

    const parteIp = limpio.slice(0, barra).trim().replace(/^\[|\]$/g, '');
    const partePrefijo = limpio.slice(barra + 1).trim();
    if (!/^\d{1,3}$/.test(partePrefijo)) return null;

    // Se parsea SIN desmapear todavía: un `::ffff:10.42.0.0/112` lleva el prefijo
    // contado sobre 128 bits, y hay que restarle los 96 del prefijo mapeado antes
    // de tratarlo como IPv4. Hacerlo al revés daría una máscara disparatada.
    const crudo = parteIp.includes(':') ? ipv6ABytes(parteIp) : ipv4ABytes(parteIp);
    if (!crudo) return null;

    let prefijo = Number(partePrefijo);
    if (prefijo > crudo.length * 8) return null;

    let bytes = crudo;
    const desmapeado = desmapear(crudo);
    if (desmapeado.length !== crudo.length) {
        if (prefijo < 96) return null;      // una red que cruza el prefijo mapeado
        bytes = desmapeado;
        prefijo -= 96;
    }

    return { bytes, prefijo, texto: limpio };
}

/**
 * Lista separada por comas → { redes, invalidas }. Quien llama decide qué hacer
 * con las inválidas; auth.js aborta el arranque, porque una entrada mal escrita
 * en una lista de control de acceso no es un detalle: o abre o cierra de más.
 */
function parsearRedes(lista) {
    const redes = [];
    const invalidas = [];

    for (const entrada of String(lista == null ? '' : lista).split(',')) {
        const limpia = entrada.trim();
        if (limpia === '') continue;
        const red = parsearRed(limpia);
        if (red) redes.push(red); else invalidas.push(limpia);
    }
    return { redes, invalidas };
}

/** ¿Coinciden los `prefijo` primeros bits de `bytes` con los de la red? */
function bytesEnRed(bytes, red) {
    // Familias distintas no se comparan: una IPv6 no está dentro de un /16 IPv4,
    // y mezclarlas daría coincidencias por accidente.
    if (!bytes || !red || bytes.length !== red.bytes.length) return false;

    const bytesEnteros = red.prefijo >> 3;
    for (let i = 0; i < bytesEnteros; i++) {
        if (bytes[i] !== red.bytes[i]) return false;
    }

    const bitsSueltos = red.prefijo & 7;
    if (bitsSueltos === 0) return true;

    const mascara = (0xff << (8 - bitsSueltos)) & 0xff;
    return (bytes[bytesEnteros] & mascara) === (red.bytes[bytesEnteros] & mascara);
}

/** ¿Pertenece esta IP (en texto) a alguna de las redes? Lista vacía ⇒ no. */
function ipEnRedes(ip, redes) {
    const bytes = aBytes(ip);
    if (!bytes || !Array.isArray(redes)) return false;
    return redes.some(red => bytesEnRed(bytes, red));
}

module.exports = { aBytes, parsearRed, parsearRedes, bytesEnRed, ipEnRedes };
