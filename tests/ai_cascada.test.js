/**
 * Cascada de modelos: reintentar, saltar al siguiente, o rendirse.
 *
 * Es lógica de DECISIÓN, y comprobarla contra la API de verdad exigiría provocar
 * un 429 real de Google y esperar a que se renueve la cuota. Por eso
 * `crearAnalizador` admite un generador inyectado: se le dan los fallos que
 * interesan, en el orden que interesa, y se comprueba a qué modelo llama después.
 *
 * `dormir` también se inyecta: sin eso, cada 503 costaría los 1+2 segundos de
 * espera entre reintentos y la prueba tardaría más que todo el resto junto.
 *
 * La clave de pega se fija ANTES de cargar el módulo: dotenv no sobreescribe lo
 * que ya está en el entorno, así que la prueba no depende del .env de nadie y no
 * llega a hacer ninguna petición.
 */
process.env.GEMINI_API_KEY = 'clave-de-pega-para-pruebas';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    crearAnalizador,
    crearGestorDeArchivos,
    clasificarError,
    leerModelos,
    resolverModelos,
    configuracionPublica,
    MAX_INTENTOS,
    MODOS,
    TOPE_INCRUSTADO_BYTES,
    TOPE_FILES_API_BYTES
} = require('../src/services/ai_service.js');

const BUENO  = 'gemini-bueno';
const MEDIO  = 'gemini-medio';
const BARATO = 'gemini-barato';
const LOS_TRES = [BUENO, MEDIO, BARATO];

const TIQUETS = [{ tipo_documento: 'COMPRA', total_centimos: 1234 }];

/** Respuesta válida del SDK: terminada y con JSON parseable. */
const respuestaOk = (tiquets = TIQUETS) => ({
    candidates: [{ finishReason: 'STOP' }],
    text: JSON.stringify(tiquets)
});

/** Un error de la API tal y como llega: el status va en la propia excepción. */
const errorApi = (status) =>
    Object.assign(new Error(`la API ha respondido ${status}`), { status });

/**
 * Generador de pega. `guion` dice qué hace cada modelo: un número es el status
 * con el que falla siempre, 'ok' es una respuesta buena. Registra cada llamada
 * para poder afirmar a quién se llamó, en qué orden y cuántas veces.
 */
function generadorDePega(guion) {
    const llamadas = [];
    const generar = async (modelo) => {
        llamadas.push(modelo);
        const papel = guion[modelo];
        if (papel === 'ok' || papel === undefined) return respuestaOk();
        throw errorApi(papel);
    };
    return { generar, llamadas };
}

/** Analizador con el guion dado, sin esperas reales. */
function analizadorCon(guion, modelos = LOS_TRES) {
    const { generar, llamadas } = generadorDePega(guion);
    const analizar = crearAnalizador({ generar, modelos, dormir: async () => {} });
    return { analizar, llamadas };
}

const imagen = Buffer.from('no-es-una-imagen-de-verdad');
const correr = (analizar, opciones) => analizar(imagen, 'image/jpeg', opciones);

/** Cuántas veces se llamó a cada modelo, en orden de primera aparición. */
function conteo(llamadas) {
    const mapa = new Map();
    for (const m of llamadas) mapa.set(m, (mapa.get(m) || 0) + 1);
    return [...mapa.entries()];
}

// =============================================================================
// SALTO POR TRANSITORIO (503): PRIMERO SE AGOTAN LOS REINTENTOS
// =============================================================================

