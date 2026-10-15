import type { Contracts, Runtime, Scripts, Tools } from '@slop-lab/part/reference';
import type { Operations } from '@slop-lab/part/runtime';
import type { ScriptBridgeEnvironment } from './bridge.js';
export interface NodeScriptService extends Scripts.Service {
  executor(id?: string): Tools.Executor;
}
export interface NodeScriptOptions {
  root: string;
  interpreters: Readonly<Record<string, string>>;
  environments?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  operations?: Operations;
  boundary?: Runtime.InvocationBoundary;
  maxOutputBytes?: number;
  bridge?: ScriptBridgeEnvironment;
  source?: (
    source: Scripts.Source,
    context: Contracts.InvocationContext,
  ) => Promise<Contracts.Result<Uint8Array>>;
  workspace?: (
    ref: Contracts.DataRef,
    context: Contracts.InvocationContext,
  ) => Promise<Contracts.Result<string>>;
  maxSourceBytes?: number;
}
