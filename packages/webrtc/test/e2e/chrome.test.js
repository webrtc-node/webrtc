"use strict";

const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const {
  DEFAULT_TIMEOUT,
  RTCPeerConnection,
  binarySignature,
  bytesOf,
  closePair,
  collectStrings,
  connectChromeOfferer,
  connectChromeOffererTrickle,
  connectNodeOfferer,
  connectNodeOffererTrickle,
  createChromeE2EContext,
  gatherLocalDescription,
  iceUfrag,
  waitFor,
  waitForMessage,
  waitForOpen,
} = require("./chrome-harness");

let context;

before(async () => {
  context = await createChromeE2EContext();
  console.log(`Chrome ${context.browser.version()}`);
});

after(async () => {
  await context?.close();
});

async function withPage(callback) {
  const page = await context.newPage();
  try {
    return await callback(page);
  } finally {
    await page.close();
  }
}

async function closeChannelGracefully(page, channel) {
  if (channel.readyState !== "closed") {
    const closePromise = waitFor(channel, "close");
    channel.close();
    await closePromise;
  }
  await page.waitForFunction(() => window.chromeE2E.snapshot().primaryState === "closed", null, {
    timeout: DEFAULT_TIMEOUT,
  });
}

test("Node offerer interoperates with Chrome for text, binary, and close", async () => {
  await withPage(async (page) => {
    const { channel, peerConnection } = await connectNodeOfferer(page);
    channel.binaryType = "arraybuffer";
    try {
      channel.send("node-to-chrome");
      await page.waitForFunction(
        () => window.chromeE2E.snapshot().strings.includes("node-to-chrome"),
        null,
        { timeout: DEFAULT_TIMEOUT },
      );

      const nodeBytes = [0, 1, 2, 127, 128, 253, 254, 255];
      channel.send(Uint8Array.from(nodeBytes));
      await page.waitForFunction(
        (length) => window.chromeE2E.snapshot().binaries.some((value) => value.length === length),
        nodeBytes.length,
        { timeout: DEFAULT_TIMEOUT },
      );

      const textPromise = waitForMessage(channel, (data) => data === "chrome-to-node");
      await page.evaluate(() => window.chromeE2E.sendString("chrome-to-node"));
      assert.equal(await textPromise, "chrome-to-node");

      const chromeBytes = [9, 8, 7, 6, 5, 4, 3, 2, 1];
      const binaryPromise = waitForMessage(
        channel,
        (data) => typeof data !== "string" && data.byteLength === chromeBytes.length,
      );
      await page.evaluate((value) => window.chromeE2E.sendBinary(value), chromeBytes);
      assert.deepEqual(bytesOf(await binaryPromise), chromeBytes);

      channel.close();
      await page.waitForFunction(
        () => window.chromeE2E.snapshot().primaryState === "closed",
        null,
        { timeout: DEFAULT_TIMEOUT },
      );
    } finally {
      await closePair(page, peerConnection);
    }
  });
});

test("Chrome offerer interoperates with Node for text, binary, and close", async () => {
  await withPage(async (page) => {
    const { channel, peerConnection } = await connectChromeOfferer(page);
    channel.binaryType = "arraybuffer";
    try {
      const textPromise = waitForMessage(channel, (data) => data === "chrome-offerer");
      await page.evaluate(() => window.chromeE2E.sendString("chrome-offerer"));
      assert.equal(await textPromise, "chrome-offerer");

      channel.send("node-answerer");
      await page.waitForFunction(
        () => window.chromeE2E.snapshot().strings.includes("node-answerer"),
        null,
        { timeout: DEFAULT_TIMEOUT },
      );

      const closePromise = waitFor(channel, "close");
      await page.evaluate(() => window.chromeE2E.closePrimary());
      await closePromise;
      assert.equal(channel.readyState, "closed");
    } finally {
      await closePair(page, peerConnection);
    }
  });
});

