"use strict";

/* ---------------------------------------------------------------------
 * POS Ninja Scanner Typing Utility 掃瞄器打字工具
 *
 * Generates QR codes that a 2D barcode scanner (running in "keyboard
 * wedge" mode) can read and type directly into the POS Ninja app, with
 * no on-screen keyboard needed. Scanners of this kind emulate a physical
 * keyboard: they type out whatever text the QR code encodes and then
 * send an Enter/Return keystroke.
 * 本工具產生的 QR 碼可讓「鍵盤模擬模式」的二維條碼掃描器直接讀取並輸入到
 * POS Ninja，完全不需要螢幕鍵盤。這類掃描器會模擬實體鍵盤：掃描 QR 碼會
 * 將其內容逐字輸入，並在最後送出一個 Enter 鍵。
 *
 * Two modes 兩種模式：
 *   1. Plain Text 純文字 — the QR simply encodes whatever was typed here.
 *      QR 碼會直接編碼您所輸入的文字內容。
 *   2. Item Import 庫存項目創建 — the QR encodes a compact, prefixed JSON
 *      payload that the POS Ninja app recognizes and turns into a
 *      brand-new inventory item automatically.
 *      QR 碼會編碼一段附有前綴、精簡的 JSON 內容，POS Ninja 應用程式會
 *      辨識並自動建立一筆新的庫存項目。
 *
 * Item Import payload format 庫存項目創建的內容格式 (kept intentionally
 * tiny — it has to fit comfortably, and scan reliably, in a QR code):
 *
 *   POSN1I:{"n":"<name>","q":<quantity>,"p":<unitPrice>,"c":<unitCost?>,"no":"<notes?>"}
 *
 *     n  - name 名稱       (required, string, 1-100 chars)
 *     q  - quantity 數量   (required, integer, 0-999999)
 *     p  - unit price 單價 (required, number, >= 0)
 *     c  - unit cost 成本  (optional, number, >= 0 — key omitted if blank)
 *     no - notes 備註      (optional, string, up to 500 chars — omitted if blank)
 *
 * IMPORTANT: this page does basic client-side validation for a better
 * authoring experience, but the app must treat every scanned code as
 * untrusted input and re-validate/sanitize everything itself before it
 * ever touches the database — a QR code could come from anywhere, not
 * just this page. See ScannerInputService on the app side.
 * 重要：本頁面僅做基本的前端驗證方便使用，實際的 App 端必須將每一筆掃描
 * 到的內容視為不可信任的輸入，在寫入資料庫前重新驗證與清理——因為 QR 碼
 * 可能來自任何地方，不一定是本頁面產生的。請參考 App 端的
 * ScannerInputService。
 * ------------------------------------------------------------------- */

const ITEM_IMPORT_PREFIX = "POSN1I:";
const MAX_TEXT_LEN = 500;
const MAX_NAME_LEN = 100;
const MAX_NOTES_LEN = 500;

let qrCode = null;

function $(id) {
  return document.getElementById(id);
}

function initQrCode() {
  qrCode = new QRCode($("qrcode"), {
    text: " ",
    width: 280,
    height: 280,
    correctLevel: QRCode.CorrectLevel.L,
  });
}

/** Strips control characters that a keyboard-wedge scanner shouldn't type. */
function stripControlChars(str) {
  return str.replace(/[\x00-\x1F\x7F]/g, "");
}

/** Removes angle brackets — defense against markup injection downstream. */
function stripAngleBrackets(str) {
  return str.replace(/[<>]/g, "");
}

/**
 * Prevents CSV/Excel formula injection: if a value starts with a
 * character a spreadsheet would interpret as the start of a formula,
 * prefix it with a single quote so it's always treated as plain text
 * wherever it later gets exported (the app also does this again itself).
 */
function neutralizeFormulaPrefix(str) {
  if (/^[=+\-@\t\r]/.test(str)) {
    return "'" + str;
  }
  return str;
}

function sanitizeField(str, maxLen) {
  let s = stripAngleBrackets(stripControlChars(str)).trim();
  if (s.length > maxLen) s = s.slice(0, maxLen);
  return neutralizeFormulaPrefix(s);
}

