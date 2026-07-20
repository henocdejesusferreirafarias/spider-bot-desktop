# QA manual — Issue #28: layout consciente de DPI

## Ambiente

- Repositório: `spider-bot-desktop`
- Branch: `fix/issue-28-dpi-layout`
- Commit funcional testado: `dd6b937`
- Sistema: Windows
- Cenário: reprodução local da issue #28 no mesmo ambiente em que o problema havia sido observado

## Resultado informado pelo usuário

Em 20/07/2026, após executar a versão desta branch, o usuário confirmou que o
organizador passou a ajustar as janelas corretamente em todas as escalas disponíveis
no ambiente:

| Escala do Windows | Resultado visual informado |
|---:|---|
| 100% | Aprovado — ajustou corretamente |
| 125% | Aprovado — ajustou corretamente |
| 150% | Aprovado — ajustou corretamente |
| 175% | Aprovado — ajustou corretamente |

O usuário resumiu o resultado como “ajustou perfeitamente” e considerou que o
comportamento deve permanecer válido nas demais escalas pela mesma regra de
conversão.

## Evidência automatizada complementar

Os testes automatizados cobrem:

- conversão física em 100%, 125%, 150% e 200%;
- grades 4×1 e 5×2;
- monitor à direita, à esquerda e acima do principal;
- monitores com fatores de escala diferentes;
- preview convertido de volta para DIP;
- janela aberta usando a escala efetivamente lançada;
- confirmação de bounds por `Browser.getWindowBounds` com tolerância de dois pixels;
- rejeição de bounds divergentes ou ausentes.

Verificação final executada após a revisão inline:

| Comando | Resultado |
|---|---|
| `npx tsx --test test/window-layout.test.ts test/window-geometry.test.ts test/window-layout-runtime.test.ts` | 20 testes aprovados, 0 falhas |
| `npm run check` | Exit code 0 |
| `npm test` | 404 testes aprovados, 0 falhas |
| `npm run build` | Typecheck, renderer e main aprovados; exit code 0 |
| `git diff --check origin/main` | Sem erros de whitespace |

## Limitações da evidência manual

- O usuário não informou separadamente a grade usada em cada escala.
- Não foram fornecidos bounds numéricos do CDP nem novas capturas para arquivamento.
- Não foi informado teste manual em monitor secundário.
- 200% não estava disponível no ambiente; essa escala permanece coberta por teste automatizado.

Essas limitações estão declaradas para não transformar inferência em evidência. Elas
não invalidam a reprodução original nem a confirmação visual nas quatro escalas
disponíveis.

## Critérios de aceite

| Critério | Resultado |
|---|---|
| Ocupação correta da área útil em múltiplas escalas | Aprovado manualmente em 100%, 125%, 150% e 175% |
| Cenário reproduzido em 150% deixa de subaproveitar a tela | Aprovado manualmente |
| Aplicar sem aviso de ajuste futuro de escala | Coberto por teste de contrato e ausência da mensagem no código |
| Conversão consistente em 200% | Aprovado por teste automatizado; indisponível para QA manual |
| Múltiplos monitores e origens negativas | Aprovado por testes automatizados; não informado manualmente |
| Bounds divergentes não geram falso sucesso | Aprovado por integração CDP com sessão controlada |

## Conclusão

A correção resolve visualmente o defeito reproduzido e permanece consistente em
quatro escalas reais do Windows. Os cenários não disponíveis no hardware foram
cobertos por testes determinísticos e estão identificados acima como não validados
manualmente.
