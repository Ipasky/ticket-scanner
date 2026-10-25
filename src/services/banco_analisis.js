'use strict';

/**
 * Lo que se saca de los movimientos del banco: qué son, con qué tiquet casan y
 * cuáles se repiten (suscripciones y recibos).
 *
 * Los conceptos del Santander tienen pocas formas, todas con el comercio y la
 * población dentro:
 *   PAGO MOVIL EN <COMERCIO>, <POBLACION> ES, TARJ. :*1234
 *   COMPRA EN <COMERCIO>, <POBLACION> ES, TARJ. :*1234
 *   COMPRA INTERNET EN <COMERCIO>, <POBLACION> ES, TARJ. :*1234
 *   TRANSACCION CONTACTLESS EN <COMERCIO>, <POBLACION> ES, TARJ. :*1234
 *   COMPRA <COMERCIO>, <REF/POBLACION>, TARJETA 1234… , COMISION 0,00
 *   BIZUM DE|A <PERSONA> CONCEPTO <TEXTO>
 *   TRANSFERENCIA [INMEDIATA] DE|A <PERSONA>, CONCEPTO <TEXTO>
 *   LIQUIDACION DEL CONTRATO …
 * El comercio viene recortado (unos 17 caracteres): "CARREF MANRESA". Por eso
 * se compara con el mismo criterio flexible que Google Places.
 */

const { nombreCoincide } = require('./lugares');

