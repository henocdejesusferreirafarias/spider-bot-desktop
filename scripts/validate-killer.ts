// Validacao do popup killer NODE-DRIVEN (buildPopupSweepScript) -- o mecanismo real.
// Modelo conservador: mata SO nuisance comprovado (classe/texto); preserva
// formularios (login/registro/deposito), QR/PIX e dialogs desconhecidos.
// Uso: npx tsx scripts/validate-killer.ts
import { chromium } from "patchright";
import { buildPopupSweepScript } from "../../api/src/payloads/popup-killer-script.js";

const SWEEP = buildPopupSweepScript();

function ok(cond: boolean, label: string) {
  console.log((cond ? "PASS " : "FAIL ") + label);
  return cond;
}

// Cada fixture e um .ui-overlay (id) cobrindo a tela, com um dialog interno.
const FIXTURES = `(function(){
  var mk = function(id, innerCls, inner){
    var ov = document.createElement('div');
    ov.id = id;
    ov.className = 'ui-overlay';
    ov.style.cssText = 'position:fixed;inset:0;z-index:5000;background:rgba(0,0,0,.5);';
    ov.innerHTML = "<div class='ui-popup ui-popup--center " + innerCls + "' style='width:320px;height:320px;'>" + inner + "</div>";
    document.body.appendChild(ov);
  };
  // red-pocket com <canvas> de animacao: NAO pode ser confundido com tela de QR.
  mk('f_redpocket', '_red-pocket-mask_1vwl3_56', "<canvas width='200' height='200'></canvas>Chuva de pacotes vermelhos ABRIR");
  mk('f_share', '_modal_16vy5_52 _hasBtn_16vy5_80', 'Telegram WhatsApp - Registe-se e indique um amigo');
  mk('f_download', '_top-download_x73qw_52', 'Baixar o app agora');
  mk('f_form', '_someSkin_ab12c_52', "<input type='text' placeholder='Conta' style='width:200px;height:30px;display:block'><input type='password' placeholder='Senha' style='width:200px;height:30px;display:block'>");
  mk('f_qr', '_payResult_ab12c_52', "<canvas width='160' height='160'></canvas><div>Chave PIX copia e cola</div>");
  mk('f_unknown', '_welcomeThing_ab12c_52', 'Bem-vindo de volta ao lobby');
  mk('f_captcha', 'geetest_panel', 'Deslize para verificar');
  // Senha de saque (PIN): 6 caixas <div> NAO-editaveis + input de senha OCULTO ->
  // hasFormInput falha; so o guard isCredential preserva. Espelha o bug do PIX.
  mk('f_pin', '_withdrawPinDialog_ab12c_52', "<div>Inserir PIN</div><div>Senha de Saque</div><input type='password' style='width:0;height:0;border:0'><div style='display:flex'><div style='width:40px;height:40px'></div><div style='width:40px;height:40px'></div><div style='width:40px;height:40px'></div><div style='width:40px;height:40px'></div><div style='width:40px;height:40px'></div><div style='width:40px;height:40px'></div></div>");
  // FIEL ao DOM real do gamecancer.com (capturado via browser-mcp): dialog
  // _withdrawalPassword_, SEM nenhum <input> -- as caixas sao <li.ui-password-input__item>
  // alimentadas por teclado numerico custom. O guard ANTIGO matava isto (bug do PIX).
  mk('f_pin_w1', 'ui-dialog _withdrawalPassword_te4t4_52', "<div class='ui-dialog__header'><span>Inserir senha</span></div><form novalidate><section class='lobby-form-item lobby-form-item--password' data-item-name='password'><div class='_label_2vs7s_55'><span>Senha de Saque</span></div><div class='ui-password-input'><ul class='ui-password-input__security'><li class='ui-password-input__item' style='width:48px;height:56px;display:inline-block'></li><li class='ui-password-input__item' style='width:48px;height:56px;display:inline-block'></li><li class='ui-password-input__item' style='width:48px;height:56px;display:inline-block'></li><li class='ui-password-input__item' style='width:48px;height:56px;display:inline-block'></li><li class='ui-password-input__item' style='width:48px;height:56px;display:inline-block'></li><li class='ui-password-input__item' style='width:48px;height:56px;display:inline-block'></li></ul></div></section><div>Para a seguranca da sua conta, introduza a senha para saque</div><button type='submit'>Proximo</button></form>");
})()`;

// Cenario VANT isolado (467win.top, dentro de iframe): backdrop .van-overlay e IRMAO
// do popup. Matar o popup deixa o overlay (blur) orfao cobrindo a tela.
const VANT_NAG = `(function(){
  document.body.innerHTML='';
  var ov = document.createElement('div');
  ov.id='v_back'; ov.className='van-overlay mask-bg';
  ov.style.cssText='position:fixed;inset:0;z-index:2000;backdrop-filter:blur(10px);background:rgba(0,0,0,.3);';
  document.body.appendChild(ov);
  var pop = document.createElement('div');
  pop.id='v_pop'; pop.className='van-popup van-popup--center';
  pop.style.cssText='position:fixed;left:60px;top:200px;width:300px;height:300px;z-index:2001;';
  pop.textContent='Chuva de pacotes vermelhos';
  document.body.appendChild(pop);
})()`;

