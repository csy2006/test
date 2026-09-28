/*
 * PrismDen 棱镜降噪图像处理系统 V1.0
 * 主程序：双边滤波降噪核心算法、Web Worker 分块调度、文件导入、参数控制、结果输出与对比
 * 著作权人：Young__Yang
 * 完成日期：2026-09-28
 * 权利取得方式：原始取得  权利范围：全部权利
 */


let _denoiseWorker = null;
let _denoiseWorkerBlobURL = null;
let _denoiseMsgId = 0;

var _vibrateEnabled = true;
try {
  var _savedVP = localStorage.getItem('prismden_vibrate');
  if (_savedVP === '0') _vibrateEnabled = false;
} catch(e) {}

var _isTouchDevice = (function() {
  if (typeof navigator === 'undefined') return false;

  if ('ontouchstart' in window) return true;

  if (navigator.maxTouchPoints && navigator.maxTouchPoints > 0) return true;

  if (navigator.msMaxTouchPoints && navigator.msMaxTouchPoints > 0) return true;

  try {
    if (window.matchMedia && window.matchMedia('(hover: none)').matches) return true;
  } catch(e) {}
  return false;
})();

function vibrate(pattern) {
  if (!_vibrateEnabled) return;
  if (!_isTouchDevice) return;
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return;
  try { navigator.vibrate(pattern); } catch(e) {}
}

/* 降噪 Worker：内联双边滤波内核，接收分块像素数据并返回处理结果，避免阻塞主线程 */
function getDenoiseWorker() {
  if (!_denoiseWorker) {

    const workerCode = `
      function gaussianLUT(sigma) {
        const lut = new Float32Array(256);
        const denom = 2 * sigma * sigma;
        for (let d = 0; d < 256; d++) { lut[d] = Math.exp(-(d * d) / denom); }
        return lut;
      }
      function buildSpatialKernel(radius, sigma) {
        const size = 2 * radius + 1;
        const kernel = new Float32Array(size * size);
        const denom = 2 * sigma * sigma;
        let ki = 0;
        for (let dy = -radius; dy <= radius; dy++) {
          for (let dx = -radius; dx <= radius; dx++) {
            kernel[ki++] = Math.exp(-(dx * dx + dy * dy) / denom);
          }
        }
        return { kernel, size, radius };
      }
      function bilateralColor(src, dst, w, h, radius, size, kernel, rLUT) {
        const wh = w * h;
        for (let idx = 0; idx < wh; idx++) {
          const x = idx % w; const y = (idx / w) | 0;
          const ci = idx * 4;
          const cr = src[ci], cg = src[ci + 1], cb = src[ci + 2];
          let sumR = 0, sumG = 0, sumB = 0, sumW = 0;
          const kyMin = Math.max(0, y - radius);
          const kyMax = Math.min(h - 1, y + radius);
          const kxMin = Math.max(0, x - radius);
          const kxMax = Math.min(w - 1, x + radius);
          for (let ky = kyMin; ky <= kyMax; ky++) {
            const rowOff = ky * w * 4;
            const kyOff = (ky - y + radius) * size;
            for (let kx = kxMin; kx <= kxMax; kx++) {
              const si = rowOff + kx * 4;
              const sr = src[si], sg = src[si + 1], sb = src[si + 2];
              let d = cr - sr; if (d < 0) d = -d;
              let rw = rLUT[d];
              d = cg - sg; if (d < 0) d = -d;
              rw *= rLUT[d];
              d = cb - sb; if (d < 0) d = -d;
              rw *= rLUT[d];
              const wgt = kernel[kyOff + (kx - x + radius)] * rw;
              sumR += sr * wgt; sumG += sg * wgt; sumB += sb * wgt; sumW += wgt;
            }
          }
          const invW = sumW > 0 ? 1 / sumW : 0;
          dst[ci] = sumW > 0 ? sumR * invW : cr;
          dst[ci + 1] = sumW > 0 ? sumG * invW : cg;
          dst[ci + 2] = sumW > 0 ? sumB * invW : cb;
          dst[ci + 3] = 255;
        }
      }
      function bilateralGrayscale(src, dst, w, h, radius, size, kernel, rLUT) {
        const wh = w * h;
        const yBuf = new Uint8ClampedArray(wh);
        for (let i = 0; i < wh; i++) {
          const ci = i * 4;
          yBuf[i] = Math.round(0.299 * src[ci] + 0.587 * src[ci + 1] + 0.114 * src[ci + 2]);
        }
        for (let idx = 0; idx < wh; idx++) {
          const x = idx % w; const y = (idx / w) | 0;
          const ci = idx * 4;
          const cy = yBuf[idx];
          let sumY = 0, sumW = 0;
          const kyMin = Math.max(0, y - radius);
          const kyMax = Math.min(h - 1, y + radius);
          const kxMin = Math.max(0, x - radius);
          const kxMax = Math.min(w - 1, x + radius);
          for (let ky = kyMin; ky <= kyMax; ky++) {
            const rowOff = ky * w;
            const kyOff = (ky - y + radius) * size;
            for (let kx = kxMin; kx <= kxMax; kx++) {
              const syVal = yBuf[rowOff + kx];
              let d = cy - syVal; if (d < 0) d = -d;
              const wgt = kernel[kyOff + (kx - x + radius)] * rLUT[d];
              sumY += syVal * wgt; sumW += wgt;
            }
          }
          const finalY = sumW > 0 ? Math.round(sumY / sumW) : cy;
          const factor = cy > 0 ? finalY / cy : 1;
          dst[ci] = Math.min(255, Math.round(src[ci] * factor));
          dst[ci + 1] = Math.min(255, Math.round(src[ci + 1] * factor));
          dst[ci + 2] = Math.min(255, Math.round(src[ci + 2] * factor));
          dst[ci + 3] = 255;
        }
      }
      self.onmessage = function (e) {
        const { id, pixels, width, height, sigmaS, sigmaR, mode } = e.data;
        const w = width, h = height;
        try {
          const radius = Math.min(Math.max(1, Math.ceil(sigmaS * 2)), 8);
          const { kernel, size } = buildSpatialKernel(radius, sigmaS);
          const rLUT = gaussianLUT(sigmaR);
          const src = new Uint8ClampedArray(pixels);
          const dst = new Uint8ClampedArray(src.length);
          const start = performance.now();
          if (mode === 'grayscale') {
            bilateralGrayscale(src, dst, w, h, radius, size, kernel, rLUT);
          } else {
            bilateralColor(src, dst, w, h, radius, size, kernel, rLUT);
          }
          const elapsed = Math.round(performance.now() - start);
          self.postMessage({ id, type: 'done', pixels: dst, elapsed }, [dst.buffer]);
        } catch (err) {
          self.postMessage({ id, type: 'error', message: err.message || String(err) });
        }
      };
    `;
    _denoiseWorkerBlobURL = URL.createObjectURL(
      new Blob([workerCode], { type: 'application/javascript' })
    );
    _denoiseWorker = new Worker(_denoiseWorkerBlobURL);
  }
  return _denoiseWorker;
}

