/** @public */
import { canonical, emptyCleanup, fail, freeze, isJson, ok } from '../contracts/index.js';
import type { Contracts } from '../reference/contracts.js';
import type { Host } from '../reference/host.js';
import type { Runtime } from '../reference/runtime.js';
import { scheduleDeadline } from '../runtime/deadline.js';
export function createRuntimeHost(options: {
  runs: Runtime.RunService;
  maxConcurrent?: number;
  maxQueued?: number;
  maxRetained?: number;
  policy?: Host.InputPolicy;
  resources?: Host.ResourceManager;
}): Host.Service & {
  getJob(id: string, context: Contracts.InvocationContext): Contracts.Result<Host.Admission>;
} {
  const concurrent = options.maxConcurrent ?? 1,
    maximum = options.maxQueued ?? 1000;
  if (
    !Number.isSafeInteger(concurrent) ||
    concurrent < 1 ||
    !Number.isSafeInteger(maximum) ||
    maximum < 0
  )
    throw new TypeError('Invalid host capacity');
  interface Job {
    request: Host.AdmissionRequest;
    principal: string;
    fingerprint: string;
    admission: Host.Admission;
    context: Contracts.InvocationContext;
    handle?: Runtime.ExecutionHandle<unknown>;
    outcome?: Runtime.ManagedOutcome<unknown>;
  }
  const jobs = new Map<string, Job>(),
    pending: Job[] = [],
    active = new Set<Job>();
  const cancellation = new AbortController();
  let root: Contracts.InvocationContext | undefined,
    state: 'idle' | 'running' | 'stopping' | 'stopped' = 'idle',
    pumping = false;
  let stopped: Promise<Contracts.CleanupReport> | undefined;
  const notify = new Set<() => void>();
  const changed = () => {
    for (const wake of notify) wake();
  };
  const authorized = (context: Contracts.InvocationContext) =>
    root && canonical(root.principal) === canonical(context.principal);
  const reject = (message: string): Host.Admission => ({
    kind: 'rejected',
    error: fail('host.admission', message, 'conflict').error,
  });
  async function admit(job: Job) {
    if (job.request.expiresAt && Date.parse(job.request.expiresAt) <= Date.now()) {
      job.admission = reject('Admission request expired');
      return;
    }
    active.add(job);
    try {
      const created = await options.runs.start(job.request.run, job.context);
      if (!created.ok) {
        job.admission = { kind: 'rejected', error: created.error };
        active.delete(job);
        changed();
        return;
      }
      job.handle = created.value;
      job.admission = { kind: 'started', run: created.value.ref };
      if (cancellation.signal.aborted) await created.value.requestCancel('host-stopped');
      void created.value.done.then((outcome) => {
        job.outcome = outcome;
        active.delete(job);
        changed();
        void pump();
      });
    } catch {
      active.delete(job);
      job.admission = reject('Run admission failed');
      changed();
    }
  }
  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (
        (state === 'running' || (state === 'stopping' && !cancellation.signal.aborted)) &&
        active.size < concurrent &&
        pending.length
      ) {
        pending.sort(
          (a, b) =>
            (b.request.priority ?? 0) - (a.request.priority ?? 0) ||
            a.request.requestId.localeCompare(b.request.requestId),
        );
        const job = pending.shift()!;
        if (job.request.expiresAt && Date.parse(job.request.expiresAt) <= Date.now()) {
          job.admission = reject('Queued request expired');
          changed();
          continue;
        }
        await admit(job);
      }
    } finally {
      pumping = false;
      changed();
    }
  }
  return {
    async start(context) {
      if (state !== 'idle' || context.signal.aborted)
        return fail('host.start', 'Host already started or cancelled', 'conflict');
      root = context;
      state = 'running';
      context.signal.addEventListener(
        'abort',
        () => {
          cancellation.abort('host-owner-cancelled');
          for (const job of active) void job.handle?.requestCancel('host-owner-cancelled');
        },
        { once: true },
      );
      return ok(undefined);
    },
    async submit(request, context) {
      if (!authorized(context))
        return fail('host.permission', 'Host admission denied', 'permission');
      if (
        !isJson(request.run.input) ||
        !request.requestId ||
        (request.expiresAt && !Number.isFinite(Date.parse(request.expiresAt))) ||
        (request.priority !== undefined && !Number.isFinite(request.priority))
      )
        return fail('host.request', 'Invalid admission request');
      const fingerprint = canonical({
        input: request.run.input,
        driver: request.run.driver,
        composition: request.run.composition.inspection.revision,
        limits: (request.run.limits as unknown as Contracts.Json) ?? null,
        concurrencyKey: request.concurrencyKey ?? null,
        priority: request.priority ?? 0,
        expiresAt: request.expiresAt ?? null,
      });
      const existing = jobs.get(request.requestId);
      if (existing)
        return existing.principal === canonical(context.principal) &&
          existing.fingerprint === fingerprint
          ? ok(existing.admission)
          : fail('host.dedupe', 'Request ID has different content', 'conflict');
      if (jobs.size >= (options.maxRetained ?? 1000))
        return fail('host.retention', 'Admission receipt capacity reached');
      if (state !== 'running' || cancellation.signal.aborted)
        return fail('host.stopped', 'Host is not accepting requests', 'conflict');
      const fixed = {
        ...request,
        run: {
          ...request.run,
          input: freeze(structuredClone(request.run.input)),
          ...(request.run.limits ? { limits: freeze(structuredClone(request.run.limits)) } : {}),
        },
      };
      const job: Job = {
        request: fixed,
        principal: canonical(context.principal),
        fingerprint,
        admission: {
          kind: 'queued',
          job: { owner: 'part/host', kind: 'job', id: request.requestId },
        },
        context: {
          ...root!,
          signal: AbortSignal.any([root!.signal, cancellation.signal]),
          correlationId: context.correlationId,
        },
      };
      const decision =
        options.policy?.decide(
          fixed,
          pending.map((j) => j.request),
        ) ??
        ok({
          action: active.size < concurrent && !pumping ? ('start' as const) : ('queue' as const),
          affected: [],
        });
      if (!decision.ok) return decision;
      if (decision.value.action === 'reject')
        return ok(reject('Input policy rejected the request'));
      if (decision.value.action === 'replace-pending') {
        for (const id of decision.value.affected) {
          const index = pending.findIndex((j) => j.request.requestId === id);
          if (index >= 0) {
            pending[index]!.admission = { kind: 'superseded', by: request.requestId };
            pending.splice(index, 1);
          }
        }
      }
      if (decision.value.action === 'start' && active.size < concurrent && !pumping) {
        jobs.set(request.requestId, job);
        await admit(job);
      } else {
        if (pending.length >= maximum) return ok(reject('Admission queue is full'));
        jobs.set(request.requestId, job);
        pending.push(job);
        void pump();
      }
      return ok(job.admission);
    },
    getJob(id, context) {
      const job = jobs.get(id);
      return authorized(context) && job?.principal === canonical(context.principal)
        ? ok(job.admission)
        : fail('host.job', 'Job not found or access denied', 'permission');
    },
    stop(stopOptions) {
      if (stopped) return stopped;
      if (stopOptions.deadline && !Number.isFinite(Date.parse(stopOptions.deadline)))
        return Promise.resolve({
          released: [],
          unresolved: [...active].flatMap((job) => (job.handle ? [job.handle.ref] : [])),
          errors: [fail('host.deadline', 'Invalid stop deadline').error],
        });
      state = 'stopping';
      stopped = (async () => {
        const errors: Contracts.Failure[] = [];
        if (stopOptions.mode === 'cancel') {
          cancellation.abort('host-stopped');
          for (const job of pending.splice(0))
            job.admission = reject('Host stopped before admission');
          await Promise.all(
            [...active].map(async (job) => {
              const result = await job.handle?.requestCancel('host-stopped');
              if (result && !result.ok) errors.push(result.error);
            }),
          );
        } else void pump();
        let expired = false;
        const cancelTimer = stopOptions.deadline
          ? scheduleDeadline(Date.parse(stopOptions.deadline), () => {
              expired = true;
              changed();
            })
          : () => {};
        while (!expired && (active.size || pending.length || pumping))
          await new Promise<void>((resolve) => {
            const wake = () => {
              notify.delete(wake);
              resolve();
            };
            notify.add(wake);
          });
        cancelTimer();
        state = 'stopped';
        const unresolved = [...active].flatMap((job) =>
          job.handle
            ? [job.handle.ref]
            : [{ owner: 'part/host', kind: 'job', id: job.request.requestId }],
        );
        for (const job of jobs.values()) {
          if (job.outcome?.phase === 'abandoned' && job.handle) unresolved.push(job.handle.ref);
          if (job.outcome) unresolved.push(...job.outcome.unsettledChildren);
        }
        for (const job of pending.splice(0)) {
          job.admission = reject('Drain deadline expired');
          unresolved.push({ owner: 'part/host', kind: 'job', id: job.request.requestId });
        }
        const resources =
          root && !unresolved.length
            ? ((await options.resources?.closeOwner(root.scope)) ?? emptyCleanup())
            : emptyCleanup();
        return {
          released: [
            ...resources.released,
            ...[...jobs.values()].flatMap((job) =>
              job.handle &&
              !unresolved.some(
                (ref) => ref.id === job.handle!.ref.id && ref.owner === job.handle!.ref.owner,
              )
                ? [job.handle.ref]
                : [],
            ),
          ],
          unresolved: [...unresolved, ...resources.unresolved],
          errors: [...errors, ...resources.errors],
        };
      })();
      return stopped;
    },
  };
}