test('503: agota los reintentos del modelo y entonces salta al siguiente', async () => {
    const { analizar, llamadas } = analizadorCon({ [BUENO]: 503, [MEDIO]: 'ok' });

    const salida = await correr(analizar);

    // El modelo preferido no se abandona a la primera: la saturación es temporal
    // y esperar es más barato que renunciar a la calidad que se ha pedido.
    assert.deepEqual(conteo(llamadas), [[BUENO, MAX_INTENTOS], [MEDIO, 1]]);
    assert.equal(salida.modelo, MEDIO);
    assert.deepEqual(salida.tiquets, TIQUETS);
    // El recorrido queda registrado: tres fallos del primero.
    assert.equal(salida.intentos.length, MAX_INTENTOS);
    assert.ok(salida.intentos.every(i => i.modelo === BUENO && i.tipo === 'transitorio'));
});

test('500 se trata igual que 503: es la otra cara del fallo temporal', async () => {
    const { analizar, llamadas } = analizadorCon({ [BUENO]: 500, [MEDIO]: 'ok' });

    assert.equal((await correr(analizar)).modelo, MEDIO);
    assert.deepEqual(conteo(llamadas), [[BUENO, MAX_INTENTOS], [MEDIO, 1]]);
});

// =============================================================================
// SALTO INMEDIATO POR CUOTA (429)
// =============================================================================

test('429: salta al siguiente modelo SIN reintentar', async () => {
    const { analizar, llamadas } = analizadorCon({ [BUENO]: 429, [MEDIO]: 'ok' });

    const salida = await correr(analizar);

    // Una sola llamada al modelo sin cuota. Insistir no la recupera: no se
    // renueva en segundos, y cada reintento gasta una petición más.
    assert.deepEqual(conteo(llamadas), [[BUENO, 1], [MEDIO, 1]]);
    assert.equal(salida.modelo, MEDIO);
    assert.equal(salida.intentos.length, 1);
    assert.equal(salida.intentos[0].tipo, 'cuota');
});

test('429 en cadena: baja por la lista una vez por modelo', async () => {
    const { analizar, llamadas } = analizadorCon({
        [BUENO]: 429, [MEDIO]: 429, [BARATO]: 'ok'
    });

    assert.equal((await correr(analizar)).modelo, BARATO);
    assert.deepEqual(llamadas, [BUENO, MEDIO, BARATO], 'una llamada por modelo, en orden');
});

// =============================================================================
// SALTO POR MODELO INEXISTENTE (404)
// =============================================================================

test('404: salta al siguiente y el mensaje nombra al modelo que no existe', async () => {
    const { analizar, llamadas } = analizadorCon({ [BUENO]: 404, [MEDIO]: 'ok' });

    const salida = await correr(analizar);

    assert.deepEqual(conteo(llamadas), [[BUENO, 1], [MEDIO, 1]], 'tampoco se reintenta');
    assert.equal(salida.modelo, MEDIO);
    assert.equal(salida.intentos[0].tipo, 'modelo');
    // El nombre tiene que ser el del intento, no el de la variable de entorno:
    // con una lista, señalar a GEMINI_MODELOS entero no dice qué arreglar.
    assert.match(salida.intentos[0].mensaje, new RegExp(`"${BUENO}"`));
    assert.match(salida.intentos[0].mensaje, /no existe o no está disponible/);
});

// =============================================================================
// SIN SALTO: EL PROBLEMA NO ES EL MODELO
// =============================================================================

test('401 de autenticación: NO salta, falla a la primera', async () => {
    // La clave es la misma para todos los modelos: probar el siguiente sería
    // repetir el mismo fallo y tardar tres veces más en decir la verdad.
    const { analizar, llamadas } = analizadorCon({ [BUENO]: 401, [MEDIO]: 'ok' });

    await assert.rejects(correr(analizar), (error) => {
        assert.equal(error.name, 'ErrorIA');
        assert.equal(error.tipo, 'autenticacion');
        assert.equal(error.status, 401);
        assert.match(error.mensaje, /GEMINI_API_KEY/);
        // Y como solo se ha tocado un modelo, el mensaje NO se adorna con el
        // recorrido: no hay recorrido que contar.
        assert.doesNotMatch(error.mensaje, /Se han probado/);
        return true;
    });

    assert.deepEqual(llamadas, [BUENO], 'ni un intento más');
});

