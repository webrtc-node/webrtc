"use strict";

const fs = require("node:fs");
const http = require("node:http");
const { chromium } = require("playwright-core");
const { RTCPeerConnection } = require("../..");

const DEFAULT_TIMEOUT = Number(process.env.CHROME_E2E_TIMEOUT_MS || 30000);

function chromeCandidates() {
  if (process.platform === "win32") {
    return [
      process.env.CHROME_PATH,
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    ];
  }
  if (process.platform === "darwin") {
    return [
      process.env.CHROME_PATH,
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ];
  }
  return [
    process.env.CHROME_PATH,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/opt/google/chrome/chrome",
  ];
}

function findChromeExecutable() {
  const executable = chromeCandidates().find((candidate) => candidate && fs.existsSync(candidate));
  if (!executable) {
    throw new Error("Google Chrome was not found; set CHROME_PATH to its executable");
  }
  return executable;
}

function waitFor(target, type, predicate = () => true, timeout = DEFAULT_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      target.removeEventListener(type, onEvent);
      reject(new Error(`Timed out waiting for ${type}`));
    }, timeout);

    function onEvent(event) {
      if (!predicate(event)) return;
      clearTimeout(timer);
      target.removeEventListener(type, onEvent);
      resolve(event);
    }

    target.addEventListener(type, onEvent);
  });
}

async function waitForOpen(channel) {
  if (channel.readyState !== "open") await waitFor(channel, "open");
}

async function gatherLocalDescription(peerConnection, description) {
  await peerConnection.setLocalDescription(description);
  if (peerConnection.iceGatheringState !== "complete") {
    await waitFor(
      peerConnection,
      "icegatheringstatechange",
      () => peerConnection.iceGatheringState === "complete",
    );
  }
  return peerConnection.localDescription.toJSON();
}

function waitForMessage(channel, predicate, timeout = DEFAULT_TIMEOUT) {
  return waitFor(channel, "message", ({ data }) => predicate(data), timeout).then(
    ({ data }) => data,
  );
}

function collectStrings(channel, count, prefix, timeout = DEFAULT_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const values = [];
    const timer = setTimeout(() => {
      channel.removeEventListener("message", onMessage);
      reject(new Error(`Timed out collecting ${prefix}: ${values.length}/${count}`));
    }, timeout);

    function onMessage({ data }) {
      if (typeof data !== "string" || !data.startsWith(prefix)) return;
      values.push(data);
      if (values.length !== count) return;
      clearTimeout(timer);
      channel.removeEventListener("message", onMessage);
      resolve(values);
    }

    channel.addEventListener("message", onMessage);
  });
}

function bytesOf(data) {
  if (data instanceof ArrayBuffer) return [...new Uint8Array(data)];
  return [...new Uint8Array(data.buffer, data.byteOffset, data.byteLength)];
}

function binarySignature(data) {
  const view =
    data instanceof Uint8Array
      ? data
      : new Uint8Array(
          data instanceof ArrayBuffer ? data : data.buffer,
          data.byteOffset || 0,
          data.byteLength,
        );
  let sum = 0;
  for (const value of view) sum = (sum + value) >>> 0;
  return {
    length: view.byteLength,
    first: view[0],
    middle: view[Math.floor(view.byteLength / 2)],
    last: view[view.byteLength - 1],
    sum,
  };
}

function iceUfrag(description) {
  return /(?:^|\r?\n)a=ice-ufrag:([^\r\n]+)/m.exec(description?.sdp || "")?.[1] ?? null;
}