test("negotiated channels and reliability options match Chrome", async () => {
  await withPage(async (page) => {
    await page.evaluate(() => {
      window.chromeE2E.reset();
      window.chromeE2E.prepareNegotiated({
        label: "negotiated",
        negotiated: true,
        id: 42,
        protocol: "neg-v1",
      });
    });
    const peerConnection = new RTCPeerConnection();
    let dataChannelEvents = 0;
    peerConnection.addEventListener("datachannel", () => {
      dataChannelEvents += 1;
    });
    const channel = peerConnection.createDataChannel("negotiated", {
      negotiated: true,
      id: 42,
      protocol: "neg-v1",
    });
    try {
      const offer = await gatherLocalDescription(
        peerConnection,
        await peerConnection.createOffer(),
      );
      const answer = await page.evaluate(
        (remoteOffer) => window.chromeE2E.acceptOfferExisting(remoteOffer),
        offer,
      );
      await peerConnection.setRemoteDescription(answer);
      await waitForOpen(channel);
      const snapshot = await page.evaluate(() => window.chromeE2E.snapshot());
      assert.equal(channel.id, 42);
      assert.equal(channel.negotiated, true);
      assert.equal(snapshot.channels[0].id, 42);
      assert.equal(snapshot.channels[0].negotiated, true);
      assert.equal(dataChannelEvents, 0);
      assert.equal(snapshot.dataChannelEvents, 0);
    } finally {
      await closePair(page, peerConnection);
    }
  });

  await withPage(async (page) => {
    const nodePair = await connectNodeOfferer(page, "node-unordered", {
      ordered: false,
      maxRetransmits: 0,
      protocol: "unordered-r0",
    });
    try {
      const snapshot = await page.evaluate(() => window.chromeE2E.snapshot());
      assert.deepEqual(
        {
          ordered: snapshot.channels[0].ordered,
          maxRetransmits: snapshot.channels[0].maxRetransmits,
          maxPacketLifeTime: snapshot.channels[0].maxPacketLifeTime,
          protocol: snapshot.channels[0].protocol,
        },
        {
          ordered: false,
          maxRetransmits: 0,
          maxPacketLifeTime: null,
          protocol: "unordered-r0",
        },
      );
    } finally {
      await closePair(page, nodePair.peerConnection);
    }
  });

  await withPage(async (page) => {
    const chromePair = await connectChromeOfferer(page, "chrome-lifetime", {
      ordered: false,
      maxPacketLifeTime: 500,
      protocol: "unordered-life",
    });
    try {
      assert.deepEqual(
        {
          ordered: chromePair.channel.ordered,
          maxRetransmits: chromePair.channel.maxRetransmits,
          maxPacketLifeTime: chromePair.channel.maxPacketLifeTime,
          protocol: chromePair.channel.protocol,
        },
        {
          ordered: false,
          maxRetransmits: null,
          maxPacketLifeTime: 500,
          protocol: "unordered-life",
        },
      );
    } finally {
      await closePair(page, chromePair.peerConnection);
    }
  });
});

test("Unicode and ordered bursts preserve message contents", async () => {
  await withPage(async (page) => {
    const { channel, peerConnection } = await connectNodeOfferer(page, "messages");
    try {
      const nodeUnicode = "Node -> Chrome: Istanbul, 你好, مرحبا, 👩🏽‍💻, e\u0301, nul:\u0000:end";
      channel.send(nodeUnicode);
      await page.waitForFunction(
        (expected) => window.chromeE2E.snapshot().strings.includes(expected),
        nodeUnicode,
        { timeout: DEFAULT_TIMEOUT },
      );

      const chromeUnicode = "Chrome -> Node: Καλημέρα, 日本語, 🚀, café, nul:\u0000:end";
      const unicodePromise = waitForMessage(channel, (data) => data === chromeUnicode);
      await page.evaluate((value) => window.chromeE2E.sendString(value), chromeUnicode);
      assert.equal(await unicodePromise, chromeUnicode);

      const count = 250;
      const nodeExpected = Array.from(
        { length: count },
        (_, index) => `N:${String(index).padStart(4, "0")}`,
      );
      for (const value of nodeExpected) channel.send(value);
      await page.waitForFunction(
        ({ prefix, expectedCount }) =>
          window.chromeE2E.snapshot().strings.filter((value) => value.startsWith(prefix)).length ===
          expectedCount,
        { prefix: "N:", expectedCount: count },
        { timeout: DEFAULT_TIMEOUT },
      );
      const nodeReceivedByChrome = (
        await page.evaluate(() => window.chromeE2E.snapshot())
      ).strings.filter((value) => value.startsWith("N:"));
      assert.deepEqual(nodeReceivedByChrome, nodeExpected);

      const chromeExpected = Array.from(
        { length: count },
        (_, index) => `B:${String(index).padStart(4, "0")}`,
      );
      const burstPromise = collectStrings(channel, count, "B:");
      await page.evaluate(
        ({ prefix, messageCount }) => window.chromeE2E.sendStringBurst(prefix, messageCount),
        { prefix: "B:", messageCount: count },
      );
      assert.deepEqual(await burstPromise, chromeExpected);
    } finally {
      await closePair(page, peerConnection);
    }
  });
});

