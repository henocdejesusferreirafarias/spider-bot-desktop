# ADR 0010: Geometria de janelas consciente de DPI

## Status

Aceito.

## Contexto

O Electron informa `Display.workArea` em DIP. Com Windows em 150%, uma tela física
1920x1080 aparece como aproximadamente 1280x720 DIP. O preview usava esses valores
corretamente em `BrowserWindow`, mas o Chromium recebia uma compensação apenas por
`force-device-scale-factor` e ocupava cerca de dois terços da tela física.

## Causa raiz

- slots lógicos em DIP eram tratados como pixels físicos na fronteira do Chromium;
- `Display.scaleFactor` era usado no fingerprint, mas não na geometria;
- a escala ideal e a escala efetivamente lançada compartilhavam o mesmo campo;
- preview, renderer e runtime mantinham fórmulas paralelas;
- `Browser.setWindowBounds` era aceito sem leitura posterior dos bounds.

## Decisão

A grade lógica permanece em DIP e vive em um módulo compartilhado. O processo
principal usa `screen.dipToScreenRect` para obter o retângulo físico do slot e a
origem física do monitor. A geometria enviada ao Chromium compensa a escala interna
somente depois dessa conversão. Como `force-device-scale-factor` também afeta as
coordenadas globais da janela, `x` e `y` completos são compensados; preservar a
origem e compensar apenas o deslocamento local move monitores secundários em
direção ao monitor principal.

A escala adaptativa usa o tamanho físico da célula. Cada handle guarda separadamente
o placement ideal e `launchedScale`. Janelas abertas usam sua escala lançada para
chegar ao novo retângulo físico, sem reinício nem aviso. Após aplicar, o runtime lê
`Browser.getWindowBounds` e aceita diferença máxima de dois pixels.

## Consequências

- 100%, 125%, 150% e 200% ocupam a mesma proporção física da área útil;
- preview, launch e apply compartilham a mesma grade lógica;
- grades densas preservam alertas de sobreposição e corte;
- monitores secundários preservam origens positivas ou negativas;
- mudar DPI exige uma nova ação de preview, launch ou apply, mas não reiniciar o app;
- falhas ou divergências de bounds não são reportadas como sucesso.

## Verificação

```powershell
npx tsx --test test/window-layout.test.ts test/window-geometry.test.ts test/window-layout-runtime.test.ts
npm run check
npm test
git diff --check
```

A QA manual compara preview, bounds CDP e ocupação física em 100%, 150% e uma
escala adicional entre 125% e 200%, incluindo janelas abertas antes da mudança de
DPI e perfis reabertos depois dela.
