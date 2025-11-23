import * as logging from "../logging";
import { options } from "./options";
import { net, dgram, dns } from "../compat";
import { on } from "node:events";
import type { Socket } from "node:net";
import type { Socket as DgramSocket } from "node:dgram";
import type { Resolver } from "node:dns/promises";

// Wrappers for node networking APIs
// In the browser these can be redefined to allow for custom transports

const is_node = typeof process !== "undefined";

const dns_cache = new Map<
  string,
  { time: number; address?: string; error?: any }
>();
let dns_servers: string[] | null = null;
let resolver: Resolver | null = null;

function assert_on_node(): void {
  if (!is_node) {
    throw new Error("not running on node.js");
  }
}

// Wrapper for node resolver methods
// resolve4 and resolve6 need to be wrapped to work around a nodejs bug
function resolve4(hostname: string): Promise<string[]> {
  return resolver!.resolve4(hostname);
}
function resolve6(hostname: string): Promise<string[]> {
  return resolver!.resolve6(hostname);
}

async function resolve_with_fallback(
  resolve_first: (hostname: string) => Promise<string[]>,
  resolve_after: (hostname: string) => Promise<string[]>,
  hostname: string,
): Promise<string> {
  try {
    return (await resolve_first(hostname))[0];
  } catch {
    return (await resolve_after(hostname))[0];
  }
}

// A wrapper for the actual dns lookup
async function perform_lookup(hostname: string): Promise<string> {
  // Resolve using system dns
  if (options.dns_method === "lookup") {
    let result = await dns.lookup(hostname, {
      order: options.dns_result_order,
    });
    return result.address;
  }

  // Resolve using dns.resolve4 / dns.resolve6, which bypasses the system dns
  else if (options.dns_method === "resolve") {
    // We need to make a new resolver at first run because setServers doesn't work otherwise
    if (!resolver) resolver = new dns.Resolver();

    // Set custom dns servers if needed
    if (options.dns_servers !== dns_servers) {
      logging.debug(
        "Setting custom DNS servers to: " + options.dns_servers!.join(", "),
      );
      resolver.setServers(options.dns_servers!);
      dns_servers = options.dns_servers;
    }

    if (
      options.dns_result_order === "verbatim" ||
      options.dns_result_order === "ipv6first"
    )
      return await resolve_with_fallback(resolve6, resolve4, hostname);
    else if (options.dns_result_order === "ipv4first")
      return await resolve_with_fallback(resolve4, resolve6, hostname);
    else
      throw new Error(
        "Invalid result order. options.dns_result_order must be either 'ipv6first', 'ipv4first', or 'verbatim'.",
      );
  }

  // Use a custom function for dns resolution
  else if (typeof options.dns_method === "function") {
    return await options.dns_method(hostname);
  }

  throw new Error(
    "Invalid DNS method. options.dns_method must either be 'lookup' or 'resolve'.",
  );
}

// Perform a dns lookup and use the cache
export async function lookup_ip(hostname: string): Promise<string> {
  if (!is_node) {
    // We cannot do the dns lookup on the browser
    return hostname;
  }

  let ip_level = net.isIP(hostname);
  if (ip_level === 4 || ip_level === 6) {
    return hostname; // hostname is already an ip address
  }

  // Remove stale entries from the cache
  let now = Date.now();
  for (let [entry_hostname, cache_entry] of dns_cache) {
    let ttl = now - cache_entry.time;
    if (ttl > options.dns_ttl) {
      dns_cache.delete(entry_hostname);
    }
  }

  // Look in the cache first before using the system resolver
  let cache_entry = dns_cache.get(hostname);
  if (cache_entry) {
    if (cache_entry.error) throw cache_entry.error;
    return cache_entry.address!;
  }

  // Try to perform the actual dns lookup and store the result
  let address: string;
  try {
    address = await perform_lookup(hostname);
    logging.debug(`Domain resolved: ${hostname} -> ${address}`);
    dns_cache.set(hostname, { time: Date.now(), address: address });
  } catch (e) {
    dns_cache.set(hostname, { time: Date.now(), error: e });
    throw e;
  }

  return address;
}

