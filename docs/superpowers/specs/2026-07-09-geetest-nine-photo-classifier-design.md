# Classificador próprio de fotos para o `nine` (Plan 2c)

- **Status:** Proposta — pendente de validação pelo Gate 3 (go/no-go na seção 8)
- **Data:** 2026-07-09
- **Issue:** [#3 — Reescrever o solver de captcha (confiável e funcional)](https://github.com/henocdejesusferreirafarias/spider-bot-desktop/issues/3)
- **Spec pai:** [`2026-07-08-geetest-captcha-solver-ts.md`](./2026-07-08-geetest-captcha-solver-ts.md) (este plano substitui a abordagem `nine` do Gate 2, que foi NO-GO)
- **Branch:** `feat/solver-captcha-ts` (continua aberta; merge junto com Plan 2b + 3, conforme decisão do Plan 1)

---

## 1. Contexto

O spec pai (2026-07-08) planejava resolver `nine` plugando o `geetest_v4_icon.onnx` existente (2,4 MB, 40 classes) para
classificar a pergunta e as 9 células, casando por label. **O Gate 2 deu NO-GO: 0% (0/10)** no `nine` end-to-end.

Investigação pós-NO-GO revelou a causa estrutural:

- **O ícone-pergunta é uma silhueta preta sólida** (todos os pixels opacos = RGB 0,0,0). O `geetest_v4_icon.onnx`
  classifica essa silhueta **corretamente** (domínio limpo — e.g. `plane_d`), mas **falha nas células**, porque as
  células são **fotos reais** coloridas, e o modelo (treinado em ícones, argmax-only) não generaliza para esse domínio.
- **Spike da Solução B (matching perceptual/shape) — NO-GO**: `edge-energy` 16,7% (1/6), `dice-otsu` 0%,
  `random-control` 0%. A pergunta é silhueta; as células são fotos. A única coisa que distingue a célula-certa da
  errada é **"que objeto é"** (reconhecimento semântico) — pixel, forma e borda não enxergam isso. Solução B morta.
- **Hipótese do catálogo fixo — descartada**: analisadas 45 células dos 5 fixtures do dataset (990 pares pareados);
  distância mínima entre quaisquer duas = **131,6** (mediana 1009), **zero pares** abaixo de 40. As células são
  genuinamente todas diferentes — não há catálogo fixo pequeno pra matching por referência exata.

**Conclusão:** o `nine` exige um classificador que reconheça **objeto + direção (5×8 = 40 classes) na foto real**.
A pergunta→classe-alvo já está resolvida (silhueta via ONNX existente, provado). Falta só **foto→classe**. Este plano
treina esse classificador próprio, leve, reutilizando o ONNX da silhueta.

## 2. Objetivo

Um classificador leve `foto → 1 das 40 classes (objeto+direção)`, treinado sob medida, rodando in-process via
`onnxruntime-node` (sem Python no runtime). Combinado com o `IconClassifier` existente (silhueta→classe), resolve o
`nine` com **≥90% de acerto por tentativa** (com retry do GeeTest → taxa efetiva ~99%+). Modelo **o menor possível**
dentro da meta de precisão (~2-5 MB), leve em armazenamento e runtime.

## 3. Escopo

- **Dentro:** coletar dataset de fotos do `nine`, auto-rotular via CLIP (offline), revisar (humano), treinar
  MobileNetV3-Small, integrar como `solvers/nine-photo.ts`, medir via Gate 3.
- **Fora:** desafio `icon` (Plan 2b, separado) — embora o `PhotoClassifier` seja **reutilizável** para `icon`
  (mesmas 40 classes), isso é construído depois, não agora. Remoção total do Python (Plan 3) também é separada.
- **Python offline-only:** CLIP e PyTorch são **ferramentas de build**, não embarcadas. O app empacotado continua
  100% TS + `onnxruntime-node`.

## 4. Arquitetura

Dois modelos especializados, em estágios:

```
PERGUNTA (silhueta PNG) ──► IconClassifier (geetest_v4_icon.onnx, 2,4MB, já existe) ──► classe-alvo (ex: plane_d)
                                                                                              │
CÉLULAS (9 fotos JPEG) ──► PhotoClassifier (nine_photo.onnx, ~2-5MB, NOVO) ──► classe de cada ─┤
                                                                                              ▼
                                                          MATCH: células cuja classe == classe-alvo
                                                          (top nineNums por confiança do PhotoClassifier)
```

- **Estágio A — Silhueta→classe**: `IconClassifier` existente (`onnx-session.ts`), modelo `geetest_v4_icon.onnx`.
  Provado no Gate 2 (classificou `plane_d` com confiança). **Não mexe.**
- **Estágio B — Foto→classe**: modelinho **novo** `nine_photo.onnx` (MobileNetV3-Small, head 40 classes), input
  **64×64 RGB**. Classifica cada célula. **Treinado** sob medida no dataset rotulado.

Runtime: 100% TS + `onnxruntime-node`. CLIP/torch só offline.

## 5. Pipeline (uma vez, iterável)

```
1. COLETAR (TS, automatizado)        scripts/captcha-collect-nine-dataset.mjs
   load → fetch grid+ques → IconClassifier(ques)=classe-alvo → salva {grid.jpg, ques.png, targetClass, nineNums}
2. AUTO-ROTULAR (Python CLIP, offline)  scripts/captcha-autolabel-clip.py
   abre desafio → parte grid em 9 células → CLIP pontua cada vs silhueta → top-nineNums → rotula-as = targetClass
   → salva dataset/labeled/<class>/<cellid>.jpg (+ score de confiança do CLIP)
3. REVISAR (humano)                    scripts/captcha-review-gallery.mjs → review.html
   galeria ordenada por CONFIANÇA ASC do CLIP (mais arriscadas primeiro); usuário marca "errado" → move p/ dataset/flagged/ (excluído do treino)
4. TREINAR (Python/PyTorch, GPU local) scripts/captcha-train-photo.py
   MobileNetV3-Small, 40 classes, dataset revisado → exporta nine_photo.onnx + nine_classes.json
5. INTEGRAR (TS)                       src/main/services/captcha/solvers/nine-photo.ts
   solta ONNX em assets/captcha/ → rewire generateW nine → nine-photo.ts
6. MEDIR (TS)                          scripts/captcha-gate3-nine.mjs
   load → generateW → verify, N=15 → taxa real. ≥90% = GO; <90% = itera (seção 9)
```

## 6. Componentes (estrutura de arquivos)

| Arquivo (novo) | Linguagem | Responsabilidade |
|---|---|---|
| `scripts/captcha-collect-nine-dataset.mjs` | TS | Loop `load→fetch→IconClassifier(ques)→salva` em dataset/raw/`<id>/` (headless, ~2s/desafio) |
| `scripts/captcha-autolabel-clip.py` | Python | CLIP (open_clip ViT-B-32 do `GeekedTest-main/`) pontua 9 células vs silhueta → top-nineNums → dataset/labeled/`<class>/`+ score |
| `scripts/captcha-review-gallery.mjs` | TS | Gera `review.html`: células ordenadas por confiança CLIP asc, agrupadas por classe, com a silhueta ao lado; flags → dataset/flagged/ |
| `scripts/captcha-train-photo.py` | Python/PyTorch | Treina MobileNetV3-Small (GPU local) → exporta `nine_photo.onnx` (opset 17) + `nine_classes.json` |
| `src/main/services/captcha/solvers/nine-photo.ts` | TS | `findIconCellsPhoto(grid, ques, nineNums)`: alvo=IconClassifier(ques); célula=PhotoClassifier(cell); match por classe==alvo |
| `scripts/captcha-gate3-nine.mjs` | TS | Harness Gate 3 (sucessor do Gate 2, com solver novo) |

**Modificar:**
- `src/main/services/captcha/onnx-session.ts` — adiciona `PhotoClassifier` (carrega `nine_photo.onnx`, input 64×64
  RGB, `classify(rgba,w,h)→{label,score}`) ao lado do `IconClassifier` existente. Reusa o mesmo módulo `onnxruntime-node`.
- `src/main/services/captcha/signer.ts` — branch `nine` do `generateW`: troca `import('./solvers/nine.js')` por
  `import('./solvers/nine-photo.js')`.

**Modelos (em `assets/captcha/`):**
- `nine_photo.onnx` (~2-5 MB, NOVO — classificador de fotos, 40 classes, RGB 64×64)
- `nine_classes.json` (labels das 40 classes — idêntico ao `charsets.json` existente, replicado pra isolar o modelo novo)
- `geetest_v4_icon.onnx` (2,4 MB, existente — silhueta) e `charsets.json` (existentes, sem mudança)

**Tornar-se-á morto (limpeza no Plan 3):**
- `src/main/services/captcha/solvers/nine.ts` (solver ONNX-nas-células, quebrado no Gate 2)

## 7. Modelo e treino

- **Arquitetura:** MobileNetV3-Small (head 40 classes), input **64×64 RGB**. ~2,5 MB de pesos. **Backbone
  pré-treinado em ImageNet** (transfer learning, fine-tune no dataset GeeTest) — essencial pra convergir com
  ~6-8k imagens; from-scratch precisaria de muito mais dado.
- **Pré-processamento (idêntico treino + runtime):** resize 64×64 (bilinear) + **normalização ImageNet**
  (mean=[0.485,0.456,0.406], std=[0.229,0.224,0.225] sobre `px/255`). Travado assim (par canônico do backbone
  pré-treinado). Replicado fielmente em `PhotoClassifier` (TS) e no treino (PyTorch).
- **Loss:** cross-entropy 40 classes.
- **Augmentação — restrição crítica:** **PROIBIDO flip horizontal/vertical e rotação** (mudam a direção:
  `car_r`↔`car_l`, `car_ru`↔`car_rd`). Só augmentação **neutra à direção**: jitter de cor (brilho/contraste/
  saturação), leve escala/translação (preserva orientação).
- **Balanceamento de classes:** amostragem equilibrada (weighted sampler) — o GeeTest serve classes não-uniformemente;
  garantir ~150-200 fotos/classe.
- **Quantidade alvo:** ~150-200 fotos/classe × 40 = 6.000-8.000 células. A ~3 células úteis/desafio (as CLIP-matched)
  → ~2.000-2.700 desafios coletados. (~45-90 min de coleta, ~2s/desafio, unattended.)
- **Split:** 80/10/10 treino/val/teste, estratificado por classe.
- **Export:** `torch.onnx.export` opset 17, dynamic batch=1. **Validação de paridade:** mesma saída (argmax + top-5)
  em PyTorch vs ONNX em 50 amostras held-out (assert arrays equivalentes).
- **Métrica de aceite do treino:** ≥90% top-1 no split de teste held-out (offline) ANTES de ir pro Gate 3 vivo.

## 8. Gate 3 — medição real (go/no-go)

- **O quê:** `scripts/captcha-gate3-nine.mjs` roda N=15 desafios vivos: `load → generateW (com nine-photo) → verify`.
  Critério idêntico ao Gate 2 mas com o solver novo.
- **GO:** taxa ≥90% → `nine` resolvido; ADR 0003 atualizado; segue pra Plan 2b (`icon`).
- **NO-GO:** taxa <90% → **itera** (seção 9), não descarta a abordagem.

## 9. Iteração (se Gate 3 < 90%)

Escalar nesta ordem, medindo a cada passo:
1. **Mais dados + revisão:** coletar +2.000 desafios, revisar mais (sobretudo classes de baixa acurácia no held-out).
2. **Arquitetura maior:** MobileNetV3-Large ou EfficientNet-Lite0 (~5-7 MB) — troca só o modelo, pipeline igual.
3. **Augmentação/hiperparâmetros:** ajustar LR/epochs/regularização; considerar mixup/neutro-à-direção.
4. **(Re-rotular tudo):** depois que o dataset acumular as ~40 silhuetas-pergunta (uma por classe), relabelar as 9
   células/desafio contra todas as 40 silhuetas (não só as 3 matched contra a do desafio) — triplica o dataset
   sem nova coleta.

## 10. Decisões registradas (brainstorming 2026-07-09)

- **Rotulação:** híbrida (CLIP auto-rotula + revisão humana de amostra, sobretudo as de baixa confiança).
- **Meta de acerto:** começar em ~90% por tentativa + retry (taxa efetiva ~99%+); **escalável** — se não bastar,
  aumenta dados/arquitetura (não há lock-in; o modelinho é trocável e o dataset cresce).
- **Ambiente de treino:** GPU NVIDIA local (treino rápido, iteração livre).
- **Arquitetura:** Abordagem 1 (dois modelos especializados) sobre a 2 (unificada) e a 3 (embedding destilada) —
  risco mais baixo, reusa o ONNX provado da silhueta, tarefa do modelinho-foto é previsível (classificação 40 classes).

## 11. Riscos e mitigações

| Risco | Mitigação |
|---|---|
| Convenção de direção do GeeTest ambígua (o que é `car_ru` exato?) | Os rótulos vêm do CLIP (que já acerta ~95% no `nine`), então a convenção é aprendida por osmose, não precisa ser definida formalmente |
| Ruído de rótulo ~5% herdado do CLIP | Revisão híbrida focada nas baixas confianças; held-out mede o impacto real antes do Gate 3 |
| Desbalanceamento de classes na coleta | Sampler weighted no treino; held-out estratificado; coletar mais das classes raras |
| Augmentação que inverte direção | Restrição explícita: sem flip/rotação; só jitter de cor/escala/translação |
| Paridade PyTorch↔ONNX divergir | Teste de paridade em 50 amostras held-out antes de integrar |
| `nine_photo.onnx` pesado demais p/ distribuição | Começar em MobileNetV3-Small (~2,5MB); só escalar se <90%; quantização INT8 é fallback futuro |

## 12. Dependências

- **Runtime (embarcado, sem mudança nova):** `onnxruntime-node` (já no projeto desde Plan 2). Apenas novo arquivo
  `nine_photo.onnx` em `assets/captcha/` (coberto por `build.files: "assets/**"`).
- **Build/offline (não embarcadas):** `torch` + `open_clip` (CLIP, já no `GeekedTest-main/`) + `torchvision`
  (MobileNetV3) — usados só em `scripts/*.py`, nunca no `postinstall`/runtime. Podem virar um `requirements-ml.txt`
  separado do `GeekedTest-main/requirements.txt`.

## 13. Critérios de aceite

- [ ] Dataset coletado (~2.000+ desafios) e auto-rotulado (CLIP) cobrindo as 40 classes (~150+/classe).
- [ ] Revisão humana aplicada às células de baixa confiança; ruins movidas a `dataset/flagged/` (excluídas).
- [ ] `nine_photo.onnx` treinado, **≥90% top-1 no held-out offline** + paridade PyTorch↔ONNX validada.
- [ ] `nine-photo.ts` integrado; `generateW` nine branch rewireado; `nine.ts` morto (limpeza no Plan 3).
- [ ] **Gate 3 GO: ≥90% end-to-end vivo** (15 desafios) no demo `gt4.geetest.com`.
- [ ] `npm run check` limpo; testes do `nine-photo` (snapshot + paridade) verdes.
- [ ] ADR 0003 atualizado com a decisão do classificador próprio de fotos (Contexto→Problema→Decisão→Consequências→Verificação).

## 14. Versionamento

- Branch `feat/solver-captcha-ts` (continua). Commits conventional (`feat(captcha): …`, `chore(captcha): …`),
  atômicos. Pipeline ML em commits separados dos de integração TS.
- Issue #3 atualizada com o resultado do Gate 3 (GO/NO-GO) e o ADR.
- Após spec aprovada, o plano de implementação (writing-plans) quebra em tasks TDD bite-sized.
