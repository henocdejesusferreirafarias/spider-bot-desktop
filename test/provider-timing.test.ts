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

test("WG timing does not claim an unrelated frame path", () => {
  assert.equal(
    resolveProviderByFrameUrl("https://example.com/client/v3/index.html"),
    undefined
  );
});

test("WG konnect launcher resolves to the Cocos Director strategy", () => {
  const profile = resolveProviderByFrameUrl(
    "https://6imyktbb.wgkonnect.com/clientv3/index.html?gameId=3048"
  );

  assert.equal(profile?.id, "wg");
  assert.equal(profile?.speedStrategy, "cocos-director-tick");
});

test("WG Cocos launcher route is independent of the delivery host", () => {
  const profile = resolveProviderByFrameUrl(
    "https://ephemeral-game-host.example/clientv3/index.html"
  );

  assert.equal(profile?.id, "wg");
  assert.equal(profile?.speedStrategy, "cocos-director-tick");
});

test("WG Cocos pattern matches the observed launcher URL", () => {
  const [source] = cocosDirectorTickFramePatternSources();
  assert.ok(source);
  const url = new URL(
    "https://6imyktbb.wgkonnect.com/clientv3/index.html?gameId=3048"
  );
  assert.match(url.pathname, new RegExp(source, "i"));
});

test("JDB game frame resolves from its stable query signature on a dynamic host", () => {
  const profile = resolveProviderByFrameUrl(
    "https://dynamic-host.example/?isAPP=false&gVer=9716ef5&lang=pt&gameType=8&mType=8048&x=token"
  );

  assert.equal(profile?.id, "jdb");
  assert.equal(profile?.speedStrategy, "generic-timers");
  assert.equal(profile?.supportsAutomaticFrameReload, false);
});

test("JDB timing does not claim an unrelated mType query", () => {
  assert.equal(
    resolveProviderByFrameUrl("https://example.com/?mType=8048"),
    undefined
  );
});

test("PP UHT resolves from the stable html5Game path on a dynamic host", () => {
  const profile = resolveProviderByFrameUrl(
    "https://dynamic.example/gs2c/html5Game.do?key=secret"
  );

  assert.equal(profile?.id, "pp");
  assert.equal(profile?.speedStrategy, "uht-delta-time");
});

test("PP wrapper is not treated as the UHT game document", () => {
  assert.equal(
    resolveProviderByFrameUrl("https://dynamic.example/gs2c/playGame.do?key=secret"),
    undefined
  );
});
