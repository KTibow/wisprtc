import * as logging from "../logging";
import * as filter from "./filter";
import {
  AsyncRTCDataChannel,
  type CompatibleRTCDataChannel,
} from "../datachannel";
import { crypto } from "../compat";
import { NodeTCPSocket, NodeUDPSocket } from "./net";
import {
  WispBuffer,
  WispPacket,
  ContinuePayload,
  ClosePayload,
  ConnectPayload,
  DataPayload,
  InfoPayload,
  stream_types,
  close_reasons,
} from "../packet";
import { options } from "./options";
import {
  BaseExtension,
  MOTDExtension,
  UDPExtension,
  serialize_extensions,
  parse_extensions,
} from "../extensions";
import { PassThrough } from "node:stream";

class HandshakeError extends Error {}

interface Socket extends AsyncIterable<Buffer> {
  hostname: string;
  port: number;
  connect(): Promise<void>;
  send(data: Buffer): Promise<void>;
  close(): Promise<void>;
}

class ServerStream {
  static buffer_size = 128;

  stream_id: number;
  conn: ServerConnection;
  socket: Socket;
  clientToTarget: PassThrough;
  packets_sent: number;
  closed: boolean;

  constructor(stream_id: number, conn: ServerConnection, socket: Socket) {
    this.stream_id = stream_id;
    this.conn = conn;
    this.socket = socket;

    // Object-mode stream acts as our local buffer for client->target data.
    this.clientToTarget = new PassThrough({
      objectMode: true,
      highWaterMark: ServerStream.buffer_size,
    });

    this.packets_sent = 0;
    this.closed = false;
  }

  async setup(): Promise<void> {
    await this.socket.connect();

    // Start the proxy tasks in the background
    this.tcp_to_ws().catch((error) => {
      logging.error(
        `(${this.conn.conn_id}) a tcp/udp to ws task encountered an error - ${error}`,
      );
      this.close();
    });

    this.ws_to_tcp().catch((error) => {
      logging.error(
        `(${this.conn.conn_id}) a ws to tcp/udp task encountered an error - ${error}`,
      );
      this.close();
    });
  }

  // Target (TCP/UDP) -> WebRTC data channel
  async tcp_to_ws(): Promise<void> {
    let totalBytes = 0;
    let packetCount = 0;
    for await (const data of this.socket) {
      totalBytes += data.length;
      packetCount++;

      const packet = new WispPacket({
        type: DataPayload.type,
        stream_id: this.stream_id,
        payload: new DataPayload({
          data: new WispBuffer(new Uint8Array(data)),
        }),
      });

      await this.conn.ws.send(packet);
    }

    // Underlying socket ended gracefully
    await this.conn.close_stream(this.stream_id, close_reasons.Voluntary);
  }

  // WebRTC data channel -> target (TCP/UDP)
  async ws_to_tcp(): Promise<void> {
    let totalBytes = 0;
    for await (const data of this.clientToTarget as AsyncIterable<Uint8Array>) {
      totalBytes += data.length;
      await this.socket.send(Buffer.from(data));

      this.packets_sent++;
      if (this.packets_sent % (ServerStream.buffer_size / 2) !== 0) {
        continue;
      }

      // Mirror the old flow-control semantics: tell the client how much
      // space is left in our local buffer.
      const buffer_remaining =
        ServerStream.buffer_size - this.clientToTarget.readableLength;

      const packet = new WispPacket({
        type: ContinuePayload.type,
        stream_id: this.stream_id,
        payload: new ContinuePayload({
          buffer_remaining,
        }),
      });
      this.conn.ws.send(packet);
    }

    await this.close();
  }

  async close(reason: number | null = null): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    // Stop accepting new data from the client for this stream
    this.clientToTarget.end();

    await this.socket.close();

    if (reason == null) return;

    const packet = new WispPacket({
      type: ClosePayload.type,
      stream_id: this.stream_id,
      payload: new ClosePayload({
        reason,
      }),
    });
    await this.conn.ws.send(packet);
  }

  // Enqueue data coming from the client into the object-mode stream.
  put_data(data: Uint8Array): void {
    this.clientToTarget.write(data);
  }
}

interface ServerConnectionOptions {
  TCPSocket?: typeof NodeTCPSocket;
  UDPSocket?: typeof NodeUDPSocket;
  ping_interval?: number;
  wisp_version?: number;
  wisp_extensions?: BaseExtension[] | null;
}

export class ServerConnection {
  ws: AsyncRTCDataChannel;
  path: string;
  TCPSocket: typeof NodeTCPSocket;
  UDPSocket: typeof NodeUDPSocket;
  ping_interval: number;
  wisp_version: number;
  wisp_extensions: BaseExtension[] | null;
  ping_task: NodeJS.Timeout | null;
  streams: Record<number, ServerStream>;
  conn_id: string;
  server_exts: Record<number, any>;
  client_exts: Record<number, any>;

  constructor(
    ws: CompatibleRTCDataChannel,
    path: string,
    {
      TCPSocket,
      UDPSocket,
      ping_interval,
      wisp_version,
      wisp_extensions,
    }: ServerConnectionOptions = {},
  ) {
    this.ws = new AsyncRTCDataChannel(ws);
    this.path = path;
    this.TCPSocket = TCPSocket || NodeTCPSocket;
    this.UDPSocket = UDPSocket || NodeUDPSocket;
    this.ping_interval = ping_interval || 30;
    this.wisp_version = wisp_version || 1;
    this.wisp_extensions = wisp_extensions ?? null;

    this.ping_task = null;
    this.streams = {};
    this.conn_id = crypto.randomUUID().split("-")[0];

    this.server_exts = {};
    this.client_exts = {};

    if (this.wisp_version === 2 && this.wisp_extensions === null) {
      this.add_extensions();
    }
  }

