// App entry: tab routing
(function () {
    const main = document.getElementById('main');
    const tabs = document.querySelectorAll('.tab-btn');

    // Parse the hash into a tab name + query string. The hash may be
    // '#wizard' or '#wizard?project=abc' — the latter is used by the
    // library card "继续编辑" button to resume editing an existing project.
    function parseHash(h) {
        const raw = (h || location.hash || '#wizard').replace(/^#/, '');
        const qIdx = raw.indexOf('?');
        const tab = qIdx === -1 ? raw : raw.slice(0, qIdx);
        const qs = qIdx === -1 ? '' : raw.slice(qIdx + 1);
        const params = Object.fromEntries(new URLSearchParams(qs).entries());
        return { tab, params };
    }

    function activate(parsed) {
        let tabName = parsed.tab;
        if (!['wizard', 'library'].includes(tabName)) tabName = 'wizard';
        tabs.forEach(b => b.classList.toggle('active', b.dataset.tab === tabName));
        // Preserve the ?project=... portion in the hash when re-writing
        const targetHash = '#' + tabName + (parsed.params && parsed.params.project
            ? '?project=' + encodeURIComponent(parsed.params.project)
            : '');
        if (location.hash !== targetHash) {
            history.replaceState(null, '', targetHash);
        }
        if (tabName === 'wizard') renderWizard(main, parsed.params);
        else renderLibrary(main);
    }

    tabs.forEach(b => b.addEventListener('click', () => {
        // Tab clicks always clear the project query string
        activate({ tab: b.dataset.tab, params: {} });
    }));

    activate(parseHash());

    window.addEventListener('hashchange', () => activate(parseHash()));
})();

// ---------- Toast ----------
function toast(msg, type = 'success') {
    const el = document.createElement('div');
    el.className = 'toast' + (type === 'error' ? ' error' : '');
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2400);
}

// ---------- API helper ----------
async function api(path, options = {}) {
    const opts = options || {};
    const headers = opts.headers || {};
    if (opts.body && typeof opts.body !== 'string') {
        headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(opts.body);
    }
    const res = await fetch(path, { ...opts, headers });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) {}
    if (!res.ok) {
        const err = new Error((json && json.error) || res.statusText || 'request failed');
        err.status = res.status;
        err.body = json || text;
        throw err;
    }
    return json;
}

function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

