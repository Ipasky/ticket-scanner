/**
 * Endpoints de estadísticas del panel de finanzas.
 *
 * Lo que de verdad se vigila aquí, más allá de que los números salgan:
 *   · que NUNCA se sumen dos monedas distintas,
 *   · que un importe ausente valga 0 al sumar pero siga contando como tiquet,
 *   · que las filas que nadie ha leído ('pendiente'/'error') no entren en las
 *     medias, porque un gasto de cero euros que no es un gasto las hunde,
 *   · y que "este mes" se decida en hora de Madrid, no en UTC.
 *
 * El aislamiento (base temporal, doble de la IA) vive en tests/ayuda_api.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { db, pedir, crearTicket, crearEstablecimiento } = require('./ayuda_api.js');
const { _internos } = require('../src/controllers/estadisticas_controller.js');

async function pedirOk(ruta) {
    const { status, datos } = await pedir('GET', ruta);
    assert.equal(status, 200, `${ruta} debería responder 200: ${JSON.stringify(datos)}`);
    return datos;
}

/**
 * Un histórico con todo lo que hay que distinguir: dos monedas, un documento sin
 * importe, una fila sin fecha, una sin leer y dos años.
 */
function sembrar() {
    const mercadona = crearEstablecimiento('MERCADONA', { ciudad: 'Barcelona' });
    const saba      = crearEstablecimiento('SABA PARKING', { ciudad: 'Barcelona' });
    const renfe     = crearEstablecimiento('RENFE', { ciudad: 'Madrid' });
    const amazon    = crearEstablecimiento('AMAZON', { ciudad: 'Luxemburgo' });

    const fila = (campos) => crearTicket({ moneda: 'EUR', estado: 'procesado', ...campos }).id;

    // --- EUR ---
    fila({ establecimiento_id: mercadona, categoria: 'ALIMENTACION', tipo_documento: 'COMPRA',
           fecha_compra: '2025-12-31 11:00:00', total_centimos: 1000 });
    fila({ establecimiento_id: mercadona, categoria: 'ALIMENTACION', tipo_documento: 'COMPRA',
           fecha_compra: '2026-01-10 13:25:12', total_centimos: 3949 });
    fila({ establecimiento_id: mercadona, categoria: 'ALIMENTACION', tipo_documento: 'COMPRA',
           fecha_compra: '2026-01-20 19:05:00', total_centimos: 2051 });
    // Documento sin importe: cuenta como visita y suma 0.
    const parking = fila({ establecimiento_id: saba, categoria: 'TRANSPORTE', tipo_documento: 'PARKING',
                           fecha_compra: '2026-02-05 09:00:00', total_centimos: null, sin_importe: 1 });
    fila({ establecimiento_id: renfe, categoria: 'TRANSPORTE', tipo_documento: 'BILLETE TREN',
           fecha_compra: '2026-02-14 18:40:00', total_centimos: 12500 });
    // Sin fecha: fuera de cualquier serie temporal, pero es un gasto real.
    const sinFecha = fila({ establecimiento_id: mercadona, categoria: 'ALIMENTACION',
                            tipo_documento: 'COMPRA', fecha_compra: null,
                            total_centimos: 777, estado: 'incompleto' });

    // --- USD, que NO se suma con lo anterior ---
    fila({ establecimiento_id: amazon, categoria: 'COMPRAS', tipo_documento: 'FACTURA',
           fecha_compra: '2026-02-10 12:00:00', total_centimos: 5000, moneda: 'USD' });

    // --- sin leer: no es un gasto de cero euros, es una foto sin procesar ---
    const pendiente = crearTicket({
        estado: 'pendiente', tipo_documento: null, categoria: null,
        fecha_compra: null, total_centimos: null, moneda: null
    }).id;

    return { mercadona, saba, renfe, amazon, parking, sinFecha, pendiente };
}

const soloEur = (filas) => filas.filter(f => f.moneda === 'EUR');

// =============================================================================
// SERIES
// =============================================================================

