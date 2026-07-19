"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const test = require("node:test");

test("media peers tolerate queued callbacks, close, GC, and process teardown", () => {
  const webrtcRoot = path.resolve(__dirname, "..");
  const script = `
    const { nonstandard, RTCPeerConnection } = require(${JSON.stringify(webrtcRoot)});
    const { EncodedMediaSink, EncodedMediaSource } = nonstandard;

    function waitFor(target, type) {
      return new Promise((resolve) => target.addEventListener(type, resolve, { once: true }));
    }

    async function negotiate(offerer, answerer) {
      await offerer.setLocalDescription(await offerer.createOffer());
      await answerer.setRemoteDescription(offerer.localDescription);
      await answerer.setLocalDescription(await answerer.createAnswer());
      await offerer.setRemoteDescription(answerer.localDescription);
    }

    (async () => {
      for (let index = 0; index < 20; index += 1) {
        let offerer = new RTCPeerConnection();
        let answerer = new RTCPeerConnection();
        let source = new EncodedMediaSource({
          kind: "video",
          codec: { mimeType: "video/VP8", payloadType: 96 },
          ssrc: 1000 + index,
        });
        const incoming = waitFor(answerer, "track");
        const sourceOpen = waitFor(source, "open");
        offerer.addTrack(source.track);
        await negotiate(offerer, answerer);
        let sink = new EncodedMediaSink((await incoming).track);
        if (source.readyState !== "open") await sourceOpen;
        source.send(Uint8Array.from([
          0x80, 96, 0, index + 1, 0, 0, 0, index + 1,
          0, 0, (1000 + index) >> 8, (1000 + index) & 0xff, 1,
        ]));

        if (index % 2 === 0) {
          sink.close();
          source.close();
          answerer.close();
          offerer.close();
        }
        sink = null;
        source = null;
        answerer = null;
        offerer = null;
        global.gc();
        await new Promise((resolve) => setImmediate(resolve));
      }
      global.gc();
      await new Promise((resolve) => setTimeout(resolve, 50));
    })().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  `;

  const child = spawnSync(process.execPath, ["--expose-gc", "-e", script], {
    encoding: "utf8",
    timeout: 30000,
    windowsHide: true,
  });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr);
});
