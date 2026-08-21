/**
 * The boot-home row controller: reads the resolved harness home and its
 * source, and persists the next-boot override through the host domain. The
 * wire is fake; the row's visible behavior is covered by its component spec.
 */

import { describe, expect, it, vi } from 'vitest'
import type { IApiClient } from '@deepseek-ai/dsh-api-remotes/client'
import { BootHomeController } from '../src/client/boot-home-controller.ts'

/** A fake host domain: describe answers a fixed home, setDshHome records calls. */
function fakeHost() {
  const setCalls: (string | null)[] = []
  const host = {
    describe: vi.fn(async () => ({
      result: { ok: true as const, value: { dshHome: '/a/.dsh', dshHomeSource: 'default' as const } },
    })),
    setDshHome: vi.fn(async (request: { path: string | null }) => {
      setCalls.push(request.path)
      return {
        result: {
          ok: true as const,
          value: { nextHome: request.path ?? '/a/.dsh', source: request.path === null ? 'default' as const : 'boot-file' as const },
        },
      }
    }),
  }
  return { api: { host } as unknown as Pick<IApiClient, 'host'>, setCalls }
}

describe('BootHomeController', () => {
  it('loads the resolved home and its source into the draft', async () => {
    const { api } = fakeHost()
    const controller = new BootHomeController(api)
    await controller.load()
    expect(controller.store.getSnapshot()).toMatchObject({
      status: 'ready',
      home: '/a/.dsh',
      source: 'default',
      draft: '/a/.dsh',
    })
  })

  it('saves a typed home and reports that a restart is needed', async () => {
    const { api, setCalls } = fakeHost()
    const controller = new BootHomeController(api)
    await controller.load()
    controller.setDraft('/b/.dsh')
    await controller.save()
    expect(setCalls).toEqual(['/b/.dsh'])
    expect(controller.store.getSnapshot()).toMatchObject({
      saving: false,
      home: '/b/.dsh',
      source: 'boot-file',
      saved: 'saved-restart',
    })
  })

  it('clears the override and reports the default return', async () => {
    const { api, setCalls } = fakeHost()
    const controller = new BootHomeController(api)
    await controller.load()
    await controller.clear()
    expect(setCalls).toEqual([null])
    expect(controller.store.getSnapshot()).toMatchObject({ saved: 'cleared-restart' })
  })

  it('reports the host rejection text', async () => {
    const host = {
      describe: vi.fn(async () => ({
        result: { ok: true as const, value: { dshHome: '/a/.dsh', dshHomeSource: 'default' as const } },
      })),
      setDshHome: vi.fn(async () => ({ result: { ok: false as const, error: { message: 'write refused' } } })),
    }
    const controller = new BootHomeController({ host } as unknown as Pick<IApiClient, 'host'>)
    await controller.load()
    controller.setDraft('/b/.dsh')
    await controller.save()
    expect(controller.store.getSnapshot()).toMatchObject({ saving: false, error: 'write refused' })
  })
})
