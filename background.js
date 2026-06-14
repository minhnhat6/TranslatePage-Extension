

const RETRYABLE_STATUSES = new Set([429, 500, 503, 504]);
const exhaustedConfigs = new Map(); // "apiKey|model" -> timestamp


function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getApiUrl(model) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
}

function buildRequestBody(prompt, model) {
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.2,
    },
  };

  if (/2\.5|3\./.test(model)) {
    body.generationConfig.thinkingConfig = { thinkingBudget: 0 };
  }

  return body;
}

if (chrome.storage?.session?.setAccessLevel) {
  chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });
}

// Broadcast enabled state to all tabs
async function broadcastEnabled(enabled) {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    chrome.tabs.sendMessage(tab.id, { type: 'SET_ENABLED', enabled }).catch(() => {});
  }
}

function parseRetryDelayMs(errorText) {
  try {
    const json = JSON.parse(errorText);
    const details = json?.error?.details ?? [];

    for (const detail of details) {
      if (detail['@type']?.includes('RetryInfo') && detail.retryDelay) {
        const seconds = parseFloat(String(detail.retryDelay).replace('s', ''));
        if (!Number.isNaN(seconds)) {
          return Math.ceil(seconds * 1000) + 500;
        }
      }
    }

    const message = json?.error?.message ?? '';
    const match = message.match(/retry in (\d+\.?\d*)s/i);
    if (match) {
      return Math.ceil(parseFloat(match[1]) * 1000) + 500;
    }
  } catch {
    // ignore parse errors
  }

  return 3000;
}

function getExhaustedModel(errorText) {
  const match = errorText.match(/"model":\s*"([^"]+)"/);
  return match?.[1] ?? null;
}

function formatUserError(status, errorText) {
  if (status !== 429) {
    return `API lỗi (${status}): ${errorText}`;
  }

  if (errorText.includes('free_tier') || errorText.includes('Quota exceeded') || errorText.includes('rate_limit_exceeded')) {
    return [
      'Đã hết quota hoặc giới hạn tốc độ miễn phí của API.',
      'Hãy thử lại sau, hoặc thêm API Key khác (Gemini/Groq) vào danh sách để dự phòng.',
    ].join(' ');
  }

  return 'API đang giới hạn tốc độ. Đang chờ và thử lại...';
}

function parseTranslations(translatedText) {
  const translations = new Map();
  const lines = translatedText.split('\n').map(l => l.trim()).filter(Boolean);

  for (const trimmedLine of lines) {
    const match = trimmedLine.match(/^(\d+)\|\|\|(.*)$/);
    if (match) {
      translations.set(Number(match[1]), match[2].trim());
      continue;
    }

    const looseMatch = trimmedLine.match(/^(\d+)[.:)\s]+(.*)$/);
    if (looseMatch) {
      translations.set(Number(looseMatch[1]), looseMatch[2].trim());
    }
  }

  if (translations.size === 0 && lines.length === 1) {
    const cleaned = lines[0].replace(/^(Dịch:|Bản dịch:|Translation:)/i, '').trim();
    translations.set(0, cleaned);
  }

  return translations;
}

