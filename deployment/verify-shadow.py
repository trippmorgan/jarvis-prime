import json, time, tempfile, subprocess, urllib.request
from pathlib import Path

def get(url):
    with urllib.request.urlopen(url, timeout=5) as r: return json.load(r)
root=Path('/home/joevoldemort/.openclaw/workspace/jarvis-prime')
out=Path(tempfile.mkdtemp(prefix='frank-shadow-deploy-smoke-'))
print('Synthetic smoke directory:',out,flush=True)
# Explicitly enable collection without inspecting any existing credential configuration.
override=Path.home()/'.config/systemd/user/jarvis-prime.service.d/jev-shadow.conf'
override.parent.mkdir(parents=True,exist_ok=True)
if override.exists(): raise RuntimeError('Existing shadow override requires inspection')
override.write_text('[Service]\nEnvironment=FRANK_JEV=1\nEnvironment=FRANK_JEV_URL=http://127.0.0.1:30110\nEnvironment=FRANK_CROSS_REVIEW=1\n')
subprocess.run(['systemctl','--user','daemon-reload'],check=True)
# Refuse a busy restart; leave enablement pending rather than interrupting work.
status=get('http://127.0.0.1:3100/status')
if status['queue']['length'] or status['queue']['processing']: raise RuntimeError('Bridge busy; activation restart deferred')
subprocess.run(['systemctl','--user','restart','jarvis-prime.service'],check=True)
print('Bridge restarted with explicit shadow enablement',flush=True)
deadline=time.monotonic()+240
while time.monotonic()<deadline:
    try:
        health=get('http://127.0.0.1:30110/health')
        if health.get('loaded') and health.get('device')=='cpu': break
    except Exception: pass
    time.sleep(2)
else: raise RuntimeError('CPU service failed readiness deadline')
print('CPU service ready',flush=True)
script='''import { collectCase, evaluateShadow, nextBlind, shadowStatus } from './dist/bridge/shadow-review.js';
const dir=process.argv[1];
const c=collectCase({messageId:'synthetic-deployment-smoke',chatId:'synthetic',task:'What is 2 plus 2?',harness:'4',jarvis:'5',evidence:{harness:[],jarvis:[]}},dir);
await evaluateShadow({url:'',model:'',timeoutMs:1,jevUrl:'http://127.0.0.1:30110'},c,dir);
const blind=nextBlind('synthetic-ui-check',dir);
if(!blind || 'result' in blind || 'pHarness' in blind) throw Error('Blind review check failed');
console.log(JSON.stringify({synthetic:true,queue:shadowStatus(dir)}));'''
r=subprocess.run(['node','--input-type=module','-e',script,str(out)],cwd=root,text=True,capture_output=True,timeout=180)
print(r.stdout,flush=True)
if r.returncode: raise RuntimeError('Shadow smoke failed: '+r.stderr[-1200:])
models=get('http://127.0.0.1:11434/api/ps')['models']
residents=[{'name':m['name'],'size_vram':m['size_vram']} for m in models]
if not any(m['name']=='qwen3.8:27b' and m['size_vram']>17_000_000_000 for m in models): raise RuntimeError('Qwen GPU residency changed')
if not any(m['name'].startswith('nomic-embed-text') and m['size_vram']>300_000_000 for m in models): raise RuntimeError('Nomic GPU residency changed')
report={'synthetic':True,'health':get('http://127.0.0.1:30110/health'),'bridge':get('http://127.0.0.1:3100/status'),'ollama':residents}
(out/'deployment-result.json').write_text(json.dumps(report,indent=2))
print(json.dumps(report),flush=True)
print('PASS: live shipped CPU judge and blind queue; Ollama retained GPU residency; no human label submitted.',flush=True)
