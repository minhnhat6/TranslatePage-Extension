const MODEL_FALLBACK_CHAIN = [
  'gemini-2.0-flash',
  'gemini-2.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash',
];

const RETRYABLE_STATUSES = new Set([429, 500, 503, 504]);
const MAX_RETRIES_PER_MODEL = 2;
const exhaustedModels = new Set();

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
    return `Gemini API lỗi (${status}): ${errorText}`;
  }

  if (errorText.includes('free_tier') || errorText.includes('Quota exceeded')) {
    return [
      'Đã hết quota miễn phí Gemini (khoảng 20 request/ngày cho mỗi model).',
      'Extension đã gộp trang thành ít request hơn — thử lại ngày mai,',
      'hoặc bật billing tại https://ai.google.dev/gemini-api/docs/rate-limits',
    ].join(' ');
  }

  return 'Gemini đang giới hạn tốc độ. Đang chờ và thử lại...';
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

async function translateWithModel(apiKey, model, prompt) {
  let lastError;

  for (let attempt = 0; attempt < MAX_RETRIES_PER_MODEL; attempt += 1) {
    try {
      return await callGemini(apiKey, model, prompt);
    } catch (error) {
      lastError = error;

      if (!RETRYABLE_STATUSES.has(error.status)) {
        throw error;
      }

      if (error.status === 429 && error.raw?.includes('free_tier')) {
        exhaustedModels.add(model);
        throw error;
      }

      if (attempt === MAX_RETRIES_PER_MODEL - 1) {
        throw error;
      }

      const delay = error.status === 429 ? parseRetryDelayMs(error.raw) : 2000 * (attempt + 1);
      await sleep(delay);
    }
  }

  throw lastError;
}

async function translateLines(apiKey, lines) {
  const sourceText = lines.map((text, index) => `${index}|||${text}`).join('\n');
  const prompt = [
    'Translate each numbered line into Vietnamese.',
    'IMPORTANT: If a line is ALREADY in Vietnamese, DO NOT translate it. Just return the original Vietnamese text exactly as it is.',
    "Keep the index before '|||' exactly as given.",
    'Return ONLY lines formatted as: <index>|||<vietnamese_text>.',
    'Preserve meaning. Do not add notes, markdown, or blank lines.',
    'Keep proper nouns and dictionary headwords when appropriate.',
    sourceText,
  ].join('\n\n');

  const availableModels = MODEL_FALLBACK_CHAIN.filter((model) => !exhaustedModels.has(model));
  let lastError;

  for (const model of availableModels) {
    try {
      return await translateWithModel(apiKey, model, prompt);
    } catch (error) {
      lastError = error;

      const exhaustedModel = getExhaustedModel(error.raw ?? '');
      if (exhaustedModel) {
        exhaustedModels.add(exhaustedModel);
      }

      if (!RETRYABLE_STATUSES.has(error.status)) {
        throw error;
      }
    }
  }

  throw lastError ?? new Error('Tất cả model Gemini đều không khả dụng. Thử lại sau.');
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'GEMINI_TRANSLATE_CHUNK') {
    return false;
  }

  translateLines(message.apiKey, message.lines)
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

  const { geminiApiKey, bilingualMode } = await chrome.storage.sync.get(['geminiApiKey', 'bilingualMode']);
  if (!geminiApiKey) {
    chrome.tabs.sendMessage(tab.id, { type: 'SHOW_ERROR', message: 'Vui lòng nhập API Key trong popup trước khi dịch.' }).catch(() => {});
    return;
  }

  if (info.selectionText) {
    chrome.tabs.sendMessage(tab.id, { type: 'TRANSLATE_SELECTION', apiKey: geminiApiKey, bilingualMode }).catch(() => {});
  } else {
    chrome.tabs.sendMessage(tab.id, { type: 'TRANSLATE_TO_VI', apiKey: geminiApiKey, bilingualMode }).catch(() => {});
  }
});