test('403 de permisos: tampoco salta', async () => {
    const { analizar, llamadas } = analizadorCon({ [BUENO]: 403, [MEDIO]: 'ok' });

    await assert.rejects(correr(analizar), { tipo: 'autenticacion', status: 403 });
    assert.deepEqual(llamadas, [BUENO]);
});

test('un error permanente no se reintenta ni se salta', async () => {
    const { analizar, llamadas } = analizadorCon({ [BUENO]: 418, [MEDIO]: 'ok' });

    await assert.rejects(correr(analizar), { tipo: 'permanente' });
    assert.deepEqual(llamadas, [BUENO]);
});

test('una respuesta truncada no se salta: el problema es la foto, no el modelo', async () => {
    // Volver a pedir lo mismo a otro modelo la truncaría otra vez. Lo que hay que
    // hacer es separar la foto, y eso lo dice el mensaje.
    const generar = async () => ({ candidates: [{ finishReason: 'MAX_TOKENS' }], text: '' });
    const analizar = crearAnalizador({ generar, modelos: LOS_TRES, dormir: async () => {} });

    await assert.rejects(correr(analizar), (error) => {
        assert.equal(error.tipo, 'truncado');
        assert.match(error.mensaje, /demasiados/i);
        return true;
    });
});

// =============================================================================
// AGOTAR TODOS LOS MODELOS
// =============================================================================

test('agotados todos: se propaga el error del ÚLTIMO intento', async () => {
    const { analizar, llamadas } = analizadorCon({
        [BUENO]: 429, [MEDIO]: 404, [BARATO]: 503
    });

    await assert.rejects(correr(analizar), (error) => {
        // El último fue el 503 del modelo barato: es el más reciente y el que
        // describe el estado actual del servicio.
        assert.equal(error.tipo, 'transitorio');
        assert.equal(error.status, 503);
        return true;
    });

    assert.deepEqual(conteo(llamadas), [[BUENO, 1], [MEDIO, 1], [BARATO, MAX_INTENTOS]]);
});

test('agotados todos: el mensaje dice qué modelos se probaron y por qué falló cada uno', async () => {
    const { analizar } = analizadorCon({ [BUENO]: 429, [MEDIO]: 404, [BARATO]: 503 });

    await assert.rejects(correr(analizar), (error) => {
        const m = error.mensaje;
        assert.match(m, /Se han probado 3 modelos/);
        assert.match(m, new RegExp(`${BUENO}: cuota 429`));
        assert.match(m, new RegExp(`${MEDIO}: modelo 404`));
        // Del que se reintentó se cuenta cuántas veces, sin repetirlo tres veces.
        assert.match(m, new RegExp(`${BARATO}: transitorio 503 ×${MAX_INTENTOS}`));
        return true;
    });
});

test('agotados todos por cuota: el tipo sigue siendo cuota y la foto se conserva', async () => {
    // Importa porque el controller decide con .tipo si guarda la imagen como
    // 'pendiente' (reintentable) o como 'error'. Una cascada agotada por cuota es
    // reintentable mañana.
    const { analizar } = analizadorCon({ [BUENO]: 429, [MEDIO]: 429, [BARATO]: 429 });

    await assert.rejects(correr(analizar), { tipo: 'cuota', status: 429 });
});

test('sin ningún modelo configurado: error de configuración, no una llamada a ciegas', async () => {
    const { analizar, llamadas } = analizadorCon({}, []);

    await assert.rejects(correr(analizar), (error) => {
        assert.equal(error.tipo, 'configuracion');
        assert.match(error.mensaje, /GEMINI_MODELOS/);
        return true;
    });
    assert.deepEqual(llamadas, [], 'no se llama a la API sin saber con qué modelo');
});

// =============================================================================
// MODO FORZADO: LA CASCADA SE IGNORA
// =============================================================================

