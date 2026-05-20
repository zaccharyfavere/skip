import type {
  Context,
  EagerCollection,
  Json,
  Mapper,
  Resource,
  ServiceInstance,
  SkipService,
  Values,
} from "@skipruntime/core";
import { initService } from "@skipruntime/native";
import { spawnSync } from "child_process";

// Set in main() after initService so that logMem can include queue size.
let serviceRef: ServiceInstance | null = null;

// --- Minimal service ---

type StressInputs = { input: EagerCollection<string, number> };

class StressResource implements Resource<StressInputs> {
  private readonly value: number;

  constructor(params: Json) {
    if (typeof params !== "object" || params === null || !("value" in params)) {
      throw new Error("StressResource expects { value: number }");
    }
    const v = (params as { value: unknown }).value;
    if (typeof v !== "number") {
      throw new Error("StressResource: value must be a number");
    }
    this.value = v;
  }

  instantiate(
    cs: StressInputs,
    _context: Context,
  ): EagerCollection<string, number> {
    void this.value;
    return cs.input;
  }
}

// Identity mapper : passes through each entry unchanged.
// Used to force the creation of a derived directory on each instantiate.
class IdentityMapper implements Mapper<string, number, string, number> {
  mapEntry(
    key: string,
    values: Values<number>,
    _context: Context,
  ): Iterable<[string, number]> {
    const out: [string, number][] = [];
    for (const v of values) {
      out.push([key, v]);
    }
    return out;
  }
}

// Variant of StressResource that creates a derived directory on each instantiate
// (via .map(IdentityMapper)). Used to test if leak scales with graph complexity.
class StressResourceWithMap implements Resource<StressInputs> {
  private readonly value: number;

  constructor(params: Json) {
    if (typeof params !== "object" || params === null || !("value" in params)) {
      throw new Error("StressResourceWithMap expects { value: number }");
    }
    const v = (params as { value: unknown }).value;
    if (typeof v !== "number") {
      throw new Error("StressResourceWithMap: value must be a number");
    }
    this.value = v;
  }

  instantiate(
    cs: StressInputs,
    _context: Context,
  ): EagerCollection<string, number> {
    void this.value;
    return cs.input.map(IdentityMapper);
  }
}

// Variant that stacks N .map calls. Used to test whether the leak scales
// linearly with the number of derived directories created per instantiate.
class StressResourceWithNMaps implements Resource<StressInputs> {
  private readonly value: number;
  private readonly n: number;

  constructor(params: Json) {
    if (typeof params !== "object" || params === null) {
      throw new Error("StressResourceWithNMaps expects an object");
    }
    const obj = params as { value?: unknown; n?: unknown };
    if (typeof obj.value !== "number" || typeof obj.n !== "number") {
      throw new Error("StressResourceWithNMaps: value and n must be numbers");
    }
    this.value = obj.value;
    this.n = obj.n;
  }

  instantiate(
    cs: StressInputs,
    _context: Context,
  ): EagerCollection<string, number> {
    void this.value;
    let result = cs.input;
    for (let i = 0; i < this.n; i++) {
      result = result.map(IdentityMapper);
    }
    return result;
  }
}

const stressService: SkipService<StressInputs, StressInputs> = {
  initialData: { input: [] },
  resources: {
    stress: StressResource,
    stressWithMap: StressResourceWithMap,
    stressWithNMaps: StressResourceWithNMaps,
  },
  createGraph: (inputs: StressInputs) => inputs,
};

// --- Helpers ---

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fmtMem(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(2) + " MB";
}

function logMem(label: string): void {
  const mem = process.memoryUsage();
  const queueSize = serviceRef ? serviceRef.getGarbageQueueSize() : -1;
  const queueStr = queueSize >= 0 ? ` | gcQueue=${queueSize}` : "";
  console.log(
    `[${label}] rss=${fmtMem(mem.rss)} | heapUsed=${fmtMem(mem.heapUsed)} | external=${fmtMem(mem.external)}${queueStr}`,
  );
}

type GCConfigInput = {
  enabled: boolean;
  ttlMillis: number;
  maxGarbageSize: number | null;
  logsEnabled: boolean;
};