let currentFile = null;
let currentFileData = null;
let resultBlob = null;
let resultFileName = null;
let currentMode = 'bilateral';
let startTime = 0;
let _currentSaveFormat = 'png';
let _currentSaveAction = 'save';
function scrollToSec(id) {
  const el = document.getElementById(id);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

document.addEventListener('DOMContentLoaded', () => {
  setupDragDrop();
  setupFileInput();
  setupFormatTabs();
  setupModePill();
  setupCompareSlider();
  initCustomSliders();
  initSavePills();

  if (typeof window.onHistoryPageEnter === 'function') window.onHistoryPageEnter();
  if (typeof window.onArchivePageEnter === 'function') window.onArchivePageEnter();
});

function setupFileInput() {
  const input = document.getElementById('fileInput');
  const zone = document.getElementById('uploadZone');
  if (!input) return;

  if (setupFileInput._bound) return;
  setupFileInput._bound = true;

  input.addEventListener('change', (e) => {
    if (e.target.files[0]) handleFile(e.target.files[0]);
  });

  if (zone) {
    zone.addEventListener('click', (e) => {

      if (e.target.closest('.upload-zone') && !e.target.closest('#fileInput')) {
        input.click();
      }
    });
  }
}

function setupDragDrop() {
  const zone = document.getElementById('uploadZone');
  if (!zone) return;
  zone.addEventListener('dragenter', (e) => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragover', (e) => { e.preventDefault(); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  });
}

async function handleFile(file) {

  if (file.size > 200 * 1024 * 1024) {
    showToast('文件大小超过200MB，请选择更小的图片', 'error');
    return;
  }
  vibrate(10);

  const allowed = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/bmp', 'image/tiff', 'image/x-tiff'];
  const ext = file.name.split('.').pop().toLowerCase();
  const allowedExts = ['png', 'jpg', 'jpeg', 'raw', 'bmp', 'tiff', 'tif', 'webp'];

  if (!allowed.includes(file.type) && !allowedExts.includes(ext)) {
    showToast('不支持该文件格式', 'error');
    return;
  }

  currentFile = file;
  resultBlob = null;
  resultFileName = null;

  try {
    currentFileData = await file.arrayBuffer();
  } catch {
    currentFileData = null;
  }

  const meta = document.getElementById('imgMeta');
  if (meta) {
    document.getElementById('metaName').textContent = file.name;
    document.getElementById('metaFormat').textContent = ext.toUpperCase();
    document.getElementById('metaBytes').textContent = formatBytes(file.size);
    meta.classList.remove('hidden');
  }

  const exif = parseExifRobust(currentFileData);
  const setMeta = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val || '--';
  };
  setMeta('metaMake', exif.make || '--');
  setMeta('metaModel', exif.model || '--');
  setMeta('metaAperture', formatAperture(exif.fNumber));
  setMeta('metaShutter', formatShutterSpeed(exif.exposureTime));
  setMeta('metaISO', exif.iso ? String(exif.iso) : '--');
  setMeta('metaFocal', formatFocalLength(exif.focalLength));

  const reader = new FileReader();
  reader.onload = (e) => {
    const dataURL = e.target.result;
    const previewImg = document.getElementById('previewImg');
    if (previewImg) {
      previewImg.src = dataURL;
      previewImg.classList.remove('hidden');
    }

    const img = new Image();
    img.onload = () => {
      const canvas = document.getElementById('inputCanvas');
      if (!canvas) return;
      drawToCanvas(canvas, img);
      canvas.classList.add('hidden');

      const uz = document.getElementById('uploadZone');
      if (uz) uz.style.display = 'none';

      const actions = document.getElementById('imgActions');
      if (actions) actions.classList.remove('hidden');

      resetOutputUI();

      const pb = document.getElementById('processBtn');
      if (pb) pb.disabled = false;

      showToast('图片已导入 ' + ` ${file.name}`, 'success');
    };
    img.src = dataURL;
  };

  if (ext === 'raw') {
    showRawPlaceholder();
    const pb = document.getElementById('processBtn');
    if (pb) pb.disabled = false;
  } else {
    reader.readAsDataURL(file);
  }
}

function resetOutputUI() {
  const timingBlock = document.getElementById('timingBlock');
  if (timingBlock) timingBlock.classList.add('hidden');
}

function showRawPlaceholder() {
  const previewImg = document.getElementById('previewImg');
  if (previewImg) previewImg.classList.add('hidden');

  const canvas = document.getElementById('inputCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  canvas.width = 300;
  canvas.height = 200;
  ctx.fillStyle = '#1a1a1a';
  ctx.fillRect(0, 0, 300, 200);
  ctx.fillStyle = '#666';
  ctx.font = 'bold 20px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('RAW FILE', 150, 95);
  ctx.font = '13px monospace';
  ctx.fillStyle = '#C4683A';
  ctx.fillText(currentFile.name, 150, 120);
  canvas.classList.remove('hidden');
  const uz = document.getElementById('uploadZone');
  if (uz) uz.style.display = 'none';
  const actions = document.getElementById('imgActions');
  if (actions) actions.classList.remove('hidden');
}

function changeImage() {
  const fi = document.getElementById('fileInput');
  if (fi) fi.click();
}

function removeImage() {
  currentFile = null;
  currentFileData = null;
  resultBlob = null;
  resultFileName = null;

  const el = (id) => document.getElementById(id);
  if (el('previewImg')) el('previewImg').classList.add('hidden');
  if (el('inputCanvas')) el('inputCanvas').classList.add('hidden');
  if (el('uploadZone')) el('uploadZone').style.display = '';
  if (el('imgActions')) el('imgActions').classList.add('hidden');
  if (el('imgMeta')) el('imgMeta').classList.add('hidden');
  if (el('processBtn')) el('processBtn').disabled = true;
  resetOutputUI();
  if (el('fileInput')) el('fileInput').value = '';

  showToast('已移除照片');
}

function drawToCanvas(canvas, img) {
  const MAX_SIDE = 800;
  let w = img.width, h = img.height;
  const maxSide = Math.max(w, h);
  if (maxSide > MAX_SIDE) {
    const ratio = MAX_SIDE / maxSide;
    w = Math.round(w * ratio);
    h = Math.round(h * ratio);
  }
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);
}

function setupModePill() {
  const pill = document.getElementById('modePill');
  const tabs = document.querySelectorAll('.mode-tab');
  if (!pill || !tabs.length) return;

  function movePill(activeTab) {
    const parent = pill.parentElement;
    const parentRect = parent.getBoundingClientRect();
    const rect = activeTab.getBoundingClientRect();
    pill.style.left = (rect.left - parentRect.left) + 'px';
    pill.style.width = rect.width + 'px';
  }

  const activeTab = document.querySelector('.mode-tab.active') || tabs[0];
  requestAnimationFrame(() => movePill(activeTab));

  tabs.forEach(tab => {
    tab.addEventListener('mouseenter', () => {
      selectMode(tab);
    });
  });
  const container = pill.parentElement;
  if (container) {
    container.addEventListener('mouseleave', () => {
      const current = document.querySelector('.mode-tab.active') || tabs[0];
      selectMode(current);
    });
  }
}

function selectMode(btn) {
  document.querySelectorAll('.mode-tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  currentMode = btn.dataset.mode;

  const pill = document.getElementById('modePill');
  const parent = pill?.parentElement;
  if (pill && parent) {
    const parentRect = parent.getBoundingClientRect();
    const rect = btn.getBoundingClientRect();
    pill.style.left = (rect.left - parentRect.left) + 'px';
    pill.style.width = rect.width + 'px';
  }
}

function setupFormatTabs() {
  document.querySelectorAll('.fmt-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      vibrate(6);
      document.querySelectorAll('.fmt-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const qualityRow = document.getElementById('qualityRow');
      if (qualityRow) qualityRow.style.display = btn.dataset.fmt === 'png' ? 'none' : '';
    });
  });
}

