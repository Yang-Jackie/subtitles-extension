const OVERLAY_ID = "dg-live-subtitles-overlay";
const OVERLAY_HANDLE_ID = "dg-live-subtitles-overlay-handle";
const OVERLAY_CONTENT_ID = "dg-live-subtitles-overlay-content";
const OVERLAY_POSITION_STORAGE_KEY = "subtitleOverlayPosition";
const CLEAR_DELAY_MS = 3000;
const INTERIM_RENDER_DELAY_MS = 120;

let overlayRoot = null;
let overlayContent = null;
let overlayHandle = null;
let finalLine = "";
let liveTail = "";
let pendingInterimText = "";
let clearTimer = null;
let interimRenderTimer = null;
let overlayPosition = null;
let overlayPositionLoadPromise = null;
let dragState = null;

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
    overlayHandle = overlayRoot.querySelector(`#${OVERLAY_HANDLE_ID}`);
    overlayContent = overlayRoot.querySelector(`#${OVERLAY_CONTENT_ID}`);
    return overlayRoot;
  }

  overlayRoot = document.createElement("div");
  overlayRoot.id = OVERLAY_ID;
  overlayRoot.style.position = "fixed";
  overlayRoot.style.maxWidth = "min(80vw, 960px)";
  overlayRoot.style.zIndex = "999999";
  overlayRoot.style.pointerEvents = "none";
  overlayRoot.style.display = "none";
  overlayRoot.style.willChange = "left, top";

  overlayHandle = document.createElement("div");
  overlayHandle.id = OVERLAY_HANDLE_ID;
  overlayHandle.style.height = "14px";
  overlayHandle.style.marginBottom = "-6px";
  overlayHandle.style.cursor = "move";
  overlayHandle.style.pointerEvents = "auto";
  overlayHandle.style.background = "transparent";
  overlayHandle.title = "Drag subtitle overlay";
  overlayHandle.addEventListener("pointerdown", startDrag);

  overlayContent = document.createElement("div");
  overlayContent.id = OVERLAY_CONTENT_ID;
  overlayContent.style.padding = "14px 18px";
  overlayContent.style.borderRadius = "14px";
  overlayContent.style.background = "rgba(0, 0, 0, 0.72)";
  overlayContent.style.color = "#ffffff";
  overlayContent.style.fontFamily = "'Segoe UI', Arial, sans-serif";
  overlayContent.style.fontSize = "24px";
  overlayContent.style.lineHeight = "1.35";
  overlayContent.style.textAlign = "center";
  overlayContent.style.pointerEvents = "none";
  overlayContent.style.whiteSpace = "pre-wrap";
  overlayContent.style.wordBreak = "break-word";
  overlayContent.style.boxShadow = "0 12px 30px rgba(0, 0, 0, 0.35)";

  overlayRoot.appendChild(overlayHandle);
  overlayRoot.appendChild(overlayContent);

  window.addEventListener("pointermove", handleDrag);
  window.addEventListener("pointerup", endDrag);
  window.addEventListener("pointercancel", endDrag);

  applyDefaultOverlayPosition();
  loadOverlayPosition().then(() => {
    if (overlayRoot?.isConnected) {
      applyOverlayPosition();
    }
  }).catch(() => {});

  document.documentElement.appendChild(overlayRoot);
  return overlayRoot;
}

function renderSubtitle(message) {
  const overlay = ensureOverlay();
  const status = message.status || "";

  if (status) {
    pendingInterimText = "";
    liveTail = "";
    if (interimRenderTimer) {
      clearTimeout(interimRenderTimer);
      interimRenderTimer = null;
    }
    if (overlayContent) {
      overlayContent.innerHTML = `<span style="color: rgba(255, 255, 255, 0.88);">${escapeHtml(status)}</span>`;
    }
    overlay.style.display = "block";
    scheduleClear();
    return;
  }

  if (message.isFinal) {
    pendingInterimText = "";
    if (interimRenderTimer) {
      clearTimeout(interimRenderTimer);
      interimRenderTimer = null;
    }

    finalLine = message.text || "";
    liveTail = "";

    if (!finalLine) {
      clearSubtitle(false);
      return;
    }

    renderOverlay();
    scheduleClear();
    return;
  }

  pendingInterimText = message.text || "";
  if (interimRenderTimer) {
    clearTimeout(interimRenderTimer);
  }

  interimRenderTimer = setTimeout(() => {
    interimRenderTimer = null;
    liveTail = deriveLiveTail(finalLine, pendingInterimText);

    if (!finalLine && !liveTail) {
      clearSubtitle(false);
      return;
    }

    renderOverlay();
    scheduleClear();
  }, INTERIM_RENDER_DELAY_MS);
}

