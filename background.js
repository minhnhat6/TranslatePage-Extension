const MODEL_FALLBACK_CHAIN = [
  'gemini-2.0-flash',
  'gemini-2.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash',
];

const RETRYABLE_STATUSES = new Set([429, 500, 503, 504]);
const MAX_RETRIES_PER_MODEL = 2;
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

  for (const line of translatedText.split('\n')) {
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;

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

  return translations;
}

async function callGemini(apiKey, model, prompt) {
  const response = await fetch(getApiUrl(model), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify(buildRequestBody(prompt, model)),
  });

  if (!response.ok) {
    const errorText = await response.text();
    const error = new Error(formatUserError(response.status, errorText));
    error.status = response.status;
    error.raw = errorText;
    throw error;
  }

  const data = await response.json();
  const parts = data?.candidates?.[0]?.content?.parts ?? [];
  const translatedText = parts
    .filter((part) => !part.thought)
    .map((part) => part.text ?? '')
    .join('\n')
    .trim();

  if (!translatedText) {
    throw new Error('Gemini không trả về nội dung dịch.');
  }

  const translations = parseTranslations(translatedText);
  if (!translations.size) {
    throw new Error('Không parse được kết quả dịch từ Gemini.');
  }

  return translations;
}

async function callOpenAIFormat(apiUrl, apiKey, model, prompt) {
  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    const error = new Error(formatUserError(response.status, errorText));
    error.status = response.status;
    error.raw = errorText;
    throw error;
  }

  const data = await response.json();
  const translatedText = data?.choices?.[0]?.message?.content ?? '';

  if (!translatedText) {
    throw new Error('API không trả về nội dung dịch.');
  }

  const translations = parseTranslations(translatedText);
  if (!translations.size) {
    throw new Error('Không parse được kết quả dịch từ API.');
  }

  return translations;
}

function buildKeyPool(apiKeys) {
  const pool = [];
  
  for (const key of apiKeys) {
    if (key.startsWith('gsk_')) {
      pool.push({
        provider: 'groq',
        priority: 1,
        apiKey: key,
        apiUrl: 'https://api.groq.com/openai/v1/chat/completions',
        models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant']
      });
    } else if (key.startsWith('AIza') || key.startsWith('AQ.')) {
      pool.push({
        provider: 'gemini',
        priority: 2,
        apiKey: key,
        apiUrl: '',
        models: ['gemini-2.0-flash', 'gemini-2.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-2.5-flash']
      });
    } else if (key.startsWith('sk-or-')) {
      pool.push({
        provider: 'openrouter',
        priority: 3,
        apiKey: key,
        apiUrl: 'https://openrouter.ai/api/v1/chat/completions',
        models: ['meta-llama/llama-3.3-70b-instruct:free', 'openrouter/free']
      });
    }
  }

  pool.sort((a, b) => a.priority - b.priority);
  return pool;
}