// Cenario HONGBAO (467win.top): popup de envelopes vermelhos com classes custom
// (hongbao/hongbaoyu/red-envelope) dentro de um container .BOX (fixed, z:9999999,
// background transparente mas pointer-events:auto). killRoot deve subir ate .BOX.
const HONGBAO = `(function(){
  document.body.innerHTML='';
  var box = document.createElement('div');
  box.id='hb_box'; box.className='BOX';
  box.style.cssText='position:fixed;inset:0;z-index:9999999;background:rgba(0,0,0,0);pointer-events:auto;';
  var hb = document.createElement('div');
  hb.id='hb_popup'; hb.className='hongbao';
  hb.style.cssText='position:absolute;width:300px;height:400px;';
  hb.innerHTML="<img src=''><div class='btnBox'><div class='btn'>ABRIR</div></div><img class='hongbaox' src=''>";
  box.appendChild(hb);
  var rain = document.createElement('div');
  rain.id='hb_rain'; rain.className='hongbaoyu';
  rain.style.cssText='position:fixed;inset:0;z-index:9999998;';
  for(var i=0;i<5;i++){var e=document.createElement('div');e.className='red-envelope hongbaopiao';e.innerHTML="<img class='hongbaoimg' src=''>";rain.appendChild(e);}
  box.appendChild(rain);
  document.body.appendChild(box);
})()`;

const VANT_FORM = `(function(){
  document.body.innerHTML='';
  var ov = document.createElement('div');
  ov.id='vf_back'; ov.className='van-overlay mask-bg';
  ov.style.cssText='position:fixed;inset:0;z-index:2000;backdrop-filter:blur(10px);background:rgba(0,0,0,.3);';
  document.body.appendChild(ov);
  var pop = document.createElement('div');
  pop.id='vf_pop'; pop.className='van-popup van-popup--center';
  pop.style.cssText='position:fixed;left:60px;top:200px;width:300px;height:300px;z-index:2001;';
  pop.innerHTML="<input type='text' placeholder='Conta' style='width:200px;height:30px;display:block'>";
  document.body.appendChild(pop);
})()`;

async function run() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 }, locale: "pt-BR" });
  const page = await ctx.newPage();
  await page.goto("about:blank");
  await page.evaluate(`document.body.innerHTML='';`);
  await page.evaluate(FIXTURES);
  await page.waitForTimeout(100);

  // Sweep 1: mata nuisances conhecidos na hora; marca desconhecido como "visto".
  const r1 = await page.evaluate(SWEEP);
  await page.waitForTimeout(50);
  // Sweep 2: a camada generica mata o desconhecido (2a passada, anti-race).
  const r2 = await page.evaluate(SWEEP);
  await page.waitForTimeout(50);

  const present = (id: string) => page.evaluate(`!!document.getElementById(${JSON.stringify(id)})`) as Promise<boolean>;
  let pass = true;
  // devem MORRER
  pass = ok(!(await present("f_redpocket")), "red-pocket com canvas (classe) morto") && pass;
  pass = ok(!(await present("f_share")), "share/indique-um-amigo (texto) morto") && pass;
  pass = ok(!(await present("f_download")), "download app (classe) morto") && pass;
  pass = ok(!(await present("f_unknown")), "popup DESCONHECIDO morto na 2a passada (camada generica)") && pass;
  // devem SOBREVIVER (guardas)
  pass = ok(await present("f_form"), "dialog com formulario (login/registro) preservado") && pass;
  pass = ok(await present("f_qr"), "tela de QR/PIX preservada (popup do pagamento)") && pass;
  pass = ok(await present("f_captcha"), "captcha preservado") && pass;
  pass = ok(await present("f_pin"), "senha de saque / PIN preservada (guard de credencial)") && pass;
  pass = ok(await present("f_pin_w1"), "senha de saque W1 REAL (sem input, li.ui-password-input) preservada") && pass;

  console.log("\nsweep1 removeu:", r1, "| sweep2 removeu:", r2, "(esperado 3 e 1)");

  // --- Cenario VANT nag: popup + backdrop blur (irmaos) devem AMBOS sumir ---
  await page.evaluate(VANT_NAG);
  await page.waitForTimeout(60);
  await page.evaluate(SWEEP); await page.waitForTimeout(60);
  await page.evaluate(SWEEP); await page.waitForTimeout(60);
  pass = ok(!(await present("v_pop")), "[Vant] popup nag morto") && pass;
  pass = ok(!(await present("v_back")), "[Vant] backdrop blur orfao removido (fix 467win.top)") && pass;

  // --- Cenario HONGBAO: popup + rain + container .BOX devem TODOS sumir ---
  await page.evaluate(HONGBAO);
  await page.waitForTimeout(60);
  await page.evaluate(SWEEP); await page.waitForTimeout(60);
  pass = ok(!(await present("hb_popup")), "[Hongbao] popup envelope morto") && pass;
  pass = ok(!(await present("hb_rain")), "[Hongbao] rain container morto") && pass;
  pass = ok(!(await present("hb_box")), "[Hongbao] .BOX container (killRoot) removido") && pass;

  // --- Cenario VANT form: popup com input E seu backdrop devem SOBREVIVER ---
  await page.evaluate(VANT_FORM);
  await page.waitForTimeout(60);
  await page.evaluate(SWEEP); await page.waitForTimeout(60);
  await page.evaluate(SWEEP); await page.waitForTimeout(60);
  pass = ok(await present("vf_pop"), "[Vant] popup com formulario preservado") && pass;
  pass = ok(await present("vf_back"), "[Vant] backdrop do form preservado (popup visivel)") && pass;

  console.log("\n" + (pass ? "=== TODOS OS TESTES PASSARAM ===" : "=== ALGUM TESTE FALHOU ==="));
  await browser.close();
  process.exit(pass ? 0 : 1);
}
run().catch((e) => { console.error("FATAL:", e); process.exit(1); });
