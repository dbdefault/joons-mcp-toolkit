/**
 * Portable target routing policy. No private hostnames or network calls.
 * A host adapter provides isAvailable(id) and invoke(id, operation).
 */
export class HostUnavailableError extends Error {
  constructor(id) { super(`Host unavailable: ${id}`); this.name = 'HostUnavailableError'; }
}
export class UnknownDeliveryError extends Error {
  constructor(id, cause) { super(`Delivery uncertain for host: ${id}`, { cause }); this.name = 'UnknownDeliveryError'; }
}
export function createHostRouter({ hosts, isAvailable, invoke }) {
  if (!Array.isArray(hosts) || !hosts.length || new Set(hosts).size !== hosts.length ||
      hosts.some(h => typeof h !== 'string' || !h)) throw new TypeError('Unique host IDs required');
  if (typeof isAvailable !== 'function' || typeof invoke !== 'function') throw new TypeError('Host adapters required');
  return {
    async call(operation, { targetHost } = {}) {
      if (targetHost !== undefined && !hosts.includes(targetHost)) throw new HostUnavailableError(String(targetHost));
      const candidates = targetHost === undefined ? hosts : [targetHost];
      for (const host of candidates) {
        if (!await isAvailable(host)) {
          if (targetHost !== undefined) throw new HostUnavailableError(host);
          continue;
        }
        try { return await invoke(host, operation); }
        catch (error) {
          // An invocation may have reached its target. Never fall back after an attempted invoke.
          throw new UnknownDeliveryError(host, error);
        }
      }
      throw new HostUnavailableError(targetHost ?? 'all');
    }
  };
}