async function denoiseCanvas(srcCanvas, opts) {
  opts = opts || {};
  const sigmaS = opts.sigmaS;
  const sigmaR = opts.sigmaR;
  const mode = opts.mode || 'bilateral';
  const onProgress = opts.onProgress || function () {};

  const dw = srcCanvas.width;
  const dh = srcCanvas.height;
  const srcCtx = srcCanvas.getContext('2d');

  const outCanvas = document.createElement('canvas');
  outCanvas.width = dw;
  outCanvas.height = dh;
  const outCtx = outCanvas.getContext('2d');

  const TILE = 1800;
  const OVERLAP = 32;
  const tilesX = Math.ceil(dw / TILE);
  const tilesY = Math.ceil(dh / TILE);
  const totalTiles = tilesX * tilesY;

  let elapsedAcc = 0;

  for (let ty = 0; ty < tilesY; ty++) {
    for (let tx = 0; tx < tilesX; tx++) {
      const sx = Math.max(0, tx * TILE - OVERLAP);
      const sy = Math.max(0, ty * TILE - OVERLAP);
      const sw = Math.min(TILE + 2 * OVERLAP, dw - sx);
      const sh = Math.min(TILE + 2 * OVERLAP, dh - sy);
      const tileData = srcCtx.getImageData(sx, sy, sw, sh);

      const msgId = ++_denoiseMsgId;
      const worker = getDenoiseWorker();

      const { pixels, elapsed } = await new Promise((resolve, reject) => {
        worker.onmessage = function (e) {
          const { id, type, pixels, elapsed, message } = e.data;
          if (id !== msgId) return;
          if (type === 'error') { reject(new Error(message)); return; }
          if (type === 'done') resolve({ pixels, elapsed: elapsed || 0 });
        };
        worker.onerror = () => reject(new Error('Worker 错误'));

        const buffer = tileData.data.buffer.slice(0);
        worker.postMessage({
          id: msgId,
          pixels: new Uint8ClampedArray(buffer),
          width: sw, height: sh,
          sigmaS, sigmaR, mode
        }, [buffer]);
      });

      elapsedAcc += elapsed;

      const ex = tx * TILE;
      const ey = ty * TILE;
      const ew = Math.min(TILE, dw - ex);
      const eh = Math.min(TILE, dh - ey);
      const dx = ex - sx;
      const dy = ey - sy;

      const outData = outCtx.createImageData(ew, eh);
      const resultArr = new Uint8ClampedArray(pixels);
      for (let y = 0; y < eh; y++) {
        const srcOff = ((dy + y) * sw + dx) * 4;
        const dstOff = y * ew * 4;
        outData.data.set(resultArr.subarray(srcOff, srcOff + ew * 4), dstOff);
      }
      outCtx.putImageData(outData, ex, ey);

      onProgress(ty * tilesX + tx + 1, totalTiles);
    }
  }

  outCanvas._denoiseElapsed = Math.round(elapsedAcc);
  return outCanvas;
}

