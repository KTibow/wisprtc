import { WispBuffer } from "./packet";

class EmptyPayload {
  constructor(_config?: any) {}
  static parse(_buffer?: WispBuffer): EmptyPayload {
    return new EmptyPayload();
  }
  serialize(): WispBuffer {
    return new WispBuffer(0);
  }
}

type Role = "client" | "server";

interface ExtensionConfig {
  server_config?: any;
  client_config?: any;
}

export class BaseExtension {
  static id = 0x00;
  static name = "";

  static Server = EmptyPayload;
  static Client = EmptyPayload;

  id: number;
  name: string;
  payload: any;

  constructor({ server_config, client_config }: ExtensionConfig = {}) {
    this.id = (this.constructor as typeof BaseExtension).id;
    this.name = (this.constructor as typeof BaseExtension).name;
    if (server_config)
      this.payload = new (this.constructor as typeof BaseExtension).Server(
        server_config,
      );
    else if (client_config)
      this.payload = new (this.constructor as typeof BaseExtension).Client(
        client_config,
      );
  }

  static parse(
    ext_class: typeof BaseExtension,
    buffer: WispBuffer,
    role: Role,
  ): BaseExtension {
    let extension = new ext_class({});
    if (role === "client") {
      extension.payload = ext_class.Client.parse(buffer.slice(5));
    } else if (role === "server") {
      extension.payload = ext_class.Server.parse(buffer.slice(5));
    } else {
      throw new TypeError("invalid role");
    }
    return extension;
  }

  serialize(): WispBuffer {
    let buffer = new WispBuffer(5);
    let payload_buffer = this.payload.serialize();
    buffer.view.setInt8(0, (this.constructor as typeof BaseExtension).id);
    buffer.view.setUint32(1, payload_buffer.size, true);
    return buffer.concat(payload_buffer);
  }
}

export class UDPExtension extends BaseExtension {
  static override id = 0x01;
  static override name = "UDP";
}

export class MOTDExtension extends BaseExtension {
  static override id = 0x04;
  static override name = "Server MOTD";

  static override Server = class {
    message: string;

    constructor({ message }: { message: string }) {
      this.message = message;
    }
    static parse(
      buffer: WispBuffer,
    ): InstanceType<typeof MOTDExtension.Server> {
      return new MOTDExtension.Server({
        message: buffer.get_string(),
      });
    }
    serialize(): WispBuffer {
      return new WispBuffer(this.message);
    }
  };

  static override Client = EmptyPayload;
}

export function parse_extensions(
  payload_buffer: WispBuffer,
  valid_extensions: (typeof BaseExtension)[],
  role: Role,
): BaseExtension[] {
  let index = 0;
  let parsed_extensions: BaseExtension[] = [];
  while (payload_buffer.size) {
    let ext_id = payload_buffer.view.getUint8(index);
    let ext_len = payload_buffer.view.getUint32(index + 1, true);
    let ext_payload = payload_buffer.slice(0, 5 + ext_len);
    let ext_class: typeof BaseExtension | undefined;
    for (let extension of valid_extensions) {
      if (extension.id !== ext_id) continue;
      ext_class = extension;
      break;
    }
    if (ext_class) {
      let ext_parsed = BaseExtension.parse(ext_class, ext_payload, role);
      parsed_extensions.push(ext_parsed);
    }
    payload_buffer = payload_buffer.slice(5 + ext_len);
  }
  return parsed_extensions;
}

export function serialize_extensions(extensions: BaseExtension[]): WispBuffer {
  let ext_buffer = new WispBuffer(0);
  for (let extension of extensions) {
    ext_buffer = ext_buffer.concat(extension.serialize());
  }
  return ext_buffer;
}
