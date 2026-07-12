/**
 * Estudio Jurídico - Apps Script de la Base Central de Casos (v1.2)
 * ==================================================================
 * Pegar en: la Sheet "Estudio Juridico - Base Central de Casos v1.2"
 *           → Extensiones → Apps Script → Code.gs
 * Agregar también el archivo HTML: (+) → HTML → nombre "dashboard" → pegar dashboard.html
 *
 * Qué hace:
 *  1. Menú "⚖️ Estudio Jurídico" con panel de KPIs, recálculo de dashboard y envío a Etapa B.
 *  2. Trigger onEdit (instalable) sobre la hoja Casos:
 *     - estado → "A oficiar"  : dispara el webhook de la Etapa B en n8n con el caso_id.
 *     - estado → decisión del Senior (Demandar / Pedir más prueba / Descartar):
 *       exige motivo_decision (pinta la celda si falta) y autocompleta fecha_decision.
 *     - cualquier cambio de estado actualiza ultima_actividad.
 *  3. getKpis(): datos para el panel HTML (también publicable como Web App con doGet).
 *
 * IMPORTANTE: ejecutar una vez "instalarTriggers" desde el menú (o desde el editor)
 * y aceptar los permisos. El onEdit simple de Google NO puede llamar webhooks;
 * por eso se usa un trigger instalable.
 */

var CONFIG = {
  WEBHOOK_ETAPA_B: 'https://eeliuss.app.n8n.cloud/webhook/etapa-b-nuevo-caso',
  HOJA_CASOS: 'Casos',
  HOJA_OFICIOS: 'Oficios',
  HOJA_DASHBOARD: 'Dashboard_Portafolio',
  HOJA_ERRORES: 'Errores',
  ESTADOS_DECISION: ['Demandar', 'Pedir más prueba', 'Descartar'],
  ESTADOS_DISPARAN_ETAPA_B: ['A oficiar'],
  OFICIOS_PENDIENTES: ['Enviado', 'Reiterado 1', 'Reiterado 2'],
  OFICIOS_RESPONDIDOS: ['Respondida', 'Respondida parcial', 'Rechazo solicitud'],
  UMBRAL_DIAS_EN_DECISION: 10,
  COLOR_FALTA_MOTIVO: '#f4cccc',
};

// ------------------------------------------------------------------ menú

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('⚖️ Estudio Jurídico')
    .addItem('📊 Abrir panel de KPIs', 'abrirPanelKpis')
    .addItem('🔄 Recalcular Dashboard_Portafolio', 'recalcularDashboard')
    .addItem('📨 Enviar caso de la fila actual a Etapa B', 'enviarFilaActualAEtapaB')
    .addSeparator()
    .addItem('⚙️ Instalar triggers (ejecutar una sola vez)', 'instalarTriggers')
    .addToUi();
}

function abrirPanelKpis() {
  var html = HtmlService.createHtmlOutputFromFile('dashboard')
    .setWidth(1100)
    .setHeight(720);
  SpreadsheetApp.getUi().showModalDialog(html, 'KPIs del Estudio');
}

/** Permite publicar el panel como Web App (Implementar → Nueva implementación → Aplicación web). */
function doGet() {
  return HtmlService.createHtmlOutputFromFile('dashboard')
    .setTitle('Estudio Jurídico - KPIs')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// ------------------------------------------------------------------ triggers

function instalarTriggers() {
  // elimina triggers previos de este handler para no duplicar
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'alEditarCasos') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('alEditarCasos')
    .forSpreadsheet(SpreadsheetApp.getActive())
    .onEdit()
    .create();
  SpreadsheetApp.getActive().toast('Trigger onEdit instalado sobre la hoja Casos.', '⚖️ Estudio Jurídico', 5);
}

