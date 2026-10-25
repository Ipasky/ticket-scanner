/**
 * Registro del service worker.
 *
 * En un archivo aparte y no en línea en cada página porque lo incluyen las tres
 * (index, login y sin-identidad): la instalación tiene que poder empezar desde
 * donde se entre, y en modo local lo primero que se ve es el login.
 *
 * Todo lo que importa de verdad está en sw.js. Esto solo lo engancha, y lo hace
 * con cuidado de no estorbar: si falla el registro, la web sigue funcionando
 * exactamente igual —solo deja de ser instalable—, así que el error se anota en
 * la consola y nada más.
 */
(function registrarServiceWorker() {
    if (!('serviceWorker' in navigator)) return;

    // Después de 'load': registrar antes compite por el ancho de banda con lo que
    // la página necesita para pintarse.
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js', { scope: '/' })
            .catch((error) => {
                console.warn('Service worker no registrado (la web funciona igual):', error);
            });
    });
})();
