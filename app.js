/*
  図面メモ議事録 - Gemini APIキー管理サンプル
  - GitHub Pagesなどの静的サイトで動作
  - 本物のAPIキーはGitHubに置かず、iPad内の txt から読み込む
  - 保存ON時のみ localStorage に保存
*/

const STORAGE_KEY = "zumenMinutes.geminiApiKeys.v1";
const STORAGE_MODEL_KEY = "zumenMinutes.geminiModel.v1";

const state = {
  apiKeys: [],
  nextIndex: 0,
  saveToDevice: false,
  discardAfterRead: true,
  logs: []
};

const $ = (id) => document.getElementById(id);

const els = {
  apiKeyFile: $("apiKeyFile"),
  forgetKeysBtn: $("forgetKeysBtn"),
  saveToDevice: $("saveToDevice"),
  discardAfterRead: $("discardAfterRead"),
  loadedCount: $("loadedCount"),
  rotationMode: $("rotationMode"),
  nextKeyLabel: $("nextKeyLabel"),
  keyList: $("keyList"),
  secureModeLabel: $("secureModeLabel"),
  modelName: $("modelName"),
  testPrompt: $("testPrompt"),
  testGeminiBtn: $("testGeminiBtn"),
  copyLogBtn: $("copyLogBtn"),
  logBox: $("logBox")
};

function boot() {
  loadSavedModel();
  loadSavedKeysIfAny();
  attachEvents();
  render();
  writeLog("準備完了。APIキーファイルを読み込んでください。");
}

function attachEvents() {
  els.apiKeyFile.addEventListener("change", handleApiKeyFile);
  els.forgetKeysBtn.addEventListener("click", () => forgetKeys("手動でAPIキーを破棄しました。"));

  els.saveToDevice.addEventListener("change", () => {
    state.saveToDevice = els.saveToDevice.checked;
    if (state.saveToDevice) {
      saveKeysToDevice();
      writeLog("このiPadにAPIキーを保存しました。共有iPadでは非推奨です。");
    } else {
      localStorage.removeItem(STORAGE_KEY);
      writeLog("このiPadへのAPIキー保存を解除しました。");
    }
    render();
  });

  els.discardAfterRead.addEventListener("change", () => {
    state.discardAfterRead = els.discardAfterRead.checked;
    render();
  });

  els.modelName.addEventListener("change", () => {
    localStorage.setItem(STORAGE_MODEL_KEY, els.modelName.value.trim());
  });

  els.testGeminiBtn.addEventListener("click", async () => {
    const prompt = els.testPrompt.value.trim();
    const model = els.modelName.value.trim();
    if (!prompt) return writeLog("テストプロンプトが空です。", "warn");
    if (!model) return writeLog("モデル名が空です。", "warn");

    try {
      els.testGeminiBtn.disabled = true;
      writeLog(`Gemini接続テストを開始します。model=${model}`);
      const result = await callGeminiWithRotation({ prompt, model });
      writeLog("接続テスト成功。\n" + result.text);
    } catch (error) {
      writeLog("接続テスト失敗。\n" + formatError(error), "error");
    } finally {
      els.testGeminiBtn.disabled = false;
      if (state.discardAfterRead) {
        forgetKeys("読み取り後にキーを破棄する設定のため、APIキーを破棄しました。", { keepSaved: false });
      }
    }
  });

  els.copyLogBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(state.logs.join("\n"));
      writeLog("ログをコピーしました。" );
    } catch {
      writeLog("ログコピーに失敗しました。Safariの権限設定をご確認ください。", "warn");
    }
  });
}

function loadSavedModel() {
  const saved = localStorage.getItem(STORAGE_MODEL_KEY);
  if (saved) els.modelName.value = saved;
}

function loadSavedKeysIfAny() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.keys) && parsed.keys.length > 0) {
      state.apiKeys = parsed.keys.filter(Boolean);
      state.nextIndex = parsed.nextIndex || 0;
      state.saveToDevice = true;
      els.saveToDevice.checked = true;
      writeLog(`このiPadに保存済みのAPIキーを読み込みました。${state.apiKeys.length}件`);
    }
  } catch {
    localStorage.removeItem(STORAGE_KEY);
  }
}

async function handleApiKeyFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  const text = await file.text();
  const keys = parseApiKeys(text);
  if (keys.length === 0) {
    writeLog("APIキーが見つかりません。1行に1キーで入力してください。", "warn");
    return;
  }

  state.apiKeys = keys;
  state.nextIndex = 0;
  if (state.saveToDevice) saveKeysToDevice();
  writeLog(`${file.name} からAPIキーを読み込みました。${keys.length}件`);
  render();
}

function parseApiKeys(text) {
  const unique = new Set();
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .forEach((line) => unique.add(line));
  return [...unique];
}

