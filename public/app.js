/* PictureText 图文助手 —— 前端 */
'use strict';

const $ = (id) => document.getElementById(id);

const messagesEl = $('messages');
const emptyState = $('emptyState');
const inputEl = $('input');
const sendBtn = $('send');
const fileInput = $('fileInput');
const attachmentEl = $('attachment');
const attachmentThumb = $('attachmentThumb');
const attachmentName = $('attachmentName');
const attachmentSize = $('attachmentSize');
const modeHint = $('modeHint');
const counterEl = $('counter');
const statusEl = $('status');
const statusText = $('statusText');
const toastEl = $('toast');
const galleryEl = $('gallery');
const galleryCount = $('galleryCount');

let pendingImage = null;   // { dataUrl, name, size }
let busy = false;

/* ---------- 通用 ---------- */
function toast(msg, ms) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toastEl.classList.remove('show'), ms || 2200);
}

function humanSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

/* ---------- 消息渲染 ---------- */
/** 极简 Markdown：围栏代码块 / 行内代码 / 粗体 */
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function renderMarkdown(text) {
  const blocks = String(text).split(/```/);
  let html = '';
  blocks.forEach((chunk, i) => {
    if (i % 2 === 1) {
      const nl = chunk.indexOf('\n');
      const code = nl >= 0 ? chunk.slice(nl + 1) : chunk;
      html += '<pre><code>' + escapeHtml(code.replace(/\n$/, '')) + '</code></pre>';
    } else {
      let t = escapeHtml(chunk);
      t = t.replace(/`([^`\n]+)`/g, '<code>$1</code>');
      t = t.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
      html += t;
    }
  });
  return html;
}

function addMessage(role, content, opts) {
  const o = opts || {};
  if (emptyState && emptyState.parentNode) emptyState.remove();

  const wrap = document.createElement('div');
  wrap.className = 'msg ' + role + (o.error ? ' error' : '');

  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = role === 'user' ? '🧑' : (o.error ? '⚠️' : '🤖');

  const body = document.createElement('div');
  body.className = 'body';

  const who = document.createElement('div');
  who.className = 'who';
  who.textContent = (role === 'user' ? '你' : 'PictureText') +
    ' · ' + new Date().toLocaleTimeString('zh-CN', { hour12: false });

  const bubble = document.createElement('div');
  bubble.className = 'bubble';

  if (o.imageUrl) {
    const img = document.createElement('img');
    img.className = 'attached';
    img.src = o.imageUrl;
    img.alt = '附加图片';
    bubble.appendChild(img);
  }

  if (o.pending) {
    bubble.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>&nbsp;Claude 正在处理…';
  } else if (role === 'bot' && !o.error) {
    bubble.innerHTML = renderMarkdown(content);
  } else {
    bubble.textContent = content;
  }

  body.appendChild(who);
  body.appendChild(bubble);
  wrap.appendChild(avatar);
  wrap.appendChild(body);
  messagesEl.appendChild(wrap);
  scrollToBottom();
  return wrap;
}

/* ---------- 图片选择 ---------- */
function setPendingImage(file) {
  if (!file) return;
  if (!/^image\//.test(file.type)) return toast('只支持图片文件');
  if (file.size > 10 * 1024 * 1024) return toast('图片超过 10 MiB 上限');

  const reader = new FileReader();
  reader.onload = () => {
    pendingImage = { dataUrl: reader.result, name: file.name || ('paste_' + Date.now() + '.png'), size: file.size };
    attachmentThumb.src = pendingImage.dataUrl;
    attachmentName.textContent = pendingImage.name;
    attachmentSize.textContent = humanSize(pendingImage.size);
    attachmentEl.classList.remove('hidden');
    modeHint.textContent = '图文模式 · 将写入 tmp.png 后提问';
    updateSendState();
  };
  reader.readAsDataURL(file);
}

function clearPendingImage() {
  pendingImage = null;
  attachmentEl.classList.add('hidden');
  attachmentThumb.removeAttribute('src');
  fileInput.value = '';
  modeHint.textContent = '纯文本模式';
  updateSendState();
}

function updateSendState() {
  const hasText = inputEl.value.trim().length > 0;
  sendBtn.disabled = busy || (!hasText && !pendingImage);
  counterEl.textContent = inputEl.value.length ? inputEl.value.length + ' 字' : '';
}

/* ---------- 发送 ---------- */
async function send() {
  if (busy) return;
  const text = inputEl.value.trim();
  if (!text && !pendingImage) return;

  const image = pendingImage;
  const prompt = text || (image ? '请描述这张图片的内容。' : '');

  addMessage('user', prompt, image ? { imageUrl: image.dataUrl } : {});
  inputEl.value = '';
  inputEl.style.height = 'auto';
  clearPendingImage();
  updateSendState();

  busy = true;
  updateSendState();
  const loader = addMessage('bot', '', { pending: true });

  try {
    if (image) {
      const res = await fetch('/ask/image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: prompt, image: image.dataUrl, name: image.name }),
      });
      const data = await res.json().catch(() => ({}));
      loader.remove();
      if (!res.ok || !data.ok) {
        addMessage('bot', '请求失败：' + (data.error || res.status), { error: true });
      } else {
        addMessage('bot', data.answer || '(空回复)');
        refreshGallery();
      }
    } else {
      // 平台规范：/ask/claude?q=...  含空格或长度 < 50 → URL 编码；否则 base64
      const q = (/\s/.test(prompt) || prompt.length < 50) ? encodeURIComponent(prompt) : btoa(unescape(encodeURIComponent(prompt)));
      const res = await fetch('/ask/claude?q=' + q);
      const txt = await res.text();
      loader.remove();
      if (!res.ok) addMessage('bot', '请求失败：' + txt, { error: true });
      else addMessage('bot', txt || '(空回复)');
    }
  } catch (e) {
    loader.remove();
    addMessage('bot', '网络错误：' + e.message, { error: true });
  } finally {
    busy = false;
    updateSendState();
    inputEl.focus();
  }
}

