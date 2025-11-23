import { close_reasons, stream_types } from "../packet";
import { options } from "./options";
import * as net from "./net";
import ipaddr from "ipaddr.js";

// Helper functions for the whitelist/blacklist logic
function check_port_range(
  entry: number | [number, number],
  port: number,
): boolean {
  return Array.isArray(entry)
    ? entry[0] <= port && entry[1] >= port
    : entry === port;
}

function check_whitelist<T>(
  entries: T[],
  filter: (entry: T) => boolean,
): boolean {
  let matched = false;
  for (let entry of entries) {
    if (filter(entry)) {
      matched = true;
      break;
    }
  }
  return !matched;
}

function check_blacklist<T>(
  entries: T[],
  filter: (entry: T) => boolean,
): boolean {
  for (let entry of entries) {
    if (filter(entry)) return true;
  }
  return false;
}

type IPRange =
  | "loopback"
  | "unspecified"
  | "broadcast"
  | "linkLocal"
  | "carrierGradeNat"
  | "private"
  | "reserved";

function check_ip_range(
  ip: ipaddr.IPv4 | ipaddr.IPv6,
  range: IPRange[],
): boolean {
  return range.some((r) => ip.range() === r);
}

// Check if an ip is blocked
function is_ip_blocked(ip_str: string): boolean {
  if (!ipaddr.isValid(ip_str)) return false;
  let ip = ipaddr.parse(ip_str);

  let loopback_ranges: IPRange[] = ["loopback", "unspecified"];
  let private_ranges: IPRange[] = [
    "broadcast",
    "linkLocal",
    "carrierGradeNat",
    "private",
    "reserved",
  ];

  if (!options.allow_loopback_ips && check_ip_range(ip, loopback_ranges))
    return true;
  if (!options.allow_private_ips && check_ip_range(ip, private_ranges))
    return true;
  return false;
}

// Returns the close reason if the connection should be blocked
export async function is_stream_allowed(
  connection: any,
  type: number,
  hostname: string,
  port: number,
): Promise<number> {
  // Check if tcp or udp should be blocked
  if (!options.allow_tcp_streams && type === stream_types.TCP)
    return close_reasons.HostBlocked;
  if (!options.allow_udp_streams && type === stream_types.UDP)
    return close_reasons.HostBlocked;

  // Check the hostname whitelist/blacklist
  if (options.hostname_whitelist) {
    if (
      check_whitelist(options.hostname_whitelist, (entry) =>
        entry.test(hostname),
      )
    )
      return close_reasons.HostBlocked;
  } else if (options.hostname_blacklist) {
    if (
      check_blacklist(options.hostname_blacklist, (entry) =>
        entry.test(hostname),
      )
    )
      return close_reasons.HostBlocked;
  }

  // Check if the port is blocked
  if (options.port_whitelist) {
    if (
      check_whitelist(options.port_whitelist, (entry) =>
        check_port_range(entry, port),
      )
    )
      return close_reasons.HostBlocked;
  } else if (options.port_blacklist) {
    if (
      check_blacklist(options.port_blacklist, (entry) =>
        check_port_range(entry, port),
      )
    )
      return close_reasons.HostBlocked;
  }

  // Check if the destination ip is blocked
  let ip_str = hostname;
  if (ipaddr.isValid(hostname)) {
    if (!options.allow_direct_ip) return close_reasons.HostBlocked;
  } else {
    try {
      // Look up the ip to make sure that the resolved address is allowed
      ip_str = await net.lookup_ip(hostname);
    } catch {}
  }
  if (is_ip_blocked(ip_str)) return close_reasons.HostBlocked;

  // Don't check stream counts if there isn't an associated wisp connection (with wsproxy for example)
  if (!connection) return 0;

  // Check for stream count limits
  if (
    options.stream_limit_total !== -1 &&
    Object.keys(connection.streams).length >= options.stream_limit_total
  )
    return close_reasons.ConnThrottled;
  if (options.stream_limit_per_host !== -1) {
    let streams_per_host = 0;
    for (let stream of Object.values(connection.streams) as any[]) {
      if (stream.socket.hostname === hostname) {
        streams_per_host++;
      }
    }
    if (streams_per_host >= options.stream_limit_per_host)
      return close_reasons.ConnThrottled;
  }

  return 0;
}