test('series por mes, una por moneda y sin mezclarlas jamás', async () => {
    sembrar();
    const datos = await pedirOk('/api/estadisticas/series?granularidad=mes');

    assert.deepEqual(datos.monedas, ['EUR', 'USD']);
    assert.equal(datos.varias_monedas, true);
    assert.match(datos.aviso_monedas, /NO se suman/);

    const eur = datos.series.find(s => s.moneda === 'EUR');
    assert.deepEqual(eur.puntos.map(p => [p.periodo, p.total_centimos]), [
        ['2025-12', 1000],
        ['2026-01', 6000],
        // Febrero: el billete de 12500 y el parking sin importe, que suma 0 pero
        // cuenta como tiquet.
        ['2026-02', 12500]
    ]);
    assert.equal(eur.puntos.find(p => p.periodo === '2026-02').tiquets, 2);
    assert.equal(eur.puntos.find(p => p.periodo === '2026-02').sin_importe, 1);

    const usd = datos.series.find(s => s.moneda === 'USD');
    assert.deepEqual(usd.puntos.map(p => [p.periodo, p.total_centimos]), [['2026-02', 5000]]);

    // En ninguna parte hay un total que sume euros con dólares.
    assert.equal(JSON.stringify(datos).includes('17500'), false);
});

test('series por día, semana y año', async () => {
    sembrar();

    const dias = await pedirOk('/api/estadisticas/series?granularidad=dia&desde=2026-01-01&hasta=2026-01-31');
    assert.deepEqual(soloEur(dias.series)[0].puntos.map(p => p.periodo), ['2026-01-10', '2026-01-20']);

    // La semana se etiqueta con su LUNES, que evita toda la discusión sobre
    // semanas ISO a caballo entre dos años.
    const semanas = await pedirOk('/api/estadisticas/series?granularidad=semana&desde=2026-01-01&hasta=2026-01-31');
    const lunes = soloEur(semanas.series)[0].puntos.map(p => p.periodo);
    assert.deepEqual(lunes, ['2026-01-05', '2026-01-19']);

    const anios = await pedirOk('/api/estadisticas/series?granularidad=anio');
    assert.deepEqual(soloEur(anios.series)[0].puntos.map(p => [p.periodo, p.total_centimos]),
                     [['2025', 1000], ['2026', 18500]]);
});

test('el rango recorta la serie por los dos lados', async () => {
    sembrar();
    const datos = await pedirOk('/api/estadisticas/series?granularidad=mes&desde=2026-01-01&hasta=2026-01-31');

    assert.deepEqual(soloEur(datos.series)[0].puntos.map(p => p.periodo), ['2026-01']);
    assert.equal(datos.desde, '2026-01-01');
    assert.equal(datos.hasta, '2026-01-31');
});

test('las filas sin leer y sin fecha no entran en las series', async () => {
    sembrar();
    const datos = await pedirOk('/api/estadisticas/series?granularidad=anio');

    const total = soloEur(datos.series)[0].puntos.reduce((n, p) => n + p.total_centimos, 0);
    // 1000 + 6000 + 12500 = 19500. El 777 de la fila sin fecha no está (no se
    // puede situar en ningún año) y la pendiente tampoco.
    assert.equal(total, 19500);
});

test('una granularidad inventada es un 400, no un mes por defecto', async () => {
    const { status, datos } = await pedir('GET', '/api/estadisticas/series?granularidad=quincena');
    assert.equal(status, 400);
    assert.match(datos.error, /granularidad/);
});

// =============================================================================
// RESUMEN: PERIODO ACTUAL CONTRA EL ANTERIOR
// =============================================================================

test('resumen mensual: este mes contra el pasado, con la variación', async () => {
    sembrar();
    // La referencia se fija para que la prueba no dependa de cuándo se ejecute.
    const datos = await pedirOk('/api/estadisticas/resumen?periodo=mes&referencia=2026-02-15');

    assert.equal(datos.actual.desde, '2026-02-01');
    assert.equal(datos.actual.hasta, '2026-02-28');
    assert.equal(datos.anterior.desde, '2026-01-01');
    assert.equal(datos.anterior.hasta, '2026-01-31');

    const eurActual = datos.actual.por_moneda.find(m => m.moneda === 'EUR');
    assert.equal(eurActual.total_centimos, 12500);
    assert.equal(eurActual.tiquets, 2);
    assert.equal(eurActual.tiquets_con_importe, 1);
    // El ticket medio se calcula sobre los que TIENEN importe: meter el parking
    // sin importe en el divisor lo bajaría a la mitad sin que nadie gastara menos.
    assert.equal(eurActual.ticket_medio_centimos, 12500);

    const eurAnterior = datos.anterior.por_moneda.find(m => m.moneda === 'EUR');
    assert.equal(eurAnterior.total_centimos, 6000);
    assert.equal(eurAnterior.ticket_medio_centimos, 3000);

    const variacionEur = datos.variacion.find(v => v.moneda === 'EUR');
    assert.equal(variacionEur.diferencia_centimos, 6500);
    assert.equal(variacionEur.porcentaje, 108.3);

    // El dólar aparece solo en el mes actual: ahí no hay porcentaje que calcular.
    const variacionUsd = datos.variacion.find(v => v.moneda === 'USD');
    assert.equal(variacionUsd.anterior_centimos, 0);
    assert.equal(variacionUsd.porcentaje, null, 'subir desde cero no es un porcentaje');
});

