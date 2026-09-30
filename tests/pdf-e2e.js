// End-to-end PDF test.
//
// For every project in the library, downloads the latest version's PDF,
// verifies:
//   1. HTTP 200 + Content-Type: application/pdf
//   2. Content-Disposition: attachment; filename ends with .pdf
//   3. Magic bytes %PDF (25 50 44 46)
//   4. PDF trailer: file ends with %%EOF
//   5. pdf-parse can extract text and the title appears in it
//
// Exits 0 on all-pass, 1 on any failure.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { PDFParse } = require('pdf-parse');

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

(async () => {
    const lib = JSON.parse((await get('/api/projects')).body).projects;
    console.log(`Testing PDF endpoint for ${lib.length} projects...\n`);

    const results = [];
    for (const p of lib) {
        const v = p.latestVersion;
        const url = `/api/projects/${p.id}/v${v}/pdf`;
        const out = `${p.title}_v${v}.pdf`.replace(/[\\/:*?"<>|]/g, '_');
        const outPath = path.join('/tmp', out);
        try {
            const r = await get(url);
            fs.writeFileSync(outPath, r.body);
            // Pull the actual <h1> from the raw HTML so we verify what's
            // actually rendered (meta.title may have been changed after
            // the html was generated).
            const htmlRes = await get(`/api/projects/${p.id}/v${v}`);
            const htmlJson = JSON.parse(htmlRes.body);
            const h1Match = (htmlJson.html || '').match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
            const expectedTitle = h1Match ? h1Match[1].replace(/<[^>]+>/g, '').trim() : p.title;

            const checks = [];
            checks.push(['status 200', r.status === 200]);
            const ct = r.headers['content-type'] || '';
            checks.push(['content-type application/pdf', /application\/pdf/i.test(ct)]);
            const cd = r.headers['content-disposition'] || '';
            checks.push(['content-disposition attachment', /attachment/i.test(cd)]);
            checks.push(['filename ends with .pdf', /\.pdf(\b|"|$)/.test(cd)]);
            const magic = r.body.slice(0, 4).toString();
            checks.push(['magic bytes %PDF', magic === '%PDF']);
            const tail = r.body.slice(-1024).toString('latin1');
            checks.push(['trailer %%EOF', /%%EOF\s*$/.test(tail)]);
            checks.push(['size > 1KB', r.body.length > 1024]);
            let titleFound = false;
            let parseErr = null;
            try {
                const parser = new PDFParse({ data: r.body });
                const result = await parser.getText();
                titleFound = (result.text || '').includes(expectedTitle);
            } catch (e) { parseErr = e.message; }
            checks.push(['pdf-parse succeeds', !parseErr]);
            checks.push([`title "${expectedTitle}" found in pdf`, titleFound]);

            const passed = checks.filter(c => c[1]).length;
            const total = checks.length;
            results.push({ title: p.title, version: v, size: r.body.length, passed, total, checks });
            console.log(`${passed===total?'✓':'✗'} ${p.title} v${v}  ${r.body.length} bytes  (${passed}/${total})`);
            if (passed !== total) {
                for (const [name, ok] of checks) console.log(`    ${ok?'  ok':'FAIL'}: ${name}`);
                if (parseErr) console.log(`    parse error: ${parseErr}`);
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