test('modo "mejor": solo el primero. Si falla, falla', async () => {
    const { analizar, llamadas } = analizadorCon({ [BUENO]: 503, [MEDIO]: 'ok' });

    await assert.rejects(correr(analizar, { modo: 'mejor' }), { tipo: 'transitorio' });

    // Se reintenta (la saturación es temporal) pero NO se baja al siguiente:
    // pedir calidad y recibir en silencio la lectura del modelo barato sería lo
    // contrario de lo que se ha pedido.
    assert.deepEqual(conteo(llamadas), [[BUENO, MAX_INTENTOS]]);
});

test('modo "mejor" con el preferido sano: lo usa y no toca los demás', async () => {
    const { analizar, llamadas } = analizadorCon({ [BUENO]: 'ok', [MEDIO]: 'ok' });

    assert.equal((await correr(analizar, { modo: 'mejor' })).modelo, BUENO);
    assert.deepEqual(llamadas, [BUENO]);
});

test('modo "rapido": solo el último de la lista, el más barato', async () => {
    const { analizar, llamadas } = analizadorCon({ [BUENO]: 'ok', [BARATO]: 'ok' });

    const salida = await correr(analizar, { modo: 'rapido' });

    assert.equal(salida.modelo, BARATO);
    assert.deepEqual(llamadas, [BARATO], 'al bueno no se le llama ni para empezar');
});

test('modo "rapido" que falla por cuota: no sube a los buenos', async () => {
    // Saltar hacia arriba sería gastar el modelo caro cuando se ha pedido
    // explícitamente el barato.
    const { analizar, llamadas } = analizadorCon({ [BARATO]: 429, [BUENO]: 'ok' });

    await assert.rejects(correr(analizar, { modo: 'rapido' }), { tipo: 'cuota' });
    assert.deepEqual(llamadas, [BARATO]);
});

test('modo por defecto (sin indicar nada) = automático', async () => {
    const { analizar, llamadas } = analizadorCon({ [BUENO]: 429, [MEDIO]: 'ok' });

    assert.equal((await correr(analizar)).modelo, MEDIO);
    assert.deepEqual(llamadas, [BUENO, MEDIO]);
});

// =============================================================================
// LA LISTA: LECTURA Y COMPATIBILIDAD
// =============================================================================

test('GEMINI_MODELOS: lista ordenada, sin huecos ni repetidos', () => {
    assert.deepEqual(
        leerModelos({ GEMINI_MODELOS: 'a, b ,c' }),
        ['a', 'b', 'c']
    );
    assert.deepEqual(
        leerModelos({ GEMINI_MODELOS: ' a , , b ,' }),
        ['a', 'b'],
        'las entradas vacías se tiran, no cuentan como modelo'
    );
    assert.deepEqual(
        leerModelos({ GEMINI_MODELOS: 'a,b,a' }),
        ['a', 'b'],
        'un nombre repetido no añade respaldo: añade una espera más contra el mismo modelo'
    );
});

test('GEMINI_MODEL (singular) sigue valiendo: un modelo es una lista de uno', () => {
    // Compatibilidad: un .env de antes de esta fase tiene que seguir arrancando.
    assert.deepEqual(leerModelos({ GEMINI_MODEL: 'gemini-flash-latest' }), ['gemini-flash-latest']);
    // Con las dos definidas manda la nueva, que es la específica.
    assert.deepEqual(
        leerModelos({ GEMINI_MODELOS: 'a,b', GEMINI_MODEL: 'viejo' }),
        ['a', 'b']
    );
    assert.deepEqual(leerModelos({}), []);
});

test('con un solo modelo, los tres modos son el mismo', () => {
    // El modo elige entre lo que hay; no inventa modelos que no están.
    for (const modo of MODOS) {
        assert.deepEqual(resolverModelos(modo, ['uno']), ['uno'], `modo ${modo}`);
    }
});