test('resumen anual', async () => {
    sembrar();
    const datos = await pedirOk('/api/estadisticas/resumen?periodo=anio&referencia=2026-06-01');

    assert.equal(datos.actual.etiqueta, '2026');
    assert.equal(datos.anterior.etiqueta, '2025');
    assert.equal(datos.actual.por_moneda.find(m => m.moneda === 'EUR').total_centimos, 18500);
    assert.equal(datos.anterior.por_moneda.find(m => m.moneda === 'EUR').total_centimos, 1000);
});

test('un periodo sin gasto no revienta: devuelve el bloque vacío', async () => {
    sembrar();
    const datos = await pedirOk('/api/estadisticas/resumen?periodo=mes&referencia=2024-05-10');

    assert.deepEqual(datos.actual.por_moneda, []);
    assert.deepEqual(datos.anterior.por_moneda, []);
    assert.deepEqual(datos.variacion, []);
});

test('el periodo anterior cruza bien el cambio de año y los meses cortos', () => {
    const { periodoY_anterior } = _internos;

    // Enero: el mes anterior es diciembre del año pasado.
    const enero = periodoY_anterior('2026-01-15', 'mes');
    assert.equal(enero.anterior.desde, '2025-12-01');
    assert.equal(enero.anterior.hasta, '2025-12-31');

    // Marzo: el anterior es febrero, con sus 28 o 29 días según el año.
    assert.equal(periodoY_anterior('2026-03-31', 'mes').anterior.hasta, '2026-02-28');
    assert.equal(periodoY_anterior('2024-03-31', 'mes').anterior.hasta, '2024-02-29', 'año bisiesto');

    // Y el día 31 no se convierte en el 1 del mes siguiente, que es lo que pasa
    // haciendo esta aritmética con Date.
    assert.equal(periodoY_anterior('2026-05-31', 'mes').actual.hasta, '2026-05-31');
});

test('"hoy" se decide en hora de Madrid, no en UTC', () => {
    const { hoyEnMadrid } = _internos;

    // 00:30 del 1 de enero en Madrid es todavía 31 de diciembre en UTC: sin esto
    // el panel enseñaría diciembre como "este mes" durante la primera hora del
    // año.
    assert.equal(hoyEnMadrid(new Date('2026-01-01T00:30:00+01:00')), '2026-01-01');
    // En verano son dos horas de diferencia.
    assert.equal(hoyEnMadrid(new Date('2026-07-01T00:30:00+02:00')), '2026-07-01');
    assert.match(hoyEnMadrid(), /^\d{4}-\d{2}-\d{2}$/);
});

// =============================================================================
// CATEGORÍAS
// =============================================================================

test('gasto por categoría, con el porcentaje dentro de su moneda', async () => {
    sembrar();
    const datos = await pedirOk('/api/estadisticas/categorias');

    const alimentacion = datos.categorias.find(c => c.categoria === 'ALIMENTACION' && c.moneda === 'EUR');
    // 1000 + 3949 + 2051 + 777 (la fila sin fecha también es un gasto)
    assert.equal(alimentacion.total_centimos, 7777);
    assert.equal(alimentacion.tiquets, 4);

    const transporte = datos.categorias.find(c => c.categoria === 'TRANSPORTE' && c.moneda === 'EUR');
    assert.equal(transporte.total_centimos, 12500);
    assert.equal(transporte.sin_importe, 1);

    // El porcentaje es sobre el total de SU moneda: 7777 + 12500 = 20277.
    assert.equal(alimentacion.porcentaje_de_su_moneda, 38.4);
    assert.equal(transporte.porcentaje_de_su_moneda, 61.6);

    // El dólar va por su cuenta y se lleva el 100% de lo suyo.
    const compras = datos.categorias.find(c => c.moneda === 'USD');
    assert.equal(compras.porcentaje_de_su_moneda, 100);
});

