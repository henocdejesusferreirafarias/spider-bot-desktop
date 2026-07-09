import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { decodeRgba, splitGridCells } from './captcha-nine-dataset-utils.mjs';
import { JsonlWriter, StateFile, loadChallenges } from './captcha-label-persistence.mjs';
import { LabelingQueue } from './captcha-label-queue.mjs';

const HTML = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>Plan 2d - Manual Labeling</title>
<style>
:root { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; background: #f6f7f9; color: #1f2328; }
body { margin: 0; padding: 24px; }
header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 16px; }
header h1 { font-size: 18px; margin: 0; }
header .stats { font-size: 13px; color: #57606a; }
main { max-width: 720px; margin: 0 auto; background: #fff; border: 1px solid #d0d7de; border-radius: 8px; padding: 24px; }
.ques { text-align: center; margin-bottom: 16px; }
.ques img { max-height: 140px; background: #fff; border: 1px solid #d0d7de; }
.grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; aspect-ratio: 1 / 1; }
.cell { position: relative; cursor: pointer; border: 2px solid transparent; border-radius: 4px; overflow: hidden; }
.cell img { width: 100%; height: 100%; object-fit: cover; display: block; }
.cell.selected { border-color: #1f883d; box-shadow: 0 0 0 2px rgba(31, 136, 61, 0.3) inset; }
.cell .coord { position: absolute; top: 4px; left: 4px; background: rgba(0, 0, 0, 0.6); color: #fff; font-size: 11px; padding: 1px 4px; border-radius: 3px; }
.actions { display: flex; gap: 8px; margin-top: 16px; align-items: center; }
button { font: inherit; padding: 8px 14px; border-radius: 6px; border: 1px solid #d0d7de; background: #f6f8fa; cursor: pointer; }
button.primary { background: #1f883d; color: #fff; border-color: #1f883d; }
button:disabled { opacity: 0.5; cursor: not-allowed; }
.hint { font-size: 13px; color: #57606a; }
.error { color: #cf222e; font-size: 13px; margin-top: 8px; }
</style>
</head>
<body>
<header>
  <h1>Plan 2d - Manual Labeling</h1>
  <div class="stats" id="stats">Carregando...</div>
</header>
<main id="main">
  <div class="ques"><img id="ques" alt="ques"></div>
  <div class="grid" id="grid"></div>
  <div class="actions">
    <button id="save" class="primary" disabled>Salvar (Enter)</button>
    <button id="clear">Limpar (Esc)</button>
    <button id="skip">Pular (Right arrow)</button>
    <span class="hint" id="hint"></span>
  </div>
  <div class="error" id="error"></div>
</main>
<script>
const els = {
  stats: document.getElementById('stats'),
  ques: document.getElementById('ques'),
  grid: document.getElementById('grid'),
  save: document.getElementById('save'),
  clear: document.getElementById('clear'),
  skip: document.getElementById('skip'),
  hint: document.getElementById('hint'),
  error: document.getElementById('error'),
  main: document.getElementById('main'),
};
let state = { challengeId: null, round: 1, nineNums: 3, selected: new Set() };

function cellKey(row, col) { return row + ',' + col; }

async function refreshStats() {
  const response = await fetch('/api/stats');
  const stats = await response.json();
  els.stats.textContent = stats.labeledRounds + ' / ' + (stats.remainingRounds + stats.labeledRounds) + ' rodadas | Disputas: ' + stats.disputeCount;
}

function updateButtons() {
  els.hint.textContent = 'Selecione ' + state.nineNums + ' celulas. Marcadas: ' + state.selected.size + '.';
  els.save.disabled = state.selected.size !== state.nineNums;
}

function clearSelection() {
  state.selected.clear();
  for (const cell of els.grid.querySelectorAll('.cell.selected')) cell.classList.remove('selected');
  updateButtons();
}

function toggleCell(row, col) {
  const key = cellKey(row, col);
  if (state.selected.has(key)) {
    state.selected.delete(key);
  } else {
    if (state.selected.size >= state.nineNums) return;
    state.selected.add(key);
  }
  const cell = els.grid.querySelector('[data-key="' + key + '"]');
  if (cell) cell.classList.toggle('selected', state.selected.has(key));
  updateButtons();
}

function selectedToCells() {
  return Array.from(state.selected)
    .map((key) => key.split(',').map(Number))
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

async function loadChallenge() {
  state.selected.clear();
  els.error.textContent = '';
  const response = await fetch('/api/challenge');
  const body = await response.json();
  if (body.done) {
    els.main.innerHTML = '<h2>Sessao completa</h2><p>Todas as rodadas rotuladas.</p>';
    await refreshStats();
    return;
  }

  state = { challengeId: body.challengeId, round: body.round, nineNums: body.nineNums, selected: new Set() };
  els.ques.src = body.quesDataUrl;
  els.grid.innerHTML = '';
  for (const cell of body.cells) {
    const element = document.createElement('div');
    element.className = 'cell';
    element.dataset.key = cellKey(cell.row, cell.col);
    const image = document.createElement('img');
    image.src = cell.dataUrl;
    image.alt = 'cell ' + cell.row + ',' + cell.col;
    const coord = document.createElement('span');
    coord.className = 'coord';
    coord.textContent = '(' + cell.row + ',' + cell.col + ')';
    element.appendChild(image);
    element.appendChild(coord);
    element.addEventListener('click', () => toggleCell(cell.row, cell.col));
    els.grid.appendChild(element);
  }
  await refreshStats();
  updateButtons();
}

async function submit(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    els.error.textContent = 'Falha ao salvar: ' + response.status;
    return false;
  }
  return true;
}

async function save() {
  if (state.selected.size !== state.nineNums) return;
  els.error.textContent = '';
  if (await submit('/api/label', { round: state.round, cells: selectedToCells() })) await loadChallenge();
}

async function skipRound() {
  els.error.textContent = '';
  if (await submit('/api/skip', { round: state.round })) await loadChallenge();
}

els.save.addEventListener('click', save);
els.clear.addEventListener('click', clearSelection);
els.skip.addEventListener('click', skipRound);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') { event.preventDefault(); save(); }
  else if (event.key === 'Escape' || event.key === 'Backspace') { event.preventDefault(); clearSelection(); }
  else if (event.key === 'ArrowRight') { event.preventDefault(); skipRound(); }
  else if (/^[1-9]$/.test(event.key)) {
    const number = Number(event.key);
    toggleCell(Math.floor((number - 1) / 3) + 1, ((number - 1) % 3) + 1);
  }
});

loadChallenge();
</script>
</body>
</html>`;

const LABEL_QUEUE_SEED = 20260710;

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function fileToDataUrl(filePath) {
  const buffer = readFileSync(filePath);
  const mime = filePath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

function cellsToDataUrls(gridPath) {
  const decoded = decodeRgba(readFileSync(gridPath));
  return splitGridCells(decoded.data, decoded.width, decoded.height).map((cell) => {
    const png = new PNG({ width: cell.width, height: cell.height });
    png.data = Buffer.from(cell.data);
    const buffer = PNG.sync.write(png);
    return {
      row: cell.row,
      col: cell.col,
      dataUrl: `data:image/png;base64,${buffer.toString('base64')}`,
    };
  });
}

function readAuditEntries(file) {
  if (!existsSync(file)) return [];
  const entries = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry && typeof entry === 'object') entries.push(entry);
    } catch {
      // Keep valid audit history available after a partial final line from a crash.
    }
  }
  return entries;
}

function isAuditCells(value) {
  return Array.isArray(value) && value.every((cell) => (
    Array.isArray(cell)
    && cell.length === 2
    && Number.isInteger(cell[0])
    && Number.isInteger(cell[1])
  ));
}

function replayAudit(queue, entries, challengeIds) {
  for (const entry of entries) {
    if (!challengeIds.has(entry.challengeId)) continue;
    if (entry.kind === 'round' && (entry.round === 1 || entry.round === 2) && isAuditCells(entry.cells)) {
      queue.recordLabel(entry.challengeId, entry.round, entry.cells);
      continue;
    }
    if (entry.kind === 'skipped' && (entry.round === 1 || entry.round === 2)) {
      queue.recordSkip(entry.challengeId, entry.round);
      continue;
    }
    if (entry.kind === 'final' && entry.fromDispute === true) {
      if (entry.disputeResolution === 'round1' || entry.disputeResolution === 'round2') {
        queue.resolveDispute(entry.challengeId, entry.disputeResolution);
      } else if (entry.disputeResolution === 'relabel' && isAuditCells(entry.cells)) {
        queue.resolveDispute(entry.challengeId, 'relabel', entry.cells);
      }
    }
  }
}

function validatedCells(value, expectedCount) {
  if (!Array.isArray(value) || value.length !== expectedCount) {
    return { error: `expected ${expectedCount} cells` };
  }

  const cells = [];
  const seen = new Set();
  for (const cell of value) {
    if (!Array.isArray(cell) || cell.length !== 2) {
      return { error: 'cells must be [row, col]' };
    }
    const [row, col] = cell;
    if (!Number.isInteger(row) || !Number.isInteger(col) || row < 1 || row > 3 || col < 1 || col > 3) {
      return { error: 'cells must use 1-indexed row and col values from 1 to 3' };
    }
    const key = `${row}:${col}`;
    if (seen.has(key)) {
      return { error: 'cells must be unique' };
    }
    seen.add(key);
    cells.push([row, col]);
  }

  cells.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  return { cells };
}

export async function startLabelServer(opts = {}) {
  const port = opts.port ?? 8765;
  const host = opts.host ?? '127.0.0.1';
  const rawDir = opts.rawDir ?? join(process.cwd(), 'dataset', 'raw');
  const datasetDir = opts.datasetDir ?? join(process.cwd(), 'dataset');
  mkdirSync(datasetDir, { recursive: true });

  const { challenges, skipLog } = loadChallenges(rawDir);
  if (skipLog.length > 0) {
    writeFileSync(join(datasetDir, 'label-skip.log'), `${skipLog.join('\n')}\n`, 'utf8');
  }
  if (challenges.length === 0) {
    throw new Error(`Nenhum desafio em ${rawDir}. Rode scripts/captcha-collect-nine-dataset.mjs primeiro.`);
  }

  const labelsWriter = new JsonlWriter(join(datasetDir, 'manual-labels.jsonl'));
  const disputesWriter = new JsonlWriter(join(datasetDir, 'label-disputes.jsonl'));
  const stateFile = new StateFile(join(datasetDir, 'label-state.json'), { lockWindowMs: 5000 });
  const challengeIds = new Set(challenges.map((challenge) => challenge.id));
  const auditEntries = readAuditEntries(labelsWriter.file);
  const queue = new LabelingQueue(challenges.map((challenge) => challenge.id), LABEL_QUEUE_SEED);
  replayAudit(queue, auditEntries, challengeIds);
  const challengesById = new Map(challenges.map((challenge) => [challenge.id, challenge]));
  let activePointer = null;

  function nextPointer() {
    if (!activePointer) activePointer = queue.next();
    return activePointer;
  }

  function reserveState(nextEntries) {
    if (existsSync(stateFile.file)) {
      const currentMtimeMs = statSync(stateFile.file).mtimeMs;
      if (
        currentMtimeMs !== stateFile.lastKnownMtimeMs
        && Date.now() - currentMtimeMs <= stateFile.lockWindowMs
      ) {
        return { ok: false, reason: 'state file is locked by another writer' };
      }
    }

    const prospectiveQueue = new LabelingQueue(challenges.map((challenge) => challenge.id), LABEL_QUEUE_SEED);
    replayAudit(prospectiveQueue, [...auditEntries, ...nextEntries], challengeIds);
    const stats = prospectiveQueue.getStats();
    const result = stateFile.save({
      version: 1,
      seed: prospectiveQueue.seed,
      totalRounds: stats.labeledRounds + stats.skippedRounds + stats.remainingRounds,
      currentIndex: stats.labeledRounds + stats.skippedRounds,
      labeledKeys: prospectiveQueue.getLabeledKeys(),
      disputes: prospectiveQueue.getDisputes().map((dispute) => dispute.challengeId),
      lastSavedAt: new Date().toISOString(),
    });
    return result.ok ? result : { ok: false, reason: 'state file is locked by another writer' };
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${host}:${port}`);
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(HTML);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/challenge') {
        const pointer = nextPointer();
        if (!pointer) {
          json(res, 200, { done: true });
          return;
        }
        const challenge = challengesById.get(pointer.challengeId);
        if (!challenge) throw new Error(`missing challenge ${pointer.challengeId}`);
        json(res, 200, {
          challengeId: pointer.challengeId,
          round: pointer.round,
          totalRounds: pointer.totalRounds,
          currentIndex: pointer.currentIndex,
          nineNums: challenge.nineNums,
          quesDataUrl: fileToDataUrl(challenge.quesPath),
          cells: cellsToDataUrls(challenge.gridPath),
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/stats') {
        json(res, 200, queue.getStats());
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/disputes') {
        json(res, 200, queue.getDisputes());
        return;
      }

      if (req.method === 'POST' && (url.pathname === '/api/label' || url.pathname === '/api/skip')) {
        let body;
        try {
          body = await readJsonBody(req);
        } catch {
          json(res, 400, { saved: false, error: 'invalid JSON body' });
          return;
        }

        const pointer = nextPointer();
        if (!pointer) {
          json(res, 400, { saved: false, error: 'queue exhausted' });
          return;
        }
        if (body?.round !== pointer.round) {
          json(res, 400, { saved: false, error: `expected round ${pointer.round}` });
          return;
        }
        const challenge = challengesById.get(pointer.challengeId);
        if (!challenge) throw new Error(`missing challenge ${pointer.challengeId}`);

        if (url.pathname === '/api/skip') {
          const skippedEntry = {
            kind: 'skipped',
            challengeId: pointer.challengeId,
            round: pointer.round,
            labeledAt: new Date().toISOString(),
          };
          const stateResult = reserveState([skippedEntry]);
          if (!stateResult.ok) {
            json(res, 409, { saved: false, error: stateResult.reason });
            return;
          }
          labelsWriter.append(skippedEntry);
          auditEntries.push(skippedEntry);
          queue.recordSkip(pointer.challengeId, pointer.round);
          activePointer = null;
          json(res, 200, { saved: true, stats: queue.getStats() });
          return;
        }

        const result = validatedCells(body?.cells, challenge.nineNums);
        if (result.error) {
          json(res, 400, { saved: false, error: result.error });
          return;
        }

        const roundEntry = {
          kind: 'round',
          challengeId: pointer.challengeId,
          round: pointer.round,
          cells: result.cells,
          labeledAt: new Date().toISOString(),
        };
        const stateResult = reserveState([roundEntry]);
        if (!stateResult.ok) {
          json(res, 409, { saved: false, error: stateResult.reason });
          return;
        }
        labelsWriter.append(roundEntry);
        auditEntries.push(roundEntry);
        const labelResult = queue.recordLabel(pointer.challengeId, pointer.round, result.cells);
        activePointer = null;
        if (labelResult.bothRoundsNowLabeled) {
          const dispute = queue.getDisputes().find((item) => item.challengeId === pointer.challengeId);
          if (dispute) {
            if (labelResult.isNewDispute) {
              disputesWriter.append({
                challengeId: pointer.challengeId,
                round1Cells: dispute.round1Cells,
                round2Cells: dispute.round2Cells,
                detectedAt: new Date().toISOString(),
              });
            }
          } else {
            const finalEntry = {
              kind: 'final',
              challengeId: pointer.challengeId,
              cells: result.cells,
              fromDispute: false,
              disputeResolution: null,
              labeledAt: new Date().toISOString(),
            };
            labelsWriter.append(finalEntry);
            auditEntries.push(finalEntry);
          }
        }
        json(res, 200, { saved: true, stats: queue.getStats() });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/disputes/resolve') {
        let body;
        try {
          body = await readJsonBody(req);
        } catch {
          json(res, 400, { saved: false, error: 'invalid JSON body' });
          return;
        }
        if (typeof body?.challengeId !== 'string' || typeof body.choice !== 'string') {
          json(res, 400, { saved: false, error: 'challengeId and choice required' });
          return;
        }
        const dispute = queue.getDisputes().find((item) => item.challengeId === body.challengeId);
        if (!dispute) {
          json(res, 404, { saved: false, error: 'dispute not found' });
          return;
        }

        const challenge = challengesById.get(body.challengeId);
        if (!challenge) throw new Error(`missing challenge ${body.challengeId}`);
        let finalCells;
        if (body.choice === 'round1') finalCells = dispute.round1Cells;
        else if (body.choice === 'round2') finalCells = dispute.round2Cells;
        else if (body.choice === 'relabel') {
          const result = validatedCells(body.cells, challenge.nineNums);
          if (result.error) {
            json(res, 400, { saved: false, error: result.error });
            return;
          }
          finalCells = result.cells;
        } else {
          json(res, 400, { saved: false, error: 'choice must be round1, round2, or relabel' });
          return;
        }

        const finalEntry = {
          kind: 'final',
          challengeId: body.challengeId,
          cells: finalCells,
          fromDispute: true,
          disputeResolution: body.choice,
          labeledAt: new Date().toISOString(),
        };
        const stateResult = reserveState([finalEntry]);
        if (!stateResult.ok) {
          json(res, 409, { saved: false, error: stateResult.reason });
          return;
        }
        labelsWriter.append(finalEntry);
        auditEntries.push(finalEntry);
        disputesWriter.append({
          challengeId: body.challengeId,
          round1Cells: dispute.round1Cells,
          round2Cells: dispute.round2Cells,
          choice: body.choice,
          finalCells,
          resolvedAt: new Date().toISOString(),
        });
        queue.resolveDispute(body.challengeId, body.choice, body.choice === 'relabel' ? finalCells : undefined);
        json(res, 200, { saved: true });
        return;
      }

      json(res, 404, { error: 'not found' });
    } catch (error) {
      console.error('label server error:', error);
      json(res, 500, { saved: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  return {
    port: actualPort,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  const port = Number(process.env.LABEL_PORT ?? 8765);
  const server = await startLabelServer({ port });
  console.log(`Listening on http://127.0.0.1:${server.port}`);
}
