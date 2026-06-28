from uuid import uuid4
from curl_cffi import requests
import random, time, json
from geeked.sign import Signer


class Geeked:
    DEFAULT_USER_AGENT = (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    )

    def __init__(self, captcha_id: str, risk_type: str = None, **kwargs):
        self.pass_token = None
        self.lot_number = None
        self.captcha_id = captcha_id
        self.challenge = str(uuid4())
        self.risk_type = risk_type
        self.callback = Geeked.random()
        base_url = kwargs.pop("base_url", "https://gcaptcha4.geevisit.com")
        user_agent = kwargs.pop("user_agent", None) or self.DEFAULT_USER_AGENT
        impersonate = kwargs.pop("impersonate", None) or self._impersonate_for(user_agent)
        session_kwargs = {k: v for k, v in kwargs.items() if k not in ("base_url",)}
        self.session = requests.Session(impersonate=impersonate, **session_kwargs)
        self.session.headers = {
            "connection": "keep-alive",
            "sec-ch-ua-platform": self._platform_for(user_agent),
            "user-agent": user_agent,
            "sec-ch-ua-mobile": "?0",
            "accept": "*/*",
            "sec-fetch-site": "same-origin",
            "sec-fetch-mode": "no-cors",
            "sec-fetch-dest": "script",
            "accept-encoding": "gzip, deflate, br, zstd",
            "accept-language": "en-US,en;q=0.9"
        }
        self.session.base_url = base_url

    @staticmethod
    def _impersonate_for(user_agent: str) -> str:
        """Pick the closest curl_cffi impersonation target for the real UA so the
        TLS/JA3 fingerprint stays coherent with the user-agent header we send."""
        import re

        match = re.search(r"Chrome/(\d+)", user_agent or "")
        if not match:
            return "chrome124"
        major = int(match.group(1))
        # curl_cffi ships a discrete set of chrome targets; snap to the newest
        # one that does not exceed the real browser version.
        for target in (131, 124, 120, 119, 116, 110, 107, 104, 101, 100, 99):
            if major >= target:
                return f"chrome{target}"
        return "chrome99"

    @staticmethod
    def _platform_for(user_agent: str) -> str:
        ua = (user_agent or "").lower()
        if "android" in ua:
            return "\"Android\""
        if "mac os" in ua or "macintosh" in ua:
            return "\"macOS\""
        if "linux" in ua:
            return "\"Linux\""
        return "\"Windows\""

    @staticmethod
    def random() -> str:
        return f"geetest_{int(random.random() * 10000) + int(time.time() * 1000)}"

    def format_response(self, response: str) -> dict:
        return json.loads(response.split(f"{self.callback}(")[1][:-1])["data"]

    def load_captcha(self):
        params = {
            "captcha_id": self.captcha_id,
            "challenge": self.challenge,
            "client_type": "web",
            "lang": "eng",
            "callback": self.callback,
        }
        if self.risk_type:
            params["risk_type"] = self.risk_type
        res = self.session.get("/load", params=params)
        return self.format_response(res.text)

    def submit_captcha(self, data: dict) -> dict:
        self.callback = Geeked.random()

        params = {
            "callback": self.callback,
            "captcha_id": self.captcha_id,
            "client_type": "web",
            "lot_number": self.lot_number,
            "payload": data["payload"],
            "process_token": data["process_token"],
            "payload_protocol": "1",
            "pt": "1",
            "w": Signer.generate_w(data, self.captcha_id, self.risk_type),
        }
        if self.risk_type:
            params["risk_type"] = self.risk_type
        res = self.session.get("/verify", params=params).text
        res = self.format_response(res)

        if res.get("result") == "success":
            return res.get("seccode", res)
        if res.get("seccode") is not None:
            return res["seccode"]

        raise Exception(f"Failed to submit captcha: {res}")

    def solve(self, max_retries: int = 5) -> dict:
        wanted_type = self.risk_type
        last_error = None

        for attempt in range(max_retries):
            self.challenge = str(uuid4())
            data = self.load_captcha()

            if not self.risk_type:
                self.risk_type = data.get("captcha_type", "")
            elif wanted_type and data.get("captcha_type") != wanted_type:
                if attempt < max_retries - 1:
                    time.sleep(0.5)
                    continue

            self.lot_number = data["lot_number"]

            try:
                seccode = self.submit_captcha(data)
                return seccode
            except Exception as e:
                last_error = e
                if attempt < max_retries - 1:
                    time.sleep(0.5)
                    continue

        raise last_error or Exception(
            f"Failed after {max_retries} attempts. "
            f"Wanted risk_type={wanted_type}, server returned different types."
        )