  add_extensions(): void {
    this.wisp_extensions = [];
    if (options.allow_udp_streams)
      this.wisp_extensions.push(new UDPExtension({ server_config: {} }));
    if (options.wisp_motd)
      this.wisp_extensions.push(
        new MOTDExtension({
          server_config: {
            message: options.wisp_motd,
          },
        }),
      );
  }

  async setup(): Promise<void> {
    logging.info(
      `setting up new wisp v${this.wisp_version} connection with id ${this.conn_id}`,
    );

    await this.ws.connect();
    if (this.wisp_version == 2) {
      await this.setup_wisp_v2();
    }

    // Send initial continue packet
    let continue_packet = new WispPacket({
      type: ContinuePayload.type,
      stream_id: 0,
      payload: new ContinuePayload({
        buffer_remaining: ServerStream.buffer_size,
      }),
    });
    this.ws.send(continue_packet);
  }

  async setup_wisp_v2(): Promise<void> {
    // Send initial info packet for wisp v2
    let ext_buffer = serialize_extensions(this.wisp_extensions!);
    let info_packet = new WispPacket({
      type: InfoPayload.type,
      stream_id: 0,
      payload: new InfoPayload({
        major_ver: this.wisp_version,
        minor_ver: 0,
        extensions: ext_buffer,
      }),
    });
    this.ws.send(info_packet);

    // Wait for the client's info packet
    let data = await this.ws.recv();
    if (data == null) {
      logging.warn(
        `(${this.conn_id}) handshake error: ws closed before handshake complete`,
      );
      await this.cleanup();
      throw new HandshakeError();
    }
    let buffer = new WispBuffer(new Uint8Array(data));
    let packet = WispPacket.parse_all(buffer);

    if (packet.type !== InfoPayload.type) {
      logging.warn(
        `(${this.conn_id}) handshake error: unexpected packet of type ${packet.type}`,
      );
      await this.cleanup();
      throw new HandshakeError();
    }

    // Figure out the common extensions
    let client_extensions = parse_extensions(
      packet.payload.extensions,
      this.wisp_extensions!.map((e) => e.constructor as typeof BaseExtension),
      "client",
    );
    for (let client_ext of client_extensions) {
      for (let server_ext of this.wisp_extensions!) {
        if (server_ext.id === client_ext.id) {
          this.server_exts[server_ext.id] = server_ext;
          this.client_exts[client_ext.id] = client_ext;
        }
      }
    }
  }

  create_stream(
    stream_id: number,
    type: number,
    hostname: string,
    port: number,
  ): void {
    let SocketImpl =
      type === stream_types.TCP ? this.TCPSocket : this.UDPSocket;
    let socket = new SocketImpl(hostname, port) as Socket;
    let stream = new ServerStream(stream_id, this, socket);
    this.streams[stream_id] = stream;

    // Start connecting to the destination server in the background
    (async () => {
      let close_reason = await filter.is_stream_allowed(
        this,
        type,
        hostname,
        port,
      );
      if (close_reason) {
        logging.warn(
          `(${this.conn_id}) refusing to create a stream to ${hostname}:${port}`,
        );
        await this.close_stream(stream_id, close_reason, true);
        return;
      }
      try {
        await stream.setup();
      } catch (error) {
        logging.warn(
          `(${this.conn_id}) creating a stream to ${hostname}:${port} failed - ${error}`,
        );
        await this.close_stream(stream_id, close_reasons.NetworkError);
      }
    })();
  }

  async close_stream(
    stream_id: number,
    reason: number | null = null,
    quiet: boolean = false,
  ): Promise<void> {
    let stream = this.streams[stream_id];
    if (stream == null) {
      return;
    }
    if (reason && !quiet) {
      logging.info(
        `(${this.conn_id}) closing stream to ${stream.socket.hostname} for reason ${reason}`,
      );
    }
    await stream.close(reason);
    delete this.streams[stream_id];
  }

  route_packet(buffer: WispBuffer): void {
    let packet = WispPacket.parse_all(buffer);
    let stream = this.streams[packet.stream_id];

    if (stream == null && packet.type == DataPayload.type) {
      logging.warn(
        `(${this.conn_id}) received a DATA packet for a stream which doesn't exist`,
      );
      return;
    }

    if (packet.type === ConnectPayload.type) {
      let type_info =
        packet.payload.stream_type === stream_types.TCP ? "TCP" : "UDP";
      logging.info(
        `(${this.conn_id}) opening new ${type_info} stream to ${packet.payload.hostname}:${packet.payload.port}`,
      );
      this.create_stream(
        packet.stream_id,
        packet.payload.stream_type,
        packet.payload.hostname.trim(),
        packet.payload.port,
      );
    } else if (packet.type === DataPayload.type) {
      stream!.put_data(packet.payload.data.bytes);
    } else if (packet.type == ContinuePayload.type) {
      logging.warn(
        `(${this.conn_id}) client sent a CONTINUE packet, this should never be possible`,
      );
    } else if (packet.type == ClosePayload.type) {
      this.close_stream(packet.stream_id, packet.payload.reason);
    }
  }

  async run(): Promise<void> {
    for await (const data of this.ws) {
      try {
        this.route_packet(new WispBuffer(data));
      } catch (error) {
        logging.warn(`(${this.conn_id}) routing a packet failed - ${error}`);
      }
    }

    await this.cleanup();
  }

  async cleanup(): Promise<void> {
    // Clean up all streams when the websocket is closed
    for (let stream_id of Object.keys(this.streams)) {
      await this.close_stream(Number(stream_id));
    }
    if (this.ping_task) {
      clearInterval(this.ping_task);
    }
    logging.info(`(${this.conn_id}) wisp connection closed`);
    this.ws.close();
  }
}