function abortDenoise() {
  if (_denoiseWorker) {
    try { _denoiseWorker.terminate(); } catch (e) {  }
    _denoiseWorker = null;
  }
  if (_denoiseWorkerBlobURL) {
    try { URL.revokeObjectURL(_denoiseWorkerBlobURL); } catch (e) {  }
    _denoiseWorkerBlobURL = null;
  }

  _denoiseMsgId++;
}

/* 降噪核心对外接口：按 1800px 边长切块调度 Worker，支持进度回调与中止 */
window.PrismDenDenoise = {
  run: denoiseCanvas,
  abort: abortDenoise,
  tileInfo: function (w, h) {
    const TILE = 1800;
    return Math.ceil(w / TILE) * Math.ceil(h / TILE);
  }
};

async function processImage() {
  if (!currentFile) return;
  vibrate(10);

  const processBtn = document.getElementById('processBtn');
  if (!processBtn) return;

  const btnText = processBtn.querySelector('.btn-text');
  const btnSpinner = document.getElementById('btnSpinner');
  const progressWrap = document.getElementById('progressWrap');
  const progressBar = document.getElementById('progressBar');
  const progressText = document.getElementById('progressText');

  processBtn.disabled = true;
  if (btnText) btnText.textContent = '处理中...';
  if (btnSpinner) btnSpinner.classList.remove('hidden');
  if (progressWrap) progressWrap.classList.remove('hidden');
  const timingBlock = document.getElementById('timingBlock');
  if (timingBlock) timingBlock.classList.add('hidden');

  const stopProgress = animateProgress(progressBar, progressText);

  const sigmaS = parseInt(document.getElementById('sigmaS').value);
  const sigmaR = parseInt(document.getElementById('sigmaR').value);

  startTime = performance.now();

  try {

    const img = await loadImage(currentFile);
    const dw = img.naturalWidth, dh = img.naturalHeight;

    const srcCanvas = document.createElement('canvas');
    srcCanvas.width = dw;
    srcCanvas.height = dh;
    const srcCtx = srcCanvas.getContext('2d');
    srcCtx.drawImage(img, 0, 0);

    const totalTiles = window.PrismDenDenoise.tileInfo(dw, dh);
    if (totalTiles > 1) {
      showToast(`大图分块降噪（共 ${totalTiles} 块）`, 'info');
    }

    const outCanvas = await denoiseCanvas(srcCanvas, {
      sigmaS, sigmaR, mode: currentMode,
      onProgress: function (done, total) {
        const pct = Math.round((done / total) * 100);
        if (progressBar) progressBar.style.width = pct + '%';
        if (progressText) progressText.textContent = `分块降噪 ${done}/${total} (${pct}%)`;
      }
    });
    window._lastElapsed = outCanvas._denoiseElapsed || 0;

    const resultBlobLocal = await new Promise((resolve, reject) => {
      outCanvas.toBlob(blob => {
        blob ? resolve(blob) : reject(new Error('Blob 导出失败'));
      }, 'image/png');
    });

    resultBlob = resultBlobLocal;

    const baseName = currentFile.name.replace(/\.[^.]+$/, '');
    resultFileName = `${baseName}_denoised.png`;

    const elapsed = window._lastElapsed || Math.round(performance.now() - startTime);
    window._lastDenoiseParams = { sigmaS, sigmaR, mode: currentMode, elapsed };
    window._lastInputCanvas = document.getElementById('inputCanvas');

    stopProgress();
    if (progressBar) progressBar.style.width = '100%';
    if (progressText) progressText.textContent = '处理完成！';
    setTimeout(() => { if (progressWrap) progressWrap.classList.add('hidden'); }, 1200);

    showToast('降噪完成，耗时 ' + ` ${elapsed}ms`, 'success');
    if (window.PrismDenStats) window.PrismDenStats.incDenoise();

    setTimeout(() => scrollToSec('sec-result'), 600);

  } catch (err) {
    stopProgress();
    if (progressWrap) progressWrap.classList.add('hidden');
    showToast('降噪失败', 'error');
    console.error(err);
  } finally {
    processBtn.disabled = false;
    if (btnText) btnText.textContent = '开始处理';
    if (btnSpinner) btnSpinner.classList.add('hidden');
  }
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('图片解码失败'));
      img.src = reader.result;
    };
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.readAsDataURL(file);
  });
}

