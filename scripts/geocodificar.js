#!/usr/bin/env node
/**
 * Geocodifica de una vez todos los establecimientos pendientes.
 *
 *     npm run geocodificar
 *
 * El servidor ya lo hace solo en segundo plano, pero este script sirve para dos
 * cosas que el servidor no cubre: poblar de golpe un histórico que ya existía
 * antes de que hubiera geocodificación, y volver a intentarlo cuando Nominatim
 * ha estado caído y los pendientes se han quedado a medias.
 *
 * Va a UNA petición por segundo, que es lo que permite la política de uso de
 * Nominatim, así que con muchos establecimientos esto tarda: 300 sitios son
 * cinco minutos. Se puede dejar corriendo y parar con Ctrl+C sin romper nada —lo
 * ya resuelto queda guardado— y volver a lanzarlo luego: lo que esté en 'ok' no
 * se vuelve a preguntar.
 */
// El .env, por ruta ABSOLUTA y antes de cargar el servicio. Sin esto, dotenv
// busca el .env en el directorio desde el que se lanza node: funcionaba por
// casualidad al ejecutarlo en la raíz del proyecto y fallaba desde cualquier
// otro sitio diciendo que falta NOMINATIM_USER_AGENT aunque esté definida. Es el
// mismo patrón que src/check_models.js y services/ai_service.js.
const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const geo = require('../src/services/geocodificacion.js');

const ESPERA_AVISO_MS = 1100;   // lo mismo que el servicio, para estimar

async function principal() {
    const config = geo.leerConfiguracion();

    if (!config.activa) {
        console.error(`
❌ La geocodificación está desactivada: falta NOMINATIM_USER_AGENT en el .env.

   Nominatim exige que cada cliente se identifique, y mandar peticiones
   anónimas es la forma más rápida de que bloqueen tu IP. Pon algo que diga
   qué es esto y cómo contactarte:

       NOMINATIM_USER_AGENT=ticket-scanner/1.0 (tu-correo@ejemplo.tld)
`);
        process.exit(1);
    }

    const repasables = geo.contarRepasables();
    const revisables = geo.contarRevisablesCp();

    if (repasables === 0 && revisables === 0) {
        console.log('✅ No hay nada pendiente de geocodificar ni de revisar.');
        return;
    }

    const minutos = (cuantos) => Math.ceil((cuantos * ESPERA_AVISO_MS) / 60000);

    if (repasables > 0) {
        console.log(`
🗺️  Geocodificando ${repasables} establecimiento(s) contra ${config.url}
   a una petición por segundo: esto va a tardar unos ${minutos(repasables)} minuto(s).
   Puedes pararlo con Ctrl+C; lo ya resuelto queda guardado.
`);

        // incluirFallidos: el script repasa también los que fallaron o se quedaron
        // sin datos. La búsqueda es escalonada desde hace poco y encuentra cosas que
        // antes no: un "Miami Platja" que no existía para Nominatim ahora cae por
        // código postal. La cola normal NO los repasa, para no reintentar en bucle.
        const resultado = await geo.geocodificarPendientes({ limite: repasables, incluirFallidos: true });

        console.log(`
✅ Terminado. Se han intentado ${resultado.encolados} y quedan ${resultado.pendientes} pendiente(s).
   Los que quedan son los que no se han podido preguntar (red o Nominatim caído):
   vuelve a lanzarlo más tarde. Los que no se encuentran en ninguna etapa quedan
   'fallido' y el servidor no los reintenta solo; este script sí los repasa, que
   es justo para lo que sirve cuando mejora la búsqueda.
`);
    }

    // SEGUNDA FASE: los que ya tienen punto fino, pero se situaron antes de que
    // se comprobara el código postal del resultado. Nominatim contesta con lo más
    // parecido que encuentra, y un 28490 resuelto en Madrid capital quedó
    // guardado como 'exacta'. Volver a preguntar es la única forma de saberlo:
    // el código postal del resultado no se guardó entonces.
    if (revisables > 0) {
        console.log(`
🗺️  Revisando el código postal de ${revisables} establecimiento(s) ya situados
   (unos ${minutos(revisables)} minuto(s) más). Los que no cuadren se quedan con
   su punto, pero marcados como ubicación dudosa en vez de exacta.
`);
        const revision = await geo.revisarCodigosPostales({ limite: revisables });
        const dudosos = geo.contarDiscrepantes();

        console.log(`
✅ Revisados ${revision.encolados}. Ahora hay ${dudosos} con ubicación dudosa:
   salen en el mapa como aproximados y el editor explica por qué. Si alguno es
   correcto, pega las coordenadas a mano y quedará fijado como 'manual'.
`);
    }
}

principal().catch((error) => {
    // Que un fallo aquí no deje un proceso a medias sin explicación: lo que se
    // haya guardado ya está en la base, y lo demás sigue pendiente.
    console.error('❌ La geocodificación ha fallado:', error && error.message);
    process.exit(1);
});
