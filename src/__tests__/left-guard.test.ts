import { describe, it, expect } from 'vitest'
import { guardCommand, currentAsk } from '../openclaw/spawner.js'

const ask = (msg: string) => currentAsk(`system…\n\nTripp: earlier thing\nFrank: ok\n\nTripp: ${msg}`)

describe('LEFT shell guardrail (2026-09-23)', () => {
  it('reads only the CURRENT message', () => {
    expect(ask('what is the uptime')).toBe('what is the uptime')
  })
  it('blocks the 2026-09-18 incidents when not asked', () => {
    expect(guardCommand('systemctl stop synology-drive 2>/dev/null; ps aux', ask("Read your workspace architecture, don't have access to Synology nas"))).toMatch(/BLOCKED/)
    expect(guardCommand('sudo apt-get install -y mame', ask('find a working zip for burger time'))).toMatch(/BLOCKED/)
  })
  it('allows the same actions when Tripp asks for them', () => {
    expect(guardCommand('systemctl --user restart jarvis-prime', ask('restart jarvis prime please'))).toBeNull()
    expect(guardCommand('pip install ddgs', ask('install ddgs'))).toBeNull()
  })
  it('never allows hard-blocked commands, even when asked', () => {
    expect(guardCommand('sudo reboot', ask('reboot the box'))).toMatch(/never allowed/)
    expect(guardCommand('rm -rf ~/', ask('delete everything'))).toMatch(/never allowed/)
    expect(guardCommand('nvidia-smi --gpu-reset -i 0', ask('reset the gpu'))).toMatch(/never allowed/)
  })
  it('leaves read-only work alone', () => {
    for (const c of ['uptime', 'systemctl status frank-brain', 'journalctl -u ollama -n 50', 'nvidia-smi', 'ls -la ~/workspace', 'curl -sL https://example.com | head', 'ps aux | grep ollama', 'crontab -l', 'git log -3', 'ufw status', 'rm /tmp/btime.zip', '~/.local/bin/websearch -n 3 lsu'])
      expect(guardCommand(c, ask('check things'))).toBeNull()
  })
})

describe('LEFT guard rm scope', () => {
  it('hard-blocks root/home wipes but only asks for other recursive deletes', () => {
    for (const c of ['rm -rf /', 'rm -rf ~/', 'rm -rf ~', 'rm -rf $HOME', 'rm -rf /home/joevoldemort', 'rm -rf /*'])
      expect(guardCommand(c, currentAsk('Tripp: delete it'))).toMatch(/never allowed/)
    expect(guardCommand('rm -rf /tmp/btime_dir', currentAsk('Tripp: clean up the tmp dir'))).toBeNull()
    expect(guardCommand('rm -rf /tmp/btime_dir', currentAsk('Tripp: what is in tmp'))).toMatch(/needs Tripp/)
  })
})