function animateProgress(bar, text) {
  if (!bar || !text) return () => {};
  let pct = 0;
  const msgs = ['解码图片...', '分析噪声分布...', '双边滤波处理中...', '合成结果...'];
  const lastMsgIdx = msgs.length - 1;
  let msgIdx = 0;
  const iv = setInterval(() => {
    if (pct < 90) {
      const step = pct < 30 ? 8 : pct < 60 ? 5 : 2;
      pct = Math.min(pct + step + Math.random() * 3, 90);
      bar.style.width = pct + '%';
      const expectedMsg = Math.floor((pct / 90) * lastMsgIdx);
      if (expectedMsg > msgIdx && expectedMsg < msgs.length) {
        msgIdx = expectedMsg;
        text.textContent = msgs[msgIdx];
      }
    } else {
      text.textContent = msgs[lastMsgIdx];
      bar.style.width = '90%';
    }
  }, 350);
  return () => { clearInterval(iv); };
}

function toNumber(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'object' && v.numerator !== undefined && v.denominator !== undefined) {
    return v.denominator === 0 ? null : v.numerator / v.denominator;
  }

  if (Array.isArray(v) && v.length > 0) {
    if (typeof v[0] === 'number') return v[0];
    return toNumber(v[0]);
  }
  return null;
}

/* EXIF 解析入口：容错读取 JPEG/TIFF 的拍摄参数（光圈、快门、ISO、焦距等） */
function parseExifRobust(buffer) {
  if (!buffer) return {};

  let exifJsResult = null;
  try {
    if (typeof EXIF !== 'undefined' && EXIF.readFromBinaryFile) {
      const raw = EXIF.readFromBinaryFile(buffer);
      if (raw && typeof raw === 'object') {
        exifJsResult = {
          make:           raw.Make || raw.make || null,
          model:          raw.Model || raw.model || null,
          exposureTime:   toNumber(raw.ExposureTime),
          fNumber:        toNumber(raw.FNumber),
          iso:            raw.ISOSpeedRatings !== undefined ? Number(raw.ISOSpeedRatings) || toNumber(raw.ISOSpeedRatings) : null,
          focalLength:    toNumber(raw.FocalLength),
          colorSpace:     raw.ColorSpace !== undefined ? Number(raw.ColorSpace) : null,
          gpsLatitude:    raw.GPSLatitude || null,
          gpsLatitudeRef: raw.GPSLatitudeRef || null,
          gpsLongitude:   raw.GPSLongitude || null,
          gpsLongitudeRef: raw.GPSLongitudeRef || null,
          dateTimeOriginal: raw.DateTimeOriginal || raw.DateTime || null,
        };
      }
    }
  } catch (e) {
    console.warn('exif.js parsing failed:', e.message);
  }

  const custom = parseExif(buffer);

  if (exifJsResult) {
    return {
      make:         exifJsResult.make         || custom.make         || null,
      model:        exifJsResult.model        || custom.model        || null,
      exposureTime: exifJsResult.exposureTime ?? custom.exposureTime ?? null,
      fNumber:      exifJsResult.fNumber      ?? custom.fNumber      ?? null,
      iso:          exifJsResult.iso          ?? custom.iso          ?? null,
      focalLength:  exifJsResult.focalLength  ?? custom.focalLength  ?? null,
      colorSpace:   exifJsResult.colorSpace   ?? custom.colorSpace   ?? null,
      gpsLatitude:    exifJsResult.gpsLatitude    || custom.gpsLatitude    || null,
      gpsLatitudeRef: exifJsResult.gpsLatitudeRef || custom.gpsLatitudeRef || null,
      gpsLongitude:   exifJsResult.gpsLongitude   || custom.gpsLongitude   || null,
      gpsLongitudeRef: exifJsResult.gpsLongitudeRef || custom.gpsLongitudeRef || null,
      dateTimeOriginal: exifJsResult.dateTimeOriginal || custom.dateTimeOriginal || custom.dateTime || null,
    };
  }

  return custom;
}

function parseExif(buffer) {
  if (!buffer) return {};
  const data = new Uint8Array(buffer);
  const view = new DataView(buffer);
  let offset = 0;

  if (data[0] !== 0xFF || data[1] !== 0xD8) return {};

  offset = 2;
  while (offset < data.length - 1) {
    if (data[offset] !== 0xFF) break;
    const marker = data[offset + 1];

    if (marker === 0xE1) {

      const header = String.fromCharCode(...data.slice(offset + 4, offset + 10));
      if (header !== 'Exif\x00\x00') { offset += 2 + view.getUint16(offset + 2, false); continue; }

      offset += 10;
      const tiffOffset = offset;
      const isLE = data[offset] === 0x49;
      if (data[offset] !== 0x49 && data[offset] !== 0x4D) return {};
      offset += 2;
      if (view.getUint16(offset, isLE) !== 0x002A) return {};
      offset += 2;
      const ifd0Offset = view.getUint32(offset, isLE);
      offset = tiffOffset + ifd0Offset;

      const ifd0 = readIFD(view, tiffOffset, offset, isLE);

      var result = Object.assign({}, ifd0);

      if (ifd0._subIfdOffset) {
        const sub = readIFD(view, tiffOffset, tiffOffset + ifd0._subIfdOffset, isLE);
        result = Object.assign(result, sub);
      }

      if (ifd0._gpsIfdOffset) {
        const gps = readIFD(view, tiffOffset, tiffOffset + ifd0._gpsIfdOffset, isLE);
        result = Object.assign(result, gps);
      }

      return result;
    }

    if (marker === 0x00 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) {
      offset += 2;
    } else {
      offset += 2 + (offset + 2 < data.length ? view.getUint16(offset + 2, false) : 0);
    }
  }

  return {};
}

