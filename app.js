const $ = (id) => document.getElementById(id);

const DEFAULT_PROMPT = `あなたはマンション設計・インテリアオプション打合せの図面メモ整理担当です。
添付された図面画像から、手書きメモ、矢印、引き出し線、丸囲みを読み取り、部屋名・対象箇所・指示内容・区分・状態に分類してください。

重要ルール：
- 必ず items に1件以上入れてください。
- 何も読めない場合でも、items に「画像から明確な手書きメモを確認できません。撮影状態または文字サイズを確認してください。」を1件入れてください。
- 引き出し線、矢印、丸囲みの先を優先して、どの部屋・部位の内容か判断してください。
- 推測で断定しないでください。不明な場合は status を「要確認」または「未分類」、confidence を「低」にしてください。
- 建築用語は文脈で補正してください。例：CL=クローゼット、WIC=ウォークインクローゼット、SIC=シューズインクローク、LD=リビングダイニング、PS=パイプスペース、MB=メーターボックス、DL=ダウンライト、下地=壁下地補強。
- 出力は必ずJSONのみ。説明文、Markdown、コードフェンスは不要です。

JSON形式：
{
  "summary": "全体要約",
  "unresolved": ["未解決事項1", "未解決事項2"],
  "items": [
    {
      "room": "洋室1",
      "target": "CL",
      "content": "可動棚を3段追加",
      "category": "追加",
      "status": "要見積",
      "confidence": "高",
      "reason": "手書きメモから引き出し線が洋室1のCLへ向かっているため"
    }
  ]
}`;

let apiKeys = [];
let keyIndex = 0;
let images = [];
let items = [];
let currentProjectId = crypto.randomUUID ? crypto.randomUUID() : String(Date.now());
let currentFilter = "all";
let db = null;
let cameraStream = null;
let lastGeminiText = "";

function log(message) {
  const box = $("logBox");
  const time = new Date().toLocaleTimeString("ja-JP", {hour:"2-digit", minute:"2-digit", second:"2-digit"});
  box.textContent += `[${time}] ${message}\n`;
  box.scrollTop = box.scrollHeight;
}

function updateKeyStatus() {
  $("keyStatus").textContent = `読み込み済みキー：${apiKeys.length}件 / 使用モード：ローテーション`;
}

function parseKeys(text) {
  return text.split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith("#"));
}

function nextKey() {
  if (!apiKeys.length) throw new Error("APIキーが読み込まれていません。");
  const key = apiKeys[keyIndex % apiKeys.length];
  keyIndex += 1;
  return key;
}

function shouldRotateError(status, bodyText) {
  return status === 429 || /RESOURCE_EXHAUSTED|quota|rate|limit|PERMISSION_DENIED/i.test(bodyText || "");
}

async function callGemini(parts, retryCount = 0) {
  const model = $("modelName").value.trim() || "gemini-2.5-flash";
  const key = nextKey();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;

  const payload = {
    contents: [{ role: "user", parts }],
    generationConfig: { temperature: 0.05, responseMimeType: "application/json" }
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify(payload)
  });
  const text = await res.text();

  if (!res.ok) {
    log(`Geminiエラー status=${res.status}`);
    if (retryCount < apiKeys.length - 1 && shouldRotateError(res.status, text)) {
      log("次のAPIキーへ切替えて再試行します。");
      return callGemini(parts, retryCount + 1);
    }
    throw new Error(text.slice(0, 1000));
  }

  const data = JSON.parse(text);
  const out = data?.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("\n") || "";
  lastGeminiText = out;
  return out;
}

function parseGeminiJson(text) {
  const cleaned = String(text || "")
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();

  try { return JSON.parse(cleaned); } catch (e) {}

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));

  const arrStart = cleaned.indexOf("[");
  const arrEnd = cleaned.lastIndexOf("]");
  if (arrStart >= 0 && arrEnd > arrStart) return {items: JSON.parse(cleaned.slice(arrStart, arrEnd + 1))};

  throw new Error("Gemini応答をJSONとして解析できませんでした。");
}

