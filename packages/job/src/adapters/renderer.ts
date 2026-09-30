/** The native Unity render server, started once per item and stopped after it. */
import { fileURLToPath } from "node:url";
import type { IConfigComponent, ILoggerComponent } from "@well-known-components/interfaces";
import type { Renderer } from "@dcl-regenesislabs/wearable-validator";
import { createNativeRenderer } from "@dcl-regenesislabs/wearable-validator/native";

// the render server is a Linux x86_64 player: outside the image (a laptop) it runs in Docker
export const DOCKER_RENDER_SERVER = fileURLToPath(new URL("../../render-server-docker.sh", import.meta.url));

export interface IRendererComponent {
  /** A render server for one item; the caller stops it. */
  forItem(itemId: string): Promise<Renderer>;
}

export async function createRendererComponent(components: { config: IConfigComponent; logs: ILoggerComponent }): Promise<IRendererComponent> {
  const { config, logs } = components;
  const log = logs.getLogger("renderer");
  const command = (await config.getString("RENDER_SERVER")) || DOCKER_RENDER_SERVER;
  const build = (await config.getString("RENDER_SERVER_BUILD")) ?? "unversioned";
  const workDirectory = await config.getString("RENDER_SERVER_WORK_DIR");
  log.info("render server", { command, build });
  return {
    forItem: (itemId) => createNativeRenderer({ command, build, workDirectory, onLog: (message, fields) => log.info(message, { item: itemId, ...fields }) })
  };
}
