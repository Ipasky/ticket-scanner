'use strict';

/**
 * Rutas del banco. Todo bajo /api/banco (protegido por el guard de /api), salvo
 * /banco/vuelta, que es a donde el banco devuelve al navegador tras autorizar y
 * lleva su propio guard en app.js.
 */
const express = require('express');
const { banco } = require('../services/banco');

const router = express.Router();

// Un 401/403 de Enable Banking NO puede llegar tal cual al navegador: la página
// lo toma como "sin sesión" y manda al login. Los errores del banco se
// devuelven como 502 con el mensaje de Enable Banking dentro.
const fallo = (res, err) => {
    const s = Number(err.estado);
    const propio = [400, 404, 503].includes(s) && !/^Enable Banking/.test(err.message);
    res.status(propio ? s : 502).json({ error: err.message });
};

router.get('/estado', (req, res) => {
    try { res.json(banco().estado()); } catch (err) { fallo(res, err); }
});

router.post('/conectar', async (req, res) => {
    try { res.json(await banco().iniciarConexion()); } catch (err) { fallo(res, err); }
});

router.put('/cuentas/:uid', (req, res) => {
    const ok = banco().marcarCuenta(String(req.params.uid), Boolean((req.body || {}).leer));
    if (!ok) return res.status(404).json({ error: 'Esa cuenta no existe.' });
    res.json(banco().estado());
});

router.post('/sincronizar', async (req, res) => {
    try {
        // Con el usuario delante: su IP y su navegador, que es lo que el banco
        // usa para no contarlo en el límite de consultas automáticas.
        const r = await banco().sincronizar({ usuario: { ip: req.ip, agente: req.get('user-agent') } });
        res.json({ ...r, estado: banco().estado() });
    } catch (err) { fallo(res, err); }
});

router.get('/movimientos', (req, res) => {
    try {
        res.json({ movimientos: banco().listarMovimientos({
            limite: req.query.limite, desde: req.query.desde, hasta: req.query.hasta, filtro: req.query.filtro
        }) });
    } catch (err) { fallo(res, err); }
});

// Los tiquets que el banco ha confirmado: el historial les pone su marca.
router.get('/enlaces', (req, res) => {
    try { res.json({ enlaces: banco().enlaces() }); } catch (err) { fallo(res, err); }
});

router.get('/movimientos/:id/candidatos', (req, res) => {
    try {
        const lista = banco().candidatos(Number(req.params.id));
        if (!lista) return res.status(404).json({ error: 'Ese movimiento no existe.' });
        res.json({ candidatos: lista });
    } catch (err) { fallo(res, err); }
});

// Enlazar a mano: { tiquet_id } o { tiquet_id: null } para "no tiene tiquet".
router.put('/movimientos/:id/tiquet', (req, res) => {
    const t = (req.body || {}).tiquet_id;
    const tiquet = t === null || t === undefined ? null : Number(t);
    if (tiquet !== null && !Number.isInteger(tiquet)) return res.status(400).json({ error: 'tiquet_id no válido.' });
    if (!banco().enlazar(Number(req.params.id), tiquet)) return res.status(404).json({ error: 'Ese movimiento no existe.' });
    res.json({ resultado: tiquet ? 'enlazado' : 'sin_tiquet' });
});

router.get('/movimientos/:id', (req, res) => {
    const m = banco().movimiento(Number(req.params.id));
    if (!m) return res.status(404).json({ error: 'Ese movimiento no existe.' });
    res.json(m);
});

// { excluir: true } = no cuenta como gasto (traspaso entre cuentas, inversión…).
// { categoria: 'OCIO' } = la pone a mano y la aprende para ese comercio.
router.put('/movimientos/:id', (req, res) => {
    const id = Number(req.params.id);
    const b = req.body || {};
    if (!banco().movimiento(id)) return res.status(404).json({ error: 'Ese movimiento no existe.' });
    try {
        if ('clase' in b) banco().cambiarClase(id, String(b.clase));
        // Establecimiento a mano: { id } uno existente, { nombre } por nombre, null = automático.
        if ('establecimiento' in b) banco().ponerEstablecimiento(id, b.establecimiento || {});
    } catch (err) { return fallo(res, err); }
    if ('excluir' in b) banco().marcarExcluir(id, Boolean(b.excluir));
    if ('categoria' in b) banco().ponerCategoria(id, b.categoria);
    if ('compartido_entre' in b) banco().marcarCompartido(id, b.compartido_entre, b.mi_parte_centimos);
    res.json(banco().movimiento(id));
});

// Clasificar ya con Gemini lo que quede sin categoría.
router.post('/clasificar', async (req, res) => {
    try { res.json({ clasificados: await banco().clasificarConIA() }); } catch (err) { fallo(res, err); }
});

router.get('/resumen', (req, res) => {
    try { res.json({ resumen: banco().resumen({ desde: req.query.desde, hasta: req.query.hasta }) }); }
    catch (err) { fallo(res, err); }
});

// Extracto en Excel, ya leído en el navegador: { iban, filas: [{ fecha, fecha_valor, concepto, importe, saldo }] }
router.post('/importar', (req, res) => {
    try {
        const b = req.body || {};
        if (!Array.isArray(b.filas) || !b.filas.length) return res.status(400).json({ error: 'El extracto no trae movimientos.' });
        res.json(banco().importar({ iban: b.iban, filas: b.filas }));
    } catch (err) { fallo(res, err); }
});

// Confirmar (con correcciones), descartar o volver a lo detectado (estado null).
router.put('/suscripciones/:clave', (req, res) => {
    const b = req.body || {};
    try {
        banco().ponerSuscripcion(String(req.params.clave), {
            estado: 'estado' in b ? b.estado : 'confirmada', nombre: b.nombre,
            importe_centimos: b.importe_centimos, ritmo: b.ritmo || null, proximo: b.proximo || null
        });
        res.json({ suscripciones: banco().suscripciones() });
    } catch (err) { fallo(res, err); }
});
// Una nueva: { movimiento_id } o { nombre, importe_centimos, ritmo, proximo }.
router.post('/suscripciones', (req, res) => {
    try {
        const clave = banco().crearSuscripcion(req.body || {});
        res.json({ clave, suscripciones: banco().suscripciones() });
    } catch (err) { fallo(res, err); }
});
// El pago del banco de un tiquet (enlazado o candidatos), para la ficha del tiquet.
router.get('/tiquet/:id', (req, res) => {
    try { res.json(banco().pagoDeTiquet(Number(req.params.id))); } catch (err) { fallo(res, err); }
});
router.get('/suscripciones', (req, res) => {
    try { res.json({ suscripciones: banco().suscripciones() }); } catch (err) { fallo(res, err); }
});

/** GET /banco/vuelta?code=…&state=… — el retorno del banco. */
async function vuelta(req, res) {
    const { code, state, error, error_description: descripcion } = req.query;
    if (error || !code) {
        const texto = descripcion || error || 'El banco no ha devuelto autorización.';
        return res.redirect(`/?banco=error&mensaje=${encodeURIComponent(String(texto).slice(0, 200))}`);
    }
    try {
        await banco().completarConexion(String(code), String(state || ''));
        res.redirect('/?banco=conectado');
    } catch (err) {
        res.redirect(`/?banco=error&mensaje=${encodeURIComponent(err.message.slice(0, 200))}`);
    }
}

module.exports = { router, vuelta };
