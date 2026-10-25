// Trusted test program simulating only Docker orchestration. It never runs REA
// or the target. Successful stdout is produced by the real adapter/T001 fixture.
import { readFile, writeFile } from "node:fs/promises";
import { adaptReaFile } from "@rea-studio/rea-adapter/file";

const [configPath, command, ...args] = process.argv.slice(2);
if (!configPath || !command) throw new Error("Missing test helper arguments.");
const config = JSON.parse(await readFile(configPath, "utf8"));
if (command === "info") {
  console.log(JSON.stringify({
    OSType: "linux", MemoryLimit: true, SwapLimit: true,
    CpuCfsQuota: config.mode !== "unsafe-engine", PidsLimit: true,
    SecurityOptions: ["name=seccomp,profile=builtin"],
  }));
} else if (command === "image") {
  console.log(JSON.stringify(config.mode === "old-image" ? null : { "rea-studio.owner-protocol": "1" }));
} else if (command === "create") {
  await writeFile(config.createArgs, JSON.stringify(args));
  if (config.mode === "create-hang") setInterval(() => {}, 100);
  else console.log("test-container-id");
} else if (command === "start") {
  process.stderr.write('{"rea_progress":{"phase":"parse","message":"Parsing and projecting main.js (2/260)"}}\n');
  if (config.mode === "hang") {
    setInterval(() => {}, 100);
  } else if (config.mode === "overflow") {
    for (let i = 0; i < 16; i++) process.stdout.write(Buffer.alloc(8192));
  } else if (config.mode === "limit-error") {
    process.stderr.write('{"studio_worker_error":{"code":"input_limit_exceeded","message":"File count exceeded."}}\n');
    process.exitCode = 1;
  } else if (config.mode !== "empty") {
    const result = await adaptReaFile(config.fixture, { reaVersion: "6.4.0", maxBytes: 128 * 1024 * 1024 });
    process.stdout.write(JSON.stringify(result.project));
    if (config.mode !== "no-receipt") {
      process.stderr.write(`${JSON.stringify({ studio_worker_result: {
        projectId: result.project.id, reaVersion: config.mode === "wrong-receipt" ? "0.0.0" : "6.8.0", report: result.report,
      } })}\n`);
    }
  }
} else if (command === "inspect") {
  console.log(JSON.stringify({
    Status: "exited", Running: false, OOMKilled: config.mode === "oom",
    ExitCode: config.mode === "container-timeout" ? 124 : ["oom", "failure", "limit-error"].includes(config.mode) ? 1 : 0,
  }));
} else if (command === "rm") {
  await writeFile(config.removed, JSON.stringify(args));
  if (config.mode === "cleanup-failure" || config.mode === "create-hang") {
    console.error(config.mode === "create-hang" ? "No such container" : "Cannot reach Docker engine.");
    process.exitCode = 1;
  }
} else {
  console.error("Unexpected fake Docker command.");
  process.exitCode = 1;
}
