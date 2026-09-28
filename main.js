/*
 * PrismDen 棱镜降噪图像处理系统 V1.0
 * 主程序：双边滤波降噪核心算法、Web Worker 分块调度、通用提示与触感反馈
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


window.PrismDenDenoise = {
  run: denoiseCanvas,
  abort: abortDenoise,
  tileInfo: function (w, h) {
    const TILE = 1800;
    return Math.ceil(w / TILE) * Math.ceil(h / TILE);
  }
};

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

document.addEventListener('DOMContentLoaded', () => {
  if (typeof window.onHistoryPageEnter === 'function') window.onHistoryPageEnter();
  if (typeof window.onArchivePageEnter === 'function') window.onArchivePageEnter();
});
