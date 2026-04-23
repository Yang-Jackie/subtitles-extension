const OVERLAY_ID = "dg-live-subtitles-overlay";
const OVERLAY_HANDLE_ID = "dg-live-subtitles-overlay-handle";
const OVERLAY_CONTENT_ID = "dg-live-subtitles-overlay-content";
const SNAP_PLACEHOLDER_ID = "dg-live-subtitles-snap-placeholder";
const OVERLAY_POSITION_STORAGE_KEY = "subtitleOverlayPosition";
const CLEAR_DELAY_MS = 3000;
const INTERIM_RENDER_DELAY_MS = 120;
const DEFAULT_BOTTOM_OFFSET_VH = 6;
const SNAP_DISTANCE_PX = 36;
const SNAP_PLACEHOLDER_WIDTH_PX = 520;
const SNAP_PLACEHOLDER_HEIGHT_PX = 96;
const SNAP_PLACEHOLDER_IDLE_BORDER = "2px dashed rgba(255, 255, 255, 0.92)";
const SNAP_PLACEHOLDER_IDLE_BACKGROUND = "rgba(15, 23, 42, 0.22)";
const SNAP_PLACEHOLDER_ACTIVE_BORDER = "2px solid rgba(96, 165, 250, 0.98)";
const SNAP_PLACEHOLDER_ACTIVE_BACKGROUND = "rgba(59, 130, 246, 0.22)";
const OVERLAY_IDLE_BOX_SHADOW = "0 12px 30px rgba(0, 0, 0, 0.35)";
const OVERLAY_SNAP_BOX_SHADOW = "0 0 0 3px rgba(96, 165, 250, 0.85), 0 16px 36px rgba(37, 99, 235, 0.32)";

let overlayRoot = null;
let overlayContent = null;
let overlayHandle = null;
let snapPlaceholder = null;
let finalLine = "";
let liveTail = "";
let pendingInterimText = "";
let clearTimer = null;
let interimRenderTimer = null;
let overlayPosition = null;
let overlayPositionLoadPromise = null;
let dragState = null;
let snapActive = false;

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
    snapPlaceholder = document.getElementById(SNAP_PLACEHOLDER_ID);
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
  overlayHandle.style.touchAction = "none";
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
  overlayContent.style.pointerEvents = "auto";
  overlayContent.style.cursor = "move";
  overlayContent.style.userSelect = "none";
  overlayContent.style.touchAction = "none";
  overlayContent.style.whiteSpace = "pre-wrap";
  overlayContent.style.wordBreak = "break-word";
  overlayContent.style.boxShadow = OVERLAY_IDLE_BOX_SHADOW;
  overlayContent.style.transition = "box-shadow 120ms ease, transform 120ms ease";
  overlayContent.title = "Drag subtitle overlay";
  overlayContent.addEventListener("pointerdown", startDrag);

  snapPlaceholder = document.createElement("div");
  snapPlaceholder.id = SNAP_PLACEHOLDER_ID;
  snapPlaceholder.style.position = "fixed";
  snapPlaceholder.style.width = `${SNAP_PLACEHOLDER_WIDTH_PX}px`;
  snapPlaceholder.style.height = `${SNAP_PLACEHOLDER_HEIGHT_PX}px`;
  snapPlaceholder.style.border = SNAP_PLACEHOLDER_IDLE_BORDER;
  snapPlaceholder.style.borderRadius = "16px";
  snapPlaceholder.style.background = SNAP_PLACEHOLDER_IDLE_BACKGROUND;
  snapPlaceholder.style.boxSizing = "border-box";
  snapPlaceholder.style.pointerEvents = "none";
  snapPlaceholder.style.display = "none";
  snapPlaceholder.style.zIndex = "999998";
  snapPlaceholder.style.boxShadow = "0 0 0 1px rgba(15, 23, 42, 0.45), 0 12px 32px rgba(0, 0, 0, 0.28)";
  snapPlaceholder.style.backdropFilter = "blur(2px)";
  snapPlaceholder.style.alignItems = "center";
  snapPlaceholder.style.justifyContent = "center";
  snapPlaceholder.style.color = "rgba(255, 255, 255, 0.94)";
  snapPlaceholder.style.fontFamily = "'Segoe UI', Arial, sans-serif";
  snapPlaceholder.style.fontSize = "14px";
  snapPlaceholder.style.fontWeight = "600";
  snapPlaceholder.style.letterSpacing = "0.04em";
  snapPlaceholder.style.textTransform = "uppercase";
  snapPlaceholder.style.display = "none";
  snapPlaceholder.style.opacity = "0";
  snapPlaceholder.style.transition = "opacity 120ms ease, border-color 120ms ease, background 120ms ease, box-shadow 120ms ease";
  snapPlaceholder.textContent = "Snap Here";

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

  document.documentElement.appendChild(snapPlaceholder);
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
  overlayRoot.style.bottom = `${DEFAULT_BOTTOM_OFFSET_VH}vh`;
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
    await chrome.storage.local.remove(OVERLAY_POSITION_STORAGE_KEY);
    return;
  }

  await chrome.storage.local.set({
    [OVERLAY_POSITION_STORAGE_KEY]: overlayPosition
  });
}

