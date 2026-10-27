/**
 * Frontend del escáner de tiquets.
 *
 * Sin framework y sin build: se sirve tal cual. Tres bloques bien separados:
 *
 *   HISTORIAL  la lista de la izquierda. Busca, filtra y ordena EN EL SERVIDOR,
 *              y carga por páginas al hacer scroll. Nunca se trae el histórico
 *              entero para filtrarlo aquí.
 *   PANEL      cifras, gráficas y mapa. Todo viene ya agregado de
 *              /api/estadisticas: aquí no se suma nada.
 *   EDITOR     la ficha de corrección, que recorre una cola.
 *
 * Reglas de la interfaz, por si alguien añade algo:
 *   · Ningún emoji. Donde hace falta señalar algo, texto o nada.
 *   · El color sale de los tokens de :root. Color propio SOLO para estados.
 *   · Las monedas no se suman entre sí: si hay más de una, se avisa.
 */

const $ = (id) => document.getElementById(id);

// --- SESIÓN ------------------------------------------------------------------

let SESION = {
    modo: null, autenticado: false, usuario: null, email: null, nombre: null,
    login_disponible: false, portal_url: null, logout_url: null
};

/** A dónde mandar a alguien sin identidad. En producción, al portal. */
function destinoSinSesion() {
    if (SESION.login_disponible) return '/login.html';
    return SESION.portal_url || '/sin-identidad.html';
}

/**
 * Envoltura de fetch para TODAS las llamadas a la API.
 *
 * Un 401 es que no hay identidad: se va al portal. Un 403 es otra cosa —la
 * petición no viene de donde el servidor admite— y ahí redirigir sería un bucle.
 */
// Id de esta pestaña: va en cada escritura para que los avisos en tiempo real
// sepan de dónde vienen y esta pestaña no se repinte por sus propios cambios.
const CLIENTE_ID = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2));

async function api(ruta, opciones = {}) {
    const res = await fetch(ruta, { ...opciones, headers: { ...(opciones.headers || {}), 'X-Cliente': CLIENTE_ID } });

    if (res.status === 401 || res.status === 403) {
        const datos = await res.json().catch(() => ({}));
        if (datos.modo) SESION = { ...SESION, ...datos, autenticado: false };
        location.replace(datos.origen_no_admitido ? '/sin-identidad.html' : destinoSinSesion());
        throw new Error('sin sesion');
    }
    return res;
}

async function cargarSesion() {
    let res;
    try {
        res = await fetch('/api/auth/estado');
        SESION = await res.json();
    } catch (_) {
        return;
    }

    if (res.status === 403) return location.replace('/sin-identidad.html');
    if (!SESION.autenticado) return location.replace(destinoSinSesion());

    $('sesionUsuario').textContent = SESION.nombre
        ? `${SESION.nombre} (${SESION.usuario})`
        : (SESION.usuario || '');
    if (SESION.email) $('sesionUsuario').title = SESION.email;

    $('btnSalir').classList.toggle('hidden', !SESION.login_disponible);

    const enlace = $('enlaceSalir');
    if (!SESION.login_disponible && SESION.logout_url) {
        enlace.href = SESION.logout_url;
        enlace.classList.remove('hidden');
    } else {
        enlace.classList.add('hidden');
    }
}

$('btnSalir').addEventListener('click', async () => {
    try { await fetch('/api/auth/logout', { method: 'POST' }); } catch (_) {}
    location.replace('/login.html');
});

// --- MODELO DE IA ------------------------------------------------------------
// Qué modelos hay y cómo se llaman las opciones lo dice el servidor: la lista
// vive en el .env y cambia sin tocar esta página.

let CONFIG_IA = null;

function modoModeloElegido() {
    const sel = $('modoModelo');
    if (sel && sel.value) return sel.value;
    return (CONFIG_IA && CONFIG_IA.por_defecto) || 'automatico';
}

async function cargarConfigIA() {
    try {
        const res = await api('/api/ia/config');
        CONFIG_IA = await res.json();
    } catch (_) {
        return;
    }
    if (!CONFIG_IA || !Array.isArray(CONFIG_IA.modos) || CONFIG_IA.modos.length === 0) return;

    const sel = $('modoModelo');
    sel.innerHTML = CONFIG_IA.modos.map(m =>
        `<option value="${esc(m.valor)}">${esc(m.etiqueta)}</option>`
    ).join('');
    sel.value = CONFIG_IA.por_defecto || CONFIG_IA.modos[0].valor;

    const pintarAyuda = () => {
        const elegido = CONFIG_IA.modos.find(m => m.valor === sel.value);
        $('modoModeloAyuda').textContent = elegido ? elegido.descripcion : '';
    };
    sel.addEventListener('change', pintarAyuda);
    pintarAyuda();

    // Con un solo modelo configurado los tres modos son el mismo: ofrecer tres
    // opciones idénticas es prometer una elección que no existe.
    const varios = Array.isArray(CONFIG_IA.modelos) && CONFIG_IA.modelos.length > 1;
    // 'hidden' y 'flex' se pelean entre ellas en Tailwind: aquí manda el estilo.
    $('zonaModoModelo').classList.toggle('hidden', !varios);
    $('zonaModoModelo').style.display = varios ? 'flex' : 'none';
}

// --- UTILIDADES --------------------------------------------------------------

function esc(valor) {
    return String(valor ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Plural de verdad, no "tiquet(s)".
 *
 * Con el numero delante: plural(1, 'tiquet') -> "1 tiquet"; plural(3, 'tiquet')
 * -> "3 tiquets". El plural irregular se pasa a mano (plural(n, 'vez', 'veces')).
 */
function plural(n, singular, plural_ = null) {
    const cantidad = Number(n) || 0;
    const palabra = cantidad === 1 ? singular : (plural_ || `${singular}s`);
    return `${new Intl.NumberFormat('es-ES').format(cantidad)} ${palabra}`;
}

/** Un porcentaje como lo escribe el resto de la pagina: en es-ES. */
const formatearPorcentaje = (valor, decimales = 1) =>
    new Intl.NumberFormat('es-ES', { maximumFractionDigits: decimales }).format(Number(valor) || 0) + ' %';

const formateadores = new Map();
function formateadorDe(moneda) {
    const clave = moneda || 'EUR';
    if (!formateadores.has(clave)) {
        let f;
        try {
            f = new Intl.NumberFormat('es-ES', { style: 'currency', currency: clave });
        } catch (_) {
            f = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' });
        }
        formateadores.set(clave, f);
    }
    return formateadores.get(clave);
}

/**
 * Céntimos a texto. Un importe AUSENTE se enseña como 0,00 €: el documento no
 * lleva importe y al sumar vale cero, así que enseñar un guion obligaría a
 * explicar dos veces lo mismo. La distinción entre "no lo lleva" y "pone cero"
 * sigue viva en la base y en el formulario, que es donde hace falta.
 */
function formatearImporte(centimos, moneda = 'EUR') {
    const valor = Number.isFinite(centimos) ? centimos : 0;
    return formateadorDe(moneda).format(valor / 100);
}

function centimosAEuros(centimos) {
    return Number.isFinite(centimos) ? (centimos / 100).toFixed(2) : '';
}

function eurosACentimos(texto) {
    const limpio = String(texto ?? '').trim().replace(',', '.');
    if (limpio === '') return null;
    const n = Number(limpio);
    return Number.isFinite(n) ? Math.round(n * 100) : null;
}

const val = (id) => {
    const v = $(id).value.trim();
    return v === '' ? null : v;
};

function componerFecha(idFecha, idHora) {
    const dia = $(idFecha).value;
    if (!dia) return null;
    const hora = $(idHora).value;
    return hora ? `${dia} ${hora}:00` : dia;
}

function partirFecha(iso) {
    if (!iso) return ['', ''];
    const m = String(iso).match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?/);
    return m ? [m[1], m[2] || ''] : ['', ''];
}

/** Fecha corta del tiquet: "10 ene". Con año si no es de este año. */
function formatearFechaTiquet(valor) {
    if (!valor) return 'sin fecha';
    const m = String(valor).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return String(valor);
    const fecha = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    const esteAnio = fecha.getFullYear() === new Date().getFullYear();
    return fecha.toLocaleDateString('es-ES', {
        day: 'numeric', month: 'short', ...(esteAnio ? {} : { year: 'numeric' })
    });
}

/** "lunes, 19 de octubre de 2026", para los recuadros de información. */
function formatearFechaLarga(valor) {
    const m = String(valor || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return String(valor || '');
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
        .toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

/**
 * created_at legible. SQLite guarda CURRENT_TIMESTAMP en UTC y sin marca de
 * zona; sin la Z el navegador lo leería como hora local y pintaría otra hora.
 */
function formatearFechaSubida(valor) {
    if (!valor) return 'fecha desconocida';
    const iso = String(valor).replace(' ', 'T') + (String(valor).endsWith('Z') ? '' : 'Z');
    const fecha = new Date(iso);
    if (Number.isNaN(fecha.getTime())) return String(valor);
    return fecha.toLocaleString('es-ES', {
        day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
    });
}

/** El color de un token, para Chart.js y Leaflet, que no entienden var(). */
function token(nombre) {
    return getComputedStyle(document.documentElement).getPropertyValue(nombre).trim();
}

// --- TEMA CLARO / OSCURO -----------------------------------------------------
// Tres estados: automático (sigue al sistema), claro y oscuro. Lo elegido se
// guarda; el <head> ya lo aplica antes de pintar para que no haya parpadeo.

const sistemaOscuro = () => window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
const temaEfectivo = () => document.documentElement.dataset.theme || (sistemaOscuro() ? 'dark' : 'light');

function aplicarTema(valor, { repintar = true } = {}) {
    if (valor === 'light' || valor === 'dark') document.documentElement.dataset.theme = valor;
    else delete document.documentElement.dataset.theme;
    try {
        if (valor === 'light' || valor === 'dark') localStorage.setItem('tema', valor);
        else localStorage.removeItem('tema');
    } catch (_) {}
    $('btnTema').title = temaEfectivo() === 'dark' ? 'Tema oscuro' : 'Tema claro';
    if (repintar) repintarPorTema();
}

/**
 * Lo que hay que volver a pintar al cambiar de tema: la gráfica y el mapa
 * leyeron los colores de los tokens cuando se dibujaron. El resto es CSS y se
 * actualiza solo.
 */
function repintarPorTema() {
    if (Tiempo && Tiempo.datos) pintarTiempo();
    if (mapa) cargarMapa();
}

/** Un toque: al tema contrario del que se está viendo. */
// Idioma de la interfaz (i18n.js): el botón enseña el actual y cambia al otro.
$('btnIdioma').textContent = window.IDIOMA === 'en' ? 'EN' : 'ES';
$('btnIdioma').addEventListener('click', () => window.cambiarIdioma(window.IDIOMA === 'en' ? 'es' : 'en'));

$('btnTema').addEventListener('click', () => {
    aplicarTema(temaEfectivo() === 'dark' ? 'light' : 'dark');
});

// --- PALETA DE COLOR ---------------------------------------------------------
// Independiente del claro/oscuro: cada paleta tiene sus dos versiones.

function marcarPaleta() {
    const actual = document.documentElement.dataset.paleta || '';
    for (const b of $('menuPaleta').querySelectorAll('[data-paleta]')) {
        b.setAttribute('aria-checked', String(b.dataset.paleta === actual));
    }
}
function aplicarPaleta(valor) {
    if (valor) document.documentElement.dataset.paleta = valor;
    else delete document.documentElement.dataset.paleta;
    try { valor ? localStorage.setItem('paleta', valor) : localStorage.removeItem('paleta'); } catch (_) {}
    marcarPaleta();
    if (Tiempo && Tiempo.datos) pintarTiempo();
    // Los puntos del mapa son CSS con los tokens: se recolorean solos.
}
$('btnPaleta').addEventListener('click', (ev) => {
    ev.stopPropagation();
    marcarPaleta();
    $('menuPaleta').classList.toggle('hidden');
});
$('menuPaleta').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-paleta]');
    if (!b) return;
    aplicarPaleta(b.dataset.paleta);
    $('menuPaleta').classList.add('hidden');
});
document.addEventListener('click', (ev) => {
    if (!ev.target.closest('#menuPaleta')) $('menuPaleta').classList.add('hidden');
});
document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') $('menuPaleta').classList.add('hidden');
});

// --- AVISOS FLOTANTES --------------------------------------------------------

let temporizadorToast = null;
function aviso(texto) {
    const caja = $('toast');
    caja.textContent = texto;
    caja.hidden = false;
    requestAnimationFrame(() => caja.classList.add('visible'));
    clearTimeout(temporizadorToast);
    temporizadorToast = setTimeout(() => {
        caja.classList.remove('visible');
        setTimeout(() => { caja.hidden = true; }, 300);
    }, 4000);
}

// --- INFORMACIÓN AL PASAR EL RATÓN (y pulsación larga en móvil) --------------
// El mismo recuadro para las dos cosas: en escritorio aparece al pasar por
// encima; en táctil, manteniendo pulsado. Nunca al tocar, porque tocar ya
// significa otra cosa (filtrar el historial por ese día).

const puedeApuntar = () => window.matchMedia &&
    window.matchMedia('(hover: hover) and (pointer: fine)').matches;

let temporizadorTip = null;

// Al salir de la casilla, el recuadro espera un momento antes de cerrarse: da
// tiempo a llevar el ratón hasta él para hacer scroll o abrir un tiquet.
let temporizadorCerrarTip = null;
function programarOcultarTip() {
    clearTimeout(temporizadorTip);
    clearTimeout(temporizadorCerrarTip);
    temporizadorCerrarTip = setTimeout(ocultarTip, 220);
}

let anclaTip = null;      // la casilla del recuadro abierto: se marca (sube un poco)
function ocultarTip() {
    clearTimeout(temporizadorTip);
    clearTimeout(temporizadorCerrarTip);
    if (anclaTip) { anclaTip.classList.remove('con-tip'); anclaTip = null; }
    const tip = $('tip');
    tip.classList.remove('visible');
    tip.hidden = true;
}

/**
 * Dibuja el recuadro junto a `ancla`. `contenido` es {titulo, filas:[[a,b]]}.
 * Devuelve false si no había nada que contar, para que la pulsación larga no
 * se coma el toque cuando no hay información.
 */
function dibujarTip(ancla, contenido) {
    const lista = (contenido && contenido.lista) || [];
    if (!contenido || (!contenido.filas.length && !lista.length)) return false;
    const tip = $('tip');
    tip.innerHTML =
        `<div class="tip-titulo">${esc(contenido.titulo)}</div>` +
        contenido.filas.map(([a, b]) => a
            ? `<div class="tip-fila"><span>${esc(a)}</span><span class="cifra">${esc(b)}</span></div>`
            : `<div class="tip-fila" style="justify-content: flex-start">${esc(b)}</div>`
        ).join('') +
        // Qué se gastó y dónde: lo que se quiere saber de un vistazo.
        // Todos, con scroll si son muchos; cada uno abre su tiquet.
        (lista.length ? `<div class="tip-lista">${lista.map(l => `
            <div class="tip-item"${l.id ? ` data-tiquet="${l.id}" role="button" tabindex="0"` : ''}>
                <span class="tip-item-nombre">${esc(l.nombre)}</span>
                <span class="cifra">${esc(l.importe)}</span>
                ${l.extra ? `<span class="tip-item-extra">${esc(l.extra)}</span>` : ''}
            </div>`).join('')}</div>` : '');
    tip.classList.toggle('con-lista', lista.length > 0);
    tip.hidden = false;
    if (anclaTip && anclaTip !== ancla) anclaTip.classList.remove('con-tip');
    anclaTip = ancla;
    // En táctil no hay :hover: la marca la pone esta clase mientras se ve.
    if (!puedeApuntar()) ancla.classList.add('con-tip');

    const caja = ancla.getBoundingClientRect();
    const ancho = tip.offsetWidth, alto = tip.offsetHeight;
    let x = caja.left + caja.width / 2 - ancho / 2;
    let y = caja.top - alto - 8;
    if (y < 8) y = caja.bottom + 8;
    x = Math.max(8, Math.min(x, window.innerWidth - ancho - 8));
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
    tip.classList.add('visible');
    return true;
}

/**
 * Engancha a un elemento el recuadro de información: ratón encima en
 * escritorio, pulsación larga en táctil. `contenido()` se llama al mostrarlo.
 */
function conTip(elemento, contenido) {
    if (puedeApuntar()) {
        elemento.addEventListener('mouseenter', () => {
            clearTimeout(temporizadorTip);
            clearTimeout(temporizadorCerrarTip);
            temporizadorTip = setTimeout(() => dibujarTip(elemento, contenido()), 160);
        });
        elemento.addEventListener('mouseleave', programarOcultarTip);
        return;
    }

    let temporizador = null, inicio = null;
    elemento.addEventListener('pointerdown', (ev) => {
        if (ev.pointerType === 'mouse') return;
        inicio = { x: ev.clientX, y: ev.clientY };
        clearTimeout(temporizador);
        temporizador = setTimeout(() => {
            if (dibujarTip(elemento, contenido())) {
                pulsacionLarga = true;
                if (navigator.vibrate) navigator.vibrate(15);
            }
        }, 450);
    });
    const cancelar = () => clearTimeout(temporizador);
    elemento.addEventListener('pointermove', (ev) => {
        if (inicio && Math.hypot(ev.clientX - inicio.x, ev.clientY - inicio.y) > 10) cancelar();
    });
    elemento.addEventListener('pointerup', cancelar);
    elemento.addEventListener('pointercancel', cancelar);
    elemento.addEventListener('contextmenu', (ev) => ev.preventDefault());
}

// Una pulsación larga informa, no filtra: el click que viene detrás se ignora.
let pulsacionLarga = false;

document.addEventListener('pointerdown', (ev) => {
    if (ev.pointerType !== 'mouse' && !ev.target.closest('[data-dia], [data-mes], [data-porcion], #tip')) ocultarTip();
});
// Dentro del recuadro: quedarse lo mantiene abierto, salir lo cierra, y pulsar
// un tiquet lo abre en el editor.
$('tip').addEventListener('mouseenter', () => clearTimeout(temporizadorCerrarTip));
$('tip').addEventListener('mouseleave', programarOcultarTip);
$('tip').addEventListener('click', (ev) => {
    const item = ev.target.closest('[data-tiquet]');
    if (!item) return;
    ocultarTip();
    Editor.abrirPorIds([Number(item.dataset.tiquet)]);
});
window.addEventListener('scroll', ocultarTip, { passive: true });

// --- ESCALA DEL GASTO: QUÉ ES UN DÍA CARO PARA MÍ ----------------------------
// Verde, naranja y rojo, como la ocupación de la referencia. Los umbrales NO
// son cantidades fijas: son percentiles de mi propio histórico, que es lo único
// que puede decir si 40 € es un día tranquilo o una barbaridad. Los calcula el
// servidor (/api/estadisticas/escala) con las mismas reglas que el resto.

let ESCALA = null;

// Con cuatro días de histórico, cualquier escala es inventada: hasta ahí no se
// pinta color, solo el importe.
const MUESTRAS_MINIMAS = 6;

async function cargarEscala() {
    try {
        const res = await api('/api/estadisticas/escala');
        ESCALA = await res.json();
    } catch (err) {
        if (err && err.message === 'sin sesion') return;
        console.error(err);
    }
}

/** '' (sin gasto o sin escala), 'g', 'o' o 'r'. */
function nivelDeGasto(centimos, grano = 'dia') {
    if (!centimos || centimos <= 0) return '';
    const tramos = ESCALA && ESCALA[grano];
    if (!tramos || tramos.muestras < MUESTRAS_MINIMAS || tramos.bajo === null) return '';
    if (centimos <= tramos.bajo) return 'g';
    if (centimos <= tramos.alto) return 'o';
    return 'r';
}

/**
 * Lo que significa el color, para el recuadro de informacion de cada dia. La
 * leyenda fija desaparecio: ocupaba sitio permanente para explicar algo que solo
 * se pregunta al mirar un dia concreto.
 */
const TEXTO_NIVEL = {
    g: 'por debajo de tu gasto habitual',
    o: 'tu gasto habitual',
    r: 'por encima de tu gasto habitual'
};

const COLOR_NIVEL = { g: '--g', o: '--o', r: '--r' };
/** El color del nivel, resuelto, para Chart.js y Leaflet (no entienden var()). */
const colorDeNivel = (nivel) => token(COLOR_NIVEL[nivel] || '--texto-3');

// --- DOCUMENTOS EN PDF -------------------------------------------------------
// Las facturas llegan en PDF y se guardan tal cual: ni se convierten a imagen ni
// se recortan. Para verlas sin salir del editor hay que pintarlas, porque un PDF
// no se puede meter en un <img>. Lo hace pdf.js desde la CDN; si no ha cargado,
// se dice y queda el enlace "Abrir aparte", que usa el visor del navegador.

const esPdf = (ruta) => /\.pdf(?:$|[?#])/i.test(String(ruta || ''));

const hayPdfJs = () => typeof pdfjsLib !== 'undefined';

function prepararPdfJs() {
    if (!hayPdfJs()) return false;
    // El worker tiene que ser el de la MISMA versión que la librería, o pdf.js
    // se niega a trabajar.
    if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
        pdfjsLib.GlobalWorkerOptions.workerSrc =
            'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    }
    return true;
}

/**
 * Pinta un PDF dentro de `caja`, una página por canvas.
 *
 * `origen` es una URL (/uploads/…) o un ArrayBuffer (el archivo recién elegido,
 * que todavía no está en el servidor). Con `maxPaginas` se pide solo el principio:
 * la miniatura de la subida es la primera página y nada más.
 */
async function pintarPdf(caja, origen, { maxPaginas = Infinity, ancho = 0 } = {}) {
    caja.innerHTML = '';

    // Pintar una factura de seis páginas tarda. Si mientras tanto se salta a otra
    // ficha, esta tanda tiene que abandonar en vez de ir soltando canvas sobre lo
    // que ya hay pintado de la siguiente.
    const marca = `${Date.now()}-${Math.random()}`;
    caja.dataset.render = marca;
    const vigente = () => caja.dataset.render === marca;

    if (!prepararPdfJs()) {
        caja.innerHTML = `<p class="text-sm p-3" style="color: var(--texto-2)">
            No se ha podido cargar el visor de PDF. Ábrelo aparte.</p>`;
        return 0;
    }

    try {
        const pdf = await pdfjsLib.getDocument(origen).promise;
        const total = Math.min(pdf.numPages, maxPaginas);
        const anchoCaja = ancho || caja.clientWidth || caja.parentElement.clientWidth || 360;

        for (let n = 1; n <= total; n += 1) {
            if (!vigente()) return 0;
            const pagina = await pdf.getPage(n);
            const base = pagina.getViewport({ scale: 1 });
            // Se pinta al doble de densidad y se enseña al tamaño de la caja: un
            // canvas a 1x sobre una pantalla de móvil deja el texto ilegible, que
            // es justo lo que hay que leer para corregir una factura.
            const vista = pagina.getViewport({ scale: (anchoCaja / base.width) * 2 });

            const lienzo = document.createElement('canvas');
            lienzo.width = Math.round(vista.width);
            lienzo.height = Math.round(vista.height);
            lienzo.className = 'block w-full';
            lienzo.style.marginBottom = n < total ? '6px' : '0';
            caja.appendChild(lienzo);

            await pagina.render({ canvasContext: lienzo.getContext('2d'), viewport: vista }).promise;
        }

        if (pdf.numPages > total && vigente()) {
            const aviso = document.createElement('p');
            aviso.className = 'text-xs px-2 py-1';
            aviso.style.color = 'var(--texto-2)';
            aviso.textContent = `Primera de ${pdf.numPages} páginas.`;
            caja.appendChild(aviso);
        }
        return pdf.numPages;

    } catch (err) {
        console.error(err);
        if (vigente()) {
            caja.innerHTML = `<p class="text-sm p-3" style="color: var(--texto-2)">
                No se ha podido pintar el PDF (${esc(err.message || 'error')}). Ábrelo aparte.</p>`;
        }
        return 0;
    }
}

// --- ESTADOS -----------------------------------------------------------------
// Color SOLO para estados, y ni siquiera para todos: 'procesado' es lo normal y
// no necesita señal.

const ESTADOS = {
    procesado:  { color: 'transparent',    texto: 'Procesado' },
    incompleto: { color: 'var(--aviso)',   texto: 'Falta la fecha' },
    pendiente:  { color: 'var(--texto-2)', texto: 'Sin procesar' },
    error:      { color: 'var(--error)',   texto: 'Con error' }
};

// --- BANNER ------------------------------------------------------------------

/**
 * El aviso de arriba. Queda para los fallos que no son de una subida concreta
 * (no hay sesión, el historial no carga): lo de la subida se cuenta en su propia
 * tarjeta, y lo que solo hay que enterarse de pasada, en el aviso flotante.
 */
function bannerError(titulo, cuerpo = '') {
    const caja = $('resultBanner');
    caja.className = 'tarjeta p-3 mb-4 text-sm';
    caja.style.borderLeft = '3px solid var(--error)';
    caja.innerHTML = `<b>${titulo}</b>${cuerpo}`;
    caja.classList.remove('hidden');
}
const ocultarBanner = () => $('resultBanner').classList.add('hidden');

// =============================================================================
// SUBIDA: ELEGIR, VER Y ANALIZAR
// =============================================================================
// Un input de archivo a secas no deja comprobar nada antes de gastar una llamada
// a la IA. Aquí hay tres momentos, y los tres ocurren en la MISMA tarjeta:
//
//   1. elegir      soltando el archivo encima (escritorio) o con el botón;
//                  en móvil, cámara o galería.
//   2. comprobar   vista previa (la imagen o la primera página del PDF),
//                  nombre, tamaño y páginas. Se puede cambiar o cancelar.
//   3. analizar    con el progreso real de la subida y luego los pasos; al
//                  terminar, el resultado sobre la misma tarjeta.

const Subida = {
    archivo: null,
    enCurso: false,
    ultimo: null        // la respuesta del servidor, para el resumen
};

const MB = 1024 * 1024;
const tamanoLegible = (bytes) => bytes >= MB
    ? `${(bytes / MB).toFixed(1).replace('.', ',')} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;

const esArchivoPdf = (archivo) => archivo.type === 'application/pdf' || esPdf(archivo.name);

// --- Elegir ------------------------------------------------------------------

$('btnEscanear').addEventListener('click', () => {
    $('zonaSubida').classList.remove('hidden');
    ocultarBanner();
    if (!Subida.archivo) $('fileInput').click();
    $('zonaSubida').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});

$('btnElegir').addEventListener('click', () => $('fileInput').click());
$('btnCamara').addEventListener('click', () => $('fileInputCamara').click());
$('btnCambiarArchivo').addEventListener('click', () => $('fileInput').click());
$('btnCancelarSubida').addEventListener('click', cancelarSubida);

for (const id of ['fileInput', 'fileInputCamara']) {
    $(id).addEventListener('change', (ev) => {
        const archivo = ev.target.files && ev.target.files[0];
        if (archivo) tomarArchivo(archivo);
    });
}

// Arrastrar y soltar, con estado visual mientras el archivo está encima. El
// preventDefault en dragover es obligatorio: sin él el navegador abre el archivo
// en vez de dejarlo soltar.
const zonaSoltar = $('zonaSoltar');
for (const evento of ['dragenter', 'dragover']) {
    zonaSoltar.addEventListener(evento, (ev) => {
        ev.preventDefault();
        zonaSoltar.classList.add('encima');
    });
}
for (const evento of ['dragleave', 'drop']) {
    zonaSoltar.addEventListener(evento, () => zonaSoltar.classList.remove('encima'));
}
zonaSoltar.addEventListener('drop', (ev) => {
    ev.preventDefault();
    const archivo = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
    if (archivo) tomarArchivo(archivo);
});

// Soltar en cualquier parte de la página también vale: apuntar a un recuadro
// pequeño con el ratón ocupado arrastrando es una puntería que no hace falta.
window.addEventListener('dragover', (ev) => {
    if (!ev.dataTransfer || ![...ev.dataTransfer.types].includes('Files')) return;
    ev.preventDefault();
    $('zonaSubida').classList.remove('hidden');
    if (!Subida.archivo) zonaSoltar.classList.add('encima');
});
window.addEventListener('drop', (ev) => {
    const archivo = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
    if (!archivo) return;
    ev.preventDefault();
    zonaSoltar.classList.remove('encima');
    tomarArchivo(archivo);
});

// --- Comprobar ---------------------------------------------------------------

async function tomarArchivo(archivo) {
    Subida.archivo = archivo;
    Subida.ultimo = null;
    ocultarBanner();

    $('zonaSubida').classList.remove('hidden');
    $('zonaSoltar').classList.add('hidden');
    $('previaSubida').classList.remove('hidden');
    $('previaProgreso').classList.add('hidden');
    $('previaResultado').classList.add('hidden');
    $('previaAcciones').classList.remove('hidden');
    $('btnUpload').disabled = false;

    $('previaNombre').textContent = archivo.name;
    $('previaDatos').textContent = tamanoLegible(archivo.size);

    const lienzo = $('previaLienzo');
    lienzo.innerHTML = '';

    if (esArchivoPdf(archivo)) {
        // De un PDF, la primera página: con un nombre como "scan_0001.pdf" no
        // hay otra forma de saber si es la factura que se busca.
        const paginas = await pintarPdf(lienzo, { data: new Uint8Array(await archivo.arrayBuffer()) },
                                        { maxPaginas: 1, ancho: 240 });
        $('previaDatos').textContent = `PDF · ${tamanoLegible(archivo.size)}` +
            (paginas ? ` · ${plural(paginas, 'página')}` : '');
    } else {
        const img = document.createElement('img');
        img.alt = 'Vista previa del archivo elegido';
        img.src = URL.createObjectURL(archivo);
        img.addEventListener('load', () => {
            $('previaDatos').textContent =
                `${img.naturalWidth}×${img.naturalHeight} · ${tamanoLegible(archivo.size)}`;
            URL.revokeObjectURL(img.src);
        });
        lienzo.appendChild(img);
    }
}

function cancelarSubida() {
    Subida.archivo = null;
    Subida.ultimo = null;
    $('fileInput').value = '';
    $('fileInputCamara').value = '';
    $('previaLienzo').innerHTML = '';
    $('previaSubida').classList.add('hidden');
    $('previaResultado').classList.add('hidden');
    $('zonaSoltar').classList.remove('hidden');
    $('zonaSubida').classList.add('hidden');
}

// --- Analizar ----------------------------------------------------------------

/** Enciende el paso que toca y marca como hechos los anteriores. */
function pasoSubida(nombre, detalle = '') {
    const orden = ['subiendo', 'analizando', 'guardando'];
    const actual = orden.indexOf(nombre);
    for (const paso of $('previaProgreso').querySelectorAll('[data-paso]')) {
        const i = orden.indexOf(paso.dataset.paso);
        paso.classList.toggle('activo', i === actual);
        paso.classList.toggle('hecho', actual >= 0 && i < actual);
    }
    $('previaDetalle').textContent = detalle;
}

function porcentajeSubida(fraccion) {
    const barra = $('previaProgreso').querySelector('.progreso');
    if (fraccion === null) {
        barra.classList.add('indeterminado');
        barra.firstElementChild.style.width = '';
    } else {
        barra.classList.remove('indeterminado');
        barra.firstElementChild.style.width = `${Math.round(fraccion * 100)}%`;
    }
}

/**
 * La subida con XHR y no con fetch, por una razón concreta: fetch no informa del
 * progreso de SUBIDA, y con 100 MB de tope eso es justo lo que hay que ver.
 */
function enviarArchivo(archivo, modo) {
    return new Promise((resolve, reject) => {
        const datos = new FormData();
        datos.append('ticket', archivo);
        datos.append('modo_modelo', modo);

        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/tickets/upload');
        xhr.setRequestHeader('X-Cliente', CLIENTE_ID);

        xhr.upload.addEventListener('progress', (ev) => {
            if (!ev.lengthComputable) return;
            if (ev.loaded >= ev.total) {
                // Subido: desde aquí el tiempo lo manda la IA, y cuánto va a
                // tardar no se sabe. Barra indeterminada en vez de mentir.
                pasoSubida('analizando', 'La IA está leyendo el documento…');
                porcentajeSubida(null);
            } else {
                pasoSubida('subiendo', `${tamanoLegible(ev.loaded)} de ${tamanoLegible(ev.total)}`);
                porcentajeSubida(ev.loaded / ev.total);
            }
        });

        xhr.addEventListener('load', () => {
            let cuerpo = {};
            try { cuerpo = JSON.parse(xhr.responseText || '{}'); } catch (_) {}
            resolve({ status: xhr.status, ok: xhr.status >= 200 && xhr.status < 300, datos: cuerpo });
        });
        xhr.addEventListener('error', () => reject(new Error('error de red')));
        xhr.addEventListener('abort', () => reject(new Error('cancelado')));

        xhr.send(datos);
    });
}

$('btnUpload').addEventListener('click', subirTicket);

async function subirTicket() {
    if (!Subida.archivo || Subida.enCurso) return;

    Subida.enCurso = true;
    $('btnUpload').disabled = true;
    $('btnCambiarArchivo').disabled = true;
    $('previaResultado').classList.add('hidden');
    $('previaProgreso').classList.remove('hidden');
    pasoSubida('subiendo', 'Preparando el envío…');
    porcentajeSubida(0);
    ocultarBanner();

    try {
        const { status, ok, datos } = await enviarArchivo(Subida.archivo, modoModeloElegido());

        if (status === 401 || status === 403) {
            location.replace(datos.origen_no_admitido ? '/sin-identidad.html' : destinoSinSesion());
            return;
        }

        $('previaProgreso').classList.add('hidden');

        if (!ok) {
            pintarResultadoSubida(null, datos);
            await cargarHistorial({ reiniciar: true });
            return;
        }

        pasoSubida('guardando', 'Guardando la ficha…');
        Subida.ultimo = datos;
        await Promise.all([cargarHistorial({ reiniciar: true }), cargarPanel()]);

        pintarResultadoSubida(datos, null);
        aviso(datos.total_en_foto > 1
            ? `${plural(datos.total_en_foto, 'tiquet')} detectados en la foto`
            : 'Tiquet guardado');

    } catch (err) {
        if (err && err.message === 'sin sesion') return;
        console.error(err);
        $('previaProgreso').classList.add('hidden');
        pintarResultadoSubida(null, { error: 'No se ha podido subir el archivo (error de red).' });
    } finally {
        Subida.enCurso = false;
        $('btnUpload').disabled = false;
        $('btnCambiarArchivo').disabled = false;
    }
}

/** Qué ha costado leerlo: los modelos que fallaron por el camino. */
function textoIntentos(data) {
    const intentos = (data && data.intentos_ia) || [];
    if (!intentos.length) return '';
    const porModelo = [...new Set(intentos.map(i => i.modelo))].map((modelo) => {
        const suyos = intentos.filter(i => i.modelo === modelo);
        const ultimo = suyos[suyos.length - 1];
        return `${modelo}: ${ultimo.tipo}${ultimo.status ? ` ${ultimo.status}` : ''}` +
               (suyos.length > 1 ? ` ×${suyos.length}` : '');
    });
    return `Hubo reintentos por el camino (${porModelo.join('; ')})` +
           (data.modelo_usado ? ` y acabó leyéndolo ${data.modelo_usado}.` : '.');
}

/** Lo que se ha leído de un tiquet suelto: comercio, importe y fecha. */
function resumenDeFicha(datos) {
    if (!datos) return null;
    const nombre = datos.establecimiento_nombre ||
                   (datos.establecimiento && datos.establecimiento.nombre) || null;
    const trozos = [
        nombre,
        Number.isFinite(datos.total_centimos)
            ? formatearImporte(datos.total_centimos, datos.moneda)
            : null,
        datos.fecha_compra ? formatearFechaTiquet(datos.fecha_compra) : null
    ].filter(Boolean);
    return trozos.length ? trozos.join(' · ') : null;
}

/**
 * El resultado, sobre la misma tarjeta: qué se ha guardado y un acceso directo
 * a revisarlo. `error` manda si viene.
 */
function pintarResultadoSubida(data, error) {
    const caja = $('previaResultado');
    caja.classList.remove('hidden');
    $('previaAcciones').classList.add('hidden');

    if (error) {
        const guardada = error.id
            ? `<p class="text-xs mt-1" style="color: var(--texto-2)">
                   Se ha guardado como ficha ${esc(error.id)} (${esc(error.estado || 'sin procesar')}):
                   el archivo no se pierde y se puede volver a analizar.</p>`
            : '';
        caja.innerHTML = `
            <p class="text-sm font-semibold" style="color: var(--error)">No se ha podido analizar</p>
            <p class="text-sm mt-1">${esc(error.error || 'Fallo desconocido')}</p>
            ${guardada}
            <div class="flex flex-wrap gap-2 mt-3">
                ${error.id ? `<button class="boton boton-sm" data-accion-previa="revisar"
                                      data-ids="${esc(error.id)}">Abrir la ficha</button>` : ''}
                <button class="boton boton-sm" data-accion-previa="otro">Probar con otro archivo</button>
            </div>`;
        return;
    }

    const ids = data.ids || (data.id ? [data.id] : []);
    const varios = (data.total_en_foto || 1) > 1;
    const primera = (data.filas && data.filas[0] && data.filas[0].datos) || data.datos || null;

    const resumen = varios
        ? `${plural(data.total_en_foto, 'tiquet')} detectados`
        : (resumenDeFicha(primera) || 'Ficha guardada');

    const duplicado = data.resultado === 'duplicado_exacto';
    const intentos = textoIntentos(data);

    caja.innerHTML = `
        <p class="text-sm font-semibold" style="color: ${duplicado ? 'var(--aviso)' : 'var(--correcto)'}">
            ${duplicado ? 'Ese archivo ya estaba' : 'Analizado'}
        </p>
        <p class="cifra-grande mt-1" style="font-size: 1.15rem">${esc(resumen)}</p>
        ${data.mensaje ? `<p class="text-xs mt-1" style="color: var(--texto-2)">${esc(data.mensaje)}</p>` : ''}
        ${intentos ? `<p class="text-xs mt-1" style="color: var(--texto-2)">${esc(intentos)}</p>` : ''}
        <div class="flex flex-wrap gap-2 mt-3">
            ${ids.length ? `<button class="boton boton-acento boton-sm" data-accion-previa="revisar"
                                    data-ids="${ids.join(',')}">
                                ${varios ? `Revisar los ${ids.length}` : 'Revisar'}
                            </button>` : ''}
            <button class="boton boton-sm" data-accion-previa="otro">Subir otro</button>
        </div>`;
}

$('previaResultado').addEventListener('click', (ev) => {
    const boton = ev.target.closest('[data-accion-previa]');
    if (!boton) return;
    if (boton.dataset.accionPrevia === 'otro') {
        cancelarSubida();
        $('zonaSubida').classList.remove('hidden');
        $('fileInput').click();
    } else {
        const ids = boton.dataset.ids.split(',').map(Number);
        // Al acabar de revisar: si no queda ninguno por arreglar, la caja de
        // subida ya no tiene nada que enseñar y se cierra sola.
        Editor.abrirPorIds(ids, { alTerminar: async () => {
            const fichas = await Promise.all(ids.map(id => traerTiquet(id)));
            const quedan = fichas.filter(t => t && ['incompleto', 'pendiente', 'error'].includes(t.estado));
            if (quedan.length === 0) cancelarSubida();
        } });
    }
});

$('btnCerrarSubida').addEventListener('click', cancelarSubida);

// =============================================================================
// HISTORIAL
// =============================================================================

let TICKETS = [];                       // lo cargado hasta ahora, en orden
const PAGINA = 40;

const historial = { offset: 0, total: 0, hayMas: true, cargando: false };

// Filtros sin campo propio: los pone la línea de control al pulsarla.
let filtrosExtra = {};

// El periodo que ha dejado puesto un clic en el calendario o en la rejilla del
// año, para poder enseñarlo y quitarlo con un clic. Escribe en fDesde/fHasta:
// no es un filtro paralelo, es el mismo.
let filtroPeriodo = null;

/** Los filtros tal y como están en los campos, listos para la query. */
function filtrosActuales() {
    const [orden, dir] = ($('fOrden').value || 'fecha|desc').split('|');
    const parametros = new URLSearchParams();

    const texto = $('fBuscar').value.trim();
    if (texto) parametros.set('q', texto);

    const pares = [
        ['desde', $('fDesde').value],
        ['hasta', $('fHasta').value],
        ['categoria', $('fCategoriaFiltro').value.trim()],
        ['tipo', $('fTipoFiltro').value.trim()],
        ['estado', $('fEstadoFiltro').value]
    ];
    for (const [clave, valor] of pares) if (valor) parametros.set(clave, valor);

    // Los importes se escriben en euros y viajan en céntimos, como todo.
    const min = eurosACentimos($('fMin').value);
    const max = eurosACentimos($('fMax').value);
    if (min !== null) parametros.set('min', min);
    if (max !== null) parametros.set('max', max);

    for (const [clave, valor] of Object.entries(filtrosExtra)) parametros.set(clave, valor);

    parametros.set('orden', orden);
    parametros.set('dir', dir);
    return parametros;
}

function describirFiltros() {
    const activos = [];
    if ($('fBuscar').value.trim()) activos.push(`"${$('fBuscar').value.trim()}"`);
    if ($('fDesde').value || $('fHasta').value) {
        activos.push(`${$('fDesde').value || '…'} a ${$('fHasta').value || '…'}`);
    }
    if ($('fMin').value || $('fMax').value) activos.push('importe acotado');
    if ($('fCategoriaFiltro').value.trim()) activos.push($('fCategoriaFiltro').value.trim());
    if ($('fTipoFiltro').value.trim()) activos.push($('fTipoFiltro').value.trim());
    if ($('fEstadoFiltro').value) activos.push($('fEstadoFiltro').value);
    if (filtrosExtra.sin_importe) activos.push('sin importe');
    if (filtrosExtra.sin_ubicar) activos.push('sin ubicar');
    if (filtrosExtra.dudoso) activos.push('ubicación dudosa');

    $('resumenFiltros').textContent = activos.length ? activos.join(' · ') : '';
    const hayFiltros = activos.length > 0;
    $('btnFiltros').style.borderColor = hayFiltros ? 'var(--acento)' : '';
    $('btnLimpiarRapido').disabled =
        !hayFiltros && Object.keys(filtrosExtra).length === 0 && !filtroPeriodo;
    $('btnFiltros').style.color = hayFiltros ? 'var(--acento)' : '';

    pintarFiltroPeriodo();
    marcarChipsActivos();
}

/** Deja encendido el chip del filtro que está puesto, para poder apagarlo. */
function marcarChipsActivos() {
    for (const chip of $('lineaControl').querySelectorAll('[data-filtro]')) {
        const filtro = JSON.parse(chip.dataset.filtro);
        const activo = filtro.estado
            ? $('fEstadoFiltro').value === filtro.estado
            : Object.keys(filtro).every(k => String(filtrosExtra[k] ?? '') === String(filtro[k]));
        chip.classList.toggle('activo', activo);
    }
}

/**
 * Carga una página del historial. Con `reiniciar`, empieza de cero; si no,
 * añade la siguiente página (es lo que hace el scroll).
 */
let movimientosCargados = false;
async function cargarHistorial({ reiniciar = false } = {}) {
    // Un reinicio pedido mientras se carga otra página no se pierde: se hace al
    // acabar. (Pasaba al abrir la página: el scroll infinito pedía la primera
    // página antes que el arranque, y el arranque —que es el que trae los
    // movimientos del banco— se encontraba la carga en curso y se iba.)
    if (historial.cargando) { if (reiniciar) historial.reinicioPendiente = true; return; }
    if (!reiniciar && !historial.hayMas) return;
    if ((reiniciar || !movimientosCargados) && typeof actualizarEnlacesBanco === 'function') {
        historial.cargando = true;
        try { await Promise.all([actualizarEnlacesBanco(), cargarMovimientosHistorial()]); }
        finally { historial.cargando = false; }
        movimientosCargados = true;
        pintarBizum();
    }

    historial.cargando = true;
    if (reiniciar) {
        historial.offset = 0;
        historial.hayMas = true;
        TICKETS = [];
    }
    $('estadoCarga').textContent = 'Cargando…';

    try {
        const parametros = filtrosActuales();
        parametros.set('limit', PAGINA);
        parametros.set('offset', historial.offset);

        const res = await api(`/api/tickets?${parametros.toString()}`);
        const datos = await res.json();

        if (!res.ok) {
            $('estadoCarga').textContent = datos.error || 'No se ha podido cargar el historial.';
            historial.hayMas = false;
            return;
        }

        const pagina = Array.isArray(datos) ? datos : (datos.tiquets || []);
        TICKETS = reiniciar ? pagina : TICKETS.concat(pagina);
        historial.total = datos.total ?? TICKETS.length;
        historial.suma = datos.suma_centimos ?? null;
        historial.offset = TICKETS.length;
        historial.hayMas = Boolean(datos.hay_mas);

        pintarHistorial();
        describirFiltros();
        $('estadoCarga').textContent = TICKETS.length === 0
            ? 'No hay tiquets con estos filtros.'
            : '';
    } catch (err) {
        if (err && err.message === 'sin sesion') return;
        console.error(err);
        $('estadoCarga').textContent = 'Error de conexión.';
    } finally {
        historial.cargando = false;
        if (historial.reinicioPendiente) {
            historial.reinicioPendiente = false;
            cargarHistorial({ reiniciar: true });
        }
    }
}

/**
 * El historial es una lista PLANA de tiquets, uno por fila.
 *
 * Antes agrupaba por foto, con su cabecera y su total. Pero el historial es una
 * lista de TIQUETS, no de fotos: la agrupación metía dos niveles de estructura
 * para decir algo —"estos dos salieron del mismo papel"— que solo importa cuando
 * se está corrigiendo uno, y ahí ya lo dice el editor.
 */
function pintarHistorial() {
    const lista = listaMezclada();
    $('listaTickets').innerHTML = lista.map(x => x.tipo === 't' ? pintarFila(x.t) : pintarFilaBanco(x.m)).join('');
    const movs = lista.filter(x => x.tipo === 'm').length;
    const tiq = ['banco', 'bizum'].includes(tipoHistorial) ? '' : (historial.total ? `${TICKETS.length} de ${historial.total} tiquets` : '');
    $('contadorHistorial').textContent = [tiq, movs ? `${movs} del banco` : ''].filter(Boolean).join(' · ');
    if (lista.length === 0 && !historial.cargando) $('estadoCarga').textContent = 'Nada con estos filtros.';
    pintarTotalBusqueda();
}

/**
 * Con búsqueda o filtros puestos: cuánto suma lo que se ve. Los tiquets salen
 * del servidor (todos los que encajan, no solo la página cargada); el banco se
 * cuenta aquí, con los mismos filtros que la lista.
 */
function pintarTotalBusqueda() {
    const caja = $('totalBusqueda');
    const hayFiltro = $('fBuscar').value.trim() || $('fDesde').value || $('fHasta').value ||
        $('fMin').value || $('fMax').value || $('fCategoriaFiltro').value.trim() || $('fTipoFiltro').value.trim() ||
        $('fEstadoFiltro').value || Object.keys(filtrosExtra).length || tipoHistorial;
    if (!hayFiltro) { caja.classList.add('hidden'); return; }

    const conTiquets = !['banco', 'bizum'].includes(tipoHistorial);
    const movs = movimientosVisibles();
    const parteDe = (m) => m.compartido_entre > 1
        ? (m.mi_parte_centimos != null ? Math.min(m.mi_parte_centimos, -m.importe_centimos) : Math.round(-m.importe_centimos / m.compartido_entre))
        : -m.importe_centimos;
    const cuenta = (m) => m.importe_centimos < 0 && !m.excluir && !esBizum(m) && m.clase !== 'devolucion';
    const pagos = movs.filter(cuenta);
    const bizSale = movs.filter(m => m.clase === 'bizum_enviado' && !m.excluir);
    const bizEntra = movs.filter(m => m.clase === 'bizum_recibido');
    const ingresos = movs.filter(m => m.importe_centimos > 0 && !esBizum(m) && m.clase !== 'devolucion');
    const suma = (l, f = (m) => Math.abs(m.importe_centimos)) => l.reduce((t, m) => t + f(m), 0);

    const gasto = (conTiquets ? (historial.suma || 0) : 0) + suma(pagos, parteDe) + suma(bizSale, parteDe);
    const partes = [];
    if (conTiquets && historial.total) partes.push(plural(historial.total, 'tiquet'));
    if (pagos.length) partes.push(plural(pagos.length, 'pago', 'pagos') + ' del banco');
    if (bizSale.length) partes.push(plural(bizSale.length, 'Bizum enviado', 'Bizum enviados'));
    caja.innerHTML = `
        <span>Gasto <b class="gasto">${esc(formatearImporte(gasto))}</b>${partes.length ? ` <span style="color:var(--texto-2)">(${esc(partes.join(', '))})</span>` : ''}</span>
        ${bizSale.length || bizEntra.length ? `<span>Bizum <b class="sale">−${esc(formatearImporte(suma(bizSale)))}</b> / <b class="entra">+${esc(formatearImporte(suma(bizEntra)))}</b>
            <span style="color:var(--texto-2)">(${bizSale.length} enviados, ${bizEntra.length} recibidos)</span></span>` : ''}
        ${ingresos.length ? `<span>Ingresos <b class="entra">+${esc(formatearImporte(suma(ingresos)))}</b></span>` : ''}`;
    caja.classList.remove('hidden');
}

/**
 * Una fila: comercio e importe arriba; cuándo y de qué es, debajo y en tono de
 * apoyo. Nada más.
 *
 * Lo que NO va aquí: el id, el número de tiquet dentro de la foto y la foto
 * misma. Son datos de trazabilidad, no de reconocimiento: no ayudan a encontrar
 * de un vistazo "el del jueves en Mercadona" y compiten por el poco ancho que
 * tiene la columna. Viven en el editor.
 */
/** Mi parte de un tiquet compartido (en su moneda), o null si no lo es. */
function miParteCentimos(t) {
    if (!(t.compartido_entre > 1) || t.total_centimos == null) return null;
    if (t.mi_parte_centimos != null) return Math.min(t.mi_parte_centimos, t.total_centimos);
    return Math.round(t.total_centimos / t.compartido_entre);
}

function pintarFila(t) {
    const estado = ESTADOS[t.estado] || ESTADOS.procesado;
    const enProceso = REINTENTANDO.has(t.id);
    // Solo los estados que piden algo llevan marca; 'procesado' es lo normal y
    // señalar lo normal es ruido.
    const marca = estado.color === 'transparent'
        ? ''
        : `<span class="marca-estado" style="background: ${estado.color}" title="${esc(estado.texto)}"></span>`;

    const nombre = t.establecimiento_nombre || 'Sin comercio';
    const sinExtraer = t.estado === 'pendiente' || t.estado === 'error';
    // Compartido: lo que pagué yo, y el total del papel al lado.
    const parte = miParteCentimos(t);
    const importe = parte !== null
        ? `${formatearImporte(parte, t.moneda)}`
        : formatearImporte(t.total_centimos, t.moneda);

    // La categoría dice más que el tipo de documento; el tipo es el relevo
    // cuando no hay categoría.
    const apoyo = [
        formatearFechaTiquet(t.fecha_compra),
        t.categoria || t.tipo_documento || null
    ].filter(Boolean).map(esc).join(' · ');

    return `
    <button type="button" class="fila-tiquet con-tipo${enProceso ? ' reintentando' : ''}"
            data-accion="editar" data-id="${t.id}">
        ${insigniaTipo('tiquet', TIQUETS_BANCO.has(t.id) ? 'Tiquet confirmado por el banco' : 'Tiquet')}
        <span class="titulo-fila font-medium"><span class="truncate">${marca}${esc(nombre)}</span>${TIQUETS_BANCO.has(t.id)
            ? '<span class="marca-banco" title="Confirmado por el banco: hay un pago con tarjeta que casa con este tiquet"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>Banco</span>' : ''}</span>
        <span class="cifra whitespace-nowrap ${sinExtraer ? '' : 'font-medium'}"
              style="${sinExtraer ? 'color: var(--texto-2)' : ''}">${
                  enProceso ? 'analizando…' : (sinExtraer ? 'sin procesar' : esc(importe))}</span>
        <span class="fila-apoyo text-xs truncate" style="color: var(--texto-2)">${t.categoria ? iconoCategoria(t.categoria, 'icono-cat icono-cat-sm') : ''}${apoyo}${
            parte !== null ? ` · de ${esc(formatearImporte(t.total_centimos, t.moneda))} entre ${t.compartido_entre}` : ''}</span>
        ${enProceso ? `<span class="barra-fila"><span class="progreso indeterminado"><i></i></span></span>` : ''}
    </button>`;
}

// Un solo listener para toda la lista.
$('listaTickets').addEventListener('click', (ev) => {
    const boton = ev.target.closest('[data-accion="editar"]');
    if (boton) { Editor.abrirPorIds([Number(boton.dataset.id)]); return; }
    const mov = ev.target.closest('[data-accion="mov"]');
    if (mov) abrirMovimiento(Number(mov.dataset.mov));
});

// --- Historial unificado: tiquets + banco -----------------------------------------
// Los movimientos del banco que NO tienen tiquet (los que sí lo tienen ya están
// en la lista como su tiquet, con la marca verde) se mezclan con los tiquets por
// la misma ordenación. Se piden de una vez: son pocos cientos al año.

const ICONOS_TIPO = {
    tiquet:  '<path d="M6 3h12v18l-2-1.4-2 1.4-2-1.4-2 1.4-2-1.4L6 21z"/><path d="M9 8h6M9 12h6"/>',
    tarjeta: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M3 10h18M7 14.5h3"/>',
    salida:  '<path d="M7 17 17 7M9 7h8v8"/>',
    entrada: '<path d="M17 7 7 17M15 17H7V9"/>',
    banco:   '<path d="M3 9.5 12 4l9 5.5"/><path d="M5 10v7M9.5 10v7M14.5 10v7M19 10v7M3.5 20h17"/>'
};
/** La insignia de la izquierda de cada fila del historial: icono y texto. */
// Abreviado: la insignia no puede ser más alta que las dos líneas de texto de
// la fila, o las separa. El nombre entero va en el title.
const TEXTO_TIPO = { tiquet: 'Tiq', tarjeta: 'Tarj', salida: 'Biz', entrada: 'Biz', banco: 'Bco' };
const NOMBRE_TIPO = { tiquet: 'Tiquet', tarjeta: 'Pago con tarjeta', salida: 'Bizum enviado', entrada: 'Bizum recibido', banco: 'Banco' };
const insigniaTipo = (tipo, titulo = '') => `<span class="tipo-fila tipo-${tipo}" title="${esc(titulo || NOMBRE_TIPO[tipo])}">` +
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" ` +
    `stroke-linejoin="round" aria-hidden="true">${ICONOS_TIPO[tipo]}</svg><small>${TEXTO_TIPO[tipo]}</small></span>`;

const iconoTipo = (tipo) => `<svg class="icono-tipo" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
    `stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONOS_TIPO[tipo]}</svg>`;

let BANCO_MOVS = [];
let tipoHistorial = '';

async function cargarMovimientosHistorial() {
    try {
        const r = await api('/api/banco/movimientos?filtro=historial&limite=10000');
        BANCO_MOVS = r.ok ? ((await r.json()).movimientos || []) : [];
    } catch (_) { BANCO_MOVS = []; }
}

const esBizum = (m) => String(m.clase || '').startsWith('bizum');
function tipoDeMovimiento(m) {
    if (m.clase === 'bizum_enviado') return 'salida';
    if (m.clase === 'bizum_recibido') return 'entrada';
    if (m.clase === 'tarjeta' || m.clase === 'devolucion') return 'tarjeta';
    return 'banco';
}
const ETIQUETA_MOV = {
    tarjeta: 'Pago con tarjeta · sin tiquet', bizum_enviado: 'Bizum enviado', bizum_recibido: 'Bizum recibido',
    transferencia_enviada: 'Transferencia enviada', transferencia_recibida: 'Transferencia recibida',
    recibo: 'Recibo', comision: 'Comisión', devolucion: 'Devolución', otro: 'Banco'
};

/** Los movimientos que pasan los filtros del historial. */
function movimientosVisibles() {
    if (tipoHistorial === 'tiquets') return [];
    // Filtros que solo existen para tiquets: con ellos puestos, el banco no sale.
    if ($('fTipoFiltro').value.trim() || $('fEstadoFiltro').value || Object.keys(filtrosExtra).length) return [];
    const categoria = $('fCategoriaFiltro').value.trim().toUpperCase();
    const texto = sinAcentos($('fBuscar').value.trim());
    const palabras = texto.split(/\s+/).filter(Boolean);
    const desde = $('fDesde').value, hasta = $('fHasta').value;
    const min = eurosACentimos($('fMin').value), max = eurosACentimos($('fMax').value);
    return BANCO_MOVS.filter(m => {
        if (categoria && String(m.categoria || '').toUpperCase() !== categoria) return false;
        if (tipoHistorial === 'bizum' && !esBizum(m)) return false;
        if (tipoHistorial === 'banco' && esBizum(m)) return false;
        if (desde && m.fecha < desde) return false;
        if (hasta && m.fecha > hasta) return false;
        const imp = Math.abs(m.importe_centimos);
        if (min !== null && imp < min) return false;
        if (max !== null && imp > max) return false;
        if (palabras.length) {
            const pajar = sinAcentos([m.nombre, m.comercio, m.persona, m.nota, m.concepto, m.poblacion, m.categoria, ETIQUETA_MOV[m.clase]].join(' '));
            if (!palabras.every(p => pajar.includes(p))) return false;
        }
        return true;
    });
}

/** Tiquets y movimientos en una sola lista, con la ordenación elegida. */
function listaMezclada() {
    const [orden, dir] = ($('fOrden').value || 'fecha|desc').split('|');
    const tiquets = ['banco', 'bizum'].includes(tipoHistorial) ? [] : TICKETS.map(t => ({ tipo: 't', t }));
    const movs = movimientosVisibles().map(m => ({ tipo: 'm', m }));
    const clave = (x) => {
        if (orden === 'importe') return x.tipo === 't' ? (miParteCentimos(x.t) ?? x.t.total_centimos ?? 0) : Math.abs(x.m.importe_centimos);
        if (orden === 'subida' && x.tipo === 't') return String(x.t.created_at || '');
        return x.tipo === 't' ? String(x.t.fecha_compra || '') : String(x.m.fecha);
    };
    const signo = dir === 'asc' ? 1 : -1;
    const comparar = (a, b) => {
        const ka = clave(a), kb = clave(b);
        return (ka < kb ? -1 : ka > kb ? 1 : 0) * signo;
    };
    let todo = tiquets.concat(movs).sort(comparar);
    // Mientras queden tiquets por cargar, los movimientos que irían DESPUÉS del
    // último tiquet cargado esperan a la siguiente página: si no, se colarían
    // antes de tiquets que aún no han llegado.
    if (historial.hayMas && tiquets.length) {
        const ultimo = tiquets[tiquets.length - 1];
        todo = todo.filter(x => x.tipo === 't' || comparar(x, ultimo) <= 0);
    }
    return todo;
}

function pintarFilaBanco(m) {
    const tipo = tipoDeMovimiento(m);
    const entrada = m.importe_centimos > 0;
    const titulo = m.nombre || m.comercio || m.persona || m.concepto || 'Movimiento';
    // Compartido: se ve mi parte, y el total del cargo en la línea de abajo.
    const parte = m.importe_centimos < 0 && m.compartido_entre > 1
        ? (m.mi_parte_centimos != null ? Math.min(m.mi_parte_centimos, -m.importe_centimos)
                                       : Math.round(-m.importe_centimos / m.compartido_entre))
        : null;
    const apoyo = [formatearFechaTiquet(m.fecha), ETIQUETA_MOV[m.clase] || 'Banco',
                   m.nota && esBizum(m) ? m.nota : m.poblacion, m.excluir ? 'no cuenta como gasto' : null,
                   parte !== null ? `de ${formatearImporte(-m.importe_centimos, m.moneda)} entre ${m.compartido_entre}` : null]
        .filter(Boolean).map(esc).join(' · ');
    return `
    <button type="button" class="fila-tiquet con-tipo fila-banco${m.excluir ? ' no-cuenta' : ''}" data-accion="mov" data-mov="${m.id}">
        ${insigniaTipo(tipo, ETIQUETA_MOV[m.clase])}
        <span class="truncate font-medium">${esc(titulo)}</span>
        <span class="cifra whitespace-nowrap font-medium${entrada ? ' importe-entrada' : ''}">${
            entrada ? '+' : ''}${esc(formatearImporte(parte ?? Math.abs(m.importe_centimos), m.moneda))}</span>
        <span class="fila-apoyo text-xs truncate" style="color: var(--texto-2)">${
            m.categoria ? iconoCategoria(m.categoria, 'icono-cat icono-cat-sm') : ''}${apoyo}${m.categoria ? ` · ${esc(m.categoria)}` : ''}</span>
    </button>`;
}

$('tipoHistorial').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-tipo-hist]');
    if (!b) return;
    tipoHistorial = b.dataset.tipoHist;
    for (const x of $('tipoHistorial').querySelectorAll('[data-tipo-hist]')) x.setAttribute('aria-selected', String(x === b));
    pintarHistorial();
});

// --- Suscripciones -----------------------------------------------------------------
// Las detectadas por el banco y las que añado yo. En la lista se confirman, se
// descartan o se corrigen; en el calendario, cada cobro que viene es un puntito
// del color de la suscripción arriba a la derecha de su día.

let SUSCRIPCIONES = [];
let SUS_POR_DIA = new Map();        // 'AAAA-MM-DD' -> [suscripciones que se cobran]
const RITMO_SUS = { mensual: 'cada mes', trimestral: 'cada 3 meses', anual: 'cada año' };
const MESES_SUS = { mensual: 1, trimestral: 3, anual: 12 };
const COLORES_SUS = ['--cat-suscripciones', '--cat-ocio', '--cat-transporte', '--cat-electronica', '--cat-ropa',
                     '--cat-salud', '--cat-hogar', '--cat-r1', '--cat-r2', '--cat-restauracion'];
function colorSuscripcion(s) {
    let h = 0;
    for (const ch of String(s.nombre || s.clave)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return `var(${COLORES_SUS[h % COLORES_SUS.length]})`;
}
function sumarMesesIso(fecha, n) {
    const [a, m, d] = fecha.split('-').map(Number);
    const ultimo = new Date(a, m - 1 + n + 1, 0).getDate();
    return iso(new Date(a, m - 1 + n, Math.min(d, ultimo)));
}

/** Los próximos cobros de las activas, de hoy a 14 meses vista. */
function calcularCobrosSuscripciones() {
    SUS_POR_DIA = new Map();
    const hoy = iso(hoyLocal());
    const limite = sumarMesesIso(hoy, 14);
    for (const s of SUSCRIPCIONES) {
        if (!s.activa || !s.proximo) continue;
        for (let n = 0, f = s.proximo; f <= limite && n < 40; n += 1, f = sumarMesesIso(s.proximo, (MESES_SUS[s.ritmo] || 1) * n)) {
            if (f < hoy) continue;
            if (!SUS_POR_DIA.has(f)) SUS_POR_DIA.set(f, []);
            SUS_POR_DIA.get(f).push(s);
        }
    }
}

function puntosSuscripcion(dia) {
    const lista = SUS_POR_DIA.get(dia);
    if (!lista || !lista.length) return '';
    return `<span class="puntos-sus" aria-hidden="true">${lista.slice(0, 3)
        .map(s => `<i style="--c: ${colorSuscripcion(s)}"></i>`).join('')}</span>`;
}

async function cargarSuscripciones() {
    try {
        const r = await api('/api/banco/suscripciones');
        SUSCRIPCIONES = r.ok ? ((await r.json()).suscripciones || []) : [];
    } catch (_) { SUSCRIPCIONES = []; }
    calcularCobrosSuscripciones();
    pintarSuscripcionesPanel();
    if (Tiempo.periodo === 'mes' && ultimoMes) pintarMes(...ultimoMes);
}

function pintarSuscripcionesPanel() {
    const activas = SUSCRIPCIONES.filter(s => s.activa && s.estado !== 'descartada');
    const deBaja = SUSCRIPCIONES.filter(s => !s.activa && s.estado !== 'descartada');
    const descartadas = SUSCRIPCIONES.filter(s => s.estado === 'descartada');
    const confirmadas = activas.filter(s => s.estado === 'confirmada');
    const total = confirmadas.reduce((n, s) => n + (s.mensual_centimos || 0), 0);
    const porRevisar = activas.length - confirmadas.length;
    $('susResumen').textContent = [
        confirmadas.length ? `${formatearImporte(total)} al mes` : null,
        porRevisar ? `${porRevisar} por revisar` : null
    ].filter(Boolean).join(' · ');

    const fila = (s) => {
        const detectada = s.estado === 'detectada';
        const meta = [
            detectada ? '<span class="pregunta">¿Es una suscripción?</span>' : null,
            esc(RITMO_SUS[s.ritmo] || ''),
            s.activa ? `próximo: ${esc(fechaCorta(s.proximo))}` : 'parece dada de baja',
            s.subida ? 'ha subido de precio' : null,
            s.origen === 'manual' ? 'añadida a mano' : null
        ].filter(Boolean).join(' · ');
        const acciones = detectada
            ? `<button type="button" class="si" data-sus-accion="confirmar" title="Sí, es una suscripción">✓</button>
               <button type="button" class="no" data-sus-accion="descartar" title="No es una suscripción">✕</button>`
            : `<button type="button" data-sus-accion="editar" title="Corregir">Editar</button>
               <button type="button" class="no" data-sus-accion="${s.origen === 'manual' ? 'borrar' : 'descartar'}"
                       title="${s.origen === 'manual' ? 'Quitar' : 'No es una suscripción'}">✕</button>`;
        return `
        <div class="sus-fila${s.activa ? '' : ' de-baja'}" data-clave="${esc(s.clave)}">
            <span class="sus-punto" style="--c: ${colorSuscripcion(s)}"></span>
            <span class="min-w-0"><span class="sus-nombre truncate block">${esc(s.nombre || s.comercio)}</span>
                <span class="sus-meta">${meta}</span></span>
            <span class="cifra font-semibold whitespace-nowrap">${esc(formatearImporte(s.importe_medio_centimos || s.importe_centimos))}</span>
            <span class="sus-acciones">${acciones}</span>
        </div>`;
    };
    $('susLista').innerHTML = activas.length || deBaja.length
        ? activas.concat(deBaja).map(fila).join('')
        : '<p class="vacio-discreto">Ninguna todavía. Añade las que tengas con "+ Añadir" o desde la ficha de un movimiento.</p>';
    $('susDescartadasCaja').classList.toggle('hidden', !descartadas.length);
    $('susDescartadasTitulo').textContent = `${plural(descartadas.length, 'descartada')} (no son suscripciones)`;
    $('susDescartadas').innerHTML = descartadas.map(s => `
        <div class="sus-fila de-baja" data-clave="${esc(s.clave)}">
            <span class="sus-punto" style="--c: var(--texto-2)"></span>
            <span class="sus-nombre truncate">${esc(s.nombre || s.comercio)}</span>
            <span class="cifra whitespace-nowrap">${esc(formatearImporte(s.importe_medio_centimos || s.importe_centimos))}</span>
            <span class="sus-acciones"><button type="button" data-sus-accion="recuperar" title="Volver a tenerla en cuenta">Recuperar</button></span>
        </div>`).join('');
}

async function guardarSuscripcion(metodo, url, cuerpo) {
    const r = await api(url, { method: metodo, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo) });
    const datos = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(datos.error || 'No se ha podido guardar.');
    SUSCRIPCIONES = datos.suscripciones || SUSCRIPCIONES;
    calcularCobrosSuscripciones();
    pintarSuscripcionesPanel();
    if (Tiempo.periodo === 'mes' && ultimoMes) pintarMes(...ultimoMes);
    cargarResumenBanco();      // la previsión del mes cuenta con ellas
}

async function accionSuscripcion(ev) {
    const b = ev.target.closest('[data-sus-accion]');
    if (!b) return;
    const clave = b.closest('[data-clave]').dataset.clave;
    const s = SUSCRIPCIONES.find(x => x.clave === clave);
    const url = `/api/banco/suscripciones/${encodeURIComponent(clave)}`;
    try {
        switch (b.dataset.susAccion) {
            case 'confirmar': await guardarSuscripcion('PUT', url, { estado: 'confirmada' }); aviso('Suscripción confirmada'); break;
            case 'descartar': await guardarSuscripcion('PUT', url, { estado: 'descartada' }); aviso('Descartada: no cuenta como suscripción'); break;
            case 'recuperar':
            case 'borrar':    await guardarSuscripcion('PUT', url, { estado: null }); break;
            case 'editar':    abrirSuscripcion({ s }); break;
        }
    } catch (err) {
        if (err && err.message !== 'sin sesion') aviso(err.message);
    }
}
$('susLista').addEventListener('click', accionSuscripcion);
$('susDescartadas').addEventListener('click', accionSuscripcion);

// La ficha: nueva (a mano o desde un movimiento) o corregir una existente.
let susEditando = null;      // { s } al corregir, { movimiento } al crear desde uno, {} nueva
function abrirSuscripcion(modo = {}) {
    susEditando = modo;
    const s = modo.s, m = modo.movimiento;
    ponerTipoFicha($('susTipo'), 'sus');
    $('susTitulo').textContent = s ? (s.nombre || s.comercio) : 'Nueva suscripción';
    $('susNombre').value = s ? (s.nombre || s.comercio) : m ? (m.nombre || m.comercio || '') : '';
    const importe = s ? (s.importe_medio_centimos || s.importe_centimos) : m ? Math.abs(m.importe_centimos) : null;
    $('susImporte').value = importe != null ? centimosAEuros(importe) : '';
    $('susRitmo').value = s ? (s.ritmo || 'mensual') : 'mensual';
    $('susRitmo').__pintar();
    $('susProximo').value = s ? (s.proximo || '') : m ? sumarMesesIso(m.fecha, 1) : '';
    $('susError').classList.add('hidden');
    $('susOverlay').classList.remove('hidden');
    document.body.classList.add('overflow-hidden');
    pintarVolver('susOverlay');
    setTimeout(() => $('susNombre').focus(), 50);
}
function cerrarSuscripcion() {
    $('susOverlay').classList.add('hidden');
    susEditando = null;
    if (volverDeFicha()) return;
    if (!fichaVisible() && $('bancoOverlay').classList.contains('hidden')) document.body.classList.remove('overflow-hidden');
}
selectBonito($('susRitmo'));
$('susAnadir').addEventListener('click', () => abrirSuscripcion({}));
$('susCerrar').addEventListener('click', cerrarSuscripcion);
$('susCancelar').addEventListener('click', cerrarSuscripcion);
$('susOverlay').addEventListener('click', (ev) => { if (ev.target === $('susOverlay')) cerrarSuscripcion(); });
// Al cambiar el ritmo de una que ya tiene fecha, la fecha se queda: es el próximo cobro.
$('susGuardar').addEventListener('click', async () => {
    if (!susEditando) return;
    const cuerpo = {
        nombre: $('susNombre').value.trim(),
        importe_centimos: $('susImporte').value.trim() !== '' ? eurosACentimos($('susImporte').value) : null,
        ritmo: $('susRitmo').value,
        proximo: $('susProximo').value || null
    };
    if (!cuerpo.nombre) {
        $('susError').textContent = 'Ponle un nombre.';
        $('susError').classList.remove('hidden');
        return;
    }
    $('susGuardar').disabled = true;
    try {
        const { s, movimiento } = susEditando;
        if (s) await guardarSuscripcion('PUT', `/api/banco/suscripciones/${encodeURIComponent(s.clave)}`, { estado: 'confirmada', ...cuerpo });
        else await guardarSuscripcion('POST', '/api/banco/suscripciones', { ...cuerpo, movimiento_id: movimiento ? movimiento.id : null });
        cerrarSuscripcion();
        aviso('Suscripción guardada');
    } catch (err) {
        if (err && err.message !== 'sin sesion') {
            $('susError').textContent = err.message;
            $('susError').classList.remove('hidden');
        }
    } finally {
        $('susGuardar').disabled = false;
    }
});

// --- Fichas: cabecera, navegación con "volver" y plegables ---------------------------
// Tiquet, movimiento, establecimiento y suscripción comparten esqueleto. Desde
// una ficha se puede abrir otra (el establecimiento de un movimiento, el tiquet
// de un establecimiento…): la de origen se ESCONDE sin perder lo escrito y la
// nueva enseña "← volver a …". Así solo hay una ficha a la vista.

const ICONOS_FICHA = {
    ...ICONOS_TIPO,
    est: '<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>',
    sus: '<path d="M20 11a8 8 0 0 0-14.5-4.6L4 8"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.5 4.6L20 16"/><path d="M20 20v-4h-4"/>'
};
const NOMBRE_FICHA = { tiquet: 'Tiquet', tarjeta: 'Pago con tarjeta', salida: 'Bizum enviado', entrada: 'Bizum recibido',
                       banco: 'Banco', est: 'Establecimiento', sus: 'Suscripción' };
function ponerTipoFicha(el, tipo, texto = null) {
    el.className = `ficha-tipo tipo-${tipo}`;
    el.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ` +
        `stroke-linejoin="round" aria-hidden="true">${ICONOS_FICHA[tipo] || ''}</svg>${esc(texto || NOMBRE_FICHA[tipo] || '')}`;
}

const FICHAS = ['susOverlay', 'movOverlay', 'estOverlay', 'editorOverlay'];
const CERRAR_FICHA = {
    editorOverlay: () => Editor.intentarCerrar(),
    movOverlay: () => cerrarMovimiento(),
    estOverlay: () => cerrarEstablecimiento(),
    susOverlay: () => cerrarSuscripcion()
};
const PILA_FICHAS = [];
const fichaVisible = () => FICHAS.find(id => !$(id).classList.contains('hidden')) || null;

/**
 * Antes de abrir `destinoId` desde la ficha que se ve: esa se esconde (con lo
 * escrito) y se apunta para volver. `alVolver` se llama al regresar a ella.
 */
function apilarFicha(destinoId, etiqueta, alVolver = null) {
    const origen = fichaVisible();
    if (!origen || origen === destinoId) return;
    const i = PILA_FICHAS.findIndex(f => f.overlayId === destinoId);
    // Ya estaba más abajo (movimiento → establecimiento → otro movimiento): se
    // reutiliza esa ficha y lo de encima se olvida, para no dar vueltas.
    if (i >= 0) PILA_FICHAS.splice(i);
    else PILA_FICHAS.push({ overlayId: origen, etiqueta, alVolver });
    $(origen).classList.add('hidden');
}
/** Al cerrar una ficha: si se llegó desde otra, se vuelve a ella. */
function volverDeFicha() {
    const f = PILA_FICHAS.pop();
    if (!f) return false;
    $(f.overlayId).classList.remove('hidden');
    document.body.classList.add('overflow-hidden');
    pintarVolver(f.overlayId);
    if (f.alVolver) { try { f.alVolver(); } catch (_) { /* nada */ } }
    return true;
}
function pintarVolver(overlayId) {
    // El contenido nuevo entra con un fundido corto: al pasar de una ficha a
    // otra o al repintarla (elegir un sitio) no hay un cambio de golpe.
    suavizarFicha(overlayId);
    const b = $(overlayId).querySelector('.ficha-volver');
    if (!b) return;
    const arriba = PILA_FICHAS[PILA_FICHAS.length - 1];
    b.classList.toggle('hidden', !arriba);
    b.innerHTML = arriba ? `← <span>${esc(arriba.etiqueta)}</span>` : '';
}
// Pulsar fuera de una ventana la cierra, pero solo si la pulsación EMPIEZA
// fuera. Al seleccionar texto dentro y soltar fuera, el navegador manda el clic
// al velo (el antepasado común) y la ventana se cerraba sola.
let inicioPulsacion = null;
document.addEventListener('pointerdown', (ev) => { inicioPulsacion = ev.target; }, true);
document.addEventListener('click', (ev) => {
    const t = ev.target;
    if (t && t.classList && t.classList.contains('modal-velo') && inicioPulsacion !== t) ev.stopPropagation();
}, true);

function suavizarFicha(overlayId) {
    const panel = $(overlayId).querySelector('.modal-panel');
    if (!panel || !panel.animate || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    for (const parte of panel.querySelectorAll(':scope > .modal-cabecera, :scope > .modal-cuerpo')) {
        parte.animate([{ opacity: 0.25, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }],
            { duration: 180, easing: 'ease-out' });
    }
}
document.addEventListener('click', (ev) => {
    const b = ev.target.closest('.ficha-volver');
    if (!b) return;
    const ficha = b.closest('[id$="Overlay"]');
    if (ficha && CERRAR_FICHA[ficha.id]) CERRAR_FICHA[ficha.id]();
});

// Los plegables recuerdan si los dejé abiertos (solo lo que abro o cierro yo).
for (const d of document.querySelectorAll('details.plegable[id]')) {
    try { const v = localStorage.getItem(`plegable:${d.id}`); if (v !== null) d.open = v === '1'; } catch (_) { /* nada */ }
    d.querySelector('summary').addEventListener('click', () => setTimeout(() => {
        try { localStorage.setItem(`plegable:${d.id}`, d.open ? '1' : '0'); } catch (_) { /* nada */ }
    }, 0));
}
/** El valor que enseña un plegable cerrado ("entre 2 · tu parte 1,40 €"). */
function valorPlegable(id, html) {
    const v = $(id) && $(id).querySelector('.pl-valor');
    if (v) v.innerHTML = html;
}

// --- Buscador unificado de establecimientos ---------------------------------------
// Uno para todo: tus establecimientos al escribir, Google Maps al pulsar (cada
// búsqueda gasta cupo) y crear uno nuevo. Qué hace elegir depende de la ficha:
// asignar (tiquet, movimiento), unir o "es este sitio" (establecimiento).

function crearBuscadorEst({
    input, flecha = null, excluir = () => null,
    textoGoogle = () => input.value.trim(), buscarGoogle = null,
    accionTuyo = 'Elegir', accionGoogle = 'Es este', accionCrear = 'Crear',
    alTuyo, alGoogle, alCrear = null
}) {
    const panel = document.createElement('div');
    panel.className = 'buscador-est hidden';
    input.parentElement.appendChild(panel);
    let google = null, buscando = false, errorGoogle = '', filas = [], activa = -1;
    // Recién entrado en el campo (sin escribir) se enseñan todos, no solo el
    // que ya pone: si no, para cambiarlo habría que borrar el nombre primero.
    let filtrar = false;

    const tuyos = () => {
        const texto = filtrar ? sinAcentos(input.value.trim()) : '';
        const palabras = texto.split(/\s+/).filter(Boolean);
        const fuera = excluir();
        return (ESTABLECIMIENTOS || []).filter(e => e.id !== fuera && palabras.every(p =>
            sinAcentos(`${e.nombre} ${e.ciudad || ''} ${e.direccion || ''}`).includes(p))).slice(0, 8);
    };
    function pintar() {
        filas = [];
        const partes = [];
        const lista = tuyos();
        partes.push('<div class="bq-grupo">Tus establecimientos</div>');
        if (lista.length) {
            for (const e of lista) {
                filas.push({ tipo: 'tuyo', dato: e });
                partes.push(`<div class="bq-fila" data-i="${filas.length - 1}">
                    <span class="bq-nombre">${esc(e.nombre)}</span>
                    <span class="bq-donde">${esc(dondeEsta(e))} · ${cuentaEst(e)}</span>
                    <span class="bq-accion">${esc(accionTuyo)}</span></div>`);
            }
        } else partes.push(`<div class="bq-vacio">${ESTABLECIMIENTOS ? 'Ninguno coincide.' : 'Cargando…'}</div>`);

        if (buscarGoogle) {
            const activaG = !GOOGLE_PLACES || GOOGLE_PLACES.activa;
            partes.push(`<div class="bq-grupo"><span>En Google Maps</span>${activaG
                ? `<button type="button" class="bq-boton" data-bq-google ${buscando ? 'disabled' : ''}>${buscando ? 'Buscando…' : 'Buscar en Google'}</button>`
                : '<span>desactivado</span>'}</div>`);
            if (errorGoogle) partes.push(`<div class="bq-vacio">${esc(errorGoogle)}</div>`);
            else if (google && !google.length) partes.push('<div class="bq-vacio">Google no ha encontrado nada con eso.</div>');
            for (const c of google || []) {
                const ya = (ESTABLECIMIENTOS || []).find(e => e.place_id === c.place_id && e.id !== excluir());
                filas.push(ya ? { tipo: 'tuyo', dato: ya } : { tipo: 'google', dato: c });
                partes.push(`<div class="bq-fila" data-i="${filas.length - 1}">
                    <span class="bq-nombre">${esc(c.nombre)}${c.cerrado ? ' · cerrado' : ''}</span>
                    <span class="bq-donde">${esc(c.direccion_completa || '')}${ya ? ` · ya es ${esc(ya.nombre)}` : c.tipo ? ` · ${esc(c.tipo)}` : ''}</span>
                    ${botonMaps(c.url || `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(c.place_id)}`, 'Maps')}
                    <span class="bq-accion">${esc(ya ? accionTuyo : accionGoogle)}</span></div>`);
            }
        }
        const escrito = input.value.trim();
        if (alCrear && escrito && !lista.some(e => sinAcentos(e.nombre) === sinAcentos(escrito))) {
            filas.push({ tipo: 'crear', dato: escrito.toUpperCase() });
            partes.push(`<div class="bq-fila" data-i="${filas.length - 1}">
                <span class="bq-nombre">+ ${esc(accionCrear)} «${esc(escrito.toUpperCase())}»</span>
                <span class="bq-donde">Uno nuevo; se buscará en el mapa solo</span></div>`);
        }
        panel.innerHTML = partes.join('');
        activa = -1;
    }
    const abierto = () => !panel.classList.contains('hidden');
    function abrir() {
        if (!ESTABLECIMIENTOS) cargarEstablecimientos().then(() => { if (abierto()) pintar(); });
        pintar();
        panel.classList.remove('hidden');
    }
    function cerrar() { panel.classList.add('hidden'); }
    async function buscar() {
        if (!buscarGoogle || buscando) return;
        const texto = textoGoogle();
        if (!texto) { errorGoogle = 'Escribe el nombre del sitio.'; pintar(); return; }
        buscando = true; errorGoogle = ''; pintar();
        try { google = (await buscarGoogle(texto)) || []; }
        catch (err) { errorGoogle = (err && err.message) || 'Google no ha respondido.'; google = null; }
        buscando = false;
        if (abierto()) pintar();
    }
    function elegir(i) {
        const f = filas[i];
        if (!f) return;
        cerrar();
        if (f.tipo === 'tuyo') alTuyo(f.dato);
        else if (f.tipo === 'google') alGoogle(f.dato);
        else if (alCrear) alCrear(f.dato);
    }

    // Al entrar, el texto queda marcado: escribir encima busca otro.
    input.addEventListener('focus', () => { filtrar = false; abrir(); setTimeout(() => input.select(), 0); });
    input.addEventListener('click', () => { if (!abierto()) { filtrar = false; abrir(); } });
    input.addEventListener('input', () => { filtrar = true; if (!abierto()) abrir(); else pintar(); });
    input.addEventListener('blur', () => setTimeout(cerrar, 160));
    input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape' && abierto()) { ev.stopPropagation(); cerrar(); return; }
        if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
            ev.preventDefault();
            if (!abierto()) abrir();
            const items = [...panel.querySelectorAll('.bq-fila')];
            if (!items.length) return;
            activa = (activa + (ev.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
            items.forEach((el, i) => el.setAttribute('aria-selected', String(i === activa)));
            items[activa].scrollIntoView({ block: 'nearest' });
        } else if (ev.key === 'Enter') {
            ev.preventDefault();
            if (activa >= 0) elegir(Number(panel.querySelectorAll('.bq-fila')[activa].dataset.i));
            else buscar();       // Intro sin elegir nada: a Google
        }
    });
    panel.addEventListener('mousedown', (ev) => {
        ev.preventDefault();        // que el campo no pierda el foco
        if (ev.target.closest('[data-bq-maps]')) return;     // el enlace a Maps se abre solo, sin elegir
        if (ev.target.closest('[data-bq-google]')) { buscar(); return; }
        const fila = ev.target.closest('.bq-fila');
        if (fila) elegir(Number(fila.dataset.i));
    });
    if (flecha) {
        flecha.addEventListener('mousedown', (ev) => {
            ev.preventDefault();
            if (abierto()) cerrar(); else { input.focus(); abrir(); }
        });
    }
    return {
        abrir, cerrar, buscar,
        /** Resultados de Google ya conocidos (los candidatos guardados, una búsqueda automática). */
        ponerGoogle(lista) { google = lista; errorGoogle = ''; if (abierto()) pintar(); },
        olvidarGoogle() { google = null; errorGoogle = ''; }
    };
}

// --- Comensales ---------------------------------------------------------------------
// Restaurantes de 25 € o más sin decir cuántos éramos (tiquets y cargos del banco
// sin tiquet). Se pregunta uno a uno; "Solo yo" guarda compartido_entre = 1, que
// es "revisado" y no vuelve a salir.

let COMENSALES = [];
const comensales = { cola: [], i: 0, total: 0, n: null };

async function cargarComensales() {
    try {
        COMENSALES = (await (await api('/api/estadisticas/comensales')).json()).pendientes || [];
    } catch (_) { return; }
    pintarChipComensales();
}

function pintarChipComensales() {
    const linea = $('lineaControl');
    const viejo = linea.querySelector('[data-comensales]');
    if (viejo) viejo.remove();
    if (!COMENSALES.length) return;
    linea.insertAdjacentHTML('afterbegin',
        `<button type="button" class="chip-control" data-comensales="1"><b>${COMENSALES.length}</b> ` +
        `${COMENSALES.length === 1 ? 'comida' : 'comidas'} por repartir</button>`);
}
$('lineaControl').addEventListener('click', (ev) => {
    if (ev.target.closest('[data-comensales]')) abrirComensales();
});

function abrirComensales() {
    if (!COMENSALES.length) return;
    comensales.cola = COMENSALES.slice();
    comensales.i = 0;
    comensales.total = comensales.cola.length;
    pintarComensal();
    $('comOverlay').classList.remove('hidden');
    document.body.classList.add('overflow-hidden');
}

function cerrarComensales() {
    $('comOverlay').classList.add('hidden');
    if ([$('editorOverlay'), $('bancoOverlay'), $('movOverlay')].every(o => o.classList.contains('hidden'))) {
        document.body.classList.remove('overflow-hidden');
    }
    cargarComensales();
}

function pintarComensal() {
    const g = comensales.cola[comensales.i];
    if (!g) { cerrarComensales(); aviso('Comidas repartidas'); return; }
    comensales.n = null;
    $('comProgreso').textContent = `${comensales.i + 1} de ${comensales.total} · restaurantes de 25 € o más sin repartir`;
    $('comOrigen').textContent = [fechaCorta(g.fecha), g.origen === 'banco' ? 'Pago con tarjeta' : 'Tiquet'].filter(Boolean).join(' · ');
    $('comNombre').textContent = g.nombre || 'Restaurante';
    $('comImporte').textContent = formatearImporte(g.total_centimos);
    $('comOpciones').innerHTML = [1, 2, 3, 4, 5, 6].map(n =>
        `<button type="button" data-com="${n}" aria-pressed="false">${n === 1 ? 'Solo yo' : n}</button>`).join('') +
        '<input id="comOtro" type="number" min="2" max="100" inputmode="numeric" class="campo cifra" placeholder="Más" aria-label="Otro número de comensales">';
    $('comMiParte').value = '';
    pintarResultadoComensal();
}

function pintarResultadoComensal() {
    const g = comensales.cola[comensales.i];
    const n = comensales.n;
    for (const b of $('comOpciones').querySelectorAll('[data-com]')) b.setAttribute('aria-pressed', String(Number(b.dataset.com) === n));
    $('comMiParte').disabled = !(n > 1);
    $('comGuardar').disabled = !n;
    if (!g || !n) { $('comResultado').textContent = 'Elige cuántos erais.'; $('comMiParte').placeholder = ''; return; }
    const igual = Math.round(g.total_centimos / Math.max(1, n));
    $('comMiParte').placeholder = n > 1 ? centimosAEuros(igual) : '';
    const parte = n > 1 && $('comMiParte').value.trim() !== '' ? eurosACentimos($('comMiParte').value) : igual;
    $('comResultado').innerHTML = n === 1 ? 'Cuenta entero como gasto tuyo.'
        : `Tu parte: <b class="cifra">${esc(formatearImporte(parte))}</b> de ${esc(formatearImporte(g.total_centimos))}`;
}

$('comOpciones').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-com]');
    if (!b) return;
    comensales.n = Number(b.dataset.com);
    $('comOtro').value = '';
    pintarResultadoComensal();
});
$('comOpciones').addEventListener('input', (ev) => {
    if (ev.target.id !== 'comOtro') return;
    const n = Math.round(Number(ev.target.value));
    comensales.n = Number.isFinite(n) && n >= 2 && n <= 100 ? n : null;
    pintarResultadoComensal();
});
$('comMiParte').addEventListener('input', pintarResultadoComensal);

$('comGuardar').addEventListener('click', async () => {
    const g = comensales.cola[comensales.i];
    const n = comensales.n;
    if (!g || !n) return;
    const cuerpo = {
        compartido_entre: n,
        mi_parte_centimos: n > 1 && $('comMiParte').value.trim() !== '' ? eurosACentimos($('comMiParte').value) : null
    };
    const url = g.origen === 'banco' ? `/api/banco/movimientos/${-g.id}` : `/api/tickets/${g.id}/compartido`;
    $('comGuardar').disabled = true;
    try {
        const r = await api(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo) });
        if (!r.ok) throw new Error('fallo');
    } catch (err) {
        if (err && err.message === 'sin sesion') return;
        $('comResultado').textContent = 'No se ha podido guardar. Vuelve a intentarlo.';
        $('comGuardar').disabled = false;
        return;
    }
    COMENSALES = COMENSALES.filter(x => !(x.id === g.id && x.origen === g.origen));
    comensales.i += 1;
    pintarComensal();
    // Las cifras y el historial, con la parte nueva.
    clearTimeout(comensales.refresco);
    comensales.refresco = setTimeout(async () => {
        cargarPanel();
        await cargarMovimientosHistorial();
        cargarHistorial({ reiniciar: true });
    }, 600);
});
$('comSaltar').addEventListener('click', () => { comensales.i += 1; pintarComensal(); });
$('comMasTarde').addEventListener('click', () => {
    try { sessionStorage.setItem('comensalesMasTarde', '1'); } catch (_) {}
    cerrarComensales();
});
$('comCerrar').addEventListener('click', () => $('comMasTarde').click());
$('comOverlay').addEventListener('click', (ev) => { if (ev.target === $('comOverlay')) $('comMasTarde').click(); });

// --- Ficha de un movimiento -------------------------------------------------------
// Los cambios (tipo, categoría, si cuenta, compartido, establecimiento) se
// aplican al pulsar Guardar, todos a la vez; Cancelar los descarta. Enlazar un
// tiquet sí es inmediato: es una acción, no un campo.

const NOMBRE_CLASE = {
    tarjeta: 'Pago con tarjeta', bizum_enviado: 'Bizum enviado', transferencia_enviada: 'Transferencia enviada',
    recibo: 'Recibo', comision: 'Comisión', bizum_recibido: 'Bizum recibido',
    transferencia_recibida: 'Transferencia recibida / ingreso', devolucion: 'Devolución o anulación', otro: 'Otro'
};
const CLASES_CARGO = ['tarjeta', 'bizum_enviado', 'transferencia_enviada', 'recibo', 'comision', 'otro'];
const CLASES_ABONO = ['bizum_recibido', 'transferencia_recibida', 'devolucion', 'otro'];
const ORIGEN_CATEGORIA = {
    manual: 'Puesta a mano.', regla: 'Por el tipo de movimiento o una regla.', tiquet: 'La de su tiquet.',
    comercio: 'La que tiene este comercio.', ia: 'Elegida por Gemini.'
};

let movAbierto = null;
let movPersonas = 2;
const etiquetaMov = () => `Movimiento · ${movAbierto ? (movAbierto.nombre || movAbierto.comercio || movAbierto.persona || '') : ''}`;
const esComercioMov = (m) => Boolean(m.comercio) && ['tarjeta', 'recibo', 'devolucion'].includes(m.clase);

async function abrirMovimiento(id) {
    let m;
    try { m = await (await api(`/api/banco/movimientos/${id}`)).json(); } catch (_) { return; }
    if (!m || !m.id) return;
    movAbierto = m;
    const cargo = m.importe_centimos < 0;
    ponerTipoFicha($('movTipoChip'), tipoDeMovimiento(m), NOMBRE_CLASE[m.clase] || 'Banco');
    $('movTitulo').textContent = m.nombre || m.comercio || m.persona || 'Movimiento';
    $('movSubtitulo').textContent = [fechaCorta(m.fecha), m.poblacion, esBizum(m) ? m.nota : null].filter(Boolean).join(' · ');
    $('movImporte').textContent = (cargo ? '' : '+') + formatearImporte(Math.abs(m.importe_centimos), m.moneda);
    $('movImporte').style.color = cargo ? '' : 'var(--g)';
    $('movConcepto').textContent = m.concepto || '';
    $('movError').classList.add('hidden');

    $('movTipo').innerHTML = (cargo ? CLASES_CARGO : CLASES_ABONO)
        .map(c => `<option value="${c}"${c === m.clase ? ' selected' : ''}>${NOMBRE_CLASE[c]}</option>`).join('');
    if (!$('movTipo').value) $('movTipo').value = 'otro';
    $('movTipo').__pintar();

    $('movCategoria').value = m.categoria || '';
    $('movCategoriaLista').classList.add('hidden');
    $('movCategoriaAyuda').title = ORIGEN_CATEGORIA[m.categoria_origen] || 'Sin categoría todavía.';

    $('movContarCaja').classList.toggle('hidden', !cargo);
    $('movContar').checked = !m.excluir;

    $('plMovCompartido').classList.toggle('hidden', !cargo);
    movPersonas = m.compartido_entre > 1 ? m.compartido_entre : 2;
    $('movCompartido').checked = m.compartido_entre > 1;
    $('movZonaCompartido').classList.toggle('hidden', !(m.compartido_entre > 1));
    $('movPersonas').textContent = String(movPersonas);
    $('movMiParte').value = m.mi_parte_centimos != null ? centimosAEuros(m.mi_parte_centimos) : '';
    actualizarParteMov();

    pintarDetallesMov(m);
    pintarEstablecimientoMov(m);
    pintarTiquetMov();
    $('movSuscripcion').classList.toggle('hidden', !(cargo && m.comercio));
    $('movOverlay').classList.remove('hidden');
    document.body.classList.add('overflow-hidden');
    pintarVolver('movOverlay');
}

function pintarTiquetMov() {
    const m = movAbierto;
    if (!m) return;
    const tarjeta = $('movTipo').value === 'tarjeta' && m.importe_centimos < 0;
    $('plMovTiquet').classList.toggle('hidden', !tarjeta);
    $('movCandidatos').innerHTML = '';
    $('movTiquetEstado').innerHTML = m.tiquet_id
        ? `<button type="button" class="chip-mov ok" data-abrir-tiquet-mov="${m.tiquet_id}">Enlazado con su tiquet: abrir</button>`
        : m.enlace === 'descartado' ? 'Marcado como sin tiquet.' : 'Sin tiquet enlazado.';
    valorPlegable('plMovTiquet', m.tiquet_id ? 'enlazado' : m.enlace === 'descartado' ? 'no tiene' : 'sin enlazar');
    $('plMovTiquet').classList.toggle('enlazado', !!m.tiquet_id);
    $('plMovTiquet').classList.toggle('sin-enlazar', !m.tiquet_id);
}
selectBonito($('movTipo'));
selectBonito($('modoReintento'), { arriba: true, ancho: '11rem' });
$('movTipo').addEventListener('change', pintarTiquetMov);

/** Todo lo que se sabe del movimiento, en una lista etiqueta → valor. */
function pintarDetallesMov(m) {
    const ORIGEN_NOMBRE = { tiquet: 'de un tiquet tuyo enlazado con un pago', ia: 'identificado por Gemini', manual: 'puesto a mano' };
    const TIPO_COMERCIO = { online: 'tienda online', cadena: 'cadena', local: 'negocio local' };
    const filas = [
        ['Nombre en el banco', [m.comercio, m.poblacion].filter(Boolean).join(' · ')],
        ['Nombre unificado', m.nombre && m.comercio ? [m.nombre, ORIGEN_NOMBRE[m.comercio_origen], TIPO_COMERCIO[m.comercio_tipo]].filter(Boolean).join(' · ')
            : (m.comercio && m.comercio_estado !== 'resuelto' ? 'pendiente de identificar' : null)],
        ['Persona', m.persona],
        ['Concepto del Bizum', m.nota],
        ['Contraparte', m.contraparte],
        ['Fecha', fechaCorta(m.fecha)],
        ['Fecha valor', m.fecha_valor && m.fecha_valor !== m.fecha ? fechaCorta(m.fecha_valor) : null],
        ['Cuenta', [m.cuenta_nombre, m.iban].filter(Boolean).join(' · ')],
        ['Código de comercio', m.codigo_comercio],
        ['Llegó', m.origen === 'fichero' ? 'del extracto importado' : m.origen === 'api' ? 'descargado del banco' : null]
    ].filter(([, v]) => v);
    $('movDetalles').innerHTML = filas.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
    valorPlegable('plMovDetalles', esc([m.comercio || m.persona, m.iban].filter(Boolean).join(' · ')));
}

// El establecimiento del comercio: lo que se sabe de él y el buscador para cambiarlo.
let movEstElegido = null;      // { id } | { place_id, nombre } | { nombre } elegido en el buscador
function pintarEstablecimientoMov(m) {
    $('plMovEst').classList.toggle('hidden', !esComercioMov(m));
    if (!esComercioMov(m)) return;
    const e = m.establecimiento;
    $('movEstablecimiento').value = e ? e.nombre : '';
    movEstElegido = null;
    buscadorMovEst.olvidarGoogle();
    pintarInfoEstMov(e, m);
    if (!ESTABLECIMIENTOS) cargarEstablecimientos();
}
async function refrescarEstMov() {
    if (!movAbierto) return;
    const movId = movAbierto.id;
    const fresco = await (await api(`/api/banco/movimientos/${movId}`)).json().catch(() => null);
    if (fresco && movAbierto && movAbierto.id === movId) {
        Object.assign(movAbierto, { establecimiento: fresco.establecimiento, nombre: fresco.nombre,
            est_propio: fresco.est_propio, pagos_comercio: fresco.pagos_comercio });
        pintarEstablecimientoMov(movAbierto);
        $('movTitulo').textContent = movAbierto.nombre || movAbierto.comercio || movAbierto.persona || 'Movimiento';
    }
}
/** Debajo del nombre: dónde está, o qué pasará al guardar si se ha cambiado. */
function pintarInfoEstMov(e, m, pendiente = '') {
    const p = $('movEstPunto');
    const verificado = !pendiente && !!e && e.google_estado === 'verificado';
    p.classList.toggle('si', verificado);
    p.title = verificado ? 'Verificado por Google' : 'No verificado por Google';
    $('movAbrirEst').classList.toggle('hidden', !!pendiente || !e);
    // Para todos los pagos del comercio solo si se marca (y se confirma al guardar).
    const otros = m ? (m.pagos_comercio || 0) - 1 : 0;
    $('movEstTodosCaja').classList.toggle('hidden', !pendiente || otros < 1);
    if (!pendiente) $('movEstTodos').checked = false;
    $('movEstTodosTexto').textContent = otros > 0
        ? `Cambiarlo también en ${otros === 1 ? 'el otro pago' : `los otros ${otros} pagos`} de «${m.comercio}»` : '';
    if (pendiente) {
        $('movEstInfo').innerHTML = `<span class="estado-ubic">${esc(pendiente)}</span>`;
        return;
    }
    if (!e) {
        $('movEstInfo').innerHTML = `<span class="estado-ubic">${m && m.comercio_estado === 'resuelto'
            ? 'Sin establecimiento.' : 'Todavía sin identificar: se hace solo en segundo plano.'}</span>`;
        return;
    }
    const u = textoUbicacionEst(e);
    const maps = e.place_id
        ? ` · <a href="https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(e.place_id)}" target="_blank" rel="noopener">ver en Maps</a>` : '';
    const estado = [u.estado === 'verificado en Google' ? '' : u.estado,
        m && m.est_propio ? `puesto a mano solo en este pago` : ''].filter(Boolean).join(' · ');
    $('movEstInfo').innerHTML = esc(u.linea || 'Sin dirección') + maps +
        (estado ? `<br><span class="estado-ubic">${esc(estado)}</span>` : '');
}
$('movAbrirEst').addEventListener('click', async () => {
    const e = movAbierto && movAbierto.establecimiento;
    if (!e) return;
    if (!(ESTABLECIMIENTOS || []).some(x => x.id === e.id)) await cargarEstablecimientos();
    apilarFicha('estOverlay', etiquetaMov(), refrescarEstMov);
    abrirEstablecimiento(e.id);
});
const buscadorMovEst = crearBuscadorEst({
    input: $('movEstablecimiento'), flecha: $('movEstBoton'),
    buscarGoogle: (texto) => buscarLugarLibre(texto),
    textoGoogle: () => $('movEstablecimiento').value.trim() || [movAbierto && movAbierto.nombre, movAbierto && movAbierto.poblacion].filter(Boolean).join(' '),
    accionTuyo: 'Asignar', accionGoogle: 'Asignar', accionCrear: 'Crear',
    alTuyo: (e) => {
        movEstElegido = { id: e.id };
        $('movEstablecimiento').value = e.nombre;
        const antes = movAbierto && movAbierto.establecimiento;
        if (antes && antes.id === e.id) pintarInfoEstMov(antes, movAbierto);
        else pintarInfoEstMov(null, movAbierto, 'Se cambiará al guardar, solo en este pago.');
    },
    alGoogle: (c) => {
        const nombre = String(c.nombre || '').toUpperCase();
        movEstElegido = { place_id: c.place_id, nombre };
        $('movEstablecimiento').value = nombre;
        pintarInfoEstMov(null, movAbierto, 'Se cambiará al guardar, solo en este pago.');
    },
    alCrear: (nombre) => {
        movEstElegido = { nombre };
        $('movEstablecimiento').value = nombre;
        pintarInfoEstMov(null, movAbierto, 'Establecimiento nuevo: se creará al guardar, solo para este pago.');
    }
});
$('movEstablecimiento').addEventListener('input', () => {
    movEstElegido = null;
    if (movAbierto) pintarInfoEstMov(null, movAbierto, $('movEstablecimiento').value.trim()
        ? 'Elige uno de la lista, o se guardará con este nombre solo en este pago.'
        : 'Vacío: volverá a ser el de su comercio.');
});
$('movTiquetEstado').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-abrir-tiquet-mov]');
    if (!b) return;
    apilarFicha('editorOverlay', etiquetaMov());
    Editor.abrirPorIds([Number(b.dataset.abrirTiquetMov)]);
});

/** Google, sin establecimiento detrás (tiquet y movimiento): los candidatos quedan recordados una hora. */
async function buscarLugarLibre(texto, cerca = null) {
    const res = await api('/api/tickets/lugares/buscar', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ texto, latitud: cerca ? cerca[0] : null, longitud: cerca ? cerca[1] : null })
    });
    const datos = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(datos.error || 'Google no ha respondido.');
    return datos.candidatos || [];
}

function actualizarParteMov() {
    if (!movAbierto) return;
    $('movMiParte').placeholder = centimosAEuros(Math.round(Math.abs(movAbierto.importe_centimos) / movPersonas));
    const total = Math.abs(movAbierto.importe_centimos);
    const parte = $('movMiParte').value.trim() !== '' ? eurosACentimos($('movMiParte').value) : Math.round(total / movPersonas);
    valorPlegable('plMovCompartido', $('movCompartido').checked
        ? `entre ${movPersonas} · tu parte ${esc(formatearImporte(parte, movAbierto.moneda))}`
        : movAbierto.compartido_entre === 1 ? 'solo tú' : 'no');
}
$('movCompartido').addEventListener('change', () => {
    $('movZonaCompartido').classList.toggle('hidden', !$('movCompartido').checked);
    actualizarParteMov();
});
$('movMiParte').addEventListener('input', actualizarParteMov);
for (const [id, paso] of [['movMenosPersonas', -1], ['movMasPersonas', 1]]) {
    $(id).addEventListener('click', () => {
        movPersonas = Math.max(2, Math.min(50, movPersonas + paso));
        $('movPersonas').textContent = String(movPersonas);
        actualizarParteMov();
    });
}

crearCombo({
    input: $('movCategoria'), lista: $('movCategoriaLista'), boton: $('movCategoriaBoton'), abrirAlPulsar: true,
    opciones: () => [...new Set([...CATEGORIAS_BASE, 'BIZUM', 'TRANSFERENCIA', 'INGRESOS', 'COMISIONES', ...CATEGORIAS_VISTAS])].map(c => ({
        valor: c, buscar: sinAcentos(c),
        html: `<div class="sug-nombre inline-flex items-center gap-2">${iconoCategoria(c)}${esc(c)}</div>`
    })),
    alElegir: (o) => { $('movCategoria').value = o.valor; }
});

function cerrarMovimiento() {
    $('movOverlay').classList.add('hidden');
    movAbierto = null;
    buscadorMovEst.cerrar();
    if (volverDeFicha()) return;
    if (!fichaVisible() && $('bancoOverlay').classList.contains('hidden')) document.body.classList.remove('overflow-hidden');
}
$('movCerrar').addEventListener('click', cerrarMovimiento);
$('movSuscripcion').addEventListener('click', () => {
    const m = movAbierto;
    if (!m) return;
    apilarFicha('susOverlay', etiquetaMov());
    abrirSuscripcion({ movimiento: m });
});
$('movCancelar').addEventListener('click', cerrarMovimiento);
$('movOverlay').addEventListener('click', (ev) => { if (ev.target === $('movOverlay')) cerrarMovimiento(); });

/** Tras cambiar un movimiento: el historial, el panel de Bizum y las cifras. */
async function refrescarTrasMovimiento() {
    await cargarMovimientosHistorial();
    pintarHistorial();
    pintarBizum();
    cargarPanel();
}

$('movGuardar').addEventListener('click', async () => {
    const m = movAbierto;
    if (!m) return;
    const cambios = {};
    if ($('movTipo').value && $('movTipo').value !== m.clase) cambios.clase = $('movTipo').value;
    const cat = $('movCategoria').value.trim().toUpperCase();
    if (cat !== String(m.categoria || '').toUpperCase()) cambios.categoria = cat;
    if (esComercioMov(m)) {
        const escrito = $('movEstablecimiento').value.trim().toUpperCase();
        const antes = m.establecimiento || null;
        const todos = !$('movEstTodosCaja').classList.contains('hidden') && $('movEstTodos').checked;
        if (movEstElegido) {
            if (todos || !(movEstElegido.id && antes && movEstElegido.id === antes.id)) cambios.establecimiento = movEstElegido;
        } else if (todos || escrito !== String((antes && antes.nombre) || '').toUpperCase()) {
            // Vacío = vuelve al de su comercio (o, para todos, que se identifique solo); texto sin elegir = ese nombre.
            cambios.establecimiento = escrito ? { nombre: escrito } : {};
        }
        if (cambios.establecimiento && todos) {
            const nombre = (movEstElegido && movEstElegido.nombre) || escrito ||
                ((ESTABLECIMIENTOS || []).find(x => movEstElegido && x.id === movEstElegido.id) || {}).nombre || '';
            const seguro = await pedirConfirmacion({
                titulo: '¿Cambiarlo en todos sus pagos?',
                cuerpo: `Los ${m.pagos_comercio} pagos de «${m.comercio}» pasarán a ${nombre ? `«${nombre}»` : 'identificarse solos'}, también los que vengan.`,
                aceptar: 'Cambiar todos'
            });
            if (!seguro) return;
            cambios.establecimiento = { ...cambios.establecimiento, todos: true };
        }
    }
    if (m.importe_centimos < 0) {
        if ($('movContar').checked === Boolean(m.excluir)) cambios.excluir = !$('movContar').checked;
        const entre = $('movCompartido').checked ? movPersonas : null;
        const parte = entre && $('movMiParte').value.trim() !== '' ? eurosACentimos($('movMiParte').value) : null;
        if ((entre || null) !== (m.compartido_entre > 1 ? m.compartido_entre : null) || parte !== (m.mi_parte_centimos ?? null)) {
            cambios.compartido_entre = entre;
            cambios.mi_parte_centimos = parte;
        }
    }
    if (!Object.keys(cambios).length) { cerrarMovimiento(); return; }
    $('movGuardar').disabled = true;
    try {
        const res = await api(`/api/banco/movimientos/${m.id}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cambios)
        });
        if (!res.ok) {
            const datos = await res.json().catch(() => ({}));
            $('movError').textContent = datos.error || 'No se ha podido guardar.';
            $('movError').classList.remove('hidden');
            return;
        }
        if ('establecimiento' in cambios) await cargarEstablecimientos();
        cerrarMovimiento();
        aviso('Movimiento guardado');
        refrescarTrasMovimiento();
    } catch (err) {
        if (err && err.message !== 'sin sesion') {
            $('movError').textContent = 'No se ha podido guardar.';
            $('movError').classList.remove('hidden');
        }
    } finally {
        $('movGuardar').disabled = false;
    }
});

$('movBuscarTiquet').addEventListener('click', async () => {
    if (!movAbierto) return;
    let lista = [];
    try { lista = (await (await api(`/api/banco/movimientos/${movAbierto.id}/candidatos`)).json()).candidatos || []; } catch (_) {}
    $('movCandidatos').innerHTML = (lista.length ? lista.map(t => `
        <button type="button" data-enlazar-mov="${t.id}">
            <b>${esc(t.nombre || 'Sin comercio')}</b> · ${esc(fechaCorta(t.dia))} · ${esc(formatearImporte(t.total_centimos))}
            ${t.diferencia === 0 ? ' · mismo importe' : ''}
        </button>`).join('') : '<p class="vacio-discreto">No hay tiquets en esos días.</p>') +
        '<button type="button" data-enlazar-mov="ninguno">No tiene tiquet</button>';
});
$('movCandidatos').addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-enlazar-mov]');
    if (!b || !movAbierto) return;
    const tiquet = b.dataset.enlazarMov === 'ninguno' ? null : Number(b.dataset.enlazarMov);
    const id = movAbierto.id;
    await api(`/api/banco/movimientos/${id}/tiquet`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tiquet_id: tiquet })
    });
    aviso(tiquet ? 'Enlazado con su tiquet' : 'Marcado como sin tiquet');
    // La ficha se queda abierta, ya con el enlace.
    const fresco = await (await api(`/api/banco/movimientos/${id}`)).json().catch(() => null);
    if (fresco && movAbierto && movAbierto.id === id) {
        Object.assign(movAbierto, { tiquet_id: fresco.tiquet_id, enlace: fresco.enlace });
        pintarTiquetMov();
    }
    await cargarMovimientosHistorial();
    cargarHistorial({ reiniciar: true });
    cargarPanel();
});

// --- Filtros y búsqueda ------------------------------------------------------

let temporizadorBusqueda = null;
$('fBuscar').addEventListener('input', () => {
    clearTimeout(temporizadorBusqueda);
    // Lo justo para no pedir una página por cada tecla.
    temporizadorBusqueda = setTimeout(() => cargarHistorial({ reiniciar: true }), 400);
});

$('fOrden').addEventListener('change', () => cargarHistorial({ reiniciar: true }));

$('btnFiltros').addEventListener('click', () => {
    const abierto = !$('panelFiltros').classList.toggle('hidden');
    $('btnFiltros').setAttribute('aria-expanded', String(abierto));
});

for (const id of ['fDesde', 'fHasta', 'fMin', 'fMax', 'fCategoriaFiltro', 'fTipoFiltro', 'fEstadoFiltro']) {
    $(id).addEventListener('change', () => cargarHistorial({ reiniciar: true }));
}

$('btnLimpiarRapido').addEventListener('click', () => $('btnLimpiarFiltros').click());
$('btnLimpiarFiltros').addEventListener('click', () => {
    for (const id of ['fBuscar', 'fDesde', 'fHasta', 'fMin', 'fMax', 'fCategoriaFiltro', 'fTipoFiltro']) {
        $(id).value = '';
    }
    $('fEstadoFiltro').value = '';
    filtrosExtra = {};
    filtroPeriodo = null;
    cargarHistorial({ reiniciar: true });
    pintarTiempo();
});

/**
 * Aplica un filtro y recarga la lista.
 *
 * `desplegar` abre el panel de filtros y lleva la vista al historial: eso lo
 * quiere quien pulsa en la linea de control ("4 incompletos"), porque si no, no
 * veria el resultado. NO lo quiere quien pulsa un dia del calendario: ahi la
 * vista no puede moverse, porque se esta mirando el calendario y el salto
 * descoloca el siguiente clic.
 */
function filtrarPor(extra, { desplegar = true } = {}) {
    filtrosExtra = extra;
    if (desplegar) {
        $('panelFiltros').classList.remove('hidden');
        $('btnFiltros').setAttribute('aria-expanded', 'true');
        cambiarVista('historial');
        // En escritorio el historial ya está a la vista (y es sticky:
        // scrollIntoView sobre él bajaba la página un poco a cada clic). Ahí
        // solo se sube su lista al principio; en el móvil sí se va a él.
        if (window.matchMedia('(min-width: 1024px)').matches) {
            $('listaTickets').scrollTo({ top: 0, behavior: 'smooth' });
        } else {
            $('columnaHistorial').scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    }
    cargarHistorial({ reiniciar: true });
}

// --- Carga al hacer scroll ---------------------------------------------------
// IntersectionObserver y no un listener de scroll: la lista tiene su propio
// contenedor con scroll en escritorio y es la ventana la que se mueve en móvil.

const centinela = new IntersectionObserver((entradas) => {
    if (entradas.some(e => e.isIntersecting)) cargarHistorial();
}, { rootMargin: '200px' });
centinela.observe($('centinelaScroll'));

// =============================================================================
// PANEL: CIFRAS, GRÁFICAS Y MAPA
// =============================================================================

let mapa = null;

/** La serie de la moneda principal (EUR si está; si no, la primera). */
function serieDe(datos) {
    if (!datos.series || datos.series.length === 0) return null;
    return datos.series.find(s => s.moneda === 'EUR') || datos.series[0];
}

async function cargarPanel() {
    // La escala primero: el calendario, la semana, el año y el mapa pintan el
    // color del gasto con ella, y sin ella pintarían sin color.
    await cargarEscala();
    await Promise.all([cargarCifras(), cargarResumenBanco(), cargarTiempo(), cargarCategorias(), cargarComercios(), cargarMapa(),
                       cargarEstablecimientos(), cargarSuscripciones()]);
}

// --- Cifras del periodo ------------------------------------------------------

/** Bizum e ingresos del mes en curso: no son gasto, se enseñan aparte. */
async function cargarResumenBanco() {
    const caja = $('resumenBanco');
    try {
        const hoy = hoyLocal();
        const desde = iso(new Date(hoy.getFullYear(), hoy.getMonth(), 1));
        const [r, rp] = await Promise.all([
            api(`/api/banco/resumen?desde=${desde}&hasta=${iso(hoy)}`),
            api('/api/estadisticas/prevision')
        ]);
        const datos = r.ok ? (await r.json()).resumen : null;
        const p = rp.ok ? await rp.json() : null;
        if (!datos && !p) { caja.classList.add('hidden'); return; }
        const prevision = p ? `
            <span class="resumen-banco-item prevision" title="${esc(p.pendientes.map(x =>
                `${x.comercio}: ${formatearImporte(x.importe_centimos)} el ${fechaCorta(x.fecha)}`).join('\n'))}">
                ${iconoCategoria('SUSCRIPCIONES')}<span>Previsión a fin de mes</span>
                <b class="cifra">~${esc(formatearImporte(p.prevision_centimos))}</b>
                <small>${esc([
                    `llevas ${formatearImporte(p.gastado_centimos)}`,
                    p.fijo_pendiente_centimos ? `${formatearImporte(p.fijo_pendiente_centimos)} de pagos fijos por llegar` : null,
                    `~${formatearImporte(p.variable_diario_centimos)} al día`
                ].filter(Boolean).join(' · '))}</small></span>` : '';
        if (!datos) { caja.innerHTML = prevision; caja.classList.remove('hidden'); return; }
        caja.innerHTML = prevision + `
            <span class="resumen-banco-item">${iconoTipo('salida')}<span>Bizum enviados</span>
                <b class="cifra">${esc(formatearImporte(datos.bizum_enviado))}</b>
                <small>${esc(plural(datos.bizum_enviados, 'envío'))} · cuentan como gasto</small></span>
            <span class="resumen-banco-item">${iconoTipo('entrada')}<span>Bizum recibidos</span>
                <b class="cifra importe-entrada">+${esc(formatearImporte(datos.bizum_recibido))}</b>
                <small>${esc(plural(datos.bizum_recibidos, 'recibido'))} · no restan gasto</small></span>
            <span class="resumen-banco-item">${iconoTipo('banco')}<span>Ingresos</span>
                <b class="cifra importe-entrada">+${esc(formatearImporte(datos.ingresos))}</b>
                <small>este mes</small></span>`;
        caja.classList.remove('hidden');
    } catch (_) {
        caja.classList.add('hidden');
    }
}

async function cargarCifras() {
    try {
        const [mes, anio, control] = await Promise.all([
            api('/api/estadisticas/resumen?periodo=mes').then(r => r.json()),
            api('/api/estadisticas/resumen?periodo=anio').then(r => r.json()),
            api('/api/estadisticas/control').then(r => r.json())
        ]);
        pintarCifras(mes, anio);
        pintarControl(control);
        cargarComensales();
    } catch (err) {
        if (err && err.message === 'sin sesion') return;
        console.error(err);
    }
}

function bloquePrincipal(resumen) {
    const bloques = (resumen.actual && resumen.actual.por_moneda) || [];
    return bloques.find(b => b.moneda === 'EUR') || bloques[0] || null;
}

function pintarCifras(mes, anio) {
    const esteMes = bloquePrincipal(mes);
    const esteAnio = bloquePrincipal(anio);
    const moneda = (esteMes && esteMes.moneda) || (esteAnio && esteAnio.moneda) || 'EUR';

    $('kpiMes').textContent = formatearImporte(esteMes ? esteMes.total_centimos : 0, moneda);
    $('kpiAnio').textContent = formatearImporte(esteAnio ? esteAnio.total_centimos : 0, moneda);
    // Solo tiquets de verdad; los pagos del banco del mes se dicen aparte.
    $('kpiTiquets').textContent = esteMes ? String(esteMes.solo_tiquets ?? esteMes.tiquets) : '0';
    $('kpiTiquetsBanco').textContent = esteMes && esteMes.del_banco
        ? `del mes en curso · y ${plural(esteMes.del_banco, 'pago', 'pagos')} del banco sin tiquet`
        : 'del mes en curso';

    $('kpiMesVariacion').innerHTML = textoVariacion(mes, moneda, 'mes anterior');
    $('kpiAnioVariacion').innerHTML = textoVariacion(anio, moneda, 'año anterior');

    // Las monedas no se suman: si hay más de una, se avisa en vez de mezclarlas.
    const otras = [...new Set([...(mes.monedas || []), ...(anio.monedas || [])])]
        .filter(m => m !== moneda);
    // Las compras en otra moneda se suman ya convertidas a euros (con el cambio
    // del día de la compra). Solo quedarían fuera las que aún no se han podido
    // convertir, y eso es temporal: no merece un aviso permanente.
    void otras;
    $('avisoMonedas').classList.add('hidden');
}

function textoVariacion(resumen, moneda, etiqueta) {
    const v = (resumen.variacion || []).find(x => x.moneda === moneda);
    const tenue = (texto) => `<span style="color: var(--texto-2)">${texto}</span>`;
    if (!v) return tenue(`sin datos del ${etiqueta}`);

    if (v.porcentaje === null) {
        return tenue(v.actual_centimos ? `sin gasto en el ${etiqueta}` : 'sin gasto');
    }

    const sube = v.diferencia_centimos > 0;
    const igual = v.diferencia_centimos === 0;
    const color = igual ? 'var(--texto-2)' : (sube ? 'var(--aviso)' : 'var(--correcto)');
    const signo = sube ? '+' : '';
    // Con Intl y no con interpolación: el resto de la página escribe los números
    // en español y un "45.1%" con punto decimal se nota.
    const porcentaje = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 1 }).format(v.porcentaje);
    return `<span class="cifra font-semibold" style="color: ${color}">${signo}${porcentaje} %</span> ` +
           tenue(`frente al ${etiqueta}`);
}

function pintarControl(control) {
    const piezas = [];
    const chip = (n, texto, filtro) =>
        `<button type="button" class="chip-control"
                 data-filtro='${esc(JSON.stringify(filtro))}'><b>${n}</b> ${texto}</button>`;

    if (control.sin_importe) piezas.push(chip(control.sin_importe, 'sin importe', { sin_importe: 1 }));
    if (control.incompletos) piezas.push(chip(control.incompletos, 'incompletos', { estado: 'incompleto' }));
    if (control.pendientes)  piezas.push(chip(control.pendientes, 'sin procesar', { estado: 'pendiente' }));
    if (control.sin_ubicar)  piezas.push(chip(control.sin_ubicar, 'sin ubicar', { sin_ubicar: 1 }));
    // Situados, pero en un punto cuyo código postal no es el del papel.
    if (control.dudosos)     piezas.push(chip(control.dudosos, 'dudosos', { dudoso: 1 }));

    $('lineaControl').innerHTML = piezas.join('');
    pintarChipComensales();

    // Reintentar en lote va PEGADO al contador de pendientes: es lo que se
    // quiere hacer justo después de leerlo.
    PENDIENTES = control.pendientes || 0;
    if (PENDIENTES > 0 && !Lote.enCurso) {
        $('lineaControl').insertAdjacentHTML('beforeend',
            `<button type="button" class="chip-control accion" data-reintentar-todos="1">` +
            `Reintentar ${PENDIENTES === 1 ? 'el pendiente' : `los ${PENDIENTES}`}</button>`);
    }
}

$('lineaControl').addEventListener('click', (ev) => {
    const boton = ev.target.closest('[data-filtro]');
    if (!boton) return;
    const filtro = JSON.parse(boton.dataset.filtro);

    // El mismo chip otra vez lo quita: el chip ES el indicador de que está
    // puesto, así que tiene que poder apagarse donde se enciende.
    const yaPuesto = filtro.estado
        ? $('fEstadoFiltro').value === filtro.estado
        : Object.keys(filtro).every(k => String(filtrosExtra[k] ?? '') === String(filtro[k]));

    if (yaPuesto) {
        $('fEstadoFiltro').value = '';
        filtrarPor({}, { desplegar: false });
        return;
    }

    // El estado tiene su propio campo; el resto son filtros sin campo. No se
    // despliega nada ni se mueve la vista: los chips están junto a la lista.
    if (filtro.estado) {
        $('fEstadoFiltro').value = filtro.estado;
        filtrarPor({}, { desplegar: false });
    } else {
        $('fEstadoFiltro').value = '';
        filtrarPor(filtro, { desplegar: false });
    }
});

// =============================================================================
// GASTO EN EL TIEMPO
// =============================================================================
// Cuatro vistas de la misma pregunta, cada una con su forma:
//
//   DÍA     una línea de 0 a 24 h con una marca por tiquet, del tamaño de su
//           importe. Los que no llevan hora impresa van aparte: ponerlos a las
//           00:00 sería inventarse una medianoche que nadie compró.
//   SEMANA  siete barras, de lunes a domingo.
//   MES     calendario. La intensidad del fondo es el gasto del día.
//   AÑO     doce casillas, misma escala.
//
// Todas se recorren: hay un ANCLA (un día cualquiera dentro del periodo que se
// está viendo) y los botones la mueven. Sin esto, cuatro vistas serían cuatro
// fotos fijas de los últimos N días.

const dos = (n) => String(n).padStart(2, '0');
const iso = (f) => `${f.getFullYear()}-${dos(f.getMonth() + 1)}-${dos(f.getDate())}`;
const mayuscula = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** Hoy a medianoche, en hora local: el ancla es un día, no un instante. */
function hoyLocal() {
    const h = new Date();
    return new Date(h.getFullYear(), h.getMonth(), h.getDate());
}

/** El lunes de la semana de `f`. La semana empieza en lunes, aquí y en el mes. */
function lunesDe(f) {
    const d = new Date(f.getFullYear(), f.getMonth(), f.getDate());
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return d;
}

const Tiempo = {
    periodo: 'mes',
    ancla: hoyLocal(),
    datos: null
};


/**
 * Qué rango se está viendo y cómo se llama. El título ES el rango: sin él, las
 * flechas moverían algo que no se sabe dónde está.
 */
function rangoVisible(periodo = Tiempo.periodo, ancla = Tiempo.ancla) {
    const anioActual = hoyLocal().getFullYear();
    const conAnio = (f) => f.getFullYear() !== anioActual;

    if (periodo === 'dia') {
        return {
            desde: iso(ancla), hasta: iso(ancla),
            titulo: mayuscula(ancla.toLocaleDateString('es-ES', {
                weekday: 'long', day: 'numeric', month: 'long',
                ...(conAnio(ancla) ? { year: 'numeric' } : {})
            }))
        };
    }

    if (periodo === 'semana') {
        const lunes = lunesDe(ancla);
        const domingo = new Date(lunes.getFullYear(), lunes.getMonth(), lunes.getDate() + 6);
        const corto = (f) => f.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
        const primero = lunes.getMonth() === domingo.getMonth()
            ? String(lunes.getDate())
            : corto(lunes);
        return {
            desde: iso(lunes), hasta: iso(domingo),
            titulo: `${primero} – ${corto(domingo)}` + (conAnio(domingo) ? ` ${domingo.getFullYear()}` : '')
        };
    }

    if (periodo === 'mes') {
        const primero = new Date(ancla.getFullYear(), ancla.getMonth(), 1);
        const ultimo  = new Date(ancla.getFullYear(), ancla.getMonth() + 1, 0);
        return {
            desde: iso(primero), hasta: iso(ultimo),
            titulo: mayuscula(primero.toLocaleDateString('es-ES', { month: 'long', year: 'numeric' }))
        };
    }

    if (periodo === 'todo') {
        return { desde: '1900-01-01', hasta: iso(hoyLocal()), titulo: 'Todo el histórico' };
    }

    return {
        desde: `${ancla.getFullYear()}-01-01`,
        hasta: `${ancla.getFullYear()}-12-31`,
        titulo: String(ancla.getFullYear())
    };
}

/** Mueve el ancla un periodo adelante (+1) o atrás (-1). */
function moverPeriodo(pasos) {
    const a = Tiempo.ancla;
    if (Tiempo.periodo === 'todo') return;   // el histórico no se recorre
    if (Tiempo.periodo === 'dia') {
        Tiempo.ancla = new Date(a.getFullYear(), a.getMonth(), a.getDate() + pasos);
    } else if (Tiempo.periodo === 'semana') {
        Tiempo.ancla = new Date(a.getFullYear(), a.getMonth(), a.getDate() + 7 * pasos);
    } else if (Tiempo.periodo === 'mes') {
        // Día 1 antes de sumar meses: desde un 31 de marzo, "mes siguiente" con
        // aritmética de días cae en mayo.
        Tiempo.ancla = new Date(a.getFullYear(), a.getMonth() + pasos, 1);
    } else {
        Tiempo.ancla = new Date(a.getFullYear() + pasos, 0, 1);
    }
}

$('selectorPeriodo').addEventListener('click', (ev) => {
    const boton = ev.target.closest('[data-periodo]');
    if (!boton) return;
    Tiempo.periodo = boton.dataset.periodo;
    // Cambiar de vista NO cambia de fecha: se sigue mirando el mismo momento,
    // con otro grano.
    for (const b of $('selectorPeriodo').querySelectorAll('[data-periodo]')) {
        b.setAttribute('aria-selected', String(b === boton));
    }
    recargarPeriodo();
});

// Las flechas hacen lo MISMO que el gesto: en la vista de mes deslizan la tira
// (y al ajustarse se mueve el ancla); en el resto mueven el ancla directamente.
$('btnAnterior').addEventListener('click', () => {
    if (Tiempo.periodo === 'mes') return deslizarTira(-1);
    moverPeriodo(-1); recargarPeriodo();
});
$('btnSiguiente').addEventListener('click', () => {
    if (Tiempo.periodo === 'mes') return deslizarTira(+1);
    moverPeriodo(+1); recargarPeriodo();
});
$('btnHoy').addEventListener('click', () => { Tiempo.ancla = hoyLocal(); recargarPeriodo(); });

function recargarPeriodo() {
    cargarTiempo();
    cargarCategorias();
    cargarComercios();
    cargarMapa();
    bizumSeleccion = null;
    pintarBizum();
}

// --- BIZUM DEL PERIODO -------------------------------------------------------------
// Sale de los movimientos que ya tiene el historial (BANCO_MOVS): nada que pedir
// al servidor, así que sigue al periodo al instante.

let bizumSeleccion = null;     // un día ('2026-10-03') o un mes ('2026-10') pulsado

function pintarBizum() {
    const seccion = $('seccionBizum');
    // Bizum (los dos sentidos) e ingresos: todo lo que entra o se manda a personas.
    const esIngreso = (m) => m.importe_centimos > 0 && !esBizum(m) && m.clase !== 'devolucion';
    const todos = (typeof BANCO_MOVS !== 'undefined' ? BANCO_MOVS : []).filter(m => esBizum(m) || esIngreso(m));
    if (!todos.length) { seccion.classList.add('hidden'); return; }
    seccion.classList.remove('hidden');

    const { desde, hasta, titulo } = rangoVisible();
    const enRango = todos.filter(m => (Tiempo.periodo === 'todo' || (m.fecha >= desde && m.fecha <= hasta)));
    $('bizumPeriodo').textContent = titulo;

    const sale = enRango.filter(m => m.clase === 'bizum_enviado');
    const entra = enRango.filter(m => m.clase === 'bizum_recibido');
    const ingresos = enRango.filter(esIngreso);
    const suma = (l) => l.reduce((t, m) => t + Math.abs(m.importe_centimos), 0);
    const balance = suma(entra) - suma(sale);
    $('bizumCifras').innerHTML = `
        <div class="cifra-periodo"><span class="etiqueta-cifra">Enviados</span><b class="cifra" style="color: var(--c-sale)">${esc(formatearImporte(suma(sale)))}</b><small>${esc(plural(sale.length, 'envío'))}</small></div>
        <div class="cifra-periodo"><span class="etiqueta-cifra">Recibidos</span><b class="cifra" style="color:var(--g)">+${esc(formatearImporte(suma(entra)))}</b><small>${esc(plural(entra.length, 'recibido'))}</small></div>
        <div class="cifra-periodo"><span class="etiqueta-cifra">Balance Bizum</span><b class="cifra">${balance >= 0 ? '+' : '−'}${esc(formatearImporte(Math.abs(balance)))}</b><small>${balance >= 0 ? 'te han devuelto más' : 'has enviado más'}</small></div>
        <div class="cifra-periodo"><span class="etiqueta-cifra">Ingresos</span><b class="cifra" style="color: var(--c-ingreso)">+${esc(formatearImporte(suma(ingresos)))}</b><small>${esc(plural(ingresos.length, 'ingreso'))}</small></div>`;

    // El calendario: días del mes (día, semana, mes), meses (año) o años (todo).
    const porClave = new Map();
    const clave = (m, n) => m.fecha.slice(0, n);
    const n = Tiempo.periodo === 'anio' ? 7 : Tiempo.periodo === 'todo' ? 4 : 10;
    for (const m of todos) {
        const k = clave(m, n);
        const v = porClave.get(k) || { sale: 0, entra: 0, ingreso: 0 };
        if (m.importe_centimos < 0) v.sale += -m.importe_centimos;
        else if (esBizum(m)) v.entra += m.importe_centimos;
        else v.ingreso += m.importe_centimos;
        porClave.set(k, v);
    }
    // En las casillas del mes no cabe "+115 €": sin el símbolo (la cabecera ya
    // dice que son euros) y con punto de miles si hace falta.
    const euros = (c) => Tiempo.periodo === 'anio' || Tiempo.periodo === 'todo'
        ? `${Math.round(c / 100).toLocaleString('es-ES')} €` : Math.round(c / 100).toLocaleString('es-ES');
    const casilla = (k, rotulo, extra = '') => {
        const v = porClave.get(k);
        return `<button type="button" class="bizum-casilla${extra}" data-bizum="${k}" aria-pressed="${bizumSeleccion === k}">
            <span class="num">${rotulo}</span>
            ${v && v.sale ? `<span class="sale">−${euros(v.sale)}</span>` : ''}
            ${v && v.entra ? `<span class="entra">+${euros(v.entra)}</span>` : ''}
            ${v && v.ingreso ? `<span class="ingreso">+${euros(v.ingreso)}</span>` : ''}
        </button>`;
    };
    const cal = $('bizumCalendario');
    cal.classList.toggle('meses', Tiempo.periodo === 'anio');
    cal.classList.toggle('anios', Tiempo.periodo === 'todo');
    if (Tiempo.periodo === 'anio') {
        const a = Tiempo.ancla.getFullYear();
        cal.innerHTML = Array.from({ length: 12 }, (_, i) => casilla(`${a}-${String(i + 1).padStart(2, '0')}`,
            mayuscula(new Date(a, i, 1).toLocaleDateString('es-ES', { month: 'short' })))).join('');
    } else if (Tiempo.periodo === 'todo') {
        const anios = [...new Set(todos.map(m => m.fecha.slice(0, 4)))].sort().reverse();
        cal.innerHTML = anios.map(a => casilla(a, a)).join('');
    } else {
        const base = Tiempo.ancla;
        const primero = new Date(base.getFullYear(), base.getMonth(), 1);
        const dias = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate();
        const hueco = (primero.getDay() + 6) % 7;
        cal.innerHTML = ['L', 'M', 'X', 'J', 'V', 'S', 'D'].map(d => `<span class="bizum-cab">${d}</span>`).join('') +
            '<span class="bizum-casilla vacia"></span>'.repeat(hueco) +
            Array.from({ length: dias }, (_, i) => {
                const k = iso(new Date(base.getFullYear(), base.getMonth(), i + 1));
                return casilla(k, String(i + 1), k < desde || k > hasta ? ' fuera' : '');
            }).join('');
    }

    const lista = (bizumSeleccion ? todos.filter(m => m.fecha.startsWith(bizumSeleccion)) : enRango)
        .slice().sort((a, b) => b.fecha.localeCompare(a.fecha));
    $('bizumSeleccion').textContent = bizumSeleccion
        ? `Solo ${bizumSeleccion.length === 10 ? formatearFechaTiquet(bizumSeleccion) : bizumSeleccion} · pulsa otra vez para quitarlo`
        : '';
    $('bizumLista').innerHTML = lista.length ? lista.map(pintarFilaBanco).join('')
        : '<p class="vacio-discreto">Ningún Bizum ni ingreso en este periodo.</p>';
}

$('bizumCalendario').addEventListener('click', (ev) => {
    const c = ev.target.closest('[data-bizum]');
    if (!c) return;
    bizumSeleccion = bizumSeleccion === c.dataset.bizum ? null : c.dataset.bizum;
    pintarBizum();
});
$('bizumLista').addEventListener('click', (ev) => {
    const mov = ev.target.closest('[data-accion="mov"]');
    if (mov) abrirMovimiento(Number(mov.dataset.mov));
});

/**
 * Qué rango de datos hay que pedir. Normalmente el visible; en la vista de mes,
 * TRES meses: la tira enseña el anterior y el siguiente a los lados para que se
 * pueda deslizar, y pintarlos vacíos mientras llega otra petición se vería como
 * un calendario roto.
 */
function rangoAPedir() {
    const { desde, hasta } = rangoVisible();
    if (Tiempo.periodo !== 'mes') return { desde, hasta };

    const a = Tiempo.ancla;
    const primero = new Date(a.getFullYear(), a.getMonth() - 1, 1);
    const ultimo  = new Date(a.getFullYear(), a.getMonth() + 2, 0);
    return { desde: iso(primero), hasta: iso(ultimo) };
}

async function cargarTiempo() {
    const { desde, hasta } = rangoAPedir();
    // El año se dibuja con doce casillas: la serie que hace falta es por mes. El
    // resto trabaja con días; el día, además, con el detalle por hora.
    const granularidad = Tiempo.periodo === 'anio' ? 'mes'
                       : Tiempo.periodo === 'todo' ? 'anio' : 'dia';
    // El detalle (un tiquet por fila) alimenta la vista del día y los recuadros
    // de información del resto: qué se compró, dónde y cuánto.
    const detalle = Tiempo.periodo === 'todo' ? '' : '&detalle=1';

    try {
        const res = await api(
            `/api/estadisticas/series?granularidad=${granularidad}&desde=${desde}&hasta=${hasta}${detalle}`
        );
        Tiempo.datos = await res.json();
        pintarTiempo();
    } catch (err) {
        if (err && err.message === 'sin sesion') return;
        console.error(err);
    }
}

/** Reparte el trabajo y deja la cabecera (título, resumen y botones) al día. */
function pintarTiempo() {
    const datos = Tiempo.datos || { series: [] };
    const rango = rangoVisible();
    const serie = serieDe(datos);
    const todos = serie ? serie.puntos : [];
    const moneda = (serie && serie.moneda) || 'EUR';

    // Los puntos del rango VISIBLE. Pueden haber llegado más (la tira de meses
    // pide tres), y el total de la cabecera es el del mes que se está viendo.
    const puntos = todos.filter(p => p.periodo >= rango.desde.slice(0, p.periodo.length) &&
                                     p.periodo <= rango.hasta.slice(0, p.periodo.length));

    $('tituloRango').textContent = rango.titulo;

    const total = puntos.reduce((n, p) => n + p.total_centimos, 0);
    const tiquets = puntos.reduce((n, p) => n + p.tiquets, 0);
    $('resumenRango').textContent = tiquets
        ? `${formatearImporte(total, moneda)} · ${plural(tiquets, 'tiquet')}` +
          ''
        : `${formatearImporte(0, moneda)} · sin tiquets`;

    // No se navega al futuro: un mes que no ha pasado no tiene gasto que ver.
    // En la vista de mes la flecha no se bloquea, porque el gesto de deslizar no
    // se puede bloquear y las dos cosas tienen que hacer lo mismo.
    const hoy = iso(hoyLocal());
    $('btnSiguiente').disabled = Tiempo.periodo !== 'mes' && rango.hasta >= hoy;
    $('btnHoy').disabled = rango.desde <= hoy && hoy <= rango.hasta;
    $('btnAnterior').disabled = Tiempo.periodo === 'todo';

    pintarCifrasPeriodo(puntos, total, tiquets, moneda, datos);

    for (const [vista, id] of [['dia', 'vistaDia'], ['semana', 'vistaSemana'],
                               ['mes', 'vistaMes'], ['anio', 'vistaAnio'], ['todo', 'vistaTodo']]) {
        $(id).classList.toggle('hidden', vista !== Tiempo.periodo);
    }

    // La plantilla se pinta SIEMPRE, tambien vacia: el calendario con todos sus
    // dias, la semana con sus siete barras a cero, el dia con su linea de 0 a
    // 24 h y el ano con sus doce meses. Un "no hay datos" que borra la
    // estructura obliga a reconstruirla mentalmente cada vez que se vuelve, y
    // hace que el bloque cambie de altura.
    if (Tiempo.periodo === 'dia')         pintarDia(datos);
    else if (Tiempo.periodo === 'semana') pintarSemana(puntos, moneda);
    // La tira necesita los tres meses, no solo el visible.
    else if (Tiempo.periodo === 'mes')    pintarMes(todos, moneda);
    else if (Tiempo.periodo === 'todo')   pintarTodo(puntos, moneda);
    else                                  pintarAnio(puntos, moneda);

    pintarFiltroPeriodo();
}

/**
 * Las cuatro cifras del periodo visible: gasto, tiquets, ticket medio y el pico
 * (mayor compra en el día; día, mes o año de más gasto en el resto).
 */
function pintarCifrasPeriodo(puntos, total, tiquets, moneda, datos) {
    const sinImporte = puntos.reduce((n, p) => n + (p.sin_importe || 0), 0);
    const conImporte = tiquets - sinImporte;

    $('kpiGasto').textContent = formatearImporte(total, moneda);
    $('kpiTiquetsPeriodo').textContent = String(tiquets);
    $('kpiTiquetsDetalle').textContent = sinImporte ? `${sinImporte} sin importe` : '\u00a0';
    $('kpiMedio').textContent = conImporte > 0 ? formatearImporte(Math.round(total / conImporte), moneda) : '—';

    let etiqueta = 'Día de más gasto', valor = '—', detalle = '\u00a0';
    if (Tiempo.periodo === 'dia') {
        etiqueta = 'Mayor compra';
        const lista = ((datos.detalle && datos.detalle.tiquets) || []).filter(t => t.total_centimos > 0);
        const mayor = lista.sort((a, b) => b.total_centimos - a.total_centimos)[0];
        if (mayor) {
            valor = formatearImporte(mayor.total_centimos, mayor.moneda || moneda);
            detalle = mayor.establecimiento || 'Sin comercio';
        }
    } else {
        if (Tiempo.periodo === 'anio') etiqueta = 'Mes de más gasto';
        if (Tiempo.periodo === 'todo') etiqueta = 'Año de más gasto';
        const mayor = [...puntos].filter(p => p.total_centimos > 0)
                                 .sort((a, b) => b.total_centimos - a.total_centimos)[0];
        if (mayor) {
            valor = formatearImporte(mayor.total_centimos, moneda);
            const p = mayor.periodo;
            if (p.length === 4) detalle = p;
            else if (p.length === 7) detalle = mayuscula(new Date(Number(p.slice(0, 4)), Number(p.slice(5, 7)) - 1, 1)
                .toLocaleDateString('es-ES', { month: 'long', year: 'numeric' }));
            else detalle = mayuscula(new Date(Number(p.slice(0, 4)), Number(p.slice(5, 7)) - 1, Number(p.slice(8, 10)))
                .toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' }));
        }
    }
    $('kpiPicoEtiqueta').textContent = etiqueta;
    $('kpiPico').textContent = valor;
    $('kpiPicoDetalle').textContent = detalle;
}

/**
 * TODO EL HISTÓRICO: una casilla por año, desde el primero con tiquets hasta
 * hoy. El color es relativo al año de más gasto (con tan pocos años, los
 * percentiles no dicen nada). Pulsar un año abre su vista anual.
 */
function pintarTodo(puntos, moneda) {
    const actual = hoyLocal().getFullYear();
    const porAnio = new Map(puntos.map(p => [p.periodo, p]));
    const primero = puntos.length ? Math.min(...puntos.map(p => Number(p.periodo))) : actual;
    const mayor = Math.max(...puntos.map(p => p.total_centimos), 1);

    // Del más antiguo (izquierda) al más reciente (derecha), como el calendario.
    const casillas = [];
    for (let a = primero; a <= actual; a += 1) {
        const punto = porAnio.get(String(a));
        const r = punto ? punto.total_centimos / mayor : 0;
        const nivel = r > 0.66 ? 'r' : r > 0.33 ? 'o' : 'g';
        casillas.push(`
            <button type="button" class="casilla-mes${punto ? ` con-gasto nivel-${nivel}` : ' sin-gasto'}${a === actual ? ' casilla-hoy' : ''}"
                    data-anio="${a}">
                <span class="nombre-mes">${a}</span>
                <span class="importe-mes${punto && formatearImporte(punto.total_centimos, moneda).length > 9 ? ' largo' : ''}">${punto ? esc(formatearImporte(punto.total_centimos, moneda)) : '—'}</span>
                <span class="cuenta-dia">${punto ? esc(plural(punto.tiquets, 'tiquet')) : 'sin gasto'}</span>
            </button>`);
    }
    $('rejillaTodo').innerHTML = casillas.join('');
}

/**
 * Pulsar una casilla ACERCA la vista: año → mes, mes o semana → día, todo →
 * año. Filtrar el historial se hace a mano, con los filtros.
 */
function irAPeriodo(periodo, ancla) {
    Tiempo.periodo = periodo;
    Tiempo.ancla = ancla;
    for (const b of $('selectorPeriodo').querySelectorAll('[data-periodo]')) {
        b.setAttribute('aria-selected', String(b.dataset.periodo === periodo));
    }
    recargarPeriodo();
}
const fechaDeIso = (s) => new Date(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)) || 1);

$('rejillaTodo').addEventListener('click', (ev) => {
    const celda = ev.target.closest('[data-anio]');
    if (!celda) return;
    irAPeriodo('anio', new Date(Number(celda.dataset.anio), 0, 1));
});

// --- Importes en poco sitio --------------------------------------------------

/**
 * Importe para una casilla de calendario, donde no caben ocho caracteres.
 *
 * Es EL MISMO formato que en el resto de la pagina (Intl, es-ES, con su simbolo
 * y su separador de miles) y lo unico que cambia es que se redondea a euros:
 * "36 €" junto a "36,09 €" se lee como la misma cifra abreviada, mientras que
 * "36,1€" se leia como otro formato distinto. Los centimos exactos estan en el
 * recuadro de informacion de la casilla.
 */
function importeCompacto(centimos, moneda = 'EUR') {
    return new Intl.NumberFormat('es-ES', {
        style: 'currency', currency: moneda || 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2
    }).format((Number(centimos) || 0) / 100);
}

/// --- DÍA ---------------------------------------------------------------------
// Una línea de horas baja y, encima, un bloque por compra con lo que hace falta
// para reconocerla: comercio, importe y hora. Debajo, la lista completa del día.
// Antes era una línea alta con puntos de colores: mucho espacio para muy poca
// información, y para saber qué era cada punto había que pasar el ratón.

// La línea de tiempo es VERTICAL: 24 horas repartidas en el alto del bloque, y
// cada compra es una tarjeta a la altura de su hora. En horizontal, las tarjetas
// no cabían (cien píxeles para comercio, importe y hora) y debajo quedaba un
// vacío enorme.

// El alto por hora NO es fijo: se calcula en cada pintado para que las 24 h
// quepan enteras en el bloque, sin scroll.
let ALTO_HORA = 12;
const ALTO_TARJETA = 22;         // px; tarjeta de una sola línea
const SEPARACION_TARJETAS = 4;   // px mínimos entre dos tarjetas seguidas

/** Dónde cae una hora (en minutos desde las 00:00) dentro del carril. */
const alturaDeMinutos = (minutos) => Math.round((minutos / 60) * ALTO_HORA);

/** Una fila de la lista de "sin hora". */
function filaDelDia(t, moneda) {
    const nivel = nivelDeGasto(t.total_centimos);
    return `
        <button type="button" class="fila-dia" data-accion="editar" data-id="${t.id}">
            <span class="hora-dia cifra">${t.hora ? esc(t.hora) : '—'}</span>
            <span class="truncate">${esc(t.establecimiento || 'Sin comercio')}</span>
            <span class="cifra font-semibold whitespace-nowrap">
                <i class="punto-nivel ${nivel}"></i>${esc(formatearImporte(t.total_centimos, t.moneda || moneda))}
            </span>
        </button>`;
}

function pintarDia(datos) {
    const serie = serieDe(datos);
    const moneda = (serie && serie.moneda) || 'EUR';
    const tiquets = (datos.detalle && datos.detalle.tiquets) || [];
    const conHora = tiquets.filter(t => t.minutos !== null)
                           .sort((a, b) => a.minutos - b.minutos);
    const sinHora = tiquets.filter(t => t.minutos === null);

    // El total del día, grande y arriba: es lo primero que se mira.
    const total = tiquets.reduce((n, t) => n + (t.total_centimos || 0), 0);
    $('totalDia').innerHTML =
        `<span class="cifra-grande">${esc(formatearImporte(total, moneda))}</span>` +
        `<span>${esc(plural(tiquets.length, 'tiquet'))}</span>`;

    // Los "sin hora" se colocan ANTES de medir: ocupan sitio al pie y la línea
    // del día tiene que caber en lo que queda.
    // Su hueco es fijo (ver el CSS): la línea mide lo mismo haya o no.
    const caja = $('sinHoraDia');
    caja.classList.toggle('vacio', sinHora.length === 0);
    caja.innerHTML = sinHora.length
        ? `<p class="titulo-seccion mb-1">Sin hora · ${sinHora.length}</p>` +
          `<div class="lista-dia">${sinHora.map(t => filaDelDia(t, moneda)).join('')}</div>`
        : '';

    // Las 24 h repartidas en el alto disponible (sin el margen de arriba y
    // abajo, que es para que los rótulos no se corten): el día de un vistazo.
    const linea = $('lineaDia');
    const margen = parseFloat(getComputedStyle(linea).paddingTop) + parseFloat(getComputedStyle(linea).paddingBottom);
    const altoDisponible = Math.max(120, (linea.clientHeight || 280) - (margen || 0));
    ALTO_HORA = altoDisponible / 24;

    // El carril de 24 horas, siempre entero: un día sin gasto enseña la misma
    // estructura, con las horas, y no una caja vacía de otro tamaño.
    const piezas = [`<div class="carril-dia" style="height: ${24 * ALTO_HORA}px">`];

    for (let h = 0; h <= 24; h += 1) {
        const y = alturaDeMinutos(h * 60);
        if (h % 3 === 0) piezas.push(`<div class="reja-hora" style="top: ${y}px"></div>`);
        if (h % 3 === 0 && h < 24) {
            piezas.push(`<span class="rotulo-hora" style="top: ${y}px">${dos(h)}:00</span>`);
        }
    }

    // Dos compras de la misma hora se taparían: la siguiente baja lo justo para
    // no solaparse. Se mueve la TARJETA, no la hora, y por eso cada una sigue
    // llevando su hora escrita.
    let ultimaBase = -Infinity;
    for (const t of conHora) {
        const deseada = alturaDeMinutos(t.minutos);
        // Sin pasarse del final del carril: una compra a las 23:50 no se sale.
        const y = Math.min(Math.max(deseada, ultimaBase + ALTO_TARJETA + SEPARACION_TARJETAS),
                           24 * ALTO_HORA - ALTO_TARJETA);
        ultimaBase = y;

        piezas.push(`
            <button type="button" class="bloque-compra ${nivelDeGasto(t.total_centimos)}"
                    data-accion="editar" data-id="${t.id}" style="top: ${y}px">
                <span class="comercio truncate">${esc(t.establecimiento || 'Sin comercio')}</span>
                <span class="cifra">${esc(formatearImporte(t.total_centimos, t.moneda || moneda))}</span>
                <span class="hora cifra">${esc(t.hora)}</span>
            </button>`);
    }

    if (conHora.length === 0) {
        piezas.push(`<p class="vacio-dia vacio-discreto">${
            tiquets.length ? 'Ningún tiquet con hora conocida.' : 'Ningún tiquet este día.'
        }</p>`);
    }

    piezas.push('</div>');
    $('lineaDia').innerHTML = piezas.join('');

    if (datos.detalle && datos.detalle.truncado) {
        $('resumenRango').textContent += ` · se dibujan los primeros ${datos.detalle.limite}`;
    }
}
// Los bloques y las filas abren el editor, como una fila del historial: son
// tiquets, y lo que se quiere al verlos es corregirlos.
for (const id of ['lineaDia', 'sinHoraDia']) {
    $(id).addEventListener('click', (ev) => {
        const boton = ev.target.closest('[data-accion="editar"]');
        if (boton) Editor.abrirPorIds([Number(boton.dataset.id)]);
    });
}

// --- SEMANA ------------------------------------------------------------------
// Siete columnas a mano, sin Chart.js: con una gráfica de librería no se podía
// separar los días con una línea, tintar el fin de semana ni resaltar hoy sin
// pelearse con el canvas. Y son siete barras: el canvas no aportaba nada.

function pintarSemana(puntos, moneda) {
    const porDia = new Map(puntos.map(p => [p.periodo, p]));
    const lunes = lunesDe(Tiempo.ancla);
    const hoy = iso(hoyLocal());

    const dias = [];
    for (let i = 0; i < 7; i += 1) {
        const f = new Date(lunes.getFullYear(), lunes.getMonth(), lunes.getDate() + i);
        const punto = porDia.get(iso(f));
        dias.push({
            fecha: f,
            dia: iso(f),
            etiqueta: f.toLocaleDateString('es-ES', { weekday: 'short' }).replace('.', ''),
            numero: f.getDate(),
            finde: i >= 5,
            total_centimos: punto ? punto.total_centimos : 0,
            tiquets: punto ? punto.tiquets : 0
        });
    }

    // La escala de alturas es del MAYOR DE LA SEMANA; el color, de mis
    // percentiles. Son dos cosas distintas: la altura compara dentro de la
    // semana y el color compara con mi costumbre.
    const mayor = Math.max(...dias.map(d => d.total_centimos), 1);

    $('vistaSemana').innerHTML = `<div class="semana">${dias.map(d => {
        const alto = d.total_centimos > 0 ? Math.max(3, (d.total_centimos / mayor) * 100) : 0;
        const nivel = nivelDeGasto(d.total_centimos);
        const seleccionado = Boolean(filtroPeriodo) &&
                             filtroPeriodo.desde === d.dia && filtroPeriodo.hasta === d.dia;
        return `
        <button type="button"
                class="col-dia${d.finde ? ' finde' : ''}${d.dia === hoy ? ' hoy' : ''}${d.total_centimos > 0 ? ` con-gasto nivel-${nivel || 'g'}` : ''}"
                data-dia="${d.dia}" aria-pressed="${seleccionado}">
            <span class="importe-col cifra">${
                d.total_centimos > 0 ? esc(importeCompacto(d.total_centimos, moneda)) : ''}</span>
            <span class="zona-barra">
                <span class="barra-col ${nivel}" style="height: ${alto}%"></span>
            </span>
            <span class="etiqueta-col">${esc(d.etiqueta)} <b class="cifra">${d.numero}</b></span>
        </button>`;
    }).join('')}</div>`;

    for (const col of $('vistaSemana').querySelectorAll('[data-dia]')) {
        const d = dias.find(x => x.dia === col.dataset.dia);
        conTip(col, () => ({
            titulo: mayuscula(formatearFechaLarga(col.dataset.dia)),
            filas: d && d.tiquets ? [
                ['Gasto', formatearImporte(d.total_centimos, moneda)],
                ['Tiquets', String(d.tiquets)]
            ] : [],
            lista: listaParaTip(tiquetsDelPeriodo(col.dataset.dia))
        }));
    }
}

// Pulsar un día de la semana abre ese día.
$('vistaSemana').addEventListener('click', (ev) => {
    const col = ev.target.closest('[data-dia]');
    if (!col) return;
    irAPeriodo('dia', fechaDeIso(col.dataset.dia));
});

// --- MES ---------------------------------------------------------------------

const DIAS_SEMANA = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];

/**
 * Las casillas del calendario: semanas completas de lunes a domingo, con los
 * días de los meses vecinos para que la cuadrícula no tenga agujeros.
 */
function celdasDelMes(anio, mes) {
    const primera = lunesDe(new Date(anio, mes, 1));

    // Día 0 del mes siguiente = último del mes. De ahí, hasta su domingo.
    const ultimo = new Date(anio, mes + 1, 0);
    const hastaDomingo = 6 - ((ultimo.getDay() + 6) % 7);
    const fin = new Date(ultimo.getFullYear(), ultimo.getMonth(), ultimo.getDate() + hastaDomingo);

    const celdas = [];
    for (let f = primera; f <= fin; f = new Date(f.getFullYear(), f.getMonth(), f.getDate() + 1)) {
        celdas.push({ fecha: f, dia: iso(f), fuera: f.getMonth() !== mes });
    }
    return celdas;
}

/**
 * Un mes dentro de su contenedor. Las etiquetas de los días de la semana y las
 * casillas van en la MISMA rejilla de siete columnas: así cada día cae
 * exactamente debajo de su etiqueta, sin cuadrar dos rejillas a ojo.
 */
function pintarCalendario(caja, anio, mes, porDia, moneda) {
    const hoy = iso(hoyLocal());
    const celdas = celdasDelMes(anio, mes);

    // Las semanas que tenga este mes (de cuatro a seis) se reparten la altura
    // que haya: la fila de etiquetas ocupa lo suyo y el resto va a 1fr, así que
    // no queda franja vacía abajo en los meses cortos.
    caja.style.gridTemplateRows = `auto repeat(${celdas.length / 7}, minmax(0, 1fr))`;

    caja.innerHTML =
        DIAS_SEMANA.map((d, i) => `<div class="rotulo-semana${i >= 5 ? ' finde' : ''}">${d}</div>`).join('') +
        celdas.map(c => {
            if (c.fuera) return `<div class="casilla-dia casilla-fuera"></div>`;

            const punto = porDia.get(c.dia);
            const nivel = nivelDeGasto(punto ? punto.total_centimos : 0);
            const compacto = punto ? importeCompacto(punto.total_centimos, moneda) : '';
            const seleccionado = Boolean(filtroPeriodo) &&
                                 filtroPeriodo.desde === c.dia && filtroPeriodo.hasta === c.dia;
            const finde = (c.fecha.getDay() + 6) % 7 >= 5;

            return `
            <button type="button"
                    class="casilla-dia${finde ? ' finde' : ''}${c.dia === hoy ? ' casilla-hoy' : ''}${punto ? ` con-gasto nivel-${nivel || 'g'}` : ''}"
                    data-dia="${c.dia}" aria-pressed="${seleccionado}">
                ${puntosSuscripcion(c.dia)}
                <span class="numero-dia cifra">${c.fecha.getDate()}</span>
                ${punto ? `
                    <span class="importe-dia cifra${compacto.length > 8 ? ' largo' : ''}">${esc(compacto)}</span>` : ''}
                <i class="barra-dia ${nivel}"></i>
            </button>`;
        }).join('');

    // El recuadro de información: al pasar el ratón en escritorio y con
    // pulsación larga en móvil. Tocar sigue filtrando el historial.
    for (const casilla of caja.querySelectorAll('[data-dia]')) {
        const dia = casilla.dataset.dia;
        const punto = porDia.get(dia);
        conTip(casilla, () => {
            const titulo = mayuscula(formatearFechaLarga(dia));
            // Las suscripciones que se cobrarán ese día.
            const sus = (SUS_POR_DIA.get(dia) || []).map(s => [`Suscripción · ${s.nombre}`, formatearImporte(s.importe_centimos)]);
            if (!punto) return { titulo, filas: sus };
            const nivel = nivelDeGasto(punto.total_centimos);
            return {
                titulo,
                filas: [
                    ['Gasto', formatearImporte(punto.total_centimos, moneda)],
                    ['Tiquets', new Intl.NumberFormat('es-ES').format(punto.tiquets)],
                    // Lo que significa el color se cuenta aquí, al mirar un día
                    // concreto, y no en una leyenda fija que ocupa sitio siempre.
                    ['', TEXTO_NIVEL[nivel] || 'todavía sin comparar'],
                    ...sus
                ],
                lista: listaParaTip(tiquetsDelPeriodo(dia))
            };
        });
    }
}

/** Los tiquets cargados cuyo día empieza por `prefijo` (un día o un mes). */
function tiquetsDelPeriodo(prefijo) {
    const lista = (Tiempo.datos && Tiempo.datos.detalle && Tiempo.datos.detalle.tiquets) || [];
    return lista.filter(t => t.dia && t.dia.startsWith(prefijo));
}

/** Los tiquets como líneas del recuadro: del mayor gasto al menor. */
function listaParaTip(tiquets, conDia = false) {
    return [...tiquets]
        .sort((a, b) => (b.total_centimos || 0) - (a.total_centimos || 0))
        .map(t => ({
            id: t.id,
            nombre: t.establecimiento || 'Sin comercio',
            importe: formatearImporte(t.total_centimos || 0, t.moneda),
            extra: [conDia ? formatearFechaTiquet(t.dia) : null, t.hora, t.categoria,
                    t.moneda_original && t.moneda_original !== 'EUR' && t.original_centimos != null
                        ? formatearImporte(t.original_centimos, t.moneda_original) : null]
                .filter(Boolean).join(' · ')
        }));
}

/** La tira: el mes de antes, el que se ve y el de después. */
let ultimoMes = null;     // para repintar el mes cuando llegan las suscripciones
function pintarMes(puntos, moneda) {
    ultimoMes = [puntos, moneda];
    const porDia = new Map(puntos.map(p => [p.periodo, p]));
    const base = Tiempo.ancla;

    for (const desplazamiento of [-1, 0, 1]) {
        const caja = $('tiraMeses').querySelector(`[data-calendario="${desplazamiento}"]`);
        const f = new Date(base.getFullYear(), base.getMonth() + desplazamiento, 1);
        pintarCalendario(caja, f.getFullYear(), f.getMonth(), porDia, moneda);
    }
    centrarTira();
}

// --- La tira de meses: deslizar, arrastrar y ajustar -------------------------
// El mes se cambia con el gesto de siempre (deslizar en móvil, arrastrar con el
// ratón en escritorio) y las flechas hacen exactamente lo mismo. Al soltar, el
// panel se ajusta y el ancla se mueve: el panel del medio vuelve a ser el mes
// que se está viendo.

const tira = $('tiraMeses');
let tiraOcupada = false;

const anchoPanel = () => tira.clientWidth || 1;
/** ¿Se está viendo? En móvil vive dentro de una pestaña que puede estar cerrada. */
const tiraVisible = () => tira.clientWidth > 50 && tira.offsetParent !== null;

function centrarTira() {
    if (!tiraVisible()) return;
    tira.classList.add('sin-ajuste');
    tira.scrollLeft = anchoPanel();
    // Dos marcos: el primero deja al navegador aplicar el scrollLeft sin el
    // ajuste puesto; el segundo lo devuelve.
    requestAnimationFrame(() => requestAnimationFrame(() => tira.classList.remove('sin-ajuste')));
}

function deslizarTira(pasos) {
    if (tiraOcupada) return;
    tira.scrollTo({ left: anchoPanel() * (1 + pasos), behavior: 'smooth' });
}

/** Al quedarse quieta: si se ha cambiado de panel, se mueve el ancla. */
let temporizadorTira = null;
tira.addEventListener('scroll', () => {
    ocultarTip();
    clearTimeout(temporizadorTira);
    temporizadorTira = setTimeout(() => {
        if (tiraOcupada || arrastre || !tiraVisible()) return;
        const panel = Math.round(tira.scrollLeft / anchoPanel());
        if (panel === 1) return;
        tiraOcupada = true;
        moverPeriodo(panel - 1);
        Promise.resolve(recargarPeriodo()).finally(() => { tiraOcupada = false; });
    }, 140);
}, { passive: true });

// Arrastre con el ratón; en táctil el deslizamiento ya es nativo.
let arrastre = null, trasArrastrar = false;
tira.addEventListener('pointerdown', (ev) => {
    if (ev.pointerType !== 'mouse' || ev.button !== 0) return;
    arrastre = { x: ev.clientX, left: tira.scrollLeft, movido: false };
});
window.addEventListener('pointermove', (ev) => {
    if (!arrastre) return;
    const dx = ev.clientX - arrastre.x;
    if (!arrastre.movido && Math.abs(dx) > 6) {
        arrastre.movido = true;
        tira.classList.add('sin-ajuste', 'arrastrando');
        ocultarTip();
    }
    if (arrastre.movido) tira.scrollLeft = arrastre.left - dx;
});
window.addEventListener('pointerup', () => {
    if (!arrastre) return;
    if (arrastre.movido) {
        // Un arrastre no es un clic: el día de debajo no se filtra.
        trasArrastrar = true;
        setTimeout(() => { trasArrastrar = false; }, 0);
        tira.classList.remove('arrastrando', 'sin-ajuste');
        const panel = Math.round(tira.scrollLeft / anchoPanel());
        tira.scrollTo({ left: anchoPanel() * panel, behavior: 'smooth' });
    }
    arrastre = null;
});

tira.addEventListener('click', (ev) => {
    const celda = ev.target.closest('[data-dia]');
    if (!celda || trasArrastrar) return;
    if (pulsacionLarga) { pulsacionLarga = false; return; }
    irAPeriodo('dia', fechaDeIso(celda.dataset.dia));
});

// --- AÑO ---------------------------------------------------------------------

function pintarAnio(puntos, moneda) {
    const porMes = new Map(puntos.map(p => [p.periodo, p]));
    const anio = Tiempo.ancla.getFullYear();
    const mesDeHoy = iso(hoyLocal()).slice(0, 7);

    const casillas = [];
    for (let m = 0; m < 12; m += 1) {
        const clave = `${anio}-${dos(m + 1)}`;
        const punto = porMes.get(clave);
        // La escala del año es la de los MESES: comparar un mes con percentiles
        // de días lo pintaría todo rojo.
        const nivel = nivelDeGasto(punto ? punto.total_centimos : 0, 'mes');
        const seleccionado = Boolean(filtroPeriodo) && filtroPeriodo.clave === clave;
        const nombre = new Date(anio, m, 1).toLocaleDateString('es-ES', { month: 'long' });

        // Los meses sin gasto mantienen la forma y bajan de tono: la rejilla de
        // doce casillas se lee como un año entero, no como huecos.
        casillas.push(`
            <button type="button" class="casilla-mes${punto ? ` con-gasto nivel-${nivel || 'g'}` : ' sin-gasto'}${clave === mesDeHoy ? ' casilla-hoy' : ''}"
                    data-mes="${clave}" aria-pressed="${seleccionado}">
                <span class="nombre-mes">${esc(nombre)}</span>
                <span class="importe-mes${punto && formatearImporte(punto.total_centimos, moneda).length > 9 ? ' largo' : ''}">${punto ? esc(formatearImporte(punto.total_centimos, moneda)) : '—'}</span>
                <span class="cuenta-dia">${punto ? esc(plural(punto.tiquets, 'tiquet')) : 'sin gasto'}</span>
                <i class="barra-mes ${nivel}"></i>
            </button>`);
    }

    $('rejillaAnio').innerHTML = casillas.join('');

    for (const casilla of $('rejillaAnio').querySelectorAll('[data-mes]')) {
        const punto = porMes.get(casilla.dataset.mes);
        conTip(casilla, () => {
            const titulo = mayuscula(new Date(
                Number(casilla.dataset.mes.slice(0, 4)),
                Number(casilla.dataset.mes.slice(5, 7)) - 1, 1
            ).toLocaleDateString('es-ES', { month: 'long', year: 'numeric' }));
            if (!punto) return { titulo, filas: [] };
            const nivel = nivelDeGasto(punto.total_centimos, 'mes');
            return {
                titulo,
                filas: [
                    ['Gasto', formatearImporte(punto.total_centimos, moneda)],
                    ['Tiquets', new Intl.NumberFormat('es-ES').format(punto.tiquets)],
                    ['Media por tiquet', formatearImporte(
                        punto.ticket_medio_centimos ?? Math.round(punto.total_centimos / punto.tiquets), moneda)],
                    ['', TEXTO_NIVEL[nivel] || 'todavía sin comparar']
                ],
                lista: listaParaTip(tiquetsDelPeriodo(casilla.dataset.mes), true)
            };
        });
    }
}

$('rejillaAnio').addEventListener('click', (ev) => {
    const celda = ev.target.closest('[data-mes]');
    if (!celda) return;
    if (pulsacionLarga) { pulsacionLarga = false; return; }
    irAPeriodo('mes', fechaDeIso(celda.dataset.mes));
});

// --- El periodo como filtro del historial ------------------------------------

/**
 * Un clic en un día o en un mes filtra el historial a ese periodo; el mismo clic
 * otra vez lo quita. Se escribe en los campos de fecha de los filtros, que son
 * los que manda el servidor: así el filtro es uno y no dos que se contradicen.
 */
function filtrarPeriodo(desde, hasta, etiqueta, clave = desde) {
    if (filtroPeriodo && filtroPeriodo.desde === desde && filtroPeriodo.hasta === hasta) {
        return quitarFiltroPeriodo();
    }
    filtroPeriodo = { desde, hasta, etiqueta, clave };
    $('fDesde').value = desde;
    $('fHasta').value = hasta;
    // Sin desplegar nada y sin mover la vista: se ha pulsado un dia, no un
    // contador de la linea de control.
    filtrarPor(filtrosExtra, { desplegar: false });
    pintarTiempo();
}

function quitarFiltroPeriodo() {
    filtroPeriodo = null;
    $('fDesde').value = '';
    $('fHasta').value = '';
    cargarHistorial({ reiniciar: true });
    pintarTiempo();
}

/**
 * Pinta el aviso de "historial filtrado a…" y lo da por muerto si los campos de
 * fecha ya no dicen lo que decían: quien los edite a mano o pulse Limpiar manda
 * sobre lo que haya dejado puesto el calendario.
 */
function pintarFiltroPeriodo() {
    const caja = $('filtroPeriodo');
    if (filtroPeriodo &&
        ($('fDesde').value !== filtroPeriodo.desde || $('fHasta').value !== filtroPeriodo.hasta)) {
        filtroPeriodo = null;
    }
    if (!filtroPeriodo) {
        caja.classList.add('hidden');
        caja.innerHTML = '';
        return;
    }
    caja.innerHTML = `Historial filtrado a <b>${esc(filtroPeriodo.etiqueta)}</b> ·
        <button type="button" class="underline underline-offset-2" data-quitar-periodo="1">quitar</button>`;
    caja.classList.remove('hidden');
}

$('filtroPeriodo').addEventListener('click', (ev) => {
    if (ev.target.closest('[data-quitar-periodo]')) quitarFiltroPeriodo();
});

// --- Reparto por categoría ---------------------------------------------------

async function cargarCategorias() {
    // El reparto es del periodo que se está viendo: si el título dice "octubre
    // de 2026", el reparto de al lado no puede ser de los últimos doce meses.
    const { desde, hasta, titulo } = rangoVisible();
    $('rangoCategorias').textContent = titulo;
    try {
        const res = await api(`/api/estadisticas/categorias?desde=${desde}&hasta=${hasta}`);
        const datos = await res.json();
        pintarCategorias(datos);
        rellenarListaCategorias(datos);
    } catch (err) {
        if (err && err.message === 'sin sesion') return;
        console.error(err);
    }
}

// Iconos de línea, sin relleno, uno por categoría. Mismo trazo para todos.
const ICONOS_CATEGORIA = {
    ALIMENTACION: '<circle cx="9" cy="20" r="1.3"/><circle cx="18" cy="20" r="1.3"/><path d="M2.5 3.5h2.6l2.4 11.2h11.3l2-8H6.3"/>',
    RESTAURACION: '<path d="M7 3v8M4.5 3v4.5a2.5 2.5 0 0 0 5 0V3M7 11v10"/><path d="M17 21V3c-2.2 1.3-3.3 3.6-3.3 6.5V13H17"/>',
    TRANSPORTE:   '<path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2"/><circle cx="7" cy="17" r="2"/><path d="M9 17h6"/><circle cx="17" cy="17" r="2"/>',
    OCIO:         '<path d="M3.5 8.5V6h17v2.5a2.5 2.5 0 0 0 0 5V18h-17v-4.5a2.5 2.5 0 0 0 0-5z"/><path d="M14 6v12" stroke-dasharray="1.6 1.8"/>',
    ROPA:         '<path d="M10 6a2 2 0 1 1 2.8 1.8c-.5.2-.8.7-.8 1.2v.8"/><path d="M12 9.8 3.2 16c-.8.6-.4 1.8.6 1.8h16.4c1 0 1.4-1.2.6-1.8z"/>',
    HOGAR:        '<path d="M3.5 11 12 4l8.5 7"/><path d="M6 9.5V20h12V9.5"/><path d="M10 20v-5.5h4V20"/>',
    ELECTRONICA:  '<rect x="4.5" y="5" width="15" height="10" rx="1.2"/><path d="M2.5 19h19M9 15l-.8 4M15 15l.8 4"/>',
    SALUD:        '<path d="M12 20s-7.5-4.6-7.5-10A4.3 4.3 0 0 1 12 7.4 4.3 4.3 0 0 1 19.5 10c0 5.4-7.5 10-7.5 10z"/><path d="M12 10.5v4M10 12.5h4"/>',
    OTROS:        '<path d="M3.5 12.5V4.5h8l9 9-8 8z"/><circle cx="8" cy="8.5" r="1.3"/>',
    SUSCRIPCIONES: '<path d="M20 11a8 8 0 0 0-14.5-4.6L4 8"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.5 4.6L20 16"/><path d="M20 20v-4h-4"/>',
    BIZUM:        '<rect x="7" y="2.5" width="10" height="19" rx="2.2"/><path d="M10.5 18h3"/><path d="M9.5 9.5h5M12.5 7.5l2 2-2 2"/>',
    TRANSFERENCIA: '<path d="M4 8h14l-3.5-3.5M20 16H6l3.5 3.5"/>',
    INGRESOS:     '<path d="M12 3v11M7.5 9.5 12 14l4.5-4.5"/><path d="M4 15v4.5h16V15"/>',
    COMISIONES:   '<circle cx="7.5" cy="7.5" r="2"/><circle cx="16.5" cy="16.5" r="2"/><path d="M18 6 6 18"/>'
};
function iconoCategoria(categoria, clase = 'icono-cat') {
    const clave = String(categoria || '').toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
    const trazos = ICONOS_CATEGORIA[clave] || ICONOS_CATEGORIA.OTROS;
    return `<svg class="${clase}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" ` +
           `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${trazos}</svg>`;
}

// Un color FIJO por categoría: la misma categoría se reconoce siempre por su
// color. Las que no están aquí sacan uno de la reserva según su nombre.
// Los colores viven en el CSS (--cat-*): salen de la paleta de la página y
// cambian con el tema claro/oscuro como todo lo demás.
const CATEGORIAS_CON_COLOR = new Set(['ALIMENTACION', 'RESTAURACION', 'TRANSPORTE', 'OCIO', 'ROPA', 'HOGAR',
    'ELECTRONICA', 'SALUD', 'SUSCRIPCIONES', 'BIZUM', 'TRANSFERENCIA', 'COMISIONES', 'INGRESOS', 'OTROS']);
const COLOR_OTRAS = 'var(--cat-otras)';
function colorCategoria(categoria) {
    const clave = String(categoria || '').toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
    if (CATEGORIAS_CON_COLOR.has(clave)) return `var(--cat-${clave.toLowerCase()})`;
    let h = 0;
    for (const ch of clave) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return `var(--cat-r${(h % 4) + 1})`;
}

const MAX_PORCIONES = 6;      // más que esto y el donut no se lee: el resto va a "Otras"

function pintarCategorias(datos) {
    const principal = (datos.monedas || []).includes('EUR') ? 'EUR' : (datos.monedas || [])[0];
    const todas = (datos.categorias || []).filter(c => c.moneda === principal && c.total_centimos > 0);
    const caja = $('listaCategoriasGasto');

    if (todas.length === 0) {
        // Discreto y sin cambiar la altura del bloque (la da .lista-reparto).
        caja.innerHTML = `<p class="vacio-discreto">Sin gasto en este periodo.</p>`;
        return;
    }

    const total = todas.reduce((n, c) => n + c.total_centimos, 0);
    const movimientos = todas.reduce((n, c) => n + (c.tiquets || 0), 0);
    // Seis porciones y "Otras" con el resto; si solo sobra una, va con su nombre.
    let porciones = todas.map(c => ({ ...c, color: colorCategoria(c.categoria) }));
    if (porciones.length > MAX_PORCIONES + 1) {
        const resto = porciones.slice(MAX_PORCIONES);
        porciones = porciones.slice(0, MAX_PORCIONES).concat({
            categoria: 'Otras', otras: resto, color: COLOR_OTRAS,
            total_centimos: resto.reduce((n, c) => n + c.total_centimos, 0),
            tiquets: resto.reduce((n, c) => n + (c.tiquets || 0), 0)
        });
    }
    for (const p of porciones) p.pct = (p.total_centimos / total) * 100;

    // Cada porción, un arco del mismo círculo con stroke-dasharray. Un pequeño
    // hueco entre porciones las separa sin bordes.
    const R = 40, C = 2 * Math.PI * R, HUECO = porciones.length > 1 ? 0.9 : 0;
    let acumulado = 0;
    const arcos = porciones.map((p, i) => {
        const largo = Math.max(0.01, (p.total_centimos / total) * C - HUECO);
        const arco = `<circle class="donut-seg" data-porcion="${i}" r="${R}" cx="50" cy="50"
            style="stroke: ${p.color}" stroke-dasharray="${largo.toFixed(2)} ${(C - largo).toFixed(2)}"
            stroke-dashoffset="${(-acumulado).toFixed(2)}"></circle>`;
        acumulado += (p.total_centimos / total) * C;
        return arco;
    }).join('');

    caja.innerHTML = `
        <div class="reparto-donut">
            <div class="donut">
                <svg viewBox="0 0 100 100" role="img" aria-label="Reparto del gasto por categoría">${arcos}</svg>
                <div class="donut-centro"><b class="cifra">${esc(formatearImporte(total, principal))}</b>
                    <small>${esc(plural(movimientos, 'movimiento'))}</small></div>
            </div>
            <div class="leyenda-donut">${porciones.map((p, i) => `
                <div class="leyenda-fila" data-porcion="${i}" style="--c: ${p.color}">
                    <span class="punto"></span>
                    ${p.otras ? '<span></span>' : iconoCategoria(p.categoria)}
                    <span class="truncate">${esc(p.otras ? 'Otras' : mayuscula(String(p.categoria).toLowerCase()))}</span>
                    <span class="pct">${esc(formatearPorcentaje(p.pct))}</span>
                    <span class="cifra">${esc(formatearImporte(p.total_centimos, principal))}</span>
                </div>`).join('')}
            </div>
        </div>`;

    // El detalle de cada porción: al pasar el ratón o manteniendo pulsado.
    const detalle = (p) => ({
        titulo: p.otras ? 'Otras categorías' : mayuscula(String(p.categoria).toLowerCase()),
        filas: [
            ['Gasto', formatearImporte(p.total_centimos, principal)],
            ['Del total', formatearPorcentaje(p.pct)],
            ['Movimientos', String(p.tiquets || 0)]
        ],
        lista: p.otras ? p.otras.map(c => ({
            nombre: mayuscula(String(c.categoria).toLowerCase()),
            importe: formatearImporte(c.total_centimos, principal),
            extra: formatearPorcentaje((c.total_centimos / total) * 100)
        })) : []
    });
    const donut = caja.querySelector('.donut');
    for (const el of caja.querySelectorAll('[data-porcion]')) {
        const p = porciones[Number(el.dataset.porcion)];
        el.dataset.categoria = p.otras ? '' : p.categoria;
        conTip(el, () => detalle(p));
        // Una línea de la leyenda resalta su porción, y al revés.
        el.addEventListener('mouseenter', () => {
            for (const x of caja.querySelectorAll(`[data-porcion="${el.dataset.porcion}"]`)) x.classList.add('activo');
            donut.classList.add('con-activo');
        });
        el.addEventListener('mouseleave', () => {
            for (const x of caja.querySelectorAll('.activo')) x.classList.remove('activo');
            donut.classList.remove('con-activo');
        });
    }
}

/** El datalist del filtro, para no tener que recordar cómo se escribió. */
function rellenarListaCategorias(datos) {
    for (const c of (datos.categorias || [])) if (c.categoria && c.categoria[0] !== '(') CATEGORIAS_VISTAS.add(c.categoria);
    const nombres = [...new Set((datos.categorias || []).map(c => c.categoria))]
        .filter(n => n && n !== '(sin categoría)');
    $('listaCategorias').innerHTML = nombres.map(n => `<option value="${esc(n)}"></option>`).join('');
}

$('listaCategoriasGasto').addEventListener('click', (ev) => {
    if (pulsacionLarga) { pulsacionLarga = false; return; }
    const fila = ev.target.closest('[data-categoria]');
    // "Otras" no filtra: son varias categorías (su detalle sale en el recuadro).
    if (!fila || !fila.dataset.categoria) return;
    $('fCategoriaFiltro').value = fila.dataset.categoria;
    filtrarPor({});
});

// --- Dónde más gasto ---------------------------------------------------------

async function cargarComercios() {
    const { desde, hasta, titulo } = rangoVisible();
    $('rangoComercios').textContent = titulo;
    try {
        const res = await api(
            `/api/estadisticas/establecimientos?orden=gasto&limit=8&desde=${desde}&hasta=${hasta}`
        );
        pintarComercios(await res.json());
    } catch (err) {
        if (err && err.message === 'sin sesion') return;
        console.error(err);
    }
}

function pintarComercios(datos) {
    const principal = (datos.monedas || []).includes('EUR') ? 'EUR' : (datos.monedas || [])[0];
    const filas = (datos.establecimientos || []).filter(e => e.moneda === principal);
    const caja = $('listaComercios');

    if (filas.length === 0) {
        caja.innerHTML = `<p class="vacio-discreto">Sin comercios en este periodo.</p>`;
        return;
    }

    const mayor = Math.max(...filas.map(f => f.total_centimos), 1);

    caja.innerHTML = filas.map(f => `
        <div data-comercio="${esc(f.nombre)}" class="cursor-pointer">
            <div class="flex items-baseline justify-between gap-3 text-sm min-w-0">
                <span class="truncate min-w-0">${esc(f.nombre)}</span>
                <span class="cifra whitespace-nowrap">${esc(formatearImporte(f.total_centimos, f.moneda))}</span>
            </div>
            <div class="barra-fondo mt-1">
                <div class="barra" style="width: ${Math.max(2, (f.total_centimos / mayor) * 100)}%"></div>
            </div>
            <div class="text-xs mt-0.5" style="color: var(--texto-2)">
                ${esc(plural(f.visitas, 'visita'))}${f.ciudad ? ` · ${esc(f.ciudad)}` : ''}
            </div>
        </div>`).join('');
}

$('listaComercios').addEventListener('click', (ev) => {
    const fila = ev.target.closest('[data-comercio]');
    if (!fila) return;
    $('fBuscar').value = fila.dataset.comercio;
    filtrarPor({});
});

// --- Mapa --------------------------------------------------------------------
// Mapa de Google. Los comercios son marcadores HTML (AdvancedMarkerElement):
// con unos cientos va sobrado, y así el punto es CSS con los colores de la
// paleta. El tema claro/oscuro lo pone Google (colorScheme), y como solo se
// puede elegir al crear el mapa, al cambiar de tema el mapa se rehace.

const gastoDe = (punto) => {
    const m = (punto.por_moneda || []).find(x => x.moneda === 'EUR') || (punto.por_moneda || [])[0];
    return m ? m.total_centimos : 0;
};

let temaDelMapa = null;
let puntosDelMapa = [];
let marcadores = [];
let agrupador = null;      // MarkerClusterer: junta los puntos cercanos al alejarse

/** El recuadro de un grupo: todos sus comercios, del que más gasto al que menos. */
function tooltipDeGrupo(puntos) {
    const orden = [...puntos].sort((a, b) => gastoDe(b) - gastoDe(a));
    const total = orden.reduce((s, p) => s + gastoDe(p), 0);
    const visitas = orden.reduce((s, p) => s + (p.visitas || 0), 0);
    return `<b>${esc(plural(orden.length, 'comercio'))}</b><br>
        ${esc(plural(visitas, 'visita'))} · ${esc(formatearImporte(total))}
        <div class="tip-lista">${orden.map(p => `
            <div class="tip-item" data-ir-lat="${p.latitud}" data-ir-lng="${p.longitud}" role="button">
                <span class="tip-item-nombre">${esc(p.nombre)}</span>
                <span class="cifra">${esc(formatearImporte(gastoDe(p)))}</span>
                <span class="tip-item-extra">${esc(plural(p.visitas, 'visita'))}${p.ciudad ? ` · ${esc(p.ciudad)}` : ''}</span>
            </div>`).join('')}</div>`;
}

const renderizadorGrupos = {
    render({ count, position, markers }) {
        const puntos = markers.map(m => m.__punto).filter(Boolean);
        const div = document.createElement('div');
        div.className = 'grupo-mapa';
        const lado = Math.round(30 + Math.sqrt(Math.min(count, 60)) * 4);
        div.style.width = div.style.height = `${lado}px`;
        div.textContent = String(count);
        const m = new google.maps.marker.AdvancedMarkerElement({
            position, content: div, zIndex: 1000 + count, title: plural(count, 'comercio')
        });
        if (puedeApuntar()) {
            div.addEventListener('mouseenter', () => {
                abrirGloboPasar(tooltipDeGrupo(puntos), div);
            });
            div.addEventListener('mouseleave', cerrarGloboPasarLuego);
        }
        return m;
    }
};
let globoPasar = null, globoPulsar = null;

// El globo de "pasar el ratón" espera un momento antes de cerrarse: da tiempo a
// llevar el ratón hasta él para hacer scroll o pulsar un tiquet.
let temporizadorGlobo = null;
function cerrarGloboPasar() {
    clearTimeout(temporizadorGlobo);
    const tip = $('tipMapa');
    tip.classList.remove('visible');
    tip.hidden = true;
}
function cerrarGloboPasarLuego() {
    clearTimeout(temporizadorGlobo);
    temporizadorGlobo = setTimeout(cerrarGloboPasar, 260);
}
/**
 * El recuadro de un punto o grupo del mapa, junto a su elemento: encima si
 * cabe dentro del mapa y, si no (punto cerca del borde de arriba), DEBAJO. El
 * globo de Google solo se abría hacia arriba y se cortaba.
 */
function abrirGloboPasar(html, elemento) {
    clearTimeout(temporizadorGlobo);
    const tip = $('tipMapa');
    tip.innerHTML = `<div class="globo-mapa">${html}</div>`;
    tip.hidden = false;
    const r = elemento.getBoundingClientRect();
    const zona = mapa ? mapa.getDiv().getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
    const ancho = tip.offsetWidth, alto = tip.offsetHeight;
    const arriba = Math.max(8, zona.top);
    let y = r.top - alto - 10;
    if (y < arriba) y = r.bottom + 10;
    if (y + alto > window.innerHeight - 8) y = Math.max(8, window.innerHeight - alto - 8);
    const x = Math.max(8, Math.min(r.left + r.width / 2 - ancho / 2, window.innerWidth - ancho - 8));
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
    tip.classList.add('visible');
}
$('tipMapa').addEventListener('mouseenter', () => clearTimeout(temporizadorGlobo));
$('tipMapa').addEventListener('mouseleave', cerrarGloboPasarLuego);
window.addEventListener('scroll', cerrarGloboPasar, { passive: true });
// Dentro de los globos: un tiquet se abre en el editor y un comercio de un
// grupo acerca el mapa hasta él.
document.addEventListener('click', (ev) => {
    const globo = ev.target.closest('.globo-mapa');
    if (!globo) return;
    const tiquet = ev.target.closest('[data-tiquet]');
    if (tiquet) {
        if (globoPasar) cerrarGloboPasar();
        if (globoPulsar) globoPulsar.close();
        Editor.abrirPorIds([Number(tiquet.dataset.tiquet)]);
        return;
    }
    const sitio = ev.target.closest('[data-ir-lat]');
    if (sitio && mapa) {
        cerrarGloboPasar();
        mapa.panTo({ lat: Number(sitio.dataset.irLat), lng: Number(sitio.dataset.irLng) });
        mapa.setZoom(17);
    }
});
let cargaGoogle = null;
let configMapa = null;

/** Carga la API de Google Maps una vez. Lanza si no hay clave o no carga. */
function cargarGoogleMaps() {
    if (window.google && google.maps && google.maps.marker) return Promise.resolve();
    if (cargaGoogle) return cargaGoogle;
    cargaGoogle = (async () => {
        const res = await api('/api/mapa/config');
        configMapa = await res.json();
        if (!configMapa.clave) throw new Error('sin clave');
        await new Promise((ok, mal) => {
            window.__alCargarMapa = ok;
            // Clave rechazada por Google (dominio no autorizado, API sin activar).
            window.gm_authFailure = () => mostrarVacioMapa(
                'Google ha rechazado la clave del mapa: revisa GOOGLE_MAPS_API_KEY y sus restricciones.');
            const s = document.createElement('script');
            s.src = 'https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(configMapa.clave) +
                    `&v=weekly&loading=async&libraries=marker&language=${window.IDIOMA === 'en' ? 'en' : 'es'}&region=ES&callback=__alCargarMapa`;
            s.async = true;
            s.onerror = () => mal(new Error('no carga'));
            document.head.appendChild(s);
        });
    })();
    cargaGoogle.catch(() => { cargaGoogle = null; });
    return cargaGoogle;
}

function crearMapa(centro, zoom) {
    const tema = temaEfectivo() === 'dark' ? 'dark' : 'light';
    temaDelMapa = tema;
    $('mapa').innerHTML = '';
    mapa = new google.maps.Map($('mapa'), {
        mapId: configMapa.map_id,
        colorScheme: tema === 'dark' ? google.maps.ColorScheme.DARK : google.maps.ColorScheme.LIGHT,
        center: centro, zoom,
        disableDefaultUI: true,
        zoomControl: true,
        fullscreenControl: true,
        // Dentro de una página que hace scroll: la rueda sola no secuestra el
        // scroll, hace falta Ctrl (en el móvil, dos dedos).
        gestureHandling: 'cooperative',
        clickableIcons: false
    });
    globoPulsar = new google.maps.InfoWindow({ maxWidth: 280 });
    mapa.addListener('click', () => globoPulsar.close());
    // Al mover o acercar el mapa, el recuadro dejaría de estar junto a su punto.
    mapa.addListener('dragstart', cerrarGloboPasar);
    mapa.addListener('zoom_changed', cerrarGloboPasar);
}

function ponerMarcadores(puntos) {
    if (agrupador) { agrupador.clearMarkers(); agrupador.setMap(null); agrupador = null; }
    for (const m of marcadores) m.map = null;
    marcadores = [];
    if (!mapa) return;
    const mayor = Math.max(...puntos.map(gastoDe), 1);
    for (const p of puntos) {
        // El tamaño va con la raíz del gasto: es como el ojo compara círculos.
        const lado = Math.round(2 * (7 + Math.sqrt(gastoDe(p) / mayor) * 17));
        const punto = document.createElement('div');
        punto.className = 'punto-mapa' + (p.aproximada ? ' aproximado' : '');
        punto.style.width = punto.style.height = `${lado}px`;
        // Sin mapa: lo pone el agrupador (o el final, si la librería no cargó).
        const m = new google.maps.marker.AdvancedMarkerElement({
            position: { lat: p.latitud, lng: p.longitud }, content: punto, title: p.nombre
        });
        m.__punto = p;
        if (puedeApuntar()) {
            punto.addEventListener('mouseenter', () => {
                abrirGloboPasar(tooltipDe(p), punto);
            });
            punto.addEventListener('mouseleave', cerrarGloboPasarLuego);
        }
        m.addListener('click', () => {
            cerrarGloboPasar();
            globoPulsar.setContent(`<div class="globo-mapa">${popupDe(p)}</div>`);
            globoPulsar.open({ map: mapa, anchor: m });
        });
        marcadores.push(m);
    }
    if (window.markerClusterer && marcadores.length) {
        agrupador = new markerClusterer.MarkerClusterer({
            map: mapa, markers: marcadores, renderer: renderizadorGrupos,
            onClusterClick: (ev, grupo, mapaG) => {
                cerrarGloboPasar();
                if (grupo.bounds) mapaG.fitBounds(grupo.bounds, 48);
            }
        });
    } else {
        for (const m of marcadores) m.map = mapa;
    }
}

/** El encuadre sobre mis puntos, con margen y sin acercarse demasiado. */
function encuadrarPuntos(puntos) {
    if (!mapa || puntos.length === 0) return;
    if (puntos.length === 1) {
        mapa.setCenter({ lat: puntos[0].latitud, lng: puntos[0].longitud });
        mapa.setZoom(14);
        return;
    }
    const limites = new google.maps.LatLngBounds();
    for (const p of puntos) limites.extend({ lat: p.latitud, lng: p.longitud });
    mapa.fitBounds(limites, 48);
    google.maps.event.addListenerOnce(mapa, 'idle', () => {
        if (mapa.getZoom() > 15) mapa.setZoom(15);
    });
}

// El mapa enseña lo del periodo que se está viendo en "Gasto en el tiempo".
let peticionMapa = 0;
async function cargarMapa() {
    const esta = ++peticionMapa;
    try {
        const { desde, hasta } = rangoVisible();
        const res = await api(Tiempo.periodo === 'todo'
            ? '/api/estadisticas/mapa'
            : `/api/estadisticas/mapa?desde=${desde}&hasta=${hasta}`);
        const datos = await res.json();
        // Si mientras tanto se ha cambiado otra vez de periodo, esta ya no vale.
        if (esta !== peticionMapa) return;
        await pintarMapa(datos);
    } catch (err) {
        if (err && err.message === 'sin sesion') return;
        console.error(err);
    }
}

async function pintarMapa(datos) {
    const puntos = (datos.puntos || []).filter(
        p => Number.isFinite(p.latitud) && Number.isFinite(p.longitud)
    );
    puntosDelMapa = puntos;

    const aproximados = puntos.filter(p => p.aproximada).length;
    const titulo = rangoVisible().titulo;
    $('leyendaMapa').textContent = `${titulo} · ` + (puntos.length
        ? plural(puntos.length, 'comercio') +
          (aproximados ? ` · ${plural(aproximados, 'aproximado')}` : '')
        : 'sin compras ubicadas');

    if (puntos.length === 0) {
        // Con el mapa ya puesto se queda, solo que vacío: cambiar de periodo no
        // tiene que hacer desaparecer el bloque.
        if (mapa) { cerrarGloboPasar(); globoPulsar.close(); ponerMarcadores([]); return; }
        mostrarVacioMapa('Sin compras con ubicación en este periodo.');
        return;
    }
    try {
        await cargarGoogleMaps();
    } catch (err) {
        mostrarVacioMapa(err.message === 'sin clave'
            ? 'Falta la clave del mapa (GOOGLE_MAPS_API_KEY en el .env).'
            : 'No se ha podido cargar Google Maps (¿sin conexión?).');
        return;
    }

    $('vacioMapa').classList.add('hidden');
    $('mapa').style.display = '';

    const tema = temaEfectivo() === 'dark' ? 'dark' : 'light';
    if (!mapa) {
        crearMapa({ lat: puntos[0].latitud, lng: puntos[0].longitud }, 11);
        ponerMarcadores(puntos);
        encuadrarPuntos(puntos);
        return;
    }
    if (tema !== temaDelMapa) {
        // El esquema de color solo se elige al crear: se rehace donde estaba.
        crearMapa(mapa.getCenter(), mapa.getZoom());
        ponerMarcadores(puntos);
        return;
    }
    ponerMarcadores(puntos);
    encuadrarPuntos(puntos);
}

function mostrarVacioMapa(texto) {
    $('vacioMapa').textContent = texto;
    $('vacioMapa').classList.remove('hidden');
    $('mapa').style.display = 'none';
}

function tooltipDe(punto) {
    const m = (punto.por_moneda || []).find(x => x.moneda === 'EUR') || (punto.por_moneda || [])[0];
    const importe = m ? formatearImporte(m.total_centimos, m.moneda) : formatearImporte(0);
    return `
        <b>${esc(punto.nombre)}</b><br>
        ${esc(plural(punto.visitas, 'visita'))} · ${esc(importe)}<br>
        <span style="opacity:.75">Última: ${esc(formatearFechaTiquet(punto.ultima_visita))}</span>
        ${punto.aproximada ? '<br><span style="opacity:.75">Ubicación aproximada</span>' : ''}
        ${(punto.ultimos_tiquets || []).length ? `<div class="tip-lista">${punto.ultimos_tiquets.map(t => `
            <div class="tip-item"${t.id ? ` data-tiquet="${t.id}" role="button"` : ''}>
                <span class="tip-item-nombre">${esc(formatearFechaTiquet(t.fecha_compra))}</span>
                <span class="cifra">${esc(formatearImporte(t.total_centimos || 0, t.moneda))}</span>
                ${t.tipo_documento ? `<span class="tip-item-extra">${esc(mayuscula(String(t.tipo_documento).toLowerCase()))}</span>` : ''}
            </div>`).join('')}</div>` : ''}`;
}

function popupDe(punto) {
    const ultimos = (punto.ultimos_tiquets || []).map(t => `
        <li style="display:flex; justify-content:space-between; gap:.75rem">
            <span>${esc(formatearFechaTiquet(t.fecha_compra))}</span>
            <span class="cifra">${esc(formatearImporte(t.total_centimos, t.moneda))}</span>
        </li>`).join('');

    return `
        <div>
            <b>${esc(punto.nombre)}</b>
            <div style="opacity:.75">${esc(punto.direccion || '')} ${esc(punto.ciudad || '')}</div>
            ${punto.place_id ? `<a class="enlace-maps" target="_blank" rel="noopener"
                href="https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(punto.place_id)}">Abrir en Google Maps</a>` : ''}
            ${punto.aproximada ? '<div style="opacity:.75">Ubicación aproximada</div>' : ''}
            <ul style="margin-top:.5rem">${ultimos}</ul>
        </div>`;
}

// --- Pestañas del móvil ------------------------------------------------------

function cambiarVista(vista) {
    document.body.classList.remove('vista-historial', 'vista-analisis', 'vista-mapa', 'vista-comercios');
    document.body.classList.add(`vista-${vista}`);
    for (const b of $('pestanas').querySelectorAll('[data-vista]')) {
        b.setAttribute('aria-selected', String(b.dataset.vista === vista));
    }
    // Leaflet necesita saber que ya se le ve; la tira de meses, lo mismo: con la
    // pestaña cerrada medía 0 y no pudo colocarse en el panel del medio.
    if (vista === 'mapa' && !mapa && puntosDelMapa.length) cargarMapa();
    if (vista === 'analisis' && Tiempo.periodo === 'mes') setTimeout(centrarTira, 60);
}

$('pestanas').addEventListener('click', (ev) => {
    const boton = ev.target.closest('[data-vista]');
    if (boton) cambiarVista(boton.dataset.vista);
});

// Si cambia el tema del sistema hay que repintar: los colores de la gráfica y
// del mapa se leyeron de los tokens cuando se dibujaron.
if (window.matchMedia) {
    const oscuro = window.matchMedia('(prefers-color-scheme: dark)');
    if (oscuro.addEventListener) {
        oscuro.addEventListener('change', repintarPorTema);
    }
}

// =============================================================================
// EDITOR / PANTALLA DE CONFIRMACIÓN
// =============================================================================
// Recorre una cola de fichas. Con una sola ficha es el formulario de corrección;
// con varias es la confirmación en cadena de una foto con varios tiquets.

let recuadroActual = null;

/** Un tiquet que no está en la lista cargada. El historial pagina; el editor no. */
async function traerTiquet(id) {
    try {
        const res = await api(`/api/tickets/${id}`);
        if (!res.ok) return null;
        return await res.json();
    } catch (err) {
        if (err && err.message === 'sin sesion') return null;
        console.error(err);
        return null;
    }
}

/**
 * Las fichas que salieron de la misma foto, en orden de lectura.
 *
 * Se piden al servidor y no se buscan en TICKETS porque el historial pagina y
 * ordena como quiera quien mira: tres hermanas pueden estar en tres páginas
 * distintas, o no estar cargadas todavía.
 */
async function traerHermanas(hash) {
    try {
        const res = await api(`/api/tickets?hash=${encodeURIComponent(hash)}&orden=subida&dir=asc&limit=50`);
        if (!res.ok) return [];
        const datos = await res.json();
        return datos.tiquets || [];
    } catch (err) {
        if (err && err.message === 'sin sesion') return [];
        console.error(err);
        return [];
    }
}

const Editor = {
    cola: [],
    indice: 0,
    // El formulario tal y como se pintó. Lo que hay ahora comparado con esto es
    // lo que decide si cerrar pierde algo.
    limpio: null,

    /** Abre el editor con estos ids, estén o no en la lista cargada. */
    async abrirPorIds(ids, opciones = {}) {
        // Un id negativo es un movimiento del banco (así llegan en las
        // estadísticas): se abre su ficha, no el editor de tiquets.
        if (ids.length === 1 && ids[0] < 0) { abrirMovimiento(-ids[0]); return; }
        ids = ids.filter(id => id > 0);
        const fichas = [];
        for (const id of ids) {
            const ficha = TICKETS.find(t => t.id === id) || await traerTiquet(id);
            if (ficha) fichas.push(ficha);
        }
        if (fichas.length === 0) return;
        this.abrir(fichas, opciones);
    },

    // alTerminar: se llama al cerrar el editor, se cierre como se cierre.
    alTerminar: null,

    abrir(fichas, { alTerminar = null } = {}) {
        this.alTerminar = alTerminar;
        // Los establecimientos guardados, para ofrecerlos al escribir el nombre.
        cargarEstablecimientos();
        this.cola = fichas;
        this.indice = 0;
        $('editorOverlay').classList.remove('hidden');
        document.body.classList.add('overflow-hidden');
        pintarVolver('editorOverlay');
        this.pintarFichaActual();
    },

    cerrar() {
        const alTerminar = this.alTerminar;
        this.alTerminar = null;
        if (alTerminar) setTimeout(alTerminar, 0);
        $('editorOverlay').classList.add('hidden');
        document.body.classList.remove('overflow-hidden');
        this.cola = [];
        this.indice = 0;
        this.limpio = null;
        recuadroActual = null;
        $('editorRecuadro').classList.add('hidden');
        $('editorHermanas').classList.add('hidden');
        ocultarAvisoEditor();
        buscadorEditor.cerrar();
        // Si se llegó desde otra ficha (un establecimiento, un movimiento), se vuelve a ella.
        volverDeFicha();
    },

    get fichaActual() { return this.cola[this.indice] || null; },
    get haySiguiente() { return this.indice < this.cola.length - 1; },

    /** ¿Hay algo escrito que se perdería? */
    get sucio() {
        if (this.limpio === null) return false;
        return JSON.stringify(recogerFormulario()) !== this.limpio;
    },

    /**
     * Pide permiso para abandonar la ficha. Un clic de más en el velo no puede
     * borrar diez minutos de corrección, y preguntarlo siempre convertiría el
     * diálogo en un trámite que se cierra sin leer.
     */
    async puedoAbandonar() {
        if (!this.sucio) return true;
        return pedirConfirmacion({
            titulo: 'Hay cambios sin guardar',
            cuerpo: 'Lo que has escrito en esta ficha se perderá.',
            aceptar: 'Descartar cambios',
            cancelar: 'Seguir editando'
        });
    },

    async intentarCerrar() {
        if (await this.puedoAbandonar()) this.cerrar();
    },

    /** Salta a otra ficha de la misma foto. */
    async irA(id) {
        if (id === (this.fichaActual && this.fichaActual.id)) return;
        if (!await this.puedoAbandonar()) return;

        const enCola = this.cola.findIndex(f => f.id === id);
        if (enCola >= 0) {
            this.indice = enCola;
            return this.pintarFichaActual();
        }
        // Fuera de la cola, la ficha pasa a ser la cola entera: así el "ficha 2
        // de 3" sigue contando lo que de verdad hay que confirmar.
        const ficha = TICKETS.find(t => t.id === id) || await traerTiquet(id);
        if (!ficha) return;
        this.cola = [ficha];
        this.indice = 0;
        this.pintarFichaActual();
    },

    pintarFichaActual() {
        const t = this.fichaActual;
        if (!t) return this.cerrar();

        ocultarAvisoEditor();

        const enCola = this.cola.length > 1;
        // El id vive aquí: es como se nombra una ficha cuando hay que hablar de
        // ella, y en la lista no servía para reconocer nada.
        ponerTipoFicha($('editorTipo'), 'tiquet');
        $('editorTitulo').textContent = t.establecimiento_nombre || `Tiquet ${t.id}`;
        const subida = `subida el ${formatearFechaSubida(t.created_at)}`;
        $('editorProgreso').textContent = enCola
            ? `Ficha ${this.indice + 1} de ${this.cola.length} · nº ${t.id} · ${t.estado} · ${subida}`
            : `nº ${t.id} · ${t.estado} · ${subida}`;

        $('btnGuardarSiguiente').classList.toggle('hidden', !this.haySiguiente);
        $('btnSaltar').classList.toggle('hidden', !this.haySiguiente);
        $('btnGuardar').textContent = enCola && !this.haySiguiente ? 'Guardar y terminar' : 'Guardar';

        $('editorModelo').textContent = t.modelo_usado ? `Leído con ${t.modelo_usado}` : '';

        // Volver a analizar está SIEMPRE: en una ficha que la IA no llegó a leer
        // es lo que la rescata, y en una ya leída sirve para releerla con un
        // prompt nuevo o para comparar modelos. La diferencia es que lo segundo
        // sustituye datos, así que se pregunta antes.
        $('zonaReintento').classList.remove('hidden');
        $('estadoReintento').textContent = '';
        $('btnReintentar').textContent = yaLeido(t) ? 'Volver a analizar…' : 'Volver a analizar';
        rellenarSelectorDeModos($('modoReintento'));
        $('modoReintento').__pintar();

        pintarDocumentoDeLaFicha(t);
        $('editorAbrirAparte').href = t.ruta_imagen || '#';

        const totalEnFoto = Number(t.total_en_foto) || 1;
        const etiquetaPos = $('editorPosicionFoto');
        if (totalEnFoto > 1) {
            etiquetaPos.textContent = `Tiquet ${(Number(t.indice_en_foto) || 0) + 1} de ${totalEnFoto} de esta foto`;
            etiquetaPos.classList.remove('hidden');
        } else {
            etiquetaPos.classList.add('hidden');
        }

        // El recuadro marca qué trozo de una FOTO es esta ficha; sobre un PDF no
        // tiene sentido (cada factura es su propio archivo) y no se dibuja.
        recuadroActual = esPdf(t.ruta_imagen) ? null : recuadroUsable(t.recuadro);
        pintarRecuadro();

        rellenarFormulario(t);
        // La foto de la ficha: lo que hay escrito ahora mismo es "lo limpio".
        this.limpio = JSON.stringify(recogerFormulario());

        pintarHermanas(t);
        // Cada ficha empieza por arriba; si no, se abre a media página.
        const cuerpo = $('editorPanel').querySelector('.modal-cuerpo');
        if (cuerpo) cuerpo.scrollTop = 0;
    },

    siguiente() {
        if (this.haySiguiente) {
            this.indice += 1;
            this.pintarFichaActual();
        } else {
            this.cerrar();
        }
    }
};

/**
 * "Esta foto contiene N tiquets", con enlaces para saltar a los demás.
 *
 * Esto es lo que se fue de la lista: allí era estructura que estorbaba, y aquí
 * es lo único que evita dejarse a medias los tiquets de una misma foto.
 */
async function pintarHermanas(t) {
    const caja = $('editorHermanas');
    const total = Number(t.total_en_foto) || 1;

    if (total <= 1 || !t.hash_imagen) {
        caja.classList.add('hidden');
        caja.innerHTML = '';
        return;
    }

    caja.textContent = `Esta foto contiene ${total} tiquets.`;
    caja.classList.remove('hidden');

    const hermanas = await traerHermanas(t.hash_imagen);
    // Mientras se pedían, puede que ya se esté mirando otra ficha.
    if (!Editor.fichaActual || Editor.fichaActual.id !== t.id) return;
    if (hermanas.length <= 1) return;

    const enlaces = hermanas.map((h, i) => {
        const nombre = h.establecimiento_nombre || 'sin comercio';
        if (h.id === t.id) {
            return `<b style="color: var(--texto)">${i + 1}. ${esc(nombre)}</b>`;
        }
        return `<button type="button" class="underline underline-offset-2"
                        data-salto="${h.id}">${i + 1}. ${esc(nombre)}</button>`;
    });

    caja.innerHTML = `Esta foto contiene ${hermanas.length} tiquets: ${enlaces.join(' · ')}`;
}

$('editorHermanas').addEventListener('click', (ev) => {
    const boton = ev.target.closest('[data-salto]');
    if (boton) Editor.irA(Number(boton.dataset.salto));
});

/**
 * La foto —o el PDF— de la ficha que se está revisando. Una imagen va en el
 * <img> de siempre; un PDF se pinta ENTERO, todas sus páginas, porque el importe
 * de una factura suele estar en la última.
 */
function pintarDocumentoDeLaFicha(t) {
    const ruta = t.ruta_imagen || '';
    const img = $('editorFoto');
    const caja = $('editorPdf');

    // Cada ficha empieza viendo la foto entera.
    if (typeof reiniciarZoom === 'function') reiniciarZoom();

    if (!esPdf(ruta)) {
        img.src = ruta;
        img.classList.remove('hidden');
        caja.classList.add('hidden');
        caja.innerHTML = '';
        $('controlesZoom').classList.remove('hidden');
        return;
    }

    $('controlesZoom').classList.add('hidden');
    img.classList.add('hidden');
    img.src = '';
    caja.classList.remove('hidden');
    pintarPdf(caja, ruta);
}

// --- Avisos dentro del editor ------------------------------------------------

function mostrarAvisoEditor(color, html) {
    const caja = $('editorAviso');
    caja.className = 'mx-4 mt-4 p-3 rounded text-sm';
    caja.style.background = color === 'error' ? 'var(--error-fondo)' : 'var(--aviso-fondo)';
    caja.style.color = color === 'error' ? 'var(--error)' : 'var(--aviso)';
    caja.innerHTML = html;
    caja.classList.remove('hidden');
    caja.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
function ocultarAvisoEditor() {
    $('editorAviso').classList.add('hidden');
    $('editorAviso').innerHTML = '';
}

// --- Recuadro sobre la foto --------------------------------------------------
// La foto NUNCA se recorta: las N fichas de una foto múltiple comparten archivo.
// El recuadro es solo un marco encima para saber qué trozo es esta ficha.

/**
 * Rectángulo que ocupa REALMENTE la imagen dentro de su caja. El <img> es
 * object-contain, así que se centra y deja bandas; sin tenerlo en cuenta, el
 * marco saldría desplazado.
 */
function rectoImagenContenida(img) {
    const cajaAncho = img.clientWidth;
    const cajaAlto  = img.clientHeight;
    const natAncho  = img.naturalWidth;
    const natAlto   = img.naturalHeight;
    if (!cajaAncho || !cajaAlto || !natAncho || !natAlto) return null;

    const escala = Math.min(cajaAncho / natAncho, cajaAlto / natAlto);
    const ancho = natAncho * escala;
    const alto  = natAlto  * escala;
    return {
        left:   img.offsetLeft + (cajaAncho - ancho) / 2,
        top:    img.offsetTop  + (cajaAlto  - alto)  / 2,
        width:  ancho,
        height: alto
    };
}

function pintarRecuadro() {
    const marco = $('editorRecuadro');
    const img   = $('editorFoto');

    if (!recuadroActual) { marco.classList.add('hidden'); return; }
    const caja = rectoImagenContenida(img);
    if (!caja) { marco.classList.add('hidden'); return; }

    // Un poco de margen alrededor: el recuadro de la IA suele quedarse justo.
    const m = 0.012;
    const x = Math.max(0, recuadroActual.x - m), y = Math.max(0, recuadroActual.y - m);
    const ancho = Math.min(1 - x, recuadroActual.ancho + 2 * m), alto = Math.min(1 - y, recuadroActual.alto + 2 * m);
    marco.style.left   = `${caja.left + x * caja.width}px`;
    marco.style.top    = `${caja.top  + y * caja.height}px`;
    marco.style.width  = `${ancho * caja.width}px`;
    marco.style.height = `${alto  * caja.height}px`;
    marco.classList.remove('hidden');
}

/** Recuadro válido = cuatro fracciones 0..1. Si no, no se pinta nada. */
function recuadroUsable(r) {
    if (!r || typeof r !== 'object') return null;
    const v = [r.x, r.y, r.ancho, r.alto];
    if (!v.every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1)) return null;
    if (r.ancho <= 0 || r.alto <= 0) return null;
    return r;
}

$('editorFoto').addEventListener('load', pintarRecuadro);
window.addEventListener('resize', pintarRecuadro);

// --- Ausencia de fecha -------------------------------------------------------
// Solo la fecha: un importe ausente ya no deja la fila incompleta, así que no
// hay nada que confirmar. La casilla de "no imprime importe" desapareció con el
// cambio de criterio.

function sincronizarAusencias() {
    const sinFecha = $('fSinFecha').checked;

    if (sinFecha) { $('fFecha').value = ''; $('fHora').value = ''; }
    for (const campo of ['fFecha', 'fHora']) {
        $(campo).disabled = sinFecha;
        $(campo).style.opacity = sinFecha ? '.5' : '';
    }
    $('pistaSinFecha').classList.toggle('hidden', $('fFecha').value.trim() !== '');
}

$('fSinFecha').addEventListener('change', sincronizarAusencias);
$('fFecha').addEventListener('input', () => {
    // Escribir una fecha desmarca la casilla: acabo de demostrar que la lleva.
    if ($('fFecha').value.trim() !== '') $('fSinFecha').checked = false;
    sincronizarAusencias();
});

// --- Rellenar el formulario --------------------------------------------------

function textoPrecision(precision) {
    const textos = {
        manual:    'Puestas a mano. La geocodificación automática no las toca.',
        exacta:    'Situado por su dirección completa.',
        calle:     'Situado por la calle: el número no se encontró.',
        zona:      'Situado por el código postal: ubicación aproximada.',
        localidad: 'Situado por la localidad: ubicación aproximada.',
        inferida:  'Situado por el LUGAR DEDUCIDO del documento (no venía dirección impresa): ' +
                   'ubicación aproximada.',
        // El punto se encontró, pero el código postal del resultado no es el del
        // tiquet: Nominatim ha contestado con lo más parecido que tenía.
        discrepante: 'Ubicación DUDOSA: el código postal del resultado no coincide con el del ' +
                     'tiquet. Si sabes dónde es, pega las coordenadas aquí y quedarán fijadas.'
    };
    return textos[precision] || '';
}

/**
 * Reparte una dirección copiada de Google Maps en calle, ciudad, C.P. y país.
 *
 *   "203-206 Piccadilly, London W1J 9HD, Reino Unido"
 *   "Rambla d'Ègara, 30, 08221 Terrassa, Barcelona, España"
 *
 * El país es la última parte si no lleva números. La ciudad es la parte que
 * contiene el código postal (buscando desde el final); lo que va detrás de ella
 * es la provincia y se descarta; lo de delante es la calle.
 */
const PATRONES_CP = [
    /\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/i,   // Reino Unido: W1J 9HD
    /\b([A-Z]\d[A-Z]\s?\d[A-Z]\d)\b/i,             // Canadá: K1A 0B1
    /\b(\d{4}\s?[A-Z]{2})\b/,                       // Países Bajos: 1012 AB
    /\b(\d{3}-\d{4}|\d{5}-\d{3}|\d{2}-\d{3})\b/,  // Japón, Brasil, Polonia
    /\b(\d{4,6})\b/                                  // el resto: 08221, 75001, 1010
];
function buscarCp(texto) {
    for (const re of PATRONES_CP) {
        const m = texto.match(re);
        if (m) return m[1];
    }
    return null;
}
// Solo se toma la última parte como país si ES un país: Google Maps a menudo
// acaba en la provincia ("…, 08221 Terrassa, Barcelona") y no en el país.
const PAISES = new Set([
    'españa', 'spain', 'espanya', 'andorra', 'portugal', 'francia', 'france', 'italia', 'italy',
    'alemania', 'germany', 'deutschland', 'reino unido', 'united kingdom', 'uk', 'irlanda', 'ireland',
    'países bajos', 'paises bajos', 'netherlands', 'holanda', 'bélgica', 'belgica', 'belgium',
    'suiza', 'switzerland', 'austria', 'luxemburgo', 'dinamarca', 'denmark', 'suecia', 'sweden',
    'noruega', 'norway', 'finlandia', 'finland', 'islandia', 'iceland', 'polonia', 'poland',
    'república checa', 'republica checa', 'chequia', 'czechia', 'hungría', 'hungria', 'hungary',
    'grecia', 'greece', 'croacia', 'croatia', 'eslovenia', 'rumanía', 'rumania', 'romania',
    'bulgaria', 'malta', 'chipre', 'turquía', 'turquia', 'turkey', 'marruecos', 'morocco',
    'estados unidos', 'united states', 'usa', 'ee. uu.', 'eeuu', 'canadá', 'canada', 'méxico', 'mexico',
    'argentina', 'chile', 'colombia', 'perú', 'peru', 'brasil', 'brazil', 'uruguay', 'cuba',
    'japón', 'japon', 'japan', 'china', 'corea del sur', 'south korea', 'tailandia', 'thailand',
    'india', 'australia', 'nueva zelanda', 'new zealand', 'egipto', 'egypt', 'emiratos árabes unidos',
    'singapur', 'singapore', 'vietnam', 'indonesia', 'filipinas', 'sudáfrica', 'sudafrica'
]);
const esPais = (texto) => PAISES.has(String(texto || '').trim().toLowerCase());

function parsearDireccionPegada(texto) {
    const partes = String(texto || '').split(',').map(s => s.trim()).filter(Boolean);
    if (partes.length < 2) return null;

    let pais = '';
    if (partes.length >= 2 && esPais(partes[partes.length - 1])) pais = partes.pop();

    // La parte con el código postal, buscando desde el final.
    let iCiudad = -1, cp = '';
    for (let i = partes.length - 1; i >= 1; i -= 1) {
        const encontrado = buscarCp(partes[i]);
        if (encontrado) { iCiudad = i; cp = encontrado; break; }
    }
    let ciudad;
    if (iCiudad >= 0) {
        ciudad = partes[iCiudad].replace(cp, '').replace(/\s{2,}/g, ' ').replace(/^[\s-]+|[\s-]+$/g, '');
        // "08001, Barcelona": el C.P. iba solo en su parte y la ciudad en la siguiente.
        if (!ciudad && partes[iCiudad + 1]) ciudad = partes[iCiudad + 1];
    } else {
        iCiudad = partes.length - 1;
        ciudad = partes[iCiudad];
    }
    const direccion = partes.slice(0, iCiudad).join(', ');
    if (!direccion) return null;
    return { direccion, ciudad, cp, pais };
}

function aplicarDireccionPegada({ silencioso = false } = {}) {
    const texto = $('fEstPegar').value.trim();
    if (!texto) return false;
    const d = parsearDireccionPegada(texto);
    if (!d) {
        if (!silencioso) {
            $('fEstPegarAviso').textContent = 'No he sabido repartirla: rellénala a mano aquí debajo.';
            $('apartadoDireccion').open = true;
        }
        return false;
    }
    lugarElegido = null;
    $('fEstDireccion').value = d.direccion;
    $('fEstCiudad').value = d.ciudad;
    $('fEstCp').value = d.cp;
    $('fEstPais').value = d.pais;
    // Dirección nueva: que se vuelva a situar sola. Si quieres fijar el punto
    // a mano, pega las coordenadas después.
    $('fEstCoordenadas').value = '';
    $('fEstPegar').value = '';
    $('fEstPegarAviso').textContent = 'Al guardar se situará en el mapa.';
    pintarResumenUbicacion({ pendiente: true });
    return true;
}

/** La ubicación en una línea, con su estado: así no hace falta abrir el apartado. */
function pintarResumenUbicacion({ pendiente = false, ficha = null } = {}) {
    const linea = [
        $('fEstDireccion').value.trim(),
        [$('fEstCp').value.trim(), $('fEstCiudad').value.trim()].filter(Boolean).join(' '),
        $('fEstPais').value.trim()
    ].filter(Boolean).join(', ') || $('fEstLugarInferido').value.trim();

    let estado, mal = false;
    if (pendiente) estado = 'se situará al guardar';
    else if (ficha && ficha.establecimiento_google === 'verificado' && ficha.establecimiento_precision === 'google') {
        estado = '';
    }
    else if (ficha && Number.isFinite(ficha.establecimiento_latitud)) {
        const p = ficha.establecimiento_precision;
        estado = p === 'manual' ? 'en el mapa (coordenadas a mano)'
               : ['exacta', 'calle'].includes(p) ? 'en el mapa'
               : 'en el mapa, aproximada';
    } else if (ficha && ficha.establecimiento_geo_estado === 'pendiente') estado = 'buscándola…';
    else { estado = linea ? 'no se ha encontrado: pega la dirección de Google Maps' : 'sin ubicación: pega la dirección de Google Maps'; mal = true; }

    $('resumenUbicacion').innerHTML = [linea ? esc(linea) : '',
        estado ? `<span class="estado-ubic${mal ? ' mal' : ''}">${esc(estado)}</span>` : ''].filter(Boolean).join('<br>');
    pintarEstRapido(!pendiente && !!ficha && ficha.establecimiento_google === 'verificado');
}
/** La bolita de Google y el botón para ir a la ficha del establecimiento. */
function pintarEstRapido(verificado) {
    const p = $('fEstPunto');
    p.classList.toggle('si', verificado);
    p.title = verificado ? 'Verificado por Google' : 'No verificado por Google';
    $('btnAbrirEstTiq').classList.toggle('hidden', !estElegidoId);
}
$('btnAbrirEstTiq').addEventListener('click', async () => {
    const id = estElegidoId;
    if (!id) return;
    if (!(ESTABLECIMIENTOS || []).some(x => x.id === id)) await cargarEstablecimientos();
    apilarFicha('estOverlay', `Tiquet · ${$('fEstNombre').value || ''}`, () => {
        const e = (ESTABLECIMIENTOS || []).find(x => x.id === estElegidoId);
        if (e) pintarEstRapido(e.google_estado === 'verificado');
    });
    abrirEstablecimiento(id);
});
// Pegar: si es una dirección de Maps, se reparte sola. Si no, se queda escrita
// para buscarla. Intro o "Buscar": a Google.
$('fEstPegar').addEventListener('paste', () => setTimeout(() => aplicarDireccionPegada({ silencioso: true }), 0));
$('fEstPegar').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); aplicarDireccionPegada(); }
});

// --- Tiquet compartido -----------------------------------------------------------

let personasCompartido = 2;
let soloYoRevisado = false;
/** `n` = 0 apaga el compartido. `parte` = mi parte a mano, en céntimos. */
function pintarCompartido(n, parte = null) {
    $('fCompartido').checked = n > 1;
    $('zonaCompartido').classList.toggle('hidden', !(n > 1));
    personasCompartido = n > 1 ? n : 2;
    $('fPersonas').textContent = String(personasCompartido);
    $('fMiParte').value = parte != null ? centimosAEuros(parte) : '';
    actualizarParteSugerida();
}
/** La parte a partes iguales, como sugerencia en el campo vacío. */
function actualizarParteSugerida() {
    const total = eurosACentimos($('fTotal').value);
    $('fMiParte').placeholder = total ? centimosAEuros(Math.round(total / personasCompartido)) : '';
}
$('fMiParte').addEventListener('input', actualizarParteSugerida);

// --- Pago del banco del tiquet ----------------------------------------------------
// El cargo con el que está enlazado (verlo, desenlazarlo) o los candidatos de
// esos días para enlazarlo a mano.
let pagoTiquetId = null;
async function pintarPagoTiquet(t) {
    pagoTiquetId = t.id;
    const caja = $('plTiqPago');
    let d;
    try { d = await (await api(`/api/banco/tiquet/${t.id}`)).json(); } catch (_) { caja.classList.add('hidden'); return; }
    if (pagoTiquetId !== t.id) return;
    if (!d || !d.activo) { caja.classList.add('hidden'); return; }
    caja.classList.remove('hidden');
    const m = d.movimiento;
    caja.classList.toggle('enlazado', !!m);
    caja.classList.toggle('sin-enlazar', !m);
    if (m) {
        valorPlegable('plTiqPago', `${esc(NOMBRE_CLASE[m.clase] || 'Banco')} · ${esc(fechaCorta(m.fecha))} · ${esc(formatearImporte(Math.abs(m.importe_centimos), m.moneda))}`);
        $('tiqPago').innerHTML = `
            <div class="text-sm">
                <div class="font-medium">${esc(m.nombre || m.comercio || 'Movimiento')}</div>
                <div class="text-xs mt-1" style="color: var(--texto-2)">${esc(m.concepto || '')}</div>
                <div class="text-xs" style="color: var(--texto-2)">${esc([m.cuenta_nombre, m.iban].filter(Boolean).join(' · '))}</div>
            </div>
            <div class="flex flex-wrap gap-2">
                <button type="button" class="boton boton-sm" data-pago-ver="${m.id}">Ver el movimiento</button>
                <button type="button" class="boton boton-sm" data-pago-quitar="${m.id}">Desenlazar</button>
            </div>`;
    } else {
        valorPlegable('plTiqPago', d.candidatos.length ? `sin enlazar · ${d.candidatos.length} posible${d.candidatos.length === 1 ? '' : 's'}` : 'sin enlazar');
        $('tiqPago').innerHTML = d.candidatos.length
            ? `<div class="candidatos-mov">${d.candidatos.map(c => `
                <button type="button" data-pago-enlazar="${c.id}">
                    <b>${esc(c.nombre || 'Sin comercio')}</b> · ${esc(fechaCorta(c.fecha))} · ${esc(formatearImporte(Math.abs(c.importe_centimos), c.moneda))}${c.diferencia === 0 ? ' · mismo importe' : ''}
                </button>`).join('')}</div>`
            : '<p class="vacio-discreto">No hay pagos con tarjeta sin tiquet en esos días.</p>';
    }
}
$('tiqPago').addEventListener('click', async (ev) => {
    const t = Editor.fichaActual;
    if (!t) return;
    const ver = ev.target.closest('[data-pago-ver]');
    if (ver) {
        apilarFicha('movOverlay', `Tiquet · ${$('fEstNombre').value || t.id}`, () => { if (Editor.fichaActual) pintarPagoTiquet(Editor.fichaActual); });
        abrirMovimiento(Number(ver.dataset.pagoVer));
        return;
    }
    const quitar = ev.target.closest('[data-pago-quitar]');
    const enlazar = ev.target.closest('[data-pago-enlazar]');
    const movId = quitar ? quitar.dataset.pagoQuitar : enlazar ? enlazar.dataset.pagoEnlazar : null;
    if (!movId) return;
    await api(`/api/banco/movimientos/${movId}/tiquet`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tiquet_id: quitar ? null : t.id })
    });
    aviso(quitar ? 'Desenlazado del pago' : 'Enlazado con su pago del banco');
    await actualizarEnlacesBanco();
    await cargarMovimientosHistorial();
    pintarPagoTiquet(t);
    pintarHistorial();
    cargarPanel();
});
$('fCompartido').addEventListener('change', () => {
    $('zonaCompartido').classList.toggle('hidden', !$('fCompartido').checked);
    actualizarParteSugerida();
});
for (const [id, paso] of [['btnMenosPersonas', -1], ['btnMasPersonas', 1]]) {
    $(id).addEventListener('click', () => {
        personasCompartido = Math.max(2, Math.min(50, personasCompartido + paso));
        $('fPersonas').textContent = String(personasCompartido);
        actualizarParteSugerida();
    });
}
$('fTotal').addEventListener('input', actualizarParteSugerida);

// --- Google en el editor ------------------------------------------------------------
// Ya no hay buscador aparte: los sitios de Google salen en el buscador del
// establecimiento (ver crearBuscadorEst). Aquí, elegir uno y la sugerencia
// automática al abrir una ficha sin verificar.

// El sitio de Google elegido para este tiquet: al guardar, el establecimiento
// queda verificado con él.
let lugarElegido = null;

function elegirCandidatoEditor(c) {
    // ¿Ya es un establecimiento guardado? Entonces es ese, sin más.
    const existente = (ESTABLECIMIENTOS || []).find(e => e.place_id === c.place_id);
    if (existente) {
        lugarElegido = null;
        elegirEstablecimiento(existente);
        $('fEstPegarAviso').textContent = 'Ya lo tenías guardado: es este establecimiento.';
        return;
    }
    estElegidoId = null;
    lugarElegido = c.place_id;
    $('fEstNombre').value = (c.nombre || '').toUpperCase();
    $('fEstDireccion').value = c.direccion || '';
    $('fEstCiudad').value = c.ciudad || '';
    $('fEstCp').value = c.codigo_postal || '';
    $('fEstPais').value = c.pais || '';
    $('fEstCoordenadas').value = `${c.latitud}, ${c.longitud}`;
    $('fEstPegarAviso').textContent = '';
    $('resumenUbicacion').innerHTML = `${esc(c.direccion_completa)}<br>` +
        `<span class="estado-ubic">de Google: se guardará verificado</span>`;
    valorPlegable('apartadoDireccion', esc(c.direccion_completa || ''));
}

/**
 * Al abrir una ficha cuyo comercio no está verificado en Google, se buscan ya
 * los sitios posibles: quedan en el buscador y un aviso invita a elegir.
 */
let fichaSugerida = null;
async function sugerirSitiosDeGoogle(t) {
    fichaSugerida = t.id;
    const nombre = String(t.establecimiento_nombre || '').trim();
    if (t.establecimiento_google === 'verificado') return;
    if (!nombre || nombre === 'DESCONOCIDO') return;
    if (GOOGLE_PLACES && !GOOGLE_PLACES.activa) return;
    const punto = parsearCoordenadasTexto($('fEstCoordenadas').value);
    try {
        const lista = await buscarLugarLibre([nombre, t.establecimiento_ciudad || t.establecimiento_lugar_inferido].filter(Boolean).join(' '), punto);
        if (fichaSugerida !== t.id || !lista.length) return;
        buscadorEditor.ponerGoogle(lista);
        $('fEstPegarAviso').innerHTML = `Google ha encontrado ${plural(lista.length, 'sitio')} para este nombre: ` +
            '<button type="button" class="enlace-boton" data-ver-google>elegir el bueno</button>';
    } catch (_) { /* sin Google: nada que sugerir */ }
}
$('fEstPegarAviso').addEventListener('click', (ev) => {
    if (ev.target.closest('[data-ver-google]')) { $('fEstNombre').focus(); buscadorEditor.abrir(); }
});

/** "41.1, 1.8" -> [41.1, 1.8], o null. */
function parsearCoordenadasTexto(texto) {
    const n = String(texto || '').match(/-?\d+(?:\.\d+)?/g);
    return n && n.length === 2 ? n.map(Number) : null;
}

// --- Desplegables con filtro ---------------------------------------------------
// Un campo de texto con su lista: al escribir se filtra, y la flecha de al lado
// enseña todas las opciones. Lo usan el comercio y la categoría del editor y la
// unión de establecimientos.

const sinAcentos = (s) => String(s || '').toLowerCase().normalize('NFD')
    .replace(/[̀-ͯ]/g, '').replace(/['’.]/g, '');

/**
 * Un <select> con el aspecto de los campos con lista: botón + lista propia. El
 * <select> sigue existiendo (oculto) y es donde vive el valor; al elegir se
 * lanza su 'change'. Si se cambian sus opciones o su valor desde el código,
 * hay que llamar a select.__pintar().
 */
function selectBonito(select, { arriba = false, ancho = '' } = {}) {
    const caja = document.createElement('div');
    caja.className = 'campo-con-boton select-bonito';
    if (ancho) caja.style.width = ancho;
    const boton = document.createElement('button');
    boton.type = 'button';
    boton.className = 'campo select-bonito-boton';
    const flecha = document.createElement('span');
    flecha.className = 'boton-lista';
    flecha.setAttribute('aria-hidden', 'true');
    flecha.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m6 9 6 6 6-6"/></svg>';
    const lista = document.createElement('ul');
    lista.className = 'sugerencias hidden' + (arriba ? ' hacia-arriba' : '');
    lista.setAttribute('role', 'listbox');
    select.classList.add('hidden');
    select.after(caja);
    caja.append(boton, flecha, lista);

    const pintar = () => {
        const o = select.options[select.selectedIndex];
        boton.textContent = o ? o.textContent : '';
        boton.disabled = select.disabled;
    };
    const cerrar = () => lista.classList.add('hidden');
    const abrir = () => {
        lista.innerHTML = [...select.options].map((o, i) =>
            `<li role="option" data-i="${i}" aria-selected="${i === select.selectedIndex}"><div class="sug-nombre">${esc(o.textContent)}</div></li>`).join('');
        lista.classList.remove('hidden');
    };
    boton.addEventListener('click', () => (lista.classList.contains('hidden') ? abrir() : cerrar()));
    boton.addEventListener('blur', () => setTimeout(cerrar, 150));
    boton.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape') { ev.stopPropagation(); cerrar(); }
        if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
            ev.preventDefault();
            const n = select.options.length;
            select.selectedIndex = (select.selectedIndex + (ev.key === 'ArrowDown' ? 1 : -1) + n) % n;
            pintar();
            select.dispatchEvent(new Event('change'));
            if (!lista.classList.contains('hidden')) abrir();
        }
    });
    lista.addEventListener('mousedown', (ev) => {
        const li = ev.target.closest('li[data-i]');
        if (!li) return;
        ev.preventDefault();
        select.selectedIndex = Number(li.dataset.i);
        pintar();
        cerrar();
        select.dispatchEvent(new Event('change'));
    });
    select.__pintar = pintar;
    pintar();
}

function crearCombo({ input, lista, boton, opciones, alElegir, minimo = 1, abrirAlPulsar = false }) {
    let activos = [], activa = -1;
    const cerrar = () => lista.classList.add('hidden');

    function mostrar(todos = false) {
        const texto = sinAcentos(input.value.trim());
        if (!todos && texto.length < minimo) { cerrar(); return; }
        const palabras = todos ? [] : texto.split(/\s+/).filter(Boolean);
        activos = opciones().filter(o => palabras.every(p => o.buscar.includes(p))).slice(0, 60);
        if (activos.length === 0 ||
            (!todos && activos.length === 1 && sinAcentos(activos[0].valor) === texto)) { cerrar(); return; }
        activa = -1;
        lista.innerHTML = activos.map((o, i) =>
            `<li role="option" data-indice="${i}" aria-selected="false">${o.html}</li>`).join('');
        lista.classList.remove('hidden');
    }
    function elegir(i) {
        const o = activos[i];
        if (!o) return;
        cerrar();
        alElegir(o);
    }

    input.addEventListener('input', () => mostrar());
    input.addEventListener('blur', () => setTimeout(cerrar, 150));
    // Pulsar en el campo abre la lista entera (y deja el texto marcado para
    // escribir encima), igual que la flecha.
    if (abrirAlPulsar) {
        input.addEventListener('click', () => {
            if (lista.classList.contains('hidden')) { input.select(); mostrar(true); }
        });
    }
    input.addEventListener('keydown', (ev) => {
        if (lista.classList.contains('hidden')) {
            if (ev.key === 'ArrowDown') { ev.preventDefault(); mostrar(true); }
            return;
        }
        const items = [...lista.querySelectorAll('li')];
        if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
            ev.preventDefault();
            activa = (activa + (ev.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
            items.forEach((li, i) => li.setAttribute('aria-selected', String(i === activa)));
            items[activa].scrollIntoView({ block: 'nearest' });
        } else if (ev.key === 'Enter' && activa >= 0) {
            ev.preventDefault();
            elegir(activa);
        } else if (ev.key === 'Escape') {
            ev.stopPropagation();
            cerrar();
        }
    });
    // mousedown y no click: el click llega después del blur, con la lista ya cerrada.
    lista.addEventListener('mousedown', (ev) => {
        const li = ev.target.closest('li[data-indice]');
        if (!li) return;
        ev.preventDefault();
        elegir(Number(li.dataset.indice));
    });
    if (boton) {
        boton.addEventListener('mousedown', (ev) => {
            ev.preventDefault();
            if (lista.classList.contains('hidden')) { input.focus(); mostrar(true); } else cerrar();
        });
    }
    return { mostrar, cerrar };
}

// --- Establecimientos guardados ------------------------------------------------

let ESTABLECIMIENTOS = null;
let GOOGLE_PLACES = null;      // { activa, averia, ... } del servidor

async function cargarEstablecimientos() {
    try {
        const res = await api('/api/tickets/establecimientos');
        const datos = await res.json();
        ESTABLECIMIENTOS = datos.establecimientos || [];
        GOOGLE_PLACES = datos.google || null;
    } catch (err) {
        if (err && err.message !== 'sin sesion') console.error(err);
    }
    pintarListaEstablecimientos();
}

const dondeEsta = (e) => [e.direccion, [e.codigo_postal, e.ciudad].filter(Boolean).join(' ')]
    .filter(Boolean).join(', ') || e.lugar_inferido || 'sin dirección';

/** Las opciones de establecimiento para un desplegable, sin `excluir`. */
function opcionesDeEstablecimiento(excluir = null) {
    return (ESTABLECIMIENTOS || []).filter(e => e.id !== excluir).map(e => ({
        valor: e.nombre,
        dato: e,
        buscar: sinAcentos(`${e.nombre} ${e.ciudad || ''} ${e.direccion || ''}`),
        html: `<div class="sug-nombre">${esc(e.nombre)}</div>
               <div class="sug-donde">${esc(dondeEsta(e))}${Number.isFinite(e.latitud) ? '' : ' · sin ubicar'} · ${cuentaEst(e)}</div>`
    }));
}

// El establecimiento elegido en el editor: con nombres repetidos (dos
// Mercadona) el nombre no basta para saber cuál.
let estElegidoId = null;
$('fEstNombre').addEventListener('input', () => { estElegidoId = null; pintarEstRapido(false); });

function elegirEstablecimiento(e) {
    estElegidoId = e.id;
    lugarElegido = null;
    $('fEstNombre').value = e.nombre;
    $('fEstDireccion').value = e.direccion || '';
    $('fEstCiudad').value = e.ciudad || '';
    $('fEstCp').value = e.codigo_postal || '';
    $('fEstPais').value = e.pais || '';
    $('fEstLugarInferido').value = e.lugar_inferido || '';
    $('fEstCoordenadas').value = Number.isFinite(e.latitud) ? `${e.latitud}, ${e.longitud}` : '';
    $('fEstPegarAviso').textContent = '';
    pintarResumenUbicacion({ ficha: {
        establecimiento_google: e.google_estado,
        establecimiento_latitud: e.latitud,
        establecimiento_precision: e.geo_precision,
        establecimiento_geo_estado: e.geo_estado
    } });
}

const buscadorEditor = crearBuscadorEst({
    input: $('fEstNombre'), flecha: $('btnListaEst'),
    textoGoogle: () => [$('fEstNombre').value, $('fEstCiudad').value || $('fEstLugarInferido').value]
        .map(x => x.trim()).filter(Boolean).join(' '),
    buscarGoogle: (texto) => buscarLugarLibre(texto, parsearCoordenadasTexto($('fEstCoordenadas').value)),
    accionTuyo: 'Asignar', accionGoogle: 'Es este', accionCrear: 'Nuevo',
    alTuyo: (e) => elegirEstablecimiento(e),
    alGoogle: (c) => elegirCandidatoEditor(c),
    alCrear: (nombre) => {
        $('fEstNombre').value = nombre;
        estElegidoId = null;
        lugarElegido = null;
        $('fEstPegarAviso').textContent = 'Establecimiento nuevo: al guardar se buscará en el mapa.';
    }
});

// --- Lista de establecimientos (pantalla principal) y su ficha ----------------

/** "12 [tiquet] · 34 [banco]": lo que hay de cada sitio, con iconos (HTML). */
const iconoMini = (tipo) => `<svg class="icono-mini" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" ` +
    `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONOS_TIPO[tipo]}</svg>`;
const cuentaEst = (e) => [
    e.tiquets || !e.movimientos ? `<span title="${esc(plural(e.tiquets || 0, 'tiquet'))}">${e.tiquets || 0}${iconoMini('tiquet')}</span>` : null,
    e.movimientos ? `<span title="${esc(plural(e.movimientos, 'cargo del banco', 'cargos del banco'))}">${e.movimientos}${iconoMini('banco')}</span>` : null
].filter(Boolean).join(' · ');

function pintarListaEstablecimientos() {
    const caja = $('listaEst');
    if (!caja) return;
    const todos = ESTABLECIMIENTOS || [];
    const texto = sinAcentos($('buscarEst').value.trim());
    const palabras = texto.split(/\s+/).filter(Boolean);
    const dudosos = todos.filter(e => e.google_estado === 'por_confirmar').length;
    $('filtroPorConfirmar').textContent = `${dudosos} por confirmar`;
    $('filtroPorConfirmar').classList.toggle('hidden', dudosos === 0);
    if (dudosos === 0) soloPorConfirmar = false;
    $('filtroPorConfirmar').setAttribute('aria-pressed', String(soloPorConfirmar));
    const visibles = todos.filter(e => {
        if (soloPorConfirmar && e.google_estado !== 'por_confirmar') return false;
        const pajar = sinAcentos(`${e.nombre} ${e.ciudad || ''} ${e.direccion || ''}`);
        return palabras.every(p => pajar.includes(p));
    });
    $('cuentaEst').textContent = todos.length ? String(todos.length) : '';
    caja.innerHTML = visibles.length ? visibles.map(e => `
        <button type="button" class="fila-est" data-est="${e.id}">
            <span class="truncate font-medium">${esc(e.nombre)}</span>
            <span class="text-xs whitespace-nowrap" style="color: var(--texto-2)">${cuentaEst(e)}</span>
            <span class="text-xs truncate" style="color: var(--texto-2)">
                <i class="punto-ubic ${claseUbicacion(e)}" title="${esc(textoGoogle(e))}"></i>${esc(dondeEsta(e))}</span>
        </button>`).join('')
        : `<p class="vacio-discreto px-1">${todos.length ? 'Ninguno coincide.' : 'Todavía no hay establecimientos.'}</p>`;
}
let soloPorConfirmar = false;
const claseUbicacion = (e) => e.google_estado === 'verificado' ? 'google'
    : e.google_estado === 'por_confirmar' ? 'dudoso'
    : Number.isFinite(e.latitud) ? '' : 'sin';
const textoGoogle = (e) => ({
    verificado: 'Verificado en Google',
    por_confirmar: 'Google ha encontrado varios: elige el bueno',
    sin_resultados: 'Google no lo conoce',
    descartado: 'No está en Google',
    pendiente: 'Pendiente de buscar en Google'
})[e.google_estado] || '';
$('filtroPorConfirmar').addEventListener('click', () => {
    soloPorConfirmar = !soloPorConfirmar;
    pintarListaEstablecimientos();
});
$('buscarEst').addEventListener('input', pintarListaEstablecimientos);
$('listaEst').addEventListener('click', (ev) => {
    const fila = ev.target.closest('[data-est]');
    if (fila) abrirEstablecimiento(Number(fila.dataset.est));
});

let estAbierto = null;
let estCoordenadasIniciales = '';

/** La ubicación en una línea, con su estado. */
function textoUbicacionEst(e) {
    if (e.geo_precision === 'online') return { linea: 'Tienda online', estado: 'sin ubicación, no sale en el mapa' };
    const linea = dondeEsta(e);
    const estado = e.google_estado === 'verificado' ? 'verificado en Google'
        : Number.isFinite(e.latitud) ? (e.geo_precision === 'manual' ? 'en el mapa, puesto a mano'
            : ['exacta', 'calle'].includes(e.geo_precision) ? 'en el mapa' : 'en el mapa, aproximado')
        : 'sin situar en el mapa';
    return { linea, estado };
}

function abrirEstablecimiento(id) {
    const e = (ESTABLECIMIENTOS || []).find(x => x.id === id);
    if (!e) return;
    estAbierto = e;
    ponerTipoFicha($('estTipo'), 'est');
    $('estTitulo').textContent = e.nombre;
    $('estResumen').innerHTML = cuentaEst(e);
    $('eUbicacion').innerHTML = identidadEst(e);
    $('eUbicacion').classList.toggle('verificada', e.google_estado === 'verificado');
    pintarGoogle(e);
    buscadorEst.olvidarGoogle();
    if (e.google_estado !== 'verificado' && (e.google_candidatos || []).length) buscadorEst.ponerGoogle(e.google_candidatos);
    $('eBuscar').value = '';
    $('eOnline').textContent = e.geo_precision === 'online' ? 'Tiene ubicación (no es online)' : 'Es online (sin ubicación)';
    $('eDesvincular').classList.toggle('hidden', e.google_estado !== 'verificado');
    $('eSuscripcion').classList.add('hidden');
    $('eNombre').value = e.nombre;
    $('eDireccion').value = e.direccion || '';
    $('eCiudad').value = e.ciudad || '';
    $('eCp').value = e.codigo_postal || '';
    $('ePais').value = e.pais || '';
    $('eLugar').value = e.lugar_inferido || '';
    estCoordenadasIniciales = Number.isFinite(e.latitud) ? `${e.latitud}, ${e.longitud}` : '';
    $('eCoordenadas').value = estCoordenadasIniciales;
    valorPlegable('plEstDireccion', esc(e.geo_precision === 'online' ? 'sin ubicación' : (dondeEsta(e) || 'vacía')));
    valorPlegable('plEstMas', esc([e.geo_precision === 'online' ? 'online' : null].filter(Boolean).join(' · ')));
    $('ePegar').value = '';
    $('eAviso').textContent = '';
    $('eError').classList.add('hidden');
    cargarActividadEst(e.id);
    $('estOverlay').classList.remove('hidden');
    document.body.classList.add('overflow-hidden');
    pintarVolver('estOverlay');
}
/** Enlace a Google Maps: el sitio exacto si se conoce, si no el punto o una búsqueda por nombre. */
function urlMapsEst(e) {
    if (e.place_id) return `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(e.place_id)}`;
    if (Number.isFinite(e.latitud)) return `https://www.google.com/maps/search/?api=1&query=${e.latitud},${e.longitud}`;
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([e.nombre, e.ciudad].filter(Boolean).join(' '))}`;
}
const ICONO_SALIR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17 17 7M9 7h8v8"/></svg>';
const botonMaps = (url, texto = 'Abrir en Google Maps') =>
    `<a class="boton-maps" href="${esc(url)}" target="_blank" rel="noopener" data-bq-maps>${esc(texto)} ${ICONO_SALIR}</a>`;
/** Qué sitio es: el nombre y la dirección que da Google (si está verificado), el estado y Maps. */
function identidadEst(e) {
    const u = textoUbicacionEst(e);
    const verificado = e.google_estado === 'verificado';
    const nombreG = verificado && e.google_nombre && sinAcentos(e.google_nombre) !== sinAcentos(e.nombre) ? e.google_nombre : '';
    const dir = (verificado && e.google_direccion) || u.linea || 'Sin dirección';
    const estado = verificado ? 'Verificado en Google' : u.estado;
    return `
        ${nombreG ? `<div class="est-id-nombre">${esc(nombreG)}</div>` : ''}
        <div class="est-id-dir">${esc(dir)}</div>
        <div class="est-id-pie">
            <span class="est-id-estado"><i class="punto-verif en-linea${verificado ? ' si' : ''}"></i>${esc(estado)}</span>
            ${e.geo_precision === 'online' ? '' : botonMaps(urlMapsEst(e), e.place_id ? 'Abrir en Google Maps' : 'Buscar en Google Maps')}
        </div>`;
}

let actividadMovEst = null;
const etiquetaEst = () => `Establecimiento · ${estAbierto ? estAbierto.nombre : ''}`;

/** Tienda online / sin ubicación, o volver a buscarle sitio. */
async function marcarOnlineEst(id, online) {
    const r = await api(`/api/tickets/establecimientos/${id}/online`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ online })
    });
    if (!r.ok) { aviso('No se ha podido cambiar.'); return false; }
    aviso(online ? 'Sin ubicación: no saldrá en el mapa' : 'Se le buscará ubicación');
    await cargarEstablecimientos();
    cargarMapa();
    return true;
}
$('eOnline').addEventListener('click', async () => {
    if (!estAbierto) return;
    const id = estAbierto.id;
    if (await marcarOnlineEst(id, estAbierto.geo_precision !== 'online')) abrirEstablecimiento(id);
});
$('eSuscripcion').addEventListener('click', () => {
    if (!estAbierto || !actividadMovEst) return;
    const nombre = estAbierto.nombre;
    apilarFicha('susOverlay', etiquetaEst());
    abrirSuscripcion({ movimiento: { ...actividadMovEst, nombre } });
});

/** Sus últimos cargos del banco y tiquets: para reconocer qué sitio es. */
async function cargarActividadEst(id) {
    const caja = $('eActividad');
    caja.classList.add('hidden');
    let d;
    try { d = await (await api(`/api/tickets/establecimientos/${id}/actividad`)).json(); } catch (_) { return; }
    if (!estAbierto || estAbierto.id !== id) return;
    const filas = [
        ...(d.movimientos || []).map(m => ({ tipo: 'mov', id: m.id, fecha: m.fecha, importe: Math.abs(m.importe_centimos), moneda: m.moneda,
            etiqueta: 'Banco', texto: [m.comercio, m.poblacion].filter(Boolean).join(' · '), detalle: m.concepto })),
        ...(d.tiquets || []).map(t => ({ tipo: 'tiq', id: t.id, fecha: String(t.fecha_compra || '').slice(0, 10), importe: t.total_centimos,
            moneda: t.moneda, etiqueta: 'Tiquet', texto: t.categoria || '', detalle: '' }))
    ].sort((a, b) => String(b.fecha).localeCompare(String(a.fecha))).slice(0, 10);
    // El último cargo del banco: desde él se puede marcar como suscripción.
    actividadMovEst = (d.movimientos || [])[0] || null;
    $('eSuscripcion').classList.toggle('hidden', !actividadMovEst);
    if (!filas.length) return;
    $('eActividadTotal').innerHTML = cuentaEst({ tiquets: d.total_tiquets, movimientos: d.total_movimientos });
    $('eActividadLista').innerHTML = filas.map(f => `
        <button type="button" class="est-act" data-act="${f.tipo}" data-id="${f.id}">
            <span class="tipo">${f.etiqueta}</span>
            <span class="truncate">${esc(f.fecha ? fechaCorta(f.fecha) : 'sin fecha')}${f.texto ? ` · ${esc(f.texto)}` : ''}</span>
            <span class="cifra font-semibold">${f.importe != null ? esc(formatearImporte(f.importe, f.moneda)) : '—'}</span>
            ${f.detalle ? `<span class="detalle">${esc(f.detalle)}</span>` : ''}
        </button>`).join('');
    caja.classList.remove('hidden');
}
$('eActividadLista').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-act]');
    if (!b || !estAbierto) return;
    const id = Number(b.dataset.id);
    const estId = estAbierto.id;
    const refrescar = () => { if (estAbierto && estAbierto.id === estId) cargarActividadEst(estId); };
    if (b.dataset.act === 'mov') {
        apilarFicha('movOverlay', etiquetaEst(), refrescar);
        abrirMovimiento(id);
        return;
    }
    apilarFicha('editorOverlay', etiquetaEst(), refrescar);
    Editor.abrirPorIds([id]);
});

function cerrarEstablecimiento() {
    $('estOverlay').classList.add('hidden');
    estAbierto = null;
    buscadorEst.cerrar();
    if (volverDeFicha()) return;
    if (!fichaVisible()) document.body.classList.remove('overflow-hidden');
}
$('eCerrar').addEventListener('click', cerrarEstablecimiento);
$('eCancelar').addEventListener('click', cerrarEstablecimiento);
$('estOverlay').addEventListener('click', (ev) => { if (ev.target === $('estOverlay')) cerrarEstablecimiento(); });

/** Google: el aviso de arriba solo cuando hay sitios entre los que elegir. */
/**
 * Sin verificar (y con sitio físico): un solo bloque para decir qué sitio es.
 * Las opciones que encontró Google y un buscador para pedirle otras, que salen
 * igual. Verificado u online: la ficha de identidad, sin este bloque.
 */
function pintarGoogle(e, resultados = null, buscado = '') {
    const pendiente = e.google_estado !== 'verificado' && e.geo_precision !== 'online';
    $('eAvisoGoogle').classList.toggle('hidden', !pendiente);
    $('eUbicacion').classList.toggle('hidden', pendiente);
    if (!pendiente) return;
    const candidatos = resultados || e.google_candidatos || [];
    $('eGoogleEstado').textContent = resultados
        ? (candidatos.length ? `Google para «${buscado}»: ¿cuál es?` : `Google no ha encontrado nada para «${buscado}».`)
        : candidatos.length === 1 ? 'Google ha encontrado un sitio: ¿es este?'
        : candidatos.length ? `Google ha encontrado ${candidatos.length} sitios: ¿cuál es?`
        : 'Sin verificar en Google: búscalo para situarlo en el mapa.';
    if (!resultados) $('eGoogleTexto').value = [e.nombre, e.ciudad || e.lugar_inferido].filter(Boolean).join(' ');
    $('eNingunoGoogle').classList.toggle('hidden', !!resultados || !(e.google_candidatos || []).length);
    pintarCandidatosEst(candidatos);
}
function pintarCandidatosEst(candidatos) {
    const enlace = (id) => `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(id)}`;
    $('eCandidatos').innerHTML = candidatos.map(c => `
        <div class="candidato">
            <span class="c-nombre">${esc(c.nombre)}${c.cerrado ? ' · cerrado' : ''}</span>
            <span class="c-donde">${esc(c.direccion_completa)}${c.tipo ? ` · ${esc(c.tipo)}` : ''}</span>
            <span class="c-acciones">
                <button type="button" class="boton" data-place="${esc(c.place_id)}">Es este</button>
                ${botonMaps(c.url || enlace(c.place_id), 'Ver en Maps')}
            </span>
        </div>`).join('');
}

async function accionGoogle(ruta, cuerpo, aviso_) {
    if (!estAbierto) return null;
    try {
        const res = await api(`/api/tickets/establecimientos/${estAbierto.id}/${ruta}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo || {})
        });
        const datos = await res.json();
        if (!res.ok) { mostrarErrorEst(datos.error || 'Google no ha respondido.'); return null; }
        if (aviso_) aviso(aviso_);
        return datos;
    } catch (err) {
        if (err && err.message !== 'sin sesion') mostrarErrorEst('Google no ha respondido.');
        return null;
    }
}

/** Este establecimiento ES ese sitio de Google (si otro ya lo era, se unen). */
async function elegirLugarEst(placeId) {
    const datos = await accionGoogle('elegir-lugar', { place_id: placeId }, 'Establecimiento verificado');
    if (!datos) return;
    if (datos.resultado === 'unido') aviso('Ya existía: unidos en uno');
    await refrescarTrasEstablecimiento();
    abrirEstablecimiento(datos.establecimiento.id);
}
// Buscar otros sitios en Google: salen en la misma lista, con los mismos botones.
$('eGoogleForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const texto = $('eGoogleTexto').value.trim();
    if (!texto || !estAbierto) return;
    $('eGoogleBuscar').disabled = true;
    $('eGoogleBuscar').textContent = 'Buscando…';
    const datos = await accionGoogle('buscar-lugar', { texto });
    $('eGoogleBuscar').disabled = false;
    $('eGoogleBuscar').textContent = 'Buscar';
    if (datos) pintarGoogle(estAbierto, datos.candidatos || [], texto);
});
$('eCandidatos').addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-place]');
    if (!b) return;
    b.disabled = true;
    await elegirLugarEst(b.dataset.place);
    b.disabled = false;
});
async function descartarGoogleEst() {
    const datos = await accionGoogle('descartar-lugar', {}, 'Desvinculado de Google');
    if (!datos) return;
    await refrescarTrasEstablecimiento();
    abrirEstablecimiento(datos.establecimiento.id);
}
$('eNingunoGoogle').addEventListener('click', descartarGoogleEst);
$('eDesvincular').addEventListener('click', descartarGoogleEst);

/** Unir: el otro pasa a ser este (sus tiquets y cargos). */
async function unirConEst(otro) {
    if (!estAbierto) return;
    const ok = await pedirConfirmacion({
        titulo: `¿Unir ${otro.nombre} con ${estAbierto.nombre}?`,
        cuerpo: `Sus tiquets y cargos pasan a ${estAbierto.nombre} y ${otro.nombre} desaparece de la lista. ` +
                'Lo que le falte a este (dirección, ubicación) se completa con lo del otro.',
        aceptar: 'Unir'
    });
    if (!ok) return;
    try {
        const res = await api(`/api/tickets/establecimientos/${estAbierto.id}/unir`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ origen: otro.id })
        });
        const datos = await res.json();
        if (!res.ok) return mostrarErrorEst(datos.error || 'No se han podido unir.');
        aviso(`Unidos: ${plural(datos.movidos, 'tiquet')} movidos`);
        const id = estAbierto.id;
        await refrescarTrasEstablecimiento();
        abrirEstablecimiento(id);
    } catch (err) {
        if (err && err.message !== 'sin sesion') mostrarErrorEst('No se han podido unir.');
    }
}

// El buscador de la ficha: un sitio de Google lo verifica; uno tuyo se une.
const buscadorEst = crearBuscadorEst({
    input: $('eBuscar'), flecha: $('eBuscarFlecha'),
    excluir: () => estAbierto && estAbierto.id,
    textoGoogle: () => $('eBuscar').value.trim() ||
        [estAbierto && estAbierto.nombre, $('eCiudad').value || $('eLugar').value].filter(Boolean).join(' '),
    buscarGoogle: async (texto) => {
        const datos = await accionGoogle('buscar-lugar', { texto });
        if (!datos) throw new Error('Google no ha respondido.');
        return datos.candidatos || [];
    },
    accionTuyo: 'Unir con este', accionGoogle: 'Es este sitio',
    alTuyo: (e) => unirConEst(e),
    alGoogle: (c) => elegirLugarEst(c.place_id)
});

function mostrarErrorEst(texto) {
    $('eError').textContent = texto;
    $('eError').classList.remove('hidden');
}

/** Tras cambiar un establecimiento: todo lo que lo enseña, al día. */
async function refrescarTrasEstablecimiento() {
    await cargarEstablecimientos();
    cargarPanel();
    cargarHistorial({ reiniciar: true });
}

$('ePegar').addEventListener('paste', () => setTimeout(() => {
    const d = parsearDireccionPegada($('ePegar').value);
    if (!d) { $('eAviso').textContent = 'No he sabido repartirla: rellénala a mano.'; return; }
    $('eDireccion').value = d.direccion;
    $('eCiudad').value = d.ciudad;
    $('eCp').value = d.cp;
    $('ePais').value = d.pais;
    $('eCoordenadas').value = '';
    $('ePegar').value = '';
    $('eAviso').textContent = 'Al guardar se situará en el mapa.';
}, 0));

$('eGuardar').addEventListener('click', async () => {
    if (!estAbierto) return;
    const cuerpo = {
        nombre: $('eNombre').value, direccion: $('eDireccion').value, ciudad: $('eCiudad').value,
        codigo_postal: $('eCp').value, pais: $('ePais').value, lugar_inferido: $('eLugar').value
    };
    const coordenadas = $('eCoordenadas').value.trim();
    if (coordenadas !== estCoordenadasIniciales) cuerpo.coordenadas = coordenadas;
    try {
        const res = await api(`/api/tickets/establecimientos/${estAbierto.id}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo)
        });
        const datos = await res.json();
        if (!res.ok) return mostrarErrorEst(datos.error || 'No se ha podido guardar.');
        await refrescarTrasEstablecimiento();
        cerrarEstablecimiento();
        aviso('Establecimiento guardado');
    } catch (err) {
        if (err && err.message !== 'sin sesion') mostrarErrorEst('No se ha podido guardar.');
    }
});

// --- Categorías ------------------------------------------------------------------

const CATEGORIAS_BASE = ['ALIMENTACION', 'RESTAURACION', 'TRANSPORTE', 'OCIO', 'ROPA',
                         'HOGAR', 'ELECTRONICA', 'SALUD', 'SUSCRIPCIONES', 'OTROS'];
const CATEGORIAS_VISTAS = new Set();

crearCombo({
    input: $('fCategoria'), lista: $('sugerenciasCat'), boton: $('btnListaCat'),
    opciones: () => [...new Set([...CATEGORIAS_BASE, ...CATEGORIAS_VISTAS])].map(c => ({
        valor: c, buscar: sinAcentos(c),
        html: `<div class="sug-nombre inline-flex items-center gap-2">${iconoCategoria(c)}${esc(c)}</div>`
    })),
    alElegir: (o) => { $('fCategoria').value = o.valor; },
    abrirAlPulsar: true
});

function rellenarFormulario(t) {
    $('fTipo').value      = t.tipo_documento || '';
    $('fCategoria').value = t.categoria || '';

    $('fEstNombre').value    = t.establecimiento_nombre || '';
    estElegidoId = t.establecimiento_id || null;
    $('fEstDireccion').value = t.establecimiento_direccion || '';
    $('fEstCiudad').value    = t.establecimiento_ciudad || '';
    $('fEstCp').value        = t.establecimiento_codigo_postal || '';
    $('fEstLugarInferido').value = t.establecimiento_lugar_inferido || '';
    $('fEstPais').value = t.establecimiento_pais || '';
    $('fEstPegar').value = '';
    $('fEstPegarAviso').textContent = '';
    lugarElegido = null;
    buscadorEditor.olvidarGoogle();
    buscadorEditor.cerrar();

    const hayCoordenadas = Number.isFinite(t.establecimiento_latitud) &&
                           Number.isFinite(t.establecimiento_longitud);
    $('fEstCoordenadas').value = hayCoordenadas
        ? `${t.establecimiento_latitud}, ${t.establecimiento_longitud}`
        : '';
    $('pistaCoordenadas').textContent = hayCoordenadas && textoPrecision(t.establecimiento_precision)
        ? textoPrecision(t.establecimiento_precision) : '';

    const [dia, hora] = partirFecha(t.fecha_compra);
    $('fFecha').value = dia;
    $('fHora').value  = hora;

    const [diaEv, horaEv] = partirFecha(t.fecha_evento);
    $('fFechaEvento').value = diaEv;
    $('fHoraEvento').value  = horaEv;

    $('fTotal').value      = centimosAEuros(t.total_centimos);
    pintarCompartido(t.compartido_entre > 1 ? t.compartido_entre : 0, t.mi_parte_centimos);
    soloYoRevisado = t.compartido_entre === 1;
    $('fMoneda').value     = t.moneda || '';
    $('fMetodoPago').value = t.metodo_pago || '';
    actualizarParteSugerida();

    $('fSinFecha').checked = Boolean(t.sin_fecha);
    sincronizarAusencias();

    // Si la fecha guardada no es interpretable, los inputs de tipo date no la
    // pueden mostrar: decirlo en vez de dejarla en blanco como si no hubiera nada.
    if (t.fecha_compra && !dia) {
        mostrarAvisoEditor('aviso',
            `<b>La fecha guardada no es válida:</b> <code>${esc(t.fecha_compra)}</code>.
             Escríbela abajo; al guardar se sustituirá.`);
    }

    pintarItems(Array.isArray(t.items) ? t.items : []);
    pintarDetalles(t.detalles && typeof t.detalles === 'object' ? t.detalles : {});
    pintarResumenUbicacion({ ficha: t });
    valorPlegable('apartadoDireccion', esc([t.establecimiento_direccion, t.establecimiento_ciudad].filter(Boolean).join(', ') || 'sin dirección'));
    valorPlegable('plTiqTipo', esc([t.tipo_documento, t.metodo_pago].filter(Boolean).join(' · ').toLowerCase()));
    valorPlegable('plTiqLineas', Array.isArray(t.items) && t.items.length ? esc(plural(t.items.length, 'línea')) : '');
    const nDet = t.detalles && typeof t.detalles === 'object' ? Object.keys(t.detalles).length : 0;
    valorPlegable('plTiqDetalles', nDet ? esc(plural(nDet, 'dato')) : '');
    valorPlegable('grupoFechas', t.fecha_evento ? `evento ${esc(fechaCorta(String(t.fecha_evento).slice(0, 10)))}` : (t.sin_fecha ? 'sin fecha' : ''));
    sugerirSitiosDeGoogle(t);
    pintarPagoTiquet(t);
}

// --- Lista editable de ITEMS -------------------------------------------------

function filaItem(item = {}) {
    const div = document.createElement('div');
    div.className = 'grid grid-cols-12 gap-2 items-center';
    div.dataset.fila = 'item';
    div.innerHTML = `
        <input type="text" data-campo="producto" placeholder="producto"
               maxlength="120" class="col-span-6 campo">
        <input type="number" data-campo="cantidad" placeholder="cant." step="0.001"
               class="col-span-2 campo text-right cifra">
        <input type="number" data-campo="precio" placeholder="€" step="0.01"
               class="col-span-3 campo text-right cifra">
        <button type="button" data-quitar="1" class="col-span-1 text-lg leading-none"
                style="color: var(--texto-2)" title="Quitar línea">&times;</button>`;
    div.querySelector('[data-campo="producto"]').value = item.producto ?? '';
    div.querySelector('[data-campo="cantidad"]').value = item.cantidad ?? '';
    div.querySelector('[data-campo="precio"]').value   = centimosAEuros(item.precio_centimos);
    return div;
}

function pintarItems(items) {
    const cont = $('listaItems');
    cont.innerHTML = '';
    items.forEach(i => cont.appendChild(filaItem(i)));
}

$('btnAnadirItem').addEventListener('click', () => $('listaItems').appendChild(filaItem()));

// --- Lista editable de DETALLES ----------------------------------------------

function filaDetalle(clave = '', valor = '') {
    const div = document.createElement('div');
    div.className = 'grid grid-cols-12 gap-2 items-center';
    div.dataset.fila = 'detalle';
    div.innerHTML = `
        <input type="text" data-campo="clave" placeholder="clave"
               maxlength="40" class="col-span-5 campo">
        <input type="text" data-campo="valor" placeholder="valor"
               maxlength="200" class="col-span-6 campo">
        <button type="button" data-quitar="1" class="col-span-1 text-lg leading-none"
                style="color: var(--texto-2)" title="Quitar par">&times;</button>`;
    div.querySelector('[data-campo="clave"]').value = clave;
    div.querySelector('[data-campo="valor"]').value = valor;
    return div;
}

function pintarDetalles(detalles) {
    const cont = $('listaDetalles');
    cont.innerHTML = '';
    Object.entries(detalles).forEach(([k, v]) => cont.appendChild(filaDetalle(k, v)));
}

$('btnAnadirDetalle').addEventListener('click', () => $('listaDetalles').appendChild(filaDetalle()));

for (const idLista of ['listaItems', 'listaDetalles']) {
    $(idLista).addEventListener('click', (ev) => {
        const boton = ev.target.closest('[data-quitar]');
        if (boton) boton.closest('[data-fila]').remove();
    });
}

// --- Recoger el formulario ---------------------------------------------------

function recogerItems() {
    return Array.from($('listaItems').querySelectorAll('[data-fila="item"]'))
        .map(fila => {
            const producto = fila.querySelector('[data-campo="producto"]').value.trim();
            const cantidad = fila.querySelector('[data-campo="cantidad"]').value.trim();
            const precio   = fila.querySelector('[data-campo="precio"]').value;
            return {
                producto,
                cantidad: cantidad === '' ? null : Number(cantidad),
                precio_centimos: eurosACentimos(precio)
            };
        })
        .filter(i => i.producto !== '');
}

function recogerDetalles() {
    return Array.from($('listaDetalles').querySelectorAll('[data-fila="detalle"]'))
        .map(fila => ({
            clave: fila.querySelector('[data-campo="clave"]').value.trim(),
            valor: fila.querySelector('[data-campo="valor"]').value.trim()
        }))
        .filter(d => d.clave !== '' && d.valor !== '');
}

function recogerFormulario() {
    const datos = recogerFormularioBase();
    // Sitio de Google elegido: manda él, y sus coordenadas no son "a mano".
    if (lugarElegido) {
        datos.establecimiento.place_id = lugarElegido;
        delete datos.establecimiento.coordenadas;
    }
    return datos;
}
function recogerFormularioBase() {
    return {
        tipo_documento: val('fTipo'),
        categoria:      val('fCategoria'),
        establecimiento: {
            id:            estElegidoId,
            nombre:        val('fEstNombre'),
            direccion:     val('fEstDireccion'),
            ciudad:        val('fEstCiudad'),
            codigo_postal: val('fEstCp'),
            lugar_inferido: val('fEstLugarInferido'),
            pais:          val('fEstPais'),
            // Se manda SIEMPRE, también vacío: vaciarlo es la forma de volver a
            // la geocodificación automática.
            coordenadas:   $('fEstCoordenadas').value.trim()
        },
        fecha_compra: componerFecha('fFecha', 'fHora'),
        fecha_evento: componerFecha('fFechaEvento', 'fHoraEvento'),
        // Euros en pantalla, céntimos en el cable.
        total_centimos: eurosACentimos($('fTotal').value),
        // 1 = ya dije que pagué solo yo: guardar el tiquet no lo deshace.
        compartido_entre:  $('fCompartido').checked ? personasCompartido : (soloYoRevisado ? 1 : null),
        mi_parte_centimos: $('fCompartido').checked && $('fMiParte').value.trim() !== ''
            ? eurosACentimos($('fMiParte').value) : null,
        moneda:         val('fMoneda'),
        metodo_pago:    val('fMetodoPago'),
        sin_fecha:      $('fSinFecha').checked,
        items:          recogerItems(),
        detalles:       recogerDetalles()
    };
}

// --- Guardar -----------------------------------------------------------------

/**
 * Manda el PUT. Devuelve true si se ha guardado, false si el backend lo ha
 * rechazado, para que el recorrido de la cola sepa si puede avanzar.
 */
async function guardarFichaActual() {
    const t = Editor.fichaActual;
    if (!t) return false;

    const botones = [$('btnGuardar'), $('btnGuardarSiguiente')];
    botones.forEach(b => { b.disabled = true; });

    try {
        const res = await api(`/api/tickets/${t.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(recogerFormulario())
        });
        const data = await res.json();

        if (res.status === 422) {
            const filas = (data.descartados || [])
                .map(d => `<li><code>${esc(d.campo)}</code>: ${esc(d.motivo)}
                           ${d.valor ? `— ${esc(d.valor)}` : ''}</li>`)
                .join('');
            mostrarAvisoEditor('aviso',
                `<b>No se ha guardado.</b> ${esc(data.error)}
                 <ul class="list-disc ml-5 mt-2">${filas}</ul>`);
            return false;
        }

        if (res.status === 409) {
            mostrarAvisoEditor('error',
                `<b>No se ha guardado: sería un duplicado.</b>
                 <div class="mt-1">${esc(data.error)}</div>`);
            return false;
        }

        if (!res.ok) {
            mostrarAvisoEditor('error',
                `<b>Error al guardar.</b> <div class="mt-1">${esc(data.error || res.status)}</div>`);
            return false;
        }

        // Guardado: se refrescan la lista y las cifras, y la ficha de la cola se
        // sustituye por lo que hay en la base, no por lo que escribí.
        await Promise.all([cargarHistorial({ reiniciar: true }), cargarPanel()]);
        const refrescada = TICKETS.find(x => x.id === t.id);
        if (refrescada) Editor.cola[Editor.indice] = refrescada;

        return true;

    } catch (err) {
        if (err && err.message === 'sin sesion') return false;
        console.error(err);
        mostrarAvisoEditor('error', '<b>Error de conexión al guardar.</b>');
        return false;
    } finally {
        botones.forEach(b => { b.disabled = false; });
    }
}

$('btnGuardar').addEventListener('click', async () => {
    if (await guardarFichaActual()) Editor.siguiente();
});
$('btnGuardarSiguiente').addEventListener('click', async () => {
    if (await guardarFichaActual()) Editor.siguiente();
});
$('btnSaltar').addEventListener('click', async () => {
    if (await Editor.puedoAbandonar()) Editor.siguiente();
});
$('editorCerrar').addEventListener('click', () => Editor.intentarCerrar());
$('editorCancelar').addEventListener('click', () => Editor.intentarCerrar());

// Pulsar fuera del panel cierra, como cualquier modal. El clic tiene que ser
// EN el velo: `closest` evita que un clic que empieza dentro y acaba fuera
// (arrastrar para seleccionar texto) se lleve por delante la edición.
$('editorOverlay').addEventListener('click', (ev) => {
    if (ev.target === $('editorOverlay')) Editor.intentarCerrar();
});

// --- DIÁLOGO DE CONFIRMACIÓN -------------------------------------------------
// Propio y no confirm(): el del navegador no respeta los tokens, no se puede
// nombrar en español sin que aparezca el dominio y, en la PWA instalada, sale
// como si lo pidiera otra aplicación.

let resolverDialogo = null;

function pedirConfirmacion({ titulo, cuerpo, aceptar = 'Aceptar', cancelar = 'Cancelar', peligro = false }) {
    $('dialogoTitulo').textContent = titulo;
    $('dialogoCuerpo').textContent = cuerpo || '';
    $('dialogoAceptar').textContent = aceptar;
    $('dialogoCancelar').textContent = cancelar;
    // Lo que borra se ve que borra: nunca con el aspecto del botón de guardar.
    $('dialogoAceptar').className = peligro ? 'boton boton-peligro' : 'boton boton-acento';
    $('dialogoOverlay').classList.remove('hidden');
    // El foco va a la salida segura: quien pulse Enter sin leer, no pierde nada.
    $('dialogoCancelar').focus();

    return new Promise((resolve) => { resolverDialogo = resolve; });
}

function cerrarDialogo(respuesta) {
    $('dialogoOverlay').classList.add('hidden');
    const resolver = resolverDialogo;
    resolverDialogo = null;
    if (resolver) resolver(respuesta);
}

const dialogoAbierto = () => !$('dialogoOverlay').classList.contains('hidden');

$('dialogoAceptar').addEventListener('click',  () => cerrarDialogo(true));
$('dialogoCancelar').addEventListener('click', () => cerrarDialogo(false));
$('dialogoOverlay').addEventListener('click', (ev) => {
    if (ev.target === $('dialogoOverlay')) cerrarDialogo(false);
});

// --- Lupa --------------------------------------------------------------------

function abrirLupa(src) {
    const esDocumentoPdf = esPdf(src);
    $('lupaFoto').classList.toggle('hidden', esDocumentoPdf);
    $('lupaPdf').classList.toggle('hidden', !esDocumentoPdf);
    $('lupa').classList.remove('hidden');

    if (esDocumentoPdf) {
        $('lupaFoto').src = '';
        // A pantalla completa el PDF se pinta más grande: es donde se leen los
        // números pequeños de una factura escaneada.
        pintarPdf($('lupaPdf'), src, { ancho: Math.min(window.innerWidth - 24, 900) });
    } else {
        $('lupaFoto').src = src;
        zoomLupa.reiniciar();
    }
    $('controlesZoomLupa').classList.toggle('hidden', esDocumentoPdf);
    $('lupaCaja').classList.toggle('hidden', esDocumentoPdf);
}
function cerrarLupa() {
    $('lupa').classList.add('hidden');
    $('lupaFoto').src = '';
    $('lupaPdf').innerHTML = '';
}
$('lupa').addEventListener('click', (ev) => {
    // Dentro del PDF se hace scroll y se selecciona: cerrar solo desde el fondo.
    // La foto se amplía y se arrastra: pulsarla ya no cierra. Se cierra con la
    // cruz, con Escape o pulsando el fondo.
    if (ev.target === $('lupa')) cerrarLupa();
});
$('lupaCerrar').addEventListener('click', cerrarLupa);

/** Lo que hay que ampliar: la foto si hay foto, y si no el PDF de la ficha. */
const documentoVisible = () => {
    const t = Editor.fichaActual;
    return t && esPdf(t.ruta_imagen) ? t.ruta_imagen : $('editorFoto').src;
};
$('editorAmpliar').addEventListener('click', () => abrirLupa(documentoVisible()));

// --- Zoom de la foto DENTRO del editor ----------------------------------------
// Rueda del ratón o pellizco para ampliar (hasta 12x), arrastrar para moverse,
// doble clic para acercar ahí o volver a la vista entera. Se amplía la capa que
// contiene la foto y el marco, así que el marco sigue en su sitio.

const ZOOM_MAX = 12;

/**
 * Zoom sobre una caja: `capa` es lo que se amplía (foto + marco) y `caja` el
 * marco fijo que recorta. Mismo comportamiento en el editor y a pantalla completa.
 */
function crearZoom(caja, capa, controles, nivel) {
    const z = { escala: 1, x: 0, y: 0 };
    const punteros = new Map();
    let pellizco = null;

    function aplicar() {
        const ancho = caja.clientWidth, alto = caja.clientHeight;
        z.escala = Math.min(ZOOM_MAX, Math.max(1, z.escala));
        z.x = Math.min(0, Math.max(ancho - ancho * z.escala, z.x));
        z.y = Math.min(0, Math.max(alto - alto * z.escala, z.y));
        capa.style.transform = `translate(${z.x}px, ${z.y}px) scale(${z.escala})`;
        capa.classList.toggle('ampliada', z.escala > 1);
        // Sin ampliar, un dedo arrastrando en vertical mueve la PÁGINA (en el
        // móvil la foto ocupa media pantalla y no había por dónde hacer scroll).
        // Ampliada, el dedo mueve la foto. El pellizco funciona en los dos casos.
        caja.style.touchAction = z.escala > 1 ? 'none' : 'pan-y';
        nivel.textContent = `${Math.round(z.escala * 100)} %`;
    }
    function en(px, py, factor) {
        const antes = z.escala;
        const despues = Math.min(ZOOM_MAX, Math.max(1, antes * factor));
        z.x = px - (px - z.x) * (despues / antes);
        z.y = py - (py - z.y) * (despues / antes);
        z.escala = despues;
        aplicar();
    }
    function reiniciar() { z.escala = 1; z.x = 0; z.y = 0; aplicar(); }
    const punto = (ev) => {
        const r = caja.getBoundingClientRect();
        return [ev.clientX - r.left, ev.clientY - r.top];
    };

    caja.addEventListener('wheel', (ev) => {
        if (capa.offsetParent === null) return;   // oculta (un PDF en su lugar)
        ev.preventDefault();
        en(...punto(ev), Math.exp(-ev.deltaY * 0.0018));
    }, { passive: false });
    capa.addEventListener('dblclick', (ev) => {
        if (z.escala > 1.05) reiniciar(); else en(...punto(ev), 3);
    });
    capa.addEventListener('pointerdown', (ev) => {
        capa.setPointerCapture(ev.pointerId);
        punteros.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
        if (punteros.size === 2) {
            const [p1, p2] = [...punteros.values()];
            pellizco = { distancia: Math.hypot(p1.x - p2.x, p1.y - p2.y) };
        }
    });
    capa.addEventListener('pointermove', (ev) => {
        const previo = punteros.get(ev.pointerId);
        if (!previo) return;
        const actual = { x: ev.clientX, y: ev.clientY };
        punteros.set(ev.pointerId, actual);
        if (punteros.size === 2 && pellizco) {
            const [p1, p2] = [...punteros.values()];
            const distancia = Math.hypot(p1.x - p2.x, p1.y - p2.y);
            const r = caja.getBoundingClientRect();
            en((p1.x + p2.x) / 2 - r.left, (p1.y + p2.y) / 2 - r.top, distancia / pellizco.distancia);
            pellizco.distancia = distancia;
        } else if (punteros.size === 1 && z.escala > 1) {
            capa.classList.add('arrastrando');
            z.x += actual.x - previo.x;
            z.y += actual.y - previo.y;
            aplicar();
        }
    });
    const soltar = (ev) => {
        punteros.delete(ev.pointerId);
        if (punteros.size < 2) pellizco = null;
        if (punteros.size === 0) capa.classList.remove('arrastrando');
    };
    capa.addEventListener('pointerup', soltar);
    capa.addEventListener('pointercancel', soltar);
    controles.addEventListener('click', (ev) => {
        const b = ev.target.closest('[data-zoom]');
        if (!b) return;
        const centro = [caja.clientWidth / 2, caja.clientHeight / 2];
        if (b.dataset.zoom === 'mas') en(...centro, 1.6);
        else if (b.dataset.zoom === 'menos') en(...centro, 1 / 1.6);
        else reiniciar();
    });
    window.addEventListener('resize', aplicar);
    return { reiniciar };
}

const zoomEditor = crearZoom($('editorFotoCaja'), $('editorZoom'), $('controlesZoom'), $('nivelZoom'));
const zoomLupa   = crearZoom($('lupaCaja'), $('lupaZoom'), $('controlesZoomLupa'), $('nivelZoomLupa'));
function reiniciarZoom() { zoomEditor.reiniciar(); }

// Escape cierra de dentro hacia fuera: el diálogo, luego la lupa, luego el
// editor —y el editor preguntando, si hay algo escrito.
document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    if (dialogoAbierto()) cerrarDialogo(false);
    else if (!$('lupa').classList.contains('hidden')) cerrarLupa();
    else if (fichaVisible() && fichaVisible() !== 'editorOverlay') CERRAR_FICHA[fichaVisible()]();
    else if (!$('bancoOverlay').classList.contains('hidden')) cerrarBanco();
    else if (!$('editorOverlay').classList.contains('hidden')) Editor.intentarCerrar();
});

// =============================================================================
// VOLVER A ANALIZAR Y BORRAR
// =============================================================================
// Las dos acciones que cierran el ciclo de una ficha. Los endpoints ya existían
// (POST /api/tickets/:id/reintentar y DELETE /api/tickets/:id); lo que faltaba
// era poder llegar a ellos.

let PENDIENTES = 0;

/**
 * Las fichas que se están reanalizando ahora mismo. La fila del historial las
 * pinta con la barra en marcha: un reintento que tarda veinte segundos sin dar
 * señales parece que no ha hecho nada.
 */
const REINTENTANDO = new Set();

function marcarEnProceso(id, enProceso) {
    if (enProceso) REINTENTANDO.add(id);
    else REINTENTANDO.delete(id);
    // Repintar la lista es barato: TICKETS ya está en memoria.
    pintarHistorial();
}

/** Los modos de la IA en un <select>, igual que en la tarjeta de subida. */
function rellenarSelectorDeModos(select) {
    if (!CONFIG_IA || !Array.isArray(CONFIG_IA.modos) || CONFIG_IA.modos.length === 0) {
        select.innerHTML = '<option value="automatico">Automático</option>';
        return;
    }
    select.innerHTML = CONFIG_IA.modos.map(m =>
        `<option value="${esc(m.valor)}">${esc(m.etiqueta)}</option>`
    ).join('');
    select.value = CONFIG_IA.por_defecto || CONFIG_IA.modos[0].valor;
}

/** ¿Esta ficha ya tiene datos extraídos? Entonces releerla los sustituye. */
const yaLeido = (t) => t && (t.estado === 'procesado' || t.estado === 'incompleto');

/**
 * Reintenta UNA ficha. Devuelve la respuesta del servidor con su status, sin
 * tocar la interfaz: quien llama decide qué hacer (el editor se refresca, el
 * lote cuenta y sigue).
 *
 * `forzar` es obligatorio para releer una ficha que ya tiene datos: el servidor
 * responde 409 sin él, a propósito.
 */
async function reintentarFicha(id, modo, forzar = false) {
    const res = await api(`/api/tickets/${id}/reintentar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modo_modelo: modo, forzar })
    });
    const datos = await res.json().catch(() => ({}));
    return { status: res.status, ok: res.ok, datos };
}

// --- Desde el editor ---------------------------------------------------------

$('btnReintentar').addEventListener('click', async () => {
    const t = Editor.fichaActual;
    if (!t) return;

    // Dos cosas que hay que avisar antes de releer, y las dos a la vez si toca:
    // que la IA lee la FOTO ENTERA (así que una foto con varios tiquets se
    // reanaliza completa) y que releer sustituye lo que hubiera, correcciones
    // manuales incluidas.
    const enLaFoto = Number(t.total_en_foto) || 1;
    const avisos = [];
    if (enLaFoto > 1) {
        avisos.push(`Esta foto contiene ${plural(enLaFoto, 'tiquet')}; se volverán a analizar ` +
                    `los ${enLaFoto}.`);
    }
    if (yaLeido(t)) {
        avisos.push('Se sustituirán los datos extraídos; tus correcciones manuales se perderán.');
    }

    if (avisos.length) {
        const seguro = await pedirConfirmacion({
            titulo: enLaFoto > 1 ? '¿Volver a analizar la foto?' : '¿Volver a analizar este tiquet?',
            cuerpo: `${avisos.join(' ')} La foto no se toca.`,
            aceptar: 'Volver a analizar',
            cancelar: 'Cancelar'
        });
        if (!seguro) return;
    }

    const boton = $('btnReintentar');
    const estado = $('estadoReintento');
    boton.disabled = true;
    $('modoReintento').disabled = true; $('modoReintento').__pintar();
    estado.textContent = 'Enviando el archivo a la IA…';
    $('progresoReintento').classList.remove('hidden');
    marcarEnProceso(t.id, true);
    ocultarAvisoEditor();

    try {
        const { ok, datos } = await reintentarFicha(t.id, $('modoReintento').value, yaLeido(t));

        if (!ok) {
            // El motivo REAL, que es lo único que permite decidir si reintentar
            // con otro modelo, esperar a que se renueve la cuota o borrarla.
            estado.textContent = '';
            mostrarAvisoEditor('error',
                `<b>No se ha podido analizar.</b>
                 <div class="mt-1">${esc(datos.error || 'Fallo desconocido')}</div>
                 ${datos.tipo ? `<div class="text-xs mt-1">Tipo: ${esc(datos.tipo)}` +
                                `${datos.status_api ? ` · respuesta de la API: ${esc(datos.status_api)}` : ''}</div>` : ''}`);
            return;
        }

        // Se refrescan lista y panel, y la ficha de la cola se sustituye por lo
        // que hay en la base: lo que se enseña es lo guardado, no lo esperado.
        await Promise.all([cargarHistorial({ reiniciar: true }), cargarPanel()]);

        const refrescada = TICKETS.find(x => x.id === t.id) || datos.ticket;
        if (refrescada) Editor.cola[Editor.indice] = refrescada;

        // Si la foto tenía varios tiquets, el endpoint ha creado las hermanas:
        // la cola pasa a ser las N fichas, que es lo que hay que revisar.
        const ids = datos.ids || [t.id];
        if (ids.length > 1) {
            await Editor.abrirPorIds(ids);
            aviso(`${plural(ids.length, 'tiquet')} encontrados en esa foto`);
        } else {
            Editor.pintarFichaActual();
            aviso(datos.resultado === 'sin_tiquets'
                ? 'La IA no ha reconocido ningún tiquet'
                : 'Ficha analizada de nuevo');
        }

        estado.textContent = '';
        if (datos.mensaje && datos.resultado !== 'reintentado') {
            mostrarAvisoEditor('aviso', `<b>Analizado.</b> <div class="mt-1">${esc(datos.mensaje)}</div>`);
        }

    } catch (err) {
        if (err && err.message === 'sin sesion') return;
        console.error(err);
        estado.textContent = '';
        mostrarAvisoEditor('error', '<b>Error de conexión al volver a analizar.</b>');
    } finally {
        boton.disabled = false;
        $('modoReintento').disabled = false; $('modoReintento').__pintar();
        $('progresoReintento').classList.add('hidden');
        marcarEnProceso(t.id, false);
    }
});

// --- En lote, desde la línea de control -------------------------------------
// EN SERIE, uno tras otro. En paralelo sería la forma más rápida de agotar la
// cuota de la API y de que fallaran todos a la vez.

const Lote = { enCurso: false, cancelado: false };

$('lineaControl').addEventListener('click', (ev) => {
    if (ev.target.closest('[data-reintentar-todos]')) reintentarPendientes();
});

function pintarLote(html) {
    const caja = $('zonaLote');
    caja.classList.remove('hidden');
    caja.innerHTML = html;
}

async function reintentarPendientes() {
    if (Lote.enCurso) return;

    // Se piden los pendientes al servidor en vez de usar lo que haya cargado el
    // historial: la lista pagina, y "todos" tiene que ser todos.
    let ids = [];
    try {
        const res = await api('/api/tickets?estado=pendiente&limit=500&orden=subida&dir=asc');
        const datos = await res.json();
        ids = (datos.tiquets || []).map(t => t.id);
    } catch (err) {
        if (err && err.message === 'sin sesion') return;
        console.error(err);
        pintarLote('<b>No se ha podido consultar la lista de pendientes.</b>');
        return;
    }

    if (ids.length === 0) {
        pintarLote('No queda ninguna ficha pendiente.');
        return;
    }

    Lote.enCurso = true;
    Lote.cancelado = false;

    const modo = modoModeloElegido();
    const resultado = { hechos: 0, sinTiquets: 0, fallados: [], nuevos: 0 };
    let detenido = null;

    for (let i = 0; i < ids.length; i += 1) {
        if (Lote.cancelado) { detenido = 'cancelado'; break; }

        pintarLote(
            `<b>Reintentando ${i + 1} de ${ids.length}</b> (ficha ${ids[i]})… ` +
            `<button type="button" class="boton boton-sm ml-2" data-cancelar-lote="1">Parar</button>`
        );

        try {
            marcarEnProceso(ids[i], true);
            const { ok, status, datos } = await reintentarFicha(ids[i], modo);
            marcarEnProceso(ids[i], false);

            if (ok) {
                resultado.hechos += 1;
                if (datos.resultado === 'sin_tiquets') resultado.sinTiquets += 1;
                // Una foto con varios tiquets genera hermanas: cuenta cuántas.
                if (datos.ids && datos.ids.length > 1) resultado.nuevos += datos.ids.length - 1;
            } else {
                resultado.fallados.push({ id: ids[i], error: datos.error || `respuesta ${status}`, tipo: datos.tipo });

                // La cuota no se renueva en segundos: seguir es quemar intentos
                // y acabar con todas las fichas marcadas como fallidas sin que
                // ninguna lo esté de verdad.
                if (status === 429 || datos.tipo === 'cuota') { detenido = 'cuota'; break; }
            }
        } catch (err) {
            marcarEnProceso(ids[i], false);
            if (err && err.message === 'sin sesion') return;
            console.error(err);
            resultado.fallados.push({ id: ids[i], error: 'error de conexión' });
            detenido = 'red';
            break;
        }
    }

    Lote.enCurso = false;
    await Promise.all([cargarHistorial({ reiniciar: true }), cargarPanel()]);

    const partes = [`<b>Reintento terminado.</b>`];
    partes.push(`${resultado.hechos} de ${ids.length} ${resultado.hechos === 1 ? 'procesada' : 'procesadas'}.`);
    if (resultado.nuevos) partes.push(`Han aparecido ${plural(resultado.nuevos, 'tiquet')} más de fotos con varios.`);
    if (resultado.sinTiquets) partes.push(`${resultado.sinTiquets} no contenía(n) ningún tiquet reconocible.`);

    if (detenido === 'cuota') {
        partes.push(`Se ha parado al agotarse la cuota de la API: las ${ids.length - resultado.hechos} ` +
                    `que quedan siguen pendientes. Vuelve a intentarlo más tarde.`);
    } else if (detenido === 'red') {
        partes.push('Se ha parado por un problema de conexión; el resto sigue pendiente.');
    } else if (detenido === 'cancelado') {
        partes.push('Parado a mano; el resto sigue pendiente.');
    }

    if (resultado.fallados.length) {
        partes.push(`<div class="mt-1">Sin procesar: ` +
            resultado.fallados.map(f => `${f.id} (${esc(f.tipo || 'error')})`).join(', ') + `.</div>`);
    }

    pintarLote(partes.join(' ') +
        ` <button type="button" class="boton boton-sm ml-2" data-cerrar-lote="1">Cerrar</button>`);
    aviso(`Reintento: ${resultado.hechos} de ${ids.length}`);
}

$('zonaLote').addEventListener('click', (ev) => {
    if (ev.target.closest('[data-cancelar-lote]')) {
        Lote.cancelado = true;
        pintarLote('Parando en cuanto termine la ficha que está en marcha…');
    }
    if (ev.target.closest('[data-cerrar-lote]')) {
        $('zonaLote').classList.add('hidden');
        $('zonaLote').innerHTML = '';
    }
});

// --- Borrar ------------------------------------------------------------------

$('btnBorrar').addEventListener('click', async () => {
    const t = Editor.fichaActual;
    if (!t) return;

    // Lo que hay que decir ANTES: si la foto se va con la ficha o se queda,
    // porque la comparten otros tiquets de la misma imagen.
    const enLaFoto = Number(t.total_en_foto) || 1;
    const compartida = enLaFoto > 1;
    const quedan = enLaFoto - 1;

    const seguro = await pedirConfirmacion({
        titulo: `¿Borrar el tiquet ${t.id}?`,
        cuerpo: (t.establecimiento_nombre ? `${t.establecimiento_nombre}. ` : '') +
                (compartida
                    ? `La foto NO se borra: la comparten ${plural(quedan, 'tiquet')} más de la misma imagen.`
                    : 'Se borran la ficha y su foto. No se puede deshacer.'),
        aceptar: 'Borrar',
        cancelar: 'Cancelar',
        peligro: true
    });
    if (!seguro) return;

    $('btnBorrar').disabled = true;
    try {
        const res = await api(`/api/tickets/${t.id}`, { method: 'DELETE' });
        const datos = await res.json().catch(() => ({}));

        if (!res.ok) {
            mostrarAvisoEditor('error',
                `<b>No se ha podido borrar.</b> <div class="mt-1">${esc(datos.error || res.status)}</div>`);
            return;
        }

        // Fuera de la cola, de la lista y de las cifras.
        Editor.cola = Editor.cola.filter(f => f.id !== t.id);
        if (Editor.indice >= Editor.cola.length) Editor.indice = Editor.cola.length - 1;

        await Promise.all([cargarHistorial({ reiniciar: true }), cargarPanel()]);
        aviso(datos.mensaje || 'Tiquet borrado');

        // Si esto era parte de una revisión en cadena, se sigue con la
        // siguiente: cerrar el editor obligaría a volver a entrar.
        if (Editor.cola.length > 0) {
            Editor.limpio = null;       // la ficha borrada ya no se compara
            Editor.pintarFichaActual();
        } else {
            Editor.cerrar();
        }

    } catch (err) {
        if (err && err.message === 'sin sesion') return;
        console.error(err);
        mostrarAvisoEditor('error', '<b>Error de conexión al borrar.</b>');
    } finally {
        $('btnBorrar').disabled = false;
    }
});

// =============================================================================
// ARRANQUE
// =============================================================================
// Primero la sesión: sin ella, todo lo demás recibiría un 401 y api() mandaría
// al portal igualmente, pero comprobarlo antes evita el parpadeo de una página a
// medio pintar.

(async () => {
    // El <head> ya ha puesto data-theme para que no parpadee; esto solo deja el
    // título del botón al día y no repinta nada (todavía no hay nada pintado).
    try { aplicarTema(localStorage.getItem('tema') || 'auto', { repintar: false }); } catch (_) {}

    await cargarSesion();
    if (!SESION.autenticado) return;
    await Promise.all([cargarConfigIA(), cargarHistorial({ reiniciar: true }), cargarPanel()]);
    conectarEventos();
    // Si hay comidas sin repartir, se pregunta sola (una vez por sesión si se
    // pulsa "Más tarde").
    await cargarComensales();
    let aplazado = false;
    try { aplazado = sessionStorage.getItem('comensalesMasTarde') === '1'; } catch (_) {}
    if (COMENSALES.length && !aplazado) abrirComensales();
})();

// =============================================================================
// BANCO
// =============================================================================
// Conexión con el banco (Enable Banking, solo lectura): conectar, elegir qué
// cuentas se leen, sincronizar y ver los últimos movimientos. El cruce con los
// tiquets y las suscripciones vienen después.

const fechaCorta = (iso) => iso ? new Date(iso).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' }) : '';

function avisoBanco(texto, error = false) {
    $('bancoAviso').textContent = texto || '';
    $('bancoAviso').style.color = error ? 'var(--error)' : 'var(--texto-2)';
    $('bancoAviso').classList.toggle('hidden', !texto);
}

async function abrirBanco() {
    $('bancoOverlay').classList.remove('hidden');
    document.body.classList.add('overflow-hidden');
    await pintarBanco();
}
function cerrarBanco() {
    $('bancoOverlay').classList.add('hidden');
    if ($('editorOverlay').classList.contains('hidden')) document.body.classList.remove('overflow-hidden');
}
$('btnBanco').addEventListener('click', abrirBanco);
$('bancoCerrar').addEventListener('click', cerrarBanco);
$('bancoOverlay').addEventListener('click', (ev) => { if (ev.target === $('bancoOverlay')) cerrarBanco(); });

async function pintarBanco() {
    let e;
    try { e = await (await api('/api/banco/estado')).json(); } catch (err) { return; }
    const dias = e.valida_hasta ? Math.floor((new Date(e.valida_hasta) - Date.now()) / 86400e3) : null;

    $('bancoEstado').textContent = !e.configurado ? 'Sin configurar: faltan la clave o el id de Enable Banking en el .env.'
        : !e.conectado ? 'Sin conectar.'
        : e.caducada ? `${e.banco}: el permiso ha caducado. Vuelve a conectar.`
        : `${e.banco} · permiso hasta el ${fechaCorta(e.valida_hasta)}${dias !== null && dias <= 14 ? ` (quedan ${dias} días)` : ''}`;

    $('bancoConectar').classList.toggle('hidden', !e.configurado);
    $('bancoConectar').textContent = e.conectado && !e.caducada ? 'Renovar el permiso' : 'Conectar con el banco';
    $('bancoConectar').classList.toggle('boton-acento', !e.conectado || e.caducada || (dias !== null && dias <= 14));
    $('bancoSincronizar').classList.toggle('hidden', !e.conectado || e.caducada);
    pintarSyncBanco(e);
    pintarUsoIA();
    $('bancoImportar').classList.toggle('hidden', !e.cuentas.some(c => c.leer));

    const vigentes = e.cuentas.filter(c => c.vigente);
    $('bancoCuentasBloque').classList.toggle('hidden', vigentes.length === 0);
    $('bancoCuentas').innerHTML = vigentes.map(c => `
        <label class="cuenta-banco">
            <input type="checkbox" data-cuenta="${esc(c.uid)}" ${c.leer ? 'checked' : ''}>
            <span class="min-w-0 flex-1">
                <span class="block font-medium">${esc(c.iban || c.nombre || 'Cuenta')}</span>
                <span class="block text-xs" style="color: var(--texto-2)">${esc([
                    c.nombre, c.leer ? plural(c.movimientos, 'movimiento') : 'no se lee',
                    c.ultima_sincronizacion ? `al día: ${fechaCorta(c.ultima_sincronizacion + 'Z')}` : null
                ].filter(Boolean).join(' · '))}</span>
                ${c.ultimo_error ? `<span class="block text-xs" style="color: var(--error)">${esc(c.ultimo_error)}</span>` : ''}
            </span>
        </label>`).join('');
    if (vigentes.length && !vigentes.some(c => c.leer)) avisoBanco('Marca la cuenta que quieres leer: hasta entonces no se descarga nada.');

    $('bancoMovBloque').classList.toggle('hidden', !e.conectado || !e.cuentas.some(c => c.leer && c.movimientos));
    if (e.conectado) {
        if (bancoVista === 'sus') pintarSuscripciones(); else pintarMovimientosBanco();
    }
}

/** "Hoy a las 14:05", "ayer a las 9:30", "el 3 nov a las 12:00". */
function cuandoTexto(isoFecha) {
    const f = new Date(isoFecha);
    const hora = f.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
    const dia = iso(f), hoy = iso(hoyLocal());
    const ayer = iso(new Date(Date.now() - 86400e3)), manana = iso(new Date(Date.now() + 86400e3));
    const d = dia === hoy ? 'hoy' : dia === ayer ? 'ayer' : dia === manana ? 'mañana' : `el ${fechaCorta(dia)}`;
    return `${d} a las ${hora}`;
}
function haceTexto(isoFecha) {
    const min = Math.round((Date.now() - new Date(isoFecha)) / 60000);
    if (min < 1) return 'ahora mismo';
    if (min < 60) return `hace ${min} min`;
    const h = Math.floor(min / 60);
    return h < 48 ? `hace ${h} h` : `hace ${Math.floor(h / 24)} días`;
}

/** El estado de las descargas: última, próxima, cupo y si se puede a mano. */
function pintarSyncBanco(e) {
    const caja = $('bancoSync');
    const s = e.sync;
    if (!s || !e.conectado || e.caducada || !e.cuentas.some(c => c.leer)) { caja.classList.add('hidden'); return; }
    const linea = (a, b) => `<div class="linea"><span>${esc(a)}</span><span>${b}</span></div>`;
    const filas = [
        linea('Última actualización', s.ultima ? `${esc(cuandoTexto(s.ultima))} <span style="color: var(--texto-2)">(${esc(haceTexto(s.ultima))})</span>` : 'todavía ninguna'),
        linea('Próxima automática', e.sincronizando ? '<span class="ok">descargando ahora…</span>'
            : s.pausa_auto_hasta ? `<span class="aviso">en pausa hasta ${esc(cuandoTexto(s.pausa_auto_hasta))}</span>`
            : s.auto_hoy >= s.auto_max ? '<span class="aviso">mañana (cupo de hoy gastado)</span>'
            : esc(new Date(s.proxima_auto) <= new Date(Date.now() + 90e3) ? 'en unos minutos' : cuandoTexto(s.proxima_auto))),
        linea('Automáticas hoy', `${s.auto_hoy} de ${s.auto_max} <span style="color: var(--texto-2)">(cada ${s.cada_horas} h)</span>`),
        linea('Actualizar a mano', s.pausa_manual_hasta
            ? `<span class="aviso">el banco no deja hasta ${esc(cuandoTexto(s.pausa_manual_hasta))}</span>`
            : '<span class="ok">disponible</span> <span style="color: var(--texto-2)">(no gasta el cupo automático)</span>')
    ];
    if (s.ultimo_intento && s.ultimo_intento.resultado === 'error') {
        filas.push(linea('Último intento', `<span class="aviso">falló ${esc(cuandoTexto(s.ultimo_intento.cuando))}</span>`));
    }
    caja.innerHTML = filas.join('');
    caja.classList.remove('hidden');
    $('bancoSincronizar').disabled = Boolean(s.pausa_manual_hasta) || e.sincronizando;
}

/** Gemini hoy: peticiones por modelo, límites conocidos y si está agotado o saturado. */
async function pintarUsoIA() {
    let d;
    try { d = await (await api('/api/ia/uso')).json(); } catch (_) { return; }
    if (!d || !Array.isArray(d.modelos) || !d.modelos.length) { $('plIA').classList.add('hidden'); return; }
    $('plIA').classList.remove('hidden');
    const corto = (m) => m.replace(/^gemini-/, '');
    const filas = d.modelos.map(m => {
        const limite = m.limite_dia ? ` de ${m.limite_dia}/día` : '';
        const extra = [m.cuota ? `${m.cuota} sin cuota` : '', m.saturado ? `${m.saturado} saturado` : ''].filter(Boolean).join(' · ');
        const [clase, texto] = m.estado === 'agotado_dia' ? ['agotado', `agotado hasta ${cuandoTexto(m.agotado_hasta).replace(/^hoy a las |^mañana a las /, '')}`]
            : m.estado === 'agotado_minuto' ? ['agotado', 'límite por minuto: espera un poco']
            : m.estado === 'saturado' ? ['saturado', `saturado ${haceTexto(m.ultimo_saturado_at)}`]
            : m.estado === 'ok' ? ['ok', 'disponible'] : ['sin_uso', 'sin usar hoy'];
        return `<div class="ia-fila">
            <span class="ia-modelo">${esc(corto(m.modelo))}</span>
            <span class="ia-cifras">${esc(plural(m.peticiones, 'petición', 'peticiones'))} hoy${esc(limite)}${extra ? ` · ${esc(extra)}` : ''}</span>
            <span class="ia-estado ${clase}">${esc(texto)}</span></div>`;
    });
    const agotados = d.modelos.filter(m => m.estado.startsWith('agotado')).length;
    const total = d.modelos.reduce((s, m) => s + m.peticiones, 0);
    $('iaUso').innerHTML = filas.join('') +
        `<p class="ia-nota">Contado por la app (Google no da el uso por la API). Los límites salen cuando un modelo se agota. La cuota diaria se renueva ${esc(cuandoTexto(d.renueva_at))}.</p>`;
    valorPlegable('plIA', agotados
        ? `<span class="aviso">${agotados} de ${d.modelos.length} agotado${agotados === 1 ? '' : 's'}</span>`
        : esc(`${total} peticiones`));
}

let bancoVista = 'mov';
let bancoFiltro = '';
const CLASE_MOV = {
    tarjeta: 'Tarjeta', bizum_recibido: 'Bizum recibido', bizum_enviado: 'Bizum enviado',
    transferencia_recibida: 'Transferencia recibida', transferencia_enviada: 'Transferencia enviada',
    recibo: 'Recibo', comision: 'Comisión', devolucion: 'Devolución', otro: ''
};

async function pintarMovimientosBanco() {
    let movimientos = [];
    try {
        movimientos = (await (await api(`/api/banco/movimientos?limite=300${bancoFiltro ? `&filtro=${bancoFiltro}` : ''}`)).json()).movimientos || [];
    } catch (_) { return; }
    $('bancoMovimientos').innerHTML = movimientos.length ? movimientos.map(m => {
        const titulo = m.nombre || m.comercio || m.persona || m.concepto || 'Movimiento';
        const estado = m.tiquet_id
            ? `<button type="button" class="chip-mov ok" data-abrir-tiquet="${m.tiquet_id}">Con tiquet${m.enlace === 'manual' ? ' (a mano)' : ''}</button>
               <button type="button" class="chip-mov" data-mov="${m.id}" data-buscar-tiquet>Cambiar</button>`
            : m.clase === 'tarjeta' && m.importe_centimos < 0
                ? (m.enlace === 'descartado'
                    ? `<button type="button" class="chip-mov" data-mov="${m.id}" data-buscar-tiquet>Sin tiquet</button>`
                    : `<button type="button" class="chip-mov falta" data-mov="${m.id}" data-buscar-tiquet>Falta el tiquet: buscar</button>`)
                : '';
        return `
        <div class="fila-mov" data-fila-mov="${m.id}">
            <span class="mov-concepto font-medium">${esc(titulo)}</span>
            <span class="cifra${m.importe_centimos > 0 ? ' abono' : ''}">${esc(formatearImporte(m.importe_centimos, m.moneda))}</span>
            <span class="mov-apoyo">${esc([fechaCorta(m.fecha), m.poblacion, CLASE_MOV[m.clase] || null, m.nota].filter(Boolean).join(' · '))}</span>
            ${estado ? `<span class="mov-estado">${estado}</span>` : ''}
        </div>`;
    }).join('') : '<p class="vacio-discreto">Nada con este filtro.</p>';
}

async function pintarSuscripciones() { await cargarSuscripciones(); }

$('bancoPestanas').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-banco-vista]');
    if (!b) return;
    bancoVista = b.dataset.bancoVista;
    for (const x of $('bancoPestanas').querySelectorAll('[data-banco-vista]')) x.setAttribute('aria-selected', String(x === b));
    $('bancoVistaMov').classList.toggle('hidden', bancoVista !== 'mov');
    $('bancoVistaSus').classList.toggle('hidden', bancoVista !== 'sus');
    if (bancoVista === 'sus') pintarSuscripciones(); else pintarMovimientosBanco();
});
$('bancoFiltros').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-filtro]');
    if (!b) return;
    bancoFiltro = b.dataset.filtro;
    for (const x of $('bancoFiltros').querySelectorAll('[data-filtro]')) x.setAttribute('aria-pressed', String(x === b));
    pintarMovimientosBanco();
});

// Abrir el tiquet enlazado, o buscar con qué tiquet casa un cargo.
$('bancoMovimientos').addEventListener('click', async (ev) => {
    const abrir = ev.target.closest('[data-abrir-tiquet]');
    if (abrir) { Editor.abrirPorIds([Number(abrir.dataset.abrirTiquet)]); return; }

    const elegir = ev.target.closest('[data-enlazar]');
    if (elegir) {
        const id = elegir.dataset.mov;
        const tiquet = elegir.dataset.enlazar === 'ninguno' ? null : Number(elegir.dataset.enlazar);
        await api(`/api/banco/movimientos/${id}/tiquet`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tiquet_id: tiquet })
        });
        await actualizarEnlacesBanco();
        cargarHistorial({ reiniciar: true });
        pintarMovimientosBanco();
        return;
    }

    const buscar = ev.target.closest('[data-buscar-tiquet]');
    if (!buscar) return;
    const fila = buscar.closest('[data-fila-mov]');
    const abierta = fila.querySelector('.candidatos-mov');
    if (abierta) { abierta.remove(); return; }
    const id = buscar.dataset.mov;
    let lista = [];
    try { lista = (await (await api(`/api/banco/movimientos/${id}/candidatos`)).json()).candidatos || []; } catch (_) {}
    const caja = document.createElement('div');
    caja.className = 'candidatos-mov';
    caja.innerHTML = (lista.length ? lista.map(t => `
        <button type="button" data-mov="${id}" data-enlazar="${t.id}">
            <b>${esc(t.nombre || 'Sin comercio')}</b> · ${esc(fechaCorta(t.dia))} · ${esc(formatearImporte(t.total_centimos))}
            ${t.diferencia === 0 ? ' · mismo importe' : ''}
        </button>`).join('') : '<p class="vacio-discreto">No hay tiquets en esos días.</p>') +
        `<button type="button" data-mov="${id}" data-enlazar="ninguno">No tiene tiquet</button>`;
    fila.appendChild(caja);
});

// Los tiquets confirmados por el banco: el historial les pone una marca.
let TIQUETS_BANCO = new Set();
async function actualizarEnlacesBanco() {
    try {
        const r = await api('/api/banco/enlaces');
        if (!r.ok) return;
        TIQUETS_BANCO = new Set(((await r.json()).enlaces || []).map(e => e.tiquet_id));
    } catch (_) {}
}

$('bancoCuentas').addEventListener('change', async (ev) => {
    const caja = ev.target.closest('[data-cuenta]');
    if (!caja) return;
    try {
        await api(`/api/banco/cuentas/${encodeURIComponent(caja.dataset.cuenta)}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ leer: caja.checked })
        });
        avisoBanco(caja.checked ? 'Se leerá esta cuenta. Pulsa "Sincronizar ahora" para traer sus movimientos.' : '');
        pintarBanco();
    } catch (_) {}
});

$('bancoConectar').addEventListener('click', async () => {
    $('bancoConectar').disabled = true;
    avisoBanco('Preparando la autorización con el banco…');
    try {
        const res = await api('/api/banco/conectar', { method: 'POST' });
        const datos = await res.json();
        if (!res.ok) { avisoBanco(datos.error || `No se ha podido conectar (${res.status}).`, true); return; }
        if (!datos.url) { avisoBanco('Enable Banking no ha devuelto la dirección del banco.', true); return; }
        avisoBanco('Abriendo la página del banco…');
        location.href = datos.url;      // al banco; vuelve a /banco/vuelta
    } catch (err) {
        if (err && err.message !== 'sin sesion') avisoBanco('No se ha podido conectar.', true);
    } finally {
        $('bancoConectar').disabled = false;
    }
});

$('bancoSincronizar').addEventListener('click', async () => {
    $('bancoSincronizar').disabled = true;
    $('bancoSincronizar').textContent = 'Sincronizando…';
    try {
        const r = await (await api('/api/banco/sincronizar', { method: 'POST' })).json();
        avisoBanco(r.resultado === 'ok'
            ? (r.nuevos ? `${plural(r.nuevos, 'movimiento nuevo', 'movimientos nuevos')}.` : 'Al día: no hay movimientos nuevos.')
            : r.resultado === 'error' ? (r.mensaje || 'El banco ha devuelto un error.')
            : r.resultado === 'limite_manual' ? `El banco no deja consultar más ahora; prueba ${cuandoTexto(r.hasta)}.`
            : r.resultado === 'caducada' ? 'El permiso ha caducado: vuelve a conectar.'
            : r.resultado === 'en_curso' ? 'Ya se está sincronizando.' : 'No hay conexión con el banco.', r.resultado !== 'ok');
        pintarBanco();
    } catch (_) {
        avisoBanco('No se ha podido sincronizar.', true);
    } finally {
        $('bancoSincronizar').disabled = false;
        $('bancoSincronizar').textContent = 'Sincronizar ahora';
    }
});

// --- Importar un extracto en Excel ---------------------------------------------------
// El fichero se lee AQUÍ, en el navegador (SheetJS), y al servidor solo van las
// filas: fecha, concepto, importe y saldo. Así el servidor no necesita ninguna
// librería de Excel.

let cargaXlsx = null;
function cargarLectorExcel() {
    if (window.XLSX) return Promise.resolve();
    cargaXlsx ||= new Promise((ok, mal) => {
        const s = document.createElement('script');
        s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
        s.onload = ok;
        s.onerror = () => { cargaXlsx = null; mal(new Error('No se ha podido cargar el lector de Excel.')); };
        document.head.appendChild(s);
    });
    return cargaXlsx;
}

/** "21/10/2026", un número de fecha de Excel o un Date -> "2026-10-21". */
function fechaDeExcel(v) {
    if (v instanceof Date) return iso(v);
    if (typeof v === 'number' && window.XLSX) {
        const d = XLSX.SSF.parse_date_code(v);
        return d ? `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}` : null;
    }
    const m = String(v || '').trim().match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/);
    return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
}
/** 12.5, "-1.234,56" o "-1234.56" -> número. */
function numeroDeExcel(v) {
    if (typeof v === 'number') return v;
    const s = String(v || '').replace(/[^\d,.\-]/g, '');
    if (!s) return NaN;
    return Number(s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s);
}

function leerExtracto(libro) {
    const hoja = libro.Sheets[libro.SheetNames[0]];
    const filas = XLSX.utils.sheet_to_json(hoja, { header: 1, raw: true, defval: '' });
    let iban = null;
    for (const fila of filas.slice(0, 15)) {
        for (const celda of fila) {
            const t = String(celda).replace(/\s+/g, '').toUpperCase();
            if (/^[A-Z]{2}\d{22}$/.test(t)) { iban = t; break; }
        }
        if (iban) break;
    }
    const norm = (c) => sinAcentos(String(c)).toUpperCase();
    const i = filas.findIndex(f => f.some(c => norm(c) === 'CONCEPTO') && f.some(c => /IMPORTE/.test(norm(c))));
    if (i < 0) throw new Error('No encuentro la cabecera (CONCEPTO, IMPORTE) en el fichero.');
    const cab = filas[i].map(norm);
    const col = (re) => cab.findIndex(c => re.test(c));
    const cFecha = col(/FECHA OPERACION/) >= 0 ? col(/FECHA OPERACION/) : col(/^FECHA/);
    const cValor = col(/FECHA VALOR/), cConcepto = col(/^CONCEPTO/), cImporte = col(/IMPORTE/), cSaldo = col(/SALDO/);
    const movimientos = filas.slice(i + 1).map(f => ({
        fecha: fechaDeExcel(f[cFecha]),
        fecha_valor: cValor >= 0 ? fechaDeExcel(f[cValor]) : null,
        concepto: String(f[cConcepto] || '').trim(),
        importe: numeroDeExcel(f[cImporte]),
        saldo: cSaldo >= 0 ? numeroDeExcel(f[cSaldo]) : null
    })).filter(m => m.fecha && Number.isFinite(m.importe) && m.importe !== 0);
    return { iban, movimientos };
}

// --- Extracto en PDF ---------------------------------------------------------------
// Algunos bancos dan el histórico antiguo solo en PDF. Se lee aquí con pdf.js:
// el texto se recompone por posición (es de ancho fijo) y se interpreta.

let cargaPdfjs = null;
function cargarLectorPdf() {
    if (window.pdfjsLib) return Promise.resolve();
    const base = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
    cargaPdfjs ||= new Promise((ok, mal) => {
        const s = document.createElement('script');
        s.src = base + 'pdf.min.js';
        s.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = base + 'pdf.worker.min.js'; ok(); };
        s.onerror = () => { cargaPdfjs = null; mal(new Error('No se ha podido cargar el lector de PDF.')); };
        document.head.appendChild(s);
    });
    return cargaPdfjs;
}

/** Las líneas de texto de un PDF, reconstruidas por posición (el extracto es de ancho fijo). */
async function lineasDePdf(pdfjsLib, datos) {
    const doc = await pdfjsLib.getDocument({ data: datos }).promise;
    const lineas = [];
    for (let n = 1; n <= doc.numPages; n++) {
        const pagina = await doc.getPage(n);
        const { items } = await pagina.getTextContent();
        // Ancho de un carácter: la mediana de ancho/longitud de los trozos.
        const anchos = items.filter(i => i.str.trim() && i.width > 0).map(i => i.width / i.str.length).sort((a, b) => a - b);
        const ancho = anchos[Math.floor(anchos.length / 2)] || 5;
        const porY = new Map();
        for (const it of items) {
            if (!it.str) continue;
            const y = Math.round(it.transform[5]);
            const clave = [...porY.keys()].find(k => Math.abs(k - y) <= 2) ?? y;
            if (!porY.has(clave)) porY.set(clave, []);
            porY.get(clave).push(it);
        }
        for (const y of [...porY.keys()].sort((a, b) => b - a)) {
            let linea = '';
            for (const it of porY.get(y).sort((a, b) => a.transform[4] - b.transform[4])) {
                const col = Math.round(it.transform[4] / ancho);
                if (linea.length < col) linea = linea.padEnd(col, ' ');
                else if (linea.length && !linea.endsWith(' ') && !it.str.startsWith(' ')) linea += ' ';
                linea += it.str;
            }
            lineas.push(linea.replace(/\s+$/, ''));
        }
    }
    return lineas;
}

/**
 * Extracto en PDF de "cuentas personales" (Santander): fechas de operación,
 * valor y contable, código, concepto (en una o varias líneas), importe con D/H
 * y, a veces, el saldo. Devuelve las filas como las del Excel, con el saldo de
 * después de cada apunte calculado y comprobado contra los que trae impresos.
 */
function leerExtractoPdf(lineas) {
    const DINERO = String.raw`(\d{1,3}(?:\.\d{3})*,\d{2}) ([DH])`;
    const reApunte = new RegExp(String.raw`^\s*((?:\d\d-\d\d-\d\d\s+){2,3})(\d{1,4})\s+(.*?)\s+${DINERO}(?:\s+${DINERO})?$`);
    const reSaldo = new RegExp(String.raw`S A L D O\s+(I N I C I A L|F I N A L)\s+A L\s+(\d\d-\d\d-\d{4})\s+${DINERO}$`);
    const dinero = (n, s) => Math.round(Number(n.replace(/\./g, '').replace(',', '.')) * 100) * (s === 'D' ? -1 : 1);
    const fecha = (f) => { const [d, m, a] = f.split('-'); return `${a.length === 2 ? '20' + a : a}-${m}-${d}`; };

    let cuenta = null, saldoInicial = null, saldoFinal = null, dentro = false, ultimo = null;
    const apuntes = [];
    for (const bruta of lineas) {
        const linea = bruta.replace(/^(\s*)[01-](?=\s)/, '$1 ');
        const c = linea.match(/CUENTA\s*:\s*([\d ]{14,})/);
        if (c && !cuenta) cuenta = c[1].replace(/\s+/g, '');
        const s = linea.match(reSaldo);
        if (s) {
            if (s[1].startsWith('I') && saldoInicial === null) saldoInicial = dinero(s[3], s[4]);
            if (s[1].startsWith('F')) saldoFinal = dinero(s[3], s[4]);
            dentro = s[1].startsWith('I'); ultimo = null;
            continue;
        }
        // Cabecera de cada hoja: lo de arriba hasta la línea de títulos no son apuntes.
        if (/E X T R A C T O/.test(linea)) { dentro = false; continue; }
        if (/OPERACI\.\s+VALOR\s+CONTABLE/.test(linea)) { dentro = true; continue; }
        if (!dentro || !linea.trim()) continue;
        const a = linea.match(reApunte);
        if (a) {
            const fechas = a[1].trim().split(/\s+/);
            ultimo = {
                fecha: fecha(fechas[fechas.length - 1]),
                fecha_valor: fecha(fechas[fechas.length - 2]),
                codigo: a[2],
                concepto: a[3].trim(),
                importe: dinero(a[4], a[5]),
                saldo_impreso: a[6] ? dinero(a[6], a[7]) : null
            };
            apuntes.push(ultimo);
        } else if (ultimo && !/^\s*\d\d-\d\d-\d\d/.test(linea) && !/\d,\d\d [DH]\s*$/.test(linea)) {
            ultimo.concepto += ' ' + linea.trim();          // el concepto sigue en la línea de abajo
        } else {
            throw new Error(`No entiendo esta línea del extracto: «${linea.trim().slice(0, 60)}»`);
        }
    }
    if (!apuntes.length) throw new Error('No he encontrado apuntes en el PDF.');
    if (saldoInicial === null) throw new Error('No encuentro el saldo inicial del extracto.');
    // El saldo después de cada apunte, y que cuadre con todos los impresos.
    let saldo = saldoInicial;
    for (const m of apuntes) {
        saldo += m.importe;
        if (m.saldo_impreso !== null && m.saldo_impreso !== saldo) {
            throw new Error(`El saldo no cuadra el ${m.fecha} (${m.concepto.slice(0, 40)}): falta o sobra algún apunte.`);
        }
        m.saldo = saldo;
    }
    if (saldoFinal !== null && saldoFinal !== saldo) throw new Error('El saldo final no cuadra: falta o sobra algún apunte.');
    return {
        iban: cuenta ? ibanDeCuenta(cuenta) : null,
        movimientos: apuntes.map(m => ({ fecha: m.fecha, fecha_valor: m.fecha_valor, concepto: m.concepto,
                                         importe: m.importe / 100, saldo: m.saldo / 100 }))
    };
}

/** "0049 0001 0123456789" (entidad, oficina y cuenta, a veces sin dígitos de control) -> IBAN español. */
function ibanDeCuenta(numero) {
    let n = String(numero).replace(/\D/g, '');
    if (n.length === 18) {
        const dc = (d) => { const p = [1, 2, 4, 8, 5, 10, 9, 7, 3, 6]; const r = 11 - [...d].reduce((s, x, i) => s + Number(x) * p[i], 0) % 11; return r === 11 ? 0 : r === 10 ? 1 : r; };
        n = n.slice(0, 8) + dc('00' + n.slice(0, 8)) + dc(n.slice(8)) + n.slice(8);
    }
    if (n.length !== 20) return null;
    const resto = [...(n + '142800')].reduce((r, x) => (r * 10 + Number(x)) % 97, 0);
    return `ES${String(98 - resto).padStart(2, '0')}${n}`;
}

/** Un extracto en PDF -> { iban, movimientos } como los del Excel. */
async function leerPdfDeExtracto(archivo) {
    await cargarLectorPdf();
    const lineas = await lineasDePdf(window.pdfjsLib, new Uint8Array(await archivo.arrayBuffer()));
    return leerExtractoPdf(lineas);
}

$('bancoConvertir').addEventListener('click', () => $('bancoFicheroPdf').click());
$('bancoFicheroPdf').addEventListener('change', async () => {
    const archivo = $('bancoFicheroPdf').files[0];
    $('bancoFicheroPdf').value = '';
    if (!archivo) return;
    avisoBanco('Leyendo el PDF…');
    try {
        const { iban, movimientos } = await leerPdfDeExtracto(archivo);
        await cargarLectorExcel();
        // El mismo formato que el Excel del banco: así se puede importar luego tal cual.
        const ddmmaaaa = (f) => f ? f.split('-').reverse().join('/') : '';
        const filas = [['IBAN', iban || ''], [],
            ['FECHA OPERACIÓN', 'FECHA VALOR', 'CONCEPTO', 'IMPORTE EUR', 'SALDO'],
            ...movimientos.slice().reverse().map(m => [ddmmaaaa(m.fecha), ddmmaaaa(m.fecha_valor), m.concepto, m.importe, m.saldo])];
        const libro = XLSX.utils.book_new();
        const hoja = XLSX.utils.aoa_to_sheet(filas);
        hoja['!cols'] = [{ wch: 16 }, { wch: 14 }, { wch: 70 }, { wch: 12 }, { wch: 12 }];
        XLSX.utils.book_append_sheet(libro, hoja, 'Movimientos');
        const desde = movimientos[0].fecha, hasta = movimientos[movimientos.length - 1].fecha;
        XLSX.writeFile(libro, `extracto_${desde}_${hasta}.xlsx`);
        avisoBanco(`Convertido: ${plural(movimientos.length, 'movimiento')} del ${fechaCorta(desde)} al ${fechaCorta(hasta)}, con todos los saldos cuadrados.`);
    } catch (err) {
        avisoBanco(err.message || 'No se ha podido leer el PDF.', true);
    }
});

$('bancoImportar').addEventListener('click', () => $('bancoFichero').click());
$('bancoFichero').addEventListener('change', async () => {
    const archivo = $('bancoFichero').files[0];
    $('bancoFichero').value = '';
    if (!archivo) return;
    avisoBanco('Leyendo el extracto…');
    try {
        const esPdf = /\.pdf$/i.test(archivo.name) || archivo.type === 'application/pdf';
        let iban, movimientos;
        if (esPdf) ({ iban, movimientos } = await leerPdfDeExtracto(archivo));
        else {
            await cargarLectorExcel();
            ({ iban, movimientos } = leerExtracto(XLSX.read(await archivo.arrayBuffer(), { type: 'array', cellDates: false })));
        }
        if (!iban) throw new Error('El fichero no trae el IBAN de la cuenta.');
        if (!movimientos.length) throw new Error('No he encontrado movimientos en el fichero.');
        avisoBanco(`Importando ${plural(movimientos.length, 'movimiento')}…`);
        const res = await api('/api/banco/importar', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ iban, filas: movimientos })
        });
        const r = await res.json();
        if (!res.ok) throw new Error(r.error || 'No se ha podido importar.');
        avisoBanco(`Importado: ${plural(r.nuevos, 'movimiento nuevo', 'movimientos nuevos')}` +
            (r.emparejados ? `, ${r.emparejados} ya estaban por la conexión` : '') +
            (r.repetidos ? `, ${r.repetidos} ya importados antes` : '') + '.');
        await pintarBanco();
        cargarHistorial({ reiniciar: true });
        cargarPanel();
    } catch (err) {
        if (err && err.message !== 'sin sesion') avisoBanco(err.message, true);
    }
});

// Al volver del banco: /?banco=conectado o /?banco=error&mensaje=…
(() => {
    const p = new URLSearchParams(location.search);
    if (!p.has('banco')) return;
    const ok = p.get('banco') === 'conectado';
    history.replaceState(null, '', location.pathname);
    setTimeout(async () => {
        await abrirBanco();
        avisoBanco(ok ? 'Banco conectado. Marca la cuenta que quieres leer.' : (p.get('mensaje') || 'No se ha podido conectar.'), !ok);
    }, 300);
})();

// =============================================================================
// TIEMPO REAL: lo que pasa en otras pestañas y dispositivos
// =============================================================================
// Un escaneo lanzado desde el móvil sale aquí mientras se analiza y, al acabar,
// con un botón para revisarlo. Lo mismo si se recarga la página a media subida:
// el servidor sigue y avisa al terminar. Cualquier otro cambio hecho en otro
// sitio (editar, borrar, unir) recarga el panel y el historial.

const escaneosAjenos = new Map();     // id -> { estado: 'analizando'|'listo'|'error', ... }

function pintarEscaneosAjenos() {
    const caja = $('escaneosAjenos');
    const lista = [...escaneosAjenos.values()];
    caja.classList.toggle('hidden', lista.length === 0);
    caja.innerHTML = lista.map(e => {
        if (e.estado === 'analizando') {
            return `<div class="escaneo-ajeno"><span class="girando"></span>
                <span>${e.tipo === 'reintento' ? 'Reintentando un tiquet' : 'Analizando un tiquet'}…</span></div>`;
        }
        if (e.estado === 'listo') {
            return `<div class="escaneo-ajeno"><span class="punto-ok"></span>
                <span>${esc(e.ids.length > 1 ? `${e.ids.length} tiquets analizados` : 'Tiquet analizado')}</span>
                <button type="button" class="boton boton-sm" data-revisar="${e.id}">Revisar</button>
                <button type="button" class="cerrar-escaneo" data-quitar="${e.id}" aria-label="Quitar">&times;</button></div>`;
        }
        return `<div class="escaneo-ajeno"><span class="punto-error"></span>
            <span title="${esc(e.mensaje || '')}">No se ha podido analizar</span>
            <button type="button" class="cerrar-escaneo" data-quitar="${e.id}" aria-label="Quitar">&times;</button></div>`;
    }).join('');
}
$('escaneosAjenos').addEventListener('click', (ev) => {
    const revisar = ev.target.closest('[data-revisar]');
    const quitar = ev.target.closest('[data-quitar]');
    if (revisar) {
        const e = escaneosAjenos.get(revisar.dataset.revisar);
        escaneosAjenos.delete(revisar.dataset.revisar);
        pintarEscaneosAjenos();
        if (e && e.ids.length) Editor.abrirPorIds(e.ids);
    } else if (quitar) {
        escaneosAjenos.delete(quitar.dataset.quitar);
        pintarEscaneosAjenos();
    }
});

let temporizadorRefresco = null;
function refrescarPorCambioAjeno() {
    clearTimeout(temporizadorRefresco);
    temporizadorRefresco = setTimeout(() => {
        // La ventana del banco abierta: su estado (última descarga, cupo) también.
        if (!$('bancoOverlay').classList.contains('hidden')) pintarBanco();
        cargarPanel();
        cargarHistorial({ reiniciar: true });
    }, 700);
}

function conectarEventos() {
    if (!window.EventSource) return;
    // EventSource se reconecta solo si se corta (red, reinicio del servidor).
    const fuente = new EventSource('/api/eventos');
    const leer = (ev) => { try { return JSON.parse(ev.data); } catch (_) { return {}; } };

    fuente.addEventListener('hola', (ev) => {
        // Al (re)conectar: los escaneos que siguen en marcha, incluidos los que
        // lanzó esta misma página antes de recargarla.
        for (const [id, e] of escaneosAjenos) if (e.estado === 'analizando') escaneosAjenos.delete(id);
        for (const e of leer(ev).escaneos || []) {
            if (e.origen !== CLIENTE_ID) escaneosAjenos.set(e.id, { ...e, estado: 'analizando', ids: [] });
        }
        pintarEscaneosAjenos();
    });
    fuente.addEventListener('escaneo-inicio', (ev) => {
        const e = leer(ev);
        if (e.origen === CLIENTE_ID) return;
        escaneosAjenos.set(e.id, { ...e, estado: 'analizando', ids: [] });
        pintarEscaneosAjenos();
    });
    fuente.addEventListener('escaneo-fin', (ev) => {
        const e = leer(ev);
        if (e.origen === CLIENTE_ID) return;
        escaneosAjenos.set(e.id, { ...e, estado: e.ok && e.ids.length ? 'listo' : e.ok ? 'quitar' : 'error' });
        if (escaneosAjenos.get(e.id).estado === 'quitar') escaneosAjenos.delete(e.id);
        pintarEscaneosAjenos();
    });
    fuente.addEventListener('cambio', (ev) => {
        if (leer(ev).origen === CLIENTE_ID) return;
        refrescarPorCambioAjeno();
    });
}
