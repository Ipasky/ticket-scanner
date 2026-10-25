const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const ticketController = require('../controllers/ticket_controller.js');
const { asegurarUploads } = require('../config/rutas.js');

// 1. CONFIGURACIÓN DE MULTER (Dónde guardar las fotos)
// La carpeta la decide config/rutas.js, que es la misma que usa el controlador
// para leer y borrar imágenes. Antes estaba calculada por duplicado.

// Qué se admite subir. Las FACTURAS llegan en PDF, y Gemini las lee de forma
// nativa (varias páginas incluidas), así que no hay que convertirlas a imagen:
// se guardan y se mandan tal cual. La extensión sale del tipo MIME cuando el
// nombre original no trae una usable, porque de la extensión del archivo
// guardado depende el tipo que se le vuelve a mandar a la IA al reintentar.
const EXTENSION_POR_MIME = {
    'image/jpeg': '.jpg',
    'image/png':  '.png',
    'image/webp': '.webp',
    'image/gif':  '.gif',
    'image/heic': '.heic',
    'image/heif': '.heif',
    'application/pdf': '.pdf'
};

// Un tope con mensaje claro, no un 500 a medio subir.
//
// 100 MB por defecto: este es un servidor propio y el original se guarda SIEMPRE
// tal cual, sin recomprimir ni redimensionar, así que el tope es el del disco y
// no el de lo que quepa en una petición a Gemini. Lo que no cabe incrustado se
// le manda por su Files API (ver services/ai_service.js), que admite mucho más.
//
// SUBIDA_MAX_MB lo cambia sin tocar código. Un valor que no sea un número
// positivo se ignora: un tope de 0 dejaría la aplicación sin poder subir nada y
// el motivo costaría de encontrar.
const LIMITE_MB = (() => {
    const pedido = Number(String(process.env.SUBIDA_MAX_MB || '').trim());
    return Number.isFinite(pedido) && pedido > 0 ? pedido : 100;
})();

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, asegurarUploads());
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const delNombre = path.extname(file.originalname).toLowerCase();
        const admitida = Object.values(EXTENSION_POR_MIME).includes(delNombre)
            || delNombre === '.jpeg';
        cb(null, uniqueSuffix + (admitida ? delNombre : EXTENSION_POR_MIME[file.mimetype] || '.jpg'));
    }
});

const upload = multer({
    storage,
    limits: { fileSize: LIMITE_MB * 1024 * 1024, files: 1 },
    fileFilter: (req, file, cb) => {
        if (EXTENSION_POR_MIME[file.mimetype]) return cb(null, true);
        const error = new Error(file.mimetype);
        error.code = 'TIPO_NO_ADMITIDO';
        cb(error);
    }
});

/**
 * Multer envuelto para que sus errores salgan como JSON explicado.
 *
 * Sin esto, pasarse del tamaño cae en el manejador de errores de Express y el
 * navegador recibe un 500 con HTML: desde la interfaz se ve como "error de
 * conexión al subir", que es justo lo que no está pasando.
 */
const recibirArchivo = (req, res, next) => {
    upload.single('ticket')(req, res, (error) => {
        if (!error) return next();

        if (error.code === 'LIMIT_FILE_SIZE') {
            return res.status(413).json({
                error: `El archivo pasa de ${LIMITE_MB} MB y no se ha subido. ` +
                       `Si de verdad hace falta subir algo más grande, sube SUBIDA_MAX_MB ` +
                       `en el .env y reinicia: aquí nada se recomprime, así que el tope ` +
                       `es una decisión tuya y no un límite técnico.`
            });
        }
        if (error.code === 'TIPO_NO_ADMITIDO') {
            return res.status(415).json({
                error: `Ese tipo de archivo no se admite (${error.message}). ` +
                       `Sube una imagen (JPG, PNG, WEBP, HEIC) o un PDF.`
            });
        }
        return res.status(400).json({
            error: `No se ha podido recibir el archivo: ${error.message}`
        });
    });
};

// 2. DEFINIR RUTAS
router.post('/upload', recibirArchivo, ticketController.subirTicket);
router.get('/', ticketController.obtenerTickets);

// Un solo tiquet, para repintar una fila sin recargar el historial entero.
// Los establecimientos ya guardados, para elegir uno en el editor. Va ANTES de
// '/:id': si no, "establecimientos" se tomaría por un id.
router.get('/establecimientos', ticketController.listarEstablecimientos);
router.post('/lugares/buscar', ticketController.buscarLugarLibre);
router.put('/establecimientos/:id', ticketController.editarEstablecimiento);
// Sus últimos tiquets y cargos del banco: para saber qué sitio es.
router.get('/establecimientos/:id/actividad', ticketController.actividadEstablecimiento);
// Tienda online / sin ubicación, o volver a buscarle sitio.
router.put('/establecimientos/:id/online', ticketController.marcarOnlineEstablecimiento);
// Unir: los tiquets del establecimiento `origen` pasan a este y aquel se borra.
router.post('/establecimientos/:id/unir', ticketController.unirEstablecimientos);
router.post('/establecimientos/:id/buscar-lugar', ticketController.buscarLugar);
router.post('/establecimientos/:id/elegir-lugar', ticketController.elegirLugar);
router.post('/establecimientos/:id/descartar-lugar', ticketController.descartarLugar);
router.get('/:id', ticketController.obtenerTicket);

// Corrección manual de lo que la IA leyó mal.
router.put('/:id', ticketController.editarTicket);
// Solo el reparto (comensales): entre cuántos y mi parte.
router.put('/:id/compartido', ticketController.ponerCompartido);

// Borra la fila Y la imagen del disco.
router.delete('/:id', ticketController.borrarTicket);

// Vuelve a pasar por la IA una fila que quedó en 'pendiente' o 'error'.
router.post('/:id/reintentar', ticketController.reintentarTicket);

module.exports = router;
