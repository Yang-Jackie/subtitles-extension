const OVERLAY_ID = "dg-live-subtitles-overlay";
const CLEAR_DELAY_MS = 3000;

let overlayRoot = null;
let finalLine = "";
let interimLine = "";
let clearTimer = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message?.type) {
    case "ping":
      sendResponse({ ok: true });
      return false;
    case "subtitle_update":
      renderSubtitle(message);
      sendResponse({ ok: true });
      return false;
    case "subtitle_clear":
      clearSubtitle(true);
      sendResponse({ ok: true });
      return false;
    default:
      return false;
  }
});

ensureOverlay();

function ensureOverlay() {
  if (overlayRoot?.isConnected) {
    return overlayRoot;
  }

  overlayRoot = document.getElementById(OVERLAY_ID);
  if (overlayRoot) {
    return overlayRoot;
  }

  overlayRoot = document.createElement("div");
  overlayRoot.id = OVERLAY_ID;
  overlayRoot.style.position = "fixed";
  overlayRoot.style.left = "50%";
  overlayRoot.style.bottom = "6vh";
  overlayRoot.style.transform = "translateX(-50%)";
  overlayRoot.style.maxWidth = "min(80vw, 960px)";
  overlayRoot.style.padding = "14px 18px";
  overlayRoot.style.borderRadius = "14px";
  overlayRoot.style.background = "rgba(0, 0, 0, 0.72)";
  overlayRoot.style.color = "#ffffff";
  overlayRoot.style.fontFamily = "'Segoe UI', Arial, sans-serif";
  overlayRoot.style.fontSize = "24px";
  overlayRoot.style.lineHeight = "1.35";
  overlayRoot.style.textAlign = "center";
  overlayRoot.style.zIndex = "999999";
  overlayRoot.style.pointerEvents = "none";
  overlayRoot.style.whiteSpace = "pre-wrap";
  overlayRoot.style.wordBreak = "break-word";
  overlayRoot.style.boxShadow = "0 12px 30px rgba(0, 0, 0, 0.35)";
  overlayRoot.style.display = "none";

  document.documentElement.appendChild(overlayRoot);
  return overlayRoot;
}

function renderSubtitle(message) {
  const overlay = ensureOverlay();
  const status = message.status || "";

  if (status) {
    overlay.innerHTML = `<span style="color: rgba(255, 255, 255, 0.88);">${escapeHtml(status)}</span>`;
    overlay.style.display = "block";
    scheduleClear();
    return;
  }

  if (message.isFinal) {
    finalLine = message.text || "";
    interimLine = "";
  } else {
    interimLine = message.text || "";
  }

  const fragments = [];
  if (finalLine) {
    fragments.push(`<span style="color: #ffffff;">${escapeHtml(finalLine)}</span>`);
  }
  if (interimLine) {
    fragments.push(`<span style="color: rgba(255, 255, 255, 0.7);">${escapeHtml(interimLine)}</span>`);
  }

  if (fragments.length === 0) {
    clearSubtitle(false);
    return;
  }

  overlay.innerHTML = fragments.join("<br>");
  overlay.style.display = "block";
  scheduleClear();
}

function scheduleClear() {
  if (clearTimer) {
    clearTimeout(clearTimer);
  }

  clearTimer = setTimeout(() => clearSubtitle(false), CLEAR_DELAY_MS);
}

function clearSubtitle(resetState) {
  if (clearTimer) {
    clearTimeout(clearTimer);
    clearTimer = null;
  }

  if (resetState) {
    finalLine = "";
    interimLine = "";
  } else {
    interimLine = "";
    finalLine = "";
  }

  const overlay = ensureOverlay();
  overlay.innerHTML = "";
  overlay.style.display = "none";
}

function escapeHtml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
