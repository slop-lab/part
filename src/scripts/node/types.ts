import type { Contracts } from '../../reference/contracts.js';
import type { Runtime } from '../../reference/runtime.js';
import type { Scripts } from '../../reference/scripts.js';
import type { Tools } from '../../reference/tools.js';
import type { Operations } from '../../runtime/operations.js';
import type { ScriptBridgeEnvironment } from '../bridge/node.js';
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