async function installBrowserHarness(page) {
  await page.evaluate(() => {
    const state = {
      peerConnection: null,
      channels: [],
      strings: [],
      binaries: [],
      dataChannelEvents: 0,
      bufferedAmountLow: false,
      immediateBufferedAmount: 0,
    };

    const waitForIceGathering = (peerConnection) => {
      if (peerConnection.iceGatheringState === "complete") return Promise.resolve();
      return new Promise((resolve) => {
        const onChange = () => {
          if (peerConnection.iceGatheringState !== "complete") return;
          peerConnection.removeEventListener("icegatheringstatechange", onChange);
          resolve();
        };
        peerConnection.addEventListener("icegatheringstatechange", onChange);
      });
    };

    const signature = (data) => {
      const view = new Uint8Array(data);
      let sum = 0;
      for (const value of view) sum = (sum + value) >>> 0;
      return {
        length: view.byteLength,
        first: view[0],
        middle: view[Math.floor(view.byteLength / 2)],
        last: view[view.byteLength - 1],
        sum,
      };
    };

    const installChannel = (channel) => {
      state.channels.push(channel);
      channel.binaryType = "arraybuffer";
      channel.addEventListener("message", async ({ data }) => {
        if (typeof data === "string") {
          state.strings.push(data);
          return;
        }
        const value = data instanceof Blob ? await data.arrayBuffer() : data;
        state.binaries.push({
          kind: data instanceof Blob ? "Blob" : "ArrayBuffer",
          ...signature(value),
        });
      });
    };

    const createPeerConnection = () => {
      const peerConnection = new RTCPeerConnection();
      state.peerConnection = peerConnection;
      peerConnection.addEventListener("datachannel", ({ channel }) => {
        state.dataChannelEvents += 1;
        installChannel(channel);
      });
      return peerConnection;
    };

    window.chromeE2E = {
      reset() {
        for (const channel of state.channels) {
          try {
            channel.close();
          } catch {}
        }
        try {
          state.peerConnection?.close();
        } catch {}
        state.peerConnection = null;
        state.channels = [];
        state.strings = [];
        state.binaries = [];
        state.dataChannelEvents = 0;
        state.bufferedAmountLow = false;
        state.immediateBufferedAmount = 0;
      },

      prepareNegotiated(options) {
        const peerConnection = createPeerConnection();
        installChannel(peerConnection.createDataChannel(options.label, options));
      },

      async acceptOffer(offer) {
        const peerConnection = createPeerConnection();
        await peerConnection.setRemoteDescription(offer);
        await peerConnection.setLocalDescription(await peerConnection.createAnswer());
        await waitForIceGathering(peerConnection);
        return peerConnection.localDescription.toJSON();
      },

      async acceptOfferExisting(offer) {
        await state.peerConnection.setRemoteDescription(offer);
        await state.peerConnection.setLocalDescription(await state.peerConnection.createAnswer());
        await waitForIceGathering(state.peerConnection);
        return state.peerConnection.localDescription.toJSON();
      },

      async createOffer(label, options = {}) {
        const peerConnection = createPeerConnection();
        installChannel(peerConnection.createDataChannel(label, options));
        await peerConnection.setLocalDescription(await peerConnection.createOffer());
        await waitForIceGathering(peerConnection);
        return peerConnection.localDescription.toJSON();
      },

      async acceptAnswer(answer) {
        await state.peerConnection.setRemoteDescription(answer);
      },

      async acceptRenegotiation(offer) {
        await state.peerConnection.setRemoteDescription(offer);
        await state.peerConnection.setLocalDescription(await state.peerConnection.createAnswer());
        await waitForIceGathering(state.peerConnection);
        return state.peerConnection.localDescription.toJSON();
      },

      async createRestartOffer() {
        state.peerConnection.restartIce();
        await state.peerConnection.setLocalDescription(await state.peerConnection.createOffer());
        await waitForIceGathering(state.peerConnection);
        return state.peerConnection.localDescription.toJSON();
      },

      setPrimaryBinaryType(value) {
        state.channels[0].binaryType = value;
      },

      sendString(value) {
        state.channels[0].send(value);
      },

      sendBinary(bytes) {
        state.channels[0].send(Uint8Array.from(bytes));
      },

      sendBinaryAsBlob(bytes) {
        state.channels[0].send(new Blob([Uint8Array.from(bytes)]));
      },

      sendStringBurst(prefix, count) {
        for (let index = 0; index < count; index += 1) {
          state.channels[0].send(`${prefix}${String(index).padStart(4, "0")}`);
        }
      },

      sendBinaryBurst(count, size) {
        const channel = state.channels[0];
        channel.bufferedAmountLowThreshold = 1;
        channel.addEventListener(
          "bufferedamountlow",
          () => {
            state.bufferedAmountLow = true;
          },
          { once: true },
        );
        const payload = new Uint8Array(size);
        for (let index = 0; index < count; index += 1) channel.send(payload);
        state.immediateBufferedAmount = channel.bufferedAmount;
      },

      sendLarge(size) {
        const payload = new Uint8Array(size);
        for (let index = 0; index < payload.length; index += 1) {
          payload[index] = index % 251;
        }
        state.channels[0].send(payload);
      },

      trySendSize(size) {
        try {
          state.channels[0].send(new Uint8Array(size));
          return { threw: false };
        } catch (error) {
          return { threw: true, name: error.name, message: error.message };
        }
      },

      sendAndClose(value) {
        state.channels[0].send(value);
        state.channels[0].close();
      },

      closePrimary() {
        state.channels[0].close();
      },

      closePeer() {
        state.peerConnection?.close();
      },

      snapshot() {
        const primary = state.channels[0];
        return {
          primaryState: primary?.readyState ?? null,
          dataChannelEvents: state.dataChannelEvents,
          strings: [...state.strings],
          binaries: state.binaries.map((value) => ({ ...value })),
          channelCount: state.channels.length,
          channelIds: state.channels.map((channel) => channel.id),
          channels: state.channels.map((channel) => ({
            label: channel.label,
            id: channel.id,
            ordered: channel.ordered,
            negotiated: channel.negotiated,
            maxRetransmits: channel.maxRetransmits,
            maxPacketLifeTime: channel.maxPacketLifeTime,
            protocol: channel.protocol,
            readyState: channel.readyState,
          })),
          connectionState: state.peerConnection?.connectionState ?? null,
          iceConnectionState: state.peerConnection?.iceConnectionState ?? null,
          sctpState: state.peerConnection?.sctp?.state ?? null,
          maxMessageSize: state.peerConnection?.sctp?.maxMessageSize ?? null,
          bufferedAmount: primary?.bufferedAmount ?? null,
          bufferedAmountLow: state.bufferedAmountLow,
          immediateBufferedAmount: state.immediateBufferedAmount,
        };
      },
    };
  });
}

