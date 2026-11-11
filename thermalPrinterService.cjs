const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { ThermalPrinter, PrinterTypes, CharacterSet } = require('node-thermal-printer');
const { generateThermalImageEscposBuffer } = require('./thermalImageRaster.cjs');

/**
 * Formats a date value into dd/mm/yy, hh:mm:ss a (e.g. 12/09/26, 10:43:18 AM).
 */
function formatReceiptDateTime(dateVal) {
  const d = dateVal ? new Date(dateVal) : new Date();
  if (isNaN(d.getTime())) return '';
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = String(d.getFullYear()).slice(-2);
  const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
  return `${day}/${month}/${year}, ${timeStr}`;
}

/**
 * Checks if settings or printer specify a 2-inch (58mm) thermal paper width.
 */
function is2InchPaper(settings = {}, printerName = '') {
  const s = settings || {};
  const raw = String(s.paper_size || s.receipt_paper_size || s.paperSize || s.paper_width || 'auto').toLowerCase().trim();
  
  if (raw === '58mm' || raw === '2inch' || raw === '2"' || raw === '58' || raw === '2' || raw.includes('58') || raw.includes('2in')) {
    return true;
  }
  if (raw === '80mm' || raw === '3inch' || raw === '3"' || raw === '80' || raw === '3' || raw.includes('80') || raw.includes('3in') || raw.includes('76')) {
    return false;
  }
  
  const pName = String(printerName || s.default_printer_name || s.name || '').toLowerCase();
  if (pName.includes('58') || pName.includes('2inch') || pName.includes('xp-58') || pName.includes('pos-58') || pName.includes('zj-58') || pName.includes('rp58')) {
    return true;
  }
  return false;
}

/**
 * Safely downloads or converts an image URL / data URL to a local temporary file path.
 */
async function resolveImageToLocalFile(imageUrl) {
  if (!imageUrl || typeof imageUrl !== 'string') return { filePath: null, isTemp: false };

  const trimmed = imageUrl.trim();

  // 1. Data URL (Base64)
  if (trimmed.startsWith('data:image/')) {
    const match = trimmed.match(/^data:image\/[a-zA-Z0-9\+\-]+;base64,(.+)$/);
    if (match && match[1]) {
      const tempPath = path.join(os.tmpdir(), `ariso_qr_${Date.now()}_${Math.random().toString(36).substring(7)}.png`);
      const buffer = Buffer.from(match[1], 'base64');
      fs.writeFileSync(tempPath, buffer);
      return { filePath: tempPath, isTemp: true };
    }
  }

  // 2. HTTP / HTTPS URL
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return new Promise((resolve) => {
      try {
        const client = trimmed.startsWith('https://') ? https : http;
        const tempPath = path.join(os.tmpdir(), `ariso_dl_qr_${Date.now()}_${Math.random().toString(36).substring(7)}.png`);
        const fileStream = fs.createWriteStream(tempPath);

        const req = client.get(trimmed, { timeout: 4000 }, (res) => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            res.pipe(fileStream);
            fileStream.on('finish', () => {
              fileStream.close();
              resolve({ filePath: tempPath, isTemp: true });
            });
          } else {
            fileStream.close();
            try { fs.unlinkSync(tempPath); } catch (_) {}
            resolve({ filePath: null, isTemp: false });
          }
        });

        req.on('error', () => {
          fileStream.close();
          try { fs.unlinkSync(tempPath); } catch (_) {}
          resolve({ filePath: null, isTemp: false });
        });

        req.on('timeout', () => {
          req.destroy();
          fileStream.close();
          try { fs.unlinkSync(tempPath); } catch (_) {}
          resolve({ filePath: null, isTemp: false });
        });
      } catch (_) {
        resolve({ filePath: null, isTemp: false });
      }
    });
  }

  // 3. Local Absolute File Path
  if (fs.existsSync(trimmed)) {
    return { filePath: trimmed, isTemp: false };
  }

  return { filePath: null, isTemp: false };
}

/**
 * Builds standard, production-grade ESC/POS receipt binary buffer using node-thermal-printer
 * with a mandatory safe fallback boundary around the QR/Barcode image block.
 */
