import { logger } from '../lib/logger.js';
import { onJobQueued, requeueRunningJobs, runNextJob } from '../modules/ai/service.js';

const POLL_MS = 5_000;

// Contract 9: an in-process loop, one job at a time per process. It wakes as soon as this
// process queues a job and otherwise polls, which also picks up jobs left by a restart.
export function startAiWorker({ pollMs = POLL_MS }: { pollMs?: number } = {}): {
  stop: () => Promise<void>;
} {
  let stopped = false;
  // Set by a job queued while the worker was busy, so it looks again before sleeping.
  let queued = false;
  let wake: (() => void) | null = null;

  const unsubscribe = onJobQueued(() => {
    queued = true;
    wake?.();
  });

  function idle(): Promise<void> {
    return new Promise((resolve) => {
      if (queued || stopped) {
        resolve();
        return;
      }

      const timer = setTimeout(done, pollMs);

      function done(): void {
        clearTimeout(timer);
        wake = null;
        resolve();
      }

      wake = done;
    });
  }

  const loop = (async () => {
    try {
      const requeued = await requeueRunningJobs();
      if (requeued > 0) {
        logger.info({ requeued }, 'AI jobs left running were queued again');
      }
    } catch (err) {
      logger.error({ err }, 'AI worker could not requeue running jobs');
    }

    while (!stopped) {
      queued = false;
      let ran = false;

      try {
        ran = await runNextJob();
      } catch (err) {
        logger.error({ err }, 'AI worker could not run a job');
      }

      if (!ran) {
        await idle();
      }
    }
  })();

  return {
    async stop() {
      stopped = true;
      unsubscribe();
      wake?.();
      await loop;
    },
  };
}
