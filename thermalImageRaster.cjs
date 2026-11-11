/**
 * Thermal Image Raster Module for ESC/POS Printers
 * Ported from proven working reference implementation at D:\Image Print
 * 
 * Features:
 * 1. Aspect-ratio preserved scaling to 58mm (384 dots) and 80mm (576 dots).
 * 2. High-quality binarization (ITU-R BT.601 luminance + contrast boost + 1-bit thresholding / error diffusion).
 * 3. Byte-aligned ESC/POS GS v 0 0 sliced raster bands (max 256 lines per slice to prevent buffer overflow).
 * 4. Isolation & mode reset (ESC @) to ensure text printing is never corrupted.
 */

const { nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');

const PAPER_DOTS = {
  '58mm': 384,
  '80mm': 576,
};

const OFFLINE_QR_CACHE_FILE = path.join(os.tmpdir(), 'ariso_cached_receipt_qr.bin');

/**
 * Downloads an HTTP/HTTPS image into a Buffer, caching it locally for 100% offline support
 */
async function downloadImageBuffer(url) {
  return new Promise((resolve, reject) => {
    try {
      const client = url.startsWith('https://') ? https : http;
      const req = client.get(url, { timeout: 4000 }, (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const buf = Buffer.concat(chunks);
            try { fs.writeFileSync(OFFLINE_QR_CACHE_FILE, buf); } catch (_) {}
            resolve(buf);
          });
        } else {
          // If server fails or offline, fall back to cached copy
          if (fs.existsSync(OFFLINE_QR_CACHE_FILE)) {
            try { return resolve(fs.readFileSync(OFFLINE_QR_CACHE_FILE)); } catch (_) {}
          }
          reject(new Error(`Failed to download image, status code: ${res.statusCode}`));
        }
      });
      req.on('error', (err) => {
        // Fallback to offline cached copy if network/DNS fails
        if (fs.existsSync(OFFLINE_QR_CACHE_FILE)) {
          try { return resolve(fs.readFileSync(OFFLINE_QR_CACHE_FILE)); } catch (_) {}
        }
        reject(err);
      });
      req.on('timeout', () => {
        req.destroy();
        if (fs.existsSync(OFFLINE_QR_CACHE_FILE)) {
          try { return resolve(fs.readFileSync(OFFLINE_QR_CACHE_FILE)); } catch (_) {}
        }
        reject(new Error('Image download timed out'));
      });
    } catch (err) {
      if (fs.existsSync(OFFLINE_QR_CACHE_FILE)) {
        try { return resolve(fs.readFileSync(OFFLINE_QR_CACHE_FILE)); } catch (_) {}
      }
      reject(err);
    }
  });
}

/**
 * Loads any image source (file path, data URL, http URL, buffer) into an Electron nativeImage instance
 */