test('con rango, la fila sin fecha se queda fuera', async () => {
    sembrar();
    const datos = await pedirOk('/api/estadisticas/categorias?desde=2026-01-01&hasta=2026-12-31');

    const alimentacion = datos.categorias.find(c => c.categoria === 'ALIMENTACION' && c.moneda === 'EUR');
    assert.equal(alimentacion.total_centimos, 6000, 'sin el 777 de la fila sin fecha ni el 1000 de 2025');
});

// =============================================================================
// ESTABLECIMIENTOS
// =============================================================================

test('establecimientos por gasto y por visitas, que no son lo mismo', async () => {
    sembrar();

    const porGasto = await pedirOk('/api/estadisticas/establecimientos?orden=gasto');
    assert.equal(porGasto.establecimientos[0].nombre, 'RENFE');
    assert.equal(porGasto.establecimientos[0].total_centimos, 12500);

    const porVisitas = await pedirOk('/api/estadisticas/establecimientos?orden=visitas');
    assert.equal(porVisitas.establecimientos[0].nombre, 'MERCADONA');
    assert.equal(porVisitas.establecimientos[0].visitas, 4);
    assert.equal(porVisitas.establecimientos[0].total_centimos, 7777);

    // La última visita es la fecha más reciente, ignorando las filas sin fecha.
    assert.match(porVisitas.establecimientos[0].ultima_visita, /^2026-01-20/);
});

test('cada establecimiento lleva su moneda; nunca se juntan en una fila', async () => {
    sembrar();
    const datos = await pedirOk('/api/estadisticas/establecimientos');

    for (const e of datos.establecimientos) {
        assert.ok(e.moneda, 'cada fila dice en qué moneda está');
    }
    assert.equal(datos.establecimientos.find(e => e.nombre === 'AMAZON').moneda, 'USD');
});

// =============================================================================
// MAPA
// =============================================================================

test('el mapa solo trae lo que tiene coordenadas, con sus últimos tiquets', async () => {
    const { mercadona, renfe } = sembrar();
    db.prepare(`UPDATE establecimientos SET latitud = ?, longitud = ?, geo_estado = 'ok' WHERE id = ?`)
      .run(41.3755, 2.137, mercadona);

    const datos = await pedirOk('/api/estadisticas/mapa');

    assert.equal(datos.puntos.length, 1, 'el resto todavía no está geocodificado');
    const punto = datos.puntos[0];
    assert.equal(punto.establecimiento_id, mercadona);
    assert.equal(punto.latitud, 41.3755);
    assert.equal(punto.visitas, 4);
    assert.match(punto.ultima_visita, /^2026-01-20/);

    const eur = punto.por_moneda.find(m => m.moneda === 'EUR');
    assert.equal(eur.total_centimos, 7777);

    // Los últimos tiquets, para el globo del mapa: como mucho cinco y ordenados
    // del más reciente al más antiguo.
    assert.ok(punto.ultimos_tiquets.length > 0 && punto.ultimos_tiquets.length <= 5);
    assert.match(punto.ultimos_tiquets[0].fecha_compra, /^2026-01-20/);
    assert.ok(renfe);
});

test('sin ningún establecimiento geocodificado, el mapa está vacío pero responde', async () => {
    sembrar();
    const datos = await pedirOk('/api/estadisticas/mapa');
    assert.deepEqual(datos.puntos, []);
    assert.deepEqual(datos.monedas, []);
});

// =============================================================================
// CONTROL
// =============================================================================

test('los contadores de control cuentan también lo que no es gasto', async () => {
    sembrar();
    const datos = await pedirOk('/api/estadisticas/control');

    assert.equal(datos.tiquets, 8, 'aquí sí entran la pendiente y la que no tiene fecha');
    assert.equal(datos.sin_importe, 1);
    assert.equal(datos.incompletos, 1);
    assert.equal(datos.pendientes, 1);
    assert.equal(datos.con_error, 0);
});

test('control informa de cuántos establecimientos faltan por situar en el mapa', async () => {
    const { mercadona } = sembrar();
    db.prepare(`UPDATE establecimientos SET geo_estado = 'ok', latitud = 1, longitud = 1 WHERE id = ?`)
      .run(mercadona);
    db.prepare(`UPDATE establecimientos SET geo_estado = 'fallido' WHERE nombre = 'AMAZON'`).run();

    const datos = await pedirOk('/api/estadisticas/control');

    assert.equal(datos.establecimientos.establecimientos, 4);
    assert.equal(datos.establecimientos.geo_ok, 1);
    assert.equal(datos.establecimientos.geo_fallidos, 1);
    assert.equal(datos.establecimientos.geo_pendientes, 2);
});

