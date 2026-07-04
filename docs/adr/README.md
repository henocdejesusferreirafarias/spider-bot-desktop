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
