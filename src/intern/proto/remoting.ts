/**
 * RemotingClient — ported from Sooloos.Broker.Remoting.RemotingClientV2.
 *
 * Sits on top of a Transport (raw frames) and provides:
 *  - getService(guid)            -> object id of a service
 *  - callMethod(oid, name, args) -> result bytes (resolves on final response)
 *  - DEFMETHOD bookkeeping: a method's signature string is declared to the
 *    server (cmd 6) the first time we use its locally-assigned method id.
 *  - request/response correlation by request id.
 *
 * Inbound requests (server pushes: PUSHOBJ/UPDATEOBJ/DEFTYPE/PING…) are handed
 * to onPush; the object-graph reader consumes those to locate service objects.
 */
import { Frame, FrameParser, encodeRequest, encodeResponse } from './frame';
import { BinaryWriter } from './writer';
import { readFlexLong } from './flex';

export const Cmd = {
  PING: 1,
  GETSVC: 2,
  CALL: 3,
  GCOBJS: 4,
  DEFTYPE: 5,
  DEFMETHOD: 6,
  SENDMSG: 7,
} as const;

export interface Transport {
  send(data: Buffer): void;
  /** Register a handler for raw inbound bytes. */
  onData(handler: (chunk: Buffer) => void): void;
}

export interface CallResult {
  /** status string from the server; 'Success' (or empty) means OK. */
  status: string;
  /** true when the call succeeded. */
  success: boolean;
  /** remaining response bytes after the status string (the return value). */
  payload: Buffer;
}

/** The server reports success with the literal status string "Success". */
export function isSuccessStatus(status: string): boolean {
  return status === 'Success' || status === '';
}

