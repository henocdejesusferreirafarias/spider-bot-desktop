import { generateW, type GeetestChallengeData } from "./captcha/signer.js";
import type { GeetestVerifyResult } from "./captcha/geetest-client.js";

export interface GeetestCaptchaData {
  captchaId: string;
  baseUrl: string;
  riskType?: string;
}

export interface GeetestSolution {
  captcha_id?: string;
  lot_number?: string;
  pass_token?: string;
  gen_time?: string;
  captcha_output?: string;
  userresponse?: string | number | Array<[number, number]>;
  setLeft?: number;
}

export function shouldAttemptAutomaticGeetestSolve(riskType?: string | null): boolean {
  return riskType?.trim().toLowerCase() === "nine";
}

export interface GeetestNineClient {
  load(captchaId: string, riskType?: string | null): Promise<GeetestChallengeData & { captcha_type?: string }>;
  fetchImage(path: string): Promise<Buffer>;
  verify(args: {
    captchaId: string;
    lotNumber: string;
    payload: string;
    processToken: string;
    w: string;
    riskType?: string | null;
  }): Promise<GeetestVerifyResult>;
}

export const GEETEST_NINE_SEARCH_LIMIT = 10;
export const GEETEST_NINE_ANSWER_LIMIT = 5;
export const GEETEST_NINE_RETRY_DELAY_MS = 180;
export const GEETEST_NINE_DEADLINE_MS = 60_000;

export type NineChallengeSearchResult =
  | { status: "found"; data: GeetestChallengeData; searchAttempts: number }
  | { status: "exhausted" | "deadline"; searchAttempts: number };

export interface NineChallengeSearchOptions {
  deadlineAt: number;
  maxAttempts?: number;
  now?: () => number;
  wait?: (delayMs: number) => Promise<void>;
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isUsableNineChallenge(
  data: GeetestChallengeData & { captcha_type?: string },
): boolean {
  const questions = Array.isArray(data.ques) ? data.ques : [];
  return shouldAttemptAutomaticGeetestSolve(data.captcha_type)
    && hasText(data.lot_number)
    && hasText(data.payload)
    && hasText(data.process_token)
    && hasText(data.imgs)
    && hasText(questions[0]);
}

export async function findNineChallengeWithClient(
  client: GeetestNineClient,
  captchaId: string,
  options: NineChallengeSearchOptions,
): Promise<NineChallengeSearchResult> {
  const maxAttempts = options.maxAttempts ?? GEETEST_NINE_SEARCH_LIMIT;
  const now = options.now ?? Date.now;
  const wait = options.wait ?? ((delayMs: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  let searchAttempts = 0;

  while (searchAttempts < maxAttempts) {
    if (now() >= options.deadlineAt) {
      return { status: "deadline", searchAttempts };
    }
    searchAttempts += 1;
    try {
      const data = await client.load(captchaId, "nine");
      if (now() >= options.deadlineAt) {
        return { status: "deadline", searchAttempts };
      }
      if (isUsableNineChallenge(data)) {
        return { status: "found", data, searchAttempts };
      }
    } catch {
      // A failed load consumes this search attempt.
    }
    if (searchAttempts < maxAttempts) {
      if (now() >= options.deadlineAt) {
        return { status: "deadline", searchAttempts };
      }
      await wait(GEETEST_NINE_RETRY_DELAY_MS);
    }
  }

  return { status: "exhausted", searchAttempts };
}

export type GenerateGeetestW = (
  data: GeetestChallengeData,
  captchaId: string,
  riskType: string,
  fetchImage: (path: string) => Promise<Buffer>,
) => Promise<string>;

export async function solveLoadedNineGeetestWithClient(
  client: GeetestNineClient,
  captchaId: string,
  data: GeetestChallengeData,
  generateGeetestW: GenerateGeetestW = (challengeData, id, type, fetchImage) =>
    generateW(challengeData, id, type, fetchImage, () => 0),
): Promise<GeetestSolution | null> {
  const w = await generateGeetestW(data, captchaId, "nine", (path) => client.fetchImage(path));
  const result = await client.verify({
    captchaId,
    lotNumber: data.lot_number,
    payload: String(data.payload ?? ""),
    processToken: String(data.process_token ?? ""),
    w,
    riskType: "nine",
  });
  const seccode = result.seccode;
  if (!seccode?.pass_token || !seccode.lot_number) {
    return null;
  }

  return {
    captcha_id: seccode.captcha_id ?? captchaId,
    lot_number: seccode.lot_number,
    pass_token: seccode.pass_token,
    gen_time: seccode.gen_time,
    captcha_output: seccode.captcha_output,
  };
}
