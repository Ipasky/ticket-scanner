'use strict';

/**
 * Reglas fijas de categoría que valen igual para tiquets y movimientos del banco.
 *
 * bonÀrea: en sus gasolineras se pide un importe redondo ("35 €", "50 €"); en la
 * tienda casi nunca sale una cuenta exacta. Un pago en bonÀrea de euros justos
 * es gasolina: TRANSPORTE, no ALIMENTACION.
 */
const ES_BONAREA = /bon\s*[aà]rea/i;

/** La categoría que impone una regla, o null si ninguna aplica. */
function categoriaPorRegla(nombre, centimos) {
    const c = Math.abs(Number(centimos));
    if (ES_BONAREA.test(String(nombre || '')) && Number.isInteger(c) && c > 0 && c % 100 === 0) return 'TRANSPORTE';
    return null;
}

module.exports = { categoriaPorRegla, ES_BONAREA };
