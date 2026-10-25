#!/usr/bin/env node
/**
 * Genera los iconos PNG de la PWA.
 *
 *     npm run iconos
 *
 * Por qué un script y no unos PNG sueltos en el repo: el icono se dibuja a
 * partir de UNA definición (el mismo tiquet que hay en src/public/icono.svg), y
 * así cambiar el color o el dibujo es cambiar dos números aquí en vez de reabrir
 * cuatro ficheros binarios en un editor. Los PNG generados SÍ se versionan: la
 * página los necesita y no hay paso de build.
 *
 * Escribe el PNG a mano (zlib del propio Node + CRC-32) para no añadir ninguna
 * dependencia: el proyecto no tiene bundler ni herramientas de imagen, y meter
 * sharp o canvas significaría compilar módulos nativos para arm64 al construir
 * la imagen de la Raspberry, que es justo lo que se evita en todo el proyecto
 * (ver password.js y scrypt).
 *
 * El dibujo se hace a 4× y se reduce por promedio: así los bordes redondeados y
 * el dentado del tiquet salen suavizados sin escribir un rasterizador con
 * antialias de verdad.
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

// --- PALETA ------------------------------------------------------------------
// Los mismos colores que la interfaz: azul de los botones (Tailwind blue-600) y
// el gris del fondo (gray-100). Si cambian ahí, cambian aquí.
const AZUL        = [0x3f, 0x5b, 0xd9];   // #3f5bd9 — el acento de la interfaz
const AZUL_OSCURO = [0x2f, 0x46, 0xad];   // #2f46ad — la línea del total
const AZUL_CLARO  = [0xa8, 0xb6, 0xf2];   // #a8b6f2 — las líneas de texto
const BLANCO      = [0xff, 0xff, 0xff];

const SUPER = 4;                          // factor de supermuestreo

// --- PNG ---------------------------------------------------------------------

const TABLA_CRC = (() => {
    const tabla = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        tabla[n] = c;
    }
    return tabla;
})();

function crc32(buf) {
    let c = 0xffffffff;
    for (const byte of buf) c = TABLA_CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

/** Un chunk PNG: longitud + tipo + datos + CRC(tipo+datos). */
function chunk(tipo, datos) {
    const longitud = Buffer.alloc(4);
    longitud.writeUInt32BE(datos.length, 0);
    const cuerpo = Buffer.concat([Buffer.from(tipo, 'ascii'), datos]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(cuerpo), 0);
    return Buffer.concat([longitud, cuerpo, crc]);
}

/** RGBA sin comprimir (lado × lado × 4) → PNG de color verdadero con alfa. */
function escribirPNG(lado, rgba) {
    const firma = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(lado, 0);
    ihdr.writeUInt32BE(lado, 4);
    ihdr[8]  = 8;    // 8 bits por canal
    ihdr[9]  = 6;    // color type 6 = RGBA
    ihdr[10] = 0;    // deflate
    ihdr[11] = 0;    // filtro adaptativo
    ihdr[12] = 0;    // sin entrelazado

    // Cada scanline va precedida de su byte de filtro; 0 = sin filtrar, que con
    // zlib detrás comprime de sobra para un icono plano.
    const conFiltro = Buffer.alloc(lado * (lado * 4 + 1));
    for (let y = 0; y < lado; y++) {
        const destino = y * (lado * 4 + 1);
        conFiltro[destino] = 0;
        rgba.copy(conFiltro, destino + 1, y * lado * 4, (y + 1) * lado * 4);
    }

    return Buffer.concat([
        firma,
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(conFiltro, { level: 9 })),
        chunk('IEND', Buffer.alloc(0))
    ]);
}

// --- DIBUJO ------------------------------------------------------------------
// Todo en coordenadas normalizadas 0..1 sobre el lienzo, para que el mismo
// código sirva para 180, 192 y 512 píxeles.

// El papel: rectángulo con las esquinas de arriba redondeadas y el borde de
// abajo dentado, que es lo que hace que se lea como un tiquet y no como una hoja
// o una tarjeta. En coordenadas 0..1 dentro de la caja del dibujo.
const PAPEL    = { x0: 0.19, x1: 0.81, y0: 0.06, y1: 0.90, r: 0.05 };
const DIENTES  = 7;
const AMPLITUD = 0.055;

// Las líneas impresas: tres de texto y una más gruesa y oscura abajo, que es el
// total. Un tiquet se reconoce por tener un número destacado al final.
const LINEAS = [
    { x0: 0.28, x1: 0.72, y: 0.24, alto: 0.055, color: AZUL_CLARO },
    { x0: 0.28, x1: 0.72, y: 0.38, alto: 0.055, color: AZUL_CLARO },
    { x0: 0.28, x1: 0.60, y: 0.52, alto: 0.055, color: AZUL_CLARO },
    { x0: 0.28, x1: 0.64, y: 0.70, alto: 0.085, color: AZUL_OSCURO }
];