async function callApi(config, model, prompt) {
  let url, headers, body, extractText;

  if (config.provider === 'gemini') {
    url = getApiUrl(model);
    headers = { 'Content-Type': 'application/json', 'x-goog-api-key': config.apiKey };
    body = buildRequestBody(prompt, model);
    extractText = (data) => {
      const parts = data?.candidates?.[0]?.content?.parts ?? [];
      return parts.filter(p => !p.thought).map(p => p.text ?? '').join('\n').trim();
    };
  } else if (config.provider === 'anthropic') {
    url = 'https://api.anthropic.com/v1/messages';
    headers = {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    };
    body = { model, max_tokens: 4000, temperature: 0.2, messages: [{ role: 'user', content: prompt }] };
    extractText = (data) => data?.content?.[0]?.text ?? '';
  } else {
    url = config.apiUrl;
    headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.apiKey}` };
    body = { model, messages: [{ role: 'user', content: prompt }], temperature: 0.2 };
    extractText = (data) => data?.choices?.[0]?.message?.content ?? '';
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    const error = new Error(formatUserError(response.status, errorText));
    error.status = response.status;
    error.raw = errorText;
    throw error;
  }

  const data = await response.json();
  const translatedText = extractText(data);

  if (!translatedText) throw new Error('API không trả về nội dung dịch.');

  const translations = parseTranslations(translatedText);
  if (!translations.size) throw new Error('Không parse được kết quả dịch từ API.');

  return translations;
}

function buildKeyPool(apiKeys) {
  const pool = [];
  
  for (const key of apiKeys) {
    if (key.startsWith('gsk_')) {
      pool.push({
        provider: 'groq',
        apiKey: key,
        apiUrl: 'https://api.groq.com/openai/v1/chat/completions',
        models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant']
      });
    } else if (key.startsWith('AIza') || key.startsWith('AQ.')) {
      pool.push({
        provider: 'gemini',
        apiKey: key,
        apiUrl: '',
        models: ['gemini-2.0-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-flash']
      });
    } else if (key.startsWith('sk-or-')) {
      pool.push({
        provider: 'openrouter',
        apiKey: key,
        apiUrl: 'https://openrouter.ai/api/v1/chat/completions',
        models: ['meta-llama/llama-3.3-70b-instruct:free', 'openrouter/free']
      });
    } else if (key.startsWith('sk-ant-')) {
      pool.push({
        provider: 'anthropic',
        apiKey: key,
        apiUrl: '',
        models: ['claude-3-5-haiku-20241022', 'claude-3-haiku-20240307']
      });
    } else if (key.startsWith('ghp_') || key.startsWith('github_pat_')) {
      pool.push({
        provider: 'github',
        apiKey: key,
        apiUrl: 'https://models.inference.ai.azure.com/chat/completions',
        models: ['gpt-4o-mini', 'meta-llama-3.1-70b-instruct', 'cohere-command-r']
      });
    } else if (key.startsWith('nvapi-')) {
      pool.push({
        provider: 'nvidia',
        apiKey: key,
        apiUrl: 'https://integrate.api.nvidia.com/v1/chat/completions',
        models: ['meta/llama-3.1-70b-instruct', 'meta/llama-3.1-8b-instruct']
      });
    } else if (key.startsWith('sk-proj-') || (key.startsWith('sk-') && !key.startsWith('sk-or-') && !key.startsWith('sk-ant-'))) {
      pool.push({
        provider: 'openai',
        apiKey: key,
        apiUrl: 'https://api.openai.com/v1/chat/completions',
        models: ['gpt-4o-mini', 'gpt-4o']
      });
    } else if (key.startsWith('sta_')) {
      pool.push({
        provider: 'freetheai',
        apiKey: key,
        apiUrl: 'https://api.freetheai.xyz/v1/chat/completions',
        models: ['gpt-4o-mini', 'gpt-4o', 'opc/gpt-4o-mini']
      });
    } else if (key.startsWith('csk-')) {
      pool.push({
        provider: 'cerebras',
        apiKey: key,
        apiUrl: 'https://api.cerebras.ai/v1/chat/completions',
        models: ['llama3.1-70b', 'llama-3.3-70b', 'llama3.3-70b', 'llama3.1-8b', 'gpt-oss-120b', 'zai-glm-4.7']
      });
    } else if (/^[A-Za-z0-9]{32}$/.test(key)) {
      pool.push({
        provider: 'mistral',
        apiKey: key,
        apiUrl: 'https://api.mistral.ai/v1/chat/completions',
        models: ['mistral-large-latest', 'mistral-small-latest', 'open-mistral-nemo']
      });
    }
  }

  return pool;
}

let cachedApiKeysJSON = '';
let cachedKeyPool = [];
const activeConnections = new Map();

function buildKeyPoolCached(apiKeys) {
  const json = JSON.stringify(apiKeys);
  if (json !== cachedApiKeysJSON) {
    cachedApiKeysJSON = json;
    cachedKeyPool = buildKeyPool(apiKeys);
  }
  return cachedKeyPool;
}

function cleanupExhausted() {
  const now = Date.now();
  for (const [configId, exhaustedUntil] of exhaustedConfigs.entries()) {
    if (now >= exhaustedUntil) {
      exhaustedConfigs.delete(configId);
    }
  }
}

async function translateLines(apiKeys, lines, targetLanguage = 'Vietnamese') {
  const sourceText = lines.map((text, index) => `${index}|||${text}`).join('\n');
  const hasTags = sourceText.includes('<t0>');
  const prompt = [
    'You are a professional translator.',
    `Translate the following numbered lines into ${targetLanguage}.`,
    hasTags ? 'IMPORTANT: Some lines contain XML-like tags (e.g. <t0>...). Preserve them exactly in the translated text.' : '',
    "You MUST return the exact same number of lines. Each line MUST start with its original <index>|||.",
    'DO NOT output any source language text. DO NOT repeat the source text. DO NOT add explanations.',
    'Format: <index>|||<translation>',
    '--- SOURCE TEXT ---',
    sourceText,
  ].filter(Boolean).join('\n');

  cleanupExhausted();
  const pool = buildKeyPoolCached(apiKeys);
  let lastError;
  let attempts = 0;
  const totalModels = pool.reduce((acc, config) => acc + config.models.length, 0);

  while (attempts < totalModels * 2) {
    let bestConfig = null;
    for (const config of pool) {
      for (const model of config.models) {
        const configId = `${config.apiKey}|${model}`;
        const exhaustedUntil = exhaustedConfigs.get(configId) || 0;
        
        if (Date.now() < exhaustedUntil) continue;

        const connections = activeConnections.get(configId) || 0;
        const maxConn = config.provider === 'gemini' ? 2 : 4;

        if (connections < maxConn) {
          bestConfig = { config, model, configId };
          break;
        }
      }
      if (bestConfig) break;
    }

    if (!bestConfig) {
      let hasAvailableNotExhausted = false;
      for (const config of pool) {
        for (const model of config.models) {
          const configId = `${config.apiKey}|${model}`;
          if (Date.now() >= (exhaustedConfigs.get(configId) || 0)) {
            hasAvailableNotExhausted = true;
            break;
          }
        }
      }

      if (!hasAvailableNotExhausted) {
        throw new Error('Tất cả API Keys đều đã cạn kiệt Quota hoặc bị giới hạn tốc độ. Vui lòng thêm Key mới hoặc đợi.');
      }

      await sleep(1000);
      continue;
    }

    activeConnections.set(bestConfig.configId, (activeConnections.get(bestConfig.configId) || 0) + 1);
    
    try {
      return await callApi(bestConfig.config, bestConfig.model, prompt);
    } catch (error) {
      lastError = error;
      attempts++;

      if (error.status === 401 || error.status === 403) {
        for (const m of bestConfig.config.models) {
          exhaustedConfigs.set(`${bestConfig.config.apiKey}|${m}`, Date.now() + 365 * 24 * 60 * 60 * 1000);
        }
      } else if (error.status === 429) {
        let penalty = parseRetryDelayMs(error.raw);
        if (error.raw?.includes('free_tier') || error.raw?.includes('Quota exceeded')) {
          penalty = 24 * 60 * 60 * 1000;
        } else if (bestConfig.config.provider === 'groq') {
          penalty = Math.max(penalty, 60000);
        }
        exhaustedConfigs.set(bestConfig.configId, Date.now() + penalty);
      } else if (RETRYABLE_STATUSES.has(error.status)) {
        exhaustedConfigs.set(bestConfig.configId, Date.now() + 2000);
      } else {
        exhaustedConfigs.set(bestConfig.configId, Date.now() + 10000);
      }
    } finally {
      activeConnections.set(bestConfig.configId, activeConnections.get(bestConfig.configId) - 1);
    }
  }

  throw lastError || new Error('Translation failed after multiple retries.');
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'VERIFY_API_KEY') {
    const config = buildKeyPool([message.apiKey])[0];
    if (!config) {
      sendResponse({ ok: false, error: 'Key không đúng định dạng hỗ trợ.' });
      return false;
    }
    
    const prompt = 'hi';
    
    async function verifyAllModels() {
      let lastErrorMsg = '';
      for (const model of config.models) {
        try {
          await callApi(config, model, prompt);
          return { ok: true };
        } catch (err) {
          if (err.message.includes('Không parse được') || err.message.includes('không trả về nội dung')) {
            return { ok: true };
          }
          lastErrorMsg = err.message;
          if (err.message.includes('401') || err.message.includes('403')) {
            return { ok: false, error: err.message };
          }
        }
      }
      return { ok: false, error: lastErrorMsg };
    }
    
    verifyAllModels().then(sendResponse);
      
    return true;
  }

  if (message?.type === 'GET_ENABLED') {
    chrome.storage.session.get(['extensionEnabled'], (data) => {
      // Default to true if never set (e.g. fresh browser session)
      const enabled = data.extensionEnabled !== false;
      sendResponse({ enabled });
    });
    return true;
  }

  if (message?.type === 'SET_ENABLED') {
    const enabled = message.enabled;
    chrome.storage.session.set({ extensionEnabled: enabled }, async () => {
      await broadcastEnabled(enabled);
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message?.type !== 'GEMINI_TRANSLATE_CHUNK') {
    return false;
  }

  translateLines(message.apiKeys, message.lines, message.targetLanguage)
    .then((translations) => {
      sendResponse({
        ok: true,
        translations: Object.fromEntries(translations),
      });
    })
    .catch((error) => {
      sendResponse({ ok: false, error: error.message });
    });

  return true;
});



chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'translate_to_vi',
    title: 'Translate Selection',
    contexts: ['page', 'selection'],
  });
  chrome.contextMenus.create({
    id: 'restore_original',
    title: 'Khôi phục bản gốc',
    contexts: ['page', 'selection'],
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;

  if (info.menuItemId === 'restore_original') {
    chrome.tabs.sendMessage(tab.id, { type: 'REMOVE_TRANSLATIONS' }).catch(() => {});
    return;
  }

  if (info.menuItemId !== 'translate_to_vi') return;

  // Check enabled state before translating
  const sessionData = await chrome.storage.session.get(['extensionEnabled']);
  if (sessionData.extensionEnabled === false) return;

  const { apiKeys, bilingualMode, targetLanguage } = await chrome.storage.sync.get(['apiKeys', 'bilingualMode', 'targetLanguage']);
  const keys = apiKeys || [];
  const targetLang = targetLanguage || 'Vietnamese';
  if (keys.length === 0) {
    chrome.tabs.sendMessage(tab.id, { type: 'SHOW_ERROR', message: 'Vui lòng thêm API Key trong popup trước khi dịch.' }).catch(() => {});
    return;
  }

  if (info.selectionText) {
    chrome.tabs.sendMessage(tab.id, { type: 'TRANSLATE_SELECTION', apiKeys: keys, bilingualMode, targetLanguage: targetLang }).catch(() => {});
  } else {
    chrome.tabs.sendMessage(tab.id, { type: 'TRANSLATE_TO_VI', apiKeys: keys, bilingualMode, targetLanguage: targetLang }).catch(() => {});
  }
});