function renderOverlay() {
  const overlay = ensureOverlay();
  const fragments = [];

  if (finalLine) {
    fragments.push(`<span style="color: #ffffff;">${escapeHtml(finalLine)}</span>`);
  }

  if (liveTail) {
    fragments.push(
      `<span style="color: rgba(255, 255, 255, 0.72); font-size: 0.9em;">${escapeHtml(liveTail)}</span>`
    );
  }

  if (fragments.length === 0) {
    clearSubtitle(false);
    return;
  }

  if (overlayContent) {
    overlayContent.innerHTML = fragments.join("<br>");
  }
  overlay.style.display = "block";
}

function scheduleClear() {
  if (clearTimer) {
    clearTimeout(clearTimer);
  }

  clearTimer = setTimeout(() => clearSubtitle(false), CLEAR_DELAY_MS);
}

function clearSubtitle(resetState) {
  pendingInterimText = "";
  liveTail = "";

  if (clearTimer) {
    clearTimeout(clearTimer);
    clearTimer = null;
  }

  if (interimRenderTimer) {
    clearTimeout(interimRenderTimer);
    interimRenderTimer = null;
  }

  finalLine = "";

  if (overlayContent) {
    overlayContent.innerHTML = "";
  }

  if (overlayRoot) {
    overlayRoot.style.display = "none";
  }
}

function deriveLiveTail(committedText, interimText) {
  const committedWords = tokenizeWords(committedText);
  const interimWords = tokenizeWords(interimText);

  if (interimWords.length === 0) {
    return "";
  }

  let prefixLength = 0;
  while (
    prefixLength < committedWords.length &&
    prefixLength < interimWords.length &&
    normalizeWord(committedWords[prefixLength]) === normalizeWord(interimWords[prefixLength])
  ) {
    prefixLength += 1;
  }

  const remainingWords = prefixLength > 0 ? interimWords.slice(prefixLength) : interimWords;
  return remainingWords.join(" ");
}

function tokenizeWords(text) {
  return (text || "").trim().split(/\s+/).filter(Boolean);
}

function normalizeWord(word) {
  return word
    .toLowerCase()
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, "");
}

function escapeHtml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function applyDefaultOverlayPosition() {
  if (!overlayRoot) {
    return;
  }

  overlayRoot.style.left = "50%";
  overlayRoot.style.top = "auto";
  overlayRoot.style.bottom = "6vh";
  overlayRoot.style.transform = "translateX(-50%)";
}

function applyOverlayPosition() {
  if (!overlayRoot) {
    return;
  }

  if (!overlayPosition) {
    applyDefaultOverlayPosition();
    return;
  }

  overlayRoot.style.left = `${Math.round(overlayPosition.left)}px`;
  overlayRoot.style.top = `${Math.round(overlayPosition.top)}px`;
  overlayRoot.style.bottom = "auto";
  overlayRoot.style.transform = "none";
}

async function loadOverlayPosition() {
  if (overlayPositionLoadPromise) {
    return overlayPositionLoadPromise;
  }

  overlayPositionLoadPromise = chrome.storage.local
    .get([OVERLAY_POSITION_STORAGE_KEY])
    .then((result) => {
      const saved = result?.[OVERLAY_POSITION_STORAGE_KEY];
      if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
        overlayPosition = { left: saved.left, top: saved.top };
      }
    })
    .finally(() => {
      overlayPositionLoadPromise = null;
    });

  return overlayPositionLoadPromise;
}

async function saveOverlayPosition() {
  if (!overlayPosition) {
    return;
  }

  await chrome.storage.local.set({
    [OVERLAY_POSITION_STORAGE_KEY]: overlayPosition
  });
}

function startDrag(event) {
  if (!overlayRoot) {
    return;
  }

  const rect = overlayRoot.getBoundingClientRect();
  dragState = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    left: rect.left,
    top: rect.top
  };

  overlayHandle?.setPointerCapture?.(event.pointerId);
  event.preventDefault();
}

function handleDrag(event) {
  if (!dragState || event.pointerId !== dragState.pointerId || !overlayRoot) {
    return;
  }

  const nextLeft = clamp(
    dragState.left + (event.clientX - dragState.startX),
    12,
    Math.max(12, window.innerWidth - overlayRoot.offsetWidth - 12)
  );
  const nextTop = clamp(
    dragState.top + (event.clientY - dragState.startY),
    12,
    Math.max(12, window.innerHeight - overlayRoot.offsetHeight - 12)
  );

  overlayPosition = { left: nextLeft, top: nextTop };
  applyOverlayPosition();
}

function endDrag(event) {
  if (!dragState || event.pointerId !== dragState.pointerId) {
    return;
  }

  dragState = null;
  saveOverlayPosition().catch(() => {});
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
