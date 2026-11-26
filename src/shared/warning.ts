type Warning = (message: string) => void
const isolated = new WeakSet<Warning>()

export function isolateWarning(onWarning: Warning = console.warn): Warning {
  if (isolated.has(onWarning)) return onWarning
  const warn = (message: string): void => {
    try {
      void Promise.resolve(onWarning(message)).catch(() => {})
    } catch {
      // A diagnostic must never interrupt the operation it reports.
    }
  }
  isolated.add(warn)
  return warn
}