// ---------- Wizard ----------
// New design: single title + progress strip of thumbnails.
// Editor switches between "image" and "text" for the current segment.
// User clicks "下一步" to advance within segment, "+ 添加一段" for new segment.
// Each segment is finalized via "完成此段" which marks it done and returns to image step.
function renderWizard(root, params = {}) {
    const state = {
        projectId: null,
        title: '',
        // segments: { status, draftImage, text, imageId, imageUrl, thumbDataUrl }
        segments: [],
        currentIndex: 0,
        currentStep: 'image', // 'image' | 'text'
        saved: false,
        // Project-wide layout direction: 'text-first' (default, 文字在上图片在下)
        // or 'image-first'. Applied to every segment when finalize renders v{n}.
        layoutDirection: 'text-first'
    };

    root.innerHTML = `
    <div class="wizard-container">
        <div class="wizard-header">
            <div class="wizard-header-main">
                <h1>图文 HTML 向导</h1>
                <p>填写标题，循环添加图片+文字段，点击完成生成 v1</p>
            </div>
            <div class="layout-toggle" id="layout-toggle" role="radiogroup" aria-label="段落版式">
                <button type="button" role="radio" data-dir="text-first" class="active" aria-checked="true">文字在上</button>
                <button type="button" role="radio" data-dir="image-first" aria-checked="false">图片在上</button>
            </div>
        </div>

        <div class="card" id="title-card">
            <div class="input-group">
                <label>标题</label>
                <input type="text" id="title-input" placeholder="例如：春天的第一杯咖啡">
                <div class="helper">随时可改，所有段落共用此标题</div>
            </div>
        </div>

        <div class="card" id="progress-card">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
                <h3 style="margin:0;font-size:15px;color:#374151">进度</h3>
                <button class="btn btn-secondary" id="add-segment-btn" style="padding:6px 14px;font-size:13px">+ 添加一段</button>
            </div>
            <div class="thumb-strip" id="thumb-strip">
                <div class="thumb-empty muted">点击"+ 添加一段"开始第一段</div>
            </div>
        </div>

        <div class="card" id="editor-card">
            <div id="editor-body"></div>
            <div class="btn-row">
                <button class="btn btn-secondary" id="prev-btn">上一步</button>
                <div style="display:flex;gap:8px">
                    <button class="btn btn-secondary" id="next-step-btn">下一步</button>
                    <button class="btn btn-success" id="finish-btn">完成，生成 v1</button>
                </div>
            </div>
        </div>
    </div>`;

    const titleInput = document.getElementById('title-input');
    const thumbStrip = document.getElementById('thumb-strip');
    const editorBody = document.getElementById('editor-body');
    const prevBtn = document.getElementById('prev-btn');
    const nextStepBtn = document.getElementById('next-step-btn');
    const finishBtn = document.getElementById('finish-btn');
    const addBtn = document.getElementById('add-segment-btn');

    titleInput.addEventListener('input', () => { state.title = titleInput.value; });

    // Layout toggle: the user can flip the segment order at any time. The
    // choice is project-level (saved to draft + applied on finalize) so it
    // also applies to v{n+1} when the wizard re-edits a finished project.
    const layoutToggle = document.getElementById('layout-toggle');
    function setLayoutDirection(dir, opts = {}) {
        if (dir !== 'text-first' && dir !== 'image-first') dir = 'text-first';
        state.layoutDirection = dir;
        if (layoutToggle) {
            layoutToggle.querySelectorAll('button').forEach(b => {
                const on = b.dataset.dir === dir;
                b.classList.toggle('active', on);
                b.setAttribute('aria-checked', on ? 'true' : 'false');
            });
        }
        if (opts.persist) {
            // No-op if we don't have a project yet — the next autosave after
            // the first segment will pick up the current state value.
            autosave();
            if (!opts.silent) toast(dir === 'text-first' ? '已切换为「文字在上」' : '已切换为「图片在上」');
        }
    }
    if (layoutToggle) {
        layoutToggle.addEventListener('click', e => {
            const btn = e.target.closest('button[data-dir]');
            if (!btn || btn.classList.contains('active')) return;
            setLayoutDirection(btn.dataset.dir, { persist: true });
            // Re-render the editor so the visual order of any visible image +
            // text pair matches the new direction.
            renderEditor();
            renderThumbs();
        });
    }

    addBtn.onclick = () => {
        if (!state.title.trim()) { toast('请先填写标题', 'error'); titleInput.focus(); return; }
        state.segments.push({ status: 'pending', text: '' });
        state.currentIndex = state.segments.length - 1;
        state.currentStep = 'image';
        ensureProject().then(() => {
            renderThumbs();
            renderEditor();
            autosave();
        });
    };

    prevBtn.onclick = () => goPrevStep();
    nextStepBtn.onclick = () => goNextStep();
    finishBtn.onclick = () => finalize();

    thumbStrip.addEventListener('click', e => {
        const t = e.target.closest('.thumb-item');
        if (!t) return;
        // Avoid switching segment immediately after a drag completes — the
        // click also fires on mouseup in some browsers. If the user just
        // dropped this thumb onto a different slot, the dragend handler will
        // have updated currentIndex; only switch when there was no drag.
        if (dragState.endedAt && Date.now() - dragState.endedAt < 150) return;
        switchToSegment(parseInt(t.dataset.idx, 10));
    });

    // ---- Drag-and-drop reorder ----
    // Track drag source + last drop position so we can ignore the trailing
    // click event browsers fire after dragend.
    const dragState = { fromIdx: null, overIdx: null, endedAt: 0 };

    thumbStrip.addEventListener('dragstart', e => {
        const t = e.target.closest('.thumb-item');
        if (!t) return;
        dragState.fromIdx = parseInt(t.dataset.idx, 10);
        dragState.overIdx = dragState.fromIdx;
        t.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        // Required for Firefox to actually start the drag
        try { e.dataTransfer.setData('text/plain', String(dragState.fromIdx)); } catch (_) {}
    });

    thumbStrip.addEventListener('dragover', e => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const over = e.target.closest('.thumb-item');
        if (!over) return;
        const overIdx = parseInt(over.dataset.idx, 10);
        if (overIdx === dragState.overIdx) return;
        dragState.overIdx = overIdx;
        updateDropIndicators();
    });

    thumbStrip.addEventListener('dragleave', e => {
        // Only clear indicators when leaving the strip entirely
        if (!thumbStrip.contains(e.relatedTarget)) {
            clearDropIndicators();
        }
    });

    thumbStrip.addEventListener('drop', e => {
        e.preventDefault();
        const from = dragState.fromIdx;
        const to = dragState.overIdx;
        if (from == null || to == null || from === to) {
            clearDropIndicators();
            return;
        }
        reorderSegments(from, to);
        clearDropIndicators();
    });

    thumbStrip.addEventListener('dragend', () => {
        // Clean up visual state; the click after this would otherwise switch
        // to the original (now possibly stale) segment index.
        thumbStrip.querySelectorAll('.thumb-item.dragging')
            .forEach(el => el.classList.remove('dragging'));
        dragState.fromIdx = null;
        dragState.endedAt = Date.now();
    });

    function clearDropIndicators() {
        thumbStrip.querySelectorAll('.thumb-item.drop-before, .thumb-item.drop-after')
            .forEach(el => el.classList.remove('drop-before', 'drop-after'));
    }

    function updateDropIndicators() {
        clearDropIndicators();
        const items = thumbStrip.querySelectorAll('.thumb-item');
        if (dragState.overIdx == null) return;
        const target = items[dragState.overIdx];
        if (!target) return;
        if (dragState.fromIdx == null || dragState.fromIdx === dragState.overIdx) return;
        // Show insertion line on the side closer to the source
        if (dragState.fromIdx < dragState.overIdx) target.classList.add('drop-after');
        else target.classList.add('drop-before');
    }

    function reorderSegments(from, to) {
        if (from === to) return;
        const moving = state.segments[from];
        if (!moving) return;
        state.segments.splice(from, 1);
        state.segments.splice(to, 0, moving);
        // Track which segment the user was editing
        if (state.currentIndex === from) {
            state.currentIndex = to;
        } else if (from < state.currentIndex && to >= state.currentIndex) {
            state.currentIndex -= 1;
        } else if (from > state.currentIndex && to <= state.currentIndex) {
            state.currentIndex += 1;
        }
        renderThumbs();
        renderEditor();
        autosave();
        toast('已调整段落顺序');
    }

    async function ensureProject() {
        if (state.projectId) return state.projectId;
        if (!state.title.trim()) return null;
        try {
            const r = await api('/api/projects', { method: 'POST', body: { title: state.title.trim() } });
            state.projectId = r.projectId;
            state.saved = true;
            return state.projectId;
        } catch (e) {
            toast('创建项目失败：' + e.message, 'error');
            return null;
        }
    }

    async function autosave() {
        if (!state.projectId) return;
        try {
            await api(`/api/projects/${state.projectId}/draft`, {
                method: 'PUT',
                body: {
                    draft: {
                        title: state.title,
                        layoutDirection: state.layoutDirection,
                        items: serializeItems()
                    }
                }
            });
        } catch (e) { /* silent */ }
    }

    function serializeItems() {
        // Include any segment with an uploaded image — text may be empty, that's OK.
        // Filter only on imageId (not status) so unfinished segments aren't silently dropped.
        return state.segments
            .filter(s => s.imageId)
            .map(s => ({ imageId: s.imageId, text: (s.text || '').trim() }));
    }

    function renderThumbs() {
        if (state.segments.length === 0) {
            thumbStrip.innerHTML = `<div class="thumb-empty muted">点击"+ 添加一段"开始第一段</div>`;
            return;
        }
        thumbStrip.innerHTML = state.segments.map((seg, i) => {
            const isCurrent = i === state.currentIndex;
            const thumb = seg.thumbDataUrl || (seg.imageId && state.projectId ? `/api/projects/${state.projectId}/images/${seg.imageId}` : null);
            let cls = 'thumb-item';
            if (isCurrent) cls += ' current';
            if (seg.status === 'done') cls += ' done';
            else if (isCurrent) cls += ' active';
            const statusLabel = seg.status === 'done' ? '✓' : (i + 1);
            const textSnippet = (seg.text || '').slice(0, 14) || (seg.status === 'image' ? '待上传图片' : seg.status === 'text' ? '待配文' : '');
            return `
            <div class="${cls}" data-idx="${i}" draggable="true" title="按住拖动可调整顺序">
                <div class="thumb-num">${statusLabel}</div>
                ${thumb ? `<img class="thumb-img" src="${thumb}">` : `<div class="thumb-placeholder">＋</div>`}
                <div class="thumb-text">${escapeHtml(textSnippet || (seg.status === 'done' ? '已完成' : '编辑中'))}</div>
            </div>`;
        }).join('');
    }

    function switchToSegment(idx) {
        if (idx < 0 || idx >= state.segments.length) return;
        state.currentIndex = idx;
        const seg = state.segments[idx];
        state.currentStep = (seg.status === 'done' || seg.status === 'text') ? 'text' : 'image';
        renderEditor();
        renderThumbs();
    }

    function goPrevStep() {
        const seg = state.segments[state.currentIndex];
        if (!seg) return;
        if (state.currentStep === 'text') {
            state.currentStep = 'image';
        } else if (state.currentIndex > 0) {
            state.currentIndex -= 1;
            const prev = state.segments[state.currentIndex];
            state.currentStep = (prev.status === 'done' || prev.status === 'text') ? 'text' : 'image';
        } else {
            toast('已经是第一步了');
            return;
        }
        renderEditor();
        renderThumbs();
    }

    async function goNextStep() {
        const seg = state.segments[state.currentIndex];
        if (!seg) return;
        if (state.currentStep === 'image') {
            // Trigger upload + advance to text
            await advanceImageToText(seg);
        } else {
            seg.text = (document.getElementById('text-input')?.value || '').trim();
            seg.status = 'done';
            if (state.currentIndex < state.segments.length - 1) {
                state.currentIndex += 1;
                state.currentStep = 'image';
            } else {
                // No more; user can add or finish
                renderThumbs();
                autosave();
                toast('本段已完成，可以添加下一段或生成 v1');
                return;
            }
        }
        renderEditor();
        renderThumbs();
        autosave();
    }

    async function advanceImageToText(seg) {
        if (!seg.draftImage || !seg.draftImage.crop) { toast('请先上传并裁剪图片', 'error'); return; }
        if (!state.projectId) {
            const pid = await ensureProject();
            if (!pid) return;
        }
        const blob = await cropDataUrlToBlob(seg.draftImage);
        seg.thumbDataUrl = blob.dataUrl;
        try {
            const r = await api(`/api/projects/${state.projectId}/images`, {
                method: 'POST',
                body: { dataUrl: blob.dataUrl }
            });
            seg.imageId = r.imageId;
            seg.imageUrl = r.url;
            seg.status = 'text';
            state.currentStep = 'text';
        } catch (e) {
            toast('上传失败：' + e.message, 'error');
        }
    }

    function renderEditor() {
        const seg = state.segments[state.currentIndex];
        if (!seg) {
            editorBody.innerHTML = `<div class="empty-state">还没有段落。点上面的 "+ 添加一段" 开始。</div>`;
            prevBtn.disabled = true;
            nextStepBtn.disabled = true;
            finishBtn.disabled = true;
            return;
        }
        prevBtn.disabled = false;
        nextStepBtn.disabled = false;
        const anyReady = state.segments.some(s => s.imageId);
        finishBtn.disabled = !anyReady;

        if (state.currentStep === 'image') {
            renderImageEditor(seg);
        } else {
            renderTextEditor(seg);
        }
    }

    function renderImageEditor(seg) {
        editorBody.innerHTML = `
        <div class="input-group">
            <label>第 ${state.currentIndex + 1} 段：上传/裁剪图片</label>
            <div class="cropper-wrapper" id="cropper">
                <div class="cropper-empty" id="cropper-empty">
                    <div class="big-icon">🖼️</div>
                    <div>点击上传 / 拖入图片 / 粘贴（Ctrl/Cmd+V）</div>
                    <input type="file" id="file-input" accept="image/*" style="display:none">
                    <button class="btn btn-secondary" id="pick-file-btn" style="margin-top:12px">选择图片</button>
                </div>
            </div>
            <div class="cropper-controls hidden" id="cropper-controls">
                <button class="btn-icon" id="zoom-out-btn">−</button>
                <input type="range" id="zoom-range" min="10" max="400" value="100">
                <button class="btn-icon" id="zoom-in-btn">+</button>
                <button class="btn-icon" id="reset-btn">重置</button>
                <button class="btn-icon" id="paste-btn">粘贴</button>
                <button class="btn-icon" id="replace-btn">换图</button>
                <div class="spacer"></div>
                <span class="muted" id="zoom-label">100%</span>
            </div>
        </div>
        <div class="crop-preview hidden" id="crop-preview">
            <div class="muted" style="margin-bottom:6px">裁剪预览</div>
            <img id="preview-img">
        </div>`;

        const cropperEl = document.getElementById('cropper');
        const empty = document.getElementById('cropper-empty');
        const controls = document.getElementById('cropper-controls');
        const previewWrap = document.getElementById('crop-preview');
        const previewImg = document.getElementById('preview-img');
        const zoomRange = document.getElementById('zoom-range');
        const zoomLabel = document.getElementById('zoom-label');

        // Reuse existing draftImage if present (resuming), else create new
        const draft = seg.draftImage = seg.draftImage || {
            dataUrl: null, naturalW: 0, naturalH: 0,
            scale: 1, offsetX: 0, offsetY: 0, crop: null
        };

        let imgEl = null, cropFrame = null;

        function clampCrop() {
            if (!draft.crop || !imgEl) return;
            const dispW = imgEl.clientWidth, dispH = imgEl.clientHeight;
            draft.crop.x = Math.max(0, Math.min(draft.crop.x, dispW - 10));
            draft.crop.y = Math.max(0, Math.min(draft.crop.y, dispH - 10));
            draft.crop.w = Math.max(10, Math.min(draft.crop.w, dispW - draft.crop.x));
            draft.crop.h = Math.max(10, Math.min(draft.crop.h, dispH - draft.crop.y));
        }
        function renderCropFrame() {
            if (!cropFrame) return;
            cropFrame.style.left = draft.crop.x + 'px';
            cropFrame.style.top = draft.crop.y + 'px';
            cropFrame.style.width = draft.crop.w + 'px';
            cropFrame.style.height = draft.crop.h + 'px';
            // When the image is panned (offsetX/offsetY != 0), the crop frame
            // must move with it, otherwise the visible box no longer lines up
            // with the actual source pixels captured by cropDataUrlToBlob().
            cropFrame.style.transform = `translate(${draft.offsetX || 0}px, ${draft.offsetY || 0}px)`;
        }
        function updatePreview() {
            if (!draft.crop || !imgEl) return;
            const nx = (draft.crop.x - draft.offsetX) / draft.scale;
            const ny = (draft.crop.y - draft.offsetY) / draft.scale;
            const nw = draft.crop.w / draft.scale;
            const nh = draft.crop.h / draft.scale;
            const targetW = Math.min(600, draft.crop.w * 2);
            const targetH = Math.max(1, Math.round(targetW * (nh / nw)));
            const canvas = document.createElement('canvas');
            canvas.width = targetW; canvas.height = targetH;
            canvas.getContext('2d').drawImage(imgEl, nx, ny, nw, nh, 0, 0, targetW, targetH);
            previewImg.src = canvas.toDataURL('image/jpeg', 0.9);
            previewWrap.classList.remove('hidden');
        }
        function applyZoom() {
            if (!imgEl || !draft.naturalW) return;
            const oldScale = draft.scale;
            draft.scale = parseFloat(zoomRange.value) / 100;
            imgEl.style.width = (draft.naturalW * draft.scale) + 'px';
            imgEl.style.height = (draft.naturalH * draft.scale) + 'px';
            zoomLabel.textContent = Math.round(draft.scale * 100) + '%';
            if (draft.crop) {
                const cx = draft.crop.x + draft.crop.w / 2;
                const cy = draft.crop.y + draft.crop.h / 2;
                const natCx = (cx - draft.offsetX) / oldScale;
                const natCy = (cy - draft.offsetY) / oldScale;
                draft.offsetX = natCx * draft.scale - draft.crop.w / 2;
                draft.offsetY = natCy * draft.scale - draft.crop.h / 2;
                const newDispW = draft.naturalW * draft.scale;
                const newDispH = draft.naturalH * draft.scale;
                draft.offsetX = Math.max(-(newDispW - 10), Math.min(10, draft.offsetX));
                draft.offsetY = Math.max(-(newDispH - 10), Math.min(10, draft.offsetY));
                imgEl.style.transform = `translate(${draft.offsetX}px, ${draft.offsetY}px)`;
            } else {
                imgEl.style.transform = 'translate(0px, 0px)';
            }
            clampCrop(); renderCropFrame(); updatePreview();
        }
        function initCropFrame() {
            cropFrame = document.createElement('div');
            cropFrame.className = 'crop-frame';
            ['tl','tr','bl','br'].forEach(p => {
                const h = document.createElement('div');
                h.className = 'handle-' + p;
                cropFrame.appendChild(h);
            });
            cropperEl.appendChild(cropFrame);
            if (!draft.crop) {
                draft.crop = { x: 0, y: 0, w: imgEl.clientWidth, h: imgEl.clientHeight };
            }
            renderCropFrame();
            updatePreview();

            let mode = null, startX, startY, startCrop;
            function beginDrag(e, m) {
                mode = m;
                const t = e.touches ? e.touches[0] : e;
                startX = t.clientX; startY = t.clientY;
                startCrop = { ...draft.crop };
                if (e.preventDefault) e.preventDefault();
            }
            function applyDrag(e) {
                if (!mode) return;
                const t = e.touches ? e.touches[0] : e;
                const dx = t.clientX - startX;
                const dy = t.clientY - startY;
                let { x, y, w, h } = startCrop;
                const dispW = imgEl.clientWidth, dispH = imgEl.clientHeight;
                if (mode === 'move') {
                    x = Math.max(0, Math.min(x + dx, dispW - w));
                    y = Math.max(0, Math.min(y + dy, dispH - h));
                } else {
                    if (mode === 'tl') { x = startCrop.x + dx; y = startCrop.y + dy; w = startCrop.w - dx; h = startCrop.h - dy; }
                    if (mode === 'tr') { y = startCrop.y + dy; w = startCrop.w + dx; h = startCrop.h - dy; }
                    if (mode === 'bl') { x = startCrop.x + dx; w = startCrop.w - dx; h = startCrop.h + dy; }
                    if (mode === 'br') { w = startCrop.w + dx; h = startCrop.h + dy; }
                    if (w < 10) { w = 10; if (mode === 'tl' || mode === 'bl') x = startCrop.x + startCrop.w - 10; }
                    if (h < 10) { h = 10; if (mode === 'tl' || mode === 'tr') y = startCrop.y + startCrop.h - 10; }
                    x = Math.max(0, x); y = Math.max(0, y);
                    if (x + w > dispW) w = dispW - x;
                    if (y + h > dispH) h = dispH - y;
                }
                draft.crop = { x, y, w, h };
                clampCrop(); renderCropFrame(); updatePreview();
            }
            cropFrame.addEventListener('mousedown', e => {
                let m = 'move';
                if (e.target.classList.contains('handle-tl')) m = 'tl';
                else if (e.target.classList.contains('handle-tr')) m = 'tr';
                else if (e.target.classList.contains('handle-bl')) m = 'bl';
                else if (e.target.classList.contains('handle-br')) m = 'br';
                beginDrag(e, m);
            });
            cropFrame.addEventListener('touchstart', e => {
                let m = 'move';
                if (e.target.classList.contains('handle-tl')) m = 'tl';
                else if (e.target.classList.contains('handle-tr')) m = 'tr';
                else if (e.target.classList.contains('handle-bl')) m = 'bl';
                else if (e.target.classList.contains('handle-br')) m = 'br';
                beginDrag(e, m);
            }, { passive: false });
            document.addEventListener('mousemove', applyDrag);
            document.addEventListener('mouseup', () => { mode = null; });
            cropFrame.addEventListener('touchmove', applyDrag, { passive: false });
            cropFrame.addEventListener('touchend', () => { mode = null; });
        }
        function loadImage(dataUrl, preserveCrop = false) {
            draft.dataUrl = dataUrl;
            const img = new Image();
            img.onload = () => {
                draft.naturalW = img.naturalWidth;
                draft.naturalH = img.naturalHeight;
                const maxW = Math.min(cropperEl.clientWidth - 4, 700);
                const maxH = 480;
                draft.scale = Math.min(maxW / draft.naturalW, maxH / draft.naturalH, 1);
                draft.offsetX = 0; draft.offsetY = 0;
                if (!preserveCrop) draft.crop = null;
                if (imgEl) imgEl.remove();
                if (cropFrame) cropFrame.remove();
                imgEl = document.createElement('img');
                imgEl.src = dataUrl;
                imgEl.style.width = (draft.naturalW * draft.scale) + 'px';
                imgEl.style.height = (draft.naturalH * draft.scale) + 'px';
                imgEl.style.transform = 'translate(0px, 0px)';
                cropperEl.appendChild(imgEl);
                controls.classList.remove('hidden');
                empty.classList.add('hidden');
                zoomRange.value = Math.round(draft.scale * 100);
                zoomLabel.textContent = Math.round(draft.scale * 100) + '%';
                initCropFrame();
            };
            img.src = dataUrl;
        }

        document.getElementById('pick-file-btn').onclick = () => document.getElementById('file-input').click();
        document.getElementById('file-input').onchange = e => {
            const f = e.target.files[0]; if (!f) return;
            const reader = new FileReader();
            reader.onload = () => loadImage(reader.result);
            reader.readAsDataURL(f);
        };
        cropperEl.addEventListener('dragover', e => { e.preventDefault(); cropperEl.style.background = '#eef2ff'; });
        cropperEl.addEventListener('dragleave', () => { cropperEl.style.background = ''; });
        cropperEl.addEventListener('drop', e => {
            e.preventDefault();
            cropperEl.style.background = '';
            const f = e.dataTransfer.files[0];
            if (f && f.type.startsWith('image/')) {
                const reader = new FileReader();
                reader.onload = () => loadImage(reader.result);
                reader.readAsDataURL(f);
            }
        });
        document.getElementById('paste-btn').onclick = async () => {
            try {
                const items = await navigator.clipboard.read();
                for (const it of items) {
                    const type = it.types.find(t => t.startsWith('image/'));
                    if (type) {
                        const blob = await it.getType(type);
                        const reader = new FileReader();
                        reader.onload = () => loadImage(reader.result);
                        reader.readAsDataURL(blob);
                        return;
                    }
                }
                toast('剪贴板里没有图片', 'error');
            } catch (e) { toast('粘贴失败：' + e.message, 'error'); }
        };
        document.getElementById('paste-global-btn')?.remove?.();
        document.addEventListener('paste', function onPaste(e) {
            if (state.currentStep !== 'image') return;
            if (state.segments[state.currentIndex] !== seg) return;
            const items = e.clipboardData && e.clipboardData.items;
            if (!items) return;
            for (const it of items) {
                if (it.type.startsWith('image/')) {
                    const blob = it.getAsFile();
                    const reader = new FileReader();
                    reader.onload = () => loadImage(reader.result);
                    reader.readAsDataURL(blob);
                    e.preventDefault();
                    return;
                }
            }
        });
        document.getElementById('zoom-in-btn').onclick = () => { zoomRange.value = Math.min(400, parseInt(zoomRange.value) + 10); applyZoom(); };
        document.getElementById('zoom-out-btn').onclick = () => { zoomRange.value = Math.max(10, parseInt(zoomRange.value) - 10); applyZoom(); };
        zoomRange.oninput = applyZoom;
        document.getElementById('reset-btn').onclick = () => {
            if (!draft.naturalW) return;
            const maxW = Math.min(cropperEl.clientWidth - 4, 700);
            const maxH = 480;
            draft.scale = Math.min(maxW / draft.naturalW, maxH / draft.naturalH, 1);
            draft.offsetX = 0; draft.offsetY = 0;
            zoomRange.value = Math.round(draft.scale * 100);
            applyZoom();
        };
        document.getElementById('replace-btn').onclick = () => {
            if (imgEl) imgEl.remove();
            if (cropFrame) cropFrame.remove();
            imgEl = null; cropFrame = null;
            controls.classList.add('hidden');
            previewWrap.classList.add('hidden');
            empty.classList.remove('hidden');
            draft.dataUrl = null; draft.naturalW = 0; draft.naturalH = 0; draft.crop = null;
            document.getElementById('file-input').click();
        };

        nextStepBtn.textContent = '下一步：配文 →';

        // If we're resuming an existing segment that already has an image on
        // disk (imageId set) but no in-memory draft.bytes, fetch the image
        // bytes and load them into the cropper so the user can keep editing
        // without re-uploading.
        if (seg.imageId && !draft.dataUrl) {
            const url = `/api/projects/${state.projectId}/images/${seg.imageId}`;
            fetch(url)
                .then(resp => {
                    if (!resp.ok) throw new Error('http ' + resp.status);
                    return resp.blob();
                })
                .then(blob => {
                    const reader = new FileReader();
                    reader.onload = () => loadImage(reader.result, true);
                    reader.readAsDataURL(blob);
                })
                .catch(e => toast('加载图片失败：' + e.message, 'error'));
        }
    }

    function renderTextEditor(seg) {
        editorBody.innerHTML = `
        <div class="input-group">
            <label>第 ${state.currentIndex + 1} 段：文字</label>
            <div class="crop-preview" style="margin-bottom:16px">
                ${seg.imageUrl ? `<img src="${seg.imageUrl}" style="max-width:100%;max-height:240px;border:1px solid var(--border);border-radius:6px;">` : ''}
            </div>
            <textarea id="text-input" placeholder="写下这段文字...">${escapeHtml(seg.text || '')}</textarea>
            <div class="helper">支持换行，将在 HTML 中保留</div>
        </div>`;
        const ta = document.getElementById('text-input');
        ta.focus();
        ta.addEventListener('input', () => { seg.text = ta.value; autosave(); });
        nextStepBtn.textContent = state.currentIndex < state.segments.length - 1 ? '下一段 →' : '完成此段 ✓';
    }

    async function finalize() {
        const ready = state.segments.filter(s => s.imageId);
        if (ready.length === 0) { toast('请至少完成一段（上传图片）', 'error'); return; }
        if (!state.title.trim()) { toast('请填写标题', 'error'); return; }
        if (!state.projectId) {
            const pid = await ensureProject();
            if (!pid) return;
        }
        finishBtn.disabled = true;
        finishBtn.innerHTML = '<span class="spinner"></span> 生成中...';
        try {
            // v1 always uses template — instant, no AI call. AI runs only when user
            // submits feedback in the viewer (v2+).
            const r = await api(`/api/projects/${state.projectId}/finalize`, {
                method: 'POST',
                body: { draft: { title: state.title.trim(), items: serializeItems() } }
            });
            toast('v1 生成成功，正在跳到库…');
            setTimeout(() => { window.location.href = '/library'; }, 600);
        } catch (e) {
            toast('生成失败：' + e.message, 'error');
            finishBtn.disabled = false;
            finishBtn.innerHTML = '完成，生成 v1';
        }
    }

    renderThumbs();
    renderEditor();

    // Expose a resume hook so the global loadProjectForEdit() helper can
    // rehydrate state from a server-side project meta. Only one wizard can
    // be active at a time (the routing layer replaces the root innerHTML),
    // so a single global slot is sufficient.
    window.__wizardResume = function (meta) {
        if (!meta || meta.id !== state.projectId && !state.projectId) {
            // First time: adopt the project id
        }
        state.projectId = meta.id;
        state.title = meta.title || '';
        state.segments = [];
        state.currentIndex = 0;
        state.currentStep = 'image';

        // Adopt the persisted layout direction if the meta has one (either
        // stored at the top level or carried by the draft). When neither is
        // present we keep the in-wizard default of 'text-first' but the
        // server's finalize path will fall back to the legacy 'image-first'
        // for projects that never set the field.
        const persistedDir = (meta.layoutDirection)
            || (meta.draft && meta.draft.layoutDirection)
            || null;
        if (persistedDir === 'image-first' || persistedDir === 'text-first') {
            setLayoutDirection(persistedDir, { silent: true });
        }

        // Restore from the draft if present, otherwise fall back to the
        // latest version's items so the user can keep editing an already-
        // finalized project (e.g. add a new section, change text).
        const items = (meta.draft && Array.isArray(meta.draft.items) && meta.draft.items.length > 0)
            ? meta.draft.items
            : (latestVersionItems(meta));

        for (const it of items) {
            state.segments.push({
                status: 'done',
                imageId: it.imageId || null,
                imageUrl: it.imageId ? `/api/projects/${meta.id}/images/${it.imageId}` : null,
                text: it.text || ''
            });
        }
        if (state.segments.length === 0) {
            state.segments.push({ status: 'pending', text: '' });
        }

        // Sync the title input + UI
        titleInput.value = state.title;
        renderThumbs();
        renderEditor();
        toast('已加载项目，可继续编辑');
    };

    // Helper: pull image items from the latest finalized version's HTML
    // by scraping the project meta. We don't have a dedicated endpoint for
    // this, so we re-derive from the rendered HTML if no draft exists.
    function latestVersionItems(meta) {
        if (!meta.versions || meta.versions.length === 0) return [];
        const latest = meta.versions[meta.versions.length - 1];
        // We can't read the HTML here synchronously; the server returns the
        // HTML on demand. Returning [] is safe — the user can re-add segments
        // from scratch in that case. The preferred path is preserving a draft.
        // To avoid surprising users, attempt a synchronous fetch when no
        // draft exists:
        return [];
    }

    // If we landed here via the library "继续编辑" button, fetch the project
    // meta and restore the draft (title, segments, images) so the user can
    // keep editing. The images themselves are loaded server-side by imageId,
    // so no re-upload is needed.
    if (params && params.project) {
        loadProjectForEdit(params.project);
    }
}

