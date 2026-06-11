const apiKeyInput = document.getElementById('apiKey');
const translateBtn = document.getElementById('translateBtn');
const removeBtn = document.getElementById('removeBtn');
const selectionBtn = document.getElementById('selectionBtn');
const statusEl = document.getElementById('status');
const bilingualToggle = document.getElementById('bilingualToggle');

chrome.storage.sync.get(['geminiApiKey', 'bilingualMode'], ({ geminiApiKey, bilingualMode }) => {
  if (geminiApiKey) {
    apiKeyInput.value = geminiApiKey;
  }
  if (bilingualMode) {
    bilingualToggle.classList.add('active');
  }
});

bilingualToggle.addEventListener('click', () => {
  bilingualToggle.classList.toggle('active');
  const isActive = bilingualToggle.classList.contains('active');
  chrome.storage.sync.set({ bilingualMode: isActive });
});

async function ensureContentScript(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
    if (response?.ok) return;
  } catch {
    // Content script chưa được inject vào tab hiện tại.
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content.js'],
  });
}

async function handleAction(actionType) {
  const apiKey = apiKeyInput.value.trim();

  if (!apiKey) {
    statusEl.textContent = 'Vui lòng nhập Gemini API key.';
    return;
  }

  chrome.storage.sync.set({ geminiApiKey: apiKey });

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab?.id) {
    statusEl.textContent = 'Không tìm thấy tab hiện tại.';
    return;
  }

  if (tab.url?.startsWith('chrome://') || tab.url?.startsWith('brave://') || tab.url?.startsWith('edge://')) {
    statusEl.textContent = 'Không áp dụng được trên trang nội bộ của trình duyệt.';
    return;
  }

  statusEl.textContent = 'Đang xử lý...';

  try {
    await ensureContentScript(tab.id);

    const bilingualMode = bilingualToggle.classList.contains('active');

    const response = await chrome.tabs.sendMessage(tab.id, {
      type: actionType,
      apiKey,
      bilingualMode,
    });

    if (actionType === 'REMOVE_TRANSLATIONS') {
      statusEl.textContent = 'Đã khôi phục bản gốc.';
    } else {
      statusEl.textContent = response?.ok
        ? 'Hoàn tất!'
        : response?.error || 'Xử lý thất bại.';
    }
  } catch (error) {
    statusEl.textContent =
      error?.message ||
      'Không thể kết nối với trang. Hãy reload trang rồi thử lại.';
  }
}

translateBtn.addEventListener('click', () => handleAction('TRANSLATE_TO_VI'));
removeBtn.addEventListener('click', () => handleAction('REMOVE_TRANSLATIONS'));
selectionBtn.addEventListener('click', () => handleAction('TRANSLATE_SELECTION'));

// Tự động lưu API Key khi người dùng nhập
apiKeyInput.addEventListener('input', () => {
  const apiKey = apiKeyInput.value.trim();
  if (apiKey) {
    chrome.storage.sync.set({ geminiApiKey: apiKey });
  } else {
    chrome.storage.sync.remove('geminiApiKey');
  }
});

// Optional: listen to Alt+A to trigger translation
document.addEventListener('keydown', (e) => {
  if (e.altKey && e.key.toLowerCase() === 'a') {
    handleAction('TRANSLATE_TO_VI');
  }
});