test("Node enforces and Chrome interoperates at the negotiated message-size boundary", async () => {
  await withPage(async (page) => {
    const { channel, peerConnection } = await connectNodeOfferer(page, "message-size");
    channel.binaryType = "arraybuffer";
    try {
      const snapshot = await page.evaluate(() => window.chromeE2E.snapshot());
      const limit = snapshot.maxMessageSize;
      assert.equal(limit, 262144);
      assert.equal(peerConnection.sctp.maxMessageSize, limit);

      const payload = new Uint8Array(limit);
      for (let index = 0; index < payload.length; index += 1) payload[index] = index % 251;
      const expected = binarySignature(payload);

      channel.send(payload);
      await page.waitForFunction(
        (signature) =>
          window.chromeE2E.snapshot().binaries.some(
            (value) =>
              JSON.stringify(value) ===
              JSON.stringify({
                kind: "ArrayBuffer",
                ...signature,
              }),
          ),
        expected,
        { timeout: DEFAULT_TIMEOUT },
      );

      const reversePromise = waitForMessage(
        channel,
        (data) => typeof data !== "string" && data.byteLength === limit,
      );
      await page.evaluate((size) => window.chromeE2E.sendLarge(size), limit);
      assert.deepEqual(binarySignature(await reversePromise), expected);

      assert.throws(
        () => channel.send(new Uint8Array(limit + 1)),
        (error) => error instanceof TypeError,
      );
    } finally {
      await closePair(page, peerConnection);
    }
  });
});

test("Blob conversion, bufferedAmount drain, and send-then-close interoperate", async () => {
  await withPage(async (page) => {
    const { channel, peerConnection } = await connectNodeOfferer(page, "blob");
    channel.binaryType = "blob";
    try {
      const chromeBytes = [9, 8, 7, 6, 5];
      const blobPromise = waitForMessage(channel, (data) => data instanceof Blob);
      await page.evaluate((value) => window.chromeE2E.sendBinaryAsBlob(value), chromeBytes);
      const blob = await blobPromise;
      assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], chromeBytes);
    } finally {
      await closePair(page, peerConnection);
    }
  });

  await withPage(async (page) => {
    const { channel, peerConnection } = await connectNodeOfferer(page, "buffered");
    channel.binaryType = "arraybuffer";
    try {
      const count = 512;
      const size = 8192;
      channel.bufferedAmountLowThreshold = 1;
      const lowPromise = waitFor(channel, "bufferedamountlow", () => true, 60000);
      const payload = new Uint8Array(size);
      for (let index = 0; index < count; index += 1) channel.send(payload);
      assert.equal(channel.bufferedAmount, count * size);
      await lowPromise;
      assert.equal(channel.bufferedAmount, 0);
      await page.waitForFunction(
        (expected) => window.chromeE2E.snapshot().binaries.length === expected,
        count,
        { timeout: 60000 },
      );

      let received = 0;
      const reversePromise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          channel.removeEventListener("message", onMessage);
          reject(new Error(`Timed out receiving binary burst: ${received}/${count}`));
        }, 60000);
        function onMessage({ data }) {
          if (typeof data === "string") return;
          received += 1;
          if (received !== count) return;
          clearTimeout(timer);
          channel.removeEventListener("message", onMessage);
          resolve();
        }
        channel.addEventListener("message", onMessage);
      });
      await page.evaluate(
        ({ messageCount, messageSize }) =>
          window.chromeE2E.sendBinaryBurst(messageCount, messageSize),
        { messageCount: count, messageSize: size },
      );
      await reversePromise;
      await page.waitForFunction(
        () => {
          const state = window.chromeE2E.snapshot();
          return state.bufferedAmountLow && state.bufferedAmount === 0;
        },
        null,
        { timeout: 60000 },
      );
    } finally {
      await closePair(page, peerConnection);
    }
  });

  await withPage(async (page) => {
    const { channel, peerConnection } = await connectNodeOfferer(page, "send-close");
    try {
      channel.send("node-last-message");
      channel.close();
      await page.waitForFunction(
        () => {
          const state = window.chromeE2E.snapshot();
          return state.strings.includes("node-last-message") && state.primaryState === "closed";
        },
        null,
        { timeout: DEFAULT_TIMEOUT },
      );
    } finally {
      await closePair(page, peerConnection);
    }
  });

  await withPage(async (page) => {
    const { channel, peerConnection } = await connectNodeOfferer(page, "chrome-send-close");
    try {
      const messagePromise = waitForMessage(channel, (data) => data === "chrome-last-message");
      const closePromise = waitFor(channel, "close");
      await page.evaluate(() => window.chromeE2E.sendAndClose("chrome-last-message"));
      await messagePromise;
      await closePromise;
      assert.equal(channel.readyState, "closed");
    } finally {
      await closePair(page, peerConnection);
    }
  });
});

