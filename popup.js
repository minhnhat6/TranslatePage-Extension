const apiKeyInput = document.getElementById('apiKey');
const translateBtn = document.getElementById('translateBtn');
const removeBtn = document.getElementById('removeBtn');
const selectionBtn = document.getElementById('selectionBtn');
const statusEl = document.getElementById('status');
const bilingualToggle = document.getElementById('bilingualToggle');

const newApiKeyInput = document.getElementById('newApiKey');
const addApiBtn = document.getElementById('addApiBtn');
const apiListContainer = document.getElementById('apiList');

let savedApiKeys = [];

function renderApiList() {
  apiListContainer.innerHTML = '';
  savedApiKeys.forEach((key, index) => {
    let provider = 'Unknown';
    let badgeClass = '';
    let displayKey = key.substring(0, 8) + '***' + key.substring(key.length - 4);
    
    if (key.startsWith('gsk_')) {
      provider = 'Groq';
      badgeClass = 'badge-groq';
    } else if (key.startsWith('AIza') || key.startsWith('AQ.')) {
      provider = 'Gemini';
      badgeClass = 'badge-gemini';
    } else if (key.startsWith('sk-or-')) {
      provider = 'OpenRouter';
      badgeClass = 'badge-openrouter';
    }

    const item = document.createElement('div');
    item.className = 'api-item';
    item.innerHTML = `
      <div style="display: flex; align-items: center;">
        <span class="provider-badge ${badgeClass}">${provider}</span>
        <span>${displayKey}</span>
      </div>
      <button class="delete-btn" data-index="${index}">X</button>
    `;
    apiListContainer.appendChild(item);
  });

  document.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const idx = parseInt(e.target.getAttribute('data-index'), 10);
      savedApiKeys.splice(idx, 1);
      chrome.storage.sync.set({ apiKeys: savedApiKeys }, renderApiList);
    });
  });
}

chrome.storage.sync.get(['apiKeys', 'apiKeysText', 'bilingualMode'], (data) => {
  // Migrate from apiKeysText if exists
  if (data.apiKeys) {
    savedApiKeys = data.apiKeys;
  } else if (data.apiKeysText) {
    savedApiKeys = data.apiKeysText.split('\n').map(k => k.trim()).filter(k => k);
    chrome.storage.sync.set({ apiKeys: savedApiKeys });
  }
  
  renderApiList();

  if (data.bilingualMode) {
    bilingualToggle.classList.add('active');
  }
});

addApiBtn.addEventListener('click', async () => {
  const key = newApiKeyInput.value.trim();
  if (!key) return;

  if (savedApiKeys.includes(key)) {
    statusEl.textContent = 'Key này đã tồn tại trong danh sách!';
    return;
  }

  addApiBtn.disabled = true;
  addApiBtn.textContent = 'Đang thử...';
  statusEl.textContent = 'Đang kiểm tra kết nối API...';

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'VERIFY_API_KEY',
      apiKey: key
    });

    if (response?.ok) {
      savedApiKeys.push(key);
      await chrome.storage.sync.set({ apiKeys: savedApiKeys });
      renderApiList();
      newApiKeyInput.value = '';
      statusEl.textContent = 'Thêm API Key thành công!';
    } else {
      statusEl.textContent = 'Lỗi: ' + (response?.error || 'Key không hợp lệ');
    }
  } catch (err) {
    statusEl.textContent = 'Lỗi kết nối: ' + err.message;
  } finally {
    addApiBtn.disabled = false;
    addApiBtn.textContent = 'Thêm';
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
  if (savedApiKeys.length === 0) {
    statusEl.textContent = 'Vui lòng Thêm ít nhất 1 API Key hợp lệ.';
    return;
  }

  const apiKeys = savedApiKeys;

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
      apiKeys,
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

// Optional: listen to Alt+A to trigger translation
document.addEventListener('keydown', (e) => {
  if (e.altKey && e.key.toLowerCase() === 'a') {
    handleAction('TRANSLATE_TO_VI');
  }
});
