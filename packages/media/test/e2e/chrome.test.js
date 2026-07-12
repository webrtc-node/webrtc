"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const { after, before, test } = require("node:test");
const { chromium } = require("playwright-core");
const { RTCPeerConnection } = require("@webrtc-node/webrtc");
const { EncodedMediaSink } = require("../..");

const timeout = Number(process.env.CHROME_E2E_TIMEOUT_MS || 30000);
let browser;

function chromeExecutable() {
  const candidates =
    process.platform === "win32"
      ? [
          process.env.CHROME_PATH,
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        ]
      : process.platform === "darwin"
        ? [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
        : [
            process.env.CHROME_PATH,
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
            "/opt/google/chrome/chrome",
          ];
  const executable = candidates.find((candidate) => candidate && fs.existsSync(candidate));
  if (!executable) throw new Error("Google Chrome was not found; set CHROME_PATH");
  return executable;
}

function waitFor(target, type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), timeout);
    target.addEventListener(
      type,
      (event) => {
        clearTimeout(timer);
        resolve(event);
      },
      { once: true },
    );
  });
}

async function gather(peer, description) {
  await peer.setLocalDescription(description);
  while (peer.iceGatheringState !== "complete") {
    await waitFor(peer, "icegatheringstatechange");
  }
  return peer.localDescription.toJSON();
}

before(async () => {
  browser = await chromium.launch({ executablePath: chromeExecutable(), headless: true });
  console.log(`Chrome ${browser.version()}`);
});

after(async () => browser?.close());

test("Chrome VP8 reaches a Node encoded receive track", async () => {
  const page = await browser.newPage();
  const peer = new RTCPeerConnection();
  let sink;
  try {
    const offer = await page.evaluate(async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 32;
      canvas.height = 32;
      const context = canvas.getContext("2d");
      let frame = 0;
      window.frameTimer = setInterval(() => {
        context.fillStyle = frame++ % 2 ? "#e63946" : "#2a9d8f";
        context.fillRect(0, 0, canvas.width, canvas.height);
      }, 50);
      const stream = canvas.captureStream(20);
      window.mediaPeer = new RTCPeerConnection();
      window.mediaStream = stream;
      window.mediaPeer.addTrack(stream.getVideoTracks()[0], stream);
      await window.mediaPeer.setLocalDescription(await window.mediaPeer.createOffer());
      if (window.mediaPeer.iceGatheringState !== "complete") {
        await new Promise((resolve) => {
          window.mediaPeer.addEventListener("icegatheringstatechange", () => {
            if (window.mediaPeer.iceGatheringState === "complete") resolve();
          });
        });
      }
      return window.mediaPeer.localDescription.toJSON();
    });

    const video = /m=video[^\r\n]*[\s\S]*?(?=\r?\nm=|$)/i.exec(offer.sdp)?.[0];
    const payloadType = Number(/(?:^|\r?\n)a=rtpmap:(\d+) VP8\/90000/i.exec(video || "")?.[1]);
    assert.ok(Number.isInteger(payloadType));

    const trackEvent = waitFor(peer, "track");
    await peer.setRemoteDescription(offer);
    sink = new EncodedMediaSink((await trackEvent).track);
    const packet = waitFor(sink, "packet");
    const answer = await gather(peer, await peer.createAnswer());
    await page.evaluate(
      (description) => window.mediaPeer.setRemoteDescription(description),
      answer,
    );

    const bytes = new Uint8Array((await packet).data);
    assert.ok(bytes.byteLength >= 12);
    assert.equal(bytes[0] >> 6, 2);
    const receivedPayloadType = bytes[1] & 0x7f;
    assert.match(video, new RegExp(`(?:^|\\s)${receivedPayloadType}(?:\\s|$)`));
    assert.match(video, new RegExp(`a=rtpmap:${receivedPayloadType} `, "i"));
  } finally {
    sink?.close();
    peer.close();
    await page.evaluate(() => {
      clearInterval(window.frameTimer);
      window.mediaStream?.getTracks().forEach((track) => {
        track.stop();
      });
      window.mediaPeer?.close();
    });
    await page.close();
  }
});
