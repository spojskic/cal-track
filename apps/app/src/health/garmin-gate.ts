// One Garmin request stream at a time, whoever asks. The sync (garmin-runner.ts) and the workout-detail reads
// (garmin-details-runner.ts) each build their own GarminConnectClient, and each client only spaces and serialises ITS OWN requests.
// Two clients running together would be a parallel burst against the user's real account, which this app never does, so every
// Garmin job runs through this gate: the next one starts when the previous one has finished (whether it worked or not).
//
// Pure: no react-native / expo imports, unit tested in tools/db-tests.

let tail: Promise<unknown> = Promise.resolve();

/** Runs `job` after every job started before it has settled. Returns the job's own result (or rejection). */
export function withGarminGate<T>(job: () => Promise<T>): Promise<T> {
  const run = tail.then(job, job);
  tail = run.catch(() => undefined);
  return run;
}
