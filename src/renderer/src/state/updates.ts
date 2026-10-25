import { useEffect, useState } from 'react'
import type { UpdateStatus } from '@shared/types.ts'

/** The updater's state, kept current as it checks, downloads and installs. */
export function useUpdates(): UpdateStatus | null {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  useEffect(() => {
    void window.goldfelty.updates.status().then((r) => r.ok && setStatus(r.data))
    return window.goldfelty.updates.onChanged(setStatus)
  }, [])
  return status
}