function normalizeItem(raw = {}) {
  const content = raw.content || raw.memo || raw.text || raw.note || raw.内容 || raw.メモ || raw.指示 || "";
  return {
    id: raw.id || (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random())),
    room: raw.room || raw.room_name || raw.place || raw.部屋 || raw.場所 || "未分類",
    target: raw.target || raw.part || raw.対象 || raw.部位 || "",
    content: content || "内容未取得。Gemini応答を確認してください。",
    category: raw.category || raw.type || raw.区分 || "確認",
    status: raw.status || raw.状態 || "要確認",
    confidence: raw.confidence || raw.信頼度 || "低",
    reason: raw.reason || raw.理由 || raw.note || raw.備考 || ""
  };
}

function extractItemsFromAny(data) {
  if (Array.isArray(data)) return data.map(normalizeItem);

  const directKeys = ["items", "memos", "results", "result", "notes", "entries", "確認事項", "項目", "読み取り結果"];
  for (const k of directKeys) {
    if (Array.isArray(data?.[k])) return data[k].map(normalizeItem);
  }

  const found = [];
  function walk(obj) {
    if (!obj || typeof obj !== "object") return;
    if (Array.isArray(obj)) {
      const looksLikeItems = obj.some(x => x && typeof x === "object" && (
        "content" in x || "memo" in x || "text" in x || "内容" in x || "部屋" in x || "room" in x
      ));
      if (looksLikeItems) found.push(...obj.map(normalizeItem));
      else obj.forEach(walk);
      return;
    }
    Object.values(obj).forEach(walk);
  }
  walk(data);
  if (found.length) return found;

  const summary = data?.summary || data?.要約 || data?.全体要約 || "";
  const unresolved = Array.isArray(data?.unresolved) ? data.unresolved.join("\n") : "";
  const fallbackText = [summary, unresolved].filter(Boolean).join("\n");
  if (fallbackText) {
    return [normalizeItem({
      room: "全体",
      target: "要約",
      content: fallbackText,
      category: "確認",
      status: "要確認",
      confidence: "中",
      reason: "Gemini応答にitems配列がなかったため、要約を仮登録"
    })];
  }

  return [];
}

function setDefaultDate() {
  const d = new Date();
  $("meetingDate").value = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

function getProjectPayload() {
  return {
    id: currentProjectId,
    projectName: $("projectName").value.trim(),
    unitNo: $("unitNo").value.trim(),
    meetingDate: $("meetingDate").value,
    clientName: $("clientName").value.trim(),
    attendees: $("attendees").value.trim(),
    note: $("projectNote").value.trim(),
    promptText: $("promptText").value,
    items,
    images,
    lastGeminiText,
    updatedAt: new Date().toISOString()
  };
}

function applyProject(project) {
  currentProjectId = project.id || (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()));
  $("projectName").value = project.projectName || "";
  $("unitNo").value = project.unitNo || "";
  $("meetingDate").value = project.meetingDate || "";
  $("clientName").value = project.clientName || "";
  $("attendees").value = project.attendees || "";
  $("projectNote").value = project.note || "";
  $("promptText").value = project.promptText || DEFAULT_PROMPT;
  items = (project.items || []).map(normalizeItem);
  images = project.images || [];
  lastGeminiText = project.lastGeminiText || "";
  renderImages();
  renderItems();
  log(`案件を読み込みました：${project.projectName || "無題"}`);
}