function readIFD(view, tiffBase, offset, isLE) {
  const result = {};
  const count = view.getUint16(offset, isLE);
  offset += 2;

  for (let i = 0; i < count; i++) {
    const tag = view.getUint16(offset, isLE);
    const type = view.getUint16(offset + 2, isLE);
    const numVals = view.getUint32(offset + 4, isLE);
    const valOffset = offset + 8;

    const typeSizes = { 1:1, 2:1, 3:2, 4:4, 5:8, 7:1, 9:4, 10:8 };
    const totalBytes = numVals * (typeSizes[type] || 1);

    let rawVal;
    if (totalBytes <= 4) {
      rawVal = valOffset;
    } else {
      rawVal = tiffBase + view.getUint32(valOffset, isLE);
    }

    switch (tag) {
      case 0x010F: result.make = readString(view, rawVal, numVals); break;
      case 0x0110: result.model = readString(view, rawVal, numVals); break;
      case 0x0132: result.dateTime = readString(view, rawVal, numVals); break;
      case 0x829A: result.exposureTime = readRational(view, rawVal, isLE); break;
      case 0x829D: result.fNumber = readRational(view, rawVal, isLE); break;
      case 0x8827: result.iso = readShort(view, rawVal, isLE); break;
      case 0x920A: result.focalLength = readRational(view, rawVal, isLE); break;
      case 0x9003: result.dateTimeOriginal = readString(view, rawVal, numVals); break;
      case 0xA001: result.colorSpace = readShort(view, rawVal, isLE); break;
      case 0x8769: result._subIfdOffset = view.getUint32(valOffset, isLE); break;
      case 0x8825: result._gpsIfdOffset = view.getUint32(valOffset, isLE); break;

      case 0x0001: result.gpsLatitudeRef = readString(view, rawVal, numVals); break;
      case 0x0002: result.gpsLatitude = readRationalArray(view, rawVal, isLE, numVals); break;
      case 0x0003: result.gpsLongitudeRef = readString(view, rawVal, numVals); break;
      case 0x0004: result.gpsLongitude = readRationalArray(view, rawVal, isLE, numVals); break;
    }

    offset += 12;
  }

  return result;
}

function readString(view, offset, len) {
  const bytes = [];
  for (let i = 0; i < len; i++) {
    const b = view.getUint8(offset + i);
    if (b === 0) break;
    bytes.push(b);
  }
  return String.fromCharCode(...bytes).trim() || null;
}

function readRational(view, offset, isLE) {
  const num = view.getUint32(offset, isLE);
  const den = view.getUint32(offset + 4, isLE);
  if (den === 0) return null;
  return num / den;
}

function readRationalArray(view, offset, isLE, count) {
  const arr = [];
  for (let i = 0; i < count; i++) {
    const num = view.getUint32(offset + 8 * i, isLE);
    const den = view.getUint32(offset + 4 + 8 * i, isLE);
    arr.push(den === 0 ? 0 : num / den);
  }
  return arr;
}

function readShort(view, offset, isLE) {
  return view.getUint16(offset, isLE);
}

function formatShutterSpeed(seconds) {
  if (seconds === null || seconds === undefined) return null;
  if (seconds >= 1) return seconds.toFixed(1) + 's';
  const recip = Math.round(1 / seconds);
  return '1/' + recip + 's';
}

function formatAperture(fNumber) {
  if (fNumber === null || fNumber === undefined) return null;
  return 'f/' + fNumber.toFixed(1);
}

function formatFocalLength(mm) {
  if (mm === null || mm === undefined) return null;
  return Math.round(mm) + 'mm';
}

function colorSpaceName(code) {
  if (code === 1) return 'sRGB';
  if (code === 2) return 'Adobe RGB';
  if (code === 0xFFFF) return 'Uncalibrated';
  return null;
}

async function fillPhotoInfo() {
  const set = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val || '--';
  };

  if (currentFile) {
    const sizeStr = formatBytes(currentFile.size);
    const ext = currentFile.name.split('.').pop().toUpperCase();

    set('infoFileSize', sizeStr);
    set('infoFormat', ext);

  } else {
    set('infoFileSize', '--');
    set('infoFormat', '--');
  }

  if (!currentFileData && currentFile) {
    try { currentFileData = await currentFile.arrayBuffer(); } catch { currentFileData = null; }
  }

  const exif = parseExifRobust(currentFileData);

  const setPair = (metaId, infoId, val) => {
    set(metaId, val);
    set(infoId, val);
  };

  setPair('metaMake', 'infoMake', exif.make || '--');
  setPair('metaModel', 'infoModel', exif.model || '--');
  setPair('metaAperture', 'infoAperture', formatAperture(exif.fNumber));
  setPair('metaShutter', 'infoShutter', formatShutterSpeed(exif.exposureTime));
  setPair('metaISO', 'infoISO', exif.iso ? String(exif.iso) : '--');
  setPair('metaFocal', 'infoFocal', formatFocalLength(exif.focalLength));
  set('infoColorSpace', colorSpaceName(exif.colorSpace) || '--');
}

/* 结果区渲染：输出降噪后图像、参数摘要与耗时统计，并同步 EXIF 信息表 */
function refreshResultPage() {
  if (!resultBlob) {
    const emptyState = document.getElementById('emptyState');
    const resultContent = document.getElementById('resultContent');
    if (emptyState) emptyState.classList.remove('hidden');
    if (resultContent) resultContent.classList.add('hidden');
    return;
  }

  const emptyState = document.getElementById('emptyState');
  const resultContent = document.getElementById('resultContent');
  if (emptyState) emptyState.classList.add('hidden');
  if (resultContent) {
    resultContent.classList.remove('hidden');

    void resultContent.offsetHeight;
  }

  requestAnimationFrame(() => { requestAnimationFrame(() => initSavePills()); });

  const p = window._lastDenoiseParams || {};
  const timing = document.getElementById('resultTiming');
  if (timing) timing.textContent = (p.elapsed || '--') + ' ms';
  const rs = document.getElementById('resultSigmaS');
  if (rs) rs.textContent = p.sigmaS || '--';
  const rr = document.getElementById('resultSigmaR');
  if (rr) rr.textContent = p.sigmaR || '--';
  const rm = document.getElementById('resultMode');
  if (rm) rm.textContent = p.mode === 'bilateral' ? '彩色双边' : '灰度 Y 通道';

  fillPhotoInfo();

  const resultSizeStr = formatBytes(resultBlob.size);
  const infoFileSize = document.getElementById('infoFileSize');
  if (infoFileSize) infoFileSize.textContent = resultSizeStr;
  const metaBytes = document.getElementById('metaBytes');
  if (metaBytes) metaBytes.textContent = resultSizeStr;

  const url = URL.createObjectURL(resultBlob);
  const img = new Image();
  img.onload = () => {
    const canvas = document.getElementById('resultCanvas');
    if (!canvas) return;
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext('2d').drawImage(img, 0, 0);
    URL.revokeObjectURL(url);
  };
  img.src = url;
}

