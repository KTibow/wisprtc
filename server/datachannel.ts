import { WispPacket } from "./packet";

// Compatible RTCDataChannel interface that works with both browser and werift
export interface CompatibleRTCDataChannel {
  readyState: string;
  bufferedAmount?: number;
  bufferedAmountLowThreshold?: number;
  binaryType?: string;
  send(data: ArrayBuffer | ArrayBufferView | string): void;
  close(): void;
  addEventListener?(type: string, handler: (event: any) => void): void;
  removeEventListener?(type: string, handler: (event: any) => void): void;
  onopen?: ((event: any) => void) | null;
  onclose?: ((event: any) => void) | null;
  onerror?: ((event: any) => void) | null;
  onmessage?: ((event: any) => void) | null;
  [key: string]: any;
}

/**
 * Async wrapper around an RTCDataChannel that mirrors the AsyncWebSocket helper.
 * Provides backpressure-aware send and async receive utilities with async iteration support.
 */
export class AsyncRTCDataChannel implements AsyncIterable<Uint8Array> {
  send_buffer_size = 32 * 1024 * 1024;

  channel: CompatibleRTCDataChannel;
  connected: boolean;
  private _queue: Uint8Array[];
  private _waiters: Array<(value: Uint8Array | null) => void>;
  private _closed: boolean;
  private _hasAddEventListener: boolean;
  private _bufferLowThreshold: number;
  private _openPromise: Promise<void> | null;
  private _lastError?: Error;
  private _onMessage: (event: MessageEvent) => void;
  private _onClose: () => void;
  private _onError: (event: Event | RTCErrorEvent) => void;
  private _removeMessage?: () => void;
  private _removeClose?: () => void;
  private _removeError?: () => void;

  constructor(
    channel: CompatibleRTCDataChannel,
    { bufferLowThreshold }: { bufferLowThreshold?: number } = {},
  ) {
    this.channel = channel;
    this.connected = false;
    this._queue = [];
    this._waiters = [];
    this._closed = false;

    this._hasAddEventListener = typeof channel.addEventListener === "function";
    this._bufferLowThreshold =
      typeof bufferLowThreshold === "number"
        ? bufferLowThreshold
        : this.send_buffer_size / 2;
    this._openPromise = null;

    if ("binaryType" in this.channel) {
      this.channel.binaryType = "arraybuffer";
    }
    if (
      "bufferedAmountLowThreshold" in this.channel &&
      typeof this.channel.bufferedAmountLowThreshold === "number"
    ) {
      this.channel.bufferedAmountLowThreshold = this._bufferLowThreshold;
    }

    this._onMessage = (event: MessageEvent) => {
      const waiter = this._waiters.shift();
      if (waiter) {
        waiter(event.data);
      } else {
        this._queue.push(event.data);
      }
    };

    this._onClose = () => {
      this.connected = false;
      this._closed = true;
      // Resolve all pending waiters with null
      while (this._waiters.length > 0) {
        this._waiters.shift()!(null);
      }
    };

    this._onError = (event: Event | RTCErrorEvent) => {
      const err = (event as RTCErrorEvent)?.error ?? event;
      if (!this._lastError) {
        this._lastError = err instanceof Error ? err : new Error(String(err));
      }
      if (!this.connected) {
        this._closed = true;
        while (this._waiters.length > 0) {
          this._waiters.shift()!(null);
        }
      }
    };

    this._removeMessage = this._addEventListener("message", this._onMessage);
    this._removeClose = this._addEventListener("close", this._onClose);
    this._removeError = this._addEventListener("error", this._onError);
  }

  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }
    if (this.channel.readyState === "open") {
      this.connected = true;
      return;
    }
    if (
      this.channel.readyState === "closing" ||
      this.channel.readyState === "closed"
    ) {
      throw this._lastError ?? new Error("RTCDataChannel is already closed");
    }
    if (this._openPromise) {
      return this._openPromise;
    }

    this._openPromise = new Promise((resolve, reject) => {
      const handleOpen = () => {
        cleanup();
        this.connected = true;
        resolve();
      };
      const handleClose = () => {
        cleanup();
        reject(
          this._lastError ?? new Error("RTCDataChannel closed before open"),
        );
      };
      const handleError = (event: Event | RTCErrorEvent) => {
        cleanup();
        const err = (event as RTCErrorEvent)?.error ?? event;
        reject(err instanceof Error ? err : new Error(String(err)));
      };

      const cleanup = () => {
        removeOpen();
        removeClose();
        removeError();
        this._openPromise = null;
      };

      const removeOpen = this._addEventListener("open", handleOpen);
      const removeClose = this._addEventListener("close", handleClose);
      const removeError = this._addEventListener("error", handleError);
    });

    return this._openPromise;
  }

  // Async iteration support
  async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    while (true) {
      const data = await this._getNext();
      if (data === null) break;
      yield data;
    }
  }

  // Get next message from queue or wait for one
  private async _getNext(): Promise<Uint8Array | null> {
    if (this._queue.length > 0) {
      return this._queue.shift()!;
    }
    if (this._closed) {
      return null;
    }
    return new Promise((resolve) => {
      this._waiters.push(resolve);
    });
  }

  async recv(): Promise<Uint8Array | null> {
    return this._getNext();
  }

  async send(
    data: ArrayBuffer | ArrayBufferView | string | WispPacket,
  ): Promise<void> {
    if (!this.connected && this.channel.readyState !== "open") {
      throw this._lastError ?? new Error("RTCDataChannel is not open");
    }

    if (data instanceof WispPacket) {
      this.channel.send(data.serialize().bytes);
    } else if (data instanceof ArrayBuffer) {
      this.channel.send(data);
    } else if (ArrayBuffer.isView(data)) {
      this.channel.send(data);
    } else {
      this.channel.send(data);
    }

    const buffered = this.channel.bufferedAmount;
    if (typeof buffered != "number")
      throw new Error("bufferedAmount is not a number");
    if (buffered > this.send_buffer_size) {
      await this._throttleSendBuffer();
    } else if (buffered > this._bufferLowThreshold) {
      // Wait a bit even if not at max to allow transmission
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }

  close(): void {
    if (
      this.channel.readyState !== "closing" &&
      this.channel.readyState !== "closed"
    ) {
      this.channel.close();
    }
    this._cleanup();
  }

  get buffered_amount(): number {
    return this.channel.bufferedAmount ?? 0;
  }

  private _cleanup(): void {
    this._removeMessage?.();
    this._removeClose?.();
    this._removeError?.();
    this._closed = true;
    // Clear queue and resolve all pending waiters
    this._queue = [];
    while (this._waiters.length > 0) {
      this._waiters.shift()!(null);
    }
  }

  private _addEventListener(
    type: string,
    handler: (event: any) => void,
  ): () => void {
    if (this._hasAddEventListener) {
      this.channel.addEventListener(type, handler);
      return () => {
        this.channel.removeEventListener(type, handler);
      };
    }

    const prop = `on${type}`;
    const previous = this.channel[prop];
    this.channel[prop] = (event: any) => {
      handler(event);
      if (typeof previous === "function") {
        previous.call(this.channel, event);
      }
    };
    return () => {
      this.channel[prop] = previous ?? null;
    };
  }

  private async _throttleSendBuffer(): Promise<void> {
    while (
      this.channel.readyState === "open" &&
      this.channel.bufferedAmount > this._bufferLowThreshold
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}