async function buildThermalReceiptBuffer(order = {}, items = [], restaurant = {}, receiptSettings = {}) {
  const s = receiptSettings || {};
  const is2Inch = is2InchPaper(s);
  const cols = is2Inch ? 32 : 42;
  const divider = '-'.repeat(cols);
  const doubleDivider = '='.repeat(cols);
  const isGstEnabled = s.gst_enabled === 1 || s.gst_enabled === true || s.gst_enabled === 'true';

  const printer = new ThermalPrinter({
    type: PrinterTypes.EPSON,
    characterSet: CharacterSet.PC437_USA,
    width: cols,
    removeSpecialCharacters: false
  });

  // 1. Header (Store Title & Details)
  printer.alignCenter();
  printer.bold(true);
  if (!is2Inch) {
    printer.setTextDoubleHeight();
    printer.setTextDoubleWidth();
  }
  const storeName = (s.restaurant_name || restaurant.name || 'ARISO RETAIL STORE').toUpperCase();
  printer.println(storeName);
  printer.setTextNormal();
  printer.bold(false);

  if (s.branch_name) printer.println(s.branch_name);
  const addr = s.address !== undefined ? s.address : restaurant.address;
  if (addr) printer.println(addr);
  const phone = s.phone !== undefined ? s.phone : restaurant.phone;
  if (phone) printer.println(`Ph: ${phone}`);
  const gstin = s.gst_number !== undefined ? s.gst_number : restaurant.gst_number;
  if (gstin) printer.println(`GSTIN: ${gstin}`);
  const headerWelcome = s.header_message || restaurant.header_message;
  if (headerWelcome) printer.println(`* ${headerWelcome} *`);

  printer.println(doubleDivider);

  // 2. Order Metadata (No Payment Method line, Date formatted as dd/mm/yy)
  printer.alignLeft();
  const invoiceNo = order.unique_order_number || order.offline_id || 'LOCAL-POS';
  printer.println(`Bill No : #${invoiceNo}`);
  printer.println(`Date    : ${formatReceiptDateTime(order.created_at)}`);
  if (order.customer_name && order.customer_name !== 'Walk-in Customer') {
    printer.println(`Customer: ${order.customer_name}`);
  }
  if (order.is_duplicate || (order.reprint_count && order.reprint_count > 0)) {
    printer.alignCenter();
    printer.bold(true);
    printer.println(`*** DUPLICATE RECEIPT (REPRINT #${order.reprint_count || 1}) ***`);
    printer.bold(false);
    printer.alignLeft();
  }
  printer.println(divider);

  const showMrpSavings = s.show_mrp_savings !== 0 && s.show_mrp_savings !== false && s.show_mrp_savings !== '0' && s.show_mrp_savings !== 'false';

  const safeItems = Array.isArray(items) ? items : [];
  let itemsSavingSum = 0;
  safeItems.forEach((item) => {
    const price = parseFloat(item.price || item.unit_price || 0);
    const qty = item.is_weight_based ? (parseFloat(item.item_weight) || 1) : (parseFloat(item.quantity ?? item.qty ?? 1) || 1);
    const rawMrp = item.mrp !== undefined && item.mrp !== null ? parseFloat(item.mrp) : price;
    const effectiveMrp = (!isNaN(rawMrp) && rawMrp > price) ? rawMrp : price;
    itemsSavingSum += Math.max(0, effectiveMrp - price) * qty;
  });
  const totalYouSaved = itemsSavingSum + (parseFloat(order.discount_amount || 0) || 0);

  // 3. Items Column Header
  if (showMrpSavings && !is2Inch) {
    printer.println('SN ITEM         QTY    MRP  PRICE AMOUNT');
  } else if (is2Inch) {
    printer.println('Item Description          Amount');
  } else {
    printer.println('Item Description       Qty   Rate  Total');
  }
  printer.println(divider);

  // 4. Print Items
  safeItems.forEach((item, idx) => {
    const isWeight = !!item.is_weight_based;
    const qtyStr = isWeight ? `${item.item_weight} ${item.weight_unit || 'kg'}` : `${item.quantity || 1}`;
    const priceVal = parseFloat(item.price || item.unit_price || 0);
    const rawMrp = item.mrp !== undefined && item.mrp !== null ? parseFloat(item.mrp) : priceVal;
    const mrpVal = (!isNaN(rawMrp) && rawMrp > priceVal) ? rawMrp : priceVal;
    const totalVal = parseFloat(item.total_price || (priceVal * (item.quantity || 1)));

    const rateStr = priceVal.toFixed(2);
    const mrpStr = mrpVal.toFixed(2);
    const totalStr = totalVal.toFixed(2);

    if (showMrpSavings && !is2Inch) {
      const snStr = String(idx + 1).padEnd(3, ' ');
      let nameStr = item.name || 'Item';
      if (nameStr.length > 12) {
        printer.println(`${snStr}${nameStr}`);
        printer.println(`   `.padEnd(16, ' ') +
                        `${qtyStr.padStart(4, ' ')} ` +
                        `${mrpStr.padStart(6, ' ')} ` +
                        `${rateStr.padStart(6, ' ')} ` +
                        `${totalStr.padStart(7, ' ')}`);
      } else {
        const namePart = nameStr.padEnd(13, ' ');
        printer.println(`${snStr}${namePart}${qtyStr.padStart(4, ' ')} ${mrpStr.padStart(6, ' ')} ${rateStr.padStart(6, ' ')} ${totalStr.padStart(7, ' ')}`);
      }
      if (item.sku) printer.println(`  SKU: ${item.sku}`);
      if (item.serial_number) printer.println(`  SN: ${item.serial_number}`);
    } else if (is2Inch) {
      let nameStr = item.name || 'Item';
      if (nameStr.length > 18) nameStr = nameStr.substring(0, 18);
      const totalPart = `Rs.${totalStr}`;
      const spaces = ' '.repeat(Math.max(1, cols - nameStr.length - totalPart.length));
      printer.println(`${nameStr}${spaces}${totalPart}`);
      if (showMrpSavings && mrpVal > priceVal) {
        printer.println(`  Qty: ${qtyStr} @ Rs.${rateStr} [MRP Rs.${mrpStr}]` + (item.sku ? ` [${item.sku}]` : ''));
      } else {
        printer.println(`  Qty: ${qtyStr} @ Rs.${rateStr}` + (item.sku ? ` [${item.sku}]` : ''));
      }
      if (item.serial_number) printer.println(`  SN: ${item.serial_number}`);
    } else {
      let nameStr = item.name || 'Item';
      if (nameStr.length > 20) {
        nameStr = nameStr.substring(0, 20);
      }
      const namePart = nameStr.padEnd(20, ' ');
      const qtyPart = qtyStr.padStart(5, ' ');
      const ratePart = rateStr.padStart(8, ' ');
      const amtPart = totalStr.padStart(8, ' ');
      let line = `${namePart} ${qtyPart} ${ratePart} ${amtPart}`;
      if (line.length > cols) line = line.substring(0, cols);
      printer.println(line);
      if (item.sku) {
        printer.println(`  SKU: ${item.sku}`);
      }
      if (item.serial_number) {
        printer.println(`  SN: ${item.serial_number}`);
      }
    }
  });
  printer.println(divider);

  // 5. Total Items & Total Quantity
  const totalItemsCount = safeItems.length;
  const totalQtySum = safeItems.reduce((sum, it) => sum + (it.is_weight_based ? parseFloat(it.item_weight || 1) : (parseFloat(it.quantity ?? it.qty ?? 1) || 1)), 0);
  const formattedQty = totalQtySum % 1 === 0 ? totalQtySum : parseFloat(totalQtySum.toFixed(3));
  printer.println(`Total Items: ${totalItemsCount} | Total Qty: ${formattedQty}`);

  // 6. Subtotal, Discount, GST
  const subtotalVal = parseFloat(order.subtotal || 0).toFixed(2);
  const discountVal = parseFloat(order.discount_amount || 0).toFixed(2);
  const taxVal = parseFloat(order.tax_amount || 0).toFixed(2);
  const grandTotalVal = parseFloat(order.total_amount || 0).toFixed(2);

  printer.println(`Subtotal:`.padEnd(cols - 14, ' ') + `Rs.${subtotalVal}`.padStart(14, ' '));
  if (parseFloat(discountVal) > 0) {
    printer.println(`Discount:`.padEnd(cols - 14, ' ') + `-Rs.${discountVal}`.padStart(14, ' '));
  }

  if (isGstEnabled && parseFloat(taxVal) > 0) {
    if (order.tax_type === 'inter') {
      printer.println(`IGST:`.padEnd(cols - 14, ' ') + `Rs.${taxVal}`.padStart(14, ' '));
    } else {
      const cgstVal = order.cgst_amount !== undefined && order.cgst_amount !== null
        ? parseFloat(order.cgst_amount).toFixed(2)
        : (parseFloat(taxVal) / 2).toFixed(2);
      const sgstVal = order.sgst_amount !== undefined && order.sgst_amount !== null
        ? parseFloat(order.sgst_amount).toFixed(2)
        : (parseFloat(taxVal) / 2).toFixed(2);
      printer.println(`CGST:`.padEnd(cols - 14, ' ') + `Rs.${cgstVal}`.padStart(14, ' '));
      printer.println(`SGST:`.padEnd(cols - 14, ' ') + `Rs.${sgstVal}`.padStart(14, ' '));
    }
  }
  printer.println(doubleDivider);

  // 7. Grand Total
  printer.bold(true);
  if (!is2Inch) {
    printer.setTextDoubleHeight();
    printer.println(`TOTAL:`.padEnd(cols - 14, ' ') + `Rs.${grandTotalVal}`.padStart(14, ' '));
    printer.setTextNormal();
  } else {
    printer.println(`TOTAL:`.padEnd(cols - 14, ' ') + `Rs.${grandTotalVal}`.padStart(14, ' '));
  }
  printer.bold(false);

  if (showMrpSavings && totalYouSaved > 0) {
    printer.println(doubleDivider);
    printer.bold(true);
    printer.println(`You Saved (Rs.): ${totalYouSaved.toFixed(2)}`);
    printer.bold(false);
  }
  printer.println(doubleDivider);

  // 8. Footer Messages
  printer.alignCenter();
  const thankYouMsg = (s.thank_you_message !== undefined ? s.thank_you_message : (restaurant.thank_you_message || 'Thank You! Visit Again.') || '').trim();
  if (thankYouMsg) printer.println(thankYouMsg);
  const footerMsg = (s.footer_message || restaurant.footer_message || '').trim();
  if (footerMsg) printer.println(footerMsg);

  const rawTerms = s.terms_conditions !== undefined ? s.terms_conditions : (s.terms_and_conditions !== undefined ? s.terms_and_conditions : (restaurant.terms_conditions || ''));
  const terms = (rawTerms || '').trim();
  if (terms) {
    printer.println(divider);
    printer.println(`T&C: ${terms}`);
  }

  // 9. Extract completed text receipt buffer
  const textBuffer = printer.getBuffer();
  const chunks = [textBuffer];

  // 10. MANDATORY ISOLATED QR / BARCODE IMAGE BLOCK WITH SAFE ERROR BOUNDARY
  // Ported from proven working reference implementation at D:\Image Print
  const showQrToggle = s.show_qr_code === 1 || s.show_qr_code === true || s.show_qr_code === '1' || s.show_qr_code === 'true';
  const qrImageSource = s.qr_code_url || order.qr_code_url;

  if (showQrToggle && qrImageSource) {
    try {
      const imageRasterBuffer = await generateThermalImageEscposBuffer(qrImageSource, is2Inch, {
        feedLinesBefore: 1,
        feedLinesAfter: 2,
        cutPaper: false,
      });

      if (imageRasterBuffer && imageRasterBuffer.length > 0) {
        chunks.push(imageRasterBuffer);
      }
    } catch (imgErr) {
      // SAFE FALLBACK: Never let an image decoding/raster error interrupt or corrupt receipt printing
      console.warn('[QR Block Safe Fallback] Warning during image rasterization, proceeding cleanly with text receipt:', imgErr?.message);
    }
  }

  // 11. Hardware Auto-Cut
  // Feed 3 lines so content clears cutter blade, then trigger partial cut (GS V 66 0)
  const cutBuffer = Buffer.from([0x1B, 0x64, 0x03, 0x1D, 0x56, 0x42, 0x00]);
  chunks.push(cutBuffer);

  return Buffer.concat(chunks);
}

