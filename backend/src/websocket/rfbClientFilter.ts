/**
 * Streaming parser for the client-to-server half of an RFB (VNC) connection.
 *
 * Each WebSocket participant in a shared session has its own RFB connection to
 * the VNC server. For participants without 'control' permission we still have to
 * forward the messages that keep their own view working (pixel format,
 * encodings, framebuffer update requests, ...) while dropping anything that acts
 * on the desktop (keyboard, pointer, clipboard, resize, power actions). Doing
 * that safely requires knowing where each message starts and ends, so this
 * class tracks the handshake and the length of every client message.
 *
 * Message layouts follow RFC 6143 plus the extensions noVNC uses
 * (see public/novnc/core/rfb.js, RFB.messages).
 */

export class RfbProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RfbProtocolError';
  }
}

type Phase = 'version' | 'security-type' | 'vnc-auth' | 'client-init' | 'messages';

const SECURITY_NONE = 1;
const SECURITY_VNC_AUTH = 2;

// Client-to-server message types
const MSG = {
  SET_PIXEL_FORMAT: 0,
  SET_ENCODINGS: 2,
  FRAMEBUFFER_UPDATE_REQUEST: 3,
  KEY_EVENT: 4,
  POINTER_EVENT: 5,
  CLIENT_CUT_TEXT: 6,
  ENABLE_CONTINUOUS_UPDATES: 150,
  CLIENT_FENCE: 248,
  SET_DESKTOP_SIZE: 251,
  XVP: 252,
  QEMU: 255,
} as const;

const QEMU_EXTENDED_KEY_EVENT = 0;
const QEMU_AUDIO = 1;

/** Messages that change the shared desktop rather than the sender's own view */
const isInputMessage = (header: Buffer): boolean => {
  switch (header[0]) {
    case MSG.KEY_EVENT:
    case MSG.POINTER_EVENT:
    case MSG.CLIENT_CUT_TEXT:
    case MSG.SET_DESKTOP_SIZE:
    case MSG.XVP:
      return true;
    case MSG.QEMU:
      return header[1] === QEMU_EXTENDED_KEY_EVENT;
    default:
      return false;
  }
};

export class RfbClientFilter {
  private phase: Phase = 'version';
  /** Bytes of the handshake step or message header currently being read */
  private header: Buffer = Buffer.alloc(0);
  /** Remaining body bytes of the current message to pass through */
  private forwardRemaining = 0;
  /** Remaining body bytes of the current message to discard */
  private dropRemaining = 0;

  /**
   * @param allowInput - consulted per message, so permission changes take effect
   *   at the next message boundary
   */
  constructor(private readonly allowInput: () => boolean) {}

  /**
   * Feed bytes received from the client. Returns the bytes that may be sent on
   * to the VNC server (possibly empty). Throws RfbProtocolError on anything the
   * parser can't frame; the connection must then be closed, since the position
   * in the stream is lost.
   */
  process(chunk: Buffer): Buffer {
    const out: Buffer[] = [];
    let offset = 0;

    for (;;) {
      if (this.forwardRemaining > 0 || this.dropRemaining > 0) {
        if (offset >= chunk.length) break;
        const available = chunk.length - offset;
        if (this.forwardRemaining > 0) {
          const n = Math.min(this.forwardRemaining, available);
          out.push(chunk.subarray(offset, offset + n));
          this.forwardRemaining -= n;
          offset += n;
        } else {
          const n = Math.min(this.dropRemaining, available);
          this.dropRemaining -= n;
          offset += n;
        }
        continue;
      }

      const needed = this.headerBytesNeeded();
      if (this.header.length < needed) {
        if (offset >= chunk.length) break;
        const n = Math.min(needed - this.header.length, chunk.length - offset);
        this.header = Buffer.concat([this.header, chunk.subarray(offset, offset + n)]);
        offset += n;
        // Re-evaluate: reading a message type can reveal a longer header
        continue;
      }

      this.completeStep(out);
    }

    return out.length === 1 ? out[0] : Buffer.concat(out);
  }

