# Diagnóstico de inicialização do Speed Time JDB

## Objetivo

Descobrir qual agendador o runtime proprietário JDB captura durante o boot, antes de tentar aplicar Speed Time. Os testes no Console após a carga não tiveram efeito porque `jdbsgv3way` já havia guardado referências aos relógios nativos.

## Escopo

- Instrumentação temporária e somente observacional no desktop.
- Ativação antes dos bundles JDB em novas abas e iframes.
- Reuso do binding local `__spiderInputDiagnostic` e do arquivo local `input-diagnostics.log`.
- Nenhuma alteração de velocidade, de relógio, de timer ou de tráfego de rede.

## Desenho

O init script do contexto instala wrappers pass-through para `requestAnimationFrame`, `setTimeout` e `setInterval`. Cada wrapper delega imediatamente à API nativa e guarda, em memória, uma amostra limitada dos primeiros agendamentos: API, atraso quando houver e assinatura curta do callback.

Como a identificação de JDB só fica disponível depois de os recursos começarem a carregar, o script mantém uma pequena janela de amostras por frame. Um `PerformanceObserver` identifica recursos com `jdbsgv3way` ou o caminho `/h5/games/`; o DOM também serve como fallback por `#jdbGameContainer`. Ao reconhecer JDB, o script emite um único evento `jdb-early-timing-diagnostic` pelo binding já existente e para de observar.

## Limites e segurança

- No máximo 16 amostras por API, com callback truncado em 240 caracteres.
- Sem stack traces, URLs com query string, dados de conta ou conteúdo de rede.
- Sem wrappers para `Date`: a análise estática já confirmou uso de `new Date().getTime()` e envolver o construtor global, mesmo passivamente, aumenta o risco de compatibilidade.
- O código temporário será removido depois de identificar o ponto de patch da JDB; registros antigos no log local não afetam o runtime.

## Critério de sucesso

Após abrir um jogo JDB novo, o log local contém exatamente um evento do frame JDB com as APIs usadas no boot e os callbacks amostrados. Esse resultado define se a estratégia final deverá capturar um agendador previamente cacheado ou reescrever um ponto específico do bundle.

## Verificação

- Teste automatizado garante que o script é serializado no init script e é pass-through.
- `npm test` e `npm run check` passam.
- Teste manual: abrir JDB em uma nova aba, confirmar o evento no log e confirmar que o jogo continua em velocidade normal.