function saveKeysToDevice() {
  if (!state.saveToDevice || state.apiKeys.length === 0) return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    keys: state.apiKeys,
    nextIndex: state.nextIndex,
    savedAt: new Date().toISOString()
  }));
}

function forgetKeys(message = "APIキーを破棄しました。", options = {}) {
  const { keepSaved = false } = options;
  state.apiKeys = [];
  state.nextIndex = 0;
  els.apiKeyFile.value = "";
  if (!keepSaved) {
    localStorage.removeItem(STORAGE_KEY);
    state.saveToDevice = false;
    els.saveToDevice.checked = false;
  }
  writeLog(message);
  render();
}

function getNextApiKey() {
  if (state.apiKeys.length === 0) {
    throw new Error("APIキーが読み込まれていません。");
  }
  const index = state.nextIndex % state.apiKeys.length;
  const key = state.apiKeys[index];
  state.nextIndex = (index + 1) % state.apiKeys.length;
  saveKeysToDevice();
  render();
  return { key, index };
}

function shouldRotate(error) {
  const message = `${error?.message || ""} ${error?.status || ""}`.toLowerCase();
  return ["429", "resource_exhausted", "quota", "rate limit", "rate_limit"].some((token) => message.includes(token));
}

async function callGeminiWithRotation({ prompt, model, imageBase64 = null, mimeType = "image/jpeg" }) {
  if (state.apiKeys.length === 0) throw new Error("APIキーが読み込まれていません。");

  const maxTries = state.apiKeys.length;
  let lastError = null;

  for (let attempt = 0; attempt < maxTries; attempt++) {
    const { key, index } = getNextApiKey();
    const masked = maskKey(key);
    writeLog(`Geminiへ送信します。key=${index + 1}/${state.apiKeys.length} ${masked}`);

    try {
      return await callGeminiOnce({ key, prompt, model, imageBase64, mimeType });
    } catch (error) {
      lastError = error;
      writeLog(`key ${index + 1} でエラー: ${formatError(error)}`, "warn");
      if (!shouldRotate(error)) break;
      writeLog("quota/429系の可能性があるため、次のキーへ切り替えます。", "warn");
    }
  }
  throw lastError || new Error("Gemini呼び出しに失敗しました。");
}

async function callGeminiOnce({ key, prompt, model, imageBase64 = null, mimeType = "image/jpeg" }) {
  const parts = [{ text: prompt }];
  if (imageBase64) {
    parts.push({
      inline_data: {
        mime_type: mimeType,
        data: imageBase64
      }
    });
  }

  const body = {
    contents: [{ role: "user", parts }]
  };

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(json?.error?.message || `HTTP ${response.status}`);
    err.status = response.status;
    err.details = json;
    throw err;
  }

  const text = json?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("\n").trim() || "";
  return { text, raw: json };
}

function render() {
  const count = state.apiKeys.length;
  els.loadedCount.textContent = `${count}件`;
  els.rotationMode.textContent = count > 0 ? "ローテーション" : "未設定";
  els.nextKeyLabel.textContent = count > 0 ? `${(state.nextIndex % count) + 1}番目` : "なし";

  els.secureModeLabel.className = "status-pill";
  if (count === 0) {
    els.secureModeLabel.textContent = "APIキー未読込";
  } else if (state.saveToDevice) {
    els.secureModeLabel.textContent = "iPad内に保存中";
    els.secureModeLabel.classList.add("warning");
  } else {
    els.secureModeLabel.textContent = "一時読込中";
    els.secureModeLabel.classList.add("ready");
  }

  if (count === 0) {
    els.keyList.className = "key-list empty";
    els.keyList.textContent = "APIキーはまだ読み込まれていません。";
    return;
  }

  els.keyList.className = "key-list";
  els.keyList.innerHTML = state.apiKeys.map((key, index) => {
    const isNext = index === (state.nextIndex % count);
    return `
      <div class="key-row">
        <span>${index + 1}. ${maskKey(key)}</span>
        <span class="key-tag ${isNext ? "next" : ""}">${isNext ? "次に使用" : "待機"}</span>
      </div>`;
  }).join("");
}

function maskKey(key) {
  if (!key) return "";
  if (key.length <= 12) return "****";
  return `${key.slice(0, 6)}••••••••${key.slice(-6)}`;
}

function writeLog(message, level = "info") {
  const prefix = level === "error" ? "ERROR" : level === "warn" ? "WARN" : "INFO";
  const line = `[${new Date().toLocaleTimeString("ja-JP")}] ${prefix}: ${message}`;
  state.logs.push(line);
  els.logBox.textContent = state.logs.slice(-80).join("\n");
  els.logBox.scrollTop = els.logBox.scrollHeight;
}

function formatError(error) {
  if (!error) return "不明なエラー";
  const status = error.status ? `HTTP ${error.status}: ` : "";
  return `${status}${error.message || String(error)}`;
}

boot();