// =============================================================================
// PROTECCIÓN Y ERRORES
// =============================================================================

test('las estadísticas exigen identidad, como todo /api', async () => {
    const { ctx } = require('./ayuda_api.js');
    for (const ruta of ['series', 'resumen', 'categorias', 'establecimientos', 'mapa', 'control']) {
        const res = await fetch(`${ctx.base}/api/estadisticas/${ruta}`);
        assert.equal(res.status, 401, `/${ruta} tiene que exigir identidad`);
    }
});

test('un rango del revés se explica en vez de devolver una lista vacía', async () => {
    const { status, datos } = await pedir('GET', '/api/estadisticas/series?desde=2026-12-01&hasta=2026-01-01');
    assert.equal(status, 400);
    assert.match(datos.error, /del revés/);
});

test('una fecha que no es una fecha es un 400 en todos los endpoints', async () => {
    for (const ruta of ['series', 'categorias', 'establecimientos', 'mapa', 'control']) {
        const { status } = await pedir('GET', `/api/estadisticas/${ruta}?desde=el-lunes`);
        assert.equal(status, 400, `/${ruta}`);
    }
});

// =============================================================================
// PRECISIÓN EN EL MAPA Y CONTADOR DE SIN UBICAR
// =============================================================================

test('cada punto del mapa dice con qué precisión está situado', async () => {
    // El mapa pinta sólidos los puntos finos y tenues los aproximados; para eso
    // necesita saber de cuál se trata.
    const { mercadona, renfe } = sembrar();
    db.prepare(`UPDATE establecimientos SET latitud=?, longitud=?, geo_estado='ok', geo_precision='exacta' WHERE id=?`)
      .run(41.3755, 2.137, mercadona);
    db.prepare(`UPDATE establecimientos SET latitud=?, longitud=?, geo_estado='ok', geo_precision='localidad' WHERE id=?`)
      .run(40.4168, -3.7038, renfe);

    const datos = await pedirOk('/api/estadisticas/mapa');

    const fino = datos.puntos.find(p => p.establecimiento_id === mercadona);
    assert.equal(fino.precision, 'exacta');
    assert.equal(fino.aproximada, false);

    const aproximado = datos.puntos.find(p => p.establecimiento_id === renfe);
    assert.equal(aproximado.precision, 'localidad');
    assert.equal(aproximado.aproximada, true, 'el tooltip dirá "ubicación aproximada"');
});

test('un punto puesto a mano cuenta como fino', async () => {
    const { mercadona } = sembrar();
    db.prepare(`UPDATE establecimientos SET latitud=?, longitud=?, geo_estado='ok', geo_precision='manual' WHERE id=?`)
      .run(41.0, 0.9, mercadona);

    const datos = await pedirOk('/api/estadisticas/mapa');
    assert.equal(datos.puntos[0].aproximada, false);
});

test('control cuenta los tiquets sin ubicar, que es lo que filtra el historial', async () => {
    const { mercadona } = sembrar();
    db.prepare(`UPDATE establecimientos SET latitud=?, longitud=?, geo_estado='ok' WHERE id=?`)
      .run(41.3755, 2.137, mercadona);

    const datos = await pedirOk('/api/estadisticas/control');

    // MERCADONA tiene 4 tiquets situados; quedan 4 sin ubicar (parking, renfe,
    // amazon y la fila pendiente sin establecimiento).
    assert.equal(datos.sin_ubicar, 4);
    assert.equal(datos.establecimientos.sin_ubicar, 3);
    assert.equal(datos.establecimientos.a_mano, 0);
});

// =============================================================================
// DETALLE POR HORA (la vista diaria)
// =============================================================================
// La vista de día no dibuja barras: pone una marca por tiquet en la hora a la
// que se compró. Necesita las filas, no los agregados, y necesita saber cuáles
// NO tienen hora: hora_conocida = 0 no significa medianoche.