async function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("gijiroku_db_v03", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("projects", {keyPath:"id"});
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveProject() {
  const payload = getProjectPayload();
  if (!payload.projectName) payload.projectName = "無題案件";
  return new Promise((resolve, reject) => {
    const tx = db.transaction("projects", "readwrite");
    tx.objectStore("projects").put(payload);
    tx.oncomplete = () => { log("案件をiPad内ブラウザ保存しました。"); renderProjectList(); resolve(); };
    tx.onerror = () => reject(tx.error);
  });
}

async function getAllProjects() {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("projects", "readonly");
    const req = tx.objectStore("projects").getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function renderProjectList() {
  const list = $("projectList");
  list.innerHTML = "";
  const projects = await getAllProjects();
  projects.sort((a,b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  if (!projects.length) {
    list.innerHTML = `<p class="status">保存案件なし</p>`;
    return;
  }
  for (const p of projects) {
    const row = document.createElement("div");
    row.className = "project-row";
    row.innerHTML = `<strong>${escapeHtml(p.projectName || "無題案件")} ${escapeHtml(p.unitNo || "")}</strong><span>${escapeHtml(p.meetingDate || "")} / ${p.items?.length || 0}件</span>`;
    row.addEventListener("click", () => applyProject(p));
    list.appendChild(row);
  }
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

async function fileToDataUrl(file, maxSize = 1600) {
  if (file.type === "application/pdf") {
    throw new Error("この試作版ではPDF画像化は未対応です。PDFはスクショまたは画像にして読み込んでください。");
  }
  const dataUrl = await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(file);
  });
  return await resizeDataUrl(dataUrl, file.type || "image/jpeg", maxSize);
}

async function resizeDataUrl(dataUrl, mimeType, maxSize) {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const ratio = Math.min(1, maxSize / Math.max(img.width, img.height));
  const w = Math.round(img.width * ratio);
  const h = Math.round(img.height * ratio);
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  canvas.getContext("2d").drawImage(img, 0, 0, w, h);
  const outType = mimeType.includes("png") ? "image/png" : "image/jpeg";
  return canvas.toDataURL(outType, 0.9);
}

function addImageDataUrl(dataUrl, name = "camera.jpg") {
  const match = dataUrl.match(/^data:(.*?);base64,(.*)$/);
  const mimeType = match ? match[1] : "image/jpeg";
  const base64 = match ? match[2] : dataUrl;
  images.push({
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()+Math.random()),
    name, mimeType, dataUrl, base64
  });
  renderImages();
}

function renderImages() {
  $("imageCount").textContent = `${images.length}枚`;
  const gallery = $("imageGallery");
  gallery.innerHTML = "";
  for (const img of images) {
    const card = document.createElement("div");
    card.className = "image-card";
    card.innerHTML = `
      <img src="${img.dataUrl}" alt="">
      <div class="image-meta">
        <span>${escapeHtml(img.name || "image")}</span>
        <button class="danger-outline">削除</button>
      </div>`;
    card.querySelector("button").addEventListener("click", () => {
      images = images.filter(x => x.id !== img.id);
      renderImages();
    });
    gallery.appendChild(card);
  }
}

function itemNeedsCheck(item) {
  return item.status === "要確認" || item.status === "未分類" || item.confidence === "低" || !item.room || item.room === "未分類";
}

function renderItems() {
  const container = $("itemsContainer");
  container.innerHTML = "";
  const visibleItems = items.filter(item => currentFilter === "all" ? true : itemNeedsCheck(item));
  const needCount = items.filter(itemNeedsCheck).length;
  $("resultStats").textContent = `全${items.length}件 / 要確認${needCount}件`;
  $("readStatus").textContent = items.length ? "読取済" : "未読取";
  $("readStatus").className = items.length ? "badge ok" : "badge neutral";

  if (!visibleItems.length) {
    container.innerHTML = `<p class="status">表示する項目がありません。</p>`;
    return;
  }

  for (const item of visibleItems) {
    const tpl = $("itemCardTemplate").content.cloneNode(true);
    const card = tpl.querySelector(".item-card");
    if (itemNeedsCheck(item)) card.classList.add("needs-check");
    if (item.confidence === "低") card.classList.add("low");

    tpl.querySelector(".item-title").textContent = `${item.room || "未分類"} / ${item.target || "対象未設定"}`;
    const bind = (selector, key) => {
      const el = tpl.querySelector(selector);
      el.value = item[key] || "";
      el.addEventListener("input", () => {
        item[key] = el.value;
        tpl.querySelector(".item-title").textContent = `${item.room || "未分類"} / ${item.target || "対象未設定"}`;
      });
      el.addEventListener("change", () => { item[key] = el.value; renderItems(); });
    };
    bind(".field-room", "room");
    bind(".field-target", "target");
    bind(".field-category", "category");
    bind(".field-status", "status");
    bind(".field-confidence", "confidence");
    bind(".field-content", "content");
    bind(".field-reason", "reason");

    tpl.querySelector(".delete-item").addEventListener("click", () => {
      items = items.filter(x => x.id !== item.id);
      renderItems();
    });

    container.appendChild(tpl);
  }
}

function buildAiPrompt() {
  const mode = $("readMode").value;
  const modeText = {
    standard: "標準モード：過不足なく読み取り、部屋別に整理してください。",
    high_precision: "高精度モード：時間がかかってもよいので、引き出し線、矢印、丸囲み、部屋名の位置関係を詳しく判断してください。",
    line_focus: "引き出し線重視モード：メモ本文よりも、線や矢印の先端が指す部屋・部位を優先してください。",
    handwriting_focus: "手書き重視モード：手書き文字の判読を優先し、建築用語として自然な補正をしてください。"
  }[mode];

  return `${$("promptText").value}

追加の厳守事項：
- items は絶対に空配列にしないでください。
- 画像に手書きメモが見当たらない場合でも、その旨を items に1件入れてください。
- 各項目は room, target, content, category, status, confidence, reason を必ず持たせてください。

今回の案件情報：
- 案件名：${$("projectName").value || "未入力"}
- 住戸番号：${$("unitNo").value || "未入力"}
- 打合せ日：${$("meetingDate").value || "未入力"}
- 打合せ相手：${$("clientName").value || "未入力"}
- 出席者：${$("attendees").value || "未入力"}

${modeText}

画像は${images.length}枚あります。全画像を総合して、JSONのみで返してください。`;
}

async function handleGeminiRead() {
  if (!apiKeys.length) return alert("先に gemini_api_key.txt を読み込んでください。");
  if (!images.length) return alert("先に図面・手書き画像を追加してください。");

  $("readGeminiBtn").disabled = true;
  log("Gemini読み取りを開始します。");

  try {
    const parts = [{text: buildAiPrompt()}];
    for (const img of images) parts.push({inline_data: {mime_type: img.mimeType, data: img.base64}});

    const text = await callGemini(parts);
    log(`Gemini応答先頭：${text.slice(0, 500)}`);
    const data = parseGeminiJson(text);
    items = extractItemsFromAny(data);

    if (!items.length) {
      items = [normalizeItem({
        room: "未分類",
        target: "画像全体",
        content: "Geminiは応答しましたが、読み取り項目が0件でした。画像の解像度・手書きメモの有無・プロンプトを確認してください。",
        category: "確認",
        status: "要確認",
        confidence: "低",
        reason: "itemsが空配列、または項目として解釈できる配列が見つからなかったため"
      })];
    }

    renderItems();
    await saveProject();
    log(`読み取り完了：${items.length}件`);
  } catch (e) {
    console.error(e);
    log(`エラー：${e.message || e}`);
    alert("読み取りに失敗しました。ログを確認してください。");
  } finally {
    $("readGeminiBtn").disabled = false;
    if ($("discardKeysCheck").checked && !$("saveKeysCheck").checked) {
      apiKeys = [];
      keyIndex = 0;
      updateKeyStatus();
      log("読み取り後にAPIキーを破棄しました。");
    }
  }
}

function downloadBlob(filename, content, mime) {
  const blob = new Blob([content], {type:mime});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function safeName(s) {
  return String(s || "無題").replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, "_");
}

function exportJson() {
  const payload = getProjectPayload();
  downloadBlob(`${safeName(payload.projectName)}_${safeName(payload.unitNo)}_gijiroku.json`, JSON.stringify(payload, null, 2), "application/json");
}

function exportRaw() {
  downloadBlob(`gemini_raw_${new Date().toISOString().replace(/[:.]/g,"-")}.txt`, lastGeminiText || "応答なし", "text/plain;charset=utf-8");
}

function xmlEscape(s) {
  return String(s || "").replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
}

function wordTextRuns(text) {
  const lines = String(text || "").split(/\r?\n/);
  return lines.map((line, i) => {
    const br = i === 0 ? "" : "<w:br/>";
    return `${br}<w:r><w:t xml:space="preserve">${xmlEscape(line)}</w:t></w:r>`;
  }).join("");
}

function wordParagraph(text, opts = {}) {
  const style = opts.heading ? `<w:pPr><w:pStyle w:val="${opts.heading}"/></w:pPr>` : "";
  return `<w:p>${style}${wordTextRuns(text)}</w:p>`;
}

function wordCell(text) {
  return `<w:tc><w:tcPr><w:tcW w:w="2400" w:type="dxa"/></w:tcPr>${wordParagraph(text)}</w:tc>`;
}

function wordRow(cells) {
  return `<w:tr>${cells.map(wordCell).join("")}</w:tr>`;
}

function crc32(bytes) {
  if (!crc32.table) {
    crc32.table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      crc32.table[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = crc32.table[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosTimeDate(date = new Date()) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosYear = Math.max(1980, date.getFullYear()) - 1980;
  const d = (dosYear << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return {time, date: d};
}

function makeZipBlob(files) {
  const enc = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const dt = dosTimeDate();

  for (const file of files) {
    const nameBytes = enc.encode(file.name);
    const dataBytes = typeof file.data === "string" ? enc.encode(file.data) : file.data;
    const crc = crc32(dataBytes);
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0, true);  // flags
    lv.setUint16(8, 0, true);  // no compression
    lv.setUint16(10, dt.time, true);
    lv.setUint16(12, dt.date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, dataBytes.length, true);
    lv.setUint32(22, dataBytes.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    localParts.push(local, dataBytes);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, 0, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, dt.time, true);
    cv.setUint16(14, dt.date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, dataBytes.length, true);
    cv.setUint32(24, dataBytes.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centralParts.push(central);
    offset += local.length + dataBytes.length;
  }

  const centralSize = centralParts.reduce((sum, p) => sum + p.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);

  return new Blob([...localParts, ...centralParts, end], {type:"application/vnd.openxmlformats-officedocument.wordprocessingml.document"});
}

function buildDocxBlob() {
  const p = getProjectPayload();
  const nowIso = new Date().toISOString();

  const metaRows = [
    ["案件名", p.projectName],
    ["住戸番号", p.unitNo],
    ["打合せ日", p.meetingDate],
    ["打合せ相手", p.clientName],
    ["出席者", p.attendees],
    ["備考", p.note]
  ].map(wordRow).join("");

  const header = wordRow(["No.", "部屋", "対象", "内容", "区分", "状態", "信頼度", "備考"]);
  const rows = items.map((item, idx) => wordRow([
    String(idx + 1), item.room, item.target, item.content, item.category, item.status, item.confidence, item.reason
  ])).join("") || wordRow(["", "", "", "項目なし", "", "", "", ""]);

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    ${wordParagraph("図面メモ議事録", {heading:"Title"})}
    ${wordParagraph("案件情報", {heading:"Heading1"})}
    <w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/><w:tblBorders><w:top w:val="single" w:sz="4"/><w:left w:val="single" w:sz="4"/><w:bottom w:val="single" w:sz="4"/><w:right w:val="single" w:sz="4"/><w:insideH w:val="single" w:sz="4"/><w:insideV w:val="single" w:sz="4"/></w:tblBorders></w:tblPr>${metaRows}</w:tbl>
    ${wordParagraph("確認・変更事項", {heading:"Heading1"})}
    <w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/><w:tblBorders><w:top w:val="single" w:sz="4"/><w:left w:val="single" w:sz="4"/><w:bottom w:val="single" w:sz="4"/><w:right w:val="single" w:sz="4"/><w:insideH w:val="single" w:sz="4"/><w:insideV w:val="single" w:sz="4"/></w:tblBorders></w:tblPr>${header}${rows}</w:tbl>
    <w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="850" w:bottom="1134" w:left="850" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>
  </w:body>
</w:document>`;

  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/><w:rPr><w:rFonts w:ascii="Yu Gothic" w:eastAsia="Yu Gothic" w:hAnsi="Yu Gothic"/><w:sz w:val="22"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:qFormat/><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:qFormat/><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style>
  <w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4"/><w:left w:val="single" w:sz="4"/><w:bottom w:val="single" w:sz="4"/><w:right w:val="single" w:sz="4"/><w:insideH w:val="single" w:sz="4"/><w:insideV w:val="single" w:sz="4"/></w:tblBorders></w:tblPr></w:style>
</w:styles>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`;

  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;

  const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${xmlEscape((p.projectName || "図面メモ議事録") + " 議事録")}</dc:title>
  <dc:creator>図面メモ議事録</dc:creator>
  <cp:lastModifiedBy>図面メモ議事録</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${nowIso}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${nowIso}</dcterms:modified>
</cp:coreProperties>`;

  const appXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>図面メモ議事録</Application></Properties>`;

  return makeZipBlob([
    {name:"[Content_Types].xml", data:contentTypes},
    {name:"_rels/.rels", data:rels},
    {name:"docProps/core.xml", data:core},
    {name:"docProps/app.xml", data:appXml},
    {name:"word/document.xml", data:documentXml},
    {name:"word/styles.xml", data:stylesXml}
  ]);
}

function exportWordDoc() {
  const p = getProjectPayload();
  const blob = buildDocxBlob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${safeName(p.projectName)}_${safeName(p.unitNo)}_図面メモ議事録.docx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  log("正式な .docx ファイルを書き出しました。iPadのファイルからWordで開いてください。");
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    alert("このブラウザではカメラプレビューが使えません。カメラ撮影ボタンを使ってください。");
    return;
  }
  cameraStream = await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:"environment"}}, audio:false});
  const video = $("cameraPreview");
  video.srcObject = cameraStream;
  video.classList.remove("hidden");
  $("captureCameraBtn").disabled = false;
  $("stopCameraBtn").disabled = false;
  log("カメラプレビューを開始しました。");
}

function stopCamera() {
  if (cameraStream) {
    cameraStream.getTracks().forEach(t => t.stop());
    cameraStream = null;
  }
  $("cameraPreview").classList.add("hidden");
  $("captureCameraBtn").disabled = true;
  $("stopCameraBtn").disabled = true;
  log("カメラを停止しました。");
}

async function captureCamera() {
  const video = $("cameraPreview");
  const canvas = $("captureCanvas");
  canvas.width = video.videoWidth || 1280;
  canvas.height = video.videoHeight || 720;
  canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
  const dataUrl = await resizeDataUrl(canvas.toDataURL("image/jpeg", .9), "image/jpeg", 1600);
  addImageDataUrl(dataUrl, `camera_${new Date().toISOString().replace(/[:.]/g,"-")}.jpg`);
  log("カメラ画像を追加しました。");
}

async function loadImageFiles(fileList) {
  for (const file of Array.from(fileList || [])) {
    try {
      const dataUrl = await fileToDataUrl(file);
      addImageDataUrl(dataUrl, file.name);
      log(`画像追加：${file.name}`);
    } catch (e) {
      log(`画像追加エラー：${file.name} / ${e.message}`);
      alert(e.message);
    }
  }
}

function insertSampleItems() {
  items = [
    normalizeItem({room:"洋室1", target:"CL", content:"可動棚を3段追加", category:"追加", status:"要見積", confidence:"高", reason:"引き出し線が洋室1のCL方向を指している想定"}),
    normalizeItem({room:"LD", target:"TV面", content:"壁下地を追加", category:"追加", status:"要確認", confidence:"中", reason:"TV面付近のメモとして仮分類"}),
    normalizeItem({room:"未分類", target:"", content:"寸法確認", category:"確認", status:"未分類", confidence:"低", reason:"対象部屋が不明"})
  ];
  renderItems();
  log("試験データを入れました。");
}

function newProject() {
  currentProjectId = crypto.randomUUID ? crypto.randomUUID() : String(Date.now());
  $("projectName").value = "";
  $("unitNo").value = "";
  setDefaultDate();
  $("clientName").value = "";
  $("attendees").value = "";
  $("projectNote").value = "";
  items = [];
  images = [];
  lastGeminiText = "";
  renderImages();
  renderItems();
  log("新規案件を開始しました。");
}

function initEvents() {
  $("keyFileInput").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    apiKeys = parseKeys(text);
    keyIndex = 0;
    updateKeyStatus();
    if ($("saveKeysCheck").checked) {
      localStorage.setItem("gijiroku_gemini_keys", JSON.stringify(apiKeys));
      log("APIキーをこのiPadに保存しました。");
    }
    log(`APIキーを${apiKeys.length}件読み込みました。`);
  });

  $("saveKeysCheck").addEventListener("change", () => {
    if ($("saveKeysCheck").checked && apiKeys.length) {
      localStorage.setItem("gijiroku_gemini_keys", JSON.stringify(apiKeys));
      log("現在のAPIキーをこのiPadに保存しました。");
    }
  });

  $("clearKeysBtn").addEventListener("click", () => {
    localStorage.removeItem("gijiroku_gemini_keys");
    apiKeys = [];
    keyIndex = 0;
    updateKeyStatus();
    log("保存済みAPIキーを削除しました。");
  });

  $("testGeminiBtn").addEventListener("click", async () => {
    if (!apiKeys.length) return alert("APIキーを読み込んでください。");
    try {
      log("接続テスト開始。");
      const text = await callGemini([{text:'JSONで {"ok":true} の形式だけ返してください。'}]);
      log(`接続テスト応答：${text.slice(0,200)}`);
    } catch(e) {
      log(`接続テスト失敗：${e.message || e}`);
      alert("接続テストに失敗しました。ログを確認してください。");
    }
  });

  $("promptFileInput").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    $("promptText").value = await file.text();
    log(`プロンプトを読み込みました：${file.name}`);
  });

  $("imageFileInput").addEventListener("change", e => loadImageFiles(e.target.files));
  $("cameraFileInput").addEventListener("change", e => loadImageFiles(e.target.files));
  $("startCameraBtn").addEventListener("click", startCamera);
  $("stopCameraBtn").addEventListener("click", stopCamera);
  $("captureCameraBtn").addEventListener("click", captureCamera);
  $("readGeminiBtn").addEventListener("click", handleGeminiRead);
  $("insertSampleBtn").addEventListener("click", insertSampleItems);
  $("addItemBtn").addEventListener("click", () => {
    items.unshift(normalizeItem({room:"未分類", target:"", content:"", category:"確認", status:"要確認", confidence:"低", reason:"手入力"}));
    renderItems();
  });
  $("showAllBtn").addEventListener("click", () => { currentFilter = "all"; renderItems(); });
  $("showNeedsCheckBtn").addEventListener("click", () => { currentFilter = "needs"; renderItems(); });
  $("saveProjectBtn").addEventListener("click", saveProject);
  $("exportJsonBtn").addEventListener("click", exportJson);
  $("downloadRawBtn").addEventListener("click", exportRaw);
  $("exportWordBtn").addEventListener("click", exportWordDoc);
  $("newProjectBtn").addEventListener("click", newProject);
}

async function init() {
  $("promptText").value = DEFAULT_PROMPT;
  setDefaultDate();
  initEvents();
  db = await openDb();
  await renderProjectList();
  const savedKeys = localStorage.getItem("gijiroku_gemini_keys");
  if (savedKeys) {
    try {
      apiKeys = JSON.parse(savedKeys);
      updateKeyStatus();
      log("このiPadに保存されたAPIキーを読み込みました。");
    } catch {}
  } else {
    updateKeyStatus();
  }
  renderImages();
  renderItems();
  log("v04 起動しました。Word出力は正式な .docx です。");
}

init().catch(err => {
  console.error(err);
  alert("初期化に失敗しました：" + err.message);
});
