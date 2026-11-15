/**
 * BinaryReader — read half of Sooloos.Broker.Remoting.RemotingUtils.
 * Mirrors writer.ts; used to deserialize server frames and object fields.
 */
export class BinaryReader {
  pos = 0;
  constructor(public buf: Uint8Array) {}

  get remaining(): number {
    return this.buf.length - this.pos;
  }

  /** Never past the end, never backwards (15 Nov 2026): lengths and counts come from the wire. A negative length moved
   *  the cursor back (a loop that never ends), and reads past the end returned zeros (billions of empty members) — all
   *  inside the socket's data handler. Now a malformed frame throws, and the connection closes and reconnects. */
  private need(n: number): void {
    if (!Number.isInteger(n) || n < 0 || this.pos + n > this.buf.length) throw new RangeError(`malformed frame: ${n} bytes at ${this.pos} of ${this.buf.length}`);
  }

  flexInt(): number {
    let num = 0;
    for (;;) {
      this.need(1);
      const b = this.buf[this.pos++];
      num = (num << 7) | (b & 0x7f);
      if ((b & 0x80) === 0) break;
    }
    return num >>> 0;
  }

  /** ReadInteger == ReadFlexInt, but lengths use -1 as a sentinel: interpret as signed. */
  integer(): number {
    const u = this.flexInt();
    return u | 0; // signed 32-bit (0xFFFFFFFF -> -1)
  }

  flexLong(): bigint {
    let num = 0n;
    for (;;) {
      this.need(1);
      const b = this.buf[this.pos++];
      num = (num << 7n) | BigInt(b & 0x7f);
      if ((b & 0x80) === 0) break;
    }
    return num;
  }

  long(): bigint {
    return this.flexLong();
  }

  boolean(): boolean {
    this.need(1);
    return this.buf[this.pos++] !== 0;
  }

  bytes(n: number): Buffer {
    this.need(n);
    const b = Buffer.from(this.buf.subarray(this.pos, this.pos + n));
    this.pos += n;
    return b;
  }

  guid(): Buffer {
    return this.bytes(16);
  }

  double(): number {
    this.need(8);
    const v = Buffer.from(this.buf.subarray(this.pos, this.pos + 8)).readDoubleLE(0);
    this.pos += 8;
    return v;
  }

  float(): number {
    this.need(4);
    const v = Buffer.from(this.buf.subarray(this.pos, this.pos + 4)).readFloatLE(0);
    this.pos += 4;
    return v;
  }

  char(): number {
    return this.integer();
  }

  dateTime(): bigint {
    return this.long(); // .NET DateTime.FromBinary(long); we keep the raw int64
  }

  /** ReadSooid: integer(len) + len bytes. */
  sooid(): Buffer {
    const len = this.integer();
    return this.bytes(len);
  }

  /** ReadString: integer(len); -1 -> null, else len utf8 bytes. */
  string(): string | null {
    const len = this.integer();
    if (len < 0) return null;
    this.need(len);
    const s = Buffer.from(this.buf.subarray(this.pos, this.pos + len)).toString('utf8');
    this.pos += len;
    return s;
  }

  /** ReadByteArray: integer(len); -1 -> null, else len bytes. */
  byteArray(): Buffer | null {
    const len = this.integer();
    if (len < 0) return null;
    return this.bytes(len);
  }

  // --- optionals ---
  optionalInteger(): number | null {
    return this.boolean() ? this.integer() : null;
  }
  optionalLong(): bigint | null {
    return this.boolean() ? this.long() : null;
  }
  optionalBoolean(): boolean | null {
    const b = this.buf[this.pos++];
    return b === 0 ? false : b === 1 ? true : null;
  }
  optionalGuid(): Buffer | null {
    return this.boolean() ? this.guid() : null;
  }
  optionalSooid(): Buffer | null {
    const len = this.integer();
    return len < 0 ? null : this.bytes(len);
  }
  optionalDouble(): number | null {
    return this.boolean() ? this.double() : null;
  }
  optionalFloat(): number | null {
    return this.boolean() ? this.float() : null;
  }
  optionalChar(): number | null {
    return this.boolean() ? this.char() : null;
  }
  optionalDateTime(): bigint | null {
    return this.optionalLong();
  }
}
