import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_DSH_HOME_DISPLAY,
  DSH_BOOT_FILENAME,
  DSH_HOME_DIR_NAME,
  bootOverridePath,
  canonicalizeWatchPath,
  defaultDshHome,
  dshHomeDisplay,
  dshHomePath,
  expandHomePath,
  readBootHome,
  resolveDshHome,
  writeBootHome,
} from '@deepseek-ai/dsh-home-paths'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('dsh path helpers', () => {
  it('owns the shared default DSH home directory name', () => {
    expect(DSH_HOME_DIR_NAME).toBe('.dsh')
    expect(DEFAULT_DSH_HOME_DISPLAY).toBe('~/.dsh')
    expect(defaultDshHome()).toBe(join(homedir(), '.dsh'))
  })

  it('expands tilde paths without changing non-tilde paths', () => {
    expect(expandHomePath('~')).toBe(homedir())
    expect(expandHomePath('~/.dsh')).toBe(join(homedir(), '.dsh'))
    expect(expandHomePath('~\\.dsh')).toBe(join(homedir(), '.dsh'))
    expect(expandHomePath('/tmp/.dsh')).toBe('/tmp/.dsh')
    expect(expandHomePath('~other/.dsh')).toBe('~other/.dsh')
  })

  it('resolves explicit path before DSH_HOME and the default', async () => {
    const envHome = join(homedir(), 'env-dsh')
    const osHome = await mkdtemp(join(tmpdir(), 'dsh-oshome-'))
    try {
      expect(resolveDshHome('/tmp/explicit-dsh', { DSH_HOME: '~/env-dsh' }, osHome)).toBe(resolve('/tmp/explicit-dsh'))
      expect(resolveDshHome(undefined, { DSH_HOME: '~/env-dsh' }, osHome)).toBe(envHome)
      expect(resolveDshHome(undefined, {}, osHome)).toBe(defaultDshHome())
    } finally {
      await rm(osHome, { recursive: true, force: true })
    }
  })

  it('treats an empty or whitespace-only DSH_HOME as unset', async () => {
    const osHome = await mkdtemp(join(tmpdir(), 'dsh-oshome-'))
    try {
      expect(resolveDshHome(undefined, { DSH_HOME: '' }, osHome)).toBe(defaultDshHome())
      expect(resolveDshHome(undefined, { DSH_HOME: '   ' }, osHome)).toBe(defaultDshHome())
    } finally {
      await rm(osHome, { recursive: true, force: true })
    }
  })

  it('joins child segments onto the resolved DSH_HOME', () => {
    vi.stubEnv('DSH_HOME', '~/env-dsh')
    expect(dshHomePath()).toBe(join(homedir(), 'env-dsh'))
    expect(dshHomePath('storages', 'cache')).toBe(join(homedir(), 'env-dsh', 'storages', 'cache'))
  })

  it('labels a resolved home by whether it is the default root', () => {
    expect(dshHomeDisplay(resolve(defaultDshHome()))).toBe('~/.dsh')
    expect(dshHomeDisplay('/some/other/root')).toBe('$DSH_HOME')
  })

  it('persists and clears a boot-override file under the OS home', async () => {
    const osHome = await mkdtemp(join(tmpdir(), 'dsh-oshome-'))
    try {
      expect(bootOverridePath(osHome)).toBe(join(osHome, DSH_BOOT_FILENAME))
      expect(readBootHome(osHome)).toBeUndefined()
      writeBootHome('/data/dsh-home', osHome)
      expect(readBootHome(osHome)).toBe(resolve('/data/dsh-home'))
      writeBootHome(null, osHome)
      expect(readBootHome(osHome)).toBeUndefined()
    } finally {
      await rm(osHome, { recursive: true, force: true })
    }
  })

  it('resolves the persisted boot override beneath env and above the default', async () => {
    const osHome = await mkdtemp(join(tmpdir(), 'dsh-oshome-'))
    try {
      writeBootHome('/boot/home', osHome)
      expect(resolveDshHome(undefined, {}, osHome)).toBe(resolve('/boot/home'))
      // DSH_HOME outranks the file; an explicit path outranks both.
      expect(resolveDshHome(undefined, { DSH_HOME: '/env/home' }, osHome)).toBe(resolve('/env/home'))
      expect(resolveDshHome('/explicit', { DSH_HOME: '/env/home' }, osHome)).toBe(resolve('/explicit'))
      // Blank env falls through to the file.
      expect(resolveDshHome(undefined, { DSH_HOME: '   ' }, osHome)).toBe(resolve('/boot/home'))
      // No file, no env: the default wins.
      writeBootHome(null, osHome)
      expect(resolveDshHome(undefined, {}, osHome)).toBe(defaultDshHome())
    } finally {
      await rm(osHome, { recursive: true, force: true })
    }
  })

  it('canonicalizes a watcher ancestor while preserving a missing suffix', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-watch-path-'))
    const target = join(root, 'target')
    const alias = join(root, 'alias')
    try {
      await mkdir(target)
      await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir')
      await expect(canonicalizeWatchPath(join(alias, 'later', 'config.yml'))).resolves.toBe(
        join(await realpath(target), 'later', 'config.yml'),
      )
      const file = join(root, 'file')
      await writeFile(file, 'not a directory')
      await expect(canonicalizeWatchPath(join(file, 'child'))).rejects.toMatchObject({ code: 'ENOTDIR' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