async function runCycles(
  service: ServiceInstance,
  cycles: number,
  uuidPrefix: string,
  reportLabel: string,
  reportEveryN = -1,
): Promise<void> {
  const reportInterval =
    reportEveryN > 0 ? reportEveryN : Math.max(1, Math.floor(cycles / 10));
  for (let i = 0; i < cycles; i++) {
    const uuid = `${uuidPrefix}-${i}`;
    await service.instantiateResource(uuid, "stress", { value: i });
    service.closeResourceInstance(uuid);

    if ((i + 1) % reportInterval === 0) {
      logMem(`${reportLabel} | ${i + 1}/${cycles}`);
    }
  }
}

async function runPhase(
  service: ServiceInstance,
  phaseName: string,
  config: GCConfigInput,
  cycles: number,
  uuidPrefix: string,
): Promise<void> {
  console.log("");
  console.log("=".repeat(70));
  console.log(`PHASE: ${phaseName}`);
  console.log(`config:`, config);
  console.log(`running ${cycles} cycles`);
  console.log("=".repeat(70));

  service.setGCConfig(config);
  logMem(`${phaseName} | start`);

  await runCycles(service, cycles, uuidPrefix, phaseName);

  logMem(`${phaseName} | cycles done`);
}

// --- Test 4: Long burn-in ---

async function runLongBurnIn(service: ServiceInstance): Promise<void> {
  const phaseName = "Test 4: long burn-in (500k cycles, cap=100)";
  console.log("");
  console.log("=".repeat(70));
  console.log(`PHASE: ${phaseName}`);
  console.log("running 500 000 cycles to expose tiny leaks if any");
  console.log("=".repeat(70));

  service.setGCConfig({
    enabled: true,
    ttlMillis: 30_000,
    maxGarbageSize: 100,
    logsEnabled: false,
  });
  logMem(`${phaseName} | start`);

  await runCycles(service, 500_000, "burnin", phaseName);

  logMem(`${phaseName} | cycles done`);
}

// --- Test 4 bis: Long burn-in with derived directory ---
// Same as runLongBurnIn but uses StressResourceWithMap, which creates a
// derived directory via .map(IdentityMapper) at each instantiate.
// Goal: compare RSS growth rate to know if the leak scales with graph complexity.

async function runLongBurnInWithMap(service: ServiceInstance): Promise<void> {
  const phaseName = "Test 4 bis: long burn-in with map (500k cycles, cap=100)";
  console.log("");
  console.log("=".repeat(70));
  console.log(`PHASE: ${phaseName}`);
  console.log("Each instantiate creates a derived directory via .map");
  console.log("=".repeat(70));

  service.setGCConfig({
    enabled: true,
    ttlMillis: 30_000,
    maxGarbageSize: 100,
    logsEnabled: false,
  });
  logMem(`${phaseName} | start`);

  const reportInterval = Math.max(1, Math.floor(500_000 / 10));
  for (let i = 0; i < 500_000; i++) {
    const uuid = `burnin-map-${i}`;
    await service.instantiateResource(uuid, "stressWithMap", { value: i });
    service.closeResourceInstance(uuid);

    if ((i + 1) % reportInterval === 0) {
      logMem(`${phaseName} | ${i + 1}/500000`);
    }
  }

  logMem(`${phaseName} | cycles done`);
}

// --- Test 4 ter: Long burn-in with N maps ---
// Same as runLongBurnInWithMap but stacks N maps per instantiate.
// Used to test whether the leak scales linearly with the number of
// derived directories created per resource.

async function runLongBurnInWithNMaps(
  service: ServiceInstance,
  n: number,
  cycles: number = 200_000,
): Promise<void> {
  const phaseName = `Test 4 ter: long burn-in with ${n} maps (${cycles} cycles, cap=100)`;
  console.log("");
  console.log("=".repeat(70));
  console.log(`PHASE: ${phaseName}`);
  console.log(`Each instantiate creates ${n} derived directories via stacked .maps`);
  console.log("=".repeat(70));

  service.setGCConfig({
    enabled: true,
    ttlMillis: 30_000,
    maxGarbageSize: 100,
    logsEnabled: false,
  });
  logMem(`${phaseName} | start`);

  const reportInterval = Math.max(1, Math.floor(cycles / 10));
  for (let i = 0; i < cycles; i++) {
    const uuid = `burnin-nmaps-${n}-${i}`;
    await service.instantiateResource(uuid, "stressWithNMaps", { value: i, n });
    service.closeResourceInstance(uuid);

    if ((i + 1) % reportInterval === 0) {
      logMem(`${phaseName} | ${i + 1}/${cycles}`);
    }
  }

  logMem(`${phaseName} | cycles done`);
}