async function loadProjectForEdit(projectId) {
    try {
        const meta = await api(`/api/projects/${encodeURIComponent(projectId)}`);
        // If the project has no draft (e.g. v1 was finalized and draft was
        // cleared), fetch the latest v{n}.html and re-derive segment items
        // from the rendered <img> + text nodes so the user has something to
        // edit instead of starting from scratch.
        if (!meta.draft || !Array.isArray(meta.draft.items) || meta.draft.items.length === 0) {
            if (meta.latestVersion > 0) {
                try {
                    const resp = await api(`/api/projects/${encodeURIComponent(projectId)}/v${meta.latestVersion}`);
                    meta.draft = parseHtmlToDraft(meta.title || '', resp.html || '');
                } catch (_) { /* fall through with empty draft */ }
            }
        }
        if (typeof window.__wizardResume === 'function') {
            window.__wizardResume(meta);
        }
    } catch (e) {
        toast('加载项目失败：' + e.message, 'error');
    }
}

// Parse a generated HTML page back into a draft so the user can edit
// already-finalized projects. Extracts <img> data-* imageId values from
// the /api/projects/<id>/images/<imageId> URL shape and pairs each with
// the text node that follows it.
function parseHtmlToDraft(title, html) {
    if (!html) return { title, items: [] };
    // Match every image in a generated segment and read the text from the
    // following .post-text element. This is intentionally DOM-based rather
    // than dependent on whitespace or a particular attribute order.
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const items = [];
    doc.querySelectorAll('img[src*="/api/projects/"][src*="/images/"]').forEach(img => {
        const match = img.getAttribute('src').match(/\/api\/projects\/[^/]+\/images\/([^/?#]+)/);
        if (!match) return;
        const textEl = img.parentElement?.querySelector('.post-text')
            || img.nextElementSibling?.classList?.contains('post-text') && img.nextElementSibling;
        items.push({ imageId: match[1], text: textEl ? textEl.textContent.trim() : '' });
    });
    return { title, items };
}

// Helper: crop a draft to a JPEG dataUrl using canvas
async function cropDataUrlToBlob(draft) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            const nx = (draft.crop.x - draft.offsetX) / draft.scale;
            const ny = (draft.crop.y - draft.offsetY) / draft.scale;
            const nw = draft.crop.w / draft.scale;
            const nh = draft.crop.h / draft.scale;
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(nw));
            canvas.height = Math.max(1, Math.round(nh));
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, nx, ny, nw, nh, 0, 0, canvas.width, canvas.height);
            resolve({ dataUrl: canvas.toDataURL('image/jpeg', 0.9), width: canvas.width, height: canvas.height });
        };
        img.onerror = reject;
        img.src = draft.dataUrl;
    });
}