test("multiple channels keep matching stream identifiers", async () => {
  await withPage(async (page) => {
    const { channel, peerConnection } = await connectNodeOfferer(page, "primary");
    const extraChannels = [];
    try {
      for (let index = 0; index < 8; index += 1) {
        extraChannels.push(peerConnection.createDataChannel(`extra-${index}`));
      }
      await Promise.all(extraChannels.map(waitForOpen));
      await page.waitForFunction(() => window.chromeE2E.snapshot().channelCount === 9, null, {
        timeout: DEFAULT_TIMEOUT,
      });
      const nodeIds = [channel, ...extraChannels].map((value) => value.id);
      const chromeIds = (await page.evaluate(() => window.chromeE2E.snapshot())).channelIds;
      assert.equal(new Set(nodeIds).size, 9);
      assert.deepEqual(chromeIds, nodeIds);
    } finally {
      for (const extraChannel of extraChannels) extraChannel.close();
      await closePair(page, peerConnection);
    }
  });
});

test("ICE restart remains live when initiated by either peer", async () => {
  await withPage(async (page) => {
    const { channel, peerConnection } = await connectNodeOfferer(page, "node-restart");
    try {
      const oldUfrag = iceUfrag(peerConnection.localDescription);
      peerConnection.restartIce();
      const offer = await gatherLocalDescription(
        peerConnection,
        await peerConnection.createOffer(),
      );
      assert.equal(iceUfrag(offer), oldUfrag);
      const answer = await page.evaluate(
        (remoteOffer) => window.chromeE2E.acceptRenegotiation(remoteOffer),
        offer,
      );
      await peerConnection.setRemoteDescription(answer);

      const messagePromise = waitForMessage(channel, (data) => data === "after-node-restart");
      await page.evaluate(() => window.chromeE2E.sendString("after-node-restart"));
      await messagePromise;
      assert.equal(channel.readyState, "open");
    } finally {
      await closePair(page, peerConnection);
    }
  });

  await withPage(async (page) => {
    const { channel, peerConnection } = await connectChromeOfferer(page, "chrome-restart");
    try {
      const oldUfrag = iceUfrag(peerConnection.remoteDescription);
      const offer = await page.evaluate(() => window.chromeE2E.createRestartOffer());
      assert.notEqual(iceUfrag(offer), oldUfrag);
      await peerConnection.setRemoteDescription(offer);
      const answer = await gatherLocalDescription(
        peerConnection,
        await peerConnection.createAnswer(),
      );
      await page.evaluate((remoteAnswer) => window.chromeE2E.acceptAnswer(remoteAnswer), answer);

      const messagePromise = waitForMessage(channel, (data) => data === "after-chrome-restart");
      await page.evaluate(() => window.chromeE2E.sendString("after-chrome-restart"));
      await messagePromise;
      assert.equal(channel.readyState, "open");
    } finally {
      await closePair(page, peerConnection);
    }
  });
});

test("Chrome closure propagates to Node", async () => {
  await withPage(async (page) => {
    const { channel, peerConnection } = await connectNodeOfferer(page, "close");
    try {
      const closePromise = waitFor(channel, "close");
      await page.evaluate(() => window.chromeE2E.closePeer());
      await closePromise;
      assert.equal(channel.readyState, "closed");
    } finally {
      peerConnection.close();
    }
  });
});

