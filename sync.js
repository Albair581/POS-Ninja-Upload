"use strict";

/* ---------------------------------------------------------------------
 * POS Ninja Device Sync — website side
 * 裝置同步（網站端）
 *
 * Pairs this browser with a POS Ninja install using a short one-time
 * code, then remembers the resulting sync token in localStorage so the
 * pairing never has to be repeated. From then on this page talks to the
 * token directly: list/download files the app pushed (inventory,
 * products, analytics exports), and push an .xlsx file back for the app
 * to import.
 *
 * See server_route/pos_sync.ts on the backend for the full contract.
 * Nothing here ever sees or needs the pairing code again once claimed —
 * that's the whole point of splitting "pairing code" from "sync token".
 * ------------------------------------------------------------------- */

const SYNC_API_BASE = "https://api.food-ninja.com";
const SYNC_TOKEN_KEY = "pos_ninja_sync_token";
const REFRESH_INTERVAL_MS = 30000;

const SYNC_KINDS = [
  { kind: "inventory_xlsx", containerId: "sync-kind-inventory" },
  { kind: "products_xlsx", containerId: "sync-kind-products" },
  { kind: "analytics_xlsx", containerId: "sync-kind-analytics" },
];

let refreshTimer = null;

function $(id) {
  return document.getElementById(id);
}

function getToken() {
  return localStorage.getItem(SYNC_TOKEN_KEY);
}

function setToken(token) {
  localStorage.setItem(SYNC_TOKEN_KEY, token);
}

function clearToken() {
  localStorage.removeItem(SYNC_TOKEN_KEY);
}

/* --- API calls --------------------------------------------------------- */

async function apiClaimCode(code) {
  const res = await fetch(`${SYNC_API_BASE}/api/pos/sync/pair/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `request_failed_${res.status}`);
  return data.syncToken;
}

async function apiListFiles(token) {
  const res = await fetch(`${SYNC_API_BASE}/api/pos/sync/files?token=${encodeURIComponent(token)}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `request_failed_${res.status}`);
  return data.files || [];
}

async function apiPushToApp(token, file) {
  const form = new FormData();
  form.append("kind", "import_xlsx");
  form.append("file", file, file.name);
  const res = await fetch(
    `${SYNC_API_BASE}/api/pos/sync/files/push-to-app?token=${encodeURIComponent(token)}`,
    { method: "POST", body: form },
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `request_failed_${res.status}`);
  return data;
}

async function apiUnlink(token) {
  const res = await fetch(`${SYNC_API_BASE}/api/pos/sync/unlink`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ syncToken: token }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `request_failed_${res.status}`);
  }
}

/**
 * Not fetched with JS — used as a plain <a href> so the browser follows
 * the server's 302 straight to the presigned storage URL and downloads
 * the file (the server sets Content-Disposition: attachment), without
 * this page ever needing CORS access to that storage provider itself.
 * This is a full page navigation, not a fetch()/XHR call, so browser
 * CORS restrictions on cross-origin redirects never come into play here
 * — unlike the app's own pending-file download, which does go through
 * fetch() and is proxied server-side for exactly that reason.
 */
function downloadHref(token, kind) {
  return `${SYNC_API_BASE}/api/pos/sync/files/download?token=${encodeURIComponent(token)}&kind=${encodeURIComponent(kind)}`;
}

/* --- View switching ----------------------------------------------------- */

function showConnectView() {
  $("sync-connect-view").classList.remove("hidden");
  $("sync-dashboard-view").classList.add("hidden");
  stopAutoRefresh();
}

function showDashboardView() {
  $("sync-connect-view").classList.add("hidden");
  $("sync-dashboard-view").classList.remove("hidden");
}

/* --- Error messages ------------------------------------------------------*/

