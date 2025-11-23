// Shared packet parsing / serialization code

const text_encoder = new TextEncoder();
const encode_text = text_encoder.encode.bind(text_encoder);
const text_decoder = new TextDecoder();
const decode_text = text_decoder.decode.bind(text_decoder);

export class WispBuffer {
  size: number;
  bytes: Uint8Array;
  view: DataView;

  constructor(data: Uint8Array | number | string) {
    if (data instanceof Uint8Array) {
      this.from_array(data);
    } else if (typeof data === "number") {
      this.from_array(new Uint8Array(data));
    } else if (typeof data === "string") {
      this.from_array(encode_text(data));
    } else {
      console.trace();
      throw new Error("invalid data type passed to wisp buffer constructor");
    }
  }

  private from_array(bytes: Uint8Array): void {
    this.size = bytes.length;
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  concat(buffer: WispBuffer): WispBuffer {
    let new_buffer = new WispBuffer(this.size + buffer.size);
    new_buffer.bytes.set(this.bytes, 0);
    new_buffer.bytes.set(buffer.bytes, this.size);
    return new_buffer;
  }

  slice(index: number, size?: number): WispBuffer {
    let bytes_slice = this.bytes.slice(index, size);
    return new WispBuffer(bytes_slice);
  }

  get_string(): string {
    return text_decoder.decode(this.bytes);
  }
}

interface WispPacketOptions {
  type: number;
  stream_id: number;
  payload?: any;
  payload_bytes?: WispBuffer;
}

export class WispPacket {
  static min_size = 5;

  type: number;
  stream_id: number;
  payload_bytes?: WispBuffer;
  payload?: any;

  constructor({ type, stream_id, payload, payload_bytes }: WispPacketOptions) {
    this.type = type;
    this.stream_id = stream_id;
    if (payload && !payload_bytes) {
      this.payload_bytes = payload.serialize();
    } else {
      this.payload_bytes = payload_bytes;
    }
    this.payload = payload;
  }

  static parse(buffer: WispBuffer): WispPacket {
    return new WispPacket({
      type: buffer.view.getUint8(0),
      stream_id: buffer.view.getUint32(1, true),
      payload_bytes: buffer.slice(5),
    });
  }

  static parse_all(buffer: WispBuffer): WispPacket {
    if (buffer.size < WispPacket.min_size) {
      throw new TypeError("packet too small");
    }
    let packet = WispPacket.parse(buffer);
    let payload_class = packet_classes[packet.type];
    if (typeof payload_class === "undefined") {
      throw new TypeError("invalid packet type");
    }
    if (
      packet.payload_bytes &&
      packet.payload_bytes.size < (payload_class.min_size ?? 0)
    ) {
      throw new TypeError("payload too small");
    }
    packet.payload = payload_class.parse(packet.payload_bytes!);
    return packet;
  }

  serialize(): WispBuffer {
    let buffer = new WispBuffer(5);
    buffer.view.setUint8(0, this.type);
    buffer.view.setUint32(1, this.stream_id, true);
    buffer = buffer.concat(this.payload.serialize());
    return buffer;
  }
}

export class ConnectPayload {
  static min_size = 3;
  static type = 0x01;
  static name = "CONNECT";

  stream_type: number;
  port: number;
  hostname: string;

  constructor({
    stream_type,
    port,
    hostname,
  }: {
    stream_type: number;
    port: number;
    hostname: string;
  }) {
    this.stream_type = stream_type;
    this.port = port;
    this.hostname = hostname;
  }

  static parse(buffer: WispBuffer): ConnectPayload {
    return new ConnectPayload({
      stream_type: buffer.view.getUint8(0),
      port: buffer.view.getUint16(1, true),
      hostname: decode_text(buffer.slice(3).bytes),
    });
  }

  serialize(): WispBuffer {
    let buffer = new WispBuffer(3);
    buffer.view.setUint8(0, this.stream_type);
    buffer.view.setUint16(1, this.port, true);
    buffer = buffer.concat(new WispBuffer(this.hostname));
    return buffer;
  }
}

export class DataPayload {
  static min_size = 0;
  static type = 0x02;
  static name = "DATA";

  data: WispBuffer;

  constructor({ data }: { data: WispBuffer }) {
    this.data = data;
  }

  static parse(buffer: WispBuffer): DataPayload {
    return new DataPayload({
      data: buffer,
    });
  }

  serialize(): WispBuffer {
    return this.data;
  }
}

export class ContinuePayload {
  static min_size = 4;
  static type = 0x03;
  static name = "CONTINUE";

  buffer_remaining: number;

  constructor({ buffer_remaining }: { buffer_remaining: number }) {
    this.buffer_remaining = buffer_remaining;
  }

  static parse(buffer: WispBuffer): ContinuePayload {
    return new ContinuePayload({
      buffer_remaining: buffer.view.getUint32(0, true),
    });
  }

  serialize(): WispBuffer {
    let buffer = new WispBuffer(4);
    buffer.view.setUint32(0, this.buffer_remaining, true);
    return buffer;
  }
}

export class ClosePayload {
  static min_size = 1;
  static type = 0x04;
  static name = "CLOSE";

  reason: number;

  constructor({ reason }: { reason: number }) {
    this.reason = reason;
  }

  static parse(buffer: WispBuffer): ClosePayload {
    return new ClosePayload({
      reason: buffer.view.getUint8(0),
    });
  }

  serialize(): WispBuffer {
    let buffer = new WispBuffer(1);
    buffer.view.setUint8(0, this.reason);
    return buffer;
  }
}

export class InfoPayload {
  static min_size = 2;
  static type = 0x05;
  static name = "INFO";

  major_ver: number;
  minor_ver: number;
  extensions: WispBuffer;

  constructor({
    major_ver,
    minor_ver,
    extensions,
  }: {
    major_ver: number;
    minor_ver: number;
    extensions: WispBuffer;
  }) {
    this.major_ver = major_ver;
    this.minor_ver = minor_ver;
    this.extensions = extensions;
  }

  static parse(buffer: WispBuffer): InfoPayload {
    return new InfoPayload({
      major_ver: buffer.view.getUint8(0),
      minor_ver: buffer.view.getUint8(1),
      extensions: buffer.slice(2),
    });
  }

  serialize(): WispBuffer {
    let buffer = new WispBuffer(2);
    buffer.view.setUint8(0, this.major_ver);
    buffer.view.setUint8(1, this.minor_ver);
    return buffer.concat(this.extensions);
  }
}

const packet_classes: Record<
  number,
  | typeof ConnectPayload
  | typeof DataPayload
  | typeof ContinuePayload
  | typeof ClosePayload
  | typeof InfoPayload
> = {
  0x01: ConnectPayload,
  0x02: DataPayload,
  0x03: ContinuePayload,
  0x04: ClosePayload,
  0x05: InfoPayload,
};

export const stream_types = {
  TCP: 0x01,
  UDP: 0x02,
};

export const close_reasons = {
  // Client/server close reasons
  Unknown: 0x01,
  Voluntary: 0x02,
  NetworkError: 0x03,
  IncompatibleExtensions: 0x04,

  // Server only close reasons
  InvalidInfo: 0x41,
  UnreachableHost: 0x42,
  NoResponse: 0x43,
  ConnRefused: 0x44,
  TransferTimeout: 0x47,
  HostBlocked: 0x48,
  ConnThrottled: 0x49,

  // Client only close reasons
  ClientError: 0x81,

  // Extension specific close reasons
  AuthBadPassword: 0xc0,
  AuthBadSignature: 0xc1,
  AuthMissingCredentials: 0xc2,
};
