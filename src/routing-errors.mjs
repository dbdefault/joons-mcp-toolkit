/** Shared routing error types for the core router and legacy host-router facade. */

export class HostUnavailableError extends Error {
  constructor(id) {
    super(`Host unavailable: ${id}`);
    this.name = 'HostUnavailableError';
  }
}

export class UnknownDeliveryError extends Error {
  constructor(id, cause) {
    super(`Delivery uncertain for host: ${id}`, { cause });
    this.name = 'UnknownDeliveryError';
  }
}