// --- Test 5: Recovery cycle ---

async function runRecoveryCycle(service: ServiceInstance): Promise<void> {
  const phaseName = "Test 5: recovery cycle";
  console.log("");
  console.log("=".repeat(70));
  console.log(`PHASE: ${phaseName}`);
  console.log("burst → pause 35s → burst → pause 35s → burst");
  console.log("pause > TTL to let the sweep clean everything");
  console.log("=".repeat(70));

  service.setGCConfig({
    enabled: true,
    ttlMillis: 30_000,
    maxGarbageSize: 100,
    logsEnabled: false,
  });

  for (let round = 1; round <= 3; round++) {
    logMem(`${phaseName} | round ${round} start`);
    await runCycles(
      service,
      50_000,
      `recovery-r${round}`,
      `${phaseName} R${round}`,
    );
    logMem(`${phaseName} | round ${round} cycles done`);

    if (round < 3) {
      console.log(`>>> pause 35s (longer than TTL) so all entries can expire`);
      await sleep(35_000);
      logMem(`${phaseName} | round ${round} after pause`);
    }
  }
}

// --- Test 6: Concurrent stress ---

async function runConcurrentStress(service: ServiceInstance): Promise<void> {
  const phaseName = "Test 6: concurrent stress (10 parallel loops)";
  console.log("");
  console.log("=".repeat(70));
  console.log(`PHASE: ${phaseName}`);
  console.log("10 parallel loops × 10 000 cycles each = 100 000 cycles total");
  console.log("=".repeat(70));

  service.setGCConfig({
    enabled: true,
    ttlMillis: 30_000,
    maxGarbageSize: 100,
    logsEnabled: false,
  });
  logMem(`${phaseName} | start`);

  const workers = Array.from({ length: 10 }, (_, workerId) =>
    runCycles(
      service,
      10_000,
      `concurrent-w${workerId}`,
      `${phaseName} W${workerId}`,
    ),
  );
  await Promise.all(workers);

  logMem(`${phaseName} | all workers done`);
}

// --- Test 7: Fine-grained burn-in ---

async function runFineGrainedBurnIn(service: ServiceInstance): Promise<void> {
  const phaseName = "Test 7: fine-grained burn-in (500k, measure every 5k)";
  console.log("");
  console.log("=".repeat(70));
  console.log(`PHASE: ${phaseName}`);
  console.log("Goal: see if growth is strictly linear or stabilizes");
  console.log("=".repeat(70));

  service.setGCConfig({
    enabled: true,
    ttlMillis: 30_000,
    maxGarbageSize: 100,
    logsEnabled: false,
  });
  logMem(`${phaseName} | start`);

  await runCycles(service, 500_000, "fine-burnin", phaseName, 5_000);

  logMem(`${phaseName} | cycles done`);
}

// --- Test 8: Very long burn-in ---

async function runVeryLongBurnIn(service: ServiceInstance): Promise<void> {
  const phaseName = "Test 8: very long burn-in (5M cycles)";
  console.log("");
  console.log("=".repeat(70));
  console.log(`PHASE: ${phaseName}`);
  console.log("WARNING: takes a long time and may use significant memory");
  console.log("=".repeat(70));

  service.setGCConfig({
    enabled: true,
    ttlMillis: 30_000,
    maxGarbageSize: 100,
    logsEnabled: false,
  });
  logMem(`${phaseName} | start`);

  await runCycles(service, 5_000_000, "verylong-burnin", phaseName, 100_000);

  logMem(`${phaseName} | cycles done`);
}

// --- Test 9: updates only ---

