import { parseServerEnvironment, redactEnvironmentError } from "@evidence-loop/config";
import { createDatabase } from "@evidence-loop/db";
import { buildApp } from "./http/app.ts";
import { PrivateS3Storage } from "@evidence-loop/artifact-pipeline";

try {
  const environment = parseServerEnvironment();
  const { client } = createDatabase(environment.databaseUrl.href);
  const app = buildApp({ environment, client, artifactStorage: new PrivateS3Storage(environment.objectStorage) });
  await app.listen({ port: environment.port, host: "0.0.0.0" });

  const close = async () => {
    await app.close();
    await client.end({ timeout: 5 });
  };
  process.once("SIGTERM", close);
  process.once("SIGINT", close);
} catch (error) {
  console.error(redactEnvironmentError(error));
  process.exitCode = 1;
}
