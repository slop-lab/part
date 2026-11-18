// @ts-check

export const delay = /** @param {number} ms */ (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));
/** @param {() => boolean | Promise<boolean>} predicate */
export async function until(predicate) {
  for (let i = 0; i < 300; i++) {
    if (await predicate()) return;
    await delay(2);
  }
  throw Error('Condition did not arrive');
}
