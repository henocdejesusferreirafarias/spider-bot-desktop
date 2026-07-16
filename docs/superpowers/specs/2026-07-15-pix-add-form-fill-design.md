# Preenchimento verificado do formulário de chave PIX PHONE

## Contexto

O fluxo novo já alcança o modal único “Adicionar PIX” após confirmar o PIN de
saque. Nas plataformas observadas, o formulário inicia em `CPF` e, ao escolher
`PHONE`, passa a ter três inputs visíveis, nesta ordem: nome real, chave PIX e
CPF. O campo de nome pode estar vazio e editável ou já preenchido e bloqueado.

## Objetivo

Preencher de forma verificável os dados de uma chave PIX `PHONE` no modal vivo.
Esta fatia não pressiona “Confirmar”, não envia o formulário, não consome a
chave reservada e não declara o cadastro PIX concluído.

## Dados e reserva

Antes de qualquer alteração visual, a rotina resolve os dados persistidos do
perfil: nome real, CPF e uma chave PHONE reservada para aquele perfil.

A chave é reutilizada quando já estiver reservada para o mesmo perfil; caso
contrário, a rotina reserva uma chave disponível de modo atômico. A reserva
persiste por interrupções e será consumida apenas por uma futura confirmação
real do cadastro. Falta de nome, CPF válido ou chave disponível falha antes de
alterar o modal.

## Modal e tipo PHONE

A rotina resolve novamente o único modal PIX visível na rota de saque
`active=10`, sem PIN-grid nem teclado numérico. Ela não conserva elementos de
leituras anteriores.

O seletor de tipo é resolvido dentro desse modal. Wrappers duplicados do mesmo
controle não contam como ambiguidade quando levam à mesma ação viva. A seleção
usa a ação semântica exposta pela SPA, com fallback DOM apenas quando a própria
ação viva não existir; não usa host, coordenadas, viewport ou posição global.

Após uma única seleção, a rotina espera até 12 segundos por todos os sinais:

- tipo exibido normalizado como `PHONE`;
- exatamente três inputs visíveis no modal;
- ausência de PIN-grid e de teclado virtual;
- modal ainda único e na rota `active=10`.

## Preenchimento e confirmação

Os papéis dos inputs são estruturais: nome é o campo anterior ao seletor; a
chave PHONE e o CPF são, respectivamente, o primeiro e o segundo campos
editáveis posteriores ao seletor. Placeholders são apenas reforço diagnóstico.

- Nome vazio e editável: preencher pelo modelo/evento vivo da SPA e reler a
  igualdade normalizada com o nome do perfil.
- Nome já preenchido e bloqueado: não escrever; comparar o valor normalizado
  com o nome do perfil.
- Nome já preenchido, mas divergente: falhar sem sobrescrever.
- Chave PHONE e CPF: preencher pelo modelo/evento vivo e confirmar a igualdade
  de dígitos, aceitando apenas máscara visual introduzida pela plataforma.

Cada alteração é seguida da própria confirmação. Valores de nome, CPF, telefone
e PIN nunca são incluídos nos diagnósticos ou logs.

## Resultado, falhas e isolamento

O sucesso é `pix_add_form_filled`: o modal permanece aberto com tipo PHONE e
os três valores confirmados. O botão “Confirmar” permanece sem interação.

Modal ambíguo, seleção não confirmada, campo não editável quando deveria ser,
valor divergente ou perda da superfície interrompem a janela sem envio. A chave
PHONE continua reservada para retomada segura. Cada janela resolve seu modal,
reserva e espera de forma independente.

## Verificação

- testes puros para papéis dos três campos e comparação normalizada;
- testes de reserva/reuso por perfil e ausência de chave sem interação visual;
- testes de nome vazio editável, nome bloqueado correspondente e divergente;
- testes de seleção PHONE e confirmação estrutural antes da escrita;
- teste de falha sem clique no envio;
- `npm test`, `npm run check` e teste manual com múltiplas plataformas.
