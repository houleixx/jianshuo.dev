// VoiceDrop agent tools — general primitives the article-editing agent composes.
// Each handler takes (args, ctx) where ctx = {env, scope, articleKey, token, origin}.

export const TOOL_DEFS = []; // populated in Tasks 2–4

const HANDLERS = {}; // name -> async (args, ctx) => result  (populated below)

export async function runTool(name, args, ctx) {
  const h = HANDLERS[name];
  if (!h) return { error: "unknown_tool" };
  try {
    return await h(args || {}, ctx);
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
}

// Internal: register a tool definition + handler together.
export function register(def, handler) {
  TOOL_DEFS.push(def);
  HANDLERS[def.name] = handler;
}
