from geeked import Geeked

# --- Edite aqui ---
CAPTCHA_ID = "54088bb07d2df3c46b79f80300b0abbe"
BASE_URL = "https://gcaptcha4.geetest.com/"
RISK_TYPE = "slide"   # nine=~95% | None=auto | icon=~85% (com retry)

# --- Nao mexer ---
geeked = Geeked(CAPTCHA_ID, RISK_TYPE, base_url=BASE_URL)
seccode = geeked.solve(max_retries=10)
print(seccode)