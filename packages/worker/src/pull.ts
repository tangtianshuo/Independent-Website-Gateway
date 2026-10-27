export async function pullApprovedImage(
  pull: () => Promise<void>,
  recordFailure: () => Promise<unknown>,
): Promise<boolean> {
  try { await pull(); return true; }
  catch {
    await recordFailure();
    return false;
  }
}
