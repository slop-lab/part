import { semanticItem } from '../context/index.js';
import { canonical, fail, freeze, ok } from '../foundation/contracts.js';
import type { Context, Contracts, Packages, Skills } from '../reference/index.js';
interface Decoded {
  name: string;
  description: string;
  instructions: string;
}
function decode(text: string): Contracts.Result<Decoded> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/u.exec(text);
  if (!match) return fail('skill.frontmatter', 'SKILL.md requires frontmatter');
  const fields = new Map<string, string>();
  for (const line of match[1]!.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const field = /^([a-z-]+):\s*(.*)$/u.exec(line);
    if (!field || !['name', 'description', 'license'].includes(field[1]!))
      return fail(
        'skill.frontmatter-subset',
        'Unsupported frontmatter field or YAML syntax',
        'unsupported',
      );
    if (fields.has(field[1]!)) return fail('skill.duplicate-field', 'Duplicate frontmatter field');
    let value = field[2]!.trim();
    if (value.startsWith('"')) {
      try {
        value = JSON.parse(value);
      } catch {
        return fail('skill.frontmatter', 'Invalid quoted scalar');
      }
    } else if (value.startsWith("'")) {
      if (!value.endsWith("'")) return fail('skill.frontmatter', 'Invalid quoted scalar');
      value = value.slice(1, -1).replaceAll("''", "'");
    } else if (/^[>|&*!\[{]/u.test(value) || value.includes(' #'))
      return fail(
        'skill.frontmatter-subset',
        'Only plain and quoted single-line scalars are supported',
        'unsupported',
      );
    if (typeof value !== 'string')
      return fail('skill.scalar', 'Frontmatter fields must be strings');
    fields.set(field[1]!, value);
  }
  const name = fields.get('name'),
    description = fields.get('description');
  if (
    !name ||
    name.length > 64 ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name) ||
    !description ||
    description.length > 1024
  )
    return fail('skill.metadata', 'Invalid skill name or description');
  return ok({ name, description, instructions: match[2]! });
}
export function createSkills(
  source: Packages.Source,
  packages: readonly Packages.Snapshot[],
): Skills.Service & { closeOwner(owner: Contracts.EntityRef): void } {
  const active = new Map<
    string,
    { activation: Skills.Activation; principal: Contracts.InvocationContext['principal'] }
  >();
  const descriptor = async (
    snapshot: Packages.Snapshot,
    context: Contracts.InvocationContext,
  ): Promise<Contracts.Result<{ descriptor: Skills.Descriptor; instructions: string }>> => {
    const content = await source.read(snapshot, 'SKILL.md', context);
    if (!content.ok) return content;
    let decoded: Contracts.Result<Decoded>;
    try {
      decoded = decode(new TextDecoder('utf-8', { fatal: true }).decode(content.value));
    } catch {
      return fail('skill.encoding', 'Invalid UTF-8');
    }
    if (!decoded.ok) return decoded;
    const parent = snapshot.origin.split('/').at(-1);
    if (parent && parent !== decoded.value.name)
      return fail('skill.name', 'Skill name must match its directory');
    return ok({
      descriptor: freeze({
        id: snapshot.id,
        name: decoded.value.name,
        description: decoded.value.description,
        package: snapshot,
        instructionPath: 'SKILL.md',
        references: snapshot.assets.filter((a) => a.path !== 'SKILL.md').map((a) => a.path),
        requiredCapabilities: [],
      }),
      instructions: decoded.value.instructions,
    });
  };
  return {
    async list(context) {
      const descriptors: Skills.Descriptor[] = [];
      for (const snapshot of packages) {
        if (!snapshot.assets.some((a) => a.path === 'SKILL.md')) continue;
        const decoded = await descriptor(snapshot, context);
        if (!decoded.ok) return decoded;
        descriptors.push(decoded.value.descriptor);
      }
      return ok(descriptors);
    },
    async activate(request, context) {
      const snapshot = packages.find((p) => p.id === request.skillId);
      if (!snapshot) return fail('skill.missing', 'Skill not found');
      if (snapshot.digest !== request.packageDigest)
        return fail('skill.digest', 'Skill digest mismatch', 'conflict');
      if (!['invocation', 'run', 'session'].includes(request.scope))
        return fail('skill.scope', 'Unsupported activation scope');
      const decoded = await descriptor(snapshot, context);
      if (!decoded.ok) return decoded;
      const activation: Skills.Activation = freeze({
        id: crypto.randomUUID(),
        descriptor: decoded.value.descriptor,
        owner: { ...request.owner },
        scope: request.scope,
        contextItems: [
          await semanticItem('part/skill-instructions', {
            instructions: decoded.value.instructions,
            skillId: snapshot.id,
            packageDigest: snapshot.digest,
          }),
        ],
        warnings: [
          'Instructions only; no scripts, hooks or workflows were installed.',
          'Frontmatter compatibility is limited to name, description and license scalar fields.',
        ],
      });
      active.set(activation.id, { activation, principal: { ...context.principal } });
      return ok(activation);
    },
    async deactivate(id, context) {
      const existing = active.get(id);
      if (!existing) return fail('skill.activation', 'Activation not found');
      if (canonical(existing.principal) !== canonical(context.principal))
        return fail('skill.permission', 'Activation access denied', 'permission');
      active.delete(id);
      return ok(undefined);
    },
    closeOwner(owner) {
      for (const [id, value] of active)
        if (
          canonical(value.activation.owner as unknown as Contracts.Json) ===
          canonical(owner as unknown as Contracts.Json)
        )
          active.delete(id);
    },
  };
}
export function skillLowerer(
  role: Context.Fragment['role'] = 'user',
): Context.Lowerer<{ instructions: string }> {
  return {
    id: 'part/skill-instructions',
    accepts: { id: 'part/skill-instructions', version: 1 },
    lower(item) {
      if (typeof item.payload?.instructions !== 'string')
        return fail('skill.instructions', 'Invalid skill instructions');
      return ok({
        kind: 'include',
        fragments: [
          {
            id: item.id,
            kind: 'instruction',
            role,
            content: [{ kind: 'text', text: item.payload.instructions }],
            sources: [item.source],
            provenance: item.provenance,
          },
        ],
      });
    },
  };
}
