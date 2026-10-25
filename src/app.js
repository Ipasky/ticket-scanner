const express = require('express');
const path = require('path');
// El .env por ruta absoluta: así `node src/app.js` funciona desde cualquier
// directorio y no solo desde la raíz del proyecto.
require('dotenv').config({ path: require('node:path').resolve(__dirname, '../.env') });

// auth se carga ANTES que cualquier ruta: valida su configuración al importarse y
// aborta el proceso si falta algo del modo activo. Arrancar sin protección sería
// peor que no arrancar, así que el fallo tiene que ocurrir aquí y ser ruidoso.
const auth = require('./services/auth');

const ticketRoutes = require('./routes/ticket_routes');
const eventos = require('./services/eventos');
const bancoRutas = require('./routes/banco_routes');
const estadisticasRoutes = require('./routes/estadisticas_routes');
const geo = require('./services/geocodificacion');
const divisas = require('./services/divisas');
const ia = require('./services/ai_service');
const { UPLOADS_DIR } = require('./config/rutas');

const app = express();
const PORT = process.env.PORT || 3000;

// MIDDLEWARES (Configuraciones previas)
// Permite al servidor entender JSON (el PUT de edición manda el ticket entero).
// El límite por defecto de express.json() es 100kb: un tiquet con muchos items y
// detalles no se acerca, pero lo dejamos explícito para que se vea el techo.
// Un extracto del banco de varios años pesa más: solo esa ruta admite más.
app.use('/api/banco/importar', express.json({ limit: '15mb' }));
app.use(express.json({ limit: '1mb' }));

// --- RUTAS PÚBLICAS ---------------------------------------------------------

// Healthcheck de Kubernetes: público a propósito. No revela nada.
//
// Va FUERA de todo guard, incluido el de IP de origen del modo proxy: las sondas
// las lanza el kubelet desde la IP del nodo, no desde la red de pods, así que
// restringir el origen aquí las haría fallar y Kubernetes reiniciaría el pod en
// bucle.
app.get('/ping', (req, res) => {
    res.json({ message: '¡Pong! El servidor está funcionando correctamente.' });
});

// El frontend necesita saber si hay identidad, de qué tipo es este despliegue y a
// dónde mandar a quien no la tenga. No devuelve nada que no se pueda deducir
// intentando entrar. En modo proxy sí comprueba la IP de origen (lo hace el
// propio handler), así que desde fuera de la red del portal responde 403.
app.get('/api/auth/estado', auth.estadoSesion);
// Las dos existen solo en modo local; en modo proxy responden 404 explicando que
// de las contraseñas y del cierre de sesión se encarga el portal.
app.post('/api/auth/login', auth.iniciarSesion);
app.post('/api/auth/logout', auth.cerrarSesion);

// El caparazón del frontend (index.html, login.html, app.js) no contiene datos:
// todo lo que se ve llega por /api, que sí está protegido. Servirlo abierto
// permite que la página de login exista y que el 401 se pueda pintar. Aquí
// dentro van también el manifiesto, el service worker y los iconos de la PWA.
app.use(express.static(path.join(__dirname, 'public'), {
    setHeaders(res, rutaDelArchivo) {
        const nombre = path.basename(rutaDelArchivo);
        // El service worker y el manifiesto NO se cachean en el navegador. Si el
        // navegador sirviera un sw.js viejo de su propia caché HTTP, la
        // aplicación se quedaría congelada en una versión antigua del armazón y
        // no habría manera de desplegar nada: el fichero que arregla el problema
        // es justo el que no se vuelve a pedir.
        if (nombre === 'sw.js' || nombre === 'manifest.webmanifest') {
            res.setHeader('Cache-Control', 'no-cache');
        }
    }
}));

// --- RUTAS PROTEGIDAS -------------------------------------------------------