async function runUpdateBurnIn(service: ServiceInstance): Promise<void> {
  const phaseName = "Update burn-in (500k updates, single resource)";
  console.log("");
  console.log("=".repeat(70));
  console.log(`PHASE: ${phaseName}`);
  console.log("=".repeat(70));

  service.setGCConfig({
    enabled: true,
    ttlMillis: 30_000,
    maxGarbageSize: 100,
    logsEnabled: false,
  });

  // One persistent resource that stays alive across all updates
  const uuid = "update-burnin-resource";
  await service.instantiateResource(uuid, "stress", { value: 0 });

  logMem(`${phaseName} | start`);

  const reportInterval = 5_000;
  for (let i = 0; i < 500_000; i++) {
    await service.update("input", [["fixed-key", [i]]]);

    if ((i + 1) % reportInterval === 0) {
      logMem(`${phaseName} | ${i + 1}/500000`);
    }
  }

  logMem(`${phaseName} | cycles done`);

  // Clean up
  service.closeResourceInstance(uuid);
  logMem(`${phaseName} | resource closed`);
}

// --- Test 10: add/remove cycles ---

async function runAddRemoveBurnIn(service: ServiceInstance): Promise<void> {
  const phaseName = "Add/Remove burn-in (500k cycles, single resource)";
  console.log("");
  console.log("=".repeat(70));
  console.log(`PHASE: ${phaseName}`);
  console.log("=".repeat(70));

  service.setGCConfig({
    enabled: true,
    ttlMillis: 30_000,
    maxGarbageSize: 100,
    logsEnabled: false,
  });

  const uuid = "addremove-burnin-resource";
  await service.instantiateResource(uuid, "stress", { value: 0 });

  logMem(`${phaseName} | start`);

  const reportInterval = 5_000;
  for (let i = 0; i < 500_000; i++) {
    await service.update("input", [["fixed-key", [i]]]);
    await service.update("input", [["fixed-key", []]]);

    if ((i + 1) % reportInterval === 0) {
      logMem(`${phaseName} | ${i + 1}/500000`);
    }
  }

  logMem(`${phaseName} | cycles done`);

  service.closeResourceInstance(uuid);
  logMem(`${phaseName} | resource closed`);
}

// --- Main ---

async function main() {
  console.log(`[gc-stress] PID=${process.pid}`);
  console.log(`[gc-stress] observe memory in another terminal with:`);
  console.log(`            watch -n 1 'ps -o pid,rss,vsz,cmd -p ${process.pid}'`);
  console.log("");
  const service = await initService(stressService);
  serviceRef = service;  // activates queue size reporting in logMem

  const CYCLES = 20_000;

  // await runPhase(
  //   service,
  //   "Test 1: aggressive cap (maxGarbageSize=0)",
  //   { enabled: true, ttlMillis: 30_000, maxGarbageSize: 0, logsEnabled: false },
  //   CYCLES,
  //   "phase1",
  // );

  // await runPhase(
  //   service,
  //   "Test 2: bounded cap (maxGarbageSize=100)",
  //   {
  //     enabled: true,
  //     ttlMillis: 30_000,
  //     maxGarbageSize: 100,
  //     logsEnabled: false,
  //   },
  //   CYCLES,
  //   "phase2",
  // );

  // await runPhase(
  //   service,
  //   "Test 3: no cap (maxGarbageSize=null)",
  //   {
  //     enabled: true,
  //     ttlMillis: 30_000,
  //     maxGarbageSize: null,
  //     logsEnabled: false,
  //   },
  //   CYCLES,
  //   "phase3",
  // );

  // await runLongBurnIn(service);
  // await runLongBurnInWithMap(service);
  // await runRecoveryCycle(service);
  // await runConcurrentStress(service);
  // await runFineGrainedBurnIn(service);
  // await runVeryLongBurnIn(service);
  // await runAddRemoveBurnIn(service);
  // await runUpdateBurnIn(service);
  await runLongBurnInWithNMaps(service, 0, 200_000);  // baseline, equivalent to runLongBurnIn
  await runLongBurnInWithNMaps(service, 1, 200_000);  // equivalent to runLongBurnInWithMap
  await runLongBurnInWithNMaps(service, 3, 200_000);
  await runLongBurnInWithNMaps(service, 5, 200_000);
  console.log("");
  console.log("[gc-stress] all phases done, closing service");
  logMem("final before close");
  await service.close();
  logMem("final after close");

  console.log("[gc-stress] exiting");
}

// eslint-disable-next-line @typescript-eslint/no-floating-promises
main();