async function loadToNativeImage(source) {
  if (!source) throw new Error('No image source provided');

  // 1. Buffer directly
  if (Buffer.isBuffer(source)) {
    const img = nativeImage.createFromBuffer(source);
    if (!img.isEmpty()) return img;
    throw new Error('Could not decode image from buffer');
  }

  if (typeof source !== 'string') {
    throw new Error('Unsupported image source type');
  }

  const trimmed = source.trim();

  // 2. Data URL (Base64)
  if (trimmed.startsWith('data:image/')) {
    const match = trimmed.match(/^data:image\/[a-zA-Z0-9\+\-]+;base64,(.+)$/);
    if (match && match[1]) {
      const buf = Buffer.from(match[1], 'base64');
      const img = nativeImage.createFromBuffer(buf);
      if (!img.isEmpty()) return img;
    }
    const img = nativeImage.createFromDataURL(trimmed);
    if (!img.isEmpty()) return img;
    throw new Error('Could not decode image from Data URL');
  }

  // 3. HTTP / HTTPS URL
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    const buf = await downloadImageBuffer(trimmed);
    const img = nativeImage.createFromBuffer(buf);
    if (!img.isEmpty()) return img;
    throw new Error('Could not decode image downloaded from URL');
  }

  // 4. Local File Path (Absolute or Relative)
  const cleanRel = trimmed.replace(/^[\\\/]+/, '');
  const candidatePaths = [
    trimmed,
    path.resolve(trimmed),
    path.join(__dirname, 'public', cleanRel),
    path.join(__dirname, cleanRel),
    path.join(process.cwd(), 'public', cleanRel),
    path.join(process.cwd(), cleanRel),
    path.join(__dirname, '..', 'backend', cleanRel),
    path.join(__dirname, '..', 'backend', 'public', cleanRel),
    path.join(__dirname, '..', 'public', cleanRel),
  ];

  for (const candidate of candidatePaths) {
    try {
      if (fs.existsSync(candidate)) {
        const stat = fs.statSync(candidate);
        if (stat.isFile()) {
          const img = nativeImage.createFromPath(candidate);
          if (!img.isEmpty()) {
            // Save to offline cache
            try { fs.copyFileSync(candidate, OFFLINE_QR_CACHE_FILE); } catch (_) {}
            return img;
          }
          const fileBuf = fs.readFileSync(candidate);
          const imgFromBuf = nativeImage.createFromBuffer(fileBuf);
          if (!imgFromBuf.isEmpty()) {
            try { fs.writeFileSync(OFFLINE_QR_CACHE_FILE, fileBuf); } catch (_) {}
            return imgFromBuf;
          }
        }
      }
    } catch (_) {}
  }

  // 5. Offline Fallback: Use last cached QR image if present
  if (fs.existsSync(OFFLINE_QR_CACHE_FILE)) {
    try {
      const cachedBuf = fs.readFileSync(OFFLINE_QR_CACHE_FILE);
      const imgCached = nativeImage.createFromBuffer(cachedBuf);
      if (!imgCached.isEmpty()) {
        console.log('[thermalImageRaster] Loaded QR code from offline cache.');
        return imgCached;
      }
    } catch (_) {}
  }

  throw new Error(`Image source not found or unreachable: ${trimmed.substring(0, 100)}`);
}

/**
 * Applies ITU-R BT.601 standard luminance, transparency conversion, and contrast enhancement.
 * (Direct port of D:\Image Print\src\utils\ditherEngine.js processLuminance)
 */
function processLuminance(bitmap, width, height, options = {}) {
  const {
    brightness = 0,
    contrast = 20,
    invert = false,
    transparentToWhite = true,
  } = options;

  const luminance = new Float32Array(width * height);
  // Contrast factor calculation
  const factor = (259 * (contrast + 255)) / (255 * (259 - contrast));
  const brightOffset = (brightness / 100) * 255;

  for (let i = 0; i < width * height; i++) {
    const offset = i * 4;
    // Electron's toBitmap() on Windows is 32-bit BGRA
    let b = bitmap[offset];
    let g = bitmap[offset + 1];
    let r = bitmap[offset + 2];
    const a = bitmap[offset + 3];

    // Transparent pixels (alpha < 128) default to white paper background
    if (a < 128 && transparentToWhite) {
      r = 255;
      g = 255;
      b = 255;
    }

    // ITU-R BT.601 luminance
    let gray = 0.299 * r + 0.587 * g + 0.114 * b;
    gray += brightOffset;
    gray = factor * (gray - 128) + 128;
    gray = Math.max(0, Math.min(255, gray));

    if (invert) {
      gray = 255 - gray;
    }

    luminance[i] = gray;
  }

  return luminance;
}

/**
 * 1-bit Monochrome Binarization & Dithering
 * (Direct port of D:\Image Print\src\utils\ditherEngine.js applyDithering)
 */
