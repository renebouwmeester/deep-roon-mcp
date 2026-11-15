/**
 * Roon remoting frame codec — ported from
 * Sooloos.Broker.Remoting.RemotingBaseProtocol (SendRequest/SendResponse/_ParseHeader).
 *
 * Frame = [header byte] [flexint rid?] [flexint bodyLength] [body].
 *
 *   header bit 0x80  -> is-response (a reply to a prior request)
 *   REQUEST  (0x80 clear): cmd = header & 0x3F; 0x40 set => expects a response
 *                          (a request-id flexint follows).
 *   RESPONSE (0x80 set):   0x40 => this is the final response chunk; a request-id
 *                          flexint (which request it answers) follows.
 *
 * cmd values (Commands): PING=1, GETSVC=2, CALL=3, GCOBJS=4, DEFTYPE=5,
 * DEFMETHOD=6, SENDMSG=7. Client-bound pushes: PUSHOBJ=3, etc.
 */
import { writeFlexInt } from './flex';

export interface Frame {
  isResponse: boolean;
  /** request command (only meaningful when !isResponse) */
  cmd: number;
  /** request id: present on responses, and on requests that expect a response */
  rid: number | null;
  /** response only: is this the final chunk */
  isFinal: boolean;
  body: Buffer;
}

/** Encode an outbound request frame. */
export function encodeRequest(cmd: number, body: Uint8Array, rid: number | null): Buffer {
  const out: number[] = [];
  if (rid !== null) {
    out.push((cmd & 0x3f) | 0x40);
    writeFlexInt(out, rid);
  } else {
    out.push(cmd & 0x3f);
  }
  writeFlexInt(out, body.length);
  return Buffer.concat([Buffer.from(out), Buffer.from(body)]);
}

/** Encode an outbound response frame (client-as-server, e.g. flush acks). */
export function encodeResponse(rid: number, body: Uint8Array, isFinal = true): Buffer {
  const out: number[] = [0x80 | (isFinal ? 0x40 : 0)];
  writeFlexInt(out, rid);
  writeFlexInt(out, body.length);
  return Buffer.concat([Buffer.from(out), Buffer.from(body)]);
}

/**
 * Incremental frame parser: feed it socket chunks, get complete frames out.
 * Handles TCP coalescing and splitting (a frame may span multiple reads, and
 * one read may contain several frames).
 */
/** The largest frame body we accept; Roon's largest real answers (a full library page, artwork) are far below. */
const MAX_FRAME = 64 * 1024 * 1024;

export class FrameParser {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Frame[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const frames: Frame[] = [];
    for (;;) {
      const parsed = this.tryParseOne();
      if (!parsed) break;
      frames.push(parsed);
    }
    return frames;
  }

  private tryParseOne(): Frame | null {
    if (this.buf.length < 2) return null;
    const u = this.buf;

    /** Bounded flex-int read: returns null if it would run past the buffer. */
    const flex = (pos: number): [number, number] | null => {
      let num = 0;
      for (;;) {
        if (pos >= u.length) return null; // incomplete header
        const b = u[pos++];
        num = (num << 7) | (b & 0x7f);
        if ((b & 0x80) === 0) break;
      }
      return [num >>> 0, pos];
    };

    let pos = 1;
    const b = u[0];
    const isResponse = (b & 0x80) !== 0;
    let cmd = 0;
    let rid: number | null = null;
    let isFinal = false;

    if (!isResponse) {
      cmd = b & 0x3f;
      if ((b & 0x40) !== 0) {
        const r = flex(pos);
        if (!r) return null;
        [rid, pos] = r;
      }
    } else {
      isFinal = (b & 0x40) !== 0;
      const r = flex(pos);
      if (!r) return null;
      [rid, pos] = r;
    }

    const lenR = flex(pos);
    if (!lenR) return null;
    const [bodyLen, bodyStart] = lenR;
    // A ceiling (15 Nov 2026): a declared length of up to 4 GB was buffered until memory ran out.
    if (bodyLen > MAX_FRAME) throw new RangeError(`malformed frame: body of ${bodyLen} bytes`);
    if (u.length < bodyStart + bodyLen) return null; // body incomplete; wait

    const frame: Frame = {
      isResponse,
      cmd,
      rid,
      isFinal,
      body: Buffer.from(u.subarray(bodyStart, bodyStart + bodyLen)),
    };
    this.buf = this.buf.subarray(bodyStart + bodyLen);
    return frame;
  }
}
