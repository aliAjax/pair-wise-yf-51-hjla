export async function resolve(specifier, context, nextResolve) {
  if (specifier === "$app/environment") {
    return { url: "file:///workspace/test/env-stub.mjs", shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