async function translateLines(apiKeys, lines) {
  const sourceText = lines.map((text, index) => `${index}|||${text}`).join('\n');
  const prompt = [
    'Translate each numbered line into Vietnamese.',
    'IMPORTANT: Some lines contain XML-like tags (e.g. <t0>...</t0>, <t1>...</t1>). These represent fragments of a single sentence.',
    'You MUST preserve all <tX>...</tX> tags exactly. Do not merge, delete, or change the tag names.',
    'Translate the text inside each tag individually, but use the surrounding tags for context so the whole sentence flows naturally.',
    'If a line is ALREADY in Vietnamese, DO NOT translate it. Just return the original text exactly as it is.',
    "Keep the index before '|||' exactly as given.",
    'Return ONLY lines formatted as: <index>|||<vietnamese_text>.',
    'Preserve meaning. Do not add notes, markdown, or blank lines.',
    'Keep proper nouns and dictionary headwords when appropriate.',
    sourceText,
  ].join('\n\n');

  const pool = buildKeyPool(apiKeys);
  let lastError;

  for (const config of pool) {
    for (const model of config.models) {
      const configId = `${config.apiKey}|${model}`;
      const exhaustedUntil = exhaustedConfigs.get(configId) || 0;
      
      if (Date.now() < exhaustedUntil) continue;

      for (let attempt = 0; attempt < MAX_RETRIES_PER_MODEL; attempt += 1) {
        try {
          if (config.provider === 'gemini') {
            return await callGemini(config.apiKey, model, prompt);
          } else {
            return await callOpenAIFormat(config.apiUrl, config.apiKey, model, prompt);
          }
        } catch (error) {
          lastError = error;

          if (error.status === 401 || error.status === 403) {
            // Invalid key, exhaust all models for this key forever
            for (const m of config.models) {
              exhaustedConfigs.set(`${config.apiKey}|${m}`, Date.now() + 365 * 24 * 60 * 60 * 1000);
            }
            break; 
          }

          if (error.status === 429) {
            let penalty = parseRetryDelayMs(error.raw);
            if (error.raw?.includes('free_tier') || error.raw?.includes('Quota exceeded')) {
              penalty = 24 * 60 * 60 * 1000;
            } else if (config.provider === 'groq') {
              penalty = Math.max(penalty, 60000); // Wait at least 60s for Groq rate limits
            }
            exhaustedConfigs.set(configId, Date.now() + penalty);
            break; 
          }

          if (!RETRYABLE_STATUSES.has(error.status)) {
            break; 
          }

          if (attempt === MAX_RETRIES_PER_MODEL - 1) {
            break; 
          }

          const delay = 2000 * (attempt + 1);
          await sleep(delay);
        }
      }
    }
  }

  throw lastError ?? new Error('Tất cả API Key và Model đều không khả dụng hoặc đã hết Quota.');
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'VERIFY_API_KEY') {
    const config = buildKeyPool([message.apiKey])[0];
    if (!config) {
      sendResponse({ ok: false, error: 'Key không đúng định dạng hỗ trợ.' });
      return false;
    }
    
    // We only verify with the first model of the config
    const model = config.models[0];
    const prompt = 'hi';
    
    let verifyPromise;
    if (config.provider === 'gemini') {
      verifyPromise = callGemini(config.apiKey, model, prompt);
    } else {
      verifyPromise = callOpenAIFormat(config.apiUrl, config.apiKey, model, prompt);
    }
    
    verifyPromise
      .then(() => sendResponse({ ok: true }))
      .catch(err => {
        // Since we didn't send a valid translation prompt, it might fail to parse,
        // but if it hits the parse error, the connection and auth were SUCCESSFUL!
        if (err.message.includes('Không parse được') || err.message.includes('không trả về nội dung')) {
          sendResponse({ ok: true });
        } else {
          sendResponse({ ok: false, error: err.message });
        }
      });
      
    return true;
  }

  if (message?.type !== 'GEMINI_TRANSLATE_CHUNK') {
    return false;
  }

  translateLines(message.apiKeys, message.lines)
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

async function ensureContentScript(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
    if (response?.ok) return;
  } catch {
    // Lỗi tức là chưa inject
  }
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content.js'],
  });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'translate_to_vi',
    title: 'Translate to Tiếng Việt',
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

  try {
    await ensureContentScript(tab.id);
  } catch (error) {
    console.error('Không thể inject content script:', error);
    return;
  }

  const { apiKeys, bilingualMode } = await chrome.storage.sync.get(['apiKeys', 'bilingualMode']);
  const keys = apiKeys || [];
  if (keys.length === 0) {
    chrome.tabs.sendMessage(tab.id, { type: 'SHOW_ERROR', message: 'Vui lòng thêm API Key trong popup trước khi dịch.' }).catch(() => {});
    return;
  }

  if (info.selectionText) {
    chrome.tabs.sendMessage(tab.id, { type: 'TRANSLATE_SELECTION', apiKeys: keys, bilingualMode }).catch(() => {});
  } else {
    chrome.tabs.sendMessage(tab.id, { type: 'TRANSLATE_TO_VI', apiKeys: keys, bilingualMode }).catch(() => {});
  }
});
