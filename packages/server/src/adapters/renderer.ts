/** The Unity renderer as a component: the native render server, its captures and diagnostics routed to the run's stream and the log. */
import { fileURLToPath } from "node:url";
import type { IConfigComponent, ILoggerComponent } from "@well-known-components/interfaces";
import type { Renderer } from "@dcl-regenesislabs/wearable-validator";
import { createNativeRenderer, probeRenderServer, type RenderServerProbe } from "@dcl-regenesislabs/wearable-validator/native";
import type { RunSink } from "../types.js";
import { appLogger } from "./log-buffer.js";

// the render server is a Linux x86_64 player: outside the image (a laptop) it runs in Docker
export const DOCKER_RENDER_SERVER = fileURLToPath(new URL("../../render-server-docker.sh", import.meta.url));

export interface IRendererComponent {
  readonly available: boolean;
  forRun(run: RunSink): Promise<Renderer | undefined>;
  /** Draws one still of a stock item; the startup self-test reports it. */
  probe(timeoutMs: number): Promise<RenderServerProbe>;
}

export async function createRendererComponent(components: { config: IConfigComponent; logs: ILoggerComponent }): Promise<IRendererComponent> {
  const { config, logs } = components;
  const log = appLogger(logs, "renderer");
  const command = (await config.getString("RENDER_SERVER")) || DOCKER_RENDER_SERVER;
  const build = (await config.getString("RENDER_SERVER_BUILD")) ?? "unversioned";
  const workDirectory = await config.getString("RENDER_SERVER_WORK_DIR");
  log.info("render server", { command, build });
  return {
    available: true,
    forRun: async (run) =>
      createNativeRenderer({ command, build, workDirectory, onCapture: (capture) => void run.capture(capture), onLog: (message, fields) => log.info(message, { run: run.id, ...fields }) }),
    probe: (timeoutMs) => probeRenderServer({ command, workDirectory, timeoutMs })
  };
}
