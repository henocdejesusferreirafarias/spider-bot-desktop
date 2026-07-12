import assert from "node:assert/strict";
import test from "node:test";
import {
  cocosDirectorTickFramePatternSources,
  resolveProviderByFrameUrl
} from "../src/main/services/provider-timing.js";

test("WG networking launcher resolves to the Cocos Director strategy", () => {
  const profile = resolveProviderByFrameUrl(
    "https://pwmercjm.wgnetworking.com/clientv3/index.html"
  );

  assert.equal(profile?.id, "wg");
  assert.equal(profile?.speedStrategy, "cocos-director-tick");
  assert.equal(cocosDirectorTickFramePatternSources().length, 1);
});

test("WG timing does not claim a non-WG clientv3 frame", () => {
  assert.equal(
    resolveProviderByFrameUrl("https://example.com/clientv3/index.html"),
    undefined
  );
});

test("WG Cocos pattern matches the observed launcher URL", () => {
  const [source] = cocosDirectorTickFramePatternSources();
  assert.ok(source);
  assert.match(
    "https://pwmercjm.wgnetworking.com/clientv3/index.html",
    new RegExp(source, "i")
  );
});
