"use strict";

/* ---------------------------------------------------------------------
 * POS Ninja Scanner Typing Utility
 *
 * Generates QR codes that a 2D barcode scanner (running in "keyboard
 * wedge" mode) can read and type directly into the POS Ninja app, with
 * no on-screen keyboard needed. Scanners of this kind emulate a physical
 * keyboard: they type out whatever text the QR code encodes and then
 * send an Enter/Return keystroke.
 *
 * Two modes:
 *   1. Plain Text  — the QR simply encodes whatever was typed here.
 *   2. Item Import — the QR encodes a compact, prefixed JSON payload
 *      that the POS Ninja app recognizes and turns into a brand-new
 *      inventory item automatically.
 *
 * Item Import payload format (kept intentionally tiny — it has to fit
 * comfortably, and scan reliably, in a QR code):
 *
 *   POSN1I:{"n":"<name>","q":<quantity>,"p":<unitPrice>,"c":<unitCost?>,"no":"<notes?>"}
 *
 *     n  - name       (required, string, 1-100 chars)
 *     q  - quantity   (required, integer, 0-999999)
 *     p  - unit price (required, number, >= 0)
 *     c  - unit cost  (optional, number, >= 0 — key omitted if blank)
 *     no - notes      (optional, string, up to 500 chars — omitted if blank)
 *
 * IMPORTANT: this page does basic client-side validation for a better
 * authoring experience, but the app must treat every scanned code as
 * untrusted input and re-validate/sanitize everything itself before it
 * ever touches the database — a QR code could come from anywhere, not
 * just this page. See ScannerInputService on the app side.
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
    correctLevel: QRCode.CorrectLevel.M,
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
  qrCode.makeCode(payload);
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
    showError("Type something first.");
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
    showError("Name is required.");
    return;
  }

  const quantity = parseInt(qtyRaw, 10);
  if (!Number.isFinite(quantity) || quantity < 0 || quantity > 999999) {
    showError("Quantity must be a whole number between 0 and 999999.");
    return;
  }

  const unitPrice = parseFloat(priceRaw);
  if (!Number.isFinite(unitPrice) || unitPrice < 0) {
    showError("Unit price must be a number of 0 or more.");
    return;
  }

  const payloadObj = { n: name, q: quantity, p: unitPrice };

  if (costRaw.trim() !== "") {
    const unitCost = parseFloat(costRaw);
    if (!Number.isFinite(unitCost) || unitCost < 0) {
      showError("Unit cost must be a number of 0 or more, or left blank.");
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
    btn.textContent = "Copied!";
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