/** ¿Está (x,y) dentro de un rectángulo de esquinas redondeadas? */
function enRectRedondeado(x, y, x0, y0, x1, y1, r) {
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    const cx = Math.min(Math.max(x, x0 + r), x1 - r);
    const cy = Math.min(Math.max(y, y0 + r), y1 - r);
    const dx = x - cx;
    const dy = y - cy;
    return (dx * dx + dy * dy) <= r * r;
}

const enBanda = (x, y, x0, x1, yc, alto) =>
    x >= x0 && x <= x1 && Math.abs(y - yc) <= alto / 2;

/**
 * El color de un punto del icono, o null si es transparente.
 *
 * @param {number} escala  tamaño del tiquet respecto al lienzo (0..1). Más
 *                         pequeño en la versión "maskable", donde Android
 *                         recorta los bordes y el dibujo tiene que caber en el
 *                         círculo interior seguro.
 * @param {number} radio   redondeo del fondo (0 = cuadrado a sangre)
 */
function colorDelPunto(x, y, { escala, radio }) {
    const fondo = enRectRedondeado(x, y, 0, 0, 1, 1, radio) ? AZUL : null;
    if (!fondo) return null;

    // Caja del tiquet, centrada.
    const margen = (1 - escala) / 2;
    const u = (x - margen) / escala;      // 0..1 dentro del dibujo
    const v = (y - margen) / escala;
    if (u < 0 || u > 1 || v < 0 || v > 1) return fondo;

    const dentro = (() => {
        if (u < PAPEL.x0 || u > PAPEL.x1 || v < PAPEL.y0) return false;
        // Diente triangular: el borde inferior sube y baja a lo largo de x.
        const t = ((u - PAPEL.x0) / (PAPEL.x1 - PAPEL.x0)) * DIENTES;
        const sierra = Math.abs((t % 1) - 0.5) * 2;        // 0..1 en picos
        const limite = PAPEL.y1 - AMPLITUD * sierra;
        if (v > limite) return false;
        // Esquinas de arriba redondeadas (abajo no: ahí está el dentado).
        if (v < PAPEL.y0 + PAPEL.r) {
            return enRectRedondeado(u, v, PAPEL.x0, PAPEL.y0, PAPEL.x1, PAPEL.y0 + 2 * PAPEL.r, PAPEL.r);
        }
        return true;
    })();

    if (!dentro) return fondo;

    for (const l of LINEAS) {
        if (enBanda(u, v, l.x0, l.x1, l.y, l.alto)) return l.color;
    }

    return BLANCO;
}

/** Dibuja a SUPER× y reduce por promedio, que es el antialias de los pobres. */
function dibujar(lado, opciones) {
    const grande = lado * SUPER;
    const rgba = Buffer.alloc(lado * lado * 4);

    for (let y = 0; y < lado; y++) {
        for (let x = 0; x < lado; x++) {
            let r = 0, g = 0, b = 0, a = 0;

            for (let sy = 0; sy < SUPER; sy++) {
                for (let sx = 0; sx < SUPER; sx++) {
                    const px = (x * SUPER + sx + 0.5) / grande;
                    const py = (y * SUPER + sy + 0.5) / grande;
                    const color = colorDelPunto(px, py, opciones);
                    if (color) {
                        r += color[0]; g += color[1]; b += color[2]; a += 255;
                    }
                }
            }

            const muestras = SUPER * SUPER;
            const destino = (y * lado + x) * 4;
            // Se promedia sobre las muestras OPACAS para que el borde no se
            // oscurezca al mezclarse con el negro transparente.
            const opacas = a / 255;
            rgba[destino]     = opacas ? Math.round(r / opacas) : 0;
            rgba[destino + 1] = opacas ? Math.round(g / opacas) : 0;
            rgba[destino + 2] = opacas ? Math.round(b / opacas) : 0;
            rgba[destino + 3] = Math.round(a / muestras);
        }
    }
    return rgba;
}

// --- QUÉ SE GENERA -----------------------------------------------------------

const DESTINO = path.join(__dirname, '..', 'src', 'public', 'iconos');

