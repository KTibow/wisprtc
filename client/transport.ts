import type {
  BareHeaders,
  TransferrableResponse,
  BareTransport,
} from "@mercuryworkshop/bare-mux";
import initEpoxy, {
  EpoxyClient,
  EpoxyClientOptions,
  EpoxyHandlers,
} from "@mercuryworkshop/epoxy-tls/epoxy";

// TODO: remove queue once https://github.com/MercuryWorkshop/epoxy-tls/issues/16 fixed
class RequestQueue {
  private queue: Array<() => Promise<void>> = [];
  private processing = false;

  async enqueue<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push(async () => {
        try {
          const result = await fn();
          resolve(result);
        } catch (error) {
          reject(error);
        }
      });
      this.process();
    });
  }

  private async process() {
    if (this.processing || this.queue.length === 0) return;

    this.processing = true;
    while (this.queue.length > 0) {
      const task = this.queue.shift()!;
      await task();
    }
    this.processing = false;
  }
}
const requestQueue = new RequestQueue();

export default async function createEpoxyTransport(
  dc: RTCDataChannel,
): Promise<BareTransport> {
  const { readable, writable } = new TransformStream<
    ArrayBuffer,
    ArrayBuffer
  >();
  const writer = writable.getWriter();
  dc.onmessage = async (event) => {
    const data = event.data;
    await writer.write(data);
  };
  dc.onclose = () => {
    console.log("Data channel closed");
    writer.close().catch(() => {});
  };
  dc.onerror = (error) => {
    console.error("Data channel error:", error);
    writer.abort(error).catch(() => {});
  };

  const write = new WritableStream<Uint8Array>({
    async write(chunk) {
      if (dc.readyState != "open") {
        throw new Error("Channel is not open");
      }
      dc.send(chunk.buffer);
    },
  });

  await initEpoxy();
  const options = new EpoxyClientOptions();
  options.user_agent = navigator.userAgent;
  options.wisp_v2 = true;

  const client = new EpoxyClient(() => {
    console.log("[streams] providing");
    return { read: readable, write };
  }, options);

  return {
    ready: true,
    async meta() {},
    async init() {},

    async request(
      remote: URL,
      method: string,
      body: BodyInit | null,
      headers: BareHeaders,
      signal: AbortSignal | undefined,
    ): Promise<TransferrableResponse> {
      if (body instanceof Blob) body = await body.arrayBuffer();

      return requestQueue.enqueue(async () => {
        let res = await client.fetch(remote.href, {
          method,
          body,
          headers,
          redirect: "manual",
        });
        return {
          body: res.body!,
          headers: (res as any).rawHeaders,
          status: res.status,
          statusText: res.statusText,
        };
      });
    },

    connect(
      url: URL,
      protocols: string[],
      requestHeaders: BareHeaders,
      onopen: (protocol: string) => void,
      onmessage: (data: Blob | ArrayBuffer | string) => void,
      onclose: (code: number, reason: string) => void,
      onerror: (error: string) => void,
    ): [
      (data: Blob | ArrayBuffer | string) => void,
      (code: number, reason: string) => void,
    ] {
      let handlers = new EpoxyHandlers(
        onopen,
        onclose,
        onerror,
        (data: Uint8Array | string) =>
          data instanceof Uint8Array ? onmessage(data.buffer) : onmessage(data),
      );

      let ws = client.connect_websocket(
        handlers,
        url.href,
        protocols,
        Object.assign(requestHeaders),
      );

      return [
        async (data) => {
          if (data instanceof Blob) data = await data.arrayBuffer();
          (await ws).send(data);
        },
        async (code, reason) => {
          (await ws).close(code, reason || "");
        },
      ];
    },
  };
}
