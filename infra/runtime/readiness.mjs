import net from "node:net";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}: required`);
  return value;
}

function connect(url, label) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: url.hostname, port: Number(url.port || (url.protocol === "https:" ? 443 : 80)) });
    const timer = setTimeout(() => socket.destroy(new Error(`${label}: timeout`)), 1500);
    socket.once("connect", () => { clearTimeout(timer); socket.end(); resolve(); });
    socket.once("error", (error) => { clearTimeout(timer); reject(new Error(`${label}: unavailable (${error.code ?? "error"})`)); });
  });
}

export async function checkDependencies() {
  if (process.env.SYNTHETIC_DATA_ONLY !== "true") throw new Error("SYNTHETIC_DATA_ONLY: must-be-true-for-a01");
  const database = new URL(required("DATABASE_URL"));
  const objectStorage = new URL(required("S3_ENDPOINT"));
  if (!/^postgres(?:ql)?:$/.test(database.protocol) || !/^https?:$/.test(objectStorage.protocol)) throw new Error("dependency-url: invalid-protocol");
  await Promise.all([connect(database, "database"), connect(objectStorage, "object-storage")]);
}

if (import.meta.main) {
  try {
    await checkDependencies();
    console.log(`${process.argv[2] ?? "runtime"}: dependencies-ready`);
  } catch (error) {
    // Never include URLs, credentials, request data, or raw provider errors in readiness output.
    console.error(`${process.argv[2] ?? "runtime"}: dependency-unavailable`);
    process.exitCode = 1;
  }
}
