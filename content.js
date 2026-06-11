(() => {
if (window.__tpContentLoaded) return;
window.__tpContentLoaded = true;

const MAX_CHARS_PER_BATCH = 4000;
const CONCURRENCY_LIMIT = 3;

const SKIP_ANCESTOR =
  'script, style, noscript, svg, code, pre, textarea, input, select, option, [contenteditable], .tp-translated-text';

const translatedEntries = [];
const translationCache = new Map();

function injectStyles() {
  if (document.getElementById('tp-styles')) return;

  const style = document.createElement('style');
  style.id = 'tp-styles';
  style.textContent = `
    #tp-status-banner {
      position: fixed;
      top: 12px;
      right: 12px;
      z-index: 2147483647;
      max-width: 340px;
      padding: 10px 14px;
      border-radius: 8px;
      background: #0f172a;
      color: #f8fafc;
      font: 13px/1.4 system-ui, sans-serif;
      box-shadow: 0 8px 24px rgba(15, 23, 42, 0.25);
      pointer-events: none;
    }

    #tp-status-banner.tp-error {
      background: #7f1d1d;
    }

    #tp-selection-popup {
      position: absolute;
      z-index: 2147483647;
      background: #ffffff;
      color: #1e293b;
      padding: 14px 18px;
      border-radius: 12px;
      box-shadow: 0 10px 40px rgba(0, 0, 0, 0.2), 0 0 0 4px rgba(244, 63, 94, 0.15);
      border: 2px solid #f43f5e;
      max-width: 450px;
      font: 14px/1.6 system-ui, sans-serif;
      animation: tp-fade-in 0.2s cubic-bezier(0.16, 1, 0.3, 1);
    }
    @keyframes tp-fade-in {
      from { opacity: 0; transform: translateY(-8px) scale(0.95); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }

    #tp-quick-translate-btn {
      position: absolute;
      z-index: 2147483647;
      background: #ffffff;
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
      border: 1px solid #e2e8f0;
      padding: 6px;
      cursor: pointer;
      display: none;
      align-items: center;
      justify-content: center;
      color: #f43f5e;
      transition: transform 0.1s, box-shadow 0.1s;
    }
    #tp-quick-translate-btn:hover {
      transform: scale(1.05);
      box-shadow: 0 6px 16px rgba(0, 0, 0, 0.2);
    }

    #tp-floating-btn {
      position: fixed;
      right: 20px;
      bottom: 20px;
      width: 44px;
      height: 44px;
      background: #ffffff;
      border-radius: 50%;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
      z-index: 2147483647;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      color: #f43f5e;
      transition: transform 0.2s, box-shadow 0.2s, background 0.2s, color 0.2s;
    }
    #tp-floating-btn:hover {
      transform: scale(1.05);
      box-shadow: 0 6px 16px rgba(0, 0, 0, 0.2);
    }
    #tp-floating-btn.tp-active {
      background: #f43f5e;
      color: #ffffff;
    }
    #tp-floating-btn.tp-loading, #tp-quick-translate-btn.tp-loading {
      opacity: 0.7;
      pointer-events: none;
      animation: tp-spin 1s linear infinite;
    }
    @keyframes tp-spin {
      100% { transform: rotate(360deg); }
    }

    .tp-bilingual-inline {
      color: #f43f5e;
      font-weight: 500;
      opacity: 0.95;
    }
  `;

  document.documentElement.appendChild(style);

  const observer = new MutationObserver(() => {
    if (!document.getElementById('tp-styles')) {
      document.documentElement.appendChild(style);
    }
  });
  observer.observe(document.documentElement, { childList: true });
  if (document.head) observer.observe(document.head, { childList: true });
}

function injectFloatingButton() {
  if (document.getElementById('tp-floating-btn')) return;

  const btn = document.createElement('div');
  btn.id = 'tp-floating-btn';
  btn.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/></svg>`;
  
  const target = document.body || document.documentElement;
  target.appendChild(btn);

  const observer = new MutationObserver(() => {
    if (!document.getElementById('tp-floating-btn')) {
      const newTarget = document.body || document.documentElement;
      newTarget.appendChild(btn);
    }
  });
  observer.observe(document.documentElement, { childList: true });
  if (document.body) observer.observe(document.body, { childList: true });

  let isDragging = false;
  let hasMoved = false;
  let startX, startY, initialLeft, initialTop;

  btn.addEventListener('mousedown', (e) => {
    isDragging = true;
    hasMoved = false;
    startX = e.clientX;
    startY = e.clientY;
    
    const rect = btn.getBoundingClientRect();
    initialLeft = rect.left;
    initialTop = rect.top;
    
    btn.style.right = 'auto';
    btn.style.bottom = 'auto';
    btn.style.left = `${initialLeft}px`;
    btn.style.top = `${initialTop}px`;
    btn.style.transition = 'none';
    
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });

  function onMouseMove(e) {
    if (!isDragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
      hasMoved = true;
    }
    
    let newLeft = initialLeft + dx;
    let newTop = initialTop + dy;
    
    newLeft = Math.max(0, Math.min(newLeft, window.innerWidth - btn.offsetWidth));
    newTop = Math.max(0, Math.min(newTop, window.innerHeight - btn.offsetHeight));
    
    btn.style.left = `${newLeft}px`;
    btn.style.top = `${newTop}px`;
  }

  function onMouseUp() {
    if (!isDragging) return;
    isDragging = false;
    btn.style.transition = 'transform 0.2s, box-shadow 0.2s, background 0.2s, color 0.2s';
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
  }

  btn.addEventListener('click', async () => {
    if (hasMoved) return;
    const isTranslated = translatedEntries.length > 0;
    if (isTranslated) {
      restoreOriginal();
      clearStatusBanner(0);
    } else {
      chrome.storage.sync.get(['geminiApiKey', 'bilingualMode'], async ({ geminiApiKey, bilingualMode }) => {
        if (!geminiApiKey) {
          setStatusBanner('Vui lòng nhập API Key trong popup trước.', true);
          clearStatusBanner(6000);
          return;
        }
        try {
          if (btn.classList.contains('tp-loading')) return;
          btn.classList.add('tp-loading');
          
          await translatePageToVietnamese(geminiApiKey, bilingualMode);
        } catch (error) {
          setStatusBanner(error.message, true);
          clearStatusBanner(6000);
        } finally {
          btn.classList.remove('tp-loading');
        }
      });
    }
  });
}

function updateFloatingButtonState() {
  const btn = document.getElementById('tp-floating-btn');
  if (btn) {
    if (translatedEntries.length > 0) {
      btn.classList.add('tp-active');
    } else {
      btn.classList.remove('tp-active');
    }
  }
}

function setStatusBanner(text, isError = false) {
  let banner = document.getElementById('tp-status-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'tp-status-banner';
    document.documentElement.appendChild(banner);
  }

  banner.textContent = text;
  banner.classList.toggle('tp-error', isError);
}

function clearStatusBanner(delayMs = 3000) {
  window.setTimeout(() => {
    document.getElementById('tp-status-banner')?.remove();
  }, delayMs);
}

function isHidden(el) {
  const style = getComputedStyle(el);
  return style.display === 'none' || style.visibility === 'hidden';
}

function withOriginalWhitespace(original, translated) {
  const leading = original.match(/^\s*/)?.[0] ?? '';
  const trailing = original.match(/\s*$/)?.[0] ?? '';
  return `${leading}${translated.trim()}${trailing}`;
}

function getTranslatableTextNodes() {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let node;

  while ((node = walker.nextNode())) {
    const parent = node.parentElement;
    if (!parent || parent.closest(SKIP_ANCESTOR) || isHidden(parent)) continue;

    const original = node.nodeValue ?? '';
    const trimmed = original.trim();
    if (!trimmed || trimmed.length < 2) continue;

    nodes.push({ node, original, trimmed });
  }

  return nodes;
}

function buildBatches(textNodes) {
  const batches = [];
  let current = [];
  let currentChars = 0;

  textNodes.forEach((item, globalIndex) => {
    const lineLen = item.trimmed.length + String(globalIndex).length + 5;

    if (current.length && currentChars + lineLen > MAX_CHARS_PER_BATCH) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }

    current.push({ ...item, globalIndex });
    currentChars += lineLen;
  });

  if (current.length) {
    batches.push(current);
  }

  return batches;
}

function restoreOriginal() {
  for (const entry of translatedEntries) {
    if (entry.type === 'selection') {
      if (entry.translatedSpan) entry.translatedSpan.remove();
    } else {
      if (entry.span) {
        entry.span.remove();
      } else if (entry.node) {
        entry.node.nodeValue = entry.original;
      }
    }
  }
  translatedEntries.length = 0;
  updateFloatingButtonState();
}

function applyInPlaceTranslation(item, translatedText, bilingualMode) {
  const entry = { node: item.node, original: item.original };
  translatedEntries.push(entry);
  
  if (bilingualMode) {
    const span = document.createElement('span');
    span.className = 'tp-bilingual-inline';
    span.textContent = ` (${translatedText}) `;
    
    const parent = item.node.parentNode;
    if (parent) {
      if (item.node.nextSibling) {
        parent.insertBefore(span, item.node.nextSibling);
      } else {
        parent.appendChild(span);
      }
      entry.span = span;
    } else {
      item.node.nodeValue = withOriginalWhitespace(item.original, ` ${item.original} (${translatedText}) `);
    }
  } else {
    item.node.nodeValue = withOriginalWhitespace(item.original, translatedText);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function translateBatch(apiKey, batch) {
  const lines = batch.map((item) => item.trimmed);
  const response = await chrome.runtime.sendMessage({
    type: 'GEMINI_TRANSLATE_CHUNK',
    apiKey,
    lines,
  });

  if (!response?.ok) {
    throw new Error(response?.error || 'Không thể dịch batch hiện tại.');
  }

  return response.translations;
}

async function translatePageToVietnamese(apiKey, bilingualMode) {
  injectStyles();
  restoreOriginal();

  const textNodes = getTranslatableTextNodes();
  if (!textNodes.length) {
    throw new Error('Trang không có nội dung để dịch.');
  }

  const nodesToTranslate = [];
  let translatedCount = 0;

  for (const item of textNodes) {
    if (translationCache.has(item.trimmed)) {
      applyInPlaceTranslation(item, translationCache.get(item.trimmed), bilingualMode);
      translatedCount += 1;
    } else {
      nodesToTranslate.push(item);
    }
  }

  if (nodesToTranslate.length > 0) {
    const batches = buildBatches(nodesToTranslate);

    async function processBatches(iterator) {
      for (const [batchIndex, batch] of iterator) {
        setStatusBanner(
          `Đang dịch phần ${batchIndex + 1}/${batches.length} (${nodesToTranslate.length} đoạn mới)...`,
        );

        const translations = await translateBatch(apiKey, batch);

        batch.forEach((item, index) => {
          const translated = translations[String(index)];
          if (!translated) return;
          
          translationCache.set(item.trimmed, translated);
          applyInPlaceTranslation(item, translated, bilingualMode);
          translatedCount += 1;
        });
      }
    }

    const iterator = batches.entries();
    const workers = Array.from({ length: Math.min(CONCURRENCY_LIMIT, batches.length) }, () => processBatches(iterator));
    await Promise.all(workers);
  }

  if (!translatedCount) {
    throw new Error('Gemini trả về nhưng không khớp được nội dung trên trang.');
  }

  const skipped = textNodes.length - translatedCount;
  const summary =
    skipped > 0
      ? `Dịch xong ${translatedCount}/${textNodes.length} đoạn (${skipped} đoạn chưa khớp).`
      : `Dịch xong toàn trang (${translatedCount} đoạn).`;

  setStatusBanner(summary);
  clearStatusBanner();
  updateFloatingButtonState();
}

function showSelectionPopup(text, selection) {
  document.getElementById('tp-selection-popup')?.remove();

  if (!selection.rangeCount) return;

  const popup = document.createElement('div');
  popup.id = 'tp-selection-popup';
  
  const resultLines = text.split('\n');
  resultLines.forEach((line, i) => {
    popup.appendChild(document.createTextNode(line));
    if (i < resultLines.length - 1) {
      popup.appendChild(document.createElement('br'));
    }
  });

  document.body.appendChild(popup);

  const range = selection.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  
  let top = rect.bottom + window.scrollY + 10;
  let left = rect.left + window.scrollX + (rect.width / 2) - (popup.offsetWidth / 2);
  
  if (left < 10) left = 10;
  if (left + popup.offsetWidth > window.innerWidth - 10) {
    left = window.innerWidth - popup.offsetWidth - 10;
  }
  
  popup.style.top = `${top}px`;
  popup.style.left = `${left}px`;

  popup.addEventListener('mousedown', (e) => e.stopPropagation());

  setTimeout(() => {
    const closeListener = () => {
      popup.remove();
      document.removeEventListener('mousedown', closeListener);
    };
    document.addEventListener('mousedown', closeListener);
  }, 10);
}

async function translateSelectionToVietnamese(apiKey, bilingualMode) {
  const selection = window.getSelection();
  const text = selection.toString();
  if (!text.trim()) {
    throw new Error('Không có văn bản nào được chọn.');
  }

  injectStyles();
  setStatusBanner('Đang dịch đoạn text đã chọn...');

  const lines = text.split('\n');
  const linesToTranslate = [];
  const linesMap = new Map();

  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed) {
      linesMap.set(i, line);
    } else if (translationCache.has(trimmed)) {
      linesMap.set(i, translationCache.get(trimmed));
    } else {
      linesToTranslate.push({ line: trimmed, index: i });
    }
  });

  if (linesToTranslate.length > 0) {
    const response = await chrome.runtime.sendMessage({
      type: 'GEMINI_TRANSLATE_CHUNK',
      apiKey,
      lines: linesToTranslate.map(x => x.line),
    });

    if (!response?.ok) {
      throw new Error(response?.error || 'Không thể dịch đoạn text.');
    }

    linesToTranslate.forEach((x, i) => {
      const translated = response.translations[String(i)] || x.line;
      translationCache.set(x.line, translated);
      linesMap.set(x.index, translated);
    });
  }

  const translatedLines = lines.map((_, i) => linesMap.get(i) || lines[i]);
  const translatedText = translatedLines.join('\n');

  if (selection.rangeCount > 0) {
    showSelectionPopup(translatedText, selection);
  }

  setStatusBanner('Dịch đoạn text thành công.');
  clearStatusBanner();
  updateFloatingButtonState();
}

function initQuickTranslate() {
  let quickBtn = null;

  document.addEventListener('mouseup', (e) => {
    if (e.target.closest('#tp-quick-translate-btn') || e.target.closest('#tp-selection-popup')) return;

    setTimeout(() => {
      const selection = window.getSelection();
      if (!selection) return;
      
      const text = selection.toString().trim();

      if (text.length > 0) {
        if (!quickBtn) {
          quickBtn = document.createElement('div');
          quickBtn.id = 'tp-quick-translate-btn';
          quickBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/></svg>`;
          document.body.appendChild(quickBtn);

          quickBtn.addEventListener('mousedown', async (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            quickBtn.classList.add('tp-loading');

            chrome.storage.sync.get(['geminiApiKey', 'bilingualMode'], async ({ geminiApiKey, bilingualMode }) => {
              if (!geminiApiKey) {
                setStatusBanner('Vui lòng nhập API Key trong popup trước.', true);
                clearStatusBanner(6000);
                quickBtn.classList.remove('tp-loading');
                quickBtn.style.display = 'none';
                return;
              }
              try {
                await translateSelectionToVietnamese(geminiApiKey, bilingualMode);
              } catch (error) {
                setStatusBanner(error.message, true);
                clearStatusBanner(6000);
              } finally {
                quickBtn.classList.remove('tp-loading');
                quickBtn.style.display = 'none';
              }
            });
          });
        }

        if (selection.rangeCount > 0) {
          const range = selection.getRangeAt(0);
          const rect = range.getBoundingClientRect();
          
          let top = rect.bottom + window.scrollY + 8;
          let left = rect.right + window.scrollX - 18;
          
          quickBtn.style.top = `${top}px`;
          quickBtn.style.left = `${left}px`;
          quickBtn.style.display = 'flex';
        }
      } else {
        if (quickBtn) {
          quickBtn.style.display = 'none';
        }
      }
    }, 10);
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'PING') {
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === 'REMOVE_TRANSLATIONS') {
    restoreOriginal();
    clearStatusBanner(0);
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === 'SHOW_ERROR') {
    setStatusBanner(message.message, true);
    clearStatusBanner(6000);
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === 'TRANSLATE_SELECTION') {
    translateSelectionToVietnamese(message.apiKey, message.bilingualMode)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        setStatusBanner(error.message, true);
        clearStatusBanner(6000);
        sendResponse({ ok: false, error: error.message });
      });
    return true;
  }

  if (message?.type !== 'TRANSLATE_TO_VI') {
    return false;
  }

  translatePageToVietnamese(message.apiKey, message.bilingualMode)
    .then(() => sendResponse({ ok: true }))
    .catch((error) => {
      setStatusBanner(error.message, true);
      clearStatusBanner(6000);
      sendResponse({ ok: false, error: error.message });
    });

  return true;
});

injectStyles();
injectFloatingButton();
initQuickTranslate();
updateFloatingButtonState();

})();
