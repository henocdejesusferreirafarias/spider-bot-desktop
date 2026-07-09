import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { parseArgs, readJsonl } from './captcha-nine-dataset-utils.mjs';

const args = parseArgs(process.argv.slice(2));
const manifest = String(args.manifest ?? 'dataset/labels.jsonl');
const out = String(args.out ?? 'dataset/review.html');
const apply = args.apply ? String(args.apply) : null;

function rel(path) {
  return path.replaceAll('\\', '/');
}

if (apply) {
  const decisions = JSON.parse(await import('node:fs').then((fs) => fs.readFileSync(apply, 'utf8')));
  const rejected = new Set(decisions.rejected ?? []);
  for (const row of readJsonl(manifest)) {
    if (!rejected.has(row.cellPath)) continue;
    const target = join('dataset', 'flagged', row.targetClass, basename(row.cellPath));
    mkdirSync(dirname(target), { recursive: true });
    if (existsSync(row.cellPath)) renameSync(row.cellPath, target);
  }
  console.log(`flagged=${rejected.size}`);
  process.exit(0);
}

const rows = readJsonl(manifest).sort((a, b) => a.clipScore - b.clipScore);
const cards = rows.map((row) => `
  <article class="card" data-cell="${row.cellPath}">
    <label><input type="checkbox" class="reject" value="${row.cellPath}"> errado</label>
    <img src="../${rel(row.cellPath)}" alt="${row.targetClass} ${row.challengeId}">
    <p><b>${row.targetClass}</b> score=${row.clipScore.toFixed(4)} row=${row.row} col=${row.col}</p>
    <p><a href="../${rel(row.gridPath)}">grid</a> <a href="../${rel(row.quesPath)}">ques</a></p>
  </article>`).join('\n');

const html = `<!doctype html>
<meta charset="utf-8">
<title>GeeTest nine review</title>
<style>
body{font-family:system-ui,Segoe UI,sans-serif;margin:24px;background:#f6f7f9;color:#1f2328}
.toolbar{position:sticky;top:0;background:#fff;border:1px solid #d0d7de;padding:12px;margin-bottom:16px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:12px}
.card{background:#fff;border:1px solid #d0d7de;border-radius:6px;padding:10px}
img{width:100%;aspect-ratio:1/1;object-fit:cover}
p{font-size:12px;line-height:1.35}
</style>
<div class="toolbar">
  <button id="download">Baixar review-decisions.json</button>
  <span id="count"></span>
</div>
<section class="grid">${cards}</section>
<script>
function update(){count.textContent=document.querySelectorAll('.reject:checked').length+' rejeitadas';}
document.addEventListener('change', update); update();
download.onclick=()=>{const rejected=[...document.querySelectorAll('.reject:checked')].map(x=>x.value);const blob=new Blob([JSON.stringify({rejected},null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='review-decisions.json';a.click();}
</script>`;

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, html);
console.log(out);
