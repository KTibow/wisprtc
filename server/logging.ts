const DEBUG = 0;
const INFO = 1;
const WARN = 2;
const ERROR = 3;
// const NONE = 4;

let log_level = DEBUG;

function get_timestamp(): string {
  let [date, time] = new Date().toJSON().split("T");
  date = date.replaceAll("-", "/");
  time = time.split(".")[0];
  return `[${date} - ${time}]`;
}

export function debug(...messages: any[]): void {
  if (log_level > DEBUG) return;
  console.debug(get_timestamp() + " debug:", ...messages);
}

export function info(...messages: any[]): void {
  if (log_level > INFO) return;
  console.info(get_timestamp() + " info:", ...messages);
}

export function warn(...messages: any[]): void {
  if (log_level > WARN) return;
  console.warn(get_timestamp() + " warn:", ...messages);
}

export function error(...messages: any[]): void {
  if (log_level > ERROR) return;
  console.error(get_timestamp() + " error:", ...messages);
}