const limpio = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const titulo = (s) => limpio(s).toLowerCase().replace(/(^|[\s\-/.(])\S/g, (m) => m.toUpperCase());

/** Un concepto del banco -> { clase, comercio, poblacion, persona, nota }. */
function parsearConcepto(concepto) {
    const c = limpio(concepto);
    const may = c.toUpperCase();
    let m;

    if ((m = c.match(/^BIZUM (DE|A)\s+(.*?)(?:\s+CONCEPTO\s+(.*))?$/i))) {
        return { clase: m[1].toUpperCase() === 'DE' ? 'bizum_recibido' : 'bizum_enviado', comercio: null,
                 poblacion: null, persona: titulo(m[2]), nota: m[3] ? limpio(m[3]) : null };
    }
    if ((m = c.match(/^TRANSFERENCIA(?: INMEDIATA)? (DE|A)\s+([^,]*?)(?:,\s*CONCEPTO\s+(.*))?$/i))) {
        return { clase: m[1].toUpperCase() === 'DE' ? 'transferencia_recibida' : 'transferencia_enviada', comercio: null,
                 poblacion: null, persona: titulo(m[2]), nota: m[3] ? limpio(m[3]) : null };
    }
    // Anulaciones y retrocesos: deshacen otro apunte, no son gasto ni ingreso.
    if (/^(ANUL|RETROCES|DEVOLUCION)/.test(may.normalize('NFD').replace(/[\u0300-\u036f]/g, ''))) {
        return { clase: 'devolucion', comercio: null, poblacion: null, persona: null, nota: c };
    }
    if (/^LIQUIDACION/.test(may)) return { clase: 'comision', comercio: null, poblacion: null, persona: null, nota: c };
    if (/^RECIBO|^ADEUDO|DOMICILIA/.test(may)) {
        const resto = c.replace(/^(RECIBO|ADEUDO)( DE| RECIBO)?\s*/i, '');
        return { clase: 'recibo', comercio: titulo(resto.split(/,|\s+REF/i)[0]), poblacion: null, persona: null, nota: null };
    }
    // Tarjeta, forma 1: "... EN <COMERCIO>, <POBLACION> ES, TARJ. :*1234". En
    // los extractos antiguos la población viene recortada y pegada al país
    // ("ALCALA DE HENES") o con otra coma por medio ("ROGES SUMA, PERE III,
    // PASES"): el comercio es lo de antes de la primera coma y el resto, el sitio.
    if ((m = c.match(/^(?:PAGO MOVIL|COMPRA INTERNET|COMPRA|TRANSACCION CONTACTLESS|DEVOLUCION COMPRA)\s+EN\s+([^,]+),\s*(.+?),\s*TARJ/i))) {
        let poblacion = limpio(m[2]).split(',').pop().trim();
        if (/\s[A-Z]{2}$/i.test(poblacion)) poblacion = poblacion.replace(/\s+[A-Z]{2}$/i, '');
        else if (poblacion.length >= 13 && /ES$/i.test(poblacion)) poblacion = poblacion.slice(0, -2);
        return { clase: /^DEVOLUCION/i.test(c) ? 'devolucion' : 'tarjeta', comercio: titulo(m[1]),
                 poblacion: titulo(poblacion), persona: null, nota: null };
    }
    // Tarjeta, forma 2 (internet y extranjero): "COMPRA <COMERCIO>, <REF>, TARJETA ..."
    if ((m = c.match(/^COMPRA\s+(.+?),\s*([^,]*),\s*TARJETA/i))) {
        let comercio = m[1].replace(/^PAYPAL\s*\*/i, '').replace(/\*.*$/, '').replace(/^WWW\./i, '');
        const ref = limpio(m[2]);
        return { clase: 'tarjeta', comercio: titulo(comercio),
                 poblacion: /\d{5,}|\d{3}-/.test(ref) || ref.length < 3 ? null : titulo(ref), persona: null,
                 nota: /^PAYPAL/i.test(m[1]) ? 'PayPal' : null };
    }
    return { clase: 'otro', comercio: null, poblacion: null, persona: null, nota: c || null };
}

// --- CRUCE CON LOS TIQUETS ---------------------------------------------------------

const DIAS_ANTES = 5;   // el cargo llega después de la compra (o el mismo día)
const DIAS_DESPUES = 1;

/**
 * Enlaza cada cargo con tarjeta sin tiquet con el tiquet que le corresponde.
 * `tiquets(desde, hasta)` devuelve los candidatos de la base de tiquets.
 * Solo se enlaza cuando no hay duda; lo dudoso se queda para elegir a mano.
 */
function cruzar(bancoDb, tiquetsEnRango) {
    const ocupados = new Set(bancoDb.prepare('SELECT tiquet_id FROM movimientos WHERE tiquet_id IS NOT NULL')
        .all().map(f => f.tiquet_id));
    const pendientes = bancoDb.prepare(`
        SELECT id, fecha, importe_centimos, comercio, poblacion FROM movimientos
        WHERE tiquet_id IS NULL AND COALESCE(enlace, '') <> 'descartado'
          AND clase = 'tarjeta' AND importe_centimos < 0
    `).all();
    const enlazar = bancoDb.prepare(`UPDATE movimientos SET tiquet_id = ?, enlace = 'auto' WHERE id = ?`);
    let enlazados = 0;

    for (const m of pendientes) {
        const f = new Date(`${m.fecha}T12:00:00Z`);
        const desde = new Date(f.getTime() - DIAS_ANTES * 86400e3).toISOString().slice(0, 10);
        const hasta = new Date(f.getTime() + DIAS_DESPUES * 86400e3).toISOString().slice(0, 10);
        const importe = -m.importe_centimos;
        const candidatos = tiquetsEnRango(desde, hasta).filter(t => !ocupados.has(t.id) && (
            t.total_centimos === importe ||
            // Compra en otra moneda: el banco cobra el cambio con su comisión.
            (t.total_eur_centimos && Math.abs(t.total_eur_centimos - importe) <= Math.max(30, importe * 0.03))
        ));
        if (!candidatos.length) continue;

        const porNombre = candidatos.filter(t => [t.nombre, t.google_nombre, ...(t.alias || [])]
            .filter(Boolean).some(n => nombreCoincide(m.comercio || '', n)));
        let elegido = null;
        if (porNombre.length === 1) elegido = porNombre[0];
        else if (porNombre.length === 0 && candidatos.length === 1 && candidatos[0].total_centimos === importe) {
            // Mismo importe exacto y es el único tiquet en esos días: casi seguro
            // el mismo, aunque el banco escriba el comercio de otra forma. Si no
            // se enlaza, ese gasto contaría DOS veces (tiquet y cargo).
            elegido = candidatos[0];
        }
        if (elegido) {
            enlazar.run(elegido.id, m.id);
            ocupados.add(elegido.id);
            enlazados += 1;
        }
    }
    return enlazados;
}

// --- SUSCRIPCIONES Y RECIBOS ---------------------------------------------------------

/** La clave para agrupar cargos del mismo comercio: sin números ni ruido. */
const claveComercio = (s) => limpio(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim().split(' ').slice(0, 2).join(' ');

/**
 * Cargos que se repiten con un ritmo (mensual, trimestral, anual) y un importe
 * parecido. Con tres meses de historia, dos cargos mensuales ya cuentan; los
 * anuales aparecerán cuando haya un año de datos.
 */
function detectarSuscripciones(movimientos, hoy = new Date()) {
    const grupos = new Map();
    for (const m of movimientos) {
        if (m.importe_centimos >= 0 || !['tarjeta', 'recibo'].includes(m.clase) || !m.comercio) continue;
        const clave = claveComercio(m.comercio);
        if (!clave) continue;
        if (!grupos.has(clave)) grupos.set(clave, []);
        grupos.get(clave).push(m);
    }

    const RITMOS = [
        { nombre: 'mensual', dias: 30.4, tolerancia: 6 },
        { nombre: 'trimestral', dias: 91, tolerancia: 12 },
        { nombre: 'anual', dias: 365, tolerancia: 20 }
    ];
    const resultado = [];
    for (const lista of grupos.values()) {
        if (lista.length < 2) continue;
        lista.sort((a, b) => a.fecha.localeCompare(b.fecha));
        const intervalos = lista.slice(1).map((m, i) =>
            (new Date(m.fecha) - new Date(lista[i].fecha)) / 86400e3);
        const ritmo = RITMOS.find(r => intervalos.every(d => Math.abs(d - r.dias) <= r.tolerancia));
        if (!ritmo) continue;
        const importes = lista.map(m => -m.importe_centimos);
        const medio = Math.round(importes.reduce((a, b) => a + b, 0) / importes.length);
        // Importe estable: la luz varía, Netflix no. Hasta un 25 % se admite.
        if (importes.some(i => Math.abs(i - medio) > medio * 0.25)) continue;
        const ultimo = lista[lista.length - 1];
        const proximo = new Date(new Date(ultimo.fecha).getTime() + ritmo.dias * 86400e3);
        resultado.push({
            comercio: ultimo.comercio,
            nombre: ultimo.nombre || ultimo.comercio,
            ritmo: ritmo.nombre,
            importe_centimos: -ultimo.importe_centimos,
            importe_medio_centimos: medio,
            subida: importes.length > 1 && importes[importes.length - 1] > importes[importes.length - 2],
            cargos: lista.length,
            ultimo: ultimo.fecha,
            proximo: proximo.toISOString().slice(0, 10),
            // Más de un ciclo y medio sin cargo: probablemente dada de baja.
            activa: (hoy - new Date(ultimo.fecha)) / 86400e3 < ritmo.dias * 1.5,
            mensual_centimos: Math.round(medio * 30.4 / ritmo.dias)
        });
    }
    return resultado.sort((a, b) => b.mensual_centimos - a.mensual_centimos);
}

module.exports = { parsearConcepto, cruzar, detectarSuscripciones, claveComercio, nombreCoincide };
