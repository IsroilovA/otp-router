import { Context } from "effect";
import type { RuntimeConfiguration } from "./config.js";
export class RouterConfig extends Context.Service<RouterConfig, RuntimeConfiguration>()(
  "otp-router/Config",
) {}