function friendlyError(err) {
  const msg = String((err && err.message) || err);
  if (msg.includes("invalid_or_expired_code")) {
    return "That code is invalid or has expired. Generate a new one in the app. 此代碼無效或已過期，請在應用程式中重新產生。";
  }
  if (msg.includes("invalid_or_revoked_token")) {
    return "This device is no longer linked. Pair again with a new code. 此裝置已取消連結，請使用新代碼重新配對。";
  }
  if (msg.includes("Failed to fetch") || msg.includes("NetworkError")) {
    return "Couldn't reach the server. Check your connection and try again. 無法連線至伺服器，請檢查網路連線後再試一次。";
  }
  return `Something went wrong: ${msg}`;
}

/* --- Connect flow ---------------------------------------------------------*/

function normalizeCodeInput(raw) {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

async function handleConnect() {
  const input = $("sync-code-input");
  const errorEl = $("sync-connect-error");
  const btn = $("sync-connect-btn");
  errorEl.textContent = "";

  const code = normalizeCodeInput(input.value);
  if (code.length !== 8) {
    errorEl.textContent = "Enter the 8-character code shown in the app. 請輸入應用程式顯示的 8 碼代碼。";
    return;
  }

  btn.disabled = true;
  btn.textContent = "Connecting… 連接中…";
  try {
    const token = await apiClaimCode(code);
    setToken(token);
    input.value = "";
    showDashboardView();
    await refreshFiles();
    startAutoRefresh();
  } catch (err) {
    errorEl.textContent = friendlyError(err);
  } finally {
    btn.disabled = false;
    btn.textContent = "Connect 連接";
  }
}

/* --- Dashboard: file list --------------------------------------------------*/

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatRelativeExpiry(expiresAtIso) {
  const ms = new Date(expiresAtIso).getTime() - Date.now();
  if (ms <= 0) return "expired 已過期";
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "expires in under a minute 即將過期";
  return `expires in ${minutes} min 剩餘 ${minutes} 分鐘`;
}

function renderFileCard(container, fileInfo) {
  container.innerHTML = "";
  const token = getToken();

  if (!fileInfo || !token) {
    const p = document.createElement("p");
    p.className = "sync-file-empty";
    p.textContent = "Not synced yet. 尚未同步。";
    container.appendChild(p);
    return;
  }

  const meta = document.createElement("p");
  meta.className = "sync-file-meta";
  meta.textContent = `${formatBytes(fileInfo.sizeBytes)} · ${formatRelativeExpiry(fileInfo.expiresAt)}`;
  container.appendChild(meta);

  const link = document.createElement("a");
  link.className = "secondary-btn sync-download-btn";
  link.href = downloadHref(token, fileInfo.kind);
  link.rel = "noopener";
  link.textContent = "Download 下載";
  container.appendChild(link);
}

async function refreshFiles() {
  const token = getToken();
  if (!token) return;
  try {
    const files = await apiListFiles(token);
    const byKind = {};
    for (const f of files) byKind[f.kind] = f;
    for (const { kind, containerId } of SYNC_KINDS) {
      renderFileCard($(containerId), byKind[kind] || null);
    }
    $("sync-dashboard-error").textContent = "";
  } catch (err) {
    $("sync-dashboard-error").textContent = friendlyError(err);
  }
}

function startAutoRefresh() {
  stopAutoRefresh();
  refreshTimer = setInterval(refreshFiles, REFRESH_INTERVAL_MS);
}

function stopAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
}

/* --- Dashboard: upload to app ----------------------------------------------*/

