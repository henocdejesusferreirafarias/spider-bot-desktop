import test from "node:test";
import assert from "node:assert/strict";
import {
  findNineChallengeWithClient,
  solveLoadedNineGeetestWithClient,
} from "../src/main/services/geetest-solver.js";

function challenge(captchaType: string, suffix: string) {
  return {
    lot_number: `lot-${suffix}`,
    pow_detail: { hashfunc: "md5", version: "1", bits: 0, datetime: "2026-07-16" },
    pt: "0",
    captcha_type: captchaType,
    payload: `payload-${suffix}`,
    process_token: `process-${suffix}`,
    imgs: "grid.jpg",
    ques: ["ques.png"],
    nine_nums: 3,
  };
}

test("findNineChallengeWithClient requests nine and accepts the tenth nine response", async () => {
  const requestedTypes: Array<string | null | undefined> = [];
  let loads = 0;
  const client = {
    async load(_captchaId: string, riskType?: string | null) {
      requestedTypes.push(riskType);
      loads += 1;
      return challenge(loads === 10 ? " NINE " : "icon", String(loads));
    },
    async fetchImage() { return Buffer.alloc(0); },
    async verify() { return {}; },
  };

  const result = await findNineChallengeWithClient(client, "captcha-1", {
    deadlineAt: 60_000,
    now: () => 0,
    wait: async () => undefined,
  });

  assert.equal(result.status, "found");
  assert.equal(result.searchAttempts, 10);
  assert.deepEqual(requestedTypes, Array(10).fill("nine"));
});

test("findNineChallengeWithClient exhausts ten non-nine responses", async () => {
  let loads = 0;
  const client = {
    async load() {
      loads += 1;
      return challenge("icon", String(loads));
    },
    async fetchImage() { return Buffer.alloc(0); },
    async verify() { return {}; },
  };

  const result = await findNineChallengeWithClient(client, "captcha-1", {
    deadlineAt: 60_000,
    now: () => 0,
    wait: async () => undefined,
  });

  assert.deepEqual(result, { status: "exhausted", searchAttempts: 10 });
});

test("findNineChallengeWithClient counts load errors and honors the deadline", async () => {
  let now = 0;
  let loads = 0;
  const client = {
    async load() {
      loads += 1;
      throw new Error("network");
    },
    async fetchImage() { return Buffer.alloc(0); },
    async verify() { return {}; },
  };

  const result = await findNineChallengeWithClient(client, "captcha-1", {
    deadlineAt: 60_000,
    now: () => now,
    wait: async () => { now += 30_000; },
  });

  assert.deepEqual(result, { status: "deadline", searchAttempts: 2 });
  assert.equal(loads, 2);
});

test("findNineChallengeWithClient treats malformed nine data as a consumed search", async () => {
  let loads = 0;
  const client = {
    async load() {
      loads += 1;
      return loads === 1
        ? { ...challenge("nine", "bad"), process_token: "" }
        : challenge("nine", "good");
    },
    async fetchImage() { return Buffer.alloc(0); },
    async verify() { return {}; },
  };

  const result = await findNineChallengeWithClient(client, "captcha-1", {
    deadlineAt: 60_000,
    now: () => 0,
    wait: async () => undefined,
  });

  assert.equal(result.status, "found");
  assert.equal(result.searchAttempts, 2);
});

test("solveLoadedNineGeetestWithClient verifies without loading another challenge", async () => {
  const calls: string[] = [];
  const client = {
    async load() {
      throw new Error("must not load");
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

  const solution = await solveLoadedNineGeetestWithClient(
    client,
    "captcha-1",
    challenge("nine", "1"),
    async () => "signed-w",
  );

  assert.deepEqual(solution, {
    captcha_id: "captcha-1",
    lot_number: "lot-1",
    pass_token: "pass-1",
    gen_time: "time-1",
    captcha_output: "output-1",
  });
  assert.deepEqual(calls, ["verify:signed-w:nine"]);
});