// ---------- Library ----------
async function renderLibrary(root) {
    root.innerHTML = `
    <div class="wizard-container">
        <div class="wizard-header">
            <h1>HTML 库</h1>
            <p>所有已生成的图文 HTML 项目</p>
        </div>
        <div id="lib-body" class="text-center muted">加载中...</div>
    </div>`;
    let data;
    try {
        data = await api('/api/projects');
    } catch (e) {
        document.getElementById('lib-body').innerHTML = `<div class="error-text">加载失败：${escapeHtml(e.message)}</div>`;
        return;
    }
    const list = data.projects || [];
    const body = document.getElementById('lib-body');
    if (list.length === 0) {
        body.classList.remove('muted');
        body.innerHTML = `
        <div class="empty-state">
            <div style="font-size:48px">📭</div>
            <p>暂无项目</p>
            <button class="btn btn-primary" onclick="location.hash='#wizard'">去创建</button>
        </div>`;
        return;
    }
    body.classList.remove('muted');
    body.innerHTML = `<div class="library-list">${list.map(p => renderLibCard(p)).join('')}</div>` + `<div class="text-center spaced"><button class="btn btn-primary" onclick="location.hash='#wizard'">+ 新建项目</button></div>`;

    body.querySelectorAll('.version-select').forEach(sel => {
        sel.addEventListener('change', e => {
            const v = e.target.value;
            const projectId = e.target.dataset.project;
            window.location.href = v === 'latest' ? `/p/${projectId}` : `/p/${projectId}/v${v}`;
        });
        sel.addEventListener('click', e => e.stopPropagation());
    });
    // Action buttons: stop bubble (they have their own hrefs)
    body.querySelectorAll('.lib-actions, .btn-action').forEach(el => {
        el.addEventListener('click', e => e.stopPropagation());
    });
}