function applyDithering(luminance, width, height, mode = 'threshold', threshold = 128) {
  const mono = new Uint8Array(width * height);
  const buffer = new Float32Array(luminance);

  if (mode === 'threshold') {
    // Sharp binary thresholding (Optimal for Barcodes, QR codes & Vector Logos)
    for (let i = 0; i < buffer.length; i++) {
      mono[i] = buffer[i] < threshold ? 0 : 255; // 0 = black (burn), 255 = white
    }
  } else if (mode === 'floydSteinberg') {
    // Floyd-Steinberg error diffusion for photos / portraits
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        const oldVal = buffer[idx];
        const newVal = oldVal < threshold ? 0 : 255;
        mono[idx] = newVal;

        const err = oldVal - newVal;
        if (x + 1 < width) buffer[idx + 1] += (err * 7) / 16;
        if (y + 1 < height) {
          if (x - 1 >= 0) buffer[(y + 1) * width + (x - 1)] += (err * 3) / 16;
          buffer[(y + 1) * width + x] += (err * 5) / 16;
          if (x + 1 < width) buffer[(y + 1) * width + (x + 1)] += (err * 1) / 16;
        }
      }
    }
  } else if (mode === 'atkinson') {
    // Atkinson dithering for high-contrast shading
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        const oldVal = buffer[idx];
        const newVal = oldVal < threshold ? 0 : 255;
        mono[idx] = newVal;

        const err = (oldVal - newVal) / 8;
        if (x + 1 < width) buffer[idx + 1] += err;
        if (x + 2 < width) buffer[idx + 2] += err;
        if (y + 1 < height) {
          if (x - 1 >= 0) buffer[(y + 1) * width + (x - 1)] += err;
          buffer[(y + 1) * width + x] += err;
          if (x + 1 < width) buffer[(y + 1) * width + (x + 1)] += err;
        }
        if (y + 2 < height) {
          buffer[(y + 2) * width + x] += err;
        }
      }
    }
  }

  return mono;
}

/**
 * Generates ESC/POS GS v 0 0 raster chunks from 1-bit monochrome pixel array
 * (Direct port of D:\Image Print\electron\escposRaster.js createEscposRasterBuffer)
 */
function createEscposRasterBuffer(monoPixels, width, height, options = {}) {
  const {
    feedLinesBefore = 1,
    feedLinesAfter = 3,
    cutPaper = false,
  } = options;

  const ESC = 0x1B;
  const GS = 0x1D;
  const chunks = [];

  // 1. Reset / Initialize printer to clean state
  chunks.push(Buffer.from([ESC, 0x40])); // ESC @

  // 2. Feed lines before if requested
  if (feedLinesBefore > 0) {
    chunks.push(Buffer.from([ESC, 0x64, Math.min(10, feedLinesBefore)]));
  }

  // 3. Center alignment
  chunks.push(Buffer.from([ESC, 0x61, 0x01])); // ESC a 1 (Center)

  // 4. Calculate width in bytes (must be multiple of 8 bits)
  const widthBytes = Math.ceil(width / 8);

  // Process raster in slices (max 256 lines per GS v 0 slice to prevent printer receive buffer overflow)
  const SLICE_HEIGHT = 256;

  for (let sliceY = 0; sliceY < height; sliceY += SLICE_HEIGHT) {
    const currentSliceH = Math.min(SLICE_HEIGHT, height - sliceY);

    const xL = widthBytes % 256;
    const xH = Math.floor(widthBytes / 256);
    const yL = currentSliceH % 256;
    const yH = Math.floor(currentSliceH / 256);

    // GS v 0 0 xL xH yL yH
    const header = Buffer.from([GS, 0x76, 0x30, 0x00, xL, xH, yL, yH]);
    const dataBuffer = Buffer.alloc(widthBytes * currentSliceH);

    let byteIndex = 0;
    for (let row = 0; row < currentSliceH; row++) {
      const globalY = sliceY + row;

      for (let colByte = 0; colByte < widthBytes; colByte++) {
        let currentByte = 0;

        for (let bit = 0; bit < 8; bit++) {
          const globalX = colByte * 8 + bit;

          if (globalX < width && globalY < height) {
            const pIdx = globalY * width + globalX;
            // In monoPixels, 0 = black (burn dot), 255 = white
            const isBlack = monoPixels[pIdx] === 0 || monoPixels[pIdx] < 128;

            if (isBlack) {
              currentByte |= (1 << (7 - bit)); // MSB first
            }
          }
        }

        dataBuffer[byteIndex++] = currentByte;
      }
    }

    chunks.push(header);
    chunks.push(dataBuffer);
  }

  // 5. Feed lines after if requested
  if (feedLinesAfter > 0) {
    chunks.push(Buffer.from([ESC, 0x64, Math.min(10, feedLinesAfter)]));
  }

  // 6. Reset printer back to standard text mode
  chunks.push(Buffer.from([ESC, 0x40])); // ESC @

  // 7. Paper cut if requested
  if (cutPaper) {
    chunks.push(Buffer.from([GS, 0x56, 0x42, 0x00])); // GS V 66 0 (Cut)
  }

  return Buffer.concat(chunks);
}

