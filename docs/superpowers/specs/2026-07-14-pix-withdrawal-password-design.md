# Senha de saque no fluxo de cadastro PIX

## Contexto

O fluxo de cadastro PIX ja navega de forma validada ate a gestao de saques e
classifica a tela resultante. Quando a conta ainda nao possui senha de saque, a
plataforma mostra dois campos de PIN de seis digitos e um teclado virtual. Esta
e a proxima etapa do mesmo fluxo PIX; nao e uma automacao separada.

## Objetivo deste corte

Preencher, de maneira programatica e verificavel, os dois campos de definicao
da senha de saque com a mesma senha de seis digitos. Este corte nao envia o
botao `Confirmar`; o envio e a confirmacao na plataforma serao validados no
corte seguinte.

## Senha como fonte de verdade

1. Antes de abrir ou usar o teclado virtual, obter a senha do perfil.
2. Se o perfil nao tiver senha valida, gerar seis digitos aleatorios e gravar
   sincronicamente no armazenamento seguro local.
3. A senha persistida e a unica senha permitida para aquele perfil: tentativas
   posteriores a reutilizam e nunca geram uma substituta automaticamente.
4. A senha nao pode constar em logs, metricas, erros, capturas ou resultados
   de IPC. Os checkpoints registram apenas estados booleanos/nominais.

Persistir antes da primeira interacao elimina o caso perigoso em que a
plataforma aceita a senha, mas o aplicativo e interrompido antes de associa-la
ao perfil.

## Operacao da interface

A implementacao deve exigir simultaneamente:

- a superficie de definicao de senha de saque;
- exatamente dois componentes visiveis `ui-password-input`, cada um com seis
  celulas;
- um teclado virtual visivel `ui-number-keyboard` com as teclas `0` a `9`;
- um controle `Confirmar` visivel, apenas como evidencia de que a tela esta
  completa. Ele nao sera acionado neste corte.

Cada campo sera selecionado pelo listener Vue vivo do componente. Cada digito
sera enviado pelo handler vivo do teclado virtual, com evento sintetico no
documento da plataforma; nao havera coordenadas de tela, clique fisico ou
escrita direta em um input inexistente. Depois de cada campo, o bot confirma
que as seis celulas exibem o estado preenchido antes de seguir para o proximo.

## Checkpoints e recuperacao

O `AutomationRun.metrics` recebe checkpoints sem segredo:

`withdrawalPasswordStage` em `reserved`, `first-field-filled`,
`second-field-filled`, `submitted` e `confirmed`.

Os checkpoints sao atualizados antes e depois de cada limite sensivel. Em
interrupcao, o mecanismo existente marca a execucao como interrompida, mas a
senha ja permanece cifrada no perfil.

Na proxima solicitacao PIX:

- se a superficie de definicao ainda aparecer, o bot reutiliza a senha
  persistida e reexecuta os dois campos, verificando o estado visivel;
- se a superficie de saque pronta aparecer, trata a senha como ja definida e
  continua o fluxo;
- se a plataforma pedir uma senha existente, usa a senha persistida;
- se a plataforma indicar senha existente sem que o perfil possua senha
  persistida, interrompe em erro critico. Nunca gera ou tenta uma nova senha.

## Falhas seguras

O corte falha sem clicar em `Confirmar` quando houver componente ausente,
quantidade inesperada de campos/celulas, teclado ou handler ambiguo, digito que
nao atualize a contagem visual, fechamento de pagina ou cancelamento. A falha
inclui a etapa e diagnostico sem segredo.

## Verificacao

- testes unitarios para descoberta e prioridade dos handlers e para os estados
  de checkpoint;
- `npm run check` e toda a suite de testes;
- teste manual em uma conta descartavel: chegada a `Senha de Saque`, dois
  campos preenchidos visualmente com seis posicoes e botao `Confirmar` ainda
  intacto;
- teste de recuperacao: fechar a janela entre os campos, reabrir e confirmar
  que a mesma senha e reutilizada, sem geracao adicional.
