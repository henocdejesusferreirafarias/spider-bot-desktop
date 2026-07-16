# Tolerância à transição na confirmação do PIN PIX

## Problema

A confirmação do PIN é intermitente entre janelas. Em algumas delas o formulário
“Adicionar PIX” abre, mas o locator reporta erro durante a desmontagem do modal
e o runtime encerra como falha. Em outras, a tentativa ocorre antes de a ação
estar estável e o modal PIN permanece aberto.

Os diagnósticos `sourceModals=1 sourceActions=1` mostram que a origem já foi
resolvida de modo único; a falha está entre a tentativa de clique e a transição.

## Decisão

A confirmação será uma transação de uma tentativa:

1. aguardar uma origem única com PIN completo e ação elegível estável em duas
   inspeções consecutivas, separadas por 180 ms;
2. executar um único `locator.click()`, sem retry;
3. mesmo se esse locator rejeitar, aguardar condicionalmente até 12 segundos
   pelo formulário PIX;
4. declarar sucesso somente se o formulário PIX estrutural for confirmado;
5. declarar falha se o destino não surgir, registrando apenas o resultado
   estrutural e se houve rejeição do locator.

## Estabilidade da origem

Cada amostra exige um modal visível, um único grid de seis células completas e
uma única ação semântica habilitada. A segunda leitura precisa apontar para a
mesma raiz e o mesmo índice global de botão. Isso não usa host, texto do
usuário, coordenadas, viewport ou ordem de janelas.

Se a origem não ficar estável dentro de 4 segundos, não ocorre clique.

## Resultado da ação

`locator.click()` continua sendo a única interação real. Uma rejeição dele não
é tomada isoladamente como prova de que nada aconteceu, pois a transição pode
desanexar o elemento depois do dispatch. Ela é marcada como `clickRejected`
somente para diagnóstico seguro.

O destino continua sendo a autoridade: rota `active=10`, ausência de PIN e
teclado, e formulário PIX estrutural completo. Não existe segundo clique.

## Verificação

- teste de origem que só fica estável após duas amostras;
- teste de clique que dispara uma transição mas rejeita, ainda aceito se o
  destino ficar pronto;
- teste de clique rejeitado sem destino, que falha após a espera;
- `npm test` e `npm run check`;
- teste manual simultâneo em múltiplas plataformas.

