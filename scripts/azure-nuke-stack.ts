import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Azure from "../src/index.ts";

export default Alchemy.Stack(
  "alchemy-azure-smoke-nuke",
  {
    providers: Azure.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {}),
);