async function handleUpload() {
  const input = $("sync-upload-input");
  const status = $("sync-upload-status");
  const btn = $("sync-upload-btn");
  status.textContent = "";
  status.classList.remove("sync-upload-success");

  const file = input.files && input.files[0];
  if (!file) {
    status.textContent = "Choose an .xlsx file first. 請先選擇 .xlsx 檔案。";
    return;
  }
  if (!file.name.toLowerCase().endsWith(".xlsx")) {
    status.textContent = "Only .xlsx files are supported. 僅支援 .xlsx 檔案。";
    return;
  }

  btn.disabled = true;
  btn.textContent = "Uploading… 上傳中…";
  try {
    const token = getToken();
    await apiPushToApp(token, file);
    status.textContent =
      'Sent! Open POS Ninja and tap "Import from Website" in the Excel import dialog. ' +
      "已傳送！請在 POS Ninja 開啟 Excel 匯入視窗並點選「從網站匯入」。";
    status.classList.add("sync-upload-success");
    input.value = "";
  } catch (err) {
    status.textContent = friendlyError(err);
  } finally {
    btn.disabled = false;
    btn.textContent = "Upload to POS Ninja 上傳至 POS Ninja";
  }
}

/* --- Dashboard: disconnect --------------------------------------------------*/

async function handleDisconnect() {
  const btn = $("sync-disconnect-btn");
  const token = getToken();
  if (!token) {
    showConnectView();
    return;
  }
  const confirmed = window.confirm(
    "Disconnect this website from POS Ninja? This also clears any files currently waiting to transfer.\n" +
      "取消此網站與 POS Ninja 的連結？這也會清除任何等待傳輸中的檔案。",
  );
  if (!confirmed) return;

  btn.disabled = true;
  try {
    await apiUnlink(token);
  } catch (_) {
    // Even if the server call fails (e.g. offline), forget the token
    // locally — there's nothing useful this browser can still do with a
    // token it now believes should be revoked.
  } finally {
    clearToken();
    btn.disabled = false;
    showConnectView();
  }
}

/* --- Blank import template (no pairing required) ----------------------------*/
//
// Mirrors ExcelImportService.buildTemplate() on the app side exactly —
// same header text, same column order, and (as of this version) the
// same rule: headers are always a single language at a time, drawn
// verbatim from the app's recognized alias list. An earlier version of
// this template used combined bilingual headers like "ID (編號)", which
// looked helpful but didn't exactly match any alias the app's parser
// checks against — so a template downloaded, filled in, and re-imported
// unmodified would silently fail to match any column. Pick one language
// and both sides agree on it.

const TEMPLATE_HEADERS = {
  en: ["ID", "Name", "Quantity", "Unit Price", "Unit Cost", "Notes"],
  zh: ["編號", "名稱", "數量", "單價", "單位成本", "備註"],
};

function getTemplateLang() {
  const checked = document.querySelector('input[name="template-lang"]:checked');
  return checked ? checked.value : "en";
}

function downloadImportTemplate() {
  const lang = getTemplateLang();
  const headers = TEMPLATE_HEADERS[lang] || TEMPLATE_HEADERS.en;
  const worksheet = XLSX.utils.aoa_to_sheet([headers]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, lang === "zh" ? "範本" : "Template");
  XLSX.writeFile(workbook, lang === "zh" ? "庫存匯入範本.xlsx" : "inventory_import_template.xlsx");
}

/** Defaults the language radio to match the visitor's browser language,
 * so most people never have to touch it — still fully overridable. */
function initTemplateLangDefault() {
  const prefersChinese = (navigator.language || "").toLowerCase().startsWith("zh");
  const target = document.querySelector(
    `input[name="template-lang"][value="${prefersChinese ? "zh" : "en"}"]`,
  );
  if (target) target.checked = true;
}

/* --- Wiring -------------------------------------------------------------- */

window.addEventListener("DOMContentLoaded", () => {
  initTemplateLangDefault();
  $("sync-template-btn").addEventListener("click", downloadImportTemplate);

  $("sync-connect-btn").addEventListener("click", handleConnect);
  $("sync-code-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleConnect();
  });

  $("sync-refresh-btn").addEventListener("click", refreshFiles);
  $("sync-upload-btn").addEventListener("click", handleUpload);
  $("sync-disconnect-btn").addEventListener("click", handleDisconnect);

  if (getToken()) {
    showDashboardView();
    refreshFiles();
    startAutoRefresh();
  } else {
    showConnectView();
  }
});