async function saveImage(fmtOverride) {
  if (!resultBlob) { showToast('没有可保存的图片', 'error'); return; }

  let fmt;
  if (fmtOverride) {
    fmt = fmtOverride;
  } else {
    const activeTab = document.querySelector('.fmt-tab.active');
    if (!activeTab) { showToast('请选择保存格式', 'error'); return; }
    fmt = activeTab.dataset.fmt;
  }
  const qualitySlider = document.getElementById('qualitySlider');
  const quality = qualitySlider ? parseInt(qualitySlider.value) / 100 : 1;

  let finalBlob = resultBlob;
  let fileName = resultFileName;

  if (fmt !== 'png') {

    finalBlob = await convertBlob(resultBlob, fmt, quality);
    const base = (resultFileName || 'denoised').replace(/\.[^.]+$/, '');
    fileName = `${base}.${fmt}`;
  }

  const url = URL.createObjectURL(finalBlob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName || 'denoised.png';
  a.click();
  URL.revokeObjectURL(url);

  showToast('已保存: ' + ` ${fileName}`, 'success');
}

async function convertBlob(blob, fmt, quality) {
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(blob);
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      canvas.toBlob((b) => resolve(b), `image/${fmt}`, quality);
    };
    img.src = url;
  });
}

function selectSaveFormat(btn) {
  vibrate(6);
  _currentSaveFormat = btn.dataset.fmt;

  document.querySelectorAll('.save-fmt-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');

  const container = document.getElementById('saveFormatTabs');
  if (container) {
    const pill = container.querySelector('.save-format-pill');
    if (pill) {
      const cr = container.getBoundingClientRect();
      const br = btn.getBoundingClientRect();
      pill.style.left = (br.left - cr.left) + 'px';
      pill.style.width = br.width + 'px';
    }
  }

  const qualityRow = document.getElementById('qualityRow');
  if (qualityRow) {
    qualityRow.style.display = (_currentSaveFormat === 'png') ? 'none' : 'flex';
  }
}

function selectSaveAction(btn) {
  vibrate(6);
  _currentSaveAction = btn.dataset.action;

  document.querySelectorAll('.save-action-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');

  const container = document.getElementById('saveActions');
  if (container) {
    const pill = container.querySelector('.save-action-pill');
    if (pill) {
      const cr = container.getBoundingClientRect();
      const br = btn.getBoundingClientRect();
      pill.style.left = (br.left - cr.left) + 'px';
      pill.style.width = br.width + 'px';
    }
  }
}

function executeSaveAction() {
  if (_currentSaveAction === 'save') {
    saveImage(_currentSaveFormat);
  } else if (_currentSaveAction === 'new') {
    scrollToSec('sec-denoise');
  }
}

function initSavePills() {

  const formatContainer = document.getElementById('saveFormatTabs');
  if (formatContainer) {
    const activeFmt = formatContainer.querySelector('.save-fmt-btn.active');
    const pill = formatContainer.querySelector('.save-format-pill');
    if (activeFmt && pill) {
      const cr = formatContainer.getBoundingClientRect();
      const br = activeFmt.getBoundingClientRect();
      pill.style.left = (br.left - cr.left) + 'px';
      pill.style.width = br.width + 'px';
    }

    formatContainer.querySelectorAll('.save-fmt-btn').forEach(btn => {
      btn.addEventListener('click', () => selectSaveFormat(btn));
    });
  }

  const actionContainer = document.getElementById('saveActions');
  if (actionContainer) {
    const firstAction = actionContainer.querySelector('.save-action-btn');
    const pill = actionContainer.querySelector('.save-action-pill');
    if (firstAction && pill) {
      const cr = actionContainer.getBoundingClientRect();
      const br = firstAction.getBoundingClientRect();
      pill.style.left = (br.left - cr.left) + 'px';
      pill.style.width = br.width + 'px';
    }

    actionContainer.querySelectorAll('.save-action-btn').forEach(btn => {
      btn.addEventListener('click', () => selectSaveAction(btn));
    });
  }
}

let _customSliders = [];