async function createChromeE2EContext() {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": "text/html; charset=utf-8",
    });
    response.end('<!doctype html><meta charset="utf-8"><title>Chrome WebRTC E2E</title>');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  let browser;
  try {
    browser = await chromium.launch({
      executablePath: findChromeExecutable(),
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-features=WebRtcHideLocalIpsWithMdns",
        "--allow-loopback-in-peer-connection",
      ],
    });
  } catch (error) {
    await new Promise((resolve) => server.close(resolve));
    throw error;
  }

  async function newPage() {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}`, {
      waitUntil: "domcontentloaded",
    });
    await installBrowserHarness(page);
    return page;
  }

  async function close() {
    try {
      await browser.close();
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }

  return {
    browser,
    close,
    newPage,
  };
}

async function connectNodeOfferer(page, label = "node-channel", options = {}) {
  await page.evaluate(() => window.chromeE2E.reset());
  const peerConnection = new RTCPeerConnection();
  const channel = peerConnection.createDataChannel(label, options);
  const offer = await gatherLocalDescription(peerConnection, await peerConnection.createOffer());
  const answer = await page.evaluate(
    (remoteOffer) => window.chromeE2E.acceptOffer(remoteOffer),
    offer,
  );
  await peerConnection.setRemoteDescription(answer);
  await waitForOpen(channel);
  await page.waitForFunction(() => window.chromeE2E.snapshot().primaryState === "open", null, {
    timeout: DEFAULT_TIMEOUT,
  });
  return { channel, peerConnection };
}

async function connectChromeOfferer(page, label = "chrome-channel", options = {}) {
  await page.evaluate(() => window.chromeE2E.reset());
  const peerConnection = new RTCPeerConnection();
  const channelPromise = waitFor(peerConnection, "datachannel").then(({ channel }) => channel);
  const offer = await page.evaluate(
    ({ channelLabel, channelOptions }) =>
      window.chromeE2E.createOffer(channelLabel, channelOptions),
    { channelLabel: label, channelOptions: options },
  );
  await peerConnection.setRemoteDescription(offer);
  const answer = await gatherLocalDescription(peerConnection, await peerConnection.createAnswer());
  await page.evaluate((remoteAnswer) => window.chromeE2E.acceptAnswer(remoteAnswer), answer);
  const channel = await channelPromise;
  await waitForOpen(channel);
  await page.waitForFunction(() => window.chromeE2E.snapshot().primaryState === "open", null, {
    timeout: DEFAULT_TIMEOUT,
  });
  return { channel, peerConnection };
}

async function closePair(page, peerConnection) {
  try {
    peerConnection?.close();
  } catch {}
  try {
    await page.evaluate(() => window.chromeE2E.reset());
  } catch {}
}

module.exports = {
  DEFAULT_TIMEOUT,
  RTCPeerConnection,
  binarySignature,
  bytesOf,
  closePair,
  collectStrings,
  connectChromeOfferer,
  connectNodeOfferer,
  createChromeE2EContext,
  gatherLocalDescription,
  iceUfrag,
  waitFor,
  waitForMessage,
  waitForOpen,
};
