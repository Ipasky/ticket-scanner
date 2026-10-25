/**
 * Detección de respuesta truncada.
 *
 * Es la parte del servicio de IA que no se puede verificar llamando a la API de
 * verdad: haría falta una foto con veinte tiquets y una factura de Google. Lo que
 * sí se puede probar es la decisión a partir del finishReason que devuelve el SDK.
 *
 * Se fija una clave de pega ANTES de cargar el módulo: dotenv no sobreescribe lo
 * que ya está en el entorno, así que la prueba no depende del .env de nadie y no
 * llega a hacer ninguna petición.
 */
process.env.GEMINI_API_KEY = 'clave-de-pega-para-pruebas';

const test = require('node:test');
const assert = require('node:assert/strict');

const { comprobarRespuestaCompleta, MAX_OUTPUT_TOKENS, ErrorIA } =
    require('../src/services/ai_service.js');

const respuesta = (finishReason, extra = {}) => ({
    candidates: [{ finishReason }],
    ...extra
});

test('una respuesta que termina en STOP pasa sin más', () => {
    assert.doesNotThrow(() => comprobarRespuestaCompleta(respuesta('STOP')));
});

test('sin finishReason no se afirma que esté cortada', () => {
    // Algunos caminos del SDK no lo rellenan. Si el JSON está roto lo recogerá el
    // parseo; lo que no se puede es inventarse una truncación.
    assert.doesNotThrow(() => comprobarRespuestaCompleta(respuesta(undefined)));
    assert.doesNotThrow(() => comprobarRespuestaCompleta({}));
    assert.doesNotThrow(() => comprobarRespuestaCompleta({ candidates: [] }));
});

test('MAX_TOKENS: error claro de "demasiados tiquets", sin intentar parsear', () => {
    let lanzado = null;
    try {
        comprobarRespuestaCompleta(respuesta('MAX_TOKENS'));
    } catch (err) {
        lanzado = err;
    }

    assert.ok(lanzado, 'tenía que lanzar');
    assert.ok(lanzado instanceof ErrorIA);
    assert.equal(lanzado.tipo, 'truncado');
    assert.match(lanzado.mensaje, /demasiados\s+tiquets/);
    assert.match(lanzado.mensaje, /Sepárala en varias fotos/);
});

test('SAFETY y los demás bloqueos también cortan antes del parseo', () => {
    for (const motivo of ['SAFETY', 'RECITATION', 'PROHIBITED_CONTENT', 'BLOCKLIST']) {
        assert.throws(
            () => comprobarRespuestaCompleta(respuesta(motivo)),
            (err) => err.tipo === 'truncado' && typeof err.mensaje === 'string' && err.mensaje.length > 20,
            `${motivo} debería lanzar un ErrorIA de tipo truncado`
        );
    }
});

test('un finishReason desconocido también se trata como respuesta incompleta', () => {
    assert.throws(
        () => comprobarRespuestaCompleta(respuesta('ALGO_NUEVO')),
        (err) => err.tipo === 'truncado' && /ALGO_NUEVO/.test(err.mensaje)
    );
});

test('un blockReason en promptFeedback se detecta aunque el candidato diga STOP', () => {
    assert.throws(
        () => comprobarRespuestaCompleta(respuesta('STOP', { promptFeedback: { blockReason: 'SAFETY' } })),
        (err) => err.tipo === 'truncado'
    );
});

test('el presupuesto de tokens de salida ya no es el 8192 que desbordaba', () => {
    // El presupuesto se comparte con los tokens de razonamiento del modelo, así que
    // varios tiquets con sus líneas de producto no caben en 8192.
    assert.ok(Number.isInteger(MAX_OUTPUT_TOKENS));
    assert.ok(MAX_OUTPUT_TOKENS > 8192, `esperaba más de 8192, es ${MAX_OUTPUT_TOKENS}`);
});