/** Trigger instalable: reacciona a ediciones manuales en la hoja Casos. */
function alEditarCasos(e) {
  try {
    var hoja = e.range.getSheet();
    if (hoja.getName() !== CONFIG.HOJA_CASOS) return;
    var fila = e.range.getRow();
    if (fila < 2 || e.range.getNumRows() > 1) return; // solo ediciones de una fila de datos

    var headers = hoja.getRange(1, 1, 1, hoja.getLastColumn()).getValues()[0];
    var col = function (nombre) { return headers.indexOf(nombre) + 1; }; // 1-indexado, 0 = no existe
    var colEditada = e.range.getColumn();
    var casoId = col('caso_id') ? String(hoja.getRange(fila, col('caso_id')).getValue()) : '';

    // --- se editó el estado del caso ---
    if (col('estado') && colEditada === col('estado')) {
      var nuevoEstado = String(e.value || e.range.getValue() || '').trim();

      if (col('ultima_actividad')) {
        hoja.getRange(fila, col('ultima_actividad')).setValue(new Date().toISOString());
      }

      // decisión del Senior: motivo obligatorio + fecha automática
      if (CONFIG.ESTADOS_DECISION.indexOf(nuevoEstado) !== -1) {
        if (col('fecha_decision')) {
          hoja.getRange(fila, col('fecha_decision')).setValue(new Date().toISOString());
        }
        if (col('motivo_decision')) {
          var celdaMotivo = hoja.getRange(fila, col('motivo_decision'));
          if (!String(celdaMotivo.getValue()).trim()) {
            celdaMotivo.setBackground(CONFIG.COLOR_FALTA_MOTIVO)
              .setNote('Motivo obligatorio: la decisión "' + nuevoEstado + '" requiere completar motivo_decision.');
            SpreadsheetApp.getActive().toast(
              'Caso ' + casoId + ': completá motivo_decision (obligatorio para "' + nuevoEstado + '").',
              '⚠️ Falta motivo', 8);
          }
        }
      }

      // disparo manual de la Etapa B
      if (CONFIG.ESTADOS_DISPARAN_ETAPA_B.indexOf(nuevoEstado) !== -1 && casoId) {
        enviarCasoAEtapaB(casoId);
      }
      return;
    }

    // --- se completó el motivo: limpiar la marca roja ---
    if (col('motivo_decision') && colEditada === col('motivo_decision')) {
      if (String(e.range.getValue()).trim()) {
        e.range.setBackground(null).setNote('');
      }
      return;
    }
  } catch (err) {
    registrarError('alEditarCasos', err.message);
  }
}

// ------------------------------------------------------------------ Etapa B

function enviarCasoAEtapaB(casoId) {
  try {
    var resp = UrlFetchApp.fetch(CONFIG.WEBHOOK_ETAPA_B, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ caso_id: casoId, modo: 'oficiamiento' }),
      muteHttpExceptions: true,
    });
    var ok = resp.getResponseCode() >= 200 && resp.getResponseCode() < 300;
    SpreadsheetApp.getActive().toast(
      ok ? 'Caso ' + casoId + ' enviado a Etapa B (oficios).'
         : 'Etapa B respondió HTTP ' + resp.getResponseCode() + ' — revisar que el workflow esté Activo.',
      ok ? '📨 Etapa B' : '⚠️ Etapa B', 8);
    if (!ok) registrarError('enviarCasoAEtapaB', 'HTTP ' + resp.getResponseCode() + ' para caso ' + casoId);
  } catch (err) {
    registrarError('enviarCasoAEtapaB', err.message + ' (caso ' + casoId + ')');
    SpreadsheetApp.getActive().toast('No se pudo llamar a Etapa B: ' + err.message, '⚠️ Etapa B', 8);
  }
}

/** Desde el menú: envía a Etapa B el caso de la fila seleccionada en Casos. */
function enviarFilaActualAEtapaB() {
  var hoja = SpreadsheetApp.getActiveSheet();
  if (hoja.getName() !== CONFIG.HOJA_CASOS) {
    SpreadsheetApp.getUi().alert('Pará en una fila de la hoja "Casos" primero.');
    return;
  }
  var fila = hoja.getActiveRange().getRow();
  var headers = hoja.getRange(1, 1, 1, hoja.getLastColumn()).getValues()[0];
  var idx = headers.indexOf('caso_id');
  var casoId = idx >= 0 ? String(hoja.getRange(fila, idx + 1).getValue()) : '';
  if (fila < 2 || !casoId) {
    SpreadsheetApp.getUi().alert('La fila seleccionada no tiene caso_id.');
    return;
  }
  enviarCasoAEtapaB(casoId);
}

// ------------------------------------------------------------------ KPIs

/** Lee una hoja como array de objetos {header: valor}, ignorando filas vacías. */
function leerHoja(nombre) {
  var hoja = SpreadsheetApp.getActive().getSheetByName(nombre);
  if (!hoja || hoja.getLastRow() < 2) return [];
  var valores = hoja.getRange(1, 1, hoja.getLastRow(), hoja.getLastColumn()).getValues();
  var headers = valores[0];
  return valores.slice(1)
    .filter(function (f) { return f.some(function (v) { return v !== '' && v !== null; }); })
    .map(function (f) {
      var o = {};
      headers.forEach(function (h, i) { if (h) o[h] = f[i]; });
      return o;
    });
}

function aDias(valor) {
  var t = new Date(valor).getTime();
  return isNaN(t) ? null : (Date.now() - t) / 86400000;
}

