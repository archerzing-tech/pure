let deferredStylesPromise: Promise<void> | null = null;

export function loadDeferredStyles(): Promise<void> {
  if (!deferredStylesPromise) {
    deferredStylesPromise = import('./styles.css')
      .then(() => undefined)
      .catch((error) => {
        deferredStylesPromise = null;
        throw error;
      });
  }
  return deferredStylesPromise;
}
