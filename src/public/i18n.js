/**
 * Capa de traducción: la interfaz en inglés sin tocar la lógica.
 *
 * La aplicación está escrita en español. Con el idioma en inglés, esta capa
 * traduce lo que se PINTA (textos, placeholders, títulos) con un diccionario y
 * unas reglas para los textos con números, y pasa las fechas a formato inglés.
 * Los DATOS no se tocan: lo que hay escrito en los campos, los nombres de las
 * tiendas, los conceptos del banco y las categorías guardadas siguen en
 * español; las categorías solo se ENSEÑAN traducidas.
 *
 * Lo que se escape queda en español: se añade al diccionario y listo.
 * Cambiar de idioma recarga la página, así no hay que deshacer nada.
 */
(() => {
    let idioma = 'es';
    try { idioma = localStorage.getItem('idioma') === 'en' ? 'en' : 'es'; } catch (_) { /* sin almacenamiento */ }
    window.IDIOMA = idioma;
    window.cambiarIdioma = (nuevo) => {
        try { localStorage.setItem('idioma', nuevo); } catch (_) { /* nada */ }
        location.reload();
    };
    document.documentElement.lang = idioma;
    if (idioma !== 'en') return;

    // --- Fechas: lo que la app pide en es-ES sale en inglés ----------------------
    for (const metodo of ['toLocaleDateString', 'toLocaleTimeString', 'toLocaleString']) {
        const original = Date.prototype[metodo];
        Date.prototype[metodo] = function (locale, opciones) {
            return original.call(this, typeof locale === 'string' && locale.startsWith('es') ? 'en-GB' : locale, opciones);
        };
    }

    // --- Diccionario: el texto entero, tal cual -----------------------------------
    const D = {
        // Cabecera y navegación
        'Tiquets': 'Receipts', 'Tiquet': 'Receipt', 'Paleta de color': 'Colour palette', 'Banco': 'Bank', 'Tema': 'Theme',
        'Cambiar entre claro y oscuro': 'Switch between light and dark', 'Tema oscuro': 'Dark theme', 'Tema claro': 'Light theme',
        'Cerrar': 'Close', 'Cerrar sesión': 'Log out', 'Salir del portal': 'Leave the portal', 'Escanear tiquet': 'Scan receipt',
        'Historial': 'History', 'Análisis': 'Analysis', 'Mapa': 'Map', 'Comercios': 'Merchants', 'Idioma': 'Language',
        'Original': 'Original', 'Verde': 'Green', 'Magenta': 'Magenta', 'Amarillo': 'Yellow', 'Rojo': 'Red', 'Lima': 'Lime', 'Sobrio': 'Sober',
        // Subida
        'Suelta aquí una foto o un PDF': 'Drop a photo or a PDF here', 'o elige el archivo: imágenes y facturas en PDF, hasta 100 MB': 'or choose a file: images and PDF invoices, up to 100 MB',
        'Cámara': 'Camera', 'Subiendo': 'Uploading', 'Analizando': 'Analysing', 'Guardando': 'Saving', 'Modelo': 'Model', 'Analizar': 'Analyse',
        'Automático': 'Automatic', 'Mejor': 'Best', 'Rápido': 'Fast', 'Vista previa del archivo elegido': 'Preview of the chosen file',
        'La IA está leyendo el documento…': 'The AI is reading the document…', 'error de red': 'network error', 'Preparando el envío…': 'Preparing the upload…',
        'Guardando la ficha…': 'Saving the entry…', 'No se ha podido subir el archivo (error de red).': 'The file could not be uploaded (network error).',
        'sin procesar': 'not processed', 'No se ha podido analizar': 'It could not be analysed', 'Probar con otro archivo': 'Try another file',
        'Abrir la ficha': 'Open the entry', 'Analizado': 'Analysed', 'Revisar': 'Review', 'página': 'page', 'Falta la fecha': 'Date missing',
        'No se ha podido cargar el visor de PDF. Ábrelo aparte.': 'The PDF viewer could not be loaded. Open it separately.',
        'Reintentando un tiquet': 'Retrying a receipt', 'Analizando un tiquet': 'Analysing a receipt', 'analizando…': 'analysing…',
        // Panel
        'Este mes': 'This month', 'Este año': 'This year', 'del mes en curso': 'this month', 'Gasto': 'Spending', 'Movimientos': 'Transactions',
        'Gasto medio': 'Average spend', 'Media por tiquet': 'Average per receipt', 'Día de más gasto': 'Top spending day', 'Mes de más gasto': 'Top spending month',
        'Año de más gasto': 'Top spending year', 'Reparto por categoría': 'By category', 'Dónde más gasto': 'Where I spend most', 'Dónde gasto': 'Where I spend',
        'Gasto en el tiempo': 'Spending over time', 'Gasto por día de la semana': 'Spending by weekday', 'Día': 'Day', 'Semana': 'Week', 'Mes': 'Month',
        'Año': 'Year', 'Todo': 'All', 'Hoy': 'Today', 'Todo el histórico': 'All time', 'Previsión a fin de mes': 'End-of-month forecast',
        'Bizum enviados': 'Bizum sent', 'Bizum recibidos': 'Bizum received', 'Ingresos': 'Income', 'este mes': 'this month',
        'frente al mes anterior': 'vs. last month', 'frente al año anterior': 'vs. last year', 'año anterior': 'last year', 'todavía sin comparar': 'nothing to compare yet',
        'por debajo de tu gasto habitual': 'below your usual spending', 'tu gasto habitual': 'your usual spending', 'por encima de tu gasto habitual': 'above your usual spending',
        'sin gasto': 'no spending', 'el pendiente': 'outstanding', 'Bizum e ingresos': 'Bizum & income', 'Balance Bizum': 'Bizum balance',
        'Enviados': 'Sent', 'Recibidos': 'Received', 'te han devuelto más': 'you got back more', 'has enviado más': 'you sent more',
        'Ningún Bizum ni ingreso en este periodo.': 'No Bizum or income in this period.', 'Ningún tiquet con hora conocida.': 'No receipts with a known time.',
        'Ningún tiquet este día.': 'No receipts on this day.', 'Sin gasto en este periodo.': 'No spending in this period.', 'Otras': 'Others',
        'Otras categorías': 'Other categories', '(sin categoría)': '(no category)', 'Sin comercios en este periodo.': 'No merchants in this period.',
        'cuentan como gasto': 'count as spending', 'no restan gasto': 'not deducted from spending',
        'Lun': 'Mon', 'Mar': 'Tue', 'Mié': 'Wed', 'Jue': 'Thu', 'Vie': 'Fri', 'Sáb': 'Sat', 'Dom': 'Sun',
        'L': 'M', 'M': 'T', 'X': 'W', 'J': 'T', 'V': 'F', 'S': 'S', 'D': 'S',
        // Historial
        'Buscar comercio, persona, categoría o producto': 'Search shop, person, category or product', 'Quitar todos los filtros': 'Clear all filters',
        'Fecha del tiquet, primero el reciente': 'Receipt date, newest first', 'Fecha del tiquet, primero el antiguo': 'Receipt date, oldest first',
        'Importe, de mayor a menor': 'Amount, high to low', 'Importe, de menor a mayor': 'Amount, low to high',
        'Fecha de subida, primero el reciente': 'Upload date, newest first', 'Fecha de subida, primero el antiguo': 'Upload date, oldest first',
        'Limpiar': 'Clear', 'Filtros': 'Filters', 'Desde': 'From', 'Hasta': 'To', 'Importe mínimo (€)': 'Minimum amount (€)', 'Importe máximo (€)': 'Maximum amount (€)',
        'Categoría': 'Category', 'Tipo': 'Type', 'Estado': 'Status', 'Todos': 'All', 'Procesado': 'Processed', 'Incompleto': 'Incomplete', 'Pendiente': 'Pending',
        'procesado': 'processed', 'incompleto': 'incomplete', 'pendiente': 'pending', 'error': 'error',
        'Cargando…': 'Loading…', 'No se ha podido cargar el historial.': 'The history could not be loaded.', 'No hay tiquets con estos filtros.': 'No receipts match these filters.',
        'Error de conexión.': 'Connection error.', 'Nada con estos filtros.': 'Nothing matches these filters.', 'del banco': 'from the bank',
        'Tiquet confirmado por el banco': 'Receipt confirmed by the bank', 'Confirmado por el banco: hay un pago con tarjeta que casa con este tiquet': 'Confirmed by the bank: a card payment matches this receipt',
        'Tiq': 'Rcpt', 'Tarj': 'Card', 'Biz': 'Biz', 'Bco': 'Bank', 'sin ubicar': 'not located', 'ubicación dudosa': 'doubtful location',
        'sin fecha': 'no date', 'sin importe': 'no amount', 'sin comercio': 'no merchant',
        // Movimientos
        'Pago con tarjeta': 'Card payment', 'Pago con tarjeta · sin tiquet': 'Card payment · no receipt', 'Recibo': 'Direct debit', 'Comisión': 'Fee',
        'Devolución': 'Refund', 'Movimiento': 'Transaction', 'no cuenta como gasto': 'does not count as spending', 'Bizum enviado': 'Bizum sent',
        'Bizum recibido': 'Bizum received', 'Transferencia enviada': 'Transfer sent', 'Transferencia recibida': 'Transfer received',
        'Transferencia recibida / ingreso': 'Transfer received / income', 'Devolución o anulación': 'Refund or cancellation', 'Otro': 'Other',
        'Puesta a mano.': 'Set by hand.', 'Por el tipo de movimiento o una regla.': 'From the transaction type or a rule.', 'La de su tiquet.': 'From its receipt.',
        'La que tiene este comercio.': 'The one this merchant has.', 'Elegida por Gemini.': 'Chosen by Gemini.', 'Sin categoría todavía.': 'No category yet.',
        'Enlazado con su tiquet: abrir': 'Linked to its receipt: open', 'Enlazado con su tiquet': 'Linked to its receipt', 'Marcado como sin tiquet.': 'Marked as having no receipt.',
        'Marcado como sin tiquet': 'Marked as having no receipt', 'Sin tiquet enlazado.': 'No receipt linked.', 'no tiene': 'none', 'sin enlazar': 'not linked',
        'enlazado': 'linked', 'Buscar su tiquet': 'Find its receipt', 'No hay tiquets en esos días.': 'No receipts on those days.', '· mismo importe': '· same amount',
        'mismo importe': 'same amount', 'de un tiquet tuyo enlazado con un pago': 'from one of your receipts linked to a payment', 'identificado por Gemini': 'identified by Gemini',
        'puesto a mano': 'set by hand', 'tienda online': 'online shop', 'cadena': 'chain', 'negocio local': 'local business',
        'Nombre en el banco': 'Name at the bank', 'Nombre unificado': 'Unified name', 'pendiente de identificar': 'waiting to be identified', 'Persona': 'Person',
        'Concepto del Bizum': 'Bizum description', 'Contraparte': 'Counterparty', 'Cuenta': 'Account', 'Código de comercio': 'Merchant code', 'Llegó': 'Source',
        'del extracto importado': 'from an imported statement', 'descargado del banco': 'downloaded from the bank', 'Fecha valor': 'Value date', 'Concepto': 'Description',
        'Cuenta como gasto': 'Counts as spending', 'Desmárcalo si es un traspaso entre tus cuentas o dinero a una inversión.': 'Untick it for a transfer between your own accounts or money moved into an investment.',
        'Pagado entre varios': 'Split between several people', 'Entre': 'Between', 'personas': 'people', 'Mi parte': 'My share', 'Una persona más': 'One more person',
        'Una persona menos': 'One less person', 'solo tú': 'just you', 'no': 'no', 'Detalles del banco': 'Bank details', 'Es una suscripción…': 'It is a subscription…',
        'Cambiarlo aquí solo cambia este pago, salvo que marques que sea para todos los de este comercio. Vacíalo para que vuelva a ser el de su comercio.': 'Changing it here only changes this payment, unless you tick it for every payment of this merchant. Empty it to go back to the merchant’s place.',
        'el otro pago': 'the other payment', 'Sin establecimiento.': 'No place.', 'Todavía sin identificar: se hace solo en segundo plano.': 'Not identified yet: it happens on its own in the background.',
        'ver en Maps': 'view on Maps', 'verificado en Google': 'verified on Google', 'puesto a mano solo en este pago': 'set by hand for this payment only',
        'Sin dirección': 'No address', 'sin dirección': 'no address', 'Asignar': 'Assign', 'Se cambiará al guardar, solo en este pago.': 'It will change when you save, for this payment only.',
        'Establecimiento nuevo: se creará al guardar, solo para este pago.': 'New place: it will be created when you save, for this payment only.',
        'Elige uno de la lista, o se guardará con este nombre solo en este pago.': 'Pick one from the list, or it will be saved with this name for this payment only.',
        'Vacío: volverá a ser el de su comercio.': 'Empty: it will go back to the merchant’s place.', '¿Cambiarlo en todos sus pagos?': 'Change it for all its payments?',
        'Cambiar todos': 'Change all', 'identificarse solos': 'being identified automatically', 'Tarjeta': 'Card', '(a mano)': '(by hand)',
        'Falta el tiquet: buscar': 'Missing receipt: find', 'Con tiquet': 'With receipt', 'Sin tiquet': 'No receipt', 'Con tiquet (a mano)': 'With receipt (by hand)',
        'Cambiar': 'Change', 'comidas por repartir': 'meals to split',
        // Comensales
        '¿Cuántos erais?': 'How many of you were there?', 'Comensales': 'Diners', 'Mi parte (opcional, si no fue a partes iguales)': 'My share (optional, if it was not split evenly)',
        'Más tarde': 'Later', 'Restaurante': 'Restaurant', 'Elige cuántos erais.': 'Choose how many of you there were.', 'Cuenta entero como gasto tuyo.': 'The whole amount counts as your spending.',
        'No se ha podido guardar. Vuelve a intentarlo.': 'It could not be saved. Try again.',
        // Suscripciones
        'Suscripciones': 'Subscriptions', 'Suscripción': 'Subscription', '+ Añadir': '+ Add', 'Nombre': 'Name', 'Importe (€)': 'Amount (€)', 'Cada': 'Every',
        'Próximo cargo': 'Next charge', 'mes': 'month', 'trimestre': 'quarter', 'mensual': 'monthly', 'trimestral': 'quarterly', 'anual': 'yearly',
        'cada mes': 'monthly', 'cada trimestre': 'every quarter', 'cada año': 'yearly', '¿Es una suscripción?': 'Subscription?', 'parece dada de baja': 'looks cancelled',
        'ha subido de precio': 'price went up', 'añadida a mano': 'added by hand', 'Editar': 'Edit', 'Quitar': 'Remove', 'No es una suscripción': 'Not a subscription',
        'Sí, es una suscripción': 'Yes, it is a subscription',
        'Ninguna todavía. Añade las que tengas con "+ Añadir" o desde la ficha de un movimiento.': 'None yet. Add yours with "+ Add" or from a transaction.',
        'Recuperar': 'Restore', 'No se ha podido guardar.': 'It could not be saved.', 'Suscripción confirmada': 'Subscription confirmed',
        'Descartada: no cuenta como suscripción': 'Dismissed: not counted as a subscription', 'Nueva suscripción': 'New subscription', 'Ponle un nombre.': 'Give it a name.',
        'Suscripción guardada': 'Subscription saved', 'Netflix, gimnasio, seguro…': 'Netflix, gym, insurance…',
        // Buscador de establecimientos
        'Tus establecimientos': 'Your places', 'En Google Maps': 'On Google Maps', 'Elegir': 'Choose', 'Crear': 'Create', 'Ninguno coincide.': 'No match.',
        'Buscando…': 'Searching…', 'Buscar en Google': 'Search Google', 'Google no ha encontrado nada con eso.': 'Google found nothing for that.', '· cerrado': '· closed',
        'Uno nuevo; se buscará en el mapa solo': 'A new one; it will be located on the map automatically', 'Escribe el nombre del sitio.': 'Type the place name.',
        'Google no ha respondido.': 'Google did not respond.', 'Es este': 'It is this one', 'Nuevo': 'New', 'Unir con este': 'Merge with this one', 'Es este sitio': 'It is this place',
        'Busca uno tuyo o en Google Maps': 'Search yours or on Google Maps', 'Nombre del sitio o de un establecimiento tuyo': 'Place name or one of your places',
        'Ver opciones': 'See options', 'Ver todas las categorías': 'See all categories', 'Elige o escribe': 'Pick or type',
        // Ficha del tiquet
        'Cerrar sin guardar': 'Close without saving', 'Foto del tiquet': 'Receipt photo', 'Alejar': 'Zoom out', 'Acercar': 'Zoom in', 'Ajustar': 'Fit',
        'Ampliar': 'Enlarge', 'Abrir aparte': 'Open separately', 'Establecimiento': 'Place', 'Establecimientos': 'Places', 'Pago del banco': 'Bank payment',
        'Importe': 'Amount', 'Moneda': 'Currency', 'Fecha': 'Date', 'Hora': 'Time', 'Dirección y coordenadas': 'Address and coordinates',
        'Pegar dirección de Google Maps': 'Paste a Google Maps address', 'Se reparte sola en los campos de abajo': 'It fills in the fields below on its own',
        'Dirección': 'Address', 'Ciudad': 'City', 'C.P.': 'Postcode', 'País': 'Country', 'España': 'Spain', 'Lugar deducido (si el papel no trae dirección)': 'Inferred place (if the receipt has no address)',
        'Lugar deducido': 'Inferred place', 'Coordenadas': 'Coordinates', 'Más sobre la fecha': 'More about the date', 'Este documento no imprime fecha.': 'This document has no printed date.',
        'El campo está vacío: márcalo si has comprobado que el papel no la lleva.': 'The field is empty: tick it if you have checked that the receipt does not have one.',
        'Fecha del evento': 'Event date', 'Hora del evento': 'Event time', 'Tipo de documento y pago': 'Document type and payment', 'Tipo de documento': 'Document type',
        'Método de pago': 'Payment method', 'Líneas del tiquet': 'Receipt lines', 'Añadir línea': 'Add line', 'Detalles': 'Details', 'Añadir par': 'Add pair',
        'Borrar': 'Delete', 'Saltar': 'Skip', 'Guardar': 'Save', 'Cancelar': 'Cancel', 'Aceptar': 'OK', 'Guardar y siguiente': 'Save and next',
        'Guardar y terminar': 'Save and finish', 'Volver a analizar…': 'Analyse again…', 'Volver a analizar': 'Analyse again', 'No verificado por Google': 'Not verified by Google',
        'Verificado por Google': 'Verified by Google', 'Verificado en Google': 'Verified on Google', 'Abrir la ficha del establecimiento': 'Open the place page',
        'Vacío = el documento no lleva importe (cuenta como 0,00 €). Un 0 = el documento pone cero.': 'Empty = the document shows no amount (counts as 0.00 €). A 0 = the document says zero.',
        'Déjala vacía si el tiquet no la imprime: no se rellena con 00:00.': 'Leave it empty if the receipt does not print it: it is not filled in with 00:00.',
        'Hay cambios sin guardar': 'There are unsaved changes', 'Lo que has escrito en esta ficha se perderá.': 'What you typed in this entry will be lost.',
        'Puestas a mano. La geocodificación automática no las toca.': 'Set by hand. Automatic geocoding does not touch them.',
        'Puestas a mano no se tocan nunca. Vacíalas para volver a la ubicación automática.': 'Coordinates set by hand are never changed. Empty them to go back to automatic location.',
        'Situado por su dirección completa.': 'Located by its full address.', 'Situado por la calle: el número no se encontró.': 'Located by street: the number was not found.',
        'Situado por el código postal: ubicación aproximada.': 'Located by postcode: approximate location.', 'Situado por la localidad: ubicación aproximada.': 'Located by town: approximate location.',
        'ubicación aproximada.': 'approximate location.', 'Ubicación aproximada': 'Approximate location',
        'No he sabido repartirla: rellénala a mano aquí debajo.': 'I could not split it: fill it in by hand below.', 'No he sabido repartirla: rellénala a mano.': 'I could not split it: fill it in by hand.',
        'Al guardar se situará en el mapa.': 'It will be placed on the map when you save.', 'se situará al guardar': 'will be located when you save',
        'en el mapa (coordenadas a mano)': 'on the map (coordinates by hand)', 'en el mapa': 'on the map', 'en el mapa, aproximada': 'on the map, approximate',
        'buscándola…': 'looking for it…', 'no se ha encontrado: pega la dirección de Google Maps': 'not found: paste the Google Maps address',
        'sin ubicación: pega la dirección de Google Maps': 'no location: paste the Google Maps address', 'Ver el movimiento': 'View transaction', 'Desenlazar': 'Unlink',
        'No hay pagos con tarjeta sin tiquet en esos días.': 'No card payments without a receipt on those days.', 'Desenlazado del pago': 'Unlinked from the payment',
        'Enlazado con su pago del banco': 'Linked to its bank payment', 'Ya lo tenías guardado: es este establecimiento.': 'You already had it: it is this place.',
        'de Google: se guardará verificado': 'from Google: it will be saved as verified', 'elegir el bueno': 'pick the right one', 'línea': 'line',
        'Establecimiento nuevo: al guardar se buscará en el mapa.': 'New place: it will be located on the map when you save.', 'No se ha guardado.': 'It was not saved.',
        'No se ha guardado: sería un duplicado.': 'It was not saved: it would be a duplicate.', 'Error al guardar.': 'Error while saving.', 'Error de conexión al guardar.': 'Connection error while saving.',
        'Se sustituirán los datos extraídos; tus correcciones manuales se perderán.': 'The extracted data will be replaced; your manual corrections will be lost.',
        '¿Volver a analizar la foto?': 'Analyse the photo again?', '¿Volver a analizar este tiquet?': 'Analyse this receipt again?', 'Enviando el archivo a la IA…': 'Sending the file to the AI…',
        'No se ha podido analizar.': 'It could not be analysed.', 'La IA no ha reconocido ningún tiquet': 'The AI did not recognise any receipt', 'Ficha analizada de nuevo': 'Entry analysed again',
        'Analizado.': 'Analysed.', 'Error de conexión al volver a analizar.': 'Connection error while analysing again.', 'No se ha podido consultar la lista de pendientes.': 'The pending list could not be loaded.',
        'No queda ninguna ficha pendiente.': 'No pending entries left.', 'Parar': 'Stop', 'error de conexión': 'connection error', 'Reintento terminado.': 'Retry finished.',
        'Se ha parado por un problema de conexión; el resto sigue pendiente.': 'Stopped because of a connection problem; the rest is still pending.',
        'Parado a mano; el resto sigue pendiente.': 'Stopped by hand; the rest is still pending.', 'Parando en cuanto termine la ficha que está en marcha…': 'Stopping as soon as the current entry finishes…',
        'Se borran la ficha y su foto. No se puede deshacer.': 'The entry and its photo will be deleted. This cannot be undone.', 'No se ha podido borrar.': 'It could not be deleted.',
        'Error de conexión al borrar.': 'Connection error while deleting.', 'tiquet': 'receipt', 'factura': 'invoice', 'entrada': 'ticket', 'compra': 'purchase',
        'TIQUET': 'RECEIPT', 'FACTURA': 'INVOICE', 'ENTRADA': 'TICKET', 'EFECTIVO': 'CASH', 'TARJETA': 'CARD', 'DESCONOCIDO': 'UNKNOWN', 'MIXTO': 'MIXED',
        // Ficha del establecimiento
        'Qué es': 'Activity', 'Buscar el sitio o unir con otro': 'Find the place or merge with another', 'Más': 'More', 'Es online (sin ubicación)': 'Online (no location)',
        'Desvincular de Google': 'Unlink from Google', 'No es ninguno de estos': 'None of these', 'Abrir su ficha': 'Open its page', 'Buscarle ubicación': 'Find its location',
        'Elige un sitio de Google para verificar este establecimiento, o uno de los tuyos para unirlos: sus tiquets y cargos pasan a este.': 'Pick a Google place to verify this one, or one of yours to merge them: its receipts and charges move to this one.',
        'cargo del banco': 'bank charge', 'cargos del banco': 'bank charges', 'Todavía no hay establecimientos.': 'No places yet.',
        'Google ha encontrado varios: elige el bueno': 'Google found several: pick the right one', 'Google no lo conoce': 'Google does not know it', 'No está en Google': 'Not on Google',
        'Pendiente de buscar en Google': 'Waiting to be searched on Google', 'sin ubicación, no sale en el mapa': 'no location, not shown on the map', 'en el mapa, puesto a mano': 'on the map, set by hand',
        'en el mapa, aproximado': 'on the map, approximate', 'sin situar en el mapa': 'not on the map', 'Tiene ubicación (no es online)': 'Has a location (not online)',
        'sin ubicación': 'no location', 'vacía': 'empty', 'No se ha podido cambiar.': 'It could not be changed.', 'Sin ubicación: no saldrá en el mapa': 'No location: it will not appear on the map',
        'Se le buscará ubicación': 'Its location will be looked up', 'Google ha encontrado un sitio: ¿es este?': 'Google found a place: is it this one?', 'Ya existía: unidos en uno': 'It already existed: merged into one',
        'Desvinculado de Google': 'Unlinked from Google', 'Lo que le falte a este (dirección, ubicación) se completa con lo del otro.': 'Whatever this one is missing (address, location) is filled in from the other.',
        'Unir': 'Merge', 'No se han podido unir.': 'They could not be merged.', 'Tienda online': 'Online shop', 'Buscar establecimiento': 'Search places',
        'Ningún establecimiento tiene coordenadas todavía.': 'No place has coordinates yet.', 'Montserrat, Barcelona': 'Montserrat, Barcelona',
        // Mapa
        'Google ha rechazado la clave del mapa: revisa GOOGLE_MAPS_API_KEY y sus restricciones.': 'Google rejected the map key: check GOOGLE_MAPS_API_KEY and its restrictions.',
        'no carga': 'not loading', 'sin compras ubicadas': 'no located purchases', 'Sin compras con ubicación en este periodo.': 'No purchases with a location in this period.',
        'Falta la clave del mapa (GOOGLE_MAPS_API_KEY en el .env).': 'The map key is missing (GOOGLE_MAPS_API_KEY in .env).', 'No se ha podido cargar Google Maps (¿sin conexión?).': 'Google Maps could not be loaded (offline?).',
        'Abrir en Google Maps': 'Open in Google Maps',
        // Banco
        'Conectar con el banco': 'Connect to the bank', 'Sincronizar ahora': 'Sync now', 'Importar extracto': 'Import statement', 'Convertir PDF a Excel': 'Convert PDF to Excel',
        'Renovar el permiso': 'Renew consent', 'Cuentas que se leen': 'Accounts being read', 'Sin configurar: faltan la clave o el id de Enable Banking en el .env.': 'Not configured: the Enable Banking key or id is missing in .env.',
        'Sin conectar.': 'Not connected.', 'no se lee': 'not read', 'Marca la cuenta que quieres leer: hasta entonces no se descarga nada.': 'Tick the account you want to read: nothing is downloaded until then.',
        'mañana': 'tomorrow', 'Última actualización': 'Last sync', 'todavía ninguna': 'none yet', 'Próxima automática': 'Next automatic', 'descargando ahora…': 'downloading now…',
        'mañana (cupo de hoy gastado)': 'tomorrow (today’s allowance used)', 'en unos minutos': 'in a few minutes', 'Automáticas hoy': 'Automatic today',
        '(no gasta el cupo automático)': '(does not use the automatic allowance)', 'Último intento': 'Last attempt', 'Actualizar a mano': 'Manual sync', 'disponible': 'available',
        'Nada con este filtro.': 'Nothing matches this filter.', 'Se leerá esta cuenta. Pulsa "Sincronizar ahora" para traer sus movimientos.': 'This account will be read. Press "Sync now" to fetch its transactions.',
        'Preparando la autorización con el banco…': 'Preparing the bank authorisation…', 'Enable Banking no ha devuelto la dirección del banco.': 'Enable Banking did not return the bank address.',
        'Abriendo la página del banco…': 'Opening the bank page…', 'No se ha podido conectar.': 'It could not connect.', 'Sincronizando…': 'Syncing…',
        'Al día: no hay movimientos nuevos.': 'Up to date: no new transactions.', 'El banco ha devuelto un error.': 'The bank returned an error.',
        'El permiso ha caducado: vuelve a conectar.': 'Consent has expired: connect again.', 'Ya se está sincronizando.': 'Already syncing.', 'No hay conexión con el banco.': 'No connection to the bank.',
        'No se ha podido sincronizar.': 'It could not sync.', 'No se ha podido cargar el lector de Excel.': 'The Excel reader could not be loaded.',
        'No encuentro la cabecera (CONCEPTO, IMPORTE) en el fichero.': 'I cannot find the header (CONCEPTO, IMPORTE) in the file.', 'No se ha podido cargar el lector de PDF.': 'The PDF reader could not be loaded.',
        'No he encontrado apuntes en el PDF.': 'I found no entries in the PDF.', 'No encuentro el saldo inicial del extracto.': 'I cannot find the opening balance of the statement.',
        'El saldo final no cuadra: falta o sobra algún apunte.': 'The closing balance does not add up: an entry is missing or extra.', 'Leyendo el PDF…': 'Reading the PDF…',
        'No se ha podido leer el PDF.': 'The PDF could not be read.', 'Leyendo el extracto…': 'Reading the statement…', 'El fichero no trae el IBAN de la cuenta.': 'The file does not include the account IBAN.',
        'No he encontrado movimientos en el fichero.': 'I found no transactions in the file.', 'No se ha podido importar.': 'It could not be imported.',
        'Banco conectado. Marca la cuenta que quieres leer.': 'Bank connected. Tick the account you want to read.', 'Movimiento guardado': 'Transaction saved',
        // Servidor
        'Alguno de los dos establecimientos no existe.': 'One of the two places does not exist.', 'Contraseña incorrecta.': 'Wrong password.',
        'El IBAN del extracto no es el de ninguna cuenta conectada.': 'The statement IBAN does not match any connected account.', 'El extracto no trae movimientos.': 'The statement has no transactions.',
        'El nombre no puede quedar vacío.': 'The name cannot be empty.', 'Esa cuenta no existe.': 'That account does not exist.', 'Escribe qué buscar.': 'Type what to search for.',
        'Ese establecimiento no existe.': 'That place does not exist.', 'Ese movimiento no es un pago en un comercio.': 'That transaction is not a payment at a merchant.',
        'Ese movimiento no existe.': 'That transaction does not exist.', 'Ese sitio de Google ya no está en memoria: vuelve a buscarlo.': 'That Google place is no longer in memory: search for it again.',
        'Ese sitio no está entre los candidatos.': 'That place is not among the candidates.', 'Ese tipo no vale para este movimiento.': 'That type is not valid for this transaction.',
        'Ese tiquet no existe.': 'That receipt does not exist.', 'Este movimiento no es una compra en un comercio.': 'This transaction is not a purchase at a merchant.',
        'Falta GOOGLE_PLACES_API_KEY: la búsqueda en Google está desactivada.': 'GOOGLE_PLACES_API_KEY is missing: Google search is disabled.',
        'Falta el establecimiento o el sitio.': 'The place or the site is missing.', 'Falta el nombre del establecimiento.': 'The place name is missing.',
        'Hay campos que no se pueden guardar tal como están escritos.': 'Some fields cannot be saved as written.', 'Hay que indicar dos establecimientos distintos.': 'Two different places are needed.',
        'Mi parte tiene que ser un importe positivo.': 'My share must be a positive amount.', 'No existe ese establecimiento.': 'That place does not exist.',
        'No has subido ningún archivo (imagen o PDF)': 'You have not uploaded any file (image or PDF)', 'Ritmo no válido (mensual, trimestral o anual).': 'Invalid frequency (monthly, quarterly or yearly).',
        'Las coordenadas no se entienden. Pégalas como "41.0123, 0.9876".': 'The coordinates cannot be read. Paste them like "41.0123, 0.9876".',
        'El modelo de Gemini está saturado ahora mismo. El tiquet se ha guardado sin procesar y se puede reintentar en unos minutos.': 'The Gemini model is overloaded right now. The receipt was saved unprocessed and can be retried in a few minutes.',
        'Se ha agotado la cuota diaria de la API de Gemini. El tiquet se ha guardado sin procesar; podrás reintentarlo cuando la cuota se renueve.': 'The daily Gemini API quota is used up. The receipt was saved unprocessed; you can retry when the quota renews.',
        'La clave de la API de Gemini no es válida. Revisa GEMINI_API_KEY en el .env. La imagen se ha guardado.': 'The Gemini API key is not valid. Check GEMINI_API_KEY in .env. The image was saved.',
        'Google ha tenido un error interno al procesar la imagen. Es temporal: el tiquet se ha guardado y puedes reintentarlo en un rato.': 'Google had an internal error processing the image. It is temporary: the receipt was saved and you can retry in a while.',
        'Esta autorización no la ha pedido esta aplicación o ha caducado. Vuelve a conectar.': 'This authorisation was not requested by this app or has expired. Connect again.',
        'Estado no válido.': 'Invalid status.',
        'efectivo': 'cash', 'tarjeta': 'card', 'transferencia': 'transfer', 'mixto': 'mixed', 'desconocido': 'unknown',
        'sin tiquet': 'no receipt', 'sin tiquets': 'no receipts', 'Con error': 'With errors', 'Sin hora': 'No time', 'Un solo modelo configurado.': 'Only one model configured.',
        'Quitar línea': 'Remove line', 'Reparto del gasto por categoría': 'Spending by category', 'verificado en Google ·': 'verified on Google ·',
        'Quitar par': 'Remove pair', 'Clave': 'Key', 'Valor': 'Value', 'Producto': 'Product', 'Cantidad': 'Quantity', 'Precio': 'Price',
    };
    // Categorías: se guardan en español; aquí solo se enseñan.
    const CAT = {
        ALIMENTACION: 'GROCERIES', RESTAURACION: 'RESTAURANTS', TRANSPORTE: 'TRANSPORT', OCIO: 'LEISURE', ROPA: 'CLOTHING', HOGAR: 'HOME',
        ELECTRONICA: 'ELECTRONICS', SALUD: 'HEALTH', SUSCRIPCIONES: 'SUBSCRIPTIONS', INGRESOS: 'INCOME', OTROS: 'OTHER', BIZUM: 'BIZUM',
        TRANSFERENCIA: 'TRANSFER', TRANSFERENCIAS: 'TRANSFERS', COMISIONES: 'FEES', EDUCACION: 'EDUCATION', VIAJES: 'TRAVEL',
    };
    for (const [es, en] of Object.entries(CAT)) {
        D[es] = en;
        D[es[0] + es.slice(1).toLowerCase()] = en[0] + en.slice(1).toLowerCase();
    }
    const RE_CAT = new RegExp(`\\b(${Object.keys(CAT).join('|')})\\b`, 'g');

    // Nombres que salen con un número delante ("3 tiquets"): singular y plural.
    const NOMBRES = {
        tiquet: ['receipt', 'receipts'], tiquets: ['receipt', 'receipts'], movimiento: ['transaction', 'transactions'], movimientos: ['transaction', 'transactions'],
        día: ['day', 'days'], días: ['day', 'days'], pago: ['payment', 'payments'], pagos: ['payment', 'payments'], visita: ['visit', 'visits'], visitas: ['visit', 'visits'],
        persona: ['person', 'people'], personas: ['person', 'people'], establecimiento: ['place', 'places'], establecimientos: ['place', 'places'],
        cargo: ['charge', 'charges'], cargos: ['charge', 'charges'], línea: ['line', 'lines'], líneas: ['line', 'lines'], suscripción: ['subscription', 'subscriptions'],
        suscripciones: ['subscription', 'subscriptions'], comida: ['meal', 'meals'], comidas: ['meal', 'meals'], ficha: ['entry', 'entries'], fichas: ['entry', 'entries'],
        sitio: ['place', 'places'], sitios: ['place', 'places'], envío: ['sent', 'sent'], envíos: ['sent', 'sent'], recibido: ['received', 'received'], recibidos: ['received', 'received'],
        ingreso: ['income', 'income'], ingresos: ['income', 'income'], página: ['page', 'pages'], páginas: ['page', 'pages'], documento: ['document', 'documents'],
        documentos: ['document', 'documents'], posible: ['possible', 'possible'], posibles: ['possible', 'possible'], foto: ['photo', 'photos'], fotos: ['photo', 'photos'],
        nuevo: ['new', 'new'], nuevos: ['new', 'new'], 'movimiento nuevo': ['new transaction', 'new transactions'], 'movimientos nuevos': ['new transaction', 'new transactions'],
        restaurante: ['restaurant', 'restaurants'], restaurantes: ['restaurant', 'restaurants'], min: ['min', 'min'], h: ['h', 'h'],
    };
    const RE_NOMBRE = new RegExp(`(^|[^\\p{L}\\d])(\\d[\\d.,]*) (${Object.keys(NOMBRES).sort((a, b) => b.length - a.length).join('|')})(?![\\p{L}])`, 'gu');

    // Reglas para lo que lleva números o nombres dentro (orden: de lo más largo a lo más corto).
    const R = [
        [/^nº (\d+) · (.+?) · subida el (.+)$/, (_, n, e, f) => `no. ${n} · ${tr(e)} · uploaded ${f}`],
        [/^Ficha (\d+) de (\d+)$/, 'Entry $1 of $2'], [/^Leído con (.+)$/, 'Read with $1'], [/^Tiquet (\d+) de (\d+) de esta foto$/, 'Receipt $1 of $2 in this photo'],
        [/^Esta foto contiene (\d+) tiquets:?\.?$/, 'This photo contains $1 receipts'], [/^Esta foto contiene (\d+) tiquets\.$/, 'This photo contains $1 receipts.'],
        [/^(\d+) de (\d+) tiquets$/, '$1 of $2 receipts'], [/^(\d+) de (\d+)$/, '$1 of $2'],
        [/^(\d+) cargos? del banco$/, (_, n) => `${n} bank charge${n === '1' ? '' : 's'}`], [/^(\d+) del banco$/, '$1 from the bank'],
        [/^\((\d+) enviados?, (\d+) recibidos?\)$/, '($1 sent, $2 received)'], [/^(.+) al mes$/, '$1 a month'], [/^(\d+) por revisar$/, '$1 to review'],
        [/^(\d+) \(no son suscripciones\)$/, '$1 (not subscriptions)'], [/^(\d+) por repartir$/, '$1 to split'], [/^(\d+) por confirmar$/, '$1 to confirm'],
        [/^(\d+) de (\d+) · restaurantes de 25 € o más sin repartir$/, '$1 of $2 · restaurants of 25 € or more not split'],
        [/^Cambiarlo también en (.+) de «(.+)»$/, (_, q, c) => `Also change it in ${q === 'el otro pago' ? 'the other payment' : q.replace(/^los otros (\d+) pagos$/, 'the other $1 payments')} of «${c}»`],
        [/^Los (\d+) pagos de «(.+)» pasarán a (.+), también los que vengan\.$/, (_, n, c, a) => `The ${n} payments of «${c}» will move to ${a === 'identificarse solos' ? 'automatic identification' : a}, including future ones.`],
        [/^(.+) de pagos fijos por llegar$/, '$1 in fixed payments still to come'], [/^~(.+) al día$/, '~$1 a day'], [/^llevas (.+)$/, (_, r) => `so far ${tr(r)}`],
        [/^y (\d+) pagos? del banco sin tiquet$/, (_, n) => `and ${n} bank payment${n === '1' ? '' : 's'} without a receipt`],
        [/^Solo (.+) · pulsa otra vez para quitarlo$/, 'Only $1 · press again to remove it'], [/^(.+) sin importe$/, (_, r) => `${tr(r)} without an amount`],
        [/^Google ha encontrado (.+) para este nombre:$/, 'Google found $1 for this name:'], [/^Google ha encontrado (\d+) sitios: ¿cuál es\?$/, 'Google found $1 places: which one is it?'],
        [/^¿Unir (.+) con (.+)\?$/, 'Merge $1 with $2?'], [/^Sus tiquets y cargos pasan a (.+) y (.+) desaparece de la lista\.$/, 'Its receipts and charges move to $1 and $2 disappears from the list.'],
        [/^Unidos: (.+) movidos$/, 'Merged: $1 moved'], [/^La fecha guardada no es válida:(.*)$/, 'The saved date is not valid:$1'],
        [/^Esta foto contiene (.+); se volverán a analizar$/, 'This photo contains $1; they will all be analysed again'], [/^los (\d+)\.$/, 'all $1.'],
        [/^(.+) La foto no se toca\.$/, (_, r) => `${tr(r)} The photo is not touched.`], [/^(\d+) encontrados en esa foto$/, '$1 found in that photo'],
        [/^(\d+) detectados( en la foto)?$/, (_, n, f) => `${n} detected${f ? ' in the photo' : ''}`], [/^\(ficha (\d+)\)…$/, '(entry $1)…'],
        [/^Han aparecido (.+) más de fotos con varios\.$/, '$1 more came from photos with several.'], [/^(.+) no contenía\(n\) ningún tiquet reconocible\.$/, '$1 contained no recognisable receipt.'],
        [/^¿Borrar el tiquet (.+)\?$/, 'Delete receipt $1?'], [/^La foto NO se borra: la comparten (.+) más de la misma imagen\.$/, 'The photo is NOT deleted: $1 more share the same image.'],
        [/^(.+): el permiso ha caducado\. Vuelve a conectar\.$/, '$1: consent has expired. Connect again.'], [/^\(quedan (\d+) días\)$/, '($1 days left)'],
        [/^\(hace (\d+) (min|h|días?)\)$/, (_, n, u) => `(${n} ${u.startsWith('d') ? (n === '1' ? 'day' : 'days') : u} ago)`],
        [/^hace (\d+) (min|h|días?)$/, (_, n, u) => `${n} ${u.startsWith('d') ? (n === '1' ? 'day' : 'days') : u} ago`],
        [/^\(cada (\d+) h\)$/, '(every $1 h)'], [/^No se ha podido conectar \((.+)\)\.$/, 'It could not connect ($1).'],
        [/^El banco no deja consultar más ahora; prueba (.+)\.$/, (_, c) => `The bank does not allow more requests now; try ${tr(c)}.`],
        [/^No entiendo esta línea del extracto: «(.+)»$/, 'I do not understand this statement line: «$1»'],
        [/^El saldo no cuadra el (.+) \((.+)\): falta o sobra algún apunte\.$/, 'The balance does not add up on $1 ($2): an entry is missing or extra.'],
        [/^Convertido: (.+) del (.+) al (.+), con todos los saldos cuadrados\.$/, (_, n, a, b) => `Converted: ${tr(n)} from ${a} to ${b}, with every balance adding up.`],
        [/^Importando (.+)…$/, (_, n) => `Importing ${tr(n)}…`], [/^Importado: (.+?)(, .+)?\.$/, (_, n, r) => `Imported: ${tr(n)}${r ? r.replace(/(\d+) ya estaban por la conexión/, '$1 already there from the connection').replace(/(\d+) ya importados antes/, '$1 imported before') : ''}.`],
        [/^(\d+) tiquets analizados$/, '$1 receipts analysed'], [/^Primera de (\d+) páginas\.$/, 'First of $1 pages.'],
        [/^No se ha podido pintar el PDF \((.+)\)\. Ábrelo aparte\.$/, 'The PDF could not be drawn ($1). Open it separately.'],
        [/^Hubo reintentos por el camino \((.+)\)$/, 'There were retries along the way ($1)'], [/^y acabó leyéndolo (.+)\.$/, 'and $1 finally read it.'],
        [/^Se ha guardado como ficha (.+) \((.+)\): el archivo no se pierde y se puede volver a analizar\.$/, 'Saved as entry $1 ($2): the file is not lost and can be analysed again.'],
        [/^(.+) · (\d+) movimientos · al día: (.+)$/, (_, c, n, f) => `${c} · ${n} transactions · up to date: ${f}`], [/^al día: (.+)$/, 'up to date: $1'],
        [/^(.+) · permiso hasta el (.+)$/, '$1 · consent until $2'], [/^próximo: (.+)$/, 'next: $1'], [/^de (.+) entre (\d+)$/, 'of $1 split $2 ways'],
        [/^entre (\d+)( · tu parte (.+))?$/, (_, n, x, p) => `split ${n} ways${p ? ` · your share ${p}` : ''}`],
        [/^(ayer|hoy|mañana) a las (.+)$/, (_, d, h) => `${{ ayer: 'yesterday', hoy: 'today', mañana: 'tomorrow' }[d]} at ${h}`], [/^el (.+) a las (.+)$/, 'on $1 at $2'],
        [/^sin enlazar · (\d+) posibles?$/, (_, n) => `not linked · ${n} possible`], [/^Pagado entre (\d+)$/, 'Split $1 ways'],
        [/^(\d+) sin importe$/, '$1 without an amount'], [/^(.+) · sin tiquets$/, (_, r) => `${tr(r)} · no receipts`],
        [/^tarjeta (\*+\d+)$/, 'card $1'], [/^TARJETA (\*+\d+)$/, 'CARD $1'],
        [/^Uno nuevo; se buscará en el mapa solo$/, 'A new one; it will be located on the map automatically'], [/^Crear «(.+)»$/, 'Create «$1»'], [/^\+ Crear «(.+)»$/, '+ Create «$1»'],
    ];

    /** Traduce un texto (sin espacios alrededor). Devuelve el mismo si no sabe. */
    function tr(s) {
        if (!s || !/\p{L}/u.test(s)) return s;
        if (Object.prototype.hasOwnProperty.call(D, s)) return D[s];
        for (const [re, rep] of R) if (re.test(s)) { re.lastIndex = 0; return s.replace(re, rep); }
        if (s.startsWith('· ')) return '· ' + tr(s.slice(2));
        if (s.endsWith(' ·')) return tr(s.slice(0, -2)) + ' ·';
        if (s.includes(' · ')) {
            const partes = s.split(' · ');
            const t = partes.map(p => tr(p.trim()));
            if (t.some((x, i) => x !== partes[i].trim())) return t.join(' · ');
        }
        let r = s.replace(RE_NOMBRE, (_, a, n, w) => {
            const [uno, varios] = NOMBRES[w]; const num = Number(n.replace(/\./g, '').replace(',', '.'));
            return `${a}${n} ${num === 1 ? uno : varios}`;
        });
        r = r.replace(RE_CAT, m => CAT[m]);
        return r;
    }
    window.traducir = tr;

    // --- Aplicarlo a la página, y a todo lo que se pinte después ------------------
    const puesto = new WeakMap();           // nodo -> último texto que le puso esta capa
    const ATRIBUTOS = ['placeholder', 'title', 'aria-label', 'alt'];
    const enTexto = (n) => {
        const p = n.parentNode;
        if (!p || p.nodeName === 'SCRIPT' || p.nodeName === 'STYLE' || p.nodeName === 'TEXTAREA') return;
        if (puesto.get(n) === n.data) return;
        const bruto = n.data, limpio = bruto.trim();
        if (!limpio) return;
        const t = tr(limpio);
        if (t !== limpio) { const nuevo = bruto.replace(limpio, t); puesto.set(n, nuevo); n.data = nuevo; }
        else puesto.set(n, bruto);
    };
    const enElemento = (el) => {
        for (const a of ATRIBUTOS) {
            const v = el.getAttribute && el.getAttribute(a);
            if (!v) continue;
            const t = tr(v.trim());
            if (t !== v.trim()) el.setAttribute(a, t);
        }
        if (el.nodeName === 'INPUT' && (el.type === 'button' || el.type === 'submit') && el.value) el.value = tr(el.value);
    };
    const recorrer = (raiz) => {
        if (raiz.nodeType === 3) { enTexto(raiz); return; }
        if (raiz.nodeType !== 1 && raiz.nodeType !== 9 && raiz.nodeType !== 11) return;
        if (raiz.nodeType === 1) enElemento(raiz);
        const w = document.createTreeWalker(raiz, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
        let n;
        while ((n = w.nextNode())) { if (n.nodeType === 3) enTexto(n); else enElemento(n); }
    };
    const arrancar = () => {
        recorrer(document.body);
        if (document.title) document.title = tr(document.title);
        new MutationObserver((cambios) => {
            for (const c of cambios) {
                if (c.type === 'characterData') enTexto(c.target);
                else if (c.type === 'attributes') enElemento(c.target);
                else for (const n of c.addedNodes) recorrer(n);
            }
        }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATRIBUTOS });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', arrancar);
    else arrancar();
})();
