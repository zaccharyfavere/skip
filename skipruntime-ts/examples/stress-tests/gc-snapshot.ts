import type {
  Context,
  EagerCollection,
  Json,
  Resource,
  SkipService,
  ServiceInstance,
} from "@skipruntime/core";
import { initService } from "@skipruntime/native";

// --- Service minimal (identique à ce qu'on avait) ---

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

function fmtMem(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(2) + " MB";
}

function logMem(label: string): void {
  const mem = process.memoryUsage();
  console.log(
    `[${label}] rss=${fmtMem(mem.rss)} | heapUsed=${fmtMem(mem.heapUsed)} | external=${fmtMem(mem.external)}`,
  );
}

function waitEnter(prompt: string): Promise<void> {
  return new Promise((resolve) => {
    console.log(prompt);
    process.stdin.once("data", () => resolve());
  });
}

// --- Main ---

async function main() {
  console.log(`[gc-snapshot] PID=${process.pid}`);
  console.log("");
  console.log("INSTRUCTIONS:");
  console.log("1. Open Chrome and go to chrome://inspect");
  console.log("2. Click 'inspect' on the Node target");
  console.log("3. In DevTools, go to the Memory tab");
  console.log("4. Select 'Heap snapshot' and click 'Take snapshot'");
  console.log("");

  await waitEnter("Press Enter once you have DevTools open and ready.");

  const service: ServiceInstance = await initService(stressService);
  await service.instantiateResource("test", "stress", { value: 0 });

  logMem("baseline");
  await waitEnter("Now take a BASELINE snapshot in DevTools, then press Enter.");

  console.log("Running 50 000 updates...");
  for (let i = 0; i < 50_000; i++) {
    await service.update("input", [["fixed-key", [i]]]);
    if ((i + 1) % 10_000 === 0) {
      logMem(`progress ${i + 1}/50000`);
    }
  }

  logMem("after updates");
  await waitEnter("Now take a FINAL snapshot in DevTools, then press Enter to exit.");

  await service.close();
  console.log("Done.");
  process.exit(0);
}

// eslint-disable-next-line @typescript-eslint/no-floating-promises
main();