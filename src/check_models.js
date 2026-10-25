// src/check_models.js
//
// Lista los modelos que la clave tiene habilitados, con sus límites de tokens.
// El outputTokenLimit es el dato que hace falta para poner GEMINI_MAX_OUTPUT_TOKENS
// en el .env sin provocar un 400: ese tope se comparte con los tokens de
// razonamiento del modelo, y una foto con varios tiquets lo necesita entero.
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

// La lectura de GEMINI_MODELOS vive en ai_service: una sola definición de qué
// cuenta como lista de modelos, para que esta utilidad no diga una cosa y la
// aplicación haga otra.
const { leerModelos } = require('./services/ai_service.js');

/** 65536 -> "65.536", para que se lea de un golpe. */
const conMiles = (n) =>
    typeof n === 'number' ? n.toLocaleString('es-ES') : '¿?';

/** Alinea a la derecha en un ancho fijo, para que las columnas cuadren. */
const aDerecha = (texto, ancho) => String(texto).padStart(ancho, ' ');

async function listarModelosDisponibles() {
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
        console.error("❌ Error: No se ha leído la API KEY.");
        return;
    }

    console.log("📡 Preguntando a Google qué modelos tienes habilitados...");

    // Hacemos una petición directa a la API REST de Google.
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;

    try {
        const response = await fetch(url);
        const data = await response.json();

        if (data.error) {
            console.error("❌ ERROR DE GOOGLE:", data.error.message);
            console.error("👉 Causa probable:", data.error.status);
            return;
        }

        if (!data.models || data.models.length === 0) {
            console.log("⚠️ TU CLAVE FUNCIONA, PERO LA LISTA DE MODELOS ESTÁ VACÍA.");
            console.log("👉 Esto significa que no has activado la API en tu proyecto de Google Cloud.");
            return;
        }

        // Solo los que sirven para generar contenido: el resto (embeddings,
        // recuento de tokens) no nos vale para leer tiquets.
        const utiles = data.models.filter(m =>
            Array.isArray(m.supportedGenerationMethods) &&
            m.supportedGenerationMethods.includes("generateContent")
        );

        if (utiles.length === 0) {
            console.log("⚠️ Hay modelos, pero ninguno admite generateContent.");
            return;
        }

        console.log("\n✅ ¡CONEXIÓN EXITOSA! Estos son los modelos que TU clave puede usar:\n");

        const nombreMasLargo = Math.max(
            ...utiles.map(m => m.name.replace('models/', '').length)
        );

        console.log(
            '   ' + 'MODELO'.padEnd(nombreMasLargo, ' ') +
            '  ' + aDerecha('ENTRADA', 12) +
            '  ' + aDerecha('SALIDA', 10)
        );
        console.log('   ' + '-'.repeat(nombreMasLargo + 26));

        for (const model of utiles) {
            const nombre = model.name.replace('models/', '');
            console.log(
                '🔹 ' + nombre.padEnd(nombreMasLargo, ' ') +
                '  ' + aDerecha(conMiles(model.inputTokenLimit), 12) +
                '  ' + aDerecha(conMiles(model.outputTokenLimit), 10)
            );
        }

        // Los modelos configurados ahora mismo, señalados aparte. Son una LISTA
        // ordenada (GEMINI_MODELOS), así que se repasan todos: el techo que vale
        // para GEMINI_MAX_OUTPUT_TOKENS es el MÁS BAJO de la lista, porque ese
        // valor se manda en todas las llamadas y la cascada puede acabar en
        // cualquiera de ellos.
        const configurados = leerModelos();

        console.log('\n📐 ENTRADA = inputTokenLimit (lo que le caben de foto + prompt).');
        console.log('   SALIDA  = outputTokenLimit, el techo de GEMINI_MAX_OUTPUT_TOKENS.');

        if (configurados.length === 0) {
            console.log(
                '\n💡 No tienes ningún modelo configurado. Copia uno o varios nombres de arriba,\n' +
                '   del preferido al de respaldo, y ponlos en GEMINI_MODELOS:\n\n' +
                '       GEMINI_MODELOS=modelo-bueno,modelo-barato\n'
            );
            return;
        }

        console.log(`\n👉 Tu GEMINI_MODELOS, en orden (${configurados.length}):`);

        const limites = [];
        configurados.forEach((nombre, i) => {
            const encontrado = utiles.find(
                m => m.name.replace('models/', '') === nombre.replace('models/', '')
            );
            const papel = i === 0
                ? 'preferido'
                : (i === configurados.length - 1 ? 'último, el de "Rápido"' : 'respaldo');

            if (encontrado) {
                limites.push(encontrado.outputTokenLimit);
                console.log(
                    `   ${i + 1}. ${nombre}  (${papel}) — salida hasta ` +
                    `${conMiles(encontrado.outputTokenLimit)} tokens`
                );
            } else {
                console.log(
                    `   ${i + 1}. ${nombre}  (${papel}) — ⚠️  NO aparece en esta lista: tu clave ` +
                    `no puede usarlo.\n      La cascada lo saltará con un 404 y perderá un intento ` +
                    `en cada foto.`
                );
            }
        });

        if (limites.length > 0) {
            console.log(
                `\n   Pon GEMINI_MAX_OUTPUT_TOKENS a ${conMiles(Math.min(...limites))} o menos: es ` +
                `el techo del más\n   justo de tus modelos, y ese valor se manda en todas las ` +
                `llamadas. Por encima, la API responde 400.`
            );
        }

    } catch (error) {
        console.error("❌ Error de red:", error);
    }
}

listarModelosDisponibles();
