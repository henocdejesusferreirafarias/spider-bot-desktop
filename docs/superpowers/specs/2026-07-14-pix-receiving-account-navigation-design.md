# Navegacao para contas de recebimento PIX

## Contexto

O fluxo de entrada PIX ja chega de forma confirmada a uma superficie real de
saque. A proxima fatia deve abrir a aba de contas de recebimento, onde existe a
opcao de adicionar uma chave PIX. Esta fatia nao abre o modal nem cadastra a
chave.

## Objetivo

Navegar da superficie de saque para a aba `active=10` usando o router Vue vivo
da propria pagina e concluir somente depois que a superficie de contas de
recebimento PIX estiver renderizada.

## Navegacao

A automacao reutiliza a rota de saque encontrada no router em execucao e envia
`active: "10"` na query. Ela nao monta URL, nao usa host, marca, cor ou
coordenadas, e nao clica em uma aba por texto.

## Confirmacao da superficie

O polling condicional considera a aba pronta apenas quando os tres sinais
abaixo coexistirem na pagina visivel:

1. a rota viva de saque informa `active=10` (corroboracao, nunca prova unica);
2. existe uma area semantica de conta para recebimento;
3. dentro dessa area existe a opcao PIX acompanhada de uma acao de adicionar.

Os textos sao normalizados (acentos, caixa e espacos) e tratados como
vocabulario semantico. O escopo da terceira verificacao e a area de recebimento,
para nao confundir PIX de banners, saldo ou outro modal.

## Espera e falhas

O polling usa teto de `PIX_MS(12000)`: doze segundos no padrao e de 12 a 72
segundos quando `SPIDERBOT_PIX_SLOWNESS` estiver configurado entre 1 e 6.
Durante a transicao, rota e superficie parciais permanecem pendentes. Ao
esgotar o teto, a etapa falha sem clicar em "Adicionar" e inclui no diagnostico
os sinais ausentes e o estado de rota observado.

## Isolamento e resultado

Cada janela continua independente, com o mesmo limite de concorrencia atual e
sem estado global de navegacao. Sucesso desta fatia e `pix_receiving_ready`; ela
apenas libera a proxima etapa para localizar e acionar o botao de adicionar
PIX.

## Verificacao

- teste: rota `active=10` sem superficie semantica nao e sucesso;
- teste: superficie semanticamente completa sem `active=10` nao e sucesso;
- teste: os tres sinais retornam `pix_receiving_ready`;
- teste: o waiter ignora estado parcial e retorna apenas quando a superficie
  completa aparece;
- teste manual: apos senha de saque existente ou recem-cadastrada, a janela
  para na aba de conta para recebimento com a opcao PIX visivel;
- `npm test` e `npm run check` passam.
