# ADR 0003: Solver GeeTest automatico apenas para nine

## Contexto

As plataformas podem entregar `icon` ou `nine` para o mesmo captcha ID. O
modelo pareado `nine_match.onnx` atingiu 0,92 de acuracia held-out por desafio,
enquanto os caminhos icon, matching perceptual e slide nao fazem parte da
estrategia automatica de producao.

## Causa raiz

Manter varios solvers aumentava tempo de instalacao, superficie de manutencao e
ambiguidade operacional. Novas chamadas `/load?risk_type=nine` normalmente
rerrolam um desafio nao-nine para nine.

## Decisao

O Captcha Killer busca no maximo 10 desafios por rodada, responde no maximo 5
desafios nine rejeitados e respeita prazo total de 60 segundos. Tipos nao-nine
nao sao resolvidos; eles consomem uma busca. Ao esgotar limites, o fluxo passa
para resolucao manual. O ONNX aprovado e seus metadados sao assets versionados;
o dataset de origem permanece local.

## Verificacao

- teste de selecao cobre respostas `icon` antes de `nine`;
- teste real do ONNX cobre nomes e lote do tensor;
- o modelo aceito tem SHA-256
  `36EF9B73964D36A0F43ECA5366F83EFA3224ECA2CD7A7F20CC2C0DC11F05622A`;
- `npm run check` e `npm test` devem passar;
- o pacote inclui `assets/captcha/nine_match.onnx` e nao inclui dataset.
