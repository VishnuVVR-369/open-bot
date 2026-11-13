import { base } from "../base";
import { workerStatusSchema } from "../views";

export const statusContract = {
  /** Never wakes the computer: it reports whether it is awake. */
  get: base.route({ method: "GET", path: "/internal/status" }).output(workerStatusSchema),
};
