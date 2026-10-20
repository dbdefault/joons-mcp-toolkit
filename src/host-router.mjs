/**
 * Compatibility facade over createRouter.
 * Preserves the original createHostRouter({ hosts, isAvailable, invoke }) contract:
 * any invoke error is treated as uncertain delivery (no fallback), matching legacy behavior.
 */
import { createRouter } from './router.mjs';
import { HostUnavailableError, UnknownDeliveryError } from './routing-errors.mjs';

export { HostUnavailableError, UnknownDeliveryError };

export function createHostRouter({ hosts, isAvailable, invoke }) {
  if (!Array.isArray(hosts) || !hosts.length || new Set(hosts).size !== hosts.length ||
      hosts.some((h) => typeof h !== 'string' || !h)) {
    throw new TypeError('Unique host IDs required');
  }
  if (typeof isAvailable !== 'function' || typeof invoke !== 'function') {
    throw new TypeError('Host adapters required');
  }

  // Fresh requestId per call so core dedupe never collapses legacy call() invocations.
  let callSeq = 0;
  // Original invoke error retained for UnknownDeliveryError.cause (phase forced for the core).
  let lastInvokeError = null;

  const routerHosts = hosts.map((id, index) => ({
    id,
    priority: index,
    isAvailable: () => isAvailable(id),
    async send(operation) {
      try {
        return await invoke(id, operation);
      } catch (error) {
        lastInvokeError = error;
        // Legacy path: every invoke failure is uncertain delivery — never before_send fallback.
        const bridge = new Error(error?.message ?? 'invoke failed');
        bridge.phase = 'after_send';
        throw bridge;
      }
    },
  }));

  const core = createRouter({ hosts: routerHosts });

  return {
    async call(operation, { targetHost } = {}) {
      lastInvokeError = null;
      callSeq += 1;
      const requestId = `host-router:${callSeq}`;

      const result = await core.route({
        requestId,
        request: operation,
        target: targetHost,
      });

      if (result.status === 'SUCCEEDED') {
        return result.value;
      }

      if (result.status === 'UNKNOWN') {
        const hostId = result.host ?? String(targetHost ?? 'unknown');
        throw new UnknownDeliveryError(hostId, lastInvokeError);
      }

      // FAILED: unregistered target, unavailable explicit host, or all pre-send failures.
      if (targetHost !== undefined && !hosts.includes(targetHost)) {
        throw new HostUnavailableError(String(targetHost));
      }
      if (targetHost !== undefined) {
        throw new HostUnavailableError(targetHost);
      }
      throw new HostUnavailableError('all');
    },
  };
}
