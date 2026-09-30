(function () {
    const projectId = window.PROJECT_ID;
    const version = parseInt(window.VERSION, 10);
    const latest = parseInt(window.LATEST, 10);

    const iframe = document.getElementById('html-frame');
    const feedbackInput = document.getElementById('feedback-input');
    const submitBtn = document.getElementById('submit-feedback');
    const statusBox = document.getElementById('status-box');
    const versionList = document.getElementById('version-list');
    const copyBtn = document.getElementById('copy-html-btn');

    let currentHtml = '';
    let meta = null;

    function setStatus(text, kind = '') {
        statusBox.className = 'status-box' + (kind ? ' ' + kind : '');
        statusBox.textContent = text;
    }

    function escapeHtml(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
    }

    async function loadAll() {
        try {
            meta = await api(`/api/projects/${projectId}`);
        } catch (e) {
            setStatus('加载项目失败：' + e.message, 'error');
            return;
        }
        renderVersionList();
        await loadVersion(version);
    }

    async function loadVersion(v) {
        setStatus('加载中...');
        try {
            const r = await api(`/api/projects/${projectId}/v${v}`);
            currentHtml = r.html;
            // Write into iframe
            const doc = iframe.contentDocument || iframe.contentWindow.document;
            doc.open();
            doc.write(currentHtml);
            doc.close();
            // Highlight current in version list
            versionList.querySelectorAll('li').forEach(li => {
                li.classList.toggle('current', parseInt(li.dataset.version, 10) === v);
            });
            setStatus('已加载 v' + v + (v === r.latestVersion ? '（最新）' : `（最新为 v${r.latestVersion}）`),
                      v === r.latestVersion ? 'success' : '');
        } catch (e) {
            setStatus('加载失败：' + e.message, 'error');
        }
    }

    function renderVersionList() {
        const versions = (meta.versions || []).slice().sort((a, b) => b.version - a.version);
        versionList.innerHTML = versions.map(v => {
            const isCurrent = v.version === version;
            const date = v.createdAt ? new Date(v.createdAt).toLocaleString('zh-CN') : '';
            const fb = (v.feedback || '').slice(0, 30);
            return `<li data-version="${v.version}" class="${isCurrent ? 'current' : ''}">
                <span class="ver-label">v${v.version}${v.version === meta.latestVersion ? ' ★' : ''}</span>
                <span class="ver-meta" title="${escapeHtml(v.feedback || '')}">${escapeHtml(fb)}<br>${escapeHtml(date)}</span>
            </li>`;
        }).join('');
        versionList.querySelectorAll('li').forEach(li => {
            li.addEventListener('click', () => {
                const v = parseInt(li.dataset.version, 10);
                window.location.href = `/p/${projectId}/v${v}`;
            });
        });
    }

    submitBtn.addEventListener('click', async () => {
        const fb = feedbackInput.value.trim();
        if (!fb) { setStatus('请输入修改意见', 'error'); return; }
        submitBtn.disabled = true;
        const originalText = submitBtn.innerHTML;
        submitBtn.innerHTML = '<span class="spinner"></span> 生成中...';
        setStatus('调用 Claude 中，可能需要数十秒...');
        try {
            const r = await api(`/api/projects/${projectId}/feedback`, {
                method: 'POST',
                body: { baseVersion: version, feedback: fb }
            });
            setStatus(`成功生成 v${r.newVersion}！正在跳转...`, 'success');
            setTimeout(() => {
                window.location.href = `/p/${projectId}/v${r.newVersion}`;
            }, 700);
        } catch (e) {
            setStatus('生成失败：' + e.message, 'error');
            submitBtn.disabled = false;
            submitBtn.innerHTML = originalText;
        }
    });

    copyBtn.addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(currentHtml);
            const old = copyBtn.textContent;
            copyBtn.textContent = '已复制 ✓';
            setTimeout(() => copyBtn.textContent = old, 1500);
        } catch (e) {
            setStatus('复制失败：' + e.message, 'error');
        }
    });

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
            throw err;
        }
        return json;
    }

    loadAll();
})();