test("mixed channel modes remain stable in one Node process", async () => {
  await withPage(async (page) => {
    await page.evaluate(() => {
      window.chromeE2E.reset();
      window.chromeE2E.prepareNegotiated({
        label: "mixed-negotiated",
        negotiated: true,
        id: 42,
      });
    });
    const peerConnection = new RTCPeerConnection();
    const channel = peerConnection.createDataChannel("mixed-negotiated", {
      negotiated: true,
      id: 42,
    });
    try {
      const offer = await gatherLocalDescription(
        peerConnection,
        await peerConnection.createOffer(),
      );
      const answer = await page.evaluate(
        (remoteOffer) => window.chromeE2E.acceptOfferExisting(remoteOffer),
        offer,
      );
      await peerConnection.setRemoteDescription(answer);
      await waitForOpen(channel);
    } finally {
      await closePair(page, peerConnection);
    }
  });

  await withPage(async (page) => {
    const { channel, peerConnection } = await connectNodeOfferer(page, "mixed-retransmits", {
      ordered: false,
      maxRetransmits: 0,
    });
    try {
      channel.send("unreliable");
      await page.waitForFunction(
        () => window.chromeE2E.snapshot().strings.includes("unreliable"),
        null,
        { timeout: DEFAULT_TIMEOUT },
      );
    } finally {
      await closePair(page, peerConnection);
    }
  });

  await withPage(async (page) => {
    const { channel, peerConnection } = await connectChromeOfferer(page, "mixed-lifetime", {
      ordered: false,
      maxPacketLifeTime: 500,
    });
    try {
      const messagePromise = waitForMessage(channel, (data) => data === "lifetime");
      await page.evaluate(() => window.chromeE2E.sendString("lifetime"));
      await messagePromise;
    } finally {
      await closePair(page, peerConnection);
    }
  });

  await withPage(async (page) => {
    const { channel, peerConnection } = await connectNodeOfferer(page, "mixed-buffered");
    channel.binaryType = "blob";
    try {
      const blobPromise = waitForMessage(channel, (data) => data instanceof Blob);
      await page.evaluate(() => window.chromeE2E.sendBinaryAsBlob([1, 3, 5, 7, 9]));
      assert.deepEqual(
        [...new Uint8Array(await (await blobPromise).arrayBuffer())],
        [1, 3, 5, 7, 9],
      );

      channel.bufferedAmountLowThreshold = 1;
      const lowPromise = waitFor(channel, "bufferedamountlow");
      const payload = new Uint8Array(4096);
      for (let index = 0; index < 64; index += 1) channel.send(payload);
      await lowPromise;
      assert.equal(channel.bufferedAmount, 0);
      await page.waitForFunction(() => window.chromeE2E.snapshot().binaries.length === 64, null, {
        timeout: DEFAULT_TIMEOUT,
      });
    } finally {
      await closePair(page, peerConnection);
    }
  });

  await withPage(async (page) => {
    const { channel, peerConnection } = await connectNodeOfferer(page, "mixed-ordinary");
    try {
      const messagePromise = waitForMessage(channel, (data) => data === "ordinary-after-mixed");
      await page.evaluate(() => window.chromeE2E.sendString("ordinary-after-mixed"));
      assert.equal(await messagePromise, "ordinary-after-mixed");
    } finally {
      await closePair(page, peerConnection);
    }
  });
});

test("candidate-by-candidate trickle ICE interoperates in both offerer directions", async () => {
  await withPage(async (page) => {
    const pair = await connectNodeOffererTrickle(page);
    try {
      assert.doesNotMatch(pair.offer.sdp, /^a=candidate:/m);
      assert.doesNotMatch(pair.answer.sdp, /^a=candidate:/m);
      assert.ok(pair.candidateCounts.nodeCandidateCount > 0);
      assert.ok(pair.candidateCounts.chromeCandidateCount > 0);

      const messagePromise = waitForMessage(pair.channel, (data) => data === "node-trickle-open");
      await page.evaluate(() => window.chromeE2E.sendString("node-trickle-open"));
      assert.equal(await messagePromise, "node-trickle-open");
    } finally {
      await closePair(page, pair.peerConnection);
    }
  });

  await withPage(async (page) => {
    const pair = await connectChromeOffererTrickle(page);
    try {
      assert.doesNotMatch(pair.offer.sdp, /^a=candidate:/m);
      assert.doesNotMatch(pair.answer.sdp, /^a=candidate:/m);
      assert.ok(pair.candidateCounts.nodeCandidateCount > 0);
      assert.ok(pair.candidateCounts.chromeCandidateCount > 0);

      pair.channel.send("chrome-trickle-open");
      await page.waitForFunction(
        () => window.chromeE2E.snapshot().strings.includes("chrome-trickle-open"),
        null,
        { timeout: DEFAULT_TIMEOUT },
      );
    } finally {
      await closePair(page, pair.peerConnection);
    }
  });
});

test("20 alternating offerer negotiations remain stable", async () => {
  for (let index = 0; index < 20; index += 1) {
    await withPage(async (page) => {
      const offerer = index % 2 === 0 ? "Node" : "Chrome";
      let pair;
      try {
        pair =
          offerer === "Node"
            ? await connectNodeOfferer(page, `cycle-${index}`)
            : await connectChromeOfferer(page, `cycle-${index}`);
        const expected = `cycle-${index}`;
        const messagePromise = waitForMessage(pair.channel, (data) => data === expected);
        await page.evaluate((value) => window.chromeE2E.sendString(value), expected);
        await messagePromise;
      } catch (error) {
        error.message = `Cycle ${index + 1}/20 (${offerer} offerer): ${error.message}`;
        throw error;
      } finally {
        if (pair) {
          await closeChannelGracefully(page, pair.channel);
          await closePair(page, pair.peerConnection);
        }
      }
    });
  }
});
