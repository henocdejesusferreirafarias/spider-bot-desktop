# Architecture Decision Records (ADR)

Registro cronológico de decisões técnicas relevantes deste repositório (desktop client).
Cada ADR captura **contexto → causa-raiz → decisão → consequências → verificação**, para que
qualquer dev ou agente entenda *por que* o código está do jeito que está sem reabrir a investigação.

Convenção:
- Um arquivo por decisão: `NNNN-titulo-curto.md` (numeração sequencial, nunca reutilizada).
- Status: `Aceito` | `Substituído por NNNN` | `Descontinuado`.
- ADR é imutável depois de aceito; para mudar de rumo, escreva um novo que substitui o anterior.

## Índice

| # | Título | Status |
|---|--------|--------|
| [0001](0001-kill-escopado-de-processo-do-navegador.md) | Kill escopado por `user-data-dir` ao invés de `taskkill /IM` global | Aceito |
| [0002](0002-remover-deposito-por-navegacao-morto.md) | Depósito do bot é sempre por injeção de estado; remoção do fluxo por navegação | Aceito |
| [0003](0003-wg-speed-time-cocos-director.md) | Speed Time WG pelo Director do Cocos | Aceito |
| [0004](0004-pg-speed-loading-gate.md) | Gate reversível de loading para o Speed Time PG | Aceito |
| [0005](0005-jdb-speed-time-early-wrappers.md) | Speed Time JDB com wrappers antecipados | Aceito |
| [0006](0006-pp-uht-delta-time.md) | Speed Time PP pelo delta UHT | Aceito |
| [0007](0007-jdb-frame-token-reload.md) | Frames JDB tokenizados não aceitam recuperação por reload | Aceito |