interface Pending {
  chunks: Buffer[];
  resolve: (r: Frame) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class RemotingClient {
  private parser = new FrameParser();
  private ridCounter = 0;
  private methodNameToId = new Map<string, number>();
  private nextMethodId = 1;
  private definedMethods = new Set<number>();
  private pending = new Map<number, Pending>();
  /** More patience for the library's heavy questions (issue #4, 21 Nov 2026): on a library of 322,000 tracks a search took
   *  9 s, and right after a Core update — while Roon rebuilds its index — more than the 15 s every other call gets. A
   *  dead connection is still noticed in 15 s on everything else. */
  private slowTimeoutMs = 30000
  private static slow = /UnifiedSearch|Virtual\w*Query|RetainPage|AlbumQueryInfo|Histogram/

  /** Called with every inbound request frame (server push). */
  onPush: (frame: Frame) => void = () => {};

  constructor(
    private transport: Transport,
    private requestTimeoutMs = 15000
  ) {
    transport.onData((chunk) => {
      for (const frame of this.parser.push(chunk)) this.handleFrame(frame);
    });
  }

  private nextRid(): number {
    this.ridCounter = (this.ridCounter + 1) & 0x7fffffff;
    return this.ridCounter;
  }

  /** Get (assigning if new) the local method id for a signature string. */
  methodId(signature: string): number {
    let id = this.methodNameToId.get(signature);
    if (id === undefined) {
      id = this.nextMethodId++;
      this.methodNameToId.set(signature, id);
    }
    return id;
  }

  /** DEFMETHOD on first use: declare (methodId, signature) to the server. */
  private ensureDefined(methodId: number, signature: string): void {
    if (this.definedMethods.has(methodId)) return;
    this.definedMethods.add(methodId);
    const body = new BinaryWriter().flexInt(methodId).string(signature).toBuffer();
    this.transport.send(encodeRequest(Cmd.DEFMETHOD, body, null));
  }

  // The receiver maps remote IDs to local types, but stores property mappings
  // by LOCAL type ID. Multiple schemas for one typename overwrite each other.
  private clientTypes = new Map<string, { id: number; schema: string }>();
  private nextClientTypeId = 1;

  /** Declare one immutable ordered schema per type for this session. */
  defineType(typeName: string, members: readonly { name: string; propType: number }[] = []): number {
    const schema = JSON.stringify(members.map(({ name, propType }) => [name, propType]));
    const existing = this.clientTypes.get(typeName);
    if (existing) {
      if (existing.schema !== schema) throw new Error(`incompatible schema for ${typeName}: use the full canonical schema`);
      return existing.id;
    }
    if (new Set(members.map((m) => m.name)).size !== members.length) {
      throw new Error(`duplicate members in schema for ${typeName}`);
    }
    const id = this.nextClientTypeId++;
    const w = new BinaryWriter().flexInt(id).string(typeName).flexInt(members.length);
    for (const m of members) w.string(m.name).integer(m.propType);
    this.transport.send(encodeRequest(Cmd.DEFTYPE, w.toBuffer(), null));
    this.clientTypes.set(typeName, { id, schema });
    return id;
  }

  /** Low-level: send a request that expects a response; resolves with the final frame. */
  private request(cmd: number, body: Buffer, timeoutMs = this.requestTimeoutMs): Promise<Frame> {
    const rid = this.nextRid();
    return new Promise<Frame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(rid);
        reject(new Error(`remoting request ${rid} (cmd ${cmd}) timed out`));
      }, timeoutMs);
      this.pending.set(rid, { chunks: [], resolve, reject, timer });
      try {
        this.transport.send(encodeRequest(cmd, body, rid));
      } catch (err) {
        // Dead transport (e.g. after close): fail now instead of leaking the
        // pending entry until its timeout fires.
        clearTimeout(timer);
        this.pending.delete(rid);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * A keepalive round trip (added 8 Oct 2026): the Core reaps a session that sent nothing for ~30–35 s ("no keepalive
   * … reaping dead peer" in RoonServer_log); it answers a PING with an empty response.
   */
  ping(): Promise<void> {
    return this.request(Cmd.PING, Buffer.alloc(0)).then(() => undefined);
  }

  /**
   * Fail every in-flight request immediately and clear the pending table.
   * Mirrors node-roon-api's moo.clean_up(): called when the connection closes
   * so callers get a prompt rejection instead of waiting out the request
   * timeout. Idempotent — safe to call from both the explicit close() path
   * and the socket 'close' event.
   */
  failPending(reason = 'connection closed'): void {
    for (const [rid, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`remoting request ${rid} failed: ${reason}`));
    }
    this.pending.clear();
  }

  /**
   * Call a method on an object. `signature` is the full DEFMETHOD string
   * (build with formatMethodSignature). `args` is the pre-serialized argument
   * block. Returns the parsed status + return-value bytes.
   */
  async callMethod(objectId: bigint | number, signature: string, args: Buffer): Promise<CallResult> {
    const mid = this.methodId(signature);
    this.ensureDefined(mid, signature);
    const body = new BinaryWriter().long(objectId).flexInt(mid).bytes(args).toBuffer();
    const frame = await this.request(Cmd.CALL, body, RemotingClient.slow.test(signature) ? this.slowTimeoutMs : this.requestTimeoutMs);
    return this.parseCallResult(frame.body);
  }

  /** Fire-and-forget call (no ResultCallback param). */
  callMethodNoReply(objectId: bigint | number, signature: string, args: Buffer): void {
    const mid = this.methodId(signature);
    this.ensureDefined(mid, signature);
    const body = new BinaryWriter().long(objectId).flexInt(mid).bytes(args).toBuffer();
    this.transport.send(encodeRequest(Cmd.CALL, body, null));
  }

  /** GETSVC: resolve a service GUID to its object id. */
  async getService(guid16: Uint8Array): Promise<bigint> {
    const body = new BinaryWriter().guid(guid16).toBuffer();
    const frame = await this.request(Cmd.GETSVC, body);
    // response = string(status) + flexLong(objectId)
    const res = this.parseCallResult(frame.body);
    if (!res.success) throw new Error(`getService failed: ${res.status}`);
    const [oid] = readFlexLong(Uint8Array.from(res.payload), 0);
    return oid;
  }

  /** A response body begins with a status string ('' = Success). */
  private parseCallResult(body: Buffer): CallResult {
    const u = Uint8Array.from(body);
    // string = flexInt(len) then bytes; len -1 (0xFFFFFFFF) means null.
    let pos = 0;
    let num = 0;
    for (;;) {
      const b = u[pos++];
      num = (num << 7) | (b & 0x7f);
      if ((b & 0x80) === 0) break;
    }
    const len = num >>> 0;
    let status = '';
    if (len === 0xffffffff) {
      status = '';
    } else {
      status = Buffer.from(u.subarray(pos, pos + len)).toString('utf8');
      pos += len;
    }
    return { status, success: isSuccessStatus(status), payload: Buffer.from(u.subarray(pos)) };
  }

  private handleFrame(frame: Frame): void {
    if (frame.isResponse) {
      const p = frame.rid !== null ? this.pending.get(frame.rid) : undefined;
      if (!p) return; // unknown/late response
      p.chunks.push(frame.body);
      if (frame.isFinal) {
        clearTimeout(p.timer);
        this.pending.delete(frame.rid!);
        const joined =
          p.chunks.length === 1 ? frame.body : Buffer.concat([...p.chunks]);
        p.resolve({ ...frame, body: joined });
      }
      return;
    }
    // Inbound request from the server.
    if (frame.cmd === Cmd.PING) {
      // reply to keep-alive: empty final response to the ping's rid
      if (frame.rid !== null) this.transport.send(encodeResponse(frame.rid, Buffer.alloc(0)));
      return;
    }
    this.onPush(frame);
    // Requests that expect a response (rid present) must be acked.
    if (frame.rid !== null && frame.cmd !== Cmd.PING) {
      this.transport.send(encodeResponse(frame.rid, Buffer.alloc(0)));
    }
  }
}