/**
 * Main Entry Point: Converts any uploaded image source into an ESC/POS raster buffer
 * ready to be appended to thermal receipts.
 * 
 * @param {string|Buffer} imageSource File path, Data URL, HTTP URL, or Buffer
 * @param {boolean} is2Inch Whether the printer paper width is 58mm (true) or 80mm (false)
 * @param {Object} options Configuration overrides
 * @returns {Promise<Buffer>} Complete ESC/POS raster buffer
 */
async function generateThermalImageEscposBuffer(imageSource, is2Inch = false, options = {}) {
  const {
    ditherMode = 'threshold',
    threshold = 128,
    contrast = 20,
    brightness = 0,
    feedLinesBefore = 1,
    feedLinesAfter = 2,
    cutPaper = false,
  } = options;

  // 1. Load image using Electron nativeImage
  const img = await loadToNativeImage(imageSource);
  const origSize = img.getSize();
  if (origSize.width <= 0 || origSize.height <= 0) {
    throw new Error(`Invalid image dimensions: ${origSize.width}x${origSize.height}`);
  }

  // 2. Paper roll dot width (384 for 58mm, 576 for 80mm)
  const paperDots = is2Inch ? PAPER_DOTS['58mm'] : PAPER_DOTS['80mm'];

  // 3. Aspect-ratio preserved scaling
  const aspectRatio = origSize.width / origSize.height;
  let targetImgW;

  if (is2Inch) {
    // 58mm roll: Use full 384 dots width
    targetImgW = paperDots;
  } else {
    // 80mm roll:
    // If wide image (e.g. barcode / banner): fit full 576 dots
    // If square or tall (e.g. QR code / logo): scale to 420 dots centered with clean margins
    if (aspectRatio > 1.3) {
      targetImgW = paperDots; // 576
    } else {
      targetImgW = Math.min(paperDots, 420); // 420 dots centered
    }
  }

  const targetImgH = Math.max(1, Math.round(targetImgW / aspectRatio));

  // 4. High-quality resize via Electron's Skia engine
  const resized = img.resize({
    width: targetImgW,
    height: targetImgH,
    quality: 'best',
  });

  const bmp = resized.toBitmap();

  // 5. Luminance conversion & 1-bit dithering
  const luminance = processLuminance(bmp, targetImgW, targetImgH, {
    brightness,
    contrast,
  });

  const monoPixels = applyDithering(luminance, targetImgW, targetImgH, ditherMode, threshold);

  // 6. Center image on the paper roll canvas
  // The canvas width MUST be exactly paperDots (384 or 576) so byte alignment is 100% matched to printhead
  const canvasW = paperDots;
  const canvasH = targetImgH;
  const canvasMono = new Uint8Array(canvasW * canvasH);
  canvasMono.fill(255); // Fill with white paper (255)

  const drawX = Math.max(0, Math.round((canvasW - targetImgW) / 2));

  for (let row = 0; row < targetImgH; row++) {
    const srcRowOffset = row * targetImgW;
    const destRowOffset = row * canvasW + drawX;
    for (let col = 0; col < targetImgW; col++) {
      canvasMono[destRowOffset + col] = monoPixels[srcRowOffset + col];
    }
  }

  // 7. Convert to sliced ESC/POS raster buffer
  return createEscposRasterBuffer(canvasMono, canvasW, canvasH, {
    feedLinesBefore,
    feedLinesAfter,
    cutPaper,
  });
}

module.exports = {
  generateThermalImageEscposBuffer,
  createEscposRasterBuffer,
  processLuminance,
  applyDithering,
  loadToNativeImage,
  PAPER_DOTS,
};
