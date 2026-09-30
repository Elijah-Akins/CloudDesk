import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { RfbClientFilter, RfbProtocolError } from '../src/websocket/rfbClientFilter';

// --- RFB client message builders (layouts per RFC 6143 / noVNC) ---

const version = (v = 'RFB 003.008\n') => Buffer.from(v, 'latin1');
const securityNone = () => Buffer.from([1]);
const clientInit = (shared: 0 | 1) => Buffer.from([shared]);

const setPixelFormat = () => {
  const b = Buffer.alloc(20);
  b[0] = 0;
  b[4] = 32; // bits-per-pixel
  b[5] = 24; // depth
  return b;
};

const setEncodings = (encodings: number[]) => {
  const b = Buffer.alloc(4 + 4 * encodings.length);
  b[0] = 2;
  b.writeUInt16BE(encodings.length, 2);
  encodings.forEach((e, i) => b.writeInt32BE(e, 4 + 4 * i));
  return b;
};

const fbUpdateRequest = () => {
  const b = Buffer.alloc(10);
  b[0] = 3;
  b[1] = 1;
  b.writeUInt16BE(1920, 6);
  b.writeUInt16BE(1080, 8);
  return b;
};

const keyEvent = (keysym = 0x61) => {
  const b = Buffer.alloc(8);
  b[0] = 4;
  b[1] = 1;
  b.writeUInt32BE(keysym, 4);
  return b;
};

const pointerEvent = () => Buffer.from([5, 1, 0, 10, 0, 20]);

const clientCutText = (text: string) => {
  const data = Buffer.from(text, 'latin1');
  const b = Buffer.alloc(8);
  b[0] = 6;
  b.writeInt32BE(data.length, 4);
  return Buffer.concat([b, data]);
};

const extendedClipboard = (payload: Buffer) => {
  const b = Buffer.alloc(8);
  b[0] = 6;
  b.writeInt32BE(-payload.length, 4);
  return Buffer.concat([b, payload]);
};

const enableContinuousUpdates = () => Buffer.from([150, 1, 0, 0, 0, 0, 7, 128, 4, 56]);

const clientFence = (payload: string) => {
  const b = Buffer.alloc(9);
  b[0] = 248;
  b.writeUInt32BE(0x80000000, 4);
  b[8] = payload.length;
  return Buffer.concat([b, Buffer.from(payload, 'latin1')]);
};

const setDesktopSize = () => {
  const b = Buffer.alloc(24);
  b[0] = 251;
  b.writeUInt16BE(1280, 2);
  b.writeUInt16BE(720, 4);
  b[6] = 1; // number-of-screens
  return b;
};

const xvp = () => Buffer.from([252, 0, 1, 2]);

const qemuKeyEvent = () => {
  const b = Buffer.alloc(12);
  b[0] = 255;
  b[1] = 0;
  b.writeUInt16BE(1, 2);
  b.writeUInt32BE(0x61, 4);
  b.writeUInt32BE(30, 8);
  return b;
};

const handshake = () => Buffer.concat([version(), securityNone(), clientInit(1)]);

/** Feed a stream through a filter one byte at a time */
const feedBytewise = (filter: RfbClientFilter, stream: Buffer): Buffer =>
  Buffer.concat([...stream].map((byte) => filter.process(Buffer.from([byte]))));

