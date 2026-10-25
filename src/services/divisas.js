'use strict';

/**
 * Conversión a euros de las compras hechas en otra moneda.
 *
 * El importe original no se toca nunca: es lo que dice el papel. Al lado se
 * guarda su equivalente en euros (total_eur_centimos) con el tipo de cambio del
 * DÍA DE LA COMPRA, que es lo que de verdad costó. Las estadísticas suman ese
 * equivalente, así que un viaje a Londres cuenta en el gasto del mes como
 * cualquier otra compra.
 *
 * Los tipos salen del Banco Central Europeo a través de Frankfurter
 * (https://frankfurter.dev): gratis, sin clave y sin registro. Cada par
 * día+moneda se pregunta UNA vez y se guarda en la tabla tasas_cambio.
 *
 * Funciona en segundo plano, como la geocodificación: nunca bloquea una subida.
 * Sin red, la compra sigue en su moneda y se convierte en el siguiente intento.
 */

const db = require('../config/db');

const URL_BASE = String(process.env.DIVISAS_URL || 'https://api.frankfurter.dev/v2').replace(/\/+$/, '');

const STMT_PENDIENTES = db.prepare(`
    SELECT id, total_centimos,
           UPPER(TRIM(moneda))        AS moneda,
           substr(fecha_compra, 1, 10) AS dia
    FROM tickets
    WHERE total_eur_centimos IS NULL
      AND total_centimos IS NOT NULL
      AND moneda IS NOT NULL AND TRIM(moneda) <> ''
      AND UPPER(TRIM(moneda)) <> 'EUR'
      AND estado IN ('procesado', 'incompleto')
    LIMIT 500
`);
const STMT_TASA         = db.prepare('SELECT tasa FROM tasas_cambio WHERE fecha = ? AND moneda = ?');
const STMT_GUARDAR_TASA = db.prepare('INSERT OR REPLACE INTO tasas_cambio (fecha, moneda, tasa) VALUES (?, ?, ?)');
const STMT_CONVERTIR    = db.prepare('UPDATE tickets SET total_eur_centimos = @eur, tasa_eur = @tasa WHERE id = @id');

// Monedas que el servicio no conoce (o una fecha sin cambio): no se vuelven a
// preguntar en esta ejecución. Se reintentan al reiniciar.
const sinRespuesta = new Set();

let iniciado = false;
let enCurso = false;
let temporizador = null;

const hoy = () => new Date().toISOString().slice(0, 10);

/** El cambio de 1 unidad de `moneda` a euros el día `dia`, o null. */
async function tasaDe(dia, moneda) {
    const fecha = /^\d{4}-\d{2}-\d{2}$/.test(dia || '') && dia <= hoy() ? dia : null;
    if (fecha) {
        const guardada = STMT_TASA.get(fecha, moneda);
        if (guardada) return guardada.tasa;
    }
    const clave = `${fecha || 'hoy'}|${moneda}`;
    if (sinRespuesta.has(clave)) return null;

    const url = `${URL_BASE}/rate/${encodeURIComponent(moneda.toLowerCase())}/eur` +
                (fecha ? `?date=${fecha}` : '');
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) {
        // 4xx: moneda o fecha que no tiene; 5xx: el servicio, que se reintenta.
        if (res.status < 500) sinRespuesta.add(clave);
        return null;
    }
    const json = await res.json().catch(() => null);
    const tasa = Number(json && (json.rate ?? (json.rates && json.rates.EUR)));
    if (!Number.isFinite(tasa) || tasa <= 0) { sinRespuesta.add(clave); return null; }

    if (fecha) STMT_GUARDAR_TASA.run(fecha, moneda, tasa);
    return tasa;
}

/** Convierte todo lo pendiente. Nunca lanza. */
async function convertirPendientes() {
    if (enCurso) return { convertidos: 0, sin_convertir: 0 };
    enCurso = true;
    let convertidos = 0, sinConvertir = 0;
    try {
        for (const t of STMT_PENDIENTES.all()) {
            let tasa;
            try {
                tasa = await tasaDe(t.dia, t.moneda);
            } catch (err) {
                // Sin red: no tiene sentido seguir preguntando ahora.
                console.warn(`💱 Sin conexión con el servicio de cambio (${err.message}). Se reintentará.`);
                break;
            }
            if (!tasa) { sinConvertir += 1; continue; }
            STMT_CONVERTIR.run({ id: t.id, eur: Math.round(t.total_centimos * tasa), tasa });
            convertidos += 1;
        }
    } catch (err) {
        console.error('💱 Error convirtiendo divisas:', err);
    } finally {
        enCurso = false;
    }
    if (convertidos) console.log(`💱 ${convertidos} compra(s) en otra moneda convertida(s) a euros.`);
    return { convertidos, sin_convertir: sinConvertir };
}

/** Al arrancar el servidor: lo pendiente ahora y un repaso cada 6 horas. */
function arrancar() {
    iniciado = true;
    convertirPendientes();
    const repaso = setInterval(convertirPendientes, 6 * 3600 * 1000);
    if (repaso.unref) repaso.unref();
}

/**
 * Tras guardar algo. Solo actúa si el servidor arrancó el servicio: las pruebas
 * importan la app sin arrancarlo y no deben mandar tráfico a ningún sitio.
 */
function avisar() {
    if (!iniciado) return;
    clearTimeout(temporizador);
    temporizador = setTimeout(convertirPendientes, 1500);
    if (temporizador.unref) temporizador.unref();
}

module.exports = { arrancar, avisar, convertirPendientes };
