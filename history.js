/* ============================================================
 * 处理日志 history.js
 * 职责：记录每一次图像处理（降噪 / 编辑 / 批量 / 导入）的完整参数与耗时，
 *      支持按类型与状态筛选、关键词搜索、统计汇总、CSV 导出
 * 存储：IndexedDB，库名 prismden_logs，对象仓 logs
 * ============================================================ */
(function () {
  'use strict';

  var DB_NAME = 'prismden_logs';
  var DB_VERSION = 1;
  var STORE = 'logs';
  var db = null;
  var cache = [];          // 内存缓存（时间倒序）
  var filterType = 'all';
  var filterStatus = 'all';
  var keyword = '';

  var el = {};

  /** 取翻译文本，支持 {占位符} 替换 */
  function tr(key, vars) {
    if (window.i18n && typeof window.i18n.t === 'function') return window.i18n.t(key, vars);
    return key;
  }

  function toast(msg, type) {
    if (typeof window.showToast === 'function') window.showToast(msg, type || 'info');
  }

  /* ────────── IndexedDB ────────── */

  function openDB() {
    if (db) return Promise.resolve(db);
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function (e) {
        var d = e.target.result;
        if (!d.objectStoreNames.contains(STORE)) {
          var store = d.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex('createdAt', 'createdAt');
          store.createIndex('type', 'type');
          store.createIndex('status', 'status');
        }
      };
      req.onsuccess = function (e) { db = e.target.result; resolve(db); };
      req.onerror = function (e) { reject(e.target.error); };
    });
  }

  function dbPut(record) {
    return openDB().then(function (d) {
      return new Promise(function (resolve, reject) {
        var tx = d.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(record);
        tx.oncomplete = function () { resolve(record); };
        tx.onerror = function (e) { reject(e.target.error); };
      });
    });
  }

  function dbGetAll() {
    return openDB().then(function (d) {
      return new Promise(function (resolve, reject) {
        var tx = d.transaction(STORE, 'readonly');
        var req = tx.objectStore(STORE).getAll();
        req.onsuccess = function () { resolve(req.result || []); };
        req.onerror = function (e) { reject(e.target.error); };
      });
    });
  }

  function dbClear() {
    return openDB().then(function (d) {
      return new Promise(function (resolve, reject) {
        var tx = d.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).clear();
        tx.oncomplete = resolve;
        tx.onerror = function (e) { reject(e.target.error); };
      });
    });
  }

  function dbDelete(id) {
    return openDB().then(function (d) {
      return new Promise(function (resolve, reject) {
        var tx = d.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(id);
        tx.oncomplete = resolve;
        tx.onerror = function (e) { reject(e.target.error); };
      });
    });
  }

  /* ────────── 写入日志 ────────── */

  /**
   * 记录一条处理日志
   * @param {Object} info { type, name, params, width, height, elapsed, status, error, thumb }
   */
  function addLog(info) {
    info = info || {};
    var record = {
      id: 'L' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      type: info.type || 'other',          // denoise | edit | batch | import | other
      name: info.name || '未命名',
      params: info.params || {},
      width: info.width || 0,
      height: info.height || 0,
      elapsed: info.elapsed || 0,
      status: info.status || 'success',    // success | error
      error: info.error || '',
      thumb: info.thumb || '',
      createdAt: Date.now()
    };
    cache.unshift(record);
    return dbPut(record).catch(function (e) {
      console.warn('[history] 写入失败', e);
    });
  }

  /* ────────── 查询 ────────── */

  function refresh() {
    return dbGetAll().then(function (rows) {
      cache = rows.sort(function (a, b) { return b.createdAt - a.createdAt; });
      render();
    }).catch(function () {
      render();
    });
  }

  function filtered() {
    var kw = keyword.trim().toLowerCase();
    return cache.filter(function (r) {
      if (filterType !== 'all' && r.type !== filterType) return false;
      if (filterStatus !== 'all' && r.status !== filterStatus) return false;
      if (kw) {
        var hay = (r.name + ' ' + r.type + ' ' + JSON.stringify(r.params || {})).toLowerCase();
        if (hay.indexOf(kw) === -1) return false;
      }
      return true;
    });
  }

  /* ────────── 渲染 ────────── */

  /* 类型文案：每次渲染时现取，保证跟随当前语言 */
  var TYPE_KEY = {
    denoise: 'logTypeDenoise', edit: 'logTypeEdit', batch: 'logTypeBatch',
    import: 'logTypeImport', other: 'logTypeOther'
  };

  function typeText(type) {
    return tr(TYPE_KEY[type] || 'logTypeOther');
  }

  function fmtDateTime(ts) {
    var d = new Date(ts);
    function p(n) { return n < 10 ? '0' + n : '' + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function fmtParams(params) {
    if (!params) return tr('logParamsNone');
    var parts = [];
    Object.keys(params).forEach(function (k) {
      var v = params[k];
      if (v === '' || v === null || typeof v === 'undefined') return;
      parts.push(k + '=' + v);
    });
    return parts.length ? parts.join(' · ') : tr('logParamsNone');
  }

  function render() {
    if (!el.list) return;

    var rows = filtered();
    el.list.innerHTML = '';

    if (!rows.length) {
      el.empty.classList.remove('hidden');
    } else {
      el.empty.classList.add('hidden');
    }

    rows.forEach(function (r) {
      var item = document.createElement('div');
      item.className = 'log-item status-' + r.status;
      item.setAttribute('data-id', r.id);

      var thumbHtml = r.thumb
        ? '<img src="' + r.thumb + '" alt="" />'
        : '<div class="log-thumb-ph">' + tr('logNoThumb') + '</div>';

      item.innerHTML =
        '<div class="log-thumb">' + thumbHtml + '</div>' +
        '<div class="log-main">' +
          '<div class="log-line1">' +
            '<span class="log-type">' + typeText(r.type) + '</span>' +
            '<span class="log-name" title="' + r.name + '">' + r.name + '</span>' +
            '<span class="log-status">' + (r.status === 'success' ? tr('logStatusSuccess') : tr('logStatusError')) + '</span>' +
          '</div>' +
          '<div class="log-line2">' +
            '<span>' + fmtDateTime(r.createdAt) + '</span>' +
            (r.width ? '<span>' + r.width + '×' + r.height + '</span>' : '') +
            (r.elapsed ? '<span>' + tr('logElapsed', { ms: r.elapsed }) + '</span>' : '') +
          '</div>' +
          '<div class="log-line3">' + fmtParams(r.params) +
            (r.error ? ' <span class="log-err">（' + r.error + '）</span>' : '') +
          '</div>' +
        '</div>' +
        '<button class="log-del" title="' + tr('logDelTitle') + '">×</button>';

      item.querySelector('.log-del').addEventListener('click', function (e) {
        e.stopPropagation();
        dbDelete(r.id).then(function () {
          cache = cache.filter(function (x) { return x.id !== r.id; });
          render();
        });
      });

      el.list.appendChild(item);
    });

    renderStats();
  }

  function renderStats() {
    if (!el.stats) return;
    var total = cache.length;
    var ok = cache.filter(function (r) { return r.status === 'success'; }).length;
    var err = total - ok;
    var times = cache.filter(function (r) { return r.elapsed > 0; }).map(function (r) { return r.elapsed; });
    var avg = times.length ? Math.round(times.reduce(function (a, b) { return a + b; }, 0) / times.length) : 0;
    var pixels = cache.reduce(function (s, r) { return s + (r.width && r.height ? r.width * r.height : 0); }, 0);

    el.stats.innerHTML =
      '<div class="log-stat"><span class="log-stat-num">' + total + '</span><span>' + tr('logStatTotal') + '</span></div>' +
      '<div class="log-stat ok"><span class="log-stat-num">' + ok + '</span><span>' + tr('logStatSuccess') + '</span></div>' +
      '<div class="log-stat err"><span class="log-stat-num">' + err + '</span><span>' + tr('logStatFailed') + '</span></div>' +
      '<div class="log-stat"><span class="log-stat-num">' + avg + '<i>ms</i></span><span>' + tr('logStatAvg') + '</span></div>' +
      '<div class="log-stat"><span class="log-stat-num">' + (pixels / 1e6).toFixed(1) + '<i>MP</i></span><span>' + tr('logStatPixels') + '</span></div>';
  }

  /* ────────── CSV 导出 ────────── */

  function exportCSV() {
    var rows = filtered();
    if (!rows.length) {
      toast(tr('logExportEmpty'), 'error');
      return;
    }

    function esc(v) {
      var s = String(v === null || v === undefined ? '' : v);
      return '"' + s.replace(/"/g, '""') + '"';
    }

    var head = [
      tr('logCsvNo'), tr('logCsvTime'), tr('logCsvType'), tr('logCsvName'), tr('logCsvStatus'),
      tr('logCsvElapsed'), tr('logCsvWidth'), tr('logCsvHeight'), tr('logCsvParams'), tr('logCsvError')
    ];
    var lines = [head.map(esc).join(',')];

    rows.forEach(function (r, i) {
      lines.push([
        i + 1,
        fmtDateTime(r.createdAt),
        typeText(r.type),
        r.name,
        r.status === 'success' ? tr('logStatusSuccess') : tr('logStatusError'),
        r.elapsed || 0,
        r.width || '',
        r.height || '',
        fmtParams(r.params),
        r.error || ''
      ].map(esc).join(','));
    });

    // 加 BOM，避免 Excel 打开中文乱码
    var csv = '\uFEFF' + lines.join('\r\n');
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'PrismDen_处理日志_' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);

    toast(tr('logExported', { n: rows.length }), 'success');
  }

  /* ────────── 初始化 ────────── */

  function init() {
    el = {
      list: document.getElementById('logList'),
      empty: document.getElementById('logEmpty'),
      stats: document.getElementById('logStats'),
      search: document.getElementById('logSearch'),
      typeTabs: document.getElementById('logTypeTabs'),
      statusTabs: document.getElementById('logStatusTabs'),
      btnExport: document.getElementById('logExportBtn'),
      btnClear: document.getElementById('logClearBtn'),
      btnRefresh: document.getElementById('logRefreshBtn')
    };

    if (!el.list) return;

    if (el.search) {
      el.search.addEventListener('input', function () {
        keyword = el.search.value;
        render();
      });
    }

    function bindTabs(container, onPick) {
      if (!container) return;
      container.addEventListener('click', function (e) {
        var btn = e.target.closest('.log-tab');
        if (!btn) return;
        Array.prototype.forEach.call(container.querySelectorAll('.log-tab'), function (b) {
          b.classList.remove('active');
        });
        btn.classList.add('active');
        onPick(btn.getAttribute('data-value'));
        render();
      });
    }

    bindTabs(el.typeTabs, function (v) { filterType = v; });
    bindTabs(el.statusTabs, function (v) { filterStatus = v; });

    if (el.btnExport) el.btnExport.addEventListener('click', exportCSV);
    if (el.btnRefresh) el.btnRefresh.addEventListener('click', function () { refresh(); });

    if (el.btnClear) {
      el.btnClear.addEventListener('click', function () {
        if (!cache.length) return;
        if (!window.confirm(tr('logClearConfirm', { n: cache.length }))) return;
        dbClear().then(function () {
          cache = [];
          render();
          toast(tr('logCleared'), 'info');
        });
      });
    }

    refresh();

    // 语言切换后重渲染日志列表与统计
    (window._langChangeHooks = window._langChangeHooks || []).push(function () { render(); });
  }

  /* 对外 API：其他模块调用 add() 写日志 */
  window.PrismDenLog = {
    add: addLog,
    count: function () { return cache.length; },
    refresh: refresh
  };

  window.onHistoryPageEnter = function () { refresh(); };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
