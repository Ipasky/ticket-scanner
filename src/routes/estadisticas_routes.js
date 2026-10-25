const express = require('express');
const router = express.Router();
const estadisticas = require('../controllers/estadisticas_controller.js');

// Todas son de solo lectura y todas calculan en SQL. Van detrás del guard de
// /api como el resto: son datos de gasto, de los más personales que hay aquí.

// Gasto por día, semana, mes o año en un rango. Para las gráficas.
router.get('/series', estadisticas.series);

// Este mes contra el pasado (o este año contra el pasado), con la variación.
router.get('/resumen', estadisticas.resumen);

// Qué es un día (o un mes) caro PARA MÍ: percentiles de mi propio gasto. Es la
// escala de color del calendario, de la semana, del año y del mapa.
router.get('/escala', estadisticas.escala);

// Gasto por categoría en un rango.
router.get('/categorias', estadisticas.categorias);

// Dónde se gasta y dónde se va más veces, que no siempre es lo mismo.
router.get('/establecimientos', estadisticas.establecimientos);

// Un registro por establecimiento con coordenadas, para el mapa.
router.get('/mapa', estadisticas.mapa);

// Los contadores de "hay que mirar esto": sin importe, incompletos, pendientes
// y cuántos establecimientos faltan por situar en el mapa.
router.get('/control', estadisticas.control);
// Previsión del mes: lo gastado + pagos periódicos pendientes + gasto variable.
router.get('/prevision', estadisticas.prevision);
// Comidas de restaurante de cierto importe sin decir cuántos éramos.
router.get('/comensales', estadisticas.comensales);

module.exports = router;