// Async TCP and UDP socket wrappers
export class NodeTCPSocket implements AsyncIterable<Buffer> {
  hostname: string;
  port: number;
  socket: Socket | null;
  connected: boolean;

  constructor(hostname: string, port: number) {
    assert_on_node();
    this.hostname = hostname;
    this.port = port;

    this.socket = null;
    this.connected = false;
  }

  async connect(): Promise<void> {
    const ip = await lookup_ip(this.hostname);

    await new Promise<void>((resolve, reject) => {
      const socket = new net.Socket();
      this.socket = socket;

      socket.setNoDelay(true);

      const onConnect = () => {
        this.connected = true;
        resolve();
      };

      const onError = (error: Error) => {
        logging.warn(
          `tcp stream to ${this.hostname} ended with error - ${error}`,
        );
        if (!this.connected) {
          cleanup();
          reject(error);
        }
      };

      const onClose = () => {
        this.connected = false;
        this.socket = null;
      };

      const cleanup = () => {
        socket.off("connect", onConnect);
        socket.off("error", onError);
        socket.off("close", onClose);
      };

      socket.once("connect", onConnect);
      socket.once("error", onError);
      socket.once("close", onClose);

      socket.connect({
        host: ip,
        port: this.port,
      });
    });
  }

  // Delegate async iteration to the underlying Node.js Socket,
  // which already implements AsyncIterable<Buffer>.
  [Symbol.asyncIterator](): AsyncIterator<Buffer> {
    if (!this.socket) {
      throw new Error("TCP socket not connected");
    }
    return (this.socket as any)[Symbol.asyncIterator]();
  }

  async send(data: Buffer): Promise<void> {
    if (!this.socket) {
      throw new Error("TCP socket not connected");
    }

    await new Promise<void>((resolve, reject) => {
      this.socket!.write(data, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async close(): Promise<void> {
    if (!this.socket) return;
    this.socket.end();
    this.socket = null;
    this.connected = false;
  }
}

export class NodeUDPSocket implements AsyncIterable<Buffer> {
  hostname: string;
  port: number;
  connected: boolean;
  socket: DgramSocket | null;

  constructor(hostname: string, port: number) {
    assert_on_node();
    this.hostname = hostname;
    this.port = port;

    this.connected = false;
    this.socket = null;
  }

  async connect(): Promise<void> {
    const ip = await lookup_ip(this.hostname);
    const ip_level = net.isIP(ip);

    await new Promise<void>((resolve, reject) => {
      const socket = dgram.createSocket(ip_level === 6 ? "udp6" : "udp4");
      this.socket = socket;

      socket.once("connect", () => {
        this.connected = true;
        resolve();
      });

      socket.once("error", (error: Error) => {
        logging.warn(
          `udp stream to ${this.hostname} ended with error - ${error}`,
        );
        if (!this.connected) {
          reject(error);
        }
      });

      socket.connect(this.port, ip);
    });
  }

  // Async iteration over incoming datagrams using Node's `events.on` helper.
  [Symbol.asyncIterator](): AsyncIterator<Buffer> {
    if (!this.socket) {
      throw new Error("UDP socket not connected");
    }

    const socket = this.socket;

    async function* iterate(): AsyncGenerator<Buffer, void, unknown> {
      for await (const [msg] of on(socket, "message" as const)) {
        yield msg as Buffer;
      }
    }

    return iterate();
  }

  async send(data: Buffer): Promise<void> {
    if (!this.socket) {
      throw new Error("UDP socket not connected");
    }

    await new Promise<void>((resolve, reject) => {
      this.socket!.send(data, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async close(): Promise<void> {
    if (!this.socket) return;
    this.socket.close();
    this.socket = null;
    this.connected = false;
  }
}
