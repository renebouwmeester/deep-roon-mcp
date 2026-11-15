/**
 * RoonConnection — the transport beneath the remoting layer.
 *
 * Sequence (the ROON-magic handshake + DistributedBroker ConnectRequest live
 * below the remoting frame layer; verified working in examples/debug-flow.ts):
 *   1. TCP connect to host:9332
 *   2. ROON 0104 hello (server broker id + our random client broker id)
 *   3. <- ROON 0180 ack ; -> ROON 0102 ; <- ROON 0182 + session id
 *   4. -> ConnectRequest (a SENDMSG frame; we reuse the captured template)
 *   5. <- ConnectResponse ; thereafter all bytes are remoting frames
 *
 * After step 5, raw bytes are forwarded to whatever onData handler the
 * RemotingClient registered, and send() writes remoting frames to the socket.
 */
import * as net from 'net';
import * as crypto from 'crypto';
import { Transport } from './remoting';

const MAGIC = Buffer.from('ROON');

// ConnectRequest template (a SENDMSG frame), client broker id = XXXX...
// Captured from the official client; ProtocolVersion 28 / production branch.
const CONNECT_REQUEST_TEMPLATE =
  '470181670000000100012c536f6f6c6f6f732e4d73672e446973747269627574656442726f6b65722e436f6e6e6563745265717565737424840e436c69656e7442726f6b65724964XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX228110436c69656e7442726f6b65724e616d650000000848512d30303435321b810f50726f746f636f6c56657273696f6e0000000232383e810c50726f746f636f6c48617368000000286161656464323265326536653435323233316537346464333039666662396432376139373531656420810c436c69656e744272616e63680000000a70726f64756374696f6e05030503';

export interface ConnectionOptions {
  host: string;
  port?: number;
  /** 16-byte server broker id (from SOOD discovery / project notes). */
  serverBrokerId: Buffer;
}

export class RoonConnection implements Transport {
  private socket: net.Socket | null = null;
  private dataHandler: (chunk: Buffer) => void = () => {};
  private established = false;
  readonly clientBrokerId = crypto.randomBytes(16);

  /**
   * Fired when the socket closes for any reason (explicit close(), peer
   * disconnect, error) so the remoting layer can fail in-flight requests
   * immediately instead of waiting out their timeouts. Fires at most once per
   * socket attempt: a connect() that fails before establishment consumes its
   * own notification, and a retried connect() re-arms it.
   */
  onclosed: () => void = () => {};
  private onclosedFired = false;

  constructor(private opts: ConnectionOptions) {}

  private fireOnclosed(): void {
    if (this.onclosedFired) return;
    this.onclosedFired = true;
    this.onclosed();
  }

  onData(handler: (chunk: Buffer) => void): void {
    this.dataHandler = handler;
  }

  send(data: Buffer): void {
    if (!this.socket) throw new Error('not connected');
    this.socket.write(data);
  }

  /** Complete TCP + ROON handshake + ConnectRequest; resolves when remoting is live. */
  connect(): Promise<void> {
    const { host, port = 9332, serverBrokerId } = this.opts;
    return new Promise<void>((resolve, reject) => {
      // This class does not support reconnecting once a session has been
      // established: `established` never resets, and the remoting layer's
      // DEFMETHOD/DEFTYPE declarations and object ids are per-connection
      // anyway. Reject before touching any state (a live session stays
      // usable) instead of feeding a second handshake to the frame parser
      // and stalling until the socket timeout. Reconnect = new instance.
      if (this.established) {
        reject(
          new Error('RoonConnection cannot reconnect after an established session; create a new instance')
        );
        return;
      }
      const socket = new net.Socket();
      this.socket = socket;
      // Re-arm the once-only close notification for this attempt: a connect()
      // that failed before establishment must not consume the notification
      // that belongs to the socket we are about to open.
      this.onclosedFired = false;
      let step = 0;
      socket.setTimeout(20000);

      const fail = (e: Error) => {
        socket.destroy();
        reject(e);
      };

      socket.on('timeout', () => fail(new Error('connection timed out during handshake')));
      socket.on('error', fail);
      socket.on('close', () => {
        // A superseded attempt's socket must not clear the current socket or
        // fail its requests: only the socket we still own reports closure.
        if (this.socket !== socket) return;
        this.socket = null;
        this.fireOnclosed();
      });

      socket.on('connect', () => {
        step = 1;
        socket.write(Buffer.concat([MAGIC, Buffer.from([0x01, 0x04]), serverBrokerId, this.clientBrokerId]));
      });

      // Handshake replies are fixed-length records (lengths from wire
      // captures): the 0180 ack is 6 bytes, the 0182 reply is 22 (6-byte
      // header + 16-byte session id). TCP does not preserve those record
      // boundaries (#10), so buffer inbound bytes, consume complete records,
      // and hand any remainder to the remoting layer once established.
      const ACK_RECORD_LEN = 6; // ROON 01 80
      const SESSION_RECORD_LEN = 22; // ROON 01 82 + 16-byte session id
      let pending: Buffer = Buffer.alloc(0);

      socket.on('data', (data: Buffer) => {
        if (this.established) {
          // A malformed frame closes the connection (the reconnect takes over) instead of throwing out of 'data'.
          try { this.dataHandler(data); } catch (e) { socket.destroy(e as Error); }
          return;
        }
        pending = pending.length === 0 ? data : Buffer.concat([pending, data]);
        // Consume complete handshake records; a partial record waits for more.
        for (;;) {
          if (step === 1 || step === 2) {
            if (pending.length < ACK_RECORD_LEN) return;
            if (pending.subarray(0, 4).toString() !== 'ROON') {
              fail(new Error(`unexpected non-ROON bytes during handshake (step ${step})`));
              return;
            }
            const code = pending[5];
            if (step === 1 && code === 0x80) {
              pending = pending.subarray(ACK_RECORD_LEN);
              step = 2;
              socket.write(Buffer.concat([MAGIC, Buffer.from([0x01, 0x02])]));
              continue;
            }
            if (step === 2 && code === 0x82) {
              if (pending.length < SESSION_RECORD_LEN) return; // wait for the whole record
              pending = pending.subarray(SESSION_RECORD_LEN);
              step = 3;
              const cr = Buffer.from(
                CONNECT_REQUEST_TEMPLATE.replace(
                  'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
                  this.clientBrokerId.toString('hex')
                ),
                'hex'
              );
              socket.write(cr);
              continue;
            }
            fail(new Error(`unexpected handshake reply 0x${code.toString(16)} at step ${step}`));
            return;
          }
          if (step === 3) {
            // First bytes after our ConnectRequest are the ConnectResponse:
            // remoting is live, and everything buffered belongs to it.
            if (pending.length === 0) return;
            socket.setTimeout(0);
            this.established = true;
            const rest = pending;
            pending = Buffer.alloc(0);
            resolve();
            this.dataHandler(rest);
            return;
          }
          return; // step 0: nothing arrives before our hello is written
        }
      });

      // A clean FIN before the handshake completes fires no 'error', which
      // used to leave the promise unsettled; reject it explicitly.
      socket.on('close', () => {
        if (!this.established) reject(new Error('connection closed during handshake'));
      });

      socket.connect(port, host);
    });
  }

  close(): void {
    // Idempotent: fireOnclosed dedupes the synchronous notification here, and
    // the destroyed socket's own later 'close' event is guarded out because
    // this.socket is already null by the time it fires.
    this.socket?.destroy();
    this.socket = null;
    this.fireOnclosed();
  }
}
