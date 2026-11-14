import { os } from "../../core/rpc";
import type { FileService } from "./service";

const ok = { ok: true } as const;

/** The files procedures in the worker's internal API. */
export function filesRoutes(files: FileService) {
  return {
    list: os.files.list.handler(({ input }) => files.list(input.path)),
    read: os.files.read.handler(({ input }) => files.read(input.path)),
    write: os.files.write.handler(async ({ input }) => {
      await files.write(input.path, input.dataBase64);
      return ok;
    }),
    put: os.files.put.handler(async ({ input }) => ({
      path: await files.put(input.dir, input.name, input.dataBase64),
    })),
    remove: os.files.remove.handler(async ({ input }) => {
      await files.remove(input.path);
      return ok;
    }),
  };
}