test('con un solo modelo el mensaje de fallo no habla de cascada', async () => {
    const { analizar } = analizadorCon({ [BUENO]: 503 }, [BUENO]);

    await assert.rejects(correr(analizar), (error) => {
        assert.doesNotMatch(error.mensaje, /Se han probado/);
        return true;
    });
});

test('resolverModelos: automático es la lista entera y en orden', () => {
    assert.deepEqual(resolverModelos('automatico', LOS_TRES), LOS_TRES);
    assert.deepEqual(resolverModelos('mejor', LOS_TRES), [BUENO]);
    assert.deepEqual(resolverModelos('rapido', LOS_TRES), [BARATO]);
    assert.deepEqual(resolverModelos('automatico', []), []);
});

// =============================================================================
// CONFIGURACIÓN PARA EL SELECTOR
// =============================================================================

test('las etiquetas del selector salen de la configuración, con el modelo dentro', () => {
    // El HTML no puede llevarlas clavadas: la lista cambia en el .env.
    const cfg = configuracionPublica(LOS_TRES);

    assert.deepEqual(cfg.modelos, LOS_TRES);
    assert.equal(cfg.por_defecto, 'automatico');
    assert.deepEqual(cfg.modos.map(m => m.valor), ['automatico', 'mejor', 'rapido']);

    const mejor  = cfg.modos.find(m => m.valor === 'mejor');
    const rapido = cfg.modos.find(m => m.valor === 'rapido');
    assert.match(mejor.etiqueta, new RegExp(BUENO));
    assert.match(rapido.etiqueta, new RegExp(BARATO));
    assert.deepEqual(mejor.modelos, [BUENO]);
    assert.deepEqual(rapido.modelos, [BARATO]);
});

test('con un solo modelo las etiquetas no se adornan con el nombre', () => {
    // "Mejor (x)" y "Rápido (x)" con el mismo x sería ofrecer tres veces lo mismo
    // pretendiendo que son opciones distintas.
    const cfg = configuracionPublica(['solo-uno']);
    assert.equal(cfg.modos.find(m => m.valor === 'mejor').etiqueta, 'Mejor');
    assert.equal(cfg.modos.find(m => m.valor === 'rapido').etiqueta, 'Rápido');
});

test('sin modelos configurados la configuración no revienta', () => {
    const cfg = configuracionPublica([]);
    assert.deepEqual(cfg.modelos, []);
    assert.equal(cfg.modos.length, 3);
    assert.ok(cfg.modos.every(m => Array.isArray(m.modelos) && m.modelos.length === 0));
});

// =============================================================================
// CLASIFICACIÓN CON EL MODELO DENTRO
// =============================================================================

test('clasificarError nombra el modelo del intento en el 404', () => {
    const e = clasificarError(errorApi(404), 'gemini-inventado');
    assert.equal(e.tipo, 'modelo');
    assert.match(e.mensaje, /"gemini-inventado"/);
});

test('clasificarError sin modelo no miente: dice "(sin definir)"', () => {
    assert.match(clasificarError(errorApi(404)).mensaje, /\(sin definir\)/);
});

// =============================================================================
// ARCHIVOS GRANDES: FILES API DE GEMINI
// =============================================================================
// El original se guarda tal cual, así que a la IA puede llegarle un archivo que
// no cabe incrustado en una petición (20 MB contando todo, y el base64 infla un
// 33 %). Eso se manda por la Files API, se referencia por su URI y se BORRA de
// Google en cuanto termina el análisis, vaya bien o mal: no quiero copias de mis
// tiquets allí durante 48 horas.
//
// El SDK va simulado: comprobarlo de verdad significaría subir y borrar archivos
// en una cuenta real, que es exactamente lo que no debe hacer una prueba.