/** KPIs para el panel HTML. Devuelve un objeto JSON-serializable. */
function getKpis() {
  var casos = leerHoja(CONFIG.HOJA_CASOS).filter(function (c) { return c.caso_id; });
  var oficios = leerHoja(CONFIG.HOJA_OFICIOS).filter(function (o) { return o.oficio_id || o.caso_id; });

  // casos por estado
  var porEstado = {};
  casos.forEach(function (c) {
    var e = String(c.estado || '(sin estado)');
    porEstado[e] = (porEstado[e] || 0) + 1;
  });
  var casosPorEstado = Object.keys(porEstado)
    .map(function (e) { return { estado: e, cantidad: porEstado[e] }; })
    .sort(function (a, b) { return b.cantidad - a.cantidad; });

  var nuevos7 = casos.filter(function (c) { var d = aDias(c.fecha_captura); return d !== null && d <= 7; }).length;
  var nuevos30 = casos.filter(function (c) { var d = aDias(c.fecha_captura); return d !== null && d <= 30; }).length;

  // oficios
  var porEstadoOficio = {};
  oficios.forEach(function (o) {
    var e = String(o.estado || '(sin estado)');
    porEstadoOficio[e] = (porEstadoOficio[e] || 0) + 1;
  });
  var pendientes = oficios.filter(function (o) { return CONFIG.OFICIOS_PENDIENTES.indexOf(o.estado) !== -1; });
  var respondidos = oficios.filter(function (o) { return CONFIG.OFICIOS_RESPONDIDOS.indexOf(o.estado) !== -1; }).length;
  var vencidos = oficios.filter(function (o) { return o.estado === 'Vencido sin respuesta'; }).length;
  var antiguedades = pendientes.map(function (o) { return aDias(o.fecha_ultimo_envio); })
    .filter(function (d) { return d !== null; });
  var antiguedadProm = antiguedades.length
    ? Math.round(antiguedades.reduce(function (a, b) { return a + b; }, 0) / antiguedades.length * 10) / 10
    : 0;

  // casos estancados en decisión
  var estancados = casos.filter(function (c) {
    if (c.estado !== 'En decisión') return false;
    var d = aDias(c.fecha_captura);
    return d !== null && d > CONFIG.UMBRAL_DIAS_EN_DECISION;
  }).map(function (c) {
    return { caso_id: String(c.caso_id), cliente: String(c.nombre_apellido_cliente || ''), dias: Math.floor(aDias(c.fecha_captura)) };
  });

  return {
    generado: new Date().toISOString(),
    casos: { total: casos.length, nuevos7: nuevos7, nuevos30: nuevos30, porEstado: casosPorEstado },
    oficios: {
      total: oficios.length,
      pendientes: pendientes.length,
      respondidos: respondidos,
      vencidos: vencidos,
      pctRespondidos: oficios.length ? Math.round(respondidos / oficios.length * 100) : 0,
      antiguedadPromPendientes: antiguedadProm,
      porEstado: Object.keys(porEstadoOficio).map(function (e) { return { estado: e, cantidad: porEstadoOficio[e] }; })
        .sort(function (a, b) { return b.cantidad - a.cantidad; }),
    },
    estancados: estancados,
    umbralEstancados: CONFIG.UMBRAL_DIAS_EN_DECISION,
  };
}

// ------------------------------------------------------------------ dashboard en la Sheet

/** Reescribe la hoja Dashboard_Portafolio con los mismos agregados que calcula la Etapa C. */
function recalcularDashboard() {
  var k = getKpis();
  var hoja = SpreadsheetApp.getActive().getSheetByName(CONFIG.HOJA_DASHBOARD)
    || SpreadsheetApp.getActive().insertSheet(CONFIG.HOJA_DASHBOARD);

  var casos = leerHoja(CONFIG.HOJA_CASOS).filter(function (c) { return c.caso_id; });
  var oficios = leerHoja(CONFIG.HOJA_OFICIOS).filter(function (o) { return o.oficio_id || o.caso_id; });
  var estadoPorCaso = {};
  casos.forEach(function (c) { estadoPorCaso[c.caso_id] = String(c.estado || '(sin estado)'); });

  var filas = k.casos.porEstado.map(function (f) {
    return [
      f.estado,
      f.cantidad,
      oficios.filter(function (o) { return estadoPorCaso[o.caso_id] === f.estado && CONFIG.OFICIOS_PENDIENTES.indexOf(o.estado) !== -1; }).length,
      oficios.filter(function (o) { return estadoPorCaso[o.caso_id] === f.estado && o.estado === 'Vencido sin respuesta'; }).length,
      k.oficios.pctRespondidos,
      k.generado,
    ];
  });
  filas.push(['TOTAL (portafolio)', k.casos.total, k.oficios.pendientes, k.oficios.vencidos, k.oficios.pctRespondidos, k.generado]);

  hoja.clearContents();
  hoja.getRange(1, 1, 1, 6).setValues([['estado', 'cantidad_casos', 'oficios_pendientes', 'oficios_vencidos', 'pct_respondidos_global', 'actualizado_el']]);
  if (filas.length) hoja.getRange(2, 1, filas.length, 6).setValues(filas);
  SpreadsheetApp.getActive().toast('Dashboard_Portafolio recalculado (' + filas.length + ' filas).', '📊 Dashboard', 5);
}

// ------------------------------------------------------------------ errores

function registrarError(donde, mensaje) {
  try {
    var hoja = SpreadsheetApp.getActive().getSheetByName(CONFIG.HOJA_ERRORES);
    if (!hoja) return;
    hoja.appendRow([new Date().toISOString(), 'AppsScript', donde, '', mensaje]);
  } catch (e) { /* último recurso: no romper la edición del usuario */ }
}
