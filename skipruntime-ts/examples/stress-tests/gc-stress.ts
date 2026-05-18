import type {
  Context,
  EagerCollection,
  Json,
  Resource,
  SkipService,
  ServiceInstance,
} from "@skipruntime/core";
import { initService } from "@skipruntime/native";
import { spawnSync } from "child_process";

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

const stressService: SkipService<StressInputs, StressInputs> = {
  initialData: { input: [] },
  resources: { stress: StressResource },
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
  console.log(
    `[${label}] rss=${fmtMem(mem.rss)} | heapUsed=${fmtMem(mem.heapUsed)} | external=${fmtMem(mem.external)}`,
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

// Calls malloc_trim(0) on this process via gdb.
// Requires gdb to be installed and ptrace to be permitted on this process.
function tryMallocTrim(label: string): void {
  logMem(`${label} | before malloc_trim`);

  const result = spawnSync(
    "gdb",
    [
      "-batch",
      "-p",
      String(process.pid),
      "-ex",
      "call (int)malloc_trim(0)",
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    },
  );

  if (result.error) {
    console.log(`${label} | malloc_trim failed: ${result.error.message}`);
    console.log(`${label} | (make sure gdb is installed: apt install gdb)`);
  } else if (result.status !== 0) {
    console.log(
      `${label} | malloc_trim returned non-zero status: ${result.status}`,
    );
    console.log(`${label} | stderr: ${result.stderr?.toString() ?? ""}`);
  } else {
    console.log(`${label} | malloc_trim(0) called successfully`);
  }

  logMem(`${label} | after malloc_trim`);
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

// --- Main ---

async function main() {
  console.log(`[gc-stress] PID=${process.pid}`);
  console.log(`[gc-stress] observe memory in another terminal with:`);
  console.log(`            watch -n 1 'ps -o pid,rss,vsz,cmd -p ${process.pid}'`);
  console.log("");
  console.log("[gc-stress] giving you 10s to attach your observer...");
  await sleep(10_000);

  const service = await initService(stressService);

  const CYCLES = 20_000;

  await runPhase(
    service,
    "Test 1: aggressive cap (maxGarbageSize=0)",
    { enabled: true, ttlMillis: 30_000, maxGarbageSize: 0, logsEnabled: false },
    CYCLES,
    "phase1",
  );

  await runPhase(
    service,
    "Test 2: bounded cap (maxGarbageSize=100)",
    {
      enabled: true,
      ttlMillis: 30_000,
      maxGarbageSize: 100,
      logsEnabled: false,
    },
    CYCLES,
    "phase2",
  );

  await runPhase(
    service,
    "Test 3: no cap (maxGarbageSize=null)",
    {
      enabled: true,
      ttlMillis: 30_000,
      maxGarbageSize: null,
      logsEnabled: false,
    },
    CYCLES,
    "phase3",
  );

  await runLongBurnIn(service);
  tryMallocTrim("after Test 4");

  await runRecoveryCycle(service);
  await runConcurrentStress(service);

  await runFineGrainedBurnIn(service);
  tryMallocTrim("after Test 7");

  await runVeryLongBurnIn(service);
  tryMallocTrim("after Test 8");

  console.log("");
  console.log("[gc-stress] all phases done, closing service");
  logMem("final before close");
  await service.close();
  logMem("final after close");

  tryMallocTrim("after close");

  console.log("[gc-stress] exiting");
}

// eslint-disable-next-line @typescript-eslint/no-floating-promises
main();