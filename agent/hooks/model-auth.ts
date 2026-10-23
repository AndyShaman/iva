import { defineHook } from "eve/hooks";
import { modelAuthFailure } from "../lib/model-auth.js";
import { dispatchModelAuth } from "../lib/model-auth-dispatch.js";

export default defineHook({
  events: {
    "turn.failed": async (event, ctx) => {
      const provider = modelAuthFailure(event.data);
      if (provider)
        await dispatchModelAuth({
          provider,
          at: Date.now(),
          failed: true,
          answers: ctx.channel.kind === "channel:telegram",
        });
    },
    // A completed model step proves the login actually works, including background turns.
    "step.completed": async () => {
      await dispatchModelAuth({
        provider: process.env.MODEL_PROVIDER ?? "ollama",
        at: Date.now(),
        failed: false,
      });
    },
  },
});