/* 自定义滑块控件：将原生 range 包装为带数值气泡的交互控件 */
function initCustomSliders() {
  const natives = document.querySelectorAll('.slider');
  natives.forEach(native => {
    if (native.dataset.custom === 'true') return;
    native.dataset.custom = 'true';

    const min = parseFloat(native.min) || 0;
    const max = parseFloat(native.max) || 100;
    let val = parseFloat(native.value) || 0;

    const wrap = document.createElement('div');
    wrap.className = 'custom-slider';
    wrap.dataset.targetId = native.id;

    const track = document.createElement('div');
    track.className = 'custom-slider-track';

    const fill = document.createElement('div');
    fill.className = 'custom-slider-fill';

    const thumb = document.createElement('div');
    thumb.className = 'custom-slider-thumb';

    track.appendChild(fill);
    track.appendChild(thumb);
    wrap.appendChild(track);

    native.style.display = 'none';
    native.insertAdjacentElement('afterend', wrap);

    const data = {
      native, wrap, track, thumb, fill,
      min, max, val,
      isHover: false,
      isClickDrag: false,
    };
    _customSliders.push(data);

    function pctFromX(clientX) {
      const r = track.getBoundingClientRect();
      return Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    }

    function updateThumb() {
      const pct = (data.val - data.min) / (data.max - data.min) * 100;
      thumb.style.left = pct + '%';
      fill.style.width = pct + '%';
    }

    function applyValue(newVal) {
      newVal = Math.max(data.min, Math.min(data.max, Math.round(newVal)));
      if (newVal === data.val) return;
      data.val = newVal;
      native.value = data.val;
      native.dispatchEvent(new Event('input', { bubbles: true }));
      updateThumb();
    }

    updateThumb();

    wrap.addEventListener('mouseenter', () => {
      data.isHover = true;
      wrap.classList.add('hover');
    });
    wrap.addEventListener('mouseleave', () => {
      data.isHover = false;
      data.isClickDrag = false;
      wrap.classList.remove('hover');
      thumb.classList.remove('dragging');
    });

    thumb.addEventListener('mousedown', (e) => {
      data.isClickDrag = true;
      thumb.classList.add('dragging');
      e.preventDefault();
      e.stopPropagation();
    });
    thumb.addEventListener('touchstart', (e) => {
      data.isClickDrag = true;
      thumb.classList.add('dragging');
      e.preventDefault();
      e.stopPropagation();
    }, { passive: false });

    track.addEventListener('click', (e) => {
      if (data.isClickDrag) return;
      applyValue(data.min + pctFromX(e.clientX) * (data.max - data.min));
    });

    track.addEventListener('touchstart', (e) => {
      e.preventDefault();
      var t = e.touches[0];
      applyValue(data.min + pctFromX(t.clientX) * (data.max - data.min));
    }, { passive: false });

    data._applyFromX = (clientX) => {
      applyValue(data.min + pctFromX(clientX) * (data.max - data.min));
    };
  });

  document.addEventListener('mousemove', (e) => {
    _customSliders.forEach(d => {
      if (d.isClickDrag) {
        d._applyFromX(e.clientX);
      }
    });
  });

  document.addEventListener('touchmove', (e) => {
    _customSliders.forEach(d => {
      if (d.isClickDrag) {
        d._applyFromX(e.touches[0].clientX);
      }
    });
  }, { passive: false });

  document.addEventListener('mouseup', () => {
    _customSliders.forEach(d => {
      d.isClickDrag = false;
      d.thumb.classList.remove('dragging');
    });
  });
  document.addEventListener('touchend', () => {
    _customSliders.forEach(d => {
      d.isClickDrag = false;
      d.thumb.classList.remove('dragging');
    });
  });
}

let compareActive = false;

/* 原图与降噪图的对比浮层：可拖动分割线进行左右比对 */
function openCompare() {
  if (!resultBlob) return;

  const overlay = document.getElementById('compareOverlay');
  const origCanvas = document.getElementById('compareOriginal');
  const resCanvas = document.getElementById('compareResult');

  const srcCanvas = document.getElementById('inputCanvas');
  if (!srcCanvas || !overlay || !origCanvas || !resCanvas) return;

  const resultCanvas = document.getElementById('resultCanvas');
  if (!resultCanvas) return;

  const cmpW = resultCanvas.width;
  const cmpH = resultCanvas.height;

  origCanvas.width = cmpW;
  origCanvas.height = cmpH;
  resCanvas.width = cmpW;
  resCanvas.height = cmpH;

  const ictx = origCanvas.getContext('2d');
  ictx.drawImage(srcCanvas, 0, 0, cmpW, cmpH);

  const rctx = resCanvas.getContext('2d');
  rctx.drawImage(resultCanvas, 0, 0);

  overlay.classList.remove('hidden');
  compareActive = true;
}

function closeCompare() {
  const overlay = document.getElementById('compareOverlay');
  if (overlay) overlay.classList.add('hidden');
  compareActive = false;
}

function setupCompareSlider() {
  const divider = document.getElementById('compareDivider');
  const wrap = document.getElementById('compareResultWrap');
  const container = document.getElementById('compareContainer');
  if (!divider || !wrap || !container) return;

  let dragging = false;

  const onMove = (x) => {
    if (!dragging || !compareActive) return;
    const rect = container.getBoundingClientRect();
    let pct = ((x - rect.left) / rect.width) * 100;
    pct = Math.max(5, Math.min(95, pct));
    divider.style.left = pct + '%';
    wrap.style.width = pct + '%';
  };

  divider.addEventListener('mousedown', () => { dragging = true; });
  document.addEventListener('mousemove', (e) => onMove(e.clientX));
  document.addEventListener('mouseup', () => { dragging = false; });

  divider.addEventListener('touchstart', (e) => { dragging = true; e.preventDefault(); });
  document.addEventListener('touchmove', (e) => onMove(e.touches[0].clientX));
  document.addEventListener('touchend', () => { dragging = false; });

  const overlay = document.getElementById('compareOverlay');
  if (overlay) {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeCompare();
    });
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

let toastTimer = null;
function showToast(msg, type) {
  type = type || '';

  if (type === 'success') vibrate(15);
  else if (type === 'error') vibrate([20, 40, 20]);
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = msg;
  toast.className = 'toast show' + (type ? ' ' + type : '');

  toast.style.color = '#FFFFFF';
  toast.style.background = '#141210';
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.className = 'toast hidden'; }, 2800);
}

