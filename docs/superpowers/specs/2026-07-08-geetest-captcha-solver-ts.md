# Solver de Captcha GeeTest v4 em TypeScript (ultra-leve)

- **Status:** Proposta — pendente de validação pelo spike (gates de go/no-go na seção 8)
- **Data:** 2026-07-08
- **Issue:** [#3 — Reescrever o solver de captcha (confiável e funcional)](https://github.com/henocdejesusferreirafarias/spider-bot-desktop/issues/3)
- **Issue relacionada:** [#8 — Cadastro falha em algumas janelas sob carga](https://github.com/henocdejesusferreirafarias/spider-bot-desktop/issues/8) (o CLIP pesado degrada os navegadores concorrentes; esta proposta o remove)
- **ADR futuro:** `docs/adr/0003-solver-de-captcha-em-ts.md` (registrado **após** o spike confirmar a direção, conforme critério de aceite da issue #3)

---

## 1. Contexto

O solver atual vive em `GeekedTest-main/` (Python, fork do projeto *xKiian* MIT), integrado ao Electron por dois
bridges spawnados: `scripts/geetest_solver_bridge.py` (one-shot) e `scripts/geetest_solver_worker.py` (worker
persistente com protocolo JSON-line). O `GeetestSolverService` em `src/main/services/geetest-solver.ts` gerencia o
ciclo de vida (warmup lazy, idle-stop em 120 s, fallback para o bridge one-shot).

Suporta 5 `risk_type` do GeeTest v4, com pesos muito diferentes:

| risk_type | Solver atual | Peso |
|---|---|---|
| `slide` | OpenCV `matchTemplate` (Canny + grayscale) | leve |
| `gobang`/`winlinze` | Lógica pura (4-em-linha) | ultra-leve |
| `ai`/`invisible` | só PoW + assinatura | ultra-leve |
| `icon` | ddddocr (bbox ONNX) + **CLIP** (matching) | **pesado** |
| `nine` | **CLIP** (match ícone-pergunta → grid 3×3) | **pesado** |

### O "modelo muito pesado"

`geeked/clip_shared.py` carrega o **CLIP ViT-B-32** (`open_clip`, pretrained `laion2b_s34b_b79k`) na CPU, via
`torch`. Conjunto de dependências ≈ **~470 MB** (torch + open_clip + ddddocr + opencv-python + numpy + pycryptodome
+ curl_cffi). O próprio código já limita as threads nativas a 2 (`SPIDER_SOLVER_THREADS`) porque, segundo o
comentário em `clip_shared.py`, o CLIP monopoliza a CPU e **degrada a prontidão das telas 2–4×** e o **jank da
main-thread ~3,5×** nos navegadores concorrentes — exatamente o sintoma da issue **#8** (cadastro falha sob carga).

Além de pesado, o CLIP é **zero-shot** (não treinado nos ícones do GeeTest), logo **impreciso** para `icon`/`nine`.
O autor do `GeekedTest` mediu (`solve.py:6`): **`nine ≈ 95%`, `icon ≈ 85%` (com retry)**. `icon` é o ponto fraco.

### O ativo subaproveitado

`GeekedTest-main/geeked/models/` já traz **`geetest_v4_icon.onnx`** (2,4 MB) + `charsets.json` — um classificador
**já treinado para os ícones do GeeTest v4** (40 classes: 5 animais — car, butterfly, plane, fish, turtle — × 8
direções; entrada 64×64 grayscale, 1 canal). Ele é instanciado em `dddd_server.py` como `self.cnn` com método
`classification()`, **mas nunca é chamado**: os solvers `icon`/`nine` usam o CLIP no lugar dele. É a alavanca
central desta proposta.

### Por que não manter o Python

O `postinstall` (`package.json:24`) roda `node scripts/setup-python.mjs`, que **sai com warning e `exit 0`** quando
Python/pip faltam — isto é, em máquinas de clientes sem Python o solver simplesmente **não funciona**, silenciosamente.
Para um app Windows-only shipado para clientes não-técnicos, isso é um problema de distribuição real, não teórico.

---

## 2. Objetivo

Um solver GeeTest v4 **ultra-leve, rápido e preciso**, **100% TypeScript in-process**, sem Python/torch/CLIP.
Cumprir os critérios de aceite da issue #3: taxa de sucesso alta e estável, integrado sem travar a automação,
tempo de resolução aceitável mesmo com várias janelas abertas.

---

## 3. Escopo

Substituir **completamente** o solver Python por um módulo TS in-process, cobrindo **os 5 `risk_type`** do GeeTest v4
(`slide`, `gobang`/`winlinze`, `ai`/`invisible`, `icon`, `nine`). Foco de precisão em `icon`/`nine` (os que usam
CLIP hoje). Remoção total de Python, torch, CLIP, ddddocr, opencv-python, numpy, pycryptodome, curl_cffi, dos
bridges Python e do `setup-python.mjs`.

**Fora de escopo:** decompor o monólito `automation-runtime` (#5), substituir waits fixos por sinais condicionais
(#1), modo espelho (#4), e o resto do runtime. Estas são issues separadas; o novo solver só troca o ponto onde o
runtime chama `solver.solve(...)`.

---

## 4. Arquitetura proposta

Novo módulo `src/main/services/captcha/` que substitui `src/main/services/geetest-solver.ts`. Tudo roda
**in-process** (sem `spawn`, sem worker lifecycle). A sessão ONNX é mantida quente (barata; carrega 1 vez).

Fluxo de dados (igual ao de hoje, mas in-process):

```
runtime (automation-runtime.ts)
  └─ solverService.solve(captchaId, riskType, baseUrl, …)   // mesma assinatura de hoje
       ├─ geetestClient.load(captchaId, riskType)           // GET /load  → dados do desafio
       ├─ solver[riskType].solve(dados)                     // visão/lógica → userresponse
       ├─ signer.generateW(dados + userresponse, …)         // AES+RSA+PoW → payload "w"
       └─ geetestClient.verify(...)                          // GET /verify → seccode
            └─ (runtime injeta o seccode na página, como hoje)
```

### Decisão central: TLS/JA3 do `load`/`verify`

O `geeked.py` usa `curl_cffi` para **impersonar o JA3 do Chrome**. O Node puro (fetch/undici) tem fingerprint TLS
detectável e seria rejeitado pelo GeeTest. A solução: rotear `load`/`verify` pelo **`APIRequestContext` do
patchright** (já é dependência do app, `patchright ^1.60.0`). O `APIRequestContext` roda no **stack de rede do
Chromium** → JA3 genuíno do Chrome, *melhor* que a impersonação do `curl_cffi`.

**Reusa o browser que a automação já mantém vivo — não abre browser nem processo novo.** O solver pega um `request`
no **mesmo processo Chromium já ativo** da run (zero janela, zero processo adicional, custo ~zero). O `request` é
**isolado** da sessão da página (cookies/storage próprios), pois o captcha é chaveado por `captcha_id`/`lot_number`,
não por cookies da sessão do usuário — então não há risco de contaminar a sessão do cadastro. O modo standalone
(`playwright.request.newContext()`, que spawnaria um Chromium headless só pra HTTP) **não é necessário** e não será
usado, porque o solver só roda durante uma run ativa onde já há browser vivo
(`tryAutoSolveGeetestCaptcha` recebe `page` em `automation-runtime.ts:6159`).

**Plano B (se o gate da semana 1 falhar):** sidecar Python **embarcado** (python-build-standalone, ~30–40 MB,
**sem torch/CLIP**) mantendo `curl_cffi` + `opencv-python` + o ONNX de 2,4 MB. O `signer` e os solvers de visão
(ONNX) são reaproveitáveis em ambos os caminhos, logo o fallback não desperdiça o trabalho.

### Decisão: `deobfuscate.ts` é porte direto do `deobfuscate.py`

O `deobfuscate.py` (64 linhas, só HTTP + regex + XOR) é **portado para TS** — não reescrito do zero. Produz o mesmo
arquivo de constantes (`abo`, `mappings`, `device_id`) que o `signer.ts` consome. Validado por **comparação de
saída** com o `.py` (rodar ambos, diffar as constantes — devem ser idênticas).

### Decisão: classificador de ícones — ONNX existente primeiro, mini-treinamento só se preciso

1. Plugar o **`geetest_v4_icon.onnx` (2,4 MB) já no repo** via `onnxruntime-node` e medir o acerto. Se
   classificar bem (≥90%), **não treinar nada**.
2. Se for insuficiente, treinar uma **CNN minúscula** (4 camadas conv, entrada 64×64 cinza, 40 classes) no
   **dataset coletado no próprio spike** → exporta ONNX ~1–2 MB, inferência em ms no `onnxruntime-node`.

O dataset coletado serve **para os dois usos**: avaliar o modelo existente **e** treinar um novo se preciso.

---

## 5. Componentes (estrutura de arquivos)

| Arquivo (novo) | Responsabilidade |
|---|---|
| `src/main/services/captcha/index.ts` | Barrel: exporta `CaptchaSolverService` e tipos |
| `src/main/services/captcha/solver-service.ts` | Substitui `geetest-solver.ts`. In-process. Mesma interface que o runtime consome (`solve(captchaId, riskType, baseUrl, proxy?, maxRetries?)`) |
| `src/main/services/captcha/geetest-client.ts` | Porte de `geeked.py`: `load()`/`verify()` via `APIRequestContext` do patchright (JA3 Chrome) |
| `src/main/services/captcha/signer.ts` | Porte de `sign.py`: AES-CBC, RSA-PKCS1v1.5, PoW (md5/sha1/sha256), lot-parser, `generateW()`. Usa `node:crypto` |
| `src/main/services/captcha/deobfuscate.ts` | Porte direto de `deobfuscate.py`: baixa `gcaptcha4.js`, desembaralha (XOR), extrai `abo`/`mappings`/`device_id`. Roda como script (`npm run captcha:refresh-constants`) |
| `src/main/services/captcha/constants.ts` | Constantes rotativas consumidas pelo `signer.ts`; produzidas pelo `deobfuscate.ts`. (Hoje hardcoded em `sign.py`) |
| `src/main/services/captcha/onnx-session.ts` | Envolve `onnxruntime-node`; carrega `geetest_v4_icon.onnx` 1× (lazy, mantém quente); expõe `classify(imgRgb): {label, score}` |
| `src/main/services/captcha/image-utils.ts` | Helpers `opencv-wasm`: `decode`, `canny`, `matchTemplate`, `threshold`, `connectedComponents`, conversões de cor |
| `src/main/services/captcha/solvers/slide.ts` | Porte de `slide.py`: Canny + `matchTemplate` (edge + grayscale), melhor score. Sem ML |
| `src/main/services/captcha/solvers/gobang.ts` | Porte de `gobang.py`: 4-em-linha em linhas/colunas/diagonais. Lógica pura |
| `src/main/services/captcha/solvers/nine.ts` | Classifica ícone-pergunta + 9 células via `onnx-session`; seleciona as `nine_nums` células de **label igual** ao da pergunta. Sem CLIP |
| `src/main/services/captcha/solvers/icon.ts` | Detecta bboxes (threshold + componentes conexas via `image-utils`) + classifica cada recorte e ícone-pergunta via `onnx-session` + casa por label (atribuição por score de classe). Sem CLIP/ddddocr |
| `src/main/services/captcha/solvers/index.ts` | Mapa `risk_type → solver` (`slide`, `gobang`/`winlinze`, `ai`/`invisible` = no-op, `icon`, `nine`) |

**Modelos (movidos de `GeekedTest-main/geeked/models/` para `assets/captcha/`):**
- `assets/captcha/geetest_v4_icon.onnx` (2,4 MB — classificador de 40 classes)
- `assets/captcha/charsets.json` (536 B — labels das classes)

**Arquivos a remover:**
- `GeekedTest-main/` (projeto Python inteiro)
- `scripts/geetest_solver_bridge.py`, `scripts/geetest_solver_worker.py`
- `scripts/setup-python.mjs` e `scripts/clip-burn.py`
- `src/main/services/geetest-solver.ts` (substituído por `captcha/solver-service.ts`)

**Arquivos a modificar:**
- `src/main/services/automation-runtime.ts` — trocar import `./geetest-solver.js` → `./captcha/index.js`;
  substituir `new GeetestSolverService()` pelo novo serviço. (A interface `solve()` é mantida.)
- `package.json` — remover `setup-python.mjs` do `postinstall` (manter `patch-package && npm run napi:build …`);
  remover `setup:python`; adicionar `captcha:refresh-constants` script; remover `extraResources` do
  `GeekedTest-main` e dos `.py` (encolhe o installer); adicionar deps `onnxruntime-node` + `opencv-wasm` em
  `dependencies`; atualizar `dev:electron` `wait-on` de `dist-electron/main/services/geetest-solver.js` para
  `dist-electron/main/services/captcha/solver-service.js` (senão o Electron nunca inicia — ver AGENTS.md).
- `tsconfig.electron.json` — garantir que `src/main/services/captcha/**/*.ts` esteja no `include` (herda de base).

**Testes (flat em `test/`, padrão `tsx --test test/*.test.ts`):**
- `test/captcha-signer.test.ts` — vetores conhecidos (AES/RSA/PoW) comparados com a saída do `sign.py` atual.
- `test/captcha-deobfuscate.test.ts` — compara `abo`/`mappings`/`device_id` produzidos pelo `.ts` vs `.py`.
- `test/captcha-slide.test.ts` — imagens-fixas de `GeekedTest-main/assets/` → posição esperada conhecida.
- `test/captcha-gobang.test.ts` — tabuleiros de exemplo → jogada esperada.
- `test/captcha-nine.test.ts` e `test/captcha-icon.test.ts` — casos do dataset do spike → labels esperados.
- `test/captcha-onnx.test.ts` — carrega o ONNX, classifica 1 ícone, verifica label no charset.

---

## 6. Dependências

| Adicionar (`dependencies`) | Tamanho aprox. | Por quê |
|---|---|---|
| `onnxruntime-node` | ~15–25 MB (binários pré-compilados) | Roda o `geetest_v4_icon.onnx` in-process, sem Python |
| `opencv-wasm` | ~8 MB (WASM puro) | `matchTemplate`/`Canny`/`threshold`/`connectedComponents` para `slide` e `icon` |

| Remover | Tamanho aprox. |
|---|---|
| `torch` + `open_clip` (CLIP ViT-B-32) | ~350 MB |
| `ddddocr` (+ ONNX de detecção) | ~40 MB |
| `opencv-python`, `numpy`, `pycryptodome`, `curl_cffi` | ~80 MB |
| Runtime Python + `setup-python.mjs` (postinstall frágil) | — |

**Líquido: ≈ −470 MB, +30 MB** no installer. As `.node` do `onnxruntime-node` já caem em `asarUnpack: "**/*.node"`
(`package.json:65`) e em `signExts` (`.node`/`.dll`, `package.json:73`), então code-signing e unpack estão cobertos.

---

## 7. Integração com o runtime

O runtime hoje chama (em `automation-runtime.ts:6174`):

```ts
const solution = await solver.solve(captchaId, captured?.riskType || null, captured?.baseUrl, undefined, 1);
```

O novo `CaptchaSolverService.solve()` mantém esta assinatura e o tipo de retorno (`GeetestSolution`). A mudança no
runtime é **só o import** e a classe instanciada — o resto (captura de `captcha_id`/`risk_type` da rede, injeção
do seccode via `resolveGeetestWithPageBridge`/`interactWithGeetestWidget`) fica intacto.

Detalhe de empacotamento: `build.extraResources` hoje copia `GeekedTest-main/` e os `.py`. Removendo-os, o
installer encolhe. O ONNX vai em `assets/captcha/` (já coberto por `build.files: "assets/**"`).

---

## 8. Spike e gates de go/no-go

A issue #3 exige **"Decisão de arquitetura registrada (qual engine e por quê) após o spike"**. O spike valida os
pontos de risco antes de comprometer a direção. Cada gate tem um critério objetivo e um plano de contingência.

### Gate 1 — TLS/JA3 (semana 1, crítico)
- **O quê:** portar só `geetest-client.ts` + `signer.ts` (PoW/assinatura) e fazer 1 `load` + 1 `verify`
  end-to-end contra o demo `gt4.geetest.com/demov4` via `APIRequestContext` do patchright.
- **Critério de GO:** GeeTest retorna `result=success` num `slide` (tipo mais simples, sem visão).
- **NO-GO:** rejeição sistemática por fingerprint → cai no **Plano B** (sidecar Python embarcado leve). Os solvers
  de visão e o `signer` são reaproveitados; só o transporte HTTP muda.

### Gate 2 — classificador de ícones existente
- **O quê:** plugar o `geetest_v4_icon.onnx` (2,4 MB) via `onnxruntime-node`; classificar os ícones do dataset do
  spike; medir acerto de classificação.
- **Critério de GO:** ≥90% de acerto de label.
- **NO-GO:** treinar a mini-CNN (seção 4, decisão 3) no dataset coletado → ONNX ~1–2 MB.

### Gate 3 — detecção de bboxes do `icon`
- **O quê:** threshold + componentes conexas (`opencv-wasm`) sobre a imagem do desafio `icon`; comparar bboxes com
  o ground-truth do dataset.
- **Critério de GO:** IoU médio ≥0,8 ou end-to-end `verify` de `icon` ≥90%.
- **NO-GO:** adicionar um ONNX de detecção pequeno (porte do det do ddddocr ou modelo leve treinado).

### Dataset do spike
Extende o padrão já provado em `GeekedTest-main/demo_nine.py` (Playwright capturando `captcha_id`, `grid_url`,
`ques_paths` da rede do demo) para `slide`/`icon`/`nine`. Coleta N desafios por tipo com imagens + metadados +
resultado do `verify` (ground-truth end-to-end). Serve para avaliar o modelo existente **e** treinar a mini-CNN.

### Metas de acerto end-to-end (pós-spike)
- `slide` ≥95% · `nine` ≥95% (hoje ~95% com CLIP) · `icon` ≥90% (hoje ~85%) · `gobang`/`ai` ≈100%.

---

## 9. ADR

Após o spike confirmar GO em todos os gates, registrar **`docs/adr/0003-solver-de-captcha-em-ts.md`** no formato
do repo (Contexto → Problema → Decisão → Consequências → Verificação, ver `docs/adr/README.md`), referenciando
esta spec e a issue #3. Atualizar o índice em `docs/adr/README.md`. Se o Gate 1 falhar e for para o Plano B, o ADR
documenta a escolha do sidecar embarcado e **por que** o 100% TS foi descartado.

---

## 10. Critérios de aceite (mapeados à issue #3)

- [ ] Decisão de arquitetura registrada em ADR `0003` após o spike (qual engine e por quê).
- [ ] Solver resolve os captchas das plataformas com taxa de sucesso alta e estável (metas da seção 8).
- [ ] Integrado ao fluxo sem travar a automação quando o captcha aparece (interface `solve()` preservada; runtime
      só troca o import).
- [ ] Tempo de resolução aceitável mesmo com várias janelas abertas (sem CLIP monopolizando CPU → alivia #8).
- [ ] Python/torch/CLIP/ddddocr removidos; `postinstall` sem `setup-python.mjs`; installer encolhido.
- [ ] `npm run check` (typecheck) limpo; `npm test` verde; `dev:electron` `wait-on` atualizado.

---

## 11. Riscos e mitigações

| Risco | Mitigação |
|---|---|
| JA3 do Node rejeitado pelo GeeTest | Gate 1 na semana 1; Plano B (sidecar embarcado) sem desperdício |
| Porte do `signer` com bug sutil (AES/RSA/PoW) | Vetores de teste comparados com a saída do `sign.py` atual |
| Regex do `deobfuscate.py` diverge em TS | Comparação de saída `.ts` vs `.py` (devem ser idênticas) |
| Rotação das constantes pelo GeeTest | `npm run captcha:refresh-constants` roda `deobfuscate.ts` (mesmo fluxo de hoje) |
| `geetest_v4_icon.onnx` impreciso | Gate 2 → mini-CNN treinada no dataset do spike |
| Detecção de bboxes do `icon` em fundos de baixo contraste | Gate 3 → fallback p/ ONNX de detecção pequeno |
| `onnxruntime-node` em code-signing/release | `.node` já coberto por `asarUnpack` + `signExts`; validar no `dist:win` |

---

## 12. Versionamento

- Branch: `feat/solver-captcha-ts` (criado a partir de `main`).
- Commits em padrão conventional (`feat(captcha): …`, `test(captcha): …`, `chore(captcha): …`), atômicos e
  frequentes (TDD: vermelho→verde→commit).
- A issue #3 é atualizada com: link desta spec, status do spike, e o ADR assim que registrado.
- Após aprovada, o plano de implementação (writing-plans) quebra o trabalho em tasks TDD bite-sized.