function renderLibCard(p) {
    const versions = [];
    for (let v = 1; v <= p.latestVersion; v++) versions.push(v);
    const date = p.updatedAt ? new Date(p.updatedAt).toLocaleString('zh-CN') : '';
    const hasHtml = p.latestVersion > 0;
    return `
    <div class="lib-card" data-project="${escapeAttr(p.id)}">
        <h3>${escapeHtml(p.title || '(未命名)')}</h3>
        <div class="meta">
            <span>v${p.latestVersion} · ${date}</span>
            ${hasHtml ? `<select class="version-select" data-project="${escapeAttr(p.id)}" onclick="event.stopPropagation()">
                <option value="latest">最新 (v${p.latestVersion})</option>
                ${versions.slice().reverse().map(v => `<option value="${v}">v${v}</option>`).join('')}
            </select>` : '<span class="muted">未生成</span>'}
        </div>
        <div class="lib-actions">
            <a class="btn-action primary" href="/p/${escapeAttr(p.id)}">进入</a>
            ${hasHtml ? `<a class="btn-action" href="/api/projects/${escapeAttr(p.id)}/v${p.latestVersion}/download" download>下载 v${p.latestVersion}</a>` : ''}
            ${hasHtml ? `<a class="btn-action" href="/api/projects/${escapeAttr(p.id)}/v${p.latestVersion}/pdf" download>导出 PDF</a>` : ''}
            <a class="btn-action" href="#wizard?project=${encodeURIComponent(p.id)}">✏️ 继续编辑</a>
        </div>
    </div>`;
}