import { computer, ok } from "../base";
import { z } from "zod";
import { fileListingSchema } from "../views";

export const filesContract = {
  /** Only paths inside `/home/bot`, outside Codex's private folder. */
  list: computer
    .route({ method: "GET", path: "/internal/files/list" })
    .input(z.object({ path: z.string().optional() }))
    .output(fileListingSchema),
  read: computer
    .route({ method: "GET", path: "/internal/files/read" })
    .input(z.object({ path: z.string() }))
    .output(z.object({ path: z.string(), dataBase64: z.string() })),
  write: computer
    .route({ method: "POST", path: "/internal/files/write" })
    .input(z.object({ path: z.string(), dataBase64: z.string() }))
    .output(ok),
  /** Add a file to a folder; a name that is taken becomes "name (2).ext". */
  put: computer
    .route({ method: "POST", path: "/internal/files/put" })
    .input(z.object({ dir: z.string(), name: z.string().min(1), dataBase64: z.string() }))
    .output(z.object({ path: z.string() })),
  /** Refused for folders the system needs, like an active teammate's workspace. */
  remove: computer
    .route({ method: "POST", path: "/internal/files/remove" })
    .input(z.object({ path: z.string() }))
    .output(ok),
};
