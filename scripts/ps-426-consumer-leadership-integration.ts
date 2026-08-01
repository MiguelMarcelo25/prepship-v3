/**
 * PS-426 provider-free consumer-leadership integration.
 *
 * Exercises the production leadership controller with an injected advisory
 * lock session, pg-boss consumer boundary, active-job read, and clock. It does
 * not connect to a database, enqueue work, or call ShipStation.
 */
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgres://user:pass@127.0.0.1:1/prepship_guard';
process.env.SUPABASE_URL ??= 'http://127.0.0.1:1';
process.env.SUPABASE_ANON_KEY ??= 'anon';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'service';
process.env.SUPABASE_JWT_SECRET ??= 'secret';

const {
  ShipStationConsumerLeadershipController,
} = await import('../src/services/sync-job-queue');

type ActiveJob = { id: string; name: string };

class FakeClock {
  private nextId = 1;
  private readonly timers = new Map<number, { callback: () => void; delayMs: number }>();
  /**
   * PS-485: the controller now needs a clock to bound how long leadership
   * acquisition may keep failing. Scheduling advances it, so elapsed time here
   * tracks the retries the controller actually made rather than wall time.
   */
  private nowMs = 1_000_000;

  now = (): number => this.nowMs;

  setTimer = (callback: () => void, delayMs: number): number => {
    const id = this.nextId++;
    this.nowMs += delayMs;
    this.timers.set(id, { callback, delayMs });
    return id;
  };

  clearTimer = (handle: unknown): void => {
    this.timers.delete(handle as number);
  };

  pendingDelays(): number[] {
    return [...this.timers.values()].map((timer) => timer.delayMs);
  }
}

class FakeLeadershipConnection {
  acquired = false;
  closed = false;
  released = false;

  constructor(
    private readonly workerId: string,
    private readonly manager: FakeLeadershipManager,
  ) {}

  async ping(): Promise<void> {
    if (this.closed || this.manager.owner !== this.workerId) {
      throw new Error(`leadership connection lost for ${this.workerId}`);
    }
  }

  async tryAcquire(): Promise<boolean> {
    if (this.closed) throw new Error(`closed connection for ${this.workerId}`);
    if (this.manager.owner !== null) return false;
    this.manager.owner = this.workerId;
    this.acquired = true;
    this.manager.events.push(`acquire:${this.workerId}`);
    return true;
  }

  async unlock(): Promise<void> {
    if (this.manager.owner === this.workerId) {
      this.manager.owner = null;
      this.manager.events.push(`unlock:${this.workerId}`);
    }
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    this.manager.events.push(`release:${this.workerId}`);
  }
}

class FakeLeadershipManager {
  owner: string | null = null;
  readonly events: string[] = [];
  readonly registeredWorkers = new Set<string>();
  maxRegisteredWorkers = 0;
  private readonly connections: FakeLeadershipConnection[] = [];

  reserve(workerId: string): FakeLeadershipConnection {
    const connection = new FakeLeadershipConnection(workerId, this);
    this.connections.push(connection);
    this.events.push(`reserve:${workerId}`);
    return connection;
  }

  register(workerId: string): void {
    assert.equal(this.owner, workerId, `${workerId} must own the advisory lock before registering`);
    assert.equal(this.registeredWorkers.has(workerId), false, `${workerId} registered twice`);
    this.registeredWorkers.add(workerId);
    this.maxRegisteredWorkers = Math.max(
      this.maxRegisteredWorkers,
      this.registeredWorkers.size,
    );
    this.events.push(`register:${workerId}`);
  }

  unregister(workerId: string): void {
    if (!this.registeredWorkers.delete(workerId)) return;
    this.events.push(`unregister:${workerId}`);
  }

  dropLeadershipSession(workerId: string): void {
    assert.equal(this.owner, workerId, `${workerId} must own leadership before connection loss`);
    this.owner = null;
    const connection = [...this.connections]
      .reverse()
      .find((candidate) => candidate.acquired && !candidate.released);
    assert.ok(connection, `active ${workerId} leadership connection must exist`);
    connection.closed = true;
    this.events.push(`drop:${workerId}`);
  }
}

function createWorker(workerId: string, manager: FakeLeadershipManager) {
  const clock = new FakeClock();
  let activeJobs: ActiveJob[] = [];
  let recoverActiveJobs = async (): Promise<void> => undefined;
  let recoveryCount = 0;
  let registerCount = 0;
  let unregisterCount = 0;
  const restartRequests: string[] = [];
  const diagnostics: string[] = [];

  const controller = new ShipStationConsumerLeadershipController(
    {
      reserveConnection: async () => manager.reserve(workerId),
      recoverActiveJobs: async () => {
        recoveryCount += 1;
        await recoverActiveJobs();
      },
      readActiveJobs: async () => activeJobs,
      registerConsumers: async () => {
        manager.register(workerId);
        registerCount += 1;
      },
      unregisterConsumers: async () => {
        manager.unregister(workerId);
        unregisterCount += 1;
      },
      requestRestart: (reason: string) => restartRequests.push(reason),
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      info: (message: string) => diagnostics.push(`info:${message}`),
      warn: (message: string) => diagnostics.push(`warn:${message}`),
      error: (message: string) => diagnostics.push(`error:${message}`),
    },
    5,
    15,
  );

  return {
    controller,
    clock,
    diagnostics,
    setActiveJobs(jobs: ActiveJob[]) {
      activeJobs = jobs;
    },
    setActiveJobRecovery(recovery: () => Promise<void>) {
      recoverActiveJobs = recovery;
    },
    counts() {
      return { recoveryCount, registerCount, unregisterCount, restartRequests };
    },
  };
}

