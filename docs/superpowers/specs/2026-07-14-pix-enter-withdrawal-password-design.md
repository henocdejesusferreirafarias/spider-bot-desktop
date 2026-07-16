# Preenchimento seguro da senha de saque para PIX

## Contexto

O fluxo chega ao prompt “Inserir PIN” após a ação PIX de adicionar. Esse prompt
usa um único PIN-grid e teclado virtual. A senha correta já foi cadastrada e
reservada para o perfil em etapa anterior; ela não pode ser recriada ou
substituída aqui.

## Objetivo

Preencher os seis dígitos da senha de saque existente no prompt e confirmar
visualmente o preenchimento completo. Esta fatia não aciona “Próximo”, não abre
o formulário de chave PIX e não envia dados.

## Senha e estado persistido

A rotina lê a senha persistida no perfil e exige exatamente seis dígitos. Não
chama método de geração/reserva nesta etapa. Uma senha ausente ou inválida
falha antes de qualquer interação, protegendo uma conta cujo PIN de plataforma
não esteja conhecido pelo bot.

## Teclado virtual e confirmação por efeito

O mecanismo do novo fluxo de cadastro de senha é generalizado para suportar
tanto dois PIN-grids quanto um. Para este prompt, exige:

1. exatamente um PIN-grid visível no modal;
2. seis células no grid;
3. zero células preenchidas antes da primeira tecla;
4. foco e teclado virtual disponíveis, tocando a primeira célula somente se
   necessário.

Para cada dígito, a rotina encontra as teclas correspondentes em todas as
raízes de teclado. Ela envia os eventos de toque e aceita somente a raiz cujo
efeito visual eleva a contagem de células preenchidas de `n` para `n + 1`.
A raiz que funcionou passa a ser preferida nos dígitos seguintes.

Ao final, sucesso exige seis de seis células preenchidas. O conteúdo mascarado
nunca é lido ou logado; a confirmação é a sequência conhecida de teclas e o
avanço visual unitário de cada célula.

## Falhas, idempotência e isolamento

Grid parcial, foco ausente, teclado ausente, dígito sem avanço confirmado,
modal fechado ou senha reservada ausente interrompem a etapa sem pressionar
“Próximo” e sem tentar substituir/apagar dígitos.

Cada janela opera com sua própria senha, prompt, timeout e resultado. Não há
estado global de teclado. Diagnósticos incluem somente contagens, índices e
causas técnicas, nunca senha ou dígitos.

## Resultado e verificação

Sucesso recebe `withdrawal_password_entered`; esse estado significa
exclusivamente “seis dígitos preenchidos”, não “senha aceita pela plataforma”.

- teste: uma senha persistida preenche um único grid e confirma seis avanços;
- teste: grid parcialmente preenchido falha sem nova tecla;
- teste: teclado oculto/visível concorrente é escolhido pelo efeito;
- teste: senha ausente falha antes de avaliar a página;
- teste manual: o prompt exibe seis células mascaradas e não avança após o
  preenchimento;
- `npm test` e `npm run check` passam.

