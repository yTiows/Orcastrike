// Cloudflare Worker entry point. Only the default handler may be exported from this module
// (workerd treats named exports as entrypoints). Implementation: worker/lib.js.
import { handleRequest } from "./lib.js";

export default {
  fetch: handleRequest,
};
