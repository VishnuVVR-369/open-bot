import "server-only";
import { os } from "@/lib/server/api/rpc";
import {
  cancelScreenOperation,
  codeContext,
  dismissTakeoverRequest,
  getScreenOperation,
  handBackScreen,
  lastScreenFrames,
  listScreens,
  reportScreenActivity,
  takeOverScreen,
  typeOnScreen,
  wakeScreen,
} from "./service";

/**
 * Screens on the computer, taking one over and typing on it, as the browser and the phone ask
 * (`contract.screens`, `contract.takeovers` and `contract.screenOperations`).
 */
export function computerRoutes() {
  return {
    screens: {
      list: os.screens.list.handler(() => listScreens()),
      frames: os.screens.frames.handler(() => lastScreenFrames()),
      takeOver: os.screens.takeOver.handler(({ input }) => takeOverScreen(input)),
      handBack: os.screens.handBack.handler(({ input }) => handBackScreen(input)),
      wake: os.screens.wake.handler(({ input }) => wakeScreen(input)),
      activity: os.screens.activity.handler(({ input }) => reportScreenActivity(input)),
    },
    takeovers: {
      dismiss: os.takeovers.dismiss.handler(({ input }) => dismissTakeoverRequest(input)),
      codeContext: os.takeovers.codeContext.handler(({ input }) => codeContext(input)),
    },
    screenOperations: {
      type: os.screenOperations.type.handler(({ input }) => typeOnScreen(input)),
      get: os.screenOperations.get.handler(({ input }) => getScreenOperation(input)),
      cancel: os.screenOperations.cancel.handler(({ input }) => cancelScreenOperation(input)),
    },
  };
}