/** Un SDK de pega con las tres llamadas de archivos que se usan. */
function sdkDePega({ estados = ['ACTIVE'], fallaElBorrado = false } = {}) {
    const registro = { subidas: [], consultas: [], borrados: [] };
    let paso = 0;

    const sdk = {
        files: {
            upload: async ({ file, config }) => {
                registro.subidas.push({ tipo: config.mimeType, nombre: config.displayName, bytes: file.size });
                return { name: 'files/abc123', uri: 'https://generativelanguage.googleapis.com/v1beta/files/abc123',
                         mimeType: config.mimeType, state: estados[paso++] || 'ACTIVE' };
            },
            get: async ({ name }) => {
                registro.consultas.push(name);
                return { name, uri: 'https://generativelanguage.googleapis.com/v1beta/files/abc123',
                         mimeType: 'application/pdf', state: estados[paso++] || 'ACTIVE' };
            },
            delete: async ({ name }) => {
                registro.borrados.push(name);
                if (fallaElBorrado) throw new Error('403 no se puede borrar');
            }
        }
    };
    return { sdk, registro };
}

/** Un archivo que NO cabe incrustado, sin reservar 30 MB de verdad. */
function archivoGrande() {
    const grande = Buffer.alloc(TOPE_INCRUSTADO_BYTES + 1);
    return grande;
}

function analizadorConArchivos(guion, opciones = {}) {
    const { generar, llamadas } = generadorDePega(guion);
    const { sdk, registro } = sdkDePega(opciones);
    const partes = [];
    const generarEspia = async (modelo, parte) => { partes.push(parte); return generar(modelo, parte); };

    const analizar = crearAnalizador({
        generar: generarEspia,
        modelos: [BUENO],
        dormir: async () => {},
        archivos: crearGestorDeArchivos({ sdk, dormir: async () => {} })
    });
    return { analizar, llamadas, registro, partes };
}

test('un archivo pequeño sigue yendo incrustado: ni sube ni borra nada', async () => {
    const { analizar, registro, partes } = analizadorConArchivos({ [BUENO]: 'ok' });

    await analizar(Buffer.from('cuatro bytes'), 'image/jpeg');

    assert.deepEqual(registro.subidas, []);
    assert.deepEqual(registro.borrados, []);
    assert.ok(partes[0].inlineData, 'va con los datos dentro de la petición');
});

test('un archivo grande se sube, se referencia por URI y se borra al terminar', async () => {
    const { analizar, registro, partes } = analizadorConArchivos({ [BUENO]: 'ok' });

    const salida = await analizar(archivoGrande(), 'application/pdf', { nombre: 'factura.pdf' });

    assert.deepEqual(salida.tiquets, TIQUETS, 'el análisis devuelve lo de siempre');

    assert.equal(registro.subidas.length, 1);
    assert.equal(registro.subidas[0].tipo, 'application/pdf');
    assert.equal(registro.subidas[0].nombre, 'factura.pdf');

    // En la petición va la referencia, NO los datos: si fueran los datos, la
    // petición pasaría del tope y Google la rechazaría.
    assert.equal(partes[0].inlineData, undefined);
    assert.match(partes[0].fileData.fileUri, /files\/abc123$/);
    assert.equal(partes[0].fileData.mimeType, 'application/pdf');

    assert.deepEqual(registro.borrados, ['files/abc123'], 'no se queda en Google');
});

test('el archivo se borra TAMBIÉN cuando el análisis falla', async () => {
    // Es el caso que de verdad importa: un fallo que deje copias en Google es
    // justo lo que no puede pasar, y es el camino que es fácil olvidar.
    const { analizar, registro } = analizadorConArchivos({ [BUENO]: 500 });

    await assert.rejects(() => analizar(archivoGrande(), 'application/pdf'),
                         (e) => e.tipo === 'transitorio');

    assert.equal(registro.subidas.length, 1);
    assert.deepEqual(registro.borrados, ['files/abc123']);
});

