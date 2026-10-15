import type { Composition } from './composition.js';
import type { Context } from './context.js';
import type { Contracts } from './contracts.js';
import type { Driver } from './driver.js';
import type { Model } from './model.js';
import type { Runtime } from './runtime.js';
import type { Tools } from './tools.js';
export namespace Convenience {
  export interface ConfiguredModel {
    readonly profile: Model.Profile;
    readonly adapter: Model.Adapter;
    readonly transport: Model.Transport;
    readonly auth: Model.AuthStrategy;
  }
  export interface BaseOptions {
    readonly model: ConfiguredModel;
    readonly tools?: readonly Tools.InstalledTool[];
    readonly limits?: Runtime.ExecutionLimits;
    readonly components?: readonly Composition.ComponentFactory[];
    readonly customize?: (base: Composition.CompositionSpec) => Composition.CompositionSpec;
  }
  export interface DefaultOptions extends BaseOptions {
    readonly driver?: never;
  }
  export interface CustomOptions<I, O> extends BaseOptions {
    readonly driver: Driver.Factory<I, O>;
  }
  export interface Agent<I, O> {
    start(input: I): Promise<Contracts.Result<Runtime.ExecutionHandle<O>>>;
    generate(input: I): Promise<Contracts.Result<Runtime.ManagedOutcome<O>>>;
    inspectComposition(): Composition.ResolvedComposition;
    dispose(): Promise<Contracts.CleanupReport>;
  }
  export interface Factory {
    create(
      options: DefaultOptions,
    ): Contracts.Result<Agent<string | readonly Context.SemanticItem[], Model.Response>>;
    create<I, O>(options: CustomOptions<I, O>): Contracts.Result<Agent<I, O>>;
  }
}