/* ---------- 图库 ---------- */
async function refreshGallery() {
  try {
    const res = await fetch('/api/images');
    const data = await res.json();
    const list = (data.images || []);
    galleryCount.textContent = list.length;

    const kw = ($('gallerySearch').value || '').trim().toLowerCase();
    const shown = kw ? list.filter((i) => i.name.toLowerCase().includes(kw)) : list;

    galleryEl.innerHTML = '';
    if (!shown.length) {
      const none = document.createElement('div');
      none.className = 'none';
      none.textContent = list.length ? '没有匹配的图片' : '图库还是空的 —— 去「对话」页上传第一张图吧';
      galleryEl.appendChild(none);
      return;
    }

    shown.forEach((item) => {
      const card = document.createElement('div');
      card.className = 'card';

      const img = document.createElement('img');
      img.className = 'thumb';
      img.src = item.url;
      img.loading = 'lazy';
      img.alt = item.name;
      img.addEventListener('click', () => openLightbox(item.url));

      const meta = document.createElement('div');
      meta.className = 'meta';
      const nm = document.createElement('strong');
      nm.textContent = item.name;
      const info = document.createElement('span');
      info.textContent = humanSize(item.size) + ' · ' + new Date(item.uploaded_at).toLocaleString('zh-CN', { hour12: false });
      meta.appendChild(nm);
      meta.appendChild(info);

      const ops = document.createElement('div');
      ops.className = 'ops';

      const copyBtn = document.createElement('button');
      copyBtn.className = 'mini';
      copyBtn.textContent = '复制链接';
      copyBtn.addEventListener('click', () => {
        const abs = location.origin + item.url;
        navigator.clipboard.writeText(abs).then(
          () => toast('已复制：' + abs),
          () => toast(abs)
        );
      });

      const askBtn = document.createElement('button');
      askBtn.className = 'mini';
      askBtn.textContent = '用它提问';
      askBtn.addEventListener('click', () => {
        switchTab('chat');
        fetch(item.url).then((r) => r.blob()).then((b) => {
          setPendingImage(new File([b], item.name, { type: b.type || 'image/png' }));
          inputEl.focus();
        }).catch((e) => toast('加载图片失败：' + e.message));
      });

      const delBtn = document.createElement('button');
      delBtn.className = 'mini danger';
      delBtn.textContent = '删除';
      delBtn.addEventListener('click', async () => {
        if (!confirm('删除 ' + item.name + ' ？')) return;
        const r = await fetch('/api/images/' + encodeURIComponent(item.name), { method: 'DELETE' });
        if (r.ok) { toast('已删除'); refreshGallery(); }
        else toast('删除失败');
      });

      ops.appendChild(copyBtn);
      ops.appendChild(askBtn);
      ops.appendChild(delBtn);

      card.appendChild(img);
      card.appendChild(meta);
      card.appendChild(ops);
      galleryEl.appendChild(card);
    });
  } catch (e) {
    toast('图库加载失败：' + e.message);
  }
}

function openLightbox(url) {
  const box = document.createElement('div');
  box.className = 'lightbox';
  const img = document.createElement('img');
  img.src = url;
  box.appendChild(img);
  box.addEventListener('click', () => box.remove());
  document.body.appendChild(box);
}

/* ---------- Tab ---------- */
function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === 'panel-' + name));
  if (name === 'gallery') refreshGallery();
  if (name === 'chat') inputEl.focus();
}

/* ---------- 健康检查 ---------- */
async function checkHealth() {
  try {
    const r = await fetch('/health');
    const t = (await r.text()).trim();
    if (r.ok && t === 'OK') {
      statusEl.className = 'status ok';
      statusText.textContent = '服务正常 · 8082';
    } else throw new Error(t);
  } catch (e) {
    statusEl.className = 'status bad';
    statusText.textContent = '服务异常';
  }
}

/* ---------- 事件绑定 ---------- */
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));

sendBtn.addEventListener('click', send);
inputEl.addEventListener('input', () => {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 190) + 'px';
  updateSendState();
});
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
});

fileInput.addEventListener('change', () => setPendingImage(fileInput.files[0]));
$('attachmentRemove').addEventListener('click', clearPendingImage);

document.querySelectorAll('.chip').forEach((c) => c.addEventListener('click', () => {
  inputEl.value = c.dataset.sample;
  updateSendState();
  inputEl.focus();
}));

const composerRow = document.querySelector('.composer-row');
['dragenter', 'dragover'].forEach((ev) => composerRow.addEventListener(ev, (e) => {
  e.preventDefault();
  composerRow.classList.add('drag');
}));
['dragleave', 'drop'].forEach((ev) => composerRow.addEventListener(ev, (e) => {
  e.preventDefault();
  composerRow.classList.remove('drag');
}));
composerRow.addEventListener('drop', (e) => {
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) setPendingImage(f);
});

document.addEventListener('paste', (e) => {
  const items = (e.clipboardData && e.clipboardData.items) || [];
  for (const it of items) {
    if (it.type && it.type.startsWith('image/')) {
      const f = it.getAsFile();
      if (f) { setPendingImage(f); toast('已粘贴图片'); }
      break;
    }
  }
});

$('refreshGallery').addEventListener('click', refreshGallery);
$('gallerySearch').addEventListener('input', refreshGallery);

/* ---------- 启动 ---------- */
updateSendState();
checkHealth();
setInterval(checkHealth, 30000);
refreshGallery();
inputEl.focus();
