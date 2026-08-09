import type { WorkContext, WorkMessage, WorkTool, ContextOperations } from "./contracts.ts";

function cloneMessages(messages: WorkMessage[]): WorkMessage[] {
  return messages.map(m => ({ ...m }));
}

function cloneTools(tools: WorkTool[] | undefined): WorkTool[] | undefined {
  if (!tools) return undefined;
  return tools.map(t => ({ ...t }));
}

function newMeta(context: WorkContext, newContextId: string, setParent: boolean): WorkContext["metadata"] {
  return {
    contextId: newContextId,
    parentContextId: setParent ? context.metadata.contextId : undefined,
    sourceRefs: [...context.metadata.sourceRefs],
    artifactRefs: [...context.metadata.artifactRefs],
  };
}

function append(context: WorkContext, messages: WorkMessage[], newContextId: string): WorkContext {
  const newMessages = [...cloneMessages(context.messages), ...cloneMessages(messages)];
  return {
    systemPrompt: context.systemPrompt,
    messages: newMessages,
    tools: cloneTools(context.tools),
    metadata: newMeta(context, newContextId, true),
  };
}

function filterMessages(context: WorkContext, predicate: (msg: WorkMessage) => boolean, newContextId: string): WorkContext {
  const newMessages = cloneMessages(context.messages).filter(predicate);
  return {
    systemPrompt: context.systemPrompt,
    messages: newMessages,
    tools: cloneTools(context.tools),
    metadata: newMeta(context, newContextId, true),
  };
}

function merge(base: WorkContext, other: WorkContext, newContextId: string): WorkContext {
  // Concatenate messages: base first, then other
  const mergedMessages = [...cloneMessages(base.messages), ...cloneMessages(other.messages)];

  // Deduplicate sourceRefs in first-seen order: base first, then other
  const seenSources = new Set<string>();
  const mergedSources: string[] = [];
  for (const ref of [...base.metadata.sourceRefs, ...other.metadata.sourceRefs]) {
    if (!seenSources.has(ref)) {
      seenSources.add(ref);
      mergedSources.push(ref);
    }
  }

  // Deduplicate artifactRefs in first-seen order: base first, then other
  const seenArtifacts = new Set<string>();
  const mergedArtifacts: string[] = [];
  for (const ref of [...base.metadata.artifactRefs, ...other.metadata.artifactRefs]) {
    if (!seenArtifacts.has(ref)) {
      seenArtifacts.add(ref);
      mergedArtifacts.push(ref);
    }
  }

  // Deduplicate tools by name, first-seen order: base first, then other
  // Unnamed tools are retained (no dedup)
  let mergedTools: WorkTool[] | undefined;
  const baseTools = base.tools ?? [];
  const otherTools = other.tools ?? [];
  if (baseTools.length > 0 || otherTools.length > 0) {
    const seenNames = new Set<string>();
    mergedTools = [];
    for (const t of baseTools) {
      const cloned = { ...t };
      if (cloned.name !== undefined) {
        if (!seenNames.has(cloned.name)) {
          seenNames.add(cloned.name);
          mergedTools.push(cloned);
        }
      } else {
        mergedTools.push(cloned);
      }
    }
    for (const t of otherTools) {
      const cloned = { ...t };
      if (cloned.name !== undefined) {
        if (!seenNames.has(cloned.name)) {
          seenNames.add(cloned.name);
          mergedTools.push(cloned);
        }
      } else {
        mergedTools.push(cloned);
      }
    }
  }

  // Use other.systemPrompt only when base has none
  const systemPrompt = base.systemPrompt !== undefined ? base.systemPrompt : other.systemPrompt;

  return {
    systemPrompt,
    messages: mergedMessages,
    tools: mergedTools,
    metadata: {
      contextId: newContextId,
      parentContextId: undefined,
      sourceRefs: mergedSources,
      artifactRefs: mergedArtifacts,
    },
  };
}

function truncateMessages(context: WorkContext, limit: number, newContextId: string): WorkContext {
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error("message limit must be a nonnegative integer");
  }
  const all = cloneMessages(context.messages);
  // slice(-0) === slice(0) which returns all messages; guard explicitly
  const kept = limit === 0 ? [] : all.slice(-limit);
  return {
    systemPrompt: context.systemPrompt,
    messages: kept,
    tools: cloneTools(context.tools),
    metadata: newMeta(context, newContextId, true),
  };
}

export function createContextOperations(): ContextOperations {
  return {
    append,
    filterMessages,
    merge,
    truncateMessages,
  };
}
