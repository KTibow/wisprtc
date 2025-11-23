export const options = {
  // Destination hostname restrictions
  hostname_blacklist: null as RegExp[] | null,
  hostname_whitelist: null as RegExp[] | null,
  port_blacklist: null as (number | [number, number])[] | null,
  port_whitelist: null as (number | [number, number])[] | null,
  allow_direct_ip: true,
  allow_private_ips: false,
  allow_loopback_ips: false,

  // Client connection restrictions
  client_ip_blacklist: null as string[] | null, // not implemented!
  client_ip_whitelist: null as string[] | null, // not implemented!
  stream_limit_per_host: -1,
  stream_limit_total: -1,
  allow_udp_streams: true,
  allow_tcp_streams: true,

  // DNS options
  dns_ttl: 120,
  dns_method: "lookup" as "lookup" | "resolve" | ((hostname: string) => Promise<string>),
  dns_servers: null as string[] | null,
  dns_result_order: "verbatim" as "verbatim" | "ipv4first" | "ipv6first",

  // Misc options
  parse_real_ip: true,
  parse_real_ip_from: ["127.0.0.1"] as string[],

  // Wisp v2 options
  wisp_version: 2,
  wisp_motd: null as string | null,
};