test('si Google no deja borrar, la subida NO se rompe por eso', async () => {
    // El tiquet ya está guardado aquí: perderlo porque falle una limpieza en
    // Google sería cambiar un problema pequeño por uno grande. Queda en el log.
    const { analizar, registro } = analizadorConArchivos({ [BUENO]: 'ok' }, { fallaElBorrado: true });

    const salida = await analizar(archivoGrande(), 'application/pdf');

    assert.deepEqual(salida.tiquets, TIQUETS);
    assert.deepEqual(registro.borrados, ['files/abc123'], 'se intentó');
});

test('se espera a que Google acabe de procesar el archivo', async () => {
    const { analizar, registro } = analizadorConArchivos(
        { [BUENO]: 'ok' }, { estados: ['PROCESSING', 'PROCESSING', 'ACTIVE'] }
    );

    await analizar(archivoGrande(), 'application/pdf');

    assert.equal(registro.consultas.length, 2, 'se preguntó hasta que estuvo listo');
    assert.deepEqual(registro.borrados, ['files/abc123']);
});

test('un archivo que ni la Files API admite se explica y no se sube', async () => {
    const { analizar, registro } = analizadorConArchivos({ [BUENO]: 'ok' });

    // No se reserva un archivo de 2 GB: basta con un buffer que diga que lo mide.
    const enorme = Buffer.alloc(8);
    Object.defineProperty(enorme, 'length', { value: TOPE_FILES_API_BYTES + 1 });

    await assert.rejects(() => analizar(enorme, 'application/pdf'), (e) => {
        assert.equal(e.tipo, 'demasiado_grande');
        assert.match(e.mensaje, /2048,0 MB/);
        return true;
    });

    assert.deepEqual(registro.subidas, [], 'no se gasta una subida en algo que no vale');
});

// =============================================================================
// QUÉ CAUSA MANDA CUANDO SE AGOTAN LOS MODELOS
// =============================================================================
// No es una cuestión de redacción: del TIPO del error depende si el controller
// guarda la foto como 'pendiente' (reintentable) o como 'error' (esperando que
// alguien toque la configuración). Quedarse con el último intento marcaba como
// error de configuración lo que era saturación general.

test('el caso real: 3 modelos con 503 y uno con 404 es SATURACIÓN, no configuración', async () => {
    const guion = { [BUENO]: 503, [MEDIO]: 503, [BARATO]: 404 };
    const { analizar } = analizadorCon(guion);

    await assert.rejects(() => correr(analizar), (e) => {
        // Lo que decide que la fila quede reintentable.
        assert.equal(e.tipo, 'transitorio');
        assert.equal(e.status, 503);
        // Y el 404 no se pierde: se dice aparte, porque hay que arreglarlo.
        assert.match(e.mensaje, new RegExp(`"${BARATO}"`));
        assert.match(e.mensaje, /no está disponible para tu clave/);
        return true;
    });
});

test('si la mayoría es 404, entonces sí manda la configuración', async () => {
    const guion = { [BUENO]: 404, [MEDIO]: 404, [BARATO]: 503 };
    const { analizar } = analizadorCon(guion);

    await assert.rejects(() => correr(analizar), (e) => {
        assert.equal(e.tipo, 'modelo');
        // Y entonces el aviso no se repite: el mensaje principal ya lo dice.
        assert.doesNotMatch(e.mensaje, /Además, (el|los) modelo/);
        return true;
    });
});

test('empatados, se queda el tipo que deja la foto reintentable', async () => {
    // Un 404 y un 503, uno cada uno: entre marcarla 'error' para siempre y
    // dejarla pendiente, pendiente. Una foto en 'error' no se reintenta sola.
    const { analizar } = analizadorCon({ [BUENO]: 404, [MEDIO]: 503 }, [BUENO, MEDIO]);

    await assert.rejects(() => correr(analizar), (e) => {
        assert.equal(e.tipo, 'transitorio');
        return true;
    });
});
