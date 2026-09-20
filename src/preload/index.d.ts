import type { GoldfeltyApi } from './index.ts'

declare global {
  interface Window {
    goldfelty: GoldfeltyApi
  }
}

export {}
