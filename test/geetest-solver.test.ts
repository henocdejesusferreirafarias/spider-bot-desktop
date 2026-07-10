import test from "node:test";
import assert from "node:assert/strict";
import { shouldAttemptAutomaticGeetestSolve, solveNineGeetestWithClient } from "../src/main/services/geetest-solver.js";

test("temporary Geetest policy attempts automatic solving only for nine captchas", () => {
  assert.equal(shouldAttemptAutomaticGeetestSolve("nine"), true);
  assert.equal(shouldAttemptAutomaticGeetestSolve(" NINE "), true);
  assert.equal(shouldAttemptAutomaticGeetestSolve("icon"), false);
  assert.equal(shouldAttemptAutomaticGeetestSolve("slide"), false);
  assert.equal(shouldAttemptAutomaticGeetestSolve(null), false);
  assert.equal(shouldAttemptAutomaticGeetestSolve(undefined), false);
});

test("solveNineGeetestWithClient probes load when captured risk type is unknown", async () => {
  const calls: string[] = [];
  const client = {
    async load(captchaId: string, riskType?: string | null) {
      calls.push(`load:${captchaId}:${riskType ?? "none"}`);
      return {
        lot_number: "lot-unknown",
        pow_detail: { hashfunc: "md5", version: "1", bits: 0, datetime: "2026-07-10" },
        pt: "0",
        captcha_type: "nine",
        payload: "payload-unknown",
        process_token: "process-unknown",
        imgs: "grid.jpg",
        ques: ["ques.png"],
        nine_nums: 3,
      };
    },
    async fetchImage() {
      return Buffer.alloc(0);
    },
    async verify() {
      return {
        result: "success",
        seccode: {
          captcha_id: "captcha-unknown",
          lot_number: "lot-unknown",
          pass_token: "pass-unknown",
        },
      };
    },
  };

  const solution = await solveNineGeetestWithClient(client, "captcha-unknown", undefined, async () => "signed-w");

  assert.equal(solution?.pass_token, "pass-unknown");
  assert.deepEqual(calls, ["load:captcha-unknown:none"]);
});

test("solveNineGeetestWithClient skips a loaded non-nine challenge without signing", async () => {
  let signed = false;
  const solution = await solveNineGeetestWithClient({
    async load() {
      return {
        lot_number: "lot-icon",
        pow_detail: { hashfunc: "md5", version: "1", bits: 0, datetime: "2026-07-10" },
        pt: "0",
        captcha_type: "icon",
      };
    },
    async fetchImage() {
      throw new Error("must not fetch image");
    },
    async verify() {
      throw new Error("must not verify");
    },
  }, "captcha-icon", undefined, async () => {
    signed = true;
    return "signed-w";
  });

  assert.equal(solution, null);
  assert.equal(signed, false);
});

test("solveNineGeetestWithClient verifies nine captcha using the TS signer path", async () => {
  const calls: string[] = [];
  const client = {
    async load(captchaId: string, riskType?: string | null) {
      calls.push(`load:${captchaId}:${riskType}`);
      return {
        lot_number: "lot-1",
        pow_detail: { hashfunc: "md5", version: "1", bits: 0, datetime: "2026-07-10" },
        pt: "0",
        captcha_type: "nine",
        payload: "payload-1",
        process_token: "process-1",
        imgs: "grid.jpg",
        ques: ["ques.png"],
        nine_nums: 3,
      };
    },
    async fetchImage(path: string) {
      calls.push(`image:${path}`);
      return Buffer.alloc(0);
    },
    async verify(args: { w: string; riskType?: string | null }) {
      calls.push(`verify:${args.w}:${args.riskType}`);
      return {
        result: "success",
        seccode: {
          captcha_id: "captcha-1",
          lot_number: "lot-1",
          pass_token: "pass-1",
          gen_time: "time-1",
          captcha_output: "output-1",
        },
      };
    },
  };

  const solution = await solveNineGeetestWithClient(client, "captcha-1", "nine", async () => "signed-w");

  assert.deepEqual(solution, {
    captcha_id: "captcha-1",
    lot_number: "lot-1",
    pass_token: "pass-1",
    gen_time: "time-1",
    captcha_output: "output-1",
  });
  assert.deepEqual(calls, ["load:captcha-1:nine", "verify:signed-w:nine"]);
});

test("solveNineGeetestWithClient skips non-nine before loading captcha data", async () => {
  let loadCalls = 0;
  const solution = await solveNineGeetestWithClient({
    async load() {
      loadCalls += 1;
      throw new Error("must not load");
    },
    async fetchImage() {
      throw new Error("must not fetch image");
    },
    async verify() {
      throw new Error("must not verify");
    },
  }, "captcha-1", "icon", async () => "signed-w");

  assert.equal(solution, null);
  assert.equal(loadCalls, 0);
});