/**
 * Builds standard ESC/POS KOT binary buffer using node-thermal-printer
 */
async function buildThermalKotBuffer(order = {}, items = [], kotSettings = {}) {
  const s = kotSettings || {};
  const is2Inch = is2InchPaper(s);
  const cols = is2Inch ? 32 : 42;
  const divider = '-'.repeat(cols);
  const doubleDivider = '='.repeat(cols);

  const printer = new ThermalPrinter({
    type: PrinterTypes.EPSON,
    characterSet: CharacterSet.PC437_USA,
    width: cols,
    removeSpecialCharacters: false
  });

  printer.alignCenter();
  printer.bold(true);
  printer.setTextDoubleHeight();
  printer.println('*** KITCHEN ORDER TICKET ***');
  printer.setTextNormal();
  printer.bold(false);
  printer.println(doubleDivider);

  printer.alignLeft();
  const invoiceNo = order.unique_order_number || order.offline_id || 'LOCAL-POS';
  printer.println(`KOT Order #: ${invoiceNo}`);
  printer.println(`Date/Time  : ${formatReceiptDateTime(order.created_at)}`);
  if (order.table_number || order.table_name) {
    printer.bold(true);
    printer.println(`TABLE: ${order.table_number || order.table_name}`);
    printer.bold(false);
  }
  printer.println(divider);

  printer.println('Item Description'.padEnd(cols - 8, ' ') + 'Qty'.padStart(8, ' '));
  printer.println(divider);

  const safeItems = Array.isArray(items) ? items : [];
  safeItems.forEach((item) => {
    const qtyStr = item.is_weight_based ? `${item.item_weight} ${item.weight_unit || 'kg'}` : `x${item.quantity || 1}`;
    printer.bold(true);
    printer.println(String(item.name || 'Item').padEnd(cols - 8, ' ') + qtyStr.padStart(8, ' '));
    printer.bold(false);
    if (item.notes) {
      printer.println(`  * Note: ${item.notes}`);
    }
  });

  printer.println(doubleDivider);
  printer.newLine();
  printer.newLine();
  printer.cut();

  return printer.getBuffer();
}

module.exports = {
  buildThermalReceiptBuffer,
  buildThermalKotBuffer,
  formatReceiptDateTime,
  is2InchPaper,
  resolveImageToLocalFile
};
