# Contexto dinâmico do modal de senha de saque PIX

## Contexto

O fluxo PIX captura o contexto SPA no início da execução para navegar. Na tela
inicial, esse contexto pode ser um frame de jogo ou outro frame transitório.
Após navegar até a conta para recebimento, o modal “Inserir PIN” pode existir
no documento principal atual. Reutilizar o contexto inicial faz a rotina de
PIN procurar foco e teclado num documento obsoleto, apesar de o modal estar
visível e pronto na página.

## Objetivo

Resolver o contexto do modal imediatamente antes de preencher a senha de
saque. A seleção deve ser estrutural, independente de domínio, texto e rota,
e deve parar sem digitar quando não houver um alvo inequivocamente acionável.

## Seleção de contexto

No instante posterior à confirmação do prompt, a rotina avalia a página
principal e todos os frames vivos. Um contexto é elegível somente se contiver:

1. exatamente um `.ui-password-input` visível;
2. exatamente seis células `.ui-password-input__item` nesse grid;
3. nenhuma célula preenchida;
4. exatamente uma célula com `.ui-password-input__item--focus`;
5. ao menos uma raiz `.ui-number-keyboard` visível com teclas.

A rotina aceita somente um contexto elegível. Ela não escolhe pelo primeiro
frame, por host, por copy, por rota ou por ordem do DOM. Se não houver
candidato, aguarda condicionalmente uma janela curta; se houver mais de um,
aguarda a ambiguidade desaparecer. Ao expirar, falha sem tocar em qualquer
tecla e fornece apenas diagnósticos de contagens/contextos.

## Preenchimento e segurança

O PIN continua sendo lido exclusivamente do registro persistido do perfil. O
contexto resolvido é passado ao mecanismo existente de teclado virtual: cada
dígito é aceito apenas quando aumenta os dots de `n` para `n + 1`; se houver
mais de uma raiz de teclado, a raiz que produz o efeito é preferida nos
dígitos seguintes.

Esta alteração não gera, altera, registra em log ou confirma uma senha. Não
pressiona “Próximo”, não abre o formulário da chave PIX e não envia dados.

## Verificação

- contexto principal com modal elegível é selecionado, mesmo se o contexto de
  navegação capturado anteriormente era outro;
- modal elegível em frame vivo é selecionado;
- ausência e ambiguidade não produzem interação;
- o teste existente de PIN de um grid continua confirmando seis avanços;
- `npm test` e `npm run check` passam;
- no teste manual, as seis células mascaradas são preenchidas e o modal não
  avança.