describe('RfbClientFilter', () => {
  test('passes a control participant\'s stream through unchanged', () => {
    const stream = Buffer.concat([
      handshake(),
      setPixelFormat(),
      setEncodings([7, 1, 0, -223]),
      fbUpdateRequest(),
      keyEvent(),
      pointerEvent(),
      clientCutText('hello'),
      setDesktopSize(),
      qemuKeyEvent(),
    ]);

    const out = new RfbClientFilter(() => true).process(stream);

    assert.deepEqual(out, stream);
  });

  test('drops desktop-changing messages from view-only participants but keeps their view working', () => {
    const viewMessages = [
      setPixelFormat(),
      setEncodings([7, 1, 0]),
      fbUpdateRequest(),
      enableContinuousUpdates(),
      clientFence('ab'),
    ];
    const inputMessages = [
      keyEvent(),
      pointerEvent(),
      clientCutText('secret'),
      extendedClipboard(Buffer.from([0, 0, 0, 1, 0x10, 0x20])),
      setDesktopSize(),
      xvp(),
      qemuKeyEvent(),
    ];
    const stream = Buffer.concat([
      handshake(),
      viewMessages[0],
      inputMessages[0],
      viewMessages[1],
      inputMessages[1],
      inputMessages[2],
      viewMessages[2],
      inputMessages[3],
      inputMessages[4],
      viewMessages[3],
      inputMessages[5],
      inputMessages[6],
      viewMessages[4],
    ]);

    const out = new RfbClientFilter(() => false).process(stream);

    assert.deepEqual(out, Buffer.concat([handshake(), ...viewMessages]));
  });

  test('frames messages correctly however the stream is chunked', () => {
    const stream = Buffer.concat([
      handshake(),
      setEncodings([7, 1]),
      keyEvent(),
      extendedClipboard(Buffer.alloc(300, 0x41)),
      fbUpdateRequest(),
      qemuKeyEvent(),
      clientFence('xyz'),
      pointerEvent(),
    ]);

    const whole = new RfbClientFilter(() => false).process(stream);
    const bytewise = feedBytewise(new RfbClientFilter(() => false), stream);

    assert.deepEqual(bytewise, whole);
    assert.deepEqual(whole, Buffer.concat([handshake(), setEncodings([7, 1]), fbUpdateRequest(), clientFence('xyz')]));
  });

  test('applies permission changes at the next message boundary', () => {
    let canControl = false;
    const filter = new RfbClientFilter(() => canControl);

    assert.deepEqual(filter.process(Buffer.concat([handshake(), keyEvent(0x61)])), handshake());

    canControl = true;
    assert.deepEqual(filter.process(keyEvent(0x62)), keyEvent(0x62));

    canControl = false;
    assert.deepEqual(filter.process(pointerEvent()), Buffer.alloc(0));
  });

  test('decides on a message once its header is complete, even if permissions change mid-message', () => {
    let canControl = true;
    const filter = new RfbClientFilter(() => canControl);
    filter.process(handshake());

    const message = clientCutText('0123456789');
    const first = filter.process(message.subarray(0, 10)); // header + 2 body bytes
    canControl = false;
    const rest = filter.process(message.subarray(10));

    assert.deepEqual(Buffer.concat([first, rest]), message);
  });

  test('forces the shared flag so a participant cannot take exclusive access', () => {
    const out = new RfbClientFilter(() => true).process(Buffer.concat([version(), securityNone(), clientInit(0)]));

    assert.deepEqual(out, Buffer.concat([version(), securityNone(), clientInit(1)]));
  });

  test('handles RFB 3.3 clients, which send no security type', () => {
    const stream = Buffer.concat([version('RFB 003.003\n'), clientInit(1), keyEvent(), fbUpdateRequest()]);

    const out = new RfbClientFilter(() => false).process(stream);

    assert.deepEqual(out, Buffer.concat([version('RFB 003.003\n'), clientInit(1), fbUpdateRequest()]));
  });

  test('passes the VNC authentication response through', () => {
    const authResponse = Buffer.alloc(16, 0x7f);
    const stream = Buffer.concat([version(), Buffer.from([2]), authResponse, clientInit(1), fbUpdateRequest()]);

    const out = new RfbClientFilter(() => false).process(stream);

    assert.deepEqual(out, stream);
  });

  test('rejects an invalid protocol version', () => {
    assert.throws(
      () => new RfbClientFilter(() => true).process(Buffer.from('GET / HTTP/1.1\r\n')),
      RfbProtocolError
    );
  });

  test('rejects unsupported security types', () => {
    const filter = new RfbClientFilter(() => true);
    assert.throws(() => filter.process(Buffer.concat([version(), Buffer.from([19])])), RfbProtocolError);
  });

  test('rejects unknown message types rather than guessing their length', () => {
    const filter = new RfbClientFilter(() => false);
    filter.process(handshake());
    assert.throws(() => filter.process(Buffer.from([99, 0, 0, 0])), RfbProtocolError);
  });

  test('discards a huge dropped message without buffering it', () => {
    const filter = new RfbClientFilter(() => false);
    filter.process(handshake());

    const header = Buffer.alloc(8);
    header[0] = 6;
    header.writeInt32BE(-(64 * 1024 * 1024), 4);

    assert.equal(filter.process(header).length, 0);
    for (let i = 0; i < 64; i++) {
      assert.equal(filter.process(Buffer.alloc(1024 * 1024)).length, 0);
    }
    // The stream is back in sync afterwards
    assert.deepEqual(filter.process(fbUpdateRequest()), fbUpdateRequest());
  });
});
