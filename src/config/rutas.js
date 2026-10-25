/**
 * Rutas de disco compartidas: las usan el controlador (leer/borrar imágenes) y
 * las rutas (dónde deja multer los archivos subidos). Estaban duplicadas en los
 * dos sitios con __dirname distintos; aquí se calculan una sola vez.
 *
 * TICKETS_UPLOADS_DIR permite apuntar a otra carpeta. Las pruebas la usan para
 * no escribir ni borrar nada dentro de uploads/ del proyecto.
 */
const fs = require('fs');
const path = require('path');

const UPLOADS_DIR = process.env.TICKETS_UPLOADS_DIR
    ? path.resolve(process.env.TICKETS_UPLOADS_DIR)
    : path.join(__dirname, '../../uploads');

const REEMPLAZADAS_DIR = path.join(UPLOADS_DIR, 'reemplazadas');

/**
 * Traduce la URL guardada en la columna ruta_imagen a una ruta de disco.
 *   "/uploads/1737.jpg"                -> <UPLOADS_DIR>/1737.jpg
 *   "/uploads/reemplazadas/1737.jpg"   -> <UPLOADS_DIR>/reemplazadas/1737.jpg
 *
 * Devuelve null si la URL no es usable o si apuntaría FUERA de UPLOADS_DIR. Ese
 * guardarraíl importa porque esta función alimenta a fs.unlink: una columna con
 * "../../.env" dentro no puede acabar borrando un archivo del proyecto.
 */
function rutaEnDisco(rutaImagenUrl) {
    if (typeof rutaImagenUrl !== 'string' || rutaImagenUrl.trim() === '') return null;

    const relativa = rutaImagenUrl
        .trim()
        .replace(/\\/g, '/')
        .replace(/^\/+/, '')
        .replace(/^uploads\/?/i, '');

    if (relativa === '') return null;

    const destino = path.resolve(UPLOADS_DIR, relativa);
    const base = UPLOADS_DIR.endsWith(path.sep) ? UPLOADS_DIR : UPLOADS_DIR + path.sep;
    if (destino !== UPLOADS_DIR && !destino.startsWith(base)) return null;

    return destino;
}

/** Tipo MIME a partir de la extensión, para reenviar la imagen a la IA. */
const MIME_POR_EXTENSION = {
    '.jpg':  'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png':  'image/png',
    '.webp': 'image/webp',
    '.gif':  'image/gif',
    '.heic': 'image/heic',
    '.heif': 'image/heif',
    '.pdf':  'application/pdf'
};

function mimeDeArchivo(rutaDisco) {
    return MIME_POR_EXTENSION[path.extname(rutaDisco).toLowerCase()] || 'image/jpeg';
}

/** Crea UPLOADS_DIR si no existe (multer falla si no está). */
function asegurarUploads() {
    if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    return UPLOADS_DIR;
}

module.exports = {
    UPLOADS_DIR,
    REEMPLAZADAS_DIR,
    rutaEnDisco,
    mimeDeArchivo,
    asegurarUploads
};