const manager = new FakeLeadershipManager();
const workerA = createWorker('worker-a', manager);
const workerB = createWorker('worker-b', manager);

await workerA.controller.start();
assert.deepEqual(workerA.controller.snapshot(), {
  started: true,
  stopping: false,
  ownsLock: true,
  consumersRegistered: true,
  scheduledDelayMs: 15,
  // PS-485: null while leadership is held -- only set when acquisition is failing.
  acquireFailingForMs: null,
});
assert.deepEqual(workerA.counts(), {
  recoveryCount: 1,
  registerCount: 1,
  unregisterCount: 0,
  restartRequests: [],
});

await workerB.controller.start();
assert.equal(workerB.controller.snapshot().ownsLock, false);
assert.equal(workerB.controller.snapshot().consumersRegistered, false);
assert.deepEqual(workerB.clock.pendingDelays(), [5]);
assert.equal(manager.maxRegisteredWorkers, 1, 'two workers must never register together');

await workerA.controller.stop();
assert.equal(manager.owner, null);
assert.deepEqual(workerA.clock.pendingDelays(), []);
assert.deepEqual(workerA.counts(), {
  recoveryCount: 1,
  registerCount: 1,
  unregisterCount: 1,
  restartRequests: [],
});

workerB.setActiveJobs([{ id: 'old-generation-job', name: 'prepship.sync.orders' }]);
await workerB.controller.runMaintenanceNow();
assert.equal(workerB.controller.snapshot().ownsLock, true);
assert.equal(workerB.controller.snapshot().consumersRegistered, false);
assert.deepEqual(workerB.clock.pendingDelays(), [5]);
assert.ok(
  workerB.diagnostics.some((entry) => entry.includes('waiting for active deploy handoff')),
  'new leader must report the durable active-job handoff fence',
);
assert.equal(workerB.counts().recoveryCount, 1);

workerB.setActiveJobRecovery(async () => {
  workerB.setActiveJobs([]);
});
await workerB.controller.runMaintenanceNow();
assert.equal(workerB.controller.snapshot().consumersRegistered, true);
assert.deepEqual(workerB.clock.pendingDelays(), [15]);
assert.equal(
  workerB.counts().recoveryCount,
  2,
  'handoff maintenance must recover orphaned rows before reading the active-job fence',
);

manager.dropLeadershipSession('worker-b');
await workerB.controller.notifyConnectionClosed();
assert.equal(workerB.controller.snapshot().ownsLock, false);
assert.equal(workerB.controller.snapshot().consumersRegistered, false);
assert.deepEqual(workerB.clock.pendingDelays(), [5]);
assert.deepEqual(workerB.counts(), {
  recoveryCount: 2,
  registerCount: 1,
  unregisterCount: 1,
  restartRequests: ['shipstation_consumer_leadership_closed'],
});

const workerC = createWorker('worker-c', manager);
await workerC.controller.start();
assert.equal(workerC.controller.snapshot().consumersRegistered, true);
assert.equal(manager.maxRegisteredWorkers, 1, 'connection-loss handoff must not overlap consumers');

await workerB.controller.runMaintenanceNow();
assert.equal(workerB.controller.snapshot().ownsLock, false);
assert.equal(workerB.controller.snapshot().consumersRegistered, false);

const fallbackStart = manager.events.length;
manager.dropLeadershipSession('worker-c');
await workerC.controller.runMaintenanceNow();
const fallbackEvents = manager.events.slice(fallbackStart);
assert.deepEqual(
  fallbackEvents.filter((event) => /^(drop|unregister|release|reserve|acquire|register):/.test(event)),
  [
    'drop:worker-c',
    'unregister:worker-c',
    'release:worker-c',
  ],
  'health fallback must unregister the lost generation before requesting restart',
);
assert.equal(workerC.controller.snapshot().ownsLock, false);
assert.equal(workerC.controller.snapshot().consumersRegistered, false);
assert.deepEqual(workerC.clock.pendingDelays(), [5]);
assert.deepEqual(workerC.counts().restartRequests, [
  'shipstation_consumer_leadership_ping_failed',
]);
assert.equal(manager.maxRegisteredWorkers, 1);

await workerC.controller.stop();
await workerB.controller.stop();
await workerC.controller.stop();
assert.equal(manager.owner, null);
assert.equal(manager.registeredWorkers.size, 0);
assert.deepEqual(workerB.clock.pendingDelays(), []);
assert.deepEqual(workerC.clock.pendingDelays(), []);

console.log('PASS PS-426 consumer leadership acquisition/handoff/loss/shutdown integration');
