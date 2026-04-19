import { describe, it, expect } from 'vitest'
import { readRemoteFile, listRemoteDir } from '../ssh/file-ops.js'

describe('readRemoteFile', () => {
  it('reads a local file on superserver', async () => {
    const result = await readRemoteFile('superserver', '/etc/hostname')
    expect(result.error).toBeUndefined()
    expect(result.content.trim().length).toBeGreaterThan(0)
  })

  it('returns error for nonexistent file', async () => {
    const result = await readRemoteFile('superserver', '/nonexistent/file.txt')
    expect(result.error).toBeDefined()
  })

  it('blocks path traversal', async () => {
    const result = await readRemoteFile('superserver', '/home/../etc/shadow')
    expect(result.error).toContain('Forbidden')
  })
})

describe('listRemoteDir', () => {
  it('lists a directory on superserver', async () => {
    const result = await listRemoteDir('superserver', '/tmp')
    expect(result.error).toBeUndefined()
    expect(result.entries.length).toBeGreaterThan(0)
  })
})