const ICONOS = [
    // Icono normal: cuadrado redondeado, el dibujo generoso.
    { archivo: 'icono-192.png', lado: 192, escala: 0.74, radio: 0.22 },
    { archivo: 'icono-512.png', lado: 512, escala: 0.74, radio: 0.22 },
    // "Maskable": Android recorta la forma que le dé la gana (círculo, trébol...),
    // así que el fondo va a sangre y el dibujo se encoge para caber en la zona
    // segura (el 80% central). Sin esta versión, el sistema recorta el icono
    // normal y se come las esquinas del tiquet.
    { archivo: 'icono-maskable-512.png', lado: 512, escala: 0.52, radio: 0 },
    // iOS no usa el manifiesto para el icono de la pantalla de inicio: usa
    // apple-touch-icon y le aplica su propia máscara, así que también a sangre.
    { archivo: 'apple-touch-icon-180.png', lado: 180, escala: 0.70, radio: 0 }
];

const hex = ([r, g, b]) =>
    `#${[r, g, b].map(n => n.toString(16).padStart(2, '0')).join('')}`;

/**
 * El mismo dibujo en SVG, para el favicon de las páginas.
 *
 * Se genera de las MISMAS constantes que el PNG: con un SVG escrito a mano,
 * los dos dibujos divergirían en cuanto alguien tocara un número y nadie se
 * daría cuenta hasta ver la pestaña y la pantalla de inicio distintas.
 */
function generarSVG({ lado = 512, escala = 0.74, radio = 0.22 } = {}) {
    const margen = (1 - escala) / 2;
    const n = (valor) => Number((valor * lado).toFixed(2));   // 0..1 → píxeles
    const u = (valor) => n(margen + valor * escala);          // dentro del dibujo

    // El contorno del papel, en sentido horario: lado izquierdo, esquinas de
    // arriba redondeadas, lado derecho y borde inferior dentado de vuelta.
    const anchoDiente = (PAPEL.x1 - PAPEL.x0) / DIENTES;
    const vuelta = [];
    for (let i = DIENTES - 1; i >= 0; i--) {
        const centro = PAPEL.x0 + (i + 0.5) * anchoDiente;
        const inicio = PAPEL.x0 + i * anchoDiente;
        vuelta.push(`L ${u(centro)} ${u(PAPEL.y1)} L ${u(inicio)} ${u(PAPEL.y1 - AMPLITUD)}`);
    }

    const papel = [
        `M ${u(PAPEL.x0)} ${u(PAPEL.y0 + PAPEL.r)}`,
        `Q ${u(PAPEL.x0)} ${u(PAPEL.y0)} ${u(PAPEL.x0 + PAPEL.r)} ${u(PAPEL.y0)}`,
        `L ${u(PAPEL.x1 - PAPEL.r)} ${u(PAPEL.y0)}`,
        `Q ${u(PAPEL.x1)} ${u(PAPEL.y0)} ${u(PAPEL.x1)} ${u(PAPEL.y0 + PAPEL.r)}`,
        `L ${u(PAPEL.x1)} ${u(PAPEL.y1 - AMPLITUD)}`,
        ...vuelta,
        'Z'
    ].join(' ');

    const barras = LINEAS.map(l =>
        `  <rect x="${u(l.x0)}" y="${u(l.y - l.alto / 2)}" ` +
        `width="${n((l.x1 - l.x0) * escala)}" height="${n(l.alto * escala)}" ` +
        `rx="${n(0.012 * escala)}" fill="${hex(l.color)}"/>`
    ).join('\n');

    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${lado} ${lado}" width="${lado}" height="${lado}">
  <title>Tiquets</title>
  <rect width="${lado}" height="${lado}" rx="${n(radio)}" fill="${hex(AZUL)}"/>
  <path d="${papel}" fill="${hex(BLANCO)}"/>
${barras}
</svg>
`;
}

function principal() {
    fs.mkdirSync(DESTINO, { recursive: true });

    for (const { archivo, lado, escala, radio } of ICONOS) {
        const png = escribirPNG(lado, dibujar(lado, { escala, radio }));
        fs.writeFileSync(path.join(DESTINO, archivo), png);
        console.log(`🎨 ${archivo.padEnd(28)} ${String(lado).padStart(3)}×${lado}  ${(png.length / 1024).toFixed(1)} KiB`);
    }
    console.log(`\nHecho. ${ICONOS.length} iconos en src/public/iconos/.`);

    const svg = path.join(__dirname, '..', 'src', 'public', 'icono.svg');
    fs.writeFileSync(svg, generarSVG());
    console.log(`🎨 ${'icono.svg'.padEnd(28)} vectorial, para el favicon`);
}

if (require.main === module) principal();

module.exports = { escribirPNG, dibujar, colorDelPunto, generarSVG, ICONOS, AZUL };