  /** Total header bytes required for the current step, given what's read so far */
  private headerBytesNeeded(): number {
    switch (this.phase) {
      case 'version':
        return 12;
      case 'security-type':
      case 'client-init':
        return 1;
      case 'vnc-auth':
        return 16;
      case 'messages':
        return this.messageHeaderLength();
    }
  }

  private messageHeaderLength(): number {
    if (this.header.length === 0) return 1;

    const type = this.header[0];
    switch (type) {
      case MSG.SET_PIXEL_FORMAT:
        return 20;
      case MSG.SET_ENCODINGS:
        return 4;
      case MSG.FRAMEBUFFER_UPDATE_REQUEST:
        return 10;
      case MSG.KEY_EVENT:
        return 8;
      case MSG.POINTER_EVENT:
        return 6;
      case MSG.CLIENT_CUT_TEXT:
        return 8;
      case MSG.ENABLE_CONTINUOUS_UPDATES:
        return 10;
      case MSG.CLIENT_FENCE:
        return 9;
      case MSG.SET_DESKTOP_SIZE:
        return 8;
      case MSG.XVP:
        return 4;
      case MSG.QEMU: {
        if (this.header.length < 2) return 2;
        const subtype = this.header[1];
        if (subtype === QEMU_EXTENDED_KEY_EVENT) return 12;
        if (subtype === QEMU_AUDIO) {
          if (this.header.length < 4) return 4;
          // Operation 2 (set format) carries sample format, channels and frequency
          return this.header.readUInt16BE(2) === 2 ? 10 : 4;
        }
        throw new RfbProtocolError(`Unsupported QEMU client message subtype ${subtype}`);
      }
      default:
        throw new RfbProtocolError(`Unsupported client message type ${type}`);
    }
  }

  /** Length of the payload that follows a complete message header */
  private static messageBodyLength(header: Buffer): number {
    switch (header[0]) {
      case MSG.SET_ENCODINGS:
        return 4 * header.readUInt16BE(2);
      case MSG.CLIENT_CUT_TEXT:
        // A negative length marks an Extended Clipboard message of |length| bytes
        return Math.abs(header.readInt32BE(4));
      case MSG.CLIENT_FENCE:
        return header[8];
      case MSG.SET_DESKTOP_SIZE:
        return 16 * header[6];
      default:
        return 0;
    }
  }

  private completeStep(out: Buffer[]): void {
    const header = this.header;
    this.header = Buffer.alloc(0);

    switch (this.phase) {
      case 'version': {
        const match = /^RFB (\d{3})\.(\d{3})\n$/.exec(header.toString('latin1'));
        if (!match) {
          throw new RfbProtocolError('Invalid RFB protocol version');
        }
        out.push(header);
        // RFB 3.3 clients don't choose a security type; the server dictates it.
        // Our VNC servers only offer "None", so a 3.3 client goes straight to ClientInit.
        const major = Number(match[1]);
        const minor = Number(match[2]);
        this.phase = major === 3 && minor < 7 ? 'client-init' : 'security-type';
        return;
      }

      case 'security-type': {
        const securityType = header[0];
        if (securityType === SECURITY_NONE) {
          this.phase = 'client-init';
        } else if (securityType === SECURITY_VNC_AUTH) {
          this.phase = 'vnc-auth';
        } else {
          throw new RfbProtocolError(`Unsupported security type ${securityType}`);
        }
        out.push(header);
        return;
      }

      case 'vnc-auth':
        out.push(header);
        this.phase = 'client-init';
        return;

      case 'client-init':
        // Always ask for a shared session, so a participant can never
        // disconnect everyone else by requesting exclusive access
        out.push(Buffer.from([1]));
        this.phase = 'messages';
        return;

      case 'messages': {
        const bodyLength = RfbClientFilter.messageBodyLength(header);
        if (!isInputMessage(header) || this.allowInput()) {
          out.push(header);
          this.forwardRemaining = bodyLength;
        } else {
          this.dropRemaining = bodyLength;
        }
        return;
      }
    }
  }
}