// Las imágenes de los tiquets. ESTO ERA UN AGUJERO: hasta ahora era un
// express.static abierto, así que cualquiera con la URL de una imagen veía la
// foto de un tiquet —con su importe, su establecimiento y su matrícula— sin
// pasar por nada.
//
// Se mantiene express.static DETRÁS del guard en lugar de escribir el envío del
// archivo a mano: así se conservan los tipos MIME, las peticiones por rango y los
// ETag, y lo único que se añade es el control de identidad delante. El guard es
// el MISMO middleware que protege la API, no una copia.
app.use('/uploads', auth.exigirIdentidad, express.static(UPLOADS_DIR, {
    index: false,        // nada de listar el directorio
    dotfiles: 'deny',
    setHeaders(res) {
        // Son fotos de tiquets de una persona: que ninguna caché intermedia las
        // guarde como si fueran públicas.
        res.setHeader('Cache-Control', 'private, max-age=300');
    }
}));

// TODO /api/* exige identidad. El guard se monta sobre '/api' entero y no sobre
// cada router: así una ruta nueva nace protegida y hay que querer explícitamente
// lo contrario (sacándola arriba, con las públicas) en lugar de quedarse abierta
// por olvido. Las tres rutas de /api/auth de arriba ya han respondido cuando se
// llega aquí; quedan fuera por necesidad, porque hay que poder preguntar si hay
// sesión y poder iniciarla sin tenerla.
app.use('/api', auth.exigirIdentidad);

// Qué modelos de IA hay configurados y qué modos de selección ofrecer. El
// frontend pinta el selector con esto en lugar de llevar las etiquetas clavadas
// en el HTML: la lista de modelos vive en el .env y cambia sin tocar código.
// No devuelve nada sensible —nombres de modelo, no claves—, pero va detrás del
// guard igual que el resto de /api: no hay razón para publicar la configuración
// del servicio a quien no ha entrado.
// El mapa de Google se carga en el navegador: necesita SU clave (restringida
// por dominio en la consola de Google, no la de Places del servidor).
app.get('/api/mapa/config', (req, res) => {
    res.json({
        clave: String(process.env.GOOGLE_MAPS_API_KEY || '').trim() || null,
        map_id: String(process.env.GOOGLE_MAPS_MAP_ID || '').trim() || 'DEMO_MAP_ID'
    });
});

app.get('/api/ia/config', (req, res) => {
    res.json(ia.configuracionPublica());
});

// Avisos en tiempo real entre pestañas y dispositivos (escaneos y cambios).
app.get('/api/eventos', eventos.suscribir);
app.use('/api/tickets', eventos.registrarCambios, ticketRoutes);
// El banco (Enable Banking, solo lectura). /banco/vuelta es a donde el banco
// devuelve al navegador tras autorizar: fuera de /api, con su propio guard.
app.use('/api/banco', bancoRutas.router);
app.get('/banco/vuelta', auth.exigirIdentidad, bancoRutas.vuelta);

// El panel de finanzas. Todo calculado en SQL y agregado por moneda.
app.use('/api/estadisticas', estadisticasRoutes);

// Solo arrancamos el servidor cuando este archivo se ejecuta directamente
// (`npm start`). Al requerirlo desde las pruebas se exporta la app sin escuchar,
// y cada prueba abre su propio servidor en un puerto libre.
if (require.main === module) {
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`Servidor arrancado y listo.`);
        console.log(auth.resumenDeArranque());
        console.log(geo.resumenDeArranque());

        // Geocodificación de fondo: vacía lo que quedara pendiente, de uno en uno
        // y a una petición por segundo. Va AQUÍ dentro y no al cargar el módulo a
        // propósito: las pruebas importan la app sin escuchar, y no tienen por qué
        // mandarle tráfico a Nominatim por existir.
        geo.arrancarEnSegundoPlano();
        // Lo mismo con las compras en otra moneda: a euros, en segundo plano.
        divisas.arrancar();
        // Y la verificación de establecimientos con Google Places.
        require('./services/lugares').arrancar();
        // Y la descarga de movimientos del banco, cada 6 horas.
        require('./services/banco').banco().arrancar();
        console.log(`Acceso local: http://localhost:${PORT}`);
        console.log(`Para entrar con el móvil, necesitarás tu IP local.`);
    });
}

module.exports = app;