function startDrag(event) {
  if (!overlayRoot || event.button !== 0) {
    return;
  }

  const rect = overlayRoot.getBoundingClientRect();
  dragState = {
    pointerId: event.pointerId,
    captureElement: event.currentTarget,
    startX: event.clientX,
    startY: event.clientY,
    left: rect.left,
    top: rect.top
  };

  showSnapPlaceholder();
  setSnapActive(false);
  event.currentTarget?.setPointerCapture?.(event.pointerId);
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

  const shouldSnap = isNearDefaultOverlayPosition(nextLeft, nextTop);
  setSnapActive(shouldSnap);

  if (shouldSnap) {
    overlayPosition = null;
    applyDefaultOverlayPosition();
    return;
  }

  overlayPosition = { left: nextLeft, top: nextTop };
  applyOverlayPosition();
}

function endDrag(event) {
  if (!dragState || event.pointerId !== dragState.pointerId) {
    return;
  }

  const captureElement = dragState.captureElement;
  if (captureElement?.hasPointerCapture?.(event.pointerId)) {
    captureElement.releasePointerCapture(event.pointerId);
  }

  dragState = null;
  setSnapActive(false);
  hideSnapPlaceholder();
  saveOverlayPosition().catch(() => {});
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function isNearDefaultOverlayPosition(left, top) {
  if (!overlayRoot) {
    return false;
  }

  const defaultRect = getDefaultOverlayRect();
  const nextCenterX = left + (overlayRoot.offsetWidth / 2);
  const nextCenterY = top + (overlayRoot.offsetHeight / 2);
  const defaultCenterX = defaultRect.left + (overlayRoot.offsetWidth / 2);
  const defaultCenterY = defaultRect.top + (overlayRoot.offsetHeight / 2);
  const deltaX = nextCenterX - defaultCenterX;
  const deltaY = nextCenterY - defaultCenterY;
  return Math.hypot(deltaX, deltaY) <= SNAP_DISTANCE_PX;
}

function getDefaultOverlayRect() {
  const bottomOffset = (window.innerHeight * DEFAULT_BOTTOM_OFFSET_VH) / 100;
  const left = (window.innerWidth - overlayRoot.offsetWidth) / 2;
  const top = window.innerHeight - bottomOffset - overlayRoot.offsetHeight;

  return {
    left,
    top
  };
}

function showSnapPlaceholder() {
  if (!snapPlaceholder) {
    return;
  }

  const rect = getSnapPlaceholderRect();
  setSnapActive(snapActive);
  snapPlaceholder.style.left = `${Math.round(rect.left)}px`;
  snapPlaceholder.style.top = `${Math.round(rect.top)}px`;
  snapPlaceholder.style.display = "flex";
  requestAnimationFrame(() => {
    if (snapPlaceholder) {
      snapPlaceholder.style.opacity = "1";
    }
  });
}

function hideSnapPlaceholder() {
  if (!snapPlaceholder) {
    return;
  }

  snapPlaceholder.style.opacity = "0";
  snapPlaceholder.style.display = "none";
}

function getSnapPlaceholderRect() {
  const bottomOffset = (window.innerHeight * DEFAULT_BOTTOM_OFFSET_VH) / 100;
  const width = Math.min(SNAP_PLACEHOLDER_WIDTH_PX, window.innerWidth - 24);
  const height = SNAP_PLACEHOLDER_HEIGHT_PX;
  const left = Math.max(12, (window.innerWidth - width) / 2);
  const top = Math.max(12, window.innerHeight - bottomOffset - height);

  snapPlaceholder.style.width = `${Math.round(width)}px`;

  return {
    left,
    top
  };
}

function setSnapActive(active) {
  snapActive = active;

  if (snapPlaceholder) {
    snapPlaceholder.style.border = active ? SNAP_PLACEHOLDER_ACTIVE_BORDER : SNAP_PLACEHOLDER_IDLE_BORDER;
    snapPlaceholder.style.background = active ? SNAP_PLACEHOLDER_ACTIVE_BACKGROUND : SNAP_PLACEHOLDER_IDLE_BACKGROUND;
    snapPlaceholder.style.boxShadow = active
      ? "0 0 0 2px rgba(96, 165, 250, 0.35), 0 14px 36px rgba(37, 99, 235, 0.28)"
      : "0 0 0 1px rgba(15, 23, 42, 0.45), 0 12px 32px rgba(0, 0, 0, 0.28)";
  }

  if (overlayContent) {
    overlayContent.style.boxShadow = active ? OVERLAY_SNAP_BOX_SHADOW : OVERLAY_IDLE_BOX_SHADOW;
    overlayContent.style.transform = active ? "translateY(-1px)" : "none";
  }
}
