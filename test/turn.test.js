const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const dgram = require("node:dgram");
const test = require("node:test");
const { RTCPeerConnection } = require("..");

function stunAttribute(type, value) {
  const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const attribute = Buffer.alloc(4 + Math.ceil(data.length / 4) * 4);
  attribute.writeUInt16BE(type, 0);
  attribute.writeUInt16BE(data.length, 2);
  data.copy(attribute, 4);
  return attribute;
}

function turnUnauthorizedResponse(request, realm, nonce) {
  const errorCode = Buffer.concat([Buffer.from([0, 0, 4, 1]), Buffer.from("Unauthorized")]);
  const attributes = Buffer.concat([
    stunAttribute(0x0009, errorCode),
    stunAttribute(0x0014, realm),
    stunAttribute(0x0015, nonce),
  ]);
  const response = Buffer.alloc(20 + attributes.length);
  response.writeUInt16BE(0x0113, 0);
  response.writeUInt16BE(attributes.length, 2);
  request.copy(response, 4, 4, 20);
  attributes.copy(response, 20);
  return response;
}

function parseStunAttributes(message) {
  const attributes = new Map();
  const end = Math.min(message.length, 20 + message.readUInt16BE(2));
  for (let offset = 20; offset + 4 <= end; ) {
    const type = message.readUInt16BE(offset);
    const length = message.readUInt16BE(offset + 2);
    const valueStart = offset + 4;
    const valueEnd = valueStart + length;
    if (valueEnd > end) break;
    attributes.set(type, {
      offset,
      value: message.subarray(valueStart, valueEnd),
    });
    offset = valueStart + Math.ceil(length / 4) * 4;
  }
  return attributes;
}

function hasValidMessageIntegrity(message, attributes, username, realm, password) {
  const integrity = attributes.get(0x0008);
  if (!integrity || integrity.value.length !== 20) return false;

  const hmacInput = Buffer.from(message.subarray(0, integrity.offset));
  hmacInput.writeUInt16BE(integrity.offset - 20 + 24, 2);
  const key = crypto.createHash("md5").update(`${username}:${realm}:${password}`).digest();
  const expected = crypto.createHmac("sha1", key).update(hmacInput).digest();
  return crypto.timingSafeEqual(integrity.value, expected);
}

test("TURN credentials are forwarded to the native ICE transport", async (t) => {
  const username = "turn-user";
  const password = "turn-password";
  const realm = "webrtc-node-test";
  const nonce = "nonce-for-test";
  const server = dgram.createSocket("udp4");

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.bind(0, "127.0.0.1", resolve);
  });

  const pc = new RTCPeerConnection({
    iceTransportPolicy: "relay",
    iceServers: [
      {
        urls: `turn:127.0.0.1:${server.address().port}`,
        username,
        credential: password,
      },
    ],
  });
  t.after(async () => {
    pc.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await new Promise((resolve) => server.close(resolve));
  });

  const authenticatedRequest = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out waiting for authenticated TURN allocation")),
      5000,
    );
    server.on("message", (message, remote) => {
      if (message.length < 20 || message.readUInt16BE(0) !== 0x0003) return;
      const attributes = parseStunAttributes(message);
      if (!attributes.has(0x0006)) {
        server.send(turnUnauthorizedResponse(message, realm, nonce), remote.port, remote.address);
        return;
      }
      clearTimeout(timer);
      resolve({ attributes, message });
    });
  });

  pc.createDataChannel("turn-probe");
  await pc.setLocalDescription(await pc.createOffer());

  const { attributes, message } = await authenticatedRequest;
  assert.equal(attributes.get(0x0006).value.toString(), username);
  assert.equal(attributes.get(0x0014).value.toString(), realm);
  assert.equal(hasValidMessageIntegrity(message, attributes, username, realm, password), true);
});
