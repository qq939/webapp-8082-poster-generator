// End-to-end DOCX test.
//
// For every project in the library, downloads the latest version's DOCX,
// verifies:
//   1. HTTP 200 + Content-Type is the WordprocessingML MIME
//   2. Content-Disposition: attachment; filename ends with .docx
//   3. Magic bytes PK (50 4b) — it is a ZIP container
//   4. The ZIP opens and contains the required OOXML parts
//      ([Content_Types].xml, _rels/.rels, word/document.xml)
//   5. word/document.xml carries the title (taken from the rendered <h1>)
//   6. One <w:drawing> per <img class="post-img"> in the HTML
//   7. Every media part referenced by document.xml.rels actually exists
//
// Exits 0 on all-pass, 1 on any failure.

const http = require('http');
const { unzipSync } = require('fflate');

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function get(urlPath) {
    return new Promise((resolve, reject) => {
        http.get('http://127.0.0.1:8082' + urlPath, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve({
                status: res.statusCode,
                headers: res.headers,
                body: Buffer.concat(chunks)
            }));
        }).on('error', reject);
    });
}

function text(files, name) {
    return files[name] ? Buffer.from(files[name]).toString('utf8') : '';
}

(async () => {
    const lib = JSON.parse((await get('/api/projects')).body).projects;
    console.log(`Testing DOCX endpoint for ${lib.length} projects...\n`);

    const results = [];
    for (const p of lib) {
        const v = p.latestVersion;
        const url = `/api/projects/${p.id}/v${v}/docx`;
        const checks = [];
        try {
            const r = await get(url);
            checks.push(['status 200', r.status === 200]);
            checks.push(['content-type docx mime', (r.headers['content-type'] || '') === DOCX_MIME]);
            const cd = r.headers['content-disposition'] || '';
            checks.push(['content-disposition attachment', /attachment/i.test(cd)]);
            checks.push(['filename ends with .docx', /\.docx(\b|"|$)/.test(cd)]);
            checks.push(['magic bytes PK', r.body.slice(0, 2).toString('binary') === 'PK']);
            checks.push(['size > 1KB', r.body.length > 1024]);

            let files = {};
            let zipErr = null;
            try { files = unzipSync(new Uint8Array(r.body)); } catch (e) { zipErr = e.message; }
            checks.push(['zip opens', !zipErr]);
            checks.push(['[Content_Types].xml present', !!files['[Content_Types].xml']]);
            checks.push(['_rels/.rels present', !!files['_rels/.rels']]);
            checks.push(['word/document.xml present', !!files['word/document.xml']]);
            checks.push(['word/_rels/document.xml.rels present', !!files['word/_rels/document.xml.rels']]);

            const doc = text(files, 'word/document.xml');
            const ct = text(files, '[Content_Types].xml');

            // Expected title = the rendered <h1>, not meta.title (may have drifted).
            const htmlRes = await get(`/api/projects/${p.id}/v${v}`);
            const html = JSON.parse(htmlRes.body).html || '';
            const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
            const expectedTitle = h1Match ? h1Match[1].replace(/<[^>]+>/g, '').trim() : p.title;
            checks.push([`title "${expectedTitle}" in document.xml`, doc.includes(expectedTitle)]);

            const imgCount = (html.match(/<img class="post-img"/g) || []).length;
            const drawingCount = (doc.match(/<w:drawing>/g) || []).length;
            checks.push([`${imgCount} images embedded`, drawingCount === imgCount]);

            // Every r:embed id in document.xml.rels must resolve to a real part.
            const rels = text(files, 'word/_rels/document.xml.rels');
            const targets = [...rels.matchAll(/Target="(media\/[^"]+)"/g)].map(m => 'word/' + m[1]);
            const relsOk = imgCount === 0
                ? targets.length === 0
                : (targets.length > 0 && targets.every(t => !!files[t]));
            checks.push([`${targets.length} media rels resolve`, relsOk]);
            checks.push(['[Content_Types] declares png', /Extension="png"/.test(ct) || imgCount === 0]);
            checks.push(['eastAsia font set', /w:eastAsia="[^"]+"/.test(doc)]);

            const passed = checks.filter(c => c[1]).length;
            const total = checks.length;
            results.push({ title: p.title, version: v, size: r.body.length, passed, total });
            console.log(`${passed === total ? '✓' : '✗'} ${p.title} v${v}  ${r.body.length} bytes  (${passed}/${total})`);
            if (passed !== total) {
                for (const [name, ok] of checks) if (!ok) console.log(`    FAIL: ${name}`);
                if (zipErr) console.log(`    zip error: ${zipErr}`);
            }
        } catch (e) {
            console.log(`✗ ${p.title} v${v}  ERROR: ${e.message}`);
            results.push({ title: p.title, version: v, error: e.message });
        }
    }

    const failed = results.filter(r => r.error || (r.passed !== r.total));
    console.log(`\n${'='.repeat(60)}`);
    console.log(`SUMMARY: ${results.length - failed.length}/${results.length} projects PASS`);
    if (failed.length) {
        console.log('FAILED:');
        for (const f of failed) console.log(`  - ${f.title} v${f.version}: ${f.error || 'check failures'}`);
        process.exit(1);
    }
    console.log('All checks passed ✓');
})();
