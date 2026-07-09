import type { APIRequestContext } from 'patchright';

export interface GeetestLoadData {
  lot_number: string;
  pow_detail: { hashfunc: string; version: string; bits: number; datetime: string };
  pt: string;
  captcha_type?: string;
  payload?: string;
  process_token?: string;
  slice?: string; bg?: string;
  ques?: unknown; imgs?: string; nine_nums?: number;
  [k: string]: unknown;
}
export interface GeetestVerifyResult {
  result?: string;
  seccode?: Record<string, unknown> & { captcha_id?: string; lot_number?: string; pass_token?: string; gen_time?: string; captcha_output?: string };
  [k: string]: unknown;
}

export class GeetestClient {
  private callback: string;
  constructor(
    private readonly req: APIRequestContext,
    private readonly baseUrl: string = 'https://gcaptcha4.geevisit.com',
  ) {
    this.callback = `geetest_${Math.floor(Math.random() * 10000) + Date.now()}`;
  }

  private static randomCallback(): string {
    return `geetest_${Math.floor(Math.random() * 10000) + Date.now()}`;
  }

  private parseJsonp(text: string, callback: string): Record<string, unknown> {
    const prefix = `${callback}(`;
    const start = text.indexOf(prefix);
    if (start < 0) throw new Error(`resposta não-JSONP: ${text.slice(0, 80)}`);
    return JSON.parse(text.slice(start + prefix.length, text.lastIndexOf(')')));
  }

  async load(captchaId: string, riskType?: string | null): Promise<GeetestLoadData> {
    this.callback = GeetestClient.randomCallback();
    const params: Record<string, string> = {
      captcha_id: captchaId,
      challenge: crypto.randomUUID(),
      client_type: 'web',
      lang: 'eng',
      callback: this.callback,
    };
    if (riskType) params.risk_type = riskType;
    const res = await this.req.get(`${this.baseUrl}/load`, { params });
    const data = this.parseJsonp(await res.text(), this.callback)['data'] as GeetestLoadData;
    return data;
  }

  async verify(args: {
    captchaId: string; lotNumber: string; payload: string; processToken: string;
    w: string; riskType?: string | null;
  }): Promise<GeetestVerifyResult> {
    this.callback = GeetestClient.randomCallback();
    const params: Record<string, string> = {
      callback: this.callback,
      captcha_id: args.captchaId,
      client_type: 'web',
      lot_number: args.lotNumber,
      payload: args.payload,
      process_token: args.processToken,
      payload_protocol: '1',
      pt: '1',
      w: args.w,
    };
    if (args.riskType) params.risk_type = args.riskType;
    const res = await this.req.get(`${this.baseUrl}/verify`, { params });
    return this.parseJsonp(await res.text(), this.callback) as unknown as GeetestVerifyResult;
  }

  async fetchImage(path: string): Promise<Buffer> {
    const url = path.startsWith('http') ? path : `https://static.geetest.com/${path}`;
    const res = await this.req.get(url);
    return Buffer.from(await res.body());
  }
}
