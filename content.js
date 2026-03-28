const OVERLAY_ID = "dg-live-subtitles-overlay";
const CLEAR_DELAY_MS = 3000;
const INTERIM_RENDER_DELAY_MS = 120;
const LIVE_TAIL_WORD_LIMIT = 6;

let overlayRoot = null;
let finalLine = "";
let liveTail = "";
let pendingInterimText = "";
let clearTimer = null;
let interimRenderTimer = null;

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
    pendingInterimText = "";
    liveTail = "";
    if (interimRenderTimer) {
      clearTimeout(interimRenderTimer);
      interimRenderTimer = null;
    }
    overlay.innerHTML = `<span style="color: rgba(255, 255, 255, 0.88);">${escapeHtml(status)}</span>`;
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

  overlay.innerHTML = fragments.join("<br>");
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

  if (resetState) {
    finalLine = "";
  } else {
    finalLine = "";
  }

  const overlay = ensureOverlay();
  overlay.innerHTML = "";
  overlay.style.display = "none";
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
  const tailWords = remainingWords.slice(-LIVE_TAIL_WORD_LIMIT);
  return tailWords.join(" ");
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