/** Un día con tres compras: dos con hora impresa y una sin ella. */
function sembrarUnDia() {
    const forn = crearEstablecimiento('FORN DEL CARRER');
    const merca = crearEstablecimiento('MERCADONA');
    const saba = crearEstablecimiento('SABA PARKING');

    crearTicket({ establecimiento_id: forn, moneda: 'EUR', total_centimos: 540,
                  fecha_compra: '2026-04-15 09:12:00', hora_conocida: 1, categoria: 'ALIMENTACION' });
    crearTicket({ establecimiento_id: merca, moneda: 'EUR', total_centimos: 4210,
                  fecha_compra: '2026-04-15 13:40:00', hora_conocida: 1, categoria: 'ALIMENTACION' });
    // Sin hora impresa: la fecha se guarda a secas, sin hora.
    crearTicket({ establecimiento_id: saba, moneda: 'EUR', total_centimos: 1200,
                  fecha_compra: '2026-04-15', hora_conocida: 0, categoria: 'TRANSPORTE' });
}

test('el detalle trae los tiquets del día con su hora en minutos', async () => {
    sembrarUnDia();
    const datos = await pedirOk(
        '/api/estadisticas/series?granularidad=dia&desde=2026-04-15&hasta=2026-04-15&detalle=1'
    );

    // El agregado del día sigue ahí: el detalle se añade, no sustituye.
    assert.equal(soloEur(datos.series)[0].puntos[0].total_centimos, 5950);

    assert.equal(datos.detalle.tiquets.length, 3);
    assert.equal(datos.detalle.truncado, false);

    const porNombre = new Map(datos.detalle.tiquets.map(t => [t.establecimiento, t]));
    assert.equal(porNombre.get('FORN DEL CARRER').hora, '09:12');
    assert.equal(porNombre.get('FORN DEL CARRER').minutos, 9 * 60 + 12);
    assert.equal(porNombre.get('MERCADONA').minutos, 13 * 60 + 40);
    assert.equal(porNombre.get('MERCADONA').total_centimos, 4210);
    assert.equal(porNombre.get('MERCADONA').moneda, 'EUR');
});

test('sin hora conocida, el detalle no inventa las 00:00', async () => {
    sembrarUnDia();
    const datos = await pedirOk(
        '/api/estadisticas/series?granularidad=dia&desde=2026-04-15&hasta=2026-04-15&detalle=1'
    );

    const saba = datos.detalle.tiquets.find(t => t.establecimiento === 'SABA PARKING');
    assert.equal(saba.hora_conocida, 0);
    assert.equal(saba.hora, null);
    assert.equal(saba.minutos, null, 'la interfaz lo pone aparte, no a medianoche');
});

test('quien manda es hora_conocida, no lo que ponga el texto de la fecha', async () => {
    // Una fila antigua puede tener hora en el texto y hora_conocida = 0. Si se
    // creyera al texto, se dibujaría una compra a una hora que nadie leyó en el
    // papel.
    crearTicket({ moneda: 'EUR', total_centimos: 100,
                  fecha_compra: '2026-04-15 03:00:00', hora_conocida: 0 });

    const datos = await pedirOk(
        '/api/estadisticas/series?granularidad=dia&desde=2026-04-15&hasta=2026-04-15&detalle=1'
    );
    assert.equal(datos.detalle.tiquets[0].minutos, null);
});

test('el detalle solo trae lo que cuenta como gasto', async () => {
    sembrarUnDia();
    // Una foto sin leer del mismo día: no es un gasto de cero euros.
    crearTicket({ estado: 'pendiente', fecha_compra: '2026-04-15 10:00:00', hora_conocida: 1 });
    crearTicket({ estado: 'error', fecha_compra: '2026-04-15 11:00:00', hora_conocida: 1 });

    const datos = await pedirOk(
        '/api/estadisticas/series?granularidad=dia&desde=2026-04-15&hasta=2026-04-15&detalle=1'
    );
    assert.equal(datos.detalle.tiquets.length, 3);
    assert.equal(datos.detalle.tiquets.every(t => t.estado === 'procesado'), true);
});

test('sin pedirlo, no hay detalle: las otras tres vistas no lo gastan', async () => {
    sembrarUnDia();
    const datos = await pedirOk('/api/estadisticas/series?granularidad=mes');

    assert.equal(datos.detalle, undefined);
});

test('un detalle que no es ni sí ni no se explica', async () => {
    const { status, datos } = await pedir(
        'GET', '/api/estadisticas/series?granularidad=dia&detalle=puede'
    );
    assert.equal(status, 400);
    assert.match(datos.error, /detalle/);
});
