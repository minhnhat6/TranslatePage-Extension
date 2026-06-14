const apiKeyInput = document.getElementById('apiKey');
const translateBtn = document.getElementById('translateBtn');
const removeBtn = document.getElementById('removeBtn');
const selectionBtn = document.getElementById('selectionBtn');
const statusEl = document.getElementById('status');
const bilingualToggle = document.getElementById('bilingualToggle');

const newApiKeyInput = document.getElementById('newApiKey');
const addApiBtn = document.getElementById('addApiBtn');
const apiListContainer = document.getElementById('apiList');
const targetLangSelect = document.getElementById('targetLangSelect');

const powerBtn = document.getElementById('powerBtn');
const mainWrap = document.getElementById('mainWrap');

let savedApiKeys = [];
let extensionEnabled = true;

function applyEnabledState(enabled) {
  if (enabled) {
    powerBtn.classList.add('enabled');
    // Remove overlay if any
    const overlay = mainWrap.querySelector('.ext-disabled-overlay');
    if (overlay) overlay.remove();
  } else {
    powerBtn.classList.remove('enabled');
    // Add overlay if not already there
    if (!mainWrap.querySelector('.ext-disabled-overlay')) {
      const overlay = document.createElement('div');
      overlay.className = 'ext-disabled-overlay';
      overlay.innerHTML = `
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 2v6"/>
          <path d="M6.8 4.8a9 9 0 1 0 10.4 0"/>
        </svg>
        <span>Extension đã tắt</span>
        <span style="font-size:11px;color:#52525b">Bấm nút nguyên để bật lại</span>
      `;
      mainWrap.appendChild(overlay);
    }
  }
}

powerBtn.addEventListener('click', () => {
  extensionEnabled = !extensionEnabled;
  applyEnabledState(extensionEnabled);
  // Send to background which will broadcast to all tabs
  chrome.runtime.sendMessage({ type: 'SET_ENABLED', enabled: extensionEnabled });
});


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
    } else if (key.startsWith('sk-ant-')) {
      provider = 'Claude';
      badgeClass = 'badge-claude';
    } else if (key.startsWith('ghp_') || key.startsWith('github_pat_')) {
      provider = 'GitHub';
      badgeClass = 'badge-github';
    } else if (key.startsWith('nvapi-')) {
      provider = 'NVIDIA';
      badgeClass = 'badge-nvidia';
    } else if (key.startsWith('sk-proj-') || (key.startsWith('sk-') && !key.startsWith('sk-or-') && !key.startsWith('sk-ant-'))) {
      provider = 'OpenAI';
      badgeClass = 'badge-openai';
    } else if (key.startsWith('sta_')) {
      provider = 'FreeTheAi';
      badgeClass = 'badge-freetheai';
    } else if (key.startsWith('csk-')) {
      provider = 'Cerebras';
      badgeClass = 'badge-cerebras';
    } else if (/^[A-Za-z0-9]{32}$/.test(key)) {
      provider = 'Mistral';
      badgeClass = 'badge-mistral';
    }

    const item = document.createElement('div');
    item.className = 'api-item';
    item.innerHTML = `
      <div style="display: flex; align-items: center;">
        <span class="provider-badge ${badgeClass}">${provider}</span>
        <span>${displayKey}</span>
      </div>
      <div class="api-item-actions">
        <button class="move-btn move-up-btn" data-index="${index}" ${index === 0 ? 'disabled' : ''}>↑</button>
        <button class="move-btn move-down-btn" data-index="${index}" ${index === savedApiKeys.length - 1 ? 'disabled' : ''}>↓</button>
        <button class="delete-btn" data-index="${index}">X</button>
      </div>
    `;
    apiListContainer.appendChild(item);
  });

  const saveAndRender = () => {
    chrome.storage.sync.set({ apiKeys: savedApiKeys }, renderApiList);
  };

  document.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const idx = parseInt(e.target.getAttribute('data-index'), 10);
      savedApiKeys.splice(idx, 1);
      saveAndRender();
    });
  });

  document.querySelectorAll('.move-up-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const idx = parseInt(e.target.getAttribute('data-index'), 10);
      if (idx > 0) {
        [savedApiKeys[idx - 1], savedApiKeys[idx]] = [savedApiKeys[idx], savedApiKeys[idx - 1]];
        saveAndRender();
      }
    });
  });

  document.querySelectorAll('.move-down-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const idx = parseInt(e.target.getAttribute('data-index'), 10);
      if (idx < savedApiKeys.length - 1) {
        [savedApiKeys[idx], savedApiKeys[idx + 1]] = [savedApiKeys[idx + 1], savedApiKeys[idx]];
        saveAndRender();
      }
    });
  });
}

// Load storage data and enabled state in parallel
applyEnabledState(true); // default while loading
Promise.all([
  new Promise(resolve => chrome.storage.sync.get(['apiKeys', 'apiKeysText', 'bilingualMode', 'targetLanguage'], resolve)),
  new Promise(resolve => chrome.runtime.sendMessage({ type: 'GET_ENABLED' }, res => resolve(res)))
]).then(([data, enabledRes]) => {
  if (data.apiKeys) {
    savedApiKeys = data.apiKeys;
  } else if (data.apiKeysText) {
    savedApiKeys = data.apiKeysText.split('\n').map(k => k.trim()).filter(k => k);
    chrome.storage.sync.set({ apiKeys: savedApiKeys });
  }
  renderApiList();
  if (data.bilingualMode) bilingualToggle.classList.add('active');
  if (data.targetLanguage) targetLangSelect.value = data.targetLanguage;

  extensionEnabled = enabledRes?.enabled !== false;
  applyEnabledState(extensionEnabled);
});

targetLangSelect.addEventListener('change', () => {
  chrome.storage.sync.set({ targetLanguage: targetLangSelect.value });
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

    const bilingualMode = bilingualToggle.classList.contains('active');
    const targetLanguage = targetLangSelect.value || 'Vietnamese';

    const response = await chrome.tabs.sendMessage(tab.id, {
      type: actionType,
      apiKeys,
      bilingualMode,
      targetLanguage,
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