function setMode(mode) {
  const isText = mode === "text";
  $("mode-text-btn").classList.toggle("active", isText);
  $("mode-item-btn").classList.toggle("active", !isText);
  $("panel-text").classList.toggle("hidden", !isText);
  $("panel-item").classList.toggle("hidden", isText);
  clearOutput();
}

function clearOutput() {
  $("payload-preview").textContent = "";
  $("output-section").classList.add("hidden");
  $("form-error").textContent = "";
}

function renderQr(payload) {
  qrCode.clear();
  qrCode.makeCode(encodeURIComponent(payload));
  $("payload-preview").textContent = payload;
  $("output-section").classList.remove("hidden");
  $("form-error").textContent = "";
}

function showError(message) {
  $("output-section").classList.add("hidden");
  $("form-error").textContent = message;
}

function generateTextQr() {
  const raw = $("text-input").value;
  if (!raw.trim()) {
    showError("Type something first. 請先輸入文字。");
    return;
  }
  // Newlines/tabs would be typed as Enter/Tab keystrokes by the scanner,
  // which could unexpectedly submit forms or jump fields inside the POS
  // app — so plain-text mode is kept to a single line.
  const cleaned = stripControlChars(raw).slice(0, MAX_TEXT_LEN);
  renderQr(cleaned);
}

function generateItemQr() {
  const name = sanitizeField($("item-name").value, MAX_NAME_LEN);
  const qtyRaw = $("item-qty").value;
  const priceRaw = $("item-price").value;
  const costRaw = $("item-cost").value;
  const notesRaw = $("item-notes").value;

  if (!name) {
    showError("Name is required. 請輸入名稱。");
    return;
  }

  const quantity = parseInt(qtyRaw, 10);
  if (!Number.isFinite(quantity) || quantity < 0 || quantity > 999999) {
    showError("Quantity must be a whole number between 0 and 999999. 數量須為 0 至 999999 之間的整數。");
    return;
  }

  const unitPrice = parseFloat(priceRaw);
  if (!Number.isFinite(unitPrice) || unitPrice < 0) {
    showError("Unit price must be a number of 0 or more. 單價須為 0 或以上的數字。");
    return;
  }

  const payloadObj = { n: name, q: quantity, p: unitPrice };

  if (costRaw.trim() !== "") {
    const unitCost = parseFloat(costRaw);
    if (!Number.isFinite(unitCost) || unitCost < 0) {
      showError("Unit cost must be a number of 0 or more, or left blank. 成本須為 0 或以上的數字，或留空。");
      return;
    }
    payloadObj.c = unitCost;
  }

  const notes = sanitizeField(notesRaw, MAX_NOTES_LEN);
  if (notes) {
    payloadObj.no = notes;
  }

  // Deliberately compact (no extra whitespace) — every byte counts
  // toward QR density and scan reliability.
  const payload = ITEM_IMPORT_PREFIX + JSON.stringify(payloadObj);
  renderQr(payload);
}

function copyPayload() {
  const text = $("payload-preview").textContent;
  if (!text) return;
  navigator.clipboard.writeText(text).then(() => {
    const btn = $("copy-btn");
    const original = btn.textContent;
    btn.textContent = "Copied! 已複製！";
    setTimeout(() => (btn.textContent = original), 1200);
  });
}

function downloadQr() {
  const canvas = $("qrcode").querySelector("canvas");
  if (!canvas) return;
  const link = document.createElement("a");
  link.download = "pos-ninja-scan.png";
  link.href = canvas.toDataURL("image/png");
  link.click();
}

window.addEventListener("DOMContentLoaded", () => {
  initQrCode();
  setMode("text");

  $("mode-text-btn").addEventListener("click", () => setMode("text"));
  $("mode-item-btn").addEventListener("click", () => setMode("item"));
  $("generate-text-btn").addEventListener("click", generateTextQr);
  $("generate-item-btn").addEventListener("click", generateItemQr);
  $("copy-btn").addEventListener("click", copyPayload);
  $("download-btn").addEventListener("click", downloadQr);
});
