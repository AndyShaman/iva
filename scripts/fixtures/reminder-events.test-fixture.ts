import { runReminderTurn, type TurnStreamEvent } from "../lib/reminder-turn.ts";

/** Real event settlement with an in-memory eve session. */
export function reminderFromEvents(events: readonly TurnStreamEvent[]) {
  return runReminderTurn(
    "fixture",
    {
      host: "http://fixture.invalid",
      auth: { bearer: () => Promise.resolve("fixture") },
    },
    {
      createClient: () =>
        Promise.resolve({
          sessions: {
            create: () =>
              Promise.resolve({
                response: Object.assign(
                  (async function* () {
                    await Promise.resolve();
                    yield* events;
                  })(),
                  { sessionId: "fixture", cancel: () => Promise.resolve() },
                ),
                session: {
                  send: () => Promise.resolve(),
                  cancel: () => Promise.resolve(),
                  reset: () => Promise.resolve(),
                },
              }),
          },
        }),
    },
  );
}
