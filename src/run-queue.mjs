const NOOP_LOGGER = {
  info() {},
  warn() {},
  error() {},
};

export function createRunQueue({
  maxConcurrent,
  maxQueuePerScope = 20,
  execute,
  logger = NOOP_LOGGER,
}) {
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new Error('maxConcurrent must be a positive integer');
  }
  if (!Number.isInteger(maxQueuePerScope) || maxQueuePerScope < 0) {
    throw new Error('maxQueuePerScope must be a non-negative integer');
  }
  if (typeof execute !== 'function') {
    throw new Error('execute must be a function');
  }

  const active = new Map();
  const pending = new Map();
  const queues = new Map();
  const waiters = [];
  let activeCount = 0;
  let closed = false;

  async function acquire() {
    if (activeCount < maxConcurrent) {
      activeCount += 1;
      return;
    }
    await new Promise((resolveWaiter) => {
      waiters.push(resolveWaiter);
    });
  }

  function release() {
    const next = waiters.shift();
    if (next) next();
    else activeCount = Math.max(0, activeCount - 1);
  }

  function drain(scope) {
    const queue = queues.get(scope);
    if (!queue || queue.length === 0) {
      queues.delete(scope);
      return;
    }
    const next = queue.shift();
    if (queue.length === 0) queues.delete(scope);
    if (next) launch(scope, next);
  }

  async function start(scope, item, controller) {
    if (closed) {
      pending.delete(scope);
      return;
    }
    await acquire();
    if (closed) {
      release();
      pending.delete(scope);
      return;
    }
    if (controller.signal.aborted) {
      release();
      pending.delete(scope);
      drain(scope);
      return;
    }

    pending.delete(scope);
    active.set(scope, { controller, item, startedAt: Date.now() });
    try {
      await execute(scope, item, controller.signal);
    } catch (err) {
      logger.error('queue.execute_failed', {
        scope,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      active.delete(scope);
      release();
      drain(scope);
    }
  }

  function launch(scope, item) {
    if (closed) return;
    const controller = new AbortController();
    pending.set(scope, { controller, item });
    void start(scope, item, controller).catch((err) => {
      logger.error('queue.start_failed', {
        scope,
        message: err instanceof Error ? err.message : String(err),
      });
      if (pending.get(scope)?.controller === controller) {
        pending.delete(scope);
      }
    });
  }

  function enqueue(scope, item) {
    if (closed) {
      return { accepted: false, reason: 'closed', queued: false, depth: 0 };
    }
    if (active.has(scope) || pending.has(scope) || queues.has(scope)) {
      const queue = queues.get(scope) || [];
      if (queue.length >= maxQueuePerScope) {
        return {
          accepted: false,
          reason: 'full',
          queued: false,
          depth: queue.length,
        };
      }
      queue.push(item);
      queues.set(scope, queue);
      logger.info('queue.enqueue', { scope, depth: queue.length });
      return { accepted: true, queued: true, depth: queue.length };
    }
    launch(scope, item);
    return { accepted: true, queued: false, depth: 0 };
  }

  function abort(scope) {
    const controller =
      active.get(scope)?.controller || pending.get(scope)?.controller;
    queues.delete(scope);
    if (controller) controller.abort();
    return Boolean(controller);
  }

  function getState(scope) {
    const running = active.has(scope);
    return {
      running,
      waiting: pending.has(scope) && !running,
      queued: queues.get(scope)?.length || 0,
    };
  }

  function shutdown() {
    closed = true;
    for (const entry of active.values()) entry.controller.abort();
    for (const entry of pending.values()) entry.controller.abort();
    queues.clear();
  }

  function waitForIdle(timeoutMs = 5000) {
    if (active.size === 0 && pending.size === 0) return Promise.resolve(true);
    return new Promise((resolveIdle) => {
      const startedAt = Date.now();
      const timer = setInterval(() => {
        if (active.size === 0 && pending.size === 0) {
          clearInterval(timer);
          resolveIdle(true);
        } else if (Date.now() - startedAt >= timeoutMs) {
          clearInterval(timer);
          resolveIdle(false);
        }
      }, 25);
    });
  }
  return {
    enqueue,
    abort,
    getState,
    shutdown,
    waitForIdle,
    get activeCount() {
      return activeCount;
    },
  };
}
