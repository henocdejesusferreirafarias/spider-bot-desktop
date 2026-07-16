# Confirmacao segura da senha de saque

## Contexto

O fluxo de entrada PIX ja chega a tela de definicao de senha de saque, reserva
uma senha de seis digitos por perfil, preenche e confirma visualmente os dois
PINs. Esta etapa completa somente o cadastro da senha: nao abre, preenche ou
envia o cadastro de uma chave PIX.

## Objetivo

Depois dos dois PINs confirmados, acionar uma unica vez a confirmacao da tela e
aceitar sucesso somente quando a plataforma exibir uma superficie real de
saque. A automacao deve funcionar por capacidade da pagina, sem host, marca,
cor, coordenada ou rota fixa.

## Pre-condicoes

Antes de qualquer confirmacao, a rotina exige:

1. dois `ui-password-input` visiveis, cada um com seis celulas preenchidas;
2. a superficie de definicao de senha ainda presente;
3. um unico controle de confirmacao visivel e pertencente ao contexto ativo da
   definicao de senha.

Texto e atributos acessiveis do controle sao normalizados e comparados a uma
pequena vocabulario semantico (`confirmar`/`confirm`). Se houver ausencia ou
ambiguidade, a rotina falha sem disparar evento algum.

## Acionamento

A rotina procura primeiro o listener Vue vivo do controle de confirmacao e o
invoca uma unica vez. Quando a skin nao expuser o listener, ela envia um evento
de clique ao unico controle validado. Nao ha retry de submissao, `requestSubmit`
generico, clique por coordenada nem escolha arbitraria entre botoes.

O botao fica restrito a tela que contem os dois PINs; um `Confirmar` de modal,
PIX ou saque fora dela nao e elegivel.

## Confirmacao positiva

Depois do acionamento, o fluxo usa polling condicional da classificacao de
destino ja compartilhada:

- `needs_withdrawal_password` enquanto a superficie de definicao permanecer;
- `withdrawal_ready` somente se aparecer a superficie de conta/solicitacao de
  saque; rota de saque e apenas corroboracao, nunca prova isolada;
- `unknown` enquanto a pagina transiciona.

Sucesso exige `withdrawal_ready`. Um modal que simplesmente some, uma URL que
muda, ou a ausencia de erro nao sao sucesso.

## Falhas e isolamento

Uma resposta de erro visivel, setup que continua aberto, destino desconhecido
ao esgotar o teto, pagina fechada ou cancelamento produz falha na etapa
`withdrawal-password-confirmation`. Nenhuma dessas falhas tenta enviar o botao
novamente ou continua para o cadastro PIX.

Os dados e checkpoints continuam por `AutomationRun` e perfil. Nenhum log,
metrica, erro ou diagnostico inclui a senha. A execucao conserva o limite atual
de duas janelas simultaneas; cada janela mantem sessao, timeout e resultado
independentes.

## Checkpoints e resultado

Somente apos a superficie de saque ser confirmada, o run recebe
`pixWithdrawalPasswordStage: confirmed` e o resultado passa para
`withdrawal_ready`. Ate esse ponto, `second-field-filled` significa apenas que
os PINs foram preenchidos, nao que a plataforma aceitou a senha.

## Verificacao

- teste: controle de confirmacao ausente ou ambiguo nao e acionado;
- teste: clique unico com destino `withdrawal_ready` retorna sucesso e grava o
  checkpoint `confirmed`;
- teste: setup ainda presente ou destino desconhecido falha sem segundo clique;
- teste manual: conta descartavel sai da tela de definicao para a tela de saque,
  sem abrir o cadastro PIX;
- `npm test` e `npm run check` passam.
